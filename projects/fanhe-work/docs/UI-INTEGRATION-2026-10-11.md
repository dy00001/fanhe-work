# 最终 UI 集成记录（合并两批 · 最终态）

> 集成对象：`UI合并方案/梵禾Work-首页改造预览.html`（七轮调试的最终原型）。
> 集成目标：把原型的外壳、信息架构与首页三段式落到 `projects/fanhe-work`，替换原界面层，接入已实现的功能模块，并保持业务逻辑与数据流不变。
> 记录时间 2026-10-12。**本文是最终态记录**：第一批（骨架层）与第二批（首页三段式 + 导航重构）已合并，早期那版「11 项 + 分组头可路由」的中间态已被最终态取代。

---

## 一、最终信息架构

侧栏从上到下四段：

| 段 | 内容 | 数量 |
| -- | -- | -- |
| 品牌行 | logo + 「梵禾 Work」 | 1 |
| 主列表顶层项 | 首页 / 资产 / 搜索 | 3 |
| 分组 | 客户信息平台(4) / 运维信息平台(4) / 设计信息平台(3) / 其他(3) | 14 |
| 底部图标行 | 外观三档 + 系统设置 + 通知 | — |

合计 **18 个导航项**（3 顶层 + 14 分组内 + 1 页脚）。

三条关键规则：

- **分组头是纯折叠开关，不是链接。** 原型里它就是 `<button>`，无 href。`NAV_GROUP_CODES` 与 `NAV_CODES` 因此**没有交集** —— 分组不再是导航项编号。
- **子项被权限全部过滤掉的分组整组不渲染**（分组头不可路由，空分组点了只展开一片空白）。
- **11 个预留槽位**（原型每组尾部的「功能开发中 N」）可点击，落到统一占位页。它们用虚线图标 + 弱化文字，**不带**「开发中」标签（名称本身就是「功能开发中 N」）。

### 路径分层

`NavItem` 新增 `slug` 字段，路径由 `navPath` 唯一决定：

| 类型 | 形态 | 例子 |
| -- | -- | -- |
| 顶层项（`group === null`） | `/${slug}` | `/workbench`、`/assets`、`/system-settings` |
| 子项 | `/${group}/${slug}` | `/customer/overview`、`/ops/dashboard` |

`code` 是身份、`slug` 是地址，两者刻意分开：首页的 `code` 至今仍是 `workbench`（旧地址与埋点认它），显示名早已改成「首页」。

---

## 二、两批的边界

| 批 | 内容 | 状态 |
| -- | -- | -- |
| 第一批 · 骨架层 | 导航结构、令牌层、侧栏、顶栏、内容区通栏 | 完成（导航结构已被第二批扩写） |
| 第二批 · 首页三段式 | 导航重构为 18 项 + 分层路径 + 纯折叠分组 + 预留槽位 + 页脚系统设置；首页替换为三段式并保留子路由；头像菜单补齐五项；版本号显示 | 完成 |

原型首页三段（编号 9 / 10 / 11）：案例展示、一键启动、工作纪要及事件记录。

---

## 三、改动文件清单

### 共享包

| 文件 | 改动 |
| -- | -- |
| `packages/shared/src/navigation.ts` | 重写。`NAV_CODES` 18 个；`NAV_GROUP_CODES` 与 `NAV_CODES` 分离；`NavGroup` 去掉 `summary`；`NavItem` 新增 `slug` / `slot`；新增 `NAV_FOOTER_CODES`；`navPath` 按分层拼路径；`navCodeFromPath` 先精确再前缀（带 `/` 分隔符，末尾斜杠归一）；`buildNavSections` 跳过页脚项、丢弃空分组 |
| `packages/shared/src/permissions.ts` | 「运营信息平台」→「运维信息平台」 |
| `packages/shared/test/navigation.test.mjs` | 重写。18 项、四角色可见范围、分层 `ALL_PATHS`、精确 + 前缀解析、分组编号不与导航编号重叠、11 槽位按组计数、页脚仅系统设置、`buildNavSections` 7 段 |

### 前端

