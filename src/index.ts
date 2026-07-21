#!/usr/bin/env node
/**
 * IdemStep — Stripe's Idempotency-Key, but for your browser agent.
 *
 * Public API:
 *   - `idemStep(label, key, fn)`   exactly-once wrapper for a browser step
 *   - `IdemStore`                  the key -> StepRecord store
 *   - `startProxy(opts)`           the local interception/dedup proxy
 *   - `generateKey` / `requestSignature`  key + signature helpers
 *
 * CLI:
 *   - `idemstep proxy [--port N] [--host H] [--store path.json]`   start the local proxy
 *   - `idemstep hosted [--port N] [--host H] [--store path.json]`  start the single-tenant hosted dedup proxy
 */

export { idemStep, setDefaultStore, getDefaultStore } from "./idemStep.js";
export type { IdemStepOptions } from "./idemStep.js";
export { IdemStore } from "./store.js";
export type {
  StepRecord,
  StepStatus,
  CachedResponse,
  IdemStoreOptions,
} from "./store.js";
export {
  startProxy,
  IDEM_KEY_HEADER,
  IDEM_REPLAYED_HEADER,
  IDEM_API_KEY_HEADER,
} from "./proxy.js";
export type { ProxyOptions, RunningProxy, AuthorizeKey } from "./proxy.js";
export { CertAuthority, attachConnectTunnel } from "./connect.js";
export type { ConnectTunnelOptions } from "./connect.js";
export {
  generateKey,
  requestSignature,
  canonicalizeBody,
} from "./key.js";
export type { IdemKey, RequestShape } from "./key.js";

import { startProxy, IDEM_API_KEY_HEADER, type AuthorizeKey } from "./proxy.js";
import { IdemStore } from "./store.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface ParsedArgs {
  command?: string;
  port?: number;
  host?: string;
  store?: string;
  ttlMs?: number;
  https: boolean;
  help: boolean;
  /** `--api-keys` value: a comma-separated list or a path to a keys file. */
  apiKeys?: string;
  /** `--prune-interval` value in ms: how often to sweep TTL-expired keys. */
  pruneIntervalMs?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, https: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--port" || arg === "-p") out.port = Number(argv[++i]);
    else if (arg === "--host") out.host = argv[++i];
    else if (arg === "--store" || arg === "-s") out.store = argv[++i];
    else if (arg === "--ttl" || arg === "-t") out.ttlMs = Number(argv[++i]);
    else if (arg === "--https") out.https = true;
    else if (arg === "--api-keys") out.apiKeys = argv[++i];
    else if (arg === "--prune-interval") out.pruneIntervalMs = Number(argv[++i]);
    else if (!arg.startsWith("-") && out.command === undefined) out.command = arg;
  }
  return out;
}

const USAGE = `idemstep — exactly-once for browser-agent transactional steps

Usage:
  idemstep proxy  [--port N] [--host H] [--store path.json] [--https]
  idemstep hosted [--port N] [--host H] [--store path.json] [--https] [--api-keys SPEC]

Commands:
  proxy   Start the local interception proxy. Point Playwright at it via
          { proxy: { server: "http://localhost:PORT" } } and wrap your
          transactional step with idemStep("place_order", key, fn).
  hosted  Start a hosted dedup proxy — the same interception layer, bound to a
          configurable host/port with a durable JSON-file store, so a remote
          Playwright context gets managed exactly-once without operating the
          proxy itself. Dedup events are logged here.
          With --api-keys it is MULTI-TENANT: multiple operators point a remote
          context at the same URL and get managed exactly-once in ISOLATED
          per-key namespaces (one shared JSON-file store; each idempotency key
          is namespaced by a hash of the operator's API key so tenants never
          collide). Without --api-keys it is single-tenant (no auth).
          Scoped to single-operator API-key auth + routing only; team plans,
          billing, and local-library multi-user remain future v0.6.0+.

Options:
  -p, --port N      Port to listen on (default: 8473)
      --host H      Interface to bind. ` + "`proxy`" + ` defaults to all interfaces;
                    ` + "`hosted`" + ` defaults to 0.0.0.0 (remote-capable); pass
                    127.0.0.1 for local-only.
  -s, --store PATH  JSON-file store so dedup state survives a restart.
                    ` + "`hosted`" + ` defaults to ./idemstep-hosted.json.
  -t, --ttl MS      Expire committed keys after MS milliseconds (default: keep
                    forever). After the window a retry is a new action.
      --prune-interval MS  (proxy/hosted) How often to sweep TTL-expired
                    committed keys from the in-memory Map and JSON file so a
                    long-running proxy reclaims memory (default: never; lookups
                    expire keys lazily but never-again-looked-up keys linger
                    without this). No effect when no --ttl is set.
      --https       Intercept HTTPS via a CONNECT+MITM tunnel so dedup works
                    against real https sites (requires openssl; prints the CA
                    cert to trust in the client).
      --api-keys SPEC  (hosted only) Comma-separated API keys ("k1,k2") OR a
                    path to a file with one key per line (blank/# lines ignored).
                    Each operator sends x-idem-api-key: <key> on a transactional
                    request; dedup state is namespaced per key. Omit for
                    single-tenant mode.
  -h, --help        Show this help
`;

