import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import express, { type Request, type Response } from "express";
import { IdemStore, type CachedResponse } from "./store.js";
import { requestSignature, type IdemKey } from "./key.js";
import { CertAuthority, attachConnectTunnel } from "./connect.js";

/**
 * Header the agent (via `idemStep`) attaches to a transactional request to
 * declare its idempotency key. The proxy binds the request's `requestSig` to
 * this key the first time it forwards it, then suppresses any later request
 * carrying the same signature under a committed key.
 */
export const IDEM_KEY_HEADER = "x-idem-key";

/** Header the proxy stamps on a replayed response so callers can see dedup. */
export const IDEM_REPLAYED_HEADER = "x-idem-replayed";

/**
 * Header an operator stamps on a transactional request to authenticate to the
 * multi-tenant hosted proxy (`idemstep hosted --api-keys`). The proxy reads it
 * to resolve the per-operator namespace, then strips it before forwarding
 * upstream (it is proxy-control metadata, not destined for the target site).
 * Single-tenant mode (`idemstep proxy`, or `hosted` without `--api-keys`)
 * never consults this header.
 */
export const IDEM_API_KEY_HEADER = "x-idem-api-key";

/**
 * Multi-tenant hook for `idemstep hosted --api-keys`. Called for every
 * transactional request carrying an `x-idem-key`. Return the (possibly
 * rewritten) idempotency key to dedup under — the hosted proxy returns
 * `${sha256(apiKey).slice(0,16)}::${original}` so one shared JSON-file store
 * isolates operators by namespace, and the proxy's in-flight coalescing map
 * (also keyed by the idempotency key) stays per-operator too. Return `null` to
 * reject the request as unauthorized (the proxy responds 401 and does NOT
 * forward). When omitted, the proxy uses the raw `x-idem-key` verbatim
 * (single-tenant mode) — so all existing single-tenant behavior is unchanged.
 */
export type AuthorizeKey = (
  req: http.IncomingMessage,
  idemKey: string,
) => string | null;

export interface ProxyOptions {
  /** Port to listen on. 0 picks a free port (returned by `start`). */
  port?: number;
  /**
   * Hostname/interface to bind. Omit to listen on all interfaces (the default
   * `idemstep proxy` behaviour). The `idemstep hosted` command binds `0.0.0.0`
   * by default so a remote Playwright context can route through it; pass
   * `127.0.0.1` for local-only.
   */
  host?: string;
  /** Store backing the dedup decision. Defaults to a fresh in-memory store. */
  store?: IdemStore;
  /**
   * TTL (ms) for committed keys, when the proxy creates its own store. After
   * the window a duplicate is forwarded as a new action instead of suppressed.
   * Ignored when an explicit `store` is supplied (configure the TTL there).
   */
  ttlMs?: number;
  /** Optional logger; defaults to console. Pass `false` to silence. */
  log?: ((line: string) => void) | false;
  /**
   * Enable HTTPS interception via a CONNECT+MITM tunnel (see connect.ts). When
   * on, the proxy terminates `CONNECT host:443` tunnels with a locally-trusted
   * leaf cert and runs the same x-idem-key dedup/replay over the decrypted
   * HTTPS traffic, so dedup works against real https checkout sites — not just
   * plaintext fixtures. The client must trust the tunnel CA, exposed on the
   * returned proxy as `caCertPem`. Requires the system `openssl` binary; if it
   * is unavailable the proxy still starts and serves plain http (tunneling is
   * skipped). Off by default.
   */
  https?: boolean;
  /**
   * TLS options for the tunnel's *upstream* leg (proxy → real https site). Use
   * `ca` to trust a private upstream CA, or `rejectUnauthorized: false` to
   * accept self-signed upstreams in tests/dev. Production https sites with
   * public certs need none of this. Only consulted when `https: true`.
   */
  upstreamTls?: { ca?: string | string[] | Buffer | Buffer[]; rejectUnauthorized?: boolean };
  /**
   * Multi-tenant auth + per-operator key namespacing hook (used by `idemstep
   * hosted --api-keys`). See {@link AuthorizeKey}. When omitted, the proxy is
   * single-tenant and uses the raw `x-idem-key` verbatim — the default for
   * `idemstep proxy` and for `hosted` without `--api-keys`.
   */
  authorizeKey?: AuthorizeKey;
}

