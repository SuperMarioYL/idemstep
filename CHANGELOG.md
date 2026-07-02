# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-07-03

Reliability-and-monetization-continuation release. Takes the deliberate next
step of the hosted-proxy monetization seam — multi-tenant API-key auth + per-key
namespacing on the `idemstep hosted` proxy — and folds three high-confidence
exactly-once / CLI defects the bug-hunter verified in the shipped v0.4.0 source.

### Added

- **Hosted dedup proxy multi-tenant API-key auth — `idemstep hosted --api-keys`
  (single-operator auth/routing).** Multiple operators now point a remote
  Playwright context at the SAME hosted proxy URL and get managed exactly-once
  in ISOLATED per-key namespaces, without operating the proxy themselves. The
  `idemstep hosted` command gains a `--api-keys` flag (a comma-separated list
  or a path to a file with one key per line); each operator stamps
  `x-idem-api-key: <key>` on a transactional request, the proxy authenticates
  it (401 on a missing/unknown key) and namespaces the idempotency key by a
  hash of the API key — so one shared JSON-file store isolates tenants and the
  in-flight coalescing map stays per-operator too. `startProxy` and the CONNECT
  tunnel gain an opt-in `authorizeKey` hook (the namespacing logic lives in
  `src/index.ts`); single-tenant mode (no hook) is byte-for-byte unchanged.
  Scoped to single-operator API-key auth + routing only; team management, team
  plans, and billing remain out of scope (future v0.6.0+).

### Fixed

- **A mid-write crash corrupted the JSON store and the next start silently lost
  every committed key.** `persist()` used a bare truncate-then-write
  `writeFileSync`, and `load()` wrapped `JSON.parse` in a bare `catch {}` that
  returned silently — so a crash (OOM / SIGKILL / power loss) or disk-full
  during a persist left a truncated/partial file and the next start began EMPTY
  with no log, breaking exactly-once on the durable/hosted path (a same-key
  retry was forwarded as a new action, a double-submit). `persist()` now writes
  to a sibling `.tmp` and renames it over the target (atomic on POSIX), and
  `load()` surfaces a parse or shape error via a new public `store.loadError`
  field that the `hosted` / `proxy` CLI logs on startup — fail-loud, not
  fail-open.
- **`idemStep` rejected with an internal "no pending record" invariant on the
  shared-store path when the proxy's upstream errored.** On the documented
  shared-store path (wrapper + proxy sharing one JSON-file store), when the
  proxy's upstream errors, `forward()`'s `fail()` calls `store.delete(key)` and
  writes a 502 BEFORE the wrapper's `fn` resolves; if `fn` then handles the 502
  gracefully and returns a result without throwing, the wrapper's
  `store.commit(key, result)` landed on a missing record. `commit` was the only
  mutator that threw on a missing record (setResult/setRequestSig/
  setCachedResponse/setInflight all no-op'd), so `idemStep` rejected with that
  invariant instead of returning `fn`'s result. `commit` now no-ops (returns
  `undefined`) on a missing record, consistent with the other mutators;
  `idemStep`'s existing `store.commit + store.setResult` then handles all three
  cases (separate-store pending; shared-store proxy-committed; shared-store
  proxy-deleted).
- **The CLI silently no-op'd when the entry path contained a space or crossed a
  symlink.** `invokedDirectly` compared `import.meta.url` to the string-concat
  `file://${process.argv[1]}`; `import.meta.url` is URL-encoded and
  symlink-realpath-resolved while the concat form is neither, so they mismatched
  whenever `process.argv[1]` contained a space (literal space vs `%20`) or
  crossed a symlink (e.g. `/tmp` → `/private/tmp` on macOS) — `main()` never
  ran and `idemstep proxy` / `hosted` printed nothing. The check now uses
  `pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url`
  (handles spaces, symlinks, relative paths, and Windows drive letters), with
  the `endsWith("idemstep")` bin-symlink fallback retained.

[0.5.0]: https://github.com/SuperMarioYL/idemstep/releases/tag/v0.5.0

