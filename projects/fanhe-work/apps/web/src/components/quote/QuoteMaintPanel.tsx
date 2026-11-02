import type { QuoteAccessStateResponse, QuoteMetaResponse } from '@fanhe/shared'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { describeDataset, minutesUntil } from '../../lib/quote-display'

/**
 * 价格维护。**结构与文案对齐静态稿 `.maint`（第三视图）：六节 + 页脚。**
 *
 * 这一屏回答的是「价格怎么进来、改动怎么留痕、谁能改」，不是「改这一条」——
 * 改一条的动作在右栏的维护区里（静态稿 4.2 也是这么分的：入口在面板右栏）。
 *
 * 六节刻意保持静态稿的顺序：入口 → 字段 → 同步 → 图 → 授权 → 记录。
 * 这是从「数据从哪来」一路走到「谁动了它」的顺序，打乱之后读起来会像六张
 * 互不相干的说明卡。
 *
 * 数字全部取当前数据集（`/quote/meta`），不写死。静态稿里 192/307/97 那三档绑定
 * 统计没有对应接口，因此这里不给这三个数 —— **宁可少一个角标，也不编一个数**。
 */

const ENTRY = [
  {
    title: 'Excel 批量导入',
    body: (
      <>
        改完 <code>报价查价系统/*.xlsx</code> 后执行
        <br />
        <code>pnpm db:quote-import</code>
        <br />
        幂等：按业务键 upsert，重跑不产生重复行。
      </>
    ),
  },
  {
    title: '在线单条改价',
    body: (
      <>
        面板右栏「维护」直接改价格，写一条 <code>price_revision</code> 记录旧值/新值/
        操作人/原因。适合临时促销、供应商调价。
      </>
    ),
  },
  {
    title: '停用 / 恢复',
    body: (
      <>
        台账中已删除的项目转为 <code>archived</code>，<b>不做物理删除</b>。
        历史报价单仍可追溯当时单价。
      </>
    ),
  },
]

const MAPPING = [
  ['销售查价系统改1', '名称（合并单元格）', 'category', '向下填充，合并单元格展开为每行的分类值'],
  ['销售查价系统改1', '材质', 'name', '去空格，保留原文括号与「+」'],
  ['销售查价系统改1', '单价 / 单位', 'price / unit', '纯数字入 price_fen；口径写进备注'],
  [
    '板式工艺收费',
    '品类（合并）/ 项目 / 收费标准 / 说明',
    'category / name / price_text / note',
    '含倍率、每米、区间者不折算，原样入 price_text',
  ],
  ['诺米 / 百隆五金', 'sheet 名', 'category（系列）', '18 个 sheet 各自成一个系列'],
  [
    '诺米 / 百隆五金',
    '产品名称（合并）/ 型号 / 规格 / 单价',
    'name / model / spec / price',
    '名称向下填充；主架型号 + 篮体型号拼为 model',
  ],
] as const

const FLOW = [
  [
    'T0',
    '导入写库',
    '导入器算一次内容指纹（行数 + 各行业务键 + 单价），写进数据集的 version 与 imported_at。',
  ],
  [
    'T1',
    '前端取版本',
    '页面挂载时调 GET /api/quote/meta，只拿 version、条数、导入时间，约 100 字节。',
  ],
  [
    'T2',
    '版本不一致即作废',
    '窗口重新获得焦点、或距上次校验超过 5 分钟时重取 version。不一致就丢本地缓存、重拉当前查询。',
  ],
  ['T3', '写操作即回传', '在线改价成功后，响应体直接带回新 version，本端立即刷新，不等轮询。'],
] as const

const AUTH_ROWS = [
  ['超级管理员', 'role.code === owner', '直接进入，不弹口令', '改价、改图、设置与轮换口令、翻审计'],
  [
    '管理员 / 设计师 / 其他',
    '其余全部已登录账号',
    '输入口令 → 30 分钟会话',
    '改价、改图；不能设置或查看口令',
  ],
  ['未登录', '无会话', '不放行', '无 —— 口令是第二道门，不替代登录'],
] as const

const API_LINES = [
  ['GET ', '/api/quote/access-state', '→ { role, direct, unlockedUntil, lockedUntil, failCount }'],
  ['POST', '/api/quote/unlock', '{ password } → { unlockToken, expiresAt }'],
  ['POST', '/api/quote/access-secret', '{ password } 仅 owner → { version, updatedAt }'],
  ['PUT ', '/api/quote/access-secret', '{ newPassword } 仅 owner，version+1，旧令牌全废'],
  ['POST', '/api/quote/items/:code/image', 'multipart，需 owner 或有效 unlockToken'],
  ['DEL ', '/api/quote/items/:code/image', '解绑，不删图'],
] as const

export function QuoteMaintPanel({
  open,
  onOpenChange,
  access,
  meta,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  access: QuoteAccessStateResponse | null
  meta: QuoteMetaResponse | null
}) {
  const remaining = minutesUntil(access?.unlockedUntil ?? null)
  const badge =
    access === null
      ? '读取权限中'
      : access.direct
        ? '超级管理员 · 免口令'
        : remaining !== null && remaining > 0
          ? `已解锁 · 剩余 ${remaining} 分钟`
          : '需要维护口令'
  const badgeClass =
    access !== null && (access.direct || (remaining !== null && remaining > 0))
      ? 'bg-[color-mix(in_srgb,var(--m-teal)_11%,transparent)] text-m-teal border-[color-mix(in_srgb,var(--m-teal)_22%,transparent)]'
      : 'bg-[color-mix(in_srgb,var(--m-amber)_12%,transparent)] text-m-amber border-[color-mix(in_srgb,var(--m-amber)_24%,transparent)]'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[min(720px,92vh)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[min(1080px,94vw)]"
      >
        {/* 头。标题带授权角标，副标题一行讲清这一屏的性质。 */}
        <div className="flex items-center gap-3 border-b border-border-soft px-5 py-3.5">
          <div>
            <DialogTitle className="flex items-center gap-2 text-base font-medium">
              价格维护
              <span
                className={`inline-flex items-center rounded-full border px-2 text-[11px] leading-[18px] font-normal ${badgeClass}`}
              >
                {badge}
              </span>
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground-weak">
              三档入口 · 一处真值 · 全量留痕
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false)
            }}
            className="ml-auto inline-flex h-8 items-center rounded-[9px] border border-border bg-card px-3 text-[13px] hover:bg-accent"
          >
            关闭
          </button>
        </div>

        <div className="min-h-0 overflow-auto px-5 pt-4 pb-7">
          <Section title="1. 数据入口">
            <p className="mb-3.5 text-[12.5px] text-muted-foreground">
              三份源台账是唯一真值。平台上不新增第四个录入口，只提供三条操作路径，
              改价一律回到台账再导入，避免出现「库里有、表里没有」的分叉。
            </p>
            <div className="mb-5 grid grid-cols-3 gap-3">
              {ENTRY.map((entry, index) => (
                <div
                  key={entry.title}
                  className="rounded-xl border border-border bg-background p-3"
                >
                  <div className="mb-1.5 flex items-center gap-2 text-[13.5px] font-medium">
                    <span className="grid size-5 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
                      {index + 1}
                    </span>
                    {entry.title}
                  </div>
                  <p className="text-[12.5px] leading-[1.65] text-muted-foreground">{entry.body}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="2. 字段映射（三源 → 统一模型）">
            <p className="mb-3.5 text-[12.5px] text-muted-foreground">
              三份表的列名与粒度都不同，导入器负责归一。以下为实际列到 <code>price_items</code>
              的映射。
            </p>
            <MapTable
              head={['源台账', '源列', '统一字段', '归一规则']}
              widths={['22%', '20%', '22%']}
              rows={MAPPING.map((row) => [
                row[0],
                row[1],
                <code key={row[2]}>{row[2]}</code>,
                row[3],
              ])}
            />
          </Section>

          <Section title="3. 种子变更后，前端如何同步">
            <p className="mb-3.5 text-[12.5px] text-muted-foreground">
              同步的判据只有一个数字：数据集版本号。它不跟着代码版本走，改价不需要重新构建镜像。
            </p>
            <div className="mb-5 grid grid-cols-4 gap-2.5">
              {FLOW.map(([tag, title, desc], index) => (
                <div
                  key={tag}
                  className="relative rounded-xl border border-border bg-background px-3 py-2.5"
                >
                  <div className="font-mono text-[11px] text-muted-foreground-weak">{tag}</div>
                  <div className="mt-0.5 mb-1 text-[13px] font-medium">{title}</div>
                  <div className="text-xs leading-[1.6] text-muted-foreground">{desc}</div>
                  {index < FLOW.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1/2 -right-2.5 -translate-y-1/2 text-sm text-border"
                    >
                      →
                    </span>
                  )}
                </div>
              ))}
            </div>
            <p className="text-[12.5px] text-muted-foreground">
              失败策略是<b className="text-foreground">宁可空白，不给旧价</b>：version 取不到或
              对不上时，结果区显示骨架与「价格数据正在更新」，不拿缓存价顶上。价格显示旧值比
              显示空白危险得多。
            </p>
          </Section>

          <Section title="4. 商品图维护">
            <p className="mb-3.5 text-[12.5px] text-muted-foreground">
              图片不做独立一份图库，而是<b className="text-foreground">跟着价格行走</b>。 绑定依据是{' '}
              <code>sheet + 行号</code>，不是名称匹配 —— 同名最多重复 15 次，
              匹配一旦出错，图会安静地挂到错型号上，界面上完全看不出来。
            </p>
            <div className="mb-4 flex flex-wrap gap-1.5">
              <Pill value={meta?.imageCount ?? 0} label="张图文件" />
              <Pill value={meta?.itemCount ?? 0} label="条价格行" />
              <Pill text="按行号绑定" />
              <Pill text="不按名称匹配" />
            </div>
            <div className="mb-5 grid grid-cols-3 gap-3">
              {[
                [
                  '上传绑定',
                  '详情占位框内选图。服务端按魔数判 MIME（不看扩展名），字节入库，同时生成缩略图。',
                ],
                [
                  '替换',
                  '新图写为 is_active，旧记录翻成 false 并记 replaced_by，不物理删除。历史报价单能对上当时那张图。',
                ],
                [
                  '解绑',
                  '只解除与条目的关联，图仍留在库。用于「图贴错型号」——把图挪到正确型号，而不是删了重传。',
                ],
              ].map(([title, body]) => (
                <div key={title} className="rounded-xl border border-border bg-background p-3">
                  <div className="mb-1.5 text-[13.5px] font-medium">{title}</div>
                  <p className="text-[12.5px] leading-[1.65] text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>
            <dl className="mb-5 grid grid-cols-[132px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
              <dt className="text-muted-foreground-weak">格式</dt>
              <dd className="m-0 leading-[1.6]">JPEG / PNG / WebP；透明底一律按白底合成</dd>
              <dt className="text-muted-foreground-weak">尺寸</dt>
              <dd className="m-0 leading-[1.6]">
                建议长边 ≥ 1000px。台账原图中位 336px —— 放大后偏糊是原图的问题，不是页面压缩
              </dd>
              <dt className="text-muted-foreground-weak">体积</dt>
              <dd className="m-0 leading-[1.6]">
                单张 ≤ 6MB（沿用案例库的 bodyLimit）。原图字节原样入库，不做二次转码
              </dd>
              <dt className="text-muted-foreground-weak">存储</dt>
              <dd className="m-0 leading-[1.6]">
                <code>bytea</code> 入库，不写容器磁盘、不挂宿主目录（与案例库同一套约定）
              </dd>
              <dt className="text-muted-foreground-weak">读取</dt>
              <dd className="m-0 leading-[1.6]">
                取图需令牌：fetch → Blob → objectURL，不开放公开静态目录
              </dd>
            </dl>
          </Section>

          <Section title="5. 价格维护授权">
            <p className="mb-3.5 text-[12.5px] text-muted-foreground">
              一句话：
              <b className="text-foreground">
                超级管理员直接进；其他所有人 —— 包括管理员 —— 都要输入口令
              </b>
              。口令由超级管理员设置与轮换，验证后 30 分钟内有效。
            </p>
            <MapTable
              head={['身份', '判据', '进入方式', '能做什么']}
              widths={['18%', '24%', '22%']}
              rows={AUTH_ROWS.map((row) => [
                row[0],
                <code key={row[1]}>{row[1]}</code>,
                row[2],
                row[3],
              ])}
            />
            <p className="mb-3.5 text-[12.5px] text-muted-foreground">
              判据必须是角色而不是权限点：管理员持有 <code>personal.*</code> 通配，一旦把{' '}
              <code>price.write</code> 放进这个通配，管理员会
              <b className="text-foreground">静默绕过</b>口令 —— 库全对、日志干净、界面无任何
              异常，只能靠人读代码发现。
            </p>
            <div className="mb-5 grid grid-cols-4 gap-2.5">
              {[
                [
                  '1',
                  '超管设口令',
                  '至少 8 位含字母与数字。argon2id 哈希入表，明文只在设置时出现一次。',
                ],
                [
                  '2',
                  '验证',
                  'POST /unlock 限流 5 次/分；连续错 5 次锁 15 分钟，锁定期间口令正确也不放行。',
                ],
                [
                  '3',
                  '30 分钟会话',
                  '签发不透明 unlockToken（库内只存哈希）。写请求带它，审计记 unlock_session_id。',
                ],
                [
                  '4',
                  '轮换即失效',
                  '改口令把 secret.version +1，所有已签发令牌立即作废，不等自然过期。',
                ],
              ].map(([tag, title, desc], index) => (
                <div
                  key={tag}
                  className="relative rounded-xl border border-border bg-background px-3 py-2.5"
                >
                  <div className="font-mono text-[11px] text-muted-foreground-weak">{tag}</div>
                  <div className="mt-0.5 mb-1 text-[13px] font-medium">{title}</div>
                  <div className="text-xs leading-[1.6] text-muted-foreground">{desc}</div>
                  {index < 3 && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1/2 -right-2.5 -translate-y-1/2 text-sm text-border"
                    >
                      →
                    </span>
                  )}
                </div>
              ))}
            </div>
            {/* `<pre>` 里不能放 `<div>`（HTML 上非法，浏览器会把它拆开）。等宽与换行
                用类名表达即可：`font-mono` + 逐行一个 div。 */}
            <div className="mb-5 overflow-auto rounded-[10px] border border-border-soft bg-background px-3 py-2.5 font-mono text-[11.5px] leading-[1.85] whitespace-pre-wrap text-muted-foreground">
              {API_LINES.map(([method, path, rest]) => (
                <div key={`${method}${path}`}>
                  <span className="text-muted-foreground-weak">{method}</span> {path}{' '}
                  <span className="text-muted-foreground-weak">{rest}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="6. 变更记录">
            <p className="text-[12.5px] text-muted-foreground">
              改价与改图共用一张 <code>price_revision</code>：条目号、字段、旧值、新值、
              操作人、解锁会话、原因、时间。每次改价都会写一行，页面上暂未开放查询入口 ——
              现在的读法是直接查这张表。
            </p>
          </Section>
        </div>

        <div className="flex items-center gap-2.5 border-t border-border-soft px-5 py-2.5 text-xs text-muted-foreground-weak">
          <span>
            导入脚本：<code className="font-mono">apps/api/src/db/quote-import.ts</code>
            （幂等，可重复执行）
          </span>
          <span className="ml-auto">{meta === null ? '数据集读取中…' : describeDataset(meta)}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-1 text-[15px] font-medium">{title}</h3>
      {children}
    </section>
  )
}

function Pill({ value, label, text }: { value?: number; label?: string; text?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-[11.5px] text-muted-foreground">
      {text ?? (
        <>
          <b className="font-medium text-foreground tabular-nums">{value}</b>
          {label}
        </>
      )}
    </span>
  )
}

function MapTable({
  head,
  widths,
  rows,
}: {
  head: readonly string[]
  widths: readonly string[]
  rows: readonly (readonly React.ReactNode[])[]
}) {
  return (
    <table className="mb-5 w-full border-collapse text-[12.5px]">
      <thead>
        <tr>
          {head.map((label, index) => (
            <th
              key={label}
              style={{ width: widths[index] }}
              className="border-b border-border-soft bg-background px-2.5 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak"
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className="border-b border-border-soft px-2.5 py-2 align-top [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-m-teal"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
