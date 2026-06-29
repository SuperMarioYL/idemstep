import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { IdemStore, type CachedResponse } from "./store.js";
import { requestSignature, type IdemKey } from "./key.js";
import { IDEM_KEY_HEADER, IDEM_REPLAYED_HEADER } from "./proxy.js";

/**
 * HTTPS / CONNECT tunnel support for the IdemStep proxy.
 *
 * The plain-HTTP proxy in proxy.ts can only dedup plaintext fixtures: a browser
 * pointed at it sends real checkout traffic over HTTPS via a `CONNECT host:443`
 * tunnel, which proxy.ts does not terminate. This module adds that path. On a
 * CONNECT it establishes a locally-trusted MITM TLS session (a per-host leaf
 * cert signed by a process-local CA), decrypts the tunneled request, and runs
 * the SAME x-idem-key dedup/replay logic the plaintext proxy uses:
 *
 *   - committed-key suppression: a later request carrying an already-committed
 *     idempotency key is a duplicate of one logical action — its cached response
 *     is replayed and nothing is forwarded upstream;
 *   - in-flight coalescing: a second same-key request arriving before the first
 *     settles awaits and replays the first's response instead of double-POSTing.
 *
 * Pass-through ONLY. The tunnel reads `x-idem-key` and replays cached responses;
 * it NEVER rewrites, injects, or mutates request bodies, headers, tokens,
 * CSRF/anti-bot fields, or any other payload content. Anti-bot / token rewriting
 * is explicitly out of scope.
 *
 * The MITM requires the client to trust the tunnel's CA — exactly like any
 * developer MITM proxy. {@link CertAuthority.caCertPem} exposes the CA cert so a
 * test or example can pass it to the client (e.g. Node's `NODE_EXTRA_CA_CERTS`
 * or a Playwright `ignoreHTTPSErrors`).
 */

export interface ConnectTunnelOptions {
  /** Store backing the dedup decision (shared with the plaintext proxy). */
  store: IdemStore;
  /** Certificate authority minting per-host leaf certs for the MITM. */
  ca: CertAuthority;
  /**
   * TLS options for the upstream leg (proxy → real https site). `ca` trusts a
   * private upstream CA; `rejectUnauthorized: false` accepts self-signed
   * upstreams (tests/dev). Public https sites need neither.
   */
  upstreamTls?: { ca?: string | string[] | Buffer | Buffer[]; rejectUnauthorized?: boolean };
  /** Logger; a no-op when omitted. */
  log?: (line: string) => void;
  /** Called when a duplicate is suppressed, so the proxy can count it. */
  onSuppressed?: () => void;
}

/**
 * A process-local certificate authority. Mints a self-signed CA once, then
 * issues (and caches) a leaf certificate per upstream host so the tunnel can
 * present a name-matching cert during the MITM TLS handshake.
 *
 * Backed by the system `openssl` binary (universally present in dev/CI), so no
 * runtime npm dependency is added — IdemStep stays dependency-light.
 */
