<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=700&size=34&duration=3500&pause=900&color=7C5CFF&center=true&vCenter=true&width=720&height=70&lines=IdemStep;Exactly-once+for+browser+agents" alt="IdemStep" />
</p>

<p align="center">
  <em>The idempotency-key layer that makes browser-Agent retries place an order exactly once.</em>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <img src="https://img.shields.io/github/v/release/SuperMarioYL/idemstep?color=7c5cff" alt="Latest release" />
  <a href="./.github/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-vitest-success.svg" alt="CI: vitest" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/exactly--once-✓-0db7a4.svg" alt="Exactly-once" />
  <img src="https://img.shields.io/badge/Agent--ready-✓-7c5cff.svg" alt="Agent-ready" />
</p>

<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

> **Your browser Agent's self-healing retry re-clicks "place order" after a slow-but-successful submit — and charges the card twice. IdemStep wraps that step with a client-generated key so the retry is deduplicated instead of duplicated.**

## Contents

- [Why this exists](#why-this-exists)
- [Architecture](#architecture)
- [Install &amp; Quickstart](#install--quickstart)
- [Demo](#demo)
- [How it works](#how-it-works)
- [vs browser-use self-healing retry](#vs-browser-use-self-healing-retry)
- [API](#api)
- [Pricing](#pricing)
- [Roadmap](#roadmap)
- [License &amp; Contributing](#license--contributing)

## Why this exists

Self-healing browser harnesses re-drive any action that *looks* failed — which is exactly what makes flaky web automation usable. But a retry fired after a slow-but-successful submit has no notion of idempotency, so the booking, checkout, or account-creation happens twice. The pattern is spreading fast: [browser-use/browser-use](https://github.com/browser-use/browser-use) (98k★) is the runtime trusted with more and more write actions, and its self-healing layer grows at hundreds of stars a day. Payments solved this years ago with Stripe's `Idempotency-Key` — a stable, client-minted token that lets the receiver recognize "this is a retry, not a new request." IdemStep transplants that primitive into the browser layer: wrap a transactional step in a key, route the browser through a local proxy, and a re-driven submit becomes a no-op at the network boundary. It is the safety belt the agent-builder crowd ([affaan-m/ECC](https://github.com/affaan-m/ECC) and the broader reliability orbit) has needed since the day self-healing retries started touching real-money flows.

## <img src="https://api.iconify.design/tabler:topology-star-3.svg?color=%230071E3&width=24" height="22" align="absmiddle" alt=""> Architecture

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/atlas-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/atlas-light.svg">
    <img src="./assets/atlas-light.svg" width="880" alt="Architecture: an Agent wraps a transactional step with idemStep(), which records the key in IdemStore; browser traffic routes through the local proxy, which checks each requestSig against committed keys and either forwards the first request to the third-party site or replays the cached response so a self-healing retry is suppressed">
  </picture>
</p>

Two cooperating processes inside one **exactly-once boundary you own** — no third-party cooperation required. The **`idemStep()` wrapper** guards the client-side effect (a committed key replays the cached result instead of re-running `fn`), recording each key in **`IdemStore`** (in-memory or JSON-file). Browser traffic routes through the **local proxy**, which computes a `requestSig` (`method + host + path + body-hash`) and, when a committed key already owns that signature, replays the cached response instead of forwarding — so a self-healing retry never reaches the **third-party site** and the order is placed exactly once.

## <img src="https://api.iconify.design/tabler:rocket.svg?color=%230071E3&width=24" height="22" align="absmiddle" alt=""> Install &amp; Quickstart

From a cold clone to your first "exactly-once" proof in three steps:

```bash
npm install idemstep playwright   # 1. install (playwright is a peer dep)
npx idemstep proxy                # 2. start the local dedup proxy (prints a port)
npx tsx examples/place-order.ts   # 3. run the demo: retried 3x, ordered 1x
```

Then wrap any transactional step in your own agent script — point Playwright at the proxy and guard the click:

```ts
import { chromium } from "playwright";
import { idemStep, startProxy, generateKey, IDEM_KEY_HEADER } from "idemstep";

// 1. Start the local interception proxy (or run `npx idemstep proxy` separately).
const proxy = await startProxy({ port: 8473 });

// 2. Route the browser through it.
const browser = await chromium.launch({
  proxy: { server: `http://localhost:${proxy.port}` },
});
const page = await (await browser.newContext()).newPage();

// 3. Mint one stable key for this logical action and stamp it on the request.
const orderKey = generateKey("order"); // e.g. derive `order:${cartId}` for cross-restart safety
await page.route("**/checkout", (route) =>
  route.continue({ headers: { ...route.request().headers(), [IDEM_KEY_HEADER]: orderKey } }),
);

// 4. Wrap the side-effecting step. A self-healing retry with the SAME key is a no-op.
await idemStep("place_order", orderKey, () => page.click("#submit"));
await idemStep("place_order", orderKey, () => page.click("#submit")); // retry — suppressed
```

<details>
<summary>sample output of the demo run</summary>

```text
IdemStep demo — placing one order, retrying it three times.

  checkout site  : http://127.0.0.1:54121
  idem proxy     : http://localhost:8473
  idempotency key: order:7c3f…b21a

  attempt #1: agent clicks #submit...
    -> forwarded            status=200
  attempt #2: agent re-drives submit...
    -> REPLAYED (suppressed) status=200
  attempt #3: agent re-drives submit...
    -> REPLAYED (suppressed) status=200

  ──────────────────────────────────────────
  retried 3x  ·  orders actually placed: 1
  proxy suppressed: 2 duplicate request(s)
  ──────────────────────────────────────────

PASS: retried 2x, ordered 1x.
```

</details>

## <img src="https://api.iconify.design/tabler:photo.svg?color=%230071E3&width=24" height="22" align="absmiddle" alt=""> Demo

<p align="center">
  <img src="./assets/demo.gif" alt="IdemStep demo — retried 3x, ordered 1x" width="760" />
</p>

> The clip above runs `npx tsx examples/place-order.ts` end-to-end: the agent submits, re-drives the click twice as a self-healing harness would, the IdemStep proxy suppresses both duplicates, and the checkout site records exactly one order. It is rendered in CI from [`docs/demo.tape`](./docs/demo.tape) via [`vhs`](https://github.com/charmbracelet/vhs).

## How it works

Two processes, no orchestration — a wrapper guards the client-side effect, a proxy guards the network-side duplicate.

```
[ Agent + Playwright ]  --wraps step-->  idemStep()  --records key in-->  [ IdemStore ]
         |                                                                      ^
         | browser traffic via proxy                                           |
         v                                                                      |
[ IdemStep local proxy ]  --checks requestSig against committed keys-----------┘
         |
         v
   [ Real third-party site ]   (duplicate transactional request suppressed; cached response replayed)
```

- **`idemStep(label, key, fn)`** — first call runs `fn`, caches the result, marks the key `committed`. A later call with the same key short-circuits `fn` and replays the cached result.
- **The proxy** — computes a `requestSig` (`method + host + path + body-hash`) for every outbound request carrying an `x-idem-key`. If the key is already `committed`, it replays the cached response instead of forwarding — even if the retry's body has drifted, since the key denotes one logical action. Two concurrent same-key requests coalesce onto a single forward. The retry never reaches the upstream site.
- **HTTPS, not just plaintext** — `startProxy({ https: true })` (CLI `--https`) terminates `CONNECT host:443` tunnels with a locally-trusted MITM leaf cert and runs the same dedup over the decrypted traffic, so exactly-once works against real https checkout sites. Trust the proxy's `caCertPem` in your client. Pass-through only — it never rewrites bodies, headers, or tokens. Requires the system `openssl`.
- **`IdemStore`** — in-memory by default; pass `--store path.json` to the CLI (or `new IdemStore({ filePath })`) so dedup state survives a process restart. Pass `ttlMs` (CLI `--ttl`) to expire committed keys after a window — past it, a retry is a genuinely new action, and the store stays bounded across a long-running session. The JSON-file write is atomic (temp + rename) and a corrupt file is surfaced on startup via `store.loadError` rather than silently swallowed, so a crash mid-persist can no longer lose every committed key and let a retry double-submit unnoticed. Redis/Postgres are out of scope.

Honest scope: IdemStep does **not** ask the third-party site to cooperate — it cannot inject a key a site you don't control will honor. It dedups *client-side* by replaying the request you already committed. That is replay-suppression in a proxy you own, not server-side idempotency.

## vs browser-use self-healing retry

Positioning, not bragging — the harness is genuinely better at the thing it is built for.

| Capability | IdemStep | [browser-use](https://github.com/browser-use/browser-use) self-healing |
| --- | :---: | :---: |
| Re-drives a failed-looking action (DOM recovery) | — | ✓ |
| Idempotency key bound to a transactional step | ✓ | — |
| Suppresses a duplicate POST after a slow-but-successful submit | ✓ | — |
| Exactly-once proof on a real checkout flow | ✓ | — |
| Drop-in: one wrapper, no harness replacement | ✓ | n/a |

IdemStep is not a harness and does not compete with one — it is the dedup half that sits *under* your existing self-healing loop. Use both.

## API

| Export | Signature | Purpose |
| --- | --- | --- |
| `idemStep` | `idemStep(label, key, fn, opts?)` | Exactly-once wrapper around a side-effecting step. |
| `startProxy` | `startProxy(opts?) => RunningProxy` | Start the local interception/dedup proxy. Pass `{ https: true }` for CONNECT/MITM HTTPS interception; the CA to trust is on `proxy.caCertPem`. |
| `IdemStore` | `new IdemStore({ filePath?, ttlMs? })` | The key → `StepRecord` store (in-memory or JSON-file). `ttlMs` expires committed keys after a window. |
| `store.prune()` | `() => number` | Sweep committed keys past the TTL; returns how many were removed. |
| `generateKey` | `generateKey(prefix?)` | Mint an idempotency key (or derive your own stable one). |
| `requestSignature` | `requestSignature(shape)` | Compute the `method+host+path+body-hash` dedup signature. |
| `setDefaultStore` / `getDefaultStore` | — | Swap the process-wide store `idemStep` uses by default. |
| `IDEM_KEY_HEADER` | `"x-idem-key"` | Header the proxy reads to opt a request into dedup. |

CLI: `idemstep proxy [--port N] [--host H] [--store path.json] [--ttl MS] [--https]` for the local proxy, or `idemstep hosted [--api-keys SPEC]` for the hosted dedup proxy — single-tenant by default, or multi-tenant with `--api-keys` (per-operator `x-idem-api-key` auth + per-key namespacing so operators sharing one URL never collide; same flags; binds `0.0.0.0`, durable `--store`, dedup logged server-side).

## Pricing

The OSS core — the local proxy and the `idemStep` wrapper — is free and self-hostable forever under Apache 2.0. The paid tier is the part that is genuinely hard to run yourself reliably across messy real-world sites.

| Plan | Price | What you get |
| --- | --- | --- |
| **Open Source** | Free | Local in-process proxy + `idemStep` wrapper, in-memory / JSON-file store, all milestones in this repo. |
| **Hosted Proxy (self-hosted — v0.4.0 / v0.5.0)** | Free | `idemstep hosted` runs the same interception layer bound to a configurable host/port with a durable JSON-file store, so a remote Playwright context gets managed exactly-once without you operating the proxy. v0.5.0 adds `--api-keys` for multi-tenant per-operator auth + per-key namespacing (single-operator auth/routing only; team plans/billing remain future v0.6.0+). |
| **Hosted Proxy — Starter** | **$49 / mo** | One managed dedup endpoint, 10k deduped transactional steps/mo, durable key store. Point `proxy.server` at the hosted URL — zero code change. |
| **Hosted Proxy — Team** | **$199 / mo** | Multiple endpoints, 100k steps/mo, shared key store, retention/audit log of suppressed duplicates. Overage ~$1 / additional 1k steps. |

The hosted dedup proxy is the v0.2 monetization seam: teams running agents on real-money checkout/booking flows pay for managed exactly-once instead of operating the cross-site interception layer themselves. v0.4.0 shipped the first concrete step — `idemstep hosted`, a self-hostable single-tenant preview of that interception layer (free, Apache 2.0). v0.5.0 takes the next step: `--api-keys` adds per-operator API-key auth + per-key namespacing so multiple operators share one hosted URL in isolated namespaces. The managed tiers above (Starter/Team, with team management, billing, and a dashboard) remain future v0.6.0+. The conversion moment is a one-line swap — point your existing Playwright `proxy.server` at the hosted endpoint and watch the suppressed-duplicate count climb.

## Roadmap

- [x] **m1** — `idemStep(label, key, fn)` wrapper: same-key re-run short-circuits and replays the cached result.
- [x] **m2** — local interception proxy: a duplicate outbound transactional request under a committed key is suppressed and the original response replayed.
- [x] **m3** — runnable `examples/place-order.ts` proving exactly-once end-to-end ("retried 2x, ordered 1x").
- [x] **Concurrency + durability hardening (v0.3)** — proxy-layer in-flight coalescing, committed-replay on body drift, pending release on upstream error, and validation of the JSON-file store on load.
- [x] **HTTPS / CONNECT tunnel (v0.3)** — MITM interception so dedup works against real https sites; `examples/place-order-https.ts` proves exactly-once over TLS.
- [x] **Reliability fixes (v0.4)** — four exactly-once fixes: the wrapper leaking a `pending` record on reject, the CLI firing `main()` on an `index.js`/`index.ts` import, a truncated upstream response hanging the client, and the proxy's commit clobbering the shared-store wrapper's result.
- [x] **Hosted dedup proxy preview (v0.4)** — `idemstep hosted`: the cross-site interception layer bound to a configurable host/port with a durable JSON-file store, single-tenant, dedup logged server-side.
- [x] **Hosted multi-tenant API-key auth (v0.5)** — `idemstep hosted --api-keys`: per-operator API-key auth + per-key IdemStore namespacing, so multiple operators share one hosted URL in isolated namespaces (single-operator auth/routing only; team/billing remain future v0.6.0+).
- [x] **Exactly-once reliability fixes (v0.5)** — atomic JSON-store persist + fail-loud load (no silent key loss on a crash), `commit` no-op on a missing record (shared-store proxy-error race), and `pathToFileURL`-based CLI direct-run detection (spaces/symlinks no longer silently no-op).
- [x] **Reliability + ops hardening (v0.6)** — replayed duplicate responses preserve multi-valued `Set-Cookie` headers (previously joined into one unparseable line); `persist()` fails soft on a disk error (`EACCES`/`ENOSPC`/`ENOENT`) instead of surfacing a system-error rejection through `idemStep`, with a `persistError` the CLI surfaces; and `--prune-interval MS` auto-sweeps TTL-expired keys so a long-running hosted proxy reclaims memory.
- [ ] **Managed multi-tenant hosted tier** — team plans, billing, dashboard (the paid tier beyond the v0.5 self-hosted multi-tenant step).
- [ ] **Auto-detection of side-effecting steps** — POST/submit heuristics so the default path needs zero annotation.
- [ ] **Duplicate-detection / reconcile mode** — post-hoc detection alongside prevention.
- [ ] **More bindings** — Puppeteer, Selenium, native browser-use adapter.

## License &amp; Contributing

Released under the [Apache License, Version 2.0](./LICENSE). Issues and pull requests are welcome — open an [issue](https://github.com/SuperMarioYL/idemstep/issues) for a bug or a request, or send a PR.

After pushing, set discoverable repo topics:

```bash
gh repo edit --add-topic idempotency --add-topic browser-automation --add-topic playwright --add-topic agent
```

## Share this

```text
IdemStep — Stripe's Idempotency-Key, but for your browser Agent. Wrap a
transactional step with one key so a self-healing retry is deduplicated,
not duplicated. Retried 2x, ordered 1x. https://github.com/SuperMarioYL/idemstep
```

<p align="center"><sub><a href="./LICENSE">Apache-2.0</a> © 2026 SuperMarioYL</sub></p>
