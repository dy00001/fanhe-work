# 梵禾 Work 架构梳理与下一步路线

日期 2026-10-21 19:4x。范围：工作区结构、代码架构、依赖关系、已交付功能、阶段判断、下一步任务。
基线：仓库版本 `0.2.0`，分支 `main`（领先 `origin/main` 3 笔提交），工作区另有 16 个未提交文件。
方法：读代码与配置，查运行中的数据库，实跑门禁。凡未验证的结论单独标注。

---

## 零、五条结论

1. **阶段位置。** 项目已过「能跑起来」与「能发版」，处在「单店数据链路闭合、多店能力已写但未落地」的位置。版本 `0.2.0` 已发布安装包，运营看板是当前唯一有真实数据的业务模块。
2. **架构形态。** 四包 monorepo 加三条独立运行边界。网页端与 API 容器化部署，桌面端只做「静态壳加反代」，不自带后端，采集器在仓库外运行并通过 HTTP 或 CLI 入库。
3. **当前最大阻塞在环境，不在代码。** 工作区已从 `F:` 迁到 `E:`，`projects/fanhe-work` 下有 527 个符号链接仍指向 `/f/`。四道门禁在本机跑不通，`packages/shared` 的测试以 `MODULE_NOT_FOUND` 结束。这是迁移副作用，与断言失败无关。
4. **三个 P0 构成一条依赖链，不能并行处理。** 店铺定名先于提交，提交先于锚点修正，锚点修正先于多店采集，多店采集先于重新打包。交接文档把它们列为「三选一」，实际它们是串行关系。
5. **功能面上还有大片空白。** 客户信息平台两个具名项、资产、搜索都是占位页。运营看板的「服务体验」「推广投放」「内容运营」三个板块没有真实数据，页面显示待接入清单。

---

## 一、物理结构：工作区层与业务层

工作区根是 git 根，也是介质根。它分两层，边界按变更频率划。

```
E:\fanhe Work\                     工作区根，.ws-root 为定位标记
├── infra/                         机制层，变更少、影响面大
│   ├── portable/                  ws-run / ws-env / ws-repair / ws-doctor / ws-compose
│   └── docs/                      便携工作区与 NTFS 迁移的机制文档
├── projects/
│   ├── README.md
│   └── fanhe-work/                业务层，即本报告主体
├── keys/                          代码签名证书（pfx / cer）
├── 交接-20261012/  WORKLOG/  UI合并方案/  星尘AIGC-UI解析/   按惯例不入库
├── .workbuddy/  .workbuddy-ai/    记忆系统，路径固定，不可删
└── .cache/ .tmp/ .local/ .config/ logs/ runtime/ ...          运行时重定向目标
```

两条硬约束贯穿全仓。

- 受版本控制的文件禁止写死盘符。需要根目录时向上找 `.ws-root`，或读 `WS_ROOT`。这条规则的原因已经发生过一次：`F:` 换到 `E:` 之后，所有写死盘符的脚本当场失效。
- 所有命令经 `infra/portable/` 入口进入，环境重定向才生效。入口是透传式的，写 `ws-run.sh pnpm test`，不写 `ws-run.sh test`。后者会执行 shell 内建 `test` 并静默返回 1，看起来像门禁失败。

---

## 二、代码架构：四包与依赖方向

```
packages/shared          契约层。类型、权限点、导航清单、纯函数
    ↑ 编译期依赖（workspace:*）
    ├── apps/api         Fastify 5 + Prisma 7，唯一持有数据库连接
    ├── apps/web         React 19 + Vite 8，只经 HTTP 访问 api
    └── apps/desktop     Electron 44，静态托管 web/dist 并反代 /api
```

| 包 | 职责 | 关键约束 |
| --- | --- | --- |
| `packages/shared` | 权限点 `permissions.ts`、导航 `navigation.ts`、各模块类型与展示纯函数 | 权限与导航的唯一事实来源。路由表由 `NAV_ITEMS` 派生，不另写一份 |
| `apps/api` | 认证、账号、纪要、事件、一键启动、运营看板、版本清单 | 只有它能连 Prisma。权限校验只发生在这里 |
| `apps/web` | 侧栏外壳、首页三段、运营看板七入口、系统设置 | 不写死颜色，令牌唯一来源是 `index.css`；组件从 `components/ui/` 取 |
| `apps/desktop` | 窗口、内置静态服务、`/api` 反代、凭据保险箱、更新通道 | 不内嵌后端。`serviceUrl` 从 `.config/fanhe-work/service.json` 读，环境变量仅作一次性覆盖 |

