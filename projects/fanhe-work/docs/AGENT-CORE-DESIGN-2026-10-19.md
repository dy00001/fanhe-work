# Agent 内核设计规格
## 模型配置、工具调用与任务逻辑

> 版本：设计稿 v1，2026-10-19
> 上游方案：`AI-WORKBENCH-INTEGRATION-PLAN-2026-10-19.md`
> 范围：只描述机制与接口，不修改任何代码
> 目标读者：负责实现 `apps/api/src/agent/` 的服务端工程师

---

## 0. 三层职责边界

先把三件事分清楚，避免实现时相互污染。

```
┌───────────────────────────────────────────────────────────┐
│ 任务层 Task                                                │
│   跨回合的目标。有 DAG、有租约、有 Attempt、有验收。           │
│   一个任务由 N 个回合组成，任务自己不调用模型。                 │
├───────────────────────────────────────────────────────────┤
│ 回合层 Turn                                                │
│   一次用户输入到最终答复。驱动模型循环、工具调度、审批暂停。      │
│   回合是唯一会调用模型的地方。                                │
├───────────────────────────────────────────────────────────┤
│ 能力层 Tool / Model                                        │
│   无状态。工具是一次函数调用，模型是一次流式请求。              │
│   两者都不持有会话状态，也不感知任务。                         │
└───────────────────────────────────────────────────────────┘
```

三条边界规则。

规则一，只有回合层调用模型。任务层若需要模型判断（例如拆分步骤），它发起一个新回合，不直接调模型。

规则二，工具层无状态。工具不读会话、不读任务，只接受参数与一个受限上下文（用户、组织、桌面连接）。这让工具可以单测，也让权限判定集中在一处。

规则三，任务层不复制回合逻辑。任务把每个步骤交给回合执行，自己只管顺序、并发、重试与验收。

这三条对应 NomiFun 的 `AgentExecution` 与 `AgentSession` 分离，也对应 EvoFlow 把 collab 与 lead_agent 分成两个包的做法。两家独立收敛到同一结论，说明这条边界是必要的。

---

## 1. 模型配置

### 1.1 配置分层与优先级

四层，从粗到细，后者覆盖前者。

| 层 | 存在哪 | 谁维护 | 作用 |
|---|---|---|---|
| 组织级供应商 | `ModelProvider` 表 | 管理员 | 决定可用的 API 端点与密钥 |
| 组织级模型目录 | `Model` 表 | 管理员 | 决定可选的模型与能力快照 |
| 个人默认 | `User.defaultModelId` | 用户 | 新建会话时的默认值 |
| 会话覆盖 | `AgentSession.modelId` | 用户 | 单个会话临时换模型 |

解析函数只有一个入口，避免多处各写一遍。

```ts
function resolveModel(ctx: AgentContext): ResolvedModel {
  const id =
    ctx.session.modelId ??
    ctx.agentPreset?.modelId ??
    ctx.user.defaultModelId ??
    ctx.org.defaultModelId
  if (!id) throw new AgentError('NO_MODEL_CONFIGURED', '请先在设置里选择模型')
  const model = ctx.modelCatalog.get(id)
  if (!model || !model.enabled) throw new AgentError('MODEL_UNAVAILABLE', '模型已停用')
  return model
}
```

关键点在于 `ctx.modelCatalog` 在回合开始时一次性加载并冻结。回合进行中管理员改了模型配置，不影响这一回合。否则会出现"前半段用 A 模型、后半段用 B 模型"的诡异现象。

### 1.2 数据模型

```prisma
model ModelProvider {
  id           String   @id @default(uuid())
  orgId        String
  kind         String   // 'openai' | 'anthropic' | 'openai-compatible'
  label        String
  baseUrl      String
  apiKeyCipher Bytes    // AES-256-GCM，密钥来自服务端环境变量
  enabled      Boolean  @default(true)
  createdAt    DateTime @default(now())
  models       Model[]
}

model Model {
  id                String   @id @default(uuid())
  providerId        String
  modelId           String   // 供应商标识，如 'gpt-4.1'、'deepseek-chat'
  label             String
  contextWindow     Int
  maxOutput         Int
  supportsTools     Boolean
  supportsParallel  Boolean
  supportsVision    Boolean
  supportsStreaming Boolean
  priceInPerM       Decimal  @db.Decimal(10, 4)
  priceOutPerM      Decimal  @db.Decimal(10, 4)
  enabled           Boolean  @default(true)
  provider          ModelProvider @relation(fields: [providerId], references: [id])
}
```