export interface RunningProxy {
  port: number;
  store: IdemStore;
  /** Count of transactional requests suppressed (replayed) so far. */
  suppressedCount: () => number;
  /**
   * PEM of the CA the HTTPS tunnel signs leaf certs with, when `https: true`.
   * Trust this in the client (e.g. `NODE_EXTRA_CA_CERTS`) to accept the MITM.
   * `undefined` when HTTPS interception is off or `openssl` was unavailable.
   */
  caCertPem?: string;
  close: () => Promise<void>;
}

/**
 * Start the local IdemStep interception proxy.
 *
 * Playwright is pointed at this proxy via `{ proxy: { server } }`. For each
 * outbound request the proxy:
 *   1. Computes the `requestSig` (method+host+path+body-hash).
 *   2. If a *committed* key already owns that signature, it does NOT forward —
 *      it replays the cached response. The duplicate becomes a no-op at the
 *      network boundary (the order is not placed twice).
 *   3. Otherwise it forwards upstream, caches the response, and — when the
 *      request declared an `x-idem-key` — marks that key committed and binds
 *      the signature to it.
 *
 * Only requests carrying the `x-idem-key` header participate in dedup;
 * everything else (page loads, assets, GETs) is forwarded transparently.
 */
export function startProxy(options: ProxyOptions = {}): Promise<RunningProxy> {
  const store = options.store ?? new IdemStore({ ttlMs: options.ttlMs });
  const log =
    options.log === false
      ? () => {}
      : options.log ?? ((line: string) => console.log(`[idemstep] ${line}`));

  let suppressed = 0;
  // In-flight forwards keyed by idemKey. While the first request for a key is
  // still waiting on its upstream response (not yet committed), a second same-key
  // request awaits this promise and replays the same cached response instead of
  // forwarding a second time — the network-side analogue of idemStep()'s
  // in-flight coalescing. Without this, two concurrent same-key submits both see
  // the key as not-yet-committed and both POST upstream (a double order).
  const inflightForwards = new Map<IdemKey, Promise<CachedResponse>>();
  const app = express();

  // Capture the raw body for every method so we can hash it into requestSig.
  app.use((req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      (req as RawBodyRequest).rawBody = Buffer.concat(chunks);
      next();
    });
    req.on("error", next);
  });

  app.all(/.*/, (req, res) => {
    const target = resolveTarget(req);
    if (!target) {
      res.status(400).send("idemstep proxy: cannot resolve target URL");
      return;
    }

    let idemKey = headerValue(req.headers[IDEM_KEY_HEADER]);
    const rawBody = (req as RawBodyRequest).rawBody ?? Buffer.alloc(0);

    // Non-transactional traffic (no idempotency key) is forwarded untouched.
    if (!idemKey) {
      forward(target, req, rawBody, res, null, store, log);
      return;
    }

    // Multi-tenant hosted mode: authenticate the operator (401 on a
    // missing/unknown x-idem-api-key) and namespace the idempotency key by the
    // operator so one shared store — and the in-flight coalescing map — isolates
    // tenants. Single-tenant mode (no authorizeKey hook) leaves the raw key
    // untouched, exactly as before. The namespaced key is what gets committed,
    // replayed, and coalesced downstream, so the rest of the handler is
    // unchanged.
    if (options.authorizeKey) {
      const authorized = options.authorizeKey(req, idemKey);
      if (authorized === null) {
        res
          .status(401)
          .send("idemstep proxy: unauthorized (valid x-idem-api-key required)");
        return;
      }
      idemKey = authorized;
    }

    const sig = requestSignature({
      method: req.method,
      url: target,
      body: rawBody.length ? rawBody : null,
    });

    // Duplicate of an already-committed transactional request? The dedup unit is
    // the idempotency *key*: once a key is committed it denotes one logical
    // action, so a later request carrying that same key is a duplicate even if
    // its body has drifted (a self-healing retry may re-render the page and
    // re-serialize the form). We replay the cached response and — critically —
    // never re-forward or re-bind the signature, which would double-submit and
    // corrupt the committed record. A *different* key is always a new action.
    const existing = store.get(idemKey);
    if (existing?.status === "committed" && existing.cachedResponse) {
      suppressed += 1;
      log(
        `suppressed duplicate "${existing.label}" key=${idemKey} sig=${sig.slice(0, 12)} (total ${suppressed})`,
      );
      replay(res, existing.cachedResponse);
      return;
    }

    // A forward for this key is already in flight (committed not yet stamped).
    // Coalesce onto it: await the first request's cached response and replay it
    // rather than firing a second upstream POST for the same logical action.
    const pending = inflightForwards.get(idemKey);
    if (pending) {
      suppressed += 1;
      log(
        `coalescing concurrent duplicate key=${idemKey} sig=${sig.slice(0, 12)} (total ${suppressed})`,
      );
      pending.then(
        (cached) => replay(res, cached),
        (err) => {
          if (!res.headersSent) {
            res.status(502).send(
              `idemstep proxy upstream error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
      return;
    }

    // First time we see this transactional request: record it, forward it,
    // cache the response, and commit the key bound to its signature.
    store.begin(idemKey, labelFor(req) ?? "step");
    store.setRequestSig(idemKey, sig);
    log(`forwarding "${idemKey}" sig=${sig.slice(0, 12)} -> ${target}`);
    const settled = forward(target, req, rawBody, res, { idemKey, sig }, store, log);
    inflightForwards.set(idemKey, settled);
    // Swallow the rejection here so it never surfaces as an unhandled rejection:
    // the upstream-error path already wrote the 502 to `res` and released the
    // pending record. Coalesced waiters observe the rejection via their own
    // `.then(_, onError)` handler registered above.
    settled
      .catch(() => {})
      .finally(() => {
        // Only clear if this exact promise is still the registered one.
        if (inflightForwards.get(idemKey) === settled) inflightForwards.delete(idemKey);
      });
  });

  return new Promise((resolve) => {
    const server = http.createServer(app);

    // HTTPS interception: terminate CONNECT tunnels with a locally-trusted MITM
    // cert and run the same dedup over the decrypted traffic. Best-effort — if
    // `openssl` is unavailable the proxy still serves plain http.
    let ca: CertAuthority | undefined;
    let detachTunnel: (() => void) | undefined;
    if (options.https) {
      try {
        ca = new CertAuthority();
        detachTunnel = attachConnectTunnel(server, {
          store,
          ca,
          upstreamTls: options.upstreamTls,
          log: options.log === false ? () => {} : log,
          onSuppressed: () => {
            suppressed += 1;
          },
          authorizeKey: options.authorizeKey,
        });
      } catch (err) {
        log(
          `HTTPS interception unavailable (${err instanceof Error ? err.message : String(err)}); serving plain http only`,
        );
        ca = undefined;
        detachTunnel = undefined;
      }
    }

    server.listen({ port: options.port ?? 0, host: options.host }, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : (options.port ?? 0);
      log(`listening on http://localhost:${port}`);
      resolve({
        port,
        store,
        suppressedCount: () => suppressed,
        caCertPem: ca?.caCertPem,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => {
              detachTunnel?.();
              ca?.dispose();
              if (err) rej(err);
              else res();
            }),
          ),
      });
    });
  });
}

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

