# 客户信息平台的行级权限方案（设计师 / 销售按归属隔离）

> ⚠️ **已被 `CUSTOMER-DUAL-ROLE-2026-11-02.md` 取代（同日）。**
> 本文的三条核心裁决里有两条被后续需求推翻：归属从**单列 `assignee_id`** 改为**双列 designer + sales**；`finance.read` 从「销售默认不给」改为「两个业务角色都发，金额保护移到行范围」。第三处改动是公共池从「业务角色不可见」改为「可见且可归类」。
> **本文仍有价值的部分**：§二 需求范围与边界、§八 越权拦截的响应语义（404 而非 403）、§十一 测试与验证要点、§十四 顺带发现的两处既有缺陷 —— 这些结论在新方案里被继承，没有被推翻。读代码实现请以新文档为准。

> 2026-11-02。状态：设计定稿，未开工（**已被取代，见上**）。
> 前置阅读：`CUSTOMER-CRM-IMPLEMENTATION-2026-10-28.md`（客户模块现状）、`QIANNIU-OPS-PERMISSION-2026-10-19.md`（权限点体系的第一份同类设计）、`CUSTOMER-CRM-IDENTITY-RULES-2026-10-29.md`（显示名规则）。
> 本文只回答「怎么改、改哪儿、怎么验证」，不复述已有实现。

---

## 一、结论摘要

需求的一句话版本：**让设计师与销售只能看到并修改自己名下的客户，系统要能证明这一点。**

这句话里藏着一个与现有体系不兼容的地方，方案的全部难点都在这里。现有的权限模型只有**动作维度**（`customer.record.read` 表示「能不能读客户」），而本次要的是**数据行维度**（「能读哪些行」）。维度不同，不能靠再加一个动作权限点表达。

三条裁决：

1. **范围做成第三维度，与动作正交。** 新增 `customer.scope.read` 与 `customer.scope.write` 两个权限点，含义是「范围覆盖全库」。不持有时范围自动收缩为本人。这样存量五个权限点的语义一个字都不用改，设计师拿到的仍然是 `record.read`，只是作用域变了。
2. **归属用单列 `assignee_id`，不做「设计师 + 销售」双列。** 归属主体是账号，与角色解耦。角色只决定权限模板，不决定能看哪些行。
3. **服务端一律返回 404，不返回 403。** 403 会让任意响应变成「这个 UUID 存在」的探针。拦截提示放在前端文案里，用一句话同时覆盖「不存在」与「不在你范围内」。

---

## 二、需求范围与边界

### 2.1 本期做

| 编号 | 内容 | 验收判据 |
|---|---|---|
| S1 | 客户表新增归属账号列、索引、迁移 | `\d customers` 可见 `assignee_id` 与组合索引 |
| S2 | 两个范围权限点，两个业务角色 | `permissions` 表 23 行，`roles` 表 6 行 |
| S3 | 列表七处统计统一按范围过滤 | 本人账号看到的 total / byStage / byScope / amountByScope 与 items 同源 |
| S4 | 详情、订单、环节、阶段四条读写下路径全部做归属校验 | 越权一律 404，且库中数据零变化 |
| S5 | 编辑字段白名单，越界字段返回 `field_not_allowed` | 提交 `reviewStatus` 被 400 拒绝 |
| S6 | 转派接口，仅范围写权限可用，写审计 | `audit_logs` 出现 `customer.assignee.change` |
| S7 | 前端归属列、编辑对话框、越权提示文案 | 设计师列表无「录入他人客户」入口 |
| S8 | 隔离用例与反例验证 | 去掉范围过滤后隔离用例必须变红 |

### 2.2 本期不做

- **不做双归属。** 一个客户只有一个负责人。销售签单后转给设计师，走转派。
- **不做订单级归属。** 订单跟随客户，因为一单必然属于一位客户，而客户已有归属。给订单再加一列会产生「客户归 A、订单归 B」这种无法解释的状态。
- **不做字段级历史版本。** 改档案仍不写审计，只有归属变更写。
- **不做「按部门」范围。** `users.department` 是展示标签，schema 注释已明确它不参与授权。把它接进范围判断，会让调岗变成一次授权变更。
- **不动案例库的共享语义。** 案例库全账号共用是明确要求，与客户隔离方向相反，两者不冲突，理由见 3.4。

### 2.3 与既有文档的冲突处理

`apps/api/src/customer/customers.ts` 顶部注释写着「这里没有所有权参数，隔离由权限点承担」。本文修订这一条：隔离由「权限点 × 归属范围」共同承担。该注释必须同步改写，否则下一个读代码的人会按旧结论把 `where` 里的归属条件删掉。

