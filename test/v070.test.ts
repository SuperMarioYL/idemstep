import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdemStore } from "../src/store.js";
import { generateKey } from "../src/key.js";
import {
  startProxy,
  IDEM_KEY_HEADER,
  type RunningProxy,
} from "../src/proxy.js";

// ---------------------------------------------------------------------------
// v0.7.0 fix-proxy-no-upstream-timeout-poisons-key: there was NO upstream
// timeout on the forward (proxy.ts forward() / connect.ts forwardHttps). A
// stalled backend — one that accepts the connection then goes silent (never
// responds/errors/ends/aborts) — fell through every existing guard (those only
// fire on `error`/`aborted`), so the forward promise never settled, the client
// hung, the pending record leaked as un-expirable poison-pending
// (`store.isExpired` returns false for non-committed records), and a same-key
// retry coalesced onto the hung forward and also hung — permanently breaking
// once-only recovery for that key. The fix bounds the upstream forward with an
// idle timeout (ClientRequest.setTimeout); on expiry it routes through the
// EXISTING `fail()` path (store.delete(commit.idemKey) + 502 + reject) and
// destroys the upstream socket, so the pending record is released and a same-key
// retry forwards fresh instead of coalescing. The `settled` flag makes the
// timeout callback a no-op if the response already settled.
// ---------------------------------------------------------------------------
describe("v0.7.0 fixA: upstream timeout bounds a stalled backend (no poison-pending, no coalesce)", () => {
  let stalled: http.Server;
  let stalledHost: string;
  let upstreamHits: number;
  let proxy: RunningProxy;

  beforeEach(async () => {
    upstreamHits = 0;
    // A stalled backend: accepts the connection, fires the request handler, but
    // never responds/ends/errors/aborts — exactly the case every existing guard
    // (error/aborted) misses. Pre-fix this hung the client forever (until the
    // fetch's own timeout, which Node's fetch has none of).
    stalled = http.createServer((_req, _res) => {
      upstreamHits += 1;
      // intentionally never call res.end() — the backend goes silent
    });
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", () => r()));
    stalledHost = `127.0.0.1:${(stalled.address() as AddressInfo).port}`;
    // --upstream-timeout 200 (threaded via ProxyOptions.upstreamTimeoutMs).
    proxy = await startProxy({ port: 0, log: false, upstreamTimeoutMs: 200 });
  });

  afterEach(async () => {
    await proxy.close();
    // The stalled backend never ends its responses, so its sockets linger even
    // after the proxy destroyed its (proxy-side) upstream socket on timeout.
    // Force-close them so server.close() does not hang waiting on idle conns.
    stalled.closeAllConnections();
    await new Promise<void>((r) => stalled.close(() => r()));
  });

  const post = (key: string) =>
    fetch(`http://localhost:${proxy.port}/checkout`, {
      method: "POST",
      headers: {
        "x-idem-target": `http://${stalledHost}`,
        "content-type": "application/json",
        [IDEM_KEY_HEADER]: key,
        "x-idem-label": "place_order",
      },
      body: JSON.stringify({ cart: ["sku-1"] }),
    });

  it(
    "returns 502 within ~250ms, deletes the pending record, and a same-key retry forwards fresh (no coalesce)",
    async () => {
      const key = generateKey("order");

      const start = Date.now();
      // Pre-fix this await never resolved: the forward promise never settled
      // because the stalled backend fires neither error/aborted/end. The client
      // hung indefinitely and the just-begun pending record leaked forever.
      const r1 = await post(key);
      const elapsed = Date.now() - start;

      // With the timeout the existing fail() path fires: 502 + store.delete +
      // reject, in both forward() (proxy.ts) and forwardHttps() (connect.ts).
      expect(r1.status).toBe(502);
      // ~200ms idle timeout, well under a hang (allow scheduling/IO slack).
      expect(elapsed).toBeLessThan(500);

      // The pending record is RELEASED — no un-expirable poison-pending leak.
      // isExpired() returns false for non-committed records, so a leaked
      // pending would otherwise live for the whole session (and on disk until
      // restart), and a same-key retry would coalesce onto the hung forward.
      expect(proxy.store.get(key)).toBeUndefined();
      expect(proxy.store.all()).toHaveLength(0);

      // A same-key retry does NOT coalesce onto the (now-released) hung forward
      // — it forwards fresh, landing a SECOND upstream hit. Pre-fix the retry
      // awaited the still-registered inflight forward promise and hung too, so
      // once-only recovery was permanently broken for that key.
      const r2start = Date.now();
      const r2 = await post(key);
      const r2elapsed = Date.now() - r2start;
      expect(r2.status).toBe(502);
      expect(r2elapsed).toBeLessThan(500);
      // Two distinct forwards, not one coalesced — the inflightForwards map was
      // cleared via the settled promise's .finally() before this request landed.
      expect(upstreamHits).toBe(2);
    },
    5000,
  );
});

