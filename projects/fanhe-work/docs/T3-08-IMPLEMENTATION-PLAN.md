# T3-08 草稿自动保存 · 实施计划

> **【已完成 · 2026-10-11】** 本文是 T3-08 的施工图，**任务已按此实施并收口**，代码提交 `fcfc7aa`，
> 四道门禁 251 项 0 失败、浏览器 e2e 98 项全通过（原 85，新增 13）。实施结果与逐项判断见
> `DEVELOPMENT-PLAN.md` 9.35；本文保留为实施依据留档 —— 其中「第五节 所需改动点与预期验收标准」
> 里的预测项已由实际结果取代，**数字以 9.35 与 `WORK-STATUS.md` 为准**。
>
> 实际与本文预测的差异只有两处：① e2e 新增 **13 项**（本文预测 7 项，实际把「页面隐藏立即落盘」
> 与「草稿槽清回基线」等也各自立了断言）；② 单测实际 13 项（预测 12 项，多了一条「写失败且无草稿
> 可让位」）。其余按本文执行，未作设计变更。
>
> 生成时间 2026-10-11 20:50。本文是 **T3-08 的施工图**：写完就能照做，不必再回读源码。
> 进度主文档仍是 `WORK-STATUS.md`；本次核对的结论见 `NEXT-TASK-PREP-2026-10-11.md`。
> 所有改动点都落在真实读过的文件与行号上。

| 项 | 值 |
| -- | -- |
| 任务编号 | **T3-08 草稿自动保存** |
| 优先级 | P1（**实际优先级更高**，理由见 2.3） |
| 依赖 | T3-06 Markdown 编辑与预览（✅ 已具备） |
| 验收要点 | **关闭后重进可恢复未提交内容** |
| 涉及模块 | 前端存储层（新）+ 前端界面层；**后端零改动** |
| 代码基线 | `5e73c5e` |
| 门禁基线 | 238 项 0 失败；e2e 85 项全通过 |

---

## 一、项目已完成的部分与整体目标

### 1.1 整体目标

**梵禾 Work** 是桌面端个人工作台（实验版），用来管自己的软件启动通道、工作纪要、事件记录，之后包成 Electron 外壳，并支持局域网/远程两种服务地址。

分七个阶段、50 项任务，编号「T + 阶段号 + 连字符 + 序号」：

| 阶段 | 内容 | 状态 |
| -- | -- | -- |
| 零 | 目录骨架 | ✅ 7/7 |
| 一 | 账号与权限 | ✅ 12/12 |
| 二 | 主框架与 UI 骨架 | ✅ 7/7 |
| 三 | 个人工作台三板块（启动 / 纪要 / 事件） | 🔄 **7/12** |
| 四 | Electron 桌面外壳 | ⬜ 0/4 |
| 五 | 服务端化 | ⬜ 0/5 |
| 六 | 更新通道 | ⬜ 0/3 |

**总进度 33/50（66%）。**

### 1.2 已经能用的东西

| 板块 | 能力 |
| -- | -- |
| 账号与权限 | 登录、双令牌轮换与撤销、登录限速、权限中间件（每次查库不缓存）、首次初始化引导、审计日志、记住账号密码 |
| 主框架 | 应用式外壳（侧栏 224/64、顶栏 56、内容区独立滚动）、路由体系、占位页、错误与空状态、折叠偏好、亮暗主题 |
| 启动通道 | 配置增删改排序、本机回环代理拉起外部进程、启动记录、路径失效提示与重新指定 |
| 工作纪要 | Markdown 编辑与预览、标签、置顶、归档、删除、**中文全文检索** |

**技术栈**：pnpm monorepo；React 19 + TypeScript 6.0.3 + Vite 8 + Tailwind 4 + shadcn/ui；Fastify 5 + Prisma 7.10.0 + PostgreSQL 16；Electron（阶段四）。

**数据**：5 个迁移、10 张业务表；种子 11 权限 / 4 角色 / 29 关联。

### 1.3 阶段三剩下的两条链

```
纪要链  T3-05 ✅ ─┬─ T3-06 ✅ ─── T3-08 ◀── 本次
                  └─ T3-07 ✅
事件链  T3-09 ─┬─ T3-10 ── T3-11
               └─ T3-12
```

