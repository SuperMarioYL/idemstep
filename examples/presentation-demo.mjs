import http from 'node:http';
import assert from 'node:assert/strict';
import {startProxy} from '../dist/index.js';
let received = 0;
const upstream = http.createServer((req, res) => {
  req.resume(); req.on('end', () => { received++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({order:received})); });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const proxy = await startProxy({port:0, host:'127.0.0.1', log:false});
try {
  for (const key of ['order-demo-1','order-demo-1','order-demo-2']) {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/orders`, {method:'POST', headers:{'x-idem-key':key, 'x-idem-target':`http://127.0.0.1:${upstream.address().port}`, 'content-type':'application/json'}, body:JSON.stringify({item:'example-book',quantity:1})});
    console.log(JSON.stringify({key,status:response.status,replayed:response.headers.get('x-idem-replayed') === 'true',body:await response.json()}));
  }
  assert.equal(received,2); assert.equal(proxy.suppressedCount(),1);
  console.log(`upstream calls=${received}; suppressed retries=${proxy.suppressedCount()}`);
  console.log('Scope: local HTTP fixture; no browser, payment provider or external order.');
} finally { await proxy.close(); await new Promise(resolve=>upstream.close(resolve)); }
