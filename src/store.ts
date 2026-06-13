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
}

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  /** Base64-encoded body so binary responses survive JSON-file persistence. */
  bodyBase64: string;
}

/**
 * The idempotency store. In-memory by default; pass `filePath` to opt into a
 * JSON-file backing so records survive a process restart (the only durable
 * option in v0.1 — Redis/Postgres are explicitly out of scope).
 */
export class IdemStore {
  private readonly records = new Map<IdemKey, StepRecord>();
  private readonly filePath?: string;

  constructor(options: { filePath?: string } = {}) {
    this.filePath = options.filePath;
    if (this.filePath && existsSync(this.filePath)) {
      this.load();
    }
  }

  /** Look up a record by its idempotency key. */
  get(key: IdemKey): StepRecord | undefined {
    return this.records.get(key);
  }

  /** Whether a committed (fully-executed) record exists for this key. */
  isCommitted(key: IdemKey): boolean {
    return this.records.get(key)?.status === "committed";
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
    this.persist();
    return record;
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
    for (const record of this.records.values()) {
      if (record.status === "committed" && record.requestSig === requestSig) {
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

  /** Snapshot of all records (read-only view). */
  all(): StepRecord[] {
    return [...this.records.values()];
  }

  private persist(): void {
    if (!this.filePath) return;
    const data = JSON.stringify([...this.records.values()], null, 2);
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
