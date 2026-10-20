import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9222;
const [, , rawUrl, outDir, preArg, exprArg, postArg] = process.argv;
const preMs = Number(preArg || 8000);
const postMs = Number(postArg || 10000);

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout ' + p)));
    r.end();
  });
}

async function main() {
  const created = await req('PUT', '/json/new?' + encodeURIComponent(rawUrl));
  const target = JSON.parse(created.body);
  console.log('NEW TARGET', target.id);

  fs.mkdirSync(outDir, { recursive: true });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const byId = new Map();
  const seen = [];
  const saved = [];
  let send;

  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Network.responseReceived') {
      const { requestId, response, type } = msg.params;
      if (type === 'XHR' || type === 'Fetch') {
        const rec = { requestId, url: response.url, mime: response.mimeType, status: response.status };
        seen.push(rec);
        byId.set(requestId, rec);
      }
    }
    if (msg.method === 'Network.loadingFinished') {
      const rec = byId.get(msg.params.requestId);
      if (!rec || rec.done) return;
      rec.done = true;
      try {
        const body = await send('Network.getResponseBody', { requestId: rec.requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        if (text && text.length > 80 && !/^\s*</.test(text)) {
          const name = String(saved.length + 1).padStart(2, '0') + '_' + (rec.url.split('?')[0].split('/').pop() || 'resp').replace(/[^\w.\-]/g, '_').slice(0, 55) + '.json';
          const fp = path.join(outDir, name);
          fs.writeFileSync(fp, text, 'utf8');
          saved.push({ file: path.basename(fp), url: rec.url, bytes: text.length });
        }
      } catch {}
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
    setTimeout(() => rej(new Error('ws open timeout')), 10000);
  });

  send = (method, params = {}) => {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 25000);
    });
  };

  await send('Page.enable');
  await send('Network.enable', { maxTotalBufferSize: 300 * 1024 * 1024, maxResourceBufferSize: 30 * 1024 * 1024 });

  await new Promise((r) => setTimeout(r, preMs));

  let exprResult = null;
  if (exprArg && exprArg !== '-') {
    try {
      const r = await send('Runtime.evaluate', { expression: exprArg, returnByValue: true, awaitPromise: true });
      exprResult = r.result && (r.result.value !== undefined ? r.result.value : r.result.description);
    } catch (e) { exprResult = 'EXPR ERR: ' + e.message; }
  }
  await new Promise((r) => setTimeout(r, postMs));

  let finalState = null;
  try {
    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify({href:location.href,body:(document.body?document.body.innerText:'').slice(0,300)})`,
      returnByValue: true,
    });
    finalState = JSON.parse(r.result.value);
  } catch (e) { finalState = { error: e.message }; }

  fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify({ url: rawUrl, exprResult, finalState, seen, saved }, null, 2), 'utf8');
  console.log('EXPR:', typeof exprResult === 'string' ? exprResult.slice(0, 1500) : JSON.stringify(exprResult));
  console.log('FINAL:', JSON.stringify(finalState).slice(0, 500));
  console.log('JSON RESPONSES:', saved.length);
  for (const s of saved) console.log('  ' + s.bytes + '\t' + s.file + '  <- ' + s.url.slice(0, 110));

  try { await req('GET', '/json/close/' + target.id); } catch {}
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
