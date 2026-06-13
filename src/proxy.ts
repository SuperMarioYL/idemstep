import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import express, { type Request, type Response } from "express";
import { IdemStore, type CachedResponse } from "./store.js";
import { requestSignature, type IdemKey } from "./key.js";

/**
 * Header the agent (via `idemStep`) attaches to a transactional request to
 * declare its idempotency key. The proxy binds the request's `requestSig` to
 * this key the first time it forwards it, then suppresses any later request
 * carrying the same signature under a committed key.
 */
export const IDEM_KEY_HEADER = "x-idem-key";

/** Header the proxy stamps on a replayed response so callers can see dedup. */
export const IDEM_REPLAYED_HEADER = "x-idem-replayed";

export interface ProxyOptions {
  /** Port to listen on. 0 picks a free port (returned by `start`). */
  port?: number;
  /** Store backing the dedup decision. Defaults to a fresh in-memory store. */
  store?: IdemStore;
  /** Optional logger; defaults to console. Pass `false` to silence. */
  log?: ((line: string) => void) | false;
}

export interface RunningProxy {
  port: number;
  store: IdemStore;
  /** Count of transactional requests suppressed (replayed) so far. */
  suppressedCount: () => number;
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
  const store = options.store ?? new IdemStore();
  const log =
    options.log === false
      ? () => {}
      : options.log ?? ((line: string) => console.log(`[idemstep] ${line}`));

  let suppressed = 0;
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

    const idemKey = headerValue(req.headers[IDEM_KEY_HEADER]);
    const rawBody = (req as RawBodyRequest).rawBody ?? Buffer.alloc(0);

    // Non-transactional traffic (no idempotency key) is forwarded untouched.
    if (!idemKey) {
      forward(target, req, rawBody, res, null, store, log);
      return;
    }

    const sig = requestSignature({
      method: req.method,
      url: target,
      body: rawBody.length ? rawBody : null,
    });

    // Duplicate of an already-committed transactional request? The dedup unit
    // is "this idempotency key, already committed, whose original requestSig
    // matches what we're seeing again" — a *different* key denotes a genuinely
    // new logical action even if the body is byte-identical, so we never
    // cross-suppress between keys.
    const existing = store.get(idemKey);
    if (
      existing?.status === "committed" &&
      existing.requestSig === sig &&
      existing.cachedResponse
    ) {
      suppressed += 1;
      log(
        `suppressed duplicate "${existing.label}" key=${idemKey} sig=${sig.slice(0, 12)} (total ${suppressed})`,
      );
      replay(res, existing.cachedResponse);
      return;
    }

    // First time we see this transactional request: record it, forward it,
    // cache the response, and commit the key bound to its signature.
    store.begin(idemKey, labelFor(req) ?? "step");
    store.setRequestSig(idemKey, sig);
    log(`forwarding "${idemKey}" sig=${sig.slice(0, 12)} -> ${target}`);
    forward(target, req, rawBody, res, { idemKey, sig }, store, log);
  });

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(options.port ?? 0, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : (options.port ?? 0);
      log(`listening on http://localhost:${port}`);
      resolve({
        port,
        store,
        suppressedCount: () => suppressed,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
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

function forward(
  target: string,
  req: Request,
  body: Buffer,
  res: Response,
  commit: CommitContext | null,
  store: IdemStore,
  log: (line: string) => void,
): void {
  const url = new URL(target);
  const client = url.protocol === "https:" ? https : http;

  // Strip hop-by-hop / idem control headers before forwarding upstream.
  const outHeaders = { ...req.headers } as Record<string, string | string[] | undefined>;
  delete outHeaders[IDEM_KEY_HEADER];
  delete outHeaders["x-idem-label"];
  delete outHeaders["x-idem-target"];
  delete outHeaders["proxy-connection"];
  outHeaders.host = url.host;

  const upstream = client.request(
    url,
    { method: req.method, headers: outHeaders },
    (upRes) => {
      const chunks: Buffer[] = [];
      upRes.on("data", (c: Buffer) => chunks.push(c));
      upRes.on("end", () => {
        const respBody = Buffer.concat(chunks);

        if (commit) {
          const cached: CachedResponse = {
            status: upRes.statusCode ?? 200,
            headers: flattenHeaders(upRes.headers),
            bodyBase64: respBody.toString("base64"),
          };
          store.setCachedResponse(commit.idemKey, cached);
          store.commit(commit.idemKey, {
            requestSig: commit.sig,
            status: cached.status,
          });
          log(`committed "${commit.idemKey}" status=${cached.status}`);
        }

        res.status(upRes.statusCode ?? 200);
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v !== undefined) res.setHeader(k, v);
        }
        res.end(respBody);
      });
    },
  );

  upstream.on("error", (err) => {
    log(`upstream error for ${target}: ${err.message}`);
    if (!res.headersSent) res.status(502).send(`idemstep proxy upstream error: ${err.message}`);
  });

  if (body.length) upstream.write(body);
  upstream.end();
}

function replay(res: Response, cached: CachedResponse): void {
  res.status(cached.status);
  for (const [k, v] of Object.entries(cached.headers)) {
    res.setHeader(k, v);
  }
  res.setHeader(IDEM_REPLAYED_HEADER, "true");
  res.end(Buffer.from(cached.bodyBase64, "base64"));
}

function flattenHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
