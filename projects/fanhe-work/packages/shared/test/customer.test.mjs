import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CUSTOMER_LEGACY_STAGE_KEYS,
  CUSTOMER_STAGE_FLOW,
  CUSTOMER_STAGE_META,
  CUSTOMER_STAGE_OFFFLOW,
  CUSTOMER_STAGES,
  ORDER_STAGE_COUNT,
  ORDER_STAGE_DEFS,
  canTransition,
  compareStage,
  customerDisplayName,
  customerShortName,
  normalizeRegion,
  regionScopeOf,
  customerStageOrder,
  isStageRegression,
  mapLegacyStageKey,
} from '../dist/customer.js'

test('状态枚举共 14 档，主线 12 档加旁支 2 档', () => {
  assert.equal(CUSTOMER_STAGES.length, 14)
  assert.equal(CUSTOMER_STAGE_FLOW.length, 12)
  assert.equal(CUSTOMER_STAGE_OFFFLOW.length, 2)
})

test('主线序号从 1 连续到 12，无重复无缺号', () => {
  const orders = CUSTOMER_STAGE_FLOW.map((s) => customerStageOrder(s))
  assert.deepEqual(orders, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
})

test('旁支终态没有序号，不参与推进比较', () => {
  for (const stage of CUSTOMER_STAGE_OFFFLOW) {
    assert.equal(customerStageOrder(stage), null)
  }
})

test('每个状态都有展示文案，且文案互不相同', () => {
  const labels = CUSTOMER_STAGES.map((s) => CUSTOMER_STAGE_META[s].label)
  assert.equal(labels.length, 14)
  assert.equal(new Set(labels).size, 14)
  for (const label of labels) assert.ok(label.length >= 2)
})

test('九个旧节点键全部能折到新状态', () => {
  assert.equal(CUSTOMER_LEGACY_STAGE_KEYS.length, 9)
  for (const key of CUSTOMER_LEGACY_STAGE_KEYS) {
    const mapped = mapLegacyStageKey(key)
    assert.ok(mapped, `${key} 未映射`)
    assert.ok(CUSTOMER_STAGES.includes(mapped))
  }
})

test('一对多的旧键按约定落位', () => {
  assert.equal(mapLegacyStageKey('access'), 'consulting')
  assert.equal(mapLegacyStageKey('needs'), 'consulting')
  assert.equal(mapLegacyStageKey('payment'), 'contracted')
  assert.equal(mapLegacyStageKey('order'), 'contracted')
})

test('认不出的旧键返回 null，不兜底成咨询中', () => {
  assert.equal(mapLegacyStageKey('unknown_key'), null)
  assert.equal(mapLegacyStageKey(''), null)
  assert.notEqual(mapLegacyStageKey('unknown_key'), 'consulting')
})

test('旧键映射大小写不敏感且容错空白', () => {
  assert.equal(mapLegacyStageKey(' DESIGN '), 'designing')
  assert.equal(mapLegacyStageKey('Install'), 'installed')
})

test('倒序推进被判定为回退', () => {
  assert.equal(isStageRegression('contracted', 'quoted'), true)
  assert.equal(isStageRegression('installed', 'measured'), true)
})

test('正序推进与同档不算回退', () => {
  assert.equal(isStageRegression('quoted', 'contracted'), false)
  assert.equal(isStageRegression('producing', 'producing'), false)
})

test('跨到旁支终态不算回退，属于终止', () => {
  assert.equal(isStageRegression('installed', 'refunding'), false)
  assert.equal(isStageRegression('installed', 'lost'), false)
})

test('环节模板共 14 项，序号从 1 连续到 14', () => {
  assert.equal(ORDER_STAGE_COUNT, 14)
  assert.deepEqual(
    ORDER_STAGE_DEFS.map((d) => d.index),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  )
})

test('第十环是判定节点，其余为流转节点', () => {
  const decisions = ORDER_STAGE_DEFS.filter((d) => d.kind === 'decision')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].index, 10)
  assert.equal(decisions[0].key, 'spare_decision')
})

test('环节键唯一，文案唯一', () => {
  const keys = ORDER_STAGE_DEFS.map((d) => d.key)
  const labels = ORDER_STAGE_DEFS.map((d) => d.label)
  assert.equal(new Set(keys).size, 14)
  assert.equal(new Set(labels).size, 14)
})

test('每个环节都写了完成标志', () => {
  for (const def of ORDER_STAGE_DEFS) assert.ok(def.doneWhen.length > 0, `${def.key} 缺完成标志`)
})