| 文件 | 改动 |
| -- | -- |
| `apps/web/src/lib/nav-icons.ts` | 重写。18 个 `NAV_ICONS`（槽位统一 `CircleDashed`）+ 新增 `NAV_GROUP_ICONS` |
| `apps/web/src/index.css` | 新增 `--shadow-pop`、hero 令牌族（`--hero-surface/-fg/-sub/-line/-chip/-badge`）、`.launch-cta` 玻璃胶囊，深浅两态各一份 |
| `apps/web/src/components/Sidebar.tsx` | 重写。品牌行、`buildNavSections` 渲染、纯折叠分组（`grid-rows` 动画）、折叠态浮层带分组名标题、底部外观三档 + 页脚项 + 通知；**折叠按钮渲染在 `<aside>` 之外**（骑边浮标，绝对定位） |
| `apps/web/src/components/TopBar.tsx` | 重写。头像菜单补齐五项（设置 / 收藏 / 外观▸ / 帮助中心 / 退出登录）+ 底部版本号行 |
| `apps/web/src/components/AppShell.tsx` | 外层加 `relative`（承载 aside 之外的折叠按钮） |
| `apps/web/src/components/home/CaseGallery.tsx` | 新增。9 品类横向滚动卡（原型编号 9），静态占位 |
| `apps/web/src/components/home/LaunchSection.tsx` | 新增。Bento 主卡接真实启动数据 + 6 张 AI 模块卡；「管理配置」→ `/workbench/launch` |
| `apps/web/src/components/home/RecordSection.tsx` | 新增。纪要卡（跨 3 列）+ 事件卡（1 列），按各自权限判定渲染，接真实数据；「新建」→ `/workbench/notes`、「查看全部」→ `/workbench/events` |
| `apps/web/src/pages/HomePage.tsx` | 新增。三段式首页 |
| `apps/web/src/pages/WorkbenchPage.tsx` | 重写。按地址分派：`/workbench` → 三段式首页；`/workbench/launch|notes|events` → 对应面板 + 页头 |
| `apps/web/src/pages/PlaceholderPage.tsx` | 注释同步（占位项清单） |
| `apps/web/src/routes.tsx` | 新增 `routePath`（去掉前导斜杠）与 `MODULE_SUB_ROUTES`（workbench 三段）；路由仍由 `NAV_ITEMS` 派生 |
| `apps/web/src/lib/version.ts` | 新增。构建期常量读取、本地时区换算、行/详情格式化 |
| `apps/web/src/vite-env.d.ts` | 声明 `__APP_VERSION__` / `__BUILD_TIME__` / `__COMMIT_SHA__` |
| `apps/web/vite.config.ts` | 重写。读根 `package.json` 版本、`git rev-parse --short HEAD`，经 `define` 注入三个构建常量 |
| `package.json`（根） | `version` `0.0.0` → `0.1.0` |

### 测试

| 文件 | 改动 |
| -- | -- |
| `apps/web/test/e2e-auth.mjs` | 同步新外壳与新入口；新增 `clickSidebarIconLink` / `openHomeSection` / `mouseMove` / `elementCenter` / `selectThemeOption`；导航按分组结构断言（18 项）；三个功能面板改由首页入口进入 |
| `apps/web/test/version.test.mjs` | 新增。8 项，覆盖 `v` 前缀、本地时区跨日、分钟精度、非法时刻返回 null、7 位提交号、行/详情格式 |

---

## 四、关键对接点

### 4.1 导航数据流

```
NAV_ITEMS（共享包，18 项扁平可路由清单）
  → filterNavigation(permissions)     按 module 过滤可见性
  → useVisibleNavItems()              前端 hook，三个调用点共用
  → buildNavSections(items)           聚合成「顶层项 / 分组」两段（跳过页脚项、丢弃空分组）
  → <Sidebar>                         渲染；页脚项由 NAV_FOOTER_CODES 单独取
```

`buildNavSections` 是纯函数，不做权限判定 —— 权限过滤在前一步，两者分开才能让「整组不可见」时把分组也省掉。

### 4.2 路由衔接

路由表仍由 `NAV_ITEMS.map` 派生，**分组不影响路由**，因此调整分组时 `routes.tsx` 一行不用改。模块内多一层：模块路径是父路由，模块自身挂 `index`，二级页面挂 `MODULE_SUB_ROUTES` 里的段。这样 `/workbench` 与 `/workbench/notes` 之间切换不重挂外壳，侧栏折叠状态与滚动位置不丢。

### 4.3 首页与三个面板的数据流

`WorkbenchPage` 读 `useLocation` 分派（**不存状态**，地址栏能表达「我在哪」意味着刷新不丢位置、地址可直接分享）：

