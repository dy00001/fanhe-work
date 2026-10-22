import { PERMISSIONS, type OpsCollectorStatus, type OpsShopSummary } from '@fanhe/shared'
import { ChevronDown, ChevronRight, Link2, LogIn, RefreshCw, Trash2, Zap } from 'lucide-react'
import { useCallback, useState } from 'react'

import { useAuth } from '../../auth/useAuth'
import { currentHost } from '../../lib/host'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  bindOpsShop,
  describeShopMutationError,
  loadOpsShops,
  requestOpsShopSync,
  unbindOpsShop,
} from '../../lib/ops-shops'
import {
  LOGIN_STATE_META,
  collectorView,
  loginDetail,
  shopSlotText,
  shopSyncView,
  type ShopStateTone,
} from '../../lib/ops-display'

/**
 * 店铺绑定与管理。
 *
 * ## 为什么放在看板页里，而不是新开一个导航项
 *
 * 导航项由共享包的清单派生，新增一项要动 `NAV_ITEMS`、权限映射与路由三处；
 * 而「绑定店铺」是一个低频的管理动作，不配占一个一级入口。折叠面板挂在看板页
 * 顶部，权限点单独判（`ops.shop.bind`），看不到的人连这一行都不渲染。
 *
 * ## 绑定之后数据从哪来
 *
 * 绑定只做三件事：登记店铺、写采集槽位、置 `syncRequestedAt`。真正的同步由
 * 宿主机的采集器完成（`tools/collector/scripts/sync-shops.mjs` 轮询待办，
 * 跑完把登录态与失败原因回写）。**平台侧不会自己开浏览器去采** —— API 可能
 * 跑在容器里，碰不到宿主机上的 Edge 与调试端口。
 *
 * 这也是为什么绑定成功后这里显示的是「等待采集器」，而不是直接显示数据：
 * 采集一轮几十秒起，假装同步完成会让用户以为看板上已经有数了。
 */

const TONE_CLASS: Record<ShopStateTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  muted: 'border-border bg-muted/40 text-muted-foreground',
}

