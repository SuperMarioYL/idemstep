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

  it("fires the effect exactly once for CONCURRENT same-key calls", async () => {
    let effects = 0;
    const key = generateKey("order");
    const slowSubmit = () =>
      idemStep("place_order", key, async () => {
        await new Promise((r) => setTimeout(r, 20));
        effects += 1;
        return `receipt-${effects}`;
      });

    // Fire three attempts BEFORE any of them commits — the exact window a
    // self-healing harness re-drives a slow-but-successful submit in.
    const [a, b, c] = await Promise.all([slowSubmit(), slowSubmit(), slowSubmit()]);

    expect(effects).toBe(1); // the side effect must still fire exactly once
    expect(a).toBe("receipt-1");
    expect([a, b, c]).toEqual(["receipt-1", "receipt-1", "receipt-1"]);
  });

  it("lets a later call retry after the first attempt rejects", async () => {
    let attempts = 0;
    const key = generateKey("order");
    const flaky = () =>
      idemStep("place_order", key, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network blip");
        return "receipt-ok";
      });

    await expect(flaky()).rejects.toThrow("network blip");
    // The key was NOT committed, so a fresh attempt is allowed to run fn again.
    const ok = await flaky();
    expect(attempts).toBe(2);
    expect(ok).toBe("receipt-ok");
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
// v0.2 — TTL expiry: a committed key past its window is a genuinely new action.
// ---------------------------------------------------------------------------
describe("IdemStore TTL expiry", () => {
  it("treats a committed key as absent once it ages past ttlMs", async () => {
    const store = new IdemStore({ ttlMs: 30 });
    store.begin("k", "place_order");
    store.commit("k", { order: 1 });

    expect(store.isCommitted("k")).toBe(true);
    expect(store.get("k")?.result).toEqual({ order: 1 });

    await new Promise((r) => setTimeout(r, 45));

    // Past the window: lookups behave as if the key never existed.
    expect(store.isCommitted("k")).toBe(false);
    expect(store.get("k")).toBeUndefined();
  });

  it("lets idemStep re-run the effect after a key expires", async () => {
    const store = new IdemStore({ ttlMs: 25 });
    let effects = 0;
    const submit = () =>
      idemStep("place_order", "order-1", () => {
        effects += 1;
        return effects;
      }, { store });

    expect(await submit()).toBe(1);
    expect(await submit()).toBe(1); // within window: replayed

    await new Promise((r) => setTimeout(r, 40));

    expect(await submit()).toBe(2); // window elapsed: a new action runs
    expect(effects).toBe(2);
  });

  it("findCommittedBySig skips expired records", async () => {
    const store = new IdemStore({ ttlMs: 20 });
    store.begin("k", "l");
    store.setRequestSig("k", "sig-x");
    store.commit("k", 1);
    expect(store.findCommittedBySig("sig-x")?.key).toBe("k");

    await new Promise((r) => setTimeout(r, 35));
    expect(store.findCommittedBySig("sig-x")).toBeUndefined();
  });

  it("prune() sweeps expired committed records and returns the count", async () => {
    const store = new IdemStore({ ttlMs: 20 });
    store.begin("a", "l");
    store.commit("a", 1);
    store.begin("b", "l");
    store.commit("b", 2);

    expect(store.prune()).toBe(0); // nothing aged yet
    await new Promise((r) => setTimeout(r, 35));
    expect(store.prune()).toBe(2);
    expect(store.all()).toHaveLength(0);
  });

  it("keeps keys forever when no ttl is configured (v0.1 behaviour)", async () => {
    const store = new IdemStore();
    store.begin("k", "l");
    store.commit("k", 1);
    await new Promise((r) => setTimeout(r, 15));
    expect(store.isCommitted("k")).toBe(true);
    expect(store.prune()).toBe(0);
  });

  it("does not write the inflight promise into the JSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idemstore-ttl-"));
    const filePath = join(dir, "store.json");
    try {
      const store = new IdemStore({ filePath, ttlMs: 1000 });
      await idemStep("place_order", "k", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true };
      }, { store });

      // A fresh instance reading the file must reload a clean committed record.
      const reloaded = new IdemStore({ filePath, ttlMs: 1000 });
      expect(reloaded.isCommitted("k")).toBe(true);
      expect(reloaded.get("k")?.inflight).toBeUndefined();
      expect(reloaded.get("k")?.result).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("forwards a duplicate again once the key's TTL has elapsed", async () => {
    const ttlProxy = await startProxy({ port: 0, ttlMs: 30, log: false });
    const key = generateKey("order");
    const post = () =>
      fetch(`http://localhost:${ttlProxy.port}/checkout`, {
        method: "POST",
        headers: {
          "x-idem-target": `http://${upstreamHost}`,
          "content-type": "application/json",
          [IDEM_KEY_HEADER]: key,
          "x-idem-label": "place_order",
        },
        body: JSON.stringify({ cart: ["sku-1"] }),
      });

    await post();
    await post(); // within window: suppressed
    expect(upstreamHits).toBe(1);
    expect(ttlProxy.suppressedCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 45));
    await post(); // window elapsed: forwarded as a new action
    expect(upstreamHits).toBe(2);

    await ttlProxy.close();
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
