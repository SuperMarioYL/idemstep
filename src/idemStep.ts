import { IdemStore } from "./store.js";
import type { IdemKey } from "./key.js";

/**
 * Process-wide default store. Most agent scripts run a single context and a
 * single store; advanced callers can pass their own store per call (or share
 * one with the proxy via a JSON-file path).
 */
let defaultStore = new IdemStore();

/** Replace the process default store (e.g. to point it at a JSON file). */
export function setDefaultStore(store: IdemStore): void {
  defaultStore = store;
}

/** The store `idemStep` uses when no explicit store is supplied. */
export function getDefaultStore(): IdemStore {
  return defaultStore;
}

export interface IdemStepOptions {
  /** Store to record/lookup the key in. Defaults to the process store. */
  store?: IdemStore;
}

/**
 * Wrap a side-effecting browser step with exactly-once semantics.
 *
 * The first call for a given `key` runs `fn`, caches its result, and marks the
 * key `committed`. Any later call with the *same* key short-circuits `fn`
 * entirely and replays the cached result — so a self-healing retry that
 * re-drives "place order" never fires the underlying effect twice.
 *
 * @example
 * ```ts
 * await idemStep("place_order", orderKey, () => page.click("#submit"));
 * ```
 *
 * @param label  human label for the step, e.g. "place_order"
 * @param key    stable, client-generated idempotency key for this logical action
 * @param fn     the side-effecting action to run exactly once
 */
export async function idemStep<T>(
  label: string,
  key: IdemKey,
  fn: () => T | Promise<T>,
  options: IdemStepOptions = {},
): Promise<T> {
  const store = options.store ?? defaultStore;

  // Fast path: this logical action already committed — replay, do not re-run.
  const existing = store.get(key);
  if (existing?.status === "committed") {
    return existing.result as T;
  }

  // A `pending` record with an in-flight promise means another call for this
  // key is *currently* running `fn`. Coalesce onto it rather than firing the
  // side effect a second time — this is what makes concurrent same-key retries
  // (a self-healing harness re-driving a slow submit) exactly-once.
  const inflight = store.getInflight(key);
  if (inflight) {
    return inflight as Promise<T>;
  }

  // We are the winning call: claim the key, run `fn` exactly once, and publish
  // the in-flight promise so any concurrent caller awaits our result. If `fn`
  // rejects we delete the whole record so an abandoned failed key does not leak
  // a `pending` entry — TTL/prune only sweep committed records, so a leaked
  // pending would otherwise live for the whole session (and on disk, since
  // begin() persisted it). A later retry begins a fresh record via begin().
  store.begin(key, label);
  const run = (async () => {
    try {
      const result = await fn();
      // Commit (separate-store / pending-record path) AND publish the result
      // onto an already-committed record (shared-store path, where the proxy's
      // network-commit lands first and commits WITHOUT a result). Without the
      // setResult, a same-key retry on a shared store would replay `undefined`
      // instead of fn's real return value.
      store.commit(key, result);
      store.setResult(key, result);
      return result;
    } catch (err) {
      // Release the pending record before rethrowing — mirrors the proxy's
      // upstream-error release (proxy.ts). clearInflight alone left the record
      // behind as an un-expirable poison-pending key.
      store.delete(key);
      throw err;
    }
  })();
  store.setInflight(key, run);
  return run;
}
