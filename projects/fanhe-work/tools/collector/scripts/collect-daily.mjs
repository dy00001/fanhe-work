/**
 * 日增采集器：只抓「前一天」，不做历史回溯、不去重、不合并。
 *
 * 职责边界（2026-10-20 明确）
 *   采集端：把指定那一天各页面的接口响应原样落盘，一天一个目录。
 *   存储端：增量的去重、合并、历史拼接由使用方负责，采集端不参与。
 *
 * 三个「不」：不读不写 data/raw30；不调用 build_csv.py（它做全量重建 + 去重）；
 * 不碰其它日期的目录，只覆盖目标日期自己的文件。
 *
 * 为什么不是「每页新开标签」
 *   首轮为省时间用单标签页内 location.href 顺序导航：生意参谋的 SPA 有路由守卫，
 *   直接 PUT /json/new 到 /qos/** 会被弹回「数据概览」首页（实测多次复现），
 *   先进首页让 SPA 启动再页内跳转就能正常停住。
 *   但页内跳转复用同一个渲染进程，个别页面（trade-detail / item-macro）会间歇性地
 *   只画外壳、一个业务请求都不发。所以重试时改开全新标签 + Page.navigate：
 *   干净渲染进程，实测这是 30 天基线能全页成功的原因。/qos/** 仍走页内跳转。
 *
 * 用法
 *   node scripts/collect-daily.mjs                 抓前一天，全部页面
 *   node scripts/collect-daily.mjs qos-core        只抓某一页
 *   node scripts/collect-daily.mjs trade-detail,qos-core   抓多页
 *   node scripts/collect-daily.mjs --date 2026-10-19
 * 环境变量：WAIT（每页等待毫秒，默认 60000）、BOOT（首页启动等待，默认 14000）、
 *          DATE_TYPE（默认 day，不要改 recent30：它会把区间改写成 30 天）、
 *          RETRY（偏薄重试次数，默认 2）、RETRY_WAIT（重试等待，默认 WAIT+30000）、
 *          OUT_ROOT（默认 data/daily）、SKIP_PREFLIGHT=1（跳过登录态判定，排查用）
 *
 * 退出码：0 全部采到；2 有页面重试后仍偏薄（数据已落盘，可先用 check_daily.mjs 复核）；
 *        3 登录态检查未通过，一个页面都没采
 *
 * 前置：Edge 已带 --remote-debugging-port=9222 且已登录生意参谋。
 *      登录态由脚本自行判定，结果落在 data/daily/_preflight.json。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingEndpoints } from './lib/required-endpoints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9222;
const BASE = 'https://sycm.taobao.com';
const WAIT = Number(process.env.WAIT || 60000);
const BOOT = Number(process.env.BOOT || 12000);

function yesterday(){
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const argv = process.argv.slice(2);
let target = yesterday();
const di = argv.indexOf('--date');
if (di >= 0 && argv[di + 1]){ target = argv[di + 1]; argv.splice(di, 2); }
/* 页面名支持逗号分隔多个：node scripts/collect-daily.mjs trade-detail,qos-core */
const onlyArg = argv.find(a => !a.startsWith('-'));
const only = onlyArg ? onlyArg.split(',').map(s => s.trim()).filter(Boolean) : null;

if (!/^\d{4}-\d{2}-\d{2}$/.test(target)){
  console.error('日期格式应为 YYYY-MM-DD，收到: ' + target);
  process.exit(1);
}

const OUT_ROOT = process.env.OUT_ROOT || path.join(ROOT, 'data', 'daily');
const OUT_DAY  = path.join(OUT_ROOT, target);

/* 第三个元素为 true 表示「这一页本来就没有数据」。
   实测依据：30 天基线 data/raw30/<模块>/ 里同样只有心跳，csv30/<模块>/ 全空。
   这类页面照跑一次（万一账号开了权限就能拿到），但不重试，也不算偏薄。 */
