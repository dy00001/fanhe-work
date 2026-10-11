/**
 * 浏览器级端到端验证：首次初始化 → 登录（勾选记住账号密码）→ 主界面 → 导航过滤 →
 * 切换模块 → 静默续期 → 直接访问子路由 → 未知路径落到 404 页 → 折叠偏好跨刷新保持 →
 * 主题切换与跨刷新保持 → 登出 → 重新打开后凭据自动带出 → 取消勾选后凭据被清除 →
 * 启动通道的新增、编辑、排序、启动与删除，以及路径失效的提示、重新指定入口与
 * 启动记录的摘要。
 *
 * 为什么需要它：类型检查、生产构建与 HTTP 契约测试都覆盖不到渲染层。React 在
 * 运行期抛错时，构建照样通过、接口照样返回 200，只有页面会白掉 —— 这类故障
 * 前面三道关卡一个都拦不住。本脚本把页面里的未捕获异常与 console.error 全部
 * 收集起来，在末尾断言为零，这是自动化里唯一能覆盖那一层的做法。
 *
 * 不下载 Chromium：直接驱动本机已安装的 Chrome 或 Edge，走 DevTools 协议。
 * Node 22 自带 WebSocket 与 fetch，因此没有任何第三方依赖。
 *
 * 覆盖不到的部分：**四种角色的可见范围差异**。造出另外三个角色的账号需要账号
 * 管理接口（阶段三），本脚本只能验证 owner 这一种角色的渲染结果。四种角色的
 * 过滤结果由 packages/shared/test/navigation.test.mjs 逐条钉死。
 *
 * 前置条件（三条都满足才能跑）：
 *   1. 数据库处于「未初始化」状态，即 users 表为空。否则首次初始化页不会出现，
 *      第 1 项必然失败。重置方法：
 *        docker exec fanhe-work-db psql -U fanhe -d fanhe_work -c \
 *          "delete from notes; delete from launch_history; delete from launch_profiles; delete from refresh_tokens; delete from audit_logs; delete from login_attempts; delete from users;"
 *      启动配置与工作纪要要一起清掉：两者的删除都是软删除，跑完之后 `launch_profiles`
 *      与 `notes` 里会留下几行 `deletedAt` 非空的记录，不清的话下一次跑会带着这些行
 *      进来。启动记录跟着配置走（外键级联），显式写出来是因为它才是那张会不断增长的
 *      表；`notes` 排在 `users` 之前是因为它的外键指向 users，反过来会撞约束。
 *   2. 启动 API 时把访问令牌有效期压短，否则续期要等 15 分钟才发生，观察窗口
 *      内什么也看不到：
 *        ACCESS_TOKEN_TTL_SECONDS=60 pnpm dev:api
 *   3. 前端 dev server 在跑：pnpm dev
 *
 * 用法：node test/e2e-auth.mjs [应用地址] [截图目录]
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5173'
const SHOT_DIR = process.argv[3] ?? 'e2e-shots'
const CDP_PORT = 9222

/** 本次验证创建的账号。带 zz_ 前缀，便于与真实数据区分和清理。 */
const OWNER = {
  username: 'zz_e2e_owner',
  password: 'e2e-browser-password-1',
  displayName: '浏览器验证',
}

/** 续期检查能容忍的最大访问令牌有效期。超过它就等不到刷新请求。 */
const MAX_OBSERVABLE_TTL_SECONDS = 65

/** 本次验证创建的启动配置。名字带 zz_ 前缀，与真实配置区分。 */
const LAUNCH_PROFILE_A = { name: 'zz_e2e_微信', renamed: 'zz_e2e_微信改名' }
const LAUNCH_PROFILE_B = { name: 'zz_e2e_自定义' }

/**
 * 本次验证创建的纪要。
 *
 * 正文里同时放一个一级标题与一张 GFM 表格 —— 这两样只有在 Markdown 渲染器真的跑过
 * 之后才会变成元素，靠「文本里有没有这几个字」是证明不了渲染的：原文里本来就有。
 */
const NOTE_TITLE = 'zz_e2e_纪要'
const NOTE_BODY = '# 预览标题\n\n| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |\n'
const NOTE_TAG_A = 'zz_e2e_标签甲'
const NOTE_TAG_B = 'zz_e2e_标签乙'

/**
 * 一条形态合法但**一定不存在**的路径，用来验证「路径失效」的提示与重新指定入口。
 *
 * 用盘符写法而不是临时目录：客户端的形态校验只认盘符、UNC 与 `/` 开头的路径，而它
 * 不查文件是否存在（存在性只有服务端能查，且只有真正要启动的那一刻才有意义）。
 * 这样写在任何平台上都能通过表单校验，随后被服务端判为失效。
 */
const LAUNCH_PROFILE_MISSING = {
  name: 'zz_e2e_路径失效',
  path: 'C:\\zz_e2e_missing\\client.exe',
}

/**
 * 启动通道里被拉起的程序：当前这个 Node。
 *
 * 用 `process.execPath` 有三个好处：一定是绝对路径（表单校验要放行）、一定存在
 * （脚本能跑起来就说明它在）、参数让它立刻退出 —— 验证的是「工作台把一个进程创建
 * 出来了」，不需要真的拉起某个客户端，也就不会在跑完之后于机器上留下一堆窗口。
 */
const LAUNCH_TARGET_PATH = process.execPath
const LAUNCH_TARGET_ARGS = '-e\nprocess.exit(0)'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

function findBrowser() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path))
  if (!found) throw new Error('没有找到 Chrome 或 Edge')
  return found
}

/**
 * 浏览器 profile 的落点：真正的系统临时目录。
 *
 * **不能用 `os.tmpdir()`。** 经工作空间入口运行时，`TEMP` 与 `TMP` 已被重定向到 U 盘上
 * 的 `.tmp/`，`os.tmpdir()` 读的正是这两个变量，于是 profile 又落回了 U 盘 —— 注释里
 * 那条「不放 U 盘」的理由看起来成立，实际不成立。实测确认过：入口下 `os.tmpdir()`
 * 返回 `E:\fanhe Work\.tmp`。绕开被重定向的变量，改从 `LOCALAPPDATA` 推（它不在重定向
 * 映射表里）。非 Windows 环境退回 `os.tmpdir()`。
 *
 * 为什么在意落点：profile 里是 IndexedDB 与 localStorage 的后端文件，访问模式是随机
 * 小 IO，而工作空间在 U 盘上 —— 同一份 profile 落在 U 盘时打开一次 IndexedDB 要 5.8 秒，
 * 落在系统盘是毫秒级。这是项目约定「重型产物移出 U 盘」的一个具体落点。
 */
function systemTempDir() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) return join(localAppData, 'Temp')
  }
  return tmpdir()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

/** 页面里的 console.error 与未捕获异常。这两类只要有内容就说明渲染层出过问题。 */
const pageErrors = []
const pageLogs = []

async function waitForPageTarget() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 浏览器还没起来，继续等。
    }
    await sleep(250)
  }
  throw new Error('CDP 页面目标未就绪')
}

async function portInUse() {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
    return response.ok
  } catch {
    return false
  }
}

function createClient(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
      return
    }
    const handlers = listeners.get(message.method)
    if (handlers) for (const handler of handlers) handler(message.params)
  })

  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
    }),
    send(method, params = {}) {
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(handler)
    },
    once(method) {
      return new Promise((resolve) => {
        const handler = (params) => {
          listeners.get(method).delete(handler)
          resolve(params)
        }
        if (!listeners.has(method)) listeners.set(method, new Set())
        listeners.get(method).add(handler)
      })
    },
    close() {
      socket.close()
    },
  }
}

async function evaluate(client, expression) {
  const outcome = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (outcome.exceptionDetails) {
    const description =
      outcome.exceptionDetails.exception?.description ?? JSON.stringify(outcome.exceptionDetails)
    throw new Error(`页面内脚本抛错：${description}`)
  }
  return outcome.result.value
}

/** 在页面里轮询一个表达式，直到它为真。返回该表达式的值。 */
function waitFor(expression, timeoutMs, label) {
  return `new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let value = null
      try { value = (${expression}) } catch (error) { return reject(new Error(String(error))) }
      if (value) return resolve(value)
      if (Date.now() - started > ${timeoutMs}) return reject(new Error('等待超时：${label}'))
      setTimeout(tick, 100)
    }
    tick()
  })`
}

/**
 * 填受控输入。直接赋 value 不会触发 React 的 onChange，必须走原生 setter 再派发 input。
 *
 * setter 按元素类型取：`textarea` 的 value 描述符挂在 `HTMLTextAreaElement.prototype` 上，
 * 拿 `HTMLInputElement` 的那一份去调用会抛「Illegal invocation」。两者的用法完全一样，
 * 所以不另开一个函数 —— 调用方只需给出选择器。
 */
function fillInput(selector, value) {
  return `(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('找不到输入框 ' + ${JSON.stringify(selector)})
    const proto = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`
}

