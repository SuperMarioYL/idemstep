import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFileSync, spawn } from "node:child_process";
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
  type RunningProxy,
} from "../src/proxy.js";

// ---------------------------------------------------------------------------
// v0.4.0 fix-proxy-response-stream-error-hangs-client: a truncated /
// prematurely-closed upstream response never emits "end", so before the fix the
// proxy never settled the forward promise, never ended `res`, and the client
// hung until its own timeout — while the just-begun pending record leaked. The
// fix treats the response stream's "error"/"aborted" like the request-level
// error: 502, release the pending record, reject.
// ---------------------------------------------------------------------------
describe("v0.4.0 fix3: response-stream error does not hang the client (http)", () => {
  let proxy: RunningProxy;

  beforeEach(async () => {
    proxy = await startProxy({ port: 0, log: false });
  });
  afterEach(async () => {
    await proxy.close();
  });

  // Upstream that promises a 1000-byte body, sends a sliver, then destroys the
  // socket mid-response — the premature close that emits "aborted" + "error"
  // but never "end".
  function startTruncatingUpstream(): Promise<http.Server> {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000", "content-type": "text/plain" });
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 5);
    });
    return new Promise((r) => upstream.listen(0, "127.0.0.1", () => r(upstream)));
  }

  it(
    "returns 502 (not a hang) and releases the pending record",
    async () => {
      const upstream = await startTruncatingUpstream();
      const upstreamHost = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      try {
        const key = generateKey("order");
        const r = await fetch(`http://localhost:${proxy.port}/checkout`, {
          method: "POST",
          headers: {
            "x-idem-target": `http://${upstreamHost}`,
            "content-type": "application/json",
            [IDEM_KEY_HEADER]: key,
            "x-idem-label": "place_order",
          },
          body: JSON.stringify({ cart: ["sku-1"] }),
        });

        // Before the fix this await never resolved until the fetch's own timeout.
        expect(r.status).toBe(502);
        // The pending record is released — no poison-pending leak.
        expect(proxy.store.get(key)).toBeUndefined();
        expect(proxy.store.all()).toHaveLength(0);
      } finally {
        await new Promise<void>((r) => upstream.close(() => r()));
      }
    },
    3000,
  );

  it(
    "recovers and forwards normally after a truncated-response 502",
    async () => {
      const truncUp = await startTruncatingUpstream();
      const truncPort = (truncUp.address() as AddressInfo).port;

      let hits = 0;
      const okUp = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/checkout") {
          hits += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, order: hits }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => okUp.listen(0, "127.0.0.1", () => r()));
      const okPort = (okUp.address() as AddressInfo).port;

      const key = generateKey("order");
      try {
        const r1 = await fetch(`http://localhost:${proxy.port}/checkout`, {
          method: "POST",
          headers: {
            "x-idem-target": `http://127.0.0.1:${truncPort}`,
            "content-type": "application/json",
            [IDEM_KEY_HEADER]: key,
            "x-idem-label": "place_order",
          },
          body: JSON.stringify({ cart: ["sku-1"] }),
        });
        expect(r1.status).toBe(502);
        expect(proxy.store.get(key)).toBeUndefined();

        // Same key, healthy upstream → fresh forward (no stale committed record).
        const r2 = await fetch(`http://localhost:${proxy.port}/checkout`, {
          method: "POST",
          headers: {
            "x-idem-target": `http://127.0.0.1:${okPort}`,
            "content-type": "application/json",
            [IDEM_KEY_HEADER]: key,
            "x-idem-label": "place_order",
          },
          body: JSON.stringify({ cart: ["sku-1"] }),
        });
        expect(r2.status).toBe(200);
        expect(await r2.json()).toEqual({ ok: true, order: 1 });
        expect(hits).toBe(1);
      } finally {
        await new Promise<void>((r) => truncUp.close(() => r()));
        await new Promise<void>((r) => okUp.close(() => r()));
      }
    },
    3000,
  );
});

