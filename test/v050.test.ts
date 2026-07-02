import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  IDEM_API_KEY_HEADER,
  IDEM_REPLAYED_HEADER,
} from "../src/proxy.js";

// ---------------------------------------------------------------------------
// v0.5.0 fix-shared-store-commit-throws-on-proxy-error: on the documented
// shared-store path (wrapper + proxy share one JSON-file store), when the
// proxy's upstream errors, forward()'s fail() deletes the pending record
// (proxy.ts store.delete) and writes a 502 BEFORE the wrapper's fn resolves.
// If fn handles the 502 gracefully and returns a result without throwing, the
// wrapper's success path calls store.commit(key, result) — but the record was
// deleted by the proxy, so v0.4.0's commit THREW "no pending record" and
// idemStep rejected with that internal invariant instead of returning fn's
// result. The fix makes commit a no-op on a missing record (consistent with
// setResult/setRequestSig/setCachedResponse/setInflight); idemStep's
// store.commit + store.setResult then handles all three cases.
// ---------------------------------------------------------------------------
describe("v0.5.0 fix1: idemStep resolves with fn's result on the shared-store proxy-error race", () => {
  it("a non-throwing fn that handles a 502 resolves with fn's result (not 'no pending record')", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-shared-commit-"));
    const filePath = join(dir, "store.json");
    try {
      // ONE JSON-file store shared between the wrapper and the proxy — the
      // documented "share one with the proxy via a JSON-file path" pattern.
      const shared = new IdemStore({ filePath });
      const proxy = await startProxy({ port: 0, store: shared, log: false });
      const key = generateKey("order");

      // fn fetches through the shared proxy, whose upstream is a dead port, so
      // the proxy's fail() deletes the record and returns 502. fn HANDLES the
      // 502 (returns a result) instead of throwing — the case that exposed the
      // missing-record throw before the fix.
      const result = await idemStep(
        "place_order",
        key,
        async () => {
          const r = await fetch(`http://localhost:${proxy.port}/checkout`, {
            method: "POST",
            headers: {
              "x-idem-target": "http://127.0.0.1:1", // nothing listening → 502
              "content-type": "application/json",
              [IDEM_KEY_HEADER]: key,
              "x-idem-label": "place_order",
            },
            body: JSON.stringify({ cart: ["sku-1"] }),
          });
          // Graceful, non-throwing: surface the 502 as a value.
          return { ok: r.ok, status: r.status };
        },
        { store: shared },
      );

      // Before the fix this awaited promise rejected with
      // "IdemStore.commit: no pending record for key ..." and the test would
      // fail at this await. With the fix, idemStep resolves with fn's result.
      expect(result).toEqual({ ok: false, status: 502 });

      await proxy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v0.5.0 fix-store-persist-non-atomic-silent-load: persist() now writes to a
// sibling .tmp then renames (atomic on POSIX), and load() surfaces a parse or
// shape error via store.loadError (logged by the hosted/proxy CLI on startup)
// instead of silently swallowing it. Before the fix, a crash mid-persist left
// a truncated file and the next start's bare `catch {}` returned silently —
// every committed key was gone and a same-key retry was forwarded as a new
// action (a double-submit) with zero operator visibility.
// ---------------------------------------------------------------------------
describe("v0.5.0 fix2: atomic persist + fail-loud load", () => {
  it("a truncated store file surfaces loadError (fail-loud, not fail-open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-load-loud-"));
    const filePath = join(dir, "store.json");
    try {
      // A previously-valid committed record, then truncate it partway —
      // exactly the partial file a crash mid-write (before the atomic-rename
      // fix) would leave on disk.
      const good = JSON.stringify(
        [
          {
            key: "k1",
            label: "place_order",
            status: "committed",
            result: 1,
            requestSig: "sig",
            createdAt: 1,
            committedAt: 1,
          },
        ],
        null,
        2,
      );
      writeFileSync(filePath, good.slice(0, 12), "utf8"); // partial JSON

      const store = new IdemStore({ filePath });

      // (a) The store does NOT silently pretend all keys are absent: loadError
      // is set so the hosted/proxy CLI can surface the lost state on startup.
      expect(store.loadError).toBeInstanceOf(Error);
      // And it still starts clean (no crash, no half-loaded poison record).
      expect(store.all()).toHaveLength(0);
      expect(store.isCommitted("k1")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an atomic persist leaves no .tmp behind and survives a stale-tmp interruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-atomic-"));
    const filePath = join(dir, "store.json");
    try {
      const store = new IdemStore({ filePath });
      store.begin("k1", "place_order");
      store.commit("k1", { ok: true });

      // After persist: the real file is valid, no .tmp lingers (it was renamed
      // over the target), and a fresh instance recovers the committed key with
      // no loadError.
      expect(existsSync(filePath)).toBe(true);
      expect(existsSync(`${filePath}.tmp`)).toBe(false);
      const reloaded = new IdemStore({ filePath });
      expect(reloaded.loadError).toBeUndefined();
      expect(reloaded.isCommitted("k1")).toBe(true);

      // Simulate a mid-write interruption: a crashed prior run left a garbage
      // .tmp behind (the rename never happened). The REAL file is intact
      // because the atomic write only ever touches the target via rename.
      writeFileSync(`${filePath}.tmp`, "{ partial garbage :: not json");
      const reloaded2 = new IdemStore({ filePath });
      expect(reloaded2.loadError).toBeUndefined();
      expect(reloaded2.isCommitted("k1")).toBe(true); // real file untouched

      // The next persist overwrites the stale garbage .tmp and renames it over
      // the target — the file ends up valid with BOTH keys, no .tmp left.
      store.begin("k2", "place_order");
      store.commit("k2", { ok: true });
      expect(existsSync(`${filePath}.tmp`)).toBe(false);
      const reloaded3 = new IdemStore({ filePath });
      expect(reloaded3.loadError).toBeUndefined();
      expect(reloaded3.isCommitted("k1")).toBe(true);
      expect(reloaded3.isCommitted("k2")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v0.5.0 m_hosted_multi_tenant_auth: `idemstep hosted --api-keys` adds
// per-operator API-key auth + per-key IdemStore namespacing. Two operators
// point a remote Playwright context at the SAME hosted URL; each sends their
// own x-idem-api-key. Dedup state is namespaced per key (one shared JSON-file
// store, each idempotency key prefixed by a hash of the API key) so tenants
// never collide — even when they happen to use the SAME idempotency key. A
// missing/unknown API key is rejected with 401. Single-operator auth/routing
// only; team plans/billing remain out of scope (future v0.6.0+).
// ---------------------------------------------------------------------------
describe("v0.5.0 m1: hosted multi-tenant API-key auth + per-key namespacing", () => {
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

    dir = mkdtempSync(join(tmpdir(), "idem-hosted-mt-"));
    storePath = join(dir, "hosted.json");
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const tsx = join(repoRoot, "node_modules/.bin/tsx");
    const entry = join(repoRoot, "src", "index.ts");

    // Spawn the hosted CLI exactly as an operator would, with two API keys.
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
        "--api-keys",
        "alpha,beta",
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

    // Wait for the ready banner and parse the bound port.
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`hosted multi-tenant proxy did not start:\n${stderr}`)),
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

  // One transactional POST through the hosted proxy. `apiKey` omitted → no
  // x-idem-api-key header (the 401 case).
  function post(apiKey: string | null, idemKey: string): Promise<Response> {
    const headers: Record<string, string> = {
      "x-idem-target": `http://127.0.0.1:${upstreamPort}`,
      "content-type": "application/json",
      [IDEM_KEY_HEADER]: idemKey,
      "x-idem-label": "place_order",
    };
    if (apiKey !== null) headers[IDEM_API_KEY_HEADER] = apiKey;
    return fetch(`http://127.0.0.1:${port}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cart: ["sku-1"] }),
    });
  }

  it("isolates two operators by API key: same idem-key, two orders, dedup logged per key", async () => {
    // Operator alpha places an order, then a self-healing retry fires.
    const alpha1 = await post("alpha", "shared-key");
    const alpha2 = await post("alpha", "shared-key"); // retry — suppressed
    expect(alpha1.status).toBe(200);
    expect(await alpha1.json()).toEqual({ ok: true, order: 1 });
    expect(alpha1.headers.get(IDEM_REPLAYED_HEADER)).toBeNull(); // forwarded
    expect(alpha2.headers.get(IDEM_REPLAYED_HEADER)).toBe("true"); // replayed

    // Operator beta uses the SAME idempotency key ("shared-key"). Without
    // per-key namespacing, beta's first request would be replayed from alpha's
    // committed record (a cross-tenant leak → only one order placed total).
    // With namespacing, beta's "shared-key" lives in a separate namespace and
    // is forwarded as a fresh action → a SECOND order.
    const beta1 = await post("beta", "shared-key");
    const beta2 = await post("beta", "shared-key"); // retry — suppressed
    expect(beta1.status).toBe(200);
    expect(await beta1.json()).toEqual({ ok: true, order: 2 }); // forwarded, not replayed
    expect(beta1.headers.get(IDEM_REPLAYED_HEADER)).toBeNull();
    expect(beta2.headers.get(IDEM_REPLAYED_HEADER)).toBe("true");

    // Exactly one order per operator reached the target site (2 total).
    expect(upstreamHits).toBe(2);

    // The dedup was logged server-side (per namespaced key).
    await new Promise((r) => setTimeout(r, 50));
    expect(stdout).toContain("suppressed");
    // Durable store was written.
    expect(existsSync(storePath)).toBe(true);
  });

  it("rejects a transactional request with no API key (401, not forwarded)", async () => {
    const r = await post(null, "shared-key");
    expect(r.status).toBe(401);
    expect(upstreamHits).toBe(0); // never forwarded
  });

  it("rejects a transactional request with an unknown API key (401, not forwarded)", async () => {
    const r = await post("charlie", "shared-key");
    expect(r.status).toBe(401);
    expect(upstreamHits).toBe(0);
  });
});
