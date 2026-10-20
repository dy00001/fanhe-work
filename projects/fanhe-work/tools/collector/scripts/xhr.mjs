import http from 'node:http';

const PORT = 9222;
const [, , apiPath, query] = process.argv;

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(12000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

async function main() {
  const list = JSON.parse((await req('GET', '/json/list')).body);
  const tab = list.find((t) => t.type === 'page' && /sycm\.taobao\.com/.test(t.url));
  if (!tab) throw new Error('无生意参谋标签页');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

  const qs = query ? (query.startsWith('?') ? query : '?' + query) : '';
  const url = apiPath + qs;

  const expr = `new Promise((resolve) => {
    try {
      const tk = (document.cookie.match(/(?:^|; )_tb_token_=([^;]+)/)||[])[1]||'';
      const u = ${JSON.stringify(url)} + (${JSON.stringify(url)}.includes('?') ? '&' : '?') + 'token=' + tk;
      const x = new XMLHttpRequest();
      x.open('GET', u, true);
      x.withCredentials = true;
      x.setRequestHeader('Accept', 'application/json, text/plain, */*');
      x.onload = () => resolve('STATUS:' + x.status + '\\n' + String(x.responseText).slice(0, 9000));
      x.onerror = () => resolve('XHR_ERROR status=' + x.status);
      x.send();
    } catch (e) { resolve('THROW ' + e.message); }
  })`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const v = r && r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 800);
  console.log(String(v).slice(0, 9000));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