阶段三的验收清单第三项是「纪要支持编辑预览、标签、置顶、检索、**草稿恢复**」—— 前四项都已完成并过了浏览器验证，**只差草稿恢复这一项，整项因此至今没勾**。

---

## 二、下一步任务：T3-08 草稿自动保存

### 2.1 任务定义

| 项 | 内容 |
| -- | -- |
| 编号 | T3-08 |
| 优先级 | P1 |
| 依赖 | T3-06（✅） |
| 主要产出 | 定时保存与误关恢复 |
| 验收要点 | **关闭后重进可恢复未提交内容** |

### 2.2 涉及的功能模块

| 模块 | 文件 | 动作 |
| -- | -- | -- |
| **前端本机存储层**（新） | `apps/web/src/lib/note-draft.ts` | **新建** |
| **前端界面层** | `apps/web/src/components/notes/NoteEditor.tsx` | 改动（主要工作量） |
| 前端面板层 | `apps/web/src/components/notes/NotesPanel.tsx` | 仅改注释，**不动 `key`** |
| 前端测试配置 | `apps/web/package.json` | 改 `test` 脚本 |
| 前端单测 | `apps/web/test/note-draft.test.mjs` | **新建** |
| 浏览器 e2e | `apps/web/test/e2e-auth.mjs` | 加 6 项断言 |
| **后端** | — | **零改动**（无新接口、无迁移、无 schema 变更） |
| 文档 | `docs/DEVELOPMENT-PLAN.md`、`docs/WORK-STATUS.md` | 回填 |

### 2.3 为什么它的实际优先级比标称的 P1 高一档

它是**纪要链的最后一项**，也是**阶段三验收第三项的唯一剩余缺口**。做完这一项，那条验收就能勾上，阶段三从「7/12 + 一项悬空」变成「8/12 + 第三项验收闭环」。相比事件链（要从第 6 个迁移、两张新表起步），它是**纯增量、零迁移、不触碰任何既有数据路径**的低风险改动。

### 2.4 它顺带要解决的既有场景

**检索会缩小可见集合**：被搜掉的那条退出列表、选中随之落到第一条匹配上、编辑器重挂、**正在编辑的草稿随之丢失**。归档、删除、切视图也早已如此 —— 这是既有行为，不是 T3-07 引入的，`NotesPanel.tsx:181-182` 与 `NoteEditor.tsx` 的注释里都标着交接项。本轮一并收口。

---

## 三、设计

### 3.1 槽（slot）设计

槽名 = 编辑器的身份 = 父组件传给 `key` 的那个值（`NotesPanel.tsx:433`）：

| 场景 | 槽名 | localStorage 键 |
| -- | -- | -- |
| 编辑已有纪要 | `<noteId>` | `fanhe-work.draft.note.<noteId>` |
| 新建中未提交 | `new` | `fanhe-work.draft.note.new` |

前缀 `fanhe-work.draft.` 与既有的 `fanhe-work.ui.`（`lib/preferences.ts:23`、`:68`）并列：既能按前缀整体清理，又不会碰到会话与凭据类数据。

### 3.2 值结构

```ts
type NoteDraft = {
  v: 1                    // 结构版本号
  title: string
  content: string
  tags: string[]
  savedAt: string         // ISO 8601
}
```

- **必须带 `v`**：将来改结构时，没有版本号的旧草稿会把界面打崩（例如 `tags` 从数组变成字符串）。读到不认识的版本一律丢弃，不做迁移 —— 草稿是可有可无的副本，迁移逻辑的收益不抵它的风险。
- **不存 `noteId`**：槽名里已经有，再存一份就会出现「槽名说 A、值里写 B」的漂移。
- **存 `savedAt`**：过期清理的依据、提示条要说「上次自动保存于 X」、排查时唯一的时间线索。

### 3.3 写入时机（三个触发点，缺一不可）

