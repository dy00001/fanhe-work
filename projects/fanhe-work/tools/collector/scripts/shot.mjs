import http from 'node:http';
import fs from 'node:fs';

const PORT = 9222;
const [, , target, out, wArg, hArg, fullPage] = process.argv;
const W = Number(wArg || 1600);
const H = Number(hArg || 1100);

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = /^[a-z]+:\/\//i.test(target) ? target : 'file:///' + target.replace(/\\/g, '/');
  const created = await req('PUT', '/json/new?' + encodeURIComponent(url));
  const t = JSON.parse(created.body);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await sleep(1200);

  const pre = process.env.EVAL;
  if (pre) {
    const r = await send('Runtime.evaluate', { expression: pre, returnByValue: true, awaitPromise: true });
    console.log('EVAL', JSON.stringify(r.result && r.result.result ? r.result.result.value : r).slice(0, 200));
    await sleep(500);
  }

  let clip;
  if (fullPage === 'full') {
    const lm = await send('Page.getLayoutMetrics');
    const cs = lm.result.cssContentSize || lm.result.contentSize;
    clip = { x: 0, y: 0, width: W, height: Math.min(cs.height, 4000), scale: 1 };
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip } : {}) });
  const b64 = shot.result.data;
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('saved', out, fs.statSync(out).size, 'bytes');

  try { await req('GET', '/json/close/' + t.id); } catch {}
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
