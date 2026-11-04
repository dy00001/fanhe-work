import {
  CUSTOMER_STAGES,
  NAV_CODES,
  PERMISSIONS,
  computeOrderSettlement,
  navPath,
  summarizeOrderAmounts,
  type AssignableUserDto,
  type CustomerAssignmentDto,
  type CustomerDetailDto,
  type CustomerListItemDto,
  type CustomerListResponse,
  type CustomerOrderDto,
  type CustomerOwnerDto,
  type CustomerStage,
  type NavItem,
  type RegionScope,
  type UpdateOrderAmountsRequest,
} from '@fanhe/shared'
import { UsersRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { useAuth } from '../auth/useAuth'
import { ModuleHeader } from '../components/ModuleHeader'
import { EmptyState, ErrorState, LoadingState } from '../components/StateView'
import { TextField } from '../components/TextField'
import { CustomerActivityLine } from '../components/customer/CustomerActivityLine'
import { CustomerDonut, type DonutSlice } from '../components/customer/CustomerDonut'
import { CustomerFilterBar } from '../components/customer/CustomerFilterBar'
import { CustomerKpiCards } from '../components/customer/CustomerKpiCards'
import { CustomerPoolDialog } from '../components/customer/CustomerPoolDialog'
import { CustomerTable } from '../components/customer/CustomerTable'
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
import { ApiError } from '../lib/api'
import {
  EDITABLE_AMOUNT_FIELDS,
  ORDER_AMOUNT_FIELDS,
  activityOf,
  assignmentParts,
  fillStageBuckets,
  formatDate,
  formatDateTime,
  formatFen,
  formatWan,
  isAmountAnomaly,
  orderProgress,
  parseYuanToFen,
  scopeLabel,
  splitStepSections,
  stageLabel,
  stageTone,
  toneClass,
  type OrderAmountFieldKey,
  type StageTone,
} from '../lib/customer-display'
import {
  filtersFromParams,
  filtersKey,
  filtersToParams,
  hourRange,
  overlapsActivity,
  rangeQuery,
  resolveCustomerRange,
  type CustomerFilters,
} from '../lib/customer-filters'
import {
  assignCustomer,
  createCustomer,
  createCustomerOrder,
  deleteCustomer,
  deleteCustomerOrder,
  loadAssignableUsers,
  loadCustomer,
  loadCustomers,
  setCustomerStage,
  updateCustomerOrderAmounts,
  updateCustomerStep,
} from '../lib/customers'
import { useNow } from '../lib/use-now'

/**
 * 客户信息平台的页面。
 *
 * 两个导航入口共用这一个组件，由 `item.code` 决定视角（与运营看板七项共用
 * `OpsDashboardPage` 是同一条做法）：
 *
 *   - 综合看板：指标卡 + 阶段环形 + 金额环形 + 近 24 小时折线，回答「这批客户
 *     是什么结构、钱压在哪个地区」；
 *   - 客户进度：客户清单，回答「这一单做到哪了」。
 *
 * **清单从看板搬到了进度页。** 一屏里同时放四张卡、两张环、一条折线和一个二十行的
 * 表格，图表会被挤到需要滚动才能看全，表格又因为上面压着图只剩半屏。两栏共用同一
 * 份数据与同一套筛选，所以「在看板点某个阶段的扇区，跳过去看到的正是那个阶段的人」
 * 是构造上成立的。
 *
 * **筛选状态整份存在地址栏。** 两栏各存一份的话，从看板跳到进度页时筛选会丢，
 * 而丢掉之后列表显示的是一批与刚才那张图不对应的客户，界面上没有任何提示。
 *
 * **金额可见性由服务端决定，界面不做二次判断。** 响应里的 `financeReadable` 与
 * `summary.amountTotalFen` 是唯一依据：它们同时覆盖「有没有权限」与「服务端是否
 * 已经裁掉」。前端再按角色算一遍，等于把授权规则复制到第二个地方，而两处不一致时
 * 的表现是「金额列空着但没报错」。
 */
export function CustomerPage({ item }: { item: NavItem }) {
  const { can } = useAuth()
  const canWrite = can(PERMISSIONS.CUSTOMER_RECORD_WRITE)
  /*
   * 删除客户要两个权限点，与服务端的两道守卫一一对应。只判写权限的话，设计师会
   * 看到一个点下去必然 400/403 的按钮 —— 那比没有按钮更糟，因为它看起来像功能坏了。
   */
  const canDeleteCustomer = canWrite && can(PERMISSIONS.CUSTOMER_SCOPE_WRITE)
  const isProgress = item.code === NAV_CODES.CUSTOMER_PROGRESS

  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  // 每分钟推进的「现在」：区间文案（本月、本季）与自定义区间的初始日期都要用它，
  // 而渲染里不许调 `Date.now()`。
  const now = useNow()
  const filters = filtersFromParams(params, now)

  const [refreshToken, setRefreshToken] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [poolOpen, setPoolOpen] = useState(false)

  /**
   * 归属下拉的成员档，保留最后一次非空结果。
   *
   * 加载中的那一帧 `data` 是 null，直接渲染 `data?.owners ?? []` 会让下拉先收缩
   * 再展开；而「选项自己变少了」在使用者眼里就是数据出了问题。
   */
  const [owners, setOwners] = useState<CustomerOwnerDto[]>([])

  /*
   * 公共池归类要同时有「复核」与「转派」两个权限点。只判前者的话，点进去会看到
   * 一屏建议却点不动（服务的复核接口两个点都要），那种界面比没有入口更糟。
   */
  const canReviewPool =
    can(PERMISSIONS.CUSTOMER_IMPORT_REVIEW) && can(PERMISSIONS.CUSTOMER_SCOPE_WRITE)

  const mode = isProgress ? 'list' : 'summary'
  const { scope, stage, q, pendingReview, owner } = filters
  // 请求参数走 `rangeQuery` 而不是 `toISOString()`：后者是完整 ISO，接口的 pattern
  // 直接拒收，且末尾的 Z 是 UTC，东八区会整体错一天。取成两个字符串而不是每次现
  // 构造对象，是因为它们要进 effect 的依赖列表，对象引用每次都新，会让请求白跑。
  const { from: fromParam, to: toParam } = rangeQuery(filters.range)

  /**
   * 加载结果带着「它是哪一次请求的」。
   *
   * **不在 effect 体里同步 `setState({ status: 'loading' })`。** 那样每改一次筛选
   * 都会多一轮渲染（先把状态切成加载中，再切回来），而 React 的 lint 规则直接把它
   * 判成缺陷。这里的做法是让结果自己记住 key：当前请求的 key 与结果里的 key 不相等，
   * 就是「还没回来」，加载态由比较得出而不是被写进去。
   */
  const requestKey = [filtersKey(filters), mode, String(refreshToken)].join('\u0000')

  const [result, setResult] = useState<{
    key: string
    data: CustomerListResponse | null
    error: string | null
    /**
     * 数据到达的那一刻。活跃度（「3 天前有消息」）要用它当基准。
     * 取一次跟着数据走，不在渲染里逐行取「现在」。
     */
    at: number
  }>({ key: '', data: null, error: null, at: 0 })

  useEffect(() => {
    let cancelled = false
    loadCustomers({
      q,
      scope,
      stage,
      pendingReview,
      owner,
      ...(fromParam === '' ? {} : { from: fromParam }),
      ...(toParam === '' ? {} : { to: toParam }),
      mode,
    })
      .then((data) => {
        if (cancelled) return
        setResult({ key: requestKey, data, error: null, at: Date.now() })
        // 只在拿到非空名单时覆盖：空数组是「这批人恰好都没归属」，不是「公司没人」。
        if (data.owners.length > 0) setOwners(data.owners)
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
  }, [requestKey, q, scope, stage, pendingReview, owner, fromParam, toParam, mode])

  const loading = result.key !== requestKey
  const data = loading ? null : result.data
  const failure = loading ? null : result.error

  const reload = () => setRefreshToken((value) => value + 1)

  /** 栏内改筛选：只改地址，地址变了数据自然重取。 */
  const applyFilters = (next: CustomerFilters) => {
    setParams(filtersToParams(next), { replace: true })
  }

  /**
   * 图表下钻：带着当前筛选跳到客户进度。
   *
   * 用 `push` 而不是 `replace`：这是一次跨栏目的跳转，返回键应当能回到刚才那张图。
   */
  const jumpToProgress = (patch: Partial<CustomerFilters>) => {
    const search = filtersToParams({ ...filters, ...patch }).toString()
    const target = navPath(NAV_CODES.CUSTOMER_PROGRESS)
    navigate(search === '' ? target : `${target}?${search}`)
  }

  return (
    <div className="flex flex-col gap-5">
      <ModuleHeader item={item} />

      <CustomerFilterBar filters={filters} onChange={applyFilters} now={now} owners={owners} />

      {/*
        范围提示必须存在。列表被静默缩小之后，用户的第一反应是「数据丢了」——
        这个提示把「看不到别人的客户」与「客户真的没了」区分开。
      */}
      {data !== null && data.scopeKind === 'own' ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          当前只显示你负责的 {data.total} 位客户（作为设计师或销售）。需要跟进其他客户，
          请联系管理员在「客户进度」的归属里转派给你。
        </p>
      ) : null}

      {loading ? <LoadingState variant="plain" label="正在加载客户…" /> : null}

      {failure === null ? null : (
        <ErrorState variant="plain" description={failure} onRetry={reload} />
      )}

      {data !== null && !isProgress ? (
        <Overview
          data={data}
          rangeLabel={filters.range.label}
          hasRange={filters.range.key !== 'all'}
          activityConflict={
            overlapsActivity(filters.range, now)
              ? null
              : `当前时间筛选（${filters.range.label}）与最近 24 小时没有交集`
          }
          onSelectStage={(value) => jumpToProgress({ stage: value })}
          onSelectScope={(value) => jumpToProgress({ scope: value })}
          onSelectHour={(hourStart) => {
            const range = hourRange(hourStart)
            if (range !== null) jumpToProgress({ range })
          }}
          onFocusToday={() => {
            jumpToProgress({
              range: resolveCustomerRange({ preset: 'day', from: null, to: null }, now),
            })
          }}
        />
      ) : null}

      {data !== null && isProgress ? (
        <section className="rounded-xl border border-border bg-card">
          {data.items.length === 0 ? (
            <EmptyState
              icon={UsersRound}
              variant="plain"
              title="没有符合条件的客户"
              description="换个筛选条件，或者先把客户录进来。"
            />
          ) : (
            <CustomerTable
              items={data.items}
              financeReadable={data.financeReadable}
              nowMs={result.at}
              onSelect={setSelectedId}
            />
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2">
            <p className="text-xs text-muted-foreground">
              共 {data.total} 位客户
              {data.items.length < data.total ? `，当前显示最近活跃的 ${data.items.length} 位` : ''}
            </p>
            <div className="ml-auto flex items-center gap-2">
              {canReviewPool ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setPoolOpen(true)}>
                  公共池归类
                </Button>
              ) : null}
              {canDeleteCustomer ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setDeleting(true)}>
                  删除客户
                </Button>
              ) : null}
              {canWrite ? (
                <Button type="button" size="sm" onClick={() => setCreating(true)}>
                  录入客户
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {selectedId === null ? null : (
        <CustomerDetailDialog
          customerId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}

      {poolOpen ? (
        <CustomerPoolDialog onClose={() => setPoolOpen(false)} onChanged={reload} />
      ) : null}

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

      {deleting ? (
        <DeleteCustomerDialog
          onClose={() => setDeleting(false)}
          onDeleted={(deleted) => {
            setDeleting(false)
            // 正在看的那位被删掉时把详情一起关掉：留着它会立刻请求一个 404。
            if (selectedId === deleted.id) setSelectedId(null)
            reload()
          }}
        />
      ) : null}
    </div>
  )
}

/** 地区层级到色调。三个层级用三种可分辨的颜色，与阶段环的五档色共用一套令牌。 */
const SCOPE_TONE: Record<RegionScope, StageTone> = {
  domestic: 'progress',
  overseas: 'done',
  'special-region': 'warn',
}

/**
 * 综合看板主体。
 *
 * 四块内容全部来自同一次响应：`summary` 里的阶段分布、金额分布、24 小时活跃度，
 * 加上 `total`。**没有一个数字是前端自己算的**（除了把比例折成弧长），因此四块
 * 内容与客户进度页的清单永远对得上。
 */
function Overview(props: {
  data: CustomerListResponse
  rangeLabel: string
  hasRange: boolean
  activityConflict: string | null
  onSelectStage: (stage: CustomerStage) => void
  onSelectScope: (scope: string) => void
  onSelectHour: (hourStart: string) => void
  onFocusToday: () => void
}) {
  const { data } = props
  // 补齐零值并按主线顺序排，再丢掉零档：环上不画零宽的弧，图例也不必列出 14 行空档。
  const stageSlices: DonutSlice[] = fillStageBuckets(data.summary.byStage, CUSTOMER_STAGES)
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => ({
      key: bucket.stage,
      label: stageLabel(bucket.stage),
      value: bucket.count,
      tone: stageTone(bucket.stage),
    }))

  const amountByScope = data.summary.amountByScope
  const scopeOrder: RegionScope[] = ['domestic', 'overseas', 'special-region']
  const amountSlices: DonutSlice[] =
    amountByScope === null
      ? []
      : scopeOrder.map((key) => ({
          key,
          label: scopeLabel(key),
          value: amountByScope[key],
          tone: SCOPE_TONE[key],
        }))

  const amountTotal = data.summary.amountTotalFen

  return (
    <div className="flex flex-col gap-4">
      <CustomerKpiCards
        summary={data.summary}
        total={data.total}
        rangeLabel={props.rangeLabel}
        hasRange={props.hasRange}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <CustomerDonut
          title="阶段分布"
          note="按客户数，点击扇区看对应客户"
          slices={stageSlices}
          centerValue={String(data.total)}
          centerLabel="位客户"
          formatValue={(value) => `${value} 位`}
          emptyText="当前筛选下没有客户"
          onSelect={(key) => {
            props.onSelectStage(key as CustomerStage)
          }}
        />

        <CustomerDonut
          title="合同额分布"
          note={
            amountTotal === null ? '需要「查看客户金额」权限' : '按地区层级，点击扇区看对应客户'
          }
          slices={amountSlices}
          centerValue={amountTotal === null ? '无权限' : formatWan(amountTotal)}
          centerLabel={amountTotal === null ? '查看金额需要授权' : '合同额合计'}
          formatValue={(value) => formatWan(value)}
          emptyText={amountTotal === null ? '当前账号看不到金额' : '当前筛选下的客户还没有合同额'}
          onSelect={props.onSelectScope}
        />
      </div>

      <CustomerActivityLine
        points={data.summary.activity}
        conflictNote={props.activityConflict}
        onSelectHour={props.onSelectHour}
        onFocusToday={props.onFocusToday}
      />
    </div>
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
      setError('地区不能为空：显示名由地区加称呼组成，缺了就分辨不出重名客户')
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
 * 删除客户。
 *
 * **选择与确认分成两步。** 点一下行就删，和「点了行、看清是谁、再按确认」是两种
 * 完全不同的风险：客户档案是硬删除，订单、十四环节、归类记录一起消失，事后只能
 * 从审计里知道删了谁，找不回来。
 *
 * 名单自己查，不复用页面上的列表：页面列表带着当前筛选，想删的那个人可能正好被
 * 筛掉；而「看不到就删不了」会被理解成功能坏了。
 */
function DeleteCustomerDialog({
  onClose,
  onDeleted,
}: {
  onClose: () => void
  onDeleted: (deleted: { id: string; displayName: string }) => void
}) {
  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<CustomerListItemDto[] | null>(null)
  const [selected, setSelected] = useState<CustomerListItemDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    /*
     * 输入即查，250 毫秒防抖。每敲一个字符发一次请求既没有必要，也会让结果列表在
     * 打字过程中反复重排 —— 而「正在变的那一屏」最容易点错人。
     */
    const timer = setTimeout(() => {
      loadCustomers({
        ...(keyword.trim() === '' ? {} : { q: keyword.trim() }),
        mode: 'list',
        limit: 20,
      })
        .then((data) => {
          if (cancelled) return
          setRows(data.items)
          setError(null)
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(describeFailure(caught))
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [keyword])

  const submit = async () => {
    if (selected === null) return
    setBusy(true)
    setError(null)
    try {
      onDeleted(await deleteCustomer(selected.id))
    } catch (caught) {
      setError(describeFailure(caught))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>删除客户</DialogTitle>
          <DialogDescription>
            删除会连同这位客户的订单、十四环节进度与归类记录一起清掉，无法恢复。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="delete-customer-search" className="text-xs text-muted-foreground">
            搜索客户
          </label>
          <Input
            id="delete-customer-search"
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value)
              // 结果会被新关键词替换，之前选中的那一行可能已经不在列表里了。
              setSelected(null)
            }}
            placeholder="姓名、昵称或显示名"
          />
        </div>

        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          {rows === null ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">正在加载…</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              没有匹配的客户（只能删除你权限范围内的客户）
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => {
                const active = selected?.id === row.id
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(row)}
                      className={
                        active
                          ? 'flex w-full items-center gap-3 bg-destructive/10 px-3 py-2 text-left'
                          : 'flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/60'
                      }
                    >
                      <span className="font-medium text-foreground">{row.displayName}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.region} · {row.orderCount} 单
                      </span>
                      {active ? (
                        <span className="ml-auto text-xs text-destructive">已选中</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {selected === null ? null : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm text-foreground">
              将删除「{selected.displayName}」及其 {selected.orderCount}{' '}
              张订单、全部环节进度与归类记录。
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              这一步不可恢复。审计日志会留下「谁在什么时候删了谁」，但不保留档案内容。
            </p>
          </div>
        )}

        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void submit()}
            disabled={busy || selected === null}
          >
            {busy ? '删除中…' : selected === null ? '先选择客户' : '确认删除'}
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
  const canAssign = can(PERMISSIONS.CUSTOMER_SCOPE_WRITE)
  /**
   * 金额编辑的门槛 = 看得到金额 + 有订单写权限。
   *
   * 服务端还会再判一次（没有 `customer.finance.read` 直接 `field_not_allowed`）。
   * 这里判是为了不显示一个点下去必然失败的按钮，不是为了替代服务端。
   */
  const canFinance = can(PERMISSIONS.CUSTOMER_FINANCE_READ) && canOrder

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

  /** 只替换详情里的错误，不动已加载的数据：改一步失败时整页不该退回空白。 */
  const setError = (message: string | null) =>
    setLoaded((previous) => ({ ...previous, error: message }))

  /**
   * 执行一次写操作并同步结果。
   *
   * 写接口回的都是**整条客户详情**，所以这里直接替换，不猜「改完之后应该长什么样」。
   * 同时通知外层刷新列表：阶段与合同额在列表行上也有一份，不同步会让两处对不上。
   *
   * 返回是否成功。金额更正与删除订单的编辑区要**在成功之后**才收起 —— 失败时收起
   * 表单等于把刚填的五个数字一起丢掉，而错误提示还在上面，用户得从头再填一遍。
   */
  const apply = async (action: () => Promise<CustomerDetailDto>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const updated = await action()
      // 保留 `at`：这次改的是阶段或环节，`lastMessageAt` 没动，活跃度的基准不该跳。
      setLoaded((previous) => ({ ...previous, id: customerId, customer: updated, error: null }))
      setStage(updated.stage)
      onChanged()
      return true
    } catch (caught) {
      setError(describeFailure(caught))
      return false
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

            {/*
              负责团队。两栏同时展示，这是需求第 1 条「双向可查」的落点：
              设计师打开时能看到销售是谁，销售打开时能看到设计师是谁，管理员两栏都看。
            */}
            <div className="rounded-xl border border-border p-4">
              <p className="text-sm font-medium text-foreground">负责团队</p>
              <AssignmentBadges assignment={customer.assignment} />
              {canAssign ? (
                <AssignmentEditor
                  customerId={customer.id}
                  current={customer.assignment}
                  onSaved={(updated) => {
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
                <>
                  <OrderAmountTotals orders={customer.orders} />
                  {customer.orders.map((order) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      canEdit={canOrder}
                      canEditFinance={canFinance}
                      busy={busy}
                      onToggleStep={(idx, patch) =>
                        void apply(() => updateCustomerStep(customer.id, order.id, idx, patch))
                      }
                      onSaveAmounts={(patch) =>
                        apply(() => updateCustomerOrderAmounts(customer.id, order.id, patch))
                      }
                      onDelete={() => apply(() => deleteCustomerOrder(customer.id, order.id))}
                    />
                  ))}
                </>
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

/** 金额输入框的空草稿。七个键都留空，等于「七项都未录入」。 */
const EMPTY_AMOUNT_DRAFT: Record<OrderAmountFieldKey, string> = {
  deposit: '',
  prepay: '',
  finalReceived: '',
  unpaid: '',
  fee: '',
  contract: '',
  received: '',
}

/**
 * 分 → 输入框里的元。
 *
 * 不用 `formatFen`：那个带「元」字与千分位，粘回输入框会解析失败。这里保留两位
 * 有效小数，去掉无意义的尾零（16800000 分显示成 `168000`，不是 `168000.00`）。
 */
function fenToInput(fen: number | null): string {
  if (fen === null) return ''
  const text = (fen / 100).toFixed(2)
  if (text.endsWith('.00')) return text.slice(0, -3)
  return text.replace(/0$/, '')
}

/**
 * 输入框文本 → 分。空串是 `null`（未录入），格式错时 `ok: false`。
 *
 * 返回值统一带 `fen` 字段（失败时为 null），这样调用处取 `.fen` 不必先做类型收窄 ——
 * 七个框逐个收窄会把渲染函数写成一串 if。
 */
function parseAmountInput(text: string): { ok: boolean; fen: number | null } {
  if (text.trim() === '') return { ok: true, fen: null }
  const parsed = parseYuanToFen(text)
  return parsed.ok ? { ok: true, fen: parsed.fen } : { ok: false, fen: null }
}

/**
 * 客户级订单金额合计。
 *
 * **一单时不出现**：那张订单卡片上的七格就是它自己的合计，再列一遍只是把同样的
 * 数字印两次。两单起才有「合计」这件事可看。
 *
 * 七个格子复用 `ORDER_AMOUNT_FIELDS`，与每张订单卡同序同标签。这里另起一份字段
 * 表的话，某天改了一处标签而另一处没跟上，用户会以为合计行的「实收金额」和明细
 * 里的「实收金额」不是同一个东西。
 */
function OrderAmountTotals({ orders }: { orders: readonly CustomerOrderDto[] }) {
  // 全部订单的金额都不可见时，这块没有任何能显示的数，整块不渲染。
  const summary = summarizeOrderAmounts(orders.map((order) => order.amounts))
  if (orders.length < 2 || summary.orderCount === 0) return null

  const hints: string[] = []
  if (summary.hiddenCount > 0) {
    hints.push(`另有 ${summary.hiddenCount} 单金额不可见，未计入合计`)
  }
  if (summary.missingContractCount > 0) {
    hints.push(`${summary.missingContractCount} 单未录合同，其未收尾款未计入`)
  }

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm font-medium text-foreground">{summary.orderCount} 单合计</p>
        <span className="text-xs text-muted-foreground">逐单相加，不做跨单冲抵</span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {ORDER_AMOUNT_FIELDS.map((field) => {
          const value = summary.amounts[field.field]
          return (
            <div key={field.key} className="rounded-lg bg-background/70 px-2.5 py-1.5">
              <p className="text-[11px] text-muted-foreground">
                {field.label}
                {field.editable ? null : (
                  <span className="ml-1 text-[10px] text-muted-foreground-weak">自动</span>
                )}
              </p>
              <p
                className={
                  isAmountAnomaly(field, value)
                    ? 'text-sm font-medium text-destructive tabular-nums'
                    : 'text-sm font-medium text-foreground tabular-nums'
                }
              >
                {formatFen(value)}
              </p>
            </div>
          )
        })}
      </div>

      {/* 缺的数要说出来。总和里少了一单却显示得像个完整的总数，比不显示更危险。 */}
      {hints.length === 0 ? null : (
        <p className="mt-2 text-xs text-muted-foreground-weak">{hints.join('；')}</p>
      )}
    </div>
  )
}

function OrderCard({
  order,
  canEdit,
  canEditFinance,
  busy,
  onToggleStep,
  onSaveAmounts,
  onDelete,
}: {
  order: CustomerOrderDto
  canEdit: boolean
  canEditFinance: boolean
  busy: boolean
  onToggleStep: (idx: number, patch: { done: boolean }) => void
  onSaveAmounts: (patch: UpdateOrderAmountsRequest) => Promise<boolean>
  onDelete: () => Promise<boolean>
}) {
  const progress = orderProgress(order.steps)
  const sections = splitStepSections(order.steps)

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<OrderAmountFieldKey, string>>(EMPTY_AMOUNT_DRAFT)
  const [formError, setFormError] = useState<string | null>(null)

  const openEditor = () => {
    setDraft(
      order.amounts === null
        ? EMPTY_AMOUNT_DRAFT
        : {
            deposit: fenToInput(order.amounts.depositFen),
            prepay: fenToInput(order.amounts.prepayFen),
            finalReceived: fenToInput(order.amounts.finalReceivedFen),
            unpaid: fenToInput(order.amounts.unpaidFen),
            fee: fenToInput(order.amounts.feeFen),
            contract: fenToInput(order.amounts.contractFen),
            received: fenToInput(order.amounts.receivedFen),
          },
    )
    setFormError(null)
    setEditing(true)
  }

  /*
   * 输入过程中的即时预览。
   *
   * 用的是**与服务端同一个契约函数** `computeOrderSettlement`，不是这里另写一份
   * 减法。另写一份的结果是「编辑时预览 12 万，保存后变成 11.8 万」，而两次数字
   * 都长得对，没人能说出差在哪。
   */
  const parse = parseAmountInput

  const draftNumbers = {
    contract: parse(draft.contract),
    deposit: parse(draft.deposit),
    prepay: parse(draft.prepay),
    finalReceived: parse(draft.finalReceived),
    fee: parse(draft.fee),
  }
  const draftOk = Object.values(draftNumbers).every((parsed) => parsed.ok)
  const preview = draftOk
    ? computeOrderSettlement({
        contractFen: draftNumbers.contract.fen,
        depositFen: draftNumbers.deposit.fen,
        prepayFen: draftNumbers.prepay.fen,
        finalReceivedFen: draftNumbers.finalReceived.fen,
        feeFen: draftNumbers.fee.fen,
      })
    : null

  const save = async () => {
    if (!draftOk) {
      setFormError('金额格式不正确：只能填数字，最多两位小数')
      return
    }
    if (draftNumbers.contract.fen !== null && draftNumbers.contract.fen > 10_000_000_000) {
      setFormError('合同总金额过大，请核对单位（元）')
      return
    }
    const patch: UpdateOrderAmountsRequest = {
      contractFen: draftNumbers.contract.fen,
      depositFen: draftNumbers.deposit.fen,
      prepayFen: draftNumbers.prepay.fen,
      finalReceivedFen: draftNumbers.finalReceived.fen,
      feeFen: draftNumbers.fee.fen,
    }
    if (await onSaveAmounts(patch)) {
      setEditing(false)
      setFormError(null)
    }
  }

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
        {canEdit ? (
          confirmingDelete ? (
            <span className="flex items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={busy}
                onClick={() => void onDelete().then((ok) => setConfirmingDelete(!ok))}
              >
                确认删除
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                取消
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setConfirmingDelete(true)}
            >
              删除订单
            </Button>
          )
        ) : null}
      </div>

      {confirmingDelete ? (
        <p className="mt-2 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
          确认删除 {order.code} 后，这一单的十四环节进度与金额一并消失，客户级合同额汇总会重算。
          这一步不可恢复。
        </p>
      ) : null}

      {/* 进度条用宽度百分比表达，不用 <progress>：后者的外观由浏览器决定，
          亮暗两套令牌管不到它。 */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${progress.percent}%` }} />
      </div>

      {order.amounts === null ? (
        <p className="mt-2 text-xs text-muted-foreground">金额不可见（需要「查看客户金额」权限）</p>
      ) : (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ORDER_AMOUNT_FIELDS.map((field) => {
              const value = order.amounts?.[field.field] ?? null
              return (
                <div key={field.key} className="rounded-lg bg-muted/40 px-2.5 py-1.5">
                  <p className="text-[11px] text-muted-foreground">
                    {field.label}
                    {field.editable ? null : (
                      <span className="ml-1 text-[10px] text-muted-foreground-weak">自动</span>
                    )}
                  </p>
                  <p
                    className={
                      isAmountAnomaly(field, value)
                        ? 'text-sm font-medium text-destructive tabular-nums'
                        : 'text-sm font-medium text-foreground tabular-nums'
                    }
                  >
                    {formatFen(value)}
                  </p>
                  {field.formula === undefined ? null : (
                    <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground-weak">
                      {field.formula}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canEditFinance && !editing ? (
              <Button type="button" size="xs" variant="outline" onClick={openEditor}>
                更正金额
              </Button>
            ) : null}
            {order.amountSource === null ? null : (
              <span className="text-xs text-muted-foreground-weak">
                来源 {order.amountSource}
                {order.amountEvidenceDate === null ? '' : ` · ${order.amountEvidenceDate}`}
              </span>
            )}
          </div>
        </div>
      )}

      {editing ? (
        <div className="mt-3 rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">
            金额单位是元。留空表示「还没录」，与填 0
            是两件事。未收尾款与实收金额由公式算出，不用手填。
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {EDITABLE_AMOUNT_FIELDS.map((field) => (
              <label key={field.key} className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">{field.label}（元）</span>
                <Input
                  value={draft[field.key]}
                  inputMode="decimal"
                  placeholder="未录入"
                  onChange={(event) => {
                    setFormError(null)
                    setDraft((previous) => ({ ...previous, [field.key]: event.target.value }))
                  }}
                />
              </label>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              未收尾款{' '}
              <span className="font-medium text-foreground tabular-nums">
                {preview === null ? '待填完' : formatFen(preview.unpaidFen)}
              </span>
            </span>
            <span className="text-muted-foreground">
              实收金额{' '}
              <span className="font-medium text-foreground tabular-nums">
                {preview === null ? '待填完' : formatFen(preview.receivedFen)}
              </span>
            </span>
          </div>

          {formError === null ? null : <p className="mt-2 text-sm text-destructive">{formError}</p>}

          <div className="mt-3 flex items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存并重算'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}

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
 * 直接用它；其余异常一律给一句概括。**不透传 `error.message`**：那是英文的
 * 运行时错误，对使用者没有意义。
 */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '请求失败，请稍后重试'
}

/**
 * 两栏归属的展示。
 *
 * 公共池用一句灰字说明，而不是留空：空白的含义在界面上是「没数据」，
 * 而它实际是「待认领」——一个需要人动手的状态。
 */
function AssignmentBadges({ assignment }: { assignment: CustomerAssignmentDto }) {
  const parts = assignmentParts(assignment)
  if (parts.length === 0) {
    return <p className="mt-1 text-sm text-muted-foreground">公共池（还没有负责人）</p>
  }
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {parts.map((part) => (
        <Badge key={part.role} variant="outline" className="text-xs font-normal">
          {part.roleLabel} · {part.name}
          {part.mine ? '（我）' : ''}
        </Badge>
      ))}
    </div>
  )
}

/**
 * 调整归属。
 *
 * 两个下拉而不是一个「负责人」下拉：一栏是人，一个人可能同时是某位客户的设计师
 * 与另一位客户的销售，把两栏合成一个下拉会让「这位客户的销售是谁」无法表达。
 *
 * 账号名单从 `/api/customers/assignable-users` 取，不读系统账号接口 —— 后者要
 * `system.user.read`，而业务角色没有这个点。
 */
function AssignmentEditor({
  customerId,
  current,
  onSaved,
  onError,
}: {
  customerId: string
  current: CustomerAssignmentDto
  onSaved: (customer: CustomerDetailDto) => void
  onError: (message: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [users, setUsers] = useState<AssignableUserDto[] | null>(null)
  const [designerId, setDesignerId] = useState(current.designerId ?? '')
  const [salesId, setSalesId] = useState(current.salesId ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  /*
   * 名单在展开时才取。详情对话框多半只是看一眼，每次打开都拉一份账号列表
   * 是白花一次往返；而放到页面加载时取，则会把「看客户」这个动作与「能转派」
   * 绑在一起 —— 没有转派权的人也会发这个请求（服务端会 403）。
   */
  useEffect(() => {
    if (!open || users !== null) return
    let cancelled = false
    loadAssignableUsers()
      .then((list) => {
        if (!cancelled) setUsers(list)
      })
      .catch((caught: unknown) => {
        if (!cancelled) onError(describeFailure(caught))
      })
    return () => {
      cancelled = true
    }
  }, [open, users, onError])

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={() => setOpen(true)}
      >
        调整归属
      </Button>
    )
  }

  const submit = async () => {
    setBusy(true)
    onError(null)
    try {
      const updated = await assignCustomer(customerId, {
        designerId: designerId === '' ? null : designerId,
        salesId: salesId === '' ? null : salesId,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      })
      setOpen(false)
      setReason('')
      onSaved(updated)
    } catch (caught) {
      onError(describeFailure(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-muted/40 p-2">
      <label className="text-xs text-muted-foreground">
        设计师
        <select
          value={designerId}
          onChange={(event) => setDesignerId(event.target.value)}
          className="mt-1 block h-8 min-w-40 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
        >
          <option value="">未指定</option>
          {(users ?? [])
            .filter((user) => user.role === 'designer')
            .map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName}
              </option>
            ))}
        </select>
      </label>
      <label className="text-xs text-muted-foreground">
        销售
        <select
          value={salesId}
          onChange={(event) => setSalesId(event.target.value)}
          className="mt-1 block h-8 min-w-40 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
        >
          <option value="">未指定</option>
          {(users ?? [])
            .filter((user) => user.role === 'sales')
            .map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName}
              </option>
            ))}
        </select>
      </label>
      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="调整原因（必填）"
        className="h-8 w-56"
      />
      <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>
        {busy ? '保存中…' : '保存归属'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setOpen(false)}
      >
        取消
      </Button>
    </div>
  )
}
