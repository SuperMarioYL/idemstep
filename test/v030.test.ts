import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdemStore } from "../src/store.js";
import { generateKey } from "../src/key.js";
import {
  startProxy,
  IDEM_KEY_HEADER,
  IDEM_REPLAYED_HEADER,
  type RunningProxy,
} from "../src/proxy.js";

// ---------------------------------------------------------------------------
// m7 — the JSON-file store validates loaded records instead of trusting the
// parsed shape: missing keys, bogus status, and persisted pending are dropped.
// ---------------------------------------------------------------------------
describe("m7: store validates records loaded from the JSON file", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "idemstore-load-"));
    filePath = join(dir, "store.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ignores a file whose top level is not an array", () => {
    writeFileSync(filePath, JSON.stringify({ not: "an array" }), "utf8");
    const store = new IdemStore({ filePath });
    expect(store.all()).toHaveLength(0);
  });

  it("drops elements missing a string key (no undefined-keyed shadow record)", () => {
    writeFileSync(
      filePath,
      JSON.stringify([
        { label: "no-key", status: "committed", createdAt: 1 },
        { key: "good", label: "ok", status: "committed", result: 7, createdAt: 1, committedAt: 1 },
      ]),
      "utf8",
    );
    const store = new IdemStore({ filePath });
    expect(store.all()).toHaveLength(1);
    expect(store.get("good")?.result).toBe(7);
    expect(store.get(undefined as unknown as string)).toBeUndefined();
  });

  it("drops records with a bogus status", () => {
    writeFileSync(
      filePath,
      JSON.stringify([{ key: "k", label: "l", status: "weird", createdAt: 1 }]),
      "utf8",
    );
    expect(new IdemStore({ filePath }).all()).toHaveLength(0);
  });

  it("drops persisted pending records (an in-flight action cannot survive a restart)", () => {
    writeFileSync(
      filePath,
      JSON.stringify([
        { key: "half", label: "place_order", status: "pending", requestSig: "sig", createdAt: 1 },
        { key: "done", label: "place_order", status: "committed", result: 1, createdAt: 1, committedAt: 1 },
      ]),
      "utf8",
    );
    const store = new IdemStore({ filePath });
    expect(store.get("half")).toBeUndefined();
    expect(store.isCommitted("done")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// m5 — a committed record is final: setRequestSig/commit refuse to clobber it.
// ---------------------------------------------------------------------------
describe("m5: committed records are immutable in the store", () => {
  it("setRequestSig refuses to overwrite a committed record's signature", () => {
    const store = new IdemStore();
    store.begin("k", "place_order");
    expect(store.setRequestSig("k", "sig-A")).toBe(true);
    store.commit("k", { ok: true });

    // A drifted-body retry must NOT be able to re-bind the signature.
    expect(store.setRequestSig("k", "sig-B")).toBe(false);
    expect(store.get("k")?.requestSig).toBe("sig-A");
  });

  it("commit on an already-committed record is a no-op (keeps the first result)", () => {
    const store = new IdemStore();
    store.begin("k", "l");
    store.commit("k", "first");
    const before = store.get("k")?.committedAt;
    store.commit("k", "second");
    expect(store.get("k")?.result).toBe("first");
    expect(store.get("k")?.committedAt).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// m4 / m5 / m6 — proxy-layer concurrency + committed-replay + error release.
// ---------------------------------------------------------------------------
describe("m4/m5/m6: proxy concurrency, committed replay, pending release", () => {
  let upstream: http.Server;
  let upstreamHost: string;
  let upstreamHits = 0;
  let delayMs = 0;
  let proxy: RunningProxy;

  beforeEach(async () => {
    upstreamHits = 0;
    delayMs = 0;
    upstream = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/checkout") {
        upstreamHits += 1;
        const order = upstreamHits;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, order }));
        }, delayMs);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const { port } = upstream.address() as AddressInfo;
    upstreamHost = `127.0.0.1:${port}`;
    proxy = await startProxy({ port: 0, log: false });
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const post = (key: string, body: unknown) =>
    fetch(`http://localhost:${proxy.port}/checkout`, {
      method: "POST",
      headers: {
        "x-idem-target": `http://${upstreamHost}`,
        "content-type": "application/json",
        [IDEM_KEY_HEADER]: key,
        "x-idem-label": "place_order",
      },
      body: JSON.stringify(body),
    });

  it("m4: two CONCURRENT same-key requests forward upstream exactly once", async () => {
    delayMs = 40; // hold the first request open so the second races in mid-flight
    const key = generateKey("order");

    const [r1, r2] = await Promise.all([
      post(key, { cart: ["sku-1"] }),
      post(key, { cart: ["sku-1"] }),
    ]);
    const [j1, j2] = await Promise.all([r1.json(), r2.json()]);

    // The double-POST defect: without proxy coalescing both forward upstream.
    expect(upstreamHits).toBe(1);
    expect(proxy.suppressedCount()).toBe(1);
    // The coalesced request replays the first's cached response.
    expect(j1).toEqual({ ok: true, order: 1 });
    expect(j2).toEqual(j1);
    const replayed = [r1, r2].filter((r) => r.headers.get(IDEM_REPLAYED_HEADER) === "true");
    expect(replayed).toHaveLength(1);
  });

  it("m4: a burst of concurrent same-key requests still forwards once", async () => {
    delayMs = 30;
    const key = generateKey("order");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(key, { cart: ["sku-1"] })),
    );
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(upstreamHits).toBe(1);
    expect(proxy.suppressedCount()).toBe(4);
    for (const b of bodies) expect(b).toEqual({ ok: true, order: 1 });
  });

  it("m5: a committed key with a DRIFTED body replays — never re-forwards or recommits", async () => {
    const key = generateKey("order");

    const r1 = await post(key, { cart: ["sku-1"], rendered: "v1" });
    const j1 = await r1.json();
    expect(upstreamHits).toBe(1);

    // Same key, different body (a self-healing retry re-serialized the form).
    const r2 = await post(key, { cart: ["sku-1"], rendered: "v2-DRIFTED" });
    const j2 = await r2.json();

    // The defect: setRequestSig overwrote the committed record and re-forwarded.
    expect(upstreamHits).toBe(1);
    expect(r2.headers.get(IDEM_REPLAYED_HEADER)).toBe("true");
    expect(j2).toEqual(j1); // original cached response, uncorrupted

    // The committed record still holds the ORIGINAL signature, not the drift.
    const rec = proxy.store.get(key);
    expect(rec?.status).toBe("committed");
  });

  it("m6: an upstream error releases the pending record (no poison-pending leak)", async () => {
    const key = generateKey("order");
    // Point at a dead port so the upstream forward errors.
    const r = await fetch(`http://localhost:${proxy.port}/checkout`, {
      method: "POST",
      headers: {
        "x-idem-target": "http://127.0.0.1:1", // nothing listening
        "content-type": "application/json",
        [IDEM_KEY_HEADER]: key,
        "x-idem-label": "place_order",
      },
      body: JSON.stringify({ cart: ["sku-1"] }),
    });
    expect(r.status).toBe(502);

    // The pending record must be gone (TTL/prune only sweep committed records,
    // so a leaked pending would live forever).
    expect(proxy.store.get(key)).toBeUndefined();
    expect(proxy.store.all()).toHaveLength(0);
  });

  it("m6: a key recovers and forwards normally after an earlier upstream error", async () => {
    const key = generateKey("order");
    await fetch(`http://localhost:${proxy.port}/checkout`, {
      method: "POST",
      headers: {
        "x-idem-target": "http://127.0.0.1:1",
        "content-type": "application/json",
        [IDEM_KEY_HEADER]: key,
        "x-idem-label": "place_order",
      },
      body: JSON.stringify({ cart: ["sku-1"] }),
    }).catch(() => {});

    // Same key, now a healthy upstream — must forward as a fresh action.
    const r = await post(key, { cart: ["sku-1"] });
    expect(r.status).toBe(200);
    expect(upstreamHits).toBe(1);
    expect(await r.json()).toEqual({ ok: true, order: 1 });
  });
});

// ---------------------------------------------------------------------------
// m9 — HTTPS / CONNECT tunnel: dedup/replay works against a real https site.
// ---------------------------------------------------------------------------
describe("m9: HTTPS CONNECT tunnel dedup", () => {
  let dir: string;
  let upstream: https.Server;
  let upstreamPort: number;
  let upstreamHits = 0;
  let proxy: RunningProxy;

  beforeEach(async () => {
    upstreamHits = 0;
    dir = mkdtempSync(join(tmpdir(), "idem-https-up-"));
    const keyP = join(dir, "up.key");
    const crtP = join(dir, "up.crt");
    // A self-signed TLS cert for 127.0.0.1 so the upstream is genuinely HTTPS.
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
      (req, res) => {
        if (req.method === "POST" && req.url === "/checkout") {
          upstreamHits += 1;
          const order = upstreamHits;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, order }));
          return;
        }
        res.writeHead(404).end();
      },
    );
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
    proxy = await startProxy({
      port: 0,
      https: true,
      log: false,
      // Trust the test upstream's self-signed cert (a real https site would not
      // need this). Exercises the proxy → upstream TLS leg honestly.
      upstreamTls: { ca: upstreamCert },
    });
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  // Open a CONNECT tunnel to the proxy, complete the MITM TLS handshake trusting
  // the proxy CA, send one POST through a real HTTP client (so chunked responses
  // are decoded correctly), and return the parsed response.
  const tunnelPost = (key: string, body: unknown): Promise<{ replayed: boolean; json: unknown }> =>
    new Promise((resolve, reject) => {
      const connectReq = http.request({
        host: "localhost",
        port: proxy.port,
        method: "CONNECT",
        path: `127.0.0.1:${upstreamPort}`,
      });
      connectReq.on("connect", (_res, socket) => {
        const tlsSocket = tls.connect({
          socket,
          // Verify against the leaf cert's IP SAN/CN. (Node warns that an IP
          // servername is non-conformant per RFC 6066, but it is what matches
          // the MITM leaf cert minted for this upstream IP.)
          servername: "127.0.0.1",
          ca: proxy.caCertPem, // trust the tunnel's MITM CA
        });
        tlsSocket.on("error", reject);
        tlsSocket.on("secureConnect", () => {
          const payload = JSON.stringify(body);
          const reqOverTunnel = http.request(
            {
              method: "POST",
              path: "/checkout",
              // Reuse the established TLS socket as the transport.
              createConnection: () => tlsSocket as unknown as ReturnType<typeof http.request>["socket"] & object,
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
              resp.on("end", () => {
                const replayed = String(resp.headers[IDEM_REPLAYED_HEADER]) === "true";
                const text = Buffer.concat(chunks).toString("utf8");
                let json: unknown;
                try {
                  json = JSON.parse(text);
                } catch {
                  json = text;
                }
                resolve({ replayed, json });
              });
            },
          );
          reqOverTunnel.on("error", reject);
          reqOverTunnel.end(payload);
        });
      });
      connectReq.on("error", reject);
      connectReq.end();
    });

  it("exposes a CA cert when https interception is on", () => {
    expect(typeof proxy.caCertPem).toBe("string");
    expect(proxy.caCertPem).toContain("BEGIN CERTIFICATE");
  });

  it("forwards the first https request and replays the duplicate (upstream hit once)", async () => {
    const key = generateKey("order");

    const first = await tunnelPost(key, { cart: ["sku-1"], total: 4200 });
    expect(first.replayed).toBe(false);
    expect(first.json).toEqual({ ok: true, order: 1 });

    const second = await tunnelPost(key, { cart: ["sku-1"], total: 4200 });
    expect(second.replayed).toBe(true);
    expect(second.json).toEqual({ ok: true, order: 1 });

    // The real https site recorded exactly one order despite two tunneled POSTs.
    expect(upstreamHits).toBe(1);
    expect(proxy.suppressedCount()).toBe(1);
  });

  it("replays a committed key over the tunnel even when the body drifts (m5 parity)", async () => {
    const key = generateKey("order");
    const a = await tunnelPost(key, { cart: ["sku-1"], rendered: "v1" });
    const b = await tunnelPost(key, { cart: ["sku-1"], rendered: "v2-DRIFTED" });

    expect(upstreamHits).toBe(1);
    expect(b.replayed).toBe(true);
    expect(b.json).toEqual(a.json);
  });

  it("forwards distinct keys independently through the tunnel", async () => {
    await tunnelPost(generateKey("order"), { cart: ["sku-1"] });
    await tunnelPost(generateKey("order"), { cart: ["sku-2"] });
    expect(upstreamHits).toBe(2);
    expect(proxy.suppressedCount()).toBe(0);
  });
});