/**
 * Resolve a `--api-keys` spec into the list of accepted API keys. A spec is
 * either a comma-separated list ("k1,k2,k3") or, when it points at an existing
 * file, one key per line (blank lines and `#`-prefixed comments ignored).
 */
function loadApiKeys(spec: string): string[] {
  if (existsSync(spec) && statSync(spec).isFile()) {
    return readFileSync(spec, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  }
  return spec
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Build the multi-tenant auth + namespacing hook for the hosted proxy. Each
 * transactional request must carry a recognized `x-idem-api-key`; the
 * operator's key is hashed (never written to the store in raw form) and
 * prepended to the idempotency key, so one shared JSON-file store isolates
 * operators by namespace and the in-flight coalescing map stays per-operator
 * too. An unknown/missing key returns `null` → the proxy responds 401 and does
 * not forward.
 */
function makeAuthorizer(apiKeys: string[]): AuthorizeKey {
  const valid = new Set(apiKeys);
  return (req, idemKey) => {
    const raw = req.headers[IDEM_API_KEY_HEADER];
    const apiKey = Array.isArray(raw) ? raw[0] : raw;
    if (!apiKey || !valid.has(apiKey)) return null;
    const ns = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
    return `${ns}::${idemKey}`;
  };
}

/** Surface durable-store load + persist failures (fail-loud, not fail-open). */
function warnIfStoreErrors(store: IdemStore, label: string): void {
  // loadError is set on startup when the store file could not be recovered
  // (truncated/partial JSON from a crash mid-persist, or a non-array shape).
  if (store.loadError) {
    process.stderr.write(
      `idemstep ${label}: WARNING — ${store.loadError.message}\n`,
    );
  }
  // persistError is set when a durable write failed (EACCES / ENOSPC / ENOENT
  // on a read-only, full, or missing store dir). On a fresh startup this is
  // undefined (no mutation has run yet), but surface it if present (e.g. a
  // pre-warmed store whose first mutation already failed) so an operator
  // learns dedup state is not being durably recorded.
  if (store.persistError) {
    process.stderr.write(
      `idemstep ${label}: WARNING — durable write failed: ${store.persistError.message} (dedup decisions continue in-memory; fix the --store path to resume durability)\n`,
    );
  }
}

/**
 * Schedule a periodic `store.prune()` so TTL-expired committed keys are
 * reclaimed from the in-memory Map and JSON file automatically. Lookups expire
 * keys lazily, but a long-running proxy fielding many one-off transactional
 * keys (each committed once, never looked up again because the self-healing
 * retry already got its replay from the in-flight coalescing map) would
 * otherwise accumulate expired-but-not-reclaimed records forever. Returns a
 * disposer that clears the interval on shutdown. The caller gates on ttlMs:
 * pruning is only meaningful when a TTL is configured (prune() is a no-op
 * otherwise, so there is no point scheduling the interval).
 */
function schedulePrune(
  store: IdemStore,
  intervalMs: number,
  log: (line: string) => void,
): (() => void) | undefined {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
  const handle = setInterval(() => {
    const removed = store.prune();
    if (removed > 0) log(`prune reclaimed ${removed} expired key(s)`);
  }, intervalMs);
  // setInterval keeps the event loop alive; unref so it never blocks shutdown
  // (the SIGINT/SIGTERM handler closes the proxy and calls process.exit(0)).
  handle.unref?.();
  return () => clearInterval(handle);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.command === "proxy") {
    const store = new IdemStore({ filePath: args.store, ttlMs: args.ttlMs });
    warnIfStoreErrors(store, "proxy");
    const proxy = await startProxy({
      port: args.port ?? 8473,
      host: args.host,
      store,
      https: args.https,
    });
    process.stdout.write(
      `idemstep proxy ready on http://localhost:${proxy.port}\n` +
        `point Playwright at it: { proxy: { server: "http://localhost:${proxy.port}" } }\n`,
    );
    if (args.https) {
      if (proxy.caCertPem) {
        process.stdout.write(
          "HTTPS interception ON — trust this CA in your client " +
            "(e.g. NODE_EXTRA_CA_CERTS) to accept the MITM:\n" +
            `${proxy.caCertPem}`,
        );
      } else {
        process.stderr.write(
          "warning: --https requested but HTTPS interception is unavailable " +
            "(is `openssl` installed?); serving plain http only\n",
        );
      }
    }
    const pruneLog = (line: string) => console.log(`[idemstep] ${line}`);
    const stopPrune =
      args.ttlMs && args.ttlMs > 0 && args.pruneIntervalMs && args.pruneIntervalMs > 0
        ? schedulePrune(store, args.pruneIntervalMs, pruneLog)
        : undefined;
    const shutdown = async () => {
      stopPrune?.();
      await proxy.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (args.command === "hosted") {
    // A deployable hosted dedup proxy: the existing interception layer bound
    // to a configurable host/port with a durable JSON-file store, so a remote
    // Playwright context gets managed exactly-once without operating the proxy
    // itself. With --api-keys it is multi-tenant (per-operator API-key auth +
    // per-key IdemStore namespacing); without, single-tenant. Team plans,
    // billing, and local-library multi-user remain out of scope (v0.6.0+).
    const host = args.host ?? "0.0.0.0";
    const storePath = args.store ?? "idemstep-hosted.json";
    const store = new IdemStore({ filePath: storePath, ttlMs: args.ttlMs });
    warnIfStoreErrors(store, "hosted");

    let authorizeKey: AuthorizeKey | undefined;
    let multiTenant = false;
    if (args.apiKeys !== undefined) {
      const apiKeys = loadApiKeys(args.apiKeys);
      if (apiKeys.length === 0) {
        process.stderr.write(
          `idemstep hosted: --api-keys provided no keys (got "${args.apiKeys}")\n`,
        );
        process.exitCode = 1;
        return;
      }
      authorizeKey = makeAuthorizer(apiKeys);
      multiTenant = true;
    }

    const proxy = await startProxy({
      port: args.port ?? 8473,
      host,
      store,
      https: args.https,
      authorizeKey,
    });
    const displayHost = host === "0.0.0.0" ? "<this-host>" : host;
    if (multiTenant) {
      process.stdout.write(
        `idemstep hosted dedup proxy ready on http://${host}:${proxy.port} (multi-tenant, per-key namespacing)\n` +
          `point a remote Playwright context at it: ` +
          `{ proxy: { server: "http://${displayHost}:${proxy.port}" } }\n` +
          `send x-idem-api-key: <your-key> on each transactional request; ` +
          `dedup state is isolated per key.\n` +
          `dedup state: ${storePath} (durable across restarts); ` +
          `dedup events are logged here per key as they are suppressed.\n`,
      );
    } else {
      process.stdout.write(
        `idemstep hosted dedup proxy ready on http://${host}:${proxy.port} (single-tenant, no auth)\n` +
          `point a remote Playwright context at it: ` +
          `{ proxy: { server: "http://${displayHost}:${proxy.port}" } }\n` +
          `dedup state: ${storePath} (durable across restarts); ` +
          `dedup events are logged here as they are suppressed.\n`,
      );
    }
    if (args.https) {
      if (proxy.caCertPem) {
        process.stdout.write(
          "HTTPS interception ON — trust this CA in your remote client " +
            "(e.g. NODE_EXTRA_CA_CERTS) to accept the MITM:\n" +
            `${proxy.caCertPem}`,
        );
      } else {
        process.stderr.write(
          "warning: --https requested but HTTPS interception is unavailable " +
            "(is `openssl` installed?); serving plain http only\n",
        );
      }
    }
    const pruneLog = (line: string) => console.log(`[idemstep] ${line}`);
    const stopPrune =
      args.ttlMs && args.ttlMs > 0 && args.pruneIntervalMs && args.pruneIntervalMs > 0
        ? schedulePrune(store, args.pruneIntervalMs, pruneLog)
        : undefined;
    const shutdown = async () => {
      stopPrune?.();
      await proxy.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  process.stderr.write(`idemstep: unknown command "${args.command}"\n\n${USAGE}`);
  process.exitCode = 1;
}

// Only run the CLI when executed directly (not when imported as a library).
// `import.meta.url` is URL-encoded and symlink-realpath-resolved, so the
// comparison must be too: a bare `file://${process.argv[1]}` string-concat is
// neither, and mismatches whenever argv[1] contains a space (literal space vs
// %20) or crosses a symlink (e.g. /tmp → /private/tmp on macOS) — `main()`
// then silently no-ops and `idemstep proxy` / `hosted` prints nothing. We
// realpath argv[1] first (so a symlinked entry matches the resolved module
// URL), then build a proper file: URL via `pathToFileURL` (handles spaces,
// relative paths, and Windows drive letters). The `endsWith("idemstep")`
// fallback still covers the published bin symlink, whose argv[1] is the
// symlink name rather than this module's path.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  if (entry.endsWith("idemstep")) return true; // published bin symlink
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {
    // entry path missing or unresolvable — fall back to the literal entry so
    // this edge never throws; the equality check simply fails instead.
    real = entry;
  }
  return pathToFileURL(real).href === import.meta.url;
}

if (invokedDirectly()) {
  main().catch((err) => {
    process.stderr.write(`idemstep: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