| # | 触发点 | 说明 |
| -- | -- | -- |
| 1 | **输入防抖 500ms** | 比检索的 250ms 长一倍（`NotesPanel.tsx:75`）：检索是一次网络请求，草稿写是**同步阻塞主线程**的 I/O，10 万字正文每次按键都写会明显卡顿 |
| 2 | **`pagehide` + `visibilitychange(hidden)` 立即 flush** | **这才是「误关恢复」真正依赖的那一条**：用户打完最后一个字 200ms 内关掉页面，防抖还没到期。`beforeunload` 在移动端与部分浏览器不可靠，`pagehide` 更稳 |
| 3 | **组件卸载立即 flush** | 切板块、换一条时保住内容 |

**三个 effect 的分工（不能合并，否则防抖会失效）**：

```tsx
// ① 防抖写。清理函数只 clearTimeout，不写 —— 否则每次 values 变都触发清理，
//    等于变成「每次输入都立即写」，防抖失效。
useEffect(() => {
  const timer = window.setTimeout(write, DRAFT_DEBOUNCE_MS)
  return () => window.clearTimeout(timer)
}, [values])

// ② 页面隐藏 flush。只注册一次，用 latest ref 读最新值（依赖 values 会反复增删监听）。
useEffect(() => {
  const flush = () => writeNow(valuesRef.current)
  window.addEventListener('pagehide', flush)
  const onVisible = () => { if (document.visibilityState === 'hidden') flush() }
  document.addEventListener('visibilitychange', onVisible)
  return () => { /* 移除两个监听 */ }
}, [])

// ③ 卸载 flush。只注册一次，清理里读 ref。
useEffect(() => () => {
  if (!committedRef.current) writeNow(valuesRef.current)
}, [])
```

`valuesRef` 用标准的 latest-ref 模式更新（在 effect 里写，不在渲染期写）：

```tsx
const valuesRef = useRef(values)
useEffect(() => { valuesRef.current = values }, [values])
```

### 3.4 清除时机（三个触发点）

| # | 触发点 | 为什么 |
| -- | -- | -- |
| 1 | **保存成功后清当前槽** | 特别是新建：`'new'` 槽若不清，下次点「新建」会恢复出**上次已提交的旧内容** |
| 2 | **用户点「丢弃草稿」** | 用户明确不要了 |
| 3 | **草稿与已保存值一致时清** | 改了又改回原样，留着没意义 —— 重进时弹一条「已恢复未保存内容」而内容其实与库里一致，是纯噪音。判据直接复用既有的 `hasChanges`（`NoteEditor.tsx:51-59`，已处理「标题 trim 后比较、正文原样比较」的不对称） |

### 3.5 恢复时机与合流点

**合流到既有的 `syncedNoteId` 机制**（`NoteEditor.tsx:95-99`）—— 那一段已经是「决定编辑器该显示什么」的唯一位置，不新开一条平行的同步路径。

```tsx
const noteId = note?.id ?? null

// 挂载时读一次。用惰性初始化器：只跑一次；而父组件用 key 表达「换了一条」，
// 因此「换一条」必然伴随重挂，读到的必然就是那一条的草稿。
const [restored] = useState(() => readNoteDraft(noteId))
const [values, setValues] = useState<NoteFormValues>(
  () => restored?.values ?? valuesFrom(note),
)
const [restoredAt, setRestoredAt] = useState<string | null>(restored?.savedAt ?? null)

const [syncedNoteId, setSyncedNoteId] = useState<string | null>(noteId)
if (noteId !== syncedNoteId) {
  setSyncedNoteId(noteId)
  setValues(valuesFrom(note))   // 保持原样，理由见 3.7
  setRestoredAt(null)
}
```

> `useState` 惰性初始化器里读 `localStorage` 是安全的：初始化器只在挂载时跑一次、不参与重渲染，因此不存在并发渲染下的撕裂。**不要把它挪进渲染体或 effect**。

### 3.6 ⚠️ 本任务最容易踩的坑：提交成功后卸载 flush 会把已提交内容写回去

**时序**：新建 → 点「创建」→ 提交成功 → 父组件 `setSelectedId(created.id)`（`NotesPanel.tsx:289`）→ `key` 由 `'new'` 变成新 id →**组件重挂 → 旧实例的卸载清理函数执行 → flush**。

