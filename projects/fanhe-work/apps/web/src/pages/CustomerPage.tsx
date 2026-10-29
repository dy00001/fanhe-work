import {
  CUSTOMER_STAGES,
  NAV_CODES,
  PERMISSIONS,
  type CustomerDetailDto,
  type CustomerListItemDto,
  type CustomerListResponse,
  type CustomerOrderDto,
  type CustomerStage,
  type NavItem,
} from '@fanhe/shared'
import { UsersRound } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useAuth } from '../auth/useAuth'
import { ModuleHeader } from '../components/ModuleHeader'
import { ErrorState, EmptyState, LoadingState } from '../components/StateView'
import { TextField } from '../components/TextField'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table'
import { ApiError } from '../lib/api'
import {
  activityClass,
  activityOf,
  fillStageBuckets,
  formatDate,
  formatDateTime,
  formatFen,
  formatWan,
  orderProgress,
  parseYuanToFen,
  reviewLabel,
  scopeLabel,
  splitStepSections,
  stageLabel,
  stageTone,
  toneClass,
} from '../lib/customer-display'
import {
  createCustomer,
  createCustomerOrder,
  loadCustomer,
  loadCustomers,
  setCustomerStage,
  updateCustomerStep,
} from '../lib/customers'

/**
 * 客户信息平台的页面。
 *
 * 两个导航入口共用这一个组件，由 `item.code` 决定视角（与运营看板七项共用
 * `OpsDashboardPage` 是同一条做法）：
 *
 *   - 综合看板：先给汇总（总量、地区层级、阶段分布），再给清单 —— 回答「我一共有
 *     多少客户、都在什么阶段」；
 *   - 客户进度：隐藏汇总，直接给清单并默认带上阶段列 —— 回答「这一单做到哪了」。
 *
 * 两块共用同一份数据与同一套筛选，切换入口不重新学一遍界面。拆成两个页面的话，
 * 筛选条件得各维护一份，而两份迟早会不一致（在「综合看板」筛了地区，切到
 * 「客户进度」发现回到了全部）。
 *
 * **金额可见性由服务端决定，界面不做二次判断。** 列表响应里的 `financeReadable`
 * 是唯一依据：它同时覆盖「有没有权限」与「服务端是否已经裁掉」。前端再按角色
 * 算一遍，等于把授权规则复制到第二个地方，而两处不一致时的表现是「金额列空着
 * 但没报错」。
 */
