import type { ReactNode } from 'react'

/**
 * 登录与初始化两个页面共用的外壳。
 *
 * 抽出来的理由是两者除了中间的表单不同，其余部分（居中容器、品牌标识、标题、
 * 卡片边框）完全一致。各写一份的话，调整一次留白要改两处，而漏改的那一处
 * 只在切到那个页面时才看得出来。
 */
export function AuthLayout({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3">
          <img src="/brand/logo.png" alt="" className="h-10 w-auto" />
          <div>
            <h1 className="text-lg font-medium tracking-tight text-ink">梵禾 Work</h1>
            <p className="text-xs text-ink-soft">{subtitle}</p>
          </div>
        </div>

        <div className="mt-8 rounded-xl border border-line bg-card p-6">{children}</div>
      </div>
    </div>
  )
}
