import {
  PERMISSIONS,
  navPath,
  NAV_CODES,
  type LaunchProfile,
  type LaunchProfileStatus,
} from '@fanhe/shared'
import {
  ArrowRight,
  Image as ImageIcon,
  LoaderCircle,
  Music,
  Plus,
  Rocket,
  Scissors,
  Sparkles,
  UserRound,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import { launchRunRecovery, LaunchRunError, runLaunchProfile } from '../../lib/launch'
import { resolveLaunchIconKey, LAUNCH_ICONS } from '../../lib/launch-icons'
import { buildSuggestedPaths } from '../../lib/launch-suggest'
import { useLaunchProfiles } from '../../lib/use-launch-profiles'
import { formatRelativeTime } from '../../lib/relative-time'

import { LaunchProfileDialog, type LaunchFormValues } from '../launch/LaunchProfileDialog'

/**
 * 六个 AI 模块单元卡（原型编号 10 的第二排与主卡右侧）。
 *
 * 全部是静态占位：它们对应的是尚未开发的模块，因此每张卡右上角带「开发中」。
 * `hue` 决定图标底与悬停辉光的色相，取共享包已有的模块分色令牌 —— 颜色不在前端
 * 另写一套，否则暗色下会出现两套明度标准。
 */
const AI_MODULES: readonly { title: string; desc: string; hue: string; Icon: LucideIcon }[] = [
  { title: '无限画布', desc: '自由排布方案稿与素材', hue: 'var(--m-teal)', Icon: Sparkles },
  { title: '创建图像', desc: '文生图 / 图生图', hue: 'var(--m-blue)', Icon: ImageIcon },
  { title: '视频创作', desc: '脚本到成片的生成', hue: 'var(--m-purple)', Icon: Video },
  { title: '音乐创作', desc: '为方案配背景音', hue: 'var(--m-amber)', Icon: Music },
  { title: '数字人视频', desc: '讲解视频自动成片', hue: 'var(--m-teal)', Icon: UserRound },
  { title: '视频剪辑', desc: '素材拼接与字幕', hue: 'var(--m-blue)', Icon: Scissors },
]

/**
 * 一键启动（原型编号 10，方案 C）。
 *
 * 4 列 × 2 行的 Bento：主卡跨两列（200 高），六张单元卡填满其余五格（第一排两格
 * 200 高、第二排四格 128 高）。列宽 378、gap 16，与案例展示落在同一条栅格上。
 *
 * **主卡接的是真实数据。** 原型那张卡上写的是授权信息，本项目没有这份数据，因此换成
 * 手上真有的两样：所选配置的可执行文件路径状态，与它的最近一次启动。
 * **不照抄那四段文案**：在拿不到数据的地方写死一段看起来很确定的字，比留白更糟。
 *
 * 主卡内是一条**小图标托盘**（方案 C，见 `docs/LAUNCH-OPTIMIZE-2026-10-15.md` §2.6）：
 * 每个已配置实例一枚小图标按钮（图标 + 名称小字 + 右上角路径状态点），`flex-wrap`
 * 排布，实例接近 9 条时自动换行，主卡随之增高。点图标进该实例的编辑（§2.7），悬停
 * 出的小火箭单独启动那一条；托盘末尾一枚虚线「+」卡进新增（仅 `canWrite` 可见）。
 *
 * 主卡大「一键启动」按钮启动当前选中（或首个）实例（§2.7）；勾选多条、批量启动的入口
 * 在工作台面板的 2.2 能力里，本区块只做「选一条 + 启动 + 管理」的缩略视图。管理入口
 * （新增 / 编辑 / 排序 / 删除）仍在完整面板上，地址 `/workbench/launch`；区块头右侧
 * 的「管理配置」是它的入口。
 */
export function LaunchSection() {
  const { can } = useAuth()
  const canRead = can(PERMISSIONS.PERSONAL_LAUNCH_READ)
  const canWrite = can(PERMISSIONS.PERSONAL_LAUNCH_WRITE)

  // 列表 / 状态 / 增删改都走共享 hook，与工作台面板共用一份数据源（见 use-launch-profiles）。
  const { profiles, statuses, loading, loadError, reload, recheckStatuses, createProfile, updateProfile } =
    useLaunchProfiles()

  // §2.5 复用：每个软件「最近有效路径」反查表，新增配置选软件时预填路径框。
  const suggestedPaths = useMemo(() => buildSuggestedPaths(profiles, statuses), [profiles, statuses])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LaunchProfile | null>(null)
  const [focusPath, setFocusPath] = useState(false)

  // 默认选中第一条。写在 profiles 变化之后而不是从列表推导：`selectedId` 是用户可改的
  // 状态，推导出来会变成「用户选过之后又被拉回第一条」。
  useEffect(() => {
    if (profiles === null) return
    setSelectedId((current) => current ?? profiles[0]?.id ?? null)
  }, [profiles])

  async function handleLaunch(profile: LaunchProfile): Promise<void> {
    // 点托盘里某条的火箭，也把它标成「当前选中」，让大按钮落到同一条上。
    setSelectedId(profile.id)
    setLaunching(true)
    setNotice(null)
    try {
      const result = await runLaunchProfile(profile)
      setNotice({ kind: 'ok', text: `已启动「${profile.name}」（进程 ${result.pid}）` })
    } catch (error) {
      // 桌面态经 IPC 失败会抛 `LaunchRunError`（reason 即 code），与 HTTP 失败的
      // `ApiError` 走同一道 `launchRunRecovery` 分流。只认 `code`，不认来源。
      const relocate =
        (error instanceof ApiError || error instanceof LaunchRunError) &&
        launchRunRecovery(error) === 'relocate'
      const message =
        error instanceof ApiError || error instanceof LaunchRunError
          ? error.message
          : '启动失败，请稍后重试'
      setNotice({
        kind: 'error',
        text: relocate ? `${message}。请到「管理配置」里重新指定路径。` : message,
      })
    } finally {
      setLaunching(false)
      // 成功与失败都会落一条记录，因此这次都要重拉状态。
      recheckStatuses()
    }
  }

  async function handleSubmit(values: LaunchFormValues): Promise<void> {
    if (editing === null) {
      const created = await createProfile(values)
      setNotice({ kind: 'ok', text: `已新增「${created.name}」` })
    } else {
      const updated = await updateProfile(editing.id, values)
      setNotice({ kind: 'ok', text: `已保存「${updated.name}」` })
    }
  }

  function openCreate(): void {
    setEditing(null)
    setFocusPath(false)
    setDialogOpen(true)
  }

  /** 点托盘图标进该实例的编辑（§2.7）。 */
  function openEdit(profile: LaunchProfile): void {
    setEditing(profile)
    setFocusPath(false)
    setDialogOpen(true)
  }

  if (!canRead) return null

  const selected = profiles?.find((item) => item.id === selectedId) ?? null
  const selectedStatus: LaunchProfileStatus | undefined =
    selected === null ? undefined : statuses[selected.id]
  const pathOk = selectedStatus?.pathState === 'ok'
  const lastRunAt = selectedStatus?.lastRun?.startedAt ?? null

  return (
    <section>
      <div className="mb-5 flex items-baseline gap-2.5">
        <h2 className="text-xl leading-7 font-medium">一键启动</h2>
        <span className="text-sm text-muted-foreground">
          配置本机客户端的启动路径，在这里一键唤起
        </span>
        <Link
          to={`${navPath(NAV_CODES.WORKBENCH)}/launch`}
          className="ml-auto flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          管理配置
          <ArrowRight className="size-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-4 grid-rows-[200px_128px] gap-4">
        {/* 主卡。跨两列。
            媒体层与压暗层是负 `z-index` 的绝对定位**兄弟节点**，必须写在内容之前 ——
            它们的叠放顺序由 DOM 顺序决定，靠后写会盖住文字。发丝高光挂在
            `.hero-card::after` 上，所以卡面要带这个类名。 */}
        <div className="hero-card relative isolate col-span-2 flex flex-col justify-end gap-2 overflow-hidden rounded-2xl bg-[var(--hero-surface)] px-4 py-6 text-[var(--hero-fg)] shadow-[var(--shadow-card)] backdrop-blur-[12.5px]">
          <div aria-hidden="true" className="hero-media" />
          <div aria-hidden="true" className="hero-shade" />
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xl leading-6 font-medium">已配置软件</h3>

            {loading ? (
              <p className="flex items-center gap-2 text-xs leading-[18px] text-[var(--hero-sub)]">
                <LoaderCircle className="size-3.5 animate-spin" />
                正在加载配置…
              </p>
            ) : loadError !== null ? (
              <p className="text-xs leading-[18px] text-[var(--hero-sub)]">
                {loadError}
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null)
                    reload()
                  }}
                  className="ml-2 underline underline-offset-2"
                >
                  重试
                </button>
              </p>
            ) : profiles !== null && profiles.length === 0 ? (
              <p className="text-xs leading-[18px] text-[var(--hero-sub)]">尚未添加启动配置。</p>
            ) : (
              /* 小图标托盘（方案 C）：每个已配置实例一枚小图标按钮，flex-wrap 排布。 */
              <div className="flex flex-wrap gap-2">
                {(profiles ?? []).map((profile) => {
                  const Icon = LAUNCH_ICONS[resolveLaunchIconKey(profile)]
                  const pathOkCard = statuses[profile.id]?.pathState === 'ok'
                  return (
                    <div
                      key={profile.id}
                      className="group relative flex size-[64px] flex-col items-center justify-center gap-1 rounded-xl border border-border bg-card p-1.5 shadow-[var(--shadow-pop)]"
                    >
                      {/* 单独的启动按钮：整卡点击是「进编辑」（§2.7），启动得有自己的一处入口。 */}
                      <button
                        type="button"
                        onClick={() => void handleLaunch(profile)}
                        aria-label={`启动 ${profile.name}`}
                        className="absolute right-1 top-1 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Rocket className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(profile)}
                        className="flex flex-col items-center gap-1"
                        title={profile.name}
                      >
                        <span className="relative grid size-9 place-items-center rounded-xl bg-muted text-foreground">
                          <Icon className="size-[18px]" />
                          {/* 右上角路径状态点：绿可用、红失效（复用现有两色）。 */}
                          <span
                            className={[
                              'size-[6px] absolute right-0 top-0 rounded-full ring-2 ring-card',
                              pathOkCard ? 'bg-[#4ade80]' : 'bg-[#f87171]',
                            ].join(' ')}
                          />
                        </span>
                        <span className="max-w-[52px] truncate text-xs leading-[14px] text-foreground">
                          {profile.name}
                        </span>
                      </button>
                    </div>
                  )
                })}
                {/* 末尾「+」卡：仅写权限可见，进新增（§2.7）。虚线边框与图标卡区分。 */}
                {canWrite && (
                  <button
                    type="button"
                    onClick={openCreate}
                    aria-label="新增启动配置"
                    className="flex size-[64px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border text-muted-foreground hover:text-foreground"
                  >
                    <Plus className="size-[18px]" />
                    <span className="text-xs">新增</span>
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs leading-[18px] text-[var(--hero-sub)]">
              {selected === null ? (
                <span>共 {profiles?.length ?? 0} 条配置</span>
              ) : (
                <>
                  <span className="flex items-center gap-2">
                    <span
                      className={[
                        'size-[5px] shrink-0 rounded-full',
                        pathOk ? 'bg-[#4ade80]' : 'bg-[#f87171]',
                      ].join(' ')}
                    />
                    {pathOk ? '路径可用' : '路径失效'}
                  </span>
                  <span className="h-2.5 w-px shrink-0 bg-[var(--hero-line)]" />
                  <span>
                    {lastRunAt === null ? '尚未启动' : `最近启动 ${formatRelativeTime(lastRunAt)}`}
                  </span>
                </>
              )}
            </div>

            {profiles !== null && profiles.length > 0 && canWrite ? (
              <button
                type="button"
                onClick={() => {
                  if (selected !== null) void handleLaunch(selected)
                }}
                disabled={launching || selectedId === null}
                className="launch-cta"
              >
                {launching ? (
                  <LoaderCircle className="size-[18px] animate-spin" />
                ) : (
                  <Rocket className="size-[18px]" />
                )}
                一键启动
              </button>
            ) : (
              <Link to={`${navPath(NAV_CODES.WORKBENCH)}/launch`} className="launch-cta">
                <Rocket className="size-[18px]" />
                去配置
              </Link>
            )}
          </div>

          {notice !== null && (
            <p
              className={[
                'text-xs leading-[18px]',
                notice.kind === 'ok' ? 'text-[var(--hero-sub)]' : 'text-[#fca5a5]',
              ].join(' ')}
            >
              {notice.text}
            </p>
          )}
        </div>

        {AI_MODULES.map(({ title, desc, hue, Icon }) => (
          <div
            key={title}
            style={{ '--hue': hue } as React.CSSProperties}
            /* 卡面、`::before` 辉光层、悬停的 box-shadow 辉光与 0.6s `glow-bloom`
               都写在 `index.css` 的 `.mod-card` 里（原型 `.mod` 的四层材质）。
               这里刻意**不给任何 transition 类**：设计稿的悬停是一帧到位，
               全站只有侧栏底部的分段控件带过渡。 */
            className="mod-card"
          >
            <span className="absolute top-3 right-3 z-[1] rounded-full border border-border px-2 text-xs leading-[1.6] text-muted-foreground-weak">
              开发中
            </span>
            <span className="mod-icon grid size-9 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--hue)_var(--wash),var(--card))] text-[var(--hue)]">
              <Icon className="size-[18px]" />
            </span>
            <div className="mod-body w-full min-w-0">
              <h4 className="mb-0.5 text-lg leading-7 font-medium">{title}</h4>
              <p className="text-sm leading-5 text-muted-foreground">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 首页直接复用工作台那套编辑/新增对话框：增删改是同一份逻辑，不该两套漂移。 */}
      <LaunchProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profile={editing}
        focusPath={focusPath}
        suggestedPaths={suggestedPaths}
        onSubmit={handleSubmit}
      />
    </section>
  )
}
