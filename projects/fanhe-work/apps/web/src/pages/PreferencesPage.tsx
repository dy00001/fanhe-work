import { HardDrive, Loader2 } from 'lucide-react'

import { CASE_ASSET_VERSION, caseAssetFiles } from '../lib/case-catalog'
import { useCaseAssets } from '../lib/use-case-assets'
import { cn } from '../lib/utils'

/**
 * 本机设置。
 *
 * 目前只有一项：**案例图片的本地缓存目录**。把它放在「系统设置」模块下而不是塞进图集
 * 弹窗，是因为它属于「这台机器怎么配」，与「我正在看哪个品类的图」是两件事；而换目录、
 * 清缓存这两个动作的后果（要重新同步、旧目录的文件会留下）也需要一整块地方说清楚。
 *
 * 页面上所有文案都在解释同一件事：**缓存坏了也不会看不到图**。用户对「缓存」这类词的
 * 默认预期是「它坏了页面就完了」，因此每一档降级都要写明它落到哪。
 */
export function PreferencesPage() {
  const assets = useCaseAssets(null, true)
  const { state } = assets
  const categoryCount = new Set(caseAssetFiles().map((file) => file.categoryId)).size

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-xl leading-7 font-medium">本机设置</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        这些设置只影响这台设备，不会同步到账号下。
      </p>

      <section className="mt-6 rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <HardDrive className="mt-0.5 size-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base leading-6 font-medium">案例图片本地缓存</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              缩略图会存到下面这个文件夹，打开图集时直接从本地读；点开放大时再按需加载原图。
            </p>
          </div>
        </div>

        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-[5rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">状态</dt>
          <dd className={cn(assets.preparing && 'text-muted-foreground')}>
            {STATUS_LABEL[state.status]}
          </dd>

          <dt className="text-muted-foreground">文件夹</dt>
          <dd className="truncate">
            {state.directoryName ?? '未选择（缩略图直接走网络）'}
            {/* 浏览器只给文件夹名，不给绝对路径 —— 这是 File System Access 的固有限制，
                不是省事。界面上与其编一个假路径，不如说清楚。*/}
            {state.directoryName !== null && (
              <span className="ml-2 text-xs text-muted-foreground">
                浏览器不提供完整路径，只有文件夹名
              </span>
            )}
          </dd>

          <dt className="text-muted-foreground">已缓存</dt>
          <dd className="tabular-nums">
            {state.fileCount} 张 · {formatBytes(state.bytes)}
            {state.lastSyncedAt !== null && (
              <span className="ml-2 text-xs text-muted-foreground">
                上次同步 {formatClock(state.lastSyncedAt)}
              </span>
            )}
          </dd>

          <dt className="text-muted-foreground">图片集版本</dt>
          <dd className="font-mono text-xs text-muted-foreground">
            {CASE_ASSET_VERSION}
            <span className="ml-2 font-sans">清单变了会自动重同步，共 {categoryCount} 个品类</span>
          </dd>
        </dl>

        {assets.progress !== null && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在同步缩略图 {assets.progress.done} / {assets.progress.total}
          </p>
        )}

        {assets.message !== null && (
          <p
            role="alert"
            className="mt-3 rounded-md bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {assets.message}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void assets.chooseDirectory()
            }}
            disabled={state.status === 'unsupported'}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {state.directoryName === null ? '选择文件夹' : '更换文件夹'}
          </button>

          {state.status === 'permission' && (
            <button
              type="button"
              onClick={() => {
                void assets.grant()
              }}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-foreground/40"
            >
              重新授权
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              void syncAll(assets.syncCategory)
            }}
            disabled={state.status !== 'ready' || assets.progress !== null}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-foreground/40 disabled:opacity-40"
          >
            立即同步
          </button>

          <button
            type="button"
            onClick={() => {
              void assets.clear()
            }}
            disabled={state.status !== 'ready' || state.fileCount === 0}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
          >
            清除缓存
          </button>
        </div>

        <div className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
          <p>
            换文件夹等于重新同步：新文件夹里会重写一遍缩略图，旧文件夹里的文件保持原样，可自行删除。
          </p>
          <p>选的文件夹不可写、授权过期或断网时，图集会回落到直接加载网络图片，功能不受影响。</p>
          <p>
            「清除缓存」只删这个文件夹里由梵禾 Work
            写入的缩略图（依据缓存目录里的记录），不碰其它文件。
          </p>
        </div>
      </section>
    </div>
  )
}

/**
 * 状态文案。
 *
 * 每一档都要能回答「那我还能不能看图」。`permission` 与 `unavailable` 最容易混：前者是
 * 「浏览器把权限收回去了」（点一下重新授权就回来），后者是「文件夹本身没了」（得重新选）。
 * 说反了用户会去做一件没用的事。
 */
const STATUS_LABEL: Record<string, string> = {
  unset: '未启用（图片走网络，可随时开启）',
  ready: '已启用',
  permission: '待授权（图片暂时走网络）',
  unsupported: '当前浏览器不支持（Safari / Firefox 无此能力）',
  unavailable: '文件夹不可用（图片暂时走网络）',
}

/**
 * 逐品类同步。
 *
 * 不并发：目录句柄的写入在 Chromium 里是串行的，并发发起不会更快，反而会让进度条
 * 在两个品类之间来回跳。几十张小图，串行的总耗时可接受。
 */
async function syncAll(syncCategory: (categoryId: string) => Promise<void>): Promise<void> {
  const ids = new Set(caseAssetFiles().map((file) => file.categoryId))
  for (const id of ids) {
    await syncCategory(id)
  }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