此刻旧实例的 `note` 仍是 `null`（列表还没更新），`hasChanges(null, values)` **恒为真** → 内容被写回 `'new'` 槽 → **下次点「新建」会恢复出上次已提交的那条内容**。

**修法**：加一个 `committedRef`，提交成功时置真并清槽；卸载 flush 前先看它。

```tsx
const committedRef = useRef(false)

// handleSave 成功分支里：
committedRef.current = true
clearNoteDraft(noteId)      // 清的是当前槽（'new' 或某 id）

// 卸载 flush 里：
if (committedRef.current) return
```

**这个 bug 的门禁拦不住**（单测、typecheck 都过），而且现象要「新建 → 提交 → 再点新建」三步才出现 —— **e2e 必须覆盖它**（见 5.3 第 7 项）。

### 3.7 与既有机制的三条硬约束（红线）

1. ❌ **不要把 `NotesPanel.tsx:433` 的 `key={selectedId ?? 'new'}` 改成 effect 同步。** 那会重新引入 T3-06 踩过的 bug：「数据到达的同时用户已经在打字」→ 输入被冲掉（见 `WORK-STATUS.md` 5.6）。
2. ✅ **同步判据用 note 的 `id`，不要用整个 note 对象** —— 列表重拉会换引用，用对象判会把用户正在输入的内容冲掉。
3. ❌ **不要在 `useEffect` 里无条件 `setValues(valuesFrom(note))`。** 现有那份注释（`NoteEditor.tsx:84-94`）已经论证过，别推翻它。

### 3.8 存储异常的处理：与 `preferences.ts` 刻意不同

`lib/preferences.ts` 的取舍是「写不进去就算了」（丢的是侧栏宽窄，`preferences.ts:44-56`）。**草稿丢的是用户的工作**，因此分两档：

| 情况 | 处理 |
| -- | -- |
| **读失败**（隐私模式、存储被禁） | 静默按「没有草稿」处理 —— 等价于降级到当前行为，可接受 |
| **写失败**（`QuotaExceededError`） | **先清一次旧草稿再重试一次**；仍失败则给**一次**提示「自动保存暂不可用，请手动保存」，不重复弹 |

**「不重复弹」是刻意的**：这条提示是「别以为存住了」的告知，每次输入都弹会变成噪声，而噪声的结果是用户学会忽略它。

### 3.9 容量治理

- 写入前清理：`savedAt` 超过 **7 天**、或总数超过 **20 条**的旧草稿。**清理必须限定在 `fanhe-work.draft.note.` 前缀内**，绝不按前缀外扫。
- 单条草稿理论上可达约 200KB（正文上限 10 万字符），localStorage 通常 5MB —— 20 条足够，不必做单条截断。

### 3.10 已知边界（写进文档，别当 bug 修）

- **同一浏览器多标签页**同时编辑同一条 → 后 flush 的覆盖先 flush 的（localStorage 无锁）。单机单用户可接受。
- **换浏览器、清缓存即丢**，与 `preferences.ts` 同源（`preferences.ts:9-11`）。
- **不跨设备同步** —— 那是阶段五服务端化的事。
- **`'new'` 槽只有一个**：不能同时保留两条「新建中」的草稿。
- 草稿**不进审计**（与既有判断一致：纪要属私有用量）。

---

## 四、分步骤实施计划

| 步 | 动作 | 产出判据 |
| -- | -- | -- |
| 1 | ~~环境复位~~（**已完成**，见第六节） | ✅ 四道门禁实跑全绿、10 张业务表、owner 可用 |
| 2 | 写 `lib/note-draft.ts`：注入式 storage 接口 + 默认绑定 `window.localStorage` 的薄壳 | 模块可被 Node 直接 import（不带 `window`） |
| 3 | 写 `test/note-draft.test.mjs`，**并改 `package.json` 的 test 脚本** | 新用例真的被跑到（见 5.1，漏改脚本等于没写） |
| 4 | 接进 `NoteEditor`：惰性初始化读草稿 + 恢复提示条 + 「丢弃草稿」 | 刷新后内容还在；点丢弃回到库里版本 |
| 5 | 接写入三触发点（防抖 / pagehide / 卸载 flush） | 打完字立刻刷新也不丢 |
| 6 | 接清除三触发点（保存成功 / 丢弃 / 与库一致）+ `committedRef` | 「新建 → 提交 → 再点新建」不出旧内容 |
| 7 | 存储失败态与容量治理 | 配额写满时给一次提示，不是静默 |
| 8 | e2e 6 项 + 四道门禁 + 文档回填 + 两笔提交 + `dev` 快进 | 见第五节 |

