import http from 'node:http';

const PORT = 9222;

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json')); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('http timeout')));
    req.end();
  });
}

async function main() {
  const targets = await getJson('/json/list');
  const t = targets.filter((x) => x.type === 'page')[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
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
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws err'))); setTimeout(() => rej(new Error('ws timeout')), 8000); });

  const send = (method, params = {}) => {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 20000);
    });
  };

  const expr = `(() => {
    const links = [...document.querySelectorAll('a[href]')].map(a => ({t: (a.innerText||'').trim().replace(/\\s+/g,''), h: a.getAttribute('href')})).filter(x => x.h && !x.h.startsWith('javascript'));
    const seen = new Set(); const out = [];
    for (const l of links) { const k = l.t + '|' + l.h; if (!seen.has(k)) { seen.add(k); out.push(l); } }
    return JSON.stringify(out.slice(0, 80));
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(r.result.value);
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