---

## 三、归属模型

### 3.1 字段定义

```prisma
model Customer {
  // ... 既有字段

  /// 归属账号。null 表示公共池，只有持 customer.scope.read 的账号可见。
  /// SetNull 而非 Cascade：账号删了，客户要留下，只是回到未分配。
  assigneeId String? @map("assignee_id") @db.Uuid
  assignee   User?   @relation("CustomerAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)

  /// 组合索引的列序与列表查询一致：先按归属过滤，再按最近消息排序。
  /// 只建单列索引时，Postgres 仍要对结果做一次排序。
  @@index([assigneeId, lastMessageAt])
}

model User {
  /// 这个账号名下的客户。与 caseFolders 那组是两条不同关系，必须命名区分。
  assignedCustomers Customer[] @relation("CustomerAssignee")
}
```

迁移 `20261102120000_customer_assignee`，内容为加列、加外键、加索引三句。**不改任何存量行**，回填单独作为运维步骤（见第十章）。

### 3.2 归属判定规则

判定「本人客户」的充要条件只有一条：

```
customer.assignee_id = 当前登录账号 id
```

不按角色、不按部门、不按微信群成员、不按创建人。四条排除理由：

- **不按角色。** 角色是权限模板，同一角色可以有多个账号，按角色判定等于「所有设计师共享一份客户」，与需求相反。
- **不按部门。** 见 2.2。
- **不按创建人。** 创建人是一次性事实，归属人可变更，用创建人判定会让转派失效。
- **不按微信群成员。** 群成员列表需要调微信接口，服务端没有该数据，且群成员变化与业务归属无关。

两条例外规则：

- **`assignee_id IS NULL` 视为公共池。** 只有持 `customer.scope.read` 的账号可见。这样导入进来尚未分配的历史数据不会消失，也不会被某个设计师顺手认领。
- **复购链不传递归属。** `repeat_of_id` 只表达「这单是那位客户的复购」，两个客户行各自独立归属。转让首单不自动转让复购。

### 3.3 为什么是单归属

业务上确实存在「销售签单、设计师做方案」两人跟同一客户的情形。双列方案（`designer_id` + `sales_id`）能覆盖这种情形，代价有三条：

1. **可见性变并集，责任变交集。** 两人都能看，但「这条电话是谁改的」无法归属。改档案是低频动作，出错时却没有追溯依据。
2. **编辑冲突成为常态。** 两人同时打开详情，后者覆盖前者，且不报错。
3. **字段会继续膨胀。** 今天加设计师与销售，明天加售后与拆单，`customers` 表会变成一张岗位表。

单归属 + 转派覆盖的是「同一时间一个人负责」。真实协作场景里，另一方的诉求通常是「看进度」而非「改档案」。看进度这份需求将来由订单只读分享或协作人表承接，那时按真实诉求加，而不是现在预判。

留的扩展位：`customer_collaborators` 表的位置在本文预留，触发条件是「出现两人同时需要推进十四环节」的真实案例。届时可见范围为「归属 ∪ 协作」，编辑范围仍只有归属人。

### 3.4 与案例库共享语义为什么不冲突

案例库是素材，共享有净收益（小阳传的图阿阳能直接用，不必重传）。客户档案是责任田，共享有净损失（抢单、离职带走完整客户清单、隐私泄露）。两者的差别在于数据的**复用价值**与**归属价值**哪个更大，不来自技术一致性。这一点要在注释里写明，否则后来者会以「案例库都共享了」为理由改回去。

---

## 四、账号与角色绑定

### 4.1 新增两个内置角色

在 `packages/shared/src/permissions.ts` 的 `ROLES` 追加：

| code | 名称 | rank | grants |
|---|---|---|---|
| `designer` | 设计师 | 20 | `personal.*`、`customer.record.read`、`customer.record.write`、`customer.order.write` |
| `sales` | 销售 | 20 | 同设计师 |

不给的三项及理由：

- `customer.finance.read`：合同额与回款是经营机密。需要时由 owner 在账号上单独授予，这条路径 `user_permissions` 已支持。
- `customer.import.review`：复核是把几百条机器猜测变成正式档案，比逐条录入危险，不随角色发放。
- `customer.scope.read` / `scope.write`：这两个点是本次隔离的开关，发给业务角色等于隔离失效。

rank 取 20 的理由：rank 只用于「能不能管理比自己低级的账号」，而这两个角色不持有任何 `system` 段权限，实际管理能力为零。取 20 是为了让排序落在 viewer(10) 与 member(50) 之间，**不要**据此推断设计师能管理只读访客。

### 4.2 角色与归属解耦

三句话讲清绑定关系：

