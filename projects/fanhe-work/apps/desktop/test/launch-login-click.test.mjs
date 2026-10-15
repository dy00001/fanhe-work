/**
 * §2.4「唤起后点登录」的回归测试。
 *
 * 钉的是两件事：**按软件开关**这一决策（qq / qianniu 开，wechat / custom / 未知关），
 * 与**平台守门**（非 Windows 连窗口操作都不发生）。窗口操作那段 PowerShell 只在
 * Windows 上、且只在已开软件上执行 —— 单测不真正调起它（沙箱非 Windows，且不该依赖
 * 外部客户端窗口），只断言脚本产物包含正确的 pid、Enter 虚拟键码与置前台的 P/Invoke。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { platform } from 'node:os'

import { buildLoginClickScript, clickLoginAfterLaunch, shouldClickLogin } from '../src/launch-login-click.ts'

test('shouldClickLogin：qq 与 qianniu 默认开', () => {
  assert.equal(shouldClickLogin('qq'), true)
  assert.equal(shouldClickLogin('qianniu'), true)
})

test('shouldClickLogin：wechat 只唤起、不点登录', () => {
  assert.equal(shouldClickLogin('wechat'), false)
})

test('shouldClickLogin：custom 与未知软件默认关', () => {
  assert.equal(shouldClickLogin('custom'), false)
  assert.equal(shouldClickLogin('something-new'), false)
  assert.equal(shouldClickLogin(''), false)
})

test('buildLoginClickScript：把目标 pid 注入脚本', () => {
  const script = buildLoginClickScript(4242)
  assert.ok(script.includes('4242'), '脚本应包含目标 pid')
})

test('buildLoginClickScript：包含「置前台 + 敲 Enter」的关键调用', () => {
  const script = buildLoginClickScript(99)
  assert.ok(script.includes('SetForegroundWindow'), '应带到前台')
  assert.ok(script.includes('EnumWindows'), '应枚举顶层窗口按 pid 挑')
  assert.ok(script.includes('keybd_event'), '应发送按键')
  assert.ok(script.includes('0x0D'), 'Enter 的虚拟键码 VK_RETURN 应为 0x0D')
  assert.ok(script.includes('Write-Output'), '应通过 stdout 回报状态')
})

test('clickLoginAfterLaunch：非 Windows 直接拦下、不操作窗口', async () => {
  // 沙箱是 linux/darwin，平台守门应在到达 PowerShell 之前返回，不抛、不卡。
  if (platform() === 'win32') return
  const result = await clickLoginAfterLaunch('qq', 1234)
  assert.deepEqual(result, { attempted: false, reason: 'unsupported-platform' })
})

test('clickLoginAfterLaunch：关掉的软件（wechat）即使有 pid 也不点', async () => {
  const result = await clickLoginAfterLaunch('wechat', 1234)
  assert.equal(result.attempted, false)
  assert.equal(result.reason, 'disabled')
})