interface CommitContext {
  idemKey: IdemKey;
  sig: string;
}

/**
 * Resolve the upstream URL. Three shapes are supported:
 *   1. HTTP-proxy mode (Playwright): `req.url` is already an absolute URL.
 *   2. Direct-hit mode: an explicit `x-idem-target` header gives the upstream
 *      origin (e.g. `http://127.0.0.1:1234`). The `host` header cannot be
 *      trusted here because clients like `fetch` overwrite it with the proxy's
 *      own address.
 *   3. Fallback: reconstruct from the `host` header (curl, reverse-proxy use).
 */
function resolveTarget(req: Request): string | null {
  if (/^https?:\/\//i.test(req.url)) return req.url;

  const explicit = headerValue(req.headers["x-idem-target"]);
  if (explicit) {
    const origin = explicit.replace(/\/$/, "");
    return /^https?:\/\//i.test(origin) ? `${origin}${req.url}` : `http://${origin}${req.url}`;
  }

  const host = headerValue(req.headers.host);
  if (!host) return null;
  return `http://${host}${req.url}`;
}

function labelFor(req: Request): string | undefined {
  return headerValue(req.headers["x-idem-label"]);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Forward one request upstream, stream the response back to `res`, and (when a
 * `commit` context is given) cache + commit the response under the idem key.
 *
 * Returns a promise that resolves with the {@link CachedResponse} once the
 * upstream response is fully buffered, or rejects if the upstream errors. The
 * caller registers this promise so concurrent same-key requests can coalesce
 * onto it. On an upstream error — whether on the *request* leg (connection
 * refused, DNS, TLS) or the *response* leg (a truncated / prematurely-closed
 * upstream response that never emits "end") — the just-begun pending record is
 * *deleted* before the promise rejects: TTL/prune only sweep committed records,
 * so a pending record left behind by a flaky upstream would otherwise poison
 * the store forever (m6). v0.3.0 hardened only the request leg; v0.4.0 closes
 * the response leg so a truncated response no longer hangs the client.
 */
function forward(
  target: string,
  req: Request,
  body: Buffer,
  res: Response,
  commit: CommitContext | null,
  store: IdemStore,
  log: (line: string) => void,
): Promise<CachedResponse> {
  return new Promise<CachedResponse>((resolve, reject) => {
    const url = new URL(target);
    const client = url.protocol === "https:" ? https : http;

    // Strip hop-by-hop / idem control headers before forwarding upstream.
    const outHeaders = { ...req.headers } as Record<string, string | string[] | undefined>;
    delete outHeaders[IDEM_KEY_HEADER];
    delete outHeaders[IDEM_API_KEY_HEADER];
    delete outHeaders["x-idem-label"];
    delete outHeaders["x-idem-target"];
    delete outHeaders["proxy-connection"];
    outHeaders.host = url.host;

    // One settled flag guards the whole forward so the request-level and
    // response-level error paths never double-write `res`, double-release the
    // record, or settle the promise twice. ("aborted" fires first on a truncated
    // response, then "error" with ECONNRESET — the second is a no-op here.)
    let settled = false;
    const fail = (err: Error, where: "request" | "response"): void => {
      if (settled) return;
      settled = true;
      log(`upstream ${where} error for ${target}: ${err.message}`);
      // Release the just-begun pending record so a flaky upstream cannot leak
      // an un-expirable poison-pending key into the store / JSON file (m6).
      if (commit) store.delete(commit.idemKey);
      if (!res.headersSent) res.status(502).send(`idemstep proxy upstream error: ${err.message}`);
      reject(err);
    };

    const upstream = client.request(
      url,
      { method: req.method, headers: outHeaders },
      (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on("data", (c: Buffer) => chunks.push(c));
        upRes.on("end", () => {
          if (settled) return;
          settled = true;
          const respBody = Buffer.concat(chunks);

          const cached: CachedResponse = {
            status: upRes.statusCode ?? 200,
            headers: snapshotHeaders(upRes.headers),
            bodyBase64: respBody.toString("base64"),
          };

          if (commit) {
            store.setCachedResponse(commit.idemKey, cached);
            // Commit WITHOUT a result: this is a network-commit, not the
            // user-facing return value. The wrapper publishes fn's real result
            // via store.setResult() after fn resolves; stuffing {requestSig,
            // status} here would clobber it on a shared store (requestSig is
            // already a field via setRequestSig, status lives in cached.status).
            store.commit(commit.idemKey);
            log(`committed "${commit.idemKey}" status=${cached.status}`);
          }

          res.status(upRes.statusCode ?? 200);
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v !== undefined) res.setHeader(k, v);
          }
          res.end(respBody);
          resolve(cached);
        });
        // A truncated / prematurely-closed upstream response never emits "end":
        // without these handlers the promise would never settle and `res` would
        // never end, so the client hangs until its own timeout. Treat the
        // response stream's "error" and "aborted" exactly like the request-level
        // error — 502, release the pending record, reject.
        upRes.on("error", (err) => fail(err, "response"));
        upRes.on("aborted", () => fail(new Error("upstream response aborted"), "response"));
      },
    );

    upstream.on("error", (err) => fail(err, "request"));

    if (body.length) upstream.write(body);
    upstream.end();
  });
}

