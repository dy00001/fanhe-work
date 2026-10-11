import { CaseGallery } from '../components/home/CaseGallery'
import { LaunchSection } from '../components/home/LaunchSection'
import { RecordSection } from '../components/home/RecordSection'

/**
 * 首页（导航项 `workbench`，地址 `/workbench`）。
 *
 * 与原型编号 9 / 10 / 11 一一对应的三段纵向排列：
 *
 *   1. 案例展示 —— 按品类横滑的运营位；
 *   2. 一键启动 —— 4×2 Bento，主卡接真实启动配置，六张单元卡是「开发中」占位；
 *   3. 工作纪要及事件记录 —— 两张卡，接真实数据。
 *
 * **三段各自决定自己渲不渲染，本页不做权限判定。** 一键启动要有 `personal.launch.read`、
 * 纪要卡与事件卡各要自己的读权限 —— 这些判定写在各自的组件里，与面板那一层的做法
 * 一致。集中到这一页会得到一个「本页需要哪些权限」的清单，而那份清单在新增一段时
 * 必然会被漏改，表现为「新段落对谁都可见」。
 *
 * **这里没有页头。** 原型首页就是从案例展示直接开始的，没有模块标题卡；上一版的
 * `ModuleHeader` 也随之从首页去掉，只保留在三个子页面上（`/workbench/notes` 等
 * 仍需要一行标题说明自己在哪）。
 *
 * 段间距是两档而不是一个固定值：首段到次段 48、其后 44，取自原型的实测值。用
 * `space-y-*` 表达不了「第一段间距与后面的不同」，所以写成两条相邻兄弟选择器。
 */
export function HomePage() {
  return (
    <div className="flex flex-col [&>section+section]:mt-12 [&>section+section+section]:mt-11">
      {/* 只给读屏软件的 h1。原型首页从案例展示直接开始、没有可见标题，但一个页面没有
          h1 会让读屏用户失去「这一页是什么」的第一个锚点，也拿不到标题导航。用
          `sr-only` 而不是可见标题：可见标题会与三段的区块标题抢层级，视觉上也多余。
          这一条不改变任何可见结构。 */}
      <h1 className="sr-only">首页</h1>
      <CaseGallery />
      <LaunchSection />
      <RecordSection />
    </div>
  )
}