1. 账号通过 `users.role_id` 持有一个角色，角色决定**权限模板**（能做什么动作、范围多大）。
2. 客户通过 `customers.assignee_id` 指向一个账号，决定**归属**（这个客户算谁的）。
3. 两者互不推导。设计师角色不等于「名下必有客户」，member 角色也不等于「不能有客户」。一个 member 若被单独授予 `record.read/write` 并承接客户，他的行为与 designer 完全一致。

这条解耦是刻意的。若把角色接进归属判断，「给某人调岗」就会连带改变他能看哪些客户，而调岗本身不该有这个副作用。

### 4.3 一人兼两职的处理

本期不支持。`users.role_id` 是单值，schema 注释已写明「需要多角色时加 `user_roles` 关联表」。

现实中的过渡做法：给这个人 `sales` 角色（拿到读写与归属），再在账号上单独授予他作为设计师需要的额外点。归属仍只有一个，因为客户只有一个负责人。真的出现「一人负责两批不相关客户」时不需要额外机制，本来就是一个账号。

---

## 五、权限点设计

### 5.1 两个新点

```ts
CUSTOMER_SCOPE_READ: 'customer.scope.read',   // 查看全部客户（跨归属）
CUSTOMER_SCOPE_WRITE: 'customer.scope.write', // 编辑全部客户，并可将客户转派给他人
```

命名必须遵守三段式，`PERMISSION_CATALOG` 在模块加载期会断言 `parts.length === 3`，写成 `customer.record.read_all` 会直接抛错。`scope` 作为对象段，语义是「数据范围」，与 `record`（档案实体）、`order`（订单实体）并列。

### 5.2 两个维度的组合语义

```
能进页面且能读     = customer.record.read
能读哪些行         = 持 scope.read 时全库，否则仅 assignee_id = 本人
能改档案           = customer.record.write ∧ 行在可读范围内
能看金额           = customer.finance.read（字段级，与行范围正交）
能推进环节/阶段     = customer.order.write ∧ 行在可读范围内
能转派归属         = customer.scope.write
能复核导入         = customer.import.review（本期仅全局角色持有）
```

### 5.3 权限矩阵

| 账号形态 | record.read | record.write | order.write | finance.read | scope.read | scope.write | 可见行 | 可改行 |
|---|---|---|---|---|---|---|---|---|
| owner | 有（代码常量短路） | 有 | 有 | 有 | 有 | 有 | 全部 | 全部 |
| admin | 有 | 有 | 有 | 有 | **本期补** | **本期补** | 全部 | 全部 |
| designer / sales | 有 | 有 | 有 | 无 | 无 | 无 | 本人 | 本人 |
| member + 单独授予 | 按授予 | 按授予 | 按授予 | 按授予 | 无 | 无 | 本人 | 本人 |
| member 未授予 | 无 | 无 | 无 | 无 | 无 | 无 | 不可进 | 不可进 |

**admin 那两个「本期补」是最高优先级的落地动作。** 现有 admin 已持有客户段全部五点，一旦开启行级过滤而不补 `scope.read`，admin 会立刻变成「只能看自己名下」，而 admin 名下通常没有任何客户，表现是全公司管理员打开客户平台看到空列表，且零报错。这与运维看板首版「裁判断写在取数路径上，管理员也看不到金额而 KPI 正常」是同一类故障。补权限点必须与开启过滤在同一个提交里，不能拆两次上线。

### 5.4 范围计算的实现

```ts
/** 客户行的可见范围。三种取值互斥且完备。 */
export type CustomerScope = { kind: 'all' } | { kind: 'own'; assigneeId: string }

function resolveCustomerScope(request: FastifyRequest): CustomerScope | null {
  const context = request.authContext
  if (context === null) return null                    // 未认证，由守卫先拦
  if (hasPermission(context.permissions, PERMISSIONS.CUSTOMER_SCOPE_READ)) {
    return { kind: 'all' }
  }
  return { kind: 'own', assigneeId: context.userId }
}
```

要点两条：

- **只认权限点，不认 `roleCode`。** 写 `roleCode === 'owner'` 会在「给某个成员单独授予范围点」时失效，而那种授予正是本设计的目的。
- **返回 `null` 而非退化成 `own`。** 判空方向决定了一旦守卫出问题，结果是「拒绝」还是「按本人放行」。取拒绝。

---

## 六、服务端实现

### 6.1 范围条件下沉到 where 构造器

`buildCustomerWhere` 是全模块唯一的口径入口，列表、总数、阶段分布、地区分布、金额汇总、新增计数、活跃度分桶七处共用。范围条件加在这里，一处改动覆盖七处，不会出现「列表筛了、KPI 没筛」这类自相矛盾的画面。

