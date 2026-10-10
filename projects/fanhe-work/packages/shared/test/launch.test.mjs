/**
 * 启动配置取值规则的回归测试。
 *
 * 直接跑构建产物 dist，不跑源码，与 permissions.test.mjs 的理由一致：服务端校验
 * 用的是 dist 里的那份代码，测它才是测真实生效的那份。
 *
 * 这两个函数值得单独测，是因为它们的判断结果不会在界面上直接显现。`isLaunchSoftware`
 * 判错的表现是「列表里某几行图标空白」，`isAbsoluteExecutablePath` 判松了则要等到
 * 用户点击启动、子进程报「找不到文件」时才暴露 —— 那时已经看不出是当初存进去的路径
 * 就有问题。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LAUNCH_SOFTWARES, isAbsoluteExecutablePath, isLaunchSoftware } from '../dist/index.js'

test('盘符路径被认作绝对路径', () => {
  assert.equal(isAbsoluteExecutablePath('C:\\Program Files\\App\\app.exe'), true)
  // 正斜杠也要认：Windows 的 API 两者都接受，用户从别处复制来的路径可能是这种写法。
  assert.equal(isAbsoluteExecutablePath('C:/Program Files/App/app.exe'), true)
  assert.equal(isAbsoluteExecutablePath('d:\\app.exe'), true)
})

test('UNC 路径被认作绝对路径', () => {
  assert.equal(isAbsoluteExecutablePath('\\\\server\\share\\app.exe'), true)
})

test('Unix 绝对路径被认作绝对路径', () => {
  assert.equal(isAbsoluteExecutablePath('/usr/bin/app'), true)
  assert.equal(isAbsoluteExecutablePath('/'), true)
})

test('相对路径一律被拒绝', () => {
  for (const value of ['app.exe', './app.exe', '../app.exe', 'tools\\app.exe', '']) {
    assert.equal(isAbsoluteExecutablePath(value), false, `应被拒绝：${JSON.stringify(value)}`)
  }
})

test('只有盘符而没有分隔符不算绝对路径', () => {
  // `C:` 在 Windows 上指的是「当前目录所在的盘」，`C:app.exe` 是相对路径。
  // 正则要求盘符后必须跟一个分隔符，正是为了挡住这两种写法。
  assert.equal(isAbsoluteExecutablePath('C:'), false)
  assert.equal(isAbsoluteExecutablePath('C:app.exe'), false)
})

test('软件标识只认清单内的取值', () => {
  for (const value of LAUNCH_SOFTWARES) {
    assert.equal(isLaunchSoftware(value), true, `应被接受：${value}`)
  }
})

test('软件标识严格匹配，不做大小写归一', () => {
  // 这些值是程序内部标识，由界面从清单里选出来，不存在用户手输大小写的场景。
  // 归一反而会掩盖「清单改过名、库里的旧值没跟着迁」这类问题。
  for (const value of ['WeChat', 'WECHAT', 'custom ', ' custom', 'telegram', '']) {
    assert.equal(isLaunchSoftware(value), false, `应被拒绝：${JSON.stringify(value)}`)
  }
})
