/**
 * 页面探针：定位「页面打开了但一个业务请求都没发」的原因。
 *
 * 只做诊断，不落数据。对指定页面输出三样东西：
 *   1. 真实的 document.title 与可见正文（截断）
 *   2. iframe 数量与各自 src —— 生意参谋部分子应用挂在 iframe 里，
 *      如果请求由跨进程 iframe（OOPIF）发出，单 target 的 WebSocket 收不到
 *   3. 本次导航期间**全部** XHR / Fetch 的 URL（不做任何过滤），
 *      用来判断页面到底有没有发请求，还是发了但被过滤规则漏掉
 *
 * 用法
 *   node scripts/probe-page.mjs flow-overview
 *   node scripts/probe-page.mjs trade-detail --qs "dateType=day&dateRange=2026-10-18|2026-10-18"
 *   node scripts/probe-page.mjs flow-overview --wait 45000
 *
 * 前置：Edge 已带 --remote-debugging-port=9222（用 scripts/run-daily.ps1 起的那个即可）。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9222;
const BASE = 'https://sycm.taobao.com';

const PAGES = {
  'trade-detail':     '/fa/trade/detail',
  'trade-refund':     '/fa/refund/analysis',
  'flow-overview':    '/flow/monitor/overview',
  'flow-shopsource':  '/flow/monitor/shopsource/construction',
  'flow-itemsource':  '/flow/monitor/itemsource',
  'flow-visitor':     '/flow/visitor/analysis',
  'flow-keyword':     '/flow/monitor/keyword_assistant',
  'item-rank':        '/cc/item_rank',
  'item-archives':    '/cc/item_archives',
  'item-macro':       '/cc/macro_macro_monitor',
  'content-overview': '/xsite/contentanalysis/overview_new_v2',
  'content-live':     '/xsite/contentanalysis/lives/performance',
  'content-channel':  '/xsite/contentanalysis/recommend_analysis',
  'qos-core':         '/qos/service/core_monitor/new',
  'qos-experience':   '/qos/frame/cds/experience',
  'qos-performance':  '/qos/service/performance/new',
  'qos-refund':       '/qos/service/refund/monitor'
};

const argv = process.argv.slice(2);
const name = argv.find(a => !a.startsWith('-') && !a.includes('='));
const gi = key => { const i = argv.indexOf('--' + key); return i >= 0 ? argv[i + 1] : null; };
const WAIT = Number(gi('wait') || 45000);
const BOOT = Number(gi('boot') || 14000);
const QS = gi('qs') || 'dateType=recent30&dateRange=' + (gi('date') || '2026-10-19') + '%7C' + (gi('date') || '2026-10-19');

if (!name || !PAGES[name]){
  console.error('用法: node scripts/probe-page.mjs <页面名> [--qs ...] [--wait ms]\n可选: ' + Object.keys(PAGES).join(' / '));
  process.exit(1);
}

function req(method, p){
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, res => {
      let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout ' + p)));
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const url = BASE + PAGES[name] + '?' + QS;
  console.log('目标页面 ' + name);
  console.log('完整 URL ' + url + '\n');

  const created = await req('PUT', '/json/new?' + encodeURIComponent(BASE + '/'));
  const tab = JSON.parse(created.body);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  let send;
  const seen = [];

  ws.addEventListener('message', msg => {
    const m = JSON.parse(msg.data);
    if (m.id && pending.has(m.id)){
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Network.responseReceived'){
      const { response, type } = m.params;
      if (type === 'XHR' || type === 'Fetch'){
        seen.push({ status: response.status, url: (response.url || '').split('?')[0], len: (response.url || '').length });
      }
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
      setTimeout(() => { if (pending.has(mid)){ pending.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
    });
  };

  await send('Page.enable');
  await send('Network.enable');

  console.log('首页启动…');
  await sleep(BOOT);

  seen.length = 0;
  await send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}; 'go'`, returnByValue: true });
  await sleep(WAIT);

  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.title;
      const body = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim();
      const ifr = Array.from(document.querySelectorAll('iframe')).map(f => f.src || '(no src)');
      // 统计时间原件：判断页面最终按哪个区间取数（recent30 会把区间改写成 30 天）
      const m = body.match(/统计时间[^日周月]{0,40}/);
      return JSON.stringify({ title: t, href: location.href, bodyLen: body.length, statTime: m ? m[0] : '(未找到)',
                               body: body.slice(0, 700), iframes: ifr });
    })()`,
    returnByValue: true
  });

  const d = JSON.parse(probe.result.value);
  console.log('\n===== 页面状态 =====');
  console.log('title  : ' + d.title);
  console.log('href   : ' + d.href);
  console.log('统计时间: ' + d.statTime);
  console.log('正文长度: ' + d.bodyLen);
  console.log('正文    : ' + d.body);
  console.log('iframe  : ' + (d.iframes.length ? d.iframes.length + ' 个 -> ' + d.iframes.join(' , ') : '无'));

  console.log('\n===== 本次 XHR / Fetch（' + seen.length + ' 条，未过滤）=====');
  const byHost = new Map();
  for (const s of seen){
    let h = '(unknown)';
    try { h = new URL(s.url).host; } catch {}
    byHost.set(h, (byHost.get(h) || 0) + 1);
  }
  for (const [h, n] of byHost) console.log('  ' + h.padEnd(34) + n + ' 条');
  console.log('\n--- 业务域请求（/flow/ /fa/ /cc/ /qos/ /xsite/ /bda/ /csp/ /api/）---');
  const BIZ = /\/(flow|fa|cc|qos|xsite|bda|csp|api|ipoll)\//;
  const biz = seen.filter(s => BIZ.test(s.url));
  for (const s of biz) console.log('  ' + String(s.status).padEnd(4) + ' ' + s.url);
  if (!biz.length) console.log('  (无)');
  console.log('\n--- 其余全部（去重）---');
  const rest = [...new Set(seen.filter(s => !BIZ.test(s.url)).map(s => s.url.split('?')[0]))];
  for (const u of rest.slice(0, 40)) console.log('  ' + u);
  if (rest.length > 40) console.log('  ... 另有 ' + (rest.length - 40) + ' 条');

  try { await req('GET', '/json/close/' + tab.id); } catch {}
  try { ws.close(); } catch {}
  process.exit(0);
})();
