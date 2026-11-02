# 客户平台：双角色归属、公共池智能归类、金额可见性

> 2026-11-02。状态：**已实现并全绿**（15 迁移 / 23 权限点 / 6 角色 / api 397 项、shared 191 项，0 失败）。
> 前置阅读：`CUSTOMER-SCOPED-PERMISSION-2026-11-02.md`（上一版行级权限方案）、`CUSTOMER-CRM-IMPLEMENTATION-2026-10-28.md`（客户模块现状）、`QIANNIU-OPS-PERMISSION-2026-10-19.md`（权限点体系的第一份同类设计）。
> 本文回答「数据结构怎么存、归类什么时候跑、金额在哪一层裁、怎么验」，并**明确列出与上一版方案冲突的三处**以及最终裁决。

---

## 一、结论摘要

需求的三句话版本：

1. **同一位客户可以既有设计师又有销售**，两端互相看得见对方是谁；
2. **公共池里的客户，按历史聊天记录自动判给销售还是设计师**，并给出依据、可人工复核；
3. **销售与设计师都能看金额，但只看得到自己名下那几位客户的金额**。

三句话里有三处与 `CUSTOMER-SCOPED-PERMISSION-2026-11-02.md` 直接冲突。那份方案的核心裁决是「单列 `assignee_id`，一个客户只有一个负责人」，且「销售默认不给金额」。本期需求把这两条都推翻了，第三条（公共池）也从「不可见」改成「可见且可归类」。

| # | 上一版裁决 | 本期要求 | 裁决 |
|---|---|---|---|
| C1 | 归属用**单列** `assignee_id`，销售签单后转派给设计师 | 同一客户**同时**有设计师和销售，双向可查 | 改成**双列** `designer_id` + `sales_id`；转派语义降级为「调整两栏中的任意一栏」 |
| C2 | 销售**不默认**给 `finance.read`，金额对销售打码 | 销售与设计师**都能看**自己名下的金额 | 两个角色都发 `finance.read`；金额保护改由**行范围**承担，`finance.read` 降级为「可见行内是否打码」 |
| C3 | 公共池（无归属）对业务角色不可见，由管理员统一分派 | 公共池**可见**，且要自动归类 + 人工复核 | 新增建议表与归类引擎；`/api/customers/pool` 要 `customer.scope.read` |

三条裁决背后的同一条原则：**动作维度（能不能读）、行维度（能读哪些行）、字段维度（读到之后哪些字段不遮）是三个正交的维度**。上一版把它们挤在两个维度里，本期需求一压就散了。

---

## 二、数据结构

### 2.1 客户表的双列归属

```prisma
model Customer {
  designerId String? @map("designer_id") @db.Uuid
  salesId    String? @map("sales_id")    @db.Uuid
  designer   User?   @relation("CustomerDesigner", fields: [designerId], references: [id], onDelete: SetNull)
  sales      User?   @relation("CustomerSales",    fields: [salesId],    references: [id], onDelete: SetNull)

  @@index([designerId, lastMessageAt])
  @@index([salesId, lastMessageAt])
}
```

四个决定的理由：

- **两列分开，不合成 `assignee_ids uuid[]`。** 界面上要显示的是「这位客户的销售是谁」，数组列会让它变成一个下标问题 —— 而「谁是销售」和「谁是设计师」不是同一种信息，它们在流水线上有先后（销售签单 → 设计师履约）。合并之后连「这一单的销售是谁」都回答不了。
- **两列都 `SetNull`，不 `Cascade`。** 账号被删时客户必须留下：客户是业务资产，账号是操作者。`SetNull` 的副作用是「账号删了，客户悄悄回到公共池」，这一点必须让复核队列能兜住（见 §4.4）。
- **组合索引带 `lastMessageAt`。** 列表默认按最近沟通时间倒序，范围过滤之后仍要走索引。单独给 `designer_id` 建索引会让排序退化成一次全表 sort。
- **两栏都为空 = 公共池。** 不引入 `status` 列表达「未分配」：那会与两栏形成两种真相，迟早不一致。

