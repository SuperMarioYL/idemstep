/**
 * examples/place-order-https.ts — the "retried 2x, ordered 1x" demo, but over
 * a real HTTPS checkout site through the CONNECT/MITM tunnel (v0.3).
 *
 * The plaintext demo (place-order.ts) proves exactly-once against an http
 * fixture. Real checkout/booking sites are HTTPS, reached through a
 * `CONNECT host:443` tunnel the plaintext proxy cannot terminate. This script
 * proves the same exactly-once guarantee end-to-end over HTTPS:
 *
 *   1. Boots a tiny HTTPS "store" with a POST /checkout endpoint (a self-signed
 *      cert stands in for the real third-party site you don't control).
 *   2. Starts the IdemStep proxy with `https: true` — it terminates the CONNECT
 *      tunnel with a locally-trusted MITM leaf cert and runs the same
 *      x-idem-key dedup over the decrypted traffic.
 *   3. Drives the transactional POST through the tunnel three times (1 real +
 *      2 self-healing retries), trusting the proxy's CA on the client side.
 *   4. Asserts the HTTPS checkout server saw exactly ONE order.
 *
 * Pass-through only: the tunnel reads x-idem-key and replays cached responses;
 * it never rewrites bodies, headers, or tokens.
 *
 * Run it:  npx tsx examples/place-order-https.ts
 * Requires the system `openssl` binary (used to mint the local CA + leaf certs).
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, IDEM_KEY_HEADER, generateKey } from "../src/index.js";

let ordersPlaced = 0;

// ---- 1. a real HTTPS "third-party" checkout site we don't control -----------

function startHttpsCheckoutSite(): {
  url: { host: string; port: number };
  cert: string;
  server: https.Server;
  close: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "idem-https-demo-"));
  const keyP = join(dir, "site.key");
  const crtP = join(dir, "site.crt");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyP, "-out", crtP,
      "-days", "825", "-nodes", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(crtP, "utf8");
  const server = https.createServer(
    { key: readFileSync(keyP), cert: readFileSync(crtP) },
    (req, res) => {
      if (req.method === "POST" && req.url === "/checkout") {
        setTimeout(() => {
          ordersPlaced += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, order: ordersPlaced }));
        }, 200);
        return;
      }
      res.writeHead(404).end();
    },
  );
  return {
    url: { host: "127.0.0.1", port: 0 },
    cert,
    server,
    close: () =>
      new Promise<void>((r) => server.close(() => {
        rmSync(dir, { recursive: true, force: true });
        r();
      })),
  };
}

// Send one POST through the proxy's CONNECT tunnel, trusting its MITM CA.
function postThroughTunnel(
  proxyPort: number,
  siteHost: string,
  sitePort: number,
  caCertPem: string,
  key: string,
): Promise<{ replayed: boolean; order: number }> {
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: "localhost",
      port: proxyPort,
      method: "CONNECT",
      path: `${siteHost}:${sitePort}`,
    });
    connectReq.on("connect", (_res, socket) => {
      const tlsSocket = tls.connect({ socket, servername: siteHost, ca: caCertPem });
      tlsSocket.on("error", reject);
      tlsSocket.on("secureConnect", () => {
        const payload = JSON.stringify({ cart: ["sku-1"], total: 4200 });
        const reqOverTunnel = http.request(
          {
            method: "POST",
            path: "/checkout",
            createConnection: () => tlsSocket as never,
            headers: {
              host: `${siteHost}:${sitePort}`,
              [IDEM_KEY_HEADER]: key,
              "x-idem-label": "place_order",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            },
          },
          (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c: Buffer) => chunks.push(c));
            resp.on("end", () => {
              const replayed = String(resp.headers["x-idem-replayed"]) === "true";
              const { order } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              resolve({ replayed, order });
            });
          },
        );
        reqOverTunnel.on("error", reject);
        reqOverTunnel.end(payload);
      });
    });
    connectReq.on("error", reject);
    connectReq.end();
  });
}

async function main() {
  const site = startHttpsCheckoutSite();
  await new Promise<void>((r) => site.server.listen(0, "127.0.0.1", () => r()));
  const sitePort = (site.server.address() as AddressInfo).port;

  const proxy = await startProxy({
    port: 0,
    https: true,
    log: (l) => console.log(`  ${l}`),
    // Trust the demo site's self-signed cert (a real https site needs nothing).
    upstreamTls: { ca: site.cert },
  });

  if (!proxy.caCertPem) {
    console.error("FAILED: HTTPS interception unavailable (is `openssl` installed?)");
    await proxy.close();
    await site.close();
    process.exit(1);
  }

  const orderKey = generateKey("order");
  console.log("\nIdemStep HTTPS demo — one order over a TLS tunnel, retried 3x.\n");
  console.log(`  checkout site : https://127.0.0.1:${sitePort}`);
  console.log(`  idem proxy    : http://localhost:${proxy.port} (https tunnel ON)`);
  console.log(`  idempotency key: ${orderKey}\n`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`  attempt #${attempt}: agent re-drives submit through the tunnel...`);
    const { replayed, order } = await postThroughTunnel(
      proxy.port, "127.0.0.1", sitePort, proxy.caCertPem, orderKey,
    );
    console.log(`    -> ${replayed ? "REPLAYED (suppressed)" : "forwarded"} order=${order}`);
  }

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
  console.log("PASS: retried 2x, ordered 1x — over HTTPS.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