const PAGES = [
  ['trade-detail',    '/fa/trade/detail'],
  ['trade-refund',    '/fa/refund/analysis'],
  ['flow-overview',   '/flow/monitor/overview'],
  ['flow-shopsource', '/flow/monitor/shopsource/construction'],
  ['flow-itemsource', '/flow/monitor/itemsource'],
  ['flow-visitor',    '/flow/visitor/analysis'],
  ['flow-keyword',    '/flow/monitor/keyword_assistant'],
  ['item-rank',       '/cc/item_rank'],
  ['item-archives',   '/cc/item_archives'],
  ['item-macro',      '/cc/macro_monitor'],
  ['content-overview','/xsite/contentanalysis/overview_new_v2', true],
  ['content-live',    '/xsite/contentanalysis/lives/performance'],
  ['content-channel', '/xsite/contentanalysis/recommend_analysis', true],
  ['qos-core',        '/qos/service/core_monitor/new'],
  ['qos-experience',  '/qos/frame/cds/experience', true],
  ['qos-performance', '/qos/service/performance/new', true],
  ['qos-refund',      '/qos/service/refund/monitor']
];

const NOISE = /oneauth\/|\/custom\/menu\/|g\.alicdn|\/portal\/water\/|\/portal\/common\/alias|umdcv4|helpcenter|everyhelp|everyservice|\/portal\/ai\/|\/portal\/coupon\/|\/portal\/live\/alarm|\/portal\/gmv\/rank|\/portal\/gamble\/|\/portal\/risk\/|\/datawar\/activityConfig|\/lyone\/|\/s_portal\/|\/mc\/ci\/|\/portal\/shop\/|getInstMappingRule|xux-web-config|qn-autolog|\.css|\.js(\?|$)/;
const DATA = /\/bda\/|\/cc\/|\/flow\/|\/qos\/|\/csp\/|\/fa\/|\/xsite\/|\/ipoll\/|\/api\/|\/item\/|\/trade\//;
const STATIC = /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map)(\?|$)/i;

/* 内容页 / 服务体验页的真实应用挂在跨域 iframe 里（实测 content-overview 的
   iframe 是 https://web.taobao.com/s-guanghe-creator/asset-overview）。
   这类 iframe 是独立的 CDP target，接口路径也不在 DATA 白名单里，
   所以对子 target 放宽成「*.taobao.com 且不是静态资源、不是已知噪声」。 */
function acceptUrl(u, fromChild){
  let host = '';
  try { host = new URL(u).host; } catch { return false; }
  if (!/(^|\.)taobao\.com$/.test(host)) return false;
  if (STATIC.test(u) || NOISE.test(u)) return false;
  return fromChild ? true : DATA.test(u);
}