**「两栏都为空」与「设计师销售是同一人」是不同状态。** 同一个人同时占两栏在权限上等价于单归属，但界面上会显示成「设计师：张三 / 销售：张三」—— 这是真实情况（小店里老板既谈单又画图），不能当成数据错误。

### 2.2 归类建议表

```prisma
model CustomerPoolSuggestion {
  customerId      String   @unique          // 一位客户只有一条最新建议
  role            String                    // designer / sales
  suggestedUserId String?                   // 建议的具体账号（该角色下最闲的人）
  confidence      Int                       // 0–100 整数
  salesScore      Int
  designerScore   Int
  reasons         Json                      // PoolReason[]，给人看的依据
  signals         Json?                     // 词频、阶段、条数，复盘用
  engine          String   @default("rules-v1")
  status          String   @default("pending") // pending / accepted / adjusted / rejected
  reviewedBy      String?
  reviewedAt      DateTime?
  reviewNote      String?   @db.VarChar(300)
}
```

- **`customerId` 唯一。** 一位客户只保留最新一条建议，不是历史表。要历史就查审计：审计里记了每次复核的决定与备注，比在这里堆版本更省事，也不会有人去 join 一张无限增长的表。
- **`reasons` 用 Json 不用关联表。** 它只被整体读取、整体展示，从不按单条理由查询。拆表只会多一次 join。
- **`signals` 与 `reasons` 分开。** `reasons` 是给人看的话（「聊天里在谈尺寸与图纸｜量尺×4、图纸×3」），`signals` 是原始证据（词频明细、阶段、消息条数）。判定规则一变，`signals` 能回答「上次为什么判得不一样」，`reasons` 不能。
- **`engine` 记规则版本。** 规则改了可以按版本筛出需要重算的旧结论，而不用全库重跑。

### 2.3 迁移

`20261102130000_customer_dual_assignment`（第 15 个迁移），由

