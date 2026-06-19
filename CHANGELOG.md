# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
