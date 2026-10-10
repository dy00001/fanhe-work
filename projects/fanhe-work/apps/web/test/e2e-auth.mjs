/**
 * 浏览器级端到端验证：首次初始化 → 登录（勾选记住账号密码）→ 主界面 → 导航过滤 →
 * 静默续期 → 登出 → 重新打开后凭据自动带出 → 取消勾选后凭据被清除。
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
 *          "delete from refresh_tokens; delete from audit_logs; delete from login_attempts; delete from users;"
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

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

function findBrowser() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path))
  if (!found) throw new Error('没有找到 Chrome 或 Edge')
  return found
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

/** 填受控输入。直接赋 value 不会触发 React 的 onChange，必须走原生 setter 再派发 input。 */
function fillInput(selector, value) {
  return `(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) throw new Error('找不到输入框 ' + ${JSON.stringify(selector)})
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
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
 * 导航项是原生 `button`，`element.click()` 就能触发 React 的 onClick，
 * 不需要 mouseClick 那套真实指针事件。
 */
function clickNavByLabel(label) {
  return `(() => {
    const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent.includes(${JSON.stringify(label)}))
    if (!button) throw new Error('找不到导航项 ' + ${JSON.stringify(label)})
    button.click()
    return true
  })()`
}

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
        '    "delete from refresh_tokens; delete from audit_logs; delete from login_attempts; delete from users;"',
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
  //
  // 放在系统临时目录，不放截图目录。profile 里是 IndexedDB 与 localStorage 的后端
  // 文件，访问模式是随机小 IO，而工作空间在 U 盘上 —— 实测同一份 profile 落在 U 盘
  // 时打开一次 IndexedDB 要 5.8 秒，落在系统盘是毫秒级。这是项目约定「重型产物移出
  // U 盘」的一个具体落点。
  //
  // 必须是绝对路径。传相对路径时 Chrome 不会报参数错误，而是弹一个模态对话框
  // 说「无法对其数据目录执行读写操作」，然后卡在那里等用户点确定 —— 调试端口
  // 始终不开，外部只看到「CDP 目标未就绪」，看不出真正原因。
  const userDataDir = join(tmpdir(), `fanhe-work-e2e-${process.pid}`)
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

    // 5. 勾选「记住账号密码」后用正确密码登录，应进入主界面并展示权限点。
    await evaluate(client, clickSelector('#login-remember'))
    await evaluate(client, fillInput('#login-password', OWNER.password))
    await evaluate(client, clickSelector('button[type="submit"]'))
    await evaluate(client, waitFor(`document.body.innerText.includes('权限点')`, 25000, '主界面'))
    const homeText = await evaluate(client, 'document.body.innerText')
    record(
      '登录成功后进入主界面',
      homeText.includes(OWNER.displayName),
      `显示名 ${OWNER.displayName}`,
    )
    record('主界面展示展开后的权限点', homeText.includes('11 项'), '')
    record('主界面展示角色名', homeText.includes('超级管理员'), '')

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
        `JSON.stringify([...document.querySelectorAll('nav button')].map((item) => item.textContent.trim()))`,
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
        const item = document.querySelector('nav button')
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

    // 5c. 切换导航项应切换内容区，占位项标注「功能开发中」。这一段走的是守卫的正常
    //     路径（请求的项可见时直接采用）。回退路径由单元测试覆盖 —— 触发它需要在会话
    //     存续期间改动权限，而那要等账号管理接口落地。
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
    record('点击占位项后内容区标注功能开发中', systemPanel.includes('功能开发中'), '')
    await screenshot(client, '4b-nav-system')

    await evaluate(client, clickNavByLabel('个人工作台'))
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

    const afterText = await evaluate(client, 'document.body.innerText')
    record('续期过程中未掉回登录页', afterText.includes('权限点'), '')

    const authCalls = JSON.parse(await evaluate(client, 'JSON.stringify(window.__e2e.authCalls)'))
    console.log(`     期间发出的鉴权请求：${authCalls.join(' → ')}`)
    await screenshot(client, '5-after-renew')

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
    await evaluate(client, clickSelector('#login-remember'))
    await evaluate(client, clickSelector('button[type="submit"]'))
    await evaluate(client, waitFor(`document.body.innerText.includes('权限点')`, 25000, '再次登录'))
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

    // 9. 渲染层无错误。这是本脚本存在的理由。
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