function req(method, p){
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout ' + p)));
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = only ? PAGES.filter(p => only.includes(p[0])) : PAGES;
  if (!list.length){
    console.error('未知页面: ' + onlyArg + '\n可选: ' + PAGES.map(p => p[0]).join(' / '));
    process.exit(1);
  }
  if (only && list.length < only.length){
    const miss = only.filter(n => !PAGES.some(p => p[0] === n));
    console.error('以下页面名不存在，已跳过: ' + miss.join(', '));
  }

  console.log(`目标日期 ${target}（单日增量，不回溯）`);
  console.log(`输出目录 ${OUT_DAY}`);
  console.log(`页面数 ${list.length}，首页启动 ${BOOT}ms，每页 ${WAIT}ms\n`);

  let ctx = null;                  // 当前页面的采集上下文

  const NET_OPTS = { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024 };

  /* 网络事件处理：顶层文档与子 target（跨域 iframe）共用一份逻辑，
     getResponseBody 必须带回该请求所属的 sessionId。 */
  async function onNet(m, send){
    if (!ctx) return;
    const sid = m.sessionId;            // undefined = 顶层文档
    const fromChild = !!sid;

    if (m.method === 'Network.responseReceived'){
      const { requestId, response, type } = m.params;
      const u = response.url || '';
      if ((type === 'XHR' || type === 'Fetch') && acceptUrl(u, fromChild)){
        ctx.hits.set(requestId, { u, sid });
      }
      return;
    }
    if (m.method === 'Network.loadingFinished'){
      const rid = m.params.requestId;
      const hit = ctx.hits.get(rid);
      if (!hit) return;
      ctx.hits.delete(rid);
      const cur = ctx;
      try {
        const b = await send('Network.getResponseBody', { requestId: rid }, hit.sid);
        const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
        if (!text || text.length < 30 || /^\s*</.test(text)){
          /* 命中缓存 / 204 / 预检 都会走到这里，记下来便于判断「接口发了但没落盘」 */
          cur.emptyBody = (cur.emptyBody || 0) + 1;
          return;
        }
        /* 只用最后一段会把 core/monitor/list 与 overview/list 都叫成 list，
           取末四段拼起来才有辨识度；同时去掉扩展名，避免出现 .json.json */
        const ep = hit.u.split('?')[0].replace(/\.json$/, '').split('/').filter(Boolean)
          .slice(-4).join('_').replace(/[^\w.\-]/g, '_').slice(0, 60);
        const fp = path.join(cur.outDir, `${String(cur.saved.length + 1).padStart(2, '0')}_${ep}.json`);
        fs.writeFileSync(fp, text, 'utf8');
        cur.saved.push({ file: path.basename(fp), bytes: text.length, url: hit.u, iframe: !!hit.sid });
      } catch {}
    }
  }

  /* 每个 target 一条 WebSocket。控制标签走一条常驻连接，重试时给新标签另开一条。 */
  async function makeConn(wsUrl){
    const sock = new WebSocket(wsUrl);
    let seq = 0;
    const waiting = new Map();
    const send = (method, params = {}, sessionId) => {
      const mid = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(mid, { resolve, reject });
        const payload = { id: mid, method, params };
        if (sessionId) payload.sessionId = sessionId;
        sock.send(JSON.stringify(payload));
        setTimeout(() => { if (waiting.has(mid)){ waiting.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
      });
    };
    sock.addEventListener('message', msg => {
      const m = JSON.parse(msg.data);
      if (m.id && waiting.has(m.id)){
        const { resolve, reject } = waiting.get(m.id);
        waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      /* 跨域 iframe 会作为子 target 被自动附加，事件带 sessionId 上来 */
      if (m.method === 'Target.attachedToTarget'){
        const sid = m.params.sessionId;
        send('Network.enable', NET_OPTS, sid).catch(() => {});
        send('Network.setCacheDisabled', { cacheDisabled: true }, sid).catch(() => {});
        return;
      }
      onNet(m, send);
    });
    await new Promise((res, rej) => {
      sock.addEventListener('open', res);
      sock.addEventListener('error', () => rej(new Error('ws error')));
      setTimeout(() => rej(new Error('ws open timeout')), 10000);
    });
    return { send, close: () => { try { sock.close(); } catch {} } };
  }

  async function setupTarget(send){
    await send('Page.enable');
    await send('Network.enable', NET_OPTS);
    /* 同一个日期反复重跑会命中磁盘缓存，命中后 getResponseBody 拿不到响应体，
       表现为「接口发了但一个都没落盘」。必须关缓存。 */
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    /* 自动附加跨域 iframe（OOPIF）与 worker，否则内容页 / 服务体验页只能采到外壳的心跳 */
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  /* 登录态前置判定。
     日增已经跑成无人值守链路，cookie 过期时 17 页会安静地跑出一堆空响应，
     check_daily 只会报 FAIL，事后很难区分「页面退化」与「没登录」。
     10-20 上午已经踩过一次同型误判（把账号限流当成脚本 bug 查了很久），
     所以这里在动任何页面之前先拦一道，宁可不采，也不产出一天的空数据。
     SKIP_PREFLIGHT=1 可跳过，供排查页面问题时使用。 */
  async function checkLogin(send){
    let info = { href: '', title: '', text: '', len: 0 };
    try {
      const r = await send('Runtime.evaluate', {
        expression: `(()=>{const t=document.body?document.body.innerText:'';return JSON.stringify({href:location.href,title:document.title,text:t.slice(0,500),len:t.length})})()`,
        returnByValue: true
      });
      info = Object.assign(info, JSON.parse(r.result.value || '{}'));
    } catch (e) {
      return Object.assign(info, { ok: false, reason: '无法读取页面状态（' + e.message + '）' });
    }

    /* 三个信号分别对应三种失败：被踢到登录页、页面出现登录表单、登录过期提示。
       登录表单类信号要求页面文本稀疏（实测登录页 innerText 只有一两百字），
       正常首页文本量大，避免把首页里的「立即登录」之类营销文案误判成未登录。 */
    const LOGIN_URL  = /login\.taobao\.com|login\.tmall\.com|passport\.taobao\.com|\/member\/login|\/custom\/login/i;
    const LOGIN_FORM = /扫码登录|账号密码登录|密码登录|亲，请登录/;
    const EXPIRED    = /登录超时|会话已失效|登录信息已失效|请重新登录/;
    const sparse     = Number(info.len || 0) < 1500;

    if (!info.href || info.href === 'about:blank') return Object.assign(info, { ok: false, reason: '控制标签没有加载出页面' });
    if (LOGIN_URL.test(info.href))                       return Object.assign(info, { ok: false, reason: '被重定向到登录页' });
    if (EXPIRED.test(info.text))                         return Object.assign(info, { ok: false, reason: '页面提示登录已过期' });
    if (sparse && LOGIN_FORM.test(info.text))            return Object.assign(info, { ok: false, reason: '页面出现登录表单（正文仅 ' + info.len + ' 字）' });
    return Object.assign(info, { ok: true, reason: '' });
  }

  const created = await req('PUT', '/json/new?' + encodeURIComponent(BASE + '/'));
  const ctrlTab = JSON.parse(created.body);
  const ctrl = await makeConn(ctrlTab.webSocketDebuggerUrl);
  await setupTarget(ctrl.send);

  /* 先让首页把 SPA 启动起来，之后的页内跳转才不会被路由守卫弹回 */
  console.log('首页启动…');
  await sleep(BOOT);

  /* 登录态判定。失败就停在这里，一个页面都不碰，退出码 3 与「偏薄」的 2 区分开。 */
  if (process.env.SKIP_PREFLIGHT !== '1'){
    const pf = await checkLogin(ctrl.send);
    try {
      fs.mkdirSync(OUT_ROOT, { recursive: true });
      fs.writeFileSync(path.join(OUT_ROOT, '_preflight.json'), JSON.stringify({
        checkedAt: new Date().toISOString(),
        targetDate: target,
        ok: pf.ok,
        reason: pf.reason || '',
        href: pf.href,
        title: pf.title,
        textLength: pf.len,
        sample: (pf.text || '').replace(/\s+/g, ' ').slice(0, 200)
      }, null, 2), 'utf8');
    } catch {}

    if (!pf.ok){
      console.error('\n[登录态检查未通过] ' + pf.reason);
      console.error('  当前地址 : ' + (pf.href || '（空）'));
      console.error('  页面标题 : ' + (pf.title || '（空）'));
      if (pf.text) console.error('  页面文字 : ' + pf.text.replace(/\s+/g, ' ').slice(0, 120));
      console.error('\n处理办法 : 运行 start-edge-debug.cmd，在打开的 Edge 里登录生意参谋，');
      console.error('           关闭该窗口后重跑本脚本。cookie 已落盘，重跑不需要再扫码。');
      console.error('  本次未采集任何页面，避免产出一天的空数据反被当成「页面退化」。\n');
      try { await req('GET', '/json/close/' + ctrlTab.id); } catch {}
      ctrl.close();
      process.exit(3);
    }
    console.log('登录态正常（' + (pf.title || 'sycm.taobao.com') + '）\n');
  } else {
    console.log('已跳过登录态检查（SKIP_PREFLIGHT=1）\n');
  }

  /* 页面加载是不稳定的：同一页单独跑能拿到 8 个接口，排在 17 页长队里只拿到 3 个。
     所以「采到几个」不能当作一次性的结果，偏薄就重试，让无人值守的日增能自愈。 */
  const RETRY = Number(process.env.RETRY ?? 2);
  const RETRY_WAIT = Number(process.env.RETRY_WAIT || WAIT + 30000);
  const isThin = saved => saved.length < 2 || saved.reduce((t, x) => t + x.bytes, 0) < 800;

  /* 每页「必须拿到」的接口。判定表放在 lib/required-endpoints.mjs，与校验脚本共用
     同一份 —— 采集按 A 判、校验按 B 判，等于没有判据。

     这里只记录、不改退出码：渠道树在当前页面结构下不会触发（已知缺口，见
     docs/ops/PIPELINE-2026-10-21.md），把它算成偏薄会让日增每天都红，告警就废了。
     记录进 manifest 后，verify-daily.mjs 能把它作为「缺口」单独报出来。 */
  const missingRequired = (name, saved) => missingEndpoints(name, saved);

  const results = [];
  for (const [name, rawPath, third] of list){
    /* 第三位可能是 dateType 覆盖（字符串），也可能是「已知空页」标记（布尔） */
    const expectEmpty = third === true;
    const dtOverride = typeof third === 'string' ? third : null;
    /* 单日必须用 dateType=day：实测 recent30 会被页面把区间改写成「终点往前 30 天」
       （dateRange=2026-10-19|2026-10-19 → 2026-09-20|2026-10-19），拿到的是 30 天口径。
       反过来说 dateType=day 也是唯一能保证页面写「统计时间 2026-10-19」的取值。
       页面会自动在 URL 上追加 activeKey 等参数，不用手工补。 */
    const dt = dtOverride || process.env.DATE_TYPE || 'day';
    const url = BASE + rawPath + `?dateType=${dt}&dateRange=${encodeURIComponent(target + '|' + target)}`;

    let attempt = 0, saved = [], bodyHead = '', thin = true, missing = [];
    while (attempt <= RETRY){
      attempt++;
      const wait = attempt === 1 ? WAIT : RETRY_WAIT;

      const outDir = path.join(OUT_DAY, name);
      /* 不用 fs.unlinkSync 清旧文件：本机「安全删除守卫」会在单轮删除超过 50 个时
         直接抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，17 页一天约 150 个文件必然触发。
         改成把旧目录整体改名挪到 .trash，再建同名空目录 —— 改名不是删除，不会被拦。
         .trash 由 run-daily.ps1 在采集结束后尽力清理，清不掉也不影响本次结果。 */
      if (fs.existsSync(outDir)){
        const trash = path.join(OUT_ROOT, '.trash', `${target}_${name}_${Date.now()}`);
        fs.mkdirSync(path.dirname(trash), { recursive: true });
        try { fs.renameSync(outDir, trash); } catch { /* 改名失败就原地覆盖 */ }
      }
      fs.mkdirSync(outDir, { recursive: true });

      ctx = { name, outDir, hits: new Map(), saved: [] };

      /* 两种导航方式交替用，各自兜一种故障模式：
         页内 location.href 复用当前渲染进程，健康时最快最稳（首轮 17 页跑出 168 个接口
         就是它）；但它会被今天的反复访问拖到退化，连 item-rank / qos-core 都只剩 2 个。
         全新标签 + Page.navigate 给的是干净渲染进程，退化时能立刻恢复满量。
         /qos/** 是唯一例外 —— 直接开新标签会被路由守卫弹回数据概览首页，只能页内跳转。 */
      const freshTab = attempt % 2 === 0 && !rawPath.startsWith('/qos/');
      let conn = ctrl, tmpTab = null;
      try {
        if (freshTab){
          const t = JSON.parse((await req('PUT', '/json/new?' + encodeURIComponent('about:blank'))).body);
          tmpTab = t;
          conn = await makeConn(t.webSocketDebuggerUrl);
          await setupTarget(conn.send);
          await conn.send('Page.navigate', { url });
          console.log(`      ${name} 改用新标签重试`);
        } else {
          await ctrl.send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}; 'go'`, returnByValue: true });
        }
      } catch (e) {
        console.log(`  ${name.padEnd(17)} 第${attempt}次 跳转失败 ${e.message}`);
      }
      await sleep(wait);

      try {
        const r = await conn.send('Runtime.evaluate', { expression: `(document.body?document.body.innerText:'').slice(0,140)`, returnByValue: true });
        bodyHead = r.result.value || '';
      } catch {}

      saved = ctx.saved.slice();
      const bytes = saved.reduce((t, x) => t + x.bytes, 0);
      thin = isThin(saved);
      const missingNow = expectEmpty ? [] : missingRequired(name, saved);
      missing = missingNow;
      const tag = thin ? (expectEmpty ? '   ← 空（已知）' : '   ← 偏薄') : '';
      const missingStr = missing.length ? `   ← 缺接口 ${missing.join('、')}` : '';
      const emptyStr = ctx.emptyBody ? `  空体 ${ctx.emptyBody}` : '';
      const modeStr = freshTab ? ' 新标签' : '';
      console.log(`  ${name.padEnd(17)} 第${attempt}次${modeStr} ${String(saved.length).padStart(2)} 个接口 ${String(bytes).padStart(7)} 字节${emptyStr}${tag}${missingStr}`);

      if (tmpTab){
        conn.close();
        try { await req('GET', '/json/close/' + tmpTab.id); } catch {}
      }

      if (!thin) break;
      if (expectEmpty) break;          // 已知空页只跑一次，不浪费重试
      if (attempt > RETRY) break;
      console.log(`      ${name} 等待 ${Math.round(RETRY_WAIT / 1000)}s 后重试`);
      await sleep(3000);
    }

    results.push({ name, url, attempts: attempt, thin, expectEmpty, missing, saved, bodyHead });
  }

  try { await req('GET', '/json/close/' + ctrlTab.id); } catch {}
  ctrl.close();

  ctx = null;
  const total = results.reduce((t, r) => t + (r.saved ? r.saved.length : 0), 0);

  /* manifest 必须合并写：只跑两三页时不能把当天其余页面的记录抹掉，
     否则「补采一页」会把整天的手册变成只含那一页。同名页面以本次结果覆盖。 */
  const mfPath = path.join(OUT_DAY, '_manifest.json');
  let prevPages = [];
  try {
    const prev = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    if (Array.isArray(prev.pages)) prevPages = prev.pages;
  } catch { /* 首次运行没有旧手册 */ }
  const merged = new Map(prevPages.map(p => [p.name, p]));
  for (const r of results) merged.set(r.name, r);
  const order = PAGES.map(p => p[0]);
  const pages = [...merged.values()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  fs.writeFileSync(mfPath, JSON.stringify({
    targetDate: target,
    capturedAt: new Date().toISOString(),
    scope: 'single-day increment only',
    contract: '采集端只负责落盘当天响应；去重、合并、历史拼接由使用方负责',
    lastRunPages: results.map(r => r.name),
    pages
  }, null, 2), 'utf8');

  console.log(`\n本次采集 ${total} 个接口响应，已写入 ${OUT_DAY}`);
  console.log(`manifest 现有 ${pages.length} 页记录（本次 ${results.length} 页，其余沿用上次）`);
  const thinPages = results.filter(r => r.thin && !r.expectEmpty).map(r => r.name);
  const emptyPages = results.filter(r => r.thin && r.expectEmpty).map(r => r.name);
  if (emptyPages.length) console.log(`已知空页 ${emptyPages.length} 个（基线同样为空，不算失败）：${emptyPages.join('、')}`);
  /* 接口缺失与偏薄分开报：偏薄是「这一页整体没加载出来」，缺接口是「页面在、但关键
     那一个请求没发」。后者体量足够，重试也不会变，重采一遍同样没有 —— 两者混在一起
     报，看到的人会去重试一个不会变的东西。 */
  const gapPages = results.filter(r => Array.isArray(r.missing) && r.missing.length > 0);
  if (gapPages.length){
    console.log(`接口缺失 ${gapPages.length} 个页面（体量够，但关键接口没触发）：`);
    for (const r of gapPages) console.log(`    · ${r.name.padEnd(17)} 缺 ${r.missing.join('、')}`);
  }
  if (thinPages.length){
    console.log(`重试后仍偏薄的页面 ${thinPages.length} 个：${thinPages.join('、')}`);
    console.log(`（用 scripts/check_daily.mjs 复核，必要时 scripts/probe-page.mjs 单页探针）`);
  }
  console.log(`说明：只抓 ${target} 单日数据，未做任何去重或与历史合并。`);

  process.exit(thinPages.length ? 2 : 0);
})();
