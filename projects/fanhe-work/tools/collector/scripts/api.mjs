import http from 'node:http';

const PORT = 9222;

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

// 用法: node api.mjs /bda/tradinganaly/overview/get_summary.json "dateRange=2026-10-01|2026-10-18&dateType=day&device=0"
const [, , apiPath, query] = process.argv;

async function main() {
  const list = JSON.parse((await req('GET', '/json/list')).body);
  const pages = list.filter((t) => t.type === 'page' && /sycm\.taobao\.com/.test(t.url));
  if (!pages.length) throw new Error('没有可用的生意参谋标签页');
  // 优先挑首页/非采集页
  const host = pages.find((p) => /portal\/home|ipoll\/index/.test(p.url)) || pages[0];
  console.log('HOST TAB', host.url);

  const ws = new WebSocket(host.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });
  const send = (method, params = {}) => {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
    });
  };

  const token = `(document.cookie.match(/(?:^|; )_tb_token_=([^;]+)/)||[])[1]||''`;
  const url = `${apiPath}${query ? (query.startsWith('?') ? '' : '?') + query : ''}`;
  const expr = `(async()=>{const tk=${token};const sep=${JSON.stringify(url)}.includes('?')?'&':'?';const r=await fetch(${JSON.stringify(url)}+sep+'token='+tk,{credentials:'include',headers:{'Accept':'application/json'}});const t=await r.text();return t.slice(0,12000);})()`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  function dig(o, depth) {
    if (!o || depth > 6) return undefined;
    if (typeof o.value === 'string') return o.value;
    for (const k of ['result', 'value', 'result']) {
      const n = dig(o[k], depth + 1);
      if (n !== undefined) return n;
    }
    return undefined;
  }
  let val = dig(r, 0);
  if (val === undefined) val = 'RAW: ' + JSON.stringify(r).slice(0, 2000);
  console.log(String(val).slice(0, 12000));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
