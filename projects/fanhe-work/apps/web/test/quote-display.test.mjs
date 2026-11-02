/**
 * 查价面板的展示规则与价格判型。
 *
 * 这些规则都属于「在界面上看不出错」的那一类：
 *
 *   - 「1.5 倍」渲染成 `¥1.5` 时，一行数字看起来完全正常 —— 只有拿它算过一次报价
 *     的人才知道错了；
 *   - 同名多行（拉篮按宽度分 15 行）只显示名称时，用户会以为列表重复了，然后随便
 *     点一条，拿到的是另一个宽度；
 *   - 关键词高亮把大小写改掉（`E0级` → `e0级`）不会报错，但台账原文被改写了。
 *
 * 所以它们全在纯函数里，在这里钉住。`parsePriceInput` 单独列一组：它是**导入器与
 * 在线改价共用的唯一判型实现**，错的代价是 1225 条数据里有一批价格形态被写错，
 * 而那些行在界面上看起来仍然是「一个数」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parsePriceInput } from '@fanhe/shared'

import {
  describeBindType,
  describeDataset,
  describePrice,
  describeStatus,
  describeUnlockSituation,
  formatYuan,
  itemQualifier,
  minutesUntil,
  resolveUnlockSituation,
  splitHighlight,
} from '../src/lib/quote-display.ts'

test('分转元：整数不带小数点', () => {
  assert.equal(formatYuan(66800), '668')
  assert.equal(formatYuan(1999), '19.99')
  assert.equal(formatYuan(0), '0')
  // 一分钱也要显示出来。四舍五入成 0 会让「有个零头」这件事消失。
  assert.equal(formatYuan(1), '0.01')
  assert.equal(formatYuan(1005), '10.05')
})

test('金额形态：主串带 ¥、单位跟在后面', () => {
  const view = describePrice({
    priceKind: 'amount',
    priceFen: 66800,
    priceText: '668',
    unit: '㎡',
  })
  assert.deepEqual(view, {
    primary: '¥668',
    suffix: '/㎡',
    caption: '单价',
    tone: 'amount',
  })
})

test('金额形态：没有单位时不拼一个孤零零的斜杠', () => {
  const view = describePrice({ priceKind: 'amount', priceFen: 12000, priceText: '', unit: '  ' })
  assert.equal(view.primary, '¥120')
  assert.equal(view.suffix, '')
})

test('金额形态但数值缺失：显示待补价，而不是 ¥0', () => {
  // 「这条还没定价」与「这条定价 0 元」是两件事。混成 ¥0 会让报价单上多出一堆
  // 免费的项，而它们其实是漏填。
  const view = describePrice({ priceKind: 'amount', priceFen: null, priceText: '', unit: '㎡' })
  assert.equal(view.primary, '待补价')
  assert.equal(view.tone, 'empty')
})

test('倍率形态：显示原文，绝不套 ¥，也不加单位', () => {
  // 这条是本模块最重要的回归。台账里「按投影面积 1.5 倍」的 1.5 与「668 元」的
  // 668 在库里都是数字，早年不分形态的实现把它渲染成 `¥1.5`。
  const view = describePrice({
    priceKind: 'multiplier',
    priceFen: null,
    priceText: '按投影面积 1.5 倍',
    unit: '㎡',
  })
  assert.equal(view.primary, '按投影面积 1.5 倍')
  assert.equal(view.suffix, '', '倍率加「/倍」只会让它更像金额')
  assert.equal(view.tone, 'text')
  assert.equal(view.caption, '倍率')
})

test('按米计价：有数值就用金额形态，没数值退回原文', () => {
  const priced = describePrice({
    priceKind: 'per_meter',
    priceFen: 10000,
    priceText: '100/米',
    unit: '米',
  })
  assert.equal(priced.primary, '¥100')
  assert.equal(priced.suffix, '/米')
  assert.equal(priced.tone, 'amount')

  const unpriced = describePrice({
    priceKind: 'per_meter',
    priceFen: null,
    priceText: '按米计价，另议',
    unit: '米',
  })
  assert.equal(unpriced.primary, '按米计价，另议')
  assert.equal(unpriced.tone, 'text')
})

test('规则形态与空形态', () => {
  const rule = describePrice({
    priceKind: 'rule',
    priceFen: null,
    priceText: '按展开面积另计',
    unit: '',
  })
  assert.equal(rule.primary, '按展开面积另计')
  assert.equal(rule.suffix, '')
  assert.equal(rule.caption, '按规则计')

  const empty = describePrice({ priceKind: 'empty', priceFen: null, priceText: '', unit: '' })
  assert.equal(empty.primary, '待补价')
  assert.equal(empty.tone, 'empty')
})

test('状态角标：在售不显示，停用才标', () => {
  assert.equal(describeStatus('active'), null)
  assert.equal(describeStatus('archived'), '已停用')
})

test('图与型号的对应方式要说清楚', () => {
  assert.equal(describeBindType('exact'), '本品项图')
  // `family` 必须单独给一句。写成「本品项图」会让客户以为这张图就是这个规格的。
  assert.equal(describeBindType('family'), '同系列图')
  assert.equal(describeBindType('manual'), '手工上传')
})

test('同名多行靠型号与规格区分', () => {
  assert.equal(itemQualifier({ model: '3177007', spec: '450 柜宽' }), '3177007 · 450 柜宽')
  assert.equal(itemQualifier({ model: '3177007', spec: '  ' }), '3177007')
  // 柜体类台账只有名称、没有型号，这里必须给空串，否则行里会多出一个孤立的「·」。
  assert.equal(itemQualifier({ model: '', spec: '' }), '')
})

test('高亮：空关键词整串一段，不返回空数组', () => {
  assert.deepEqual(splitHighlight('诺米拉篮', ''), [{ text: '诺米拉篮', hit: false }])
  assert.deepEqual(splitHighlight('诺米拉篮', '   '), [{ text: '诺米拉篮', hit: false }])
  assert.deepEqual(splitHighlight('', '拉篮'), [{ text: '', hit: false }])
})

test('高亮：大小写不敏感，但保留原文大小写', () => {
  const segments = splitHighlight('E0级 板材 e0 对比', 'e0')
  assert.deepEqual(segments, [
    { text: 'E0', hit: true },
    { text: '级 板材 ', hit: false },
    { text: 'e0', hit: true },
    { text: ' 对比', hit: false },
  ])
  // 拼回去必须与原文逐字相同 —— 高亮只切分、不改写。
  assert.equal(segments.map((segment) => segment.text).join(''), 'E0级 板材 e0 对比')
})

test('高亮：多处命中与命中在首尾', () => {
  assert.deepEqual(splitHighlight('拉篮拉篮', '拉篮'), [
    { text: '拉篮', hit: true },
    { text: '拉篮', hit: true },
  ])
  assert.deepEqual(splitHighlight('拉篮加宽', '拉篮'), [
    { text: '拉篮', hit: true },
    { text: '加宽', hit: false },
  ])
  assert.deepEqual(splitHighlight('加宽拉篮', '拉篮'), [
    { text: '加宽', hit: false },
    { text: '拉篮', hit: true },
  ])
})

test('高亮：没命中就是整串一段，不是若干段', () => {
  assert.deepEqual(splitHighlight('诺米拉篮', '百隆'), [{ text: '诺米拉篮', hit: false }])
})

test('数据集版本行：条数、图数与导入时间', () => {
  // 本地时区、到分钟。断言不写死时区偏移，只断言形状与条数，否则换机必红。
  const text = describeDataset({
    itemCount: 1225,
    imageCount: 293,
    importedAt: '2026-11-02T05:30:00.000Z',
  })
  assert.match(text, /^1225 条 · 293 张图 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

  // 未导入时不能显示成 1970 年。
  assert.equal(
    describeDataset({ itemCount: 0, imageCount: 0, importedAt: '' }),
    '0 条 · 0 张图 · 尚未导入',
  )
})

test('解锁状态：五种情形分开，直接可改排在锁定之前', () => {
  const base = { direct: false, hasSecret: true, unlockedUntil: null, lockedUntil: null }

  assert.equal(resolveUnlockSituation({ ...base, direct: true }), 'direct')
  // owner 即使正被锁定，也只是「直接可改」—— 他本来就不需要口令。
  assert.equal(
    resolveUnlockSituation({ ...base, direct: true, lockedUntil: '2026-11-02T06:00:00.000Z' }),
    'direct',
  )
  // 没设过口令排在锁定之前：那时输口令这件事本身不存在，说「已锁定」会让人等 15 分钟。
  assert.equal(
    resolveUnlockSituation({ ...base, hasSecret: false, lockedUntil: '2026-11-02T06:00:00.000Z' }),
    'no-secret',
  )
  assert.equal(
    resolveUnlockSituation({ ...base, lockedUntil: '2026-11-02T06:00:00.000Z' }),
    'locked-out',
  )
  assert.equal(
    resolveUnlockSituation({ ...base, unlockedUntil: '2026-11-02T06:00:00.000Z' }),
    'unlocked',
  )
  assert.equal(resolveUnlockSituation(base), 'locked')
})

test('解锁状态的文案各不相同', () => {
  const texts = ['direct', 'unlocked', 'locked', 'locked-out', 'no-secret'].map(
    describeUnlockSituation,
  )
  assert.equal(new Set(texts).size, 5)
  // owner 看到「你没权限」是最典型的文案事故 —— 他是唯一本来就能改的人。
  assert.match(texts[0], /超级管理员/)
})

test('剩余分钟：向上取整，过期与非法值都给 0 / null', () => {
  const now = Date.parse('2026-11-02T06:00:00.000Z')
  assert.equal(minutesUntil('2026-11-02T06:30:00.000Z', now), 30)
  // 剩 30 秒算 1 分钟。显示「剩余 0 分钟」而实际上还能用，会让人白等一次输入。
  assert.equal(minutesUntil('2026-11-02T06:00:30.000Z', now), 1)
  assert.equal(minutesUntil('2026-11-02T05:59:00.000Z', now), 0)
  assert.equal(minutesUntil(null, now), null)
  assert.equal(minutesUntil('不是时间', now), null)
})

// ---------------------------------------------------------------------------
// 价格判型
// ---------------------------------------------------------------------------

/**
 * 判型的顺序本身就是规则，所以断言的顺序也按它写：
 * 空 → 倍率 → 按米 → 纯数值 → 其余规则。
 */
