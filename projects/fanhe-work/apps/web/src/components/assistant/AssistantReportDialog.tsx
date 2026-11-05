import type { AssistantDataModule, AssistantReportResponse } from '@fanhe/shared'
import { ASSISTANT_DATA_MODULES } from '@fanhe/shared'
import { Copy, Download, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useState } from 'react'

import { assistantReportRequest } from '../../lib/api'
import { reportFailureText, reportFileName, REPORT_DAY_OPTIONS } from '../../lib/assistant-report'
import { withAccessToken } from '../../lib/session'
import { MarkdownPreview } from '../notes/MarkdownPreview'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

/**
 * 经营数据简报弹层。
 *
 * **为什么是弹层而不是新页面。** 生成一份要十几秒，而看的人多半正在和助手对话。
 * 跳到新页面会把 iframe 里的会话状态一起丢掉（切路由会卸载它），回来还得重新进一次。
 * 弹层盖在上面，底下那层完全不动。
 *
 * **为什么结果区同时接两种正文。** 服务端在模型不可用时返回 200 + `fallbackMarkdown`，
 * 一份完整的数据版。这里按 `source` 二选一渲染，并在顶部说明原因：让用户看到的是
 * 「AI 没写成，但数据都在」，而不是一个红叉加一句「生成失败」。
 *
 * 模块勾选与天数都只是**请求参数**，服务端会再校验一次角色与各模块权限。前端把
 * 未授权模块灰掉只是为了少一次 403，不构成控制。
 */

const MODULE_LABEL: Record<AssistantDataModule, string> = {
  ops: '运营信息平台',
  customer: '客户信息平台',
  quote: '报价体系',
}

type Status = 'idle' | 'loading' | 'ready' | 'error'

export function AssistantReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [days, setDays] = useState(7)
  const [modules, setModules] = useState<readonly AssistantDataModule[]>([
    ...ASSISTANT_DATA_MODULES,
  ])
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<AssistantReportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const toggleModule = useCallback((module: AssistantDataModule) => {
    setModules((current) =>
      current.includes(module)
        ? // 至少保留一个：全不选时服务端会回「没数据」，而用户的本意通常是「换一个看看」。
          current.length === 1
          ? current
          : current.filter((item) => item !== module)
        : [...current, module],
    )
  }, [])

  const generate = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      const response = await withAccessToken((accessToken) =>
        assistantReportRequest(accessToken, { days, modules: [...modules] }),
      )
      setResult(response)
      setStatus('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '生成失败，请稍后重试')
      setStatus('error')
    }
  }, [days, modules])

  const body =
    result === null ? '' : result.source === 'model' ? result.markdown : result.fallbackMarkdown

  const copy = useCallback(async () => {
    if (body === '') return
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      window.setTimeout(() => {
        setCopied(false)
      }, 2000)
    } catch {
      // 剪贴板被拒（非 https、或用户未授权）时不做任何事：正文还在，可以手动选。
      setCopied(false)
    }
  }, [body])

  const download = useCallback(() => {
    if (result === null || body === '') return
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = reportFileName(result.brief.range)
    anchor.click()
    URL.revokeObjectURL(url)
  }, [body, result])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" aria-hidden />
            经营数据简报
          </DialogTitle>
          <DialogDescription>
            汇总运营、客户、报价三个模块，按当前账号的可见范围统计，生成一份可下载的简报。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1">
            {REPORT_DAY_OPTIONS.map((option) => (
              <Button
                key={option.days}
                size="sm"
                variant={days === option.days ? 'default' : 'outline'}
                onClick={() => {
                  setDays(option.days)
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            {ASSISTANT_DATA_MODULES.map((module) => (
              <label key={module} className="flex cursor-pointer items-center gap-1.5 text-sm">
                <Checkbox
                  checked={modules.includes(module)}
                  onCheckedChange={() => {
                    toggleModule(module)
                  }}
                />
                {MODULE_LABEL[module]}
              </label>
            ))}
          </div>

          <Button
            className="ml-auto"
            size="sm"
            disabled={status === 'loading'}
            onClick={() => {
              void generate()
            }}
          >
            {status === 'loading' ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-3.5" aria-hidden />
            )}
            {status === 'loading' ? '生成中…' : result === null ? '生成简报' : '重新生成'}
          </Button>
        </div>

        {status === 'loading' ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            正在取数并生成，通常十几秒。模型较慢时会自动回落到纯数据版。
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-4 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {status === 'idle' ? (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-6 text-sm text-muted-foreground">
            选好区间与模块后点「生成简报」。若某个模块当前账号没有权限，它会自动从简报里
            剔除并在正文里写明。
          </p>
        ) : null}

        {result !== null && status === 'ready' ? (
          <>
            {result.source === 'fallback' ? (
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {reportFailureText(result.reason)}
              </p>
            ) : null}

            <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-border bg-card px-4 py-3">
              <MarkdownPreview content={body} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {result.brief.range.from} 至 {result.brief.range.to}
                {result.model === null ? '' : ` · ${result.model}`}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void copy()}>
                  <Copy className="size-3.5" aria-hidden />
                  {copied ? '已复制' : '复制'}
                </Button>
                <Button size="sm" variant="outline" onClick={download}>
                  <Download className="size-3.5" aria-hidden />
                  下载 .md
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void generate()
                  }}
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  重新生成
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