## [0.4.0] - 2026-06-29

Reliability and monetization-preview release. Folds four verified correctness
fixes found in the shipped v0.3.0 source, and surfaces the previously-deferred
hosted dedup proxy as a scoped single-tenant preview.

### Added

- **Hosted dedup proxy — `idemstep hosted` (single-tenant preview).** The
  existing interception layer (`src/proxy.ts` + `src/connect.ts`) bound to a
  configurable host/port with a durable JSON-file store, so a remote Playwright
  context gets managed exactly-once without operating the proxy itself. Dedup
  events are logged server-side. Single-tenant only: no multi-tenant auth, team
  plans, or billing (future v0.5.0+). `startProxy` gains a `host` option; the
  CLI gains `--host` (which now also applies to `idemstep proxy`).

### Fixed

- **A rejected `idemStep` fn leaked a `pending` record.** The catch block only
  cleared the in-flight handle; it never deleted the record. `isExpired()`
  returns false for non-committed records, so TTL/prune never swept it, and
  `begin()` had persisted it to the JSON file — an abandoned failed key lived
  for the whole session (and on disk until restart). The catch path now deletes
  the record before rethrowing, mirroring the proxy's upstream-error release; a
  later retry still begins a fresh record.
- **The CLI fired `main()` on a plain import when the consumer's entry was named
  `index.js`/`index.ts`.** `invokedDirectly` fell back to `endsWith("index.js")`
  / `endsWith("index.ts")`, so importing idemstep from such an entry printed the
  USAGE banner into the consumer's stdout. Those fallbacks are dropped; the
  primary direct-run check and the `endsWith("idemstep")` bin-symlink fallback
  remain, so import is side-effect-free while `idemstep proxy` still runs.
- **A truncated / prematurely-closed upstream response hung the client.** The
  response stream only did `upRes.on("error", reject)` (never ending `res`) and
  had no `aborted` handler; on a premature upstream close `"end"` never fired,
  the promise never settled, and `res` never ended. The proxy now treats the
  response stream's `"error"`/`"aborted"` like the request-level error — 502,
  release the pending record, reject — in both `forward` (proxy.ts) and
  `forwardHttps` (connect.ts).
- **The proxy's commit clobbered the wrapper's result on a shared store.** On
  the documented shared-store path the proxy called
  `store.commit(idemKey, { requestSig, status })` before the wrapper's fn
  resolved, so the wrapper's later commit hit the committed-no-op and a same-key
  retry replayed the proxy's bookkeeping instead of fn's real return value. The
  proxy now commits WITHOUT a result (the payload was redundant), and a new
  `store.setResult(key, result)` — called by `idemStep()` after fn resolves —
  publishes fn's real return value onto the committed record. Scoped to the
  shared-store path; the default separate-store usage is unaffected.

[0.4.0]: https://github.com/SuperMarioYL/idemstep/releases/tag/v0.4.0

## [0.3.0] - 2026-06-19

Hardens the proxy under concurrency and flaky upstreams, validates the on-disk
store, and reaches real (HTTPS) checkout sites through a CONNECT tunnel.

### Added

- **HTTPS interception via a CONNECT+MITM tunnel — `startProxy({ https: true })`
  and `idemstep proxy --https`.** The proxy now terminates `CONNECT host:443`
  tunnels with a locally-trusted leaf cert (signed by a process-local CA) and
  runs the same `x-idem-key` dedup/replay over the decrypted traffic, so
  exactly-once works against real https sites — not just plaintext fixtures.
  The CA to trust in the client is exposed as `proxy.caCertPem` (and printed by
  the CLI). Pass-through only: the tunnel reads the idempotency key and replays
  cached responses; it never rewrites bodies, headers, or tokens. New
  `examples/place-order-https.ts` proves "retried 2x, ordered 1x" over HTTPS.
  Cert material is minted via the system `openssl`, so no runtime dependency is
  added; if `openssl` is absent the proxy still serves plain http.

### Fixed

