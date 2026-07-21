import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdemStore } from "../src/store.js";
import { generateKey } from "../src/key.js";
import { idemStep } from "../src/idemStep.js";
import {
  startProxy,
  IDEM_KEY_HEADER,
  IDEM_REPLAYED_HEADER,
} from "../src/proxy.js";

// ---------------------------------------------------------------------------
// v0.6.0 fix-cache-headers-mangle-set-cookie: the cache snapshot helper
// (flattenHeaders, now snapshotHeaders) joined array-valued response headers
// (notably Set-Cookie, which Node's http module collects into a string[]) into
// one comma-joined string. The HTTP first-forward path forwarded raw
// upRes.headers (preserving arrays) but the REPLAY path replayed from the
// flattened cache, so a suppressed-duplicate response carried ONE joined
// Set-Cookie header line instead of N — and per RFC 6265 a comma-joined
// Set-Cookie cannot be reliably split (cookie values may contain commas, e.g.
// Expires=Wed, 09-Jun-2021). The fix widens CachedResponse.headers to
// Record<string, string | string[]> and stops joining; res.setHeader emits one
// line per array element, so a replayed duplicate carries the same number of
// Set-Cookie lines as the original forward. (The HTTPS forward+replay paths in
// connect.ts used the same snapshot helper and are fixed by the same change.)
// ---------------------------------------------------------------------------
describe("v0.6.0 fix1: replayed duplicate preserves multi-valued Set-Cookie headers", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let proxy: { port: number; close: () => Promise<void> };
  let dir: string;

  beforeEach(async () => {
    upstream = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/checkout") {
        // Two Set-Cookie headers (session + order-tracking) — exactly the
        // multi-cookie shape a transactional checkout response carries, and
        // exactly what the v0.5.0 flattenHeaders joined into one line.
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": ["session=abc; Path=/", "order=xyz; Path=/"],
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
    dir = mkdtempSync(join(tmpdir(), "idem-setcookie-"));
    const store = new IdemStore({ filePath: join(dir, "store.json") });
    proxy = await startProxy({ port: 0, store, log: false });
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  function post(idemKey: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxy.port}/checkout`, {
      method: "POST",
      headers: {
        "x-idem-target": `http://127.0.0.1:${upstreamPort}`,
        "content-type": "application/json",
        [IDEM_KEY_HEADER]: idemKey,
        "x-idem-label": "place_order",
      },
      body: JSON.stringify({ cart: ["sku-1"] }),
    });
  }

  it("a replayed (suppressed) duplicate carries two Set-Cookie headers, not one joined string", async () => {
    const key = generateKey("order");
    // First request: forwarded. The HTTP first-forward path already preserved
    // arrays (raw upRes.headers), so this carries two Set-Cookie lines.
    const first = await post(key);
    expect(first.headers.get(IDEM_REPLAYED_HEADER)).toBeNull(); // forwarded
    // getSetCookie() returns one entry per Set-Cookie header line.
    expect(first.headers.getSetCookie()).toHaveLength(2);

    // Second request with the SAME key: a self-healing retry. The proxy
    // suppresses it and replays the cached response. Before the fix the cache
    // had joined the two Set-Cookie values into one comma-joined string, so the
    // replayed response carried ONE Set-Cookie line (length 1, value
    // "session=abc; Path=/, order=xyz; Path=/") — unparseable by any strict
    // client. After the fix the array is preserved and two lines are emitted.
    const replayed = await post(key);
    expect(replayed.headers.get(IDEM_REPLAYED_HEADER)).toBe("true"); // replayed
    const cookies = replayed.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies).toEqual(["session=abc; Path=/", "order=xyz; Path=/"]);
  });
});

