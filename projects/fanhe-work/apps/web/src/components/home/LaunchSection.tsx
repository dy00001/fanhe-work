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
  Rocket,
  Scissors,
  Sparkles,
  UserRound,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import {
  launchRunRecovery,
  loadLaunchProfiles,
  loadLaunchStatuses,
  runLaunchProfile,
} from '../../lib/launch'
import { formatRelativeTime } from '../../lib/relative-time'

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
 * 一键启动（原型编号 10）。
 *
 * 4 列 × 2 行的 Bento：主卡跨两列（200 高），六张单元卡填满其余五格（第一排两格
 * 200 高、第二排四格 128 高）。列宽 378、gap 16，与案例展示落在同一条栅格上。
 *
 * **主卡接的是真实数据。** 原型那张卡上写的是「授权有效 / 有效期至 2027-03-01 /
 * 绑定设备 2 / 3 / v2.4.1」—— 那是设计软件的授权信息，本项目没有这份数据，因此
 * 换成手上真有的两样：所选配置的可执行文件路径状态，与它的最近一次启动。
 * **不照抄那四段文案**：在拿不到数据的地方写死一段看起来很确定的字，比留白更糟 ——
 * 用户会以为授权已经检查过了。
 *
 * 主卡里接的是**原型的媒体层**：背景素材、横向压暗渐变、`::after` 发丝高光三层都在
 * （取值与理由见 index.css 的「一键启动主卡的媒体层」）。素材是静态海报帧，不是原版
 * 那样循环播放的两条 `<video>` —— 首帧与实测截图的卡片内容一致，接动效等有片子再说。
 *
 * 管理入口（新增 / 编辑 / 排序 / 删除）仍在完整面板上，地址是 `/workbench/launch`；
 * 本区块只做「选一条 + 启动」。区块头右侧的「管理配置」是它的入口 —— 原型这里没有
 * 这个链接，是本实现补的：把完整面板从首页替换掉之后，不给入口等于砍功能。
 */
export function LaunchSection() {
  const { can } = useAuth()
  const canRead = can(PERMISSIONS.PERSONAL_LAUNCH_READ)
  const canWrite = can(PERMISSIONS.PERSONAL_LAUNCH_WRITE)

  /** `null` 表示还没拿到过数据，与「拿到了但是空的」区分开。 */
  const [profiles, setProfiles] = useState<readonly LaunchProfile[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, LaunchProfileStatus>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [statusToken, setStatusToken] = useState(0)

  const loading = profiles === null && loadError === null

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await loadLaunchProfiles()
        if (cancelled) return
        setProfiles(list)
        setLoadError(null)
        // 默认选中第一条。写在加载成功之后而不是从列表推导：`selectedId` 是用户
        // 可改的状态，推导出来会变成「用户选过之后又被拉回第一条」。
        setSelectedId((current) => current ?? list[0]?.id ?? null)
      } catch (error) {
        if (cancelled) return
        setLoadError(error instanceof ApiError ? error.message : '加载启动配置失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await loadLaunchStatuses()
        if (cancelled) return
        setStatuses(Object.fromEntries(list.map((item) => [item.profileId, item])))
      } catch {
        // 状态是附加信息，拿不到时列表照常可用（只是不显示路径状态与启动摘要）。
        // 这条与 `lib/launch.ts` 的取舍一致：不让一次附加查询把整块拖成「加载失败」。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [statusToken])

  async function handleLaunch(): Promise<void> {
    if (selectedId === null) return
    setLaunching(true)
    setNotice(null)
    try {
      const result = await runLaunchProfile(selectedId)
      const name = profiles?.find((item) => item.id === selectedId)?.name ?? '配置'
      setNotice({ kind: 'ok', text: `已启动「${name}」（进程 ${result.pid}）` })
    } catch (error) {
      const relocate = error instanceof ApiError && launchRunRecovery(error) === 'relocate'
      const message = error instanceof ApiError ? error.message : '启动失败，请稍后重试'
      setNotice({
        kind: 'error',
        text: relocate ? `${message}。请到「管理配置」里重新指定路径。` : message,
      })
    } finally {
      setLaunching(false)
      // 成功与失败都会落一条记录，因此这次都要重拉状态。
      setStatusToken((token) => token + 1)
    }
  }

  if (!canRead) return null

  const selected = profiles?.find((item) => item.id === selectedId) ?? null
  const selectedStatus = selected === null ? undefined : statuses[selected.id]
  const pathOk = selectedStatus?.pathState === 'ok'
  const lastRunAt = selectedStatus?.lastRun?.startedAt ?? null

  return (
    <section>
      <div className="mb-5 flex items-baseline gap-2.5">
        <h2 className="text-xl leading-7 font-medium">一键启动</h2>
        <span className="text-sm text-muted-foreground">
          授权后直接唤起本地设计软件，无需再单独登录
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
            <div className="flex items-center gap-2">
              <h3 className="text-xl leading-6 font-medium">设计软件一键登录</h3>
              <span className="rounded-[9px] bg-[var(--hero-badge)] px-2 py-[3px] text-[13px] leading-6 font-medium text-white">
                Beta
              </span>
            </div>
            <p className="text-sm leading-5 text-[var(--hero-sub)]">
              打开软件的同时带过账号与授权，省去每次手动输入。
            </p>

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
                    setLoadError(null)
                    setReloadToken((token) => token + 1)
                  }}
                  className="ml-2 underline underline-offset-2"
                >
                  重试
                </button>
              </p>
            ) : profiles !== null && profiles.length === 0 ? (
              <p className="text-xs leading-[18px] text-[var(--hero-sub)]">尚未添加启动配置。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(profiles ?? []).slice(0, 2).map((profile) => {
                  const active = profile.id === selectedId
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => setSelectedId(profile.id)}
                      aria-pressed={active}
                      className={[
                        'rounded-full border px-2.5 py-px text-xs leading-[18px]',
                        active
                          ? 'border-transparent bg-[var(--hero-chip)] text-[var(--hero-fg)]'
                          : 'border-[var(--hero-line)] text-[var(--hero-sub)] hover:text-[var(--hero-fg)]',
                      ].join(' ')}
                    >
                      {profile.name}
                    </button>
                  )
                })}
                {(profiles?.length ?? 0) > 2 && (
                  <span className="rounded-full border border-[var(--hero-line)] px-2.5 py-px text-xs leading-[18px] text-[var(--hero-sub)]">
                    +{(profiles?.length ?? 0) - 2}
                  </span>
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
                  void handleLaunch()
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
    </section>
  )
}