`apps/api/src` 内部按领域分目录，路由只做参数校验与装配，业务落在同领域模块里。

```
routes/       auth events launch notes ops setup system-users
auth/         guard login password session setup tokens user-admin
ops/          ingest query date
launch/       agent history loopback profiles status
note/ audit/ event/ version/ db/ config/ tools/
```

`apps/web/src` 的分层在 `lib/` 上体现得最清楚。

```
lib/api.ts              只拼地址、发请求、超时与错误码
lib/session.ts          withAccessToken，令牌刷新
lib/<模块>.ts           会话感知、拆信封、按错误码分流
lib/<模块>-display.ts   展示规则纯函数（可单测，不依赖浏览器）
```

这条分层不是形式要求。展示规则写在组件里，验证方式就只剩打开浏览器；下沉到 `lib/*-display.ts` 之后才能用单测钉住。`ops-display.ts`、`ops-series.ts`、`event-display.ts`、`launch-status-desktop.ts` 都是这么来的。

---

## 三、三条运行链路

### 3.1 容器链路（生产形态）

```
docker-compose.yml
  db          postgres:16-alpine，命名卷 pgdata
  migrate     target: migrate，构建时 COPY 迁移 SQL，跑迁移与种子
  api         target: runtime，Fastify 监听 8787
  web         target: runtime，静态前端
  cloudflared 隧道
```

操作必须经 `infra/portable/ws-compose.cmd`。手写 `--env-file` 会漏变量，报 `required variable ... is missing`，读起来像代码 bug。

镜像重建的判据按改动类型分三类，混淆会得到「容器起来了但行为没变」。

| 改动类型 | 需要重建 | 判据 |
| --- | --- | --- |
| 迁移 SQL、权限点 | `migrate` 与 `api` 两个 | 容器内 `ALL_PERMISSIONS.length` 为 15 |
| 路由、ops 逻辑 | `api` | 响应头里有 `etag` |
| 前端 | `web` 加 `--force-recreate` | 产物时间晚于改动时间 |

### 3.2 桌面链路

外壳加载 `apps/web/dist` 构建产物，在回环起静态服务，`/api/*` 反代到 `serviceUrl`。更新走 `electron-updater`，安装包由 `electron-builder` 产出并签名。

发布链条上有一个容易漏的点。`apps/desktop/package.json` 的版本由 `sync-version.mjs` 在打包前写入，只改仓库根版本而不重打包，`app.getVersion()` 仍报旧值，更新通道会反复提示有新版。

### 3.3 采集链路（仓库外运行）

```
Edge 每店独立 profile（端口 9222 起）
   ↓ CDP 抓原始响应
tools/collector/data/daily/<shop>/<date>/<页>/<序号>_<接口>.json
   ↓ export-daily-ingest.mjs 解析成入库契约
   ↓ verify-daily.mjs 采集与契约交叉校验
   ↓ pnpm db:ops-import 或 POST /api/ops/ingest
ecom_shops / ecom_daily_metrics / ecom_dimension_snapshots / ecom_collect_runs
```

三段职责有明确分界，判断标准是「这件事的真相只有谁能看见」。

| 环节 | 唯一拥有的事实 | 不负责 |
| --- | --- | --- |
| 抓取 | 某天某页的原始响应 | 去重、合并、数值对不对 |
| 更新 | 口径：哪列算金额、哪个窗口算整段 | 页面为什么没发请求 |
| 推送 | 可见性：权限裁剪、区间锚定、缺失怎么显示 | 数据是否完整 |

退出码是这条链路的公共语言。`0` 干净，`2` 有缺口可入库，`1` 阻断，`3` 需登录，`4` 页面未加载。`4` 单独存在，是因为标签停在 `about:blank` 不能判成登录失效，否则人会去重登一个仍然有效的账号。

---

## 四、数据与权限模型

### 4.1 数据表（8 迁移 / 18 表，本次查库核实）

| 领域 | 表 |
| --- | --- |
| 账号权限 | `users` `roles` `permissions` `role_permissions` `user_permissions` `login_attempts` `refresh_tokens` |
| 审计 | `audit_logs` |
| 个人工作台 | `launch_profiles` `launch_history` `notes` `events` `event_logs` |
| 运营 | `ecom_shops` `ecom_daily_metrics` `ecom_dimension_snapshots` `ecom_collect_runs` |

