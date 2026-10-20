/**
 * 日增门禁：判一次日增采集是否可用。
 *
 * 采完不检查等于没采 —— 页面「打开了但一个业务请求都没发」时，
 * 采集器不会报错，只会安静地落一个 183 字节的全局心跳接口。
 * 这里按页判三档并给出退出码，方便接在 run-daily.ps1 之后。
 *
 * 判定
 *   FAIL   0 个文件
 *   NODATA 有文件但全是配置类（心跳 / 规则 / token / 账号信息），业务接口一个没到
 *   WARN   只有 1 个文件，或总计 < 800 字节（大概率只采到心跳/配置）
 *   EMPTY  结构上取不到数据的页，基线同样为空，不算失败
 *   PASS   其余
 *
 * 另外校验 REQUIRED_KEYS 里的关键指标是否在场。页面 PASS 仍可能缺下游要的字段
 * （qos-core 曾 6 个文件全是配置类，服务页四指标一条都没有），缺任何一项按失败处理。
 *
 * 退出码：0 可用；1 有 FAIL / NODATA / 关键指标缺失
 *
 * 另外把响应体里出现过的非成功 code 列出来。部分 code 是已知无害的
 * （见 KNOWN_BENIGN），不算失败。
 *
 * 用法
 *   node scripts/check_daily.mjs
 *   node scripts/check_daily.mjs --date 2026-10-19
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const di = argv.indexOf('--date');
const date = di >= 0 ? argv[di + 1] : (() => {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

const DAY = path.join(ROOT, 'data', 'daily', date);
const MIN_BYTES = 800;

/* 已知无害：交易页两条子接口在单日区间下必报错，主数据另有接口 */
const KNOWN_BENIGN = new Set([1000, 1009, 1142]);

/* 结构上取不到数据的页面：30 天基线 data/raw30/<模块>/ 里同样只有心跳，
   csv30/<模块>/ 全空。写死在这里，不依赖 manifest 是否还记得这些页。 */
const STRUCTURALLY_EMPTY = new Set(['content-overview', 'content-channel', 'qos-experience', 'qos-performance']);

/* 配置类响应：文件名命中即视为非业务数据。
   这些接口每页都会发、永远成功、体积极小，它们的在场不能证明页面真的加载了数据。
   qos-core 曾出现 6 个文件 1.7 KB 全为配置类（心跳 / 按钮规则 / token / 账号信息），
   旧判据按「文件数 ≥ 2 且 ≥ 800 字节」给了 PASS，而服务页要的四指标一条都没有。 */
const CONFIG_ONLY = /getCurrentTime|rule_button|rule_value|token_generate|account_info|account_groups|getInitAccountDate|tradeIntegrityDiagnose|_errorcode|check-conf|config_/i;

/* 关键指标在场校验：页面 PASS 也可能缺下游要的字段，按页列出必须出现的响应键。
   这些键来自实测响应体，改接口字段名时要同步这里。 */
const REQUIRED_KEYS = {
  'qos-core': [
    ['manReplyRate3Min', '客服三分钟响应率'],
    ['avgReplyDur1d', '旺旺人工平均响应时长'],
    ['cstUv1d', '咨询人数'],
    ['replyUv1d', '回复人数']
  ]
};

if (!fs.existsSync(DAY)){
  console.error(`目录不存在: ${DAY}`);
  process.exit(1);
}

const mp = path.join(DAY, '_manifest.json');
const manifest = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : null;
if (!manifest){
  console.error(`缺少 _manifest.json: ${mp}`);
  process.exit(1);
}

function bodyCode(text){
  const m = text.match(/"code"\s*:\s*(-?\d+)/);
  return m ? Number(m[1]) : null;
}

console.log(`日增检查 ${date}`);
console.log(`采集于 ${manifest.capturedAt}`);
console.log(`范围 ${manifest.scope}\n`);

/* 以磁盘目录为准：manifest 可能被某次只跑几页的补采改写，目录才是真实落盘结果 */
const onDisk = fs.readdirSync(DAY, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== '.trash')
  .map(d => d.name);
const meta = new Map((manifest.pages || []).map(p => [p.name, p]));
const names = [...new Set([...onDisk, ...meta.keys()])].sort();

let fail = 0, warn = 0, pass = 0, empty = 0, nodata = 0, totalFiles = 0, totalBytes = 0;
const benignHits = [];
const badHits = [];
const emptyPages = [];
const noDataPages = [];
const missingKeys = [];

