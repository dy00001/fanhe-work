/**
 * 从 data/csv30 生成页面的数据常量。
 *
 * 为什么需要它：页面的数据块一直是手抄 CSV 的。今天发现「访客/买家其实
 * 一直有逐日序列」，就是因为手抄让人失去了对数据源的怀疑。手抄还有一个
 * 副作用：改一次数据要动两处，且没有机制能发现两边不一致。
 *
 * 做法：页面里每个生成的常量都被
 *     /* DATA:BEGIN NAME *\/ ... /* DATA:END NAME *\/
 * 包住，本脚本只替换标记之间的内容，标记外面的人工注释原样保留。
 * 取数逻辑与 check_data.mjs 共用 scripts/lib/preview-source.mjs。
 *
 * 用法：
 *   node scripts/build_preview_data.mjs          仅预演，打印会改动哪些常量
 *   node scripts/build_preview_data.mjs --write  实际写回页面
 * 写完务必跑 node scripts/check_data.mjs 复核。
 */
import fs from 'node:fs';
import { HTML_PATH, derive } from './lib/preview-source.mjs';

const WRITE = process.argv.includes('--write');

const src = fs.readFileSync(HTML_PATH, 'utf8');
const nl = src.includes('\r\n') ? '\r\n' : '\n';

const js = v => (v === null || v === undefined ? 'null' : JSON.stringify(v));
const q  = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

/* 每行放 n 个元素，末尾允许逗号 */
function rowsJoined(rows, perLine){
  const out = [];
  for (let i = 0; i < rows.length; i += perLine) out.push('  ' + rows.slice(i, i + perLine).join(','));
  /* 行间必须带逗号：少了它，JS 会把 [..]\n[..] 解析成下标访问，
     整个数组变成 undefined 元素，页面直接白屏 */
  return out.join(',' + nl);
}
const objLines = rows => rows.map(r => '  ' + r).join(',' + nl);

const d = derive();
const N = nl;

const generators = {
  DAILY(){
    const body = rowsJoined(d.DAILY.map(r => `['${r.d}',${js(r.amt)}]`), 4);
    return `const DAILY = [${N}${body}${N}].map(([d,a]) => ({d, amt:a}));`;
  },

  DAILY_FLOW(){
    const body = rowsJoined(d.DAILY_FLOW.map(r => `['${r.d}',${r.uv},${r.byr},${r.itmUv}]`), 3);
    return `const DAILY_FLOW = [${N}${body}${N}].map(([d, uv, byr, itmUv]) => ({d, uv, byr, itmUv}));`;
  },

  AGG(){
    const keys = Object.keys(d.AGG);
    const w = Math.max(...keys.map(k => k.length));
    const lines = keys.map(k => {
      const cell = d.AGG[k];
      return `  ${(k + ':').padEnd(w + 1)} {v:${js(cell.v)},${' '.repeat(Math.max(1, 10 - String(cell.v).length))}c: ${js(cell.c)}}`;
    });
    return `const AGG = {${N}${lines.join(',' + N)}${N}};`;
  },

  BUYERS(){
    const b = d.BUYERS;
    return `const BUYERS = { newCnt:${b.newCnt}, newCrc:${js(b.newCrc)}, oldCnt:${b.oldCnt}, oldCrc:${js(b.oldCrc)} };`;
  },

  CONTENT(){
    const lines = d.CONTENT.map(c =>
      `  {k:${q(c.k)}, uv:${c.uv}, crc:${js(c.crc)}, note:${q(c.note)}}`);
    return `const CONTENT = [${N}${lines.join(',' + N)}${N}];`;
  },

  ITEMS(){
    const lines = d.ITEMS.map(x =>
      `  {title:${q(x.title)}, uv:${x.uv}, amt:${js(x.amt)}, byr:${x.byr}, rate:${js(x.rate)}, cart:${js(x.cart)}, clt:${x.clt}, id:${q(x.id)}}`);
    return `const ITEMS = [${N}${lines.join(',' + N)}${N}];`;
  },

  AREAS(){
    const lines = d.AREAS.map(a =>
      `  {name:${q(a.name)}, uv:${a.uv}, ratio:${js(a.ratio)}, rate:${js(a.rate)}}`);
    return `const AREAS = [${N}${lines.join(',' + N)}${N}];`;
  },

  KEYWORDS(){
    const body = rowsJoined(d.KEYWORDS.map(([w, u]) => `[${q(w)},${u}]`), 4);
    return `const KEYWORDS = [${N}${body}${N}];`;
  },

  CHANNELS(){
    const lines = d.CHANNELS.map(c =>
      `  {name:${q(c.name)}, uv:${c.uv}, ratio:${js(c.ratio)}, crc:${js(c.crc)}, avg:${c.avg}, good:${c.good}, byr:${c.byr}, rate:${js(c.rate)}, amt:${js(c.amt)}}`);
    return `const CHANNELS = [${N}${lines.join(',' + N)}${N}];`;
  },

  FLOW_SPLIT(){
    return `const FLOW_SPLIT = { rec:${d.FLOW_SPLIT.rec}, search:${d.FLOW_SPLIT.search} };`;
  },

  TREE_PARENT(){
    const t = d.TREE_PARENT;
    return `const TREE_PARENT = { total:${t.total}, browse:${t.browse}, live:${t.live}, sum:${t.sum}, gap:${t.gap} };`;
  }
};

let out = src;
const report = [];

for (const [name, gen] of Object.entries(generators)){
  const begin = `/* DATA:BEGIN ${name} */`;
  const end   = `/* DATA:END ${name} */`;
  const re = new RegExp(
    begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  if (!re.test(out)){
    report.push({ name, status: 'SKIP', note: '页面里没有这对标记' });
    continue;
  }
  const code = gen();
  const next = `${begin}${nl}${code}${nl}${end}`;
  const changed = !re.exec(out)[0].includes(code);
  out = out.replace(re, () => next);
  report.push({ name, status: changed ? 'CHANGED' : 'SAME', note: '' });
}

for (const r of report){
  const tag = r.status === 'SAME' ? '不变' : r.status === 'CHANGED' ? '更新' : '跳过';
  console.log(`${tag}  ${r.name.padEnd(12)} ${r.note}`);
}

const changed = report.filter(r => r.status === 'CHANGED').length;
if (!WRITE){
  console.log(`\n预演：${changed} 组会被改写。加 --write 实际写入。`);
} else if (changed === 0){
  console.log('\n没有需要改写的内容。');
} else {
  fs.writeFileSync(HTML_PATH, out, 'utf8');
  console.log(`\n已写入 ${changed} 组。请跑 node scripts/check_data.mjs 复核。`);
}