// ---------------------------------------------------------------------------
// v0.7.0 fix-store-replay-crashes-on-malformed-cached-response:
// sanitizeLoadedRecord checked key/status/createdAt/label/requestSig but passed
// cachedResponse through UNVALIDATED — despite its docstring promising to defend
// against hand-edited/half-written files. A committed record with a malformed
// cachedResponse (e.g. missing bodyBase64) survived load (isCommitted true) and
// on the first same-key retry crashed replay() with a TypeError out of
// Buffer.from(undefined, "base64"). The fix validates the cachedResponse shape
// in sanitizeLoadedRecord — require bodyBase64 (string), status (number),
// headers (object) when cachedResponse is present; if malformed, CLEAR the
// cachedResponse field so the record falls through to forward-fresh (the
// proxy's dedup check requires existing.cachedResponse truthy, so a cleared
// field correctly forwards fresh; setCachedResponse repopulates + commit
// no-ops). The repair is audited via store.repairedCachedResponseKeys.
// ---------------------------------------------------------------------------
describe("v0.7.0 fixB: sanitizeLoadedRecord clears a malformed cachedResponse (no replay crash)", () => {
  it(
    "a committed record with cachedResponse missing bodyBase64 is repaired, stays committed, and a same-key retry forwards fresh + repopulates",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "idem-malformed-"));
      const filePath = join(dir, "store.json");
      try {
        // A hand-edited / half-written committed record: cachedResponse present
        // but missing bodyBase64 — survives load (committed records are not
        // dropped) and pre-fix crashed replay() at
        // Buffer.from(cached.bodyBase64, "base64") === Buffer.from(undefined)
        // on the first same-key retry through the proxy.
        const malformed = [
          {
            key: "order-malformed",
            label: "place_order",
            status: "committed",
            requestSig: "sig-xyz",
            cachedResponse: {
              status: 200,
              headers: { "content-type": "application/json" },
              // no bodyBase64 — the malformed shape that crashes replay()
            },
            createdAt: Date.now(),
            committedAt: Date.now(),
          },
        ];
        writeFileSync(filePath, JSON.stringify(malformed, null, 2), "utf8");

        const store = new IdemStore({ filePath });

        // The record survived load (committed, not dropped) — pre-fix it would
        // carry the malformed cachedResponse into the in-memory Map.
        expect(store.isCommitted("order-malformed")).toBe(true);
        // The malformed cachedResponse was CLEARED by sanitizeLoadedRecord
        // (repair), so the proxy's dedup check
        // (existing.status === "committed" && existing.cachedResponse) falls
        // through to forward fresh instead of replaying a crash.
        expect(store.get("order-malformed")?.cachedResponse).toBeUndefined();
        // The repair was audited (fail-loud, not fail-open).
        expect(store.repairedCachedResponseKeys).toContain("order-malformed");

        // Now a same-key retry through the proxy forwards fresh (no crash, no
        // Buffer.from(undefined, "base64")) and repopulates a valid
        // cachedResponse on the committed record.
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
        const upstreamHost = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
        const proxy = await startProxy({ port: 0, store, log: false });
        try {
          const r = await fetch(`http://localhost:${proxy.port}/checkout`, {
            method: "POST",
            headers: {
              "x-idem-target": `http://${upstreamHost}`,
              "content-type": "application/json",
              [IDEM_KEY_HEADER]: "order-malformed",
              "x-idem-label": "place_order",
            },
            body: JSON.stringify({ cart: ["sku-1"] }),
          });
          // Forwarded fresh (not replayed from the malformed cache), no crash.
          expect(r.status).toBe(200);
          expect(await r.json()).toEqual({ ok: true, order: 1 });
          expect(upstreamHits).toBe(1);

          // The cachedResponse is now repopulated with a valid shape (begin
          // returned the existing committed record untouched; setCachedResponse
          // wrote a valid shape onto it; commit no-op'd on the already-
          // committed record). A later same-key retry would replay, not
          // forward again.
          const rec = store.get("order-malformed");
          expect(rec?.status).toBe("committed");
          expect(typeof rec?.cachedResponse?.bodyBase64).toBe("string");
          expect(rec?.cachedResponse?.status).toBe(200);

          // A same-key retry now replays the repopulated cache — no second
          // upstream hit (exactly-once preserved after the repair).
          const r2 = await fetch(`http://localhost:${proxy.port}/checkout`, {
            method: "POST",
            headers: {
              "x-idem-target": `http://${upstreamHost}`,
              "content-type": "application/json",
              [IDEM_KEY_HEADER]: "order-malformed",
              "x-idem-label": "place_order",
            },
            body: JSON.stringify({ cart: ["sku-1"] }),
          });
          expect(r2.status).toBe(200);
          expect(await r2.json()).toEqual({ ok: true, order: 1 });
          expect(upstreamHits).toBe(1); // still one — replayed, not forwarded
        } finally {
          await proxy.close();
          await new Promise<void>((r) => upstream.close(() => r()));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    10000,
  );
});