test('判型：空与纯空白都是 empty', () => {
  for (const raw of ['', '   ', '\t\n']) {
    assert.deepEqual(parsePriceInput(raw), { kind: 'empty', priceFen: null, priceText: '' })
  }
})

test('判型：倍率必须早于纯数值，否则「1.5 倍」会变成 1.5 元', () => {
  const cases = ['1.5 倍', '1.5倍', '按投影面积 ×1.5', '× 2']
  for (const raw of cases) {
    const parsed = parsePriceInput(raw)
    assert.equal(parsed.kind, 'multiplier', raw)
    assert.equal(parsed.priceFen, null, raw)
    // 原文一字不改地留着 —— 展示层直接用这一串。
    assert.equal(parsed.priceText, raw.trim(), raw)
  }
})

test('判型：按米计价取出数值，纯文字仍归规则', () => {
  assert.deepEqual(parsePriceInput('120 元/米'), {
    kind: 'per_meter',
    priceFen: 12000,
    priceText: '120 元/米',
  })
  assert.deepEqual(parsePriceInput('100/米'), {
    kind: 'per_meter',
    priceFen: 10000,
    priceText: '100/米',
  })
  assert.equal(parsePriceInput('每米 35').kind, 'per_meter')
  assert.equal(parsePriceInput('35 米/根').kind, 'per_meter')
  // 有「米」但没有价：不能编一个假数值出来。
  assert.equal(parsePriceInput('按米计价，另议').kind, 'rule')
})

