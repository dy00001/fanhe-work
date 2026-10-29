/**
 * 存档解析层的测试。
 *
 * 这一层是「聊天事实」的唯一来源，它的错都不会报错，只会让界面上的数字慢慢变成
 * 另一种东西：
 *
 *   1. **消息条数取错** → 客户列表上的「628 条消息」变少，看起来像「这个客户
 *      删了消息」，实际是正则漏了几行；
 *   2. **空值字段吞了下一行** → `合同金额:` 为空时取到下一行的 `已收金额: 0`，
 *      于是每轮同步都在改一个不该被碰的数字；
 *   3. **把金额读进来** → md 里 `合同金额: 13847391188` 实际是手机号，一旦进了
 *      同步链路，人工核对过的合同额每天被一个电话号码覆盖。这条最容易发生，
 *      因为「顺手把 frontmatter 整个读进来」看起来是最自然的写法。
 *
 * 样本全部取自真实文件（`包头李月秋李姐VIP设计沟通群.md`）的形状，包括那两个
 * 并列的 frontmatter 块与其中的脏金额。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { parseArchiveText, readArchiveDir, listArchiveFiles } from '../src/customer/archive.js'

/**
 * 真实文件的骨架：第一块是业务字段（`ai_stage`、金额），第二块是身份字段
 * （`username`、`msg_count`）。两块都以 `---` 包裹，彼此独立。
 *
 * `合同金额: 13847391188` 是真身 —— 那是「李姐」的手机号，被早期抽取脚本当成了
 * 合同额。任何把它读进来的实现都会被下面那条断言挡住。
 */
const SAMPLE = `---
阶段: 已下单
ai_stage: 已下单
ai_profile: "项目:橱柜/木门/餐边柜；预算线索:1738118852；关注:售后/尺寸/风格/颜色"
ai_stage_conf: 0.79
ai_schema: 1.2
合同金额: 13847391188
已收金额: 157
未收金额: 13847391031
金额置信: 0.7
复购: 是
---
---
title: 包头李月秋李姐VIP设计沟通群
tags:
  - 客户聊天记录
  - 群聊
  - VIP设计沟通
date_created: 2026-08-14
date_updated: 2026-10-28
msg_count: 628
date_range: 2026-07-13 11:15 ~ 2026-10-28 11:48
wechat_account: 账号2
username: 56024028793@chatroom
---

# 包头李月秋李姐VIP设计沟通群

> 微信群聊聊天记录 | 账号2 | 共 628 条消息
> 时间范围: 2026-07-13 11:15 ~ 2026-10-28 11:48
> 已跳过 100 条图片消息（按用户要求不提取图片）
> 已跳过 6 条媒体消息（视频/文件/链接等）
> 语音消息 5 条，已转录

## 聊天记录

| 时间 | 发送人 | 内容 |
|------|--------|------|
| 2026-07-13 11:15 | 系统 | "乐乐"邀请你和"秋、梵禾安装售后部1738118852"加入了群聊 |
| 2026-07-13 11:15 | 乐乐 | 李姐这是你的专属VIP设计沟通群 以后就在这个群沟通设计交流以及安装。[愉快] |
| 2026-10-28 11:48 | 李姐 | 好的，那就按这个报价来 |
`

