import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDEM_API_KEY_HEADER, IDEM_KEY_HEADER } from "../src/proxy.js";

// Shared CLI spawn harness (mirrors the v0.5.0 / v0.6.0 hosted-CLI tests).
// tsx resolves its own internals by its own location, so spawning src/index.ts
// directly is the robust way to exercise the `idemstep hosted` CLI body.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const ENTRY = join(REPO_ROOT, "src", "index.ts");

interface SpawnedHosted {
  child: ChildProcessWithoutNullStreams;
  port: number;
  /** Live stderr collected from the child (grows after resolve). */
  getStderr: () => string;
  /** Live stdout collected from the child (grows after resolve). */
  getStdout: () => string;
}

function spawnHosted(extraArgs: string[]): Promise<SpawnedHosted> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [ENTRY, "hosted", ...extraArgs], {
      cwd: process.cwd(),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `hosted proxy did not start:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 15000);
    const poll = () => {
      const m = stdout.match(/ready on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), getStdout: () => stdout, getStderr: () => stderr });
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Send a raw CONNECT to the proxy and resolve with the response status code.
// Uses a raw socket (not http.request's 'connect' event) so the behavior is
// identical for both 2xx (tunnel established) and 407 (rejected) responses.
function connectStatus(
  port: number,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("CONNECT timed out"));
    }, 5000);
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on("connect", () => {
      let req = "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n";
      for (const [k, v] of Object.entries(headers)) {
        req += `${k}: ${v}\r\n`;
      }
      req += "\r\n";
      sock.write(req);
    });
    sock.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      if (!buf.includes("\r\n")) return; // wait for the full status line
      const statusLine = buf.split("\r\n")[0];
      const m = statusLine.match(/^HTTP\/\d\.\d (\d{3})/);
      if (m) {
        clearTimeout(timer);
        sock.destroy();
        resolve(Number(m[1]));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// v0.8.0 fix-persist-error-never-surfaced-mid-session: warnIfStoreErrors ran
// ONCE at startup (before any mutation), so store.persistError — set mid-
// session in persist()'s catch on EACCES/ENOSPC/ENOENT — was never re-checked.
// A failing disk silently dropped persists; the next restart loaded the stale
// file with no parse error, so recently-committed keys were absent,
// isCommitted(k) returned false, and a same-key retry was forwarded as a NEW
// action (double-submit) with zero operator visibility across the whole cycle.
// The fix adds an onError callback to IdemStoreOptions invoked in persist()'s
// catch when persistError transitions undefined→set (and in load() when
// loadError/repaired keys are populated), wired to stderr by the proxy/hosted
// CLI bodies. This test reproduces the running-proxy scenario: a hosted proxy
// whose --store path cannot be written (ENOENT on a missing subdir) keeps
// serving 200 off the in-memory map, BUT now also screams on stderr the first
// time a persist fails mid-session — pre-fix the stderr stayed empty.
// ---------------------------------------------------------------------------
describe("v0.8.0 fix1: mid-session durable-write failure is surfaced on stderr (not silently dropped)", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let dir: string;
  let spawned: SpawnedHosted;

  beforeEach(async () => {
    upstream = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/checkout") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, order: 1 }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    dir = mkdtempSync(join(tmpdir(), "idem-persist-surface-"));
    // A --store path whose IMMEDIATE parent dir does not exist: existsSync is
    // false so the constructor does not try to load (no startup warning), but
    // the first persist() (triggered by store.begin on the POST) throws ENOENT
    // on writeFileSync — exactly the mid-session failure that pre-fix went
    // un-surfaced because warnIfStoreErrors had already run at startup.
    const badStorePath = join(dir, "missing-subdir", "hosted.json");
    spawned = await spawnHosted([
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--store",
      badStorePath,
    ]);
  });

  afterEach(async () => {
    if (spawned.child && !spawned.child.killed) {
      spawned.child.kill("SIGTERM");
      await new Promise<void>((r) => spawned.child.once("close", () => r()));
    }
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("a transactional POST through the running hosted proxy still returns 200 (fail-soft) AND writes the durable-write warning to stderr on first occurrence", async () => {
    const key = `order-${Math.random().toString(36).slice(2)}`;
    const r = await fetch(`http://127.0.0.1:${spawned.port}/checkout`, {
      method: "POST",
      headers: {
        "x-idem-target": `http://127.0.0.1:${upstreamPort}`,
        "content-type": "application/json",
        [IDEM_KEY_HEADER]: key,
        "x-idem-label": "place_order",
      },
      body: JSON.stringify({ cart: ["sku-1"] }),
    });
    // In-memory dedup still works (fail-soft, not fail-hard): the order is
    // placed once and the client gets 200. This alone is unchanged by the fix.
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, order: 1 });

    // The fix: the first mid-session persist failure surfaces on stderr.
    // Pre-fix warnIfStoreErrors had already run at startup (persistError was
    // undefined, no mutation yet) and was never re-checked, so this stderr
    // stayed empty — the operator had zero visibility while the disk silently
    // dropped persists and the store drifted stale.
    await waitFor(() => spawned.getStderr().includes("durable write failed"));
    expect(spawned.getStderr()).toContain("WARNING — durable write failed");
    expect(spawned.getStderr()).toContain("idemstep hosted");
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 fix-hosted-connect-bypasses-api-key-auth: with --api-keys set, the
// multi-tenant hosted proxy (bound 0.0.0.0) was an OPEN RELAY. authorizeKey
// was consulted ONLY for transactional requests carrying x-idem-key; the
// CONNECT establishment (onConnect) did no auth at all (any caller could
// CONNECT to arbitrary host:port), and all non-transactional traffic (no
// x-idem-key) was forwarded untouched in BOTH the plaintext handler and the
// tunnel handler. The fix: when authorizeKey is set, authenticate the CONNECT
// itself (407 on a missing/unknown key) and require a valid key on non-
// transactional requests too (401), so the auth cannot be bypassed by simply
// omitting x-idem-key. The authorizer accepts x-idem-api-key OR Proxy-
// Authorization (Basic, which Playwright sends via proxy.username/password).
// Single-tenant mode (no --api-keys) is unchanged.
// ---------------------------------------------------------------------------
describe("v0.8.0 fix2: --api-keys closes the CONNECT + non-transactional open relay", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let upstreamHits: number;
  let dir: string;
  let spawned: SpawnedHosted;

  beforeEach(async () => {
    upstreamHits = 0;
    upstream = http.createServer((_req, res) => {
      // Any non-transactional GET is proxied through here when auth passes.
      upstreamHits += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    dir = mkdtempSync(join(tmpdir(), "idem-connect-auth-"));
    spawned = await spawnHosted([
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--store",
      join(dir, "hosted.json"),
      "--https", // registers onConnect so the CONNECT auth path is exercised
      "--api-keys",
      "alpha",
    ]);
  });

  afterEach(async () => {
    if (spawned.child && !spawned.child.killed) {
      spawned.child.kill("SIGTERM");
      await new Promise<void>((r) => spawned.child.once("close", () => r()));
    }
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unauthenticated CONNECT with 407 (pre-fix it was 200 → open relay)", async () => {
    // Bare CONNECT, no x-idem-api-key, no Proxy-Authorization. Pre-fix onConnect
    // wrote "200 Connection Established" for any caller, so an unauthenticated
    // remote client could tunnel to arbitrary host:port.
    const status = await connectStatus(spawned.port);
    expect(status).toBe(407);
  });

  it("accepts a CONNECT carrying Proxy-Authorization (Basic) with a valid key (Playwright proxy.username/password still works)", async () => {
    // Playwright sends the operator's key via proxy.username/password →
    // Proxy-Authorization (Basic). makeAuthorizer must read it (not just
    // x-idem-api-key), otherwise legitimate browser-agent HTTPS would be 407'd.
    // password = key (username empty), the typical Playwright shape.
    const cred = Buffer.from(":alpha").toString("base64");
    const status = await connectStatus(spawned.port, {
      "proxy-authorization": `Basic ${cred}`,
    });
    expect(status).toBe(200);
  });

  it("rejects a non-transactional plaintext request with no key (401, not forwarded) — pre-fix it was forwarded (open relay)", async () => {
    // No x-idem-key (non-transactional) and no credentials. Pre-fix the
    // plaintext handler forwarded it untouched to the x-idem-target; with the
    // fix the auth cannot be bypassed by omitting x-idem-key. A 401 (rather
    // than the upstream's 200) AND zero upstream hits prove it was never
    // forwarded.
    const r = await fetch(`http://127.0.0.1:${spawned.port}/anything`, {
      method: "GET",
      headers: { "x-idem-target": `http://127.0.0.1:${upstreamPort}` },
    });
    expect(r.status).toBe(401);
    expect(upstreamHits).toBe(0);
  });

  it("still forwards a non-transactional request that carries a valid x-idem-api-key (auth not over-aggressive)", async () => {
    // A valid key on non-transactional traffic authenticates and forwards —
    // the auth gates the open relay without rejecting legitimate traffic.
    const r = await fetch(`http://127.0.0.1:${spawned.port}/anything`, {
      method: "GET",
      headers: {
        "x-idem-target": `http://127.0.0.1:${upstreamPort}`,
        [IDEM_API_KEY_HEADER]: "alpha",
      },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
    expect(upstreamHits).toBe(1);
  });
});
