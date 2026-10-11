# 工作空间与远端仓库数据对比报告

> 生成时间 2026-10-11 14:35。对比对象为工作空间根目录与远端仓库 `dy00001/fanhe-work`。路径一律以工作空间根为基准，不写盘符。

---

## 零、执行摘要

三条结论。

第一，受版本控制的内容完全一致。两侧各 168 个文件，逐字节零差异，并经三条独立来源交叉验证。

第二，受控内容没有差异。差异集中在三个外围层面：本地独有的忽略内容、本地数据库的表结构落后于仓库定义、开发分支的演进位置。

第三，已执行两项补全动作。数据库补齐两个缺失迁移，九张表到位；门禁的忽略规则修复，四道门禁由两通过两失败变为全部通过。

---

## 一、对比方法与数据来源

| 对比维度 | 本地来源 | 远端来源 | 判定依据 |
| --- | --- | --- | --- |
| 文件清单 | `git ls-files` | `git ls-tree -r origin/main` | 路径集合做差 |
| 文件内容 | 工作树实体 | `git diff HEAD origin/main` | 内容哈希 |
| 提交历史 | `git log` | GitHub API `get_commit` | 提交 SHA |
| 分支状态 | `git branch -vv` | GitHub API `list_branches` | 分支指向的 SHA |
| 数据库结构 | `_prisma_migrations` 表 | `prisma/migrations/` 目录 | 迁移名集合 |
| 本地独有内容 | `git clean -ndX` | 不适用 | 忽略规则 |

远端数据经 GitHub API 直读，不依赖本地 remote-tracking 引用，避免陈旧副本导致误判。

---

## 二、文件结构对比

两侧受控文件均为 168 个，构成如下。

| 层级 | 文件数 |
| --- | --- |
| `projects/fanhe-work` | 144 |
| `infra/portable` | 14 |
| `infra/docs` | 4 |
| `projects/README.md` | 1 |
| 根级配置 | 5 |
| 合计 | 168 |

根级配置为 `README.md`、`.ws-root`、`.gitignore`、`.gitattributes`、`.editorconfig`。

结构一致，无缺失目录，无多余文件。

## 三、内容对比

`git diff --stat HEAD origin/main` 输出为空，表示两侧逐字节相同。

另有一条独立证据。GitHub API 读取的远端 main 提交为 `21696913b41c...`，与本地对应的提交 SHA 一致。提交 SHA 由文件树哈希递归计算得出，SHA 相同即内容相同。这条证据的强度高于逐文件比对，因为它覆盖了目录结构、文件模式与二进制内容。

## 四、版本状态对比

| 项目 | 值 |
| --- | --- |
| 提交总数 | 63 |
| 本地 HEAD | `3bdc45b`，位于 main |
| `origin/main` | 与 HEAD 一致 |
| 本地 `dev` | `ea119ab`，与 `origin/dev` 一致 |
| 领先落后 | main 领先 `origin/dev` 4 个提交，`dev` 无独有提交 |
| 标签 | 无 |
| 分支保护 | 两个分支均未启用 |

工作树干净，无未提交修改，无未跟踪文件。

`dev` 与 `main` 的分叉属于设计内状态。`dev` 于 2026-10-11 13:38 创建，创建时与 main 同源，此后 main 推进了 4 个文档与工具配置提交。

## 五、变更记录对比

| 指标 | 值 |
| --- | --- |
| 提交总数 | 63 |
| 时间跨度 | 2026-10-10 13:26 至 2026-10-11 14:34 |
| 10-10 提交数 | 41 |
| 10-11 提交数 | 22 |
| 作者 | 单一身份 `梵禾 <dev@fanhe.local>` |
| 历史重写 | 无 |

两侧提交历史完全一致，不存在只在一侧出现的提交。

## 六、本地独有内容盘点

共 31 个被忽略条目，性质分五类，均属设计使然，不构成缺失。

| 类别 | 路径 | 性质 |
| --- | --- | --- |
| 助手记忆 | `.workbuddy/`、`.workbuddy-ai/` | 逐机，不进版本控制 |
| 运行时重定向 | `.cache/` `.cargo/` `.config/` `.go/` `.gradle/` `.local/` `.m2/` `.nuget/` `.rustup/` `.tmp/` `.venv/` `runtime/` `logs/` | 环境状态 |
| 逐机状态 | `infra/portable/state/root.json` | 记录本机盘符 |
| 依赖与产物 | 四处 `node_modules/`、四处 `node_modules.old/`、三处 `dist/`、`src/generated/`、`e2e-shots/` | 可重建 |
| 本地凭据 | `apps/api/.env` | 密钥，忽略正确 |

