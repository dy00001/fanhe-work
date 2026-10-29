import { Download, Monitor } from 'lucide-react'
import type { ReactNode } from 'react'

import { currentHost } from '../lib/host'
import { DESKTOP_DOWNLOAD_LABEL, DESKTOP_RELEASES_URL } from '../lib/desktop-download'
import { cn } from '../lib/utils'

/**
 * 「下载桌面端」入口。
 *
 * **只在浏览器里渲染**：桌面端自己不需要下载自己，那一行会变成一个点了没用的链接，
 * 占着位置还让人怀疑是不是没装好。判断走 `currentHost()` 而不是猜 UA ——
 * 那条判据是外壳通过 `contextBridge` 显式声明的 `isDesktopShell`，`lib/host.ts`
 * 里已经写明了为什么不能用「`window.fanheDesktop` 存不存在」去推。
 *
 * 用 `<a target="_blank">` 而不是 `window.open`：浏览器会把外链当普通导航处理，
 * 中键、右键「在新标签页打开」这些习惯都还在。
 */
export function DesktopDownloadLink({
  className,
  children,
}: {
  className?: string
  children?: ReactNode
}) {
  if (currentHost() === 'desktop') return null

  return (
    <a
      href={DESKTOP_RELEASES_URL}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline',
        className,
      )}
    >
      <Download className="size-3.5" aria-hidden />
      {children ?? DESKTOP_DOWNLOAD_LABEL}
    </a>
  )
}

/**
 * 设置页里的那一块。
 *
 * 与上面的链接分开，是因为「在桌面端要整块消失」与「链接文字可以换」是两件事：
 * 把判断留在链接里，调用方就得再加一层壳才能连标题一起藏起来。
 */
export function DesktopDownloadCard() {
  if (currentHost() === 'desktop') return null

  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <Monitor className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base leading-6 font-medium">桌面端</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            装成应用后可以常驻托盘、自己检查更新，不用每次开浏览器。安装包放在 GitHub
            的发布页，始终指向最新一版。
          </p>
          <DesktopDownloadLink className="mt-3" />
        </div>
      </div>
    </section>
  )
}
