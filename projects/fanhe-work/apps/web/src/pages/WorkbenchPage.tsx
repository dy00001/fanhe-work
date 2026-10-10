import type { NavItem } from '@fanhe/shared'

import { LaunchPanel } from '../components/launch/LaunchPanel'
import { ModuleHeader } from '../components/ModuleHeader'

/**
 * 个人工作台的落地内容。
 *
 * 三板块（一键登录通道、工作纪要、事件记录）在阶段三逐个落地。T3-03 完成第一个：
 * 启动通道的配置管理。本页从阶段二起承担的两项诊断内容（当前账号、展开后的权限点）
 * 在这一版移除 —— 它们当初的存在理由就是「随阶段三三板块落地后移除」。现在页面上
 * 有了真正的功能，再留一块只对开发有意义的账号信息会挤掉它。
 *
 * 页头用 `ModuleHeader`。它与占位页的区别由路由表决定：个人工作台 `planned` 为
 * false，路由分派给本页；占位模块交给 `PlaceholderPage`。两个页面各自持有自己的
 * 呈现方式，不再由一个组件按标志位切换。
 *
 * **本页不读认证上下文。** 板块自己按权限决定露出哪些入口，页头只认导航项 ——
 * 页面层拿不到 `user` 就不必写那句「类型上不可能为空」的收窄判断，也就少一个
 * 只有渲染期才会暴露的空值分支。
 */
export function WorkbenchPage({ item }: { item: NavItem }) {
  return (
    <div className="flex flex-col gap-4">
      <ModuleHeader item={item} />
      <LaunchPanel />
    </div>
  )
}
