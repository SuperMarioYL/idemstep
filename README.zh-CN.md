<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=700&size=34&duration=3500&pause=900&color=7C5CFF&center=true&vCenter=true&width=720&height=70&lines=IdemStep;Exactly-once+for+browser+agents" alt="IdemStep" />
</p>

<p align="center">
  <em>为浏览器 Agent 而生的幂等键层——让重试也只下单一次。</em>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/release-v0.3.0-7c5cff.svg" alt="Release v0.3.0" />
  <a href="./.github/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-vitest-success.svg" alt="CI: vitest" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/exactly--once-✓-0db7a4.svg" alt="Exactly-once" />
  <img src="https://img.shields.io/badge/Agent--ready-✓-7c5cff.svg" alt="Agent-ready" />
</p>

<p align="center">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

> **你的浏览器 Agent 在一次「慢但成功」的提交之后触发自愈重试，重新点击了「下单」——于是信用卡被扣了两次。IdemStep 用一个客户端生成的幂等键包裹这一步，让重试被去重，而不是被复制。**

## 目录

- [为什么需要它](#为什么需要它)
- [架构](#架构)
- [安装与快速上手](#安装与快速上手)
- [演示](#演示)
- [工作原理](#工作原理)
- [对比 browser-use 自愈重试](#对比-browser-use-自愈重试)
- [API](#api)
- [定价](#定价)
- [路线图](#路线图)
- [许可与贡献](#许可与贡献)

## 为什么需要它

自愈式浏览器框架会重新驱动任何「看起来失败」的动作——这正是让脆弱的网页自动化变得可用的关键。但在一次「慢但成功」的提交之后触发的重试并不理解幂等性，于是预订、结账、注册被执行了两次。这种模式正在快速扩散：[browser-use/browser-use](https://github.com/browser-use/browser-use)（98k★）这个运行时被托付了越来越多的写操作，其自愈层每天增长数百颗星。支付领域多年前就用 Stripe 的 `Idempotency-Key` 解决了这个问题——一个稳定、由客户端生成的令牌，让接收方能识别「这是一次重试，而不是一个新请求」。IdemStep 把这个原语移植到浏览器层：用一个键包裹事务步骤，让浏览器走本地代理，被重新驱动的提交就在网络边界变成空操作（no-op）。自从自愈重试开始触碰真金白银的流程那天起，Agent 构建者群体（[affaan-m/ECC](https://github.com/affaan-m/ECC) 以及更广的可靠性圈子）就一直需要这条安全带。

## <img src="https://api.iconify.design/tabler:topology-star-3.svg?color=%230071E3&width=24" height="22" align="absmiddle" alt=""> 架构

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/atlas-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/atlas-light.svg">
    <img src="./assets/atlas-light.svg" width="880" alt="架构：Agent 用 idemStep() 包裹事务步骤，并把键写入 IdemStore；浏览器流量经本地代理转发，代理用 requestSig 比对已 committed 的键，要么把首个请求转发给第三方站点，要么回放缓存响应，从而抑制自愈重试">
  </picture>
</p>

两个协作的进程，被框在一个**你自己拥有的「恰好一次」边界**内——无需第三方站点配合。**`idemStep()` 包装器**守护客户端副作用（命中已 committed 的键时回放缓存结果，而不重新执行 `fn`），并把每个键写入 **`IdemStore`**（内存或 JSON 文件）。浏览器流量经**本地代理**转发，代理计算 `requestSig`（`method + host + path + body-hash`）；当某个已 committed 的键已经拥有该签名时，回放缓存响应而不转发——于是自愈重试永远到不了**第三方站点**，订单恰好下一次。

## <img src="https://api.iconify.design/tabler:rocket.svg?color=%230071E3&width=24" height="22" align="absmiddle" alt=""> 安装与快速上手

从全新克隆到第一次「恰好一次」证明，只需三步：

```bash
npm install idemstep playwright   # 1. 安装（playwright 是 peer 依赖）
npx idemstep proxy                # 2. 启动本地去重代理（会打印端口）
npx tsx examples/place-order.ts   # 3. 运行演示：重试 3 次，仅下单 1 次
```

随后在你自己的 Agent 脚本中包裹任意事务步骤——让 Playwright 走代理，并守护这一次点击：

```ts
import { chromium } from "playwright";
import { idemStep, startProxy, generateKey, IDEM_KEY_HEADER } from "idemstep";

// 1. 启动本地拦截代理（也可以单独运行 `npx idemstep proxy`）。
const proxy = await startProxy({ port: 8473 });

// 2. 让浏览器走这个代理。
const browser = await chromium.launch({
  proxy: { server: `http://localhost:${proxy.port}` },
});
const page = await (await browser.newContext()).newPage();

// 3. 为这一逻辑动作铸造一个稳定的键，并盖在请求上。
const orderKey = generateKey("order"); // 也可派生 `order:${cartId}`，跨重启也能命中
await page.route("**/checkout", (route) =>
  route.continue({ headers: { ...route.request().headers(), [IDEM_KEY_HEADER]: orderKey } }),
);

// 4. 包裹有副作用的步骤。带相同键的自愈重试就是空操作。
await idemStep("place_order", orderKey, () => page.click("#submit"));
await idemStep("place_order", orderKey, () => page.click("#submit")); // 重试——被抑制
```

<details>
<summary>演示运行的示例输出</summary>

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

## <img src="https://api.iconify.design/tabler:photo.svg?color=%230071E3&width=24" height="22" align="absmiddle" alt=""> 演示

<p align="center">
  <img src="./assets/demo.gif" alt="IdemStep 演示——重试 3 次，下单 1 次" width="760" />
</p>

> 上方的录屏端到端运行 `npx tsx examples/place-order.ts`：Agent 提交后，像自愈框架那样再重新驱动两次点击，IdemStep 代理抑制了这两个重复请求，结账站点只记录到一笔订单。它由 CI 从 [`docs/demo.tape`](./docs/demo.tape) 经 [`vhs`](https://github.com/charmbracelet/vhs) 渲染生成。

## 工作原理

两个进程，无需编排——包装器守护客户端副作用，代理守护网络侧的重复请求。

```
[ Agent + Playwright ]  --包裹步骤-->  idemStep()  --写入键-->  [ IdemStore ]
         |                                                            ^
         | 浏览器流量经代理转发                                       |
         v                                                            |
[ IdemStep 本地代理 ]  --用 requestSig 比对已 committed 的键---------┘
         |
         v
   [ 真实第三方站点 ]   （重复的事务请求被抑制；回放已缓存的响应）
```

- **`idemStep(label, key, fn)`**——首次调用执行 `fn`、缓存结果、把键标记为 `committed`；后续相同键的调用会短路 `fn` 并回放缓存结果。
- **代理**——为每个带 `x-idem-key` 的出站请求计算 `requestSig`（`method + host + path + body-hash`）。若某个键已 `committed`，则回放缓存响应而不转发——即便重试的请求体发生了漂移，因为键代表的是同一个逻辑动作。两个并发的同键请求会合并为一次转发。重试永远到不了上游站点。
- **不仅是明文 HTTP** —— `startProxy({ https: true })`（CLI `--https`）会用本地可信的 MITM 叶子证书终结 `CONNECT host:443` 隧道，并在解密后的流量上跑同一套去重逻辑，于是「恰好一次」也能作用于真实的 HTTPS 结账站点。在客户端信任代理的 `caCertPem` 即可。仅做透传——绝不改写请求体、请求头或令牌。需要系统自带 `openssl`。
- **`IdemStore`**——默认在内存中；给 CLI 传 `--store path.json`（或 `new IdemStore({ filePath })`）即可让去重状态在进程重启后留存。传入 `ttlMs`（CLI `--ttl`）可让已 committed 的键在窗口之后过期——过期之后，同键的重试被视为一次全新动作，存储也不会随长时间运行无限增长。Redis/Postgres 不在范围内。

诚实的边界：IdemStep **不**要求第三方站点配合——它无法向一个你不掌控的站点注入它会认账的键。它在*客户端*通过回放你已经提交过的请求来去重。这是你自己拥有的代理里的「回放抑制」，而非服务端幂等。

## 对比 browser-use 自愈重试

这是定位，不是吹嘘——在框架擅长的事情上，它确实更强。

| 能力 | IdemStep | [browser-use](https://github.com/browser-use/browser-use) 自愈 |
| --- | :---: | :---: |
| 重新驱动「看起来失败」的动作（DOM 恢复） | — | ✓ |
| 把幂等键绑定到一个事务步骤 | ✓ | — |
| 抑制「慢但成功」提交之后的重复 POST | ✓ | — |
| 在真实结账流程上证明恰好一次 | ✓ | — |
| 即插即用：一个包装器，无需替换框架 | ✓ | 不适用 |

IdemStep 不是框架，也不与框架竞争——它是垫在你现有自愈循环*之下*的去重那一半。两者并用即可。

## API

| 导出 | 签名 | 用途 |
| --- | --- | --- |
| `idemStep` | `idemStep(label, key, fn, opts?)` | 对有副作用的步骤做恰好一次包装。 |
| `startProxy` | `startProxy(opts?) => RunningProxy` | 启动本地拦截/去重代理。传入 `{ https: true }` 开启 CONNECT/MITM 的 HTTPS 拦截；需要信任的 CA 在 `proxy.caCertPem` 上。 |
| `IdemStore` | `new IdemStore({ filePath?, ttlMs? })` | 键 → `StepRecord` 的存储（内存或 JSON 文件）。`ttlMs` 让已 committed 的键在窗口之后过期。 |
| `store.prune()` | `() => number` | 清扫已超过 TTL 的 committed 键；返回被移除的数量。 |
| `generateKey` | `generateKey(prefix?)` | 铸造一个幂等键（也可自行派生稳定键）。 |
| `requestSignature` | `requestSignature(shape)` | 计算 `method+host+path+body-hash` 去重签名。 |
| `setDefaultStore` / `getDefaultStore` | — | 替换 `idemStep` 默认使用的进程级存储。 |
| `IDEM_KEY_HEADER` | `"x-idem-key"` | 代理据此判定一个请求是否参与去重的请求头。 |

CLI：`idemstep proxy [--port N] [--store path.json] [--ttl MS] [--https]`。

## 定价

OSS 核心——本地代理与 `idemStep` 包装器——在 MIT 许可下永久免费、可自部署。付费层是那一块在真实、混乱的站点上很难自己可靠运行的部分。

| 套餐 | 价格 | 包含内容 |
| --- | --- | --- |
| **开源版** | 免费 | 本地进程内代理 + `idemStep` 包装器，内存 / JSON 文件存储，本仓库的全部里程碑。 |
| **托管代理 — Starter** | **$49 / 月** | 1 个托管去重端点，每月 1 万次去重事务步骤，持久键存储。把 `proxy.server` 指向托管 URL 即可——零代码改动。 |
| **托管代理 — Team** | **$199 / 月** | 多端点，每月 10 万步，共享键存储，被抑制重复的留存/审计日志。超量约 $1 / 每额外 1 千步。 |

托管去重代理是 v0.2 的变现切口：在真金白银的结账/预订流程上跑 Agent 的团队，会为「托管的恰好一次」付费，而不是自己运维这套跨站拦截层。转化时刻是一行替换——把现有 Playwright 的 `proxy.server` 指向托管端点、粘贴一个 API key，就能在仪表盘里看到被抑制的重复计数往上爬。

## 路线图

- [x] **m1**——`idemStep(label, key, fn)` 包装器：相同键的重试会短路并回放缓存结果。
- [x] **m2**——本地拦截代理：某个 committed 键下的重复出站事务请求会被抑制，并回放原始响应。
- [x] **m3**——可运行的 `examples/place-order.ts`，端到端证明恰好一次（「重试 2 次，下单 1 次」）。
- [x] **并发与持久化加固（v0.3）**——代理层在途请求合并、请求体漂移时回放已 committed 记录、上游出错时释放 pending、以及 JSON 文件存储加载时的校验。
- [x] **HTTPS / CONNECT 隧道（v0.3）**——MITM 拦截，让去重作用于真实 HTTPS 站点；`examples/place-order-https.ts` 在 TLS 上证明恰好一次。
- [ ] **托管去重代理**——把托管的跨站拦截层（持久存储、审计日志）作为付费层。
- [ ] **副作用步骤自动识别**——POST/submit 启发式，让默认路径无需任何标注。
- [ ] **重复检测 / 对账模式**——在预防之外提供事后检测。
- [ ] **更多绑定**——Puppeteer、Selenium、原生 browser-use 适配器。

## 许可与贡献

基于 [MIT 许可证](./LICENSE) 发布。欢迎提交 Issue 与 Pull Request——发现缺陷或有需求请开一个 [issue](https://github.com/SuperMarioYL/idemstep/issues)，或直接发 PR。

推送之后，设置便于发现的仓库 topics：

```bash
gh repo edit --add-topic idempotency --add-topic browser-automation --add-topic playwright --add-topic agent
```

## 一句话转发

```text
IdemStep — Stripe's Idempotency-Key, but for your browser Agent. Wrap a
transactional step with one key so a self-healing retry is deduplicated,
not duplicated. Retried 2x, ordered 1x. https://github.com/SuperMarioYL/idemstep
```

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