| 地址 | 页面 | 数据来源 |
| -- | -- | -- |
| `/workbench` | `HomePage` | 三段式 |
| `/workbench/launch` | `LaunchPanel` + 页头 | `lib/launch.ts` |
| `/workbench/notes` | `NotesPanel` + 页头 | `lib/notes.ts` |
| `/workbench/events` | `EventsPanel` + 页头 | `lib/events.ts` |

首页三段与面板共用同一批 `lib/` 数据层函数，**没有另写一套接口**：

- 一键启动区块 → `loadLaunchProfiles` / `loadLaunchStatuses` / `runLaunchProfile`；
- 纪要卡 → `loadNotes`；事件卡 → `loadEvents`。

**补入口是本实现刻意的偏离。** 首页把三个完整面板替换成摘要区块之后，若不给入口，等于把「配置管理 / 纪要增删改 / 事件增删改」整个砍掉。因此补了三个链接：「管理配置」→ `/workbench/launch`、「新建」→ `/workbench/notes`、事件卡头「查看全部」→ `/workbench/events`。原型对应位置没有这三个链接。

### 4.4 权限模型

新增项的 `module` 一律为 `null`（对已认证用户可见），与既有占位项同一口径；系统设置仍绑 `system`，只是挪到页脚图标行。首页两段（启动 / 纪要 / 事件）**各自按自己的权限点判定是否渲染** —— 只读权限的角色不该看到一张空卡。

### 4.5 主题状态

侧栏底部三档与头像菜单「外观▸」共用 `useTheme` 同一份状态，改任一处另一处同步。

### 4.6 保持不变的业务逻辑

四个功能面板（`LaunchPanel` / `NotesPanel` / `EventsPanel` / 各对话框）与 `lib/` 数据层（`api.ts` / `session.ts` / `notes.ts` / `events.ts` / `launch.ts` / `credential.ts`）**一行未改**。板块路由与守卫逻辑保持原状。

---

## 五、五项裁决（严格按用户答复落地）

| # | 事项 | 用户裁决 | 落地 |
| -- | -- | -- | -- |
| 1 | 无名子项（功能开发中 1/2/3） | 可点击，落到统一占位页 | 11 个槽位均为可路由导航项，`planned: true` |
| 2 | 系统设置落点 | 通知左侧：外观三档 \| 齿轮 \| 通知 | 移入底部图标行，由 `NAV_FOOTER_CODES` 标出 |
| 3 | 首页结构 | 替换为三段式，但保留子路由 | `/workbench` 三段式；三个面板各留子地址 |
| 4 | 头像菜单 | 设置跳系统设置，其余保持原型 | 设置 → `/system-settings`；收藏 / 帮助中心保持静态不接行为 |
| 5 | 版本号位置 | 只放头像菜单 | 菜单最底部一行 |

---

## 六、版本号：展示形式与更新方式

### 展示形式

头像菜单**最底部一行**，等宽字体、弱化色、不可点：

```
v0.1.0 · 2026-10-12 · a1b2c3d
```

格式为 `版本号 · 构建日期 · 提交短号`。鼠标悬停给出完整说明（`title`）：含精确到分钟的构建时刻、UTC 标注与完整提交号。菜单里保持短，是为了让它可被随时查到、又不打扰视线。

放这里的理由：它属于「我是谁 / 我在哪一版」这类账号元信息，与上一条身份信息同源；菜单是「随时可查」与「不必随时可见」两条的交点。用 `div` 而不是菜单项 —— 后者带悬停底色与键盘焦点，会让一行纯信息看起来像一个能按的按钮。

构建时刻按**本地时区**显示，不直接贴 UTC。否则 `2026-10-11T16:14Z` 在 UTC+8 下会显示成 10-11，而此刻本机已是 10-12，读起来像过期版本。

### 更新方式

**改仓库根 `package.json` 的 `version` 一处，重新构建即生效。** 提交号与构建时刻由 Vite 在构建时自动注入，无需手工维护：

| 常量 | 来源 | 取值时机 |
| -- | -- | -- |
| `__APP_VERSION__` | 根 `package.json` 的 `version` | 构建时读文件 |
| `__BUILD_TIME__` | `new Date().toISOString()` | 构建时 |
| `__COMMIT_SHA__` | `git rev-parse --short HEAD` | 构建时（失败回退 `unknown`） |

