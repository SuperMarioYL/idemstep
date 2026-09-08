[English](./README.md) · [Website](https://idemstep.lei6393.com) · [GitHub](https://github.com/SuperMarioYL/idemstep)

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/presentation/hero-mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="./assets/presentation/hero-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./assets/presentation/hero-dark.svg">
  <img src="./assets/presentation/hero-light.svg" width="960" alt="Hero diagram">
</picture>

# IdemStep

**让重试复用第一次结果**

IdemStep 为操作绑定稳定的 Key。JavaScript 包装器复用已完成步骤的结果，HTTP 代理则为重复的带 Key 请求回放缓存响应。

## 为什么需要它

响应缓慢可能使浏览器工作流再次提交已经完成的操作。同一逻辑操作沿用一个 Key，本地存储即可识别重试；新 Key 则明确表示新操作。

- **复用结果** — 已完成的 Key 回放包装器返回值或 HTTP 响应。
- **合并并发重试** — 同一进程内，同 Key 调用共享进行中的操作。
- **选择保留窗口** — 可使用内存或 JSON 持久化存储，并设置已完成 Key 的 TTL。

## 架构

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/presentation/architecture-mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="./assets/presentation/architecture-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./assets/presentation/architecture-dark.svg">
  <img src="./assets/presentation/architecture-light.svg" width="960" alt="Architecture diagram">
</picture>

idemStep 管理本地函数生命周期；IdemStore 保存 pending、committed 状态及缓存值。startProxy 读取 x-idem-key，转发首次请求，存储完整响应，再从缓存处理后续同 Key 调用。进行中映射合并并发调用，JSON 持久化保留已完成记录供重启使用。

| 组件 | 职责 |
| --- | --- |
| `Caller` | stable logical-action key |
| `Wrapper / proxy` | first call or replay |
| `IdemStore` | pending and committed records |
| `HTTP upstream` | first keyed request |

## 安装与快速上手

需要 Node.js 20+。演示使用内置 fetch 和本机 HTTP 服务，无需下载浏览器。

```bash
git clone https://github.com/SuperMarioYL/idemstep.git
cd idemstep
npm ci
npm run build
```

脚本启动实际本地代理和合成订单接口。两次 POST 使用 order-demo-1，第三次使用 order-demo-2，统计实际上游调用并读取回放 Header。

```bash
node examples/presentation-demo.mjs
```

## 实际运行示例

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/presentation/process-mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="./assets/presentation/process-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./assets/presentation/process-dark.svg">
  <img src="./assets/presentation/process-light.svg" width="960" alt="Process diagram">
</picture>

Three local HTTP requests reach the upstream twice; one duplicate response is replayed.

```text
{"key":"order-demo-1","status":200,"replayed":false,"body":{"order":1}}
{"key":"order-demo-1","status":200,"replayed":true,"body":{"order":1}}
{"key":"order-demo-2","status":200,"replayed":false,"body":{"order":2}}
upstream calls=2; suppressed retries=1
Scope: local HTTP fixture; no browser, payment provider or external order.
```

完整命令与输出保存在 [docs/demo-results.json](./docs/demo-results.json). 输入和复现代码均随仓提供。

![已有终端录制](./assets/demo.gif)

保留已有录制供参考；上方文字示例给出当前可复现的操作。

## 用法

库用法从 idemstep 导入 idemStep、generateKey 和 IdemStore。每项逻辑操作生成一次 Key，重试时保留，需共享结果的调用使用同一存储。代理用法是在被拦截请求中传入 x-idem-key，完整 HTTP 输入见 examples/presentation-demo.mjs。新的操作意图即使内容相同，也应使用新 Key。

```bash
node dist/index.js proxy --host 127.0.0.1 --port 8473 --store ./idemstep-state.json --ttl 86400000 --prune-interval 60000
```

## 配置

--host 127.0.0.1 将代理限制在本机，省略 host 会监听所有接口。--store 启用 JSON 持久化。--ttl 使已完成 Key 过期，之后同 Key 可能再次转发；--prune-interval 清理过期记录。--upstream-timeout 限定上游空闲时间。--https 需要 OpenSSL，并要求客户端信任生成的 CA。hosted 模式提供可配置 API Key 命名空间，但没有分布式事务存储或计费服务。

## 集成与职责分工

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/presentation/integrations-mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="./assets/presentation/integrations-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./assets/presentation/integrations-dark.svg">
  <img src="./assets/presentation/integrations-light.svg" width="960" alt="Integrations diagram">
</picture>

包装器和代理是两个接入位置。包装器不会自动向浏览器请求添加网络 Header，需显式配置浏览器代理及请求头。不带幂等 Key 的 HTTP 请求透传，不参与去重。

| 路径 | 已实现职责 |
| --- | --- |
| JavaScript | idemStep wrapper |
| HTTP proxy | x-idem-key request routing |
| Playwright | explicit proxy and headers |
| JSON file | completed-record persistence |
| HTTPS CONNECT | optional local CA interception |

## 限制与后续方向

- 这是本地去重，不能保证端到端严格执行一次。上游已生效但尚未持久化提交时崩溃，结果仍可能不确定。
- 存储不适用于多个独立进程并发共享同一 JSON 文件。
- 示例覆盖本地 HTTP 响应，没有验证浏览器集成、支付 API 或 HTTPS 信任配置。

已实现包装器结果复用、HTTP 回放、并发合并、JSON 持久化、TTL 和可选 CONNECT 拦截。后续方向包括更强的恢复语义和分布式存储。依赖重启持久性前，应查看 CHANGELOG.md 和存储告警。

## 许可与贡献

许可见 [LICENSE](./LICENSE). 反馈问题时请提供最小输入、执行命令和实际输出。