test('阶段分布排序把主线排在旁支之前', () => {
  const sorted = [...CUSTOMER_STAGES].sort(compareStage)
  assert.equal(sorted[0], 'consulting')
  assert.equal(sorted[11], 'closed')
  assert.ok(sorted.indexOf('closed') < sorted.indexOf('refunding'))
  assert.ok(sorted.indexOf('closed') < sorted.indexOf('lost'))
})

test('推进校验只拒绝不属于枚举的目标状态', () => {
  assert.equal(canTransition('consulting', 'closed'), true)
  assert.equal(canTransition('consulting', 'consulting'), true)
  assert.equal(canTransition('consulting', 'not_a_stage'), false)
})

// ---------------------------------------------------------------------------
// 显示名（B7 节）。这批用例的存在理由是两个真实缺陷：
//   首版把「糖糖姐」削成「糖」、「lyra粥粥姐」削成「lyra粥」、
//   「JoJo女士」削成「JoJ」，全是你自己的客户名。
// ---------------------------------------------------------------------------

test('显示名一律带地区前缀', () => {
  assert.equal(customerDisplayName('青海', '李婧李姐'), '青海李婧')
  assert.equal(customerDisplayName('美国', '糖糖姐'), '美国糖糖姐')
  assert.equal(customerDisplayName('美国', '郭玮丹女士'), '美国郭玮丹女士')
})

test('台湾香港澳门须带「中国」前缀', () => {
  assert.equal(normalizeRegion('台湾'), '中国台湾')
  assert.equal(normalizeRegion('香港'), '中国香港')
  assert.equal(normalizeRegion('澳门'), '中国澳门')
  assert.equal(customerDisplayName('台湾', '廖丞婕廖姐'), '中国台湾廖丞婕')
  assert.equal(regionScopeOf('中国台湾'), 'special-region')
  assert.equal(regionScopeOf('中国香港'), 'special-region')
})

test('地区层级用于列表筛选分组', () => {
  assert.equal(regionScopeOf('美国'), 'overseas')
  assert.equal(regionScopeOf('意大利'), 'overseas')
  assert.equal(regionScopeOf('青海'), 'domestic')
  assert.equal(regionScopeOf('云南大理'), 'domestic')
})

test('与姓重复的尊称后缀须裁掉', () => {
  assert.equal(customerShortName('李月秋李姐'), '李月秋')
  assert.equal(customerShortName('王群王姐'), '王群')
  assert.equal(customerShortName('水志艳水姐'), '水志艳')
  assert.equal(customerShortName('韩娅婧韩姐'), '韩娅婧')
  assert.equal(customerShortName('李婧李姐'), '李婧')
})

test('叠字昵称不得被削（反例：糖糖姐、粥粥姐、JoJo）', () => {
  assert.equal(customerShortName('糖糖姐'), '糖糖姐')
  assert.equal(customerShortName('lyra粥粥姐'), 'lyra粥粥姐')
  assert.equal(customerShortName('JoJo女士'), 'JoJo女士')
  assert.equal(customerShortName('甜甜'), '甜甜')
  // 这三条才真正触达叠字保护分支：core 长度 >=3 且尾字与前字相同
  assert.equal(customerShortName('王小甜甜姐'), '王小甜甜姐')
  assert.equal(customerShortName('刘大壮壮总'), '刘大壮壮总')
})

test('单姓加尊称不被裁，繁体姓名保持原样', () => {
  assert.equal(customerShortName('树女士'), '树女士')
  assert.equal(customerShortName('李总'), '李总')
  assert.equal(customerShortName('吳亭瑤'), '吳亭瑤')
  assert.equal(customerShortName('蕭兆媛'), '蕭兆媛')
})

test('短名残留的地区前缀须剥掉，避免重复拼接', () => {
  // 梵禾成都乔哥 群解析出的姓名自带地区，曾拼成「成都成都乔哥」
  assert.equal(customerShortName('成都乔哥', '成都'), '乔哥')
  assert.equal(customerDisplayName('成都', '成都乔哥'), '成都乔哥')
  // 规范化后的地区名也要能剥：台湾 -> 中国台湾
  assert.equal(customerDisplayName('台湾', '台湾郑哥'), '中国台湾郑哥')
})

test('同一客户多项目时追加项目后缀区分', () => {
  assert.equal(customerDisplayName('秦皇岛', '肖女士'), '秦皇岛肖女士')
  assert.equal(customerDisplayName('秦皇岛', '肖女士', '阿那亚三期'), '秦皇岛肖女士（阿那亚三期）')
})