### 1.3 能力快照，这是最容易漏的一处

同一个模型名在不同供应商下的能力并不一致。`gpt-4.1` 走官方 API 支持并行工具调用，走某些兼容网关可能只支持串行，甚至不支持工具。若运行时才发现，表现是"Agent 突然不会用工具了"，而日志里只有一次 400。

因此能力必须作为快照存在 `Model` 行上，由管理员在保存时确认，运行时只读快照，不做实时探测。

三条使用规则。

其一，`supportsTools === false` 时，该模型不能用于 Agent 会话，UI 上直接禁用，避免用户选了才发现。

其二，`supportsParallel === false` 时，即使模型一次返回多个 `tool_calls`，也按顺序串行执行。

其三，`contextWindow` 用于预算计算，不用于校验。超限时走压缩，避免直接报错。

### 1.4 密钥与脱敏

密钥只在服务端解密，生命周期限于一次请求。三条约束。

存储用 AES-256-GCM，主密钥来自 `FANHE_AGENT_SECRET` 环境变量，不落库。

读取接口只返回 `sk-****abcd` 形式的掩码，任何接口都不返回明文，包括管理员接口。

日志与审计里出现的任何 `Authorization` 头、`apiKey` 字段，写库前统一经过脱敏函数。梵禾已有 `AuditLog`，这条是它能否安全承载 Agent 审计的前提。

### 1.5 选择与降级

模型调用失败按错误类型分三类处理，不能一律重试。

| 错误类型 | 判定 | 处理 |
|---|---|---|
| 限流 | 429，或响应头带 retry-after | 退避重试，最多 3 次，间隔 1s / 3s / 8s |
| 服务端故障 | 5xx、连接超时 | 重试 2 次，仍失败则切备用模型 |
| 上下文超限 | 400 且 message 含 context length | 触发压缩后重试一次，不切模型 |
| 参数错误 | 400 其他 | 不重试，直接失败并把原文给用户 |
| 鉴权失败 | 401 / 403 | 不重试，标记该 provider 不可用并提示管理员 |

备用模型是可选项，由组织级配置 `fallbackModelId` 指定。切备用模型时必须在消息里告知用户，避免"回答风格突然变了但没人知道为什么"。

### 1.6 预算与压缩

每次请求前计算可用上下文。

```
available = contextWindow - maxOutput - systemPromptTokens - toolSchemaTokens
```

`toolSchemaTokens` 容易被低估。15 个工具的 JSON Schema 大约 3,000 至 5,000 token，接近一次短对话的量。工具越多，留给对话的空间越小，这也是工具必须分档加载的原因。

压缩策略按顺序触发。

第一步，工具结果截断。超过 8KB 的结果在回填模型前截断，完整内容存 `AgentArtifact`。

第二步，历史摘要。当已用超过 `available × 0.7` 时，把最早的若干回合压成一段摘要，保留最近 6 轮原文。

第三步，工具 Schema 裁剪。只注入当前档位可用的工具，不注入全量。

三档之外若仍超限，明确报错并建议新开会话。硬撑会导致模型输出质量骤降，比报错更伤体验。

---

## 2. 工具调用

### 2.1 注册表结构