枚举 8 个。运营段四个：`EcomPlatform`、`EcomCollectSource`、`EcomCollectStatus`、`EcomDimensionType`。

本次查库的数据实况。

```
迁移 8 / 表 18
ecom_shops 5 行（fanhe-main 梵禾，s2 雅素，s3 简作，s4 分店 4，s5 分店 5）
ecom_daily_metrics 31 行 / ecom_dimension_snapshots 88 行 / ecom_collect_runs 4 行
users 7 行
```

`users` 为 7 行，不是干净基线。任何「清理残留」的动作都要先按命名前缀与创建时间甄别，库里有真实用户。

### 4.2 权限模型

15 个权限点，三段式命名，模块域为 `system` / `personal` / `ops`。

| 模块 | 权限点 |
| --- | --- |
| system | `user.read` `user.manage` `user.delete` `role.read` `role.manage` `audit.read` |
| personal | `launch.read` `launch.write` `note.read` `note.write` `event.read` `event.write` |
| ops | `shop.read` `finance.read` `collect.read` |

四个内置角色按 `rank` 分层，owner 100 / admin 80 / member 50 / viewer 10。合并顺序固定为「角色权限 ∪ 账号授予 − 账号拒绝」，拒绝在后，避免结果依赖写入顺序。

ops 段把「能进页面」与「能看金额」拆成两个点，这是该模块唯一非做不可的设计。合成一个点只有「全看」与「全不看」两档，实际结果是所有人拿到全看。

### 4.3 导航与路由的派生关系

`NAV_ITEMS` 是扁平可路由清单，侧栏、路由表、可见性过滤都从它派生。分组头是纯折叠按钮，不承担路由。子项路径由 `分组段/路径段` 拼成，例如 `/ops/dashboard`。

这条设计的收益在改动时体现。新增一个模块只改 `shared` 一处，`routes.tsx` 一行不动。

---

## 五、已交付功能清单

| 模块 | 状态 | 内容 | 证据 |
| --- | --- | --- | --- |
| 账号与权限 | 完成 | 登录、双令牌轮换、限速、首次初始化、审计、账号管理、角色清单 | `auth/`、`routes/system-users.ts`、`UsersPage.tsx` |
| 个人工作台 · 首页 | 完成 | 案例展示横滑、一键启动 4×2 Bento、纪要卡与事件卡 | `HomePage.tsx` 及 `components/home/` |
| 一键启动 | 完成 | 配置增删改排序、启动、自检、真实图标、桌面快捷方式 | `launch/`、`desktop/src/agent.ts` |
| 工作纪要 | 完成 | 富文本 markdown、草稿、按 id 同步 | `notes/`、`NotesPanel.tsx` |
| 事件记录 | 完成 | 新增、勾选完成、优先级、时间线 | `events/`、`EventsPanel.tsx` |
| 运营看板 | 完成，单店有数据 | 七入口、五店并列、区间与店铺写进地址栏、金额按权限裁剪、ETag、静默重取 | `routes/ops.ts`、`OpsDashboardPage.tsx` |
| 数据采集 | 单店闭合，多店已写未提交 | 17 页采集、契约导出、三级校验、五步管道、多店槽位与登录检查 | `tools/collector/scripts/` |
| 桌面外壳 | 完成，0.2.0 已发 | 静态服务、反代、凭据保险箱、四步更新流程、代码签名 | `desktop/src/`、`release/` |
| 客户信息平台 | 占位 | 综合看板、客户进度，仅规划文案 | `navigation.ts` 中 `planned: true` |
| 资产 / 搜索 | 占位 | 一级入口，对象清单未定 | 同上 |
| 服务体验 / 推广投放 / 内容运营 | 空壳 | 页面显示待接入清单，无演示数字 | `docs/ops/README.md` 欠账表 |

---

## 六、阶段判断

把已完成的工作按「能不能独立产生价值」排一遍，位置比较清楚。

```
阶段零 项目初始化              完成
阶段一 账号与权限              完成
阶段二 主框架与 UI 骨架        完成
阶段三 个人工作台三板块        完成
阶段四 桌面外壳                完成
阶段五 容器化与部署            完成（T5-05 由用户决定维持现状）
阶段六 打包签名与更新通道      完成，已发 0.1.0 / 0.1.1
阶段七 账号管理与界面来源      完成 T7-01 / T7-02；T7-03 / T7-04 仅设计稿
阶段八 运营看板（计划外）      0.2.0 发布，链路三段收口
```