export class CertAuthority {
  private readonly dir: string;
  private readonly caKeyPath: string;
  private readonly caCertPath: string;
  /** PEM of the CA certificate; trust this in the client to accept the MITM. */
  readonly caCertPem: string;
  private readonly leaves = new Map<string, tls.SecureContext>();

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "idemstep-ca-"));
    this.caKeyPath = join(this.dir, "ca.key");
    this.caCertPath = join(this.dir, "ca.crt");
    openssl([
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", this.caKeyPath, "-out", this.caCertPath,
      "-days", "3650", "-nodes", "-subj", "/CN=idemstep-local-ca",
    ]);
    this.caCertPem = readFileSync(this.caCertPath, "utf8");
  }

  /** A TLS SecureContext presenting a leaf cert valid for `host` (cached). */
  contextFor(host: string): tls.SecureContext {
    const cached = this.leaves.get(host);
    if (cached) return cached;

    const keyPath = join(this.dir, `${safe(host)}.key`);
    const csrPath = join(this.dir, `${safe(host)}.csr`);
    const certPath = join(this.dir, `${safe(host)}.crt`);
    const extPath = join(this.dir, `${safe(host)}.ext`);

    openssl(["genrsa", "-out", keyPath, "2048"]);
    openssl(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${host}`]);
    writeFileSync(extPath, sanForHost(host), "utf8");
    openssl([
      "x509", "-req", "-in", csrPath,
      "-CA", this.caCertPath, "-CAkey", this.caKeyPath, "-CAcreateserial",
      "-out", certPath, "-days", "825", "-extfile", extPath,
    ]);

    const ctx = tls.createSecureContext({
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    });
    this.leaves.set(host, ctx);
    return ctx;
  }

  /** Remove the on-disk key/cert material. */
  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Wire CONNECT tunneling onto an http server. Returns a disposer that detaches
 * the listener. The tunnel shares `store` with the plaintext proxy so dedup
 * state is unified across http and https traffic.
 */
export function attachConnectTunnel(
  server: http.Server,
  options: ConnectTunnelOptions,
): () => void {
  const log = options.log ?? (() => {});
  const onConnect = (
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void => {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr) || 443;
    if (!host) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    clientSocket.on("error", () => clientSocket.destroy());
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Terminate TLS locally with a leaf cert for this host (the MITM).
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: options.ca.contextFor(host),
    });
    if (head.length) tlsSocket.unshift(head);
    tlsSocket.on("error", () => tlsSocket.destroy());

    // Serve the decrypted requests with the dedup-aware handler, forwarding
    // each to the real upstream over a fresh TLS connection.
    const inner = http.createServer(
      tunnelHandler(host, port, options, log, options.upstreamTls),
    );
    inner.emit("connection", tlsSocket);
    log(`CONNECT tunnel established to ${host}:${port}`);
  };

  server.on("connect", onConnect);
  return () => server.removeListener("connect", onConnect);
}

interface TunnelState {
  store: IdemStore;
  inflight: Map<IdemKey, Promise<CachedResponse>>;
  onSuppressed?: () => void;
}

const tunnelStates = new WeakMap<ConnectTunnelOptions, TunnelState>();

function tunnelHandler(
  host: string,
  port: number,
  options: ConnectTunnelOptions,
  log: (line: string) => void,
  upstreamTls: ConnectTunnelOptions["upstreamTls"],
): http.RequestListener {
  let state = tunnelStates.get(options);
  if (!state) {
    state = { store: options.store, inflight: new Map(), onSuppressed: options.onSuppressed };
    tunnelStates.set(options, state);
  }
  const { store } = state;

  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const idemKey = headerValue(req.headers[IDEM_KEY_HEADER]);
      const target = `https://${host}:${port}${req.url ?? "/"}`;

      // Non-transactional traffic (no idempotency key) tunnels through untouched.
      if (!idemKey) {
        forwardHttps(host, port, req, rawBody, res, null, store, log, upstreamTls).catch(() => {});
        return;
      }

      const sig = requestSignature({
        method: req.method ?? "GET",
        url: target,
        body: rawBody.length ? rawBody : null,
      });

      // Already-committed key → replay the cached response, never re-forward
      // (the key denotes one logical action regardless of any body drift).
      const existing = store.get(idemKey);
      if (existing?.status === "committed" && existing.cachedResponse) {
        state.onSuppressed?.();
        log(`tunnel suppressed duplicate key=${idemKey} sig=${sig.slice(0, 12)}`);
        replay(res, existing.cachedResponse);
        return;
      }

      // A forward for this key is mid-flight → coalesce and replay its response.
      const pending = state.inflight.get(idemKey);
      if (pending) {
        state.onSuppressed?.();
        log(`tunnel coalescing concurrent duplicate key=${idemKey}`);
        pending.then(
          (cached) => replay(res, cached),
          () => {
            if (!res.headersSent) res.writeHead(502).end("idemstep tunnel upstream error");
          },
        );
        return;
      }

      store.begin(idemKey, headerValue(req.headers["x-idem-label"]) ?? "step");
      store.setRequestSig(idemKey, sig);
      log(`tunnel forwarding key=${idemKey} sig=${sig.slice(0, 12)} -> ${target}`);
      const settled = forwardHttps(host, port, req, rawBody, res, { idemKey, sig }, store, log, upstreamTls);
      state.inflight.set(idemKey, settled);
      // Swallow the rejection: the upstream-error / response-stream-error path
      // already wrote the 502 to `res` and released the pending record. Without
      // this the rejection surfaces as an unhandled rejection (mirrors the
      // plaintext proxy's `settled.catch(() => {})`). Coalesced waiters observe
      // it via their own `.then(_, onError)` handler registered above.
      settled
        .catch(() => {})
        .finally(() => {
          if (state!.inflight.get(idemKey) === settled) state!.inflight.delete(idemKey);
        });
    });
    req.on("error", () => {
      if (!res.headersSent) res.writeHead(400).end();
    });
  };
}

