/**
 * examples/place-order.ts — the "retried 2x, ordered 1x" demo.
 *
 * This script proves the whole IdemStep loop end-to-end against a real HTTP
 * checkout server and a real browser:
 *
 *   1. Boots a tiny local "store" with a POST /checkout endpoint that counts
 *      how many orders it actually placed (this stands in for the real
 *      third-party site you don't control).
 *   2. Starts the IdemStep interception proxy.
 *   3. Drives a Playwright page through the proxy, wrapping the submit in
 *      `idemStep("place_order", key, ...)` and stamping the idempotency key
 *      on the request.
 *   4. Simulates a self-healing harness: it re-drives the submit TWICE more
 *      after the first (slow-but-successful) attempt.
 *   5. Asserts the checkout server saw exactly ONE order.
 *
 * Run it:  npx tsx examples/place-order.ts
 *
 * If Playwright browsers are not installed, the script falls back to driving
 * the proxy with plain fetch() so the exactly-once proof still runs in CI.
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { startProxy, idemStep, IDEM_KEY_HEADER, generateKey } from "../src/index.js";

// ---- 1. the "third-party" checkout site we don't control --------------------

let ordersPlaced = 0;

function startCheckoutSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/checkout") {
      // Deliberately slow so the first response is "slow-but-successful" — the
      // exact window in which a self-healing retry fires.
      setTimeout(() => {
        ordersPlaced += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, order: ordersPlaced }));
      }, 250);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><form method="post" action="/checkout">
      <button id="submit" type="submit">Place order</button></form>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  const site = await startCheckoutSite();
  const proxy = await startProxy({ port: 0, log: (l) => console.log(`  ${l}`) });
  const orderKey = generateKey("order");

  console.log("\nIdemStep demo — placing one order, retrying it three times.\n");
  console.log(`  checkout site : ${site.url}`);
  console.log(`  idem proxy    : http://localhost:${proxy.port}`);
  console.log(`  idempotency key: ${orderKey}\n`);

  // The transactional request, sent THROUGH the proxy with the idempotency
  // key header. idemStep() guards the client-side effect; the proxy guards the
  // network-side duplicate.
  const submitOnce = (attempt: number) =>
    idemStep("place_order", orderKey, async () => {
      console.log(`  attempt #${attempt}: agent re-drives submit...`);
      const resp = await fetch(`http://localhost:${proxy.port}/checkout`, {
        method: "POST",
        headers: {
          "x-idem-target": site.url,
          "content-type": "application/json",
          [IDEM_KEY_HEADER]: orderKey,
          "x-idem-label": "place_order",
        },
        body: JSON.stringify({ cart: ["sku-1"], total: 4200 }),
      });
      const replayed = resp.headers.get("x-idem-replayed") === "true";
      const json = await resp.json();
      console.log(
        `    -> ${replayed ? "REPLAYED (suppressed)" : "forwarded"} status=${resp.status}`,
      );
      return json;
    });

  // We must route fetch to the proxy by absolute URL, so the proxy reconstructs
  // the upstream from the Host header. Drive it three times (1 real + 2 retry).
  await tryPlaywright(proxy.port, site.url, orderKey).catch(async (err) => {
    console.log(`  (playwright unavailable: ${err.message}; using fetch fallback)\n`);
    await submitOnce(1);
    await submitOnce(2);
    await submitOnce(3);
  });

  await new Promise((r) => setTimeout(r, 150));

  console.log("\n  ──────────────────────────────────────────");
  console.log(`  retried 3x  ·  orders actually placed: ${ordersPlaced}`);
  console.log(`  proxy suppressed: ${proxy.suppressedCount()} duplicate request(s)`);
  console.log("  ──────────────────────────────────────────\n");

  await proxy.close();
  await site.close();

  if (ordersPlaced !== 1) {
    console.error(`FAILED: expected exactly 1 order, got ${ordersPlaced}`);
    process.exit(1);
  }
  console.log("PASS: retried 2x, ordered 1x.\n");
}

/**
 * Best-effort real-browser path. Uses Playwright if available; the route
 * handler stamps the idempotency key on the transactional POST and re-drives
 * it three times to mimic a self-healing harness.
 */
async function tryPlaywright(proxyPort: number, siteUrl: string, key: string): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    proxy: { server: `http://localhost:${proxyPort}` },
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Stamp the idempotency key on the transactional submit request.
  await page.route("**/checkout", async (route) => {
    const req = route.request();
    await route.continue({
      headers: {
        ...req.headers(),
        [IDEM_KEY_HEADER]: key,
        "x-idem-label": "place_order",
      },
    });
  });

  await page.goto(siteUrl);
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`  attempt #${attempt}: agent clicks #submit...`);
    await idemStep("place_order", key, () =>
      page.click("#submit").catch(() => {/* form may already be submitted */}),
    );
    await page.waitForTimeout(120);
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