function StateChip(props: { tone: ShopStateTone; label: string; title?: string }) {
  return (
    <span
      {...(props.title === undefined ? {} : { title: props.title })}
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-4 ${TONE_CLASS[props.tone]}`}
    >
      {props.label}
    </span>
  )
}

type Notice = { kind: 'ok' | 'error'; text: string; snippet?: string }

export function OpsShopBindingPanel() {
  const { can } = useAuth()
  const canBind = can(PERMISSIONS.OPS_SHOP_BIND)

  const [open, setOpen] = useState(false)
  const [shops, setShops] = useState<OpsShopSummary[] | null>(null)
  /* 采集器状态与列表同一次响应回来，所以两者永远描述同一个时点。 */
  const [collector, setCollector] = useState<OpsCollectorStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busyCode, setBusyCode] = useState('')

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [port, setPort] = useState('')
  const [sellerNick, setSellerNick] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const data = await loadOpsShops()
      setShops(data.shops)
      setCollector(data.collector)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '读取店铺列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  /* 展开才拉列表：看板首屏不该为一块默认收起的面板多付一次往返。
     放在点击事件里而不是 effect 里 —— 在 effect 里同步 setState 会触发级联渲染，
     而且「展开」这个动作本身就是加载的意图，没必要等一次渲染再判断。 */
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && shops === null && !loading) void reload()
  }

  if (!canBind) return null

  const submit = async () => {
    setSubmitting(true)
    setNotice(null)
    try {
      const result = await bindOpsShop({
        code: code.trim(),
        name: name.trim(),
        platform: 'taobao',
        sellerNick: sellerNick.trim() === '' ? null : sellerNick.trim(),
        collectPort: Number(port),
      })
      const slot = result.slot
      setNotice({
        kind: 'ok',
        text:
          slot?.kind === 'manual'
            ? `已绑定「${result.shop.name}」，但采集槽位没能自动写入：${slot.reason}。把下面的片段手工加进 shops.config.json 的 shops 数组。`
            : `已绑定「${result.shop.name}」，采集器下一轮轮询会把它排进同步（通常一分钟内）。`,
        ...(slot?.kind === 'manual' ? { snippet: slot.snippet } : {}),
      })
      setCode('')
      setName('')
      setPort('')
      setSellerNick('')
      setShops(null)
      await reload()
    } catch (error) {
      setNotice({ kind: 'error', text: describeShopMutationError(error) })
    } finally {
      setSubmitting(false)
    }
  }

  const sync = async (shop: OpsShopSummary) => {
    setBusyCode(shop.code)
    setNotice(null)
    try {
      await requestOpsShopSync(shop.code)
      setNotice({
        kind: 'ok',
        text: `已请求同步「${shop.name}」。采集器处理完后这里的状态会更新，看板数据随后到位。`,
      })
      await reload()
    } catch (error) {
      setNotice({ kind: 'error', text: describeShopMutationError(error) })
    } finally {
      setBusyCode('')
    }
  }

  const unbind = async (shop: OpsShopSummary) => {
    if (!window.confirm(`解绑「${shop.name}」？历史数据保留，重新绑定同一个代号可以接上。`)) return
    setBusyCode(shop.code)
    setNotice(null)
    try {
      await unbindOpsShop(shop.code)
      setNotice({ kind: 'ok', text: `已解绑「${shop.name}」，历史数据仍然保留。` })
      await reload()
    } catch (error) {
      setNotice({ kind: 'error', text: describeShopMutationError(error) })
    } finally {
      setBusyCode('')
    }
  }

  /**
   * 打开采集浏览器的登录窗口。
   *
   * 两条路：桌面壳里直接起脚本（脚本要连本机 Edge，只有外壳做得到）；浏览器里
   * 没有这个能力，退化成「复制命令」。**两条路都把命令展示出来** —— 安装态没有
   * `tools/collector`，桥会返回 `collector_missing`，此时用户需要的就是这条命令。
   */
  const openLogin = async (shop: OpsShopSummary) => {
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -File tools\\collector\\scripts\\shop-login.ps1 -Shop ${shop.code}`
    setNotice(null)
    const bridge = window.fanheDesktop
    if (currentHost() === 'desktop' && bridge?.openShopLogin !== undefined) {
      const result = await bridge.openShopLogin(shop.code)
      if (result.ok) {
        setNotice({
          kind: 'ok',
          text: `已打开「${shop.name}」的采集浏览器。在里面登录生意参谋，登录态会被采集器读到并回写到这一行。`,
        })
        return
      }
      setNotice({
        kind: 'error',
        text: result.message,
        snippet: result.command === '' ? command : result.command,
      })
      return
    }
    try {
      await navigator.clipboard.writeText(command)
      setNotice({
        kind: 'ok',
        text: '命令已复制，在仓库根执行即可打开登录窗口。',
        snippet: command,
      })
    } catch {
      setNotice({
        kind: 'error',
        text: '浏览器不允许自动复制，请手工执行下面这条命令。',
        snippet: command,
      })
    }
  }

  const now = new Date()

  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <Link2 className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">店铺绑定与管理</span>
        <span className="text-xs text-muted-foreground">
          绑定后由本机采集器自动同步，无需手工录入
        </span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {notice !== null ? (
            <div
              className={`rounded-lg border px-3 py-2 text-xs ${notice.kind === 'ok' ? TONE_CLASS.ok : TONE_CLASS.error}`}
            >
              <p>{notice.text}</p>
              {notice.snippet !== undefined ? (
                <pre className="mt-2 overflow-x-auto rounded bg-background/60 p-2 text-[11px] text-foreground">
                  {notice.snippet}
                </pre>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground">已绑定店铺</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void reload()
              }}
              disabled={loading}
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>

          {(() => {
            /* 采集器离线时「立即同步」不会被执行，这一点必须在按钮旁边说清楚，
               否则用户会以为点了就会采，然后一直等一个不会来的结果。 */
            const view = collectorView(collector, now)
            return (
              <div className="flex flex-wrap items-center gap-2">
                <StateChip tone={view.tone} label={view.label} />
                <span className="text-[11px] text-muted-foreground">{view.detail}</span>
              </div>
            )
          })()}

          {loadError !== '' ? (
            <p className="text-xs text-rose-600 dark:text-rose-400">{loadError}</p>
          ) : null}

          {shops === null ? (
            <p className="text-xs text-muted-foreground">正在读取…</p>
          ) : shops.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有绑定任何店铺。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-1.5 pr-3 font-medium">店铺</th>
                    <th className="py-1.5 pr-3 font-medium">登录态</th>
                    <th className="py-1.5 pr-3 font-medium">数据同步</th>
                    <th className="py-1.5 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shops.map((shop) => {
                    const login = LOGIN_STATE_META[shop.loginState]
                    const syncView = shopSyncView(shop, now)
                    return (
                      <tr key={shop.id} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-3">
                          <div className="font-medium text-foreground">{shop.name}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {shopSlotText(shop)}
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          <StateChip tone={login.tone} label={login.label} title={login.hint} />
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {loginDetail(shop)}
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          <StateChip tone={syncView.tone} label={syncView.label} />
                          <div
                            className="mt-0.5 max-w-[22rem] truncate text-[11px] text-muted-foreground"
                            title={syncView.detail}
                          >
                            {syncView.detail}
                          </div>
                        </td>
                        <td className="py-2">
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyCode !== ''}
                              onClick={() => {
                                void openLogin(shop)
                              }}
                            >
                              <LogIn className="size-3.5" />
                              打开登录
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyCode !== ''}
                              onClick={() => {
                                void sync(shop)
                              }}
                            >
                              <Zap className="size-3.5" />
                              立即同步
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyCode !== ''}
                              onClick={() => {
                                void unbind(shop)
                              }}
                            >
                              <Trash2 className="size-3.5" />
                              解绑
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-lg border border-dashed border-border p-3">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">绑定新店铺</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-muted-foreground">
                店铺代号
                <Input
                  value={code}
                  placeholder="例如 fanhe-main"
                  onChange={(event) => {
                    setCode(event.target.value)
                  }}
                  className="mt-1 h-8 text-xs"
                />
              </label>
              <label className="text-[11px] text-muted-foreground">
                店铺名称（与千牛后台逐字一致）
                <Input
                  value={name}
                  placeholder="例如 梵禾"
                  onChange={(event) => {
                    setName(event.target.value)
                  }}
                  className="mt-1 h-8 text-xs"
                />
              </label>
              <label className="text-[11px] text-muted-foreground">
                采集端口
                <Input
                  value={port}
                  inputMode="numeric"
                  placeholder="9222"
                  onChange={(event) => {
                    setPort(event.target.value)
                  }}
                  className="mt-1 h-8 text-xs"
                />
              </label>
              <label className="text-[11px] text-muted-foreground">
                掌柜昵称（可选）
                <Input
                  value={sellerNick}
                  placeholder="用于对照千牛账号"
                  onChange={(event) => {
                    setSellerNick(event.target.value)
                  }}
                  className="mt-1 h-8 text-xs"
                />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                disabled={
                  submitting || code.trim() === '' || name.trim() === '' || port.trim() === ''
                }
                onClick={() => {
                  void submit()
                }}
              >
                {submitting ? '绑定中…' : '绑定店铺'}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                绑定不会自动登录。首次需要在采集浏览器里登录一次生意参谋，之后由采集器维持。
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
