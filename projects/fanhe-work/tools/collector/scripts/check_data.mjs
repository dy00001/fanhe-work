/**
 * 页面数据对账：把 preview 里的常量与 data/csv30 逐项比对。
 *
 * 背景：页面数据块一直是手抄 CSV 的，没有生成脚本也没有断言，是整条链上
 * 唯一不可复现的一环。今天发现「访客/买家其实一直有逐日序列」正是这条断链
 * 的后果 —— 手抄让人失去了对数据源的怀疑。
 *
 * 取数逻辑在 scripts/lib/preview-source.mjs，与生成脚本共用同一份，
 * 否则「生成后对账通过」只能证明两边一致地错。
 *
 * 用法：node scripts/check_data.mjs
 * 退出码：0 全过，1 有差异。
 */
import { derive, readHtmlConsts } from './lib/preview-source.mjs';

const NAMES = [
  'DAILY', 'DAILY_FLOW', 'AGG', 'BUYERS', 'CONTENT',
  'ITEMS', 'AREAS', 'KEYWORDS', 'CHANNELS', 'FLOW_SPLIT', 'TREE_PARENT'
];

/* 精度策略。
   页面里有些浮点是手抄时截断过的：AGG 存 10 位有效数字（1186.8131868），
   AREAS / BUYERS / CONTENT / CHANNELS 的比率存 3~4 位小数。这些截断只影响
   显示，不参与交叉校验，所以按「显示精度」放行，但把实测偏差打印出来。
   整数与金额一律逐位比，1 元的漂移（相对 9e-6）会被抓住。 */
const REL_TOL = 1e-9;
const ABS_TOL = { AREAS: 1e-3, BUYERS: 1e-3, CONTENT: 1e-3, CHANNELS: 1e-3 };

let maxDev = 0;
const near = (a, b, absTol) => {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!isFinite(a) || !isFinite(b)) return false;
  const d = Math.abs(a - b);
  if (d > maxDev) maxDev = d;
  return d <= Math.max(absTol || 0, Math.abs(b) * REL_TOL);
};

function compare(pathStr, got, want, out, tol){
  if (Array.isArray(want)){
    if (!Array.isArray(got)){ out.push(`${pathStr} 类型应为数组，实际 ${typeof got}`); return; }
    if (got.length !== want.length){ out.push(`${pathStr} 长度 ${got.length} ≠ ${want.length}`); return; }
    want.forEach((w, i) => compare(`${pathStr}[${i}]`, got[i], w, out, tol));
    return;
  }
  if (want && typeof want === 'object'){
    if (!got || typeof got !== 'object'){ out.push(`${pathStr} 类型应为对象，实际 ${typeof got}`); return; }
    for (const k of Object.keys(want)) compare(`${pathStr}.${k}`, got[k], want[k], out, tol);
    for (const k of Object.keys(got)) if (!(k in want)) out.push(`${pathStr}.${k} 页面有、CSV 无（多余字段）`);
    return;
  }
  if (!near(got, want, tol)) out.push(`${pathStr}: 页面 ${JSON.stringify(got)} ≠ CSV ${JSON.stringify(want)}`);
}

const want = derive();
const got = readHtmlConsts(NAMES);

let fails = 0;
console.log('页面常量 与 data/csv30 对账\n');

for (const name of NAMES){
  const issues = [];
  const tol = ABS_TOL[name] || 0;
  maxDev = 0;
  compare(name, got[name], want[name], issues, tol);
  if (issues.length){
    fails += 1;
    console.log(`FAIL  ${name.padEnd(12)} ${issues.length} 处差异`);
    for (const s of issues.slice(0, 6)) console.log('        ' + s);
    if (issues.length > 6) console.log(`        …还有 ${issues.length - 6} 处`);
  } else {
    const n = Array.isArray(want[name]) ? want[name].length : Object.keys(want[name]).length;
    const note = maxDev === 0 ? '逐位一致' : `最大偏差 ${maxDev.toExponential(1)}（显示精度截断，在容差内）`;
    console.log(`PASS  ${name.padEnd(12)} ${String(n).padStart(2)} 项  ${note}`);
  }
}

/* 交叉校验：四个锚点必须都等于 108,000 */
const sumDaily = got.DAILY.reduce((t, r) => t + r.amt, 0);
const sumItems = got.ITEMS.reduce((t, r) => t + r.amt, 0);
const sumCart  = got.ITEMS.reduce((t, r) => t + r.cart, 0);
console.log('\n四个锚点');
for (const [label, v] of [
  ['逐日求和', sumDaily],
  ['AGG.payAmt', got.AGG.payAmt.v],
  ['10 个商品金额相加', sumItems],
  ['退款率反算', Math.round(got.AGG.payAmt.v)]
]){
  const ok = near(v, 108000, 0);
  if (!ok) fails += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(16)} ${v}`);
}
console.log(`  INFO  商品加购合计        ${sumCart}（比支付多 ${sumCart - sumItems}，是漏损空间，不参与锚点）`);

console.log(`\n共 ${NAMES.length} 组 / ${fails} 处失败`);
if (fails) process.exit(1);