```
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

生成。**注意 Prisma 7 已移除 `--from-schema-datasource`**，用旧参数会报「未知参数」而不是给出一个可读的错误。

---

## 三、双角色关联展示

### 3.1 契约

```ts
export type CustomerAssignmentDto = {
  designerId: string | null
  designerName: string | null
  salesId: string | null
  salesName: string | null
  /** 当前账号是以什么身份负责这位客户；不是负责人时为 null。 */
  myRole: 'designer' | 'sales' | null
}
```

列表行的 `assignment` 与详情共用同一份结构。**`myRole` 由服务端算**（`roleOf(row, viewer.userId)`），前端不许拿当前账号 id 去和两个 id 比对：那等于把归属规则复制到第二个地方，而两处不一致时的表现是「我」这个标记不见了 —— 不报错、不白屏，只是少一个角标。

### 3.2 界面

| 位置 | 表现 | 文件 |
|---|---|---|
| 列表「归属」列 | 两栏都渲染，空的显示「—」 | `components/customer/CustomerTable.tsx` |
| 详情「负责团队」区块 | 两栏徽标 + `AssignmentEditor`（两个下拉 + 原因 + 保存） | `pages/CustomerPage.tsx` |
| 展示规则 | `assignmentParts` / `assignmentSummary` 纯函数 | `lib/customer-display.ts` |

展示规则下沉到纯函数是为了能被单测钉住：写在组件里只有开浏览器才能验，而「空栏显示成 undefined」这种错在浏览器里也要正好翻到那一条才看得见。

---

## 四、公共池与智能归类

### 4.1 触发时机

| 入口 | 触发方式 | 用途 |
|---|---|---|
| `POST /api/customers/pool/classify` | 界面点「公共池归类」，可传 `customerIds` 只算当前行 | 复核页「重新判定」 |
| `pnpm db:pool-classify` | 命令行，支持 `--dry-run` | 首次铺量、每天补算 |

**不做定时任务自动归类。** 归类会写建议、会影响复核队列的排序，它的产出是一个**待办**而不是事实。挂在定时任务上的后果是每天早上队列自己变一次，而没人知道它在跑。

### 4.2 判定规则（`packages/shared/src/customer-pool.ts`）

纯函数，输入是证据、输出是结论 + 依据。**不用模型**，理由很具体：复核的人要看的正是依据，而模型只能给一句「置信度 0.83」，复核无从下手，也无法解释为什么把一位老客户从设计师名下划走。

计分：

```
侧分 = Σ(词权 × (命中次数 + 最近 90 天命中次数))，单词上限 20 次，总分上限 100
```

- 销售词 19 个（定金/订金/签单 4 分，报价/价格/合同/付款/成交 3 分，其余 1–2 分）
- 设计词 20 个（量尺/复尺/测量/图纸/效果图/拆单 4 分，尺寸/设计/方案/板材/安装/见光板 3 分，其余 1–2 分）
- 阶段先验 14 档，6–16 分：`consulting` → 销售 12；`refunding` → 销售 16；`lost` → 销售 8；其余设计类 6–16

三条规则：

1. **没有任何聊天记录**（`msgRows === 0`）→ 判销售，置信度 20，依据写「新客户默认由销售接待」。这是流程起点，不假装有证据。
2. **最终分数差距 ≤ max(4, 总分 × 20%)** → 按阶段先验收口，并留一条 `tie-break` 依据。
   **这条分支比读起来窄**：比的是含先验的最终分，先验 12–16 分时只有关键词分几乎相等才落得进来（实测 `quoted` 8 分档、两侧差 2 分）。写用例验证它时别拿 `designing`（16 分）去构造 —— 差距永远够大，用例会以为分支坏了。
3. 否则按分数高的一方。

置信度的两道封顶：

| 情况 | 上限 | 依据码 |
|---|---|---|
| 读不到群文件原文 | **45** | `no-transcript` |
| 最近 90 天没有新消息 | **60** | `stale` |
| 完全没有证据 | 20（下限） | `no-history` |

封顶是刻意暴露的信号而非静默降级：低于 60 的条目界面提示「需要人工判断」。API 容器里没挂 D 盘，所以在容器内触发时 `source` 恒为 `stored`、置信度恒被压到 45 —— 复核人看到「没有读到群文件」就知道该用宿主机上的 `pnpm db:pool-classify` 补一次。

**单词次数上限 20 是必需的。** 一位客户可以说三十次「多少钱」，但那不意味着销售倾向是三十倍；不设上限时，一个反复出现的词会淹没阶段先验，判定退化成「谁刷屏谁赢」。

**关键词按不重叠子串计数，不分词。** 中文分词要词典，而这里的词都是 2–4 字固定词，`split(term).length - 1` 足够准，也不会把「见光板」拆成「见」「光」「板」而漏掉组合词。这一条在 `customer-pool.test.mjs` 里有专门用例。

### 4.3 建议账号：最闲优先

`candidatesFor(role)` 按名下客户数升序、同负载按 id 升序。**同负载一定要有确定性的次序**：否则两次跑出来的建议是不同的人，复核人刷新一次就看到另一个名字，会以为规则不稳定。

### 4.4 复核

```
POST /api/customers/:id/pool-suggestions/:suggestionId/review
  decision: accepted | adjusted | rejected
  role?  userId?  note(必填)
