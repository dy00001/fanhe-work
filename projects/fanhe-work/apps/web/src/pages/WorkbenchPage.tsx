import { PERMISSION_CATALOG, ROLES, type NavItem } from '@fanhe/shared'
import { ShieldOff } from 'lucide-react'

import { useAuth } from '../auth/useAuth'
import { EmptyState } from '../components/EmptyState'
import { ModuleHeader } from '../components/ModuleHeader'

/**
 * 个人工作台的落地内容。
 *
 * 真正的三板块（一键登录通道、工作纪要、事件记录）属阶段三。本页在阶段二承担
 * 两个职责：一是作为登录后的默认落点，二是把当前账号与展开后的权限点摆出来，
 * 让登录、会话续期与权限可见范围有一个可观察的验证面。这段诊断内容随阶段三
 * 三板块落地后移除。
 *
 * 页头用 `ModuleHeader`。它与占位页的区别由路由表决定：个人工作台 `planned` 为
 * false，路由分派给本页；占位模块交给 `PlaceholderPage`。两个页面各自持有自己的
 * 呈现方式，不再由一个组件按标志位切换。
 */
export function WorkbenchPage({ item }: { item: NavItem }) {
  const { user, permissions } = useAuth()

  // 类型上不可能为空：本页只在外壳内渲染，而外壳只在 authenticated 状态下挂载。
  // 判空是为了收窄类型，同时给出一条明确的兜底路径而不是让下面的解引用炸掉。
  // 必须放在所有 hook 之后，否则 hooks 的调用顺序会随状态变化。
  if (user === null) return null

  // 角色名与权限说明都取自共享包，与服务端引用同一份常量。前端另写一份映射迟早
  // 会与服务端不一致，而这类不一致只表现为「界面上显示的名字不对」。
  const roleName = ROLES.find((role) => role.code === user.role)?.name ?? user.role

  return (
    <div className="flex flex-col gap-4">
      <ModuleHeader item={item} />

      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-base font-medium text-foreground">当前账号</h2>
        <dl className="mt-4 divide-y divide-border-soft">
          <div className="flex items-center justify-between py-2.5 text-sm">
            <dt className="text-muted-foreground">账号</dt>
            <dd className="text-foreground">{user.username}</dd>
          </div>
          <div className="flex items-center justify-between py-2.5 text-sm">
            <dt className="text-muted-foreground">显示名</dt>
            <dd className="text-foreground">{user.displayName}</dd>
          </div>
          <div className="flex items-center justify-between py-2.5 text-sm">
            <dt className="text-muted-foreground">角色</dt>
            <dd className="text-foreground">
              {roleName}
              <span className="ml-2 text-xs text-muted-foreground-weak">{user.role}</span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-base font-medium text-foreground">
          权限点
          <span className="ml-2 text-xs font-normal text-muted-foreground-weak">
            {permissions.length} 项
          </span>
        </h2>
        {permissions.length === 0 ? (
          // 内联形态：卡片自身已有标题「权限点」，这里再出一个页面级标题会破坏层级。
          <EmptyState
            variant="plain"
            icon={ShieldOff}
            title="当前角色没有任何权限点"
            description="权限点由角色决定，请联系管理员调整角色后再试。"
            className="mt-3"
          />
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {permissions.map((code) => {
              const description =
                PERMISSION_CATALOG.find((entry) => entry.code === code)?.description ?? ''
              return (
                <li key={code} className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">{description}</span>
                  <code className="shrink-0 font-mono text-xs text-muted-foreground-weak">
                    {code}
                  </code>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground-weak">
        主框架已按实施方案第五章的规格实现（侧栏 224px / 折叠 64px、顶栏 56px、内容区最大宽度）。
        一级导航已接入路由，每个模块都有可直接访问的地址。个人工作台三板块在阶段三实现。
        本页是阶段二的落地页，用于验证登录、会话续期、权限可见范围与主框架尺寸。
      </p>
    </div>
  )
}
