/**
 * 大屏切店一致性检查（回归门禁）
 *
 * 背景：大屏 #/screen 是「五店总览」，切店只应移动高亮，不应改变任何数字。
 * 之前主店卡读的是全局 SER（= 当前高亮店），切到分店 4 后主店卡从 108,000
 * 掉到 43,200，页脚五店合计从 199,800 掉到 135,000。本脚本把这类回归卡住。
 *
 * 做法：把 preview/ops-dashboard-preview.html 里的内联脚本抽出来，给
 * document / window / location / history 打桩，然后在 Node 里直接调用
 * pageOverview / metricsFor / quotaInfo / storeSeries 等纯函数断言。
 *
 * 用法：node scripts/check_store_switch.mjs
 * 退出码：0 全过，1 有失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 工作区根目录由脚本位置推导，U 盘盘符变化时无需修改。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'preview', 'ops-dashboard-preview.html');

const source = fs.readFileSync(HTML, 'utf8');
const inline = source.match(/<script>([\s\S]*)<\/script>/);
if (!inline) {
  console.error('未找到内联 <script>，页面结构变了？');
  process.exit(1);
}
const script = inline[1];
// 只取到浮层提示之前：后面是真实 DOM 绑定与启动渲染，跑不了也不需要。
const cut = script.indexOf('const gtip');
if (cut < 0) {
  console.error('未找到切分点 "const gtip"，页面结构变了？');
  process.exit(1);
}
const core = script.slice(0, cut);

const stub = `
const __el = () => ({
  classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
  setAttribute(){}, addEventListener(){}, style: {}, innerHTML: '', scrollTop: 0, textContent: ''
});
globalThis.document = { getElementById: __el, createElement: __el, addEventListener(){}, querySelectorAll: () => [], body: { appendChild(){} } };
globalThis.window = { addEventListener(){}, innerWidth: 1680 };
globalThis.location = { hash: '#/screen' };
globalThis.history = { replaceState(){} };
`;

const assertions = `
const A = ['2026-09-19', '2026-10-18'];
const stOf = (id, route) => ({ route: route || 'screen', g: 'day', p: '30d', a: A, b: A, s: id, cmp: false, q: 80000 });
const results = [];
const ok = (name, cond, extra) => results.push({ name, cond: !!cond, extra: extra || '' });

/* ① 大屏 5 个 s 值下，除高亮 / 页头文案 / 链接参数外 HTML 完全一致 */
const norm = h => h
  .replace(/<div class="store ?(on)?"/g, '<div class="store"')
  .replace(/ class="cur"/g, ' class=""')
  .replace(/aria-selected="(true|false)"/g, 'aria-selected="X"')
  .replace(/&s=\\w+/g, '&s=X')
  .replace(/当前高亮 [^<\\n]+/, '当前高亮 X')
  /* 折线图是单店视图，会随店铺变化，剔除后再比较其余五店口径区块 */
  .replace(/<div class="card chart-card">[\\s\\S]*?<div class="mod-grid">/g, '<div class="mod-grid">');
const htmls = STORES.map(s => norm(pageOverview(stOf(s.id))));
ok('大屏 5 个 s 值输出一致（只差高亮 / 文案）', htmls.every(h => h === htmls[0]));

/* ② 任意聚焦下，主店卡恒 108,000、页脚五店合计恒 199,800 */
let cardOk = true, cardDetail = [];
for (const focus of STORES){
  SER = storeSeries(focus);
  const h = pageOverview(stOf(focus.id));
  const mainAmt = (h.match(/梵禾美学全屋定制家具<\\/span>\\s*<span class="store-flag real">真实<\\/span>[\\s\\S]*?<div class="store-amt"><small>¥<\\/small>([\\d,]+)/) || [])[1];
  const foot = (h.match(/5 店合计支付金额 <b>¥([\\d,]+)<\\/b>/) || [])[1];
  if (mainAmt !== '108,000' || foot !== '199,800') cardOk = false;
  cardDetail.push('focus=' + focus.id + ' 主店卡=' + mainAmt + ' 页脚=' + foot);
}
ok('任意聚焦下主店卡恒 108,000、页脚恒 199,800', cardOk, cardDetail.join(' | '));

/* ③ 大屏折线图：四条曲线 + 图例勾选 + 随区间联动
   （原「五店合计堆叠」2026-10-20 移入抽屉 openStackTrend，相关断言随之改写） */
