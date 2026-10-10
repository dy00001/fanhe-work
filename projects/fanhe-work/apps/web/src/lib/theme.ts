/**
 * 主题的解析与生效。
 *
 * 与 `preferences.ts` 的分工：那边只管「偏好是什么」，这边管「偏好怎么变成界面」。
 * 分开的理由是两者的失效方式不同 —— 存储读不出来只影响初始值，而 DOM 操作出错的
 * 影响面是整页配色；混在一起之后，将来要在非浏览器环境（Electron 主进程、单元测试）
 * 复用前者时会被迫连 DOM 一起带过去。
 *
 * 单开文件而不是写进 `TopBar.tsx`，另一层考虑是 react-refresh：一个文件同时导出
 * 组件与 hook 时，热更新无法确定该保留哪一部分的状态（同款说明见 `auth/context.ts`）。
 *
 * **初值的实际落点在 `index.html` 的内联脚本里，不在本模块。** 主题与侧栏折叠看起来
 * 是同一类偏好，但时机不同：折叠状态只影响已登录后的外壳，而配色在**第一个像素**上
 * 就要对，那时 React 还没挂载。所以内联脚本先加类名，本模块负责之后的每一次变更，
 * 两者判断规则一致（见 `preferences.ts` 的注释）。
 */

import { useEffect, useState } from 'react'

import { type ThemePreference, readThemePreference, writeThemePreference } from './preferences'

/**
 * `<html>` 上表示暗色的类名。与 `index.css` 的 `@custom-variant dark`、`index.html`
 * 的内联脚本三处必须一致 —— 这个字符串是它们之间唯一的约定。
 */
const DARK_CLASS = 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 把偏好解析成实际要用的配色。
 *
 * `'system'` 每次都现问一次媒体查询，不缓存结果：缓存下来的话，用户中途改了系统
 * 设置而界面不动，而这条路径上没有任何东西能触发重算。
 */
export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'system') {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
  }
  return preference
}

/**
 * 把配色落到 `<html>` 上。
 *
 * 只切类名，不写内联样式：`color-scheme` 与全部颜色令牌都由 `index.css` 的 `.dark`
 * 块提供，这里再写一遍就多出一处需要同步的真相。
 */
export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle(DARK_CLASS, theme === 'dark')
}

/**
 * 主题偏好的读写与生效。
 *
 * 返回的是**偏好**而不是解析后的配色：界面上要显示的是用户选的那一档（含「跟随
 * 系统」），而不是它此刻恰好等于亮还是暗 —— 后者会让「跟随系统」这一档看起来像
 * 一个没被选中的状态。
 */
export function useTheme(): {
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
} {
  const [preference, setPreferenceState] = useState(readThemePreference)

  // 挂载时先对一次账：内联脚本已经加过类名，这里再算一遍是幂等的，但能让「DOM 状态」
  // 与「React 读到的偏好」在应用自己的入口被重新对齐一次（例如测试直接注入页面、
  // 内联脚本没跑的情形）。
  //
  // 系统配色变化只在「跟随系统」这一档下需要响应，所以监听写在条件之后而不是
  // 每次变化都判断：切到固定档之后这条监听就不该再挂着。
  useEffect(() => {
    applyTheme(resolveTheme(preference))
    if (preference !== 'system') return

    const query = window.matchMedia(DARK_QUERY)
    const sync = () => {
      applyTheme(resolveTheme('system'))
    }
    query.addEventListener('change', sync)
    return () => {
      query.removeEventListener('change', sync)
    }
  }, [preference])

  // 与 `AppShell` 的折叠切换同一条：先算再写，不把写回塞进状态更新函数 ——
  // StrictMode 下更新函数会跑两次，副作用藏在那里迟早出问题。
  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next)
    writeThemePreference(next)
    applyTheme(resolveTheme(next))
  }

  return { preference, setPreference }
}
