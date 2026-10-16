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
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import { applyCredentialIntent, describeCredentialOutcome } from '../../lib/launch-credentials'
import { launchRunRecovery, LaunchRunError, runLaunchProfile } from '../../lib/launch'
import {
  LAUNCH_APP_ICON_SIZE,
  pickLaunchIconUrl,
  resolveLaunchBrandHue,
} from '../../lib/launch-app-icon'
import { resolveLaunchIconKey, LAUNCH_ICONS } from '../../lib/launch-icons'
import { buildSuggestedPaths } from '../../lib/launch-suggest'
import { useLaunchAppIcons } from '../../lib/use-launch-app-icons'
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
 * 4 列 × 2 行的 Bento：主卡跨两列（**200 高起**，托盘换行时随内容增高），六张单元卡填满
 * 其余五格（第一排两格 200 高、第二排四格 128 高）。列宽 378、gap 16，与案例展示落在同一条
 * 栅格上。
 *
 * **主卡接的是真实数据。** 原型那张卡上写的是授权信息，本项目没有这份数据，因此换成
 * 手上真有的两样：所选配置的可执行文件路径状态，与它的最近一次启动。
 * **不照抄那四段文案**：在拿不到数据的地方写死一段看起来很确定的字，比留白更糟。
 *
 * 主卡内是一条**小图标托盘**（方案 C，见 `docs/LAUNCH-OPTIMIZE-2026-10-15.md` §2.6）：
 * 每个已配置实例一枚小图标按钮（图标 + 名称小字 + 右上角路径状态点），`flex-wrap`
 * 排布，实例超出主卡内宽时自动换行，主卡随之增高（**默认 1280 窗口下一排 6 枚，
 * 第 6 个启动程序即换行**；窄窗口更早）。点图标进该实例的编辑（§2.7），悬停
 * 出的小火箭单独启动那一条；托盘末尾一枚虚线「+」卡进新增（仅 `canWrite` 可见）。
 *
 * **图标用的是程序自己的图标**（§2.9，`lib/launch-app-icon.ts`）：外壳经 `app.getFileIcon`
 * 取回，与桌面快捷方式同源，底衬按品牌色配浅底。取不到（浏览器态、路径失效）才回落
 * `lib/launch-icons.ts` 那套通用图标。原先那套通用图标当年写的是「不引品牌图标：商标有
 * 额外约束」，代价是每枚图标都认不出是哪个软件 —— 用户已拍板改为取真实图标。
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
  const {
    profiles,
    statuses,
    loading,
    loadError,
    reload,
    recheckStatuses,
    createProfile,
    updateProfile,
  } = useLaunchProfiles()

  // §2.5 复用：每个软件「最近有效路径」反查表，新增配置选软件时预填路径框。
  const suggestedPaths = useMemo(
    () => buildSuggestedPaths(profiles, statuses),
    [profiles, statuses],
  )

  // §2.9 真实程序图标：外壳按路径批量取回，按小写路径索引。浏览器态与取不到时是空表，
  // 卡片回落 `launch-icons.ts` 的通用图标。
  const appIcons = useLaunchAppIcons(profiles)

  const [userSelectedId, setUserSelectedId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LaunchProfile | null>(null)
  const [focusPath, setFocusPath] = useState(false)

  // 选中态 = 用户点过的那条，否则回落到列表第一条。用「派生」而不是「effect 里 setState」：
  // 这样既能在 profiles 初次到达时自动选中第一条，又不会在用户手动选过、或 profiles 重新
  // 拉取后把选择拉回第一条（userSelectedId 非空时它永远优先）。顺带绕开了
  // react-hooks/set-state-in-effect。
  const selectedId = userSelectedId ?? profiles?.[0]?.id ?? null

  async function handleLaunch(profile: LaunchProfile): Promise<void> {
    // 点托盘里某条的火箭，也把它标成「当前选中」，让大按钮落到同一条上。
    setUserSelectedId(profile.id)
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

  /**
   * 保存。与 `LaunchPanel` 同一套两步：先落配置（新增时配置还没有 id，凭据按 id 关联），
   * 再落本机凭据。两处各自写一遍迟早有一处忘了处理「清除」，因此这句话在两边都引
   * `applyCredentialIntent`。
   */
  async function handleSubmit(values: LaunchFormValues): Promise<void> {
    if (editing === null) {
      const created = await createProfile(values)
      const outcome =
        values.login === undefined
          ? ({ action: 'keep' } as const)
          : await applyCredentialIntent(created.id, values.login, created.name)
      const extra = describeCredentialOutcome(outcome)
      setNotice({
        kind: 'ok',
        text: extra === '' ? `已新增「${created.name}」` : `已新增「${created.name}」，${extra}`,
      })
      return
    }

    const updated = await updateProfile(editing.id, values)
    const outcome =
      values.login === undefined
        ? ({ action: 'keep' } as const)
        : await applyCredentialIntent(updated.id, values.login, updated.name)
    const extra = describeCredentialOutcome(outcome)
    setNotice({
      kind: 'ok',
      text: extra === '' ? `已保存「${updated.name}」` : `已保存「${updated.name}」，${extra}`,
    })
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

      {/* 行高必须写成 `minmax(200px, auto)` 而不是 `200px`。写死 200 时，主卡内容
          （标题 + 托盘 + 状态行）一旦超过 200 就被 `overflow-hidden` 裁掉 —— 而主卡是
          `justify-end`，被裁的是**顶部**：托盘换到第二行时，标题整块消失、首行图标上沿
          被切平，正是真机报上来的那个现象。托盘换行的门槛很低（默认 1280 窗口下主卡内宽
          432，一排只放得下 6 枚 64px 卡），第 6 个启动程序就会撞上。
          `auto` 让这一行随内容长高，与托盘注释里「实例增多时主卡随之增高」的原意一致；
          同排两张单元卡跟着一起长，Bento 的矩形关系不变。 */}
      <div className="grid grid-cols-4 grid-rows-[minmax(200px,auto)_128px] gap-4">
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
            ) : (
              /* 小图标托盘（方案 C）：每个已配置实例一枚小图标按钮，flex-wrap 排布。

                 **零配置时也渲染托盘**：末尾那枚「+」是新用户建首条配置的唯一入口。
                 早先实现把整块托盘放进「有配置」分支，零配置时只剩一行文字，新增入口
                 跟着整块消失（真机实测第一档就卡死在这）。空列表 + 有写权限时，托盘里
                 就只有那一枚虚线「+」。 */
              <>
                {profiles !== null && profiles.length === 0 && (
                  <p className="text-xs leading-[18px] text-[var(--hero-sub)]">
                    尚未添加启动配置。
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {(profiles ?? []).map((profile) => {
                    const Icon = LAUNCH_ICONS[resolveLaunchIconKey(profile)]
                    const pathOkCard = statuses[profile.id]?.pathState === 'ok'
                    const appIconUrl = pickLaunchIconUrl(profile, appIcons)
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
                          className="absolute top-1 right-1 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                        >
                          <Rocket className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEdit(profile)}
                          className="flex flex-col items-center gap-1"
                          title={profile.name}
                        >
                          {/* 图标位（§2.9）。底是**品牌色浅底**，用的是与右侧模块卡同一条配方
                            （`--hue` + `--wash`，见 `.mod-icon`）—— 明度语言两处一致。
                            里面优先放**程序自己的图标**（外壳经 `app.getFileIcon` 取回，与桌面
                            快捷方式同源）；没取到（浏览器态、路径失效、文件被占用）才回落
                            `launch-icons.ts` 那套通用图标，此时它由 `--hue` 上色。

                            `<img>` 用 `object-contain` + 定宽定高：源图是 48×48、这里显示 24，
                            长宽比不是 1:1 的图标会按比例缩放并居中，**不会被拉伸**。
                            `alt=""` 是刻意的 —— 名称就在下面一行，读屏再念一遍是噪音。
                            `draggable={false}` 挡掉浏览器原生的图片拖拽（外壳里拖出一张半透明
                            的图标残影看着像坏了）。 */}
                          <span
                            className="relative grid size-9 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--hue)_var(--wash),var(--card))] text-[var(--hue)]"
                            style={
                              { '--hue': resolveLaunchBrandHue(profile) } as React.CSSProperties
                            }
                          >
                            {appIconUrl === null ? (
                              <Icon className="size-[18px]" />
                            ) : (
                              <img
                                src={appIconUrl}
                                alt=""
                                draggable={false}
                                className="object-contain"
                                style={{
                                  width: LAUNCH_APP_ICON_SIZE,
                                  height: LAUNCH_APP_ICON_SIZE,
                                }}
                              />
                            )}
                            {/* 右上角路径状态点：绿可用、红失效（复用现有两色）。 */}
                            <span
                              className={[
                                'absolute top-0 right-0 size-[6px] rounded-full ring-2 ring-card',
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
                      {/* 图标与名称的盒模型必须与实例卡逐值对齐。原先加号直接是 18px 的
                        `<svg>`、名称用 `text-xs` 的默认行高，整块只有 38 高，在 64 的卡里
                        上下各留 13；实例卡是 36 的图标盒 + 14 行高，共 54 高，上下各留 5。
                        两种卡并排时「+」明显偏上、字也不在一行上。套一个同尺寸的 36px 盒、
                        名称同用 14px 行高之后，两类卡的图标中线与文字基线重合。 */}
                      <span className="grid size-9 place-items-center">
                        <Plus className="size-[18px]" />
                      </span>
                      <span className="text-xs leading-[14px]">新增</span>
                    </button>
                  )}
                </div>
              </>
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
