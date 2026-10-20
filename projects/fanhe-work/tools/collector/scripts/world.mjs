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

  // 主世界里取 token
  const tkRes = await send('Runtime.evaluate', { expression: `(document.cookie.match(/(?:^|; )_tb_token_=([^;]+)/)||[])[1]||''`, returnByValue: true });
  const token = (tkRes.result && tkRes.result.result && tkRes.result.result.value) || '';

  // 建隔离世界（不受 baxia 钩子影响）
  const tree = await send('Page.getFrameTree', {});
  const frameId = tree.result && tree.result.frameTree ? tree.result.frameTree.frame.id : tree.result.frameTree.frame.id;
  const fid = (tree.result && tree.result.frameTree && tree.result.frameTree.frame && tree.result.frameTree.frame.id) || frameId;
  const w = await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'ops-reader', grantUniveralAccess: true });
  const contextId = w.result && w.result.executionContextId;
  if (!contextId) throw new Error('隔离世界创建失败: ' + JSON.stringify(w).slice(0, 300));

  const qs = query ? (query.startsWith('?') ? query : '?' + query) : '';
  const url = apiPath + qs + (qs.includes('token=') ? '' : (qs ? '&' : '?') + 'token=' + token);

  const expr = `(async()=>{const r=await fetch(${JSON.stringify(url)},{credentials:'include',headers:{'Accept':'application/json'}});const t=await r.text();return 'STATUS:'+r.status+'\\n'+t.slice(0,14000);})()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, contextId });
  const v = r && r.result && r.result.result ? r.result.result.value : undefined;
  if (typeof v !== 'string') {
    console.log('TYPEOF', typeof v, 'RAW', JSON.stringify(r).slice(0, 3000));
  } else {
    console.log(v.slice(0, 14000));
  }
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
