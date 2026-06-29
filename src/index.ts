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
} from "./proxy.js";
export type { ProxyOptions, RunningProxy } from "./proxy.js";
export { CertAuthority, attachConnectTunnel } from "./connect.js";
export type { ConnectTunnelOptions } from "./connect.js";
export {
  generateKey,
  requestSignature,
  canonicalizeBody,
} from "./key.js";
export type { IdemKey, RequestShape } from "./key.js";

import { startProxy } from "./proxy.js";
import { IdemStore } from "./store.js";

interface ParsedArgs {
  command?: string;
  port?: number;
  host?: string;
  store?: string;
  ttlMs?: number;
  https: boolean;
  help: boolean;
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
    else if (!arg.startsWith("-") && out.command === undefined) out.command = arg;
  }
  return out;
}

const USAGE = `idemstep — exactly-once for browser-agent transactional steps

Usage:
  idemstep proxy  [--port N] [--host H] [--store path.json] [--https]
  idemstep hosted [--port N] [--host H] [--store path.json] [--https]

Commands:
  proxy   Start the local interception proxy. Point Playwright at it via
          { proxy: { server: "http://localhost:PORT" } } and wrap your
          transactional step with idemStep("place_order", key, fn).
  hosted  Start a single-tenant hosted dedup proxy — the same interception
          layer, bound to a configurable host/port with a durable JSON-file
          store, so a remote Playwright context gets managed exactly-once
          without operating the proxy itself. Dedup events are logged here.
          Single-tenant only: no auth, no team plans, no billing (future v0.5).

Options:
  -p, --port N      Port to listen on (default: 8473)
      --host H      Interface to bind. ` + "`proxy`" + ` defaults to all interfaces;
                    ` + "`hosted`" + ` defaults to 0.0.0.0 (remote-capable); pass
                    127.0.0.1 for local-only.
  -s, --store PATH  JSON-file store so dedup state survives a restart.
                    ` + "`hosted`" + ` defaults to ./idemstep-hosted.json.
  -t, --ttl MS      Expire committed keys after MS milliseconds (default: keep
                    forever). After the window a retry is a new action.
      --https       Intercept HTTPS via a CONNECT+MITM tunnel so dedup works
                    against real https sites (requires openssl; prints the CA
                    cert to trust in the client).
  -h, --help        Show this help
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.command === "proxy") {
    const store = new IdemStore({ filePath: args.store, ttlMs: args.ttlMs });
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
    const shutdown = async () => {
      await proxy.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (args.command === "hosted") {
    // A deployable single-tenant hosted dedup proxy: the existing interception
    // layer bound to a configurable host/port with a durable JSON-file store,
    // so a remote Playwright context gets managed exactly-once without
    // operating the proxy itself. Dedup events are logged server-side (here).
    // Scoped to single-tenant interception only — no auth / team plans /
    // billing / Redis (future v0.5+).
    const host = args.host ?? "0.0.0.0";
    const storePath = args.store ?? "idemstep-hosted.json";
    const store = new IdemStore({ filePath: storePath, ttlMs: args.ttlMs });
    const proxy = await startProxy({
      port: args.port ?? 8473,
      host,
      store,
      https: args.https,
    });
    const displayHost = host === "0.0.0.0" ? "<this-host>" : host;
    process.stdout.write(
      `idemstep hosted dedup proxy ready on http://${host}:${proxy.port} (single-tenant, no auth)\n` +
        `point a remote Playwright context at it: ` +
        `{ proxy: { server: "http://${displayHost}:${proxy.port}" } }\n` +
        `dedup state: ${storePath} (durable across restarts); ` +
        `dedup events are logged here as they are suppressed.\n`,
    );
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
    const shutdown = async () => {
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
// The primary check covers `node dist/index.js` / `tsx src/index.ts` (argv[1] is
// this module's own path); the `endsWith("idemstep")` fallback covers the bin
// symlink. The previous `endsWith("index.js")`/`endsWith("index.ts")` fallbacks
// were dropped: they fired as false positives whenever a *consumer's* entry
// script was named index.js/ts and merely imported idemstep, printing the USAGE
// banner into their stdout on a side-effect-free import.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1].endsWith("idemstep"));

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`idemstep: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