当前处在阶段八的尾部。判据有三条。第一，运营链路从抓取到推送已经端到端跑通，10-19 真实数据五步全过，整体退出码 2（有缺口但可入库）。第二，多店采集的代码已写完，尚未提交，且从未在真实账号上跑完整日增。第三，看板七个入口里有三个没有数据源，属于「界面先行、数据待接」。

用一句话概括：**从「功能开发」转向「数据运营与多店扩张」的过渡点。**

这个判断有一个反面证据需要摆出来。运营看板的成熟度在三个板块上并不一致。交易、商品、流量三段有真实数据，服务、推广、内容三段是空壳。所以「运营看板已完成」这句话只在「框架与链路」这个层面上成立。

---

## 七、技术债与风险

### 7.1 P0（会阻塞或产生错数据）

| # | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| 1 | 本机依赖是上一台机器的符号链接（已解决） | 已重装依赖，`/f/` 链接归零，四道门禁实跑出数 | 已恢复可验证状态；诊断与修法见批次 0 |
| 2 | `s2` / `s3` 库内名称与配置文件不一致（已解决） | 库内原为「分店 2」「分店 3」，`shops.config.json` 原为「雅素定制家具」「简作美学定制」 | 首次采集入库会静默改名，upsert 用 payload 覆盖库内 name。已由用户拍板统一为「雅素」「简作」，主店同一轮改为「梵禾」 |
| 3 | 多店采集 16 个文件未提交（已解决） | 六笔 26 个文件入库，全部显式列路径 | 工作区已干净，只剩按惯例不入库的目录 |
| 4 | 桌面端 0.2.0 不含 10-21 推送段改动 | `apps/web/dist` 时间为 10-20 23:48，ETag 与超时写入于 10-21 16:20 | 用户装到的版本没有超时保护、没有静默重取、没有 304 |

### 7.2 P1（正确性与可靠性）

| # | 问题 | 位置 |
| --- | --- | --- |
| 5 | `latestCoveredDate()` 不带 `shopId`（已解决） | 改为 `latestCoveredDate(shopCode)` 按店取锚，并列口径另立 `latestCoveredDateAllShops`，`799557f` |
| 6 | 渠道树接口从未被触发 | `flow-shopsource` 页只发 `getCurrentTime` 与 `shop_source_overview_v4`，渠道维度永远停在回填值 |
| 7 | `running` 无过期判定 | 事务失败且补写 `failed` 也失败时，界面永久显示「采集中」 |
| 8 | 计划任务运行身份未定 | 采集依赖已登录图形会话，服务账户跑不起来 |
| 9 | 维度快照按「重叠天数最多」近似匹配 | 查近 7 天时可能选中 30 天快照，商品榜实际是 30 天的榜 |

### 7.3 P2（策略待定）

| # | 事项 | 现状 |
| --- | --- | --- |
| 10 | 千牛直采是否走系统代理加本地 CA | 三条口子已实测堵死，仅剩这一条，侵入性最大，不建议启动 |
| 11 | 已写但无来源的 cookie 工具 | `cookie-crypt.mjs`、`shop-cookie-inject.mjs` 等，留着等真实来源 |
| 12 | 多店首次登录 | `s2` / `s3` 各需人工登录一次 |
| 13 | 日增未挂计划任务 | 两步需人工接力 |

### 7.4 文档可信度

这一节单独写，因为陈旧基线比没有基线更危险。

| 文档 | 过期内容 | 现值 |
| --- | --- | --- |
| `docs/DEVELOPMENT-PLAN.md` 顶部状态行 | 门禁 599 项、7 迁移、13 表、12 权限点 | 924 项、8 迁移、18 表、15 权限点 |
| `docs/HANDOVER-2026-10-21.md` 环境节 | 运行时路径写作 `C:\Users\Administrator\...`，示例盘符 `/f/` | 本机为 `C:\Users\dy\...`，盘符 `E:` |
| `docs/ops/README.md` 五店表 | 写作「分店 2 至 5」 | 库与配置已统一为「梵禾」「雅素」「简作」，该表仍按占位口径描述 |

`DEVELOPMENT-PLAN.md` 的状态行是判断「库是不是坏了」的第一入口，它写着 7 迁移，而实际是 8。这类偏差会把人引向「迁移丢了」的错误结论。

---

## 八、下一步任务

排序原则有三条。环境先于代码，因为不可验证的改动无法验收。数据正确性先于功能扩展，因为错数据比缺功能更难发现。收口先于新开工，因为未提交的工作每多一天，丢失成本就多一分。