```ts
type ToolTier = 'system' | 'read' | 'write' | 'local' | 'external'

interface ToolSpec {
  name: string
  tier: ToolTier
  description: string          // 给模型看的，决定它会不会用对
  schema: JSONSchema
  sideEffect: boolean
  requiresDesktop: boolean
  approval: 'never' | 'first-time' | 'always'
  timeoutMs: number
  concurrency: 'parallel' | 'serial'
  execute(ctx: ToolContext, args: unknown): Promise<ToolResult>
}

interface ToolContext {
  userId: string
  orgId: string
  sessionId: string
  turnId: string
  toolCallId: string
  desktop: DesktopChannel | null   // 桌面不在线时为 null
  signal: AbortSignal
}

type ToolResult =
  | { ok: true; summary: string; data?: unknown; artifacts?: string[] }
  | {
      ok: false
      code: 'INVALID_ARGS' | 'DENIED' | 'OFFLINE' | 'TIMEOUT' | 'NOT_FOUND' | 'FAILED'
      message: string
      retryable: boolean
      hint?: string
    }
```

`ToolResult` 的设计是整套机制里最关键的一处。工具永不抛异常，永远返回结构化结果。原因在 2.8 展开。

### 2.2 五个档位

EvoFlow 用七档，那是为多模式产品设计的。梵禾只需要五档。

| 档位 | 含义 | 示例 | 默认审批 |
|---|---|---|---|
| `system` | 会话骨架，始终注入 | `ask_user`、`plan_write`、`tool_search` | 否 |
| `read` | 只读业务数据 | `note.search`、`customer.get`、`event.list` | 否 |
| `write` | 写业务数据 | `note.create`、`customer.update` | 首次 |
| `local` | 操作本机 | `launch.start`、`launch.fill`、`screen.capture` | 每次 |
| `external` | 外部系统 | MCP 工具、HTTP 请求 | 首次 |

分档的实际作用有三个。控制注入给模型的工具数量，控制默认审批强度，控制角色可配置的范围（只有 `read` 与 `write` 对角色编辑器开放）。

### 2.3 一次调用的完整生命周期

```
模型流式返回 tool_calls
  → 累积 args delta，流结束后整体解析
  → 按 toolCallId 去重（重连重放时可能重复）
  → Schema 校验（ajv，additionalProperties: false）
  → 策略判定
      ① 角色是否有该工具权限
      ② 该档位是否需要审批，是否需要二次确认
      ③ requiresDesktop 时桌面是否在线、目标程序是否存在
  → 需要审批 → 回合转入 awaiting_approval，持久化，等待
  → 执行（并发或串行，见 2.5）
  → 结果整形（截断、脱敏、外置）
  → 写 AgentToolCall 与 AgentEffect
  → 以 tool 角色消息回填
  → 进入下一轮模型调用
```

有四个顺序不能颠倒。

Schema 校验必须在策略判定之前。否则一个参数非法的 `launch.start` 会先弹审批框，用户点了允许才发现参数错了。

权限判定必须在审批之前。否则用户会被要求审批一个他本来就无权执行的操作。

桌面可用性判定必须在审批之前。否则用户批准了一个根本执行不了的动作。

效果回执必须在结果回填之前写。否则进程崩溃时，模型已经拿到"成功"，而系统不知道到底做没做。

### 2.4 权限三重判定

梵禾已有角色权限体系，Agent 的工具权限必须复用，不能另建一套。

```ts
function authorize(spec: ToolSpec, ctx: AgentContext): Decision {
  if (!ctx.permissions.has(`assistant.tool.${spec.tier}`)) {
    return deny('DENIED', '当前角色未开放该能力')
  }
  if (spec.tier === 'local' && !ctx.desktop) {
    return deny('OFFLINE', '该操作需要你的电脑在线')
  }
  if (needsApproval(spec, ctx)) {
    return ask('需要确认')
  }
  return allow()
}
```

`needsApproval` 的判据。

`approval === 'always'` 时总是询问。`'first-time'` 时查个人偏好表里是否已有"总是允许该工具"的记录。`'never'` 时直接放行。

个人偏好按 `(userId, toolName)` 存，不按角色存。理由是信任是个人的，管理员不该替所有人做这个决定。

### 2.5 并发与串行

一条规则，同一批 `tool_calls` 里只要有一个是副作用工具，整批串行。全是只读工具时并发，上限 4。

理由很直接。并发的副作用工具会产生无法预期的交错，例如同时启动两个程序，前台窗口归属不确定，后续填表会填错窗口。梵禾的 `launch-login-click` 依赖前台校验，这类交错会直接导致失败。

