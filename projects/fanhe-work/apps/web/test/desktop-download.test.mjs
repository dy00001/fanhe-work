import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { DESKTOP_DOWNLOAD_LABEL, DESKTOP_RELEASES_URL } from '../src/lib/desktop-download.ts'

const here = dirname(fileURLToPath(import.meta.url))
const builderConfig = readFileSync(join(here, '../../desktop/electron-builder.yml'), 'utf8')

/** 从 `electron-builder.yml` 的 publish 段里取 owner 与 repo。 */
function publishTarget() {
  const owner = /^\s{2}owner:\s*(\S+)$/m.exec(builderConfig)?.[1]
  const repo = /^\s{2}repo:\s*(\S+)$/m.exec(builderConfig)?.[1]
  assert.ok(owner !== undefined, 'electron-builder.yml 里找不到 publish.owner')
  assert.ok(repo !== undefined, 'electron-builder.yml 里找不到 publish.repo')
  return { owner, repo }
}

test('下载地址指向打包配置里声明的那个仓库', () => {
  const { owner, repo } = publishTarget()
  assert.ok(
    DESKTOP_RELEASES_URL.includes(`/${owner}/${repo}/`),
    `下载地址 ${DESKTOP_RELEASES_URL} 与 publish 目标 ${owner}/${repo} 不一致`,
  )
})

/**
 * 指向发布页而不是某个带版本号的 exe，是本模块存在的主要判断。
 *
 * 这条断言的价值不在「字符串长什么样」，而在于**把那个判断固定下来**：哪天有人
 * 觉得「直接下 exe 更省一次点击」而改成拼版本号，他会先在这里看到理由。
 */
test('指向 latest 而不是固定版本号的安装包', () => {
  assert.match(DESKTOP_RELEASES_URL, /\/releases\/latest$/)
  assert.doesNotMatch(DESKTOP_RELEASES_URL, /fanhe-work-setup-[\d.]+\.exe$/)
})

test('文案里写明只有 Windows 安装包', () => {
  assert.match(DESKTOP_DOWNLOAD_LABEL, /Windows/)
})
