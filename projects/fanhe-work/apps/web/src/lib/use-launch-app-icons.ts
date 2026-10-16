import { useEffect, useMemo, useRef, useState } from 'react'

import type { LaunchProfile } from '@fanhe/shared'

import { indexLaunchIconUrls } from './launch-app-icon'

/**
 * 批量取「每条配置的可执行文件图标」（§2.9）。
 *
 * ## 一次请求取回整盘，而不是逐条
 *
 * 托盘里通常十几枚。逐条 `await` 会让打开首页时图标一个接一个地冒出来、且要十几次
 * IPC 往返；外壳那条通道本来就是按路径数组收的，一次取完最省。返回的是**按小写路径
 * 索引的查找表**，调用方用 `pickLaunchIconUrl(profile, icons)` 取自己那一条 —— 同一条
 * exe 被两条配置指向（QQ 与 QQ2）时两处共用同一张图，不必各取一次。
 *
 * ## 只请求「还没拿到的那几条」
 *
 * 依赖是「需要取图的路径集合」，所以新增一条配置只会去取那一条的图标，不会把已有的
 * 十几条重取一遍。已经取到的路径记在 ref 里；**只在成功后才记** —— 失败（外壳没起来、
 * 通道暂时不可用）留着重试的机会，而下一次列表刷新就会再试一次。
 *
 * ## 失败与浏览器态都静默回落
 *
 * 取不到图标不是错误状态：卡片的图标位回落成 `launch-icons.ts` 那套通用图标即可。
 * 这里不抛、不弹提示 —— 用户不需要知道「图标没取到」，他需要的是这一行仍然可读。
 * 浏览器态下 `window.fanheDesktop` 不存在，直接不发请求。
 */
export function useLaunchAppIcons(
  profiles: readonly LaunchProfile[] | null,
): Readonly<Record<string, string>> {
  const [icons, setIcons] = useState<Record<string, string>>({})
  const fetchedRef = useRef<Set<string>>(new Set())

  /**
   * 要取图的路径：小写键 → 用户填的原样路径。
   *
   * 键归一成小写是为了去重（Windows 路径大小写不敏感，两条配置指向同一份安装时大小写
   * 很可能不同）；值保留原样是因为桥要求绝对路径、且回传时按请求里的写法配对。
   * `profiles` 换一次身份就重算一次，但内容相同时下面的 effect 不会重复请求（ref 挡着）。
   */
  const wanted = useMemo(() => {
    const map = new Map<string, string>()
    for (const profile of profiles ?? []) {
      const path = profile.executablePath.trim()
      if (path === '') continue
      const key = path.toLowerCase()
      if (!map.has(key)) map.set(key, path)
    }
    return map
  }, [profiles])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const bridge = window.fanheDesktop
    if (bridge?.getLaunchIcons === undefined) return

    const missing: string[] = []
    for (const [key, path] of wanted) {
      if (fetchedRef.current.has(key)) continue
      missing.push(path)
    }
    if (missing.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        const result = await bridge.getLaunchIcons(missing)
        if (cancelled) return
        const indexed = indexLaunchIconUrls(result.icons)
        for (const key of Object.keys(indexed)) fetchedRef.current.add(key)
        if (Object.keys(indexed).length > 0) {
          setIcons((current) => ({ ...current, ...indexed }))
        }
      } catch {
        // 取不到就回落内置图标；不记进 `fetchedRef`，下次列表刷新还会再试。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [wanted])

  return icons
}