实现上给每个 `ToolSpec` 标 `concurrency`，调度器取整批的最小值。

### 2.6 幂等与副作用

副作用工具必须携带幂等键，键由 `turnId + toolCallId` 生成。执行前查 `AgentEffect`，命中则直接返回上次结果，不重复执行。

这条规则解决的是恢复场景。服务重启后重放回合，若没有幂等键，会重复启动程序或重复发消息。

`AgentEffect` 的状态只有四种。

| 状态 | 含义 | 恢复时如何处理 |
|---|---|---|
| `pending` | 已下发，未确认 | 询问用户，不自动重放 |
| `succeeded` | 收到明确成功 | 直接使用结果 |
| `failed` | 收到明确失败 | 可重试 |
| `unknown` | 超时或连接中断 | 询问用户，不自动重放 |

`unknown` 这一档是 NomiFun 反复强调的，也是最容易漏的。它的含义是"不知道做没做"，此时任何自动决策都可能造成重复副作用。正确做法是停下来问人。

### 2.7 结果整形

工具返回给模型的内容要经过三道处理。

第一道，截断。超过 8KB 截断并标注"内容已截断，完整结果见附件"。模型不需要读一万行 JSON 才能回答"有几个客户"。

第二道，脱敏。手机号、身份证、密钥在进入模型前替换为占位符。这条不只是合规，也防止敏感信息被写进日志。

第三道，外置。超过 32KB 的结果直接写 `AgentArtifact`，回填只给摘要与引用 ID，需要时用 `artifact.read` 分页读取。

### 2.8 错误即信息

这是整套工具机制里最重要的设计原则。

反面做法是工具抛异常，回合捕获后直接失败。用户看到"出错了"，模型也没有机会自我修正。

正确做法是工具返回结构化错误，回合把它作为 `tool` 消息回填，模型据此决定下一步。

```ts
// 反例
throw new Error('window not found')

// 正例
return {
  ok: false,
  code: 'NOT_FOUND',
  message: '未找到标题包含「千牛」的窗口',
  retryable: true,
  hint: '可能仍在启动中，可先调用 launch.wait 等待 3 秒后重试',
}
```

差别在于模型能否读懂 `hint` 并自己修正。实践中，带 `hint` 的错误结果能把"启动并登录"这类多步操作的成功率提高一截，因为它把人的排错经验编码进了工具。

### 2.9 工具描述怎么写

`description` 是给模型看的，质量直接决定调用准确率。三条要求。

写清楚前置条件，例如"调用前需确保目标程序已启动"。

写清楚副作用，例如"会打开窗口并修改输入框内容"。

写清楚边界，例如"仅支持已在本机安装并在启动器配置中的程序"。

反面例子是"启动应用程序"，模型无法判断该传什么、什么时候不该调用。

---

## 3. 任务逻辑

### 3.1 两个状态机

很多产品把"长任务"实现成一个更长的对话，结果在恢复、并发、干预三处全面失控。正确做法是把回合与任务分成两个状态机，各自有明确的状态集。

**回合状态机**

```
queued
  → thinking          调用模型
  → streaming         流式输出文本
  → tool_running      执行工具
  → observing         结果回填
  → thinking          （循环）
  → awaiting_approval 等待用户确认
  → completed | failed | cancelled | interrupted
```

`interrupted` 与 `failed` 的区别在于能否续跑。`interrupted` 表示进程或连接中断，可从 `AgentEvent` 重放恢复。`failed` 表示业务失败，需要人工介入。

**任务状态机**

```
draft
  → planning          生成计划
  → plan_ready        等待确认（可配置为自动通过）
  → executing         按 DAG 调度
  → verifying         验收
  → done | failed | cancelled
       ↕
     paused
```

任务不直接调用模型。`planning` 阶段发起一个回合，让模型产出计划结构。`executing` 阶段每个步骤各发起一个回合。`verifying` 阶段再发起一个回合做验收。

### 3.2 回合循环

