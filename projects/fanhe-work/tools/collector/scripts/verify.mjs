import http from 'node:http';
import fs from 'node:fs';
const PORT = 9222;
const [, , target, out, expr] = process.argv;
function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); r.setTimeout(15000, () => r.destroy(new Error('timeout'))); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const url = /^[a-z]+:\/\//i.test(target) ? target : 'file:///' + target.replace(/\\/g, '/');
  const created = await req('PUT', '/json/new?' + encodeURIComponent(url));
  const t = JSON.parse(created.body);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 2, mobile: false });
  await sleep(1500);
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const v = r.result && r.result.result ? (r.result.result.value ?? r.result.result.description) : JSON.stringify(r);
  console.log('CHECK', typeof v === 'string' ? v.slice(0, 600) : JSON.stringify(v).slice(0, 600));
  await sleep(600);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (out) fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  try { await req('GET', '/json/close/' + t.id); } catch {}
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
