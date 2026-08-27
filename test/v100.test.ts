import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startProxy, type RunningProxy } from "../src/proxy.js";

// ---------------------------------------------------------------------------
// v0.10.0 fix1 (fix-proxy-nontransactional-forward-uncaught-rejection): the
// non-transactional forward() call (commit === null, proxy.ts:196) was
// fire-and-forget with NO .catch(), so any upstream error rejected the forward
// promise unhandled and (under Node's default --unhandled-rejections=throw)
// crashed the proxy process. fail() already wrote the 502 to res (and released
// the record on the transactional path), so the rejection carried no useful
// work — but left uncaught it terminated the process on ANY non-transactional
// GET/page-load whose upstream errored. The transactional call site (.catch on
// the `settled` chain) and the tunnel's non-transactional call site
// (connect.ts) both already caught; only this site was missing it.
//
// This test fires a non-transactional GET to a dead upstream and asserts BOTH
// that the client receives 502 (fail()'s visible, correct behavior) AND that no
// `unhandledRejection` surfaces (the .catch now swallows it).
// ---------------------------------------------------------------------------
describe("v0.10.0 fix1: non-transactional forward error does not crash the proxy", () => {
  let proxy: RunningProxy;

  beforeEach(async () => {
    proxy = await startProxy({ port: 0, log: false });
  });

  afterEach(async () => {
    await proxy.close();
  });

  it("returns 502 to the client and surfaces no unhandledRejection on a dead upstream", async () => {
    const rejections: unknown[] = [];
    const onUR = (err: unknown) => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onUR);
    try {
      // Non-transactional (no x-idem-key) GET to a dead port -> ECONNREFUSED on
      // the request leg. forward() rejects via fail(); pre-fix the call site had
      // no .catch(), so the rejection was unhandled.
      const r = await fetch(`http://localhost:${proxy.port}/x`, {
        headers: { "x-idem-target": "http://127.0.0.1:1" },
      });
      expect(r.status).toBe(502);
      // Drain the body fail() wrote so the response completes cleanly.
      await r.text();
      // Let any unhandled rejection surface on the microtask queue.
      await new Promise((res) => setTimeout(res, 100));
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUR);
    }
  }, 5000);

  it("stays alive and serving after a dead-upstream non-transactional forward", async () => {
    // A second, healthy non-transactional request right after the dead one must
    // still succeed — pre-fix the unhandled rejection terminated the process and
    // this follow-up would fail to connect.
    const dead = await fetch(`http://localhost:${proxy.port}/x`, {
      headers: { "x-idem-target": "http://127.0.0.1:1" },
    });
    expect(dead.status).toBe(502);
    await dead.text();

    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upPort = (upstream.address() as AddressInfo).port;
    try {
      const r = await fetch(`http://localhost:${proxy.port}/y`, {
        headers: { "x-idem-target": `http://127.0.0.1:${upPort}` },
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("ok");
    } finally {
      upstream.closeAllConnections?.();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  }, 8000);
});

// ---------------------------------------------------------------------------
// v0.10.0 fix2 (fix-proxy-streaming-midstream-error-hangs-client): v0.9.0 moved
// response header-sending to the response event in the commit === null streaming
// branch, so res.headersSent is true BEFORE "end". A mid-stream upstream
// error/abort then hit fail()'s `if (!res.headersSent)` guard: it (correctly)
// skipped the 502 but never ended/destroyed res, so the client hung until its
// own timeout. Pre-v0.9.0 the buffering path sent headers only at "end", so a
// mid-stream error cleanly 502'd. The fix ends the partial response in fail()
// when headers were already sent (else res.end()). Scoped to the
// non-transactional streaming branch only.
// ---------------------------------------------------------------------------

// http path (proxy.ts forward()).
describe("v0.10.0 fix2: mid-stream upstream error terminates the streaming client (http)", () => {
  let proxy: RunningProxy;
  let upstream: http.Server;
  let upstreamPort: number;

  beforeEach(async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      // Destroy the underlying socket mid-stream -> the proxy's upRes emits
      // "aborted"/"error" without "end".
      setTimeout(() => res.socket?.destroy(), 30);
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

  it("ends the partial response instead of hanging the client", async () => {
    const r = await fetch(`http://localhost:${proxy.port}/stream`, {
      headers: { "x-idem-target": `http://127.0.0.1:${upstreamPort}` },
    });
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(first.value ?? new Uint8Array())).toContain(
      "data: first",
    );
    // Pre-fix: fail()'s !res.headersSent guard skipped the 502 (headers already
    // sent) and never ended res -> the reader never reached `done`. Post-fix
    // fail() ends the partial response, so the stream terminates within the
    // deadline.
    const result = await Promise.race([
      reader.read().then((chunk) => ({ done: chunk.done, hung: false })),
      new Promise<{ done: boolean; hung: boolean }>((res) =>
        setTimeout(() => res({ done: false, hung: true }), 1500),
      ),
    ]);
    expect(result.hung).toBe(false);
    expect(result.done).toBe(true);
  }, 5000);
});

// https CONNECT tunnel path (connect.ts forwardHttps) — same defect, same fix.
describe("v0.10.0 fix2: mid-stream upstream error terminates the streaming client (https tunnel)", () => {
  let dir: string;
  let upstream: https.Server;
  let upstreamPort: number;
  let proxy: RunningProxy;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "idem-bug2-tunnel-"));
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
        setTimeout(() => res.socket?.destroy(), 30);
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

  // CONNECT + MITM TLS + one non-transactional GET over the tunnel whose
  // upstream destroys mid-stream. Resolves with whether the response ENDED
  // (client resp "end" fired) vs hung past the deadline.
  function tunnelStreamGet(
    proxyPort: number,
    upPort: number,
    caCertPem: string | undefined,
  ): Promise<{ ended: boolean; status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
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
              resp.on("data", (c: Buffer) => chunks.push(c));
              resp.on("end", () =>
                resolve({
                  ended: true,
                  status: resp.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
              resp.on("error", () =>
                // A response-stream error that reaches the client also counts as
                // "terminated" (not a hang); the fix routes through fail() which
                // ends res, surfacing here as end/error rather than a hang.
                resolve({
                  ended: true,
                  status: resp.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          reqOverTunnel.on("error", () =>
            resolve({ ended: true, status: 0, body: "" }),
          );
          reqOverTunnel.end();
        });
      });
      connectReq.end();
    });
  }

  it("ends the partial response through the CONNECT tunnel instead of hanging", async () => {
    const result = await Promise.race([
      tunnelStreamGet(proxy.port, upstreamPort, proxy.caCertPem),
      new Promise<{ ended: boolean; status: number; body: string }>((res) =>
        setTimeout(() => res({ ended: false, status: 0, body: "" }), 1500),
      ),
    ]);
    // Pre-fix: forwardHttps buffered/streamed then fail()'s !res.headersSent
    // guard skipped the 502 and never ended res -> the tunnel client hung past
    // the deadline. Post-fix fail() ends the partial response.
    expect(result.ended).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toContain("data: first");
  }, 5000);
});