const mainDash = pageOverview(stOf('main'));
const dashHtml = pageOverview(stOf('s4'));
const nLines = (dashHtml.match(/class="line"/g) || []).length;
const nItems = (dashHtml.match(/class="lg-item/g) || []).length;
ok('大屏折线图默认画四条曲线', nLines === 4, '实测 ' + nLines);
ok('图例提供四个勾选项', nItems === 4, '实测 ' + nItems);
ok('主店折线图 tooltip 含当日真值', mainDash.includes('¥49,000') && mainDash.includes('10.20%'));
const oneOn = pageOverview(Object.assign(stOf('s4'), { ls: ['amt'] }));
ok('只勾选支付金额时只画一条曲线', (oneOn.match(/class="line"/g) || []).length === 1,
   '实测 ' + (oneOn.match(/class="line"/g) || []).length);
const noneOn = pageOverview(Object.assign(stOf('s4'), { ls: [] }));
ok('全不勾选时不画曲线并给出提示', !/class="line"/.test(noneOn) && noneOn.includes('未选择指标'));
const n30 = (dashHtml.match(/class="hit"/g) || []).length;
const week7 = pageOverview(Object.assign(stOf('s4'), { a: ['2026-10-12','2026-10-18'], b: ['2026-10-12','2026-10-18'] }));
const n7 = (week7.match(/class="hit"/g) || []).length;
ok('折线图数据点随区间变化', n30 === 30 && n7 === 7, '30 天=' + n30 + ' 7 天=' + n7);
ok('主店折线图区间合计与其他页同源', mainDash.includes('¥108,000') && mainDash.includes('3,890'));

/* ③b 折线图必须跟随店铺切换（此前 trendRows 直接读 DAILY，切店后曲线一条不动） */
ok('折线图随店铺变化', dashHtml !== mainDash);
ok('分店 4 折线图展示该店金额与访客', dashHtml.includes('¥43,200') && dashHtml.includes('1,556'),
   '金额 43,200 / 访客 1,556');
const s2Dash = pageOverview(stOf('s2'));
ok('不同分店折线图各自不同', s2Dash !== dashHtml && s2Dash.includes('¥23,760'));
ok('分店折线图带「演示」小标', /scope-tag">演示</.test(dashHtml));
ok('主店折线图带「真实」小标', /scope-tag">真实</.test(mainDash));
const tr4 = trendRows('2026-09-19', '2026-10-18', 'day', storeOf('s4'));
ok('分店 4 折线图金额合计 == 该店交易金额', tr4.reduce((t,r) => t + r.amt, 0) === 43200,
   String(tr4.reduce((t,r) => t + r.amt, 0)));
const trM = trendRows('2026-09-19', '2026-10-18', 'day', storeOf('main'));
const rate4 = tr4.reduce((t,r) => t + r.byr, 0) / tr4.reduce((t,r) => t + r.uv, 0);
const rateM = trM.reduce((t,r) => t + r.byr, 0) / trM.reduce((t,r) => t + r.uv, 0);
ok('分店折线图转化率与主店同量级（倍率不改变比率）',
   Math.abs(rate4 - rateM) < 0.0015, '分店=' + (rate4*100).toFixed(2) + '% 主店=' + (rateM*100).toFixed(2) + '%');
/* 最大余数法：分店各日访客 / 买家合计必须严格等于 round(逐日总量 × 倍率)，
   逐日 Math.round 会把 92×0.09 的 8 人摊成 1 人（实测） */
let allocOk = true, allocDetail = [];
const dSumUv  = DAILY_FLOW.reduce((t,r) => t + r.uv, 0);
const dSumByr = DAILY_FLOW.reduce((t,r) => t + r.byr, 0);
for (const st2 of STORES.filter(x => !x.real)){
  const rows = trendRows('2026-09-19', '2026-10-18', 'day', st2);
  const uv = rows.reduce((t,r) => t + r.uv, 0);
  const by = rows.reduce((t,r) => t + r.byr, 0);
  const wantUv = Math.round(dSumUv * st2.ratio), wantBy = Math.round(dSumByr * st2.ratio);
  if (uv !== wantUv || by !== wantBy){
    allocOk = false;
    allocDetail.push(st2.id + ' 访客' + uv + '/' + wantUv + ' 买家' + by + '/' + wantBy);
  }
}
ok('分店折线图按最大余数法分配，合计不掉数', allocOk, allocDetail.join(' '));

/* ③c 店铺卡直接展示买家与访客，跨店对比表已移除，折线图占整行 */
/* 用 split 计数而不用正则，避免模板字符串吃掉反斜杠导致正则提前闭合 */
/* 只在店铺卡区域里数，折线图页脚也有「买家 <b>/访客 <b>」，会把计数带偏 */
const stripHtml = mainDash.slice(mainDash.indexOf('store-strip'), mainDash.indexOf('risk-row'));
const cardByr = stripHtml.split('买家 <b>').length - 1;
const cardUv  = stripHtml.split('访客 <b>').length - 1;
ok('五张店铺卡都显示买家数与访客数', cardByr === 5 && cardUv === 5, '买家 ' + cardByr + ' / 访客 ' + cardUv);
ok('跨店对比表已移除', !mainDash.includes('跨店对比'));
ok('折线图 viewBox 已按整行拉宽', mainDash.includes('viewBox="0 0 1000 250"'));
const oneDay = pageOverview({ route:'screen', g:'day', p:'d1', a:['2026-10-15','2026-10-15'], b:['2026-10-15','2026-10-15'], s:'main', cmp:false, q:80000 });
ok('单日只有一个点时压缩画布高度',
   oneDay.includes('viewBox="0 0 1000 140"') && oneDay.includes('单日只有一个数据点'));
ok('店铺卡口径标记随区间切换',
   mainDash.includes('store-flag real">真实<') && oneDay.includes('store-flag ">演示·折算<'));

/* ④ 大屏模块卡不再出现单店金额，主店专属指标带作用域标 */
ok('大屏模块卡为五店口径', /五店合计/.test(dashHtml) && !/支付金额<\\/span><b>¥43,200/.test(dashHtml));
ok('风险条与主店指标带「主店」小标', (dashHtml.match(/scope-tag">主店</g) || []).length >= 8, 'count=' + (dashHtml.match(/scope-tag">主店</g) || []).length);

/* ⑤ 限额抽屉：逐日表终值 == 头部本月累计 */
let quotaOk = true, quotaDetail = [];
for (const s of STORES){
  SER = storeSeries(s);
  if (!s.real) pushDemoStore(s);
  const q = quotaInfo(stOf(s.id, 'trade'), '2026-10-18');
  const tableSum = SER.filter(r => r.d.slice(0, 7) === q.mKey).reduce((t, r) => t + r.amt, 0);
  if (tableSum !== q.cum){ quotaOk = false; quotaDetail.push(s.id + ':' + tableSum + '≠' + q.cum); }
  if (!s.real) popDemoStore();
}
ok('限额抽屉表格终值 == 头部累计', quotaOk, quotaDetail.join(' '));

/* ⑥ 同店同区间：交易页金额 == 商品页金额 */
let amtOk = true, amtDetail = [];
for (const s of STORES){
  SER = storeSeries(s);
  const trade = metrics(A[0], A[1]).amt;
  if (!s.real) pushDemoStore(s);
  const item = ITEMS.reduce((t, x) => t + x.amt, 0);
  if (!s.real) popDemoStore();
  if (trade !== item){ amtOk = false; amtDetail.push(s.id + ':' + trade + '≠' + item); }
}
ok('交易页金额 == 商品页金额', amtOk, amtDetail.join(' '));

/* ⑦ 流量三项恒等于全店访客 */
let flowOk = true, flowDetail = [];
for (const s of STORES){
  if (!s.real) pushDemoStore(s);
  const sum = FLOW_SPLIT.rec + FLOW_SPLIT.search + flowOther();
  if (sum !== AGG.uv.v){ flowOk = false; flowDetail.push(s.id + ':' + sum + '≠' + AGG.uv.v); }
  if (!s.real) popDemoStore();
}
ok('推荐 + 搜索 + 其他 == 全店访客', flowOk, flowDetail.join(' '));

/* ⑧ 分店序列合计 == 108,000 × ratio */
let serOk = true, serDetail = [];
for (const s of STORES.filter(x => !x.real)){
  const sum = storeSeries(s).reduce((t, r) => t + r.amt, 0);
  const target = Math.round(108000 * s.ratio);
  if (sum !== target){ serOk = false; serDetail.push(s.id + ':' + sum + '≠' + target); }
}
ok('分店序列合计 == 108,000 × ratio', serOk, serDetail.join(' '));

/* ⑨ 快照栈：二次 push / pop 后常量完全还原 */
const snapOf = () => JSON.stringify({ uv: AGG.uv.v, items: ITEMS.reduce((t, x) => t + x.amt, 0), rec: FLOW_SPLIT.rec });
const before = snapOf();
pushDemoStore(storeOf('s4')); pushDemoStore(storeOf('s3'));
popDemoStore(); popDemoStore();
ok('二次 push / pop 后常量完全还原', before === snapOf(), snapOf());

/* ⑩ 分店日峰值不超过主店峰值 */
const mainMax = Math.max(...DAILY.map(r => r.amt));
ok('分店日峰值不超过主店峰值', STORES.filter(x => !x.real).every(s => Math.max(...storeSeries(s).map(r => r.amt)) <= mainMax));

/* ⑪ 服务体验页：计数类严格 = 主店 × ratio（不得二次缩放） */
const svcOf = id => pageService(Object.assign(stOf(id), { route: 'service' }));
const svcCnt = h => {
  const m = h.match(/咨询数量[\\s\\S]*?kpi-value">([\\d,]+)</);
  return m ? Number(m[1].replace(/,/g, '')) : NaN;
};
let svcOk = true, svcDetail = [];
for (const s of STORES){
  const got = svcCnt(svcOf(s.id));
  const want = s.real ? 216 : Math.round(216 * s.ratio);
  if (got !== want){ svcOk = false; svcDetail.push(s.id + ':' + got + '≠' + want); }
}
ok('服务页咨询量 == 216 × ratio（无二次缩放）', svcOk, svcDetail.join(' '));

/* ⑫ 服务页：KPI 与「各店服务指标」表格里当前店那一行一致 */
let svcRowOk = true, svcRowDetail = [];
for (const s of STORES){
  const h = svcOf(s.id);
  const row = (h.match(/<tr data-set="s=\\w+" class="cur">([\\s\\S]*?)<\\/tr>/) || [])[1] || '';
  const cntCell = (row.match(/<td>([\\d,]+)<\\/td>/g) || [])[0] || '';
  const rowCnt = Number((cntCell.match(/[\\d,]+/) || [''])[0].replace(/,/g, ''));
  const kpi = svcCnt(h);
  if (!(rowCnt === kpi)){ svcRowOk = false; svcRowDetail.push(s.id + ' 表' + rowCnt + '≠卡' + kpi); }
}
ok('服务页 KPI 与各店表格当前行一致', svcRowOk, svcRowDetail.join(' '));

/* ⑬ 服务页：分店不得展示主店工单文案 */
let tkOk = true, tkDetail = [];
for (const s of STORES){
  const h = svcOf(s.id);
  const hasMainTicket = h.includes('主推橱柜链接缺少');
  if (s.real && !hasMainTicket){ tkOk = false; tkDetail.push('main 丢了工单'); }
  if (!s.real && hasMainTicket){ tkOk = false; tkDetail.push(s.id + ' 混入主店工单'); }
}
ok('待处理区按店铺区分（分店不展示主店工单）', tkOk, tkDetail.join(' '));

/* ⑭ 服务 / 推广 / 内容三页不再渲染假的区间控件 */
const noDate = ['service', 'ads', 'content'].every(r => {
  const fn = { service: pageService, ads: pageAds, content: pageContent }[r];
  const h = fn(Object.assign(stOf('main'), { route: r }));
  return !/data-date=/.test(h) && /30 天整段快照/.test(h);
});
ok('服务 / 推广 / 内容三页改为快照条，无区间输入', noDate);

/* ⑮ 大屏（不缩放）主店风险条与服务页主店 KPI 对齐 */
SER = DAILY;
const dashMain = pageOverview(Object.assign(stOf('main'), { route: 'screen' }));
const dashWait = (dashMain.match(/评价待回复[\\s\\S]*?<b class="rv">(\\d+) 条/) || [])[1];
const svcWait = (svcOf('main').match(/评价待商家回复[\\s\\S]*?kpi-value">(\\d+)/) || [])[1];
ok('大屏主店待回复 == 服务页主店待回复', dashWait === svcWait && dashWait === '5', '大屏=' + dashWait + ' 服务页=' + svcWait);

/* ⑯ 演示店退款金额跟随倍率，且隐含退款率与标称自洽 */
let rfOk = true, rfDetail = [];
for (const s of STORES){
  SER = storeSeries(s);
  if (!s.real) pushDemoStore(s);
  pageTrade(Object.assign(stOf(s.id), { route: 'trade' }));
  const want = s.real ? 500 : Math.max(1, Math.round(500 * s.ratio));
  const implied = REFUND.amt / AGG.payAmt.v;
  const drift = Math.abs(implied - REFUND.amtRate);
  if (REFUND.amt !== want || drift > 0.0001){
    rfOk = false;
    rfDetail.push(s.id + ' amt=' + REFUND.amt + '≠' + want + ' 隐含率偏差=' + drift.toFixed(4));
  }
  if (!s.real) popDemoStore();
}
ok('演示店退款金额 == 500 × ratio，且隐含退款率自洽', rfOk, rfDetail.join(' '));

/* ⑰ 对比基线恒在 A 之前，不与 A 重叠；历史不足时返回 null */
const FULL = ['2026-09-19', '2026-10-18'];
const dbFull = defaultB(FULL);
ok('全段区间无等长历史时 defaultB 返回 null', dbFull === null, String(dbFull));
const db7 = defaultB(['2026-10-12', '2026-10-18']);
ok('近 7 天默认基线为紧邻的等长区间', !!db7 && db7[0] === '2026-10-05' && db7[1] === '2026-10-11', db7 ? db7.join(' ~ ') : 'null');
let ovOk = true, ovDetail = [];
for (const [s1, s2] of [['2026-09-25','2026-10-04'], ['2026-10-01','2026-10-10'], ['2026-09-19','2026-10-18'], ['2026-10-05','2026-10-18']]){
  const r = defaultB([s1, s2]);
  if (r && !(r[1] < s1)){ ovOk = false; ovDetail.push(s1 + '~' + s2 + ' → ' + r.join('~')); }
}
ok('defaultB 结果恒在 A 之前（不重叠）', ovOk, ovDetail.join(' '));

/* ⑱ metricsFor 不因处于缩放态而二次乘 ratio */
const s4x = storeOf('s4');
const plain = metricsFor(s4x, FULL[0], FULL[1]);
pushDemoStore(s4x);
const scaled = metricsFor(s4x, FULL[0], FULL[1]);
popDemoStore();
ok('metricsFor 缩放态与未缩放态一致（无 ratio²）', plain.byr === scaled.byr && plain.uv === scaled.uv,
   '未缩放 byr=' + plain.byr + ' uv=' + plain.uv + ' / 缩放态 byr=' + scaled.byr + ' uv=' + scaled.uv);

/* ⑲ 客单价不随店铺规模缩放 */
const pctBefore = AGG.payPct.v;
pushDemoStore(s4x);
const pctDuring = AGG.payPct.v;
popDemoStore();
ok('客单价 AGG.payPct 不参与缩放', pctBefore === pctDuring, 'before=' + pctBefore + ' during=' + pctDuring);

/* ⑳ 无可比基线时交易页渲染说明，不抛异常 */
let nullOk = true, nullMsg = '';
try {
  SER = DAILY;
  const h = pageTrade({ route: 'trade', g: 'day', p: '30d', a: FULL, b: null, s: 'main', cmp: true, q: 80000 });
  nullOk = h.includes('无法自动取对比基线') && !h.includes('页面渲染失败');
  nullMsg = nullOk ? 'ok' : '缺少说明文案';
} catch (e) { nullOk = false; nullMsg = e.message; }
ok('对比模式无可比基线时渲染说明而非报错', nullOk, nullMsg);

/* ㉑ 流量页数量链：推荐 + 搜索 + 其他 == 全店访客（逐区间） */
SER = DAILY;
const FLOW_CASES = [
  ['2026-09-19', '2026-10-18'],
  ['2026-10-12', '2026-10-18'],
  ['2026-10-15', '2026-10-15'],
  ['2026-09-19', '2026-09-30'],
  ['2026-10-01', '2026-10-05']
];
let fChain = true, fDetail = [];
for (const [a, b] of FLOW_CASES){
  const F = flowMetrics(a, b);
  if (F.rec + F.search + F.other !== F.uv){
    fChain = false;
    fDetail.push(a + '~' + b + ' 三项和' + (F.rec + F.search + F.other) + '≠全店' + F.uv);
  }
  if (F.itmUv > F.uv){ fChain = false; fDetail.push(a + '~' + b + ' 商品访客超全店'); }
}
ok('流量页 5 个区间数量链恒等，商品访客不超全店', fChain, fDetail.join(' '));

/* ㉒ 流量页 30 天整段必须与接口原值逐位一致 */
const FFULL = flowMetrics('2026-09-19', '2026-10-18');
const fSame = FFULL.uv === 3890 && FFULL.itmUv === 3241 && FFULL.pv === 6891 &&
              FFULL.rec === 2721 && FFULL.search === 468 && FFULL.other === 701 &&
              Math.abs(FFULL.uvValue - 27.763496143958868) < 1e-9;
ok('流量页 30 天整段与接口原值逐位一致', fSame,
   'uv=' + FFULL.uv + ' itmUv=' + FFULL.itmUv + ' pv=' + FFULL.pv + ' other=' + FFULL.other + ' uvValue=' + FFULL.uvValue);

/* ㉓ 流量页 HTML 必须随区间变化（此前的缺陷：时间条可点但数字全不动） */
const fHtml = FLOW_CASES.map(([a, b]) => pageFlow({
  route: 'flow', g: 'day', p: 'custom', a: [a, b], b: [a, b], s: 'main', cmp: false, q: 80000
}));
const fUniq = new Set(fHtml).size;
ok('流量页 5 个区间渲染出 5 份不同 HTML', fUniq === FLOW_CASES.length, '实际 ' + fUniq + ' 份');
ok('流量页整段与非整段的口径文案不同',
   fHtml[0].includes('30 天接口原值') && fHtml[1].includes('访客为逐日真值') && !fHtml[0].includes('访客为逐日真值'));

/* ㉔ 流量页分店 4 同样折算且恒等 */
const fS4 = storeOf('s4');
SER = storeSeries(fS4);
pushDemoStore(fS4);
const F4 = flowMetrics('2026-10-12', '2026-10-18');
const f4ok = F4.rec + F4.search + F4.other === F4.uv;
popDemoStore();
SER = DAILY;
ok('流量页分店 4 折算后数量链恒等', f4ok, 'uv=' + F4.uv + ' 三项和=' + (F4.rec + F4.search + F4.other));

/* ㉕ 流量页整段类与固定口径块不随区间变 */
const fA = pageFlow({ route: 'flow', g: 'day', p: 'custom', a: ['2026-09-19','2026-10-18'], b: ['2026-09-19','2026-10-18'], s: 'main', cmp: false, q: 80000 });
const fB = pageFlow({ route: 'flow', g: 'day', p: 'custom', a: ['2026-10-12','2026-10-18'], b: ['2026-10-12','2026-10-18'], s: 'main', cmp: false, q: 80000 });
ok('流量页跳失率与平均停留不随区间变',
   fA.includes('69.9%') && fB.includes('69.9%') && fA.includes('14.2<small>s</small>') && fB.includes('14.2<small>s</small>'));
ok('流量页地域与搜索词标注不随区间变',
   fA.includes('最近 1 天样本 · 不随区间变') && fB.includes('最近 1 天样本 · 不随区间变') &&
   fA.includes('30 天词表 · 不随区间变') && fB.includes('30 天词表 · 不随区间变'));


/* ㉖ 单日买家 / 访客取逐日真值，不做任何折算 */
SER = DAILY;
const ONE = ['2026-10-15', '2026-10-15'];
const day1 = metrics(ONE[0], ONE[1]);
const flow1 = DAILY_FLOW.find(r => r.d === '2026-10-15');
ok('单日买家 / 访客 == 抓取真值',
   day1.basis === 'daily' && day1.uv === flow1.uv && day1.byr === flow1.byr,
   '页面 uv=' + day1.uv + ' byr=' + day1.byr + ' / 抓取 uv=' + flow1.uv + ' byr=' + flow1.byr);

/* ㉗ 多日区间买家 / 访客 == 逐日序列求和 */
const WEEK = ['2026-10-12', '2026-10-18'];
const wk = metrics(WEEK[0], WEEK[1]);
const wkSum = flowDaily(WEEK[0], WEEK[1]);
ok('近 7 天买家 / 访客 == 逐日序列求和',
   wk.basis === 'daily' && wk.uv === wkSum.uv && wk.byr === wkSum.byr,
   '页面 uv=' + wk.uv + ' byr=' + wk.byr + ' / 求和 uv=' + wkSum.uv + ' byr=' + wkSum.byr);

/* ㉘ 支付金额为逐日真值，不受任何系数影响 */
const amtDay = metrics('2026-10-08', '2026-10-08').amt;
const amtRow = DAILY.find(r => r.d === '2026-10-08').amt;
ok('单日支付金额 == 逐日原始值（无折算）', amtDay === amtRow && amtDay === 49000, 'amt=' + amtDay);

/* ㉙ 逐日求和与整段去重值的差必须真实存在，不得被抹平 */
const FULLD = metrics(DATA_START, DATA_END);
const fullSum = flowDaily(DATA_START, DATA_END);
ok('整段用去重值，逐日和多于去重值（口径差保留）',
   FULLD.basis === 'agg' && FULLD.uv === 3890 && fullSum.uv === 4038 && fullSum.uv > FULLD.uv,
   '整段=' + FULLD.uv + ' 逐日和=' + fullSum.uv);

/* ㉚ 交易页 / 流量页 / 商品页三处访客同源 */
let sameSrc = true, sameDetail = [];
for (const [a, b] of [[DATA_START, DATA_END], ['2026-10-12', '2026-10-18'], ['2026-10-15', '2026-10-15']]){
  SER = DAILY;
  const m1 = metrics(a, b).uv;
  const m2 = flowMetrics(a, b).uv;
  const m3 = itemView(a, b).m.uv;
  if (!(m1 === m2 && m2 === m3)){ sameSrc = false; sameDetail.push(a + '~' + b + ':' + m1 + '/' + m2 + '/' + m3); }
}
ok('交易 / 流量 / 商品三页访客同源', sameSrc, sameDetail.join(' '));

/* ㉛ 主店单日不再出现「按 30 天日均折算」红字 */
SER = DAILY;
const tradeOne = pageTrade({ route:'trade', g:'day', p:'d1', a:ONE, b:ONE, s:'main', cmp:false, q:80000 });
ok('主店单日已移除折算红字', !tradeOne.includes('按 30 天日均折算'), tradeOne.includes('按 30 天日均折算') ? '仍存在' : '');

/* ㉜ 同页重渲染保留滚动位置，换页才回到顶部
   模拟浏览器的行为：改写 innerHTML 会把 scrollTop 清零，
   所以 render() 必须在写之前读出来、写之后补回去。 */
SER = DAILY;
let fakeTop = 0, lastHtml = '';
const fakeContent = {
  classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
  setAttribute(){}, addEventListener(){}, style: {}, textContent: '',
  get scrollTop(){ return fakeTop; },
  set scrollTop(v){ fakeTop = v; },
  set innerHTML(v){ fakeTop = 0; lastHtml = v; },
  get innerHTML(){ return lastHtml; }
};
const realGetById = document.getElementById;
document.getElementById = id => (id === 'content' ? fakeContent : __el());

location.hash = '#/screen?g=day&p=30d&cmp=0&q=80000&s=main';
render();
fakeTop = 500;
location.hash = '#/screen?g=day&p=7d&cmp=0&q=80000&s=main';
render();
const keptTop = fakeTop;
const sameHtml = lastHtml;

location.hash = '#/trade?g=day&p=30d&cmp=0&q=80000&s=main';
render();
const resetTop = fakeTop;

document.getElementById = realGetById;
location.hash = '#/screen';

ok('同页切区间保留滚动位置', keptTop === 500, '实测 ' + keptTop);
ok('同页切区间没有渲染失败', !sameHtml.includes('页面渲染失败'));
ok('换页回到顶部', resetTop === 0, '实测 ' + resetTop);

/* 输出 */
let fail = 0;
for (const r of results){
  if (r.cond) console.log('PASS  ' + r.name + (r.extra ? '  → ' + r.extra : ''));
  else { fail++; console.log('FAIL  ' + r.name + (r.extra ? '  → ' + r.extra : '')); }
}
console.log('\\n' + (results.length - fail) + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
`;

try {
  new Function(stub + core + assertions)();
} catch (e) {
  console.error('检查脚本执行失败：' + (e && e.message));
  process.exit(1);
}
