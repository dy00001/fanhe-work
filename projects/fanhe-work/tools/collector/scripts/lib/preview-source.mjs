/**
 * 页面数据的唯一取数入口。
 *
 * 为什么单独一层：check_data.mjs（对账）和 build_preview_data.mjs（生成）
 * 必须用完全相同的推导逻辑，否则「生成完对账通过」只能证明两边一致地错。
 *
 * 这里只做一件事：把 data/csv30 变成页面那 11 组常量。
 * 不负责格式化，也不负责写文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HTML_PATH = path.join(ROOT, 'preview', 'ops-dashboard-preview.html');
export const CSV_ROOT = path.join(ROOT, 'data', 'csv30');

/* ── 最小 CSV 解析：引号、转义引号、CRLF。商品标题里可能出现逗号 ────── */
export function parseCsv(text){
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (inQ){
      if (ch === '"'){
        if (text[i + 1] === '"'){ field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ','){ row.push(field); field = ''; }
    else if (ch === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows;
}

export function readTable(rel){
  const fp = path.join(CSV_ROOT, rel);
  let t = fs.readFileSync(fp, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  const rows = parseCsv(t);
  const head = rows.shift() || [];
  return rows
    .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map(r => {
      const o = {};
      head.forEach((h, i) => { o[h] = r[i]; });
      return o;
    });
}

const num = v => (v === '' || v === undefined || v === null ? null : Number(v));

/* 渠道树的 children 是 JSON 字符串，节点字段又都包了一层 {value}
   例：{"pageName":{"value":"推荐"},"uv":{"value":2721},...} */
function walkTree(nodes, out){
  for (const node of nodes){
    const name = node.pageName && node.pageName.value;
    const uv = node.uv && node.uv.value;
    if (name) out.push({ name, uv: Number(uv) });
    const raw = node.children && node.children.value;
    if (!raw) continue;
    try {
      walkTree(typeof raw === 'string' ? JSON.parse(raw) : raw, out);
    } catch {}
  }
}

export function derive(){
  /* 逐日支付金额 → DAILY */
  const DAILY = readTable('trade-detail/01_bda_tradinganaly_overview_getTendency__逐日.csv')
    .filter(r => r.device === 'all')
    .map(r => ({ d: r.date, amt: num(r.payAmt) }));

  /* 逐日访客 / 买家 / 商品访客 → DAILY_FLOW */
  const DAILY_FLOW = readTable('flow-overview/03_flow_new_guide_trend__逐日多指标.csv')
    .map(r => ({ d: r.date, uv: num(r.my_uv), byr: num(r.my_payByrCnt), itmUv: num(r.my_itmUv) }));

  /* 30 天整段指标 → AGG / BUYERS / CONTENT */
  const metric = {};
  for (const r of readTable('flow-overview/01_flow_new_guide_trend_overview__指标长表.csv')){
    metric[r.metric] = { v: num(r.value), c: num(r.cycleCrc) };
  }
  const AGG = {
    payAmt:     metric.payAmt,
    payByrCnt:  metric.payByrCnt,
    payPct:     metric.payPct,
    uv:         metric.uv,
    payRate:    metric.payRate,
    bounceRate: metric.bounceRate,
    pv:         metric.pv,
    cartByrCnt: metric.cartByrCnt,
    stayTime:   metric.stayTime,
    uvValue:    metric.uvValue,
    itmAvgpv:   metric.itmAvgPv,
    itmUv:      metric.itmUv
  };
  const BUYERS = {
    newCnt: metric.newPayByrCnt.v, newCrc: metric.newPayByrCnt.c,
    oldCnt: metric.payOldByrCnt.v, oldCrc: metric.payOldByrCnt.c
  };
  const CONTENT = [
    { k: '微信详情', uv: metric.miniDetailUv.v,  crc: metric.miniDetailUv.c,  note: '微详情' },
    { k: '短视频',   uv: metric.shortVideoUv.v,  crc: metric.shortVideoUv.c,  note: '短视频' },
    { k: '直播',     uv: metric.liveRoomUv.v,    crc: null,                   note: '未开播' },
    { k: '图文',     uv: metric.imageUv.v,       crc: metric.imageUv.c,       note: '图文' }
  ];

  /* 商品维度 → ITEMS（顺序沿用接口返回的支付金额倒序） */
  const ITEMS = readTable('item-rank/02_cc_item_view_top__data.csv').map(r => ({
    title: r.item_title,
    uv:    num(r.itmUv),
    amt:   num(r.payAmt),
    byr:   num(r.payByrCnt),
    rate:  num(r.payRate),
    cart:  num(r.crtAmt),
    clt:   num(r.itemCltByrCnt),
    id:    r.mainProductId
  }));

  /* 地域 → AREAS（用 areaUv 那份，orderRate 才是下单转化率） */
  const AREAS = readTable('flow-visitor/03_bda_visitor_distribution_listAreas__areaUv.csv').map(r => ({
    name: r.name,
    uv:   num(r.uv),
    ratio: num(r.ratio),
    rate:  num(r.orderRate)
  }));

  /* 搜索词 → KEYWORDS */
  const KEYWORDS = readTable('flow-keyword/01_flow_live_shop_wordAide_drainageSearch__data.csv')
    .map(r => [r.seKeyword, num(r.uv)]);

  /* 渠道树 → CHANNELS / FLOW_SPLIT / TREE_PARENT
     顶层三行是三条渠道，children 里是子渠道。
     注意父子不平：经营优势 3,679，其下四项之和 3,281，差 398 是接口去重口径差。 */
  const tree = readTable('flow-shopsource/03_flow_shop_source_tree_platform_support__data.csv');
  const CHANNELS = tree.map(r => ({
    name:  r.pageName,
    uv:    num(r.uv),
    ratio: num(r.uv_ratio),
    crc:   num(r.uv_环比),
    avg:   num(r.uv_rivalAvg),
    good:  num(r.uv_rivalGood),
    byr:   num(r.payByrCnt),
    rate:  num(r.payRate),
    amt:   num(r.payAmt)
  }));

  const subs = [];
  try { walkTree(JSON.parse(tree[0].children), subs); } catch {}
  const pick = name => (subs.find(x => x.name === name) || {}).uv ?? 0;
  const FLOW_SPLIT = { rec: pick('推荐'), search: pick('搜索') };
  const browse = pick('逛逛'), live = pick('淘宝直播');
  const parentTotal = num(tree[0].uv);
  const subSum = subs.reduce((t, x) => t + x.uv, 0);
  const TREE_PARENT = {
    total: parentTotal,
    browse,
    live,
    sum: subSum,
    gap: parentTotal - subSum
  };

  return { DAILY, DAILY_FLOW, AGG, BUYERS, CONTENT, ITEMS, AREAS, KEYWORDS, CHANNELS, FLOW_SPLIT, TREE_PARENT };
}

/* ── 从页面取出同名常量：与门禁脚本同一套打桩方式 ───────────────────── */
export function readHtmlConsts(names){
  const src = fs.readFileSync(HTML_PATH, 'utf8');
  const m = src.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('未找到内联 <script>');
  const inline = m[1];
  const cut = inline.indexOf('const gtip');
  if (cut < 0) throw new Error('未找到切分点 const gtip');
  const core = inline.slice(0, cut);

  const stub = `
const __el = () => ({ classList:{add(){},remove(){},contains(){return false;},toggle(){}}, setAttribute(){}, addEventListener(){}, style:{}, innerHTML:'', scrollTop:0, textContent:'' });
globalThis.document = { getElementById:__el, createElement:__el, addEventListener(){}, querySelectorAll:()=>[], body:{appendChild(){}} };
globalThis.window = { addEventListener(){}, innerWidth:1680 };
globalThis.location = { hash:'#/screen' };
globalThis.history = { replaceState(){} };
`;
  const tail = `\nreturn {${names.join(', ')}};`;
  return new Function(stub + core + tail)();
}