## 七、识别出的差异

### 7.1 缺失

| 编号 | 内容 | 性质 | 处置 |
| --- | --- | --- | --- |
| M1 | 数据库缺 `launch_profiles`、`launch_history` 两张表 | 结构落后于仓库定义 | 已补齐 |
| M2 | `infra/portable/state/leak-baseline.json` 不存在 | 机制状态文件，由检查脚本生成 | 待确认是否需要 |

### 7.2 过期

| 编号 | 内容 | 性质 | 处置 |
| --- | --- | --- | --- |
| O1 | 本地数据库仅应用 2 个迁移，仓库定义 4 个 | 与 M1 同源 | 已补齐 |
| O2 | `dev` 分支落后 main 4 个提交 | 分支演进位置，非内容问题 | 待人工决定 |
| O3 | `dist/` 与 `src/generated/` 产物早于最新源码 | 可重建 | 本次 typecheck 已重新生成 |

### 7.3 多余

| 编号 | 内容 | 危害 | 处置 |
| --- | --- | --- | --- |
| E1 | 四处 `node_modules.old/` | 污染 lint 与 format 门禁，造成 8803 条误报 | 已隔离，建议删除 |
| E2 | `.tmp/` 下 20 余个诊断脚本与日志 | 占用空间，长期价值有限 | 待确认 |

## 八、已执行的补全动作

| 序号 | 动作 | 命令或改动 | 结果 |
| --- | --- | --- | --- |
| 1 | 应用数据库迁移 | `pnpm db:deploy` | 补上 `20261010165220_launch_profiles` 与 `20261010180508_launch_history`，九张表到位 |
| 2 | 数据库连接自检 | `pnpm db:ping` | 通过，角色 4 行、权限 11 行、角色权限 29 行 |
| 3 | 忽略规则覆盖依赖备份 | 修改 `.prettierignore` 与 `eslint.config.js` | lint 与 format 误报归零 |
| 4 | 重新生成 Prisma 客户端 | 由 typecheck 触发 | 与当前 schema 对齐 |

后两项已提交入库，提交号 `3bdc45b`。

## 九、门禁验证结果

| 门禁 | 修复前 | 修复后 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | 通过 |
| `pnpm test` | 本次首次执行 | 通过，138 个测试，12 个套件 |
| `pnpm lint` | 失败，8803 条 | 通过 |
| `pnpm format:check` | 失败，57 个文件 | 通过 |

四道门禁现已全部通过。

## 十、待处理事项

按优先级排列。最后一列是 2026-10-11 15:40 的处置结果。