```ts
export type CustomerListFilter = {
  // ... 既有字段
  /** 行级范围。**必填**，理由见下。 */
  scope: CustomerScope
}

export function buildCustomerWhere(filter: CustomerListFilter): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = {}
  if (filter.scope.kind === 'own') where.assigneeId = filter.scope.assigneeId
  // ... 既有条件
  return where
}
```

**`scope` 设成必填而不是可选，这是本方案最重要的一行类型设计。** 做成可选时，新增一个调用点忘了传，编译器不报错，运行时静默放开全库，而界面上看不出任何异常。必填把「每个调用点必须表态」变成编译期约束。代价是既有测试与 `customer-sync` 工具要逐处补参数，这份代价正好等于一次强制复核。

### 6.2 单条读取改 findFirst

```ts
// 旧：findUnique({ where: { id } })
const row = await prisma.customer.findFirst({
  where: { id, ...scopeWhere(scope) },
  select: DETAIL_SELECT,
})
if (row === null) return { ok: false, reason: 'not_found' }
```

`findFirst` 与 `findUnique` 的性能差别可以忽略（都走主键或归属索引）。用后者再在内存里判归属，会让「存在但不属于你」这条路径多一次无谓的查询，且容易在某个分支漏判。

### 6.3 五条写路径统一前置校验

现状有五个写入口，其中三个缺归属校验：

| 函数 | 现状 | 本期 |
|---|---|---|
| `updateCustomer` | 只判存在 | 加范围 |
| `createOrder` | 只判客户存在 | **补范围**（现存漏点） |
| `updateStep` | 校验订单属于该客户 | 补范围 |
| `setStage` | 只判存在 | 补范围 |
| `insertCustomer` | 无 | 由调用方传 `assigneeId` |

做法是在 `customers.ts` 里加一个内部函数，五个入口开头统一调用：

```ts
/** 取一条在当前范围内可见的客户。不可见与不存在同形返回 null。 */
async function findScopedCustomer(
  id: string,
  scope: CustomerScope,
): Promise<{ id: string; stage: string; realName: string | null; region: string } | null>
```

**校验顺序必须是范围优先。** 若先校验字段再判归属，两次响应（400 字段不合法 / 404 不存在）的差异会泄露「这个客户确实存在，只是不属于你」。顺序错了不会有任何测试红，只能靠评审发现。

### 6.4 编辑字段白名单

现状 `UPDATE_BODY_SCHEMA` 接受六个字段，而 `updateCustomer` 只处理五个（`project` 被静默丢弃，见第七章的既有缺陷）。本次把「哪些字段谁能改」显式化，越界返回 400 而不是静默忽略，静默忽略会让用户以为保存成功。

| 字段 | 本人范围 | 全局范围 | 额外门槛 |
|---|---|---|---|
| `realName` | 可改 | 可改 | 无 |
| `region` | 可改 | 可改 | 无 |
| `phone` | 可改 | 可改 | 无 |
| `primaryNickname` | 可改 | 可改 | 无 |
| `reviewStatus` | 拒绝 | 可改 | `customer.import.review` |
| 金额三列 | 拒绝 | 拒绝 | 本期无编辑接口，保持拒绝 |
| 归属账号 | 拒绝 | 走转派接口 | `customer.scope.write` |

```ts
/** 四个身份字段对两种范围都开放。范围决定「能改哪些行」，字段集决定「能改行里的哪些列」，两者正交。 */
const IDENTITY_EDITABLE = ['realName', 'region', 'phone', 'primaryNickname'] as const

function allowedFields(canReview: boolean): ReadonlySet<string> {
  const fields = new Set<string>(IDENTITY_EDITABLE)
  if (canReview) fields.add('reviewStatus')
  return fields
}
```

注意签名里**没有** `scope` 参数。这是刻意的：范围已经在 `findScopedCustomer` 那一步决定了这一行能不能碰，再让范围影响字段集，就等于同一条规则写在两个地方，两处漂移时的表现是「全局账号反而改不了某个字段」。

新失败原因 `field_not_allowed`，映射 400，文案「该字段不在你的可编辑范围内」。**不要**用 403，403 在这一层会把「字段级拒绝」与「行级越权」混成同一个码，前端无法区分要不要重新拉详情。

### 6.5 转派接口

```
POST /api/customers/:id/assignee
preHandler: requirePermission(PERMISSIONS.CUSTOMER_SCOPE_WRITE)
body: { assigneeId: string | null, reason?: string }
```

四条约束：

