# vhs tape — IdemStep happy path: "retried 3x, ordered 1x".
# Render in CI via .github/workflows/demo.yml, or locally with:
#   vhs docs/demo.tape
# (needs `tsx` and the repo's deps installed: `npm ci`).
Output assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1100
Set Height 680
Set Theme "Dracula"
Set Padding 18

Type "# IdemStep — a self-healing retry must NOT place the order twice."
Enter
Sleep 700ms

Type "# 1) The CLI starts the local dedup proxy:"
Enter
Sleep 500ms
Type "idemstep --help | head -n 8"
Enter
Sleep 2.5s

Type "# 2) Run the demo: submit once, re-drive it 3x, see exactly-once."
Enter
Sleep 600ms
Type "npx tsx examples/place-order.ts"
Enter
Sleep 5s
