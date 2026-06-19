# Demo assets

The project README references `../assets/demo.gif` — the "retried 3x, ordered 1x"
capture of the exactly-once happy path.

It is rendered automatically in CI (see [`.github/workflows/demo.yml`](../.github/workflows/demo.yml))
from [`demo.tape`](./demo.tape) on every `v*.*.*` tag, and can be re-rendered
locally with [`vhs`](https://github.com/charmbracelet/vhs):

```bash
npm ci
vhs docs/demo.tape   # writes assets/demo.gif
```

The capture runs `npx tsx examples/place-order.ts`: the agent submits, the
self-healing layer re-drives the click twice more, the IdemStep proxy intercepts
the duplicate requests, and the target site confirms exactly one order.
