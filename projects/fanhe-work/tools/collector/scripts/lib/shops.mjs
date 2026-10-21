/**
 * 多店铺采集槽位（唯一来源：shops.config.json）
 *
 * 为什么要有这一层
 *   看板固定五列，但采集端原本只有一个 Edge 调试端口、一个浏览器 profile、
 *   一个 data/daily 根目录。四家店共用一个 profile 的后果是互相顶号：
 *   生意参谋的登录态按账号存在 cookie 里，登录 B 店就把 A 店踢下线，
 *   采集器拿到的仍是「登录成功」的页面，只是店铺已经不是原来那家 ——
 *   这类错位不会报错，只会让 B 店的数据顶着 A 店的名字入库。
 *   所以隔离必须落在浏览器 profile 上：一店一个 user-data-dir、一店一个端口、
 *   一店一个输出根目录。
 *
 * 这里只做「读配置 + 校验 + 派生路径」，不启动浏览器、不碰网络。
 * 采集、登录引导、门禁、导出都从这里取槽位，避免端口/目录在两处各写一份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const COLLECTOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SHOPS_FILE = path.join(COLLECTOR_ROOT, 'shops.config.json')

const CODE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 读原始配置。文件缺失或 JSON 坏了直接抛，不静默回退到单店 —— 回退会让四家店的数据写进同一目录。 */
export function loadConfig() {
  if (!fs.existsSync(SHOPS_FILE)) {
    throw new Error(`缺少店铺槽位表：${SHOPS_FILE}`)
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(SHOPS_FILE, 'utf8'))
  } catch (e) {
    throw new Error(`店铺槽位表不是合法 JSON（${SHOPS_FILE}）：${e.message}`)
  }
  if (!Array.isArray(parsed?.shops) || parsed.shops.length === 0) {
    throw new Error('店铺槽位表里没有任何店铺（shops 为空）')
  }
  return parsed
}

/**
 * 读配置并补全派生字段。
 * 校验失败一律抛错并指出具体是哪一行哪一项，因为槽位表写错的表现是
 * 「两家店抢同一个端口」或「数据写进别人的目录」，事后极难倒查。
 */
export function loadShops() {
  return normalizeShops(loadConfig())
}

/**
 * 纯函数：给原始配置对象，给校验后的槽位表。
 * 抽出来是为了让校验本身能被反例测到 —— 直接改 shops.config.json 造错，
 * 中途失败会把真实配置留在坏状态。
 */
export function normalizeShops(config) {
  const basePort = Number(config?.defaults?.basePort ?? 9222)
  const seenCode = new Set()
  const seenPort = new Map()

  const shops = config.shops.map((raw, index) => {
    const where = `shops[${index}]`
    const code = String(raw?.code ?? '').trim()
    if (!CODE_RE.test(code)) {
      throw new Error(`${where}.code 不合法（应为小写字母/数字/连字符）：${JSON.stringify(raw?.code)}`)
    }
    if (seenCode.has(code)) {
      throw new Error(`${where}.code 重复：${code}`)
    }
    seenCode.add(code)

    const name = String(raw?.name ?? '').trim()
    if (name === '') {
      throw new Error(`${where}.name 为空。名称会写进库并覆盖店铺名，不能留空。`)
    }

    const collect = raw?.collect === true
    const port = Number(raw?.port ?? 0) || null
    if (collect) {
      if (port === null) {
        throw new Error(`${where}.port 缺失。参与采集的店必须有独立调试端口（建议从 ${basePort} 起顺排）。`)
      }
      if (port < 1024 || port > 65535) {
        throw new Error(`${where}.port 越界：${port}`)
      }
      const clash = seenPort.get(port)
      if (clash !== undefined) {
        throw new Error(`${where}.port ${port} 与 ${clash} 冲突。两个店共用一个调试端口，采到的必然是同一个账号。`)
      }
      seenPort.set(port, code)
    }

    return {
      code,
      name,
      port,
      collect,
      state: String(raw?.state ?? (collect ? 'pending' : 'placeholder')),
      note: String(raw?.note ?? ''),
      platform: String(raw?.platform ?? config?.defaults?.platform ?? 'taobao'),
      profileDir: profileDirOf(code),
      outRoot: outRootOf(code),
    }
  })

  return { config, shops }
}

/** 浏览器 profile 目录。一店一份，cookie 不共享 —— 这是多账号不互相顶号的前提。 */
export function profileDirOf(code) {
  return path.join(COLLECTOR_ROOT, '.browser-profile', code)
}

/** 采集产物根目录：data/daily/<code>/<日期>/。店铺维度在上，日期在下。 */
export function outRootOf(code) {
  return path.join(COLLECTOR_ROOT, 'data', 'daily', code)
}

/** 参与日增的店（collect=true），按端口升序，保证每次跑的顺序一致。 */
export function collectingShops() {
  return loadShops()
    .shops.filter((shop) => shop.collect)
    .sort((a, b) => a.port - b.port)
}

/** 按 code 取槽位。找不到时把可用 code 列出来，避免「拼错一个字母查半天」。 */
export function resolveShop(code) {
  const { shops } = loadShops()
  const hit = shops.find((shop) => shop.code === code)
  if (hit === undefined) {
    throw new Error(`未知店铺 code：${code}。可用：${shops.map((s) => s.code).join('、')}`)
  }
  return hit
}

/**
 * 从任意路径里认店铺：`.../data/daily/<code>/<date>` 或 `.../.browser-profile/<code>`。
 * 导出脚本用它兜底推断，避免人忘了传 --shop 就把 A 店数据写成主店。
 * 认不出返回 null，由调用方决定报错还是回退。
 */
export function shopFromPath(target) {
  const parts = path.resolve(target).split(path.sep)
  const dailyIndex = parts.lastIndexOf('daily')
  const profileIndex = parts.lastIndexOf('.browser-profile')
  const candidates = []
  if (dailyIndex >= 0 && parts[dailyIndex - 1] === 'data') candidates.push(parts[dailyIndex + 1])
  if (profileIndex >= 0) candidates.push(parts[profileIndex + 1])
  const { shops } = loadShops()
  for (const code of candidates) {
    const hit = shops.find((shop) => shop.code === code)
    if (hit !== undefined) return hit
  }
  return null
}
