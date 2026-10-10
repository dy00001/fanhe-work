import {
  PERMISSION_CATALOG,
  ROLES,
  filterNavigation,
  resolveActiveNav,
  type NavCode,
  type NavItem,
} from '@fanhe/shared'
import { useMemo, useState } from 'react'

import { useAuth } from '../auth/useAuth'
import { AppShell } from '../components/AppShell'

/**
 * 已登录后的落地页。
 *
 * T2-02 把外壳换成了 `AppShell`（左侧导航、顶栏、内容区最大宽度），本页只负责
 * 内容。三件事仍然沿用阶段一的实现，一行未改：菜单按当前权限过滤
 * （`filterNavigation`）、选中项的解析与回退（`resolveActiveNav`）、角色名取自
 * 共享包的常量。
 *
 * 权限在这里只决定**要不要画**。前端隐藏菜单承担的是体验职责，任何人改一个请求
 * 就能绕过；强制校验始终在服务端的 `requirePermission`。
 *
 * 选中项当前由组件状态驱动，不是路由。T2-03 会把「请求项从哪里来」从 state 换成
 * URL，`resolveActiveNav` 的输入与判断不需要变。
 */
export function HomePage() {
  const { user, permissions, logout } = useAuth()
  const [requested, setRequested] = useState<NavCode | null>(null)

  const visibleItems = useMemo(() => filterNavigation(permissions), [permissions])

  // 守卫的落点。`requested` 指向的项可能已经不在可见清单里 —— 会话存续期间
  // 权限被收紧时就会这样，此时解析结果回退到第一项，而不是让内容区停在某个
  // 已经没有权限的模块上。
  const activeItem = useMemo(
    () => resolveActiveNav(visibleItems, requested),
    [visibleItems, requested],
  )

  // 类型上不可能为空：本页只在 authenticated 状态下渲染。判空是为了收窄类型，
  // 同时给出一条明确的兜底路径而不是让下面的解引用在运行期炸掉。必须放在所有
  // hook 之后，否则 hooks 的调用顺序会随状态变化，React 会直接报错。
  if (user === null) return null

  // 角色名与权限说明都取自共享包，与服务端引用同一份常量。前端另写一份映射
  // 迟早会与服务端不一致，而这类不一致只表现为「界面上显示的名字不对」。
  const roleName = ROLES.find((role) => role.code === user.role)?.name ?? user.role

  return (
    <AppShell
      items={visibleItems}
      activeCode={activeItem?.code ?? null}
      activeTitle={activeItem?.label ?? null}
      user={user}
      roleName={roleName}
      onSelect={setRequested}
      onLogout={() => {
        void logout()
      }}
    >
      <div className="flex flex-col gap-4 pt-2">
        <ActivePanel item={activeItem} />

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
            <p className="mt-3 text-sm text-muted-foreground">当前角色没有任何权限点。</p>
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
          三个占位模块的独立页面与路由在 T2-03、T2-04 实现，个人工作台三板块在阶段三实现。
          本页是阶段二的落地页，用于验证登录、会话续期、权限可见范围与主框架尺寸。
        </p>
      </div>
    </AppShell>
  )
}

/**
 * 内容区。
 *
 * 分三种情形：没有可访问的模块（兜底）、占位项（标注功能开发中）、已排期的项。
 * 第三种当前只有个人工作台一项，它的三个板块属阶段三，所以这里只给出一句指向，
 * 不预先造出界面。
 */
function ActivePanel({ item }: { item: NavItem | null }) {
  if (item === null) {
    return (
      <section className="rounded-xl border border-border bg-card p-6">
        <h1 className="text-base font-medium text-foreground">没有可访问的模块</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          当前账号没有任何模块的权限，请联系管理员分配角色。若刚刚被调整过权限，请退出后重新登录。
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-medium text-foreground">{item.label}</h1>
        {item.planned && (
          <span className="rounded-md bg-accent px-2 py-0.5 text-xs text-muted-foreground">
            功能开发中
          </span>
        )}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.summary}</p>
    </section>
  )
}