```

需要**两个权限点同时具备**（`import.review` + `scope.write`）。复核的三种出口里有两种会落成归属，只给复核权而不给转派权的账号点了「采用」也无法生效；只给转派权又不该看到机器判定依据。用两个 `preHandler` 而不是在处理器里手写判断：手写的那种一旦漏在某个分支上，表现是「按钮点了没反应」，日志里什么都没有。

执行顺序两条硬规定：

- **先落归属，再改状态。** 反过来的话，归属校验失败会留下一条「已接受但没生效」的记录，而它已经从待办队列里消失 —— 这种状态没有任何界面能表达。
- **`keepSuggestionId` 必须传。** `assignCustomer` 会清掉未复核的建议（归属变了，旧建议就过期了），正在复核的这条还没改成 `accepted`，不排除就会被一起删掉。

复核必须留一句话（`note`）。判定依据说明的是机器怎么想，注释说明的是人怎么想，两者不能互相替代 —— 三个月后回看「为什么把他划给设计师」，只有注释能回答。

**已复核的条目重跑不覆盖**（除非 `force`）。复核是人签过的字。无条件 upsert 的后果是每天早上同步一次、人工判断被悄悄推翻，而界面上只看到「结论又变了」，没有任何报错。

---

## 五、金额可见性的三层

| 层 | 判据 | 失败表现 |
|---|---|---|
| 动作 | `customer.record.read` | 401 / 403 |
| 行 | `customer.scope.read` 否则 `designer_id = 我 OR sales_id = 我` | **404**（不是 403） |
| 字段 | `customer.finance.read` | `amounts: null`、`contractTotalFen: null`，其余字段照常 |

关键点是第二层与第三层的分工：**「看不到金额」在正常路径上只会以 404 出现，不会以 `null` 出现。** 设计师与销售都拿到了 `finance.read`，所以他们能打开的每一行都能看到金额；打不开的行根本走不到字段裁剪。`null` 只留给「有行权、无金额权」的岗位（例如将来可能有的财务外包）。

**裁剪必须在权限判断之后，写在取数路径上会让管理员也看不到金额而 KPI 正常** —— 这个坑运维看板首版踩过。

---

## 六、接口清单

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/api/customers` | `record.read` | 自动按范围过滤，响应带 `scopeKind: 'all' \| 'own'` |
| GET | `/api/customers/:id` | `record.read` | 行级越权 → 404 |
| PATCH | `/api/customers/:id/assignment` | `scope.write` | **唯一能把越权合法化的入口** |
| GET | `/api/customers/assignable-users` | `scope.write` | 只返回 designer / sales 两类账号 |
| GET | `/api/customers/pool` | `scope.read` | 两栏皆空 + 本范围；按 `lastMessageAt` 升序，`take: 200` |
| POST | `/api/customers/pool/classify` | `import.review` | 可传 `customerIds` / `force` |
| POST | `/api/customers/:id/pool-suggestions/:sid/review` | `import.review` **且** `scope.write` | 采用 / 调整 / 驳回 |

失败码新增两项：`field_not_allowed`（400，字段级拒绝）、`invalid_assignee`（400，目标账号不存在/停用/角色与栏位不符）。

**`field_not_allowed` 用 400 不用 403**：403 在这一层会把「字段级拒绝」与「行级越权」混成同一个码，前端就无法区分「该重拉详情」还是「该收起这个输入框」。

---

## 七、服务端实现要点

### 7.1 范围条件必须进 `AND` 数组

`buildCustomerWhere` 里检索条件也用 `OR`，范围条件也用 `OR`。两个 `OR` 赋给同一个 `where.OR` 会**静默覆盖**（后写的赢），表现是「检索能搜到别人的客户，而平时一切正常」。所以统一收进 `and: Prisma.CustomerWhereInput[]`，最后赋给 `where.AND`。

### 7.2 观察者（viewer）整条链路传一个对象

```ts
type CustomerViewer = {
  userId: string; displayName: string; roleCode: string
  scope: { kind: 'all' } | { kind: 'own'; userId: string }
  canReadFinance: boolean; canReview: boolean; canAssign: boolean
}
```

不给每个 service 函数加三个布尔参数：加参数时漏传一个的后果是**静默放开整个范围**，而编译器不会报错。

`roleCode` 只用于「新建客户时默认归到哪一栏」这一件事，不参与任何可见性判断 —— 可见性只看 `scope`。把角色接进授权判断会让「调岗」变成一次授权变更，而调岗本身不该有这个副作用。

### 7.3 新建客户自动归到自己那一栏

`defaultAssignment(viewer)`：非全局账号建的客户，`designer` 角色写 `designer_id = 我`，`sales` 角色写 `sales_id = 我`，其余账号两栏皆空（进公共池）。

不加这一条的后果是设计师录完客户一刷新就「不见了」—— 因为新客户落进了公共池，而公共池不在他的范围内。

### 7.4 `SYSTEM_VIEWER` 与审计外键