function clickSelector(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) throw new Error('找不到元素 ' + ${JSON.stringify(selector)})
    element.click()
    return true
  })()`
}

/**
 * 用浏览器的真实鼠标事件点击一个元素，坐标取元素中心。
 *
 * 别处都用 `element.click()`，那里够用：原生按钮、复选框、提交按钮都监听 click。
 * 但 Radix 的下拉菜单不是 —— 它在 `pointerdown` 上展开、在 `pointerup` 上选中，
 * 合成事件只派发 `click`，两个动作都不会发生。失败表现还是「找不到菜单项」，
 * 看起来像选择器写错了，实际是事件类型不对。所以这里走 CDP 的输入管线，
 * 让浏览器自己生成 pointerdown / mousedown / pointerup / mouseup / click 全套。
 *
 * @param finder 返回目标元素或 undefined 的页面内表达式
 * @param label  报错时用的名字
 */
async function mouseClick(client, finder, label) {
  const point = JSON.parse(
    await evaluate(
      client,
      `(() => {
        const element = ${finder}
        if (!element) throw new Error('找不到元素：' + ${JSON.stringify(label)})
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
          throw new Error('元素没有尺寸，点了也白点：' + ${JSON.stringify(label)})
        }
        return JSON.stringify({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        })
      })()`,
    ),
  )
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
  await client.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
  await client.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
}

/**
 * 点击左侧导航里的某一项。
 *
 * 按文本包含匹配，不用精确相等：导航按钮的文本里还带一个「开发中」标签，
 * `textContent` 是「系统设置开发中」这样的拼接结果。范围限定在 `nav` 元素内，
 * 避免命中内容区里同名的标题。
 *
 * 导航项在 T2-03 由 `button` 换成了 `NavLink`（渲染为 `a`）。`element.click()`
 * 仍然够用：react-router 的链接监听的是普通 `click`，与 Radix 那种依赖
 * `pointerdown` / `pointerup` 的组件不同，不需要 mouseClick 那套真实指针事件。
 */
function clickNavByLabel(label) {
  return `(() => {
    const link = [...document.querySelectorAll('nav a')].find((item) => item.textContent.includes(${JSON.stringify(label)}))
    if (!link) throw new Error('找不到导航项 ' + ${JSON.stringify(label)})
    link.click()
    return true
  })()`
}

/**
 * 在启动通道的某一行里按文字点一个按钮。
 *
 * 先按行名定位那一行，再在行内找按钮 —— 直接用全局选择器会点到别的行：列表里每一行
 * 都有「启动」按钮，`[...document.querySelectorAll('button')].find(...)` 命中的永远是
 * 第一条，于是「点第二条的启动」这类断言会静默地测错对象。
 *
 * 行名用 `textContent.includes` 匹配而不是精确相等：一行的文本里还拼着软件标签与
 * 参数个数，整串比较不现实。名字都带 `zz_` 前缀，不会互相包含。
 */
function clickRowButton(rowName, buttonText) {
  return `(() => {
    const rows = [...document.querySelectorAll('main ul li')]
    const row = rows.find((item) => item.textContent.includes(${JSON.stringify(rowName)}))
    if (!row) throw new Error('找不到行：' + ${JSON.stringify(rowName)})
    const button = [...row.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(buttonText)})
    if (!button) throw new Error('这一行里找不到按钮：' + ${JSON.stringify(buttonText)})
    button.click()
    return true
  })()`
}

/**
 * 返回某一行里「更多操作」按钮的元素，交给 `mouseClick`。
 *
 * 菜单按钮走真实指针事件（理由见 `mouseClick`），所以这里只负责找到它，不负责点。
 */
function rowMenuFinder(rowName) {
  return `(() => {
    const rows = [...document.querySelectorAll('main ul li')]
    const row = rows.find((item) => item.textContent.includes(${JSON.stringify(rowName)}))
    if (!row) throw new Error('找不到行：' + ${JSON.stringify(rowName)})
    const button = [...row.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') ?? '').startsWith('更多操作'))
    if (!button) throw new Error('这一行没有更多操作按钮')
    return button
  })()`
}

/** 取某一行（按名称匹配）的整段文本。行不存在时返回空串，便于直接放进 `waitFor`。 */
function rowTextFinder(rowName) {
  return `(() => {
    const row = [...document.querySelectorAll('main ul li')].find((item) => item.textContent.includes(${JSON.stringify(rowName)}))
    return row ? row.textContent : ''
  })()`
}

/**
 * 某一行里**有没有**指定文案的按钮。
 *
 * 与 `clickRowButton` 的区别是它只回答「在不在」，用来断言入口本身 —— 比如路径失效
 * 时「重新指定路径」出现了、而「启动」不再出现。后者点不了，也就没法用点击去证明。
 */
function rowHasButtonFinder(rowName, buttonText) {
  return `(() => {
    const row = [...document.querySelectorAll('main ul li')].find((item) => item.textContent.includes(${JSON.stringify(rowName)}))
    if (!row) return false
    return [...row.querySelectorAll('button')].some((item) => item.textContent.trim() === ${JSON.stringify(buttonText)})
  })()`
}

/**
 * 某一行里有没有一个文字恰好是 `text` 的徽标。
 *
 * **不能用「行文本包含某几个字」来代替这个判断。** 这里要断言的徽标文字是「路径失效」，
 * 而配置名完全可以带着同样的字（本次验证用的那条名字就叫 `zz_e2e_路径失效`），于是
 * 「文本包含」在徽标消失之后依然为真 —— 断言永远通过，等于没测。按元素与精确文字判断
 * 才是这里真正想表达的意思。
 */
function rowBadgeFinder(rowName, text) {
  return `(() => {
    const row = [...document.querySelectorAll('main ul li')].find((item) => item.textContent.includes(${JSON.stringify(rowName)}))
    if (!row) return false
    return [...row.querySelectorAll('[data-slot="badge"]')].some((item) => item.textContent.trim() === ${JSON.stringify(text)})
  })()`
}

/**
 * 在内容区里按文字点一个按钮。
 *
 * **范围限定在 `main` 内。** 对话框走 portal 挂到 body 上，因此确认类按钮不在 `main`
 * 里 —— 编辑器的「删除」与确认框的「删除」正好靠这条边界区分开：前者在内容区，
 * 后者只在对话框里。不加这层限定的话，`main` 里那个会被先命中，于是「点确认」实际
 * 点的是「打开确认框」，表现是对话框一直开着而脚本报「等待超时」。
 *
 * 文本用精确相等而不是包含：这些按钮都是一个词，`trim()` 后即可比较；而用包含匹配
 * 时「未归档」会被「已归档」抢先命中 —— 后者在 DOM 里更靠前。
 */
function clickMainButton(text) {
  return `(() => {
    const button = [...document.querySelectorAll('main button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)})
    if (!button) throw new Error('内容区里找不到按钮：' + ${JSON.stringify(text)})
    if (button.disabled) throw new Error('按钮是禁用态：' + ${JSON.stringify(text)})
    button.click()
    return true
  })()`
}

/** 内容区里**有没有**指定文字的按钮。用来断言一个点不动的入口在不在。 */
function mainHasButtonFinder(text) {
  return `[...document.querySelectorAll('main button')].some((item) => item.textContent.trim() === ${JSON.stringify(text)})`
}

/** 按文字点对话框里的按钮。对话框在 portal 里，因此不限定在 `main` 内。 */
function clickDialogButton(text) {
  return `(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)})
    if (!button) throw new Error('对话框里找不到按钮：' + ${JSON.stringify(text)})
    button.click()
    return true
  })()`
}

/**
 * 点工作纪要列表里的一行。
 *
 * 行本身就是那个按钮（结构是 `<li><button>`），因此按行内文本找按钮即可。行名用
 * `includes` 匹配而不是精确相等：行里还拼着标签与更新时间，整串比较不现实。
 */
function clickNoteRow(title) {
  return `(() => {
    const row = [...document.querySelectorAll('main ul li button')].find((item) => item.textContent.includes(${JSON.stringify(title)}))
    if (!row) throw new Error('找不到纪要行：' + ${JSON.stringify(title)})
    row.click()
    return true
  })()`
}

/** 按文字找到当前展开的下拉菜单项。 */
function menuItemFinder(text) {
  return `[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes(${JSON.stringify(text)}))`
}

/**
 * 打开某一行的操作菜单。
 *
 * 点之前必须先确认「没有浮层还开着」。Radix 的对话框与下拉菜单在关闭动画期间仍留在
 * DOM 里：对话框的全屏遮罩会吃掉这一击，菜单触发器在自身关闭动画未结束时也会忽略
 * 点击。两种情况的失败表现都是「菜单没打开」，而单跑这一段又往往正常 —— 因为那时
 * 没有前一步留下的浮层，所以它是个只在完整流程里出现的时序问题。
 */
async function openRowMenu(client, rowName) {
  await evaluate(
    client,
    waitFor(`document.querySelector('[role="dialog"]') === null`, 5000, '对话框关闭'),
  )
  await evaluate(
    client,
    waitFor(`document.querySelector('[role="menuitem"]') === null`, 5000, '下拉菜单关闭'),
  )
  await mouseClick(client, rowMenuFinder(rowName), `更多操作：${rowName}`)
  await evaluate(
    client,
    waitFor(`document.querySelector('[role="menuitem"]') !== null`, 5000, '操作菜单展开'),
  )
}

/** 启动通道列表里各行的文本，用于判断顺序。 */
const ROW_TEXTS = `JSON.stringify([...document.querySelectorAll('main ul li')].map((item) => item.textContent))`

/**
 * 在页面里挂钩 fetch，统计发往 /api/auth/ 的请求，并记下登录响应里的令牌有效期。
 *
 * 续期是否真的发生，从界面外观上看不出来 —— 令牌有效期内界面本来就正常。唯一
 * 的直接证据是刷新请求确实发出去了，所以在这里计数而不是靠「等一会儿看有没有
 * 掉线」。后者在令牌尚未过期时必然通过，是个假阳性。
 *
 * 顺手取 expiresIn 是为了让「有效期没压短」这件事能被直接报出来，而不是表现成
 * 一句没头没尾的「等待超时」。
 */
const INSTALL_PROBE = `(() => {
  if (window.__e2e) return true
  const state = { authCalls: [], refreshCalls: 0, refreshAt: null, loginExpiresIn: null, loginAt: null }
  window.__e2e = state
  const original = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const response = await original(input, init)
    if (url.includes('/api/auth/')) {
      state.authCalls.push(url.replace(location.origin, ''))
      if (url.includes('/api/auth/refresh')) {
        state.refreshCalls += 1
        if (state.refreshAt === null) state.refreshAt = Date.now()
      }
      if (url.includes('/api/auth/login') && response.ok) {
        try {
          const body = await response.clone().json()
          state.loginExpiresIn = body.expiresIn
          // 登录成功的时刻必须记在探针里，不能由脚本在几步之后取当前时间：脚本那侧
          // 的取值点被中间的截图与断言推后了若干秒，算出来的「登录后多久续期」会偏小，
          // 甚至变成负数。
          state.loginAt = Date.now()
        } catch {}
      }
    }
    return response
  }
  return true
})()`

/**
 * 首帧侧栏宽度采样器。用 `Page.addScriptToEvaluateOnNewDocument` 注入，因此它比
 * 应用脚本更早开始跑 —— 这是它唯一的价值，也是不能用 `Runtime.evaluate` 替代的原因：
 * 后者只能在文档加载完之后执行，那时该渲染的帧早就渲染过了。
 *
 * **存在的理由是区分两种都能通过事后断言的实现。** 折叠偏好的验收点是「刷新后保持
 * 上次状态」，而把读取放进 `useEffect` 同样满足它：界面先按默认的展开态渲染一帧，
 * 再跳到折叠态，等一会儿再看宽度确实是 64px。用户那边看到的是每次刷新都闪一下展开
 * 的侧栏，而断言全绿。要分辨这两种写法，只能看**第一个出现侧栏的帧**有多宽。
 *
 * 逐帧记录而不是只记第一帧：万一将来出现别的闪烁来源，报错时把前几帧打出来比
 * 只有一个数字好定位。上限 30 帧或 10 秒，避免采样循环一直挂着 —— 外壳要等一次
 * 「初始化状态 + 静默续期」的往返才挂载，光靠帧数上限可能还没等到侧栏出现。
 */
const SIDEBAR_WIDTH_PROBE = `(() => {
  const samples = []
  window.__sidebarWidths = samples
  const started = Date.now()
  const tick = () => {
    const aside = document.querySelector('aside')
    if (aside) samples.push(Math.round(aside.getBoundingClientRect().width))
    if (samples.length >= 30 || Date.now() - started > 10000) return
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

/** 侧栏折叠偏好的键。与 `src/lib/preferences.ts` 里的常量必须一致。 */
const SIDEBAR_COLLAPSED_KEY = 'fanhe-work.ui.sidebar-collapsed'

/** 主题偏好的键。同样与 `src/lib/preferences.ts` 保持一致。 */
const THEME_KEY = 'fanhe-work.ui.theme'

/**
 * 首帧配色采样器。与 `SIDEBAR_WIDTH_PROBE` 同一手法、同一理由，只是量的东西不同：
 * 「刷新后还是深色」这句话同样不足以成为判据，把应用放进 `useEffect` 也能满足它，
 * 代价是每次刷新先闪一帧浅色。
 *
 * 量的是 `<html>` 上有没有 `dark` 类，而不是背景色：类名是应用自己写下的意图，
 * 背景色还取决于样式表有没有加载完 —— 样式到位之前 `body` 背景是透明的，量出来
 * 会是一个与主题无关的值，那样的断言看起来在测主题，实际在测 CSS 的加载时机。
 *
 * 这里还额外验证了一件事：主题的初值不在 React 里，而在 `index.html` 的内联脚本里
 * （配色要在第一个像素上就对，那时 React 还没挂载）。注入的这段脚本比内联脚本更早
 * 跑，所以它采到的第一帧正是内联脚本判定的结果。
 */
const THEME_FRAME_PROBE = `(() => {
  const samples = []
  window.__themeFrames = samples
  const started = Date.now()
  const tick = () => {
    samples.push(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    if (samples.length >= 30 || Date.now() - started > 10000) return
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

async function screenshot(client, name) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
  const path = resolve(SHOT_DIR, `${name}.png`)
  await writeFile(path, Buffer.from(data, 'base64'))
  console.log(`     截图 ${path}`)
  return path
}

/** 跑之前先确认库是干净的，否则第 1 项必然失败，而失败原因不在脚本里。 */
async function assertUninitialized() {
  const response = await fetch(new URL('/api/setup/status', APP_URL))
  if (!response.ok) throw new Error(`取初始化状态失败：HTTP ${response.status}`)
  const body = await response.json()
  if (body.initialized) {
    throw new Error(
      '数据库已经完成初始化，首次初始化页不会出现。先重置再跑：\n' +
        '  docker exec fanhe-work-db psql -U fanhe -d fanhe_work -c \\\n' +
        '    "delete from notes; delete from launch_profiles; delete from refresh_tokens; delete from audit_logs; delete from login_attempts; delete from users;"',
    )
  }
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true })
  await assertUninitialized()

  if (await portInUse()) {
    throw new Error(`端口 ${CDP_PORT} 已有浏览器在监听。先关掉它，或改脚本里的 CDP_PORT。`)
  }

  // 每次用全新 profile，保证 localStorage 干净，也让断言不依赖上一次运行的残留。
  // 落点的选择与理由见 `systemTempDir()`。
  //
  // 必须是绝对路径。传相对路径时 Chrome 不会报参数错误，而是弹一个模态对话框
  // 说「无法对其数据目录执行读写操作」，然后卡在那里等用户点确定 —— 调试端口
  // 始终不开，外部只看到「CDP 目标未就绪」，看不出真正原因。
  const userDataDir = join(systemTempDir(), `fanhe-work-e2e-${process.pid}`)
  await rm(userDataDir, { recursive: true, force: true })

  const browserPath = findBrowser()
  console.log(`浏览器 ${browserPath}`)
  console.log(`应用   ${APP_URL}\n`)

  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: false },
  )

  // 浏览器自己的输出要留下。它起不来时唯一的线索通常在这里，丢掉就只能看到
  // 一句「目标未就绪」，无从判断是参数问题还是启动失败。
  browser.stdout.on('data', (chunk) => process.stdout.write(`[浏览器] ${chunk}`))
  browser.stderr.on('data', (chunk) => process.stdout.write(`[浏览器] ${chunk}`))

  let client
  try {
    const target = await waitForPageTarget()
    client = createClient(target.webSocketDebuggerUrl)
    await client.ready

    // 先挂监听再导航，否则首屏渲染期的异常会漏掉。
    client.on('Runtime.exceptionThrown', (params) => {
      const detail = params.exceptionDetails
      pageErrors.push(`[未捕获] ${detail.exception?.description ?? detail.text}`)
    })
    client.on('Runtime.consoleAPICalled', (params) => {
      const text = params.args
        .map((arg) => arg.value ?? arg.description ?? arg.preview?.description ?? '')
        .join(' ')
      if (params.type === 'error') pageErrors.push(`[console.error] ${text}`)
      else pageLogs.push(`[${params.type}] ${text}`)
    })
    client.on('Log.entryAdded', (params) => {
      const entry = params.entry
      // 只记录不判错。故意用错密码那一步会返回 401，浏览器把它记成一条 error 级
      // 日志，但那是预期行为，不是缺陷。
      if (entry.level === 'error') pageLogs.push(`[日志错误] ${entry.text} ${entry.url ?? ''}`)
    })

    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Log.enable')

    const loaded = client.once('Page.loadEventFired')
    await client.send('Page.navigate', { url: APP_URL })
    await loaded

    // 1. 空库状态下应停在首次初始化页。
    await evaluate(
      client,
      waitFor(`document.querySelector('#setup-username') !== null`, 20000, '初始化页'),
    )
    const setupText = await evaluate(client, 'document.body.innerText')
    record('空库时渲染首次初始化页', setupText.includes('创建超级管理员'), '')
    await screenshot(client, '1-setup')

    // 装上请求探针。之后的续期计数靠它。
    await evaluate(client, INSTALL_PROBE)

    // 2. 客户端校验：两次密码不一致应被拦下。
    await evaluate(client, fillInput('#setup-username', OWNER.username))
    await evaluate(client, fillInput('#setup-display-name', OWNER.displayName))
    await evaluate(client, fillInput('#setup-password', OWNER.password))
    await evaluate(client, fillInput('#setup-password-confirm', `${OWNER.password}-x`))
    await evaluate(client, clickSelector('button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="alert"]') !== null`, 5000, '校验提示'),
    )
    const mismatch = await evaluate(client, `document.querySelector('[role="alert"]').innerText`)
    record('两次密码不一致被客户端拦下', mismatch.includes('不一致'), mismatch)

    // 3. 改正后创建成功，应切到登录页。
    await evaluate(client, fillInput('#setup-password-confirm', OWNER.password))
    await evaluate(client, clickSelector('button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelector('#login-username') !== null`, 25000, '登录页'),
    )
    const loginText = await evaluate(client, 'document.body.innerText')
    record('初始化成功后切到登录页', loginText.includes('登录以继续'), '')
    await screenshot(client, '2-login')

    // 4. 错误密码应显示统一文案，且不透露账号是否存在。
    await evaluate(client, fillInput('#login-username', OWNER.username))
    await evaluate(client, fillInput('#login-password', 'definitely-wrong-password'))
    await evaluate(client, clickSelector('button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="alert"]') !== null`, 20000, '登录错误提示'),
    )
    const wrongText = await evaluate(client, `document.querySelector('[role="alert"]').innerText`)
    record('错误密码显示统一文案', wrongText.includes('用户名或密码不正确'), wrongText)
    await screenshot(client, '3-login-error')

    // 5. 勾选「记住账号密码」后用正确密码登录，应进入主界面。
    //
    //    判据是「已登录外壳挂上」而不是某段正文。T3-03 之前这里等的是工作台上的
    //    「权限点」诊断板块，而那块内容随启动通道落地已被移除 —— 等正文的断言会在
    //    内容改版时无声地失效（它等的那句话可能只是恰好还在）。账号菜单只存在于
    //    已登录外壳里，与当前落在哪个模块无关。
    await evaluate(client, clickSelector('#login-remember'))
    await evaluate(client, fillInput('#login-password', OWNER.password))
    await evaluate(client, clickSelector('button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[aria-label="账号菜单"]') !== null`, 25000, '主界面'),
    )
    record('登录成功后进入主界面', true, '')

    // 账号与角色从工作台搬到了顶栏账号菜单（诊断板块在 T3-03 移除），展开一次即可
    // 核对这两项。角色名取自共享包的 `ROLES`，与服务端引用同一份常量。
    await mouseClick(client, `document.querySelector('[aria-label="账号菜单"]')`, '账号菜单')
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="menuitem"]') !== null`, 5000, '账号菜单展开'),
    )
    const accountPanel = await evaluate(
      client,
      `document.querySelector('[role="menu"]')?.innerText ?? ''`,
    )
    record('账号菜单展示显示名', accountPanel.includes(OWNER.displayName), '')
    record('账号菜单展示角色名', accountPanel.includes('超级管理员'), '')
    // 收起菜单，后面的截图与断言保持在无浮层状态。再点一次触发器即可 toggle。
    await mouseClick(client, `document.querySelector('[aria-label="账号菜单"]')`, '账号菜单')

    // 5a. 凭据已加密落盘。断言三件事：结构只有约定的三个字段、不含账号明文、
    //     不含密码明文。只判断「存在」是不够的 —— 明文同样满足存在。
    //
    // 先等它出现再读。写入发生在登录成功之后，走的是 IndexedDB 取密钥加一次
    // AES-GCM 加密，比界面切到主界面要慢一点，直接读会读到还没写进去的空值。
    await evaluate(
      client,
      waitFor(`window.localStorage.getItem('fanhe-work.credential') !== null`, 10000, '凭据落盘'),
    )
    const storedCredential = await evaluate(
      client,
      `window.localStorage.getItem('fanhe-work.credential')`,
    )
    const credentialText = typeof storedCredential === 'string' ? storedCredential : ''
    let credentialFields = ''
    let credentialOk = false
    try {
      const payload = JSON.parse(credentialText)
      credentialFields = Object.keys(payload).sort().join(',')
      credentialOk =
        credentialFields === 'data,iv,v' &&
        !credentialText.includes(OWNER.password) &&
        !credentialText.includes(OWNER.username)
    } catch {
      credentialOk = false
    }
    record('记住的凭据以密文落盘，磁盘上无明文', credentialOk, `字段 ${credentialFields || '无'}`)

    await screenshot(client, '4-home')

    // 5b. 左侧导航按权限过滤。owner 同时持有 personal 与 system 两段权限，五项应当
    //     全部可见。四种角色的差异由 packages/shared/test/navigation.test.mjs 覆盖：
    //     造出另外三个角色的账号需要账号管理接口，那是阶段三的功能。
    const navLabels = JSON.parse(
      await evaluate(
        client,
        `JSON.stringify([...document.querySelectorAll('nav a')].map((item) => item.textContent.trim()))`,
      ),
    )
    record('owner 可见全部五个导航项', navLabels.length === 5, navLabels.join(' / '))
    record(
      '可见范围包含系统设置，即 system 段权限的体现',
      navLabels.some((label) => label.includes('系统设置')),
      '',
    )
    // 5b-2. 主框架尺寸。实施方案第五章给的是三个硬数字：侧栏展开 224px、折叠 64px、
    //       顶栏 56px。它们是布局基准，改错不会报错、不会白屏，只表现为界面比例不对，
    //       所以这里逐条钉住。取整数比较是因为过渡动画期间会读到小数宽度。
    const metrics = JSON.parse(
      await evaluate(
        client,
        `JSON.stringify({
          sidebar: document.querySelector('aside')?.getBoundingClientRect().width,
          header: document.querySelector('header')?.getBoundingClientRect().height,
        })`,
      ),
    )
    record('侧栏展开宽度 224px', metrics.sidebar === 224, `实测 ${metrics.sidebar}px`)
    record('顶栏高度 56px', metrics.header === 56, `实测 ${metrics.header}px`)

    // 5b-3. 折叠。折叠态只留图标，导航项名称改由气泡提示承担 —— 这是折叠后唯一的
    //       名称来源，所以顺带断言提示真的出来了，而不只是宽度变了。
    await evaluate(
      client,
      `(() => {
        const button = document.querySelector('aside button[aria-label="收起侧栏"]')
        if (!button) throw new Error('找不到收起按钮')
        button.click()
        return true
      })()`,
    )
    await evaluate(
      client,
      waitFor(
        `Math.round(document.querySelector('aside')?.getBoundingClientRect().width ?? 0) === 64`,
        5000,
        '侧栏折叠',
      ),
    )
    record('点击收起后侧栏宽度 64px', true, '')

    await evaluate(
      client,
      `(() => {
        const item = document.querySelector('nav a')
        if (!item) throw new Error('找不到导航项')
        item.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
        item.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
        return true
      })()`,
    )
    let tooltipShown = true
    try {
      await evaluate(
        client,
        waitFor(
          `[...document.querySelectorAll('[data-slot="tooltip-content"]')].some((node) => node.offsetParent !== null)`,
          5000,
          '折叠态气泡提示',
        ),
      )
    } catch {
      tooltipShown = false
    }
    record('折叠态导航项有气泡提示', tooltipShown, '')
    await screenshot(client, '4d-sidebar-collapsed')

    // 展开回去。后续断言依赖导航项文字可见。
    await evaluate(
      client,
      `(() => {
        const button = document.querySelector('aside button[aria-label="展开侧栏"]')
        if (!button) throw new Error('找不到展开按钮')
        button.click()
        return true
      })()`,
    )
    await evaluate(
      client,
      waitFor(
        `Math.round(document.querySelector('aside')?.getBoundingClientRect().width ?? 0) === 224`,
        5000,
        '侧栏展开',
      ),
    )

    // 5c. 切换导航项应切换内容区。占位模块进入统一的占位页，页面注明规划范围并提供
    //     返回落地模块的入口。这一段走守卫的正常路径（请求项可见时直接采用）；回退路径
    //     由单元测试覆盖 —— 触发它需要在会话存续期间改动权限，而那要等账号管理接口落地。
    await evaluate(client, clickNavByLabel('系统设置'))
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main h1')?.innerText === '系统设置'`,
        5000,
        '系统设置内容区',
      ),
    )
    const systemPanel = await evaluate(client, `document.querySelector('main').innerText`)
    record('点击占位项进入统一占位页', systemPanel.includes('功能开发中'), '')
    record(
      '占位页注明规划范围',
      systemPanel.includes('规划范围') && systemPanel.includes('账号、角色与审计日志管理'),
      '',
    )
    const backHref = await evaluate(
      client,
      `(() => {
        const link = [...document.querySelectorAll('main a')].find((item) => item.textContent.includes('返回'))
        return link ? link.getAttribute('href') : null
      })()`,
    )
    record('占位页提供返回落地模块的入口', backHref === '/workbench', `href=${backHref}`)
    await screenshot(client, '4b-nav-system')

    // 5d. 点占位页的返回入口应回到个人工作台，且不再出现占位标注。用入口本身返回，
    //     而不是再点一次侧栏，顺带把「操作入口真的可用」纳入覆盖。
    await evaluate(
      client,
      `(() => {
        const link = [...document.querySelectorAll('main a')].find((item) => item.textContent.includes('返回'))
        if (!link) throw new Error('找不到返回入口')
        link.click()
        return true
      })()`,
    )
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main h1')?.innerText === '个人工作台'`,
        5000,
        '个人工作台内容区',
      ),
    )
    const benchPanel = await evaluate(client, `document.querySelector('main').innerText`)
    record('已排期的个人工作台不标注功能开发中', !benchPanel.includes('功能开发中'), '')
    await screenshot(client, '4c-nav-workbench')

    // 6. 刷新令牌存在 localStorage，访问令牌不在。
    const storage = await evaluate(
      client,
      `JSON.stringify({ refresh: window.localStorage.getItem('fanhe-work.refresh-token'), keys: Object.keys(window.localStorage) })`,
    )
    const parsed = JSON.parse(storage)
    record(
      '刷新令牌已持久化且访问令牌不在 localStorage',
      typeof parsed.refresh === 'string' &&
        parsed.refresh.length === 43 &&
        !storage.includes('accessToken'),
      `localStorage 键 ${parsed.keys.join(',')}`,
    )

    // 7. 静默续期。判据是刷新请求真的发出去了，而不是「界面还在」——
    //    后者在令牌尚未过期时必然成立，说明不了任何问题。
    let renewDetail = ''
    let renewed = true
    try {
      await evaluate(client, waitFor(`window.__e2e.refreshCalls >= 1`, 45000, '静默续期'))
      const probe = JSON.parse(await evaluate(client, 'JSON.stringify(window.__e2e)'))
      const elapsed = probe.loginAt === null ? null : (probe.refreshAt - probe.loginAt) / 1000
      renewDetail =
        `${probe.refreshCalls} 次刷新` +
        (elapsed === null ? '' : `，登录后 ${elapsed.toFixed(1)}s 触发`)
    } catch {
      renewed = false
      const ttl = await evaluate(client, 'window.__e2e.loginExpiresIn')
      renewDetail =
        ttl === null
          ? '未观察到刷新请求'
          : `未观察到刷新请求。访问令牌有效期 ${ttl} 秒，超出观察窗口；` +
            `续期检查要求 API 以 ACCESS_TOKEN_TTL_SECONDS=60 启动`
    }
    record('静默续期确实发起了刷新请求', renewed, renewDetail)

    if (renewed) {
      const ttl = await evaluate(client, 'window.__e2e.loginExpiresIn')
      record(
        '访问令牌有效期已压到观察窗口内',
        typeof ttl === 'number' && ttl <= MAX_OBSERVABLE_TTL_SECONDS,
        `expiresIn = ${ttl} 秒`,
      )
    }

    const stillInShell = await evaluate(
      client,
      `document.querySelector('[aria-label="账号菜单"]') !== null`,
    )
    record('续期过程中未掉回登录页', stillInShell === true, '')

    const authCalls = JSON.parse(await evaluate(client, 'JSON.stringify(window.__e2e.authCalls)'))
    console.log(`     期间发出的鉴权请求：${authCalls.join(' → ')}`)
    await screenshot(client, '5-after-renew')

    // 7b. 子路由可直接访问。这是 T2-03 的验收点：在地址栏直接打开某个模块的路径，
    //     应落到该模块，而不是被重定向回落地页。
    //
    //     必须放在续期断言之后：这一步会整页重新加载，挂在 window 上的请求探针随之
    //     消失，而续期正是靠它计数。放在前面会让续期那一步读不到数据。
    //
    //     重载后会话由 localStorage 里的刷新令牌静默恢复，不需要重新登录 —— 这本身
    //     也顺带验证了深链接与会话恢复能同时成立。
    const deepLoaded = client.once('Page.loadEventFired')
    await client.send('Page.navigate', { url: `${APP_URL}/system-settings` })
    await deepLoaded
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main h1')?.innerText === '系统设置'`,
        20000,
        '直接访问子路由',
      ),
    )
    const deepPath = await evaluate(client, 'location.pathname')
    const deepText = await evaluate(client, "document.querySelector('main').innerText")
    record(
      '直接访问 /system-settings 落到该模块且地址栏未被改写',
      deepPath === '/system-settings' && deepText.includes('功能开发中'),
      `路径 ${deepPath}`,
    )
    await screenshot(client, '5b-deep-link')

    // 7c. 未匹配的路径落到 404 页，且地址栏保持不变。T2-03 时这里是重定向回落地页，
    //     代价是地址栏被改写成 `/workbench`，用户看不出自己输错了什么，只会觉得
    //     「点了之后莫名其妙到了别处」。三条判据：正文是 404 的文案、地址栏仍是输入的
    //     那个路径、面包屑回落到应用名而不是某个模块名。
    //
    //     用整页导航而不是客户端跳转，顺带验证了「服务器把未知路径交回给前端」——
    //     生产环境缺了 SPA 回退配置时，这一步会直接拿到服务器的 404 而不是应用界面。
    const notFoundLoaded = client.once('Page.loadEventFired')
    await client.send('Page.navigate', { url: `${APP_URL}/no-such-module` })
    await notFoundLoaded
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main h1')?.innerText === '页面不存在'`,
        20000,
        '未知路径 404 页',
      ),
    )
    const notFound = JSON.parse(
      await evaluate(
        client,
        `JSON.stringify({
          path: location.pathname,
          panel: document.querySelector('main').innerText,
          header: document.querySelector('header').innerText,
        })`,
      ),
    )
    record(
      '未知路径落到 404 页且地址栏未被改写',
      notFound.path === '/no-such-module' && notFound.panel.includes('这个地址没有对应的页面'),
      `路径 ${notFound.path}`,
    )
    record(
      '404 页的面包屑回落到应用名',
      notFound.header.includes('梵禾 Work') && !notFound.header.includes('个人工作台'),
      notFound.header.trim().replace(/\s+/g, ' '),
    )
    await screenshot(client, '5c-not-found')

    // 7d. 404 页的出口可用。出口指向落地模块而不是浏览器历史：直接输入地址进来时
    //     没有历史可回，`navigate(-1)` 会把人留在原地或弹回站外。这一段走完地址栏
    //     停在 `/workbench`，下一节的登出不会改写它。
    await evaluate(
      client,
      `(() => {
        const link = [...document.querySelectorAll('main a')].find((item) => item.textContent.includes('返回'))
        if (!link) throw new Error('404 页找不到返回入口')
        link.click()
        return true
      })()`,
    )
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main h1')?.innerText === '个人工作台'`,
        5000,
        '404 页返回落地模块',
      ),
    )
    record('404 页的返回入口指向落地模块', true, '')

    // 7e. 折叠偏好记忆。验收点是「刷新后保持上次状态」，但**这句话本身不足以成为
    //     判据** —— 把读取放进 `useEffect` 也能满足它，代价是每次刷新先闪一帧展开
    //     的侧栏。所以这里除了量宽度，还逐帧采样首帧宽度（见 `SIDEBAR_WIDTH_PROBE`）。
    //
    //     放在这里而不是紧挨着 5b-3 的折叠断言，是因为它要整页重载，而重载会把挂在
    //     window 上的请求探针清掉 —— 续期断言（第 7 项）正靠它计数。这与 7b 的深链接
    //     验证不能提前是同一个理由。
    //
    //     5b-3 结束时侧栏已展开回去，所以这里从展开态开始。
    await evaluate(
      client,
      `(() => {
        const button = document.querySelector('aside button[aria-label="收起侧栏"]')
        if (!button) throw new Error('找不到收起按钮')
        button.click()
        return true
      })()`,
    )
    await evaluate(
      client,
      waitFor(
        `Math.round(document.querySelector('aside')?.getBoundingClientRect().width ?? 0) === 64`,
        5000,
        '再次折叠',
      ),
    )
    const collapsedStored = await evaluate(
      client,
      `window.localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)})`,
    )
    record('折叠后偏好写入 localStorage', collapsedStored === 'true', `值 ${collapsedStored}`)

    // 注入采样器必须在重载之前，它只在文档创建时执行一次。
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: SIDEBAR_WIDTH_PROBE })
    const collapseReloaded = client.once('Page.loadEventFired')
    await client.send('Page.reload', { ignoreCache: true })
    await collapseReloaded
    await evaluate(
      client,
      waitFor(`(window.__sidebarWidths ?? []).length >= 5`, 20000, '重载后首帧采样'),
    )
    const collapsedSamples = JSON.parse(
      await evaluate(client, 'JSON.stringify(window.__sidebarWidths)'),
    )
    record(
      '刷新后侧栏仍是折叠态',
      collapsedSamples[0] === 64,
      `首帧 ${collapsedSamples[0]}px，前几帧 ${collapsedSamples.slice(0, 6).join(' → ')}`,
    )
    record(
      '刷新后没有展开→折叠的跳动',
      collapsedSamples.every((width) => width === 64),
      `共采样 ${collapsedSamples.length} 帧`,
    )

    // 展开回去，验证写回另一个方向。
    await evaluate(
      client,
      `(() => {
        const button = document.querySelector('aside button[aria-label="展开侧栏"]')
        if (!button) throw new Error('找不到展开按钮')
        button.click()
        return true
      })()`,
    )
    await evaluate(
      client,
      waitFor(
        `Math.round(document.querySelector('aside')?.getBoundingClientRect().width ?? 0) === 224`,
        5000,
        '重载后展开侧栏',
      ),
    )
    const expandedStored = await evaluate(
      client,
      `window.localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)})`,
    )
    record('展开后偏好改写为 false', expandedStored === 'false', `值 ${expandedStored}`)

    // 读侧的容错：只有 `'true'` 算折叠，其余一律回落展开。用 `Boolean()` 转换的写法
    // 会在这里把 `'maybe'` 当成折叠 —— 表现是「侧栏自己收起来了」，而用户没做过这个
    // 操作。这一步同时把结束状态留在展开态。
    await evaluate(
      client,
      `window.localStorage.setItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)}, 'maybe')`,
    )
    const garbageReloaded = client.once('Page.loadEventFired')
    await client.send('Page.reload', { ignoreCache: true })
    await garbageReloaded
    await evaluate(
      client,
      waitFor(`(window.__sidebarWidths ?? []).length >= 5`, 20000, '非法偏好值下的首帧采样'),
    )
    const garbageSamples = JSON.parse(
      await evaluate(client, 'JSON.stringify(window.__sidebarWidths)'),
    )
    record('偏好值非法时回落为展开', garbageSamples[0] === 224, `首帧 ${garbageSamples[0]}px`)

    // 7f. 主题切换与跨刷新保持。判据与 7e 是同一条：「刷新后还是深色」不足以证明
    //     没有闪烁 —— 把应用放进 `useEffect` 也能满足它，代价是每次刷新先闪一帧浅色。
    //     所以这里同样逐帧采样首帧配色（见 `THEME_FRAME_PROBE`）。
    //
    //     与侧栏折叠的区别在初值的落点：折叠状态可以等到 React 挂载再读，配色不行，
    //     它要在第一个像素上就对，所以判断写在 `index.html` 的内联脚本里。这一段验证
    //     的正是那条路径 —— 只把逻辑写进 React 的话，下面「首帧就是深色」会失败。
    //
    //     位置同样受「要整页重载」的约束：重载会清掉挂在 window 上的请求探针，而续期
    //     断言（第 7 项）已经做完，所以排在这里是安全的。
    await mouseClick(client, `document.querySelector('[aria-label="切换主题"]')`, '主题切换按钮')
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="menuitemradio"]') !== null`, 5000, '主题菜单展开'),
    )
    await mouseClick(
      client,
      `[...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent.includes('深色'))`,
      '深色选项',
    )
    await evaluate(
      client,
      waitFor(
        `document.documentElement.classList.contains('dark')`,
        5000,
        '切到深色后 html 挂上 dark 类',
      ),
    )
    const darkStored = await evaluate(
      client,
      `window.localStorage.getItem(${JSON.stringify(THEME_KEY)})`,
    )
    record('切到深色后偏好写入 localStorage', darkStored === 'dark', `值 ${darkStored}`)

    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: THEME_FRAME_PROBE })
    const themeReloaded = client.once('Page.loadEventFired')
    await client.send('Page.reload', { ignoreCache: true })
    await themeReloaded
    // 先等外壳挂回来，再读采样。**这一步不能省，也不能用「攒够 5 帧」代替**：
    // 主题采样器是无条件逐帧记录的（侧栏那个只在 `aside` 存在时才记），所以它几帧
    // 就攒满了，而那时重载后的「初始化状态 + 静默续期」往返还没走完，顶栏根本没挂载，
    // 紧接着点主题按钮会报「找不到元素」—— 一个与主题毫无关系的失败。
    await evaluate(
      client,
      waitFor(
        `document.querySelector('[aria-label="切换主题"]') !== null`,
        20000,
        '重载后外壳挂载',
      ),
    )
    await evaluate(
      client,
      waitFor(`(window.__themeFrames ?? []).length >= 5`, 20000, '重载后主题首帧采样'),
    )
    const darkSamples = JSON.parse(await evaluate(client, 'JSON.stringify(window.__themeFrames)'))
    record(
      '刷新后首帧就是深色',
      darkSamples[0] === 'dark',
      `首帧 ${darkSamples[0]}，前几帧 ${darkSamples.slice(0, 6).join(' → ')}`,
    )
    record(
      '刷新后没有浅色→深色的闪烁',
      darkSamples.every((frame) => frame === 'dark'),
      `共采样 ${darkSamples.length} 帧`,
    )

    // 切回浅色，验证写回另一个方向，同时把后续截图留在浅色下。
    await mouseClick(client, `document.querySelector('[aria-label="切换主题"]')`, '主题切换按钮')
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="menuitemradio"]') !== null`, 5000, '主题菜单展开'),
    )
    await mouseClick(
      client,
      `[...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent.includes('浅色'))`,
      '浅色选项',
    )
    await evaluate(
      client,
      waitFor(
        `!document.documentElement.classList.contains('dark')`,
        5000,
        '切到浅色后摘掉 dark 类',
      ),
    )
    const lightStored = await evaluate(
      client,
      `window.localStorage.getItem(${JSON.stringify(THEME_KEY)})`,
    )
    record('切到浅色后偏好改写为 light', lightStored === 'light', `值 ${lightStored}`)

    // 「跟随系统」这一档是本期最容易做错的地方：把它在写入时折算成当时的亮暗，用户
    // 之后改了系统设置界面不会跟着变。所以这里用 CDP 改系统配色，再选「跟随系统」，
    // 断言界面跟着走、而存储里留下的是 `system` 这个**规则**而不是某个具体配色。
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    })
    await mouseClick(client, `document.querySelector('[aria-label="切换主题"]')`, '主题切换按钮')
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="menuitemradio"]') !== null`, 5000, '主题菜单展开'),
    )
    await mouseClick(
      client,
      `[...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent.includes('跟随系统'))`,
      '跟随系统选项',
    )
    await evaluate(
      client,
      waitFor(
        `document.documentElement.classList.contains('dark')`,
        5000,
        '跟随系统下按系统配色渲染',
      ),
    )
    const systemStored = await evaluate(
      client,
      `window.localStorage.getItem(${JSON.stringify(THEME_KEY)})`,
    )
    record(
      '跟随系统档存的是 system 而不是当时的配色',
      systemStored === 'system',
      `值 ${systemStored}`,
    )
    // 此刻界面是深色（模拟的系统配色为深色），截图留档。
    await screenshot(client, '7-dark-theme')

    // 系统配色变化时界面要即时跟随。这是「跟随系统」区别于固定档的唯一行为，也是
    // 它必须存成第三个值的理由 —— 存了具体配色的话，界面在这一步不会动。
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    })
    let followedSystem = true
    try {
      await evaluate(
        client,
        waitFor(
          `!document.documentElement.classList.contains('dark')`,
          5000,
          '系统改浅色后界面跟随',
        ),
      )
    } catch {
      followedSystem = false
    }
    record('跟随系统档下系统配色变化即时生效', followedSystem, '')

    // 收尾：撤掉模拟的系统配色，让后面的截图回到本机真实配色。
    await client.send('Emulation.setEmulatedMedia', { features: [] })

    // 8. 登出应清掉本地令牌并回到登录页。
    //    退出登录从顶栏的裸按钮移进了账号菜单（T2-02 的布局骨架），要多两步：
    //    先点开菜单，等菜单项真的挂上 DOM，再点它。菜单的展开与选中都依赖真实
    //    指针事件，所以这里用 mouseClick 而不是 clickByText。
    await mouseClick(client, `document.querySelector('[aria-label="账号菜单"]')`, '账号菜单')
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="menuitem"]') !== null`, 5000, '账号菜单展开'),
    )
    await mouseClick(
      client,
      `[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes('退出登录'))`,
      '退出登录菜单项',
    )
    await evaluate(
      client,
      waitFor(`document.querySelector('#login-username') !== null`, 15000, '登出后登录页'),
    )
    const afterLogout = await evaluate(
      client,
      `JSON.stringify({ refresh: window.localStorage.getItem('fanhe-work.refresh-token') })`,
    )
    record('登出后回到登录页并清空本地刷新令牌', JSON.parse(afterLogout).refresh === null, '')
    await screenshot(client, '6-after-logout')

    // 8a. 重新加载页面，账号密码应自动带出。这是「重启后生效」在浏览器里的等价形式。
    //     刷新令牌已在上一步清掉，所以页面会停在登录页，而不是静默恢复会话 —— 若它
    //     直接进了主界面，下面这个等待就会超时，而那说明登出没清干净。
    const reloaded = client.once('Page.loadEventFired')
    await client.send('Page.reload', { ignoreCache: true })
    await reloaded

    await evaluate(
      client,
      waitFor(
        `document.querySelector('#login-username')?.value === ${JSON.stringify(OWNER.username)}`,
        15000,
        '凭据自动带出',
      ),
    )
    const restored = JSON.parse(
      await evaluate(
        client,
        `JSON.stringify({
          username: document.querySelector('#login-username').value,
          password: document.querySelector('#login-password').value,
          remember: document.querySelector('#login-remember')?.getAttribute('data-state') === 'checked',
        })`,
      ),
    )
    record(
      '重新打开后账号密码自动带出',
      restored.username === OWNER.username && restored.password === OWNER.password,
      `${restored.username} / ${restored.password.length} 位密码`,
    )
    record('记住账号密码复选框保持勾选', restored.remember === true, '')
    await screenshot(client, '7-credential-restored')

    // 8b. 取消勾选后登录，已保存的凭据应被清除。
    //     账号密码这时已经带出在输入框里，直接提交即可。清除发生在登录成功之后，
    //     所以要等它完成再断言。
    //
    //     判据是「已登录外壳挂上」而不是某段正文。登出不会改写地址栏，7d 那一步把
    //     地址留在了 `/workbench`，所以等某段落在工作台上的正文此刻恰好能通过 ——
    //     但那是巧合：地址停在哪个模块取决于前一个小节最后点了什么，任何一处调整
    //     都会让等特定正文的断言无声地失效。等账号菜单这种只存在于已登录外壳里的
    //     元素，与落地在哪个模块无关。
    await evaluate(client, clickSelector('#login-remember'))
    await evaluate(client, clickSelector('button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[aria-label="账号菜单"]') !== null`, 25000, '再次登录'),
    )
    let cleared = true
    try {
      await evaluate(
        client,
        waitFor(`window.localStorage.getItem('fanhe-work.credential') === null`, 10000, '凭据清除'),
      )
    } catch {
      cleared = false
    }
    record('取消勾选后登录，已保存的凭据被清除', cleared, '')

    // 8c. 启动通道。T3-03 的验收点：配置可新增、编辑、排序，可一键唤起。
    //
    //     被拉起的程序是当前这个 Node（见 `LAUNCH_TARGET_PATH` 的注释），所以这一段
    //     不会在机器上留下窗口，也不依赖本机装没装微信或 QQ。
    //
    //     位置放在最后：这一段会新增并删除配置，虽然结束时回到空态，但过程中会往
    //     数据库里写行；排在前面的话，任何一步失败都会让后面的断言面对一份不干净的
    //     数据，而失败原因会被埋在一堆连锁失败里。
    await evaluate(
      client,
      waitFor(`document.querySelector('main h1')?.innerText === '个人工作台'`, 8000, '个人工作台'),
    )
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main').innerText.includes('还没有启动配置')`,
        10000,
        '启动通道空态',
      ),
    )
    record('启动通道空态给出新增入口', true, '')
    await screenshot(client, '8a-launch-empty')

    // 先试一个相对路径：客户端校验必须当场拦下，而不是提交后收一个 400。判据里包含
    // 「对话框还开着」—— 只断言出现了错误文案的话，一个先关闭再报错的实现也能通过。
    await mouseClick(
      client,
      `[...document.querySelectorAll('main button')].find((item) => item.textContent.trim() === '新增配置')`,
      '空态的新增配置按钮',
    )
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') !== null`, 5000, '新增对话框'),
    )
    const createTitle = await evaluate(
      client,
      `document.querySelector('[role="dialog"] h2')?.innerText ?? ''`,
    )
    record('空态入口能打开新增对话框', createTitle.includes('新增启动配置'), createTitle)

    await evaluate(client, fillInput('#launch-name', LAUNCH_PROFILE_A.name))
    await evaluate(client, fillInput('#launch-path', 'relative\\path.exe'))
    await evaluate(client, clickSelector('[role="dialog"] button[type="submit"]'))
    await evaluate(
      client,
      waitFor(
        `document.querySelector('[role="dialog"]')?.innerText.includes('必须是绝对路径') === true`,
        5000,
        '相对路径校验',
      ),
    )
    record('相对路径被客户端拦下且对话框不关闭', true, '')

    // 改正后保存。路径与参数都填上，顺带覆盖「一行一个参数」的解析。
    await evaluate(client, fillInput('#launch-path', LAUNCH_TARGET_PATH))
    await evaluate(client, fillInput('#launch-args', LAUNCH_TARGET_ARGS))
    await evaluate(client, clickSelector('[role="dialog"] button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') === null`, 8000, '新增对话框关闭'),
    )
    await evaluate(
      client,
      waitFor(`document.querySelectorAll('main ul li').length === 1`, 8000, '列表出现一条'),
    )
    const firstRow = await evaluate(client, `document.querySelector('main ul li').innerText`)
    record(
      '新增后列表出现一条配置',
      firstRow.includes(LAUNCH_PROFILE_A.name) && firstRow.includes('微信'),
      firstRow.replace(/\s+/g, ' ').slice(0, 80),
    )
    record('启动参数按行解析为两个', firstRow.includes('2 个参数'), '')
    await screenshot(client, '8b-launch-one')

    // 再新增一条，用来验证排序。
    await mouseClick(
      client,
      `[...document.querySelectorAll('main button')].find((item) => item.textContent.trim() === '新增')`,
      '列表非空时的新增按钮',
    )
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') !== null`, 5000, '第二次新增对话框'),
    )
    await evaluate(
      client,
      `(() => {
        const button = [...document.querySelectorAll('#launch-software button')].find((item) => item.textContent.trim() === '自定义程序')
        if (!button) throw new Error('找不到自定义程序选项')
        button.click()
        return true
      })()`,
    )
    await evaluate(client, fillInput('#launch-name', LAUNCH_PROFILE_B.name))
    await evaluate(client, fillInput('#launch-path', LAUNCH_TARGET_PATH))
    await evaluate(client, clickSelector('[role="dialog"] button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelectorAll('main ul li').length === 2`, 8000, '列表出现两条'),
    )
    const orderBefore = JSON.parse(await evaluate(client, ROW_TEXTS))
    record(
      '新增的配置排在末尾',
      orderBefore[0].includes(LAUNCH_PROFILE_A.name) &&
        orderBefore[1].includes(LAUNCH_PROFILE_B.name),
      orderBefore.map((text) => text.slice(0, 12)).join(' / '),
    )

    // 把第一条下移一格，顺序应当交换。判据是两行的实际先后，不是「点了没报错」——
    // 排序失败时界面什么都不会变，而那正是最需要被抓住的情况。
    await evaluate(client, clickSelector(`[aria-label="下移 ${LAUNCH_PROFILE_A.name}"]`))
    await evaluate(
      client,
      waitFor(
        `[...document.querySelectorAll('main ul li')][0]?.textContent.includes(${JSON.stringify(LAUNCH_PROFILE_B.name)}) === true`,
        8000,
        '下移后顺序交换',
      ),
    )
    const orderAfter = JSON.parse(await evaluate(client, ROW_TEXTS))
    record(
      '下移一格后两条互换位置',
      orderAfter[0].includes(LAUNCH_PROFILE_B.name) &&
        orderAfter[1].includes(LAUNCH_PROFILE_A.name),
      orderAfter.map((text) => text.slice(0, 12)).join(' / '),
    )
    // 首项不能上移、末项不能下移。不置灰的话点下去什么都不会发生，看起来像界面卡了。
    const edges = JSON.parse(
      await evaluate(
        client,
        `JSON.stringify({
          up: document.querySelector('[aria-label="上移 ${LAUNCH_PROFILE_B.name}"]')?.disabled,
          down: document.querySelector('[aria-label="下移 ${LAUNCH_PROFILE_A.name}"]')?.disabled,
        })`,
      ),
    )
    record(
      '首项不能上移、末项不能下移',
      edges.up === true && edges.down === true,
      JSON.stringify(edges),
    )
    await screenshot(client, '8c-launch-reordered')

    // 启动。被拉起的进程立刻退出，所以这里只能断言「接口回了成功结果」——工作台本来
    // 也不管子进程的生死，spawn 之后它的存活就与工作台无关了。
    await evaluate(client, clickRowButton(LAUNCH_PROFILE_A.name, '启动'))
    await evaluate(
      client,
      waitFor(`document.querySelector('main').innerText.includes('已启动')`, 15000, '启动结果提示'),
    )
    const launchNotice = await evaluate(client, `document.querySelector('main').innerText`)
    record('点击启动后提示已启动', launchNotice.includes(`已启动「${LAUNCH_PROFILE_A.name}」`), '')

    // 编辑。带出原值是这一步的关键：带错的话保存下去就是「把 B 改成了 A」，
    // 而界面上只表现为名字变了，看不出内容串了行。
    await openRowMenu(client, LAUNCH_PROFILE_A.name)
    await mouseClick(client, menuItemFinder('编辑'), '编辑菜单项')
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') !== null`, 5000, '编辑对话框'),
    )
    const prefilled = JSON.parse(
      await evaluate(
        client,
        `JSON.stringify({
          title: document.querySelector('[role="dialog"] h2')?.innerText ?? '',
          name: document.querySelector('#launch-name')?.value ?? '',
          path: document.querySelector('#launch-path')?.value ?? '',
          args: document.querySelector('#launch-args')?.value ?? '',
        })`,
      ),
    )
    record(
      '编辑对话框带出原有值',
      prefilled.title.includes('编辑启动配置') &&
        prefilled.name === LAUNCH_PROFILE_A.name &&
        prefilled.path === LAUNCH_TARGET_PATH &&
        prefilled.args === LAUNCH_TARGET_ARGS,
      prefilled.name,
    )

    await evaluate(client, fillInput('#launch-name', LAUNCH_PROFILE_A.renamed))
    await evaluate(client, clickSelector('[role="dialog"] button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') === null`, 8000, '编辑对话框关闭'),
    )
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main').innerText.includes(${JSON.stringify(LAUNCH_PROFILE_A.renamed)})`,
        8000,
        '改名生效',
      ),
    )
    const orderAfterEdit = JSON.parse(await evaluate(client, ROW_TEXTS))
    record(
      '编辑保存后名称更新且顺序不变',
      orderAfterEdit[0].includes(LAUNCH_PROFILE_B.name) &&
        orderAfterEdit[1].includes(LAUNCH_PROFILE_A.renamed),
      orderAfterEdit.map((text) => text.slice(0, 14)).join(' / '),
    )

    // 删除。先出确认框 —— 这一条不可撤销，直接删掉的风险高于多点一次。
    await openRowMenu(client, LAUNCH_PROFILE_B.name)
    await mouseClick(client, menuItemFinder('删除'), '删除菜单项')
    await evaluate(
      client,
      waitFor(
        `document.querySelector('[role="dialog"]')?.innerText.includes('删除启动配置') === true`,
        5000,
        '删除确认对话框',
      ),
    )
    const confirmText = await evaluate(
      client,
      `document.querySelector('[role="dialog"]').innerText`,
    )
    record('删除前先出确认框并说明删的是哪一条', confirmText.includes(LAUNCH_PROFILE_B.name), '')
    await mouseClick(
      client,
      `[...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent.trim() === '删除')`,
      '确认删除按钮',
    )
    await evaluate(
      client,
      waitFor(`document.querySelectorAll('main ul li').length === 1`, 8000, '删除后剩一条'),
    )
    const remaining = await evaluate(client, `document.querySelector('main ul li').innerText`)
    record('删除后该条从列表消失', remaining.includes(LAUNCH_PROFILE_A.renamed), '')

    // 删掉最后一条应回到空态。这条路径与「删掉其中一条」不同：列表变空之后渲染的是
    // 空态分支，而不是一个零行的列表 —— 后者会留下一块空白，看不出是没数据还是没加载出来。
    await openRowMenu(client, LAUNCH_PROFILE_A.renamed)
    await mouseClick(client, menuItemFinder('删除'), '删除菜单项')
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') !== null`, 5000, '删除确认对话框'),
    )
    await mouseClick(
      client,
      `[...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent.trim() === '删除')`,
      '确认删除按钮',
    )
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main').innerText.includes('还没有启动配置')`,
        8000,
        '删空后回到空态',
      ),
    )
    record('删掉最后一条后回到空态', true, '')
    await screenshot(client, '8d-launch-cleared')

    // 8e. 路径失效与启动记录。T3-04 的验收点：路径不存在时给出提示与重新指定入口。
    //
    //     位置放在清空之后：这一段会新建一条路径失效的配置、把它改好、启动一次再删掉，
    //     结束时回到空态。放进中间会改变行数，让上面那些按行数断言的用例一起失败，
    //     而真正的失败原因会被埋在一堆连锁失败里。
    await mouseClick(
      client,
      `[...document.querySelectorAll('main button')].find((item) => item.textContent.trim() === '新增配置')`,
      '空态的新增配置按钮',
    )
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') !== null`, 5000, '新增对话框'),
    )
    await evaluate(client, fillInput('#launch-name', LAUNCH_PROFILE_MISSING.name))
    await evaluate(client, fillInput('#launch-path', LAUNCH_PROFILE_MISSING.path))
    await evaluate(client, clickSelector('[role="dialog"] button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelectorAll('main ul li').length === 1`, 8000, '失效配置入列'),
    )

    // 路径状态由服务端查出来（前端不碰文件系统），所以这里等的是「标记出现」而不是
    // 「等一会儿」—— 后者在慢机器上会假通过。
    await evaluate(
      client,
      waitFor(`${rowBadgeFinder(LAUNCH_PROFILE_MISSING.name, '路径失效')}`, 15000, '路径失效标记'),
    )
    record('路径不存在时行内给出失效标记', true, '')

    const relocateEntry = JSON.parse(
      await evaluate(
        client,
        `JSON.stringify({
          hasRelocate: ${rowHasButtonFinder(LAUNCH_PROFILE_MISSING.name, '重新指定路径')},
          hasLaunch: ${rowHasButtonFinder(LAUNCH_PROFILE_MISSING.name, '启动')},
        })`,
      ),
    )
    // 失效时「启动」被换成了「重新指定路径」：留一个必然失败的按钮只会让用户点一次、
    // 收到同一条错误，而它本来就指向唯一有意义的动作。
    record(
      '失效的行给出重新指定路径入口，且不再显示启动',
      relocateEntry.hasRelocate === true && relocateEntry.hasLaunch === false,
      JSON.stringify(relocateEntry),
    )
    await screenshot(client, '8e-launch-path-missing')

    // 点进去。光标应当落在路径字段上 —— 用户要做的事就是把整段换掉，不落在那儿的话
    // 他会先落在软件选择按钮上，还得自己找到路径。
    await evaluate(client, clickRowButton(LAUNCH_PROFILE_MISSING.name, '重新指定路径'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') !== null`, 5000, '重新指定对话框'),
    )
    const focusedField = await evaluate(client, `document.activeElement?.id ?? ''`)
    record('重新指定路径打开对话框并聚焦路径字段', focusedField === 'launch-path', focusedField)

    // 换成一条真实存在的路径（跑测试的这个 Node），保存后标记应当消失。
    await evaluate(client, fillInput('#launch-path', LAUNCH_TARGET_PATH))
    await evaluate(client, clickSelector('[role="dialog"] button[type="submit"]'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') === null`, 8000, '编辑对话框关闭'),
    )
    await evaluate(
      client,
      waitFor(
        `${rowBadgeFinder(LAUNCH_PROFILE_MISSING.name, '路径失效')} === false`,
        15000,
        '失效标记消失',
      ),
    )
    const launchButtonBack = await evaluate(
      client,
      rowHasButtonFinder(LAUNCH_PROFILE_MISSING.name, '启动'),
    )
    record('改成有效路径后失效标记消失、启动按钮回来', launchButtonBack === true, '')

    // 启动一次。记录落库之后界面会重拉状态，行内出现「上次启动」—— 这一行既是启动
    // 记录真的写进去了的证据，也是「启动后摘要会刷新」这条行为的证据。
    await evaluate(client, clickRowButton(LAUNCH_PROFILE_MISSING.name, '启动'))
    await evaluate(
      client,
      waitFor(
        `${rowTextFinder(LAUNCH_PROFILE_MISSING.name)}.includes('上次启动')`,
        15000,
        '启动摘要',
      ),
    )
    const runSummary = await evaluate(client, rowTextFinder(LAUNCH_PROFILE_MISSING.name))
    record(
      '启动后行内出现上次启动的摘要',
      runSummary.includes('上次启动'),
      runSummary.replace(/\s+/g, ' ').slice(-32),
    )
    await screenshot(client, '8f-launch-history')

    // 清掉，让数据库回到基线。
    await openRowMenu(client, LAUNCH_PROFILE_MISSING.name)
    await mouseClick(client, menuItemFinder('删除'), '删除菜单项')
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') !== null`, 5000, '删除确认对话框'),
    )
    await mouseClick(
      client,
      `[...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent.trim() === '删除')`,
      '确认删除按钮',
    )
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main').innerText.includes('还没有启动配置')`,
        8000,
        '删空后回到空态',
      ),
    )
    record('失效配置删除后回到空态', true, '')

    // 9. 工作纪要（T3-06）。
    //
    //    两件事最要紧：**预览读的是草稿**（不点保存就该看到渲染结果），以及
    //    **空库时编辑器直接可用**（第一条纪要不会被空态挡住）。前者是本任务的验收
    //    要点，后者是实现过程中真的踩到过的死角 —— 编辑器原先只画在「列表非空」的
    //    分支里，于是全新库上那个「新建」按钮点下去毫无反应。
    await evaluate(client, clickNavByLabel('个人工作台'))
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main').innerText.includes('一键登录通道')`,
        10000,
        '工作台页头',
      ),
    )
    await evaluate(client, clickNavByLabel('工作纪要'))
    await evaluate(
      client,
      waitFor(`location.pathname === '/workbench/notes'`, 10000, '地址切到 /workbench/notes'),
    )
    record('工作台可切到工作纪要板块，地址同步为 /workbench/notes', true, '')

    await evaluate(
      client,
      waitFor(`document.querySelector('#note-title') !== null`, 10000, '纪要编辑器'),
    )
    record('空库时编辑器直接可用，第一条纪要不会被空态挡住', true, '')
    await screenshot(client, '9a-notes-empty')

    // 正文里放一个一级标题与一张 GFM 表格，两者都只有渲染过才会变成元素。
    await evaluate(client, fillInput('#note-title', NOTE_TITLE))
    await evaluate(client, fillInput('#note-content', NOTE_BODY))
    // 结尾多打一个逗号：分隔符落下的一刻才成条，末尾没打完的那一段留在输入框里。
    await evaluate(client, fillInput('#note-tags', `${NOTE_TAG_A}，${NOTE_TAG_B}，`))

    await evaluate(
      client,
      waitFor(
        `[...document.querySelectorAll('main h1')].some((item) => item.textContent.trim() === '预览标题')`,
        8000,
        '草稿即时渲染出标题',
      ),
    )
    record('未保存的草稿就渲染出标题（预览读草稿，而非已保存值）', true, '')
    record(
      'GFM 表格渲染为 table 元素',
      (await evaluate(client, `document.querySelector('main table') !== null`)) === true,
      '',
    )

    // 只改草稿、还没保存时预览必须跟着变。这一条直接对应验收要点「编辑与预览一致」。
    await evaluate(client, fillInput('#note-content', `${NOTE_BODY}\n## 追加的小节\n`))
    await evaluate(
      client,
      waitFor(
        `[...document.querySelectorAll('main h2')].some((item) => item.textContent.trim() === '追加的小节')`,
        8000,
        '预览跟随草稿更新',
      ),
    )
    record('正文改动后预览立即跟随', true, '')
    await screenshot(client, '9b-notes-editing')

    await evaluate(client, clickMainButton('创建'))
    await evaluate(
      client,
      waitFor(`document.querySelector('main').innerText.includes('已创建')`, 10000, '创建提示'),
    )
    await evaluate(
      client,
      waitFor(
        `[...document.querySelectorAll('main ul li button')].some((item) => item.textContent.includes(${JSON.stringify(NOTE_TITLE)}))`,
        10000,
        '列表出现新条目',
      ),
    )
    record('创建成功：给出提示且列表出现该条', true, '')
    record(
      '编辑器转为编辑态（按钮由「创建」变为「保存」）',
      (await evaluate(client, mainHasButtonFinder('保存'))) === true,
      '',
    )
    const tagChips = await evaluate(
      client,
      `[...document.querySelectorAll('main button[aria-label^="移除标签"]')].map((item) => item.getAttribute('aria-label'))`,
    )
    record('中英文逗号都能分隔成标签芯片', tagChips.length === 2, JSON.stringify(tagChips))
    await screenshot(client, '9c-notes-created')

    // 置顶是独立的一条幂等 PUT。成功后由服务端重排列表，界面照着重绘。
    await evaluate(client, clickMainButton('置顶'))
    await evaluate(
      client,
      waitFor(`document.querySelector('main').innerText.includes('已置顶')`, 10000, '置顶提示'),
    )
    record('置顶成功并给出提示', true, '')
    await evaluate(
      client,
      waitFor(
        `(() => {
          const first = document.querySelector('main ul li button')
          return first !== null && first.textContent.includes(${JSON.stringify(NOTE_TITLE)})
        })()`,
        10000,
        '置顶项排到最前',
      ),
    )
    record('置顶后该条排在列表最前', true, '')

    // 归档：退出默认视图，但仍在「已归档」里可读、可恢复。
    await evaluate(client, clickMainButton('归档'))
    await evaluate(
      client,
      waitFor(
        `document.querySelector('main').innerText.includes('已归档，可在')`,
        10000,
        '归档提示',
      ),
    )
    await evaluate(
      client,
      waitFor(
        `![...document.querySelectorAll('main ul li button')].some((item) => item.textContent.includes(${JSON.stringify(NOTE_TITLE)}))`,
        10000,
        '该条退出默认列表',
      ),
    )
    record('归档后退出默认列表，并说明去哪找', true, '')

    await evaluate(client, clickMainButton('已归档'))
    await evaluate(
      client,
      waitFor(
        `[...document.querySelectorAll('main ul li button')].some((item) => item.textContent.includes(${JSON.stringify(NOTE_TITLE)}))`,
        10000,
        '归档视图可见',
      ),
    )
    record('切到「已归档」能看到它', true, '')
    await screenshot(client, '9d-notes-archived')

    // 删除。确认框在 portal 里，因此确认按钮要用 clickDialogButton 找。
    await evaluate(client, clickNoteRow(NOTE_TITLE))
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') === null`, 5000, '没有残留浮层'),
    )
    await evaluate(client, clickMainButton('删除'))
    await evaluate(
      client,
      waitFor(`document.querySelector('[role="dialog"]') !== null`, 5000, '删除确认框'),
    )
    const deleteConfirm = await evaluate(
      client,
      `document.querySelector('[role="dialog"]').innerText`,
    )
    record('删除前先出确认框并说明删的是哪一条', deleteConfirm.includes(NOTE_TITLE), '')
    await evaluate(client, clickDialogButton('删除'))
    await evaluate(
      client,
      waitFor(`document.querySelector('main').innerText.includes('已删除')`, 10000, '删除提示'),
    )
    await evaluate(
      client,
      waitFor(
        `![...document.querySelectorAll('main ul li button')].some((item) => item.textContent.includes(${JSON.stringify(NOTE_TITLE)}))`,
        10000,
        '该条消失',
      ),
    )
    record('删除后该条从列表消失', true, '')

    // 回到基线视图。纪要走软删除，「清理」要靠在数据库里删（见文件头部注释）。
    await evaluate(client, clickMainButton('未归档'))
    await evaluate(
      client,
      waitFor(`document.querySelector('main').innerText.includes('还没有纪要')`, 10000, '回到空态'),
    )
    record('删空后回到空态', true, '')
    await screenshot(client, '9e-notes-cleared')

    // 10. 渲染层无错误。这是本脚本存在的理由。
    record(
      '渲染过程未产生未捕获异常或 console.error',
      pageErrors.length === 0,
      pageErrors.length === 0 ? '' : pageErrors.join(' | '),
    )
    if (pageErrors.length > 0) {
      console.log('     页面错误明细：')
      for (const line of pageErrors) console.log(`       ${line}`)
    }
    if (pageLogs.length > 0) {
      console.log('     页面日志（非错误，仅记录）：')
      for (const line of pageLogs.slice(0, 10)) console.log(`       ${line}`)
    }
  } finally {
    if (client) client.close()
    browser.kill()
    await sleep(800)
  }

  const failed = results.filter((item) => !item.ok)
  console.log(
    `\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
  )
  console.log(`本次创建了账号 ${OWNER.username}，清理方法见本文件头部注释。`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
