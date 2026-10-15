import { PERMISSIONS, type LaunchProfile } from '@fanhe/shared'
import { RefreshCw, Rocket, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import { launchRunRecovery, LaunchRunError, runLaunchProfile } from '../../lib/launch'
import { buildSuggestedPaths } from '../../lib/launch-suggest'
import { useLaunchProfiles } from '../../lib/use-launch-profiles'
import { cn } from '../../lib/utils'
import { EmptyState, ErrorState, LoadingState } from '../StateView'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { TooltipProvider } from '../ui/tooltip'
import { LaunchProfileDialog, type LaunchFormValues } from './LaunchProfileDialog'
import { LaunchProfileRow } from './LaunchProfileRow'

/**
 * 一键登录通道板块。
 *
 * 界面的四个状态各自对应一个组件：加载中、加载失败、空、列表。它们互斥且穷尽，
 * 不用额外的布尔量拼出来 —— 用 `loading && error && empty` 这样的组合表达，
 * 迟早会出现两个同时为真的分支，而那时的表现是「界面上同时显示着错误与列表」。
 *
 * **只读访客（`personal.*.read`）看得到列表，看不到任何改动入口。** 这一层只是
 * 体验职责：能不能改由服务端判定，前端藏起按钮挡不住直接发请求。把新增/编辑/删除
 * 的入口一并收起而不是置灰，是因为一个常年不可点的按钮只会让人反复尝试。
 *
 * **路径状态与启动摘要是另一次请求，且它的失败不算加载失败。** 它要查文件系统
 * （最坏等满超时），而列表本身只是想显示用户存了什么 —— 并在一起会让一条不可达的
 * 网络共享把整个板块拖成错误页，而用户想看的那几条配置其实好好地在那儿。因此状态
 * 有自己的加载计数，拿不到时只是不显示标记与摘要，列表照常可用。列表加载、状态重查、
 * 增删改的本地缓存更新都抽进了 `useLaunchProfiles`（首页区块与它共用同一份数据源，
 * 见 `use-launch-profiles.ts`），本板块只管自己的 UI 状态（对话框开关、提示条、行内
 * busy）。
 *
 * 操作结果用板块顶部的一条提示呈现（成功与失败共用一处）。没有引入 toast 组件：
 * 这个板块的动作都很短（启动一个进程、保存一条配置），结果紧跟操作出现即可，
 * 而 toast 要处理堆叠、超时与点击穿透，代价远大于收益。
 */

type Notice = { kind: 'ok' | 'error'; text: string }

/**
 * 判断编辑提交的内容是否真的与原来不同。
 *
 * 没有任何变化时不发请求：服务端的修改接口要求至少一个字段（`minProperties: 1`），
 * 而它写入后会把 `updatedAt` 一起刷新 —— 那会让「这一行什么时候被改过」这条信息
 * 失真。直接关闭对话框比默默接受一次空写入更诚实。
 */
function hasChanges(profile: LaunchProfile, values: LaunchFormValues): boolean {
  return (
    profile.software !== values.software ||
    profile.name !== values.name ||
    profile.executablePath !== values.executablePath ||
    profile.icon !== values.icon ||
    profile.args.length !== values.args.length ||
    profile.args.some((arg, index) => arg !== values.args[index])
  )
}

export function LaunchPanel() {
  const { can } = useAuth()
  const canWrite = can(PERMISSIONS.PERSONAL_LAUNCH_WRITE)

  // 列表 / 状态 / 增删改都走共享 hook，与首页区块共用一份数据源（见 use-launch-profiles）。
  const {
    profiles,
    statuses,
    loading,
    loadError,
    reload,
    recheckStatuses,
    createProfile,
    updateProfile,
    removeProfile,
    reorder,
  } = useLaunchProfiles()

  // §2.5 复用：每个软件「最近有效路径」反查表，新增配置选软件时预填路径框。
  const suggestedPaths = useMemo(() => buildSuggestedPaths(profiles, statuses), [profiles, statuses])

  /** 重排或删除在飞。此时整块列表不可操作，避免两处修改互相覆盖顺序。 */
  const [busy, setBusy] = useState(false)
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LaunchProfile | null>(null)
  const [deleting, setDeleting] = useState<LaunchProfile | null>(null)

  /**
   * 打开对话框时是否把光标落到路径字段。
   *
   * 与 `editing` 分开存而不是从调用点推出来：同一个编辑对话框有两个入口（更多菜单
   * 里的「编辑」与行内的「重新指定路径」），它们的区别只有这一件事。
   */
  const [focusPath, setFocusPath] = useState(false)

  function describeError(error: unknown, fallback: string): string {
    return error instanceof ApiError || error instanceof LaunchRunError ? error.message : fallback
  }

  /**
   * 重新检查路径。
   *
   * 存在的理由是**状态是快照**：U 盘重新插上、网络共享恢复、软件装回来之后，同一条
   * 配置就会变回可用，而界面上还挂着「路径失效」。这是唯一一处让用户主动刷新它、
   * 而不必改动配置的地方。
   */
  function handleRecheck(): void {
    recheckStatuses()
  }

  async function handleLaunch(profile: LaunchProfile): Promise<void> {
    setLaunchingId(profile.id)
    setNotice(null)
    try {
      const result = await runLaunchProfile(profile)
      // pid 一并报出来：它不面向日常使用，但出现「启动了却看不到窗口」时，
      // 这是判断进程到底有没有被创建的第一手信息。
      setNotice({ kind: 'ok', text: `已启动「${profile.name}」（进程 ${result.pid}）` })
    } catch (error) {
      // 按服务端给的错误码分流：路径失效与「没预料到的失败」需要用户做的事完全不同，
      // 而它们都会走到这个 catch 里。分流规则见 `lib/launch.ts`。
      const relocate =
        (error instanceof ApiError || error instanceof LaunchRunError) &&
        launchRunRecovery(error) === 'relocate'
      const message = describeError(error, '启动失败，请稍后重试')
      setNotice({
        kind: 'error',
        text: relocate ? `${message}。请编辑这一条并重新指定路径。` : message,
      })
    } finally {
      setLaunchingId(null)
      // 启动成功与失败都会落一条记录（失败也是一种记录），因此这一次都要重拉状态。
      // 请求根本没到服务端时这次重拉是白做的，但那比「刚点过启动、摘要却没变」要好。
      recheckStatuses()
    }
  }

  async function handleSubmit(values: LaunchFormValues): Promise<void> {
    if (editing === null) {
      const created = await createProfile(values)
      setNotice({ kind: 'ok', text: `已新增「${created.name}」` })
      return
    }

    if (!hasChanges(editing, values)) return

    const updated = await updateProfile(editing.id, values)
    setNotice({ kind: 'ok', text: `已保存「${updated.name}」` })
  }

  /**
   * 上移或下移一格。
   *
   * **不做乐观更新。** 重排接口会把落库后的完整顺序返回（见 `api.ts`），等它回来
   * 再重绘，界面显示的永远是服务端那一份。先改本地再提交的话，请求失败时得回滚，
   * 而回滚期间用户可能又点了一次 —— 那两次操作各自基于不同的顺序，很难收敛。
   * 本机回环请求的延迟在毫秒级，等结果是可接受的代价。
   */
  async function handleMove(profile: LaunchProfile, offset: -1 | 1): Promise<void> {
    if (profiles === null) return

    const index = profiles.findIndex((item) => item.id === profile.id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= profiles.length) return

    // 提交整个 id 顺序，而不是「把某个 id 挪到某处」：落库后的顺序由服务端回给 hook
    // （它内部 setProfiles），这里只负责把这一格与相邻格对调。
    const reorderedIds = [...profiles.map((item) => item.id)]
    const moving = reorderedIds[index]
    const displaced = reorderedIds[target]
    if (moving === undefined || displaced === undefined) return
    reorderedIds[index] = displaced
    reorderedIds[target] = moving

    setBusy(true)
    setNotice(null)
    try {
      await reorder(reorderedIds)
    } catch (error) {
      // 失败时不动本地列表：界面仍显示服务端的顺序，用户看到的是「点了没反应 + 一句说明」，
      // 比显示一个没落库的顺序要好。
      setNotice({ kind: 'error', text: describeError(error, '排序失败，请稍后重试') })
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (deleting === null) return
    const target = deleting

    setBusy(true)
    setNotice(null)
    try {
      await removeProfile(target.id)
      setNotice({ kind: 'ok', text: `已删除「${target.name}」` })
      setDeleting(null)
      // 状态列表按 id 组织，删掉的那一条不会自己消失；hook 内部已重拉状态让它与列表对齐。
      // 它的历史记录仍在库里（软删除不带走历史），只是不再出现在这个接口的返回里。
    } catch (error) {
      setNotice({ kind: 'error', text: describeError(error, '删除失败，请稍后重试') })
    } finally {
      setBusy(false)
    }
  }

  function openCreate(): void {
    setEditing(null)
    setFocusPath(false)
    setDialogOpen(true)
  }

  function openEdit(profile: LaunchProfile): void {
    setEditing(profile)
    setFocusPath(false)
    setDialogOpen(true)
  }

  /** 「重新指定路径」：同一个编辑对话框，只是把光标落在路径字段上。 */
  function openRelocate(profile: LaunchProfile): void {
    setEditing(profile)
    setFocusPath(true)
    setDialogOpen(true)
  }

  function renderBody(): React.ReactNode {
    if (loading) return <LoadingState variant="plain" label="正在加载启动配置" />

    if (loadError !== null) {
      return (
        <ErrorState
          variant="plain"
          description={loadError}
          onRetry={reload}
        />
      )
    }

    if (profiles === null || profiles.length === 0) {
      return (
        <EmptyState
          variant="plain"
          icon={Rocket}
          title="还没有启动配置"
          description={
            canWrite
              ? '把常用客户端的可执行文件路径与启动参数存成一条配置，之后就能在这里一键唤起。'
              : '当前角色只能查看。需要新增或修改时，请联系管理员调整权限。'
          }
          action={
            canWrite ? (
              <Button type="button" size="sm" onClick={openCreate}>
                新增配置
              </Button>
            ) : undefined
          }
        />
      )
    }

    return (
      <ul className="flex flex-col gap-2">
        {profiles.map((profile, index) => (
          <LaunchProfileRow
            key={profile.id}
            profile={profile}
            status={statuses[profile.id]}
            canWrite={canWrite}
            launching={launchingId === profile.id}
            busy={busy}
            canMoveUp={index > 0}
            canMoveDown={index < profiles.length - 1}
            onLaunch={() => void handleLaunch(profile)}
            onEdit={() => openEdit(profile)}
            onRelocate={() => openRelocate(profile)}
            onMove={(offset) => void handleMove(profile, offset)}
            onDelete={() => setDeleting(profile)}
          />
        ))}
      </ul>
    )
  }

  return (
    // 行内的上移/下移按钮挂了气泡说明，需要一层 Provider。与侧栏一样挂在容器上，
    // 不给每个按钮各挂一个 —— 那样每个气泡都会自己维护一套延迟与关闭逻辑。
    <TooltipProvider delayDuration={200}>
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-medium text-foreground">
              一键登录通道
              {profiles !== null && profiles.length > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground-weak">
                  {profiles.length} 项
                </span>
              )}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              配置本机客户端的启动路径与参数，在这里一键唤起。配置只保存在本机。
            </p>
          </div>
          {profiles !== null && profiles.length > 0 && (
            <div className="flex shrink-0 items-center gap-1">
              {/* 「重新检查路径」对只读访客也开放：这是一次读操作，而「路径失效」这条
                  信息对他同样有用。它放在表头而不是行内，因为它是针对整个列表的动作 ——
                  一条路径失效往往意味着一批（换机、卸载软件、共享掉线都是成批发生的）。 */}
              <Button type="button" variant="ghost" size="sm" onClick={handleRecheck}>
                <RefreshCw />
                重新检查路径
              </Button>
              {canWrite && (
                <Button type="button" size="sm" onClick={openCreate}>
                  新增
                </Button>
              )}
            </div>
          )}
        </div>

        {notice !== null && (
          <div
            role={notice.kind === 'ok' ? 'status' : 'alert'}
            className={cn(
              'mt-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm',
              notice.kind === 'ok'
                ? 'border-border bg-accent text-foreground'
                : 'border-destructive/30 bg-destructive/10 text-destructive',
            )}
          >
            <span className="min-w-0 break-words">{notice.text}</span>
            <button
              type="button"
              aria-label="关闭提示"
              className="-mr-1 shrink-0 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
              onClick={() => setNotice(null)}
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        <div className="mt-4">{renderBody()}</div>
      </section>

      <LaunchProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profile={editing}
        focusPath={focusPath}
        suggestedPaths={suggestedPaths}
        onSubmit={handleSubmit}
      />

      {/* 删除确认。用 `deleting !== null` 同时表达「对话框开着」与「删的是哪一条」，
          不再单开一个布尔量 —— 两个状态分开存就会出现「开着但没有目标」的中间态。 */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除启动配置</DialogTitle>
            <DialogDescription>
              确定要删除「{deleting?.name}」吗？删除后它会从这个列表中移除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {busy ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