### 批次 0 · 恢复本机可验证环境（P0，先决）

**目标** 让四道门禁在本机跑通，把「924 项全绿」从文档结论变成本机事实。

**做法**
```bash
cd projects/fanhe-work
../../infra/portable/ws-run.sh pnpm install > ../../.tmp/install.log 2>&1
```
日志落盘，不接管道。若报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，加 `CI=true --config.confirmModulesPurge=false`。`node_modules` 里已有 748 个 `.pnpm` 包实体，全局 store 在 `%LOCALAPPDATA%\pnpm\store\v11`，大概率是重建链接而非全量下载。

**判据** `packages/shared/node_modules/typescript` 指向 `E:`；`find . -maxdepth 4 -type l -lname "/f/*" | wc -l` 为 0；`pnpm test` 输出四包合计数字。

**风险** 可能耗时数十分钟。若 `.pnpm` 实体不完整，需要联网下载。

### 批次 1 · 多店采集定名与提交（P0）

**目标** 把已完成的多店能力落地入库，并消除改名风险。

**1.1 定名** 已完成。对外全称定为「梵禾」「雅素」「简作」（主店 / s2 / s3），`ecom_shops` 与 `shops.config.json` 已逐字一致，`ops-seed-shops.ts` 的 create 分支与 `export-ingest.mjs` 的回填 payload 同步改过。s4、s5 仍为占位名。

**1.2 提交** 已完成，共 26 个文件分五笔：`feat(infra)` 链接脚本 1 个，`docs(infra)` 依赖机制说明 1 个，`feat(collector)` 16 个，`fix(ops)` 种子脚本 1 个，`docs` 交接与运维 9 个。均显式列路径。四道门禁在改动后重跑全绿。

**判据** `git status` 只剩按惯例不入库的目录；`git ls-remote origin HEAD` 与本地一致。

**依赖** 批次 0 不是硬依赖，但提交前应先让门禁能跑，否则无法确认提交内容是否破坏基线。

### 批次 2 · 多店正确性修正（P0，紧随批次 1）

**2.1 锚点带店铺（已完成 `799557f`）** `latestCoveredDate(shopCode)`，`shopCode` 为 null 时走 `loadShop` 的默认店规则，与 `loadOpsDashboard` 的选店同源，避免出现「锚点取 A 店、数据取 B 店」。`resolveRange` 改成接收锚点函数，单店看板传 `latestCoveredDate(shop)`，五店并列传 `latestCoveredDateAllShops`，两个口径必须分开：并列那张表同屏比较五家，锚点取全库最大，退回按店会让最新那天被裁掉。

判据已达成：`apps/api/test/ops-anchor.test.ts` 8 条用例，覆盖「两店日期不同各自锚点正确」「有店无数据返回 null」「店不存在返回 null」「接口带 shop 时区间止于该店末日」。反例实测两次：去掉按店过滤 → 5 条转红（含接口用例）；把并列接口改成按店 → 第 7 条转红，而只断言「区间止于全库最大」的第 8 条仍绿，说明第 7 条这种「造一家比默认店更新的店」的写法不可省。

**2.2 `running` 过期判定（已完成 2026-10-21）** 按采集耗时分布定阈值，超时视为失败。判据是构造一条停留在 `running` 的记录，界面不再显示「采集中」。

实测依据：库里 4 次成功入库耗时 0.107 / 0.107 / 0.129 / 0.200 秒（含一次 30 天回填），量级是「一次事务」，故取 `OPS_LIMITS.COLLECT_RUNNING_TIMEOUT_MS = 10 分钟`（3000 倍余量）。**它衡量的是入库这一步，不是浏览器抓取那一段** —— 抓取耗时不在 `ecom_collect_runs` 里。

实现取舍：判定放 `packages/shared` 的纯函数 `isCollectRunStale`，由 api 算好 `stale` 字段放进 `OpsCollectRunSummary`，web 只负责文案与色档。**不把库里的 `status` 改写成 `failed`** —— 那条 `running` 是审计事实，读路径上改写会让「补写失败」与「真的失败」在库里长得一样。`loadOpsHealth` 的时间基准由参数注入（默认 `Date.now()`），测试才能把记录放到「十一分钟前」而不用等。