1. 目标账号必须存在、未软删、`status = active`。指向一个停用账号等于把客户扔进黑洞。
2. `reason` 在 `assigneeId` 发生变化时必填，与阶段回退同一条理由，归属变更比阶段变更更需要说法。
3. 写 `AuditLog`，`action = 'customer.assignee.change'`，`detail` 记 `{ from, to, reason }`，`targetType = 'customer'`。
4. 禁止把客户转给自己名下的自己，即 `assigneeId === 当前 id` 且原值相同，视为无变化直接返回，不报错也不写审计。

**禁止设计师调这个接口**，即便他篡改了请求体。否则最典型的越权路径成立：把别人的客户划到自己名下，之后一切读写都合规。这是整条链上唯一能「合法化」越权的入口，必须只由范围写权限持有者调用。

### 6.6 越权尝试写审计

`requirePermission` 已经对 403 记日志，但行级越权走的是 404，日志里看不出来。加一条：

```ts
await writeAudit({
  action: 'customer.access.denied',
  targetType: 'customer',
  targetId: id,
  result: 'denied',
})
```

只在「`findScopedCustomer` 因范围失败」时写，不区分「id 根本不存在」这一支，因为服务端自己也不该去分辨，分辨就等于承认存在性可被推断。这条记录的唯一用途是发现「有人在按 id 顺序试探」。

---

## 七、前端实现

### 7.1 入口控制

三层，各管一段，不互相替代。

1. **侧栏。** `NAV_ITEMS` 里客户两项仍绑 `module: 'customer'`，只要有任意 customer 段权限点即可见。不为设计师单独加导航项。
2. **页面顶部。** 本人范围的账号在标题下方显示一行说明：「当前显示你负责的 12 位客户。需要查看其他客户请联系管理员转派。」这句话必须存在，因为列表被静默缩小后，用户的第一反应是「数据丢了」。
3. **行内操作。** 列表已按范围过滤，因此 `canWrite` 为真时每一行都可编辑，不需要逐行判断归属。**不要**在前端再算一遍 `assigneeId === me`，那会把授权规则复制到第二个地方，而两处不一致时的表现是「按钮不见了但没报错」。

### 7.2 列表新增归属列

`CustomerListItemDto` 增加两个字段：

```ts
/** 归属账号 id。null 表示公共池。 */
assigneeId: string | null
/** 归属账号显示名。列表要能看出「这是谁的客户」，只给 id 等于不给。 */
assigneeName: string | null
```

展示规则下沉到 `apps/web/src/lib/customer-display.ts` 的纯函数：

```ts
export function assigneeLabel(name: string | null, isMe: boolean): string {
  if (name === null) return '未分配'
  return isMe ? `${name}（我）` : name
}
```

写在组件里只有开浏览器才能验，写成纯函数可以进单测。

列只在全局范围的账号上渲染。判断依据用服务端下发的字段而非本地权限计算：`data.items.some(row => row.assigneeId !== null)` 不够可靠，改为在 `CustomerListResponse` 加一个 `scopeKind: 'all' | 'own'`，由服务端算好。理由与 `financeReadable` 完全相同，前端不重复计算授权。

### 7.3 编辑对话框

现状客户详情只有阶段推进与环节勾选，**没有档案编辑表单**，`PATCH` 接口处于「有接口无入口」状态。本次补一个「编辑档案」按钮与对话框，字段与白名单一致：

- 本人范围渲染四个输入框（姓名、地区、电话、微信昵称）。
- 全局范围额外渲染 `reviewStatus` 下拉（仅持 `import.review` 时）。
- 归属账号字段**不放这里**，放在独立的小区块「负责与转派」，因为它需要另一个权限点，混进档案表单会让整张表单的提交语义变复杂。

### 7.4 越权提示文案

详情加载失败时，`describeFailure` 目前会把后端 message 原样显示。本次要求后端把 `not_found` 的文案改成：

> 客户不存在，或不在你的负责范围内。

这一句同时覆盖两种真实情况，不泄露存在性。前端的 `customer-display.ts` 里再包一层，供「从外部链接直接带到某 id」的场景使用：

```ts
export function describeCustomerMiss(): string {
  return '没找到这位客户。链接可能已失效，或该客户由其他同事负责，需要跟进请联系管理员转派。'
}
```

---

## 八、越权拦截的响应语义

三种情况必须能区分，否则前端无法给出正确提示：

| 情况 | 状态码 | 码 | 前端表现 |
|---|---|---|---|
| 未登录 | 401 | `unauthorized` | 跳登录 |
| 无 customer 段任何权限 | 403 | `forbidden` | 侧栏无入口；直接访问显示无权限页 |
| 有权限但行不在范围内 | 404 | `not_found` | 详情弹窗显示 7.4 的文案 |
| 字段越界 | 400 | `field_not_allowed` | 表单内红字，保留已填内容 |

