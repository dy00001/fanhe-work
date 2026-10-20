import http from 'node:http';
const PORT = 9222;
const [, , target, expr] = process.argv;
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
  let id = 0; const pend = new Map(); const logs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 600));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR ' + JSON.stringify(m.params.args.map(a => a.value || a.description)).slice(0, 600));
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);
  if (expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    console.log('RESULT', JSON.stringify(r.result && r.result.result ? (r.result.result.value ?? r.result.result.description) : r).slice(0, 3000));
  }
  console.log('LOGS', logs.length ? logs.join('\n') : '(none)');
  try { await req('GET', '/json/close/' + t.id); } catch {}
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