```ts
async function runTurn(turn: Turn, ctx: AgentContext) {
  let steps = 0
  const maxSteps = ctx.limits.maxToolRounds // 默认 40

  while (steps++ < maxSteps) {
    const res = await callModel(ctx, buildMessages(turn))

    if (res.toolCalls.length === 0) {
      await finishTurn(turn, res.text)
      return
    }

    await persistAssistantMessage(turn, res)
    const results = await executeTools(res.toolCalls, ctx)

    if (results.some((r) => r.needsApproval)) {
      await pauseForApproval(turn, results)
      return
    }

    await appendToolResults(turn, results)
    if (isNoProgress(turn)) {
      await failTurn(turn, 'NO_PROGRESS', '连续多轮没有新信息')
      return
    }
  }

  await failTurn(turn, 'MAX_STEPS', '本次请求步骤过多，建议拆成多个任务')
}
```

三个终止条件缺一不可。

`maxSteps` 防止死循环。`isNoProgress` 检测"同一工具同样参数连续调用"或"连续三轮没有新增信息"。成本上限 `maxCost` 防止一个复杂请求烧掉整月预算。

### 3.3 计划结构

```ts
interface PlanStep {
  id: string
  title: string
  goal: string            // 给执行者看的自然语言目标
  dependsOn: string[]     // 前置步骤
  tools: string[]         // 允许使用的工具，收窄权限
  acceptance: string      // 验收标准，给 verifying 阶段用
  status: 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped'
  attempts: Attempt[]
}

interface Attempt {
  id: string
  startedAt: Date
  endedAt?: Date
  turnId: string
  outcome?: 'succeeded' | 'failed' | 'unknown'
  error?: string
}
```

`tools` 字段是权限收窄，而非授权。步骤只能使用计划里声明的工具子集，即使执行者角色有更多权限。这条防止模型在执行阶段跑偏去调用无关工具。

`acceptance` 是自然语言，由 `verifying` 阶段的模型判断是否满足。这不是形式化验证，但比没有强，能拦住"跑完了但结果是错的"。

### 3.4 调度

调度器只做四件事。

维护就绪集，即 `dependsOn` 全部为 `done` 的步骤。按上限并发启动，默认 3。给每个运行中的步骤一个租约，执行器定期续租，租约过期视为中断。步骤完成或失败后重新计算就绪集。

并发上限取 3 的理由来自 EvoFlow 的实践（子 Agent 上限 3）与梵禾的实际场景。批量操作类任务受下游系统限流约束，并发过高反而失败率上升。

依赖关系的实际含义要说清楚。`dependsOn: ['s1']` 表示 s1 完成后 s2 才能开始，不表示 s2 需要 s1 的输出。若需要传递数据，步骤之间通过 `AgentArtifact` 引用传递，不走隐式共享状态。

### 3.5 恢复

服务重启后，扫描 `executing` 状态的任务，逐个检查运行中步骤。

```
对每个 running 的 Attempt：
  查 AgentEffect
  ├─ succeeded  → 标记步骤 done，继续调度
  ├─ failed     → 标记步骤 failed，按策略重试或暂停
  ├─ pending    → 标记任务 paused，提示用户"该步骤结果未知"
  └─ unknown    → 标记任务 paused，提示用户"请确认是否已完成"
```

核心原则是副作用不自动重放。这个判断的代价是恢复后需要人确认一次，收益是绝不重复下单、重复发消息、重复登录。

纯只读步骤可以自动重试，因为它们没有副作用。

### 3.6 干预

四个动作，都必须在任意时刻可用。

| 动作 | 语义 | 实现 |
|---|---|---|
| 暂停 | 当前步骤跑完后停 | 置标志位，调度器不再取新步骤 |
| 跳过 | 把当前步骤标 skipped，继续后续 | 需检查后续步骤是否依赖它 |
| 重试 | 为失败步骤新建 Attempt | 复用原参数，保留历史 |
| 终止 | 取消所有运行中回合 | AbortSignal 级联，写 `cancelled` |

暂停与终止的区别在于是否保留已完成的工作。暂停保留，终止保留但标记为放弃。

### 3.7 计划的修订

执行中发现计划不可行时，允许重规划，但要有边界。