interface CommitContext {
  idemKey: IdemKey;
  sig: string;
}

function forwardHttps(
  host: string,
  port: number,
  req: http.IncomingMessage,
  body: Buffer,
  res: http.ServerResponse,
  commit: CommitContext | null,
  store: IdemStore,
  log: (line: string) => void,
  upstreamTls: ConnectTunnelOptions["upstreamTls"],
): Promise<CachedResponse> {
  return new Promise<CachedResponse>((resolve, reject) => {
    const url = new URL(`https://${host}:${port}${req.url ?? "/"}`);

    // Pass headers through unmodified except the idem control headers, which are
    // internal to the proxy and must not leak upstream. NO body/token rewriting.
    const outHeaders = { ...req.headers } as Record<string, string | string[] | undefined>;
    delete outHeaders[IDEM_KEY_HEADER];
    delete outHeaders["x-idem-label"];
    delete outHeaders["proxy-connection"];
    outHeaders.host = url.host;

    // One settled flag guards the whole forward so the request-level and
    // response-level error paths never double-write `res`, double-release the
    // record, or settle the promise twice (mirrors the plaintext proxy).
    let settled = false;
    const fail = (err: Error, where: "request" | "response"): void => {
      if (settled) return;
      settled = true;
      log(`tunnel upstream ${where} error for ${host}:${port}: ${err.message}`);
      // Release the pending record so a flaky upstream cannot leak an
      // un-expirable poison-pending key (mirrors the plaintext proxy).
      if (commit) store.delete(commit.idemKey);
      if (!res.headersSent) res.writeHead(502).end(`idemstep tunnel upstream error: ${err.message}`);
      reject(err);
    };

    const upstream = https.request(
      url,
      {
        method: req.method,
        headers: outHeaders,
        ca: upstreamTls?.ca,
        rejectUnauthorized: upstreamTls?.rejectUnauthorized,
      },
      (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on("data", (c: Buffer) => chunks.push(c));
        upRes.on("end", () => {
          if (settled) return;
          settled = true;
          const respBody = Buffer.concat(chunks);
          const cached: CachedResponse = {
            status: upRes.statusCode ?? 200,
            headers: flattenHeaders(upRes.headers),
            bodyBase64: respBody.toString("base64"),
          };
          if (commit) {
            store.setCachedResponse(commit.idemKey, cached);
            // Commit WITHOUT a result (network-commit, not the user-facing
            // return value) — the wrapper's setResult publishes fn's real result
            // on this shared store. Mirrors the plaintext proxy's forward().
            store.commit(commit.idemKey);
            log(`tunnel committed key=${commit.idemKey} status=${cached.status}`);
          }
          res.writeHead(upRes.statusCode ?? 200, flattenHeaders(upRes.headers));
          res.end(respBody);
          resolve(cached);
        });
        // A truncated / prematurely-closed upstream response never emits "end";
        // without these the promise never settles and `res` never ends, so the
        // client hangs until its own timeout. Treat the response stream's
        // "error"/"aborted" like the request-level error (v0.4.0 response-leg
        // hardening, parity with the plaintext proxy's forward()).
        upRes.on("error", (err) => fail(err, "response"));
        upRes.on("aborted", () => fail(new Error("upstream response aborted"), "response"));
      },
    );

    upstream.on("error", (err) => fail(err, "request"));

    if (body.length) upstream.write(body);
    upstream.end();
  });
}

function replay(res: http.ServerResponse, cached: CachedResponse): void {
  res.writeHead(cached.status, { ...cached.headers, [IDEM_REPLAYED_HEADER]: "true" });
  res.end(Buffer.from(cached.bodyBase64, "base64"));
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** A SAN extension config naming the host (as IP or DNS, as appropriate). */
function sanForHost(host: string): string {
  return net.isIP(host)
    ? `subjectAltName=IP:${host}\n`
    : `subjectAltName=DNS:${host}\n`;
}

/** Filesystem-safe slug of a host for cert filenames. */
function safe(host: string): string {
  return host.replace(/[^a-zA-Z0-9.-]/g, "_");
}

function openssl(args: string[]): void {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "ignore"] });
}
