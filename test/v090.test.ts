import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startProxy,
  IDEM_API_KEY_HEADER,
  type RunningProxy,
  type AuthorizeKey,
} from "../src/proxy.js";

// ---------------------------------------------------------------------------
// v0.9.0 fix-proxy-buffers-streaming-responses: forward() buffered the ENTIRE
// upstream body (chunks.push on every "data") and only res.end(respBody) inside
// upRes.on("end"). That branch ran UNCONDITIONALLY — including for non-
// transactional traffic forwarded with commit === null (proxy.ts:196, called
// with null at connect.ts:249), which is meant to pass through untouched. A non-
// transactional SSE / streaming response keeps the upstream connection open and
// emits "data" over time WITHOUT emitting "end" (a keep-alive SSE stream never
// ends), so the client received zero bytes until "end" fired — it hung
// indefinitely; a finite slow chunked response was also held until completion.
// The fix branches on commit: when commit === null, stream through (write
// status + headers on the response event, res.write on data, res.end on end);
// keep the buffer-then-cache-and-commit path only for commit !== null, where the
// full body is genuinely needed for CachedResponse replay.
// ---------------------------------------------------------------------------

// An SSE-style upstream: emits one event immediately, then ends after a delay.
// The delay is long enough that the buffering path holds the first chunk until
// ~end-time, while the streaming path delivers it immediately — so the first-
// chunk arrival time cleanly distinguishes the two.
const STREAM_END_DELAY_MS = 800;
const STREAM_ASSERT_BELOW_MS = 400;

describe("v0.9.0 fix1: non-transactional streaming response is streamed, not buffered (http)", () => {
  let proxy: RunningProxy;
  let upstream: http.Server;
  let upstreamPort: number;

  beforeEach(async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.end(), STREAM_END_DELAY_MS);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
    proxy = await startProxy({ port: 0, log: false });
  });

  afterEach(async () => {
    await proxy.close();
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it("delivers the first chunk immediately instead of holding the whole body until end", async () => {
    // Non-transactional (no x-idem-key) → forward() runs with commit === null,
    // the path the fix branches on. fetch resolves once response HEADERS arrive;
    // pre-fix the proxy wrote headers only inside upRes.on("end"), so fetch — and
    // the first body chunk — did not arrive until ~end-time (or never, for a
    // keep-alive SSE stream), hanging the client.
    const start = Date.now();
    const r = await fetch(`http://localhost:${proxy.port}/stream`, {
      headers: { "x-idem-target": `http://127.0.0.1:${upstreamPort}` },
    });
    const reader = r.body!.getReader();
    const first = await reader.read();
    const elapsed = Date.now() - start;

    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(first.value ?? new Uint8Array())).toContain("data: first");
    // Streaming delivers the first chunk immediately; pre-fix buffering held it
    // until "end" fired at ~800ms.
    expect(elapsed).toBeLessThan(STREAM_ASSERT_BELOW_MS);

    // Drain to end so the response completes and teardown is clean.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  }, 3000);
});

// ---------------------------------------------------------------------------
// Same fix, HTTPS CONNECT tunnel (connect.ts forwardHttps): the identical
// buffering+end pattern hung a non-transactional SSE/streaming response over the
// tunnel. The fix streams through over the tunnel too.
// ---------------------------------------------------------------------------
describe("v0.9.0 fix1: non-transactional streaming response is streamed, not buffered (https tunnel)", () => {
  let dir: string;
  let upstream: https.Server;
  let upstreamPort: number;
  let proxy: RunningProxy;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "idem-https-stream-"));
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
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        setTimeout(() => res.end(), STREAM_END_DELAY_MS);
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
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  // CONNECT + MITM TLS + one non-transactional GET over the tunnel; returns the
  // response status, full body, and the elapsed ms at which the FIRST data chunk
  // arrived (relative to the CONNECT start).
  function tunnelStreamGet(
    proxyPort: number,
    upPort: number,
    caCertPem: string | undefined,
  ): Promise<{ firstDataMs: number; status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const connectReq = http.request({
        host: "localhost",
        port: proxyPort,
        method: "CONNECT",
        path: `127.0.0.1:${upPort}`,
      });
      connectReq.on("error", reject);
      connectReq.on("connect", (_res, socket) => {
        const tlsSocket = tls.connect({
          socket,
          servername: "127.0.0.1",
          ca: caCertPem,
        });
        tlsSocket.on("error", reject);
        tlsSocket.on("secureConnect", () => {
          const reqOverTunnel = http.request(
            {
              method: "GET",
              path: "/stream",
              createConnection: () => tlsSocket as never,
              headers: { host: `127.0.0.1:${upPort}` },
            },
            (resp) => {
              let firstDataMs = -1;
              const chunks: Buffer[] = [];
              resp.on("data", (c: Buffer) => {
                if (firstDataMs < 0) firstDataMs = Date.now() - start;
                chunks.push(c);
              });
              resp.on("end", () =>
                resolve({
                  firstDataMs,
                  status: resp.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
              resp.on("error", reject);
            },
          );
          reqOverTunnel.on("error", reject);
          reqOverTunnel.end();
        });
      });
      connectReq.end();
    });
  }

  it("delivers the first chunk through the CONNECT tunnel immediately (not held until end)", async () => {
    const { status, body, firstDataMs } = await tunnelStreamGet(
      proxy.port,
      upstreamPort,
      proxy.caCertPem,
    );

    expect(status).toBe(200);
    expect(body).toContain("data: first");
    // Streaming through the tunnel: the first chunk arrives immediately. Pre-fix
    // forwardHttps buffered the whole body and only res.end()'d on "end" (~800ms),
    // so a non-transactional SSE stream over HTTPS hung the tunnel client.
    expect(firstDataMs).toBeLessThan(STREAM_ASSERT_BELOW_MS);
  }, 5000);
});