规则一，只允许修改 `pending` 状态的步骤。已完成的步骤不改，避免历史失真。

规则二，每次重规划产生新版本，旧版本保留。`AgentTask` 上记 `planVersion`。

规则三，重规划次数上限 2 次。超过则暂停并请人介入，防止模型在"改计划、再失败、再改"里循环。

---

## 4. 三者如何咬合

用一个完整例子走通，即"把今天要用的程序都开起来"。

```
1. 用户输入
   → 新建 Turn，状态 queued
   → 解析模型（会话覆盖 > 个人默认）
   → 注入工具：system + read + local 三档（共 9 个）

2. 第一次模型调用
   → 模型返回 3 个 tool_calls：
      launch.list_today / launch.start(千牛) / launch.fill(千牛, 店铺A)
   → 含副作用工具，整批串行
   → launch.list_today 无审批，直接执行，返回 2 条配置
   → launch.start 需要审批，回合转 awaiting_approval
   → 持久化，推送 WS 事件给前端

3. 用户点"总是允许"
   → 写个人偏好 (userId, launch.start) = allow
   → 恢复回合，执行 launch.start
   → 桌面桥下发任务，等 2.4s 收到 succeeded
   → 写 AgentEffect(succeeded)
   → 执行 launch.fill
   → 窗口前台校验失败，返回 NOT_FOUND 加 hint
   → 结果回填，Turn 转 thinking

4. 第二次模型调用
   → 模型读到 hint，先调 launch.wait(3000)
   → 再调 launch.fill，成功
   → 模型输出文本"千牛已登录，接下来开 QQ"
   → Turn completed

5. 若用户一开始说的是"把今天的都开起来，这是长期安排"
   → 进入任务层：planning 回合产出 3 步计划
   → plan_ready 等确认
   → executing 逐步执行，每步一个 Turn
   → 某步失败则按 Attempt 重试，不重跑已完成的步骤
```

这个例子里三层各司其职。能力层只管执行与返回，回合层管循环与暂停，任务层管顺序与恢复。

---

## 5. 与梵禾既有代码的接口

### 5.1 注册位置

`apps/api/src/app.ts` 里，新增路由必须挂在 `registerAuthSupport(app)` 之后、权限中间件之前。这是既有注释写明的要求，原因是守卫依赖认证结果容器。

```ts
registerAuthSupport(app)
// 新增
registerAgentRoutes(app)
registerAgentSkillRoutes(app)
registerAgentTaskRoutes(app)
// 既有
registerAuthRoutes(app)
registerEventRoutes(app)
...
```

### 5.2 复用既有资产

| 既有资产 | 如何复用 |
|---|---|
| `ALL_PERMISSIONS` | 追加 `assistant.tool.read/write/local/external`、`assistant.task.manage` |
| `AuditLog` | 工具调用写一条，字段含 actor、action、target、result |
| `Permission` 体系 | 工具权限走角色，个人偏好另表，两者不混 |
| `Note` / `Event` | 作为只读工具的数据源，不新建平行表 |
| `credential-vault` | 保持"只从 stdin 读"，工具层不接触明文 |
| `StateView` | 前端三态统一复用 |

### 5.3 桌面桥的消息形状

```ts
// 服务端 → 桌面
type BridgeRequest = {
  id: string
  tool: 'launch.start' | 'launch.fill' | 'window.focus' | 'screen.capture' | 'file.read'
  args: Record<string, unknown>
  deadline: number
}

// 桌面 → 服务端
type BridgeResponse =
  | { id: string; ok: true; data: unknown; durationMs: number }
  | { id: string; ok: false; code: string; message: string; retryable: boolean }
```

`deadline` 是绝对时间戳而非超时秒数，避免两侧时钟漂移导致的误判。

桥只传动作与参数，不传凭据。`launch.fill` 的参数是 `profileId`，凭据由桌面侧解密并使用。

---

## 6. 建议参数

以下为起始值，上线后按真实数据调。

