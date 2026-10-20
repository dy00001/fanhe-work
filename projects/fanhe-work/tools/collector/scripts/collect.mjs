import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 工作区根目录由脚本位置推导，U 盘盘符随电脑变化（E 或 F）时无需修改。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = 9222;
const BASE = 'https://sycm.taobao.com';
const OUT_ROOT = process.env.OUT_ROOT || path.join(ROOT, 'data', 'raw');
const WAIT = Number(process.env.WAIT || 40000);
// 例：DATE_QS="?dateType=recent30&dateRange=2026-09-19%7C2026-10-18"
const DATE_QS = process.env.DATE_QS || '';

const PAGES = [
  ['trade-detail', '/fa/trade/detail'],
  ['trade-refund', '/fa/refund/analysis'],
  ['flow-overview', '/flow/monitor/overview'],
  ['flow-shopsource', '/flow/monitor/shopsource/construction'],
  ['flow-itemsource', '/flow/monitor/itemsource'],
  ['flow-visitor', '/flow/visitor/analysis'],
  ['flow-keyword', '/flow/monitor/keyword_assistant'],
  ['item-rank', '/cc/item_rank'],
  ['item-archives', '/cc/item_archives'],
  ['item-macro', '/cc/macro_monitor'],
  ['content-overview', '/xsite/contentanalysis/overview_new_v2'],
  ['content-live', '/xsite/contentanalysis/lives/performance'],
  ['content-channel', '/xsite/contentanalysis/recommend_analysis'],
  ['qos-core', '/qos/service/core_monitor/new'],
  ['qos-experience', '/qos/frame/cds/experience'],
  ['qos-performance', '/qos/service/performance/new'],
  ['qos-refund', '/qos/service/refund/monitor'],
];

// 只保留业务数据接口，丢掉框架/鉴权/静态资源噪音
const NOISE = /oneauth\/|\/custom\/menu\/|g\.alicdn|\/portal\/water\/|\/portal\/common\/alias|umdcv4|helpcenter|everyhelp|everyservice|\/portal\/ai\/|\/portal\/coupon\/|\/portal\/live\/alarm|\/portal\/gmv\/rank|\/portal\/gamble\/|\/portal\/risk\/|\/datawar\/activityConfig|\/lyone\/|\/s_portal\/|\/mc\/ci\/|\/portal\/shop\/|getInstMappingRule|xux-web-config|qn-autolog|\.css|\.js(\?|$)/;
const DATA = /\/bda\/|\/cc\/|\/flow\/|\/qos\/|\/fa\/|\/xsite\/|\/ipoll\/|\/api\/|\/item\/|\/trade\//;

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

async function runPage(name, rawPath) {
  const urlPath = rawPath + (DATE_QS ? (rawPath.includes('?') ? '&' + DATE_QS.slice(1) : DATE_QS) : '');
  const outDir = path.join(OUT_ROOT, name);
  fs.mkdirSync(outDir, { recursive: true });
  const created = await req('PUT', '/json/new?' + encodeURIComponent(BASE + urlPath));
  let target;
  try { target = JSON.parse(created.body); } catch { console.log(`[${name}] target fail`); return null; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const byId = new Map();
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
      const u = response.url || '';
      if ((type === 'XHR' || type === 'Fetch') && u.includes('sycm.taobao.com') && DATA.test(u) && !NOISE.test(u)) {
        byId.set(requestId, { requestId, url: u, mime: response.mimeType, status: response.status });
      }
    }
    if (msg.method === 'Network.loadingFinished') {
      const rec = byId.get(msg.params.requestId);
      if (!rec || rec.done) return;
      rec.done = true;
      try {
        const body = await send('Network.getResponseBody', { requestId: rec.requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        if (!text || text.length < 30 || /^\s*</.test(text)) return;
        const base = (rec.url.split('?')[0].split('/').pop() || 'resp').replace(/[^\w.\-]/g, '_').slice(0, 50);
        const qs = (rec.url.split('?')[1] || '').replace(/[^\w=\-|]/g, '').slice(0, 40);
        const fp = path.join(outDir, `${String(saved.length + 1).padStart(2, '0')}_${base}_${qs}.json`);
        fs.writeFileSync(fp, text, 'utf8');
        saved.push({ file: path.basename(fp), url: rec.url, bytes: text.length });
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
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
    });
  };

  await send('Page.enable');
  await send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024 });
  await new Promise((r) => setTimeout(r, WAIT));

  let bodyText = '';
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(document.body?document.body.innerText:'').slice(0,200)`,
      returnByValue: true,
    });
    bodyText = r.result.value || '';
  } catch {}

  fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify({ page: name, url: BASE + urlPath, bodyHead: bodyText, saved }, null, 2), 'utf8');
  console.log(`[${name}] ${saved.length} 个数据接口`);
  for (const s of saved) console.log(`    ${s.bytes}\t${s.url.replace('https://sycm.taobao.com', '').slice(0, 120)}`);

  try { await req('GET', '/json/close/' + target.id); } catch {}
  try { ws.close(); } catch {}
  return saved.length;
}

async function main() {
  const only = process.argv[2];
  const list = only ? PAGES.filter((p) => p[0] === only) : PAGES;
  let total = 0;
  for (const [name, p] of list) {
    try { total += (await runPage(name, p)) || 0; } catch (e) { console.log(`[${name}] ERR ${e.message}`); }
  }
  console.log('TOTAL DATA APIS:', total);
  process.exit(0);
}
main();
