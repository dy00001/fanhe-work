import { type NavItem } from '@fanhe/shared'
import { ExternalLink, FileText, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useAuth } from '../auth/useAuth'
import { AssistantReportDialog } from '../components/assistant/AssistantReportDialog'
import { Button } from '../components/ui/button'
import { assistantTokenRequest } from '../lib/api'
import { canUseAssistantReport } from '../lib/assistant-report'
import { buildAssistantUrl } from '../lib/assistant-url'
import { NAV_ICONS } from '../lib/nav-icons'
import { readThemePreference } from '../lib/preferences'
import { withAccessToken } from '../lib/session'
import { resolveTheme } from '../lib/theme'

/**
 * AI 助手页：把自托管的 EvoFlow 整块嵌进内容区。
 *
 * **为什么用 iframe 而不是接它的 640 个 HTTP 接口重画一遍界面。**
 * EvoFlow 的界面（chat / 技能 / 知识库 / 任务编排）是它自己的前端产物，重画等于
 * 把上游每一版改版都跟一遍；而它的网关本身支持 headless 部署（`scripts/serve.js`），
 * 页面自带 `/api` 同源反代，直接嵌进来就拿到完整功能，零复刻成本。
 *
 * **地址为什么不能写 `127.0.0.1:1420`。** 梵禾对外是 `work.fanhe.dpdns.org` 走隧道，
 * 同事在家里打开时，他自己浏览器里的 `127.0.0.1` 指的是他自己那台电脑。因此这里
 * 必须用同一个隧道下的独立域名 `ai.fanhe.dpdns.org`，两端都在 Cloudflare 内，
 * 家里与办公室都能到。本地开发要指向本机时，用 `VITE_ASSISTANT_URL` 覆盖。
 *
 * **为什么不做加载态遮罩。** iframe 的 `onLoad` 在跨域文档里只保证「文档加载完成」，
 * 拿不到内部渲染状态；盖一层骨架屏反而会挡住已经画出来的界面。因此只放一行
 * 载入提示，`onLoad` 一到就撤，不做进度伪装。
 *
 * 高度用 `calc(100vh - 112px)`：顶栏 72px、内容区上内边距 20px、页头与间距 20px。
 * 内容区本身是滚动容器（`.hide-scrollbar`），因此这里必须给确定高度，让 iframe
 * 内部的滚动条自己滚，而不是把整个内容区撑高 —— 撑高会让侧栏的滚动指示器跟着跳。
 */
const ASSISTANT_URL = import.meta.env.VITE_ASSISTANT_URL ?? 'https://ai.fanhe.dpdns.org'

export function AssistantPage({ item }: { item: NavItem }) {
  const Icon = NAV_ICONS[item.code]
  const [loaded, setLoaded] = useState(false)
  /** 换 key 即重挂 iframe，等价于刷新；比 `contentWindow.location.reload()` 可靠 ——
   *  后者跨域会被同源策略拦下，控制台报一行错，界面却什么都没发生。 */
  const [reloadKey, setReloadKey] = useState(0)
  const [theme] = useState(() => resolveTheme(readThemePreference()))
  /** 拼好的地址。`null` 表示还在取身份令牌，此时先不挂 iframe。 */
  const [assistantUrl, setAssistantUrl] = useState<string | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  /**
   * 数据简报只对 owner / admin 显示。
   *
   * **这里只是「不渲染一个必然失败的按钮」**，不是权限。真正的准入在
   * `GET /api/assistant/brief` 与 `POST /api/assistant/report` 里按角色判定，
   * 兜里揣着令牌直接打接口仍然会拿到 403。
   */
  const { user } = useAuth()
  const canReport = canUseAssistantReport(user?.role)

  /**
   * 每次进页面（以及每次点刷新）都重新取一个身份令牌。
   *
   * **不能取一次存起来复用。** 令牌过期或签名对不上时，助手网关不会拒绝请求，而是
   * 把这次调用当成「本机管理员」—— 表现是忽然能看到别人的对话，界面上没有任何报错。
   * 每次重取，正常使用下就永远碰不到那条分支。代价是多一次不到 50 毫秒的请求。
   *
   * 取不到不是错误：未配置身份桥（503）或网络抖动都走同一条路 —— 不带令牌装载，
   * 助手退化成「全站共享一份历史」。这比让整个页面停在空白上合理。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let token: string | null = null
      try {
        const response = await withAccessToken((accessToken) => assistantTokenRequest(accessToken))
        token = response.token
      } catch {
        // 取不到就保持 null，装载时不带令牌 —— 助手退化成共享身份，页面照常可用。
      }
      // 卸载后不再写状态：快速切走切回时，先发起的那次请求可能后返回，把新地址盖掉。
      if (cancelled) return
      setAssistantUrl(buildAssistantUrl({ baseUrl: ASSISTANT_URL, theme, token }))
    })()
    return () => {
      cancelled = true
    }
  }, [theme, reloadKey])

  return (
    <div className="flex h-[calc(100vh-112px)] flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <h1 className="text-base font-medium text-foreground">{item.label}</h1>
          <span className="text-xs text-muted-foreground">{item.summary}</span>
        </div>
        <div className="flex items-center gap-2">
          {canReport ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setReportOpen(true)
              }}
            >
              <FileText className="size-3.5" aria-hidden />
              数据简报
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoaded(false)
              setReloadKey((key) => key + 1)
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            刷新
          </Button>
          {assistantUrl === null ? null : (
            <Button asChild variant="outline" size="sm">
              {/* 编辑器里想两个窗口并排看时，新标签比在 iframe 里来回切模块顺手。
                  外链不带 opener，避免被嵌入页反向操作梵禾这一侧。 */}
              <a href={assistantUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-3.5" aria-hidden />
                新窗口打开
              </a>
            </Button>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {assistantUrl === null || !loaded ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground">
            正在载入 AI 助手…
          </div>
        ) : null}
        {assistantUrl === null ? null : (
          <iframe
            key={reloadKey}
            src={assistantUrl}
            title="AI 助手"
            className="size-full rounded-xl border border-border bg-card"
            /* 剪贴板是刚需：助手经常要把生成的文案、报价口径复制回梵禾。麦克风留给
               语音输入，不给摄像头 —— 用不到的能力不开口子。 */
            allow="clipboard-read; clipboard-write; microphone"
            onLoad={() => {
              setLoaded(true)
            }}
          />
        )}
      </div>

      {/* 弹层挂在页面最外层而不是 iframe 内部：iframe 是另一个域，里面装不了 React 节点。
          盖在这里，底下的助手会话不受影响 —— 切路由会卸载 iframe，弹层不会。 */}
      {canReport ? (
        <AssistantReportDialog
          open={reportOpen}
          onOpenChange={(next) => {
            setReportOpen(next)
          }}
        />
      ) : null}
    </div>
  )
}