**为什么行级越权用 404。** 用 403 时，攻击者遍历 UUID 就能从「403 还是 404」区分出哪些客户真实存在。客户档案包含姓名、电话、微信昵称与全年聊天摘要，这份存在性本身就有价值。返回 404 让两种响应完全同形。

代价是用户体验上「打错了 id」与「无权访问」看不出区别。这个代价用文案一次性覆盖，比泄露存在性划算得多。

---

## 九、权限配置的维护方式

### 9.1 两层结构不变

| 层 | 载体 | 谁改 | 生效时机 |
|---|---|---|---|
| 角色模板 | `ROLES` 常量 → `db:seed` 同步 | 开发，随版本发布 | 下次请求 |
| 账号覆盖 | `user_permissions` 表 | owner 在「系统设置 · 账号」里勾选 | 下次请求 |

账号级覆盖的界面已存在（`UsersPage` 的权限对话框），本次不新增界面。**需要新增的是「某人名下的客户数」与「批量转派」入口**，建议挂在账号详情，不挂客户列表，理由是离职交接这个动作的起点是「人」，从账号页发起更顺。

### 9.2 变更操作顺序

新增或调整权限点时的固定顺序，缺一步就会出「权限配了不生效」：

1. 改 `packages/shared/src/permissions.ts`（权限点与角色定义两处）。
2. `pnpm --filter @fanhe/shared build`。**必须先生成 shared 的 dist**，`db:seed` 读的是编译产物。
3. `pnpm db:seed`。差集同步会把不在 `ROLE_PERMISSIONS` 里的旧授权删掉，因此手工在库里加的行会消失。
4. 重建镜像。`api` 与 `migrate` 两个都要重。
5. 跑一遍 `/api/system/permissions`，确认返回里出现新点。

### 9.3 三处已知暗坑

- **owner 走代码常量。** `guard.ts:89` 对 owner 直接返回 `[...ALL_PERMISSIONS]`，不查库。因此新点对 owner 天然可用，即便库里缺行。这条会让「本地 owner 测通了」变成假阳性，验证必须用非 owner 账号。
- **api 镜像必须重建。** 旧镜像只返回旧权限清单，前端 `filterNavigation` 按 `module.` 过滤，结果是整组静默消失、零报错、库全对。这个坑在 2026-10-19 运维权限上线时踩过一次。
- **迁移未跑会表现为 P2021。** 桌面端安装版连的是容器，容器里的 `_prisma_migrations` 必须与新代码一致，否则整片 500，日志里是表不存在，与权限毫无关系。

---

## 十、存量数据回填与两步上线

这是本方案风险最高的一节。现有 58 位客户**没有任何负责人信息**（`tools/crm` 与 `apps/api/src/tools` 里检索 `负责人`、`designer`、`sales` 均无结果）。

如果先加过滤再生效，上线瞬间所有非全局账号看到空列表。这个故障的特征是**零报错、零日志、界面正常渲染一个空表格**，与「这批客户确实没了」无法区分。

### 10.1 两步上线

| 阶段 | 内容 | 此时行为 | 可否独立上线 |
|---|---|---|---|
| A | 加列、加索引、加权限点、加角色、加转派接口 | 与现在完全一致，不过滤 | 可 |
| B | 开启 `where` 过滤与 404 语义 | 按归属隔离 | 必须在回填完成后 |

A 阶段做完，转派接口就已经可用，可以先在真实环境里把归属分配好，再上 B。这条「影子上线」是本方案能否安全落地的关键，不建议合并成一次。

### 10.2 回填策略

三档，按可得信息依次退化：

1. **有明确负责人记录的**，按记录回填。来源优先顺序为聊天记录里客户点名的对接人、订单看板里的经办人、Excel 台账的负责人列。
2. **无记录但能按群名归类的**，归到常用对接人。这一步必须人工过一遍，不能由脚本推断。
3. **其余一律留 `null` 进公共池**，由 owner 转派。**不要**默认归到 owner 名下，那会把「未分配」伪装成「已分配」，一周后没人说得清哪些是真的没分。默认归 owner 的唯一好处是「列表有数据」，而它掩盖的正是需要被看见的问题。

### 10.3 回填脚本

`apps/api/src/tools/customer-assign.ts`，接受一份 `{ chatroom | displayName, username }` 的映射文件，`--dry-run` 输出将改哪些行，`--apply` 执行。与既有 `customer-sync.ts` 同一套写法，`--dry-run` 与 `--apply` 共用同一份校验函数，否则干跑说没问题、真跑报错，是最难解释的一类不一致。

---

