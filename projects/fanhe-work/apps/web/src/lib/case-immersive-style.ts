import type { CSSProperties } from 'react'

/**
 * 放大层全屏时，弹窗要改成这副尺寸。
 *
 * **这里必须写 `translate: 'none'`，只写 `transform: 'none'` 是不够的 —— 这是
 * 2026-11-02 的真实故障。** Tailwind v4 把 `translate-x-[-50%]` / `translate-y-[-50%]`
 * 编译成**独立属性**：
 *
 *     .translate-y-\[-50\%\] { --tw-translate-y: -50%; translate: var(--tw-translate-x) var(--tw-translate-y); }
 *
 * 而 `translate` 与 `transform` 是两套东西。只抹 transform，基类那条 `-50% -50%` 照旧
 * 生效，弹窗虽然拿到了 100vw×100dvh，却整体被推到视口左上角之外，只有右下四分之一露在
 * 屏幕里；放大层里居中的那张图，于是以视口原点为中心，看起来「卡在左上角」，顶栏（关闭、
 * 全屏、100% 复位）全在视口外，用户找不到出口。现象很像「全屏没生效」，实际是全屏生效了
 * 但整块面板被平移走了。
 *
 * 判断依据（打包后的 CSS 里可以直接看到）：
 *   `grep -o 'translate:var(--tw-translate-x)' dist/assets/*.css`
 *
 * 其余几条各自的必要性：
 *   - `position: fixed` + `inset: 0`：不依赖基类。基类哪天把 `fixed` 挪走（2026-10-30
 *     那次 tailwind-merge 删掉 `fixed` 的事故同源），这里仍然把面板钉在视口原点。
 *   - `maxWidth/maxHeight: none`：基类有 `sm:max-w-[min(1120px,94vw)]` 与 `max-h-[92vh]`，
 *     内联值优先级确定，不必和它们抢 className。
 *   - `100dvh` 取「地址栏收起后的可视高度」，正好对上移动端全屏的意图；不支持的旧浏览器
 *     会忽略这一条，回落到 `inset: 0`，仍是满屏。
 *
 * 为什么用内联样式而不是 className：`top/left` 与 `translate` 在基类里是一组联动值，
 * 用 className 覆盖会走到 tailwind-merge 的合并规则上（同组互斥），而内联样式优先级
 * 确定、只在全屏这一个状态挂上去，放大层一关整体消失，不会留下残留。
 */
export const CASE_IMMERSIVE_DIALOG_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  translate: 'none',
  transform: 'none',
  width: '100vw',
  height: '100dvh',
  maxWidth: 'none',
  maxHeight: 'none',
  margin: 0,
  borderRadius: 0,
}
