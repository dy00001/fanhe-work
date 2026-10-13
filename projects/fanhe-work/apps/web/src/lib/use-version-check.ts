/**
 * 版本检查的 React 侧接线（T6-02）。
 *
 * ## 为什么 hook 与判定逻辑分两个文件
 *
 * 纯逻辑在 `lib/version-check.ts`，hook 在这里。两个原因叠加：
 *
 * 1. **可测性。** 判定逻辑要在 Node 里直接跑（`test/version-check.test.mjs`），而这个
 *    文件依赖 `react` 与 `./api` —— 前者在 Node 下没有 DOM 上下文，后者的无扩展名
 *    相对引用 Node 的 ESM 解析不接受（`ERR_MODULE_NOT_FOUND`，且报在加载阶段，
 *    连同文件里的纯函数一起跑不了）。
 * 2. **react-refresh。** 一个文件同时导出组件与 hook 时，热更新无法确定该保留哪
 *    一部分的状态（同款说明见 `lib/theme.ts`）。
 *
 * 同 `theme.ts` 与 `preferences.ts` 的分工：那边是「偏好是什么」与「偏好怎么变成
 * 界面」分开，这边是「判定结论是什么」与「什么时候去问、问完怎么写进状态」分开。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { versionManifestRequest } from './api'
import { currentHost } from './host'
import { type UpdateNotice, buildUpdateNotice, startVersionCheck } from './version-check'
import { APP_VERSION, BUILD_TIME, COMMIT_SHA } from './version'

/**
 * 本机清单的原始三项。
 *
 * **模块加载时取一次而不是每次 refresh 取。** 这三项是构建期常量（`lib/version.ts` 的
 * 文件头解释了它们为什么不变），而它们在 Node 下会退化成 `'0.0.0'` / `''` / `''` ——
 * 那是 `typeof` 守卫的既有行为，本模块不改变它。
 *
 * 在这里读而不是让 `version-check.ts` 自己读：那会让判定层 import 一个相对路径模块，
 * 于是它无法在 Node 里被直接测（理由见 `version-check.ts` 的文件头）。
 */
const LOCAL = { version: APP_VERSION, builtAt: BUILD_TIME, commitSha: COMMIT_SHA } as const

/**
 * 当前宿主，同样在模块加载时取一次。
 *
 * 预加载脚本在页面脚本之前执行，所以到这一行时桥已经在了；而宿主在一次会话里不会变
 * （外壳不会在某次刷新后变成浏览器），每次 refresh 重读只会多一次全局访问。
 *
 * 传给 `buildUpdateNotice` 而不是让那一层自己判断：判定层不 import 相对路径模块。
 */
const HOST = currentHost()

/**
 * 版本检查的状态，供账号菜单消费。
 *
 * 返回 `notice: null` 就表示「那一行不渲染」。**没有 loading 态**：提示只在
 * `outdated` 时出现，而「还在查」与「查了没有更新」在界面上是同一件事（都不显示），
 * 多一个状态就多一处需要判断的地方 —— 而把「正在查」显示出来对用户也没有价值，
 * 那是每分钟最多发生一次、持续几十毫秒的事。
 *
 * ## 什么时候查
 *
 * **挂载时查一次 + 每次菜单打开时重查。** 只在打开时查的话，第一次打开菜单的那一瞬
 * 请求还没回来，用户看到的仍是空值，要再开一次才知道；而每次打开都查会让一个从头
 * 到尾没打开过菜单的会话完全不发这个请求。两者的缺点分别是「多一次无用请求」与
 * 「提示晚一次出现」，前者更便宜。
 *
 * 重查而不是只信挂载时那次的另一个理由：Electron 外壳（T6-03）会把应用开一整天，
 * 期间服务端可能已经发新版；每次打开菜单重查才能给出当下的结论。
 *
 * ## StrictMode 下挂载那一次会发两个请求
 *
 * 挂载 effect 在 StrictMode 里跑两遍，而开发环境不做去重。这里**刻意不去重**：
 * 一个几十字节的 GET，去重要引入「上一次还没回来时新的请求要不要等它」的状态机，
 * 而它防下的只是一次重复请求。开发环境多发一次换来逻辑更短，这个交换划算。
 *
 * `refresh` 用 `useCallback` 固定引用 —— 它会作为 `onOpenChange` 传给 Radix 的菜单，
 * 每次渲染换一个新函数会让那儿的内部 memo 全部失效。
 */
export function useVersionCheck(): { notice: UpdateNotice | null; refresh: () => void } {
  const [notice, setNotice] = useState<UpdateNotice | null>(null)

  // 正在飞行的检查。用来在发起下一次之前取消上一次：两次检查重叠时，先发的那次可能
  // 后到，而它带回来的是更旧的结论 —— 一条「慢一步」的更新提示比没有更糟。
  const inFlight = useRef<{ abort: () => void } | null>(null)

  const refresh = useCallback(() => {
    inFlight.current?.abort()
    const check = startVersionCheck(versionManifestRequest, LOCAL)
    inFlight.current = check

    void check.result
      .then((comparison) => {
        // 已被后一次取代时不写状态。
        if (inFlight.current !== check) return
        setNotice(buildUpdateNotice(comparison, LOCAL.version, HOST))
      })
      .catch(() => {
        // startVersionCheck 本身不抛（见 version-check.ts 文件头）。这一支是给
        // 「它将来的实现变了」留的：组件不能因为一条非关键路径的意外而白屏。
        if (inFlight.current !== check) return
        setNotice(null)
      })
      .finally(() => {
        if (inFlight.current === check) inFlight.current = null
      })
  }, [])

  // 挂载时查一次。
  useEffect(() => {
    refresh()
  }, [refresh])

  // 卸载时取消在飞行的检查。不取消的话，`then` 会在组件已经卸载之后到达 ——
  // React 18 起这不会再报警告，但请求本身白跑一趟，且 `setNotice` 打在一个不存在的
  // 组件上。
  useEffect(() => {
    return () => {
      inFlight.current?.abort()
    }
  }, [])

  return { notice, refresh }
}
