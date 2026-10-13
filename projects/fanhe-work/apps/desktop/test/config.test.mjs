/**
 * 服务地址配置的回归测试（T4-02）。
 *
 * 这一层要钉住的是三件**只有跑起来才看得见**、而类型检查与 lint 一概管不到的事：
 *
 * 1. **配置坏了外壳不能起不来。** 坏 JSON、非法地址、空串、顶层是数组 ——
 *    每一种都必须退回缺省并给出可读原因，而不是抛出去让窗口开不出来。
 * 2. **切换是真的切换。** 改完配置再读，读到的必须是新地址；地址会被归一
 *    （去末尾斜杠），不归一会让「改了但看着没改」。
 * 3. **优先级不能反。** 环境变量 > 文件 > 缺省。这条一旦反了，开发期指向临时
 *    端点就会静默失效，而症状是「我的改动怎么不生效」。
 *
 * 直接测 `src/config.ts`（与 `server.test.mjs` 同款，靠 Node 的类型剥离直接加载
 * TS 源码），因此不需要先构建。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * 干净暂存根。落点与理由见 `test/scratch.mjs` 的文件头 —— 一句话是：
 * **既不能用 `os.tmpdir()`**（入口下它指向工作区的 `.tmp`，而那在 `.ws-root` 底下，
 * 会让「找不到工作区根」那两条用例自相矛盾），**也不能写死某个账户名**
 * （换台机器就是整个文件加载失败）。
 */
import { SYSTEM_SCRATCH } from './scratch.mjs'

import {
  configPathFor,
  DEFAULT_SERVICE_URL,
  findWorkspaceRoot,
  loadServiceConfig,
  normalizeServiceUrl,
  parseConfig,
  saveServiceConfig,
} from '../src/config.ts'

/** 造一个「有工作区根」的临时目录。 */
async function makeWorkspace() {
  const root = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-ws-'))
  await writeFile(join(root, '.ws-root'), '{"schema":1,"id":"test"}', 'utf8')
  return root
}

/** 造一片**保证不含 `.ws-root`** 的目录树，用来验「找不到」的分支。 */
async function makeOrphan() {
  const root = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-orphan-'))
  return root
}

/** 写一份配置。value 非法的用例会走 save 的 catch 分支直接落原始文本。 */
async function writeConfig(root, body) {
  const path = configPathFor(root)
  try {
    await saveServiceConfig(path, { serviceUrl: body })
  } catch {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, '.config', 'fanhe-work'), { recursive: true })
    await writeFile(path, body, 'utf8')
  }
}

// ---------------------------------------------------------------- 校验

test('合法地址被接受，末尾斜杠被归掉', () => {
  assert.deepEqual(normalizeServiceUrl('http://127.0.0.1:8787'), {
    ok: true,
    value: 'http://127.0.0.1:8787',
  })
  assert.deepEqual(normalizeServiceUrl('https://example.tld///'), {
    ok: true,
    value: 'https://example.tld',
  })
})

test('非法地址一律被拒，且原因可读', () => {
  for (const bad of ['', '   ', 'example.tld', 'ws://example.tld', 'file:///c:/x', 'ftp://a.tld']) {
    const result = normalizeServiceUrl(bad)
    assert.equal(result.ok, false, `「${bad}」本该被拒`)
  }
})

test('非字符串被拒', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(normalizeServiceUrl(bad).ok, false)
  }
})

// ---------------------------------------------------------------- 解析

test('缺 serviceUrl 视作缺省，而不是报错', () => {
  const parsed = parseConfig('{}')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.config.serviceUrl, DEFAULT_SERVICE_URL)
})

test('坏 JSON、顶层非对象都被拒并说明原因', () => {
  assert.equal(parseConfig('{oops').ok, false)
  assert.equal(parseConfig('[]').ok, false)
  assert.equal(parseConfig('"str"').ok, false)
  assert.equal(parseConfig('null').ok, false)
})

test('合法文件解析后地址已归一', () => {
  const parsed = parseConfig('{"serviceUrl":"https://a.tld//"}')
  assert.equal(parsed.ok && parsed.config.serviceUrl, 'https://a.tld')
})

