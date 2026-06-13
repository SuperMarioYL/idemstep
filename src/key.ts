import { createHash, randomUUID } from "node:crypto";

/**
 * A stable, client-generated idempotency key scoped to one logical action.
 * Borrowed verbatim from Stripe's `Idempotency-Key` contract: the *client*
 * mints it, and the same key denotes "this is the same logical operation,
 * even if it is re-driven".
 */
export type IdemKey = string;

/**
 * Canonical, order-independent representation of an outbound transactional
 * request. Two requests collide on `requestSig` iff they are
 * method + host + path + (canonical) body equivalent — which is exactly the
 * unit at which a self-healing retry duplicates a side effect.
 */
export interface RequestShape {
  method: string;
  /** Full URL or `host/path`; querystring is included, fragments stripped. */
  url: string;
  /** Raw request body. Buffers and objects are normalized before hashing. */
  body?: string | Buffer | Record<string, unknown> | null;
}

/**
 * Mint a fresh idempotency key. Callers are encouraged to derive a *stable*
 * key from their own domain data (e.g. `order:${cartId}`) so a retry across
 * process restarts still collides — but a random v4 UUID is a safe default
 * for a single in-process run.
 */
export function generateKey(prefix?: string): IdemKey {
  const id = randomUUID();
  return prefix ? `${prefix}:${id}` : id;
}

/**
 * Normalize a request body to a deterministic string so that semantically
 * identical bodies (e.g. JSON with re-ordered keys) hash to the same value.
 */
export function canonicalizeBody(body: RequestShape["body"]): string {
  if (body === undefined || body === null) return "";
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") {
    // Attempt to canonicalize JSON; fall back to the raw string (e.g. form
    // urlencoded or opaque payloads) when it is not valid JSON.
    try {
      return stableStringify(JSON.parse(body));
    } catch {
      return body;
    }
  }
  return stableStringify(body);
}

/** Deterministic JSON stringify with sorted object keys (recursive). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Compute the `requestSig` for an outbound request: a stable hash of
 * `METHOD host path?query` + a hash of the canonical body. This is the value
 * the proxy matches on to recognize a duplicate transactional request.
 */
export function requestSignature(req: RequestShape): string {
  const method = (req.method || "GET").toUpperCase();

  let host = "";
  let pathAndQuery = req.url;
  try {
    const u = new URL(req.url);
    host = u.host;
    pathAndQuery = `${u.pathname}${u.search}`;
  } catch {
    // Not an absolute URL — treat the whole thing as host/path verbatim.
    host = "";
    pathAndQuery = req.url;
  }

  const bodyHash = createHash("sha256")
    .update(canonicalizeBody(req.body))
    .digest("hex");

  return createHash("sha256")
    .update(`${method}\n${host}\n${pathAndQuery}\n${bodyHash}`)
    .digest("hex");
}