export function CustomerPage({ item }: { item: NavItem }) {
  const { can } = useAuth()
  const canWrite = can(PERMISSIONS.CUSTOMER_RECORD_WRITE)
  const isProgress = item.code === NAV_CODES.CUSTOMER_PROGRESS

  const [draft, setDraft] = useState('')
  const [keyword, setKeyword] = useState('')
  const [scope, setScope] = useState('')
  const [stage, setStage] = useState('')
  const [pendingReview, setPendingReview] = useState(false)

  /**
   * 加载结果带着「它是哪一次请求的」。
   *
   * **不在 effect 体里同步 `setState({ status: 'loading' })`。** 那样每改一次筛选
   * 都会多一轮渲染（先把状态切成加载中，再切回来），而 React 的 lint 规则直接把它
   * 判成缺陷。这里的做法是让结果自己记住 `key`：当前请求的 key 与结果里的 key 不
   * 相等，就是「还没回来」，加载态由比较得出而不是被写进去。状态只有一个来源，
   * 也就不会出现「数据显示完了但加载态忘了关」。
   */
  const [result, setResult] = useState<{
    key: string
    data: CustomerListResponse | null
    error: string | null
    /**
     * 数据到达的那一刻。活跃度（「3 天前有消息」）要用它当基准。
     *
     * **不能在渲染里调 `Date.now()`**：渲染必须是纯的，React Compiler 会直接
     * 判成缺陷；更实际的理由是，同一次渲染里逐行取「现在」会让跨零点的两行
     * 出现「上面写昨天、下面写今天」。取一次，跟着数据走。
     */
    at: number
  }>({ key: '', data: null, error: null, at: 0 })
  const [refreshToken, setRefreshToken] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // key 里用 `\u0000` 分隔而不是逗号：客户姓名与搜索词都可能带逗号，拼起来会让
  // 两组不同的筛选算出同一个 key，表现为「改了筛选但列表没动」。
  const requestKey = [keyword, scope, stage, String(pendingReview), String(refreshToken)].join(
    '\u0000',
  )

  useEffect(() => {
    let cancelled = false
    loadCustomers({ q: keyword, scope, stage, pendingReview })
      .then((data) => {
        if (!cancelled) setResult({ key: requestKey, data, error: null, at: Date.now() })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // 只用接口给的中文提示，不透传异常原文：堆栈对使用者没有意义，还可能带出
        // 内部路径（这条与 StateView 里 ErrorState 的注释是同一条规矩）。
        setResult({ key: requestKey, data: null, error: describeFailure(error), at: Date.now() })
      })
    return () => {
      cancelled = true
    }
  }, [requestKey, keyword, scope, stage, pendingReview])

  const loading = result.key !== requestKey
  const data = loading ? null : result.data
  const failure = loading ? null : result.error

  const reload = () => setRefreshToken((value) => value + 1)

  return (
    <div className="flex flex-col gap-5">
      <ModuleHeader item={item} />

      {!isProgress && data !== null ? <Summary data={data} /> : null}

      <section className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setKeyword(draft.trim())
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="customer-search" className="text-xs text-muted-foreground">
                搜索客户
              </label>
              <Input
                id="customer-search"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="姓名、昵称或显示名"
                className="w-56"
              />
            </div>
            <Button type="submit" variant="outline" size="sm">
              查询
            </Button>
          </form>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="customer-scope" className="text-xs text-muted-foreground">
              地区
            </label>
            {/* 用原生 select 而不是造一个下拉组件：这里只需要「选一个值」，
                原生元素自带键盘操作与读屏支持，造一个反而要补齐这些。 */}
            <select
              id="customer-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            >
              <option value="">全部地区</option>
              <option value="domestic">国内</option>
              <option value="overseas">海外</option>
              <option value="special-region">港澳台</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="customer-stage" className="text-xs text-muted-foreground">
              阶段
            </label>
            <select
              id="customer-stage"
              value={stage}
              onChange={(event) => setStage(event.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            >
              <option value="">全部阶段</option>
              {CUSTOMER_STAGES.map((value) => (
                <option key={value} value={value}>
                  {stageLabel(value)}
                </option>
              ))}
            </select>
          </div>

          <label className="flex h-8 items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={pendingReview}
              onCheckedChange={(checked) => setPendingReview(checked === true)}
            />
            只看待复核
          </label>

          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft('')
                setKeyword('')
                setScope('')
                setStage('')
                setPendingReview(false)
              }}
            >
              清空筛选
            </Button>
            {canWrite ? (
              <Button type="button" size="sm" onClick={() => setCreating(true)}>
                录入客户
              </Button>
            ) : null}
          </div>
        </div>

        {loading ? <LoadingState variant="plain" label="正在加载客户…" /> : null}

        {failure === null ? null : (
          <ErrorState variant="plain" description={failure} onRetry={reload} />
        )}

        {data !== null && data.items.length === 0 ? (
          <EmptyState
            icon={UsersRound}
            variant="plain"
            title="没有符合条件的客户"
            description="换个筛选条件，或者先把客户录进来。"
          />
        ) : null}

        {data !== null && data.items.length > 0 ? (
          <CustomerTable
            items={data.items}
            financeReadable={data.financeReadable}
            nowMs={result.at}
            onSelect={setSelectedId}
          />
        ) : null}

        {data === null ? null : (
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            共 {data.total} 位客户
            {data.items.length < data.total ? `，当前显示最近活跃的 ${data.items.length} 位` : ''}
          </p>
        )}
      </section>

      {selectedId === null ? null : (
        <CustomerDetailDialog
          customerId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}

      {creating ? (
        <CreateCustomerDialog
          onClose={() => setCreating(false)}
          onCreated={(customer) => {
            setCreating(false)
            reload()
            setSelectedId(customer.id)
          }}
        />
      ) : null}
    </div>
  )
}

/** 汇总卡。只在综合看板出现，理由见页面顶部的注释。 */
function Summary({ data }: { data: CustomerListResponse }) {
  // 补齐零值并按主线顺序排：缺档会让一排阶段标签在每次刷新后跳位。
  const buckets = fillStageBuckets(data.summary.byStage, CUSTOMER_STAGES)
  const contractTotal = data.financeReadable
    ? data.items.reduce((sum, item) => sum + (item.contractTotalFen ?? 0), 0)
    : null

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard label="客户总数" value={String(data.total)} hint="当前筛选条件下" />
      <SummaryCard
        label="地区分布"
        value={`${data.summary.byScope.domestic} / ${data.summary.byScope.overseas} / ${data.summary.byScope['special-region']}`}
        hint="国内 / 海外 / 港澳台"
      />
      <SummaryCard
        label="合同额合计"
        value={contractTotal === null ? '无权限查看' : formatWan(contractTotal)}
        hint={contractTotal === null ? '需要「查看客户金额」权限' : '当前页客户汇总'}
      />
      <SummaryCard
        label="进行中"
        value={String(
          buckets
            .filter((bucket) => bucket.stage !== 'closed' && bucket.stage !== 'lost')
            .reduce((sum, bucket) => sum + bucket.count, 0),
        )}
        hint="未完结且未流失"
      />

      <div className="sm:col-span-2 lg:col-span-4">
        <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-card p-4">
          {buckets.map((bucket) => (
            <Badge
              key={bucket.stage}
              variant="outline"
              className={`${toneClass(stageTone(bucket.stage))} border-0`}
            >
              {stageLabel(bucket.stage)} {bucket.count}
            </Badge>
          ))}
        </div>
      </div>
    </section>
  )
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-medium text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground-weak">{hint}</p>
    </div>
  )
}

