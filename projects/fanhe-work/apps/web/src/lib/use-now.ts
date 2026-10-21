import { useEffect, useState } from 'react'

/**
 * 每分钟推进一次的「现在」。
 *
 * 为什么需要它：新鲜度标签（`freshnessOf`）是拿「现在」和采集时间比出来的，而
 * 组件里写 `const now = new Date()` 只在渲染时取一次 —— 页面不重新渲染，「现在」
 * 就冻在那一刻。实测后果是：窗口挂 30 小时，标签仍然显示「数据新鲜」，因为对它
 * 来说时间没有流动过。这比不显示更糟：它给出的是一个肯定的、错误的结论。
 *
 * 一分钟的间隔是按这个标签的精度定的（文案分「新鲜 / 偏旧 / 过期」三档，最小档
 * 是小时级），再密就是白跑。定时器在卸载时清掉，不会在后台标签页里常驻。
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(new Date())
    }, intervalMs)
    return () => {
      window.clearInterval(id)
    }
  }, [intervalMs])

  return now
}