// ---------------------------------------------------------------------------
// Same fix, HTTPS CONNECT tunnel (connect.ts forwardHttps): a truncated
// upstream response over TLS must also 502 + release the pending record rather
// than hang the tunnel client.
// ---------------------------------------------------------------------------
describe("v0.4.0 fix3: response-stream error does not hang the client (https tunnel)", () => {
  let dir: string;
  let upstream: https.Server;
  let upstreamPort: number;
  let proxy: RunningProxy;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "idem-https-trunc-"));
    const keyP = join(dir, "up.key");
    const crtP = join(dir, "up.crt");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyP, "-out", crtP,
        "-days", "825", "-nodes", "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const upstreamCert = readFileSync(crtP, "utf8");
    upstream = https.createServer(
      { key: readFileSync(keyP), cert: readFileSync(crtP) },
      (_req, res) => {
        // Truncate: promise 1000 bytes, send a sliver, destroy the TLS socket.
        res.writeHead(200, { "content-length": "1000", "content-type": "text/plain" });
        res.write("partial");
        setTimeout(() => res.socket?.destroy(), 5);
      },
    );
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
    proxy = await startProxy({
      port: 0,
      https: true,
      log: false,
      upstreamTls: { ca: upstreamCert },
    });
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  // CONNECT + MITM TLS + one POST over the tunnel; returns the status + body.
  function tunnelPost(key: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const connectReq = http.request({
        host: "localhost",
        port: proxy.port,
        method: "CONNECT",
        path: `127.0.0.1:${upstreamPort}`,
      });
      connectReq.on("connect", (_res, socket) => {
        const tlsSocket = tls.connect({
          socket,
          servername: "127.0.0.1",
          ca: proxy.caCertPem,
        });
        tlsSocket.on("error", reject);
        tlsSocket.on("secureConnect", () => {
          const payload = JSON.stringify({ cart: ["sku-1"] });
          const reqOverTunnel = http.request(
            {
              method: "POST",
              path: "/checkout",
              createConnection: () => tlsSocket as never,
              headers: {
                host: `127.0.0.1:${upstreamPort}`,
                [IDEM_KEY_HEADER]: key,
                "x-idem-label": "place_order",
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              },
            },
            (resp) => {
              const chunks: Buffer[] = [];
              resp.on("data", (c: Buffer) => chunks.push(c));
              resp.on("end", () =>
                resolve({
                  status: resp.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          reqOverTunnel.on("error", reject);
          reqOverTunnel.end(payload);
        });
      });
      connectReq.on("error", reject);
      connectReq.end();
    });
  }

  it(
    "returns 502 (not a hang) and releases the pending record over the tunnel",
    async () => {
      const key = generateKey("order");
      const { status } = await tunnelPost(key);
      expect(status).toBe(502);
      expect(proxy.store.get(key)).toBeUndefined();
      expect(proxy.store.all()).toHaveLength(0);
    },
    3000,
  );
});

// ---------------------------------------------------------------------------
// v0.4.0 fix-proxy-commit-clobbers-wrapper-result: on the documented
// shared-store path (wrapper + proxy share one JSON-file store), the proxy's
// network-commit must not overwrite the wrapper's user-facing result. Before the
// fix the proxy stuffed {requestSig, status} into `result`; the wrapper's later
// commit was a no-op (committed-no-op), so a same-key retry replayed the proxy's
// bookkeeping instead of fn's real return value. The proxy now commits WITHOUT a
// result and the wrapper publishes fn's result via store.setResult().
// ---------------------------------------------------------------------------
describe("v0.4.0 fix4: shared store replays fn's real result, not the proxy's bookkeeping", () => {
  it("a same-key retry replays fn's real return value (not {requestSig, status})", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-shared-"));
    const filePath = join(dir, "store.json");
    try {
      // ONE JSON-file store shared between the wrapper and the proxy — the
      // documented "share one with the proxy via a JSON-file path" pattern.
      const shared = new IdemStore({ filePath });

      let ordersPlaced = 0;
      const upstream = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/checkout") {
          ordersPlaced += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, order: ordersPlaced }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
      const upstreamHost = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;

      const proxy = await startProxy({ port: 0, store: shared, log: false });
      const key = generateKey("order");

      const submit = (attempt: number) =>
        idemStep(
          "place_order",
          key,
          async () => {
            const resp = await fetch(`http://localhost:${proxy.port}/checkout`, {
              method: "POST",
              headers: {
                "x-idem-target": `http://${upstreamHost}`,
                "content-type": "application/json",
                [IDEM_KEY_HEADER]: key,
                "x-idem-label": "place_order",
              },
              body: JSON.stringify({ cart: ["sku-1"], attempt }),
            });
            // fn's real, user-facing return value (NOT a {requestSig,status} object):
            return { real: "fn-result", attempt, upstream: await resp.json() };
          },
          { store: shared },
        );

      const first = await submit(1);
      // The proxy forwarded once; the wrapper published its real result.
      expect(ordersPlaced).toBe(1);

      // A same-key retry: idemStep short-circuits on the committed key and
      // replays the cached result — which must be fn's real return value, not
      // the proxy's internal {requestSig, status} bookkeeping (v0.3.0 clobber)
      // and not undefined.
      const second = await submit(2);
      expect(second).toEqual(first);
      expect(second).toMatchObject({ real: "fn-result", attempt: 1 });
      expect(second).not.toHaveProperty("requestSig");
      expect(second).not.toHaveProperty("status");

      // No double-submit: the retry short-circuited client-side before any fetch.
      expect(ordersPlaced).toBe(1);

      await proxy.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v0.4.0 m_hosted_dedup_proxy: `idemstep hosted` runs the existing interception
// proxy bound to a configurable host/port with a durable JSON-file store, so a
// remote Playwright context gets managed exactly-once without operating the
// proxy. Single-tenant only (no auth/billing/Redis). This test spawns the real
// CLI command, routes a remote-style retried submit through it, and asserts the
// dedup fires exactly once AND is logged server-side.
// ---------------------------------------------------------------------------
describe("v0.4.0 m5: hosted dedup proxy (single-tenant preview)", () => {
  it(
    "a remote-style agent retried through `idemstep hosted` dedups to one submit, logged server-side",
    async () => {
      // The "target site" the hosted proxy forwards to (stands in for the real
      // third-party checkout the operator does not control).
      let upstreamHits = 0;
      const upstream = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/checkout") {
          upstreamHits += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, order: upstreamHits }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
      const upstreamPort = (upstream.address() as AddressInfo).port;

      const dir = mkdtempSync(join(tmpdir(), "idem-hosted-"));
      const storePath = join(dir, "hosted.json");
      const repoRoot = fileURLToPath(new URL("..", import.meta.url));
      const tsx = join(repoRoot, "node_modules/.bin/tsx");
      const entry = join(repoRoot, "src", "index.ts");

      // Spawn the hosted CLI exactly as an operator would.
      const child = spawn(
        tsx,
        [entry, "hosted", "--port", "0", "--host", "127.0.0.1", "--store", storePath],
        { cwd: process.cwd(), env: process.env },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.stderr.on("data", (c) => {
        stderr += c;
      });

      // Wait for the ready banner and parse the bound port.
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`hosted proxy did not start:\n${stderr}`)),
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

      try {
        const key = generateKey("order");
        // A "remote-style agent": a client hitting the hosted proxy's URL with
        // the idempotency key. The second call is the self-healing retry.
        const post = () =>
          fetch(`http://127.0.0.1:${port}/checkout`, {
            method: "POST",
            headers: {
              "x-idem-target": `http://127.0.0.1:${upstreamPort}`,
              "content-type": "application/json",
              [IDEM_KEY_HEADER]: key,
              "x-idem-label": "place_order",
            },
            body: JSON.stringify({ cart: ["sku-1"] }),
          });

        const r1 = await post();
        const r2 = await post(); // the retry — must be suppressed at the proxy.
        expect(await r1.json()).toEqual({ ok: true, order: 1 });
        expect(r2.headers.get(IDEM_REPLAYED_HEADER)).toBe("true");

        // Exactly one submit reached the target site; the retry was deduped.
        expect(upstreamHits).toBe(1);

        // The dedup was logged server-side (the hosted proxy's stdout).
        await new Promise((r) => setTimeout(r, 50));
        expect(stdout).toContain("suppressed");
        // The dedup state is durable (the JSON-file store was written).
        expect(existsSync(storePath)).toBe(true);
      } finally {
        child.kill("SIGTERM");
        await new Promise<void>((r) => child.once("close", () => r()));
        await new Promise<void>((r) => upstream.close(() => r()));
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15000,
  );
});
