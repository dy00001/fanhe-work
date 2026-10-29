import type { ReactNode } from 'react'

/**
 * 登录与初始化两个页面共用的外壳。
 *
 * 抽出来的理由是两者除了中间的表单不同，其余部分（居中容器、品牌标识、标题、
 * 卡片边框）完全一致。各写一份的话，调整一次留白要改两处，而漏改的那一处
 * 只在切到那个页面时才看得出来。
 */
export function AuthLayout({
  subtitle,
  footer,
  children,
}: {
  subtitle: string
  /**
   * 卡片下方的补充区。
   *
   * 存在的原因是「下载桌面端」这类入口属于登录页、但不属于卡片里的表单：放进表单会
   * 让「记住账号密码」与它挤成一片，而它其实与「这次登录」无关。初始化页不传就什么
   * 都不渲染，两页的共用部分仍然是一份。
   */
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3">
          <img src="/brand/logo.png" alt="" className="h-10 w-auto" />
          <div>
            {/* 字距保持 normal —— 设计稿的字距规则是「一律 normal，不做特殊处理」，
                这里此前带的 `tracking-tight` 是体系外的散值。 */}
            <h1 className="text-lg font-medium text-foreground">梵禾 Work</h1>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        <div className="mt-8 rounded-xl border border-border bg-card p-6">{children}</div>

        {footer !== undefined && <div className="mt-4 text-center">{footer}</div>}
      </div>
    </div>
  )
}