// ---------------------------------------------------------------- 工作区定位

test('能从任意深度向上找到 .ws-root', async () => {
  const root = await makeWorkspace()
  try {
    assert.equal(
      findWorkspaceRoot(join(root, 'projects', 'fanhe-work', 'apps', 'desktop', 'dist')),
      root,
    )
    assert.equal(findWorkspaceRoot(root), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('找不到 .ws-root 时返回 null 而不是抛错', async () => {
  const orphan = await makeOrphan()
  try {
    assert.equal(findWorkspaceRoot(join(orphan, 'deeper', 'deeper')), null)
  } finally {
    await rm(orphan, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 读取优先级

test('环境变量赢过文件', async () => {
  const root = await makeWorkspace()
  try {
    const path = configPathFor(root)
    await saveServiceConfig(path, { serviceUrl: 'https://from-file.tld' })

    const result = await loadServiceConfig({
      workspaceRoot: root,
      env: { FANHE_SERVICE_URL: 'http://127.0.0.1:9999' },
      fromDir: root,
    })

    assert.equal(result.config.serviceUrl, 'http://127.0.0.1:9999')
    assert.equal(result.source, 'environment')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('没有环境变量时读文件', async () => {
  const root = await makeWorkspace()
  try {
    await saveServiceConfig(configPathFor(root), { serviceUrl: 'https://from-file.tld/' })
    const result = await loadServiceConfig({ workspaceRoot: root, env: {}, fromDir: root })
    assert.equal(result.config.serviceUrl, 'https://from-file.tld')
    assert.equal(result.source, 'file')
    assert.equal(result.warning, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('文件不存在时退回缺省并给出警告', async () => {
  const root = await makeWorkspace()
  try {
    const result = await loadServiceConfig({ workspaceRoot: root, env: {}, fromDir: root })
    assert.equal(result.config.serviceUrl, DEFAULT_SERVICE_URL)
    assert.equal(result.source, 'default')
    assert.match(result.warning ?? '', /未找到服务地址配置/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('坏文件退回缺省，并把原因报出来', async () => {
  const root = await makeWorkspace()
  try {
    await writeConfig(root, '{ this is not json')
    const result = await loadServiceConfig({ workspaceRoot: root, env: {}, fromDir: root })
    assert.equal(result.config.serviceUrl, DEFAULT_SERVICE_URL)
    assert.match(result.warning ?? '', /不是合法 JSON/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('坏地址值也退回缺省', async () => {
  const root = await makeWorkspace()
  try {
    await writeConfig(root, '{"serviceUrl":"ws://nope.tld"}')
    const result = await loadServiceConfig({ workspaceRoot: root, env: {}, fromDir: root })
    assert.equal(result.config.serviceUrl, DEFAULT_SERVICE_URL)
    assert.match(result.warning ?? '', /只支持 http 与 https/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('环境变量本身非法时不生效，退回继续读文件', async () => {
  const root = await makeWorkspace()
  try {
    await saveServiceConfig(configPathFor(root), { serviceUrl: 'https://from-file.tld' })
    const result = await loadServiceConfig({
      workspaceRoot: root,
      env: { FANHE_SERVICE_URL: '不是地址' },
      fromDir: root,
    })
    assert.equal(result.config.serviceUrl, 'https://from-file.tld')
    assert.equal(result.source, 'file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('找不到工作区根时退回缺省，不抛', async () => {
  const orphan = await makeOrphan()
  try {
    // 不给 workspaceRoot，让它真的从 fromDir 向上找一遍 —— 那棵目录树里没有
    // .ws-root，找不到才是这条用例要验的那条路径。
    const result = await loadServiceConfig({
      env: {},
      fromDir: join(orphan, 'x', 'y'),
    })
    assert.equal(result.config.serviceUrl, DEFAULT_SERVICE_URL)
    assert.equal(result.source, 'default')
    assert.match(result.warning ?? '', /未找到工作区根/)
  } finally {
    await rm(orphan, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 写入

test('写完能原样读回，且是带换行的格式化 JSON', async () => {
  const root = await makeWorkspace()
  try {
    const path = configPathFor(root)
    const written = await saveServiceConfig(path, { serviceUrl: 'https://a.tld/' })
    assert.equal(written.serviceUrl, 'https://a.tld')

    const raw = await readFile(path, 'utf8')
    assert.equal(raw.endsWith('\n'), true)
    assert.deepEqual(JSON.parse(raw), { serviceUrl: 'https://a.tld' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('写非法地址时抛错，不落盘', async () => {
  const root = await makeWorkspace()
  try {
    const path = configPathFor(root)
    await assert.rejects(() => saveServiceConfig(path, { serviceUrl: 'ftp://a.tld' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('写配置时自动建目录', async () => {
  const root = await makeWorkspace()
  try {
    const path = configPathFor(root)
    await saveServiceConfig(path, { serviceUrl: 'https://a.tld' })
    const again = await loadServiceConfig({ workspaceRoot: root, env: {}, fromDir: root })
    assert.equal(again.source, 'file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/*
 * 以下是 T6-03a 新增的「装完之后」那一半。
 *
 * 装出来的客户端没有工作区，而服务地址这件配置必须有地方落盘 —— 否则界面上的
 * 「切换服务地址」在安装版里根本写不进去（`service:set` 会一直返回「未找到配置文件
 * 路径」），而缺省值又指向本机 8787，在别人机器上连的是一个不存在的端口。
 */

test('安装态：配置落在 configDir 下，且 service:set 真的写得进去', async () => {
  // 临时目录上方没有 .ws-root —— 正是装完之后的样子。
  const root = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-config-packed-'))
  const configDir = join(root, 'userData')
  try {
    const loaded = await loadServiceConfig({
      fromDir: root,
      configDir,
      defaultUrl: 'https://work.example.tld',
      env: {},
    })

    // `path` 非空是这一条的核心：main.ts 的 `service:set` 拿不到路径就写不了。
    assert.equal(loaded.path, join(configDir, 'service.json'))
    assert.equal(loaded.source, 'default')
    assert.equal(loaded.config.serviceUrl, 'https://work.example.tld')

    // 真写一次再读回来 —— 只断言路径形状证明不了「写得进去」。
    await saveServiceConfig(loaded.path, { serviceUrl: 'https://other.example.tld' })
    const again = await loadServiceConfig({ fromDir: root, configDir, env: {} })
    assert.equal(again.source, 'file')
    assert.equal(again.config.serviceUrl, 'https://other.example.tld')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装态的兜底地址必须按形态给，不能共用开发态那个', async () => {
  // 开发态的兜底是 127.0.0.1:8787，在开发机上恰好是对的（api 就在本机），
  // 装到别人机器上却是一个不存在的端口 —— 而本机冒烟还能全绿。
  const root = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-config-fallback-'))
  try {
    const loaded = await loadServiceConfig({ fromDir: root, configDir: join(root, 'ud'), env: {} })
    assert.equal(
      loaded.config.serviceUrl,
      DEFAULT_SERVICE_URL,
      '不传 defaultUrl 时应当仍是开发态那个缺省值',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装态：configDir 压过工作区根（插着介质也不读那边的配置）', async () => {
  // 这台机器上恰好插着一个工作区时，安装版仍然该读自己的配置 —— 否则「装完的
  // 客户端连哪儿」会随 U 盘在不在而变，而那是一种极难解释的间歇性故障。
  const root = await makeWorkspace()
  const configDir = join(root, 'userData')
  try {
    await saveServiceConfig(configPathFor(root), { serviceUrl: 'https://from-workspace.tld' })

    const loaded = await loadServiceConfig({
      fromDir: join(root, 'projects', 'fanhe-work', 'apps', 'desktop', 'dist'),
      configDir,
      defaultUrl: 'https://from-package.tld',
      env: {},
    })

    assert.equal(loaded.path, join(configDir, 'service.json'))
    assert.equal(
      loaded.config.serviceUrl,
      'https://from-package.tld',
      '不该读到工作区那份 https://from-workspace.tld',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
