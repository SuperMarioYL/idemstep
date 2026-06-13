# Demo assets

`demo.gif` lives here — the 20-second "retried 2x, ordered 1x" capture referenced
from the project README.

To regenerate it, record a terminal/browser split while running:

```bash
npx tsx examples/place-order.ts
```

The capture should show: the agent submits, the response hangs, the self-healing
layer re-drives the click, the IdemStep proxy intercepts the duplicate request,
and the target site confirms exactly one order — overlay caption
`retried 2x, ordered 1x`.