## 十一、测试与验证要点

### 11.1 单元（`packages/shared/test/`）

| 用例 | 断言 |
|---|---|
| `scope` 条件注入 | `kind: 'own'` 时 where 必含 `assigneeId` 且等于入参；`kind: 'all'` 时 where 不含该键 |
| 权限点三段式 | `PERMISSION_CATALOG` 加载不抛错，`customer.scope.read` 拆分得 `customer/scope/read` |
| 角色展开 | `designer` 的 `ROLE_PERMISSIONS` 恰好 5 项，不含 `finance.read`、`scope.*`、`import.review` |
| 归属展示 | `assigneeLabel(null, false)` 返回「未分配」；`assigneeLabel('小阳', true)` 返回「小阳（我）」 |

### 11.2 集成（`apps/api/test/customer-scope.test.ts`）

每条都是「A 账号读 B 账号的客户」，断言一律为 404 与「库中数据未变」。**断言 404 的同时必须断言数据零变化**，只断言状态码会漏掉「返回 404 但已经写进去了」这种实现错误。

| 编号 | 场景 | 期望 |
|---|---|---|
| T1 | A 读 B 的客户详情 | 404，`error = 'not_found'` |
| T2 | A 的列表不含 B 的客户 | `items` 与 `total` 都不含 |
| T3 | A 的 `byStage` / `byScope` / `amountByScope` 只统计 A 的客户 | 三处数字相加等于 `total` |
| T4 | A 改 B 的客户电话 | 404，且 B 的客户 `phone` 原值不变 |
| T5 | A 给 B 的客户建订单 | 404，且 `customer_orders` 行数不变 |
| T6 | A 推进 B 的客户阶段 | 404，且 `stage` 与 `stage_updated` 均不变 |
| T7 | A 勾选 B 的客户环节 | 404，且 `customer_order_steps` 未变 |
| T8 | A 调转派接口 | 403（没有 `scope.write`） |
| T9 | A 提交 `reviewStatus` | 400，`error = 'field_not_allowed'` |
| T10 | 全局账号读全部 | 两个账号的客户都在 |
| T11 | 公共池客户对 A 不可见，对全局账号可见 | 前者 404，后者 200 |
| T12 | 新建客户时 body 夹带 `assigneeId` 指向 B | 被忽略，实际归属仍为 A |
| T13 | 转派后原负责人立刻看不到 | 404；新负责人 200 |
| T14 | 转派停用账号 | 400 |
| T15 | 转派写审计 | `audit_logs` 有 `customer.assignee.change` 且 `detail.from/to` 正确 |
| T16 | 越权尝试写审计 | `audit_logs` 有 `customer.access.denied` |

### 11.3 HTTP 层（走真实路由）

| 用例 | 断言 |
|---|---|
| 未登录读、写、改 | 401（既有用例保留） |
| member 无任何 customer 点 | 403，**这次要造真实令牌** |
| designer 令牌访问他人客户 | 404，响应体不含该客户任何字段 |
| 列表响应含 `scopeKind: 'own'` | 前端据此渲染「仅显示本人」提示 |
| 未加载的字段名进 body | 400 `FST_ERR_VALIDATION`（防止前端加了字段忘了改 schema） |

第三条的令牌要真造，因为行级过滤让「有权限但看不到」成为常态，403 与「空列表」必须能区分。现有 `customer.test.ts` 注释里写着「不验证 member 拿到 403」，那条前提已被本次改动推翻，需要放开。

### 11.4 反例验证（强制）

「全绿不等于验过」。下列三项必须逐条做，做完恢复：

| 反例 | 注入方式 | 期望变红的用例 |
|---|---|---|
| C1 | 删掉 `buildCustomerWhere` 里的 `assigneeId` 条件 | T2、T3 |
| C2 | 把 `findScopedCustomer` 的范围判断改成恒真 | T1、T4、T5、T6、T7 |
| C3 | 把 `not_found` 改成 403 | HTTP 层第三条（存在性泄露断言） |

C2 只做一次不够，要分别对 `createOrder` 与 `updateStep` 各做一次，因为这两条路径的校验是后补的，最容易在重构时丢。

### 11.5 门禁

顺序不变，`test` → `lint` → `typecheck` → `format:check`，在 `projects/fanhe-work` 下跑且数据库容器在运行。

本次改动会让基线从 1194 项上升，新增用例数要写进提交说明。权限点从 21 变 23，`setup.test.ts` 与 `permission.test.ts` 里断言总数的用例要同步。

---

## 十二、风险清单