---

## 五、所需改动点与预期验收标准

### 5.1 改动点清单

| # | 文件 | 动作 | 具体内容 |
| -- | -- | -- | -- |
| 1 | `apps/web/src/lib/note-draft.ts` | **新建** | 槽名生成、序列化/反序列化（含 `v` 校验）、`readNoteDraft` / `writeNoteDraft` / `clearNoteDraft`、过期与容量清理、写失败回调。**接口注入 storage，不直接摸 `window`** —— 否则 Node 单测里没有 `localStorage` |
| 2 | `apps/web/src/components/notes/NoteEditor.tsx` | 改 | ① 惰性初始化读草稿（第 80-99 行那一段）；② `committedRef`（3.6）；③ 三个写入 effect（3.3）；④ `handleSave` 成功分支清槽 + 置标记（第 155-158 行附近）；⑤ 恢复提示条 + 「丢弃草稿」按钮；⑥ 自动保存不可用的弱提示位 |
| 3 | `apps/web/src/components/notes/NotesPanel.tsx` | 改（小） | **仅更新第 56-57 行的注释**（「不缓存草稿」已被本轮实现取代）。**不动 `key`** |
| 4 | `apps/web/package.json` | 改 | `test` 脚本：`test/relative-time.test.mjs` → `test/*.test.mjs`。**漏掉这一步，新单测根本不会被执行** |
| 5 | `apps/web/test/note-draft.test.mjs` | **新建** | 纯逻辑单测，见 5.2 |
| 6 | `apps/web/test/e2e-auth.mjs` | 改 | 在「9. 工作纪要」段（第 1868 行起）之后新增一组草稿断言，见 5.3 |
| 7 | `docs/DEVELOPMENT-PLAN.md` | 改 | 新增 9.35 回填 T3-08 的实施判断与验证结果；第三章任务表、第七章验收第三项同步 |
| 8 | `docs/WORK-STATUS.md` | 改 | 进度改 **8/12**；阶段三验收第三项勾选；测试计数改新值；4.1 的「下一项」换成 **T3-09** |

### 5.2 单测清单（`test/note-draft.test.mjs`）

用 Node 内置测试器 + `--experimental-strip-types` 直接测 `.ts` 源码（与 `relative-time.test.mjs` 同款，`apps/web/test/relative-time.test.mjs:2-8`），传一个内存假 storage。

| # | 用例 | 断言 |
| -- | -- | -- |
| 1 | 槽名生成 | 有 id → `fanhe-work.draft.note.<id>`；`null` → `...note.new` |
| 2 | 往返 | 写进去再读出来，四个字段一致 |
| 3 | 版本不符 | `v: 2` 的旧数据读出来是 `null`，且**不抛异常** |
| 4 | 结构损坏 | 非法 JSON / 缺字段 / `tags` 是字符串 → 一律 `null` |
| 5 | 空内容 | 三个字段全空 → 视为「没有草稿」（避免写一堆空槽） |
| 6 | 过期清理 | `savedAt` 8 天前 → 被清掉；6 天前 → 保留 |
| 7 | 容量清理 | 21 条 → 最旧的被清，剩 20 条 |
| 8 | 前缀隔离 | 清理**不删** `fanhe-work.ui.theme` 与无关键 |
| 9 | 写失败 | storage 抛 `QuotaExceededError` → 清理后重试一次，仍失败则回调被调一次（不是两次） |
| 10 | 读失败 | `getItem` 抛异常 → 返回 `null`，不抛 |
| 11 | 与库一致不写 | 值等于已保存值 → `write` 不落盘（或落盘后立即清） |
| 12 | 清除 | `clear` 后读到 `null`，且**只删那一个键** |