| 参数 | 建议值 | 依据 |
|---|---:|---|
| 单回合最大工具轮次 | 40 | 超过说明任务该拆 |
| 单回合最大时长 | 10 分钟 | 用户等待上限 |
| 单回合最大成本 | 组织配置 | 防止单次请求失控 |
| 工具默认超时 | 30 秒 | 服务端工具普遍在秒级 |
| 本地工具超时 | 60 秒 | 启动与填表需要等待窗口 |
| 批量工具并发 | 4 | 只读工具的经验值 |
| 任务并发步骤 | 3 | 对齐 EvoFlow 子 Agent 上限 |
| 上下文压缩阈值 | 70% | 留出工具结果空间 |
| 工具结果内联上限 | 8 KB | 超过则截断 |
| 结果外置阈值 | 32 KB | 超过则落 Artifact |
| 重试次数 | 3 | 1s / 3s / 8s 退避 |
| 重规划次数 | 2 | 超过则请人介入 |

---

## 7. 常见坑

按踩中概率排序，每条都对应一个具体实现细节。

**流式工具参数要累积再解析。** 模型的 `tool_calls` 参数是 JSON 字符串分片下发的，中途不是合法 JSON。必须在流结束后整体 `JSON.parse`，中途解析必然失败。

**并行工具调用的消息顺序。** 部分供应商要求 `tool` 消息紧跟在对应的 `assistant` 消息之后，中间插入任何文本都会报错。构造消息数组时要严格按调用顺序回填。

**上下文超限要在压缩后重试一次。** 直接失败会让用户觉得"模型不行"，实际只是没做预算管理。

**审批状态必须持久化。** 若只存在内存里，服务重启后回合丢失，用户点了允许也没人接。这也是 `awaiting_approval` 要进状态机的原因。

**幂等键不能只用 toolCallId。** 重连重放时 toolCallId 会重复，但那是同一操作，应当命中幂等。跨回合的重复操作则要靠 `turnId + toolCallId` 区分。

**工具 Schema 的 `additionalProperties` 要设为 false。** 梵禾的 Fastify 已经开了 `removeAdditional: false`，工具层保持同样的严格度，避免"参数被静默丢弃"。

**不要在工具里写业务规则的副本。** 例如"哪些程序允许启动"这条规则应来自 `LaunchProfile` 表，工具只读表，不硬编码白名单。否则配置改了工具不认。

---

## 8. 结论

三句话。

**第一，模型配置的难点在能力快照与预算，不在存密钥。** 密钥存储是一次性工作，能力声明错了会在运行时持续静默失败。

**第二，工具调用的难点在错误处理与顺序。** 让工具永不抛异常、把排错经验写进 `hint`、把权限与审批的判定顺序固定下来，这三点决定 Agent 是否鲁棒。

**第三，任务逻辑的难点在恢复。** 把"不知道做没做"作为一等状态，宁可停下来问人，也不自动重放副作用。这是梵禾这类会真实操作电脑的产品必须内化的原则。

需要保留一个反面判断。这套设计的完整版适合 P2 阶段，P0 阶段应当砍掉任务层与审批，只保留回合循环加只读工具。过早引入完整状态机会让首版难以交付，而首版真正要验证的是"模型能否理解梵禾的业务语境"，那件事用 200 行循环就能验证。

---

## 附录 参考来源

| 机制 | 参考 | 差异 |
|---|---|---|
| 三层分离 | NomiFun `AgentExecution` / `AgentSession` | 梵禾简化，不做全链路栅栏 |
| 工具分档 | EvoFlow `tools/tool_catalog.py` 七档 | 梵禾收敛为五档 |
| 效果回执 | NomiFun Effect 契约 | 梵禾只在副作用工具启用 |
| 保守决策 | NomiFun IDMM | 梵禾简化为审批门 |
| 工具错误结构化 | EvoFlow `tool_response_envelope` | 梵禾增加 `hint` 字段 |
| 并发上限 3 | EvoFlow 子 Agent 限制 | 一致 |
| 计划与验收 | EvoFlow `collab` 十态 | 梵禾收敛为六态 |

外部信源：https://github.com/nomifun/nomifun-desktop （Apache-2.0）；https://github.com/EvovexAI/EvoFlow （PolyForm Noncommercial 1.0.0）