// ---------------------------------------------------------------------------
// v0.6.0 fix-persist-throws-on-disk-error: persist() had no try/catch around
// writeFileSync/renameSync, so an EACCES/ENOSPC/ENOENT on the durable path
// surfaced through idemStep (whose commit lives inside the try) as a
// system-error rejection instead of fn's result — the write-side gap the
// v0.5.0 atomic-persist + load-loud fix left open. persist() now fail-softs:
// catches the disk error, sets store.persistError, and continues off the
// in-memory Map. Demonstrated with a store whose filePath is in a non-existent
// directory (writeFileSync throws ENOENT).
// ---------------------------------------------------------------------------
describe("v0.6.0 fix2: persist() fail-soft on a disk error instead of rejecting through idemStep", () => {
  it("idemStep resolves with fn's result and sets persistError when the store dir is missing", async () => {
    // A --store path whose directory does not exist. existsSync(filePath) is
    // false so the constructor does not try to load; the first persist()
    // (triggered by begin/commit) throws ENOENT on writeFileSync.
    const store = new IdemStore({
      filePath: join(tmpdir(), "idem-nonexistent-subdir-xyz", "store.json"),
    });

    // Before the fix, store.commit (inside idemStep's try) threw ENOENT, the
    // catch re-threw it, and this await rejected with a system error — AND the
    // catch's store.delete abandoned the still-correct in-memory record.
    const result = await idemStep(
      "place_order",
      generateKey("order"),
      async () => ({ ok: true, orderId: 42 }),
      { store },
    );

    // With the fix, idemStep resolves with fn's result.
    expect(result).toEqual({ ok: true, orderId: 42 });
    // The durable-write failure is surfaced via persistError (fail-loud),
    // not thrown (fail-hard).
    expect(store.persistError).toBeInstanceOf(Error);
  });

  it("a subsequent successful persist clears persistError (transient disk issue recovers)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-persist-recover-"));
    const filePath = join(dir, "store.json");
    try {
      const store = new IdemStore({ filePath });
      // Normal path: persist succeeds, no persistError.
      store.begin("k1", "step");
      store.commit("k1", { ok: true });
      expect(store.persistError).toBeUndefined();
      expect(store.isCommitted("k1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v0.6.0 m_prune_interval: `idemstep hosted --prune-interval MS` schedules a
// periodic store.prune() so TTL-expired committed keys are reclaimed from the
// in-memory Map and JSON file automatically. Lookups expire keys lazily, but a
// long-running hosted proxy fielding many one-off transactional keys would
// otherwise accumulate expired-but-not-reclaimed records forever. With the
// flag, an un-looked-up committed key is gone from the durable store after the
// TTL + one prune tick; without it, the key lingers.
// ---------------------------------------------------------------------------
describe("v0.6.0 m1: --prune-interval reclaims TTL-expired keys from the durable store", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let upstreamHits: number;
  let dir: string;
  let storePath: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let stdout = "";
  let stderr = "";

  beforeEach(async () => {
    upstreamHits = 0;
    upstream = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/checkout") {
        upstreamHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, order: upstreamHits }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    dir = mkdtempSync(join(tmpdir(), "idem-prune-"));
    storePath = join(dir, "hosted.json");
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const tsx = join(repoRoot, "node_modules/.bin/tsx");
    const entry = join(repoRoot, "src", "index.ts");

    // Spawn the hosted CLI with a short TTL and a short prune interval so the
    // reclaim happens within the test window.
    child = spawn(
      tsx,
      [
        entry,
        "hosted",
        "--port",
        "0",
        "--host",
        "127.0.0.1",
        "--store",
        storePath,
        "--ttl",
        "100",
        "--prune-interval",
        "40",
      ],
      { cwd: process.cwd(), env: process.env },
    );
    stdout = "";
    stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });

    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`hosted prune proxy did not start:\n${stderr}`)),
        8000,
      );
      const poll = () => {
        const m = stdout.match(/ready on http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        } else {
          setTimeout(poll, 20);
        }
      };
      poll();
    });
  });

  afterEach(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.once("close", () => r()));
    }
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  function readStoreRecords(): unknown[] {
    if (!existsSync(storePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  it("a committed key is reclaimed from the durable store after TTL + one prune tick", async () => {
    const key = generateKey("order");
    // Place the order — commits the key to the durable store.
    const r = await fetch(`http://127.0.0.1:${port}/checkout`, {
      method: "POST",
      headers: {
        "x-idem-target": `http://127.0.0.1:${upstreamPort}`,
        "content-type": "application/json",
        [IDEM_KEY_HEADER]: key,
        "x-idem-label": "place_order",
      },
      body: JSON.stringify({ cart: ["sku-1"] }),
    });
    expect(r.status).toBe(200);
    // The committed key is durable on disk right after the commit.
    expect(readStoreRecords().some((rec) => (rec as { key?: string }).key === key)).toBe(true);

    // Wait long enough for the TTL (100ms) to expire the key AND the prune
    // interval (40ms) to sweep it. 500ms is well past both.
    await new Promise((r) => setTimeout(r, 500));

    // The expired key has been reclaimed from the durable store — it is gone
    // from the JSON file even though it was never looked up again. Without
    // --prune-interval it would have lingered until an explicit get() on it.
    expect(readStoreRecords().some((rec) => (rec as { key?: string }).key === key)).toBe(false);
    // The prune was logged server-side.
    expect(stdout).toContain("prune reclaimed");
  });
});