判据达成：`packages/shared/test/ops.test.mjs` 4 条（阈值两侧、只有 running 判超时、时间不可解析不误报、阈值取值）+ `apps/api/test/ops-health-stale.test.ts` 3 条（超时标 stale 且 status 不改写 / 未超时不标 / 已完成的记录多老都不标）+ `apps/web/test/ops-display.test.mjs` 1 条（「采集中断」文案与 bad 色档，且 `stale` 只对 running 生效）。变异实测两次：去掉状态守卫 → shared 1 条转红；把 `stale` 恒置 false → api 3 条中 2 条转红。


**2.3 渠道树补采** 在真实浏览器里试交互或构造请求，确认 `tree_platform_support` 能否触发。这条需要登录态，做不成也要把「未验证」写进文档，不要标成已完成。

### 批次 3 · 发布 0.2.1（P0，依赖批次 1、2）

**目标** 让 10-21 的推送段改动真正到达用户桌面。

**顺序** `web build` → `sync-version` → `dist` → `verify:sign` → 三项核对（版本号、签名、`latest.yml` 的 sha512）→ 打 tag。

**判据** `apps/web/dist` 时间晚于 16:20；线上 `latest.yml` 的 sha512 与本地一致；安装后 `app.getVersion()` 返回 0.2.1。

**为什么必须放在这里** 前端改动是构建产物。0.2.0 的安装包里，ETag、15 秒超时、`visibilitychange` 静默重取都不存在。只改代码不重打包，等于这三项从未交付。

**已完成（2026-10-21 22:05）** 版本 0.2.1，`v0.2.1` 已公开发布（release id `419625037`）。本地打包与四项核对见 `docs/RELEASE-0.2.1.md` 7.1—7.5。**发布之后又补了一步**：`api` 与 `web` 容器此前仍是旧镜像，锚点修复在宿主代码里但线上行为没变；已 `build api web` + `up -d --force-recreate`，判据为「带 `shop` 请求的 `range.to` 跟店铺走」——实测默认店 `2026-09-20~2026-10-19`、`shop=s2` `2026-09-22~2026-10-21`（s2 无数据退回以今天为锚），三条响应均带 `etag`。

### 批次 4 · 客户信息平台最小闭环（P1，产品主线）

**目标** 把「客户进度」从占位变成可用。它是三段式首页之外唯一与主业强相关的模块。

**前置** 对象清单与权限点未定。这一步必须先做，否则会重复运维看板踩过的坑：先编权限点，再发现对象清单不对。

**建议范围** 先定 `customer` 模块的对象（客户、方案、进度节点），追加权限点，再建表与迁移。综合看板依赖客户进度有数据，排在它后面。

**判据** 新增权限点后同时重建 `migrate` 与 `api` 镜像，前端菜单整组可见，且 `ALL_PERMISSIONS.length` 与清单一致。

### 批次 5 · 千牛直采（P2，待拍板，不建议现在做）

系统代理加本地根 CA 能拿到原始 mtop JSON，代价是改系统代理并信任一个本地根证书。现有「Edge 每店 profile 加 CDP」已经能拿到同构数据，多店成本只是每店登录一次。除非多店数量上到十个以上，这条路的收益不足以覆盖侵入性。

---

## 九、本次验证记录

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 目录与包结构 | 读盘 | 已核实 |
| 迁移数与表数 | `psql` 查 `_prisma_migrations` 与 `pg_tables` | 8 / 18 |
| 店铺与数据行数 | `psql` 查四表 | 5 店；31 / 88 / 4 行；`users` 7 行 |
| 容器状态 | `docker ps` | api、web、db、cloudflared 均 Up |
| 构建产物时间 | `ls -la apps/web/dist` | 10-20 23:48，早于推送段改动 |
| 四道门禁 | 实跑 `pnpm test` | **未通过，原因非断言失败** |
| 依赖完整性 | 读符号链接 | 527 个指向 `/f/`，已失效 |

门禁失败的具体输出。

```
packages/shared test: Error: Cannot find module
  'E:\fanhe Work\projects\fanhe-work\packages\shared\node_modules\typescript\bin\tsc'
  code: 'MODULE_NOT_FOUND'
ELIFECYCLE  Test failed.
```

这是依赖链接失效，与 `0.2.0` 时代记录的「924 项 0 失败」不矛盾。两者不在同一台机器的同一状态下。**本次没有验证任何一项门禁，不把文档结论当作本机事实。**

---

## 十、一页速查

```
先做什么   重装依赖，让门禁能跑
再做什么   确认 s2/s3 名称，提交 16 个文件
紧接着     锚点带 shopId，修 running 过期
然后       重打 web 产物，发 0.2.1
之后       客户信息平台定对象与权限点
不要做     千牛系统代理方案
```
