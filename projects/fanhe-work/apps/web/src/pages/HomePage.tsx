import { PERMISSION_CATALOG, ROLES } from '@fanhe/shared'

import { useAuth } from '../auth/useAuth'

/**
 * 已登录后的落地页。
 *
 * 当前只展示身份与权限，作为阶段一「四种角色登录后可见范围符合预期」这一条
 * 验收的可观察落点。真正的主框架、左侧导航与三个占位模块属阶段二（T2-01 起），
 * 届时本页会被布局骨架取代。
 *
 * 权限点在这里只是**展示**。前端按权限隐藏菜单与按钮承担的是体验职责，任何人
 * 改一个请求就能绕过；强制校验始终在服务端。
 */
export function HomePage() {
  const { user, permissions, logout } = useAuth()

  // 类型上不可能为空：本页只在 authenticated 状态下渲染。判空是为了收窄类型，
  // 同时给出一条明确的兜底路径而不是让下面的解引用在运行期炸掉。
  if (user === null) return null

  // 角色名与权限说明都取自共享包，与服务端引用同一份常量。前端另写一份映射
  // 迟早会与服务端不一致，而这类不一致只表现为「界面上显示的名字不对」。
  const roleName = ROLES.find((role) => role.code === user.role)?.name ?? user.role

  return (
    <div className="min-h-screen bg-surface">
      <header className="flex items-center justify-between border-b border-line bg-card px-6 py-3">
        <div className="flex items-center gap-3">
          <img src="/brand/logo.png" alt="" className="h-7 w-auto" />
          <span className="text-sm font-medium text-ink">梵禾 Work</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-ink-soft">
            {user.displayName}
            <span className="ml-2 text-xs text-ink-faint">{roleName}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-surface"
          >
            退出登录
          </button>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-10">
        <section className="rounded-xl border border-line bg-card p-6">
          <h2 className="text-base font-medium text-ink">当前账号</h2>
          <dl className="mt-4 divide-y divide-line-soft">
            <div className="flex items-center justify-between py-2.5 text-sm">
              <dt className="text-ink-soft">账号</dt>
              <dd className="text-ink">{user.username}</dd>
            </div>
            <div className="flex items-center justify-between py-2.5 text-sm">
              <dt className="text-ink-soft">显示名</dt>
              <dd className="text-ink">{user.displayName}</dd>
            </div>
            <div className="flex items-center justify-between py-2.5 text-sm">
              <dt className="text-ink-soft">角色</dt>
              <dd className="text-ink">
                {roleName}
                <span className="ml-2 text-xs text-ink-faint">{user.role}</span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border border-line bg-card p-6">
          <h2 className="text-base font-medium text-ink">
            权限点
            <span className="ml-2 text-xs font-normal text-ink-faint">{permissions.length} 项</span>
          </h2>
          {permissions.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">当前角色没有任何权限点。</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {permissions.map((code) => {
                const description =
                  PERMISSION_CATALOG.find((entry) => entry.code === code)?.description ?? ''
                return (
                  <li key={code} className="flex items-baseline justify-between gap-4 text-sm">
                    <span className="text-ink-soft">{description}</span>
                    <code className="shrink-0 font-mono text-xs text-ink-faint">{code}</code>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <p className="text-xs leading-relaxed text-ink-faint">
          主框架、左侧导航与个人工作台三板块在阶段二与阶段三实现。本页是阶段一的落地页，
          用于验证登录、会话续期与权限可见范围。
        </p>
      </main>
    </div>
  )
}
