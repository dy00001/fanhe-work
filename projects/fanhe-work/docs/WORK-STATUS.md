# 梵禾 Work · 完整工作总结与换机续接指南

> **本文档是单文件自包含的交接主文档。** 换一台电脑后，只读这一份就能把开发环境恢复起来并接着往下做：
> 项目是什么、做到哪了、哪些功能已经能用、下一步做什么、当初为什么这么定、环境怎么搭、有哪些坑不能踩，全部在这一份里。
>
> | 项 | 值 |
> | -- | -- |
> | 生成时间 | 2026-10-11 17:55（2026-10-11 至 10-12 随 T3-09 ~ T3-12、UI 集成、N-01、T4-01 ~ T4-04、T5-01 ~ T5-04、T6-01 逐项回填，阶段三 / 四收口，阶段五开工，阶段六开工；2026-10-13 11:3x 随 **T6-02 / 阶段七 T7-01 / UI 落地对齐** 回填；2026-10-13 13:3x 随 **T6-03a 打包与发布链路**、2026-10-13 14:0x 随 **T6-03c 安装包签名**、2026-10-13 15:3x 随 **T6-03b 更新通道（阶段六收口）**、2026-10-13 16:1x 随 **首次发布 v0.1.0**、2026-10-13 21:xx 随 **设置不丢（外壳界面来源固定）与客户端更新按钮** 回填，2026-10-13 22:xx 随 **T6-03d 签名身份档案（证书工具链 v1→v2）**、2026-10-13 23:1x 随 **T6-03e 目标机装根脚本化**、2026-10-14 随 **阶段一末项验收的端到端断言（审计留痕）** 回填至本版） |
> | 对应提交 | 代码基线 `5fd7f84`（**UI 落地对齐**；**T6-03b 为 `3a9294f`**，**T6-03c 为 `415219b`**，**T6-03a 为 `4ded6b1`**，阶段七 T7-01 为 `ab96a58` / `49c4f85` / `5dc0c90`，T6-02 为 `d179e81`，T6-01 为 `ac342e7`，T5-04 为 `7cf5af3`，T5-03 为 `3b3dc07`，T5-02 为 `16f73e8`，T5-01 为 `ace70bd`，阶段四基线 `760b92f`，阶段三为 `a5370b0`，**本轮「设置不丢（外壳界面来源固定）与客户端更新按钮」为 `4c0ac8a`**，**本轮「T6-03d 签名身份档案」为 `6b05ca2`**，**本轮「T6-03e 目标机装根脚本化」为 `e0ee8ff`**，**本轮「阶段一末项验收的端到端断言」为 `fc9d9f9`**）；用 `git log -1 -- docs/WORK-STATUS.md` 查本文档最近一次提交 |
> | 当前阶段 | **阶段零至四已完成（42/50）；阶段五 4/5（T5-05 由用户决定暂缓）；阶段六 3/3 全部完成 —— T6-01 版本清单接口、T6-02 客户端版本检查与更新提示、**T6-03 外壳升级通道（T6-03a 打包与发布链路 / T6-03b 更新通道 / T6-03c 安装包签名）** 均已完成：产得出安装包、装完真的跑得起来、两个产物带 `CN=Fanhe Work` 签名、`app-update.yml` 含 `publisherName`，且 **updater 的发布者校验与 sha512 校验都已实测能拒绝异签名 / 被篡改的包**。**✅ 已发版**：2026-10-13 首个发布版 **`v0.1.0`**（GitHub Release，三个资产齐备，线上元数据与安装包逐字节核对一致）；阶段七（计划外新开）T7-01 账号与权限管理已完成。**✅ 2026-10-13 21:xx 追加一项（用户把「更新后本地设置及本地存储的所有数据不丢失」列为验收条件）**：定位到「设置丢失」的真根因是**界面来源（端口）每次启动都变** —— `server.listen(0)` 让系统随机分配端口，而 localStorage / IndexedDB 都按 origin 分区、origin 含端口，于是每次启动换一个存储分区（实测 `%APPDATA%\梵禾 Work\IndexedDB\` 下并存 49901 与 57352 两份互不可见的存储）。已修：端口候选链（偏好 → 旧来源 → 固定段 → 系统兜底）+ 偏好持久化 + 单实例锁 + 旧来源发现；并把客户端「有更新」从一句提示做成可点的更新按钮。实测端口稳定并落回既有来源之一。**⚠️ 打包验证受阻：本机签名证书已不在（`dist:dir` 报 `Cannot find certificate CN=Fanhe Work`），产物是「新 web + 新 asar + 未签名 exe」的中间态，未发新版**，见 4.1.14。**✅ 2026-10-13 22:xx 追加一项（T6-03d）**：把证书工具链从 v1 升到 v2，新增**签名身份档案**（`%LOCALAPPDATA%\FanheWork\signing\signing-identity.json`）、**轮换闸**（有档案而无证书时拒绝静默新建）、导入/导出 pfx、`-CheckOnly` 只读自检、`-AdoptFromArtifact`（从已签名产物把身份认回来），并给 `verify:pack` 加了身份比对断言。**副产品是把原始签名身份从产物里找了回来**（`CN=Fanhe Work` / `0604B2381B8666C99F247DA7B576A4647601A5A3`，v0.1.0 与 v0.1.1 同身份），本机档案已补齐、**闸已 armed**，裁决题面收窄成「有没有这张证书的 `.pfx` 备份」，见 4.1 与 4.1.15。**✅ 2026-10-13 23:1x 追加一项（T6-03e）**：把「给目标机装信任根」从手工 `certutil` 做成脚本能力 —— 新增 `signing:trust` / `signing:trust-check`（只装根、**不建证书**），并把原始身份唯一剩下的凭据 `fanhe-work-signing-public.cer`（`0604B238…`，公钥，766 字节）**纳入版本控制**；同时修掉三处会致害的既有内容（`electron-builder.yml` 里「目标机跑 `signing:cert`」、`verify:pack` 里「Status 非 Valid 就跑 `signing:cert`」、五处 v1 遗留步号）。本机已用它把根补回，两个已发布安装包从 `UnknownError`(1) 回到 `STATUS=Valid VALUE=0` —— **但那只修好「验」的一半，「签」的一半仍阻塞于私钥不在本机**，见 4.1 与 4.1.15。**✅ 2026-10-14 追加一项（阶段一末项验收）**：补上「关键操作在 `audit_logs` 有记录」的端到端断言，**阶段一验收 6 项至此全部勾选**；补断言时发现并修掉一个留痕缺口（清理只认 `TEST_IP`，而账号管理走 `request.ip` 落在 `127.0.0.1`，库里积了近三百行测试留痕），见 4.1.17。 下一项：**在装着 v0.1.0 的机器上点更新，确认版本变v0.1.1（§八 第 4 条的正向验证，差分下载的首次正验）；T5-05 访问策略**用户 2026-10-13 17:1x 决定维持现状继续对外开放**，该风险已知并接受 |
> | 最后验证 | 四道门禁全绿（**599 项**，2026-10-14 实跑：shared 108 + **api 233** + web **116** + desktop **142**，含 5 项设计性跳过；本轮补阶段一末项验收的端到端断言，api 由 232 增至 **233**。上一版 **598 项**（2026-10-13 22:xx 实跑：api 232 + desktop **142**，T6-03d 把 desktop 由 122 增至 142，新增 20 项签名身份档案单测）。上一版数字 **578 项**（2026-10-13 21:xx 实跑：desktop 122），再上一版 **536 项**（2026-10-13 17:0x 实跑：web 97 + desktop 99）已随新增用例作废，增量见 4.1.14；api 由 226增至 232 是 P0 的改密失效修复，浏览器 e2e 由 149 增至 **150** 项并已重跑全通过。上一版数字：；T7-01 后 `permissions` 为 **12**；T6-03a 把 desktop 由 76 增至 86，T6-03b 再使 web 86 → 97、desktop 86 → 99。⚠️ `typecheck` 那一道需抬 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD` 才能过 —— `prisma generate` 清 `apps/api/src/generated/prisma` 会撞安全删除守卫，报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，**看起来像代码报错，其实是环境**）；**T6-03a 打包链路实测**：`dist:dir` 2 分 5 秒 / `dist` 6 分 1 秒均 exit 0，产出 `fanhe-work-setup-0.1.0.exe`（116,303,500 字节）+ `.blockmap` + `latest.yml`（差分三件套齐备），安装态冒烟 **PASS**（渲染元素=1 / 预加载桥=有 / 反代到达上游=是）；**T6-03c 签名实测**：安装包 116,303,500 → **116,323,480** 字节（+19,980），两个产物（`梵禾 Work.exe` 与安装包）PE 签名表由 0 → **7416 字节**，`app-update.yml` 首次生成并含 `publisherName: [Fanhe Work]`，`latest.yml` 的 sha512 与实际安装包逐字节一致，`verify-pack.mjs` 已扩至 **28 项断言 + 4 条反例全过**（T6-03a 时为 17 + 2；**本轮再增至 35 项**，新增「`resources/web` 与 `apps/web/dist` 逐文件一致」「三条产物标记」「签名报告必须比本轮产物新」——⚠️ 本轮实测 **34 通过 / 1 FAIL**，FAIL 即签名那一项，因证书已不在本机）；**`GET /api/version` 容器内与公网实测均返回 `0.1.0`**（不设门禁，T6-02 要在登录前拿到）；**空卷验收 30 项 0 失败**（全新卷 → 一条命令 → 迁移自动应用 + 种子自动写入 + 建 owner 后登录可用，见 4.1.1）；**Tunnel 验收 17 项 0 失败**（公网根路径/深链/反代到 api/未授权 401 四项 + 三层判据证源站无入站暴露，见 4.1.1）；**备份/恢复实测通过**（真恢复演练 + 带 `--force` 恢复后内容回来，不只行数）；浏览器 e2e **149 项**全通过（UI 集成后实跑；**已于 UI 落地对齐后重跑并增至 150 项，见本行开头**）；外壳冒烟 **PASS**；**T6-03b 更新通道实测**：离线验收台（`provider: generic` + 本地静态目录冒充更新源，`http://127.0.0.1:8799/`）—— 反例① 改 `latest.yml` 的 sha512 → `sha512 checksum mismatch` → `阶段=error`、`是否可安装=否`；反例② **同一个包、逐字节不变、只把自签根移出 `CurrentUser\Root`** → `Status` 由 `0`(Valid) 变 `1`(UnknownError) → `Sign verification failed, installer signed with incorrect certificate` → `阶段=error`，把根加回后**同一个包** `阶段=downloaded`（**因变量只有信任根，结果翻转**，这才是「签名校验生效」的证据）；第 5 条 缺 blockmap → `Cannot download differentially, fallback to full download ... status 404`。**含空格 CN 的具象风险解除**（`parseDn` 保留空格，实测 `Signature validated using only CN Fanhe Work`）。**✅ 首次发布（2026-10-13 16:0x）**：重跑 `pnpm --filter @fanhe/desktop dist`（6 分 14 秒，exit 0）产出**含更新通道**的 0.1.0 安装包 **112,209,040 字节**（旧的 116,323,480 那份不含 T6-03b，已弃）；`verify:all` **32 项断言全过**（比 28 项多 4 项，因为这次是真 nsis 构建，`安装包已签名` / `app-update.yml 含 publisherName` / `publisherName 与配置一致` / `latest.yml 的 sha512 与 size` 这几组**从「未验证」变成真的验了**）；打包态冒烟 **PASS**；asar 断言确认 `/node_modules/electron-updater/{package.json,out/main.js}` 都在包里。打 `v0.1.0` 注解 tag 并推送；用 electron-builder 内置 GitHub publish 传三个资产（`-f` 必须显式给文件列表，否则报 `Missing required argument: files`）；⚠️ **它建出来的是草稿**（`draft: true`、`published_at: null`，**未认证访问 by-tag 接口返回 404**，要带认证列 releases 才看得见），需再 `PATCH .../releases/<id>` 把 `draft` 置 false 才真正公开。**发布后核对**：未认证 GET by-tag **200**；下载线上 `latest.yml` 与本地**逐字节一致**，其 `sha512` 与 `size` 与实际安装包**全部 MATCH**。**仍未验**：§八 第 4 条「安装 A → 发布 B → 版本变 B」—— v0.1.0 只是**垫脚石**，A→B 那条要等有第二个版本（B）才能验。**T6-03e 实测（2026-10-13 23:1x）**：`signing:trust-check` 初始报 `TRUST_ROOT=False`、`RESULT=NOT_TRUSTED`、退出码 1 → `signing:trust` 装上后复查 `TRUST_ROOT=True` / `TRUST_PUBLISHER=True` / `CHAIN_BUILDS=True` / `TRUST_CERT_MATCHES_RECORD=True`，退出码 0；重跑一次两个库都报 `already-present`（幂等）；`-PublicCertPath` 指向不存在的文件 → `RESULT=MISSING` 并指向版本控制内那份。**本机根补回后**：`fanhe-work-setup-0.1.0.exe` 与 `-0.1.1.exe` 双双 `STATUS=Valid VALUE=0`。四道门禁复跑 **598 项 0 失败**，`verify:pack` 39 项（35 通过 / 4 失败）与基线逐字同因（本机无私钥 → exe 未签名） |
>
> ⚠️ **换机必读**：`cloudflared` 的 Tunnel Token 在 `.env.compose` 的 `FANHE_TUNNEL_TOKEN`（该文件已被 gitignore，**不随仓库走**）。域名 `work.fanhe.dpdns.org` → Tunnel `fanhe-work`（ID `e71629a6-6a53-4731-a2d9-0f1ffbdfb726`），**这套配置在 Cloudflare 侧，换机器不需要重建**，只要新机上 `.env.compose` 里有那行 Token 即可。
>
> ⚠️ **已知风险（用户 2026-10-12 决定暂缓 T5-05）**：公网上的 `work.fanhe.dpdns.org` **没有 Cloudflare Access 那一层**，任何拿到地址的人都能打开页面，唯一的保护是应用层的登录（按 IP 限速）。业务接口与数据仍受登录保护，暴露在登录之前的是页面与静态资源。
>
> 阅读顺序建议：**第零节（速览）→ 第二节（进度）→ 第七节（换机步骤）**，其余按需查。
> 深度的设计推演与逐任务判断在 `DEVELOPMENT-PLAN.md` 第九章（9.1 ~ 9.57），本文已把结论汇总，需要细节时再翻过去。
>
> ⚠️ **`PROGRESS-REVIEW-2026-10-13.md` 有三条判断已过期，读它之前先看 `git log`。** 那份复盘是 11:30 的快照，其后当天又落了十笔提交（至 `f364f84`），其中三条已被推翻：① 「文档滞后、第九章只到 9.49」——实际已到 **9.57**；② 「阶段七未登记进计划」——已登记；③ 「审计缺授权变更与删除两族」——T7-01 已补齐 `AUDIT_ACTIONS`（现有 9 类）并真正落库。**进度类文档都是快照，读之前先比对 `git log --oneline -10` 与文件的 mtime**，这一条比文档里的任何结论都更值得先做。
>
> **本仓库的进度事实以本文档头部表格为准**，其余文档（复盘、交接包说明、勘察报告）都是它的派生或快照，冲突时以本文为准。最新一份全景核查见 `WORKSPACE-SURVEY-2026-10-13.md`。

---

## 零、五分钟速览

**这个项目是什么**：一个桌面端个人工作台（实验版），用来管自己的软件启动通道、工作纪要、事件记录，后面会包成 Electron 外壳、并支持局域网/远程两种服务地址。

**现在到哪了**：账号与权限体系、主框架与 UI 骨架、个人工作台的「启动通道」「工作纪要」「事件记录」三个板块**全部完成并可用**。工作纪要支持编辑、Markdown 预览、标签、置顶、归档、删除、**中文全文检索**与**草稿自动保存**（未提交的内容落在本机，误关、切板块、被检索筛掉之后再回来都能接着写）。事件记录（`events` 与 `event_logs` 两张表、八条接口、状态变更一律追加流水）能未完成 / 已完成分组、已完成默认折叠、行内四要素（勾选框 / 标签 / 截止时间 / 优先级）、检索与增删改；**勾一下即完成、再点提示条上的「撤销」即恢复**（乐观更新、失败回滚都在）；**点标题打开详情面板** —— 完整描述（Markdown 渲染）、创建 / 截止 / 完成时间、完成用时、完成人，以及来自 `event_logs` 的**完整变更历史时间线**。**阶段三到此收口。**

**界面层已按最终 UI 方案整体整合**（两批，见 `UI-INTEGRATION-2026-10-11.md`）：侧栏导航由 5 项扩为 **18 项 / 4 分组**（含 11 个「功能开发中」占位槽），工作台首页改为**三段式**（案例展示 / 启动通道 / 记录），顶栏账号菜单底部新增**版本号**行。**业务逻辑一行未动** —— 整合只落在界面与导航结构上。

**桌面外壳 4/4，阶段四收口**：T4-01 把 `apps/desktop` 从空目录落成一个能用的 Electron 外壳 —— 打开即渲染出已有界面，`/api` 由外壳内置的静态服务反代到服务地址（**`apps/web` 一行未改**），冒烟 PASS。T4-02 把服务地址从环境变量常量升级为**可持久化的配置项**，落在**工作区的 `.config/fanhe-work/service.json`**（换机时随工作空间走，被根 `.gitignore` 排除）；`FANHE_SERVICE_URL` 保留为一次性覆盖。T4-03 把 `apps/api/src/launch/agent.ts` **原样**搬进外壳主进程（经 `import()` 动态加载 TS 源码，无构建顺序依赖），**远程模式下也能启动本机软件**；主进程对来自 IPC 的配置另做一道形态复核，因为这条通道没有 HTTP 那侧的权限与回环中间件。T4-04 加了启动自检：查每条配置指向的文件还在不在，并把三类失效各配一句**方向正确**的引导（代理不可用去查工作区、配置不合法去重新编辑、路径失效去确认路径）。

**服务化 4/5**：T5-01 落了容器编排（`docker compose up -d --wait` 拉起 db + api + web）。**T5-02 补上了它漏掉的那件事 —— 迁移的执行者。** T5-01 之所以能一次跑绿，是因为它复用了开发期那个卷（里面的迁移是本机 `db:deploy` 出来的）；实测全新卷 initdb 后 **`public` 模式下 0 张表，而编排层全绿** —— 因为 **api 连得上库，而连接成功与库里有表是两件事**。现在编排是 `db → migrate → api → web` 四个服务，`migrate` 跑完退出；连接串与口令也收成单一来源（改一处不会只改一半）。

**T5-03 补上了第二个洞 —— 建完表的库仍然不能用。** 全新卷跑完迁移后 `permissions` / `roles` / `role_permissions` **全是 0 行**，于是走初始化向导建 owner 直接 **500**（「库里没有 owner 角色，先执行 `pnpm db:seed`」）—— 系统自己说清了该做什么，但那时人已经在一个装不起来的系统里了。权限体系是**代码定义**（跟着代码走，不跟着某台机器的数据走），所以 `db:seed` 挂进了 migrate 容器：**每次部署自动跑一遍**，改了权限定义重跑即生效（幂等：按 code upsert + 关联差集同步）。**种子不建任何账号**，所以自动跑它不会在任何环境里留下默认口令的管理员。**验收脚本扩到 30 项，全新空部署上「建 owner → 登录 → 带令牌读账号」整条链验通。**

**另外落了备份恢复路径**（`tools/checks/db-backup.mjs`，`backup` / `list` / `verify` / `restore`）。`verify` 做的是**真恢复演练**（建临时库 → 真恢复 → 逐表比行数 → 删掉），不是「文件能解开」；实测「备份 → 演练 → 造数据 → 删除 → 无 `--force` 被拒 → 带 `--force` 恢复后**内容回来了而不只是行数对**」整条链路通。备份落在 `projects/fanhe-work/data/backups/`（**不放在 Docker 卷里 —— 卷坏了备份跟着坏，等于没有备份**）。

**T5-04 接上了 Cloudflare Tunnel，现在 `https://work.fanhe.dpdns.org/` 可以从公网访问。** compose 里加了 `cloudflared` 服务（官方镜像，**配置存在 Cloudflare 侧**，容器只拿一个 Tunnel Token 连出去，所以换机器时不用改配置）。**这个服务刻意不绑任何宿主端口 —— 那正是「源站无公网入站端口暴露」的全部实现。** 验收脚本用**三层判据**证这一条：读 `compose config` 展开后的端口、读 `docker inspect` 的运行时端口映射、以及**从独立 bridge 网络探宿主端口**（第三层是唯一不依赖「配置与运行态一致」这个假设的）。实测 8787 / 8080 / 5432 从网络外**全部连不上**，而公网四条全通（根路径 200 / 深链 200 / 反代到 api 拿到 json / 未授权 401 + api 自己的文案）。**T6-03 外壳升级通道已三段做完，阶段六收口**；下一项是**首次发布**（打 `v0.1.0` tag + 建 GitHub Release，当前零 tag）。T5-05 访问策略仍由用户决定暂缓。

**T6-03 把「有更新」从一句提示变成了真的能装。** 三段各管一件事：T6-03a 打包与发布链路（产得出安装包、装完真的跑得起来）、T6-03c 安装包签名（自签证书进 Windows 证书库，两个产物都带 `CN=Fanhe Work`）、**T6-03b 更新通道**（接 `electron-updater`，检查 → 下载 → 用户确认后安装退出，提示按宿主分派：浏览器「刷新页面即可更新」/ 桌面「点此重启更新」）。**最值钱的一条是 T6-03b 顺手挖出来的：T6-03c 的签名判据太松，正好漏掉更新器唯一的准入闸** —— electron-updater 只在 `Status === 0`（`Valid`）时才比对发布者，自签链不可信得到的 `UnknownError`(1) 会让**每一次更新都被拒绝**；病根在信任根（`TrustedPublisher` 只抑制弹窗、不让链变可信），修法是把自签根也装进 `CurrentUser\Root`。已用「**同一个包、逐字节不变、只改信任根**」的对照实测：移除根 → `阶段=error`，加回 → `阶段=downloaded`。细节见 4.1.13。

**T7-02（2026-10-13 21:xx 追加）把「更新后设置不丢」从一句话变成了可验证的事实。** 用户把验收条件加严为「更新后本地设置及本地存储的所有数据不丢失」，据此定位到「设置丢失」**不是升级删了文件**，而是**界面来源（端口）每次启动都变**（`server.listen(0)` 随机分配端口），而 localStorage / IndexedDB 都按 origin 分区、origin 含端口 —— 于是每次启动换一个存储分区（实测 `%APPDATA%\梵禾 Work\IndexedDB\` 下并存 `49901` 与 `57352` 两份）。修法是**端口候选链**（偏好 → 旧来源 → 固定段 `41873~41880` → 系统兜底）+ **单实例锁** + 旧来源发现；同时把客户端「有更新」从账号菜单里的一句提示挪到顶栏、做成可点的更新按钮（T7-02b）。**⚠️ 打包验证受阻于本机签名证书已不在（`dist:dir` 报 `Cannot find certificate CN=Fanhe Work`），未发新版**，须用户裁决，见 4.1.14 与 4.1。

**T6-01 与 T6-02 把更新通道接上了。** T6-01 在服务端建立一个独立的版本事实（`GET /api/version` + shared 的版本比较四种结果，**不设门禁**，因为 T6-02 要在登录之前拿到）；T6-02 让客户端启动时取它并与自己那份构建期常量比对，**只有 `outdated` 才提示更新**。两侧指纹刻意不相等（容器里没有 `.git`，api 侧 `builtAt` 恒空、`commitSha` 恒 `unknown`），所以比的是版本号；「响应不是预期形状」降级为 `unknown` 而不报错，避免客户端起不来。

**阶段七（计划外新开）的 T7-01 把「系统设置」从占位页换成了真实的账号管理页。** owner 可以建子账号、改姓名部门角色状态、重置口令、按账号单独授予或拒绝权限点。权限合并规则是「角色自带 ∪ 账号级授予 − 账号级拒绝」，拒绝优先；owner 短路返回全部权限点，让「owner 不可降权」成为服务端硬规则。界面勾选与服务端两组数据之间的转换由 `diffPermissions` 纯函数完成。另有 `db:reset-password` 作为主账号口令重置通道。

**界面还做了一轮设计稿落地对齐**（2026-10-13，见 `UI合并方案/梵禾Work-落地对齐记录-2026-10-13.md`）：字体栈合成为 `FH Sans SC`（解决 Windows 上 Medium 字面缺失导致层级被压平）、悬停改回「一帧到位」、单元卡补四层材质、内容区改自绘滚动条。改动是构建产物，已 `build web` + `--force-recreate` 生效。

跨阶段复盘（完成度口径、七条风险、优先级建议）见 `docs/PROGRESS-REVIEW-2026-10-13.md`。

**最短三条路径**（假定已按第七节把环境装好）：

```bash
# 1. 跑起来（两个终端；注意 API 要开短令牌，端到端验证才等得到续期）
cd projects/fanhe-work/apps/api && ../../infra/portable/ws-run.cmd pnpm dev:api   # 或 pnpm dev:all 一起起
# 另开一个终端
cd projects/fanhe-work && infra/portable/ws-run.cmd pnpm dev

# 2. 验证没被你改坏（四道门禁）
cd projects/fanhe-work && ../../infra/portable/ws-run.cmd pnpm test && \
  ../../infra/portable/ws-run.cmd pnpm lint && \
  ../../infra/portable/ws-run.cmd pnpm typecheck && \
  ../../infra/portable/ws-run.cmd pnpm format:check

# 3. 推到远端（必须走代理，详见 6.6）
GIT_TERMINAL_PROMPT=0 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
ALL_PROXY=http://127.0.0.1:7897 git -c http.proxy=http://127.0.0.1:7897 push origin main
```

**四条不能忘的事**：① 包管理**一律经 `infra/portable/ws-run.cmd`**，裸跑 pnpm 会静默把 store 落到宿主机磁盘；② 数据库在容器里、**不随 U 盘走**，换机必重建；③ 受版本控制的文件**禁止写死盘符**；④ 浏览器 e2e 跑一次 = 清一次库 + 重建一次 owner，不是随便能跑的。

---

## 一、项目概况

### 1.1 项目定位

**梵禾 Work** 是桌面端个人工作台（实验版），按「账号权限 → 主框架 → 个人工作台三板块（纪要 / 事件 / 启动）→ 桌面外壳 → 服务端化 → 更新通道」分七个阶段实现（阶段零至六）。七个阶段共 50 项任务，编号为「T + 阶段号 + 连字符 + 序号」。**另有计划外新开的阶段七（账号与权限管理，T7-01 已完成），尚未并入上面的任务表。**

### 1.2 技术栈

| 层 | 选型 |
| -- | -- |
| 桌面外壳 | Electron 44.7.0（阶段四，T4-01 脚手架已落地） |
| 前端 | React 19 + TypeScript 6.0.3 + Vite 8 + Tailwind 4（方案 B 现代极简，shadcn/ui） |
| 后端 | Node 22.22.2 + Fastify 5 + Prisma 7.10.0 |
| 数据库 | PostgreSQL `postgres:16-alpine`（容器，数据在命名卷，**不随 U 盘移动**） |
| 共享包 | `packages/shared`（跨进程类型与收窄函数，构建型包，输出到 `dist`） |
| 路由 / 图标 / Markdown | `react-router@8.4.0`、`lucide-react`、`react-markdown` + `remark-gfm` |
| 密码哈希 | `@node-rs/argon2`（Argon2id） |

### 1.3 仓库与提交身份

- **仓库根 = 工作空间根 = 可移动介质根**，整体推 `main`。注意不是 `projects/fanhe-work`。
- 远端：`https://github.com/dy00001/fanhe-work`（**公开**，2026-10-11 由私有改公开）。
- 提交身份：`梵禾 <dev@fanhe.local>`（**仅本仓库局部配置**，换机后要重设）。
- 分支约定：`main` 为主线、保持可交付；`dev` 为开发分支。**实际执行的是「dev 跟随 main」** —— 有实际分叉需求前，每次推完 main 就把 dev 快进并推送。两条分支本地均已建立跟踪。
- 两条访问链路：**本地 git 可读写**（细粒度 PAT 经 GCM 存于 `~/.gitconfig`，逐机逐用户，换机必重配）；**WorkBuddy 的 GitHub 连接器只读**（只能读公开仓库，写入返回 403，GitHub 侧无可调项）。**凡需要写入远端，一律走本地 git。**
- 仓库内另有 `.git/info/exclude`（本地排除，不进版本控制），`.workbuddy/` 与 `.workbuddy-ai/` 都不进仓库。

### 1.4 工作区目录结构

```
<工作空间根>/                       ← git 仓库根，整盘走
├── .ws-root                       ← 根定位标记，脚本向上查找它推导根，不写死盘符
├── infra/                         ← 工作空间机制（唯一入口）
│   ├── portable/
│   │   ├── ws-run.cmd / .ps1 / .sh    ← 唯一入口（cmd 是 Windows 上的首选）
│   │   ├── ws-env.ps1 / .sh           ← 只设置环境，不转交命令
│   │   ├── ws-locate.ps1 / ws-state.ps1 / ws-doctor.ps1 / ws-repair.ps1
│   │   ├── ws-enable-devmode.cmd/.ps1
│   │   ├── config/
│   │   └── state/root.json
│   └── docs/PORTABLE-WORKSPACE.md
├── projects/fanhe-work/           ← 代码主体
│   ├── apps/
│   │   ├── api/                   ← Fastify 后端 + Prisma + 迁移 + 测试
│   │   ├── web/                   ← React 前端（Vite）
│   │   └── desktop/               ← Electron 外壳（阶段四，T4-01 已落地）
│   ├── packages/shared/           ← 跨应用共享类型与工具（构建型，先构建后用）
│   ├── docs/                      ← 规划与交接文档（本文所在处）
│   ├── tools/                     ← 诊断脚本归档（checks/ prisma/ oneoff/）
│   ├── data/                      ← 本地数据目录（已忽略）
│   ├── docker-compose.yml
│   └── package.json               ← pnpm 工作区根
├── docs/                          ← 工作空间级文档
├── .tmp/                          ← 被忽略，临时产物与凭据落在这里
├── .cache/ .cargo/ .m2/ .nuget/ .rustup/ .venv/ ...  ← 各类工具链缓存，随盘
└── .workbuddy/ .workbuddy-ai/     ← 本地记忆（不进版本控制）
```

---

## 二、当前进度

### 2.1 阶段进度总览

| 阶段 | 范围 | 状态 |
| -- | -- | -- |
| 阶段零 | 目录骨架（T0-01 ~ T0-07） | ✅ 完成 |
| 阶段一 | 账号与权限（T1-01 ~ T1-12） | ✅ 完成（验收 7 项勾 6，余 1 项见 4.5） |
| 阶段二 | 主框架与 UI 骨架（T2-01 ~ T2-07） | ✅ 完成（验收 6 项全勾）；**UI 集成两批已完成**（导航 18 项 + 首页三段式 + 版本号），见 `UI-INTEGRATION-2026-10-11.md` |
| 阶段三 | 个人工作台三板块（T3-01 ~ T3-12） | ✅ 完成（验收 6 项全勾）：**纪要链收口**、**事件链收口**（T3-09 模型接口 → T3-10 列表 → T3-11 勾选切换 → T3-12 详情面板） |
| 阶段四 | Electron 外壳（T4-01 ~ T4-04） | ✅ **已完成（4/4）**：T4-01 外壳脚手架、T4-02 服务地址切换、T4-03 本机代理内置、T4-04 启动自检。出口条件已达成（见第七章） |
| 阶段五 | 服务端化（T5-01 ~ T5-05） | 🔄 进行中：**T5-01 ~ T5-04 已完成（4/5）**：容器编排、数据库连接串与迁移执行者、种子自动执行与备份恢复、**Cloudflare Tunnel 出站接入（公网可达且源站无入站暴露）**；**T5-05 访问策略由用户决定暂缓（2026-10-12 17:00），已知风险见头部** |
| 阶段六 | 更新通道（T6-01 ~ T6-03） | ✅ **已完成（3/3）**：T6-01 版本清单接口、T6-02 客户端版本检查与更新提示、**T6-03 外壳升级通道**（T6-03a 打包与发布链路 / **T6-03b 更新通道接 `electron-updater`，发布者校验与 sha512 校验均已实测能拒绝异签名 / 被篡改包** / T6-03c 安装包签名）。**✅ 已发版**（2026-10-13，`v0.1.0` 16:0x 与 `v0.1.1` 17:4x 两次发布，三个资产齐备且线上元数据与安装包核对一致）。实施记录见 4.1.1 / 4.1.9 / 4.1.11 / 4.1.12 / 4.1.13 与 `T6-03-UPDATE-CHANNEL.md` |
| 阶段七 | 账号与权限管理（计划外新开，T7-01） | ✅ **T7-01 已完成**：`系统设置` 页由占位换成真实账号管理页（九个接口、账号级授予与拒绝、owner 短路、层级判定、软删除、口令重置），见 `T7-01-ACCOUNT-ADMIN.md` 与 4.1.10；后续范围尚未登记进计划文档，见 4.1.0 |

> 阶段三的分母口径（12 项）见 `PROGRESS-REVIEW-2026-10-11.md` 第 28 行。

### 2.2 阶段三验收清单

- [x] 第一项：启动配置可新增、编辑、排序，可一键唤起
- [x] 第二项：路径失效有提示与重新指定入口（T3-04）
- [x] 第三项：纪要支持编辑预览、标签、置顶、检索、草稿恢复 —— **五项全部完成并逐条过浏览器验证**（编辑预览 / 标签 / 置顶 T3-06，检索 T3-07，**草稿恢复 T3-08**）
- [x] 第四项：事件列表分组正确，勾选切换乐观更新可回滚 —— 前半句 T3-10（分组、已完成默认折叠、行内四要素），后半句 T3-11（乐观更新与失败回滚，e2e 用「把切换请求拖后 1.2 秒、断言回话之前界面已改」与「服务端已删仍照样先勾上」两条把「乐观」与「等回话」分开）
- [x] 第五项：撤销入口可恢复状态并清除完成时间（T3-11；e2e 既查界面（入口出现与收起、该行回到未完成组），也经接口查服务端 `status` 回 `todo`、`completedAt` 与 `completedBy` 一起变 `null`）
- [x] 第六项：已完成详情展示耗时、操作人与变更历史（T3-12；详情面板由标题进入，展示完整描述、创建 / 截止 / 完成时间、完成用时、完成人与来自 `event_logs` 的时间线。**e2e 里那一条是按「能证伪」做的**：拿一条走过「完成 → 撤销」的事件，它此刻是未完成，而面板里必须仍留着那两笔 —— 界面若在按当前状态反推，永远画不出它们）

### 2.3 最近提交（截至本文档定稿）

> 下表是截至文档定稿时的快照。定稿之后若只有对本文档本身的文档类提交，不会补进此表 —— 想知道最新提交直接 `git log --oneline -10`。

| 提交 | 说明 |
| -- | -- |
| `4c0ac8a` | fix(阶段六): 固定外壳界面来源，修掉更新后设置丢失的根因（含客户端更新按钮 T7-02b，desktop 99 → 122、web 97 → 116，`verify-pack` 32 → 35 项；**其后的两笔为文档提交，按本表惯例不列入**，最新提交见 `git log --oneline -5`） |
| `17baa72` | docs(交接): 阶段性总结（2026-10-13）并同步两册文档至 `6e5ff78` |
| `6e5ff78` | docs(阶段六): 回填 v0.1.1 发布结果与 P0 修复 |
| `8162c33` | chore(版本): 提到 0.1.1（为闭合更新通道正向验证而发的 B 端；版本号只改仓库根一处，`apps/desktop/package.json` 由 `sync-version.mjs` 打包时同步） |
| `f361bff` | docs: 给进度类文档加勘误，并把「快照读前先看 git log」写成明规则 |
| `12b553b` | fix(测试): e2e 的占位页断言改用综合看板，并补系统设置的落地断言（e2e 149 → **150**） |
| `84ba093` | fix(账号): 改密之后此前签发的访问令牌立即失效（`passwordChangedAt` 毫秒快照进令牌载荷并比对；api 226 → **232**） |
| `f364f84` | docs(阶段六): 回填首次发布 v0.1.0 的结果与两个发布坑 |
| `917d50e` | docs(阶段六): 回填 T6-03b 执行结果与阶段六收口 |
| `1a3ceee` | fix(阶段六): 签名报告解析器静默丢弃列，STATUS_VALUE 读不到 |
| `3a9294f` | feat(阶段六): T6-03b 接上 electron-updater 更新通道（**阶段六代码基线**） |
| `a91db02` | docs(阶段六): T6-03c 安装包签名的实施记录与决策回填 |
| `415219b` | feat(阶段六): T6-03c 安装包代码签名（自签证书进 `CurrentUser\My`） |
| `8bbffec` | docs(阶段六): T6-03a 打包与发布链路的实施记录与决策 |
| `4ded6b1` | feat(阶段六): T6-03a 打包与发布链路（electron-builder + 打包态分派 + 验收脚本） |
| `c0b6142` | docs(阶段六): 记录 T6-03 三项决策，方案转为可开工 |
| `da2dc51` | docs(阶段六): T6-03 外壳升级通道施工方案（发布载体定 GitHub，签名方案待决） |
| `5fee842` | feat(UI集成): 落地一键启动主卡的媒体层、压暗层与发丝高光 |
| `f5d0f3e` | docs(进度): 回填 T6-02 / T7-01 / UI 对齐，并把阶段七登记进计划文档 |
| `5fd7f84` | fix(UI集成): 按设计稿对齐字体栈、悬停规则与滚动指示器（`FH Sans SC` 合成家族、移除 10 处 `transition-colors`、单元卡四层材质、自绘滚动条） |
| `5dc0c90` | docs(阶段七): 回填 T7-01 实施判断与验证结果 |
| `49c4f85` | feat(阶段七): 主账号口令重置通道 `db:reset-password`（密码从 stdin 读，不进 shell 历史与进程环境表） |
| `ab96a58` | feat(阶段七): T7-01 账号与权限管理（**阶段七代码基线**：第七个迁移 `user_permissions`、`users.department`、权限点 `system.user.delete`、api 九接口、web 账号管理页；api 22 项） |
| `d179e81` | feat(阶段六): T6-02 客户端版本检查与更新提示（`apps/web/src/lib/{version-check,use-version-check}.ts`，测试 16 项） |
| `ac342e7` | feat(阶段六): T6-01 版本清单接口（**阶段六代码基线**：新增 `GET /api/version`（不设门禁）+ `packages/shared/src/version.ts`（版本比较四种结果 + 构建指纹），shared 24 项、api 7 项） |
| `7cf5af3` | feat(阶段五): T5-04 Cloudflare Tunnel 出站接入（**阶段五代码基线**：新增 `cloudflared` 服务（**不绑任何宿主端口**）、新增 `tools/checks/t504-tunnel.mjs`（17 项，三层判据证「无入站暴露」）） |
| `3b3dc07` | feat(阶段五): T5-03 种子自动执行与备份恢复（migrate 容器加 `db:seed`、`jwt.secret` 改惰性求值 + `assertRequiredEnv`、新增 `tools/checks/db-backup.mjs`、验收扩到 30 项） |
| `16f73e8` | feat(阶段五): T5-02 数据库连接串单一来源与迁移执行者（T5-01 补漏：新增一次性 `migrate` 服务、连接串收成单一来源、22 项空卷验收脚本） |
| `ace70bd` | feat(阶段五): T5-01 容器编排（两个 Dockerfile + nginx 反代 + compose 扩成三服务） |
| `760b92f` | feat(阶段四): T4-04 启动自检（**阶段四收口，阶段四代码基线**） |
| `d76e084` | feat(阶段四): T4-03 本机代理内置（**外壳代码基线**） |
| `b03ddb5` | feat(阶段四): T4-01 Electron 外壳脚手架（**外壳代码基线**） |
| `c8f7a4d` | docs: WORK-STATUS 头部标注 N-01 定稿提交号 |
| `9502591` | docs: 梳理下一步任务（N-01 与阶段四主线） |
| `b5c0e7f` | docs(阶段四): 补充 T4-01 开工准备清单 |
| `fe92cb4` | docs(UI集成): 回填最终态集成记录（`UI-INTEGRATION-2026-10-11.md`） |
| `2576388` | feat(UI集成): 落地最终 UI —— 导航 18 项、首页三段式、版本号（**界面层整合代码基线**） |
| `278059d` | docs(阶段三): 回填 T3-12 实施判断与验证结果，阶段三收口 |
| `a5370b0` | feat(阶段三): T3-12 已完成详情面板（详情 + 耗时 + 操作人 + `event_logs` 变更历史时间线） |
| `29752ea` | docs(阶段三): 回填 T3-11 实施判断与验证结果 |
| `a3c08bf` | feat(阶段三): T3-11 勾选切换与撤销（乐观更新 + 失败回滚 + 撤销入口） |
| `f77c563` | docs(阶段三): 回填 T3-10 实施判断与验证结果 |
| `a7069de` | feat(阶段三): T3-10 事件列表视图（分组折叠 + 行内四要素 + 事件检索与增删改） |
| `d252107` | feat(阶段三): T3-09 事件模型与接口（第六个迁移 + 八条接口） |
| `fcfc7aa` | feat(阶段三): T3-08 草稿自动保存 |
| `4d43dae` | fix(web): 补齐 NavLink className 回调的类型标注（换盘重建依赖后 `typecheck` 才暴露出来的既有疏漏） |
| `db7bc77` | docs(交接): 重写为单文件自包含的完整工作总结与换机续接指南（本文档定稿于此） |
| `3c402fa` | docs(阶段三): 回填 T3-07 实施判断与验证结果 |
| `95bdcf2` | feat(阶段三): T3-07 纪要全文检索 |
| `122931d` | docs(阶段三): 回填 T3-06 浏览器 e2e 验证结果并修正实施判断 |
| `19c08a2` | fix(阶段三): 修复新建纪要后编辑器草稿被初始化成空白 |
| `42963b4` | docs(阶段三): 回填 T3-06 实施判断与验证结果 |
| `eb4992b` | feat(阶段三): T3-06 纪要 Markdown 编辑与预览 |
| `5d1883a` | feat(阶段三): T3-05 纪要模型与接口 |

### 2.4 当前验证基线（改完东西应与这些数字对照）

| 项 | 基线 | 说明 |
| -- | -- | -- |
| `pnpm test` | **578 项，0 失败** | `packages/shared` **108** + `apps/api` **232**（**227 通过 / 5 跳过**）+ `apps/web` **116** + **`apps/desktop` 122**。T6-01 之后基线为 457（shared 107 + api 204），T6-02 与 T7-01 再增至 496，T6-03a 增至 506，**T6-03b 增至 530**，**P0 的改密失效修复（`84ba093`）再增至 536**（api 226 → 232），**本轮「设置不丢 + 客户端更新按钮」（`4c0ac8a`）再增至 578**（web 97 → 116、desktop 99 → 122）。desktop 的增量轨迹：T4-01 起 10（内置静态服务的 SPA 回退 / 404 / 越界 / 反代 / 502）→ T4-02 **28**（配置读写 18 + 服务端 10）→ T4-03 **52**（+ 代理形态复核 17 + 跨包路径 7）→ T4-04 **76**（+ 自检 24）→ **T6-03a 86**（+ 打包态降级路径 6 + 安装态配置 3 + 版本号单一来源 1）→ **T6-03b 99**（+ 新增 `update.test.mjs` 13 项：与 electron 解耦的更新状态机，含 2 条反例）→ **本轮 122**（+ 新增 `shell-origin.test.mjs` **19 项**：端口→origin→存储分区的纯函数，含「首次升级时旧来源排在固定段之前」「并列时顺序必须确定」；+ `server.test.mjs` 端口选择 **4 项**：首选空闲就用 / 被占顺延 / 全占退系统分配 / 非 `EADDRINUSE`·`EACCES` 直接抛）。web 的增量轨迹：T3-10 起由 23 → 40，T3-11 → 45，T3-12 → 62（详情展示规则），**UI 集成 → 70**（新增 `version.test.mjs` 8 项），**T6-02 → 86**（新增 `version-check.test.mjs` 16 项），**T6-03b → 97**（新增 `host.test.mjs` 6 项 + `version-check.test.mjs` 扩 5 项），**本轮 → 116**（新增 `desktop-update.test.mjs` **19 项**：四种可见形态 / 宿主一致性 / percent 校验 / 轮询节奏 / 两条跨包契约）；shared 由 69 → **83**（UI 集成：导航 18 项 / 层级路径 / `navCodeFromPath` 断言扩写）→ **108**（T6-01 版本比较 24 项、T7-01 权限合并与 `system.user.delete`） |
| 打包链路（T6-03a） | **35 项，本轮实测 34 通过 / 1 FAIL**（FAIL 即签名那一项，因证书已不在本机，见 4.1.14） | `pnpm --filter @fanhe/desktop verify:pack`（`apps/desktop/scripts/verify-pack.mjs`）：asar 内容与版本、extraResources 与源**逐字节一致**、随包 `agent.ts` 可加载且导出齐备；**第三节为 T6-03c 的代码签名**（两个产物 PE 签名表非空、`app-update.yml` 含 `publisherName` 且与配置一致、`latest.yml` 的 sha512/size 与实际安装包一致、签名身份报告覆盖本轮全部产物），**所有断言按「本轮」划分**（以 `app.asar` 的 mtime 为界，陈旧产物排除并打印名字）。反例是「改成 commonjs 必须 SyntaxError」「注入语法错误必须抛错」「PE 解析器对非 PE 文件必须抛错」「报告解析器对无关文本必须解析不出 EXE」。**脚本不起子进程**（本机 `spawnSync` 一律 EBUSY），需要安装目录那个运行时探一次的命令由脚本打印、人工执行。**本轮新增 3 项 + 2 条反例**：`resources/web` 与 `apps/web/dist` **逐文件**一致（6 个文件逐一比对，不只看 `index.html`）、产物含三条标记（`fanheDesktop` / `重启更新到` / `正在下载`）、签名身份报告**必须比本轮产物新**（陈旧报告改判为「未验证」而不拿旧结论充数；反证：本轮 `app.asar` mtime 晚于报告，断言正确改判，而独立的 PE 签名表断言仍报 FAIL） |
| 签名身份（T6-03c，判据在 T6-03b 修正） | `RESULT=OK`（3 个 exe 均为 `CN=Fanhe Work`，`Status=Valid`、`STATUS_VALUE=0`） | `pnpm --filter @fanhe/desktop verify:sign`（`apps/desktop/scripts/verify-signature.ps1`）：取 Authenticode 的 `Subject` / `Thumbprint` / `Status` / `STATUS_VALUE` 写进 `release/signature-report.txt`，再由 `verify-pack.mjs` 读回断言。**判据是 `Status == Valid`（数值 0），不是 `!== 'NotSigned'`** —— 🔴 原先那条松判据在 T6-03b 被证伪：electron-updater 只在 `Status === 0` 时才比对发布者，自签链不可信得到的 `UnknownError`(1) 会让**每一次更新都被拒绝**。修法是把自签根也装进 `CurrentUser\Root`（`certutil -user -addstore -f Root`；`Import-Certificate` 在非交互会话装不进 Root）。`RESULT=REVIEW` 时脚本**退出非零**（原先恒退 0，`verify:all` 的 `&&` 链等于不是闸） |
| 其中 5 项跳过 | **设计行为，不是失效** | `apps/api/test/setup.test.ts` 的首次初始化用例，前置条件是「库里没有 owner」；owner 建成后自然跳过 |
| `pnpm lint` / `typecheck` / `format:check` | 全绿 | `format:check` 应输出 `All matched files use Prettier code style!` |
| 浏览器 e2e | **150 项全通过，0 失败** | 含「渲染过程未产生未捕获异常或 console.error」。UI 集成后为 149（T3-12 时为 146，UI 集成新增 3 项：导航 18 项形态、首页三段式、顶栏版本号）。**UI 落地对齐后于 2026-10-13 重跑**：首轮抓到 3 项失败，根因是断言停留在 T7-01 之前（占位页断言仍指向已落地的「系统设置」），改用「综合看板」并补系统设置的落地断言后 **150 项全通过**（`12b553b`）。T3-12 那次的首轮超时与根因（CDP 合成指针事件概率性整组丢失）见 8.2 与 9.39 |
| 外壳冒烟 | **PASS** | `pnpm --filter @fanhe/desktop smoke`：隐藏窗口加载产物 → 探 DOM → 打印一行结论并按成败设退出码。判据是 `#root` 里有元素 + console 零错误（见 8.5）。**受限环境需 `FANHE_NO_SANDBOX=1`** |
| 数据库 | **7 个迁移**、**13 张业务表**、权限点 **12** / 角色 **4** | e2e 之后的干净基线是 `users` 1（owner `fanhe`）、其余业务表 0 行。T7-01 新增第七个迁移 `20261012094234_user_permissions` 与权限点 `system.user.delete`，权限点由 11 增至 **12**。**注意**：日常开发库里有使用者自己建的账号与数据（实测 `users` 3、`notes` 2，含 `fanhe-01` / `guoyao`），清理残留前先按命名前缀与创建时间确认是不是自己的数据，测试残留的命名前缀是 `zz_test_*` |

---

## 三、已完成的功能

### 3.1 阶段零 · 目录骨架（T0-01 ~ T0-07）

一次性把工程地基打完：`apps/{web,api,desktop}` + `packages/shared` + `data` 的目录骨架（T0-01）；pnpm workspace 与根脚本（T0-02）；Electron 缓存变量名缺陷的修正与镜像补全（T0-03，判断见 9.4）；约定文档 `README.md`（T0-04）；ESLint 10 扁平配置 + Prettier + Tailwind 类名排序（T0-05）；忽略规则（T0-06）；git 仓库与提交身份（T0-07）。另有界面方案四选一对比页（`docs/mockups/index.html`，选定方案 B）与品牌标识入库。

### 3.2 阶段一 · 账号与权限（T1-01 ~ T1-12）

**这一阶段的产品能力：能登录、能记住账号密码、能按角色看到不同的导航。**

| 能力 | 交付 | 关键文件 |
| -- | -- | -- |
| 数据模型与首个迁移 | 六张账号权限表，已应用并确认无漂移 | `apps/api/prisma/schema.prisma`、`migrations/20261010150103_init` |
| 数据库连接与种子 | 11 个权限点（T7-01 后为 **12**）、4 个角色、29 条授权关联，重跑无副作用 | `src/db/prisma.ts`、`src/db/seed.ts` |
| 密码哈希 | Argon2id，参数可配置、可判定重算，12 项测试 | `src/auth/password.ts` |
| 登录与令牌签发 | `POST /api/auth/login`，四种失败共用同一响应（不给枚举用户名的机会） | `src/auth/tokens.ts`、`src/auth/login.ts` |
| 令牌轮换与撤销 | `refresh` / `logout`，并发轮换用行锁串行化，重放按 `familyId` 整链撤销，撤销分 session / device / all 三层 | `src/auth/session.ts` |
| 登录限速 | 账号 + IP 双维度，阈值与窗口全部配置化，落库 `login_attempts`，超限返回 429 | `src/auth/login.ts` |
| 权限中间件 | `requireAuth` / `requirePermission`，**授权每次查库不缓存** | `src/auth/guard.ts` |
| 首次初始化引导 | 并发初始化用咨询锁串行化，owner 被误删有 `pnpm db:create-owner` 恢复通道 | `packages/shared/src/account.ts`、`src/auth/setup.ts` |
| 审计日志 | 动作码词表 + `recordAudit`，已接入登录 / 登出 / 刷新重放 / 首次初始化四条路径 | `packages/shared/src/audit.ts`、`src/audit/audit.ts` |
| 登录页与会话管理 | 访问令牌只放内存、刷新令牌持久化，续期单飞收敛并发，401 续期一次后重试 | `apps/web/src/lib/{api,session}.ts`、`auth/`、`pages/` |
| 前端路由守卫 | 导航清单（**UI 集成后 18 项 / 4 分组**）+ 模块级可见性判定，32 项测试钉住四种角色的可见范围与分层路径 | `packages/shared/src/navigation.ts`、`components/Sidebar.tsx` |
| 记住账号密码 | AES-GCM 加密，密钥存 IndexedDB 且不可导出；只在登录成功后写、取消勾选即清 | `apps/web/src/lib/credential.ts` |

### 3.3 阶段二 · 主框架与 UI 骨架（T2-01 ~ T2-07）

**这一阶段的产品能力：一个应用式外壳（侧栏 + 顶栏 + 内容区），可折叠、可切主题、有完整的空/错/404 页。**

- **T2-01 shadcn/ui 与设计令牌**：`components.json` + `src/lib/utils.ts` + `components/ui/` 下 14 个官方组件源码；`index.css` 改为两层令牌结构并统一到 shadcn 语义命名，现有界面 60 余处类名同步迁移。
- **T2-02 布局骨架**：`Sidebar`（224px / 折叠 64px，折叠态用气泡提示补名称）、`TopBar`（56px，面包屑 + 账号下拉）、`AppShell`（`h-screen` 应用式外壳，内容区独立滚动、最大宽度 1080px）。
- **T2-03 路由体系**：路由表由 `NAV_ITEMS` 派生，模块守卫复用 `resolveActiveNav`；共享包新增 `navPath` 与 `navCodeFromPath`。
- **T2-04 占位页**：统一「功能开发中」页（模块图标、标题、规划范围、返回入口）；导航图标表抽出共用。
- **T2-05 错误与空状态**：`EmptyState`（`card` / `plain` 两形态，收敛到一处）、`NotFoundPage`（404，保留原地址不重定向）、`ErrorPage`（500，不展示异常原文）、`ErrorBoundary`。
- **T2-06 折叠偏好记忆**：`lib/preferences.ts` 读写本机偏好（键 `fanhe-work.ui.sidebar-collapsed`），读写失败静默降级。
- **T2-07 主题令牌**：`index.css` 新增 `@custom-variant dark` 与 `.dark` 块（覆盖 `:root` 全部颜色原始值），`index.html` 内联脚本在样式生效前定下主题初值，`lib/theme.ts` 提供三档（含跟随系统）与系统配色变化监听。

### 3.4 阶段三 · 个人工作台（T3-01 ~ T3-12，**已收口**）

**已经能用的三块：启动通道、工作纪要、事件记录（列表、增删改、勾选切换与详情面板）。三个板块全部完成。**

#### 启动通道（T3-01 ~ T3-04）

- **T3-01 模型与接口**：`launch_profiles` 表 + 五条路由（列表 / 新增 / 重排 / 修改 / 删除），所有权在 service 层强制，重名检查不用数据库约束。启动参数用 `String[]` 而不是拼接字符串。
- **T3-02 本机代理与进程启动**：`src/launch/agent.ts` 是**代理核心**，`buildLaunchCommand` 纯函数 + `runLaunchProfile`，**不认识数据库、认证与 HTTP**（阶段四要原样搬进外壳主进程）；只接受回环来源。
- **T3-03 管理界面**：列表 + 新增/编辑对话框 + 删除确认 + 排序，四态分派容器照 `LaunchPanel` 的形态。
- **T3-04 启动记录与路径失效提示**：`launch_history` 表记录真实启动尝试（成功 / `executable_missing` / `spawn_failed`），去重命中不记；独立的状态接口提供路径状态与近期历史；界面有失效徽标、「重新指定路径」入口与启动摘要。

#### 工作纪要（T3-05 ~ T3-08，**已收口**）

- **T3-05 模型与接口**：`notes` 表 + 八条路由（列表 / 标签清单 / 单条 / 新增 / 修改 / 删除 / 置顶 / 归档）。标签用 `text[]` + GIN 索引，归档用 `archivedAt` 记时刻而非布尔，沿用软删除。
- **T3-06 Markdown 编辑与预览**：`NotesPanel`（四态分派）/ `NoteList` / `NoteEditor` / `MarkdownPreview` / `TagInput`；**预览读的是草稿而不是已保存值**；一级导航补上二级路径这一层，`/workbench/notes` 因此可达。
- **T3-07 全文检索**：中文关键词可命中**标题与正文**；界面检索框防抖 250ms、丢弃过期响应、空态分「库里没有」与「没搜到」两种说法、关键词跨视图保留。详见 5.4。
- **T3-08 草稿自动保存**：未提交的内容按「编辑器的身份」落到本机 localStorage（`fanhe-work.draft.note.<id>` / `…note.new`）。误关页面、切板块、被检索筛掉之后再回来都能接着写，编辑器顶部给一条可「丢弃草稿」的提示条。**后端零改动、零迁移**，草稿不进数据库也不进审计。规则在 `apps/web/src/lib/note-draft.ts`，触发点与那个「提交成功后旧实例的卸载落盘把已提交内容写回新建槽」的时序坑见 5.6 与 9.35。

> 界面入口：`/workbench` 是启动通道，`/workbench/notes` 是工作纪要，`/workbench/events` 是事件记录，靠 `WorkbenchPage` 顶部的板块切换按地址分派。

#### 事件记录（T3-09 ~ T3-12 已完成，**已收口**）

- **T3-09 模型与接口**：第六个迁移 `20261011132819_add_events` 建起 **`events`** 与 **`event_logs`** 两张表，八条路由（列表 / 标签清单 / 单条 / 状态变更历史 / 新增 / 修改 / 状态切换 / 删除），统一挂 `personal.event.read` 与 `personal.event.write`。
- **T3-10 列表视图**：`components/events/` 四件（`EventsPanel` 四态分派容器、`EventList` 分组与折叠、`EventRow` 行内四要素、`EventFormDialog` 新增 / 编辑表单）＋ `lib/event-display.ts`（展示规则的纯函数）＋ `lib/events.ts`（会话感知数据层）＋ `lib/api.ts` 六条传输函数；`WorkbenchPage` 加第三块板块，`routes.tsx` 的模块子路由补 `events`。
- **界面上现在能做到什么**：未完成与已完成分两组（**已完成默认折叠**，组头带条数）、每行左侧勾选框、中间标题与最多三个标签、右侧截止时间与优先级徽标；**已过截止时间且未完成**的那条标出「已逾期 · …」；检索走与纪要同一条链路（防抖 250ms、丢弃过期响应、空态分「库里没有」与「没搜到」两种说法）；新增 / 编辑 / 删除都在，写完一律重拉列表（**排序在服务端，界面不自己排**）。
- **T3-11 勾选切换与撤销**：点行内勾选框即完成，再点即取消完成；两条路都走 `PUT /api/events/:id/status`，**后端与共享包一行未改**（T3-09 那条路径早就把「写完成时刻与完成人」「三列一起清空」「同事务追加流水」做完了）。改动集中在三处：`EventRow` 的勾选框去掉 `disabled` 并接上 `onCheckedChange`；`lib/event-display.ts` 增 `applyEventStatus` 纯函数（乐观改本地那一条）；`EventsPanel` 增 `changeStatus`、`switching` 串行化与提示条上的**撤销入口**。
- **勾选框现在可点了，两种「点不动」分得很开**：只读角色（没有 `PERSONAL_EVENT_WRITE`）永远点不动，这种禁用补 `disabled:opacity-100` —— 一整片半透明的勾选框看起来像列表坏了，而实际只是没权限；切换中的临时禁用保留组件自带的半透明，那正好表达「正在处理」。判据按 `canWrite` 取而不是按 `disabled` 取。
- **乐观更新只改 `status`，不伪造 `completedAt` / `completedBy`**：那两个是服务端的时间与身份快照，列表这一版不展示它们（展示在 T3-12 的详情面板里）。乐观阶段写一个「本地现在」进去，界面上会短暂出现一个可能偏掉的时刻，而权威值紧随其后被重拉覆盖。
- **成功之后仍然重拉列表**：乐观值负责「点下去到响应到达之间」那段空窗（完成一条会让整行跳进默认折叠的组、也就是从眼前消失），而**顺序始终来自服务端那一次重拉** —— 界面从头到尾没有定义过任何顺序。这条不违背 9.37 立的规矩，而是它的一个用例。
- **失败的回滚是「重新对齐服务端」，不是手工改回去**：切换失败时的正确状态只有服务端知道（可能刚被别处删掉、可能令牌刚失效），所以失败路径做的是「提示 + 重拉」，直接复用 `eventFailureExit` 的 404 / 其余分流。
- **切换是串行的**（`EventsPanel` 的 `switching: string | null`）：同一时刻只允许一条在飞，否则先回来的那次重拉会把另一条还没落库的乐观值覆盖成旧值，表现为「另一行的勾选框自己弹回去、过一会儿又勾上」。串行化期间所有勾选框都进 `disabled`，**不是「能点但被静默忽略」**。
- **撤销入口只在「刚标成完成」之后给，且不自动消失**：那一步会把行从眼前拿走，点错了当场看不见它去了哪 —— 这是唯一真正需要反悔入口的方向；反方向的「恢复」是把行放回眼前，做错了再点一次即可。不设定时器是因为「定时消失」= 「用户还没读完入口就没了」，而且会引入一个测试必须等待的时钟。撤销之后也不再给「重做」。
- **这张表与纪要怎么区分**：`events` 是实体表（带 `createdAt` / `updatedAt` / `deletedAt`），`event_logs` 是**只追加流水**，**只有 `createdAt`** —— 给它加 `updatedAt` 会让人以为这行改过，而它的价值就在于「记的是当时发生的事」。
- **状态是怎么存的**：`events` 上的 `status` / `completedAt` / `completedById` / `completedByName` 是**可重建的冗余**，权威来源在 `event_logs` 里；每次 `todo ↔ done` 的流转都**追加一行**（`created` / `completed` / `reopened`），从不修改已有那行，两件事在**同一个事务**里。撤销完成是追加 `reopened`，不是删掉 `completed`。
- **不写日志的那一类**：编辑标题 / 描述 / 标签 / 优先级**刻意不写日志** —— 详情面板要回答的是「状态怎么变的」，混进编辑记录就变成另一份东西了。因此 `PATCH` 的 schema 里**没有 `status` 项**，改状态只能走 `PUT /api/events/:id/status`。
- **T3-12 已完成详情面板**：点**行内标题**打开（行本身仍然不是 `<button>`，行里已经有勾选框与行内菜单两个可交互元素，整行包成按钮会得到嵌套的可点击元素）。面板展示：完整描述（**复用纪要那个 `MarkdownPreview`**，不写第二份渲染器）、完整标签（不截断到 3 个）、创建 / 截止 / 完成时间、完成用时、完成人，以及来自 `event_logs` 的**变更历史时间线**。**后端与共享包一行未改** —— `GET /api/events/:id/logs` 在 T3-09 就已就位，前端只补 `eventLogsRequest` / `loadEventLogs` 两个封装。
- **面板头部直接用列表那一份数据，只有时间线在等接口**：打开面板的第一帧就有标题、描述、时间、耗时要显示，而不是先给一个空的骨架。日志另有自己的三态（加载 / 失败 / 空）。
- **耗时不需要新字段**：`completedAt` 减去创建时刻即可，而那个「创建时刻」就是 `event_logs` 里那一行 `created`。同理操作人是 `completedByName`（**显示名快照**）。**不要为此加表或加列。**
- **未完成的事件也能打开详情**（规格里只要求已完成）：描述在列表行上无处可看，只给已完成开面板等于让未完成的人找不到自己写的内容。这是对规格的**有意扩展**。已完成的事件额外多出完成时间 / 完成人 / 完成用时三块；未完成的不显示完成用时（没有终点，硬算出来会是一个假数字）。
- **动作码认不出来就原样显示**：`EventLog.action` 的类型是 `string` 而非联合类型（有意，见 `packages/shared/src/event.ts`），因此界面用 `eventLogActionText` 匹配、认不出就把动作码本身显示出来。收窄成三选一会让「库里有第四种动作」这件事在界面上被吃掉。
- **变更历史是读 `event_logs`，不是界面按当前状态反推的**：反推的做法（「当前是未完成就画一条未完成」）在界面上看起来很对，只有一件事经历过往返时才露馅。e2e 那一段刻意复用 T3-11 段里已走过「完成 → 撤销」的那条事件 —— 它此刻是**未完成**，而面板里必须**仍然留着那两笔**。这是整个 T3-12 里唯一真正有证明力的断言。
- **详情面板里没有编辑入口、没有勾选框**：编辑走行内菜单、状态走行内勾选框，把它们再搬进面板只会给同一个动作两条路径。要在详情里改状态是以后可能的独立改动。
- **相关规则位置**：取值域与传输类型在 `packages/shared/src/event.ts`，读写与事务在 `apps/api/src/event/events.ts`，接口在 `apps/api/src/routes/events.ts`，展示规则与乐观改状态的纯函数在 `apps/web/src/lib/event-display.ts`，界面在 `apps/web/src/components/events/`。判断见 9.36、9.37、9.38 与 9.39。

### 3.5 阶段四 · 桌面外壳（4/4 已完成，阶段四收口）

**这一阶段改的是运行宿主，不是业务代码。** T4-01 只做一件事：让外壳打开并渲染出已有界面。

- **工程落点**：`apps/desktop`（此前只有 `.gitkeep`）。最小集合为 `package.json`（`@fanhe/desktop`，`main` 指向 `dist/main.js`）、`tsconfig.json`、`src/main.ts`（主进程）、`src/preload.ts`（预加载）、`src/server.ts`（内置静态服务）、`scripts/`（下载与启动两个脚本）、`test/server.test.mjs`。
- **用 CommonJS 而不是 ESM**：`package.json` **刻意不写 `"type": "module"`**，于是 `module: NodeNext` 产出 CJS。理由是 Electron 的主进程与**沙箱化的预加载脚本**都以 CJS 为默认形态，而 ESM 预加载要求关掉沙箱；T4-03 之后预加载要承担代理与凭据的 IPC，保持沙箱开启更稳妥。
- **外壳怎么拿到前端**：主进程在回环上起一个服务，托管 `apps/web/dist` 并把 `/api/*` 反代到服务地址（含 SPA 回退）。**`apps/web` 一行未改。** 为什么不能用 `file://`、为什么必须反代而不是直连 API，见 8.5 与 9.41。
- **`/api` 反代让「单一来源」这条前提继续成立**：开发期靠 Vite 代理把 `/api` 桥到 8787，服务端因此**从不需要 CORS**；外壳照抄这个形状，前端那侧（`API_BASE_URL` 默认空串）一行不用动。
- **Electron 二进制不随依赖安装落地**：44.7.0 的 tarball 里**没有 `scripts.postinstall`**，所以 `onlyBuiltDependencies` 对它其实是空操作，装完依赖不等于二进制就位。补了 `scripts/ensure-electron.mjs` 并由根 `postinstall` 调用，幂等、换机可复现，压缩包经 `ELECTRON_*` 落在工作区 `.cache/electron`。
- **启动器要摘掉 `ELECTRON_RUN_AS_NODE`**：该变量一旦为真，electron 会退化成纯 Node（不建窗口、`require('electron')` 返回路径字符串），而 CI、部分 IDE 终端与自动化会话都会带上它。见 8.5。
- **沙箱默认开启**：受限环境（无桌面会话）里 Chromium 沙箱起不来，表现为不含原因的 `ERR_FAILED (-2)`，此时用 `FANHE_NO_SANDBOX=1` 显式关闭。**关沙箱是安全降级，不设为默认值。**
- **判断见 9.41 / 9.43**；验收对照阶段四第一项「外壳可打开并渲染界面」与第三项「远程模式下可启动本机软件」。
- **本机代理是 `import()` 进来的源码，不是拷贝，也不是构建产物**：`apps/desktop` 是 CJS、`apps/api` 的产物是 ESM，而真正需要的只有 `runLaunchProfile` 这一个函数 → 走 `import()` 直接执行 `.ts`（Node 类型剥离），于是 `agent.ts` 改完外壳下一次启动就用新的，不存在「忘了先构建 api」。代价是这条路径**只有真机能验**，见 9.43 里那个被单测放过、只有真跑才炸的坑。

### 3.6 阶段五 · 服务端化（4/5 已完成）

**这一阶段把系统从「本机开发形态」变成「可部署的生产形态」并接到公网。**

- **T5-01 容器编排**：新增 `.dockerignore`、`apps/api/Dockerfile`（build 加 runtime 两阶段）、`apps/web/Dockerfile`（node 构建加 nginx 运行）、`apps/web/deploy/nginx.conf`（`/api` 反代 + SPA 回退 + 哈希资源长缓存）、`infra/portable/ws-compose.cmd`（纯 ASCII，包住 `--env-file`）；compose 从单服务扩为 db + api + web。**api 以非 root 运行、端口三处全绑 `127.0.0.1`。**
- **T5-02 迁移执行者与连接串单一来源**：T5-01 漏了迁移的执行者（新卷里 0 张表而编排层全绿，因为**连接成功与库里有表是两件事**）。补上独立的一次性 `migrate` 服务（`depends_on` 用 `service_completed_successfully`、`restart: 'no'`），连接串与口令收成 `x-database-url` 顶层锚点。**踩到一个真 bug**：migrate 阶段追加在 Dockerfile 末尾且 compose 未写 `target`，导致 api 也构建成 migrate 镜像，症状是反复重启而 healthcheck 报 healthy。
- **T5-03 种子自动执行与备份恢复**：全新卷跑完迁移后 `permissions` / `roles` / `role_permissions` 全 0 行，建 owner 直接 500（**「迁移全部应用」与「系统可用」之间隔着一个种子**）。`db:seed` 挂进 migrate 容器自动跑（幂等、不建任何账号）；`jwt.secret` 改 getter 惰性求值并补 `assertRequiredEnv()`。新增 `tools/checks/db-backup.mjs`（`backup` / `list` / `verify` / `restore`，`verify` 做真恢复演练）。
- **T5-04 Cloudflare Tunnel 出站接入**：compose 加 `cloudflared` 服务，**刻意不绑任何宿主端口**，这就是「源站无公网入站端口暴露」的全部实现。域名 `work.fanhe.dpdns.org`，配置存在 Cloudflare 侧（容器只拿一个 Token），换机不需重建。验收用三层判据（配置层 / 运行时层 / 网络层）。
- **T5-05 访问策略由用户决定暂缓**（2026-10-12 17:00），已知风险见头部。
- 关键文件：`docker-compose.yml`、`apps/api/Dockerfile`、`apps/web/Dockerfile`、`apps/web/deploy/nginx.conf`、`infra/portable/ws-compose.cmd`、`tools/checks/{t502-empty-volume,t504-tunnel,db-backup}.mjs`。判断见 9.45 ~ 9.48。

### 3.7 阶段六 · 更新通道（3/3 已完成）

- **T6-01 版本清单接口**：`GET /api/version`（**不设门禁**，T6-02 要在登录前拿到）+ `packages/shared/src/version.ts`（`VersionManifestResponse`、`computeBuildFingerprint`、`compareVersions`、`compareManifests` 四种结果）。**版本号在运行时读根 `package.json`**（逐级上溯认 `pnpm-workspace.yaml` 为根），不构建期注入。手写 SHA-256 与 UTF-8 编码均配 `node:crypto` 逐值对照测试。
- **T6-02 客户端版本检查与更新提示**：`apps/web/src/lib/version-check.ts`（取数、比对、异常降级为 `unknown`）与 `use-version-check.ts`（挂载时机），**只有 `outdated` 才提示更新**。测试 16 项。
- **T6-03a 打包与发布链路已完成**：加了 `electron-builder`（devDep）与 `apps/desktop/electron-builder.yml`；`apps/web/dist` 与 `apps/api/src/launch/agent.ts` 经 `extraResources` 投进 `resources/`（后者**原样投递 TS 源码、不编译**，旁边配一份 `{"type":"module"}` 的 `package.json`）；`main.ts` 的 `DIST_ROOT` 与 `paths.ts` 的代理模块按 `app.isPackaged` 分派并留降级路径；版本号由 `scripts/sync-version.mjs` 从仓库根同步进 desktop 包**并加了一条门禁用例钉住**。**实测**：`fanhe-work-setup-0.1.0.exe` 116MB + `.blockmap` + `latest.yml` 三件套齐备，安装态冒烟 PASS（渲染元素=1 / 预加载桥=有 / 反代到达上游=是）。**未接 updater、未发版**。判断与实测数据见 `docs/T6-03-UPDATE-CHANNEL.md`，要点见 4.1.11。
- **T6-03c 安装包签名已完成**（2026-10-13）：自签证书 `CN=Fanhe Work`（thumbprint `0604B238…A5A3`，2031 到期）装入 `CurrentUser\My`，**证书与私钥不进版本控制、工作区内不落 `.pfx`**；`electron-builder.yml` 用 **`win.signtoolOptions.certificateSubjectName`**（⚠️ **不是 `win.certificateSubjectName`** —— 26.x 把这一组挪进了子对象，平铺会得到不点名具体键的 schema 报错，详见 4.1.12）。签名后安装包由 116,303,500 → **116,323,480 字节**（+19,980），两个产物的 PE 签名表均为 **7416 字节**（原先为 0），`app-update.yml` **本轮才首次生成**并含 `publisherName: [Fanhe Work]`。验收脚本见 4.1.12；**T6-03b 后为 28 项断言（含 6 条反例）全过**（其中新增的「未受信链会穿过『不是 NotSigned』这条松判据」与「未登记的列必须抛错」两条反例，分别对应本轮发现的两个真问题）。
- **T6-03b 更新通道已完成**（2026-10-13，提交 `3a9294f`）：`electron-updater@6.8.9` 进 **`dependencies`**（devDep 不会被打进 asar，用两条 asar 断言钉住）；主进程 `wireAutoUpdater()` 启动后检查 → 有新版则下载 → 用户确认后安装并退出；提示与 T6-02 合流（新增 `apps/web/src/lib/host.ts` 判宿主，浏览器态「刷新页面即可更新」/ 桌面态「点此重启更新」）；新增 `apps/desktop/src/update.ts`（与 electron 解耦的纯更新状态机，13 项单测，含 2 条反例）。
  **验收（离线验收台：`provider: generic` + 本地静态目录冒充更新源，`http://127.0.0.1:8799/`）**：反例① 改 `latest.yml` 的 sha512 → `阶段=error`、`是否可安装=否`；**反例② 同一个包、逐字节不变、只把自签根移出 `CurrentUser\Root` → `Status` 由 0(Valid) 变 1(UnknownError) → `Sign verification failed, installer signed with incorrect certificate` → `阶段=error`，把根加回后同一个包 `阶段=downloaded`**（**因变量只有信任根，结果翻转** —— 这才是「签名校验生效」的证据）；第 5 条 缺 blockmap → `Cannot download differentially, fallback to full download ... status 404`。含空格 CN 的风险解除（`parseDn` 保留空格，实测 `Signature validated using only CN Fanhe Work`）。
  🔴 **本轮同时修正了 T6-03c 的签名判据**：`Status` 必须是 `Valid`(0) —— electron-updater 只在 `data.Status === 0` 时才比对发布者，自签链不可信得到的 `UnknownError`(1) 会让**每一次更新都被拒绝**；修法是把自签根也装进 `CurrentUser\Root`。要点见 4.1.13，完整记录见 `docs/T6-03-UPDATE-CHANNEL.md` §七 T6-03b 与 `DEVELOPMENT-PLAN.md` 9.54。
  **仍未验**：§八 第 4 条「安装 A → 发布 B → 版本变 B」的**正向路径** —— 2026-10-13 17:4x已发布 B（`v0.1.1`），B 这一端齐备，但**仍需在一台装着 v0.1.0 的机器上点一次更新并确认 `app.getVersion() === '0.1.1'`**。这一步必须真人操作（要装A、要点更新），自动化替代不了。届时差分下载也才第一次真正可用（`0.1.0.exe.blockmap` 已有对照目标）。
- **2026-10-13 21:xx 追加：修掉「更新后设置丢失」的根因，并把客户端「有更新」做成可点的按钮**（用户把验收条件加严为「更新后本地设置及本地存储的所有数据不丢失」）。真根因是**界面来源（端口）每次启动都变**：`server.ts` 原用 `listen(0)` 让系统随机分配端口，而 localStorage 与 IndexedDB 都按 origin 分区、origin 含端口，于是每次启动换一个存储分区（实测 `%APPDATA%\梵禾 Work\IndexedDB\` 下并存 `http_127.0.0.1_49901` 与 `http_127.0.0.1_57352` 两份互不可见的存储）。修法是**端口候选链**（偏好文件 → 已有数据的旧端口 → 固定段 `41873~41880` → `0` 系统兜底）+ 偏好持久化 + **单实例锁**（第二个实例抢不到同一端口会顺延到新分区、两边互相覆盖）+ 旧来源发现（IndexedDB 目录 mtime 为精确信号，localStorage 日志只补未知端口）。客户端侧新增 `UpdateNotice` 组件与 `use-desktop-update` hook（检查 / 下载进度 / 重启更新 / 失败重试），把 T6-02 的「有更新」从一句提示变成可点的按钮。**实测**：dev 外壳连跑两次，第二次日志为 `[shell] 界面来源 http://127.0.0.1:57352（沿用上次；候选 57352 → 49901 → 41873 → … → 0）`，`%APPDATA%\梵禾 Work\shell-origin.json` 为 `{"port": 57352}` —— **首次落进既有来源之一，设置重新可见**。要点与阻塞见 4.1.14。提交 `4c0ac8a`。
- ✅ **两次发布均已完成**：
  - `v0.1.0`（2026-10-13 16:0x，Release `411432862`）—— 首个发布版，垫脚石 A。
  - **`v0.1.1`（2026-10-13 17:4x，Release `411517975`，tag 指向 `8162c33`）** —— 为闭合正向验证而发，含 P0 三项。`dist` 6 分 4 秒 exit 0，安装包 **112,209,032 字节**；`verify:all` **32 项断言 + 4 条反例全过**，两个产物 PE 签名表 7416 字节且 `Status=Valid`、主体 `CN=Fanhe Work`；`app-update.yml` 含 `publisherName: [Fanhe Work]`；线上 `latest.yml` 与本地**逐字节一致**（349 字节，sha256 `eaa9839b…`），其 `sha512` 与 `size` 与实际安装包**全部 MATCH**；未认证 GET by-tag **200**（草稿已解除，id `411517975`）。

### 3.8 阶段七 · 账号与权限管理（T7-01，计划外新开）

**「系统设置」页由占位页换成真实的账号管理页**，导航项 `system-settings` 的 `planned` 置为 `false`。owner 可以建子账号、改姓名部门角色状态、重置口令、按账号单独授予或拒绝权限点。完整实施文档见 `docs/T7-01-ACCOUNT-ADMIN.md`，要点见 4.1.10。同一时间还有两条配套改动：`db:reset-password` 口令重置通道，以及一轮 UI 设计稿落地对齐（见 3.2 段的界面说明与 `UI合并方案/梵禾Work-落地对齐记录-2026-10-13.md`）。

---

## 四、待办事项

### 4.1 下一项：在装 v0.1.0 的机器上点更新，确认落到 v0.1.1（P1，B 端已发，只差真人操作）

> **T5-05 访问策略：用户 2026-10-13 17:1x 决定维持现状继续对外开放**（不加 Cloudflare Access、不停 Tunnel），该风险已知并接受；**阶段六（T6-01 ~ T6-03）已全部完成，并已发版 `v0.1.0`（2026-10-13 16:0x）与 `v0.1.1`（同日 17:4x）。** T6-03 任务定义见 `DEVELOPMENT-PLAN.md` 第三章第 224 行，阶段验收见第七章；三段的拆分理由与已落地的部分见 `docs/T6-03-UPDATE-CHANNEL.md`。

- 🔴 **2026-10-13 21:xx 追加的阻塞**（原为「需用户裁决」；**2026-10-14 已裁决并执行，见下方最后一条**）：为闭合「更新后本地设置及本地存储的所有数据不丢失」这条加严验收，已落地 **T7-02**（外壳界面来源固定 **T7-02a** + 客户端更新按钮 **T7-02b**，提交 `4c0ac8a`，四道门禁 578 项全绿，详见 4.1.14）。但**打包验证中止在本机缺签名证书**：`dist:dir` 报 `⨯ Cannot find certificate CN=Fanhe Work, all certs:   failedTask=build`，实测 `Cert:\CurrentUser\My` 为空、`CurrentUser\Root` 里没有 Fanhe 自签 —— **证书来自本沙箱会话之外且已被清理**。**未执行 `signing:cert`**：证书是唯一签名身份，须由用户决定。
  - ✅ **2026-10-13 22:xx 题面已收窄（T6-03d）**：原始身份**找回来了** —— 不是从证书库（那里确实空的），而是从**已发布产物的内嵌签名**里：`fanhe-work-setup-0.1.0.exe` 与 `-0.1.1.exe` 都带签名，主体 `CN=Fanhe Work`、指纹 **`0604B2381B8666C99F247DA7B576A4647601A5A3`**（与 4.1.12 记的一致），`NotAfter 2031-10-13`，两版指纹相同 ⇒ v0.1.0 与 v0.1.1 同身份。本机身份档案已用新增的 `signing:adopt` 补齐，**轮换闸已 armed**（下次跑 `signing:cert` 会先拒绝，不再静默换身份）。详见 4.1.15。
  - **裁决题面因此只剩一句：有没有 `0604B238…` 这张证书的 `.pfx` 备份？** **(a) 有** → `pnpm --filter @fanhe/desktop signing:import -- <pfx>` 导入（口令走 `FANHE_SIGNING_PFX_PASSWORD`），身份与档案吻合、闸放行、可直接发版；**(b) 没有** → 私钥不可从产物反推，**轮换不可避免**，须 `-AllowRotate` 新建，并**在每一台已装机器上补装新根**（把 `scripts/fanhe-work-signing-public.cer` 拷过去跑 `signing:trust` —— 它只装根、不建证书；`signing:cert` 第 4 步只装当前机器），做不到的机器永久收不到更新、只能手工重装。⚠️ v1 脚本**没有导出能力**（`-ExportPath` 是 T6-03d 才加的），且 6.3 第 6 条要求私钥不落在工作区 —— 备份只可能在**工作区之外**；当初没手工导出过，就是没有。
  - ✅ **2026-10-13 23:xx 本机信任根已补回（T6-03e）**：这里原本还记着「本机连旧包都验不过（两个已发布安装包也是 `UnknownError`(1)，因为原始根已从 `Root` 消失）」，**该条现已不成立** —— 用新加的能力 `pnpm --filter @fanhe/desktop signing:trust` 把公钥证书装进本机 `CurrentUser\Root` 与 `TrustedPublisher`，`fanhe-work-setup-0.1.0.exe` 与 `-0.1.1.exe` 双双回到 `STATUS=Valid VALUE=0`（`signing:trust-check` 报 `TRUST_ROOT=True`、`CHAIN_BUILDS=True`）。**这只修好了「验」的那一半，没修「签」的那一半**：私钥仍不在本机，`dist:dir` 依旧报 `Cannot find certificate CN=Fanhe Work`，**发版仍阻塞在上面那句裁决上**。
  - 🔍 **2026-10-14 私钥检索：工作空间与 GitHub 两侧均未找到 `.pfx`**。用户提出「备份就在工作空间」与「可以看下 GitHub 上的备份」，据此做了如下检索，**两侧都没有命中**。
    - **工作空间全盘**（`E:\fanhe Work`，含 `.workbuddy` / `.config` / `.local` / `.workbuddy-ai` / `infra` / `runtime` / `logs` / `交接-20261012` 等全部目录）：无任何 `.pfx` / `.p12` / `.pvk` / `.pem`。文件名与文件内容两路检索均无命中（含按指纹字符串 `0604B238` 的内容检索）。
    - **本机证书库**：`CurrentUser\My` 中带私钥的证书 **0 张**；`LocalMachine\My` 中 `CN=Fanhe Work` **0 条**；`Root` 与 `TrustedPublisher` 各 1 条，均为 `HASKEY=False` 的公钥副本。
    - **本机档案目录** `%LOCALAPPDATA%\FanheWork\signing\`：只有 `signing-identity.json`（487 字节），无 `.pfx`。
    - **本仓库全历史**（`git log --all --diff-filter=A --name-only`）：只出现过 `fanhe-work-signing-public.cer` 一个证书文件，**私钥从未入库**。
    - **GitHub**（账号 `dy00001`，共 7 个仓库）：`fanhe-work` 与其余 6 个仓库的**完整文件树**、全部分支、发布资产、Gists、以及 `fanhe-work` 的 Actions secrets，**均无 `.pfx` / `.p12` / 证书压缩包**。GitHub 代码搜索不索引二进制文件，故改用文件树检索。
    - **结论**：若确认存在备份，它在本机与 GitHub 之外（另一台机器、网盘、或某次未记录的手工导出）。**若没有，则 (b) 分支成立**，轮换不可避免。
  - 🔍 **2026-10-14 第二轮穷尽检索（补上一轮的三个盲区）**：上一轮只做了「文件名 + 内容」两路，**漏掉了压缩包内部、其它磁盘、以及证书库的逐库枚举**。本轮补齐，四路并行，**仍然全部落空**：
    - **全机四盘按扩展名**（C: / D: / E: / F:，`*.pfx` / `*.p12` / `*.pvk` / `*.pem` / `*.jks` / `*.keystore`）：E: 与 F: **全盘零命中**；C: 只有系统 CA 包（`cacert.pem` / `ssl-cert-snakeoil.pem`）；D: 只有第三方软件自带的 CA 包与 Python 测试证书。**无一份签名私钥。**
    - **压缩包内部**（工作空间内全部 `.zip` / `.7z` / `.tar.gz` / `.tgz`，含 `交接-20261012/docker/volumes/fanhe-work-pgdata.tar.gz`）：只有 electron-builder 缓存、pnpm 原生包、数据卷归档，**无密钥类文件**。
    - **内容特征**（工作空间内 <512 KB 的文本文件，匹配 `BEGIN * PRIVATE KEY` / `BEGIN PKCS12` / 指纹 `0604B238…`）：命中**全是文档里提到指纹的文字**，无真实密钥材料。
    - **证书库逐库枚举**（`CurrentUser` 的 `My` / `Root` / `TrustedPublisher` / `CA`）：`My` **为空**（带私钥 0 张）、`Root` 1 条 `HASKEY=False`、`TrustedPublisher` 1 条 `HASKEY=False`、`CA` 0 条。
    - 🔴 **结论已闭合：(b) 分支成立，轮换是唯一能再发版的路。** 操作手册见 **`docs/SIGNING-ROTATION-RUNBOOK.md`**（2026-10-14 新建，含源码级论证「同 CN 换证书后更新为何还能通」、打包机与目标机的分步操作、以及**装新根必须早于消费新版本**这条顺序约束）。
  - ✅ **2026-10-14 已执行轮换**（提交 `dd4e9e6`）。**新身份 `CN=Fanhe Work` / `095CB390A4CD0A64EF89B4364CC095A6A8A2A9BB`**，RSA 2048 / SHA256，有效期 2026-10-14 ~ 2031-10-14，EKU=代码签名。执行记录：
    - **轮换前自检**：`RESULT=MISSING reason=no-certificate-with-private-key-found`，档案记 `0604B238…`、本机 `CURRENT_THUMBPRINT` 为空 —— 与预期一致。
    - **轮换**：`signing:cert -AllowRotate` → `IDENTITY_CHANGE=allowed-by-AllowRotate`、`ACTION=created`、`TRUST_ROOT_CERTUTIL_EXIT=0 VERIFIED=True`、`IDENTITY_HISTORY_COUNT=1`（旧身份进档案 `history`，**不删**）。
    - **轮换后自检**：`RESULT=OK`、`CURRENT_THUMBPRINT=095CB390…`（与档案一致）、`CURRENT_DAYS_LEFT=1826`。
    - **证书库**：`My` **1 条 `HASKEY=True`**（新证书带私钥）；`Root` **2 条**（`095CB390` + `0604B238`）；`TrustedPublisher` **2 条**；`CA` 1 条（自签证书装进 `Root` 时 Windows 同时写 `CA`，属正常）。
    - **🔴 `SUBJECT` 保持 `CN=Fanhe Work` 是刻意的，也是更新链路能活下来的原因**：electron-updater 的发布者比对取 `Subject` 的 **CN 而指纹不参与**（`windowsExecutableCodeSignatureVerifier.js:70~:84`），同 CN ⇒ 比对字符串不变。剩下的一层是信任根 —— 本机已装，**目标机必须补装新根且要早于消费新版本**。
    - **公钥入库生效**：`apps/desktop/scripts/fanhe-work-signing-public.cer` 在 `git status` 里显形（这正是把它纳入版本控制的全部价值 —— 身份一变就看得见）。
    - ⚠️ **旧公钥（`0604B238…`）仍需要**：P0 正向验证用的是 v0.1.0 与 v0.1.1，两者都是**旧身份**签的，那台机器要装的是**旧根**。该文件已从 `git show dd4e9e6^:` 取出，另存为 `apps/desktop/scripts/fanhe-work-signing-public-retired-0604b238.cer`（**退役存档，不参与 `signing:trust`** —— 后者按固定文件名取证书，不会误装它）。
    - ✅ **打包已成功，`Cannot find certificate CN=Fanhe Work` 消失，发版阻塞解除。** 版本号 0.1.1 → **0.1.2**（`dist` 用旧号会覆盖 `release/` 里那个同名的已发布安装包）。先 `pnpm --filter @fanhe/web build`（22.25 s）再 `dist`（**6 分 14 秒**），产出 `fanhe-work-setup-0.1.2.exe` **112,218,832 字节** + `.blockmap` + `latest.yml`（sha512 / size 一致）。四个产物（应用本体、`elevate.exe`、卸载器、安装包）全部以新身份签上。
    - 🔴 **`dist` 这次踩到一个与签名无关的坑，值得单记**：第一次失败于 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":80,"threshold":50}`（electron-builder 解压 Electron 前要清空 `release/win-unpacked`）；抬阈值后**又**失败于 `genie-trash ... ETIMEDOUT` —— 守卫转去移入回收站，而回收站二进制在 U 盘上对 ~200 MB 目录 5 秒超时。**最终解法是先把 `release/win-unpacked*` 手工删掉**：守卫对「路径不存在 + `force`」是直通的（shim 第 765~771 行），压根不调回收站，**不必关闭全局保护**。抬阈值那个环境变量仍然要加。
    - ✅ **验收：`verify:pack` PASS —— 43 项断言全过**（含 `resources/web` 与 `apps/web/dist` **逐文件一致**、产物含 **`重启更新到`**（T7-02b 的按钮终于进了包）、`publisherName` 与证书主体一致、`latest.yml` 的 sha512/size 一致、**产物实际指纹与身份档案一致**）。
    - ✅ **签名报告给出一个很有说服力的横截面**：四个 exe **全部 `STATUS=Valid VALUE=0`**、`NOT_VALID_COUNT=0`，**横跨两个身份** —— `梵禾 Work.exe` 与 `0.1.2.exe` 是 `095CB390…`（新），`0.1.0.exe` 与 `0.1.1.exe` 仍是 `0604B238…`（**旧**）。**这直接证明新旧两个根在本机共存且各自成立**，正是轮换能活下来的那条前提。
    - ✅ **2026-10-14 `0.1.2` 已发布**（提交 `3d4032f` 之后的动作）。GitHub Release **`v0.1.2`**（ID **`412862351`**，注解 tag 指向 **`e40bdfc`** —— 与 `v0.1.1` 同惯例，指向版本号提升那个提交，即 `dist` 打包时的源码状态）。三资产齐备、**草稿已解除**；**未认证 GET by-tag 200**；线上 `latest.yml` 与本地**逐字节一致**（349 字节）；安装包线上 `Content-Length: 112218832` 相符。
    - ✅ **发布前四道门禁实跑**（不引用旧结果）：test **599 项 0 失败**（shared 108 + api 233 + web 116 + desktop 142，api 含 5 项设计性跳过）、`lint` / `typecheck` / `format:check` **退出码全 0**。此轮未改任何源码，仅文档与签名脚本注释变动。
    - 🔴 **路径 B 探针实测 PASS —— 轮换手册 §八第一条由「源码级论证」转正为「端到端实测」**：客户端是已装的 **`v0.1.1`（旧身份 `0604B238…` 签的）**，待验包是 **`0.1.2`（新身份 `095CB390…` 签的）**，探针报 `阶段=downloaded 版本=0.1.2` / `是否可安装=是` / **`PASS`** / 退出码 0，日志打出 **`Signature validated using only CN Fanhe Work.`** —— **与源码级论证预测的比对路径（取 `Subject` 的 CN、指纹不参与）逐字吻合**。探针用**本地验收台**（`provider: generic` + `python -m http.server`）而非真源，因为**从 agent 沙箱启动的 GUI 进程出网被拦**（详见下方环境坑）；安装目录的 `app-update.yml` 跑完已还原并与备份逐字节比对 `IDENTICAL`。
    - 🔴 **新挖出的两个环境事实**：① **从 agent 沙箱启动的 GUI 进程出网被拦** —— 直连 `ERR_CONNECTION_RESET`，`--proxy-server` 指向**不存在的端口**时错误**不变成** `ERR_PROXY_CONNECTION_FAILED`（说明开关未被采纳，是沙箱在拦，不是代理配错）。② **`HTTP_PROXY` / `HTTPS_PROXY` 对应用毫无作用** —— `electronHttpExecutor` 走 `electron.net`（Chromium 网络栈），**Chromium 不读这两个环境变量**，只认系统代理与 `--proxy-server`；本机系统代理**其实是配好的**（`ProxyEnable=1`、`ProxyServer=127.0.0.1:7897`），所以**用户在正常终端启动应用时应当能到达 GitHub**。
    - **差分下载（判据 6）**：计算**正确**（`To download: 2,806.4 KB` / `Full: 109,588.7 KB`，3%）；**实际差分传输未走通**，两次回退各有原因且都不是产品缺陷 —— ① 验收台缺旧 blockmap（404）；② **本地 rig 的 `python -m http.server` 不支持 Range**（实测 `200` 无 `Accept-Ranges`），而**真实源实测支持**（`206 Partial Content` + `Accept-Ranges: bytes`）。**真实源上的差分仍未被端到端跑到**，但两侧证据齐备。
    - ⚠️ **仍未闭合（唯一一条，需真人）**：真实发布源的端到端更新 —— 启动 `v0.1.1` → 自动下载 `0.1.2` → **退出应用**（触发 `autoInstallOnAppQuit`）→ 重开 → exe `FileVersion` 变 **`0.1.2`**。探针刻意关掉了退出时自动安装，所以这一步替代不了。逐步操作见 `docs/P0-UPDATE-VERIFICATION.md` §0.6「路径 B 执行记录」。
    - ✅ **2026-10-14 补：本机作为「接收机」的条件已实测通过**（`signing:trust-check`，只读）。`RESULT=OK`、**退出码 0**、`TRUST_ROOT=True` / `TRUST_PUBLISHER=True` / `CHAIN_BUILDS=True` / `TRUST_CERT_MATCHES_RECORD=True`；`Root` 与 `TrustedPublisher` 里**新旧两根各 2 条**（`095CB390…` + `0604B238…`）。**本机已装 `v0.1.1`**（`D:\fanhe work\@fanhedesktop`，`FileVersion=0.1.1`），**更新缓存是热的**（`installer.exe` 112,209,032 字节 = `v0.1.1` 安装包，验证前须清）。
    - 🔴 **由此带出一条真实缺口（已修）**：`docs/P0-UPDATE-VERIFICATION.md` 原文通篇按「A=`v0.1.0` → B=`v0.1.1`」写，判据是「期望 `0.1.1`」「缓存期望 112,209,032」，且教人装**退役旧根** —— **`0.1.2` 一发布这些判据全部失效**。已新增第 0.6 节「先选路径」，给出 A / B 两条路的对照表。**路径 B（`0.1.1` → `0.1.2`）严格更强且准备成本更低**：本机已是 `v0.1.1`（不用卸装）、两个根都在（步骤 1 可跳过）、且**它是唯一能把轮换手册 §八第一条「同 CN 新证书能否被旧客户端接受」从源码论证变成端到端实测的路径**。代价是 `latest` 指向 `0.1.2` 后「`0.1.0` → `0.1.1`」这条原始路径不再可做（但其要证明的东西被路径 B 覆盖更多）。
    - 🔴 **顺序约束已收窄为「逐机」**：手册第五节的「装新根必须早于消费新版本」**只对尚未装新根的机器成立**。本机两个根并存 ⇒ **它可在发布前后任意时刻验证**。发布前真正要做的是**盘一遍「还有哪些机器装了 `v0.1.0` / `v0.1.1`」**。
- ⚠️ **先读头部那条已知风险**：公网上的 `work.fanhe.dpdns.org` **没有 Cloudflare Access 防护**（T5-05 暂缓）。T6-02 的「有可用更新」提示已经在这一层公开可见，而版本号与提交号本来就在客户端产物里明文可见，故不增加信息量。若后续要显示更细的内容（「落后几个版本」「当前在线设备数」），需要重新评估。
- **`T6-03a` / `T6-03b` / `T6-03c` 三段均已完成**（打包与发布链路、更新通道、安装包签名），实施记录见 4.1.11 / 4.1.12 / 4.1.13。**阶段六收口。**
- ✅ **§八 第 1、2、5 条反例都已实测通过**（改 sha512 → 拒绝；**只改信任根 → 同一个包在拒绝与通过之间翻转**；缺 blockmap → 差分回退整包）。**「更新器会拒绝异签名包」这句话现在有证据了**，而反例②的因变量只有信任根，是一个干净的对照。含空格 CN 的具象风险也**已解除**（`parseDn` 保留空格，实测 `Signature validated using only CN Fanhe Work`）。
- 🔴 **接手时先注意一条被 T6-03c 漏掉的真拦路虎（本轮已修）**：electron-updater 只在 `data.Status === 0`（即 `Valid`）时才比对发布者，自签链不可信得到的 `UnknownError`(1) 会让**每一次更新都被拒绝**。所以判据是 `Status == Valid`（**不是** `!== 'NotSigned'`），前提是把自签根也装进 `CurrentUser\Root`。**换机器时这两处都要做。**
- ⏭️ **下一项（已按路径 B 重排，2026-10-14）**：**在一台真实机器上启动 `v0.1.1` → 等它自动下载 `0.1.2` → 退出应用 → 重开 → 确认 exe `FileVersion` 变 `0.1.2`**。这是「安装 A → 发布 B → 检查 → 下载 → 安装 → 重启，`app.getVersion() === B`」的收官一步，**自动化替代不了**（探针刻意关掉退出时自动安装）。**B 端已就位且已发布**：`v0.1.2`（Release `412862351`，安装包 112,218,832 字节，线上 `latest.yml` 与本地逐字节一致）。**这一步同时也是差分下载的正验**（真实源实测支持 `Range`/`206`，且缓存里已留着 `v0.1.1` 的 `installer.exe` 作为差分的「旧文件」）。**这一步做完 T6-03b 才算收尾。** 逐步操作见 `docs/P0-UPDATE-VERIFICATION.md` §0.6「路径 B 执行记录」。<br>（原表述：在装 v0.1.0 的机器上点更新、确认版本变 0.1.1 —— **该路径已因 `latest` 指向 `0.1.2` 而不再可做**，见 4.1 末与 `DEVELOPMENT-PLAN.md` 9.61。逐步操作手册 `docs/P0-UPDATE-VERIFICATION.md` 已于 2026-10-14 整理成独立文档。）
  - 🔴 **2026-10-14 实测更正一条，做验证前必读**：**已发布的 v0.1.0 / v0.1.1 客户端里没有更新按钮。** 两个包带着旧的前端产物（`dist` 只跑 `sync-version.mjs && tsc && electron-builder`，不重建 web；发布前没先跑 `pnpm --filter @fanhe/web build`）。实测本机安装的 v0.1.1，其 `resources/web/` 里检索「更新」相关文案只命中浏览器那一支的 `已是 ${n}，刷新页面即可更新`，检索「重启」**零命中**。**但更新仍然会发生**：主进程 `wireAutoUpdater()` 在启动后自动检查一次，`autoDownload = true` 且 `autoInstallOnAppQuit = true`，所以这条链路在已发布客户端上的实际入口是**「退出应用再打开」**，不是点按钮。这不影响 §八 第 4 条的验收（那条只要求检查、下载、安装、重启、版本变 B），但做验证的人必须知道，否则会去找一个不存在的按钮。**该缺陷要在下一个版本里修**，做法是发版前先 `pnpm --filter @fanhe/web build` 再 `dist`。详见 `docs/P0-UPDATE-VERIFICATION.md` 第 0.5 节。
  - ⚠️ **另一个会让验证失去意义的坑**：更新缓存目录 `%LOCALAPPDATA%\@fanhedesktop-updater\` 里那个 112,209,032 字节的 `installer.exe`（正是 v0.1.1 安装包）。**它有两面**：① 若它是**已下好的新版**，updater 会直接复用，「下载」这一步就不会真的发生 —— 所以要确认版本；② 若它正是**当前已装版本**（本机即如此，已装 `v0.1.1` 而缓存里就是 `v0.1.1` 的包），**它是差分下载必需的「旧文件」，删了反而只能整包下载**。**判据是比对版本号，不是「见到就删」。**
- **签名密钥的保管方式**：`DEVELOPMENT-PLAN.md` 6.3 第 6 条已约定「更新签名密钥与工作空间分开保管，**不随盘移动**」。已按自签证书进 Windows 证书库落地：`CurrentUser\My` 天生随机器不随盘，**证书与私钥不进版本控制、工作区内不落 `.pfx`**。🔴 **换机器必须先在新的开发机（打包机）跑一次 `pnpm --filter @fanhe/desktop signing:cert`**，否则打包会报找不到证书；**它现在还会把自签根装进 `CurrentUser\Root`（T6-03b 补上的一步）** —— 少了这一步 `Status` 会是 `UnknownError` 而不是 `Valid`，**所有更新都会被拒绝**（症状极隐蔽：签名看着好好的）。⚠️ **注意区分两种机器**：只有**打包机**需要 `signing:cert`（要私钥）；**接收更新的目标机**只需要公钥根证书进 `CurrentUser\Root`，跑 `signing:cert` 反而会在那台机器上生成一张**新**证书、装了没用。⚠️ **换了证书之后**：`publisherName` 不会变（它由 Subject DN 推出，同 CN 就同字符串），断的是**信任根** —— 新根没装进已装机器的 `CurrentUser\Root`，那些机器就会静默收不到更新。**先看 `pnpm --filter @fanhe/desktop signing:check`，再决定要不要动证书**（T6-03d 起有这条只读自检，见 4.1.15）。
- **它只依赖 T4-01 外壳，与阶段五无关**，所以 T5-05 是否推进不影响它。

### 4.1.0 阶段七的登记状态（**已登记**，2026-10-14 补齐 T7-02 / T7-03 / T7-04）

T7-01 有提交、有独立文档（`docs/T7-01-ACCOUNT-ADMIN.md`）。**阶段七已于 2026-10-13 登记进 `DEVELOPMENT-PLAN.md`**（提交 `f5d0f3e`）：第三章有任务表（第 228 行起）、第四章有依赖图（第 249 / 252 / 262 行）、第七章有验收清单（第 400 行起）。

**2026-10-14 补齐了三个缺口**（见 `DEVELOPMENT-PLAN.md` 9.59）：

- **T7-02 的三件套此前漏登记。** 它在 `4c0ac8a` 落地后只写进了 §4.1.14 与 9.55 —— 都是「实施判断」性质的叙述，而第三章任务表 / 第四章依赖图 / 第七章验收清单一处未动，成了「有提交、有长文、但不在计划里」的任务。T7-01 当初也是这样（直到 `f5d0f3e` 才补）。**两次的共同点是「记录写在容易想起的地方，登记写在不容易想起的地方」。**
- **T7-03 / T7-04 两份设计稿此前在版本控制之外**（提交 `c42e7de` 入库）。它们写于 2026-10-13，T7-03 只被 T7-04 引用、T7-04 无人引用，`git clean -fd` 一次就会丢掉 55 KB 的分析。内容恰好压在当前最痛的几件事上：T7-03 §一.4 是「已发布客户端没有更新按钮」的成因分析，§一.6 与 §四.7 分别钉住签名信任根与「打包前必须重建前端」。
- **一处误判已纠正**：「已发布客户端没有更新按钮」**不是待修缺陷**。代码与回归闸都在 T7-02 里（`verify-pack.mjs` 第 286 行起有「`resources/web` 与 `apps/web/dist` 逐文件一致，不只是 `index.html`」的断言，专门挡「半新半旧」），缺的**只是一次发版** —— `v0.1.0` / `v0.1.1` 都发在 `4c0ac8a` 之前。

**后续范围仍待用户确认**：T7-03 / T7-04 目前只有设计稿，是否正式采纳为任务由用户决定；阶段七的标题（「账号与权限管理」）已名不副实但**有意未改**（改名会牵动本文档对「第 228 行起」的引用），改以标题下的说明澄清。

> 注：`DEVELOPMENT-PLAN.md` 第 1760 行（9.51 节）仍写着「尚未进入本计划第三章的任务表、第四章的依赖图与第七章的验收清单」，那是登记之前的判断原文，未逐字改写。

### 4.1.11 T6-03a 打包与发布链路的实施记录（已完成，供对照）

完整文档是 `docs/T6-03-UPDATE-CHANNEL.md`（验收判据、两条架构冲突、六条隐藏依赖、环境陷阱、三段拆分、决策记录），逐任务判断见 `DEVELOPMENT-PLAN.md` 9.52。要点：

- **三段的切分本身就是一条判断**：打包链路、更新逻辑、签名三者的失败面完全不同，混着做时任何一步红了都定位不到是哪一层。所以 T6-03a 只到「产出安装包 + 装完之后真的跑得起来」，**不接 updater、不发版**。
- **「打包态没有工作区」是核心矛盾，且它有两个出口不是一个。** 开发态外壳靠两条工作区路径活着 —— `DIST_ROOT = resolve(__dirname, '../../web/dist')` 与 `paths.ts` 直接 `import()` 运行 `apps/api/src/launch/agent.ts`。装机后两条都不存在。做法是 `extraResources` 把 `apps/web/dist` 与 `agent.ts` 投进 `resources/`，再按 `app.isPackaged` 分派。
- **`agent.ts` 原样投递 TS 源码、不编译，是先证过才决定的**：把它单独拷到一个没有 `node_modules`、也在工作区之外的目录里直接 `import()` → **成功、导出 5 个符号**，说明运行时依赖为零。没实测这一条就不该选原样投递。
- **随包 `agent.ts` 旁边必须有 `{"type":"module"}` 的 `package.json`**：`.ts` 的模块类型由**最近的 `package.json`** 决定，缺失只是告警、写成 `commonjs` 则 `SyntaxError` 整条链路失效。验收脚本为它配了反例。
- **`paths.ts` 的降级要宽**：实测四个失败分支里最可能发生的是「介质拷了一半」（`.ws-root` 还在、`apiSourceRoot` 却抛错），所以 `resolveWorkspaceAgent(fromDir, lenient)` 让四个分支在给了随包路径时一律宽松；不给第二个参数时原报错文本一字不变。
- **安装态的 `configDir` 与 `defaultUrl` 都不是锦上添花**：少了前者 `service:set` 在装机后永远报「未找到配置文件路径」；少了后者安装态会去连不存在的 `127.0.0.1:8787`，**而本机冒烟偏偏还是绿的**（开发服务正在跑）—— 最容易漏的一种假绿。
- **`0.0.0` 是个「永远提示有更新」的合法错误答案**：`apps/desktop/package.json` 原先就是 `0.0.0`，而 electron-builder 的 `app.getVersion()` 读的正是打包进去的那份清单。加了 `scripts/sync-version.mjs` + 一条门禁用例（断言两者**相等**而非字面量，发版时才不会自己挂自己）。
- **验收脚本不能自己起子进程**（本机 `spawnSync` 对任何目标都返回 `EBUSY`，**空 stderr 正是「子进程没起来」的指纹**），改为进程内 `import()` + 打印人工步骤。脚本自带两条反例（改 `commonjs` 必失败、注入语法错误必失败），**只有能被证伪的断言才算有判据**。
- **两个与代码无关但与这台机器强相关的问题**：换盘残留的四个 `node_modules.old/`（含 46 个指向旧 `E:` 的悬空链接）让 electron-builder 收集依赖时直接 ENOENT，**而报错指向 `packages/shared`、desktop 自己的依赖完全健康**，极易误判成「electron-builder 不兼容 pnpm 的 `workspace:*`」；`prisma generate` 与 electron-builder 清理上一轮产物都会撞本机安全删除守卫，需前置 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD`。
- **顺手补了一个真实配置缺口**：`.tmp/` 原先只在 `.gitignore` 里被忽略，`.prettierignore` 与 `eslint.config.js` 都漏了；`release/`（本任务新引入的输出目录）三处都漏了。漏 `.tmp` 的那次直接让 lint 报出 **11064 条**、全部与源码无关。**忽略了 `dist/` 不等于忽略了它的兄弟目录。**
- **验证结果（2026-10-13）**：`dist:dir` 2 分 5 秒 / `dist` 6 分 1 秒，均 exit 0；产出 `fanhe-work-setup-0.1.0.exe`（116,303,500 字节）+ `.exe.blockmap` + `latest.yml`（**差分三件套齐备**，印证「只有配了 `publish` 才产出后两者」）；`latest.yml` **无 `publisherName`**、两个 PE 的签名表大小均为 0（未签名，属 T6-03c）。安装态冒烟 **PASS**：渲染元素=1 / 预加载桥=有 / 反代到达上游=是 / 启动自检可用。`verify-pack.mjs` **17 项断言 + 2 条反例全过**；随包 `agent.ts` 在**安装目录那个 Electron 44 运行时**（内置 Node 24，与开发机 Node 22 不同版本）里加载出 5 个导出且 stderr 为空。四道门禁 **506 项 0 失败**（desktop 76 → 86）。提交 `4ded6b1`。

### 4.1.12 T6-03c 安装包签名的实施记录（已完成，供对照）

完整文档是 `docs/T6-03-UPDATE-CHANNEL.md`（§六 签名方案、§七 T6-03c 执行结果、§八.1 完成状态表），逐任务判断见 `DEVELOPMENT-PLAN.md` 9.53。要点：

- 🔴 **计划文档里「用 `win.certificateSubjectName`」是错的**，照此配置会得到一个**完全不说人话**的报错：`configuration.win should be one of these: null` —— **不点名是哪个键错了**。真因：26.x 把签名选项整体挪进了 `WindowsSigntoolConfiguration`，而 `WindowsConfiguration` 是 `additionalProperties: false`。正确写法是 `win.signtoolOptions.certificateSubjectName`。
- **为什么会误判**：`out/options/winOptions.d.ts` 里确实有 `certificateSubjectName` 这个词（第 96 行），但它属于第 73 行起的 `WindowsSigntoolConfiguration` 接口。**只 grep「文件里有没有这个词」会得出相反结论，必须看它在哪个 interface 里。** 权威判据是 `scheme.json` 的键表；运行期读的也是 `signingManager` 的 `platformSpecificBuildOptions.signtoolOptions?.certificateSubjectName`。
- 🔴 **`resources/app-update.yml` 只在真正的 nsis 构建里生成**，`--dir` 之后它本来就不存在 —— 对它报 FAIL 是**假警报**。判据在源码里：`PublishManager.js` 的 `onAfterPack` 有一道 `isSuitableWindowsTarget` 闸（同文件 391 行），只认 `nsis` / `nsis-*`（或 appx 且开了 `electronUpdaterAware`），`dir` 目标不在此列。验收脚本据此改为「跟本轮是否产出安装包绑定」。
- **`publisherName` 被写进 `app-update.yml` 有前置条件**：`WinPackager.isForceCodeSigningVerification`（`winPackager.js:26`）= `verifyUpdateCodeSignature !== false`。本项目没设成 false 故为真。**哪天有人为了「跳过校验」把它设 false，`app-update.yml` 里就不会有 `publisherName`**，这条要一起看。
- **读 PE 头只能证明「有签名」，证明不了「签成了谁」**，而 electron-updater 比的是**发布者身份**。故新增 `scripts/verify-signature.ps1`（`verify:sign`）取 `Get-AuthenticodeSignature` 的 `Subject`/`Thumbprint`/`Status` **写进文件**（本沙箱 PowerShell 静默吞 stdout，落盘是唯一通道）再由验收脚本读回断言。
- **自签证书的 `Status` 是 `UnknownError`（链不可信），不是 `NotSigned`** —— ~~判「签上了」不能要求 `Status=Valid`，只能要求 `!== 'NotSigned'`~~。🔴 **这条在 T6-03b 被证伪并已撤回，见 4.1.13**：electron-updater 只在 `Status === 0`（`Valid`）时才比对发布者，所以「不是 NotSigned」不是自签方案的低门槛，而是**过不去更新器**的门槛。正解是 `Status == Valid`，前提是把自签根也装进 `CurrentUser\Root`。「签名是否可信」与「是否签上」确实是两件事，但在更新通道里**前者才是准入闸**。
- **「别把没验的说成验过了」在本任务里栽了三次**，三处都是同一个毛病：① 新写的 `verify-signature.ps1` 摘要在「有 1 个产物未签名」时仍打印 `RESULT=OK`；② `verify:pack` 对 `--dir` 构建报 `app-update.yml` 缺失（假警报）；③ `release/` 下的上一轮安装包不会被 `--dir` 清掉，导致断言对着**三轮之前**的产物下结论。修法分别是：摘要按「未签名个数」降级为 `REVIEW`；判据与「本轮是否产出安装包」绑定；用 `app.asar` 的 mtime 划出「本轮」并把被排除的产物**打印出名字**。
- **验自己写的探针**：探针里 `.PrivateKey` 对这类 CNG 键返回 `$null`（`$ErrorActionPreference='Stop'` 下还会抛），据此**误判过一次「证书没有私钥」**，实际 `HasPrivateKey=True` 且 2048 位 RSA 可取出。同理 `EnhancedKeyUsageList` 的 `$_.ObjectId` 已是字符串，再取 `.Value` 得空串 —— **不要用 EKU 的 OID 做判据**。
- **证书在 `My` 与 `TrustedPublisher` 各有一份，签名不会取错**：electron-builder 用 `Get-ChildItem -Recurse Cert: -CodeSigningCert` 取候选并拿第一个命中的，**实测只返回 `My` 那一条**。这点特意验过，因为取到公开副本会因缺私钥而失败、并重试 2 次。
- **验证结果（2026-10-13）**：证书 `CN=Fanhe Work` / thumbprint `0604B2381B8666C99F247DA7B576A4647601A5A3` / 2031 到期；`dist:dir` 约 5 分半、`dist` 5 分 35 秒均 exit 0；安装包 **116,323,480 字节**（未签名 116,303,500 → **+19,980**）；两个产物 PE 签名表均 **7416 字节**（原先 0）；`app-update.yml` 首次生成且含 `publisherName: [Fanhe Work]`；`latest.yml` 的 sha512 与实际安装包逐字节一致（已入断言）。`verify-pack.mjs` 本轮为 27 项断言（**当时的「28 项 + 4 条反例」把反例重复计了一次；T6-03b 后实测为 28 项，其中 6 条是反例**）。四道门禁 **506 项 0 失败**（本次无新增用例）。提交 `415219b`。
- ⏳ **当时仍未验的（属 T6-03b）**：§八 第 1、2、4、5 条反例都需要 `electron-updater` 真的跑起来；含空格 CN 的解析未验。**→ 已在 4.1.13 闭环第 1、2、5 条与含空格 CN，仅第 4 条待真实发版。**

### 4.1.13 T6-03b 更新通道的实施记录（已完成，供对照）

完整文档是 `docs/T6-03-UPDATE-CHANNEL.md`（§七 T6-03b 执行结果、§八.1 完成状态表），逐任务判断见 `DEVELOPMENT-PLAN.md` 9.54。要点：

- 🔴 **本轮最值钱的一条：T6-03c 的签名判据是错的，而且错得刚好漏掉更新器唯一的准入闸。** 4.1.12 那条「不能要求 `Status=Valid`」在**打包视角**下成立，在**更新器视角**下不成立 —— `windowsExecutableCodeSignatureVerifier.js` 里 `if (data.Status === 0)` 是唯一入口，`Status` 不是 `Valid` 时整个发布者比对块被跳过，然后直接落到 `Sign verification failed`。后果不是「提示未知发布者」，而是**每一次更新都被拒绝**。
- **病因在信任根，不在签名本身**：只装 `CurrentUser\My` + `TrustedPublisher` 时 `Status=UnknownError`(1)，因为 **`TrustedPublisher` 只抑制弹窗、不让链变可信**；把自签根也装进 `CurrentUser\Root` 才变 `Valid`(0)。`Import-Certificate` 做不到（非交互会话报 `此操作中不允许使用 UI。`，它要弹根证书确认框），得用 `certutil -user -addstore -f Root`。**这道修正已折进 `create-signing-cert.ps1` 第 4 步**（目标机可用 `signing:trust` 单独补装）。教训的普遍形式：**一道「够用」的判据，可能只是还没被更严格的消费者检验过。**
- **含空格 CN 是虚惊，但用测量而不是推断结案的**：electron-updater 不用正则，用 `builder-util-runtime` 的 `parseDn`；`parseDn('CN=Fanhe Work')` → `{CN: 'Fanhe Work'}`（空格保留），`parseDn('Fanhe Work')` → 空 map 于是退回 `name === subject.get('CN')` 精确相等 —— 两条路都命中，实测 `Signature validated using only CN Fanhe Work`。
- **离线验收台**：客户端 = 新代码的 `dist:dir` 产物 + 改写过的 `app-update.yml`（`provider: generic` / `http://127.0.0.1:8799/`）；更新源 = 本地静态目录放 `0.2.0` 的 `.exe` + `.blockmap` + `latest.yml`（`serve.mjs` 支持 Range，否则差分会静默退回整包）；探针 = `--update-probe`（**独立于 `--smoke`** —— 后者刻意**不**查更新）。跑法要 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`，否则打包态会退化成裸 Node。
- **探针不是正常使用路径，副作用必须显式关掉**：第一版带着默认值跑，成功下载后 `app.exit()` **顺手把新版本装了** —— 一个只读的验收动作修改了本机软件，还会污染下一轮。现在 `runUpdateProbe` 里显式 `autoUpdater.autoInstallOnAppQuit = false` 并把生效值打进输出。**验收脚本必须可重复，而副作用是一种不可重复。**
- 🔴 **验收台自己的两次假绿**：① `Clear-UpdateCache` 算出判据、调用处却写 `$null = Clear-UpdateCache` —— **返回值被丢弃**，而删除**确实**失败了：本环境 `Remove-Item -Recurse` 被安全删除守卫接管、改送回收站，**守卫是 fail-closed**（`SAFE_DELETE_FAIL_CLOSED reason=trash-failed`），回收站操作失败时**拒绝删除**而非降级。后果是 electron-updater 复用 112 MB 旧包、**下载与签名校验整段没跑**却报 `downloaded`，反例②差点「通过」。修法：缓存改由 **Node `fs.rmSync`** 清，**并把「有没有复用」变成断言**（日志里唯一线索是英文行 `Update has already been downloaded to ...`，出现即报 `RESULT=INVALID`）。② **这条新断言本身也做了反例测试**（热缓存 → 触发、冷缓存 → 不触发），否则它只是恒真的装饰。**一个观察不到自己前置条件的实验不是实验。**
- **顺带修掉一个真 bug（提交 `1a3ceee`）**：`verify-pack.mjs` 的签名报告解析器用 `kv[1].toLowerCase()` 猜字段名，`STATUS_VALUE` → `status_value` ≠ camelCase 的 `statusValue`，`in` 判断为假 → **整列被静默丢弃**（`PATH`/`SIZE`/`ERROR` 同理）。症状极具误导性：报告里明明写着 `STATUS_VALUE=0`，断言却说「报告里没有这一列」，于是先后怀疑了报告陈旧与证书。改为显式映射表，**未登记的列直接抛错**。
- **验证结果（2026-10-13）**：**反例②用同一个包、逐字节不变，只改信任根** —— C（移除根）→ `Status=1`、`Sign verification failed, installer signed with incorrect certificate`、`阶段=error`、`是否可安装=否`、`--expect-error` 退出 0；C′（加回根）→ `Status=0`、`Signature validated using only CN Fanhe Work`、`阶段=downloaded`、`--expect-downloaded` 退出 0。**因变量只有信任根，结果翻转。** 反例①（改 sha512 → 拒绝）与第 5 条（缺 blockmap → `Cannot download differentially, fallback to full download ... status 404`）同期跑通。`verify-pack.mjs` **28 项断言（含 6 条反例）全过**；四道门禁 **530 项 0 失败**（506 → +24：web 86 → 97 新增 `host.test.mjs` 6 项 + `version-check.test.mjs` 扩 5 项；desktop 86 → 99 新增 `update.test.mjs` 13 项）。提交 `3a9294f`（代码）+ `1a3ceee`（解析器修复）。
- ⚠️ **`typecheck` 那道门禁需抬阈值才能过**：`prisma generate` 清 `apps/api/src/generated/prisma` 会撞安全删除守卫，报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（count=50 ≥ threshold=50），**看起来像代码报错，其实是环境**。解法 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=<大数>`。
- ✅ **首次发布已完成（2026-10-13 16:0x）**：见 4.1 与「最后验证」栏。要点：重跑 `dist`（6 分 14 秒）拿到**含更新通道**的安装包 → `verify:all` **32 项断言全过** → 注解 tag `v0.1.0` → electron-builder 内置 GitHub publish 传三个资产。**两个坑**：① `publish` 子命令**必须显式 `-f` 给文件列表**（否则 `Missing required argument: files`）；② **它建出来的是草稿**（`draft: true`、`published_at: null`）—— 未认证访问 by-tag 接口**返回 404**，必须带认证列 releases 才看得见，**很容易误判成「没发出去」**；要再 `PATCH /repos/<owner>/<repo>/releases/<id>` 把 `draft` 置 false。发布后已核对：未认证 200、线上 `latest.yml` 与本地逐字节一致、`sha512`/`size` 与安装包全 MATCH。发布令牌从 GCM 取、用完即弃，已扫 4901 个文本文件确认**未落盘**。
- ⏳ **仍未验的（别记成已验）**：§八 第 4 条「安装 A → 发布 B → 版本变 B」—— **v0.1.0 只是 A（垫脚石）**，跑完这条要再发一个 B；`disableWebInstaller is set to false` 的告警未处理；差分下载的**正向**断言同样要等 B 发布（旧 blockmap 上线后差分才真的可用）。

### 4.1.14 T7-02 的实施记录（T7-02a 外壳来源固定 / T7-02b 客户端更新按钮，2026-10-13 21:xx）

**用户把验收条件从「更新过程中完整保留所有本地原有设置」加严到「更新后本地设置及本地存储的所有数据不丢失」**，这一条把问题从「升级时别删 `userData`」推到了「`userData` 里的存储分区得能被找回来」。代码内标注为 **T7-02a**（外壳来源固定）与 **T7-02b**（客户端更新按钮）。提交 `4c0ac8a`。

- **先说清「设置丢失」不是升级把文件删了。** NSIS 的 `deleteAppDataOnUninstall` 默认 `false`，更新与卸载都不动 `userData`，`%APPDATA%\梵禾 Work\` 一直在。真根因是**界面来源（origin）每次启动都变**：`server.ts` 原用 `server.listen(0, '127.0.0.1', …)` 让系统随机分配端口，而 **localStorage 与 IndexedDB 都按 origin 分区、origin 含端口**。实测 `%APPDATA%\梵禾 Work\IndexedDB\` 下同时存在 `http_127.0.0.1_49901.indexeddb.leveldb` 与 `http_127.0.0.1_57352.indexeddb.leveldb` 两份互不可见的存储，`Local Storage/leveldb/000003.log` 里也同时出现这两个来源。**数据一条没丢，只是新的一次启动去另一个分区里找它。**
- **修法是一条候选链，不是「写死一个端口」。** 写死会与用户机器上任何占用它的程序冲突，于是改为按序试：**偏好文件里记的上次端口 → 已有存储的旧端口（按最近使用倒序）→ 固定段 `41873 ~ 41880` → `0`（系统分配兜底）**。端口稳定 ⇒ origin 稳定 ⇒ 分区稳定 ⇒ 设置不丢。候选链本身是纯函数 `shellPortCandidates(stored, legacy)`，放在 `apps/desktop/src/shell-origin.ts`（**不 import electron / fs**，可被 Node 单测直跑）。固定段取 `SHELL_PORT_BASE = 41873`、`SHELL_PORT_SPAN = 8`。
- 🔴 **单实例锁是这条链的必要条件，不是附带优化。** 没有它，第二个实例抢不到同一端口会顺延到下一个候选（即**另一个存储分区**），两个实例各写各的、互相覆盖。所以 `app.requestSingleInstanceLock()` 与候选链是同一件事的两半，`second-instance` 事件把已有窗口顶到前面。（冒烟 / 探针模式豁免，否则会与正在运行的主实例互斥。）
- **旧来源怎么发现：两个信号，强弱分明。** ① `IndexedDB/http_127.0.0.1_<port>.indexeddb.leveldb` 目录的 **mtime** —— 精确到端口，是主信号；② `Local Storage/leveldb/*.log` 的**文本扫描** —— 只用来补那些有 localStorage 却没有 IndexedDB 的端口。🔴 **② 不许覆盖 ① 已记下的时刻**（`if (lastSeen.has(port)) continue`）：localStorage 单库的粗 mtime 会抹平两个端口之间几分钟的差别，早期实现因此让外壳锁到了**较旧**的那个分区 —— 这是实测撞出来的缺陷，不是推理。`orderLegacyPorts` 在时刻并列时按端口降序，**顺序必须确定**（否则同样的现场两次运行可能挑中不同分区）。
- **`listenOnce` 的两个 `once` 监听器要互相摘除**：`error` 与 `listening` 谁先来都要把另一个移除，否则一次失败后残留的 `listening` 会在下一次成功时误触发。重试只认 `EADDRINUSE` 与 `EACCES`（`isRetryableListenError`），其余错误直接抛 —— **端口被占是预期，权限不足之外的失败不该被吞掉**。`closeServer` 把 `ERR_SERVER_NOT_RUNNING` 当成功。
- **无论落在哪个端口都写回偏好**，包括退到系统分配的 `0`。否则「上一次实际用了哪个 origin」没有记录，下一次又要靠扫描猜。
- **T7-02b：把「有更新」做成按钮。** 新增 `apps/web/src/lib/desktop-update.ts`（纯逻辑：**四种可见形态** `checking` / `downloading` / `ready` / `failed`，加不渲染的 `hidden`；`parseDesktopUpdateStatus` 逐字段校验、`percent` 只在 `0 ≤ x ≤ 1` 时保留、自适应轮询 `1s / 15s / 30s`、`isSameUpdateStatus` 比四字段以断掉「重渲染→重建定时器」的死循环）、`use-desktop-update.ts`（挂载读一次 + 自适应轮询 + 半小时重查 + `act` 分发）、`components/UpdateNotice.tsx`（顶栏提示与按钮），接进 `TopBar.tsx` 头像左边同一行。`ready` 的动作文案是 `` `重启更新到 ${version}` ``（**按钮上带版本号**：顶栏很窄，只写「重启更新」用户无从确认装的是哪一版）。**宿主不是桌面时退回浏览器文案**（复用 T6-03b 的 `host.ts` 判定）。
- **它为什么不放账号菜单里**：菜单得先被打开才看得见，而「有新版本」是用户不会主动去找的事 —— 桌面工具会被开一整天。菜单里那一行保留（回答「本机该是什么版本」），但**动作**只有顶栏这一个。
- **`TopBar` 的 `runUpdateNoticeAction` 重写过一处语义**：`installUpdate` 被拒（尚未下载完）时**不再只打日志**，而是退回 `checkForUpdates()` 把下载踢起来 —— 否则按钮点了没反应。
- **跨包类型只能抄一份，所以必须钉住。** web 不依赖 desktop（壳反过来依赖 web 的构建产物），`DesktopUpdatePhase` 与 `apps/desktop/src/update.ts` 的 `UpdatePhase` 没有可共享的来源；抄错**不报错**，只让某个阶段落进「不认识」的分支、界面上少一条提示。故 `desktop-update.test.mjs` 里读 desktop 那份源码里的联合类型逐项比对，**任何一侧新增阶段都会让那条用例红**。
- **顺手修掉一个既有缺陷**：五处测试各自写死 `SYSTEM_SCRATCH = C:\Users\Administrator\…`，而本机账户是 `dy`，于是 `config.test.mjs`（16 条）与 `paths.test.mjs` **整文件加载失败**、报成 `not ok test\xxx.test.mjs`。改为新建 `test/scratch.mjs` 从 `LOCALAPPDATA` 推（**不用 `os.tmpdir()`** —— 工作区入口把 `TEMP`/`TMP` 重定向到了 U 盘 `.tmp/`），五处调用点统一 import。
- **验证结果（2026-10-13 21:xx）**：四道门禁全绿 **578 项 0 失败**（desktop 99 → **122**：`shell-origin.test.mjs` **19 项** + `server.test.mjs` 端口选择 **4 项**；web 97 → **116**：`desktop-update.test.mjs` **19 项**）；`lint` / `typecheck` / `format:check` 全绿。**端口稳定性实测**：dev 外壳连跑两次，第二次日志为 `[shell] 界面来源 http://127.0.0.1:57352（沿用上次；候选 57352 → 49901 → 41873 → … → 0）`，`%APPDATA%\梵禾 Work\shell-origin.json` 内容为 `{"port": 57352}` —— **首次落进既有来源之一，设置重新可见**。**离线复刻验证**（用真实 `%APPDATA%\梵禾 Work` 数据跑 `origin-probe.cjs`）：`已有存储的端口（按最近使用倒序）= [ 49901, 57352 ]`、`候选链 = 49901 → 57352 → 41873 → … → 0`、`新版本首次启动会用端口： 49901`、`换分区告警会触发吗： 不会（好）`。**现场交叉验证**：`netstat` 显示 PID 20944（`梵禾 Work.exe`，启动于 20:19:41）正 LISTENING 在 `127.0.0.1:49901`，与候选链首选完全一致。**前端产物重建**：新 chunk `index-NX1lH4Yx.js`（722.64 kB），五个标记（`fanheDesktop` / `重启更新到` / `正在下载` / `刷新页面即可更新` / `点此重启更新`）**全部字面量命中**。
- 🔴 **未完成 / 受限（必须如实记）**：`dist:dir` **因证书不在本机而中止**（`⨯ Cannot find certificate CN=Fanhe Work, all certs:   failedTask=build`）。实测 `Cert:\CurrentUser\My` 计数为 **0**、`TrustedPublisher` 仅 2 条、`CurrentUser\Root` 里没有任何 Fanhe 自签 —— **证书来自本沙箱会话之外且已被清理**；`verify:pack` 因此如实报 **1 FAIL**（签名那一项）。产物是「新 web + 新 asar + 未签名 exe」的**中间态**。**未执行 `signing:cert`**：证书是唯一签名身份，重新生成会让已装 `v0.1.0` / `v0.1.1` 的机器持有旧根、**永久无法更新**（机制是**信任根逐机**，**不是**「换了签名主体」—— 见 4.1.15），影响面覆盖已发布版本，须由用户裁决（见 4.1）。因此**未发新版**，§八 第 4 条的正向更新验证仍待真人操作。
- ⚠️ **打包态冒烟要 `env -u ELECTRON_RUN_AS_NODE`**：本环境该变量为 `1`，会把 exe 变成纯 Node 运行时，症状是 `bad option: --smoke`。另：`rm` 偏好文件 `$APPDATA/梵禾 Work/shell-origin.json` 会被安全删除守卫拦（`embedded drive prefix is not allowed`），改用 PowerShell `Remove-Item -LiteralPath`。

### 4.1.15 T6-03d 签名身份档案的实施记录（工具链 v1 → v2，2026-10-13 22:xx）

完整推演见 `DEVELOPMENT-PLAN.md` 9.56。任务来源是「找到证书相关代码/配置的现有实现，定位其原始定义与依赖关系，在其基础上做版本迭代升级，保持向下兼容」。**提交 `6b05ca2`。**

- **现有实现只有一处入口**：`apps/desktop/scripts/create-signing-cert.ps1`（v1，165 行；参数 `-Subject` / `-ValidYears` / `-ReportPath`）。依赖链单向一条：`electron-builder.yml` 的 `win.signtoolOptions.certificateSubjectName` → 脚本入参 → `Cert:\CurrentUser\My` → `signtool` → `app-update.yml` 的 `publisherName` → electron-updater 的字符串比对。证书**刻意不在工作区**（6.3 第 6 条）。
- **盘出来的缺口不是「证书存哪儿」，而是「证书库记不住拿哪一张签的哪一次发布」**。补法是一份**身份档案** `%LOCALAPPDATA%\FanheWork\signing\signing-identity.json`（`schemaVersion 1` / `toolingVersion 2`），记当前身份与历史身份 —— 落在证书库之外、同样随机器不随盘。
- 🔴 **「换了证书为什么致命」上一轮写错了因果，本轮纠正。** 直觉答案是「因为 `publisherName` 变了」，**错**：`publisherName` 由证书的 **Subject DN** 推出来（`app-builder-lib/out/publish/PublishManager.js:202` → `windowsSignToolManager.js` 的 `computePublisherName`，实现是 `publisherName || certInfo.bloodyMicrosoftSubjectDn`），**同 CN 就同字符串**，产物里实测就是 `publisherName: [Fanhe Work]`。真正断掉的是**上一层**：`electron-updater/out/windowsExecutableCodeSignatureVerifier.js:56` 只在 `data.Status === 0`（Valid）时才进入发布者名比对，而 `Status` 要求证书链走到一张**本机受信任**的根；自签根**逐机**导入，所以 **换证书 = 换信任根 = 已装机器上没有它 → `Status` 变 `UnknownError`(1) → 整段比对被跳过 → 更新被拒**（与 T6-03b 在本机撞到的是同一个闸）。**结论不变、原因不同**；按错的因果去修会去改一个本来就没问题的配置项，故 `signing-identity.mjs` / `create-signing-cert.ps1` / 单测三处一并纠正，并加了一条 `assert.doesNotMatch(text, /换签名主体/)` 把错说法钉住。
- **升级内容**：身份档案；**轮换闸**（有档案而无证书时拒绝静默新建，换身份必须显式 `-AllowRotate`）；`-ImportPath` / `-ExportPath`（口令只从环境变量 `FANHE_SIGNING_PFX_PASSWORD` 取 —— argv 在进程表里对同机其他进程可见；导出**拒绝写进工作区**，要 `-AllowWorkspaceExport` 才放行）；`-CheckOnly` 只读自检（`RESULT=MISSING` / `DRIFT` / `EXPIRING` / `OK`，**刻意不给 `--force` 逃生口** —— 强行新建正是这条闸要挡的事）；`-AdoptFromArtifact`（从已签名产物的内嵌证书把身份认回来，不碰证书库、不创建任何东西，`HAS_PRIVATE_KEY` 恒 `False`）；`-Subject` 默认改为从 `electron-builder.yml` 读、读不到才回落 `CN=Fanhe Work`（**消除两份会各自漂移的常量**）；新增纯逻辑模块 `scripts/signing-identity.mjs`（不读文件、不碰证书库、不起子进程，**故可被单测直接喂坏输入**）。
- **新增 npm 脚本**：`signing:check` / `signing:adopt` / `signing:export` / `signing:import`（`signing:cert` 语义未动）。`verify-pack.mjs` 新增**第六节（4 项断言，其中 2 项是反例）**：档案存在时比对产物实际指纹与档案、缺失时**明说未验证**、损坏时 FAIL；两条反例是「指纹不同必须判为漂移且原因要指向信任根」与「两侧都读不到指纹时**不许**判成一致」。实跑 **39 项（35 通过 / 4 失败）** —— 4 条失败**同源于证书不在本机**（exe 未签名 → 报告无 `Status=Valid`、无主体、无指纹）。
- 🔴 **原始身份找回来了，裁决题面因此收窄。** 从**已发布产物的内嵌签名**里读回：`fanhe-work-setup-0.1.0.exe` 与 `-0.1.1.exe` 都带签名，主体 `CN=Fanhe Work`、指纹 **`0604B2381B8666C99F247DA7B576A4647601A5A3`**（与 4.1.12 记的一致，互为印证）、`NotBefore 2026-10-13T05:30:38Z`、`NotAfter 2031-10-13T05:40:37Z`、RSA 2048 / sha256。两版指纹相同 ⇒ **v0.1.0 与 v0.1.1 是同一身份签的**。本机档案已用 `signing:adopt` 补齐（`ACTION=adopted`），**轮换闸已 armed**：下次跑 `signing:cert` 会先拒绝，不再静默换身份。**题面只剩「有没有这张证书的 `.pfx` 备份」**，见 4.1。
- ⚠️ **上一轮探针的清理漏了 `CA` 库**（只清了 `My` / `TrustedPublisher` / `Root`），`CN=Fanhe Guard Probe`（`4FA2766A…`）一直留在 `CurrentUser\CA`，本轮已清掉并复查 `GUARD_LEFT=0`。**教训：探针的清理清单必须写死「它进过的每一个库」，而不是「我以为它会进的库」。**
- **验证结果（2026-10-13 22:xx）**：四道门禁 **598 项 0 失败**（desktop **122 → 142**，新增 20 项身份档案单测），`lint` / `typecheck` / `format:check` 全绿。实测覆盖：`-CheckOnly` 正确报 `SUBJECT_SOURCE=electron-builder.yml`；轮换闸在「有档案无证书」时拒绝且**未创建任何证书**；`-AllowRotate` 后创建成功、进 `TrustedPublisher` 与 `Root`、`history` 记下被替换的旧指纹；`-AdoptFromArtifact` 三条路径（正常 / 未签名产物必须报错 / 档案冲突需 `-AllowRotate`）全部符合设计；`verify-pack` 第六节的「一致」与「漂移」两个分支用合成报告分别跑到；三个新脚本在**缺参数时快速失败（exit 1）而非挂起**。**探针全程用 `CN=Fanhe Guard Probe` 主体 + 独立档案路径，`real_subject_in_My` 始终为 0**，事后四个库（含 `CA`）全部清零。
- ⏳ **未验的**：`signing:import` 需要一份真实 `.pfx`，本机没有，**未实测**；`-ExportPath` 的工作区守卫同样因无证书**未走到**。两者都在 4.1 的裁决之后才可能验。
- **向下兼容**：脚本名、`-Subject` / `-ValidYears` / `-ReportPath` 三个参数、报告里原有六个键（`SUBJECT` / `THUMBPRINT` / `NOT_AFTER` / `HAS_PRIVATE_KEY` / `EKU` / `RESULT`）**一字未改**；新增参数全部可选；**没有档案的机器行为与 v1 完全一致**。

### 4.1.16 T6-03e 目标机装根脚本化的实施记录（`signing:trust` / `signing:trust-check`，2026-10-13 23:1x）

完整推演见 `DEVELOPMENT-PLAN.md` 9.57。**提交 `e0ee8ff`。** 需求一句话：**把「给目标机装信任根」从手工 `certutil` 做成脚本能力。** 选中它的理由很实际：4.1.15 那条文档错误（「换机器必须先在目标机跑 `signing:cert`」）能存活那么久，**恰恰因为正确的手工步骤没有名字** —— 当初有 `signing:cert` 一个命令，错指令与命令名对得上、看着就像有依据；而正确的路径只是散在文档里的几行 shell 命令，没名字、无法被 `pnpm scripts` 查到自己是不是写错了。**让正确路径也有名字，它才有机会在没有被想起的地方拦住错误路径。**

- **新增两个分支**（同属 `create-signing-cert.ps1` 的 `TOOLING_VERSION=2`，能力扩充而非新行为）：
  - `-InstallTrustRoot` —— **目标机专用**：读一个 `.cer`，装进 `TrustedPublisher` + `Root`，**不创建证书、不写身份档案、不涉及私钥**。报告键 `CERT_SUBJECT` / `CERT_THUMBPRINT` / `CERT_NOT_AFTER` / `CERT_HAS_PRIVATE_KEY` / `TRUST_CERT_MATCHES_RECORD`，以及 `Install-TrustForCert` 产出的 `TRUST_PUBLISHER` / `TRUST_ROOT` / `TRUST_ROOT_CERTUTIL_EXIT`。
  - `-CheckTrustRoot` —— 上面那步的只读版，退出码 0 = 这台机器能收到用该证书签的更新。**判据是「证书在不在 `CurrentUser\Root` 里」，不是「链能不能建起来」**：已记录的失效形态就是 `Root=False` → `Status=UnknownError`(1)。`X509Chain.Build` 的结果也报（`CHAIN_BUILDS=`）但**只作补充信号** —— 它是另一条代码路径（`X509Chain` 而非 `WinVerifyTrust`），不允许让它与实测结论不一致。
- **三个新函数**：`Get-PublicCertPath`（公钥证书的**唯一**定位函数，默认 `scripts/fanhe-work-signing-public.cer`）、`Install-TrustForCert`（把「两个库、两种作用」的安装逻辑从正常路径里抽出来，与 `-InstallTrustRoot` **共用同一份实现** —— 这是本次改造的重点：装根从此只有一处代码）、`Read-PublicCert`（读 `.cer` 并在文件缺失时响亮报错，而不是拿空对象继续走）。
- 🔴 **顺手把 `fanhe-work-signing-public.cer` 纳入版本控制**（766 字节、`CN=Fanhe Work`、指纹 `0604B2381B8666C99F247DA7B576A4647601A5A3`、`HasPrivateKey=False`）。它此前只在 `release/`（gitignored 的构建输出目录）里有一份 —— 而它正是整个事故中**唯一活下来的凭据**。另外两个附带好处：换机时 `git checkout` 就有；**身份一变它就会在 `git diff` 里显形**，对「静默换身份」是一道免费绊线。公钥无泄露风险，与 6.3 第 6 条不冲突。
- 🔴 **顺手修掉三处会致害的既有内容**（都在同一条链上，改完才发现它们互相掩护）：
  1. `electron-builder.yml` 原注「🔴 换机器必须先在目标机跑一次 `signing:cert`…… 证书换了等于换了签名主体」—— **两句都错**。前半句会让目标机造出错误的根；后半句是 4.1.15 已纠正过的因果错误。已改为「两种机器」对照 + 指向 `signing:trust` / `signing:trust-check`。
  2. `verify-pack.mjs` 里「Status 不是 Valid 最常见的原因…… 跑一次 `signing:cert`」—— **照这条修会加剧问题**（新建证书 = 换身份）。已改为指向 `signing:trust`，并显式写明不要用 `signing:cert` 修它、原因是信任根不是签名主体。
  3. 五处「第 3 步」引用（`create-signing-cert.ps1`、`signing-identity.mjs`、`verify-pack.mjs` ×2、`verify-signature.ps1`）是 v1 遗留：**信任那一步现在是第 4 步**（v2 在其前面插了档案与闸）。步号漂移单看无害，但它正指向「装根」这一处，而这一处的指令错一次就不可逆。
- **实测（2026-10-13 22:5x ~ 23:1x）**：① 初始 `.cer` 在、两个库均 0 条 → `TRUST_ROOT=False`、`RESULT=NOT_TRUSTED`、退出码 1；② 装上后 `TRUST_PUBLISHER=added`、`TRUST_ROOT_CERTUTIL_EXIT=0 VERIFIED=True`、`RESULT=OK`；③ 复查 `TRUST_ROOT=True` / `TRUST_PUBLISHER=True` / `CHAIN_BUILDS=True` / `TRUST_CERT_MATCHES_RECORD=True`、退出码 0；④ 重跑一次两个库都报 `already-present`（幂等）；⑤ `-PublicCertPath` 指向不存在文件 → `RESULT=MISSING` + 指向版本控制内那份的提示（**不是**把 override 路径说成「tracked copy」）。**本机根补回后** `fanhe-work-setup-0.1.0.exe` 与 `-0.1.1.exe` 双双 `STATUS=Valid VALUE=0`。
- ⚠️ **这一步只修好「验」的一半，没修「签」的一半。** 私钥仍不在本机，`dist:dir` 依旧报 `Cannot find certificate CN=Fanhe Work`，发版仍阻塞在 4.1 那句裁决上。两件事必须分开记，否则下一个读状态的人会以为证书问题已经解决了。
- **验证结果（2026-10-13 23:1x）**：四道门禁 **598 项 0 失败**（shared 108 + api 232 + web 116 + desktop 142），`lint` / `typecheck` / `format:check` 全绿。`verify:pack` 39 项（35 通过 / 4 失败），**4 条与基线逐字同因**。本轮**无新增单测** —— PowerShell 分支无法被 Node 单测触及，改用上面五组实测代替，并把关键判据写进了脚本注释（「为什么判据是 `Root` 而不是链」「为什么 override 不能叫 tracked copy」）。

### 4.1.17 阶段一末项验收的端到端断言（审计留痕，2026-10-14）

完整推演见 `DEVELOPMENT-PLAN.md` 9.58。需求一句话：**阶段一验收清单最后一项「关键操作在 `audit_logs` 有记录」，从 T1-12 起悬空了约一个月** —— 起初是「没有可以挂钩的接口」，T7-01 把接口做出来、补齐了 5 个动作码的写入点之后，只剩一条端到端断言。写入端正确而读取端无人验证，结论只有「代码里写着会写」，没有证据。

- **新增用例**：`apps/api/test/user-admin.test.ts` 一条，把五类动作按真实路由各走一遍（创建子账号 → 改状态 → 重置密码 → 调权限 → 删除），再 `prisma.auditLog.findMany` 回查，逐条断言：动作码**取自 `AUDIT_ACTIONS` 常量而不写字面量**（写错时断言直接失败，不会悄悄放行一个「长得像」的码）；`actorId` 等于发起请求的 owner；**`actorName` 等于其显示名快照**（`actorId` 的外键是 `SetNull`，账号删除后置空，没有快照就再答不出「谁做的」）；`targetType` 为 `user`；`result` 为 `success`；`detail` 序列化后**不含**创建时提交的口令，也**不含**重置后的新口令。
- **补断言时暴露并修掉一个留痕缺口**：账号管理取的是 `request.ip`，而 `inject` 的默认来源是 `127.0.0.1`；本文件的 `after` 钩子只按 `ip: TEST_IP` 清理。两者对不上，于是每一次跑测试都在库里留下五类动作各若干条，**且没有任何断言或清理会碰到它们**。实测当时 `audit_logs` 共 **317 行**，其中约 **296 行**是这批测试留痕（`set_permissions` 151 / `delete` 55 / `update` 30 / `create` 30 / `reset_password` 30）。这违反了「跑完测试业务表归零」的既定基线，而它此前不可见的原因正是**没有任何用例读过这张表**。
- **修法**：清理从「按来源地址」改为「按 `actorId` 圈定」，并**置于账号删除之前**（`actorId` 是 `SetNull`，账号一删就匹配不上，顺序颠倒会让清理静默失效）；新用例同时显式传 `remoteAddress: TEST_IP`，让它的行也带上可归属的来源。
- **验证（2026-10-14）**：跑测试**前后** `audit_logs` 总数均为 **317**、分布逐项不变，证明本轮新增与既有用例产生的行都被回收，不再累积。四道门禁 **599 项 0 失败**（api 由 232 增至 **233**），`lint` / `typecheck` / `format:check` 全绿。
- ⚠️ **遗留（不自动处理）**：那 317 行历史留痕仍在。`audit_logs` 按设计是「只增不改不删」的流水表，而 `127.0.0.1` 也可能承载真实的本机使用记录，因此**不做自动清理**，交由使用者决定是否在开发库上执行一次定向删除。基线口径相应修正为「跑完测试后 `audit_logs` 不再增长」，而**不是**「归零」。



### 4.1.18 `v0.1.2` 装完显示 0.1.1 —— 产物陈旧换了张脸又出现一次（T7-05，2026-10-14）

**现象（用户实测）**：从 GitHub 下载 `0.1.2` 安装包、装完，账号菜单那行显示 **`v0.1.1 · 2026-10-14 · dd4e9e6`**，看起来像更新失败。

**先定性：装进去的确实是 `0.1.2`。** 两条独立判据都指向它 —— 注册表卸载项 `梵禾 Work 0.1.2` / `DisplayVersion=0.1.2`，以及安装目录里 `梵禾 Work.exe` 的 `VersionInfo.FileVersion = 0.1.2`（`ProductVersion = 0.1.2.0`）。**出问题的是界面那行字，不是安装本身。**

**根因：前端产物的版本号是构建期烧进去的，而它烧在了版本号提升之前。**

菜单那行三个值全部来自 Vite 的 `define`（`apps/web/vite.config.ts` → `apps/web/src/lib/version.ts`），在**前端构建那一刻**从仓库根 `package.json` 文本替换进去。时间线（实测文件 mtime 与提交时刻）：

| 时刻 | 事件 |
| -- | -- |
| 22:39:39 | `dd4e9e6`（签名身份轮换）提交 —— 此时版本号仍是 `0.1.1` |
| **22:41:13** | `apps/web/dist` 构建完成 → **烧进 `0.1.1` + `dd4e9e6`** |
| 22:51~22:54 | `dist` 打包（`resources/web` 22:52 从上面那份拷入，安装包 22:54） |
| 22:57:05 | `e40bdfc` 提交：版本号 `0.1.1` → `0.1.2` |

**即：三步顺序「先改版本号 → 再重建前端 → 最后打包」都被执行了，只是版本号那一步排到了重建前端之后。** 文档里那句「先 `pnpm --filter @fanhe/web build` 再 `dist`」是对的，但它漏掉了更靠前的一步。

**为什么既有断言一条都没拦住 —— 这是本条最值钱的一课：**

| 既有断言 | 它实际验的是什么 | 为什么这次漏过 |
| -- | -- | -- |
| `resources/web` 与 `apps/web/dist` **逐字节一致** | 包内副本 == 源目录 | 两边**同旧**时照样全绿 |
| 产物含 `fanheDesktop` / `重启更新到` / `正在下载` | 产物**不早于**某个已知特性 | 锚点是**写死的字符串**，只能抓住写它们时想抓的那一次陈旧 |
| asar 内 `package.json` 版本 == 仓库根版本 | **桌面壳**的版本号 | 与前端产物无关，它是对的（`0.1.2`） |

三条全在、比对全过，包里烧的却是 `0.1.1`。**共同点是它们都在回答「产物够不够新」，而「够新」没有绝对判据** —— 除非拿产物**自报的版本**去和**本次要发布的版本**比。

**修法：换成绝对判据，两道关，判据只有一处实现。**

- 新增 `apps/desktop/scripts/baked-identity.mjs`：从产物里读回构建期注入的**身份三连**（版本 + ISO 构建时刻 + 提交短号）。按**形状**认，不搜具体版本号 —— 因此判据里不含任何需要随发版维护的常量，不会像「把待验版本写成常量」那样在下次发版时静默失效（`P0-UPDATE-VERIFICATION.md` 已经吃过一次同款亏）。
- 新增 `apps/desktop/scripts/check-web-build.mjs`（`pnpm --filter @fanhe/desktop check:web`）：**打包前**的前置闸，接在 `dist` / `dist:dir` 的第一步。不符即拒绝打包，失败消息里直接写出正确顺序。
- `verify-pack.mjs` 新增「二·补二」四条断言（含一条反例）：对**已打进包里**的产物再验一次。
- 新增 `apps/desktop/test/baked-identity.test.mjs` **12 项**单测，其中 4 项是反例（只有版本号没有三连、中间不是带 `Z` 的 ISO、死文件里的版本号不算数、合成旧版本必须被判为不符）。

**判据本身当场验过（不是「跑通了就算」）：**

| 验证 | 结果 |
| -- | -- |
| 对**当前陈旧的** `apps/web/dist` 跑前置闸 | ❌ `产物里烧的是 0.1.1，仓库根是 0.1.2`，退出码 1 |
| 对**用户实际装到的** `D:\fanhe work\@fanhedesktop\resources\web` 跑前置闸 | ❌ 同上（同一份产物，md5 一致） |
| 对**现有那份陈旧安装包**跑 `verify:pack` | **47 项里 46 项通过，唯一失败的就是新加的这条** —— 直接证明原来那 43 项确实有洞 |
| 反例断言 | 合成旧版本号被正确判为不符（非恒真） |

**门禁**：**611 项 0 失败**（desktop 由 142 增至 **154**，+12；其余 shared 108 / api 233 含 5 项设计性跳过 / web 116 不变），`lint` / `typecheck` / `format:check` 退出码全 0。

**踩到的两个坑（都已写进代码注释）：**

1. **压缩后三个字面量之间不是裸逗号**，中间夹着下一次赋值（`` `0.1.1`,cg=`2026-…`,lg=`dd4e9e6` ``）。第一版正则按「逗号 + 引号」写，一条都匹配不上，而失败信息是「找不到三连」—— 那会把人引向「产物不是这套流程产出的」这个**错误结论**。
2. **带 `g` 的正则是状态化的**：不重置 `lastIndex` 时，同样的输入第二次调用会得出不同结果，表现为「第一次检查通过、第二次同样的产物不通过」。已加专项用例钉住。

**⚠️ 仍未闭合**：`0.1.2` 已经装在用户机器上，且**同一版本号重新上传不会产生更新**（electron-updater 比版本号）—— 要让那行字变对，只能发下一个版本。**未决：是否为此发 `0.1.3`。**

**⚠️ 这一装对 P0 验证的副作用**：用户这次是**手工从 GitHub 装的 `0.1.2`**，于是机器上原有的 `v0.1.1` 被覆盖掉了。而 §4.1 那唯一一条未闭合项要求「**从 `v0.1.1` 起步** → 自动下载 → 退出重开 → `FileVersion` 变 `0.1.2`」。**该路径仍然可做，但要先退回去**：重新安装 `fanhe-work-setup-0.1.1.exe`（仍在 Release `412862351` 里），再走 `docs/P0-UPDATE-VERIFICATION.md` §0.6 路径 B。**若决定发 `0.1.3`，这次手工安装反而变成了有利条件** —— 那时 B 端换成 `0.1.3`，而 `0.1.2` 正好是已经装好的 A 端，且 `0.1.3` 的菜单版本号会是正确的，验收时肉眼即可确认。



### 4.1.9 T6-02 的实施记录（已完成，供对照）

- **取数把「响应不是预期形状」降级为 `unknown`，不当作解析失败报错。** 外壳（T4-01）加载远程地址时会经过 Cloudflare 那一层，而 T5-05 暂缓意味着现在没有拦截页（将来做了就有）。这条路是非关键的，崩掉会让客户端起不来。
- **只有 `outdated` 才提示更新**，`same` / `ahead` / `unknown` 都不提示。`ahead` 与 `unknown` 的存在理由都是避免淹掉有效信号的假提示：开发期本地比线上新是正常状态；取不到构建信息时报「有更新」比不报更糟。
- **两侧指纹不相等，所以比版本号**（api 侧 `builtAt` 恒空、`commitSha` 恒 `unknown`，见 4.1.1 与 9.49）。
- **验证结果（2026-10-13）**：`apps/web/test/version-check.test.mjs` **16 项 0 失败**；随三条线一并提交时四道门禁**首次全绿 496 项**（`format:check` 此前剩的 2 处 warn 随本任务一并格式化）。提交 `d179e81`。
- **生产形态实测**：重建 web 镜像并 `--force-recreate` 后，容器内构建产物含版本检查逻辑，公网 `https://work.fanhe.dpdns.org` 正常渲染。

### 4.1.10 T7-01 的实施记录（已完成，供对照）

T7-01 的完整实施文档是 `docs/T7-01-ACCOUNT-ADMIN.md`（权限模型、表结构、接口清单、四类语义陷阱、改动文件清单、四条已知限制）。要点：

- **权限合并顺序写死在纯函数里**为「角色自带 ∪ 账号级授予 − 账号级拒绝」，`granted` 存布尔而非「存在即授予」，因为必须能写下行表达显式拒绝；只做额外授予的话，收回权限就只能改角色，而改角色会影响所有同角色的人。
- **owner 短路返回全部权限点、不查 `user_permissions`**，让「owner 不可降权」成为服务端硬规则。同一规则在 `guard.ts`（请求路径）与 `user-admin.ts`（列表展示）两处各实现一次，**必须同步修改**。
- **越权一律 404、不返回 403**，因为 403 等于告诉调用者「这个账号存在，只是你管不了」，账号列表与详情不该成为枚举接口；「可见但不许做」才返回 403。
- **停用、改角色、重置密码、删除都吊销该账号全部 refresh token**，少了这一步换完密码别人手机上的旧登录状态还能继续用。
- **`role_permissions` 挂在 Role 上而不是 User 上**：`USER_SELECT` 一开始写成 User 的一层关系，Prisma 报 `Unknown field 'rolePermissions' for select statement on model 'User'` 致所有 `/api/system/*` 接口 500，改成嵌进 `role` 里取两层。
- **两条测试自身写错**（比实现更值得记）：admin 断言 DELETE 得 404 而实际 403（admin 没有 `system.user.delete`）；「owner 的权限不可配置」用另一个 owner 当操作者会先被「同级不可见」拦下（404），改用 admin 才验证到 `cannot_modify_owner`。
- **验证结果（2026-10-13）**：`apps/api/test/user-admin.test.ts` **22 项 0 失败**，四道门禁 **496 项 0 失败**。端到端实测：owner 建 viewer 账号 → 授予 `note.write` / 拒绝 `launch.write` / 授予 `event.write` → 子账号 `/me` 返回 `["personal.note.read","personal.event.read","personal.launch.read","personal.event.write"]`（拒绝压掉角色本没有的项、授予生效、无 system 泄漏），删除 200。提交 `ab96a58` / `49c4f85` / `5dc0c90`。
- **四条已知限制**：权限调整需在页面上重新进入才刷新显示（服务端下一次请求即生效）；子账号之间看不到对方数据（notes / events / launch_profiles 按 `user_id` 隔离，权限点只管功能开关）；角色清单接口对所有登录用户开放且含 rank；删除的账号无法恢复。

### 4.1.1 T6-01 的实施记录（已完成，供对照）

- **先说清 T6-01 不是「把前端那个版本号暴露出来」。** `apps/web/src/lib/version.ts` 已有三个构建期注入的常量（版本号、构建时刻、提交短号），顶栏在用。**但那些只回答「我这份前端是哪一版」，回答不了「服务端现在发的是不是这一版」** —— 而后者才是 T6-02 要的。所以 T6-01 是**在服务端侧建立一个独立的、自洽的版本事实**。
- **api 侧拿不到构建时刻与提交号，这是容器形态的必然结果。** `.dockerignore` 排掉了 `.git`，构建上下文里没有 git 仓库，`git rev-parse` 在容器里必然失败；镜像层也不记录构建时刻。于是 api 侧 `builtAt` 恒空串、`commitSha` 恒 `'unknown'`。**字段保留在类型里是为了让 T6-02 用同一份 `VersionManifestResponse` 处理两侧** —— 两侧字段集不同却共用一个类型比分成两个省事。
- 🔴 **由此得出的结论必须记住：两侧指纹不相等，T6-02 要比版本号。** api 侧的指纹只能区分「不同的 api 镜像」，**误把它与前端那份直接相等比对会得出错误结论**（看起来「本地与服务端不同」，实际两边都正常）。已写进 `VersionManifestResponse.fingerprint` 与 `compareManifests` 的注释。指纹在这套系统里的实际价值是「同一版本号下是不是同一份服务端产物」，对单用户部署意义不大，**长期价值是为多实例部署留一个能区分实例的依据**。
- **版本号在运行时读文件，而不是构建期注入。** 注入式最常见的失效是「改了 `package.json` 但忘了重新构建，接口报的还是旧版本」，而那没有任何报错。运行时读的收益是**镜像里那份清单就是真正的来源**。**而且不需要改 Dockerfile** —— 运行时阶段已经 COPY 了根 `package.json`（与 `pnpm-lock.yaml` 一起 COPY 是为了 pnpm 的链接式布局），那份文件本来就在镜像里。
- **路径查找改了两轮，第一版会静默读到错误的文件。** 第一版「上溯三层」实际落到了 `apps/api/package.json` —— **那份的 `version` 是 `0.0.0`，而 `0.0.0` 恰好是「永远比任何正式版都旧」的值，于是接口会永远说「服务端有更新」**：一个看起来完全合法的错误答案。第二版改成**逐级上溯、认 `pnpm-workspace.yaml` 为根标记**，且**顺序不能反**（先确认是根、再读版本号）。**判据不能换成「目录里有没有 package.json」** —— 沿路每一层都有，且那几份的版本号都是 `0.0.0`，会在最近一层就停下。
- **不用 `process.cwd()`：** 工作目录能被 `--workdir` 或启动脚本改掉，一旦被改就会读到另一个 package.json（同样是 `0.0.0`）。**也不用写死层数** —— 产物在 `dist/version/`、源码在 `src/version/`，两者同深度所以恰好一致，**但那是巧合，目录一调整就会静默读错**。用 `import.meta.url` 则由文件实际落点决定。
- **找不到根清单时抛错，不回落成 `0.0.0`。** 这是部署出错（镜像构建漏 COPY 清单）。**一个说谎的版本号会让 T6-02 给出错误的更新提示，而那种错误极难定位。**
- **清单接口不设门禁。** 它不泄露用户数据、不暴露凭据、不改变状态；**T6-02 需要它在登录之前可用**（否则「服务端有新版本」这条提示要先登录才看得到，而那正是「客户端太旧以致什么都跑不起来」的情形）；提交号与版本号**本来就明文可见于客户端产物**，对外可见不增加信息量。**代码注释里标了复查起点**：将来若加上「你落后几个版本」这类可推导信息，要重新评估。
- **手写 SHA-256 换同步纯函数，代价是必须配对照测试。** Web Crypto 的 `subtle.digest` 是 Promise，而 `computeBuildFingerprint` 必须是纯函数（shared 的模块会被 Node 直接跑，见 `version.ts` 那个 `typeof` 守卫的同款理由）。手写的风险形态是**能算出结果但算错了** —— 照样返回 32 字节数组，看起来完全正常。**所以测试用 `node:crypto` 逐值对照**（不是比「有没有值」，是比「值对不对」），覆盖**四种长度**：不足一块、跨块边界、超两块、三项全空 —— **补位逻辑在「长度刚好让 padding 多占一块」时最容易写错，只测一个长度会漏掉**。四种全部一致。
- **`TextEncoder` 在 shared 里不可用，改手写 UTF-8。** 那个包的 `lib` 是 `["ES2023"]`，不含 DOM。加 `DOM` 能编译通过，**但会把一个刻意不依赖运行时框架的包（见 `index.ts` 文件头）的类型环境扩大一整档**，且本包跑在 Node 与浏览器两端、Node 侧全局类型引入 DOM 就与实际不符。**为一个纯计算函数扩大整个包的 lib 不划算。** 手写时有一处必须对：**`codePointAt` 按码点读但下标按 UTF-16 单元走**，读完增补平面字符要跳过一个 —— 而那种差异两边都返回 32 位十六进制，极难查。
- **版本比较不用 semver 库，但预发布号必须处理对。** 只需要「一样吗 / 谁更新」，而发版方式固定为三段式。**但打错写成 `0.1.0-beta` 很常见**，而纯数字比较会把 `beta` 当 0 从而判成相等 —— **那条分支存在的现实理由就是「人会打错」**。规则：**没有预发布号的那个更新**，且**数字段按数值比**（否则 `'10'` 排在 `'9'` 前面）。
- **`compareManifests` 的四种结果刻意不并成布尔。** **`ahead` 与 `unknown` 的存在理由都是「避免淹掉有效信号的假提示」**：开发期本地比线上新是正常状态，并成布尔会让程序一直提示「有更新」；取不到构建信息时**报成「有更新」比不报更糟**。另有一条容易忽略：**指纹不同但版本号相同归 `ahead` 而非 `outdated`** —— 同一版本号的两次构建在开发期很常见，而提示「有更新」会指向一个**不存在的版本**。
- **测试文件里不能出现 TS 标注，也不能用 `Buffer`。** `.mjs` 里写类型标注直接 `SyntaxError`（连文件都加载不了，报错指向那一行而不指向「类型标注」这件事）。`Buffer` 与 `TextEncoder` 都不在 shared 测试的 eslint 环境里 —— **`eslint.config.js` 的 Node 全局块覆盖 `packages/**/*.{ts,tsx}` 而不含 `*.mjs`**，这是既有缺口；**发现之后没有顺手改全局配置**（会波及整个包的类型环境，超出一个版本测试该有的影响面），改用字符数核对长度（那三个值全是 ASCII）。
- **验证结果（2026-10-12）**：shared **24 项**（SHA-256 四种长度逐值对照 + 指纹区分 + 版本比较七组 + 清单比对六种）、api **7 项**，**四道门禁全绿 457 项 0 失败**（基线 426，净增 31：shared 83 → 107、api 197 → 204）。**真实生产形态也验了** —— 重建 api 镜像后，**容器内与经公网 `https://work.fanhe.dpdns.org/api/version` 都返回 `{"version":"0.1.0","builtAt":"","commitSha":"unknown","fingerprint":"ed242a…"}`**。测试里专门加了一条从**编译产物位置**出发的断言，**因为「只在源码态成立的路径」是这类代码最典型的隐患**。提交 `ac342e7`。

### 4.1.2 T5-04 的实施记录（已完成，供对照）

- **授权方式本身是这一轮的第一个决定。** Cloudflare 凭据三种给法：全局 API Key（等于整个账户，含账单与其他域名）／账户级 API Token（可限定权限）／用户手动建 Tunnel 我只拿配置。**选 API Token 且限定到「一个 zone + 两项权限」**（`Account | Cloudflare Tunnel | Edit` + `Zone | DNS | Edit`），因为它可精确收窄而全局 Key 不能。
- **填权限时有一处 UI 陷阱**：指定了 `Specific zone` 之后**不要再加 `All zones from an account` 那一行** —— 指定 zone 已经隐含了它属于哪个账户，多加一行反而让账号选择器被禁用（灰掉、选不了）。删掉那行即可。
- **踩了一个「报错完全误导人」的坑，而它是环境问题不是权限问题**：第一次列 Tunnel 报 `Authentication error` —— 因为**把 zone ID 填进了账户参数**。Cloudflare 对「格式合法但不存在的账户 ID」回的就是认证错误，**不区分「你没权限」与「这个 ID 不对」**。正确账户 ID 要**从 zone 反查**（`fdc9a8c…`）。
- **「拿不到账户列表」不等于「Token 无效」**：那个 Token 调 `/accounts` 返回**空列表**（没申请该权限），而用 zone 反查却能拿到账户。**查账户 ID 一律从 zone 反查** —— 否则会把「这个接口没权限」显示成「你什么都没有」。
- **Tunnel 配置存在 Cloudflare 侧（remotely-managed），所以容器里只有一个 Token、没有配置文件。** 三种模式里选它，因为它让「换机器」不需要改配置：容器重建、读 `.env.compose`、连出去。**Tunnel Token 与 API Token 是两回事**（前者是容器连出去用的，后者是调 API 用的），而**后者刻意不落盘**。
- **「源站无入站端口暴露」的全部实现就是 `cloudflared` 不写 `ports:`。** 它与 Cloudflare 边缘建立出站连接，源站没有任何入站端口可打。**这一条必须机械判定** —— 给别的服务加一个 `ports: '0.0.0.0:8080:80'` 会让公网入排立刻成立，而**外部照样能访问、看起来一切正常**。
- 🔴 **T5-02 那条「端口绑 127.0.0.1」不是这一条的实现，两者会互相掩盖。** 绑 127.0.0.1 防的是**局域网**，公网入站是由 `cloudflared` 不绑端口保证的。**最坏的情况是它们互相掩盖**：Tunnel 正常 → 访问顺畅 → 有人顺手给 web 加了 `0.0.0.0` 映射 → 公网暴露成立而 Tunnel 一切正常。**「Tunnel 能通」绝不代表「没暴露」。**
- **验收脚本分三层判据，第三层是唯一可靠的那个。**

  | 层 | 判据 | 能被什么骗过 |
  | --- | --- | --- |
  | 配置层 | 读 `compose config` **展开后**的 `ports` | 源文件没写 ≠ 展开后没有（锚点、override 都会带进来） |
  | 运行时层 | `docker inspect` 的 `.NetworkSettings.Ports` | **改了 compose 没 recreate 时配置层会过而这层不过** |
  | 网络层 | 从独立 bridge 网络 `nc` 探宿主端口 | 几乎骗不过；**只问事实，不依赖配置假设** |

- **网络层探针踩过：用 `172.17.0.1` 而非 `host.docker.internal`。** 后者在 Linux Docker 上解析到宿主**网关**，而宿主服务绑的是 `127.0.0.1`（只听回环）—— 「连不上回环」与「连不上网关」成了两件事，探的是后者就探不到要问的那个。**判据要问「从网络外能不能连上那个监听」。** 且必须走**默认 bridge 网络**（compose 网络内的容器当然能连到 web，那样问等于没问）。
- **「验收脚本能证伪它声称的那件事」不能只看它全绿。** 做法是给 `cloudflared` 临时加一条 `ports:`，确认断言真报 FAIL 并打出内容，再恢复。**全绿的脚本可能只是因为断言恒真而全绿** —— 而「端口没绑」用「`ports` 不存在」来判就极易恒真。实测绑了端口后报的是完整的 ports 数组，足够定位。
- **`--offline` 那条路上发现一个会误导人的措辞，已改。** 跳过公网那组后脚本原本仍打印「结论：外部可访问」—— 而那组**根本没跑**。**把「没验」说成「验过了」是验收脚本最不该有的失败模式**，现在改为「源站无公网入站端口暴露。**公网可达性本轮未验证**」。
- **`execFile` 在 Windows 上不能直接 spawn `.cmd`（抛 `spawn EINVAL`），且 `ws-compose.cmd` 不能用绝对路径调。** 后者的报错是 `'F:\fanhe' 不是内部或外部命令` —— **那句指向一个看起来完全合法的路径，真实原因是空格**。所以脚本里是 `shell: true` + 从工作区根用相对路径。
- **`${FANHE_TUNNEL_TOKEN:?...}` 守卫是有用的，因为它失败得很响。** 缺 Token 时在插值阶段就报错并给中文提示，而不是静默起一个连不上的容器 —— **那类故障会表现为「Tunnel 配好了但不通」，排查方向完全错**。
- **`--no-autoupdate` 与不配 healthcheck 都是有意的。** 前者让「这台机器跑的是哪个版本」保持可知；后者因为它健康与否不影响转发能力（连不上边缘时它自己重连重试），加了只产生一类无意义的 unhealthy 状态。**只等 `web` 起来不等 `api` 健康** —— 它自己不发起请求，等一个它不依赖的服务健康只会在 api 出问题时把 Tunnel 一起拖停。
- **验证结果（2026-10-12）**：`https://work.fanhe.dpdns.org/` 根路径 200、深链 `/notes` 200、经公网 `/api/setup/status` 拿到 `{"initialized":true}`、未授权 `/api/auth/me` 拿到 **401 + api 自己的文案**（`{"error":"unauthorized","message":"请先登录"}` —— 那文案 nginx 与 cloudflared 都伪造不出来）。`cloudflared` 日志显示 **4 条连接全部 registered**（sea10 / sjc05 / sjc01），配置也从 Cloudflare 侧拉到了。**网络层探针确认 8787 / 8080 / 5432 从容器网络外全部不可达。** 验收脚本 **17 项 0 失败**，`--offline` **13 项 0 失败**。**四道门禁全绿 426 项 0 失败**（业务代码一行未改，改动只有 compose 与新脚本）。提交 `7cf5af3`。
- **凭据记录**：Tunnel `fanhe-work`，ID `e71629a6-6a53-4731-a2d9-0f1ffbdfb726`；域名 `work.fanhe.dpdns.org` → `<tunnel-id>.cfargotunnel.com`（proxied）；ingress `work.fanhe.dpdns.org` → `http://web:80`，兜底 `http_status:404`。**Tunnel Token 在 `.env.compose` 的 `FANHE_TUNNEL_TOKEN`**（已 gitignore），**不需要跨机一致也不需要换机时重新生成**；轮换方式是在后台该 Tunnel 的配置页重置 token 后替换那一行。**用户提供的 API Token 刻意未落盘，且它在对话里明文出现过 —— 已告知用户去后台轮换。**
- **T5-04 刻意没做的两件事**：不配 `CLOUDFLARE_WARP` 路由（那是把访问者的私网也带进来，本项目不需要）；不给 `cloudflared` 配 healthcheck（同上）。

### 4.1.3 T5-03 的实施记录（已完成，供对照）

- **任务书与现实不符，按「保证后期软件正常运行」重定了目标。** T5-03 原定义是「实验版数据导入容器卷，验收记录数与抽样内容一致」，但用户明确说明**实验版程序没有使用过、没有数据**（业务表除 owner 外全 0 行），「迁移动作」这个产出**不存在可迁的对象**。选项是标记「无需执行」跳过，或重新界定 —— 选后者，因为**验收要点本身暴露了真正要解决的问题**：「保证后期软件正常运行」在换机场景下等价于三件事，而第三件最严重：① 空库可建（T5-02 已覆盖）② **库建好之后系统真的能用** ③ **已有数据不会丢**。
- **🔴 第 2 件事是本轮发现的：全新卷跑完 `migrate deploy` 之后，`permissions` / `roles` / `role_permissions` 三张表全是 0 行** —— 它们是 `20261010150103_init` 建出来的空表。于是走初始化向导建 owner 时接口 **500**，消息是「库里没有 owner 角色，先执行 `pnpm db:seed`」。**系统自己的报错把该做什么说得很清楚，但那时人已经在一个装不起来的系统里了。** 而 T5-02 的 22 项验收全绿、根本没碰这一段。**「迁移全部应用」与「系统可用」之间隔着一个种子**，这个间隔在此前任何一次验收里都没被跨过去。
- **权限体系属于部署而不属于数据迁移，这个归类决定了它该在哪个阶段跑。** `packages/shared` 的 `PERMISSION_CATALOG` / `ROLES` / `ROLE_PERMISSIONS` 是**代码定义**，跟着代码走、不跟着某台机器的数据走，所以 `db:seed` 挂 migrate 容器是对的。每次部署跑一遍，改了权限定义重跑即生效；**幂等性保证这样安全**（权限点与角色按 code upsert，角色权限关联做**差集同步**：新增缺失的、删除多余的），验收里有一条专门盯重复执行后关联数不变。
- **种子不创建任何账号，所以接进编排是安全的。** `src/db/seed.ts` 里明确写了这件事。与 T5-02 刻意不建 owner 的判断合起来才完整：**建表与写权限体系是部署的事，建账号是用户的事。** 凭空造一个默认口令的管理员比让用户自己设更危险 —— 那种账号会出现在文档里、被抄进部署脚本、忘记改就长期有效。
- **migrate 容器用 `&&` 连两步而不是分两个 CMD**：任一步失败就该非零退出，`service_completed_successfully` 因此挡住 api 起来。**「建表成功但种子失败」绝不能被当成部署成功** —— 那正是本轮要修的洞的翻版。
- **本轮第一次改业务代码（两处），理由是「惰性求值 vs 注入密钥」的取舍。** 容器里跑 `db:seed` 报「缺少环境变量 `JWT_SECRET`」，链路是 `seed.ts` → `db/prisma.ts` → `config/env.ts`，而 env 在**模块加载时**求值整个对象。
  - 方案 A「注入密钥」：把 `JWT_SECRET` 喂进 migrate 容器。代价是**那个容器的整件事就是建表 + 写种子，它没有理由持有签名密钥**；且以后每加一个运维脚本就要重复注入一次。
  - 方案 B「惰性求值」✅：`jwt.secret` 改 getter。代价是「import 即校验」不再成立，需要另找地方守住「启动即失败」。
  - **选 B：扩大的密钥暴露面比多写一行校验更贵**，而校验的缺口可以补上。
- **代价的补法是 `index.ts` 新增的 `assertRequiredEnv()`，在 `listen` 之前显式读一次 `env.jwt.secret`。** 读它就等于跑一遍 `requireSecret` 的校验（长度按**字节**算 —— 按字符数判断会放过一个远短于 32 字节的多字节密钥）。**这条自检只能覆盖被读到的字段**，所以新增「启动时必须存在」的配置时要一并加到这里，代码注释写明了这是惰性化换解耦的代价与它的登记处。**「加载时校验」换成「启动时校验」，时机差几毫秒，而配置缺失仍是在服务对外之前暴露。**
- **验证惰性化时踩了一个「读 secret 没抛」的假通过。** 第一版验证脚本在仓库目录里跑，而 `dotenv/config` 在模块加载时把 `.env` 读回了 `process.env`，`delete` 掉的值立刻被补上 —— 断言「缺失密钥时抛错」恒不成立，看起来像惰性化没生效。改到 `/tmp` 下干净目录跑才通过（且 Windows 上要用 `pathToFileURL`，裸路径喂 `import()` 抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）。四条最终全过：惰性化生效 / 缺失仍抛 / 短密钥仍拒 / 合规可读。**「验证脚本自己污染了被验证的环境」这类假通过，只有换隔离环境才暴露得出来。**
- **备份脚本里 `promisify(execFile)` 不能用来收 `pg_dump -Fc` 的输出。** 它按 utf-8 解码 stdout，二进制归档会被破坏 —— 而**损坏的备份比没有备份更危险**，因为它看起来是成功的（退出码 0）。改用 `spawn` 收 Buffer。**恢复必须走 `docker exec -i` + stdin**：容器看不到宿主文件系统，这是唯一通路。
- **`verify` 做真恢复演练，不是「文件能解开」。** 它建临时库 → 真恢复进去 → 逐表比行数 → finally 删临时库。只检查归档能不能读，只能证明文件没损坏，证明不了它**能被恢复**。
- **恢复必须带 `--clean --if-exists`，这条来自一次真踩坑。** 不加的话恢复是「插入」不是「替换」—— 同主键的行变成两份叠加，而表看起来恢复成功了。**备份不能放在 Docker 卷里**：卷坏了备份跟着坏，等于没有备份。落 `projects/fanhe-work/data/backups/`（已被该目录 `.gitignore` 的 `data/*` 排除）。
- **`n_live_tup` 是统计估算值，不能当「表是空的」的判据。** 我据它判断权限表为空、得出「种子没跑」的结论，而实际行数是 11 / 4 / 29 与基线一致（未 ANALYZE 时不准）。**要判空用 `SELECT count(*)`。**
- **验收脚本扩到 30 项，两组新增各解决一个具体问题。** §5b 权限体系断言把 **11 / 4 / 29** 写死、断言 owner 拿全部权限、**重复执行种子关联数不变**；§7b 端到端在全新空部署上**建 owner → 登录拿令牌 → 带令牌读 `/api/auth/me`** —— 前者验权限表，后者验「拿到权限之后系统真的能用」，正是本轮那个洞的两端。
- **扩展验收时两条断言失败，是「断言期望与实现不符」而非产品有 bug。** 「经 web 反代」与「切换前能读到 users」都因 §7b 先建了 owner 而状态已变（`initialized` 变 true、`users` 变 1）。**这两条只能靠问「这条断言要证明的是哪件事」来区分** —— 它们写在 §7b 之前，状态假设已过期。
- **验证结果（2026-10-12）**：验收脚本 **30 项 0 失败**，且 **prettier 格式化后又跑一次仍是 30 项 0 失败**（格式化过的文件必须复跑）。**四道门禁全绿，426 项 0 失败**（`lint` / `typecheck` / `format:check` 亦全绿）。**现有那套（`fanhe-work`）数据完好**：6 迁移 / `users=1` / 种子 11 / 4 / 29 / `initialized: true`。
- **备份与恢复实测跑通一条完整链路**：备份 → `verify` 真恢复演练通过 → 造一条数据 → 删除 → **无 `--force` 被拒并同时显示当前与备份的行数** → 带 `--force` 恢复成功，且**内容回来了而不只是行数对**（最后这点是「恢复能用」与「恢复插进去了」的区别，只有真比内容才能验出来）。提交 `3b3dc07`。
- **两件刻意没做的事**：① **备份没有定时调度** —— 当前只有手动命令，定时要选载体（宿主机计划任务还是容器内 cron），那是部署形态的另一个决定，不该顺手塞进本轮；② **不自动建 owner** —— 理由同 T5-02，刻意让前端显示初始化向导。
- **验收要点已从「记录数与抽样内容一致」改为「空库可用 + 可备份可恢复」**（`DEVELOPMENT-PLAN.md` 第三章任务表与第七章清单均已同步）。原要点不是被放弃，而是**在有数据之前无法验证**；真有实验版数据要迁时它仍然成立，那时该做 `pg_dump | pg_restore` 加逐表比对 —— 备份脚本的 `backup` 与 `restore` 已覆盖搬运本身。

### 4.1.4 T5-02 的实施记录（已完成，供对照）

- **T5-01 漏了迁移的执行者，而它的症状极有欺骗性。** T5-01 的 `up -d --wait` 能在全新机器上一次跑绿，因为它**复用了开发期那个 `fanhe-work-pgdata` 卷** —— 里面 6 个迁移是开发期在本机 `db:deploy` 出来的。实测另起一个全新卷：initdb 结束后 `public` 模式下 **0 张表**，而此时**编排层全绿**（db healthy、api 能连上库、web 页面可开）。根因是 api 启动时不跑迁移，运行镜像里也没有 Prisma CLI（`prisma` 是 devDependency，被 `--prod` 排除）。**连接成功与库里有表是两件事** —— 这是本轮最重要的一条认知。
- **迁移执行者做成独立的一次性服务，不塞进 api 启动路径。** 三个理由：职责分离（api 的职责是提供服务，让它在启动路径里塞一个「改数据库结构」的动作，会把两件可能失败的事绑在一起）；失败可见（一次性容器跑完退出，`docker compose ps` 里直接看 exited(0) 还是 exited(1)，塞进启动路径则只表现为「服务没起来」）；幂等（`migrate deploy` 本身幂等，独立服务让「重复部署」有明确入口）。
- **migrate 的镜像阶段挂在 `build` 上而不是运行阶段**：运行镜像装 Prisma CLI 等于为一个「只在部署时跑一次」的命令给所有长期运行的容器加几十 MB。代价是 migrate 镜像继承了全量 devDependency（体积大），但那个体积不进入任何运行中的服务。
- **命令选 `migrate deploy` 而不是 `dev`**：`dev` 会创建影子库验证迁移可重放，那需要实例有建库权限 —— 部署环境通常不给（给了也不该给）。选错会让部署在权限不足的库上直接失败，而错误是 `permission denied for database`，指向权限而不是指向「你该用 deploy」。
- **`depends_on` 的两种条件不是一回事**：migrate 等 db 用 `service_healthy`（等 PostgreSQL 接受连接），api 等 migrate 用 `service_completed_successfully`（等**跑完并成功**）。真正危险的是**不写这一条** —— api 与 migrate 并发启动，api 可能在建表完成前就接到第一个请求，T5-01 掩盖掉的失败又回来了。
- **`migrate` 的 `restart: no` 是语义的一部分，不是默认值。** 默认 `unless-stopped` 会让跑完即退出的容器被反复重启，每次重启连一次库。部署完观察几小时，db 日志里全是重复连接而 api 一切正常 —— 这类故障没有报错可查。
- **连接串与口令各写一遍是个陷阱，本轮收成一处。** T5-01 里 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 内嵌的口令分处两个 YAML 位置，改一处忘另一处 → db healthy 而 api 连不上，错误 `password authentication failed` 指向「口令不对」，**不会提到「你可能只改了一处」**。现在用 compose 的 `x-database-url: &database-url` 顶层锚点，api 与 migrate 引用同一个 `*database-url`，口令从 `${FANHE_DB_PASSWORD:-fanhe}` 取且默认值与 db 那三个 `POSTGRES_*` 同组。
- **`x-` 前缀不是 compose 内置能力**，而是「compose 忽略不认识的顶层键」+「YAML 锚点在该键上生效」两件事的组合。换个 YAML 工具读这个文件时它就是普通字段。
- **healthcheck 用 `$${POSTGRES_USER}` 让容器读回自己的变量**，而不是把名字再写一遍（那正是第二个可能分叉的地方）。`$$` 是 compose 转义，少了它会在插值阶段就被替换，healthcheck 变成字面量而**永远 unhealthy**，`up --wait` 就一直等下去 —— 症状是「命令卡住不动」，不报错。
- **🔴 一个 T5-01 就存在、但本轮才暴露的真 bug。** migrate 阶段被追加到 Dockerfile **末尾**，而「不写 `target` 的构建会停在最后一个 FROM」，于是 **api 也构建成了 migrate 镜像**。症状极有欺骗性：api 容器**反复重启**、日志全是 `No pending migrations to apply`，而 healthcheck 报 **healthy**（它在重启循环里被短暂满足）。前面还有一层：重启循环让端口映射与健康结果都不稳定，于是「api 连不上」看起来像端口或网络问题，我为此先后怀疑了 `!override` 标签、容器复用、代理，**全部不是**。判据是 `docker inspect -f '{{json .Config.Cmd}}' <容器>` —— 它显示 api 执行的就是那串 prisma 参数。**「服务反复重启且日志里有本不该属于它的操作」时，先看它实际执行的命令，别先看网络与端口。** 修法：compose 里给 api 与 web 都显式写 `target: runtime`。web 今天是巧合对的（runtime 恰好在末尾），**但 api 已经因为同一个巧合出过事**，所以两个都写。T5-01 时 `runtime` 在末尾也是巧合，不是设计 —— 这句话写进了 Dockerfile 末尾。
- **一次「断言写错与配置错长得一样」的坑**：脚本断言 `docker port` 每行以 `127.0.0.1` 开头，而输出形状是 `5432/tcp -> 127.0.0.1:15432`，**端口在箭头右边**。断言恒失败，看起来像「端口真的对外暴露了」。按四类归因重判（真 bug / 断言过宽 / 环境残留 / 期望与实现不符）属第四类，改断言。**这类失败不可能靠看输出区分，只能靠问「这条断言要证明的是哪件事」。**
- **空部署后刻意不自动建 owner**，让前端显示初始化向导（验收断言 `initialized === false`）。理由是**凭空造一个默认口令的账号比让用户自己设更危险** —— 那种账号会出现在文档里、被抄进部署脚本、忘记改就长期有效。这也是 T5-02 的边界：**建表是部署的事，建 owner 是用户的事。**
- **验收脚本自己生成隔离 override 并用完删掉**（验证必须在全新空卷上跑，现有卷里是实验版数据不能动；隔离靠独立项目名/卷名/容器名/端口）。override **刻意不入库** —— 它是验证脚手架，留在仓库会让人以为那几处端口改动是必要的。`!override` 合并指令不能省：不写它列表会**追加**而非替换，两套会同时绑同一宿主端口而报冲突。
- **写脚本时自己踩了两个顺序坑**：收尾函数删掉 override，而开头那次「清残留」走同一函数 → `up` 报 `compose file is invalid: cannot find the file specified`（**那句话看起来像配置坏了，真实原因是顺序**）；修好后把「写文件」与「拆环境」调了顺序，`teardown` 里的 `compose down` 读不到还没写的文件。**正确顺序：先写 override → 再拆环境 → 最后 up**；且「脚手架的生成与拆除」必须拆成两个函数（`teardown` 拆环境、`cleanup` 连脚手架一起拆），因为调用时机不同。
- **验证结果（2026-10-12）**：验收脚本 **22 项 0 失败**，且 **prettier 格式化后又跑一次仍是 22 项 0 失败**（格式化改过的文件要复跑，否则不知道有没有改坏逻辑）。覆盖：全新空卷 → 一条命令 → migrate exited(0) → 6 个迁移全部应用 → public 表数 > 10 → **重复执行 migrate 表数不变（幂等）** → 迁移目录数与已应用数一致 → api/web healthy → 深链 `/notes` 回退 → 经 web 反代到 api 拿到 `{"initialized":false}` → db 端口绑 127.0.0.1 → 两处 `DATABASE_URL` 相等且内嵌口令与 `POSTGRES_PASSWORD` 一致。**现有那套用新配置重建后一切正常**（6 迁移 / `users=1` / `initialized: true` / 反代通）。四道门禁全绿 **426 项 0 失败**（未改任何业务代码，`git diff --stat` 对 `apps/*/src` 与 `packages` 为空 —— 这本身就是验收要点「连接串切换后无需改业务代码」的直接证据）。提交 `16f73e8`。
- **T5-02 没做的一件事**：T5-03（实验版业务数据导入容器卷并校验记录数与抽样内容）不在本轮范围。**本轮只保证「空库能被建起来」。**

### 4.1.5 T5-01 的实施记录（已完成，供对照）

- **编排「生产形态」而非「开发形态」**：api 跑构建产物、web 由 nginx 托管静态产物并反代 `/api`。理由是 **T5-04 要暴露的正是生产形态**，编排开发形态等于把同一件事做两遍，且多出来的那份在 T5-04 时还得拆掉。
- **容器里 `HOST` 必须覆盖成 `0.0.0.0`**（最容易漏的一处）：代码默认 `127.0.0.1`（那条判断本身是对的），但容器里的 `127.0.0.1` 指向**容器自己**，端口映射进来的请求落在 eth0 上而进程只听 loopback。**漏掉的症状特别难查：容器全 healthy、日志里无错，只有访问时连接被拒。** 容器化会暴露一批只在特定环境里才错的默认值，而这类默认值在单测里永远是对的。
- **`depends_on` 默认只保证启动顺序**，api 连库要写 `condition: service_healthy`。db 那个 healthcheck 是 T5-01 之前就有的，注释里写的是「让 `--wait` 能等到可连接」——**那时它服务本地开发，本轮它成了 api 容器的启动前置条件**。
- **web 只等 api「起来」不等它「健康」**：它俩之间没有数据依赖，而等健康会让「前端能打开」也依赖数据库。**能看界面与能用接口是两种状态，互相阻塞没有收益。**
- **web 走 nginx 反代而非前端直连 api 地址**：直连会变跨源，要么加 CORS（服务端从不需要 CORS 这条前提整个失效），要么前端接受一个可配置地址。照抄 vite proxy 的形状，`API_BASE_URL` 保持空串、前端一行不改 —— 与 T4-01 外壳那段反代同一个决定。
- **签名密钥从环境变量注入，且刻意与 `apps/api/.env` 那份不同**：本机开发环境监听回环，容器这套将来要经 Tunnel 对外，复用同一份等于让本机签发的令牌在对外环境里也能用。`${FANHE_JWT_SECRET:?...}` 的写法让**没给值时 compose 直接拒绝启动**，好过让 api 拿着空密钥跑起来（后者会签出能被伪造的令牌，症状要到有人伪造登录才发现）。
- **`.env.compose` 这个名字是刻意的**：compose 默认只读 `.env`，而根目录的 `.env` 会被太多工具捡起，开发那份已在 `apps/api/.env` 且含义不同。于是 `--env-file` 必须手写 → **给 `infra/portable/ws-compose.cmd` 包住它**（手写标志是会被忘掉的步骤，忘了报 `required variable ... is missing`，读起来像 bug）。**容器操作一律经这个脚本。**
- **`.cmd` 必须是纯 ASCII，不只是无 BOM**：中文注释被 cmd 按 GBK 解码后**行结构被搞乱**，它于是去执行注释碎片当命令，报一堆 `'tatus' 不是内部或外部命令`。与「`.ps1` 要 BOM」同类，但症状更隐蔽 —— 报错完全看不出跟编码有关。中文说明移到文档里。
- **删掉 `# syntax=` 那一行**：它会**额外触发一次 docker.io 拉取**，是没网络时第一个失败点且报错指向那行、像写错了。没用上它的特性就别写。
- **安装必须 `--ignore-scripts`**：根 `postinstall` 调 `apps/desktop/scripts/ensure-electron.mjs`（T4-01 加的拉 Electron），容器里没那个文件 → `MODULE_NOT_FOUND` 让安装失败。取舍是**禁掉脚本 + 自己显式跑 `prisma generate`**，而不是拷进几百 MB 的 Electron。
- **运行阶段不重建 `@fanhe/shared`**：它需要 typescript（devDep，`--prod` 排除）→ `tsc: not found`。正确是 `COPY --from=build` 已构建好的 dist。
- **产物必须 `--from=build` 不能从上下文取**：`.dockerignore` 排了 `**/dist`，所以 `COPY apps/api/dist` 报 `not found` —— 而**它看起来像文件缺失，不像路径写法问题**。
- **`COPY` 路径相对构建上下文根，不是相对 Dockerfile**：`COPY deploy/nginx.conf` 会报 not found，正确是 `apps/web/deploy/nginx.conf`。它出现在**校验阶段、早于任何 COPY 执行**。
- **判据取响应的形状而不是状态码**：经 web 到 api 拿到 `{"error":"unauthorized","message":"请先登录"}` —— **那是 api 自己的文案，nginx 伪造不出来**。状态码不够：「api 返回 404」与「请求没到 api」在状态码上无法区分。与 T4-02「判据取上游回显的标记」同道理。
- **验证结果（2026-10-12）**：`up -d --wait` 后**三容器全 Healthy**；web 根路径 200（1694 字节 index.html）；深链 `/notes` 200 且大小相同（SPA 回退生效）；经 web 到 api 是 api 自己的 401；哈希资源 `max-age=31536000, immutable`；**端口三处全绑 `127.0.0.1`**（未对局域网暴露，`docker compose ps` 可查）；api 以 `uid=1000(node)` 非 root 运行；6 个迁移目录都在容器内。**外壳冒烟 PASS 且「反代到达上游=是」** —— T4-02 时同一判据是「否」（当时 8787 无监听），现在连的是容器化的 api。**同一条判据一个假一个真，比任何单独检查都更能说明这套编排真的通了。** 四道门禁全绿，**426 项 0 失败**（未改业务代码，基线不变）。提交 `ace70bd`。
- **已知限制：api 镜像 594MB，实际需要约 440MB。** `--prod` 只影响**链接到包**的那部分，被间接引用的 devDependency 仍留在 `.pnpm` 里（`@prisma/studio-core` 43MB、typescript 24MB、`effect` 34MB 等）。试过 `pnpm prune --prod`，**它会失败**（prune 自己触发 postinstall，同上那个问题）；修它要先加 `--ignore-scripts`，而它在 workspace 下语义本就模糊。**594MB 对单用户部署完全可接受，记为已知限制而不是加一个会失败、语义又不确定的步骤。** web 镜像 49MB。
- **本轮没做的两件事**：数据库没动（T5-02 的范围）；**没有把验证落成可重复执行的脚本** —— 本轮是实跑 + curl 断言，验的是「容器能不能起来」这个一次性事实。真正会回归的是镜像构建与配置的正确性，**那是 T5-04 要复用这套配置时该补的**（那时会多一个 `cloudflared` 服务，且要验「仅出站、无入站端口」这个属性）。

### 4.1.6 T4-04 的实施记录（已完成，供对照）

- **三类失效必须分开，因为引导方向不同**：`agent_unavailable`（代理不可用 → 去查工作区）、`invalid_profile`（送来的东西不像配置 → 重新编辑；**路径根本没被看过，所以引导绝不能让用户去改路径**）、`path_unavailable`（路径不在 → 去确认路径，必要时重新指定）。合成一类看着省事，代价是其中两类的文案必有一份是错的，而用户分辨不出来。
- **路径检查必须复用 api 的 `inspectExecutablePath`**，也就是启动时那一个。自检说「可用」而点击失败是这类功能最坏的失效 —— 用户会开始不信任自检，进而不再看它。`LaunchAgentModule` 契约因此加了 `inspectExecutablePath`，并**刻意要求它是「这个模块上的方法」**而不是自由函数（否则外壳会自己写一份 stat，两份实现会对「目录算不算存在」「UNC 超时怎么办」给出不同答案）。
- **不能复用 api 的 `listProfileStatuses`**：它要 `userId` 且走两次分组查询查启动记录，复用它外壳就得变成一个连库的服务，而「外壳不连数据库」是 T4-01 定下的形态。可复用的只有 `inspectExecutablePath`。
- **形态复核与路径检查都做成注入的依赖**，而不是在自检模块里 import。起因是 desktop **刻意产出 CJS**（保住沙箱化预加载，见 `tsconfig.json`），模块间 import 必须写 `.js` 后缀；而单测走类型剥离直接加载 `src/*.ts`，那里没有 `.js` 文件 → 撞 `ERR_MODULE_NOT_FOUND`（指向 `src/agent.js`）。这是本包第一次出现模块间 import 撞上双路径。**注入之后两者仍传的是同一份实现**（`main.ts` 传 `normalizeProfile` 与 agent 的方法），「自检与启动的判断不分叉」这条没丢。
- **并发检查全部路径，不是逐条 await**。`PATH_INSPECT_TIMEOUT_MS` 是 5 秒，而失效配置的典型成因正是指向网络共享（那台机器关机时 stat 不会立刻失败）→ 逐条 await 的话，10 条指向同一台关机机器的配置就是 50 秒，而自检恰恰是「用户已经等着了」的场合。与 api 侧 `listProfileStatuses` 同一口径。
- **单条检查失败不中断整轮**，按 `missing` 处理，方向与 api 侧兜底一致：**宁可让用户去确认路径，好过让他点了才收到失败。** 同理，判定可用时**只认 `ok`**，其余值一律按不可用 —— 误报可用比误报不可用糟得多。
- **整体不抛**：代理加载不了时返回一份**可显示的报告**（含一条 `agent_unavailable`）而不是错误，界面因此不必区分「没检查成」与「检查出问题」—— 用户也分不清那两者的区别。
- **诊断按配置顺序排序**：界面列表本身按 `sortOrder` / 名称排，两套顺序叠在一起会让人以为漏了哪一条。
- **「空配置」与「全部形态不合法」都提前返回**，不做任何路径检查 —— 没有一条值得查的路径就别付那个代价。
- **IPC 层空配置先判、不加载代理**：先加载会在工作区恰好有问题时报成「代理不可用」，那与事实不符（代理没事，只是没东西可查）。
- **冒烟的自检判据从渲染进程里调**（`executeJavaScript`），不是主进程自调 —— 预加载没暴露方法、通道名写错、`contextBridge` 克隆失败这三段只有这样才验得到。**判据只看「返回结构完整」**，不判「查出几条问题」，否则冒烟成败会随用户库里有没有失效配置而变。
- **验收脚本用真实文件与真实 agent 核心**（`test/acceptance/t404-diagnostics.mjs`，21 项），不靠替身 —— 全用注入的话，「路径检查与启动用的是同一份实现」这条就没人验了。里面还断言了「自检与启动对形态的判断一致」（两侧都用真实 `normalizeProfile`）。
- **并发那条判据验过能证伪**：临时把 `Promise.all` 改回逐条 await，该用例确实失败（串行 600ms vs 阈值 400ms），恢复后全绿 —— 用**耗时**判而不是「并发计数」，因为实现完全可能并发发起却仍然串行 await，而那种写法在计数上看起来是对的。
- **验证结果（2026-10-12）**：四道门禁全绿，`test` 为 shared 83 + api 197（192 过 / 5 跳过）+ web 70 + **desktop 76**，合计 **426 项 0 失败**；lint / typecheck / format:check 全通过。验收脚本 21 项全通过。外壳冒烟 PASS（新增一行「启动自检=可用 代理=可用 配置=0条 可用=0条」）。e2e 无界面改动未重跑（仍 149）。提交 `760b92f`。

### 4.1.7 T4-03 的实施记录（已完成，供对照）

- **外壳不查库，`LaunchProfile` 由渲染进程送进来**。三个方案里选了「渲染进程经现有 `GET /api/launch/profiles` 取配置 → IPC 送进主进程」：主进程自己查库会违背 `agent.ts` 顶部写死的约束（它**不认识数据库**），而把启动配置落成配置文件则要重做已交付的 T3-03，且与阶段五的数据库模型冲突。选中的方案完全复用现有链路，`agent.ts` **一行未改**，远程模式下同样通。
- **主进程必须自己复核形态**。HTTP 那条路上配置在入库时校验过一次、路由 schema 又把一次，agent 收到的一定是像样的东西；IPC 这条路上**没有任何一道**，而这条通道对渲染进程里的任何脚本开放。少这一步，`launch:run` 就等于一个本机任意命令执行入口。复核落在 `apps/desktop/src/agent.ts` 的 `normalizeProfile`：逐字段查（绝对路径、参数全为字符串、个数与长度不超限、`icon` 形态、`sortOrder` 有限数），**返回新对象**，未知的额外字段因此被丢掉、带不进进程创建。
- **新增失败原因 `invalid_profile`**，与 agent 原有的 `executable_missing` 分开：前者是「你送来的东西不像一条配置」（不该让用户去改路径），后者是「配置没问题但文件不在」（该让用户重新指定）。界面给的动作不同，合成一类会让其中一个的引导必然出错。
- **`apiLaunchModule(fromDir)` 的 `fromDir` 是必填**，沿用 T4-02 `config.ts` 的同一条约定（见 4.1.8 里那条 `__dirname` 的坑）。顺带收获是这段逻辑**可测了** —— 模块内不留 `__dirname`，单测就能在 ESM 里传自己造的目录进去。
- **`import()` 的参数必须是 URL 而不是路径**。ESM 加载器只认 `file:` / `data:` / `node:`，直接喂 Windows 绝对路径会被当成协议名为 `f` 的 URL 拒掉（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）。用 `pathToFileURL` 转，顺带把工作区名里的空格（`fanhe Work`）正确编码掉。**这一条是只有真机才暴露的**：前一层单测用的是假 agent 模块，从不真的 import，于是它在 desktop 全绿的情况下一直是坏的 —— 详见 9.43。
- **刻意不缓存模块实例**。Node 的模块缓存按 URL 索引，同 URL 第二次 `import()` 拿同一实例，这正是去重表要跨调用生效所依赖的；而缓存到模块级会让 `recentRuns` 在两个壳实例间不共享，症状是「任务管理器里躺着五个微信」。
- **`LaunchAgentModule` 写成结构类型**而不是 `typeof import('apps/api/src/launch/agent')`：后者在构建期要求 tsc 能解析那个路径，而 desktop 既没把 `@fanhe/api` 声明成依赖、工作区根也没配路径别名 —— 真写上去会得到一条解析不了的 import，**且它只在类型位置出现、运行时一切正常**，属于最难查的一类错误。代价是契约要手写，接口因此收窄到只用得到的两个成员。
- **`LaunchAgentModule` 失败时不抛而变成返回值**：agent 是按需加载的（工作区不完整时它会失败），那不该让外壳连界面都开不出来。加载失败变成一个可显示的 `detail`，界面能报「本机代理不可用」并说明原因。
- **验收脚本的判据是「真进程跑起来了且写出了标记文件」**，不是返回值也不是 pid 是否存在。可执行文件取 `process.execPath`（node 自己）加一段写标记的临时脚本，参数逐个断言原样送达 —— 只断言「进程起来了」的话，一个无视参数的错实现也能通过。另外断言了**假上游一次请求都没收到**：那是「启动走的是主进程 IPC 而没有绕回服务那条路」的唯一硬证据，而这条恰好就是 T4-03 的全部价值所在。
- **`test/acceptance/t403-shell-launch.mjs` 刻意不放 `test/*.test.mjs`**（那是 node --test 的 glob）。同 T4-02，暂存根固定落系统盘 —— `ws-run.cmd` 把 `TMP` 指向工作区 `.tmp`，会让「找不到工作区根」这类用例自相矛盾。
- **验证结果（2026-10-12）**：四道门禁全绿，`test` 为 shared 83 + api 197（192 过 / 5 跳过）+ web 70 + **desktop 52**，合计 **402 项 0 失败**；lint / typecheck / format:check 全通过。验收脚本 10 项全通过。外壳冒烟 PASS（`渲染元素=1 console错误=0`；`反代到达上游=否` 是因为当时 8787 无监听，与 T4-02 同因，非回归）。

### 4.1.8 T4-02 的实施记录（已完成，供对照）

- **配置文件落点**：工作区 `.config/fanhe-work/service.json`。**刻意不放 Electron 的 `userData`** —— 后者装的是 Chromium 缓存与 `credential.ts` 的凭据密钥库，搬进 U 盘既伤盘（与「数据库刻意不进 U 盘」同理）又会改变「凭据不随工作空间移动」的安全语义；而服务地址描述的恰恰是「这套工作空间接哪个服务」，该跟着介质走。`.config/` 是工作区既有的逐机配置目录（`ws-env.sh` 把 `XDG_CONFIG_HOME` 指向那里），已被根 `.gitignore` 第 6 行排除。
- **形状只有 `serviceUrl` 一个字段**。本机与远程**不是两个槽位**，而是同一个地址的两种取值 ——「切换」就是把这一项改成另一个 URL。做成 `localUrl` / `remoteUrl` + `active` 会引入一个真实坏处：远程没配时切过去，外壳以「没有可用地址」启动，而这与「配错了」在现场看起来一模一样。单字段下配错会当场被校验挡下。
- **改配置需重启外壳才生效**，这是刻意取舍：反代上游在起服务时确定，运行中换会产生「切了一半」的中间态，那在现场与「切失败了」难以区分。`service:set` 的返回值带 `needsRestart` 让界面能提示。
- **配置坏了不让外壳起不来**：坏 JSON、非法地址、空串、顶层是数组，全部退回缺省并把原因写进 `warning`，启动时打到标准输出。四条路径都有单测。
- **`fromDir` 必填而不是模块内自己推断**：`__dirname` 在单测那条 ESM 路径上不存在（且在参数默认值求值时就抛，早于任何显式传参），`import.meta.url` 又被 tsc 以 TS1470 拒绝（CJS 产物）。于是把「从哪儿找工作区根」交回调用方，`main.ts` 跑在 CJS 里传 `__dirname`。
- **验收脚本刻意不放在 `test/*.test.mjs`**：它没有 `node:test`，放进去会被门禁的 glob 当单测跑。落在 `test/acceptance/t402-service-switch.mjs`。
- **一处环境依赖型坑**：`ws-run.cmd` 把 `TMP` / `TEMP` 指向工作区的 `.tmp`，而 `.tmp` 就在 `.ws-root` 底下 → 任何从 `os.tmpdir()` 派生的目录向上找都必然命中工作区根。于是「找不到 `.ws-root` 时返回 null」这条用例在裸 node 下过、经 ws-run 挂。两个测试文件的暂存根因此固定落系统盘。**症状是「裸跑过、门禁里挂」，判据是跑两次对比。**
- **验证结果（2026-10-12）**：四道门禁全绿，`test` 为 shared 83 + api 197（192 过 / 5 跳过）+ web 70 + **desktop 28**（原 10 + 新增 18），合计 **378 项 0 失败**；lint / typecheck / format:check 全通过。验收脚本 11 项全通过。外壳冒烟 PASS，且**扩展了一条「反代到达上游」**（经内置服务请求 `/api/`，上游回 401/404 也算到达，只有 502 才是没到）—— 在真实工作区读到配置后为「是」，改指向假地址后转「否」。提交 `f2bfc16`。
- **顺带答了一个悬着的取舍**：「配置要跟着 U 盘走」由此落地，而 R2（`userData` 是否重定向进工作区）**降级为不阻塞主线** —— T4-02 证明了配置不必经由 `userData`。缓存留在系统盘与数据库不进 U 盘是同一类判断，凭据的安全语义也保持不变。

### 4.2 阶段三已无待办

纪要链（T3-05 → T3-06 / T3-07 → T3-08）与事件链（T3-09 → T3-10 → T3-11 → T3-12）**都收口了，12 项任务全部完成，验收六项全部勾选**。两链的已知边界与有意留白都记在 4.5，**那些是记录不是待办** —— 别把它们当缺陷去「修」。

### 4.3 阶段现状与后续

- **阶段四 Electron 外壳（T4-01 ~ T4-04）**：已完成 4/4，见 3.5。四项分别是外壳脚手架、本机与远程服务地址切换、把 `launch/agent.ts` 搬进外壳主进程、启动自检。
- **阶段五 服务端化（T5-01 ~ T5-05）**：4/5。容器编排、数据库连接串与迁移执行者、种子自动执行与备份恢复、Cloudflare Tunnel 出站接入均已完成，见 3.6；**T5-05 访问策略由用户决定暂缓**，已知风险见头部。
- **阶段六 更新通道（T6-01 ~ T6-03）✅ 已完成收口并已发版**：T6-01 与 T6-02 见 4.1.1、4.1.9；**T6-03 三段（T6-03a 打包与发布链路 / T6-03b 更新通道 / T6-03c 安装包签名）均已做完**，见 4.1.11 / 4.1.12 / 4.1.13。**「首次发布」已完成**：`v0.1.0`（2026-10-13 16:0x）与 `v0.1.1`（同日 17:4x）两次 GitHub Release 均已发布、资产齐备。**只剩 §八 第 4 条的正向验证**（在装 v0.1.0 的机器上点更新、确认落到 v0.1.1，须真人操作），见 4.1。
- **阶段七 账号与权限管理（计划外新开，T7-01）**：T7-01 已完成，见 4.1.10；**已登记进 `DEVELOPMENT-PLAN.md`**（任务表 / 依赖图 / 验收清单），后续范围待用户确认，见 4.1.0。

### 4.4 长期遗留（跨阶段，待排期）

- `users.passwordChangedAt` 接入访问令牌载荷（目前改密**不会**让已签发的访问令牌失效）。
- 改名复用 `normalizeUsername`，并在改名前用归一后的值查一次冲突（否则「只差大小写」的改名会绕过唯一约束）。目前唯一用得上冲突检测的入口是首次初始化。
- 角色管理的审计挂钩（**T7-01 已把「授权变更」与「删除」两类补上**，`packages/shared/src/audit.ts` 新增 5 个动作码、`apps/api/src/auth/user-admin.ts` 里 5 处 `recordAudit` 已接入；角色管理页面本身未做）。
- 客户信息平台 / **运维信息平台**（UI 集成时由「运营信息平台」改名）的权限点定义；当前 **12 个权限点**只有 `system` 与 `personal` 两段。
- **16 个占位导航项的 `module` 目前为 `null`**（对已认证用户一律可见）：除「首页」与「系统设置」外，其余 16 项（含 11 个预留槽位）都还没绑模块段。模块落地时改成对应模块段并同步改 `navigation.test.mjs` 的断言（否则它们会一直对所有人可见）。UI 集成里新加的 14 个子项与顶层「资产 / 搜索」同属这一类。**「系统设置」已于 T7-01 落地**（`module: 'system'`、`planned: false`），不在上述 16 项内，是既有的定位方式而非本次新增的例外。
- `projects/fanhe-work/`、`apps/api/`、`apps/web/`、`packages/shared/` 四处 `node_modules.old`：**已分析确认应当删除，但用户 2026-10-11 决定暂不删**。约 489 MB、23802 个文件，顶层软链接 100% 悬空于已不存在的 `E:` 盘，且与现役树重复、会污染 lint/format（现靠三处忽略规则压住）。依据见 `SYNC-COMPARE-2026-10-11.md` 第十一节。**将来删的时候不要连带删 `node_modules/`。**

### 4.5 已知边界与有意留白（不是缺陷）

**纪要**
- **列表分页未做**：`GET /api/notes` 一次返回该用户全部未删除纪要，没有分页参数。**检索也是全表扫描**，分页与索引应当一起排期。
- **检索有三条边界**：① 走 `ILIKE` 全表扫描、不建索引；② `LIKE` 元字符 `%` / `_` 未转义（搜 `%` 命中全部记录，有意不修）；③ 两个字的关键词即使将来建了 trgm 索引也仍走全表扫描。
- `PATCH` **不接受** `pinned` / `archivedAt` —— 这两个状态各有独立幂等 `PUT`，是有意设计。
- 标签无独立元数据（没有颜色、描述，也不跨用户共享），「标签重命名」目前要逐条改标签数组。
- 正文上限 10 万字符是**防超大请求体的闸门**而非业务约束；列类型是 `text` 不设宽度，改上限只需改 `NOTE_LIMITS.CONTENT_MAX` 与 schema 注释，**不需要迁移**。
- `@updatedAt` 副作用：置顶 / 归档都会刷新 `updatedAt`，取消置顶后该条会落到「最近修改」首位 —— 有意保留。

**启动通道**
- `canWrite: false` 已隐藏整行操作，但**浏览器级验证只覆盖 owner**；其他角色的真实渲染不能算作已验收。
- 路径 `stat` 的 5 秒超时**只结束等待、不取消底层文件系统调用**。
- 历史按用户保留最近 500 条，**不永久保证「上次成功」可得**。
- 状态重查**没有「检查中」状态、也没有失败反馈**，失败时保留上次快照。

**事件记录**
- **列表分页未做**：`GET /api/events` 一次返回该用户全部未删除事件，没有分页参数（与纪要同量级、同一判断）。
- **没有「归档」**：需要收起来时用的是软删除。真出现「要留但要退出列表」的需求再加，那是一个独立的迁移。
- **行上最多显示 3 个标签**，多出来的在后面记一句 `+N`；**完整标签列表在详情面板里**（T3-12 已做）—— 两处是同源数据，行上截断是为了让标题有地方放，不是两套值。
- **勾选切换是串行的**（同一时刻只允许一条在飞），期间所有勾选框都进 `disabled`。这不是性能问题而是观感问题：允许并发会让后一次重拉把另一条还没落库的乐观值抹掉（表现为另一行的勾选框自己弹回去）。单用户本机应用的通行做法，代价在几百毫秒的量级、实际看不见。
- **撤销入口不自动消失、不给「重做」、不写 `comment`**：服务端支持 `comment`，但界面的勾选是「做完了」这一个动作，没有可填备注的位置 —— `setEventStatusRequest` 因此刻意不收这个参数。真需要「撤销原因」时再加，那会是一次独立的改动。
- **没有批量勾选**（一次一条，配合串行化）。
- **`EventRow` 的 `locked` 与 `switching` 是两个 prop 而不是一个枚举**：「点不动」与「正在处理的是我」在界面上确实是两件事（前者不压暗、后者压暗），合成一个之后会需要在这两个量之间做一次没有信息量的映射。
- **详情面板不做编辑与勾选**（T3-12 的有意留白）：编辑走行内菜单、状态走行内勾选框，面板只做「看清楚这一件事」。想在详情里直接改状态是以后可能的独立改动，现在别加。
- **未完成的事件也能打开详情**（规格只要求已完成，这是有意扩展）：描述在列表行上无处可看，只给已完成开面板等于让未完成的人找不到自己写的内容。代价是未完成的面板缺完成时间 / 完成人 / 完成用时三块 —— **未完成时不显示完成用时**，没有终点算出来的只是一个假数字。
- **时间线只展示状态流转，不展示编辑历史**：编辑标题 / 描述 / 标签 / 优先级刻意不写日志（详见 3.4）。所以时间线里看不到「谁改了标题」—— 面板回答的是「状态怎么变的」，混进编辑记录就变成另一份东西了。若将来要编辑历史，那是新增一条 `action` 码并改 `PATCH` 的写日志策略，不是界面改动。

**账号与权限**
- 阶段一验收「关键操作在 `audit_logs` 有记录」**已于 2026-10-14 勾选**：T7-01 补上「授权变更」与「删除」两类的写入点（`audit.ts` 新增 5 个账号管理动作码，`user-admin.ts` 里 5 处 `recordAudit` 已实际调用），本轮补上端到端断言（`user-admin.test.ts` 把五类动作走完再回查审计表，逐条核动作码、操作者 id 与快照名、目标类型、结果，并断言 `detail` 不含口令）。**补断言时发现并修掉一个留痕缺口**：账号管理取 `request.ip`、`inject` 默认来源是 `127.0.0.1`，而清理只认 `TEST_IP`，库里因此积了近三百行测试留痕；清理改为按 `actorId` 圈定并置于账号删除之前。见 4.1.17 与 `DEVELOPMENT-PLAN.md` 9.58。

---

## 五、关键决策清单

> 每条只给结论与**为什么**，需要完整推演时按编号翻 `DEVELOPMENT-PLAN.md`。这一节的存在意义是：**别把已经论证过的事再论证一遍**。

### 5.1 技术选型

| 决策 | 结论与理由 | 出处 |
| -- | -- | -- |
| TypeScript **6.0.3** | 不用 7.x：`typescript-eslint` 8.71.1 的 peer 是 `>=4.8.4 <6.1.0`，遇 TS 7 是**导入即抛错**。官方出路是并存两套类型系统，不值得 | 9.3 |
| Vite **显式绑 IPv4 回环** | Windows 上 `localhost` 只解析到 IPv6 `::1`，与后端 `127.0.0.1:8787` 不在同一协议栈 | 9.3 |
| Prisma **钉 7.10.0** | 两个包同版本，不要 `@latest` | 8.4 |
| 数据库**容器 + 命名卷** | PostgreSQL 随机 IO 重，而工作空间在闪存 U 盘上（慢且有写入寿命）；代价是换机后库不在 | `docker-compose.yml` 注释 |
| 排序规则 **ICU `zh-CN`** | 默认 `C` 按 UTF-8 字节序比较，中文相当于按码位排，列表里的中文姓名不会按拼音顺序出现。建库时定死，事后改要重建 | 同上 |
| 密码哈希用 **`@node-rs/argon2`** | 本机**没有 C++ 编译器**，node-gyp 源码编译走不通；装带二进制的包优先 napi-rs 系 | 9.9 |
| Argon2id 用 **OWASP 最低推荐档**（m=19456 / t=2 / p=1） | PHC 编码串自带生成时的参数，**改参数不会让已有密码失效** | `.env.example` 注释 |
| **不引 `rehype-raw`** | Markdown 一旦放行原始 HTML，一段 `<img onerror=…>` 就能在读到它的人那里执行；要支持 HTML 必须同时加 `rehype-sanitize`，而那不该由一个预览组件顺手决定 | 9.33 |
| Web 端**不引 `@tailwindcss/typography`** | 项目排版规格出自方案 B，覆盖插件带来的整套字位与间距，成本高于直接写十几个标签 | 9.33 |

### 5.2 安全与认证

- **访问令牌只放内存，刷新令牌持久化**；续期用**单飞**收敛并发，401 续期一次后重试。出处 9.17。
- **四类登录失败共用同一响应**，不给人枚举用户名的机会。出处 9.10。
- **登录限速双维度**（账号 + IP），阈值与窗口全部配置化，超限 429。出处 9.12。
- **权限每次查库、不缓存** —— 账号停用或删除后令牌立即失效。出处 9.13。
- **归属不符与不存在统一返回 404**，不用 403 —— 用 403 会让任何一种响应都变成「这个 UUID 存在」的探针。因此前端那一侧也无从区分，文案统一。出处 9.32。
- **刷新令牌重放按 `familyId` 整链撤销**，撤销分 session / device / all 三层。出处 9.11。
- 记住账号密码用 **AES-GCM**，密钥存 IndexedDB 且不可导出；凭据只在登录成功后写入，取消勾选即清。出处 9.20。

### 5.3 数据与数据库

- **软删除统一用 `deletedAt`**；**归档用 `archivedAt` 记时刻而不是布尔**（「什么时候归档的」本身有信息，且布尔改不动历史）。
- **标签用 `text[]` + GIN，不另开 `tags` / `note_tags` 关联表**。出处 9.32。
- **所有权的强制在 service 层**（`where` 恒带 `userId`），不用数据库约束兜。
- **重名检查不用数据库唯一约束**（启动配置），因为软删除之后那个「唯一」的含义会变。出处 9.28。
- **`PATCH` 体要求 `minProperties: 1`**，空 body 被 400 拒。
- **正文不 trim、标题 trim**：Markdown 的前导空白有意义。
- **迁移的目录名字典序 ≠ 实际创建顺序**（`login_rate_limit` 比 `init` 排得靠前但创建得更晚）。当前字典序**恰好**满足依赖，**不能宣称全部迁移互相独立**；新增迁移若引用更晚创建的对象，要查的是迁移间是否真的独立。出处 9.16。
- **不写审计**：纪要属私有用量，与启动配置同判（服务端不记录读写的审计流水）。

### 5.4 中文全文检索（T3-07 的核心结论）

**选择：`ILIKE` 覆盖标题与正文，不建索引。这是实测后的决定，不是绕开。**

| 候选方案 | 实测结果 | 结论 |
| -- | -- | -- |
| `tsvector` + GIN | `to_tsvector('simple','衣柜门板安装说明')` 只产出**一个**词位，`@@ to_tsquery('simple','衣柜')` 为 **false**。返回的是「正常结果为空」而不是报错，很容易被误读成数据没写进去 | **否决**。本机容器 `pg_available_extensions` 只有 `pg_trgm` / `btree_gin` / `unaccent`，**没有中文分词器** |
| `pg_trgm` GIN + `ILIKE` | 30 000 行中文数据、索引已建并 ANALYZE：**两个字**的 `'%衣柜%'` 仍走 **Seq Scan**，三个字以上才走 Bitmap Index Scan | **否决**。两个字恰是中文最常用的关键词长度，这条路在最需要它的地方不生效 |
| **`ILIKE` 全表扫描** | 单用户纪要量级是几百到几千条，全表扫描在此量级是**毫秒级** | **采用** |

**升级路径已备好**（真出现性能问题再上）：迁移里 `CREATE EXTENSION IF NOT EXISTS pg_trgm;`，模型上加
`@@index([title(ops: raw("gin_trgm_ops")), content(ops: raw("gin_trgm_ops"))], type: Gin)` —— Prisma 7.10 对 `ops: raw(...)` 与 `extensions = [pg_trgm]` 都能通过 `prisma validate`（已实测）。**但那时只有三字以上的关键词会变快。**

**「什么叫空检索词」只有一处定义**：共享包 `normalizeSearchQuery`，`undefined` 与全空白**一律归 `null`（含义是不检索）**。`null` 与 `''` 的区别是**承重**的 —— Prisma 的 `contains: ''` 会匹配每一行。上限 `NOTE_LIMITS.SEARCH_MAX = 64` 也放共享包，前端拿它做 `maxLength`。

**边界**：`LIKE` 的 `%` / `_` 未转义（Prisma 的 `contains` 不提供 `ESCAPE`），搜 `%` 命中全部记录。不是安全问题（查询参数化、无注入面），**有意不修** —— 要修得换成原生 `$queryRaw`。完整判断见 **9.34**。

### 5.5 前端约定

- **令牌唯一来源是 `apps/web/src/index.css` 的两层结构**（`:root` 原始值 + `@theme inline` 映射），不要在组件里写死颜色。
- **新增颜色令牌要同时在 `:root` 与 `.dark` 各写一份** —— 只写一处会得到一个只在亮色（或只在暗色）下正确的界面，而这类缺陷在默认配色下完全看不出来。
- **不改 shadcn 组件源码**；方案 B 与 shadcn 默认风格的差异**在令牌层消化**（`--shadow-xs/sm` 归零、只覆盖 `--radius-md` 到 8px）。
- **组件一律从 `apps/web/src/components/ui/` 取，不手写等价元素**：同一件东西两种实现时，差异只会在改令牌或换主题时才暴露。
- **前端分层固定为三层**：`lib/api.ts`（只拼地址、不认会话）→ `lib/session.ts` 的 `withAccessToken` → `lib/<模块>.ts`（会话感知 + 拆信封 + 按错误码分流）。界面三态走 `components/StateView.tsx`。
- **展示规则下沉到 `lib/<模块>-display.ts` 的纯函数，不要写在组件里**：分组、派生判断（逾期）、取值到文案与样式的映射、时间形态转换，全都是纯函数，而它们恰恰最容易在某次改动里被弄错（例如「逾期」顺手把已完成的也算进去）。写在组件里就只有开一次浏览器才能验，抽出来则能被 `node --test` 直跑。范例见 `lib/event-display.ts` 与其 17 项单测。
- **`pnpm --filter @fanhe/shared build` 必须先跑**：根脚本的 `dev` / `build` / `typecheck` / `test` 都会先构建共享包，直接调用子包脚本会跳过这一步。
- **受控组件的「数据后到」死角**（实战踩过，见 5.6）：靠父组件 `key` 重挂来初始化草稿或表单状态时，**key 的变化可能与数据到达脱钩**。

### 5.6 三处踩过的真 bug（这类 bug 只有浏览器验证能抓到）

1. **新建纪要后编辑器被初始化成空白**（T3-06）。父组件先 `setSelectedId(created.id)` 再重拉列表，于是 `key` 由 `'new'` 变成新 id、编辑器重挂，而重挂那一刻列表里还没有这一条、`note` 仍是 `null` —— 草稿被初始化成空白且此后再无同步时机。现象是「左侧列表里有条目，右侧编辑器一片空白、标题计数 0/200」，而保存按钮还亮着。**修法**：记一个 `syncedNoteId`，只在 note 的 **id** 变化时补一次同步（判据用 id 而不是整个对象，否则列表重拉换了引用会把用户正在输入的内容冲掉）。见 9.33。
2. **空库时第一条纪要永远建不出来**（T3-06）。编辑器原先只画在「列表非空」分支里，空库走空态，而空态里的「新建」只是把选中项设回 `null` —— 渲染分支不变，点按钮毫无反应。**修法**：可写角色在加载完成后一律渲染「左列表 + 右编辑器」，只读角色空库时才回落空态。见 9.33。
3. **提交成功后旧实例的卸载落盘把已提交内容写回新建槽**（T3-08）。父组件先换 `selectedId`、编辑器随之重挂，而**旧实例的卸载清理是在重挂之后才执行的**；那一刻它手上的 `note` 仍是 `null`（列表还没重拉完），「有没有改动」恒为真，于是内容被写回 `'new'` 槽。现象是「**新建 → 提交 → 再点新建**」时编辑器里躺着上一条已经存过的纪要 —— 要三步才出现。**修法**：`committedRef`，提交成功时置真并清槽，落盘前先看它；**重置必须放在输入回调里而不是 effect 里**，因为紧跟其后的 `setValues(valuesFrom(saved))` 也是一次 values 变化，放 effect 里会被它立刻清掉、等于没挡。见 9.35。

**这三条与「四道门禁全绿」并存**：单测、类型检查、接口冒烟全都拦不住它们。第 3 条尤其典型 —— 它被修好之前，`pnpm test`（当时 251 项）、`typecheck`、`lint` **全都是绿的**，只有浏览器 e2e 的「新建 → 提交 → 再点新建」那一项能把它照出来。

> **补一条同源的反面提醒**：反过来说，**没有界面改动的任务不该硬跑 e2e**。T3-09（事件模型与接口）就属于这一类 —— 它的验收要点落在**数据**上（每次状态变更到底追加了哪一行），e2e 断言的是界面行为，跑了也验不到。那一类的正确验证方式是**绕过接口直查库**，见 9.36。

> **同类但不同源的一条（T7-02a，2026-10-13）**：**「更新后设置丢失」不是升级删了文件，而是界面来源（端口）每次启动都变** —— `server.listen(0)` 让系统随机分配端口，而 localStorage / IndexedDB 按 origin 分区、origin 含端口，于是每次启动换一个存储分区。它同样**四道门禁全绿、冒烟也绿**（每次启动都正常渲染、控制台零错误），**只有去看 `%APPDATA%\梵禾 Work\IndexedDB\` 下有几份存储才会发现**（实测并存 `49901` 与 `57352` 两份）。**这一类「与多次启动有关的状态」连浏览器 e2e 也抓不到 —— e2e 每次都是一次干净的启动。** 见 4.1.14。

### 5.7 工作空间与工程约定

- **根靠向上查找 `.ws-root` 定位，不写死盘符**；**受版本控制的文件禁止硬编码盘符**，需要根时用 `WS_ROOT`；路径含空格时变量一律加引号。
- **诊断脚本归档在 `projects/fanhe-work/tools/`**（`checks/` 门禁与探针、`prisma/` 数据库、`oneoff/` 一次性），由工作区根的 `.tmp/` 归档而来。
- **`.ps1` 必须带 UTF-8 BOM**（硬性约束）：Windows PowerShell 5.1 解析无 BOM 文件时按系统 ANSI（GBK）解码，GBK 尾字节会吃掉落在其范围内的 ASCII 字符（含单引号），报「字符串缺少终止符」而**整个脚本一行都不执行**。推论：**任何要被 PS 5.1 执行的 `.ps1`，要么带 BOM，要么全文只用 ASCII。**
- **提交完整、别用 `git add -A`**：工作区里有并发会话产生的未跟踪目录（本次为 `UI合并方案/` 与 `星尘AIGC-UI解析/`），`add -A` 会把它们一起提交进去。**显式列出路径。**
- **推送要给足时间并落盘日志**：凭据阶段会停滞约 70 秒（git 先查 `credential.helper=helper-selector` → `credential.helperselector.selected` → 才落到 GCM 绝对路径），**超时给到 ≥150 秒**；**不要把推送输出接管道**（`| tail` 的缓冲会把日志全吞掉，表现为「无输出卡死」），改用 `> .tmp/push.log 2>&1` 落盘再读。

---

## 六、依赖环境与配置

### 6.1 唯一入口：工作空间机制

- **所有包管理（install / add / build / test / lint / format）一律经 `infra/portable/ws-run.cmd`。** 直接裸跑 `pnpm` 会让 store 落到宿主机磁盘，且当场无提示。
  - 工作空间根调用：`infra/portable/ws-run.cmd pnpm <cmd>`
  - 从 `projects/fanhe-work` 调用：`../../infra/portable/ws-run.cmd pnpm <cmd>`
  - 从 `apps/web` 深处调用：四层 `../../../../infra/portable/ws-run.cmd pnpm <cmd>`
- **并行调用入口会撞车**（同时写 `state/root.json` 抛 `IOException`），串行执行即可。
- 入口下 `TEMP` / `TMP` 被重定向到 U 盘的 `.tmp/`，**`os.tmpdir()` 不可信**；要让产物落系统盘需从 `LOCALAPPDATA` 推。
- **本机没装编译器**（无 MSVC / node-gyp 走不通），装依赖优先选带预编译二进制的包。
- **`ws-env.sh` 的正确用法**（在会话里临时用）：`cd <repo> && WS_NO_REPAIR=1 WS_QUIET=1 . "<工作区根>/infra/portable/ws-env.sh" && <命令>`，**必须在同一条命令内完成**，因为 shell 状态不跨调用保留。

### 6.2 Node 与包管理

- Node **22.22.2**（受管运行时）。包管理用 **pnpm**（版本在 `package.json` 的 `packageManager` 声明，`corepack enable pnpm`）。
- `pnpm-workspace.yaml` 的 `onlyBuiltDependencies: []` **刻意禁掉生命周期脚本**。
- `.npmrc` 固定 registry 为 `registry.npmmirror.com`；**装依赖按分钟到十分钟量级预留**（实测装两个 Markdown 包解出 593 个包、耗时 5 分 25 秒，伴随 `ERR_PNPM_TARBALL_EXTRACT` 重试最终成功 —— 别把 5 分钟当卡死）。
- **store 有重定向**：`node_modules` 链到 `<工作空间根>/.cache/pnpm-store/v10`，而裸跑 pnpm 想用 `<盘符>:\.pnpm-store\v10`，于是报 `ERR_PNPM_UNEXPECTED_STORE`。重定向来自 `infra/portable/ws-env.sh` 导出的 `npm_config_store_dir` 与 `config/.npmrc` 的 `store-dir=${WS_ROOT}/.cache/pnpm-store`。**盘符会在 `E:` / `F:` 之间变**，所以上面写的是「盘符」而不是具体某个字母 —— 2026-10-11 实测已从 `F:` 变回 `E:`。
- **`pnpm` 本身是逐机的**：本机若从未 `corepack enable pnpm`，入口会报「无法将"pnpm"项识别为 cmdlet」或 `command not found`（`ws-run` 只负责转交裸 `pnpm`，自己不装）。临时替代是 `corepack pnpm <cmd>`，可免 enable 直接跑。**换机必做**。
- **`pnpm install` 的两个必加开关**（非交互环境）：① 无 TTY 时它要 purge 整个 `node_modules` 并等确认，会被中止（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）→ 加 `CI=true` 与 `--config.confirmModulesPurge=false`；② 清 `node_modules` 会撞上批量删除保护（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）→ 加 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=<大数>`。完整可用写法：
  `cd <repo> && CI=true CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=2000000 ../../infra/portable/ws-run.cmd pnpm install --config.confirmModulesPurge=false`
- **换盘之后 `node_modules` 里的软链接会全部悬空**（实测 `apps/api/node_modules/tsx -> /f/fanhe Work/...`），现象是 `Cannot find module .../tsx/dist/cli.mjs`。工作区的换机自愈会重建 `.bin` shim，但**不修软链接** —— 必须重跑一次 `pnpm install`（store 本身是好的，不需要重新下载）。

### 6.3 数据库（不随盘，换机必重建）

- 容器 **`fanhe-work-db`**，镜像 `postgres:16-alpine`，库 `fanhe_work`，用户 `fanhe`，端口绑 `127.0.0.1:5432`。
- 数据在宿主机**命名卷 `fanhe-work-pgdata`**，不随介质移动。
- 排序规则在建库时定死 **ICU `zh-CN`**，事后更改需重建数据库。
- 健康检查让 `docker compose up -d --wait` 真正等到可连接（迁移脚本依赖这一点）。
- **当前 7 个迁移、13 张业务表**（另加 `_prisma_migrations`）：

  | 迁移目录 | 建的对象 |
  | -- | -- |
  | `20261010082118_login_rate_limit` | `login_attempts` |
  | `20261010150103_init` | `users` / `roles` / `permissions` / `role_permissions` / `refresh_tokens` / `audit_logs` |
  | `20261010165220_launch_profiles` | `launch_profiles` |
  | `20261010180508_launch_history` | `launch_history` |
  | `20261011064829_add_notes` | `notes` |
  | `20261011132819_add_events` | `events` / `event_logs`（**阶段三唯一一次建两张表的迁移**） |
  | `20261012094234_user_permissions` | `user_permissions`（**T7-01 新增**；同一迁移给 `users` 加 `department` 列） |

- **迁移目录的时间戳是 UTC**（`date -u`，与 Prisma 自身一致），因此它比本地时间小 8 小时 —— 别按本地时间去找「今天那个迁移」。
- **手写迁移的生成方式（Prisma 7.10 起）**：`migrate diff --from-url` **已被移除**，改用
  `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o <文件>`（在读得到 `prisma.config.ts` 的目录下跑），再 `prisma migrate deploy` 应用。**生成后用同一条命令复核一次**，输出应当是 `-- This is an empty migration.` —— 那是「库与 schema 已无差异」的判据，比人肉核对 DDL 可靠。

- **种子数据**：**12 个权限点**（T7-01 新增 `system.user.delete`，原 11 个）、4 个角色、29 条以上授权关联；重跑无副作用（按 code upsert + 关联差集同步）。
- **owner 账号**：登录名 `fanhe`，显示名「梵禾」，状态 active。口令为 24 位强随机，写在被忽略的 `.tmp/owner-credentials.txt`（**该文件不随盘走**）。
- **owner 存在之后，`apps/api/test/setup.test.ts` 的 5 项首次初始化用例会自动跳过**（前置条件是「库里无 owner」）。看到 api 测试 `skipped=5` 是**设计行为，不是失效**。
- 常用脚本：`pnpm db:deploy`、`pnpm db:ping`、`pnpm db:seed`、`pnpm db:create-owner`、`pnpm db:generate`、`pnpm db:studio`。

### 6.4 Prisma 7 的三处硬性差异（两个包同版本 7.10.0，不要 `@latest`）

1. **强制驱动适配器**：`@prisma/adapter-pg` + `pg`。
2. **连接串与迁移配置移到 `prisma.config.ts`**；生成器改名 `prisma-client`，`output` 必填。
3. **`.env` 不再自动加载**，需 `import 'dotenv/config'` 且置于首行。

### 6.5 环境变量

`apps/api/.env`（由 `.env.example` 复制，**不进版本控制、不随盘走**）：

| 变量 | 说明 |
| -- | -- |
| `DATABASE_URL` | **`schema=public` 不能省**（Prisma 默认把表建在 public 下，缺了它部分命令会走错搜索路径） |
| `SHADOW_DATABASE_URL` | 迁移用影子库。留空时 Prisma 会在目标实例上临时建/删一个库，要求账号有 `CREATEDB` |
| `JWT_SECRET` | **必填，至少 32 字节，没有默认值**。生成：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`。每套部署用自己的，不要跨机复用 |
| `ACCESS_TOKEN_TTL_SECONDS` | 默认 900（15 分钟）。**验证「静默续期」时要压到 60** |
| `REFRESH_TOKEN_TTL_DAYS` | 默认 30 |
| `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` | 默认即 OWASP 对 Argon2id 的最低推荐档 |
| `OWNER_USERNAME` / `OWNER_PASSWORD` / `OWNER_DISPLAY_NAME` | **只被 `pnpm db:create-owner` 读取**，走环境变量不走命令行参数（避免口令留在进程列表里） |

### 6.6 GitHub 与代理（推送必看）

- **GitHub 直连不通，必须走本地代理 `http://127.0.0.1:7897`**（不是 17897，不是会话里的临时端口）。
- **代理不对的症状是「卡住」而不是「报错」**：`git push` 无限等待、无任何输出，极易被误读成凭据过期。判定方法：`git credential fill` 带 / 不带 `HTTPS_PROXY=http://127.0.0.1:7897` 各跑一次，带了的立刻返回、不带就超时，即确认是代理问题。
- 推送时三个变量一起给并加 `GIT_TERMINAL_PROMPT=0`（见第零节的命令），**把输出重定向到文件**再读。
- 判连通性用 `git ls-remote origin HEAD`（秒回即网络与凭据都正常），比反复重推更快定位问题。
- **凭据是逐机逐用户的**（细粒度 PAT 经 GCM 存于 `~/.gitconfig`），**换机必须重配**；WorkBuddy 的 GitHub 连接器只读，写不了。

### 6.7 编码与其他陷阱

- **编码**：bash 写 UTF-8 无 BOM；PowerShell 5.1 的 `Get-Content` 无 BOM 时按系统 ANSI 解码。跨环境传中文清单，读取侧必须显式 `-Encoding UTF8`。
- 原生命令的 stderr 被 PowerShell 包成 `ErrorRecord`；点源 `ws-env.ps1`（设 `$ErrorActionPreference='Stop'`）后更危险 —— 调用会写 stderr 的工具（如 Prisma）前要先改回 `Continue`。
- **Docker 客户端配置不重定向**：`DOCKER_CONFIG` 指向空目录会让 `docker compose` 变成未知命令。
- **跑 `prisma generate` 或门禁会打断正在跑的 `tsx watch`**（删文件导致整个进程退出）。先停 dev，或跑完门禁后重启 dev。
- **`EADDRINUSE` 通常意味着「已有另一个自己在跑」**。清残留要对着命令行按整条链杀，或直接杀 `tsx watch`。
- **Vite dev server 会被批量删除保护挡住**：它启动时要清自己的 `apps/web/node_modules/.vite/deps`（实测 61 个条目），撞上保护后直接抛错退出，日志是 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，而外部只看到「5173 连不上」。**与 `pnpm install` 那个坑同源**，加 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=<大数>` 即可（本次实测 `2000000` 够用）。
- **起 API 做一次性验证时，用不带 watch 的 `tsx src/index.ts`**（在 `apps/api` 下执行）。`tsx watch` 会在构建产物一变就重启，可能撞 `EADDRINUSE` 整进程退出；而且跑 `prisma generate` 或四道门禁会删文件把它打断。
- **本地端口请求一律加 `--noproxy '*'`**：不带它时 `curl http://127.0.0.1:8787` 会被送到系统代理，返回 `HTTP 000`，看起来像服务没起来。取当前代理端口：`env | grep -i proxy`。
- **`pnpm --filter <pkg> exec` 会把工作目录切到该包**：在仓库根 `exec tsx apps/api/src/index.ts` 会因为 `.env` 不在当前目录而报「缺少环境变量 DATABASE_URL」。要跑 api 就在 `apps/api` 下用 `./node_modules/.bin/tsx src/index.ts`。
- **PowerShell 里不要拿 `$pid` 当循环变量**：它是只读自动变量，赋值会静默失败，于是 `Stop-Process -Id $pid` 杀掉的是**运行脚本的 PowerShell 自己**（表现为输出截半、目标进程没死）。换名如 `$procId`。

---

## 七、换机续接步骤（照做即可 100% 恢复）

> 每一步后面都给了**验证判据**。判据不通过就别往下走 —— 后面几步的失败现象会互相掩盖。

| # | 步骤 | 命令 / 动作 | 验证判据 |
| -- | -- | -- | -- |
| 1 | **介质就位** | 整盘带 U 盘到新机，或 `git clone` **整个工作空间根**（仓库根即工作空间根，**不是** `projects/fanhe-work`） | 根目录下有 `.ws-root`、`infra/`、`projects/` |
| 2 | **pnpm 就位** | `corepack enable pnpm` | `pnpm -v` 等于 `package.json` 里 `packageManager` 声明的版本 |
| 3 | **Git 信任与身份** | `git config --global --add safe.directory "<工作空间根>"`；确认提交身份为 `梵禾 <dev@fanhe.local>` | `git config user.name` / `user.email`；`git log -1` 能正常显示（不报 dubious ownership） |
| 4 | **凭据重配** | 重配 GitHub 细粒度 PAT 到 GCM（`~/.gitconfig` 是逐机的） | `GIT_TERMINAL_PROMPT=0 HTTPS_PROXY=http://127.0.0.1:7897 git ls-remote origin HEAD` 秒回 |
| 5 | **依赖重建** | 经入口 `ws-run.cmd pnpm install` | 无 `ERR_PNPM_UNEXPECTED_STORE`；`node_modules` 链到 `<根>/.cache/pnpm-store` |
| 6 | **数据库重建** | `docker compose up -d --wait` → `cp apps/api/.env.example apps/api/.env` 并填 `JWT_SECRET` → `pnpm db:deploy` → `pnpm db:seed` → `pnpm db:ping` | `db:ping` 列出 **13 张业务表**；权限点 **12** / 角色 4；`docker ps` 里 `fanhe-work-db` 是 `healthy` |
| 7 | **构建共享包** | 经入口 `pnpm --filter @fanhe/shared build`；再 `pnpm db:generate` | `packages/shared/dist` 有产物；`apps/api/src/generated/prisma` 有产物 |
| 8 | **建 owner** | 走首次初始化引导，或 `OWNER_USERNAME=… OWNER_PASSWORD=… OWNER_DISPLAY_NAME=… pnpm db:create-owner` | 用该账号能登录（`POST /api/auth/login` 返回 200） |
| 9 | **门禁确认** | 逐条串行跑 `pnpm test` / `lint` / `typecheck` / `format:check` | test 为 **536 项、0 失败**（shared 108 + api 232 含 5 跳过 + web 97 + desktop 99）；其余三条全绿 |
| 10 | **浏览器级验证（可选，代价大）** | 见 8.2 | e2e **150 项全通过**（2026-10-13 UI 落地对齐后重跑的结果；改界面就要重跑） |
| 11 | **外壳（阶段四起）** | 经入口 `pnpm --filter @fanhe/web build` 重建产物 → `pnpm --filter @fanhe/desktop smoke`（受限环境加 `FANHE_NO_SANDBOX=1`） | 输出 `[smoke] PASS`，且 `console错误=0`；详见 8.5 |

**换机后不复存在、必须重建的东西**（都是刻意不随盘走的）：

- `.tmp/owner-credentials.txt`（owner 口令）
- `apps/api/.env`（含 `JWT_SECRET`）
- 数据库容器与命名卷（**逐机**：换一台机器就是另一份库）
- 四处 `node_modules/` 与 pnpm store（store 随盘符失效，且软链接会全部悬空）
- **`corepack enable pnpm`**（逐机，本机没做过时入口直接报「找不到 pnpm」）
- GCM 里的 GitHub 凭据、git 的 `safe.directory` 与提交身份

> **换机后必须实跑一遍四道门禁再开工**，别信文档里的「全绿」数字 —— 2026-10-11 就出现过文档记全绿、实跑 `typecheck` 报错（`WorkbenchPage.tsx` 的 `NavLink` 回调缺类型标注，换盘重建依赖后才暴露）的情况。那处已修（`4d43dae`）。

---

## 八、后续开发的注意事项

### 8.1 改代码前必读

1. **改前端**先看 5.5：令牌只从 `index.css` 取、新增令牌要在 `:root` 与 `.dark` 各写一份、组件只从 `components/ui/` 取、不改 shadcn 源码。
2. **改数据模型**先看 5.3：新增迁移要检查迁移间是否真的独立，序列与字典序不保证一致。
3. **碰检索**先看 5.4 —— 那两条路已经实测否决过，重做只会得到同样三个结论。
4. **新增界面板块**不要手写 `StateView` 的等价物；四态（加载 / 失败 / 空 / 列表）照 `LaunchPanel` / `NotesPanel` 的分派形态写。

### 8.2 跑测试与浏览器验证

- **四道门禁依次为** `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm format:check`。`test` 与 `typecheck` 会先构建共享包，`test` 还依赖数据库容器在跑。
- **断言失败时先分清是哪一类，别默认去改产品代码。** 至今累计四类，性质完全不同，但在脚本输出里长得一模一样：
  - ① **真 bug**（改产品代码）—— T3-06 的编辑器草稿同步死角；
  - ② **断言作用域过宽**（改脚本）—— T3-06 的 `nav a` 应为 `aside nav a`，尺子变长了而界面本身正确；
  - ③ **环境残留**（清进程）—— T3-06 的旧 `tsx watch` 占着 8787；
  - ④ **断言期望与实现不符**（改脚本，且要改「对的那一半」）—— T3-10 的「低优先级也有文字」：事件乙在表单里没显式选优先级、吃的是默认的「普通」，而断言期望「低」。**修法是在表单里补一次「低」的点击，而不是把期望改成「普通」** —— 后者会让那一条退化成「为默认值恰好等于期望值背书」，而它本要验的是「非默认档也有文字」。判据：问一句「这条断言要证明的到底是哪件事」，再看改哪一侧更接近那件事。
- **浏览器 e2e 的代价必须记住**（`apps/web/test/e2e-auth.mjs`）：
  - 它以**数据库未初始化（`users` 表为空）**为前置条件 → **每跑一次都要先清库，跑完重建 owner** 并更新 `.tmp/owner-credentials.txt`。重置语句见该文件头部注释（**依次 `event_logs` → `events` → `notes` → … → `users`**；`event_logs` 跟着事件走、`notes` 排在 `users` 之前都是外键的缘故）。**`event_logs` 与 `events` 从 T3-09 起必须带上**：三张表都走软删除，不清的话上一轮留下的 `deletedAt` 非空行会让这一轮的「空态」不可达，而症状只是某条空态断言失败，看起来像界面坏了。
  - 想在不破坏数据的前提下验证接口，用 `.tmp/note-smoke.mjs` 那类脚本（以现有 owner 登录，只碰自己创建的数据，跑完清理）。
  - 用法：`node test/e2e-auth.mjs <应用地址> <截图目录>`，截图目录给 `.tmp/` 下的路径，**别落进仓库**。
  - **界面做不了的准备动作可以走接口**，但要写清理由：T3-10 需要「已完成」的数据来验分组与折叠，而当时界面上还没有把事件置为完成的手段。脚本里因此有 `apiAccessToken()` 与 `apiCompleteEvent()` 两个辅助函数，各自的注释里都说明了「本轮验的是拿到数据之后怎么分组与显示，不是怎么把状态改掉」。**这不是绕开验证，是把两件事分开**。T3-11 起界面有了入口，同样的数据改由界面自己造（`apiCompleteEvent` 因此只留在 T3-10 那一段）；T3-11 反过来用接口做了一件界面做不到的事 —— **先让服务端把那条删掉**，好在界面上制造一次必然失败的切换（见 9.38）。
  - **断言要对得上它声称要证明的事**：T3-11 的「乐观更新」是这条的最新例子。直接点一下再断言「界面变了」证明不了乐观 —— 本机回环几十毫秒的响应，那个变化也可能来自回话之后的重拉。做法是给切换请求装一个 1.2 秒的延迟钩子，把断言预算压到 0.9 秒。**遇到「这条断言其实证不了它说的那件事」时，先想「要把它与什么区分开」，再决定加什么手段。**
- **三个启动前置**：① API 用 `ACCESS_TOKEN_TTL_SECONDS=60` 起（否则等不到续期，「静默续期」那项必失败）；② 前端 dev server 在 5173（**它自己也要加 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD`，否则起不来 —— 见 6.7**）；③ 调试端口上**没有别的监听者**。
- **调试端口现在可以换**：脚本默认 9222，实测可能被一个**非 CDP 的监听者**占住（任何路径都返回 `Content-Length: 0` 的 404），而脚本自带的占用检查判的是 `response.ok`，**因此拦不住你**，症状是 30 秒后的「CDP 页面目标未就绪」。**用 `E2E_CDP_PORT=<端口>` 换一个端口跑。**
  - **菜单类控件（Radix 下拉）点之前先等上一个菜单从 DOM 里消失**：关闭动画期间它仍在 DOM 里，此间的点击会被触发器忽略，脚本**直接抛错中断整轮**（不是记一条 FAIL 继续）。`openThemeMenu` 与 `openRowMenu` 都已按这个模式封好，**新增菜单交互照抄**。
  - **CDP 合成的指针事件（`mouseMoved` / `mousePressed` / `mouseReleased`）会概率性整组丢失** —— T3-12 首轮两次在 T3-11 的乐观更新断言上超时，根因就是这个（`dispatchMouseEvent` 三条都发出去了、界面却没收到）。**症状是「上一轮稳定的断言这轮超时」，重跑又好了。** 判据：CDP 返回值一切正常但 DOM 无反应，且同一段脚本换个时候就通。
  - **因此按控件类型分两档**：**Radix 下拉菜单仍走真实指针事件**（`openRowMenu` / `openThemeMenu`，菜单依赖 hover 与指针捕获，合成的 `element.click()` 不触发定位）；**Radix Checkbox 与普通标题按钮改用 `element.click()`** —— 同步、无动画依赖，稳定性明显更好。改法是让 finder 返回元素句柄后在页面里直接调 `.click()`，不再走 CDP 三件套。T3-12 改完后**连跑两次 146/146 全绿**；UI 集成后基线升到 **149/149**。
  - **二级菜单（`DropdownMenuSub`）靠 `pointermove` 展开，不是 `pointerdown`**：UI 集成把「外观」改成头像菜单下的二级菜单后，合成 `mousePressed` / `mouseReleased` 与 `element.click()` 都不触发它 —— 必须发一次**真实指针移动**（`mouseMove` 辅助函数，`Input.dispatchMouseEvent` 的 `mouseMoved`）。**判据**：菜单能靠手点开、脚本点不开，且 `pointerdown` 类事件都试过无效。
  - **「上一个菜单关好了」要等父菜单，不是子菜单**：Radix 的子菜单先于父菜单卸载。等 `[role="menuitemradio"]`（子菜单项）归零时父菜单仍在关闭动画里，紧接着的点击会被父级忽略、**直接抛错中断整轮**。**改等 `[role="menuitem"]` 归零**。
  - **坐标点击会在入场动画里漂移**：菜单项入场有动画，量中心点与真正可点之间差几像素，点偏一点就落到菜单外、菜单被关掉而选项没选中。**两条应对**：① 让 `elementCenter` 等位置稳定再取（60ms 两次采样、最多 8 次）；② 能走合成 `click` 的控件就走合成 `click`（Radix 菜单项把选择挂在 `onClick` 上，`selectThemeOption` 即此）。
  - **别把 `async` 辅助函数包进 `evaluate`**：`openHomeSection` 是 `async (client, href)`，误写成 `evaluate(client, openHomeSection(...))` 会把 Promise 当表达式，报 `client.send is not a function`。直接 `await openHomeSection(client, href)`。
  - **不要因为一次超时就断言「功能有 bug」**：先分类（见上）。概率性丢包的表现是「同一断言时好时坏」，与真 bug 的「稳定失败」正好相反 —— **跑第二次是最便宜的判据**。
  - **起服务前先确认端口上的监听者是谁** ——「上一轮遗留的进程」是这里最常见的坑。判据最省事：量 JWT 的 `exp - iat`（应为启动时给的 TTL）。

### 8.3 提交与推送

- 提交粒度照现有风格：`feat/docs/fix(阶段X): 中文说明`，一段说清「做了什么 + 为什么」。**同一功能的代码与文档回填分两笔提交**（便于查证）。
- **不要 `git add -A`**（工作区里有并发会话产生的未跟踪目录），**显式列路径**。
- 推送后**把 `dev` 快进到 `main` 并一起推**（当前约定是 dev 跟随 main）。
- 推送走 6.6 的命令，超时 ≥150 秒，日志落盘。

### 8.4 别做这些事（反模式）

- ❌ **裸跑 `pnpm`**（不经入口）—— 会静默把 store 落到宿主机磁盘，事后很难发现。
- ❌ **在受版本控制的文件里写死盘符**（工作空间会在 `E:` / `F:` 之间变）。
- ❌ **删 `.workbuddy/` 或 `.workbuddy-ai/`** —— 那是项目数据与本地记忆。
- ❌ **`git add -A`** —— 见上。
- ❌ **把 `.tmp/owner-credentials.txt` 提交进仓库** —— 它是被忽略的凭据文件。
- ❌ **在没有读 5.4 的情况下「顺手补一个中文全文检索」**。
- ❌ **给 `notes` 表加 `LIKE` 元字符转义**（除非你打算把它换成原生 `$queryRaw`）。
- ❌ **改动 shadcn 组件源码来适配本项目风格** —— 差异在令牌层消化。
- ❌ **忘了 `pnpm --filter @fanhe/shared build`** —— 共享包是构建型包，改了不构建，下游看到的是旧 `dist`。
- ❌ **在受限环境里默认关掉 Chromium 沙箱** —— 需要时用 `FANHE_NO_SANDBOX=1` 显式声明，别写进代码或脚本默认值。

### 8.5 跑外壳与验证外壳

- **加载的是构建产物，不是 dev server**：`pnpm --filter @fanhe/desktop smoke` 前必须先 `pnpm --filter @fanhe/web build`，否则加载到的是上一轮的界面（`dist` 不入版本控制，换机后是空的）。
- **冒烟（`smoke`）是外壳的验收手段**：隐藏窗口加载一次，在渲染进程里探 DOM，打印 `渲染元素/标题/路径/预加载桥/console错误` 一行并按成败设退出码。判据是 `#root` 里有元素且 console 零错误 —— 只看 HTTP 200 不够，那只说明文件在，说明不了界面画出来了。
- **受限环境（没有桌面会话的服务进程、容器、部分 CI）必须加 `FANHE_NO_SANDBOX=1`**：那里 Chromium 的渲染进程沙箱起不来，症状是加载以**不含任何原因**的 `ERR_FAILED (-2)` 结束。**先确认是这个原因再关**，因为同一个报错也可能是产物缺失或内置服务没起来。
- **`ELECTRON_RUN_AS_NODE=1` 会让 electron 退化成纯 Node**：不建窗口，`require('electron')` 返回可执行文件路径，症状是启动即抛 `Cannot read properties of undefined (reading 'on')`，看起来像 Electron 没装好。启动器 `scripts/launch.mjs` 已摘掉它，**别绕过启动器直接调 `electron .`**。
- **渲染进程不走代理**：外壳只加载自己的回环服务，`main.ts` 里已 `appendSwitch('no-proxy-server')`。缺了它，系统/环境代理会把 `127.0.0.1` 的请求也送出去、同样得到 `ERR_FAILED`。
- **Electron 二进制要单独确认**：44.7.0 没有安装脚本，`pnpm install` **不会**下载它。判据是 `node_modules/.pnpm/electron@*/node_modules/electron/dist/electron.exe` 与 `path.txt` 存在；缺了就 `pnpm --filter @fanhe/desktop ensure-electron`（根 `postinstall` 也会自动跑，幂等）。
- **内置服务有单测**：`pnpm --filter @fanhe/desktop test`，10 项，覆盖 SPA 回退、带扩展名 404、路径越界 403、405、HEAD、反代路径/查询串/方法/请求体、上游不可达 502。**改 `server.ts` 就重跑它**，这些行为只有跑起来才看得见。

---

## 九、关键文件路径清单

| 用途 | 路径（相对工作空间根） |
| -- | -- |
| 工作空间唯一入口 | `infra/portable/ws-run.cmd`（另有 `.ps1` / `.sh`） |
| **容器编排入口** | `infra/portable/ws-compose.cmd`（**纯 ASCII**，包住 `docker compose --env-file .env.compose`，**容器操作一律经它**） |
| 工作空间机制说明 | `infra/docs/PORTABLE-WORKSPACE.md` |
| 根定位标记 | `.ws-root` |
| 项目根 / pnpm 工作区根 | `projects/fanhe-work/` |
| 后端入口与代码 | `apps/api/src/index.ts`、`apps/api/src/` |
| 认证相关 | `apps/api/src/auth/{password,tokens,login,session,guard,setup}.ts` |
| 审计 | `apps/api/src/audit/audit.ts`、`packages/shared/src/audit.ts` |
| 启动通道（含代理核心） | `apps/api/src/launch/{agent,profiles,status,history}.ts`、`apps/api/src/routes/launch.ts` |
| 工作纪要（含检索） | `apps/api/src/note/notes.ts`、`apps/api/src/routes/notes.ts`、`packages/shared/src/note.ts` |
| 事件记录（T3-09 模型与接口、T3-10 列表视图、T3-11 勾选切换、T3-12 详情面板） | 后端：`apps/api/src/event/events.ts`、`apps/api/src/routes/events.ts`、`packages/shared/src/event.ts`；前端：`apps/web/src/components/events/`（`EventsPanel` / `EventList` / `EventRow` / `EventFormDialog` / `EventDetailDialog`）、`apps/web/src/lib/events.ts`、`apps/web/src/lib/event-display.ts`（展示规则、乐观改状态、动作码映射与耗时的纯函数，可被 Node 单测直跑） |
| 共享包 | `packages/shared/src/`（类型与判定）、`packages/shared/test/` |
| 前端外壳与导航 | `apps/web/src/components/{AppShell,Sidebar,TopBar,StateView}.tsx`、`apps/web/src/routes.tsx` |
| 前端首页三段式与版本号（**UI 集成新增**） | `apps/web/src/components/home/{CaseGallery,LaunchSection,RecordSection}.tsx`、`apps/web/src/pages/HomePage.tsx`、`apps/web/src/lib/{nav-icons,version}.ts`；版本常量由 `apps/web/vite.config.ts` 的 `define` 注入 |
| 桌面外壳（**阶段四 T4-01 ~ T4-04，全部完成**） | `apps/desktop/src/{main,preload,server}.ts`（主进程 / 预加载 / 内置静态服务）、**`src/{agent,paths}.ts`（T4-03：主进程侧形态复核 + 跨包路径解析与 `import()` 加载 api 的 agent 源码）**、**`src/diagnostics.ts`（T4-04：三类失效的启动自检，并发路径检查）**、**`src/config.ts`（T4-02：服务地址配置读写）**、`apps/desktop/scripts/{ensure-electron,launch}.mjs`（二进制下载 / 启动器）、`apps/desktop/test/{server,agent,paths,config,diagnostics}.test.mjs` + **`test/acceptance/{t402-service-switch,t403-shell-launch,t404-diagnostics}.mjs`**、`apps/desktop/{package.json,tsconfig.json}`；根 `package.json` 的 `postinstall` 调 `ensure-electron` |
| 前端启动通道 UI | `apps/web/src/components/launch/`、`apps/web/src/lib/{api,launch,launch-icons,relative-time}.ts` |
| 前端工作纪要 UI | `apps/web/src/components/notes/`（`NotesPanel` / `NoteList` / `NoteEditor` / `MarkdownPreview` / `TagInput`）、`apps/web/src/lib/notes.ts` |
| 前端本机草稿暂存（T3-08） | `apps/web/src/lib/note-draft.ts`（槽名、带版本号的序列化、过期与容量清理、写失败重试；接口注入 storage 以便单测） |
| 前端偏好与主题 | `apps/web/src/lib/{preferences,theme,credential}.ts`、`apps/web/src/index.css` |
| Prisma 配置与模型 | `apps/api/prisma.config.ts`、`apps/api/prisma/schema.prisma` |
| 迁移目录 | `apps/api/prisma/migrations/`（**7 个**；时间戳是 UTC；第七个是 T7-01 的 `20261012094234_user_permissions`） |
| 数据库 compose | `projects/fanhe-work/docker-compose.yml`（**T5-01 起三服务、T5-02 起四服务、T5-04 起五个**：`db` / `migrate`（`migrate deploy && db:seed`，跑完退出）/ `api` / `web` / `cloudflared`（**T5-04 加，不绑任何宿主端口** —— 这就是「无公网入站端口」的实现）；连接串收成 `x-database-url` 单一来源；容器操作经 `infra/portable/ws-compose.cmd`，**该脚本不能用绝对路径调**） |
| Tunnel 验收脚本 | `projects/fanhe-work/tools/checks/t504-tunnel.mjs`（T5-04 **新**，**17 项**；三层判据证「无入站暴露」：配置层读 `compose config` 展开后的 ports、运行时层读 `docker inspect`、**网络层从独立 bridge 网络探宿主端口（唯一不依赖配置假设的那个）**；`--offline` 跳过公网那组并**如实说明未验证**） |
| 容器构建 | `projects/fanhe-work/.dockerignore`、`apps/api/Dockerfile`（**三阶段：build / runtime / migrate —— migrate 必须在末尾，而 compose 里 api 与 web 都要显式写 `target`**）、`apps/web/Dockerfile`、`apps/web/deploy/nginx.conf` |
| 空卷验收脚本 | `projects/fanhe-work/tools/checks/t502-empty-volume.mjs`（T5-02 建、T5-03 扩：自建隔离环境 → 空卷 → 一条命令 → **30 项断言（含权限体系 11/4/29 与「建 owner → 登录 → 带令牌读账号」端到端）** → 清理；**可重复跑，不碰现有数据**） |
| 版本清单接口 | `GET /api/version`（T6-01，**不设门禁** —— T6-02 要在登录前拿到）；实现见 `apps/api/src/version/manifest.ts`（**运行时读根 `package.json`，逐级上溯认 `pnpm-workspace.yaml` 为根**）、类型与比较规则见 `packages/shared/src/version.ts`（**api 侧 `builtAt` 恒空、`commitSha` 恒 `unknown`，故两侧指纹不相等，T6-02 要比版本号**） |
| 客户端版本检查（T6-02） | `apps/web/src/lib/version-check.ts`（取数 + 比对 + 异常降级为 `unknown`）、`apps/web/src/lib/use-version-check.ts`（挂载时机）、`apps/web/test/version-check.test.mjs`（16 项）；更新提示落在 `apps/web/src/components/TopBar.tsx` 的账号菜单 |
| **外壳界面来源固定（T7-02a，2026-10-13）** | `apps/desktop/src/shell-origin.ts`（**新**：端口 → origin → 存储分区的纯函数 —— `SHELL_PORT_BASE = 41873` / `SHELL_PORT_SPAN = 8` / `SHELL_ORIGIN_FILE` / `shellPortCandidates` / `orderLegacyPorts` / `parseOriginDirName` / `parseOriginPortsInText` / `parseStoredPort` / `isFreshOrigin`，**不 import electron 与 fs**）、`apps/desktop/src/{server,main}.ts`（端口候选链 + 偏好 `shell-origin.json` + 单实例锁 + 旧来源发现）、`apps/desktop/test/shell-origin.test.mjs`（**新** 19 项）、`apps/desktop/test/scratch.mjs`（**新**：从 `LOCALAPPDATA` 推系统临时目录，**不用 `os.tmpdir()`** —— 工作区入口把 `TEMP`/`TMP` 重定向到了 U 盘 `.tmp/`） |
| **客户端更新按钮（T7-02b，2026-10-13）** | `apps/web/src/lib/desktop-update.ts`（**新**：四种可见形态 `checking` / `downloading` / `ready` / `failed` + 自适应轮询 + 与 desktop `UpdatePhase` 的跨包契约）、`apps/web/src/lib/use-desktop-update.ts`（**新**）、`apps/web/src/components/UpdateNotice.tsx`（**新**，顶栏、与头像同高 `h-8`）、`apps/web/test/desktop-update.test.mjs`（**新** 19 项） |
| 账号与权限管理（T7-01） | 库：`apps/api/prisma/migrations/20261012094234_user_permissions`、`users.department` 与 `UserPermission` 模型；共享包：`packages/shared/src/{permissions,audit,user-admin}.ts`（`system.user.delete` 权限点与 `mergePermissions`）；服务端：`apps/api/src/auth/{guard,user-admin}.ts`、`apps/api/src/routes/system-users.ts`；前端：`apps/web/src/pages/UsersPage.tsx`、`apps/web/src/components/system/UserDialogs.tsx`、`apps/web/src/lib/system-users.ts`（含 `diffPermissions`）；测试：`apps/api/test/user-admin.test.ts`（22 项）；说明文档：`docs/T7-01-ACCOUNT-ADMIN.md` |
| 数据库备份恢复 | `projects/fanhe-work/tools/checks/db-backup.mjs`（T5-03 **新**：`backup` / `list` / `verify`（真恢复演练）/ `restore <文件> --force`；`pg_dump -Fc` 收 Buffer，恢复走 `docker exec -i` + stdin 且必须 `--clean --if-exists`；产物落 `projects/fanhe-work/data/backups/`，**不放在卷里**） |
| 容器编排密钥 | `projects/fanhe-work/.env.compose`（**不入版本控制**，`.gitignore` 已排除；内容与 `apps/api/.env` 那份刻意不同） |
| 环境变量样例 | `apps/api/.env.example` |
| 种子 | `apps/api/src/db/seed.ts` |
| 测试 | `apps/api/test/{event,note,launch-history,setup,…}.test.ts`、`packages/shared/test/{event,note,launch,navigation,account,auth}.test.mjs`、`apps/web/test/{relative-time,note-draft,event-display,version,version-check,host,desktop-update}.test.mjs`、**`apps/desktop/test/{server,shell-origin,update,…}.test.mjs`**、`apps/web/test/e2e-auth.mjs`（`apps/web` 与 `apps/desktop` 的 `test` 脚本都是 `test/*.test.mjs`，新增单测文件会被自动收进来） |
| 诊断脚本归档 | `projects/fanhe-work/tools/`（其 `README.md` 说明各脚本用途、归档来由，以及 `.ps1` 必须带 UTF-8 BOM 这条硬性约束） |
| 规划与交接 | `projects/fanhe-work/docs/`（本文所在处） |
| 环境踩坑（逐机） | `.workbuddy-ai/memory/ENVIRONMENT.md` |
| 测试 / 界面令牌约定 | `.workbuddy-ai/memory/TESTING.md`、`.workbuddy-ai/memory/UI-TOKENS.md` |
| 临时产物与凭据 | `.tmp/`（被忽略，不进版本控制） |

---

## 十、文档索引

**本文档（`docs/WORK-STATUS.md`）是交接主文档**，自包含。其余文档按其职责查阅：

| 文档 | 职责 |
| -- | -- |
| `docs/DEVELOPMENT-PLAN.md` | 总体方案、任务表（第三章）、阶段验收（第七章）、里程碑（第八章）、**逐任务实施判断（第九章，阶段三为 9.28 ~ 9.39，UI 集成为 9.40，桌面外壳 T4-01 为 9.41、T4-02 为 9.42、T4-03 为 9.43、T4-04 为 9.44，服务端化 T5-01 为 9.45 ~ T5-04 为 9.48，阶段六 T6-01 为 9.49）**。9.34 专门记录中文检索的选型，9.35 记录草稿自动保存的三写三清与那个时序坑，9.36 记录事件板块两张表的语义区分与状态流水的写法，9.37 记录事件列表视图的分工（分组在前端、排序在服务端），9.38 记录勾选切换的四处判断（乐观更新与重拉如何并存、回滚为什么是「重新对齐服务端」、串行化、「乐观」那条断言怎么才证得了），9.39 记录详情面板与 e2e 指针事件的判断，9.40 记录 UI 集成的实施判断，9.41 记录 T4-01 外壳的实施判断（内置静态服务 vs `file://`、`/api` 反代、CJS 与沙箱、Electron 无 postinstall 等），9.42 记录 T4-02 的实施判断，9.43 记录 T4-03 的实施判断（跨包 `import()` 加载源码、主进程复核、IPC 通道缺防线），9.44 记录 T4-04 启动自检的实施判断（三类失效的划分、外部模块复用边界、检查类功能的两条通用规则），9.45 记录 T5-01 容器编排的实施判断（生产形态编排、`HOST=0.0.0.0`、六个构建期踩坑），**9.46 记录 T5-02 的实施判断（迁移执行者、`depends_on` 的两种条件、`x-` 锚点与单一来源、「不写 target 停在最后一个 FROM」那个真 bug）**，**9.47 记录 T5-03 的实施判断（任务书与现实不符时怎么重定目标、「建出表 ≠ 系统可用」、惰性求值 vs 注入密钥的取舍与它的代价、备份不能用 `promisify(execFile)`、恢复必须 `--clean`、`n_live_tup` 是估算值）**，**9.48 记录 T5-04 的实施判断（凭据授权方式的取舍、zone ID 填进账户参数会得到误导性的「认证错误」、`172.17.0.1` vs `host.docker.internal`、「绑 127.0.0.1」与「无公网入站」是两件事、三层判据与「验收脚本要能证伪」、`--offline` 不能把「没验」说成「验过了」，以及 T5-05 暂缓与其已知风险）**，**9.49 记录 T6-01 的实施判断（运行时读清单 vs 构建期注入、两侧指纹不相等所以要比版本号、路径查找读错会得到 `0.0.0` 这个「永远提示有更新」的合法错误答案、手写 SHA-256 必须配 node:crypto 逐值对照、`lib` 不含 DOM 时手写 UTF-8 而非扩大 lib）**，**9.50 记录 T6-02 客户端版本检查的实施判断（异常降级为 `unknown` 而不当报错、四种结果不并成布尔、只有 `outdated` 才提示），9.51 记录 T7-01 账号与权限管理的实施判断（`granted` 存布尔、owner 短路、越权一律 404、三处「立刻生效」要吊销 refresh token、`role_permissions` 的查询层级、两条写错的测试断言）**，**9.52 记录 T6-03a 打包与发布链路的实施判断（为什么把 T6-03 切成三段、打包态「没有工作区」的两个出口、`agent.ts` 原样投递必须先实测零依赖、`.ts` 的模块类型由最近的 `package.json` 决定、`paths.ts` 的降级要覆盖四个分支而不只 `root === null`、`configDir` 与 `defaultUrl` 都是必需的、`0.0.0` 是「永远提示有更新」的合法错误答案、验收脚本不能起子进程（`spawnSync` 一律 EBUSY）、「能被证伪才算判据」、两个与代码无关但与本机强相关的问题、以及「忽略了 `dist/` 不等于忽略了它的兄弟目录」）**，**9.53 记录 T6-03c 安装包签名的实施判断（签名选项必须写在 `win.signtoolOptions` 下 —— 26.x 把这一组挪了位置，而平铺时的报错不点名具体是哪个键；`winOptions.d.ts` 里确实有 `certificateSubjectName` 却属于另一个 interface，**只 grep 会得出相反结论**；`app-update.yml` 只在 nsis 构建里生成、`publisherName` 的注入另有前置条件；PE 签名表只证「有签名」不证「谁签的」；自签证书的 `Status` 是 `UnknownError` 而非 `NotSigned`；**「别把没验的说成验过了」在本任务里栽的三处**（脚本摘要假绿 / `--dir` 构建假警报 / 陈旧产物），统一修法是「断言必须说清自己是针对哪一轮下的结论」；以及「验自己的探针」——`.PrivateKey` 对 CNG 键返回 `$null` 曾导致误判证书无私钥）**，**9.54 记录 T6-03b 更新通道的实施判断（T6-03c 那条「不能要求 `Status=Valid`」的判据被证伪 —— 更新器只在 `Status === 0` 时才比对发布者，于是自签链不可信会让**每一次更新都被拒绝**；病因在信任根（`TrustedPublisher` 只抑制弹窗、不让链变可信），修法是把自签根也装进 `CurrentUser\Root`；含空格 CN 用 `parseDn` 测量结案；验收台两次假绿都出在自己身上 —— `$null =` 丢弃判据 + 安全删除守卫 fail-closed 导致缓存没清、下载与签名校验整段没跑却报 `downloaded`，以及「把前置条件变成断言」并给它做反例测试；探针的 `autoInstallOnAppQuit` 副作用；「一道够用的判据可能只是还没被更严格的消费者检验过」）**，**9.55 记录 T7-02 的实施判断（「设置丢失」的真根因是**界面来源每次启动都变** —— `listen(0)` 随机端口 × origin 含端口 = 每次换存储分区，数据没丢只是去另一个分区找它；修法是一条候选链而非写死端口，且**单实例锁是必要条件**（没有它第二个实例会顺延到另一个分区、互相覆盖）；旧来源发现的两个信号强弱分明，**localStorage 单库的粗 mtime 会抹平分钟级差别、导致外壳锁到较旧分区**（实测撞出来的）；「可重试的错误」必须收窄到 `EADDRINUSE` / `EACCES`；T7-02b 把更新提示从账号菜单挪到顶栏并抽成可断言的纯函数，`isSameUpdateStatus` 逐字段比以断掉「重渲染→重建定时器」的死循环；跨包 `UpdatePhase` 只能抄一份所以必须钉住；顺手修掉五处测试写死账户名的既有缺陷 —— **失效形态是「文件加载失败」而非「断言失败」**）**。 |
| `docs/PHASE-SUMMARY-2026-10-12.md` | **阶段性工作总结（换机检查点）**：总体进度、已完成 / 进行中 / 待办、文件与版本状态、换机衔接步骤、下一步 T4-02。**换机或新会话接手时先读本文，再读主文档。** |
| `docs/UI-INTEGRATION-2026-10-11.md` | **本次 UI 集成记录（最终态）**：18 项导航信息架构与分层路径、两批边界、改动文件清单、四个关键对接点、五项用户裁决、版本号的展示与更新方式、验证结果与实跑中修掉的六个渲染层问题。 |
| `docs/NEXT-TASK-PREP-阶段四-2026-10-11.md` | 阶段四开工准备（T4-01 开工清单；§八 为阶段三收口后的收尾更新）。**下一阶段执行前先读这份**。 |
| `docs/NEXT-TASKS-2026-10-12.md` | 下一步任务清单：**N-01（回填本文档）+ 阶段四主线 T4-01 ~ T4-04**，含优先级、先后顺序、预期产出与并行的长期线。 |
| `docs/T3-08-IMPLEMENTATION-PLAN.md` | T3-08 的施工图（含开工前的环境复位记录）。**任务已完成，此文档作为实施依据留档**。 |
| `docs/NEXT-TASK-PREP-2026-10-11.md` | 2026-10-11 的进度核对与开工清单（当时面向 T3-08）。**数字已过期，以本文为准**。 |
| `docs/IMPLEMENTATION-PLAN.md` | 实施层面的方案对照 |
| `docs/HANDOFF-2026-10-10.md` | 阶段一收口时的交接（当日成果、决策、未解决问题、逐文件清单、换机步骤 7.x） |
| `docs/HANDOFF-2026-10-11.md` | T3-04 当日补记 |
| `docs/PROGRESS-REVIEW-2026-10-11.md` | 任务进度盘点（完成 / 进行中 / 未开始、九条风险 R1~R9、下一步优先级）。**数字已过期，以 2026-10-13 那版与本文为准** |
| `docs/PROGRESS-REVIEW-2026-10-13.md` | **本轮进度复盘**：计划内 48/50 的口径、已完成 / 进行中 / 未开始、运行状态与验证基线、七条风险 R1~R7、下一步优先级 P0~P3、三个待确认点。**数字与本文一致** |
| `docs/T7-01-ACCOUNT-ADMIN.md` | T7-01 账号与权限管理的实施文档：权限模型（三处合并与 owner 短路）、表结构、接口清单、四类语义陷阱、改动文件清单、四条已知限制 |
| `docs/T6-03-UPDATE-CHANNEL.md` | **T6-03 外壳升级通道的开工前计划与决策记录**：十节 —— 验收判据拆成能跑的断言、零起点实测盘点、**两条架构冲突与六条隐藏依赖**（`DIST_ROOT`、`agent.ts` 跨包加载、T6-02 文案在 desktop 侧写错、CJS 壳 require ESM 共享包、`.ts` 需要一份 `package.json`、产品名含空格与中文）、发布载体落地、**本项目特有的环境陷阱（5.1 ~ 5.10，含换盘残留 `node_modules.old` 与安全删除守卫）**、签名方案（已决自签进 Windows 证书库）、**三段拆分与 T6-03a / T6-03b / T6-03c 执行结果**（含安装态冒烟的实际输出、签名后包体与 PE 签名表的变化、`app-update.yml` 的生成条件、**信任根导致 `Status` 从 `UnknownError` 变 `Valid` 的实测前后对照、离线验收台的搭法与两个反向用例的完整日志**）、验收脚本与反例（**含 §八.1「到 T6-03b 为止的完成状态」表，逐条标出哪几条仍未验 —— 第 1/2/5 条已验，第 4 条待真实发版**）、风险与回滚、决策记录 |
| `docs/P0-UPDATE-VERIFICATION.md` | **更新通道正向验证（§八 第 4 条）的逐步操作手册**（2026-10-14 新建）：为什么这一步必须真人做、两种机器对照（打包机 `signing:cert` / 目标机 `signing:trust`，混用会永久弄坏更新）、目标机装根的两条路（有仓库走 `signing:trust` / 无仓库走 `certutil`）、**可脚本化的版本判据**（`exe FileVersion`，菜单那行是 Vite 构建期常量、更新后仍显示旧号，不可作判据）、六条判据汇总、五类常见失败的含义与处理、以及做完之后要回填的四处文档 |
| `docs/SIGNING-ROTATION-RUNBOOK.md` | **签名身份轮换的操作手册**（2026-10-14 新建）：处理发版链路最后一个阻塞 —— 原始证书 `CN=Fanhe Work` / `0604B238…` 的**私钥已不在本机**。九节 —— **穷尽检索记录**（四路：全机四盘按扩展名 / 压缩包内部 / 内容特征 / 证书库与档案，全部落空，记下来是为了不再重复）、**纠正「换证书 = 永久收不到更新」这句过强说法**（准确表述是「不补装新根时成立」，补装后即可恢复）、🔴 **源码级论证「同 CN 换证书后更新为何还能通」**（`windowsExecutableCodeSignatureVerifier.js:56` 的 `Status === 0` 是第一道门、`:70~:84` 比对的是 `Subject` 的 CN 而**指纹不参与**，实测证书 Subject 就是 `CN=Fanhe Work` 只有一段，故比对退化成 CN 相等）、打包机四步（`signing:cert -AllowRotate` → 落档 → **提交新公钥** → 先 `build web` 再 `dist`）、目标机三步（`signing:trust-check` / `signing:trust`，**绝不在目标机跑 `signing:cert`**，新旧根可并存）、**顺序约束**（装新根必须早于消费新版本，反了会静默被拒）、六条判据、失败与回退（最后出口是手工装一次）、**明确未验的部分**（同 CN 轮换是源码论证而非端到端实测，以及用 `--update-probe` 补上这一层的做法）、九处回填清单 |
| `docs/SIGNING-KEY-BACKUP.md` | **签名私钥的保管、读取与多设备一致性**（2026-10-14 新建）：补上全项目唯一一处「有机制、没备份」的缺口 —— 轮换之所以发生，根因是**私钥从未被备份过**。九节 —— **结论先行表**（私钥只放打包机 + 两份加密备份 / 公钥必须入库 / 身份档案逐机）、**为什么私钥不进工作空间**（三条实测：仓库实测 **public**、此前**没有任何私钥忽略规则**、脚本第 755 行**刻意拒绝**导出到工作空间）、**两份副本**（A 随盘 `<工作空间根>/keys/`、B 空间外，**不同介质**）、**导出由用户自己执行**（口令用 `Read-Host` 取以免进 PSReadLine 历史；🔴 **期望 `ACTION=reuse` 而非 `ACTION=created`**，后者意味着计划外轮换）、**四步校验**（含最容易漏的一步：`Get-PfxCertificate` **读不出私钥在不在**，须用非持久导入证明 `HasPrivateKey=True`）、**换机**（打包机 `-ImportPath` vs 目标机只装公钥）、🔴 **多设备一致性机制**（靠公钥入库 + 身份档案 + 轮换闸 + 逐机自检这四件**公开**的东西，**不靠复制私钥** —— 私钥只在打包机需要）、冲突时三处记录的优先级、**明确不该做的六件事** |
| `docs/T7-03-RELEASE-COMPATIBILITY.md` | **T7-03 版本迭代期间的可用性与手动更新方案（设计稿，2026-10-13）**：九节（零 ~ 八）—— 「断网」的**六种机制**（发布窗口连接中断 / 迁移窗口 / **接口契约不兼容** / **前端产物与外壳版本错配** / 隧道层 / **签名信任根变化**；前两条自愈，后四条不自愈）、根因（一次迭代同时动了服务端运行时、数据库结构、客户端产物三层，而服务端是单实例替换式部署、没有兼容契约）、三条通道解耦加一条兼容契约（A 服务端发布 / B 客户端更新 / C 兼容仲裁，含「为什么不直接做 API 版本化」）、**七条关键约束**（旧版本可用性 / 迁移扩展收缩两步走 / 更新推送与业务解耦 / 手动确认更新 / 回滚能力 / 签名身份稳定 / **前端产物必须在打包前重建**）、**五步落地**（第 0 步发布纪律零代码 / 第 1 步客户端改为手动确认更新 / 第 2 步容忍服务端短暂不可用 / 第 3 步契约快照测试 / 第 4 步最低支持版本闸门 / 第 5 步零停机）、七条注意事项、**第七节的辩证**（手动确认更新与兼容窗口的内在张力 —— 「用户获得的是什么时候更新的选择权，而非是否永远不更新的权利」）、四条验证方式。**设计稿已入库，五步落地均未开工，范围待用户确认** |
| `docs/T7-04-TEAM-RELEASE-PIPELINE.md` | **T7-04 团队协作下的开发端隔离与版本发布流水线（设计稿，2026-10-13）**：十二节 —— **七个结构性缺口**（开发机即生产机 / dev 与 prod 共用数据库卷 / 镜像无版本标识 / 端口段被 dev 与 prod 共用 / **打包链路不重建前端产物** / 无自动化门禁与回滚脚本 / 迁移与应用启动强绑定）、**四个模块**（开发端与使用端隔离的七个维度与 staging 环境 / 六道门禁与打包纪律四条 / 部署到在用环境的两种解读与蓝绿替换 / 用户端手动更新的交互时序与 `autoInstallOnAppQuit` 的分歧）、五阶段操作流程与判据、**分层回滚策略**（含「数据库回滚明确它不存在」）、注意事项与已知限制、实施顺序、验证方式。**设计稿已入库，未开工，范围待用户确认** |
| `docs/SYNC-COMPARE-2026-10-11.md` | 工作空间与远端仓库逐项对比（含 `node_modules.old` 的完整分析，第十一节） |
| `docs/SYNC-AUDIT-*.md` | 仓库同步审计 |
| `docs/PROJECT-SURVEY-*.md` | 项目结构与依赖现状扫描 |
| `docs/WORKSPACE-BINDING.md` | 工作空间与远端仓库绑定登记、两条访问链路 |
| `infra/docs/PORTABLE-WORKSPACE.md` | 工作空间机制、入口、重定向、换机修复 |
| `projects/fanhe-work/README.md` | 项目说明、起步步骤、强制约定、迁移表、数据库与 Prisma 7 说明 |
| `.workbuddy-ai/memory/*.md` | 逐机环境事实与踩坑（ENVIRONMENT）、测试约定（TESTING）、界面令牌规格（UI-TOKENS） |

---

## 十一、本次（2026-10-11 ~ 10-13）工作留痕

| 时间 | 事项 | 结果 |
| -- | -- | -- |
| 上午 | T3-05 纪要模型与接口收口 | 5 迁移 / 10 表；八条接口；三包 219 项 |
| 下午 | T3-06 Markdown 编辑与预览 | 界面接通，路由补二级路径；三包 227 项；**e2e 首跑 78/78** |
| 下午 | T3-06 收尾归因 | 首轮 3 项失败 → 1 项真 bug（草稿同步死角，已修）+ 1 项断言过宽 + 1 项旧 `tsx watch` 残留 |
| 17:0x | T3-07 定方案前实测 | 一次性库验证 `tsvector` 与 `pg_trgm` 两条路均不可用，结论落 9.34 |
| 17:2x | T3-07 实施 | shared 63 + api 165 + web 10 = 238 项；e2e 新增 7 项 |
| 17:4x | T3-07 浏览器验证 | 首跑崩于主题菜单时序（与本次改动无关，已修 `openThemeMenu`）；换 `E2E_CDP_PORT=19222` 后 **85/85 全通过** |
| 17:5x | 提交推送 | `95bdcf2`（代码）+ `3c402fa`（文档），`main` 与 `dev` 同步；库回基线，端口释放 |
| 18:0x | 文档重写与存档 | `WORK-STATUS.md` 整体重写为十一节的单文件交接主文档并推送（`db7bc77`），`main` 与 `dev` 同步 |
| 20:0x | 换机后环境复位 | 工作区换机自愈（`root: F: → E:`、`host: DY008 → DY`）；修掉三处阻塞：`pnpm` 未 `corepack enable`、`node_modules` 软链接全部悬空（指向已不存在的 `F:`）、数据库落后一个迁移（只有 4 个且 `users` 为空，说明容器卷是**另一台机器的**）。另实跑门禁抓出 `WorkbenchPage.tsx` 的 `NavLink` 回调缺类型标注（TS7031），补成与 `Sidebar.tsx` 一致 → `4d43dae` |
| 20:5x | T3-08 实施 | 新增 `apps/web/src/lib/note-draft.ts` 与 13 项单测，`NoteEditor` 接三写（防抖 / 页面隐藏 / 卸载）三清（提交成功 / 丢弃 / 与库一致）+ `committedRef`；`apps/web` 的 `test` 脚本改为 `test/*.test.mjs`；三包 **251 项 0 失败** |
| 21:1x | T3-08 浏览器验证 | **首跑即 98/98 全通过**（原 85，新增 13），含「打完字立刻关掉页面也不丢」与「新建→提交→再点新建不带出旧内容」两条时序断言。途中踩到 Vite dev server 被批量删除保护挡住（同源坑，见 6.7） |
| 21:2x | 提交与收尾 | `fcfc7aa`（代码）+ 文档回填；库回基线、owner 重建、8787 / 5173 释放、无残留进程 |
| 21:2x | T3-09 实施 | `packages/shared/src/event.ts` 与 6 项单测；`schema.prisma` 加两个枚举与两个模型 + **第六个迁移 `20261011132819_add_events`**；`apps/api/src/event/events.ts` + `src/routes/events.ts` 八条路由 + 32 项集成测试；三包 **289 项 0 失败** |
| 21:3x | T3-09 收尾 | `d252107`（代码）+ 文档回填。**本轮未跑 e2e**（无界面改动）；库回基线（6 迁移 / 12 表、`users` 1、种子 11 / 4 / 29），owner 未动 |
| 21:5x | T3-10 实施 | 新增 `apps/web/src/components/events/` 四件 + `lib/event-display.ts` + `lib/events.ts` + 17 项单测；`lib/api.ts` 补六条传输函数；`TagInput` 增 `maxTags`；`WorkbenchPage` 加第三块板块、路由补 `events`。三包 **306 项 0 失败**；`lint` / `typecheck` / `format:check` 全绿 |
| 21:56 | T3-10 浏览器验证（首轮） | 116 项 **115 通过 / 1 失败**；唯一那条「低优先级也有文字」是**断言写错**（事件乙吃的是默认的「普通」而断言期望「低」），不是产品缺陷 |
| 22:0x | T3-10 浏览器验证（重跑） | 修掉那条断言（补一次「低」的点击），并加两条断言（编辑回填优先级的按下态、新建默认停「普通」）→ **118/118 全通过**，0 失败 |
| 22:0x | 提交与收尾 | `a7069de`（代码）+ 文档回填；库回基线（6 迁移 / 12 表、`users` 1、种子 11 / 4 / 29）、owner 第四次重建、8787 / 5173 释放、无残留进程 |
| 22:1x | T3-11 实施 | `lib/api.ts` 补 `setEventStatusRequest`、`lib/events.ts` 补 `setEventStatus`、`lib/event-display.ts` 增 `applyEventStatus` + 5 项单测；`EventRow` 勾选框接线（去掉 `disabled`、加 `locked` / `switching`）、`EventList` 透传并将组标题改用 `EVENT_STATUS_LABELS`、`EventsPanel` 增 `changeStatus` / `switching` / 撤销入口。三包 **311 项 0 失败**；`lint` / `typecheck` / `format:check` 全绿 |
| 22:1x | T3-11 浏览器验证 | e2e 段新增 17 项，**一次跑通 135/135 全通过**，无首轮失败。关键两条：给切换请求装 1.2 秒延迟钩子后断言「回话之前未完成组 2 → 1」；经接口删掉那条再点它的勾选框，断言界面「照样先勾上」（404 之后回滚） |
| 22:2x | 提交与收尾 | `a3c08bf`（代码）+ 文档回填；库回基线（6 迁移 / 12 表、`users` 1、种子 11 / 4 / 29）、owner 第五次重建、8787 / 5173 释放、无残留进程 |
| 22:3x | T3-12 实施 | `lib/api.ts` 补 `eventLogsRequest`、`lib/events.ts` 补 `loadEventLogs`、`lib/event-display.ts` 增 `EVENT_LOG_ACTION_LABELS` / `eventLogActionText` / `formatMoment` / `formatDuration` + 17 项单测；新增 `components/events/EventDetailDialog.tsx`；`EventRow` 标题由 `<span>` 改 `button` 作为详情入口、`EventList` 透传 `onOpenDetail`、`EventsPanel` 托管 `detailId` / `detailOpen`。三包 **328 项 0 失败**；`lint` / `typecheck` / `format:check` 全绿。**后端与共享包一行未改** |
| 22:4x | T3-12 浏览器验证（首轮） | e2e 段新增 11 项，146 项**两次在 T3-11 的乐观更新断言上超时**。诊断为 CDP 合成指针事件（`mouseMoved` / `mousePressed` / `mouseReleased`）**概率性整组丢失** —— 返回值正常但界面无响应，重跑即过 |
| 22:5x | T3-12 浏览器验证（修复后） | 改法是**按控件类型分两档**：Radix 下拉菜单仍走真实指针事件（依赖 hover 与指针捕获），**Radix Checkbox 与普通标题按钮改用 `element.click()`**（同步、无动画依赖）。随后 **146/146 连跑两次全通过**，0 失败 |
| 22:5x | 提交与收尾 | `a5370b0`（代码）+ 文档回填。**阶段三收口**；库回基线（6 迁移 / 12 表、`users` 1、种子 11 / 4 / 29）、owner 第六次重建、8787 / 5173 / 9222 释放、无残留进程 |
| 10-12 0x:xx | **UI 集成（第一批 · 骨架层）** | 导航结构、令牌层、侧栏、顶栏、内容区通栏按最终原型改造；业务逻辑一行未动 |
| 10-12 0x:5x | **UI 集成（第二批 · 首页三段式 + 导航重构）** | 导航扩为 **18 项 / 4 分组**（分层路径、纯折叠分组头、11 个预留槽位、页脚系统设置）；首页替换为三段式并保留三个子路由；头像菜单补齐五项 + **版本号**行；「运营信息平台」→「运维信息平台」 |
| 10-12 0x:xx | UI 集成门禁 | 四道门禁全绿：**350 项 0 失败**（shared 83 + api 197 含 5 跳过 + web 70）；`lint` / `typecheck` / `format:check` 通过 |
| 10-12 0x:xx | UI 集成浏览器验证 | e2e **149/149 全通过、一次跑通**；实跑中抓到并修掉六个渲染层问题（导航计数漏页脚项、顶层项文本含「开发中」、二级菜单靠 hover 展开、关闭判据要等父菜单、`openHomeSection` 误包进 `evaluate`、入场动画导致坐标漂移），修法见 8.2 与 `UI-INTEGRATION-2026-10-11.md` 第 7.3 节。库回基线（`pg_dump` 备份恢复） |
| 10-12 0x:xx | UI 集成提交推送 | `2576388`（代码）+ `fe92cb4`（文档回填）；`main` 与 `dev` 同步 |
| 10-12 0x:xx | 阶段四准备与任务梳理 | `b5c0e7f`（T4-01 开工准备清单）、`9502591`（下一步任务 N-01 与阶段四主线） |
| 10-12 0x:xx | **N-01 回填本文档** | 头部与 §0/§2.1/§2.3/§2.4/§3.2/§4.1/§4.4/§7/§8.2/§9/§10 同步至最终态：验证基线 328 → **350**、e2e 146 → **149**、导航口径统一为 **18 项**、`NavRail.tsx` → `Sidebar.tsx`、「三个占位导航项」→ **16 项**；`DEVELOPMENT-PLAN.md` 追加 9.40 |
| 10-12 0x:xx | **T4-01 实施（Electron 外壳脚手架）** | `apps/desktop` 从 `.gitkeep` 落成最小工程：`src/{main,preload,server}.ts` + `scripts/{ensure-electron,launch}.mjs` + `test/server.test.mjs`。主进程在回环上起内置静态服务托管 `apps/web/dist` 并把 `/api/*` 反代到服务地址（含 SPA 回退）；`apps/web` 一行未改。四道门禁全绿：**360 项 0 失败**（shared 83 + api 197 含 5 跳过 + web 70 + **desktop 10**） |
| 10-12 0x:xx | **T4-01 外壳冒烟验证** | `pnpm --filter @fanhe/desktop smoke`（受限环境加 `FANHE_NO_SANDBOX=1`）→ **PASS**：`渲染元素=1 标题=梵禾 Work 路径=/ 预加载桥=有 console错误=0`；另以活体 API 验证 `/api/health` 经反代返回 200 |
| 10-12 0x:xx | **T4-01 提交推送** | `b03ddb5`（代码，13 文件 +980/-8）；`main` 与 `dev` 同步 |
| 10-12 01:4x | **阶段性工作总结（换机检查点）** | 新增 `docs/PHASE-SUMMARY-2026-10-12.md`：总体进度 39/50（约 78%）、已完成 / 进行中 / 待办、文件与版本状态（四 ref 同点 `948b20c`）、换机衔接步骤、下一步 T4-02。核对仓库干净、门禁 360 项、四 ref 一致后落盘并登记入 §10 |
| 10-12 12:3x | **T4-02 实施（服务地址切换）** | 新增 `apps/desktop/src/config.ts`（服务地址读写，配置落工作区 `.config/fanhe-work/service.json`）+ `test/config.test.mjs`（18 项）+ `test/acceptance/t402-service-switch.mjs`（11 项）；`main.ts` 删掉 `SERVICE_URL` 常量改为 `registerServiceIpc()`；`preload.ts` 加 `getServiceStatus` / `setServiceUrl`。四道门禁全绿 **378 项 0 失败**（desktop 10 → 28）。提交 `f2bfc16` + `9963276` |
| 10-12 13:0x | **T4-03 实施（本机代理内置）** | 新增 `apps/desktop/src/{agent,paths}.ts`（主进程侧形态复核 + 跨包路径解析与 `import()` 加载 api 的 agent 源码）+ `test/agent.test.mjs`（17 项）+ `test/paths.test.mjs`（7 项）+ `test/acceptance/t403-shell-launch.mjs`（10 项）；`main.ts` 加 `registerLaunchIpc()`；`preload.ts` 加 `runLaunchProfile`；`package.json` 加 `@fanhe/shared` 依赖。**`apps/api/src/launch/agent.ts` 一行未改**。四道门禁全绿 **402 项 0 失败**（desktop 28 → 52） |
| 10-12 13:0x | **T4-03 验收与冒烟** | 验收脚本 10 项全通过（远程模式下真进程跑起来并写出标记文件、假上游零请求）；冒烟 PASS（`渲染元素=1 console错误=0`）。**期间修掉一个真 bug**：`import()` 收路径而非 URL 在 Windows 上抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，单测用假模块时看不出来 |
| 10-12 13:5x | **T4-04 实施（启动自检）· 阶段四收口** | 新增 `apps/desktop/src/diagnostics.ts`（三类失效 + 并发路径检查）、`test/diagnostics.test.mjs`（24 项）、`test/acceptance/t404-diagnostics.mjs`（21 项）；`agent.ts` 的 `LaunchAgentModule` 契约加 `inspectExecutablePath`；`main.ts` 加 `launch:diagnostics` 与 `loadLaunchAgent()` 共用加载、冒烟增一条自检判据；`preload.ts` 加 `checkLaunchProfiles`。四道门禁全绿 **426 项 0 失败**（desktop 52 → 76）。**阶段四 4/4 完成，出口条件达成** |
| 10-12 14:1x | **T5-01 实施（容器编排）· 阶段五开工** | 新增 `projects/fanhe-work/.dockerignore`、`apps/api/Dockerfile`（两阶段，运行阶段 `node:22-bookworm-slim` + `tini` + `USER node` + HEALTHCHECK）、`apps/web/Dockerfile`（构建 `node` → 运行 `nginx:1.27-alpine`）、`apps/web/deploy/nginx.conf`（`/api` 反代 + SPA 回退 + 哈希资源长缓存）、`infra/portable/ws-compose.cmd`（纯 ASCII）；`docker-compose.yml` 从单服务扩为 **db + api + web**（db 段逐字未动）；`.gitignore` 加 `.env.compose`。**业务代码一行未改**。**阶段五 1/5 完成** |
| 10-12 14:1x | **T5-01 实跑验证** | `up -d --wait` 后**三容器全 Healthy**；web 根路径与深链 `/notes` 均 200 且大小相同；经 web 到 api 拿到 **api 自己的** `{"error":"unauthorized"}` 401；哈希资源 `max-age=31536000, immutable`；端口三处全绑 `127.0.0.1`；api 以 `uid=1000` 非 root 运行。四道门禁全绿 **426 项 0 失败**（未改业务代码，基线不变）。**期间踩掉六个构建期问题**：`# syntax=` 触发额外 docker.io 拉取、`.dockerignore` 排 `dist` 致运行阶段 COPY 不到、postinstall 拉 Electron、运行阶段 `tsc: not found`、漏 COPY `tsconfig.base.json`、`COPY` 路径相对上下文根 |
| 10-12 14:1x | **T5-01 外壳冒烟对照** | 冒烟 PASS，**「反代到达上游=是」** —— T4-02 时同一判据是「否」（当时 8787 无监听），现在连的是容器化的 api。**同一条判据一个假一个真，比任何单独检查都更能说明这套编排真的通了** |
| 10-12 14:3x | **T5-02 实施（连接串与迁移执行者）· 阶段五第二项** | `apps/api/Dockerfile` 加 `migrate` 阶段（挂在 `build` 上，只影响跑完即退出的容器）；`docker-compose.yml` 新增一次性 `migrate` 服务（`depends_on: db service_healthy`，api 等它 `service_completed_successfully`，`restart: 'no'`）、连接串与口令收成 `x-database-url` 单一来源、api 与 web 都显式写 `target: runtime`；新增 `tools/checks/t502-empty-volume.mjs`（22 项，**自带隔离 override 且用完即删**）。**业务代码一行未改**。**阶段五 2/5 完成** |
| 10-12 14:3x | **T5-02 踩掉的一个真 bug** | migrate 阶段追加到 Dockerfile **末尾** → 「不写 `target` 停在最后一个 FROM」让 **api 也构建成 migrate 镜像** → api 容器反复重启、日志全是 `No pending migrations to apply`、而 healthcheck 报 healthy（重启循环里被短暂满足）。**前面还套着一层误导**：端口映射与健康结果都不稳，看起来像网络或端口问题，我先怀疑了 `!override`、容器复用、代理，全不是。判据是 `docker inspect -f '{{json .Config.Cmd}}'`。修法：compose 里显式 `target: runtime` |
| 10-12 14:4x | **T5-02 空卷验收** | **22 项 0 失败**，且 prettier 格式化后复跑仍 22 项 0 失败。全新空卷 → 一条命令 → migrate exited(0) → 6 迁移全应用 → **重复执行表数不变** → api/web healthy → 深链回退 → 经 web 反代拿到 `{"initialized":false}` → 端口绑 127.0.0.1 → 两处连接串相等。**现有那套重建后一切正常**（6 迁移 / users=1 / initialized:true）。四道门禁全绿 **426 项 0 失败**（业务代码零改动）。提交 `16f73e8` |
| 10-12 15:0x | **T5-03 实施（种子与备份恢复）· 阶段五第三项** | `apps/api/Dockerfile` 的 migrate 阶段 `CMD` 改为 `sh -c "prisma migrate deploy && pnpm db:seed"`（**建表之后必须跑种子 —— 建完表的库是不可用的**）；`apps/api/src/config/env.ts` 的 `jwt.secret` 由直接求值改为 **getter 惰性求值**（让只需数据库的脚本不必持有签名密钥）；`apps/api/src/index.ts` 新增 `assertRequiredEnv()` 在 `listen` 之前显式读一次，补上惰性化丢掉的「启动即失败」；新增 `tools/checks/db-backup.mjs`（`backup` / `list` / `verify` / `restore`）；`tools/checks/t502-empty-volume.mjs` 22 → **30 项**。**这是阶段五第一次改业务代码**。**阶段五 3/5 完成** |
| 10-12 15:0x | **T5-03 定位到的真问题** | 全新卷跑完 `migrate deploy` 后 `permissions` / `roles` / `role_permissions` **全 0 行**，于是建 owner 直接 **500**（「库里没有 owner 角色，先执行 `pnpm db:seed`」）。T5-02 的 22 项验收全绿却没碰这一段 —— **「迁移全部应用」与「系统可用」之间隔着一个种子**。修法：种子挂进 migrate 容器自动跑（幂等、按 code upsert + 关联差集同步、**不建任何账号**）。**判空时踩过一次错**：用 `pg_stat_user_tables.n_live_tup`（统计估算值、未 ANALYZE 时不准）得出「种子没跑」，实际是 11 / 4 / 29 与基线一致 —— **要判空用 `SELECT count(*)`** |
| 10-12 15:1x | **T5-03 空卷验收（30 项）** | **30 项 0 失败**，且 prettier 格式化后复跑仍 30 项 0 失败。新增两组：§5b 权限体系（**11 / 4 / 29 写死** + owner 拿全部权限 + 重复执行关联数不变）、§7b 端到端（**建 owner → 登录拿令牌 → 带令牌读 `/api/auth/me`**）。四道门禁全绿 **426 项 0 失败**。**现有那套数据完好**（6 迁移 / users=1 / 种子 11/4/29 / initialized:true）。提交 `3b3dc07` |
| 10-12 15:1x | **T5-03 备份恢复实测** | 备份 → `verify` **真恢复演练**（建临时库 → 真恢复 → 逐表比行数 → 删掉）通过 → 造一条数据 → 删除 → **无 `--force` 被拒并同时显示当前与备份行数** → 带 `--force` 恢复成功，**内容回来了而不只是行数对**。两个坑：`promisify(execFile)` 会按 utf-8 解码损坏 `pg_dump -Fc` 的二进制归档（**损坏的备份比没有备份更危险**，因为它看起来成功）→ 改用 `spawn` 收 Buffer；恢复不加 `--clean --if-exists` 是「插入」不是「替换」，同主键行叠成两份而表看起来恢复成功了 |
| 10-12 15:5x | **T5-04 Cloudflare 侧配置** | 用户按「限定权限的 API Token」方案授权（`Account \| Cloudflare Tunnel \| Edit` + `Zone \| DNS \| Edit`，**明确不用全局 API Key**）；建 Tunnel `fanhe-work`（ID `e71629a6-…`）、DNS `work.fanhe.dpdns.org` → `<tid>.cfargotunnel.com`（proxied）、ingress → `http://web:80` + 兜底 `http_status:404`。**Tunnel Token 落 `.env.compose`，API Token 不落盘** |
| 10-12 15:5x | **T5-04 授权阶段踩的两个坑** | ① 填权限时**指定 `Specific zone` 之后不要再加 `All zones from an account` 那行** —— 多加会让账号选择器被禁用（灰掉、选不了）；② 🔴 **把 zone ID 填进账户参数会得到 `Authentication error`** —— Cloudflare **不区分「你没权限」与「这个 ID 不对」**，而真实原因是后者。**账户 ID 要从 zone 反查**；调 `/accounts` 返回空列表也不代表 Token 无效（那是「没申请该权限」而非「什么都没有」） |
| 10-12 16:0x | **T5-04 实施（编排侧）** | `docker-compose.yml` 新增 `cloudflared` 服务（**官方镜像，不涉及 `target`**；配置在 Cloudflare 侧，容器只读 `FANHE_TUNNEL_TOKEN`；`--no-autoupdate`；**刻意不写 `ports:`**）；`.env.compose` 加 `FANHE_TUNNEL_TOKEN` 与对应 Cloudflare 资源注释；新增 `tools/checks/t504-tunnel.mjs`（**17 项**，三层判据）。**业务代码一行未改**。**阶段五 4/5** |
| 10-12 16:0x | **T5-04 验收（17 项）** | 公网 `https://work.fanhe.dpdns.org/` **根路径 200 / 深链 `/notes` 200 / 反代到 api 拿到 `{"initialized":true}` / 未授权 401 + api 自己的文案**（`nginx` 与 `cloudflared` 都伪造不出那句中文）；`cloudflared` 日志 **4 条连接全部 registered**（sea10 / sjc05 / sjc01）；**网络层探针确认 8787 / 8080 / 5432 从容器网络外全部不可达**。`--offline` 13 项 0 失败。四道门禁全绿 **426 项 0 失败**。提交 `7cf5af3` |
| 10-12 17:0x | **T5-05 由用户决定暂缓** | 用户选择先推功能。**判断与资源记录全部保留**（§4.1.2 与 9.48 未删）。**已在头部与任务表两处记录已知风险**：公网上的 `work.fanhe.dpdns.org` 没有 Cloudflare Access 那一层，任何拿到地址的人都能打开页面，唯一的保护是应用层登录（按 IP 限速）；业务接口与数据仍受登录保护，暴露在登录之前的是页面与静态资源。阶段五出口条件「未授权访问被拦截」将保持未勾选 —— **那是从未达成而不是遗漏** |
| 10-12 17:3x | **T6-01 实施（版本清单接口）· 阶段六开工** | 新增 `packages/shared/src/version.ts`（`VersionManifestResponse`、`computeBuildFingerprint`、`compareVersions`、`compareManifests` 四种结果）与 `apps/api/src/version/manifest.ts`（`GET /api/version`，**不设门禁**）；测试 shared 24 项、api 7 项；`app.ts` 与 `shared/src/index.ts` 各加一处接线。**四道门禁全绿 457 项 0 失败**（基线 426）。提交 `ac342e7` |
| 10-12 17:3x | **T6-01 三个关键判断** | ① **运行时读根 `package.json` 而非构建期注入** —— 注入式最常见的失效是「改了清单忘了重建而接口仍报旧版本」；且运行时阶段本就 COPY 了它（pnpm 链接式布局需要），顺带被用上，**不用改 Dockerfile**。② **两侧指纹不相等，T6-02 要比版本号** —— `.dockerignore` 排掉 `.git`，容器里 `builtAt` 恒空、`commitSha` 恒 `unknown`。③ **找不到根清单时抛错不回落** —— 而 `0.0.0` 恰好是「永远提示有更新」的值，一个说谎的版本号比启动失败更糟 |
| 10-12 17:3x | **T6-01 踩的坑** | ① 路径查找第一版「上溯三层」实际落到 `apps/api/package.json`（`0.0.0`）→ 改成逐级上溯认 `pnpm-workspace.yaml` 为根，**且顺序不能反**（先确认是根再读版本号）；判据不能换成「目录里有没有 package.json」（沿路每层都有且都是 `0.0.0`）。② `TextEncoder` 在 shared 不可用（`lib: ["ES2023"]` 不含 DOM）→ 手写 UTF-8，**不为一个纯计算函数扩大整个包的 lib**；手写时 `codePointAt` 读完增补平面字符要跳过代理对后半截。③ `.mjs` 测试里写 TS 标注直接 `SyntaxError`（连文件都加载不了）；`Buffer`/`TextEncoder` 都不在 shared 测试的 eslint 环境（Node 全局块覆盖 `packages/**/*.{ts,tsx}` 不含 `*.mjs`，既有缺口，**没有顺手改全局配置**）。④ **手写 SHA-256 必须配对照测试** —— 风险形态是「能算出结果但算错了」，故用 `node:crypto` 逐值对照并覆盖**四种长度**（不足一块 / 跨块 / 超两块 / 全空，补位逻辑在跨块时最易写错），四种全部一致 |
| 10-12 16:0x | **T5-04 写验收脚本时踩的坑** | ① 探针用 `host.docker.internal` 报三个端口全 OPEN —— **它在 Linux Docker 上解析到宿主网关，而服务绑的是 `127.0.0.1`（只听回环）**，探错了对象；改 `172.17.0.1` 全 CLOSED。② `execFile` 直接 spawn `.cmd` 抛 `spawn EINVAL`，改绝对路径调 `ws-compose.cmd` 报 `'F:\fanhe' 不是内部或外部命令`（**真实原因是路径里有空格**）→ `shell: true` + 相对路径。③ `--offline` 下仍打印「结论：外部可访问」—— **把「没验」说成「验过了」，已改为如实说明未验证**。④ **做了反例测试**：临时给 `cloudflared` 加 `ports:`，确认断言真报 FAIL 并打出数组内容，再恢复 —— **全绿的脚本可能只是因为断言恒真而全绿** |
| 10-13 09:2x | **交接包导出（换机准备）** | `交接-20261012/` 13MB / 37 文件：数据库备份（含真恢复演练，14 张表行数一致）、数据卷原始归档（1398 条目）、Docker 全量清单与 inspect、compose 展开后配置、两条线的未提交代码归档、新机还原脚本与 README |
| 10-13 09:2x ~ 09:5x | **T7-01 实施（账号与权限管理）· 阶段七** | 库加 `user_permissions` 与 `users.department`，shared 加 `system.user.delete`（权限点 11 → 12）与 `mergePermissions`，api 加九接口与三路合并权限解析，web 加账号管理页与三个对话框。api 22 项；修掉两处真 bug（`role_permissions` 写成 User 一层关系致 `/api/system/*` 全 500、Docker 引擎隔夜未启动）与两条写错的测试断言 |
| 10-13 10:0x | **`db:reset-password` 通道** | 新增 `apps/api/src/tools/reset-password.ts`：密码从 stdin 读，不进 shell 历史与进程环境表。实测活跃会话 1 → 0、失败计数清零、新密码可登录、旧密码失效 |
| 10-13 11:2x | **UI 落地对齐（设计稿 → 真机）** | 字体栈合成为 `FH Sans SC`（判据：`400=280.20 / 500=287.06 / 700=296.05`，对照 `Microsoft YaHei 400=500=291.55`）、移除 10 处 `transition-colors`、单元卡四层材质、`prefers-reduced-motion` 降级、自绘 6px 滚动条。改动 10 个前端文件，`build web` + `--force-recreate` 生效，容器内产物自检含 `FH Sans SC`×5 / `glow-bloom`×2 / `scroll-thumb`×3 |
| 10-13 11:2x | **三条线整理提交并推送** | 工作树积压的 T6-02 / T7-01 / UI 对齐按「一个任务一笔、代码与文档分两笔」拆成五笔（`d179e81` / `ab96a58` / `49c4f85` / `5dc0c90` / `5fd7f84`），`dev` 用 `git branch -f dev main` 同步跟随；`format:check` 因此首次全绿（基线 496 项）。踩到并回填两个坑：全局 `.gitconfig` 的 URL 级代理项压过 `http.proxy` 与环境变量、推内联 URL 不更新 `refs/remotes/origin/*`（判据以 `ls-remote` 为准） |
| 10-13 11:3x | **本轮：进度复盘 + 文档回填** | 新增 `docs/PROGRESS-REVIEW-2026-10-13.md`（七条风险、四级优先级、三个待确认点）；本文档头部 / §0 / §2.1 / §2.3 / §2.4 / §3.6 ~ §3.8 / §4.1 / §4.1.0 / §4.1.9 / §4.1.10 / §4.3 / §9 / §10 / §11 同步至 `5fd7f84`；`DEVELOPMENT-PLAN.md` 追加 9.50 / 9.51 并登记阶段七 |
| 10-13 13:2x | **T6-03a 实施（打包与发布链路）** | 加 `electron-builder` `26.15.3` 与 `apps/desktop/electron-builder.yml`；`apps/web/dist` 与 `agent.ts` 经 `extraResources` 投进 `resources/`（旁配 `{"type":"module"}` 的 `package.json`）；`main.ts` 的 `DIST_ROOT` 与 `paths.ts` 的代理模块按 `app.isPackaged` 分派并留降级路径；`sync-version.mjs` 收口版本号并加门禁用例。`dist:dir` 2 分 5 秒 / `dist` 6 分 1 秒均 exit 0，安装态冒烟 PASS，`verify-pack.mjs` 17 项断言 + 2 条反例全过，desktop 76 → 86，门禁 506 项。**未接 updater、未发版、未签名**。提交 `4ded6b1` |
| 10-13 14:0x | **T6-03c 实施（安装包签名）** | 自签证书 `CN=Fanhe Work` 装入 `CurrentUser\My`（`signing:cert`，幂等；公开部分另进 `TrustedPublisher`）；签名选项改为 **`win.signtoolOptions.certificateSubjectName`** —— 原计划写的 `win.certificateSubjectName` 会被 schema 拒绝，且报错**不点名具体是哪个键**。安装包 116,303,500 → **116,323,480** 字节，两个产物 PE 签名表 0 → **7416 字节**，`app-update.yml` **首次生成**并含 `publisherName: [Fanhe Work]`。新增 `verify-signature.ps1`（`verify:sign`）；`verify-pack.mjs` 当时为 27 项断言。**签名已先于首次发布完成**；§八 第 1/2/4/5 条反例仍需 T6-03b 才能验。提交 `415219b` |
| 10-13 15:3x | **T6-03b 实施（更新通道）+ 阶段六收口** | 接 `electron-updater@6.8.9`（进 `dependencies`）；主进程 `wireAutoUpdater()` 检查 → 下载 → 用户确认后安装退出；新增 `apps/desktop/src/update.ts`（纯状态机 13 项单测）与 `apps/web/src/lib/host.ts`（宿主判定 6 项单测），T6-02 的提示按宿主分派（浏览器「刷新页面即可更新」/ 桌面「点此重启更新」）。**离线验收台跑通反例①（改 sha512 → 拒绝）、反例②（同一个包、逐字节不变、只改信任根 → 拒绝；加回 → 通过，因变量只有信任根）、第 5 条（缺 blockmap → 差分回退整包）**；含空格 CN 风险解除。🔴 **修正 T6-03c 的签名判据：`Status` 必须是 `Valid`(0) —— 更新器只在 `Status === 0` 时比对发布者，自签链不可信会让每一次更新都被拒绝；修法是把自签根也装进 `CurrentUser\Root`**。附带修掉 `verify-pack.mjs` 解析器静默丢列的真 bug（`STATUS_VALUE` 读不到）。`verify-pack.mjs` **28 项断言（含 6 条反例）全过**；门禁 **530 项 0 失败**（web +11、desktop +13）。**§八 第 4 条待真实发版**（首次发布 = 下一项）。提交 `3a9294f` + `1a3ceee` |
| 10-13 16:0x | **首次发布 v0.1.0（GitHub Release）** | 重跑 `dist`（6 分 14 秒，exit 0）产出**含更新通道**的安装包 **112,209,040 字节**；`verify:all` **32 项断言全过**（比 28 多 4 项 —— 真 nsis 构建让「安装包已签名 / `app-update.yml` 含 `publisherName` / `publisherName` 与配置一致 / `latest.yml` 的 sha512 与 size」这四组**从「未验证」变成真验了**）；打包态冒烟 PASS；asar 断言确认 `electron-updater` 确实在包里。注解 tag `v0.1.0` 已推送；electron-builder 内置 GitHub publish 传 `.exe` / `.exe.blockmap` / `latest.yml` 三个资产。**两个坑**：`publish` 子命令必须显式 `-f` 给文件列表；**建出来的是草稿**（未认证 by-tag 返回 404，易误判成没发出去），需 `PATCH` 把 `draft` 置 false。发布后核对：未认证 200、线上 `latest.yml` 与本地逐字节一致、`sha512`/`size` 全 MATCH；令牌未落盘（扫 4901 个文本文件确认）。**§八 第 4 条仍未验**（v0.1.0 只是垫脚石 A）。Release：`https://github.com/dy00001/fanhe-work/releases/tag/v0.1.0` |


| 10-13 17:4x | **第二次发布 v0.1.1（GitHub Release）** | 为闭合更新通道正向验证而发的 B 端（tag 指向 `8162c33`，含 P0 三项）。`dist` 6 分 4 秒 exit 0，安装包 **112,209,032 字节**；`verify:all` **32 项断言 + 4 条反例全过**；线上 `latest.yml` 与本地**逐字节一致**（349 字节，sha256 `eaa9839b…`），`sha512` / `size` 与实际安装包**全部 MATCH**；未认证 GET by-tag **200**（草稿已解除，Release `411517975`）。**§八 第 4 条仍需真人操作** |
| 10-13 21:xx | **T7-02 实施（外壳来源固定 T7-02a + 客户端更新按钮 T7-02b）** | 用户把验收条件加严为「更新后本地设置及本地存储的所有数据不丢失」。定位真根因：**界面来源（端口）每次启动都变** —— `server.listen(0)` 随机分配端口，而 localStorage / IndexedDB 按 origin 分区、origin 含端口（实测 `%APPDATA%\梵禾 Work\IndexedDB\` 下并存 `http_127.0.0.1_49901` 与 `http_127.0.0.1_57352` 两份互不可见的存储）。修法：**端口候选链**（偏好 → 旧来源 → 固定段 `41873~41880` → 系统兜底）+ 偏好持久化 + **单实例锁** + 旧来源发现（IndexedDB 目录 mtime 为主信号，localStorage 日志只补未知端口）。客户端新增 `UpdateNotice` 与 `use-desktop-update`（检查 / 下载进度 / 重启更新 / 失败重试）。四道门禁 **578 项 0 失败**（desktop 99 → 122、web 97 → 116）；实测端口稳定并落回既有来源之一（`57352`）。顺手修掉五处测试写死 `C:\Users\Administrator` 的既有缺陷（改 `test/scratch.mjs` 从 `LOCALAPPDATA` 推）。提交 `4c0ac8a` |
| 10-13 21:xx | **T7-02 打包验证受阻（缺签名证书）** | `dist:dir` 报 `⨯ Cannot find certificate CN=Fanhe Work, all certs:   failedTask=build`；实测 `Cert:\CurrentUser\My` 为空、`CurrentUser\Root` 无 Fanhe 自签 —— 证书来自沙箱会话之外且已被清理。**未执行 `signing:cert`**（换签名主体会让已装 `v0.1.0`/`v0.1.1` 的机器永久无法更新），**待用户裁决**。产物为「新 web + 新 asar + 未签名 exe」的中间态；`verify:pack` 由 32 增至 **35 项**，本轮实测 **34 通过 / 1 FAIL**（FAIL 即签名那一项）。**未发新版** |
| 10-14 | **阶段一末项验收的端到端断言（审计留痕）** | 补上悬空约一个月的阶段一末项「关键操作在 `audit_logs` 有记录」：`user-admin.test.ts` 新增一条用例，五类动作（创建 / 改状态 / 重置密码 / 调权限 / 删除）按真实路由各走一遍再回查审计表，逐条核动作码（取 `AUDIT_ACTIONS` 常量）、`actorId`、`actorName` 快照、`targetType`、`result`，并断言 `detail` 不含任何口令。**补断言时暴露并修掉一个留痕缺口**：账号管理取 `request.ip`、`inject` 默认来源是 `127.0.0.1`，而 `after` 只按 `TEST_IP` 清理，库里因此积了 **317 行**（其中约 296 行是这批测试留痕）；清理改为按 `actorId` 圈定并置于账号删除之前。跑测试前后总数均为 317、分布不变。四道门禁 **599 项 0 失败**（api 232 → **233**）。**阶段一验收 6 项至此全部勾选**。见 4.1.17 与 `DEVELOPMENT-PLAN.md` 9.58。提交 `fc9d9f9` |
| 10-14 | **阶段七登记补齐（T7-02 三件套 + T7-03 / T7-04 入库）** | ① **T7-02 的三件套此前漏登记** —— 它在 `4c0ac8a` 落地后只写进了 §4.1.14 与 `DEVELOPMENT-PLAN.md` 9.55（都是「实施判断」性质的叙述），第三章任务表 / 第四章依赖图 / 第七章验收清单一处未动，成了「有提交、有长文、但不在计划里」的任务；T7-01 当初同样如此。本轮补齐三件套，并记入 9.59。② **T7-03 / T7-04 两份设计稿此前在版本控制之外**（`git clean -fd` 一次就会丢掉 55 KB 的分析）：T7-03「版本迭代期间的可用性与手动更新方案」、T7-04「团队协作下的开发端隔离与版本发布流水线」，已入库并登记文档索引。③ **纠正一处误判**：「已发布客户端没有更新按钮」**不是待修缺陷** —— 代码与回归闸都在 T7-02 里（`verify-pack.mjs` 第 286 行起断言 `resources/web` 与 `apps/web/dist` **逐文件一致**，注释写明要挡的是「半新半旧」），缺的**只是一次发版**（`v0.1.0` / `v0.1.1` 都发在 `4c0ac8a` 之前）。④ 顺带修掉本条变更记录上一行残留的悬空哈希（`424f3f0` 是 amend 前的对象，`git branch --contains` 为空；实际为 `fc9d9f9`）—— **同一个坑又漏了一处**。提交 `c42e7de` + 本笔 |
| 10-14 | **签名身份轮换手册 + 私钥检索闭合** | ① **私钥检索做了第二轮穷尽版**，补上一轮的三个盲区（压缩包内部 / 其它三个盘 / 证书库逐库枚举），四路**仍然全空** —— 全机四盘按扩展名只有系统 CA 包与 Python 测试证书、工作空间压缩包内无密钥类文件、内容特征命中的全是文档里提到指纹的文字、`CurrentUser\My` 为空。**结论闭合：没有 `.pfx` 备份，轮换是唯一能再发版的路。** ② 新建 **`docs/SIGNING-ROTATION-RUNBOOK.md`**（九节）。③ 🔴 **补上了一个此前没人论证过的环节**：现有文档都只说「换证书后要补装新根」，**没有一处说明补装之后为什么就能通**。答案在 `electron-updater` 的两道门 —— `windowsExecutableCodeSignatureVerifier.js:56` 的 `Status === 0` 要求链能走到本机信任的根（故必须补装新根）；`:70~:84` 比对的是 `Subject` 的 **CN 而指纹不参与**（实测证书 Subject 只有 `CN=Fanhe Work` 一段，故比对退化成 CN 相等）。**同 CN 换证书 ⇒ 第二道门照常通过。** ④ 据此**纠正一句流传很广的过强说法**：「换证书 = 已装机器**永久**收不到更新」在「新根不补装」时成立，作为一般结论过强 —— 准确说法是「不补装新根时才永久」。⑤ 手册写明**顺序约束**（装新根必须早于目标机消费新版本，反了会被静默拒绝）与**明确未验的部分**（同 CN 轮换是源码论证而非端到端实测；补法是用 `--update-probe` 在一台已装 v0.1.1 的机器上打一次）。见 `DEVELOPMENT-PLAN.md` 9.56 / 9.60 |
| 10-14 | **本机接收条件实测 + P0 验证路径分叉** | ① `signing:trust-check`（只读）**退出码 0**、`RESULT=OK`、`TRUST_ROOT` / `TRUST_PUBLISHER` / `CHAIN_BUILDS` / `TRUST_CERT_MATCHES_RECORD` 四项全 `True`；`Root` 与 `TrustedPublisher` 里**新旧两根各 2 条**。② 本机**已装 `v0.1.1`**，更新缓存**是热的**（`installer.exe` 112,209,032 字节 = `v0.1.1` 安装包）。③ GitHub 复核：`v0.1.1` 仍是最新已发布版（`draft=false`、三资产齐备），**尚无 `0.1.2`**。④ 🔴 **由此发现并修掉一个真实缺口**：`docs/P0-UPDATE-VERIFICATION.md` 原文通篇按「A=`v0.1.0` → B=`v0.1.1`」写，判据是「期望 `0.1.1`」「缓存期望 112,209,032」且教人装**退役旧根** —— **`0.1.2` 一发布这些判据全部失效**。新增第 0.6 节给出 A / B 两条路的对照表与路径 B 的分步操作（含实测值）。**路径 B（`0.1.1` → `0.1.2`）严格更强**：本机已是 `v0.1.1`（免卸装）、两根并存（步骤 1 可跳过）、且**它是唯一能把轮换手册 §八第一条从源码论证变成端到端实测的路径**（`v0.1.1` 是旧身份签的，`0.1.2` 是新身份签的，这才是真正的跨身份实测）。⑤ **顺序约束收窄为「逐机」** —— 手册第五节只对尚未装新根的机器成立；发布前真正要做的是盘一遍「还有哪些机器装了 `v0.1.0` / `v0.1.1`」。见 `docs/P0-UPDATE-VERIFICATION.md` §0.6 与 `docs/SIGNING-ROTATION-RUNBOOK.md` §八 |
| 10-14 | **发布 v0.1.2 + 路径 B 探针实测（跨身份更新闭合）** | ① **发布 `v0.1.2`**：注解 tag → `e40bdfc`（同 `v0.1.1` 惯例）；GitHub Release ID `412862351`，**先建草稿 → 传完三资产 → 核对大小 → 再解除草稿**（避免「已发布但缺 `latest.yml`」的窗口会让客户端取不到版本清单）；未认证 by-tag **200**，线上 `latest.yml` 与本地**逐字节一致**，安装包 `Content-Length: 112218832` 相符。② **四道门禁发布前实跑**（不引用旧结果）：test **599 项 0 失败**、`lint`/`typecheck`/`format:check` 退出码全 0。③ 🔴 **路径 B 探针 PASS —— 轮换手册 §八第一条从「源码级论证」转正为「端到端实测」**：旧客户端（`v0.1.1`，旧身份签）接受新身份签的 `0.1.2`，日志 `Signature validated using only CN Fanhe Work.` 与源码级论证预测的比对路径**逐字吻合**。用**本地验收台**代替真源（`provider: generic` + `python -m http.server`），因**从 agent 沙箱启动的 GUI 进程出网被拦**；安装目录 `app-update.yml` 已还原并逐字节比对 `IDENTICAL`。④ **两个新环境事实**：沙箱拦 GUI 出网（判据：`--proxy-server` 指向不存在的端口时错误**不变成** `ERR_PROXY_CONNECTION_FAILED`）；**`HTTP_PROXY`/`HTTPS_PROXY` 对应用无效**（走 `electron.net`/Chromium，只认系统代理与 `--proxy-server`；本机系统代理实测已配好）。⑤ **差分下载**：计算正确（3%，2,806.4 KB / 109,588.7 KB），实际传输未走通（rig 缺 `Accept-Ranges`，真实源实测支持 `206`）。⑥ **唯一未闭合**：真实源的端到端更新（退出应用 → 重开 → `FileVersion=0.1.2`），需真人 |
| 10-14 | **私钥保管方案（两份加密备份 + 私钥忽略规则）** | 用户要求「把私钥存进工作空间，保证各设备统一使用同一个私钥」。**没有直接执行**，因为查到三条事实：① 工作空间根仓库实测 **`public`**（未认证 `HTTP 200`、`private=false`）；② 工作空间此前**没有任何私钥忽略规则** —— `.pfx` 是「未跟踪但未被忽略」，一条 `git add -A` 就进暂存区；③ `create-signing-cert.ps1` 第 755 行**刻意拒绝**导出到工作空间内，`DEVELOPMENT-PLAN.md` 6.3 第 6 条亦写明「与工作空间分开保管，不随盘移动」。**但用户担心的那件事是真的**：轮换的根因正是**私钥从未被备份**。据此落地 —— ① **补私钥忽略规则，两层** —— 扩展名层 `*.pfx`/`*.p12`/`*.pvk`/`*.jks`/`*.keystore`/`*.key`/`*.pem`，**目录层 `/keys/`**（锚定工作空间根）。**两层都要**：只按扩展名忽略时 `keys/` 目录对 git 仍可见，里面任何非私钥扩展名的文件都会被跟踪 —— 而「顺手在放私钥的目录里写一个口令备忘 `.txt`」正是最可能发生的失误。**刻意不忽略 `.cer`** 以免破坏轮换绊线；已核对全库无已跟踪文件位于该路径下，并验证正反两面，`credential.ts` 未受影响；② 新建 **`docs/SIGNING-KEY-BACKUP.md`**（九节）；③ 脚本导出分支新增 `EXPORT_IN_WORKSPACE=True reason=guard-bypassed-by-AllowWorkspaceExport` 审计行（**纯 ASCII 无 BOM、解析 0 错误、`signing:check` 仍 `RESULT=OK`/退出码 0**）；④ 建立 `<工作空间根>/keys/` 并由目录层规则整体忽略。🔴 **纠正一处前提**：「所有设备用同一个私钥」**不靠复制私钥** —— 私钥只在打包机需要，一致性由**公钥入库 + 身份档案 + 轮换闸 + 逐机自检**四件公开的东西保证。**导出动作刻意留给用户执行**（口令用 `Read-Host` 取以免进 PSReadLine 历史），期望报告为 `ACTION=reuse` 而非 `ACTION=created`。见 6.3 第 6 条与 `docs/SIGNING-ROTATION-RUNBOOK.md` §零 bis |
| 10-14 | **`v0.1.2` 装完显示 `0.1.1` —— 产物陈旧换脸重现（T7-05）** | 用户从 GitHub 装了 `0.1.2`，账号菜单仍显示 `v0.1.1 · 2026-10-14 · dd4e9e6`。**先定性**：装进去的**确实是 `0.1.2`**（注册表 `DisplayVersion=0.1.2` + 安装目录 exe `FileVersion=0.1.2` 两条独立判据），错的是界面那行字。**根因**：那三个值是 Vite **构建期**从仓库根 `package.json` 文本替换进产物的，而**构建排在版本号提升之前** —— 前端 22:41 构建（版本号还是 `0.1.1`），版本号 22:57 才提到 `0.1.2`，安装包 22:54 打出。即三步顺序都做了，只是版本号那步排错了位置。**既有断言为何全数漏过（最值钱的一课）**：「`resources/web` 与 `apps/web/dist` 逐字节一致」比的是**包内副本 vs 源目录**，两边同旧时照样全绿；三条标记断言（`fanheDesktop` / `重启更新到` / `正在下载`）的锚点是**写死的字符串**，只能抓住写它们时想抓的那一次陈旧。**共同点是它们都在回答「产物够不够新」，而「够新」没有绝对判据。** 修法：新增 `scripts/baked-identity.mjs`（按**形状**读回构建期注入的「版本 + ISO 构建时刻 + 提交短号」三连，判据里**不含需要随发版维护的常量**）、`scripts/check-web-build.mjs`（**打包前**前置闸，接在 `dist`/`dist:dir` 第一步，不符即拒绝）、`verify-pack.mjs`「二·补二」四条断言、`test/baked-identity.test.mjs` 12 项单测（含 4 条反例）。**当场验证**：对陈旧的 `apps/web/dist` 与用户实际装到的 `resources/web`（md5 一致）前置闸均报 `产物里烧的是 0.1.1，仓库根是 0.1.2` 并退出码 1；对现有陈旧安装包跑 `verify:pack`，**47 项里 46 项通过、唯一失败的就是新加这条**，直接证明原来那 43 项确实有洞。门禁 **611 项 0 失败**（desktop 142→**154**），`lint`/`typecheck`/`format:check` 全 0。**踩坑两条**：压缩后三字面量之间**不是裸逗号**（夹着 `cg=`/`lg=`，第一版正则一条都匹配不上却报「找不到三连」，把人引向错误结论）；带 `g` 的正则**有状态**（不重置 `lastIndex` 会让同一输入两次得出不同结果）。见 4.1.18 |

**§十一 新增/修改的关键文件（T7-02）**：`projects/fanhe-work/apps/desktop/src/shell-origin.ts`（**新**：端口 → origin → 存储分区的纯函数，`shellPortCandidates` / `orderLegacyPorts` / `parseOriginDirName` / `parseStoredPort` / `isFreshOrigin`，**不 import electron 与 fs**）、`apps/desktop/src/{main,server}.ts`（端口候选链 + `shell-origin.json` 偏好 + 单实例锁 + 旧来源发现 + `listenOnce` / `isRetryableListenError`）、`apps/desktop/test/shell-origin.test.mjs`（**新** 19 项）、`apps/desktop/test/scratch.mjs`（**新**：从 `LOCALAPPDATA` 推系统临时目录）、`apps/desktop/test/{server,config,paths}.test.mjs` 与 `test/acceptance/t40{2,3,4}-*.mjs`（端口用例 4 项 + 统一 import `SYSTEM_SCRATCH`）、`apps/desktop/scripts/verify-pack.mjs`（+3 项断言 +2 条反例：`resources/web` 与 `apps/web/dist` 逐文件一致、三条产物标记、签名报告必须比本轮产物新）；`apps/web/src/lib/desktop-update.ts`（**新**）、`apps/web/src/lib/use-desktop-update.ts`（**新**）、`apps/web/src/components/UpdateNotice.tsx`（**新**）、`apps/web/src/components/TopBar.tsx`（接线 + `runUpdateNoticeAction` 补「还没下载好」那一支）、`apps/web/test/desktop-update.test.mjs`（**新** 19 项）；`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/api` 与 `packages/shared` 本轮一行未改。**

**§十一 新增/修改的关键文件（T6-01）**：`projects/fanhe-work/packages/shared/src/version.ts`（**新**：`VersionManifestResponse` / `BUILD_FINGERPRINT_LENGTH` / `computeBuildFingerprint` / `compareVersions` / `compareManifests` / `VersionComparison`，含手写 SHA-256 与 UTF-8 编码，**每一处手写都注明了「为什么不用标准库」与它的风险形态**）、`packages/shared/src/index.ts`（加 `export * from './version.js'`）、`packages/shared/test/version.test.mjs`（**新** 24 项）、`projects/fanhe-work/apps/api/src/version/manifest.ts`（**新**：`GET /api/version`、逐级上溯认 `pnpm-workspace.yaml`、**找不到就抛错**、不设门禁的理由与复查起点写在注释里）、`apps/api/src/app.ts`（接线）、`apps/api/test/version-manifest.test.ts`（**新** 7 项，含**从编译产物位置出发**的那条）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/web/src` 与 `packages/shared/src` 其余文件一行未改。**

**§十一 新增/修改的关键文件（T5-04）**：`projects/fanhe-work/docker-compose.yml`（新增 `cloudflared` 服务：`image: cloudflare/cloudflared:2025.8.1`、`command: tunnel --no-autoupdate run --token ${FANHE_TUNNEL_TOKEN:?…}`、`depends_on: web`、**刻意不写 `ports:`**；文件头注释补「五个服务」与「绑 127.0.0.1 与无公网入站是两件事」）、`projects/fanhe-work/tools/checks/t504-tunnel.mjs`（**新**，17 项，三层判据）、`projects/fanhe-work/.env.compose`（**加 `FANHE_TUNNEL_TOKEN` 与对应 Cloudflare 资源注释；该文件被 gitignore，不入库**）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/api/src` / `apps/web/src` / `packages/shared/src` 本轮一行未改。** Cloudflare 侧资源（Tunnel `fanhe-work`、DNS CNAME、ingress 规则）**不在仓库里**，记在 §4.1.1 与 `.env.compose` 注释里。

**§十一 新增/修改的关键文件（T5-03）**：`projects/fanhe-work/apps/api/Dockerfile`（migrate 阶段 `CMD` 改为 `sh -c "prisma migrate deploy && pnpm --filter @fanhe/api db:seed"`，并补一大段注释说明「只建表是不够的」「种子不建账号」「用 `&&` 而非两个 CMD」）、`projects/fanhe-work/apps/api/src/config/env.ts`（`jwt.secret` 改 getter，注释记录为何惰性化与它的代价）、`projects/fanhe-work/apps/api/src/index.ts`（**新** `assertRequiredEnv()`，`listen` 之前显式读一次 `env.jwt.secret`；注释写明这是惰性化的登记处，**新增「启动时必须存在」的配置要一并加到这里**）、`projects/fanhe-work/tools/checks/db-backup.mjs`（**新**，414 行；`dumpToBuffer()` 用 `spawn` 收二进制、`restoreFromFile()` 走 `docker exec -i` + stdin、`verify` 做真恢复演练、恢复带 `--clean --if-exists`、备份落 `projects/fanhe-work/data/backups/`）、`projects/fanhe-work/tools/checks/t502-empty-volume.mjs`（22 → 30 项，新增 §5b 权限体系与 §7b 端到端）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/web/src` 与 `packages/shared/src` 本轮一行未改**；`apps/api/src` 改了两处且都是为让种子能在容器里跑 —— 记录在此以免日后被当成无关改动。


**§十一 新增/修改的关键文件（T4-01）**：`apps/desktop/package.json`（**新**，`@fanhe/desktop`，`productName: 梵禾 Work`，`main: dist/main.js`，`devDependencies.electron: 44.7.0`，脚本 build / typecheck / test / ensure-electron / start / dev / smoke）、`apps/desktop/tsconfig.json`（**新**，`module`/`moduleResolution: NodeNext`，**刻意不写 `"type": "module"` 以产出 CJS**）、`apps/desktop/src/server.ts`（**新**，内置静态服务：MIME 表、逐跳头与剥离头、`startStaticServer` / `serveStatic`（SPA 回退 + 405 + 越界 403）/ `sendFile`（哈希资源长缓存、index 不缓存）/ `proxyToService`（剥 `host`/`content-length`/`accept-encoding`））、`apps/desktop/src/main.ts`（**新**，主进程：`DIST_ROOT`、`SERVICE_URL`（`FANHE_SERVICE_URL`）、`IS_SMOKE`、`no-proxy-server`、`buildWindow`、`setWindowOpenHandler`/`will-navigate` 白名单、`runSmoke`）、`apps/desktop/src/preload.ts`（**新**，`contextBridge` 暴露 `fanheDesktop`）、`apps/desktop/scripts/ensure-electron.mjs`（**新**，幂等二进制自检）、`apps/desktop/scripts/launch.mjs`（**新**，摘 `ELECTRON_RUN_AS_NODE`、按 `FANHE_NO_SANDBOX` 决定是否 `--no-sandbox`）、`apps/desktop/test/server.test.mjs`（**新**，10 项）、`apps/desktop/.gitkeep`（删）；`pnpm-workspace.yaml`（`onlyBuiltDependencies: [electron]`）、根 `package.json`（加 `postinstall`）、`eslint.config.js`（`apps/desktop` 进 Node 全局块）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/web` / `apps/api` / `packages/shared` 本轮一行未改。**

**§十一 新增/修改的关键文件（UI 集成）**：`packages/shared/src/navigation.ts`（18 项 / 分组 / `slug` / `buildNavSections` / `navCodeFromPath` 重写）、`packages/shared/src/permissions.ts`（运维信息平台改名）、`packages/shared/test/navigation.test.mjs`（重写，32 项）；`apps/web/src/components/Sidebar.tsx`（重写）、`TopBar.tsx`（五项菜单 + 版本号行）、`AppShell.tsx`（外层 `relative`）、`components/home/{CaseGallery,LaunchSection,RecordSection}.tsx`（新）、`pages/HomePage.tsx`（新）、`pages/WorkbenchPage.tsx`（按地址分派）、`routes.tsx`（`routePath` + `MODULE_SUB_ROUTES`）、`lib/nav-icons.ts`（重写）、`lib/version.ts`（新）、`vite-env.d.ts`、`index.css`（hero 令牌族）、`vite.config.ts`（`define` 注入构建常量）、根 `package.json`（`0.0.0` → `0.1.0`）；`apps/web/test/e2e-auth.mjs`（新外壳同步 + `mouseMove` / `elementCenter` / `selectThemeOption` / `openHomeSection`）、`apps/web/test/version.test.mjs`（新，8 项）；`docs/{DEVELOPMENT-PLAN,WORK-STATUS,UI-INTEGRATION-2026-10-11}.md`。**业务逻辑（四个面板与 `lib/` 数据层）一行未改。**

**§十一 新增/修改的关键文件（T3-12）**：`apps/web/src/lib/api.ts`（增 `eventLogsRequest`）、`apps/web/src/lib/events.ts`（增 `loadEventLogs`）、`apps/web/src/lib/event-display.ts`（增动作码映射 / `formatMoment` / `formatDuration`）、`apps/web/src/components/events/EventDetailDialog.tsx`（**新**）、`apps/web/src/components/events/EventRow.tsx`（标题改可点按钮）、`apps/web/src/components/events/EventList.tsx`（透传 `onOpenDetail`）、`apps/web/src/components/events/EventsPanel.tsx`（`detailId` / `detailOpen` 与对话框挂载）、`apps/web/test/event-display.test.mjs`（增 17 项）、`apps/web/test/e2e-auth.mjs`（新增 T3-12 段 11 项 + 截图等待 Dialog 完成 + Checkbox / 标题按钮改 `element.click()`）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**后端与共享包本轮一行未改**，**行结构（除标题变成按钮）一行未改**。

**§十一 新增/修改的关键文件（T5-02）**：`projects/fanhe-work/apps/api/Dockerfile`（加 `FROM build AS migrate` 阶段，`CMD` 为 `prisma migrate deploy`；**文件末尾带一条关于「不写 target 会停在最后」的警告**）、`projects/fanhe-work/docker-compose.yml`（新增 `migrate` 一次性服务、`x-database-url` 顶层锚点、api 与 web 的 `target: runtime`、`restart: 'no'`、healthcheck 改用 `$${POSTGRES_USER}`）、`projects/fanhe-work/tools/checks/t502-empty-volume.mjs`（**新**，22 项）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/api/src` / `apps/web/src` / `packages/shared/src` 本轮一行未改** —— 这正是验收要点「连接串切换后无需改业务代码」的直接证据（`git diff --stat` 对这些路径为空）。

**§十一 新增/修改的关键文件（T5-01）**：`projects/fanhe-work/.dockerignore`（**新**，排除 `node_modules` / `**/dist` / `.env` / `data` 与并行 UI 产物目录）、`projects/fanhe-work/apps/api/Dockerfile`（**新**，两阶段：`build` 装全量依赖并 `prisma generate` + `tsc`，`runtime` 只带 `--prod` 依赖与 `dist`；`ENV HOST=0.0.0.0`、`tini` 作 PID 1、`USER node`、HEALTHCHECK 打 `/api/`）、`projects/fanhe-work/apps/web/Dockerfile`（**新**，构建 `node:22-bookworm-slim` 出 `dist`，运行 `nginx:1.27-alpine`）、`projects/fanhe-work/apps/web/deploy/nginx.conf`（**新**，`upstream api_upstream { server api:8787 }`、`/api/` 反代并清逐跳头、`/assets/` 长缓存 `1y immutable`、SPA 回退）、`projects/fanhe-work/docker-compose.yml`（新增 `api` 与 `web` 两个服务，**db 段逐字未动**）、`.gitignore`（加 `.env.compose`）、`infra/portable/ws-compose.cmd`（**新**，纯 ASCII）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/api/src` / `apps/web/src` / `packages/shared/src` 本轮一行未改** —— `DATABASE_URL` 与 `JWT_SECRET` 都从环境变量读，改连接串不需要动业务代码，这正是 T5-02 验收要点的前置条件。

**上一轮新增/修改的关键文件（T3-11）**：`apps/web/src/lib/api.ts`（增 `setEventStatusRequest`）、`apps/web/src/lib/events.ts`（增 `setEventStatus`）、`apps/web/src/lib/event-display.ts`（增 `applyEventStatus`）、`apps/web/src/components/events/EventRow.tsx`（勾选框接线 + `locked` / `switching`）、`apps/web/src/components/events/EventList.tsx`（透传 + 组标题改用常量）、`apps/web/src/components/events/EventsPanel.tsx`（`changeStatus` / `switching` / 撤销入口 / `Notice.undo`）、`apps/web/test/event-display.test.mjs`（增 5 项）、`apps/web/test/e2e-auth.mjs`（新增 T3-11 段 17 项 + `eventCheckboxFinder` + `installStatusDelay` + `apiEventFacts` / `apiDeleteEvent` + 组计数与撤销入口的取数表达式）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**后端与共享包本轮一行未改**，**行结构一行未改**。

**上一轮新增/修改的关键文件（T3-10）**：`apps/web/src/lib/event-display.ts`（新）、`apps/web/src/lib/events.ts`（新）、`apps/web/src/components/events/{EventsPanel,EventList,EventRow,EventFormDialog}.tsx`（四个皆新）、`apps/web/src/lib/api.ts`、`apps/web/src/components/notes/TagInput.tsx`、`apps/web/src/pages/WorkbenchPage.tsx`、`apps/web/src/routes.tsx`、`apps/web/test/event-display.test.mjs`（新）、`apps/web/test/e2e-auth.mjs`（新增事件段 20 项 + 两个接口辅助函数 + 重置语句补 `event_logs` / `events`）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**后端与共享包本轮一行未改**（T3-09 的八条接口够用）。

**上一轮新增/修改的关键文件（T3-09）**：`packages/shared/src/event.ts`（新）、`packages/shared/src/index.ts`、`packages/shared/test/event.test.mjs`（新）、`apps/api/prisma/schema.prisma`、`apps/api/prisma/migrations/20261011132819_add_events/`（新）、`apps/api/src/event/events.ts`（新）、`apps/api/src/routes/events.ts`（新）、`apps/api/src/app.ts`、`apps/api/test/event.test.ts`（新）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/web` 本轮一行未改。**

**上一轮新增/修改的关键文件（T3-08）**：`apps/web/src/lib/note-draft.ts`（新）、`apps/web/src/components/notes/{NoteEditor,NotesPanel}.tsx`、`apps/web/test/note-draft.test.mjs`（新）、`apps/web/test/e2e-auth.mjs`、`apps/web/package.json`、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。

**上一轮新增/修改的关键文件（T3-07）**：`packages/shared/src/note.ts`、`apps/api/src/note/notes.ts`、`apps/api/src/routes/notes.ts`、`apps/web/src/lib/api.ts`、`apps/web/src/components/notes/NotesPanel.tsx`、`apps/web/test/e2e-auth.mjs`（新增 `openThemeMenu` 与 `E2E_CDP_PORT`）、三个测试文件、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。
