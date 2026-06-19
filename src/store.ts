import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IdemKey } from "./key.js";

export type StepStatus = "pending" | "committed";

/**
 * The record bound to a single idempotency key. Mirrors the primitive in the
 * spec: a side-effecting browser step that has been (or is being) executed.
 */
export interface StepRecord {
  key: IdemKey;
  /** Human label of the wrapped step, e.g. "place_order". */
  label: string;
  status: StepStatus;
  /** Cached return value of the wrapped fn, replayed on a duplicate call. */
  result?: unknown;
  /**
   * method+host+path+body-hash of the outbound transactional request, set by
   * the proxy when it first observes the request for this key. The proxy uses
   * it to suppress a later duplicate.
   */
  requestSig?: string;
  /** Cached HTTP response, so the proxy can replay it on a suppressed dupe. */
  cachedResponse?: CachedResponse;
  createdAt: number;
  committedAt?: number;
  /**
   * In-flight promise for the *first* `idemStep` call that is currently running
   * `fn` for this key. Concurrent same-key callers await this instead of
   * re-running `fn`, so a side effect fires exactly once even under a race.
   * Never persisted (a promise has no meaning across process restarts).
   */
  inflight?: Promise<unknown>;
}

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  /** Base64-encoded body so binary responses survive JSON-file persistence. */
  bodyBase64: string;
}

export interface IdemStoreOptions {
  /** JSON-file backing so records survive a process restart. */
  filePath?: string;
  /**
   * Time-to-live for a *committed* key, in milliseconds. After a key has been
   * committed for longer than `ttlMs`, it is treated as expired: lookups skip
   * it and a re-run with the same key is a genuinely new action (exactly like
   * Stripe's idempotency window). Omit (or `0`) to keep keys forever — the
   * v0.1 behaviour. A `pending` record is never expired by TTL; an in-flight
   * action always settles first.
   */
  ttlMs?: number;
}

/**
 * The idempotency store. In-memory by default; pass `filePath` to opt into a
 * JSON-file backing so records survive a process restart (the only durable
 * option in v0.x — Redis/Postgres are explicitly out of scope). Pass `ttlMs`
 * to expire committed keys after a window so the store does not grow unbounded
 * across a long-running agent session.
 */
export class IdemStore {
  private readonly records = new Map<IdemKey, StepRecord>();
  private readonly filePath?: string;
  private readonly ttlMs: number;

  constructor(options: IdemStoreOptions = {}) {
    this.filePath = options.filePath;
    this.ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : 0;
    if (this.filePath && existsSync(this.filePath)) {
      this.load();
    }
  }

  /**
   * Whether a committed record has aged past the configured TTL. Always false
   * when no TTL is set or the record is still `pending` (in-flight work must
   * settle before it can expire).
   */
  private isExpired(record: StepRecord, now: number = Date.now()): boolean {
    if (this.ttlMs <= 0) return false;
    if (record.status !== "committed") return false;
    const since = record.committedAt ?? record.createdAt;
    return now - since >= this.ttlMs;
  }

  /**
   * Look up a record by its idempotency key. A committed record that has aged
   * past the TTL is dropped and treated as absent, so the next call for that
   * key runs anew.
   */
  get(key: IdemKey): StepRecord | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.records.delete(key);
      this.persist();
      return undefined;
    }
    return record;
  }

  /** Whether a non-expired committed record exists for this key. */
  isCommitted(key: IdemKey): boolean {
    return this.get(key)?.status === "committed";
  }

  /**
   * Create a `pending` record for a key if none exists, returning the record.
   * If one already exists it is returned untouched — the caller decides what
   * to do based on its status.
   */
  begin(key: IdemKey, label: string): StepRecord {
    const existing = this.records.get(key);
    if (existing) return existing;
    const record: StepRecord = {
      key,
      label,
      status: "pending",
      createdAt: Date.now(),
    };
    this.records.set(key, record);
    this.persist();
    return record;
  }

  /** Mark a key committed and cache the wrapped fn's result. */
  commit(key: IdemKey, result: unknown): StepRecord {
    const record = this.records.get(key);
    if (!record) {
      throw new Error(`IdemStore.commit: no pending record for key "${key}"`);
    }
    record.status = "committed";
    record.result = result;
    record.committedAt = Date.now();
    // The action has settled — drop the in-flight handle so the record can be
    // garbage-collected cleanly and never lingers as a stale promise.
    record.inflight = undefined;
    this.persist();
    return record;
  }

  /**
   * Record the in-flight promise for the call currently running `fn` for this
   * key. Concurrent same-key callers can await it (see {@link getInflight})
   * instead of firing the side effect a second time. Not persisted.
   */
  setInflight(key: IdemKey, promise: Promise<unknown>): void {
    const record = this.records.get(key);
    if (!record) return;
    record.inflight = promise;
  }

  /** The in-flight promise for a key, if a call is mid-flight; else undefined. */
  getInflight(key: IdemKey): Promise<unknown> | undefined {
    return this.records.get(key)?.inflight;
  }

  /** Clear the in-flight handle for a key (e.g. when its `fn` rejected). */
  clearInflight(key: IdemKey): void {
    const record = this.records.get(key);
    if (record) record.inflight = undefined;
  }

  /** Attach the outbound request signature observed by the proxy. */
  setRequestSig(key: IdemKey, requestSig: string): void {
    const record = this.records.get(key);
    if (!record) return;
    record.requestSig = requestSig;
    this.persist();
  }

  /** Cache the HTTP response so the proxy can replay it on a duplicate. */
  setCachedResponse(key: IdemKey, response: CachedResponse): void {
    const record = this.records.get(key);
    if (!record) return;
    record.cachedResponse = response;
    this.persist();
  }

  /**
   * Find a committed record whose `requestSig` matches the given signature.
   * This is the lookup the proxy performs on every outbound request to decide
   * "have I already let this exact transactional request through?".
   */
  findCommittedBySig(requestSig: string): StepRecord | undefined {
    const now = Date.now();
    for (const record of this.records.values()) {
      if (
        record.status === "committed" &&
        record.requestSig === requestSig &&
        !this.isExpired(record, now)
      ) {
        return record;
      }
    }
    return undefined;
  }

  /** Drop a single key (mostly useful in tests). */
  delete(key: IdemKey): boolean {
    const ok = this.records.delete(key);
    if (ok) this.persist();
    return ok;
  }

  /** Remove every record. */
  clear(): void {
    this.records.clear();
    this.persist();
  }

  /**
   * Sweep every committed record that has aged past the TTL and return how many
   * were removed. A no-op (returns `0`) when no TTL is configured. Call this
   * periodically from a long-running agent to keep the store — and its JSON
   * file — bounded; lookups already expire keys lazily, but `prune()` reclaims
   * memory for keys that are never looked up again.
   */
  prune(): number {
    if (this.ttlMs <= 0) return 0;
    const now = Date.now();
    let removed = 0;
    for (const [key, record] of this.records) {
      if (this.isExpired(record, now)) {
        this.records.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  /** Snapshot of all records (read-only view). */
  all(): StepRecord[] {
    return [...this.records.values()];
  }

  private persist(): void {
    if (!this.filePath) return;
    // Strip the non-serializable `inflight` promise; it is process-local state.
    const serializable = [...this.records.values()].map(
      ({ inflight: _inflight, ...rest }) => rest,
    );
    const data = JSON.stringify(serializable, null, 2);
    writeFileSync(this.filePath, data, "utf8");
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StepRecord[];
      for (const record of parsed) {
        this.records.set(record.key, record);
      }
    } catch {
      // Corrupt or empty store file — start clean rather than crash.
    }
  }
}