// ---------------------------------------------------------------------------
// v0.9.0 fix-proxy-leaks-proxy-authorization-upstream: forward() built
// outHeaders = { ...req.headers } and stripped only the idem control headers +
// proxy-connection, NOT proxy-authorization. So when a client authenticated to
// the multi-tenant hosted proxy via Proxy-Authorization: Basic (the documented
// Playwright proxy.username/password flow), the operator's API key was forwarded
// verbatim to the real upstream HTTP site. The fix adds delete
// outHeaders["proxy-authorization"] — it is hop-by-hop per RFC 7230 §6.1.
//
// This test authenticates a plaintext forward via Proxy-Authorization (Basic) and
// asserts the upstream receives no proxy-authorization header.
// ---------------------------------------------------------------------------
describe("v0.9.0 fix2: Proxy-Authorization is stripped before forwarding upstream", () => {
  const API_KEY = "secret-operator-key";
  let proxy: RunningProxy;
  let upstream: http.Server;
  let upstreamPort: number;
  let receivedHeaders: http.IncomingHttpHeaders;

  // Mirrors makeAuthorizer's extractApiKey (index.ts) — accepts the operator's
  // key from EITHER x-idem-api-key OR Proxy-Authorization (Basic), the documented
  // Playwright proxy.username/password flow. Used here only to AUTHENTICATE the
  // request so it reaches forward(); the leak/fix lives in forward()'s outHeaders
  // strip, which is mode-independent.
  function readApiKey(req: http.IncomingMessage): string {
    const direct = req.headers[IDEM_API_KEY_HEADER];
    const d = Array.isArray(direct) ? direct[0] : direct;
    if (d) return d;
    const pa = req.headers["proxy-authorization"];
    const paStr = Array.isArray(pa) ? pa[0] : pa;
    if (typeof paStr !== "string" || !paStr.toLowerCase().startsWith("basic ")) return "";
    try {
      const decoded = Buffer.from(paStr.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      return pass || user || "";
    } catch {
      return "";
    }
  }

  beforeEach(async () => {
    receivedHeaders = {};
    upstream = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
    const authorizeKey: AuthorizeKey = (req, idemKey) => {
      if (readApiKey(req) !== API_KEY) return null;
      return `ns::${idemKey}`;
    };
    proxy = await startProxy({ port: 0, authorizeKey, log: false });
  });

  afterEach(async () => {
    await proxy.close();
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  // Raw http.request (NOT fetch): Proxy-Authorization is a fetch-spec forbidden
  // header name (the `proxy-` prefix), so fetch/XHR silently drop it. A real
  // proxy client (Playwright) sets it at the socket level, which http.request
  // models faithfully.
  function proxyGet(headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "localhost",
          port: proxy.port,
          method: "GET",
          path: "/anything",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("does not forward the operator's Proxy-Authorization (Basic) to the HTTP upstream", async () => {
    // Authenticate via Proxy-Authorization (Basic) — password = key, username
    // empty, the typical Playwright shape. The request is non-transactional (no
    // x-idem-key) so it exercises the commit === null forward path; in multi-
    // tenant mode the authorizer gates it (401 on a missing/unknown key).
    const cred = Buffer.from(`:${API_KEY}`).toString("base64");
    const { status, body } = await proxyGet({
      "x-idem-target": `http://127.0.0.1:${upstreamPort}`,
      "proxy-authorization": `Basic ${cred}`,
    });

    expect(status).toBe(200);
    expect(body).toBe("ok");
    // The fix: Proxy-Authorization is hop-by-hop (RFC 7230 §6.1) and must not be
    // forwarded. Pre-fix forward() stripped only proxy-connection, so the
    // operator's API key leaked verbatim to the real HTTP target site.
    expect(receivedHeaders["proxy-authorization"]).toBeUndefined();
  });
});