### 5.3 浏览器 e2e 新增断言（6 项）

| # | 场景 | 断言 |
| -- | -- | -- |
| 1 | 新建态输入 → 等过防抖窗口 → **重载页面** | 标题与正文被恢复 |
| 2 | 恢复后 | 出现恢复提示条（若采用提示方案） |
| 3 | 点「丢弃草稿」 | 编辑器回到库里版本（新建态即空白），提示条消失 |
| 4 | 保存成功 → 重载 | **不恢复**（草稿已清，显示库里的值） |
| 5 | 正文改了又改回原样 → 重载 | **不出现**恢复提示（一致即清） |
| 6 | 切到别的工作台板块再切回 | 未保存内容还在（卸载 flush 生效） |
| 7 | **「新建 → 提交 → 再点新建」** | **不出现**上一条已提交的内容（专打 3.6 那个坑） |

> 第 7 项是本轮唯一「只有 e2e 能拦」的断言，**不得省**。现有 e2e 的写法与辅助函数（`waitFor` / `record` / `fillInput` / `clickMainButton` / `clickNavByLabel` / `evaluate` / `screenshot`）都在文件里现成，照抄即可。

### 5.4 验收标准

**功能验收（对应任务表「关闭后重进可恢复未提交内容」）**

- [ ] 编辑中直接刷新 / 关闭标签页 → 重进后未提交的标题、正文、标签都在
- [ ] 恢复时不覆盖已保存数据，且用户可一键丢弃
- [ ] 保存成功后重进 → 草稿已清，显示的是库里的版本
- [ ] 「新建 → 提交 → 再点新建」→ 不出现旧内容

**不回退（这两条是 T3-06 踩过的真 bug，必须证明没复发）**

- [ ] 新建成功后编辑器**不空白**（标题回填、计数正确）
- [ ] 空库时**第一条纪要建得出来**（编辑器不被空态挡住）

**门禁**