命令行与内部回读用 `SYSTEM_VIEWER`，userId 是全零 UUID —— **它不是任何真实账号**。直接写进 `audit_logs.actor_id` 或 `customer_pool_suggestions.reviewed_by` 会撞外键：前者被 `recordAudit` 吞掉（主流程继续，但库里一条审计都没有，日志里只有一行「写入失败」），后者不吞、整次复核直接抛错。

`scope.ts` 的 `actorOf(viewer)` 统一收口：真实账号给 id，系统观察者只留名字快照（`actor.id` 类型放宽为 `string | null`）。

这个缺陷是被集成测试发现的，不是设计时想到的 —— 两处失败都表现为「看起来跑通了、痕迹没了」。

### 7.5 越权也要写审计

`recordDeniedAccess(id, viewer)`：行级越权时写一条 `customer.access.denied`，`result: 'failure'`。按 `result` 过滤时，越权尝试与正常读取必须分开，否则「有人在试别人的客户」会淹没在读记录里。

---

## 八、前端实现要点

| 位置 | 内容 |
|---|---|
| 列表 | 「归属」列（`AssignmentCell`，两栏都渲染）；`scopeKind === 'own'` 时顶部显示范围提示条 |
| 详情 | 「负责团队」区块：两栏徽标 + 编辑（两个下拉、原因必填、保存） |
| 公共池 | `CustomerPoolDialog`：顶部共用一个备注框，每行支持采用 / 调整 / 驳回，依据按 `weight` 降序 |
| 入口控制 | 「公共池归类」按钮要 `import.review` **且** `scope.write`（只判前者，点进去每个按钮都会 403） |

颜色一律走令牌类名（`border-input`、`text-muted-foreground`…），不写死 `gray-300` 之类：亮暗两套主题各有一份令牌，写死颜色等于只做了一半。

---

## 九、实现步骤（已完成的顺序）

1. 契约先行：`audit.ts` 三个动作码、`permissions.ts` 两个范围点 + 两个角色、`customer-api.ts` 全部 DTO。
2. 纯函数引擎 `customer-pool.ts` + 单测（先让规则可被断言，再接数据库）。
3. schema 双列 + 建议表 + 迁移 + `prisma generate`。
4. `scope.ts`（viewer / scopeWhere / roleOf / SYSTEM_VIEWER / actorOf）。
5. `customers.ts` 全链路加 `viewer`：列表、详情、订单、环节、阶段、归属调整。
6. `pool.ts` 归类、列表、复核、可指派名单。
7. 路由四条 + 失败码两项 + `requireViewer` 收口。
8. 前端：api / lib / display / 表格列 / 公共池对话框 / 页面块。
9. `pnpm db:seed` 同步 23 权限点与 6 角色。
10. 测试：改既有 3 个文件、新增 2 个文件。

---

## 十、边界情况处理

| 情况 | 处理 | 判据 |
|---|---|---|
| 设计师/销售打开别人的客户 | **404**，不 403 | 403 等于确认「这个 id 存在」，可以拿 id 枚举全库 |
| 两栏填了同一个人 | 允许，界面显示两行同名 | 小店里老板既谈单又画图是真实情况 |
| 账号被删 | 所在栏 `SetNull`，客户回到公共池 | 复核队列兜底；`SetNull` 而不是 `Cascade` |
| 新建客户 | 非全局账号自动归到自己那栏 | 否则「刚录完就不见了」 |
| 调整归属没填原因 | `missing_reason`（400） | 归属变更比阶段变更更需要说法 |
| 把销售记进 `designer_id` | `invalid_assignee`（400） | 不拦的话需求第 1 条会显示成「设计师和销售是同一个人」 |
| 复核没填备注 | `missing_reason`（400） | 依据是机器怎么想，备注是人怎么想 |
| 读不到群文件 | 置信度封顶 45 + `no-transcript` 依据 | 不假装算得准 |
| 最近 90 天无新消息 | 置信度封顶 60 + `stale` 依据 | 结论来自旧证据 |
| 一位客户说 500 次「多少钱」 | 单词计数封顶 20 | 否则判定退化成「谁刷屏谁赢」 |
| 有记录但零关键词命中 | 按阶段收口 | 只发了图片与地址的情况很常见 |
| 已复核的条目被重跑 | `skipped++`，不改状态与备注 | 复核是人签过的字 |
| 已落归属的客户被传进 `customerIds` | 查不到（`where` 两栏皆空），既不算也不跳过 | 「查不到」与「跳过」是两种状态，不能混成一个数 |
| 存档 58 位客户的归属 | **本期不默认归 owner**，全部落公共池 | 默认归 owner 等于把「没人负责」伪装成「老板负责」 |