describe('存档解析', () => {
  test('抽出聊天事实：条数、首末时间、跳过数、AI 阶段', () => {
    const stats = parseArchiveText(SAMPLE, '包头李月秋李姐VIP设计沟通群.md')

    assert.equal(stats.chatroom, '56024028793@chatroom')
    assert.equal(stats.baseName, '包头李月秋李姐VIP设计沟通群')
    // 文件名带 `.md`：库里 53 条存的就是这个形态，剥掉会让每轮同步都判定「全部有变化」。
    assert.equal(stats.file, '包头李月秋李姐VIP设计沟通群.md')

    // 表格里实际 3 行消息，而 frontmatter 声明 628 —— 声明值是抓取脚本自己写的，
    // 两者不一致时以行为准，同时把声明值带出来供对账。
    assert.equal(stats.msgRows, 3)
    assert.equal(stats.declaredMsgCount, 628)

    assert.equal(stats.firstMessageAt, '2026-07-13 11:15')
    assert.equal(stats.lastMessageAt, '2026-10-28 11:48')
    assert.equal(stats.skipImg, 100)
    assert.equal(stats.skipVoice, 5)
    assert.equal(stats.aiStage, '已下单')
    assert.equal(stats.aiStageConf, 0.79)
  })

  test('两块 frontmatter 各管各的，不会串', () => {
    const stats = parseArchiveText(SAMPLE, 'x.md')
    // `username` 只在第二块，`ai_stage` 只在第一块。用整份文本做一次正则搜索的
    // 实现会把两者都取到（因为都在同一份文本里），但第二块里没有 ai_stage 时
    // 就会取到 `阶段`，从而把「人工填的阶段」当成「AI 判断」。
    assert.equal(stats.chatroom, '56024028793@chatroom')
    assert.equal(stats.aiStage, '已下单')
    assert.equal(stats.declaredMsgCount, 628)
  })

  test('空值字段不吃下一行 —— 这是 `\\s*` 与 `[ \\t]*` 的差别', () => {
    const text = `---
ai_schema: 1.2
合同金额:
已收金额: 0
ai_stage: 方案设计
---
`
    const stats = parseArchiveText(text, 'y.md')
    // 取错时的表现：aiStage 变成「已收金额: 0」之类，或直接取不到。
    assert.equal(stats.aiStage, '方案设计')
    assert.equal(stats.chatroom, null)
  })

  test('金额一律不读进解析结果 —— 那里是手机号，不是钱', () => {
    const stats = parseArchiveText(SAMPLE, 'x.md')
    const serialized = JSON.stringify(stats)
    // 13847391188 是样本里的「合同金额」，实际是手机号。它出现在解析结果里，
    // 就说明金额被带进了同步链路，人工核过的合同额迟早会被它覆盖。
    assert.equal(serialized.includes('13847391188'), false)
    assert.equal(serialized.includes('157'), false)
    // 字段层面也不该有金额键：将来有人加了一个 `contractFen` 也能被这条挡住。
    assert.equal(
      Object.keys(stats).some((key) => /amount|contract|received|finance/i.test(key)),
      false,
    )
  })

  test('空文件：0 条消息、时间为 null，且声明值不冒充实际值', () => {
    const text = `---
ai_stage: 已下单
---
---
username: 111@chatroom
msg_count: 628
---
`
    const stats = parseArchiveText(text, 'empty.md')
    assert.equal(stats.msgRows, 0)
    assert.equal(stats.firstMessageAt, null)
    assert.equal(stats.lastMessageAt, null)
    // 声明值照实带出，但它不参与任何判断 —— 下游按 `msgRows === 0` 判定空文件。
    assert.equal(stats.declaredMsgCount, 628)
  })

  test('没有 username 的文件认成「不是客户群」，并单独计数', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanhe-archive-'))
    try {
      fs.writeFileSync(
        path.join(dir, '某客户VIP设计沟通群.md'),
        '---\nusername: 222@chatroom\nmsg_count: 2\n---\n\n| 时间 | 发送人 | 内容 |\n| 2026-10-01 10:00 | 甲 | 在吗 |\n',
        'utf8',
      )
      // 同目录下还有「客户关注点总结」这种汇总文档，它没有 username。
      fs.writeFileSync(path.join(dir, '客户关注点总结.md'), '# 汇总\n没有 frontmatter\n', 'utf8')

      assert.deepEqual(listArchiveFiles(dir), ['客户关注点总结.md', '某客户VIP设计沟通群.md'])

      const result = readArchiveDir(dir)
      assert.equal(result.stats.length, 1)
      assert.equal(result.stats[0]?.msgRows, 1)
      assert.equal(result.failures.length, 1)
      assert.equal(result.failures[0]?.reason, 'no_chatroom')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
