import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idemStep, getDefaultStore } from "../src/idemStep.js";
import { IdemStore } from "../src/store.js";
import { generateKey, requestSignature, canonicalizeBody } from "../src/key.js";
import {
  startProxy,
  IDEM_KEY_HEADER,
  IDEM_REPLAYED_HEADER,
  type RunningProxy,
} from "../src/proxy.js";

// ---------------------------------------------------------------------------
// m1 — idemStep wrapper: same key short-circuits, different key runs anew.
// ---------------------------------------------------------------------------
describe("m1: idemStep wrapper", () => {
  beforeEach(() => getDefaultStore().clear());

  it("runs the wrapped fn exactly once for two same-key calls", async () => {
    let effects = 0;
    const key = generateKey("order");
    const run = () =>
      idemStep("place_order", key, () => {
        effects += 1;
        return { order: effects };
      });

    const first = await run();
    const second = await run();

    expect(effects).toBe(1); // the side effect fired once
    expect(first).toEqual({ order: 1 });
    expect(second).toEqual(first); // second call replays the cached result
  });

  it("runs fn again for a different key", async () => {
    let effects = 0;
    const fn = () => {
      effects += 1;
      return effects;
    };
    await idemStep("place_order", "key-a", fn);
    await idemStep("place_order", "key-b", fn);
    expect(effects).toBe(2);
  });

  it("caches async results and never double-fires the effect on retry", async () => {
    let effects = 0;
    const key = generateKey();
    const slowSubmit = () =>
      idemStep("place_order", key, async () => {
        await new Promise((r) => setTimeout(r, 10));
        effects += 1;
        return "receipt-123";
      });

    const a = await slowSubmit();
    const b = await slowSubmit();
    const c = await slowSubmit();

    expect(effects).toBe(1);
    expect([a, b, c]).toEqual(["receipt-123", "receipt-123", "receipt-123"]);
  });

  it("isolates state when an explicit store is passed", async () => {
    const store = new IdemStore();
    let effects = 0;
    const fn = () => {
      effects += 1;
      return effects;
    };
    await idemStep("s", "k", fn, { store });
    await idemStep("s", "k", fn, { store });
    expect(effects).toBe(1);
    expect(store.isCommitted("k")).toBe(true);
    // The default store is untouched.
    expect(getDefaultStore().get("k")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// key.ts — requestSig and key generation.
// ---------------------------------------------------------------------------
describe("requestSignature", () => {
  it("collides for identical method+url+body", () => {
    const a = requestSignature({ method: "POST", url: "http://x/checkout", body: "{\"a\":1}" });
    const b = requestSignature({ method: "post", url: "http://x/checkout", body: "{\"a\":1}" });
    expect(a).toBe(b); // method is case-insensitive
  });

  it("is order-independent for JSON bodies", () => {
    const a = requestSignature({ method: "POST", url: "http://x/c", body: { a: 1, b: 2 } });
    const b = requestSignature({ method: "POST", url: "http://x/c", body: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("differs when the path or body differs", () => {
    const base = requestSignature({ method: "POST", url: "http://x/c", body: { a: 1 } });
    expect(base).not.toBe(requestSignature({ method: "POST", url: "http://x/d", body: { a: 1 } }));
    expect(base).not.toBe(requestSignature({ method: "POST", url: "http://x/c", body: { a: 2 } }));
  });

  it("canonicalizes buffers, strings and objects consistently", () => {
    expect(canonicalizeBody(Buffer.from("{\"a\":1}"))).toBe(canonicalizeBody({ a: 1 }));
    expect(canonicalizeBody(null)).toBe("");
    expect(canonicalizeBody("not-json")).toBe("not-json");
  });

  it("generates unique keys, honoring an optional prefix", () => {
    const k1 = generateKey("order");
    const k2 = generateKey("order");
    expect(k1).not.toBe(k2);
    expect(k1.startsWith("order:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// store.ts — including JSON-file persistence.
// ---------------------------------------------------------------------------
describe("IdemStore", () => {
  it("persists and reloads committed records from a JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "idemstore-"));
    const filePath = join(dir, "store.json");
    try {
      const a = new IdemStore({ filePath });
      a.begin("k1", "place_order");
      a.setRequestSig("k1", "sig-abc");
      a.commit("k1", { ok: true });

      const b = new IdemStore({ filePath }); // fresh instance, same file
      expect(b.isCommitted("k1")).toBe(true);
      expect(b.findCommittedBySig("sig-abc")?.key).toBe("k1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findCommittedBySig ignores pending records", () => {
    const s = new IdemStore();
    s.begin("k", "l");
    s.setRequestSig("k", "sig");
    expect(s.findCommittedBySig("sig")).toBeUndefined();
    s.commit("k", 1);
    expect(s.findCommittedBySig("sig")?.key).toBe("k");
  });
});

// ---------------------------------------------------------------------------
// m2 — proxy dedup: a duplicate transactional POST is suppressed and the
// original response replayed; the upstream sees exactly one request.
// ---------------------------------------------------------------------------
describe("m2: proxy dedup", () => {
  let upstream: http.Server;
  let upstreamHost: string;
  let upstreamHits = 0;
  let proxy: RunningProxy;

  beforeEach(async () => {
    upstreamHits = 0;
    upstream = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/checkout") {
        upstreamHits += 1;
        const order = upstreamHits;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, order }));
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

  const post = (key: string) =>
    fetch(`http://localhost:${proxy.port}/checkout`, {
      method: "POST",
      headers: {
        "x-idem-target": `http://${upstreamHost}`,
        "content-type": "application/json",
        [IDEM_KEY_HEADER]: key,
        "x-idem-label": "place_order",
      },
      body: JSON.stringify({ cart: ["sku-1"], total: 4200 }),
    });

  it("forwards the first request and suppresses duplicates of the same key", async () => {
    const key = generateKey("order");

    const r1 = await post(key);
    const j1 = await r1.json();
    expect(r1.headers.get(IDEM_REPLAYED_HEADER)).toBeNull();

    const r2 = await post(key);
    const j2 = await r2.json();
    const r3 = await post(key);
    const j3 = await r3.json();

    // Upstream saw exactly one order despite three attempts.
    expect(upstreamHits).toBe(1);
    expect(proxy.suppressedCount()).toBe(2);

    // Replays carry the marker and the original (cached) response body.
    expect(r2.headers.get(IDEM_REPLAYED_HEADER)).toBe("true");
    expect(r3.headers.get(IDEM_REPLAYED_HEADER)).toBe("true");
    expect(j2).toEqual(j1);
    expect(j3).toEqual(j1);
    expect(j1).toEqual({ ok: true, order: 1 });
  });

  it("forwards distinct keys independently (no false suppression)", async () => {
    await post(generateKey("order"));
    await post(generateKey("order"));
    expect(upstreamHits).toBe(2);
    expect(proxy.suppressedCount()).toBe(0);
  });

  it("does not dedup requests without an idempotency key", async () => {
    const plain = () =>
      fetch(`http://localhost:${proxy.port}/checkout`, {
        method: "POST",
        headers: {
          "x-idem-target": `http://${upstreamHost}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ cart: ["sku-1"] }),
      });
    await plain();
    await plain();
    expect(upstreamHits).toBe(2);
    expect(proxy.suppressedCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// m3 — end-to-end exactly-once: agent re-drives the submit through the proxy,
// the checkout site records exactly one order. (Mirrors examples/place-order.)
// ---------------------------------------------------------------------------
describe("m3: end-to-end exactly-once", () => {
  it("retries the checkout submit 3x but places exactly one order", async () => {
    let ordersPlaced = 0;
    const site = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/checkout") {
        // slow-but-successful submit
        setTimeout(() => {
          ordersPlaced += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, order: ordersPlaced }));
        }, 30);
        return;
      }
      res.writeHead(200).end("<form></form>");
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    const { port } = site.address() as AddressInfo;
    const proxy = await startProxy({ port: 0, log: false });
    const key = generateKey("order");

    const submit = (attempt: number) =>
      idemStep("place_order", key, async () => {
        const resp = await fetch(`http://localhost:${proxy.port}/checkout`, {
          method: "POST",
          headers: {
            "x-idem-target": `http://127.0.0.1:${port}`,
            "content-type": "application/json",
            [IDEM_KEY_HEADER]: key,
            "x-idem-label": "place_order",
          },
          body: JSON.stringify({ cart: ["sku-1"], attempt }),
        });
        return resp.json();
      });

    // Note: bodies differ per attempt, but idemStep short-circuits on the key
    // before any request is even made for attempts 2 and 3 — proving the
    // client-side guard. The proxy is the network-side backstop.
    const a = await submit(1);
    const b = await submit(2);
    const c = await submit(3);

    expect(ordersPlaced).toBe(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);

    await proxy.close();
    await new Promise<void>((r) => site.close(() => r()));
  });
});