function CustomerTable({
  items,
  financeReadable,
  nowMs,
  onSelect,
}: {
  items: readonly CustomerListItemDto[]
  financeReadable: boolean
  /** 数据到达的时刻，由上游给一次。渲染里不许调 `Date.now()`。 */
  nowMs: number
  onSelect: (id: string) => void
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>客户</TableHead>
          <TableHead>地区</TableHead>
          <TableHead>阶段</TableHead>
          <TableHead>订单</TableHead>
          <TableHead>最近消息</TableHead>
          {financeReadable ? <TableHead className="text-right">合同额</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const review = reviewLabel(item.reviewStatus, item.confidence)
          const activity = activityOf(item.lastMessageAt, nowMs)
          return (
            <TableRow
              key={item.id}
              className="cursor-pointer"
              onClick={() => onSelect(item.id)}
              // 键盘可达：只靠 onClick 的话，这张表用 Tab 走不到任何一行，
              // 而这类「鼠标能用、键盘不能用」的缺陷在视觉上完全看不出来。
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(item.id)
                }
              }}
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{item.displayName}</span>
                  {item.hasRepeat ? (
                    <Badge variant="secondary" className="text-[10px]">
                      复购
                    </Badge>
                  ) : null}
                  {review === null ? null : (
                    <Badge variant="outline" className="text-[10px]">
                      {review}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground-weak">
                  {item.shortName} · {item.msgRows} 条消息
                </p>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {item.region}
                <span className="ml-1 text-xs text-muted-foreground-weak">
                  {scopeLabel(item.regionScope)}
                </span>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={`${toneClass(stageTone(item.stage))} border-0`}>
                  {stageLabel(item.stage)}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{item.orderCount}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <div>{formatDateTime(item.lastMessageAt)}</div>
                <div className={`mt-0.5 text-[11px] ${activityClass(activity.level)}`}>
                  {activity.label}
                </div>
              </TableCell>
              {financeReadable ? (
                <TableCell className="text-right text-sm text-foreground">
                  {formatFen(item.contractTotalFen)}
                </TableCell>
              ) : null}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/**
 * 录入客户。
 *
 * 只有六个字段，且**没有显示名**：显示名由服务端按「地区 + 短名」算出。让录入者
 * 手填显示名等于允许两套命名并存，而两套并存的结果是「同一个客户在列表和详情里
 * 名字不一样」，没人会把它当 bug 报上来。
 */
function CreateCustomerDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (customer: CustomerDetailDto) => void
}) {
  const [realName, setRealName] = useState('')
  const [region, setRegion] = useState('')
  const [phone, setPhone] = useState('')
  const [nickname, setNickname] = useState('')
  const [project, setProject] = useState('')
  const [contract, setContract] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError(null)
    if (realName.trim() === '') {
      setError('客户姓名不能为空')
      return
    }
    if (region.trim() === '') {
      setError('地区不能为空 —— 显示名由地区加称呼组成，缺了就分辨不出重名客户')
      return
    }
    // 合同额允许留空（还没谈定），但不允许填了却格式不对。
    let contractFen: number | undefined
    if (contract.trim() !== '') {
      const parsed = parseYuanToFen(contract)
      if (!parsed.ok) {
        setError(parsed.reason === 'too-large' ? '金额过大，请核对单位（元）' : '金额格式不正确')
        return
      }
      contractFen = parsed.fen
    }

    setBusy(true)
    try {
      const created = await createCustomer({
        realName: realName.trim(),
        region: region.trim(),
        phone: phone.trim() === '' ? undefined : phone.trim(),
        primaryNickname: nickname.trim() === '' ? undefined : nickname.trim(),
        project: project.trim() === '' ? undefined : project.trim(),
      })
      // 先建客户再建首单：接口拆成两条，前端按顺序调。合成一个「建客户并建单」
      // 的接口会让「只录客户、暂不建单」变成一种要额外表达的例外。
      if (contractFen !== undefined) {
        await createCustomerOrder(created.id, { contractFen })
      }
      onCreated(created)
    } catch (caught) {
      setError(describeFailure(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>录入客户</DialogTitle>
          <DialogDescription>
            地区会进入显示名（例如「青海李秋月」）。显示名与称呼由系统计算，不用填。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="new-real-name" label="客户姓名" value={realName} onChange={setRealName} />
          <TextField
            id="new-region"
            label="地区"
            value={region}
            onChange={setRegion}
            hint="如 青海、美国、中国台湾"
          />
          <TextField id="new-phone" label="电话（选填）" value={phone} onChange={setPhone} />
          <TextField
            id="new-nickname"
            label="微信昵称（选填）"
            value={nickname}
            onChange={setNickname}
          />
          <TextField
            id="new-project"
            label="项目名（选填）"
            value={project}
            onChange={setProject}
            hint="同一客户多项目时用于区分"
          />
          <TextField
            id="new-contract"
            label="首单合同额（元，选填）"
            value={contract}
            onChange={setContract}
          />
        </div>

        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 客户详情：档案 + 订单 + 十四环节。
 *
 * 自己拉数据而不是由列表传进来：列表行只有汇总字段（订单数、合同额），详情的
 * 十四个环节、金额来源、消息起止时间都不在里面。传一个「半份详情」进来，界面
 * 就得处理「有的字段有、有的没有」这种中间态，而它只在点开的那一瞬间存在。
 */
function CustomerDetailDialog({
  customerId,
  onClose,
  onChanged,
}: {
  customerId: string
  onClose: () => void
  onChanged: () => void
}) {
  const { can } = useAuth()
  const canOrder = can(PERMISSIONS.CUSTOMER_ORDER_WRITE)

  // 与列表同一条做法：结果记住「是哪一位客户的」，加载态由 id 比较得出，
  // 不在 effect 体里同步清空状态（那会多渲染一轮，且 lint 直接判成缺陷）。
  const [loaded, setLoaded] = useState<{
    id: string
    customer: CustomerDetailDto | null
    error: string | null
    /** 详情到达的时刻，活跃度按它算。理由同列表那处。 */
    at: number
  }>({ id: '', customer: null, error: null, at: 0 })
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<CustomerStage>('consulting')
  const [reason, setReason] = useState('')

  const customer = loaded.id === customerId ? loaded.customer : null
  const error = loaded.id === customerId ? loaded.error : null
  const loading = loaded.id !== customerId

  useEffect(() => {
    let cancelled = false
    loadCustomer(customerId)
      .then((data) => {
        if (cancelled) return
        setLoaded({ id: customerId, customer: data, error: null, at: Date.now() })
        setStage(data.stage)
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setLoaded({
            id: customerId,
            customer: null,
            error: describeFailure(caught),
            at: Date.now(),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [customerId])

  /** 只替换详情里的错误，不动已加载的数据 —— 改一步失败时整页不该退回空白。 */
  const setError = (message: string | null) =>
    setLoaded((previous) => ({ ...previous, error: message }))

  /**
   * 执行一次写操作并同步结果。
   *
   * 写接口回的都是**整条客户详情**，所以这里直接替换，不猜「改完之后应该长什么样」。
   * 同时通知外层刷新列表：阶段与合同额在列表行上也有一份，不同步会让两处对不上。
   */
  const apply = async (action: () => Promise<CustomerDetailDto>) => {
    setBusy(true)
    setError(null)
    try {
      const updated = await action()
      // 保留 `at`：这次改的是阶段或环节，`lastMessageAt` 没动，活跃度的基准不该跳。
      setLoaded((previous) => ({ ...previous, id: customerId, customer: updated, error: null }))
      setStage(updated.stage)
      onChanged()
    } catch (caught) {
      setError(describeFailure(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{customer?.displayName ?? '客户详情'}</DialogTitle>
          <DialogDescription>
            {customer === null
              ? '正在加载…'
              : `${customer.region} · ${scopeLabel(customer.regionScope)} · ${stageLabel(customer.stage)}`}
          </DialogDescription>
        </DialogHeader>

        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}

        {customer === null ? (
          loading ? (
            <LoadingState variant="plain" label="正在加载客户…" />
          ) : null
        ) : (
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <Field label="真名" value={customer.realName ?? '—'} />
              <Field label="电话" value={customer.phone ?? '—'} />
              <Field label="微信昵称" value={customer.primaryNickname ?? '—'} />
              <Field label="姓名来源" value={customer.nameSource ?? '—'} />
              <Field label="消息条数" value={String(customer.msgRows)} />
              <Field label="图片/语音跳过" value={`${customer.skipImg} / ${customer.skipVoice}`} />
              <Field label="首条消息" value={formatDateTime(customer.firstMessageAt)} />
              <Field label="最近消息" value={formatDateTime(customer.lastMessageAt)} />
              <Field label="活跃度" value={activityOf(customer.lastMessageAt, loaded.at).label} />
              <Field label="来源群文件" value={customer.groupFile ?? '手工录入'} />
            </dl>

            {canOrder ? (
              <div className="rounded-xl border border-border p-4">
                <p className="text-sm font-medium text-foreground">推进阶段</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  回退到更早的阶段需要填写原因：它意味着之前记错了或客户反悔了，两者都要能追溯。
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <select
                    value={stage}
                    onChange={(event) => setStage(event.target.value as CustomerStage)}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
                  >
                    {CUSTOMER_STAGES.map((value) => (
                      <option key={value} value={value}>
                        {stageLabel(value)}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="回退原因（回退时必填）"
                    className="w-64"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || stage === customer.stage}
                    onClick={() =>
                      void apply(() =>
                        setCustomerStage(customer.id, {
                          stage,
                          reason: reason.trim() === '' ? undefined : reason.trim(),
                        }),
                      )
                    }
                  >
                    更新阶段
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">
                  订单（{customer.orders.length}）
                </p>
                {canOrder ? (
                  <NewOrderButton
                    customerId={customer.id}
                    busy={busy}
                    onCreated={(updated) => {
                      // 与 `apply` 一致：写接口回整条详情，直接替换，`at` 保持不动。
                      setLoaded((previous) => ({
                        ...previous,
                        id: customer.id,
                        customer: updated,
                        error: null,
                      }))
                      setStage(updated.stage)
                      onChanged()
                    }}
                    onError={setError}
                  />
                ) : null}
              </div>

              {customer.orders.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  还没有订单。合同额挂在订单上，录入订单后才能记金额。
                </p>
              ) : (
                customer.orders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    canEdit={canOrder}
                    busy={busy}
                    onToggleStep={(idx, patch) =>
                      void apply(() => updateCustomerStep(customer.id, order.id, idx, patch))
                    }
                  />
                ))
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{value}</dd>
    </div>
  )
}

function NewOrderButton({
  customerId,
  busy,
  onCreated,
  onError,
}: {
  customerId: string
  busy: boolean
  onCreated: (customer: CustomerDetailDto) => void
  onError: (message: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [contract, setContract] = useState('')

  const submit = async () => {
    let contractFen: number | undefined
    if (contract.trim() !== '') {
      const parsed = parseYuanToFen(contract)
      if (!parsed.ok) {
        onError(parsed.reason === 'too-large' ? '金额过大，请核对单位（元）' : '金额格式不正确')
        return
      }
      contractFen = parsed.fen
    }
    try {
      const updated = await createCustomerOrder(
        customerId,
        contractFen === undefined ? {} : { contractFen },
      )
      setOpen(false)
      setContract('')
      onError(null)
      onCreated(updated)
    } catch (caught) {
      onError(describeFailure(caught))
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        新建订单
      </Button>
      {open ? (
        <Dialog open onOpenChange={(next) => (next ? undefined : setOpen(false))}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>新建订单</DialogTitle>
              <DialogDescription>
                新增一单会铺好十四个环节，序号与订单编号由系统生成。
              </DialogDescription>
            </DialogHeader>
            <TextField
              id="new-order-contract"
              label="合同额（元，选填）"
              value={contract}
              onChange={setContract}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                取消
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={busy}>
                创建
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

function OrderCard({
  order,
  canEdit,
  busy,
  onToggleStep,
}: {
  order: CustomerOrderDto
  canEdit: boolean
  busy: boolean
  onToggleStep: (idx: number, patch: { done: boolean }) => void
}) {
  const progress = orderProgress(order.steps)
  const sections = splitStepSections(order.steps)

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{order.code}</span>
        <Badge variant="outline" className={`${toneClass(stageTone(order.stage))} border-0`}>
          {stageLabel(order.stage)}
        </Badge>
        {order.isRepeat ? (
          <Badge variant="secondary" className="text-[10px]">
            第 {order.seq} 单
          </Badge>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          完成 {progress.done}/{progress.total} 环（{progress.percent}%）
        </span>
      </div>

      {/* 进度条用宽度百分比表达，不用 <progress>：后者的外观由浏览器决定，
          亮暗两套令牌管不到它。 */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${progress.percent}%` }} />
      </div>

      {order.amounts === null ? (
        <p className="mt-2 text-xs text-muted-foreground">金额不可见（需要「查看客户金额」权限）</p>
      ) : (
        <p className="mt-2 text-sm text-foreground">
          合同 {formatFen(order.amounts.contractFen)} · 已收 {formatFen(order.amounts.receivedFen)}{' '}
          · 未收 {formatFen(order.amounts.unpaidFen)}
          {order.amountSource === null ? null : (
            <span className="ml-2 text-xs text-muted-foreground-weak">
              来源 {order.amountSource}
              {order.amountEvidenceDate === null ? '' : ` · ${order.amountEvidenceDate}`}
            </span>
          )}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {sections.map((section) => {
          const reachedInSection = section.steps.filter((step) => step.reached).length
          // 补件段若一环未动，直接折成一行说明。铺开三行空环节会让人以为漏填，
          // 而「这单没有补件」是正常状态。
          if (section.key === 'spare' && reachedInSection === 0) {
            return (
              <p key={section.key} className="text-xs text-muted-foreground-weak">
                {section.title}：未启用（无补件）
              </p>
            )
          }
          return (
            <div key={section.key}>
              <p className="text-xs text-muted-foreground">
                {section.title}
                <span className="ml-1 text-muted-foreground-weak">{section.hint}</span>
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {section.steps.map((step) => (
                  <li key={step.idx} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={step.done}
                      disabled={!canEdit || busy}
                      onCheckedChange={(checked) =>
                        onToggleStep(step.idx, { done: checked === true })
                      }
                      aria-label={`${step.name} 已完成`}
                    />
                    <span className={step.done ? 'text-foreground' : 'text-muted-foreground'}>
                      {step.idx}. {step.name}
                    </span>
                    {step.reached && !step.done ? (
                      <Badge variant="outline" className="text-[10px]">
                        已到达未完成
                      </Badge>
                    ) : null}
                    {step.finishedAt === null ? null : (
                      <span className="text-xs text-muted-foreground-weak">
                        {formatDate(step.finishedAt)}
                        {step.dateImprecise ? '（月份精度）' : ''}
                      </span>
                    )}
                    {step.note === null ? null : (
                      <span className="text-xs text-muted-foreground-weak">{step.note}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 把异常翻译成一句能给人看的话。
 *
 * `ApiError` 带着服务端的中文 `message`（例如「回退到更早的阶段必须填写原因」），
 * 直接用它；其余异常一律给一句概括。**不透传 `error.message`** —— 那是英文的
 * 运行时错误，对使用者没有意义。
 */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '请求失败，请稍后重试'
}