| 优先级 | 事项 | 说明 | 处置结果（2026-10-11 15:40） |
| --- | --- | --- | --- |
| P0 | 决定 `dev` 分支走向 | 落后 main 4 个提交，需决定跟进或保留分叉 | **已决：跟进。** `dev` 已快进对齐 `main`（两条分支同为 `2cfdb42`）并推送 `origin/dev`。原本设想的「dev 领先、main 稳定」从未发生 —— 一直是 main 领先，说明分支约定没有被真正执行；在出现实际的分叉需求之前，按「`dev` 跟随 `main`」处理 |
| P1 | 决定是否删除四处 `node_modules.old` | 忽略规则已隔离其影响，删除可回收空间 | **已分析，暂不删除。** 结论明确是「应当删除」，依据见第十一节；删除与否等用户另行决定 |
| P1 | 创建首个用户账号 | 数据库 `users` 表为空，界面登录依赖它 | **已完成。** owner `fanhe` 已建，`users` 行数 1；口令写入被忽略的 `.tmp\owner-credentials.txt`。副作用：`apps/api/test/setup.test.ts` 的 5 项首次初始化用例转为设计性跳过 |
| P2 | 清理 `.tmp` 诊断脚本 | 其中 `sync-handoff.py`、`verify-migration.mjs` 有复用价值，可归档到 `infra/docs` | **已完成，但落点改了**：归档到 `projects/fanhe-work/tools/`。**不是 `infra/docs`** —— `infra\` 是工作区机制层，而这些脚本的内容全是 fanhe-work 的项目细节（`apps\api`、`schema.prisma`、pnpm 门禁），混进 `infra\` 会把两层搅在一起。盘符已换成向上查找 `.ws-root`；`.ps1` 补了 UTF-8 BOM（原因见 `tools\README.md`）；`.tmp\` 里的旧位置已删除 |
| P2 | 确认 `leak-baseline.json` 是否需要生成 | 属机制状态文件 | 未处理 |
| P2 | 浏览器级端到端验证 | 需用户账号就绪 | 未处理（账号现已就绪，具备执行条件） |

其中「`.tmp` 重复的缓存与测试残留」是本轮新识别的一类：`node-compile-cache`、两个
`fanhe-work-e2e-*` 浏览器用户数据目录、`tsx-*` 编译缓存共 **73.1 MB / 约 4900 个文件，
占 `.tmp` 体积的 99%**，全部可重建。已按用户决定一并清理，`.tmp` 从 73.6 MB 降到
0.4 MB，只留下日志与 `owner-credentials.txt`。

---

## 十一、`node_modules.old` 分析（为什么应当删除）

四处目录：`projects\fanhe-work\`、`apps\api\`、`apps\web\`、`packages\shared\` 各一处。

### 它是什么

**它是工作区换盘符时留下的上一代依赖树，不是源码、不是缓存，也不是任何东西的备份。**

证据是软链接指向：四处目录的顶层软链接**全部指向 `/e/fanhe Work/...`，指向 `/f/` 的
为零**。工作区原先在 `E:` 盘，现在在 `F:` 盘，而 `E:\fanhe Work` 已经不存在
（`E:` 盘还在，但上面是别的目录）。pnpm 的 `node_modules` 是一层指向 `.pnpm` 的软链接
农场，换盘符后旧链接全部悬空，于是重建时把旧目录改名 `.old` 留了下来。

三个量化事实：

| 项目 | 数值 |
| --- | --- |
| 顶层软链接指向 `/e/` 的比例 | 27 / 27 = **100%**（根 8、api 7、web 11、shared 1） |
| 实体文件（软链接不计） | 23 802 个，合计 **489 MB** |
| `.pnpm` 条目数 | 旧 415 / 新 415 —— **与现役依赖树完全重复** |

### 为什么应当删除

1. **它已经不能用了。** 悬空软链接指向一个不存在的路径，`require` 任何东西都会失败。
   它既不能回滚依赖，也不能提供任何东西 —— 作为「备份」它是不合格的。
2. **它和现役依赖树完全重复，占 489 MB。** 其中 471.7 MB 在项目根，17.4 MB 在 `apps\web`。
   工作区在 U 盘上，这 489 MB 会随每次整盘复制、克隆、备份一起搬运。
3. **它污染门禁。** `node_modules/` 这类忽略规则匹配不到 `node_modules.old/`，于是被
   eslint 与 prettier 扫到 —— 实测产生 **8803 条 lint 报错与 57 个格式违规**，全部与
   源码无关。已在 `eslint.config.js` 与 `.prettierignore` 两处加规则隔离，但那只压住了
   症状：目录还在，就还要靠两份忽略规则记得它。
4. **它不在版本控制里，也不是交付物。** `git ls-files` 命中 0 条，且被忽略规则覆盖。
5. **重建成本为零。** `pnpm-lock.yaml` 在版本控制内，`pnpm install` 可随时重建，且
   重建出来的树会指向当前盘符 —— 这正是它当初被留下的原因，也是它现在必然过期的原因。

### 唯一的反向考虑

如果依赖树在某个特定提交上「恰好能跑」，而 `pnpm install` 之后 `pnpm-lock.yaml` 的解析
结果变了（例如 registry 撤了某个版本），留着旧树**理论上**还有一点点价值。但这个价值
兑现不了 —— 悬空软链接意味着它现在就跑不起来。所以这条不成立。

### 结论

**应当删除，风险接近于零。** 本轮按用户决定**暂不执行**，先把分析落档。删除方式：

```bash
rm -rf "projects/fanhe-work/node_modules.old" \
       "projects/fanhe-work/apps/api/node_modules.old" \
       "projects/fanhe-work/apps/web/node_modules.old" \
       "projects/fanhe-work/packages/shared/node_modules.old"
```

删完跑一次 `pnpm install` 与四道门禁确认无碍即可。**不要删 `node_modules/`本身**，
那会需要重新安装（几分钟量级）。

---

## 附、与既有文档的关系

本报告与 `SYNC-AUDIT-2026-10-11.md` 的关系如下。审计文档是 12:45 的快照，本报告是 14:35 的快照，覆盖其三处已过时结论与若干个待处理项的当前状态。审计文档中列为待处理的数据库重建、门禁执行、`node_modules.old` 清理三项，本报告给出了进展与结论。
