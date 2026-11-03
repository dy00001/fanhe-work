import {
  PERMISSIONS,
  QUOTE_LIMITS,
  type QuoteAccessStateResponse,
  type QuoteItemDto,
  type QuoteItemResponse,
  type QuoteMetaResponse,
  type QuoteSource,
} from '@fanhe/shared'
import { Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import {
  loadQuoteAccessState,
  loadQuoteImageUrl,
  loadQuoteItem,
  loadQuoteMeta,
  releaseQuoteImages,
  searchQuotes,
} from '../../lib/quote'
import { ErrorState, LoadingState } from '../StateView'

import { PriceGateDialog } from './PriceGateDialog'
import { QuoteDetail } from './QuoteDetail'
import { QuoteFilters } from './QuoteFilters'
import { QuoteLightbox } from './QuoteLightbox'
import { QuoteMaintPanel } from './QuoteMaintPanel'
import { QuoteResultTable } from './QuoteResultTable'

/**
 * 报价查价面板。**结构一比一照静态稿 `.panel`（第 625–658 行）。**
 *
 * 头部：标题 + 副标题 + 320px 搜索框 + 「价格维护」+「关闭」；主体三栏
 * （212 筛选 / 结果表 / 326 详情）；页脚一行统计 + 数据版本。
 *
 * 首页那张模块卡与 `/workbench/quote` 共用这一个组件：卡里是弹窗、页面里是整页。
 * 分两套实现的话，「搜索结果的高亮」「同名多行怎么区分」「改价之后哪一块要刷新」
 * 这些规则会各写一遍，然后在某次改动里漂开。
 *
 * ## 为什么把筛选从工具栏搬回左栏
 *
 * 上一版为了窄屏把来源做成顶部标签、把分类做成下拉，两处入口同一件事。静态稿是
 * 左栏一组、永远可见 —— 台账有一千两百多条，筛选不是「高级选项」，是主路径的一部分。
 *
 * ## 价格永远按形态显示
 *
 * `describePrice` 是唯一入口（在 `lib/quote-display.ts`，纯函数、有单测）。这里不写
 * 任何 `¥${fen/100}` —— 那正是把「1.5 倍」渲染成 `¥1.5` 的写法。
 *
 * ## 改价之后刷新什么
 *
 * 服务端返回新的 `version` 与**落库后的整条记录**，界面照着替换那一行即可；列表
 * 用 `reloadToken` 重查一次。**不做本地推算**：多设备并发时「我改完之后应该是什么
 * 样」猜不准，而猜错的后果是界面上显示一个库里不存在的价格。
 *
 * ## 加载态是推导出来的，不是写进去的
 *
 * 列表与详情都只保存「带请求指纹的结果」，渲染时判断指纹是否等于当前请求：不相等
 * 就是加载中。这是本仓库既有的做法（见 `lib/use-ops-dashboard.ts` 顶部）。在 effect
 * 开头 `setLoading(true)` 会撞 `react-hooks/set-state-in-effect`，而且那版有真的
 * 问题 —— effect 在提交之后才跑，会多一次级联渲染，列表在切换筛选时闪一下。
 *
 * 筛选变化时回到首页那条也**不在 effect 里写**：它写在两个筛选控件的回调里
 * （{@link applySource} 等）。写在 effect 里的话，请求会先按旧条件发一次、
 * 再被清零发第二次。
 *
 * ## 一次取满一页，没有翻页器
 *
 * 静态稿的 `LIMIT = 200`、超出时页脚写「请输入更精确的关键字」。这里照同一形态，
 * 上限直接用接口的 {@link QUOTE_LIMITS.PAGE_SIZE_MAX}（同为 200）—— 翻页器是参考页里
 * 没有的控件，自己加一个就不叫一比一了。
 */
const LIMIT = QUOTE_LIMITS.PAGE_SIZE_MAX

/** 空结果的稳定引用。每次渲染新建 `[]` 会让下游的 memo 全部失效。 */
const NO_ROWS: readonly QuoteItemDto[] = []

/** 静态稿 `.btn`：32 高、圆角 9、描边、13px。 */
const PANEL_BTN =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[9px] border border-border bg-card px-3 text-[13px] whitespace-nowrap hover:bg-accent'

type QuotePanelProps = {
  /** 弹窗形态下限制高度，整页形态下铺满。 */
  variant?: 'dialog' | 'page'
  /** 从首页那张卡带进来的关键字。面板一开就该是按这个词筛过的。 */
  initialKeyword?: string
  /** 关掉整个面板（弹窗形态的「关闭」）。 */
  onRequestClose?: () => void
}

export function QuotePanel({
  variant = 'dialog',
  initialKeyword = '',
  onRequestClose,
}: QuotePanelProps) {
  const { can } = useAuth()
  const canRead = can(PERMISSIONS.PERSONAL_QUOTE_READ)

  const searchRef = useRef<HTMLInputElement | null>(null)

  const [meta, setMeta] = useState<QuoteMetaResponse | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)

  const [keyword, setKeyword] = useState(initialKeyword)
  const [debounced, setDebounced] = useState(initialKeyword.trim())
  const [source, setSource] = useState<QuoteSource | null>(null)
  const [category, setCategory] = useState<string>('')
  const [reloadToken, setReloadToken] = useState(0)

  /**
   * 列表结果与它对应的请求指纹。
   *
   * 只保存一份「已完成的请求」，**不保存 loading**：指纹不等于当前请求就是加载中。
   * 因此失败与成功都能落在同一次比较里，不会出现「loading 忘了复位、界面永远转圈」。
   */
  const [listEntry, setListEntry] = useState<{
    key: string
    rows: readonly QuoteItemDto[]
    total: number
    error: string | null
  } | null>(null)

  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [detailEntry, setDetailEntry] = useState<{
    key: string
    value: QuoteItemResponse | null
  } | null>(null)

  const [access, setAccess] = useState<QuoteAccessStateResponse | null>(null)
  const [gateOpen, setGateOpen] = useState(false)
  const [maintOpen, setMaintOpen] = useState(false)

  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [lightboxFailed, setLightboxFailed] = useState(false)

  // 面板关闭时释放 object URL。不释放的话每开一次面板就攒十几 MB，直到整页刷新。
  useEffect(() => releaseQuoteImages, [])

  // 打开即聚焦搜索框并全选 —— 与静态稿 `openPanel()` 的 `focus(); select()` 一致：
  // 从卡片带着词进来的人，多半是想在词上加条件。
  useEffect(() => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [])

  useEffect(() => {
    let cancelled = false
    loadQuoteMeta()
      .then((value) => {
        if (!cancelled) setMeta(value)
      })
      .catch((error: unknown) => {
        if (!cancelled) setMetaError(error instanceof ApiError ? error.message : '加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshAccess = useCallback(() => {
    loadQuoteAccessState()
      .then(setAccess)
      .catch(() => setAccess(null))
  }, [])

  useEffect(refreshAccess, [refreshAccess])

  // 输入防抖 90ms，与静态稿的 `setTimeout(..., 90)` 一致。
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword.trim()), 90)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const listKey = `${debounced}\u001f${source ?? ''}\u001f${category}\u001f${reloadToken}`

  useEffect(() => {
    let cancelled = false
    searchQuotes({
      q: debounced,
      ...(source === null ? {} : { source }),
      ...(category === '' ? {} : { category }),
      limit: LIMIT,
      offset: 0,
    })
      .then((result) => {
        if (cancelled) return
        setListEntry({ key: listKey, rows: result.items, total: result.total, error: null })
        // 选中态：当前行还在本页就留着，否则落到第一行。
        // 落到第一行是「打开即有内容」—— 右栏空着的时候，人不知道该点哪里。
        setSelectedCode((current) => {
          if (current !== null && result.items.some((item) => item.code === current)) return current
          return result.items[0]?.code ?? null
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setListEntry({
          key: listKey,
          rows: NO_ROWS,
          total: 0,
          error: error instanceof ApiError ? error.message : '加载失败',
        })
      })
    return () => {
      cancelled = true
    }
  }, [listKey, debounced, source, category])

  const listReady = listEntry !== null && listEntry.key === listKey
  const rows = listReady ? listEntry.rows : NO_ROWS
  const total = listReady ? listEntry.total : 0
  const loading = !listReady
  const listError = listReady ? listEntry.error : null

  // 选中项详情。列表里已经有价格了，但详情还要图与备注 —— 单独取一次，带缓存的是字节。
  const detailKey = selectedCode === null ? null : `${selectedCode}\u001f${reloadToken}`

  useEffect(() => {
    let cancelled = false
    if (detailKey !== null && selectedCode !== null) {
      loadQuoteItem(selectedCode)
        .then((value) => {
          if (!cancelled) setDetailEntry({ key: detailKey, value })
        })
        .catch(() => {
          if (!cancelled) setDetailEntry({ key: detailKey, value: null })
        })
    }
    return () => {
      cancelled = true
    }
  }, [detailKey, selectedCode])

  const detailReady = detailKey !== null && detailEntry !== null && detailEntry.key === detailKey
  const detail = detailReady ? detailEntry.value : null
  const detailLoading = detailKey !== null && !detailReady

  const openLightbox = useCallback((key: string | null, version: string | null) => {
    if (key === null) return
    setLightboxOpen(true)
    setLightboxSrc(null)
    setLightboxFailed(false)
    void loadQuoteImageUrl(key, 'full', version).then((url) => {
      if (url === null) setLightboxFailed(true)
      else setLightboxSrc(url)
    })
  }, [])

  /** 换来源时分类跟着清掉：选了「五金」还留着「柜体门板」，点进去必然是空的。 */
  function applySource(next: QuoteSource | null): void {
    setSource(next)
    setCategory('')
  }

  function applyCategory(next: string): void {
    setCategory(next)
  }

  /**
   * 「价格维护」的入口。**先判角色再判口令** —— 静态稿第 1389 行的 `requestMaint()`：
   * 已解锁直接开面板，否则先弹口令门。判据是 `access.direct`（服务端算好的角色），
   * 不是权限点：管理员持有 `personal.*` 通配，用权限点判定会静默绕过口令。
   */
  function requestMaint(): void {
    if (isUnlocked(access)) setMaintOpen(true)
    else setGateOpen(true)
  }

  /** 口令验证通过后直接进维护面板（静态稿第 1443 行是同一条路径）。 */
  const handleGateChanged = useCallback(() => {
    void loadQuoteAccessState()
      .then((next) => {
        setAccess(next)
        if (isUnlocked(next)) setMaintOpen(true)
      })
      .catch(() => setAccess(null))
  }, [])

  /**
   * Esc 收起整页形态（静态稿第 1497 行）。
   *
   * 只在 `page` 上挂：弹窗形态由 Radix `Dialog` 自己处理 Esc，再挂一层会重复触发。
   * 浮层（灯箱 / 口令 / 维护）开着时交给它们各自处理 —— 否则按一下 Esc 会连面板
   * 一起收掉，人还得重新打开。
   */
  useEffect(() => {
    if (variant !== 'page' || onRequestClose === undefined) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      if (lightboxOpen || gateOpen || maintOpen) return
      onRequestClose?.()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [variant, onRequestClose, lightboxOpen, gateOpen, maintOpen])

  if (!canRead) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        当前账号没有查看报价的权限（需要 `personal.quote.read`）。
      </p>
    )
  }

  const stat =
    listError !== null
      ? '台账读取失败'
      : loading
        ? '正在检索…'
        : `共 ${total} 条${total > LIMIT ? `，显示前 ${LIMIT} 条，请输入更精确的关键字` : ''}`

  /* 面板本体：两种形态共用同一份。
     定尺照静态稿 `.panel` —— 宽 `min(1180px,100%)`、高 `min(760px,calc(100vh - 56px))`、
     18px 圆角、外投影。**不要按形态各写一套**：一比一的前提是同一个盒子。

     **尺寸用内联 `style` 而不是 Tailwind 任意值。** `h-[min(760px,calc(100vh-56px))]`
     里 `calc` 的减号两侧缺空格，CSS 判为非法 → 整条 `min()` 失效 → 退成 `auto`，
     面板被内容压成 364px 宽、标题竖排（11-02 现场截图确认）。Tailwind 的 `_` 转空格
     能修，但这类写法一个字符写错就静默失效，不如直接给 CSS。 */
  const panel = (
    <div
      style={{
        width: '1180px',
        maxWidth: '100%',
        height: '760px',
        maxHeight: 'calc(100vh - 56px)',
      }}
      className="flex min-h-0 flex-col overflow-hidden rounded-[18px] bg-card shadow-[0_30px_80px_rgb(0_0_0_/_0.3)]"
    >
      {/* 头部：标题 + 副标题 + 搜索 + 价格维护 + 关闭 */}
      <div className="flex flex-none items-center gap-3 border-b border-border-soft px-[18px] py-3.5">
        <div className="min-w-0">
          <div className="text-base leading-6 font-medium">报价查价</div>
          <div className="text-xs text-muted-foreground-weak">
            柜体投影单价 · 特殊工艺收费 · 功能五金
          </div>
        </div>

        <div className="ml-auto flex h-[34px] w-[320px] shrink-0 items-center gap-1.5 rounded-[10px] border border-border bg-background px-2.5 focus-within:border-ring focus-within:bg-card">
          <Search className="size-3.5 shrink-0 text-muted-foreground-weak" />
          <input
            ref={searchRef}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              // Enter 立即检索。90ms 防抖是给「边打边看」用的，
              // 而按下回车的人已经想好了要看什么，不该再等那一下。
              if (event.key === 'Enter') setDebounced(keyword.trim())
            }}
            placeholder="输入材质 / 型号 / 工艺，空格分隔多个关键词"
            maxLength={QUOTE_LIMITS.QUERY_MAX}
            autoComplete="off"
            aria-label="搜索报价"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none"
          />
        </div>

        <button type="button" onClick={requestMaint} className={PANEL_BTN}>
          价格维护
        </button>
        {onRequestClose !== undefined && (
          <button type="button" onClick={onRequestClose} className={PANEL_BTN}>
            关闭
          </button>
        )}
      </div>

      {/* 主体三栏：212 筛选 / 结果 / 326 详情 */}
      <div className="flex min-h-0 flex-1">
        <QuoteFilters
          meta={meta}
          source={source}
          category={category}
          onSource={applySource}
          onCategory={applyCategory}
          className="w-[212px]"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-auto">
            {listError !== null ? (
              <ErrorState
                variant="plain"
                className="py-12"
                description={listError}
                onRetry={() => setReloadToken((value) => value + 1)}
              />
            ) : loading ? (
              <LoadingState variant="plain" className="py-12" label="正在检索报价" />
            ) : (
              // 没有匹配时不铺空态插画 —— 静态稿只在右栏写一句「无匹配条目」，
              // 左表空着本身就是答案。
              <QuoteResultTable
                rows={rows}
                selectedCode={selectedCode}
                keyword={debounced}
                onSelect={(code) => setSelectedCode(code)}
                onOpenImage={(item) => openLightbox(item.imageKey, item.imageVersion)}
              />
            )}
          </div>
        </div>

        <aside
          aria-label="报价详情"
          className="w-[326px] shrink-0 overflow-auto border-l border-border-soft bg-background px-4 pt-4 pb-6"
        >
          {detailLoading ? (
            <LoadingState variant="plain" className="py-10" label="正在读取报价详情" />
          ) : detail === null ? (
            <p className="px-2 py-2 text-[13px] text-muted-foreground-weak">
              {rows.length === 0 ? '无匹配条目' : '选一条看详情'}
            </p>
          ) : (
            /* `key` 让「换一条选中项」等于重新挂载：价格输入框、改动说明、提示语
               全部回到初值。写成在 effect 里重置会撞 `react-hooks/set-state-in-effect`，
               而且第一帧会先显示上一条的价格。 */
            <QuoteDetail
              key={detail.item.code}
              detail={detail}
              access={access}
              onRequestUnlock={() => setGateOpen(true)}
              onOpenImage={() => openLightbox(detail.item.imageKey, detail.item.imageVersion)}
              onChanged={() => {
                setReloadToken((value) => value + 1)
                refreshAccess()
              }}
            />
          )}
        </aside>
      </div>

      {/* 页脚：统计 + 数据版本 */}
      <div className="flex flex-none items-center gap-2.5 border-t border-border-soft bg-card px-4 py-[9px] text-xs text-muted-foreground-weak">
        <span aria-live="polite">{stat}</span>
        <span className="ml-auto">
          数据版本{' '}
          <code className="font-mono">
            {meta === null
              ? metaError === null
                ? '…'
                : '—'
              : meta.version.slice(0, 12) || '未导入'}
          </code>
        </span>
      </div>

      <QuoteLightbox
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        src={lightboxSrc}
        failed={lightboxFailed}
        alt={detail?.item.name ?? '商品图'}
        natural={
          detail?.image === null || detail?.image === undefined
            ? null
            : { width: detail.image.width, height: detail.image.height }
        }
      />

      <PriceGateDialog
        open={gateOpen}
        onOpenChange={setGateOpen}
        state={access}
        onStateChanged={handleGateChanged}
      />

      <QuoteMaintPanel open={maintOpen} onOpenChange={setMaintOpen} access={access} meta={meta} />
    </div>
  )

  /* 整页形态也套 `.overlay` 那层壳。静态稿的面板从来不是页面里的一个盒子，而是
     `fixed inset-0` + `padding:28px` 的居中浮层 —— 把它塞进 `WorkbenchPage` 的正文
     容器会掉到约 730px 宽：212 筛选 + 326 详情先占掉 538，结果表只剩 260，
     `max-width:158px` 的规则价会撑出表格边界、压在详情栏上（11-02 现场截图确认）。
     点遮罩空白处等于关闭，与「关闭」按钮同一条出口。 */
  if (variant === 'page') {
    return (
      <div
        /* 遮罩整层用内联样式，不用 Tailwind 类。两条原因都是实测踩到的：
           ① `bg-[rgb(9_9_11_/_0.42)]` 里的 `/` 会被当成「颜色/透明度」分隔符，
              整条类名被丢掉 —— 遮罩根本不渲染，看上去像「面板浮在页面上」；
           ② 水平居中在 flex 容器里也没有如期生效。
           静态稿第 213 行的 `.overlay` 就三件事：铺满、半透明、居中。写死更稳。 */
        style={{
          position: 'fixed',
          inset: 0,
          /* 46，不是 80。面板要盖住侧栏（侧栏最高 z-45），但**必须低于 Radix 对话框的
             z-50** —— 价格维护面板与口令门都是 Dialog，遮罩压在它们上面时，对话框
             确实打开了（DOM 里有、焦点也在里面），只是整块被盖住，屏幕上什么都看不见。
             静态稿没有这个问题：它所有 overlay 都是同一个 z，靠 DOM 顺序决定前后。
             这条是 2026-11-03 现场踩到的。 */
          zIndex: 46,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 28,
          background: 'rgb(9 9 11 / 0.42)',
        }}
        /* 静态稿第 1344 行用的是 `mousedown` 而不是 `click`：起手在面板内、松手
           在遮罩上（拖选文字时常见）不该关闭。用 `click` 会把这种手势判成「点了外面」。 */
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onRequestClose?.()
        }}
      >
        {panel}
      </div>
    )
  }

  return panel
}

/**
 * 「能不能直接改价」。
 *
 * 判据是服务端算好的 `direct`（角色）或一张还没过期的解锁票据 —— **不是权限点**。
 * 管理员持有 `personal.*` 通配，用权限点判定会静默绕过口令：库全对、日志干净、
 * 界面上看不出任何异常。
 */
function isUnlocked(access: QuoteAccessStateResponse | null): boolean {
  if (access === null) return false
  if (access.direct) return true
  if (access.unlockedUntil === null) return false
  const until = Date.parse(access.unlockedUntil)
  return Number.isFinite(until) && until > Date.now()
}