for (const name of names){
  const p = meta.get(name) || { name };
  const dir = path.join(DAY, name);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch {}
  let bytes = 0;
  const codes = new Map();
  const texts = [];
  for (const f of files){
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    texts.push(text);
    bytes += Buffer.byteLength(text);
    const c = bodyCode(text);
    if (c !== null && c !== 0 && c !== 200){
      codes.set(c, (codes.get(c) || 0) + 1);
      if (KNOWN_BENIGN.has(c)) benignHits.push(`${p.name}/${f} → code ${c}`);
      else badHits.push(`${p.name}/${f} → code ${c}`);
    }
  }
  totalFiles += files.length;
  totalBytes += bytes;

  /* 业务文件 = 文件名不像配置类的那些。文件数够但业务文件为 0，说明页面只发了外壳请求 */
  const bizFiles = files.filter(f => !CONFIG_ONLY.test(f));

  /* 关键指标：同一页任一响应体含该键即算在场 */
  if (REQUIRED_KEYS[name]){
    for (const [key, label] of REQUIRED_KEYS[name]){
      if (!texts.some(t => t.includes(key))) missingKeys.push({ page: name, key, label });
    }
  }

  const thin = !files.length || files.length < 2 || bytes < MIN_BYTES;
  const knownEmpty = p.expectEmpty || STRUCTURALLY_EMPTY.has(name);
  let tag;
  if (thin && knownEmpty){
    /* 基线（data/raw30）里这些页同样只有心跳，csv30 目录全空，属结构上取不到 */
    tag = 'EMPTY'; empty++; emptyPages.push(p.name);
  } else if (!files.length){ tag = 'FAIL'; fail++; }
  else if (!bizFiles.length){ tag = 'NODATA'; nodata++; noDataPages.push(p.name); }
  else if (thin){ tag = 'WARN'; warn++; }
  else { tag = 'PASS'; pass++; }

  const codeStr = codes.size ? '  非成功 code: ' + [...codes].map(([c, n]) => `${c}×${n}`).join(' ') : '';
  const attemptStr = p.attempts > 1 ? ` (${p.attempts} 次)` : '';
  console.log(`${tag.padEnd(5)} ${p.name.padEnd(18)} ${String(files.length).padStart(3)} 个 ${String(bytes).padStart(8)} 字节${attemptStr}${codeStr}`);
}

console.log(`\n合计 ${totalFiles} 个接口响应 / ${(totalBytes / 1024).toFixed(1)} KB`);
console.log(`PASS ${pass}  WARN ${warn}  FAIL ${fail}  NODATA ${nodata}  EMPTY ${empty}（已知空页）`);
if (emptyPages.length){
  console.log(`\n已知空页: ${emptyPages.join('、')}`);
  console.log('这些页在 data/raw30 里同样只有心跳、csv30 目录为空，属结构上取不到数据，不算回归。');
}

if (noDataPages.length){
  console.log(`\n只有配置类响应、业务接口一个都没到: ${noDataPages.join('、')}`);
  console.log('文件数与字节数都够，只看这两个数会误判成 PASS；这类页面拿不出任何指标。');
}

if (missingKeys.length){
  console.log(`\n关键指标缺失 ${missingKeys.length} 项（下游页面会没有数据）:`);
  for (const m of missingKeys) console.log(`  ${m.page} 缺 ${m.key}（${m.label}）`);
  console.log('多半是页面只渲染了外壳，或该接口在当天区间被拒绝。用 probe-page.mjs 单页复核。');
}

if (benignHits.length){
  console.log(`\n已知无害的失败子请求 ${benignHits.length} 条（不影响主数据）:`);
  for (const h of benignHits.slice(0, 6)) console.log('  ' + h);
  if (benignHits.length > 6) console.log(`  ... 另有 ${benignHits.length - 6} 条`);
}
if (badHits.length){
  console.log(`\n需要注意的失败响应 ${badHits.length} 条:`);
  for (const h of badHits.slice(0, 12)) console.log('  ' + h);
}

if (fail){ console.log('\n有空采的页面，先跑 probe-page.mjs 看那页到底发了什么请求'); process.exit(1); }
if (missingKeys.length){
  console.log('\n关键指标缺席，这一天的数据无法支撑下游页面，按失败处理。');
  process.exit(1);
}
if (nodata){
  console.log('\n有页面只拿到配置类响应，按失败处理；换新标签重跑那几页通常能恢复。');
  process.exit(1);
}
process.exit(0);