| 编号 | 风险 | 触发条件 | 判据 | 缓解 |
|---|---|---|---|---|
| R1 | 静默归零 | 先开过滤后回填 | 非全局账号列表为空且无报错 | 两步上线（第十章） |
| R2 | 管理员失明 | 补权限点与开过滤拆两次发布 | admin 看到空列表，库中数据正常 | 同一提交内完成 |
| R3 | 整组菜单消失 | api 镜像未重建 | 侧栏客户组整块不见，库里权限行齐全 | 强制重建 api 与 migrate |
| R4 | 统计口径分裂 | 只过滤 items 未过滤 total | 界面「共 58 位，当前显示 12 位」 | 范围条件只在 `buildCustomerWhere` |
| R5 | 写路径漏校验 | 新增写接口未调 `findScopedCustomer` | T5/T7 类用例缺失 | 下沉到 service 层 |
| R6 | 复购链弱泄露 | 首单与复购分属不同人 | 列表显示「有复购」但看不到那位客户 | 接受，记录为已知 |
| R7 | 探针 | 越权返 403 | 遍历 UUID 可分辨存在性 | 统一 404 |
| R8 | 迁移未跑 | 桌面端连旧容器 | 整片 500，`P2021` | 发版检查迁移数 15 |

R6 的取舍要写清楚：`_count.repeats` 是关系计数，不受 `where` 影响，因此本人范围内的客户如果有一条范围外的复购，`hasRepeat` 会为真而那条复购不可见。泄露的信息量是「有人复购了」，业务上无价值，且修它要改写整个复购标记逻辑（把计数改成子查询），成本与收益不成比例。接受，并在注释里标注。

---

## 十三、实施顺序

| 阶段 | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| P0 | 加列、索引、迁移 | `20261102120000_customer_assignee` | 无 |
| P1 | 两个权限点、两个角色 | `permissions.ts` + seed 通过 | 无 |
| P2 | DTO 加三字段 | `customer-api.ts` | P0 |
| P3 | 转派接口 + 审计 | `routes/customers.ts` | P0、P1 |
| P4 | 回填脚本与实跑 | `customer-assign.ts` + 归属分配完成 | P1、P3 |
| P5 | 范围下沉（`scope` 必填） | `customers.ts`、`buildCustomerWhere` | P2 |
| P6 | 404 语义与越权审计 | `customers.ts` | P5 |
| P7 | 前端列、编辑框、提示 | `CustomerPage.tsx`、`customer-display.ts` | P2、P5 |
| P8 | 用例与反例 | 新增测试文件 + 门禁全绿 | 全部 |

P5 是唯一不可回滚的一步（它会改变所有人的可见范围）。上线前必须确认 P4 完成，且 `assignee_id IS NULL` 的行数在可解释范围内。

---

## 十四、顺带发现的两处既有缺陷

评审时看到，与本次改动相邻，建议一并处理，但不阻塞主线。

### 14.1 `project` 是死字段

`CreateCustomerRequest` 有 `project`，`insertCustomer` 用它拼 `displayName`（`customerDisplayName(region, realName, project)`），但 `customers` 表**没有 project 列**。后果有两处：

1. `UPDATE_BODY_SCHEMA` 接受 `project`，`updateCustomer` 完全忽略它，静默丢弃。用户填了不生效，无提示。
2. 改名或改地区时，`updateCustomer` 重算 `displayName` 只传两个参数，**项目后缀直接丢失**。例如「秦皇岛肖女士（阿那亚三期）」改一次地区会变成「秦皇岛肖女士」，而这是不可逆的信息损失。

修法二选一：加 `project` 列并在 `updateCustomer` 里参与重算；或删掉 `project` 入参，接受显示名不可再生成。倾向第一种，因为复购与多项目是真实业务形态。

### 14.2 客户段完全没有审计

`customers.ts` 顶部注释明确写着「不写审计」。这在本期之前成立，因为改一个电话的影响不出这个客户。一旦客户档案按人隔离，它就变成了「谁把客户划走了」这个必须回答的问题。

本期只加归属变更与越权尝试两条，其余维持不写。全线审计放到金额编辑接口做出来时一并补，那时才真正出现「把 16.8 万改成 0」这类需要追溯的改动。

---

## 十五、待确认

以下三项需要阿阳拍板，方案按括号内默认值继续：

1. **归属粒度**：一个客户一个负责人（默认），还是设计师与销售各挂一人。
2. **公共池可见性**：未分配客户是否让所有设计师可见（默认不可见，只有全局角色可见）。
3. **销售是否看金额**：默认不给 `finance.read`，按人单独授予。

第 2 项影响最大。若选「设计师可见公共池」，认领机制就是「转派给自己」，需要把 `scope.write` 的语义拆成「可认领」与「可转派他人」两点，预算要加。