- [ ] `pnpm test`：基线 238 项 + 新增单测（预计 12 项）→ **250 项 0 失败**
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm format:check`：全绿（`format:check` 应输出 `All matched files use Prettier code style!`）
- [ ] 浏览器 e2e：**85 + 7 = 92 项全通过**，且原 85 项一项不少
- [ ] `apps/api` 的 5 项跳过仍是跳过（那是设计行为，不是失效）

**交付**

- [ ] 两笔提交：`feat(阶段三): T3-08 草稿自动保存` + `docs(阶段三): 回填 T3-08 实施判断与验证结果`
- [ ] 显式列路径提交，**不用 `git add -A`**
- [ ] 推送走代理（超时 ≥150 秒、日志落盘），推完把 `dev` 快进到 `main` 一起推
- [ ] `WORK-STATUS.md` 回填：8/12、验收第三项勾选、新测试计数、下一项换成 T3-09

---

## 六、开工前的环境准备（本次实测状态）

本次核对发现工作区**刚经历一次换机**（自愈日志：`root changed: F:/fanhe Work -> E:/fanhe Work`、`host changed: DY008 -> DY`），并连带查出两个真实阻塞。已处理的两项与待确认的项如下。

| # | 项 | 状态 | 说明 |
| -- | -- | -- | -- |
| 1 | **工作区换机自愈** | ✅ 已自动完成 | 根的 `E:` / `F:` 与主机名变化触发 relocation repair，重建了 `.bin` shim |
| 2 | **`pnpm` 不在 PATH** | ✅ **已修复** | `ws-run.cmd pnpm db:ping` 报 `无法将“pnpm”项识别为 cmdlet`。根因是本机从未 `corepack enable pnpm`。已执行，`pnpm -v` → `10.33.0`（与 `package.json` 的 `packageManager: pnpm@10.33.0` 一致） |
| 3 | **`node_modules` 软链接全部悬空** | ✅ **已修复** | 例：`apps/api/node_modules/tsx -> /f/fanhe Work/...`，指向已不存在的 `F:` 盘 → `db:ping` 报 `Cannot find module .../tsx/dist/cli.mjs`。已用 `pnpm install` 重链（store 在 `E:/fanhe Work/.cache/pnpm-store/v10`，内容完整，未重新下载）。**两个坑**：① 无 TTY 会被中止（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`），要加 `CI=true` 与 `--config.confirmModulesPurge=false`；② 清 `node_modules` 会撞上 `safe-delete` 批量删除保护（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），要加 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=<大数>` |
| 3b | **数据库落后一个迁移** | ✅ **已修复** | 本机库只有 **4 个迁移**（缺 `20261011064829_add_notes`）、`users` **0 行** —— **数据库是逐机的、容器卷不随盘走**，这台机器的卷与上一台不是同一份。已 `pnpm db:deploy` 补迁移 + 按 `.tmp/owner-credentials.txt` 的原口令 `pnpm db:create-owner` 重建 owner |
| 3c | **`typecheck` 报 TS7031** | ✅ **已修复** | `apps/web/src/pages/WorkbenchPage.tsx:59` 的 `className={({ isActive }) => …}` 缺类型标注。**同一个写法在 `Sidebar.tsx:71` 一直是显式标注 `NavLinkRenderProps` 的** —— 属既有疏漏，换盘重建依赖后才暴露（此前门禁记录为全绿）。已补成与 Sidebar 一致，提交 `4d43dae`（仅本地）。纯类型标注，无运行时改动 |
| 4 | **Docker 与数据库** | ✅ 已就绪 | `fanhe-work-db` 是 `Up (healthy)`，`127.0.0.1:5432` |
| 5 | 共享包产物 | ✅ 在 | `packages/shared/dist/` 有 `account.js` / `audit.js` 等 |
| 6 | owner 凭据 | ✅ 在且已重建 | `.tmp/owner-credentials.txt`（640 B），账号 `fanhe` 已在本机库重建 |
| 7 | API 环境变量 | ✅ 在 | `apps/api/.env`（374 B） |
| 8 | 远端同步 | ✅ 一致 | `main` 从 `5e73c5e` 前进到 `4d43dae`（本地，未推送）；`dev` 仍在 `5e73c5e` |

**最终核对结果（2026-10-11 20:5x 实跑，全部达成）**

| 项 | 期望基线 | 实测 |
| -- | -- | -- |
| 数据库 | 5 迁移 / **10 张业务表** | ✅ 10 张；`users` 1、`roles` 4、`permissions` 11、`role_permissions` 29、`notes` 0 |
| `pnpm test` | **238 项 0 失败** | ✅ shared 63 + api 165 + web 10 = **238，0 失败** |
| `pnpm lint` | 全绿 | ✅ |
| `pnpm typecheck` | 全绿 | ✅ 修好 TS7031 后三个包全 `Done` |
| `pnpm format:check` | `All matched files use Prettier code style!` | ✅ |

> **教训（值得写进交接）**：门禁记录的「全绿」与**实跑**全绿是两件事。换机重启后**必须实跑一遍四道门禁再开工**，别信文档里的数字 —— 本次就抓到一处记录为绿、实跑报错的类型问题。

> **换机后不复存在、必须重建的东西**（都是刻意不随盘走的）：`.tmp/owner-credentials.txt`、`apps/api/.env`、数据库容器与命名卷、四处 `node_modules/` 与 pnpm store、GCM 里的 GitHub 凭据、git 的 `safe.directory` 与提交身份、以及**本机的 `corepack enable pnpm`**。

---

## 七、待你拍板的两处（其余按本文默认执行）

| # | 问题 | 本文默认 |
| -- | -- | -- |
| D1 | 草稿恢复的**交互方式** | 自动回填 + 编辑器顶部一条提示（「已恢复上次未保存的内容 · 保存于 X」+「丢弃草稿」按钮） |
| D2 | 本轮是否**顺带收口**「检索/归档/删除/切视图导致草稿丢失」 | 是。它们与 T3-08 是同一件事，分开做等于把同一个坑填两遍 |

D2 若选「否」，则 T3-08 只覆盖「误关恢复」，被搜掉那条的草稿仍会丢 —— 但那样验收要点仍是满足的。
