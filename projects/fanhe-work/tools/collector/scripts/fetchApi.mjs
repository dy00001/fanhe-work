import http from 'node:http';
import fs from 'node:fs';

const PORT = 9222;
const OUT = process.env.OUT || null;
const [, , apiPath, query] = process.argv;

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(12000, () => r.destroy(new Error('timeout ' + p)));
    r.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // 先从一个已登录标签页拿到 token
  const list = JSON.parse((await req('GET', '/json/list')).body);
  const hostTab = list.find((t) => t.type === 'page' && /sycm\.taobao\.com/.test(t.url));
  if (!hostTab) throw new Error('无生意参谋标签页');

  const url0 = 'https://sycm.taobao.com/portal/shop/getMainCateInfo.json';
  let token = '';
  {
    const ws = new WebSocket(hostTab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    let id = 0; const pend = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    const r = await send('Runtime.evaluate', { expression: `(document.cookie.match(/(?:^|; )_tb_token_=([^;]+)/)||[])[1]||''`, returnByValue: true });
    token = (r.result && r.result.result && r.result.result.value) || '';
    ws.close();
  }
  console.log('TOKEN', token);

  const qs = query ? (query.startsWith('?') ? query : '?' + query) : '';
  const full = 'https://sycm.taobao.com' + apiPath + qs + (qs.includes('token=') ? '' : (qs ? '&' : '?') + 'token=' + token);

  const created = await req('PUT', '/json/new?' + encodeURIComponent(full));
  const target = JSON.parse(created.body);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

  await send('Page.enable');

  let text = '';
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const r = await send('Runtime.evaluate', { expression: `document.body?document.body.innerText:''`, returnByValue: true });
    const v = (r.result && r.result.result && r.result.result.value) || '';
    if (v && v.trim().length > 20) { text = v; break; }
  }

  if (OUT) { fs.mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true }); fs.writeFileSync(OUT, text, 'utf8'); }
  console.log(text.slice(0, 6000));

  try { await req('GET', '/json/close/' + target.id); } catch {}
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