function replay(res: Response, cached: CachedResponse): void {
  res.status(cached.status);
  for (const [k, v] of Object.entries(cached.headers)) {
    // `v` may be a string[] (e.g. set-cookie); res.setHeader emits one header
    // line per array element, so a replayed duplicate carries the same number
    // of Set-Cookie lines as the original forward (v0.6.0: previously the cache
    // joined arrays into one comma-joined string, mangling multi-cookie
    // responses on the replay path a self-healing retry lands on).
    res.setHeader(k, v);
  }
  res.setHeader(IDEM_REPLAYED_HEADER, "true");
  res.end(Buffer.from(cached.bodyBase64, "base64"));
}

/**
 * Snapshot the upstream response headers into the cache. Array-valued headers
 * (notably `set-cookie`, which Node's http module collects into a string[]) are
 * PRESERVED as arrays — `res.setHeader` / `res.writeHead` emit one header line
 * per array element, so a replayed duplicate carries the same multi-valued
 * headers as the original forward. Collapsing arrays into a comma-joined string
 * (the v0.5.0 behaviour) mangled multi-cookie responses on the replay path:
 * per RFC 6265 a comma-joined Set-Cookie cannot be reliably split because
 * cookie values may contain commas (e.g. `Expires=Wed, 09-Jun-2021 ...`).
 */
function snapshotHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}