test('判型：纯数值当金额，兼容 ¥ 元 千分位', () => {
  assert.deepEqual(parsePriceInput('668'), { kind: 'amount', priceFen: 66800, priceText: '668' })
  assert.deepEqual(parsePriceInput('¥668'), {
    kind: 'amount',
    priceFen: 66800,
    priceText: '¥668',
  })
  assert.deepEqual(parsePriceInput('668元'), {
    kind: 'amount',
    priceFen: 66800,
    priceText: '668元',
  })
  assert.deepEqual(parsePriceInput('1,280'), {
    kind: 'amount',
    priceFen: 128000,
    priceText: '1,280',
  })
  assert.equal(parsePriceInput('0').priceFen, 0)
})

test('判型：元转分用四舍五入，不截断', () => {
  // `19.99 * 100` 在浮点里是 1998.9999…，截断会少一分钱 —— 而这一分钱会在
  // 月末对账时被财务找出来。
  assert.equal(parsePriceInput('19.99').priceFen, 1999)
  assert.equal(parsePriceInput('0.29').priceFen, 29)
  assert.equal(parsePriceInput('1.005').kind, 'rule', '三位小数不是台账里的写法，按原文保留')
})

test('判型：看不懂的原文归规则，不猜', () => {
  for (const raw of ['面议', '按展开面积另计', '详询', '668 元/㎡']) {
    const parsed = parsePriceInput(raw)
    assert.equal(parsed.kind, 'rule', raw)
    assert.equal(parsed.priceFen, null, raw)
  }
})