三者经 `vite.config.ts` 的 `define` 注入，在 `lib/version.ts` 里以 `typeof __APP_VERSION__ === 'string'` 的形式读取 —— 加这层 `typeof` 守卫是因为该模块会被 Node 的类型剥离测试直接加载，那里没有 Vite 的 `define`。

这套做法给「后期版本对比与更新追踪」提供两个稳定锚点：**版本号**是人为语义、**提交号**是机器事实。两者都印在同一行，用户报问题时能直接念出来。

---

## 七、验证结果（2026-10-12）

### 7.1 四道门禁

| 项 | 结果 |
| -- | -- |
| `pnpm test` | **350 项 0 失败**（shared 83 + web 70 + api 197 含 5 项设计性跳过） |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 三包通过 |
| `pnpm format:check` | `All matched files use Prettier code style!` |

### 7.2 浏览器端到端（实跑）

`pnpm --filter @fanhe/web test:e2e` → **合计 149 项，通过 149，失败 0**。

覆盖：首次初始化 → 登录（记住账号密码）→ 主界面 → 18 项导航按分组结构 → 侧栏折叠与偏好记忆 → 主题三档与跨刷新保持 → 直接访问子路由 → 404 页 → 登出 → 凭据自动带出与清除 → 启动通道（新增 / 编辑 / 排序 / 启动 / 删除 / 路径失效与重新指定 / 启动记录）→ 工作纪要（草稿预览 / 检索 / 置顶 / 归档 / 删除）→ 事件记录（四要素 / 逾期 / 分组与默认折叠 / 勾选切换与回滚 / 详情与变更流水）→ **渲染层零未捕获异常与 console.error**。

前置与善后：清库 → 起 API（`ACCESS_TOKEN_TTL_SECONDS=60`）与 web dev → 跑 e2e → **从 `pg_dump` 备份恢复数据库基线**（owner `fanhe`、roles 4、permissions 11、其余 0 行）。

### 7.3 实跑中发现并修掉的六个问题

这批问题**只有真的跑起来才会暴露**，四道门禁一个都拦不住（它们全是渲染层/交互时序问题）：

1. **导航项计数漏了页脚项。** 断言按 `aside nav` 取，数出 17，而页脚的系统设置在 `nav` 之外 → 18 要加上 `aside a[aria-label]`。
2. **顶层项文本里含「开发中」标签。** 直接读 `textContent` 得到「资产开发中」→ 只取名称所在的 `<span>`。
3. **「外观」改成二级菜单后靠指针悬停展开。** Radix 的 `SubTrigger` 监听 `pointermove`，合成事件与按下/抬起都不触发 → 新增 `mouseMove` 走真实指针。
4. **关闭动画的判据要等父菜单。** 子菜单先于父菜单卸载，等 `menuitemradio` 归零时父菜单还在关闭动画里，紧接着的点击被忽略 → 改等 `[role="menuitem"]` 归零。
5. **`openHomeSection` 被误包进 `evaluate`。** 它是 `async (client, href)`，写成 `evaluate(client, openHomeSection(...))` 会把 Promise 当表达式 → 直接 `await openHomeSection(client, href)`。
6. **二级菜单入场动画导致坐标点击漂移。** 动画期间量到的中心点与最终位置差几像素，点偏一点就落到菜单外、菜单被关掉而选项没选中 → 主题档位改用合成 `click`（Radix 的菜单项把选择挂在 `onClick` 上），并让 `elementCenter` 等位置稳定再取。

---

## 八、未完成部分

- **案例展示没有数据源。** 原型用的是 9 张占位卡，落地前需先定封面素材与数据来源（原型用的是 webp 海报）。
- **六个 AI 模块卡是静态占位**，右上角带「开发中」，对应尚未开发的模块。
- **搜索能力先占位**（一级导航项「搜索」，进入统一占位页）。
- 系统设置仍为占位页，绑 `system` 段权限。

---

## 附 · 与文档体系的关系

- 原型的视觉与交互依据见 `UI合并方案/梵禾Work-视觉与交互还原清单.md` 与 `梵禾Work-UI几何校准对照表.md`。
- 导航结构的目标映射见 `UI合并方案/梵禾Work-导航结构映射表.md`。
- 产品进度主文档仍为 `docs/WORK-STATUS.md`，本文只记录本次 UI 集成的范围、对接点与验证。
