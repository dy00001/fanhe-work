import { useCallback, useEffect, useState } from 'react'

import { loadCaseUploadImage } from './case-library'

/**
 * 上传图的地址解析。
 *
 * **为什么不能直接把接口路径写进 `<img src>`**：取图接口要 Bearer 令牌，而 `<img>` 标签
 * 不会带请求头。这里用带令牌的 `fetch` 取回字节、转成 object URL，再把那个地址交给
 * 图片元素。代价是多一次内存拷贝，换来的是「图片不靠猜地址保护」。
 *
 * **缓存放在模块级。** 图集打开又关掉是很常见的动作（看完主卧再看衣柜），每次重新拉
 * 一遍缩略图等于每次都要几百毫秒的空窗；而这些字节在会话期内不会变（同一个 itemId 的
 * 字节永不改变，改图是删掉重传一张新的），缓存它们的正确性没有疑问。
 *
 * 缓存不主动回收：一个品类最多 300 张缩略图（约 3MB object URL 背后是 3MB 内存），
 * 关掉图集之后仍然留着，是为了下次打开是瞬时的。真正会累积的场景（一天里翻遍 13 个
 * 品类）也不过几十 MB，与「每次都重新拉」的体验代价相比是划算的。
 */

const thumbCache = new Map<string, string>()
const fullCache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

function cacheOf(variant: 'thumb' | 'full'): Map<string, string> {
  return variant === 'thumb' ? thumbCache : fullCache
}

function keyOf(itemId: string, variant: 'thumb' | 'full'): string {
  return `${variant}:${itemId}`
}

/**
 * 取一个 object URL。
 *
 * 同一个 id + 变体并发请求时只发一次（`inflight` 去重）：网格里同一张图可能因为筛选
 * 切换被重新挂载，而两个并发的 blob 请求除了浪费一次往返，还会产生两个 object URL、
 * 释放掉其中一个就够让另一处显示成裂图。
 *
 * 失败返回 `null` 而不是抛错：调用方会回落到「还没加载好」的占位，下一轮 effect 再试。
 * 抛错则要在渲染路径上处理错误边界，而那会把整个图集打掉 —— 一张图取不到不该有这种
 * 后果。
 */
async function resolveImage(itemId: string, variant: 'thumb' | 'full'): Promise<string | null> {
  const key = keyOf(itemId, variant)
  const cached = cacheOf(variant).get(key)
  if (cached !== undefined) return cached

  const running = inflight.get(key)
  if (running !== undefined) return running

  const task = loadCaseUploadImage(itemId, variant)
    .then((url) => {
      cacheOf(variant).set(key, url)
      return url
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, task)
  return task
}

/**
 * 一张上传图解析出来的两个地址，各自可能还没取到。
 *
 * 两边都显式写 `| undefined`：本仓库开了 `exactOptionalPropertyTypes`，只写 `thumb?: string`
 * 的话「这个字段存在、值是 undefined」就不合法了，而这里恰恰要表达那个意思 —— 表里有这条
 * 记录、只是缩略图还没回来。
 */
export type CaseUploadEntry = {
  thumb?: string | undefined
  full?: string | undefined
}

export type CaseUploadImages = {
  /**
   * 已解析的地址表，键是 itemId。
   *
   * **消费方直接把这一项写进依赖数组**（不要用 `thumbOf(...)` 那种取值函数）：表本身
   * 每解析成功一次就换一个新引用，依赖它才知道该重绘；而取值函数是稳定的，用它做依赖
   * 等于「图取回来了界面不动」。表里没有的 id 就是还没解析好。
   */
  entries: Readonly<Record<string, CaseUploadEntry>>
  /** 主动去取原图。打开放大层时调用 —— 那才是「用户真的想看细节」的时刻。 */
  ensureFull: (itemId: string) => void
}

/** 从模块缓存里把这一批 id 现有的地址抄成一张表。缓存里没有的就不进表。 */
function readEntries(ids: readonly string[]): Record<string, CaseUploadEntry> {
  const next: Record<string, CaseUploadEntry> = {}
  for (const id of ids) {
    const thumb = thumbCache.get(keyOf(id, 'thumb'))
    const full = fullCache.get(keyOf(id, 'full'))
    if (thumb === undefined && full === undefined) continue
    next[id] = { thumb, full }
  }
  return next
}

/**
 * 两张表是否等价。
 *
 * 用它挡掉空转的 setState：`readEntries` 每次都会造一个新对象，直接塞进去会让组件
 * 每拉完一批就重绘一次，哪怕内容一个字都没变 —— 而重绘又会重新触发消费方的 `useMemo`。
 */
function sameEntries(
  a: Readonly<Record<string, CaseUploadEntry>>,
  b: Readonly<Record<string, CaseUploadEntry>>,
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => a[key]?.thumb === b[key]?.thumb && a[key]?.full === b[key]?.full)
}

/**
 * 把一批上传图的缩略图拉进来。
 *
 * @param itemIds 这一屏在显示的上传图。只取它们，不取整库：13 个品类全量预取会让
 *   打开任何一页都变成几十次并发请求。
 * @param enabled 弹窗是否打开。关着的时候不拉。
 */
export function useCaseUploadImages(
  itemIds: readonly string[],
  enabled: boolean,
): CaseUploadImages {
  const [entries, setEntries] = useState<Record<string, CaseUploadEntry>>({})

  /**
   * 依赖用拼接字符串而不是数组本身：调用方每次渲染都会产生一个新数组（`filter` 的
   * 结果），拿数组做依赖等于每帧都重跑一次 effect，而它内部会 setState —— 那就成了
   * 一个自我驱动的循环。拼成字符串之后，「同一批 id」在两次渲染里是同一个值。
   */
  const signature = itemIds.join(',')

  useEffect(() => {
    if (!enabled || signature === '') return
    const ids = signature.split(',')
    let active = true

    const commit = () => {
      if (!active) return
      const next = readEntries(ids)
      setEntries((prev) => (sameEntries(prev, next) ? prev : next))
    }

    // 命中模块缓存的先画出来，不必等请求（关掉图集再打开就是这条路径）。
    commit()

    // 只为缺的那些发请求：已经缓存过的直接跳过，否则每次筛选切换都会重拉一遍。
    const missing = ids.filter((id) => !thumbCache.has(keyOf(id, 'thumb')))
    if (missing.length === 0) return

    // 全部失败时 commit 会算出与上次相同的表，`sameEntries` 挡住重绘 —— 于是
    // 「失败 → 重绘 → 再失败」这个循环在 source 上就不成立，不需要额外的判定。
    void Promise.all(missing.map((id) => resolveImage(id, 'thumb'))).then(commit)

    return () => {
      active = false
    }
  }, [signature, enabled])

  const ensureFull = useCallback((itemId: string) => {
    if (fullCache.has(keyOf(itemId, 'full'))) return
    void resolveImage(itemId, 'full').then((url) => {
      if (url === null) return
      setEntries((prev) => {
        const current = prev[itemId]
        return {
          ...prev,
          [itemId]: {
            // 缩略图可能还在路上，顺手把缓存里已有的那一份也带上，少一次重绘。
            thumb: current?.thumb ?? thumbCache.get(keyOf(itemId, 'thumb')),
            full: url,
          },
        }
      })
    })
  }, [])

  return { entries, ensureFull }
}