- **Two concurrent same-key requests double-forwarded at the proxy.** The
  proxy's only guard was the committed-check, so two same-key requests racing
  before the first committed both forwarded upstream (a double order). The proxy
  now coalesces concurrent same-key forwards: a second request mid-flight awaits
  and replays the first's response instead of POSTing again. (v0.2's coalescing
  only covered the `idemStep()` wrapper, never the proxy.)
- **A committed key with a drifted retry body re-forwarded and corrupted its
  record.** A same-key retry carrying a different body bypassed the
  committed-check; `setRequestSig` then overwrote the committed record and the
  request was forwarded again. A committed key now always replays its cached
  response regardless of body drift, and `setRequestSig`/`commit` refuse to
  mutate an already-committed record.
- **Pending records leaked forever on an upstream error.** TTL/prune only sweep
  committed records, so a `pending` record left behind by a flaky upstream lived
  forever in memory and in the JSON file. The proxy now releases the pending
  record on the upstream-error path before returning 502.
- **The JSON-file store trusted arbitrary parsed shapes on load.** `load()` now
  requires an array, drops elements lacking a string `key` or a valid `status`,
  and discards persisted `pending` records (an in-flight action cannot survive a
  restart) — so a hand-edited or half-written file can no longer shadow real
  lookups or seed an un-expirable key.

[0.3.0]: https://github.com/SuperMarioYL/idemstep/releases/tag/v0.3.0

## [0.2.0] - 2026-06-19

First feature iteration: a concurrency-correctness fix and TTL key expiry.

### Fixed

- **Concurrent same-key calls fired the side effect more than once.** `idemStep`
  only short-circuited on an *already-committed* key, so two (or three) attempts
  racing in the same window — exactly what a self-healing harness does when it
  re-drives a slow-but-successful submit — each ran `fn`, double-charging the
  order. Concurrent same-key callers now coalesce onto the first call's
  in-flight promise and share its result, so the effect fires exactly once even
  under a race. A rejected attempt clears the in-flight handle so a *later*
  retry may legitimately run again.

### Added

- **TTL key expiry — `new IdemStore({ ttlMs })`.** Committed keys older than the
  window are treated as expired: lookups skip them and a re-run with the same
  key is a genuinely new action (mirroring Stripe's idempotency window). Without
  a TTL, keys are kept forever — the v0.1 behaviour is unchanged.
- **`IdemStore.prune()`** sweeps expired committed records and returns the count,
  so a long-running agent can keep the store — and its JSON file — bounded.
- **`startProxy({ ttlMs })`** and **`idemstep proxy --ttl MS`** thread the TTL
  through the interception proxy: past the window, a duplicate transactional
  request is forwarded as a new action instead of suppressed.

[0.2.0]: https://github.com/SuperMarioYL/idemstep/releases/tag/v0.2.0

## [0.1.0] - 2026-06-13

First public release: exactly-once semantics for transactional browser-agent steps.

### Added

- **m1 — `idemStep(label, key, fn)` wrapper.** Wrap a side-effecting browser
  step with a client-generated idempotency key. The first call runs `fn` and
  caches its result; a re-run with the same key short-circuits `fn` and replays
  the cached result, so a self-healing retry never fires the effect twice.
  In-memory `IdemStore` plus optional JSON-file persistence; `generateKey` and
  `requestSignature` (method + host + path + body-hash) helpers.
- **m2 — local interception proxy (`idemstep proxy`).** An Express-based proxy
  that Playwright routes through. It binds each transactional request's
  `requestSig` to its idempotency key on first sight, then suppresses any later
  duplicate of a committed key by replaying the cached response — turning a
  retry into a no-op at the network boundary.
- **m3 — runnable exactly-once demo.** `examples/place-order.ts` drives a real
  checkout flow through the proxy, re-drives the submit three times to mimic a
  self-healing harness, and proves the checkout site records exactly one order
  ("retried 2x, ordered 1x").

[0.1.0]: https://github.com/SuperMarioYL/idemstep/releases/tag/v0.1.0
