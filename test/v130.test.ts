import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { idemStep } from "../src/idemStep.js";
import { IdemStore } from "../src/store.js";
import { startProxy } from "../src/proxy.js";
import { canonicalizeBody, requestSignature } from "../src/key.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const SRC_INDEX_TS = join(REPO_ROOT, "src", "index.ts");

// ---------------------------------------------------------------------------
// v0.13.0 fix1 (fix-wrapper-reject-deletes-committed-record): idemStep's catch
// called store.delete(key) with no status check. On the documented shared-store
// path (wrapper + proxy sharing one IdemStore) the proxy commits the key when
// the upstream response lands — while `fn` is still running — so a throw AFTER
// that network commit (post-response validation) deleted a COMMITTED record and
// let the next retry forward again: a double submit. The fix releases only a
// still-pending record and keeps a committed one.
// ---------------------------------------------------------------------------
describe("v0.13.0 fix1: a committed key survives fn rejecting after the proxy's commit", () => {
  it("does not delete the committed record, so the retry cannot double-submit", async () => {
    let upstreamCalls = 0;
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        upstreamCalls += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ order: upstreamCalls }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    // ONE in-memory store shared between the wrapper and the proxy — the
    // documented "share one with the proxy" pattern.
    const store = new IdemStore();
    const proxy = await startProxy({ port: 0, host: "127.0.0.1", store, log: false });
    const key = "order:shared-post-commit-throw";

    const fn = async () => {
      const r = await fetch(`http://127.0.0.1:${proxy.port}/orders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idem-key": key,
          "x-idem-target": `http://127.0.0.1:${upstreamPort}`,
        },
        body: JSON.stringify({ item: "example-book", quantity: 1 }),
      });
      const body = (await r.json()) as { order: number };
      // The upstream side effect has already happened (and the proxy has already
      // committed the key) when this throws.
      throw new Error(`post-response validation failed for order ${body.order}`);
    };

    try {
      await expect(idemStep("place_order", key, fn, { store })).rejects.toThrow(
        "post-response validation failed",
      );
      // Pre-fix this was ABSENT: the wrapper had deleted the proxy's commit.
      expect(store.get(key)?.status).toBe("committed");
      expect(upstreamCalls).toBe(1);

      // A self-healing retry re-drives the same logical action. Because the
      // committed record survived, it short-circuits instead of forwarding a
      // second order.
      await idemStep("place_order", key, fn, { store });
      expect(upstreamCalls).toBe(1);
    } finally {
      await proxy.close();
      upstream.closeAllConnections?.();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  }, 10000);

  it("still releases a pending record when fn rejects before any commit", async () => {
    // The v0.4.0 no-poison-pending guarantee must survive the narrower delete:
    // a record that never reached `committed` is dropped, so a later retry runs
    // fn again instead of being blocked by an abandoned key.
    const store = new IdemStore();
    await expect(
      idemStep(
        "place_order",
        "order:pending-throw",
        async () => {
          throw new Error("network blip");
        },
        { store },
      ),
    ).rejects.toThrow("network blip");

    expect(store.get("order:pending-throw")).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// v0.13.0 fix2 (fix-canonicalize-buffer-body-not-canonical): canonicalizeBody
// is documented as order-independent for JSON bodies, and RequestShape.body
// documents Buffers as normalized before hashing — but the Buffer branch
// returned toString("utf8") verbatim. The proxy hashes rawBody Buffers on every
// forward, so this was the branch that actually mattered. The old test passed
// only because its single-key fixture has no reorderable keys.
// ---------------------------------------------------------------------------
describe("v0.13.0 fix2: canonicalizeBody canonicalizes Buffer bodies", () => {
  it("sorts JSON keys in a Buffer exactly like the string and object forms", () => {
    const buffer = Buffer.from('{"b":2,"a":1}');
    const raw = '{"b":2,"a":1}';

    // Pre-fix: '{"b":2,"a":1}' (raw bytes). Post-fix: '{"a":1,"b":2}'.
    expect(canonicalizeBody(buffer)).toBe('{"a":1,"b":2}');
    expect(canonicalizeBody(buffer)).toBe(canonicalizeBody(raw));
    expect(canonicalizeBody(buffer)).toBe(canonicalizeBody({ b: 2, a: 1 }));
  });

  it("keeps a non-JSON Buffer as its raw text", () => {
    expect(canonicalizeBody(Buffer.from("item=book&qty=1"))).toBe("item=book&qty=1");
  });

  it("gives a JSON Buffer and the equivalent object the same requestSignature", () => {
    const fromBuffer = requestSignature({
      method: "POST",
      url: "http://x/checkout",
      body: Buffer.from('{"b":2,"a":1}'),
    });
    const fromObject = requestSignature({
      method: "POST",
      url: "http://x/checkout",
      body: { a: 1, b: 2 },
    });
    expect(fromBuffer).toBe(fromObject);
  });
});

// ---------------------------------------------------------------------------
// v0.13.0 quality-stale-v060-roadmap-label-in-usage: the --help banner shipped
// "team plans, billing, and local-library multi-user remain future v0.6.0+" at
// v0.12.0. A version promise about a past release is stale documentation, the
// same drift class the v0.12.0 README roadmap fix closed.
// ---------------------------------------------------------------------------
describe("v0.13.0: CLI help carries no stale version promise", () => {
  it("does not advertise a future feature in a release that already shipped", () => {
    const out = execFileSync(TSX, [SRC_INDEX_TS, "--help"], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
    });
    expect(out).toContain("remain out of scope");
    expect(out).not.toContain("future v0.6.0+");
  });
});