---

## 十一、验收要点

### 11.1 自动化（已全绿）

| 文件 | 项数 | 守什么 |
|---|---|---|
| `packages/shared/test/customer-pool.test.mjs` | 16 | 判定规则本身（无记录、`deposited`、退款、平局、两道封顶、单词上限、子串计数、词表自检） |
| `apps/api/test/customer-scope.test.ts` | 17 | 越权 404、双角色两侧一致、金额不打码、改归属 403、公共池 403、归类三条路径、复核三出口、重跑不覆盖 |
| `apps/api/test/customer.test.ts` | 28 | 原有客户与订单行为不回归（观察者签名改写） |
| `apps/api/test/permission.test.ts` 等 | — | 权限点数量与角色集合 |

### 11.2 必须做的反例验证

「全绿」不等于验过。以下四条必须亲手塞违规项、确认断言真的变红、再恢复：

1. **去掉 `scopeWhere`** → 隔离用例必须变红（否则说明用例根本没走到范围条件）。
2. **把金额裁剪挪到取数路径** → 「自己名下金额不打码」必须变红（否则说明裁剪测的是别的东西）。
3. **`classifyPool` 改成无条件 upsert** → 「重跑不覆盖」必须变红。
4. **删掉 `keepSuggestionId`** → 复核「采用」后必须拿不到建议记录。

第 2 条是本文件最容易被写错的一条：只断言「列表有数据」的用例在裁剪写错时照样全绿。

### 11.3 手工核验

- `psql` 查 `permissions` 应 23 行、`roles` 应 6 行、`role_permissions` 合计 72 行，其中 designer 与 sales 各 **10** 条（`personal.*` 展开 6 条 + 客户段 4 条），owner 23、admin 20、member 6、viewer 3。
- 用设计师账号登录：列表只有自己的客户，顶部有范围提示条，看不到「公共池归类」按钮，直接请求 `/api/customers/pool` 得 403。
- 用销售账号打开同一位客户：`myRole` 为 `sales`，`designerName` 与设计师端看到的逐字相同。
- `audit_logs` 里 `customer.assignment.change` 一条不缺、`actor_id` 非全零 UUID。

### 11.4 上线注意

- **改权限点必须重建 `migrate` 与 `api` 两个镜像。** api 更隐蔽：owner 走代码常量 `[...ALL_PERMISSIONS]`（`guard.ts:89`），不查库 —— 旧镜像只返回旧清单，前端 `filterNavigation` 按 `module.` 过滤，结果是**整组静默消失、零报错、库全对**。
- `--build` 之后必须 `up -d --force-recreate`，否则等于没上。判据是响应头有 `etag`。

---

## 十二、未做与风险

| 项 | 为什么不做 / 风险 |
|---|---|
| 归类不上定时任务 | 产出是待办不是事实；自动跑会让队列自己变而没人知道 |
| 不做建议历史表 | 审计里已记每次复核的决定与备注；再堆版本没人会 join |
| 不做订单级归属 | 订单跟随客户；再加一列会产生「客户归 A、订单归 B」这种无法解释的状态 |
| 存量 58 位客户全落公共池 | 需要一次人工过一遍；不自动归 owner 是刻意的 |
| 规则引擎不含「谁在群里说话」 | 群文件只有发送人与内容，没有稳定的账号映射；靠这个判会把「客户自己发的量尺」算成设计师倾向 |
| `signals` 里存了聊天词频 | 属客户隐私，只有 `scope.read` 账号能通过接口看到；导出与日志里不得出现 |
