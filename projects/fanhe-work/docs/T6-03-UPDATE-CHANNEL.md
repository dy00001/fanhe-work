# T6-03 外壳升级通道 · 施工方案（开工前）

> 生成时间 2026-10-13，代码基线 `5fee842`（`main` / `dev` / 远端三者一致）。
> **本文件只做方案与决策，不含实现。** 依据：`DEVELOPMENT-PLAN.md` §3 第 224 行（任务定义）、§6.3 第 6 条（签名密钥保管约定）、§7 阶段六第 396~398 行（三条验收）。
> 发布载体已由用户于 2026-10-13 定为 **GitHub Release**。签名方案见第六节，**待决**。

---

## 一、先把验收判据拆成能跑的断言

计划文档给的三条验收都是「一句话」，开工前必须先变成可判定的东西 —— 否则「签名校验生效」这句话没有任何判据，写成什么样都能自称通过。

| 原文（§7 阶段六） | 可执行形态 | 本轮可验性 |
|---|---|---|
| 服务端发布新版本后客户端重启即加载新版 | 装 A 版 → 发布 B 版 → 壳内触发检查 → 下载 → 安装 → 重启后 `app.getVersion() === B` | 能验，但需真发布一次 |
| 旧版本有明确提示 | T6-02 已给出（`TopBar` 里只在 `outdated` 渲染的「服务端已是 vX…」） | 部分，见 §三.3 |
| 安装包签名校验生效 | **取决于签名方案**，三选一各自能证的强度差很多（§六） | 取决于决策 |

**任务行原文是「`electron-updater` 通道与签名校验 → 差分下载可用，签名校验生效」。**

「差分下载」这四个字是有具体所指的：electron-updater 在 NSIS 目标上走**块级差分**（blockmap）。所以发布时必须同时产出并上传 `.exe`、`.exe.blockmap`、`latest.yml` 三件；**只传 exe 会让「差分下载可用」这条永远无法成立**（updater 会静默退化成整包下载，看不出错）。这条要进验收脚本，且必须有反例测试。

---

## 二、零起点盘点（全部实测，非推断）

| 项目 | 实测结果 | 对 T6-03 的意义 |
|---|---|---|
| `electron-builder` / `electron-updater` | **未安装**（`node_modules/.pnpm` 与顶层均无） | 零起点，从加依赖开始 |
| 代码签名证书 | 工作区内**无 `.pfx` / `.p12`** | 签名方案必须现定（§六） |
| `apps/desktop/package.json` | `version: "0.0.0"`、`private: true`、`main: "dist/main.js"` | 见 §四.3，版本号单一来源会被打破 |
| 主进程模块形态 | CJS（`tsconfig` 的 `module: NodeNext`，且 `package.json` **无** `"type": "module"`） | 刻意为之（沙箱化 preload 要 CJS），**不能为打包改成 ESM** |
| 前端产物 | `apps/web/dist` 存在，**888KB** | 体积可控，直接进包 |
| `@fanhe/shared` | ESM（`"type": "module"`，`main: ./dist/index.js`） | desktop 是 CJS 却**引用了它的运行时值** → 见 §三.4 |
| Electron 运行时 | **Electron 44.7.0 内置 Node 24.21.0**（`ELECTRON_RUN_AS_NODE=1` 实测） | 与开发用的 Node 22.22.2 **不是同一版**；打包后跑的是 24，注意别依赖 22 特有行为 |
| `C:\Users\Administrator\package.json` | 存在，装着 `@electron/asar` / `resedit` / `wrangler` | 上次会话遗留的拆包工具链；`gh` 没有但**这对工具在**，可作 electron-builder 失败时的兜底（§九） |
| 远端仓库 | `dy00001/fanhe-work`，**public**，默认分支 `main`，**零 tag** | 见 §四.1、§四.2 |
| `gh` CLI | **本机没有** | 发版动作要靠 API + PAT（§四.4） |
| 磁盘 | F: 30G，可用 **28G** | 够用（Electron 打包缓存约 1~1.5G） |
| `projects/fanhe-work/.gitignore` | 已忽略 `dist/`、`build/`、`out/` | **`build/` 被忽略这件事会咬人**，见 §五.1 |
| 门禁基线 | 496 项 0 失败（desktop 76） | 打包改动不得让 desktop 用例如数下降 |

---

## 三、两条架构冲突与四条隐藏依赖

这是本任务真正的难点。`apps/desktop` 现在是**「工作区里的一份源码」**，而安装包形态下**没有工作区**。

- **两条会让功能直接断掉的架构冲突**：3.1（前端产物路径）、3.2（本机代理源码）。
- **四条不预先处理就会在打包后暴露的隐藏依赖**：3.3（T6-02 文案在桌面端说错话）、3.4（CJS 壳引用 ESM 包）、3.5（投出去的 `.ts` 资源缺 `package.json` 会失效）、3.6（安装路径含空格与中文）。

其中 3.2 与 3.5 的结论是**本轮跑出来的实证**，不是推断 —— 见各自小节里的复现命令。

### 3.1 `DIST_ROOT` 指向工作区兄弟目录 —— 会断

```ts
// apps/desktop/src/main.ts:59
const DIST_ROOT = resolve(__dirname, '../../web/dist')
```

`__dirname` 在打包后是 asar 内的虚拟路径，`../../web/dist` 在安装目录里不存在。

**解法**：按 `app.isPackaged` 分派。打包态从 `process.resourcesPath` 取（用 `extraResources` 把 `apps/web/dist` 投到 `resources/web/`），开发态保持现状。

选 `extraResources` 而不是塞进 asar，理由是**静态服务用 `fs.createReadStream` + `fs.stat` 直读文件**（`server.ts` 只 import 了 `node:fs` / `node:fs/promises` / `node:http` / `node:path`）—— asar 的 fs 透传虽然能读，但 `Range` / `stat.size` / 内容类型推断这些边角在 asar 里是另一套行为。**用真实目录可以完全绕开这一类不确定性**，代价只是多一层壳。

> 判据：打包后跑一次冒烟，断言「渲染元素 > 0」；再往打包目录里塞一个 `.txt` 确认静态服务真的落在 `resources/web` 而不是别处。

### 3.2 本机代理依赖工作区源码 —— 会断，但好消息是它**零运行时依赖**

```ts
// apps/desktop/src/paths.ts:107
export async function apiLaunchModule(fromDir: string) {
  const root = locateWorkspaceRoot(fromDir)   // 向上找 .ws-root
  ...
  const target = join(apiSourceRoot(root), 'launch', 'agent.ts')
  return await import(pathToFileURL(target).href)
}
```

打包后 `locateWorkspaceRoot` 返回 `null`，`一键启动`（首页主卡那条核心功能）直接失效。

**关键发现（本轮已实证，不是推断）：`apps/api/src/launch/agent.ts` 的运行时依赖是零。**

```
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LaunchPathState, LaunchProfile, RunLaunchProfileResponse } from '@fanhe/shared'
```

三条全是 Node 内建；第四条是 **`import type`**，编译期与类型剥离期都会被抹掉。**这意味着这个文件可以原样（连 `.ts` 都不必编译）作为单个资源投进安装包**，`import(pathToFileURL(...))` 就能加载 —— 无需把它编进 desktop 的产物，也无需改它的模块系统。

**实证方式**：把它单独复制到一个**隔离目录**（`C:\Users\Administrator\.workbuddy\tmp-agentcheck\`，无 `node_modules`、无 `@fanhe/shared`、不在工作区内），然后

```bash
node --experimental-strip-types -e "import('file:///…/agent.ts').then(m => console.log(Object.keys(m)))"
```

结果：**加载成功，导出 `PATH_INSPECT_TIMEOUT_MS, RUN_DEDUPE_WINDOW_MS, buildLaunchCommand, inspectExecutablePath, runLaunchProfile` 五项** —— 与 `main.ts` 用到的那两项（`runLaunchProfile`、`inspectExecutablePath`）完全覆盖。**这不是「看着像零依赖」，是换到没有解析环境的目录里真跑通了。**

**解法**：`apiLaunchModule` 增加一条**降级路径**：找不到工作区根时，改从 `resources/agent/agent.ts` 加载同一份源码。开发态仍走工作区（保持「改完 `agent.ts` 下次启动即生效」这个已有性质）。`extraResources` 把 `apps/api/src/launch/agent.ts` 复制过去。

**这条降级路径必须能证伪**：装完之后要真的点一次「一键启动」并由脚本断言进程被创建 —— 只断言「模块加载成功」不足以证明这条链路活着。**另见 §3.6：这个资源旁边必须放一个 `package.json`，否则它在某些目录下会直接加载失败。**

> ⚠️ 注意 `apps/desktop/src/agent.ts`（外壳侧包装）**不是**零依赖，它从 `@fanhe/shared` 取了**运行时的值**：`isAbsoluteExecutablePath`、`LAUNCH_PROFILE_LIMITS`。见 3.4。

### 3.3 T6-02 那句提示在桌面端说错了话 —— 要顺手改

`apps/web/src/lib/version-check.ts:172` 的文案是「服务端已是 vX，**刷新页面即可更新**」。

在**浏览器**里这句话是对的。但在**桌面壳**里，界面来自内置的 `apps/web/dist`（本地静态服务），刷新页面**什么都不会变** —— 用户会照着做、发现没变化，然后不再信这条提示。

这说明 T6-02 是按「前端从服务端取」的模型写的，而 T4-01 的形态是「前端内置 + 只反代 `/api`」。**两者当时没有对齐，T6-03 是必须收口的那一环。**

**解法**：文案按宿主分派。浏览器态维持「刷新页面即可更新」；桌面态改成「已可更新到 vX，重启后生效」并挂到 T6-03 的更新动作上（或先只改文案，动作在 T6-03b 接上）。判据是**同一份 `version-check.ts` 在两个宿主下给出不同文案**，属于纯函数，可单测。

### 3.4 CJS 壳引用 ESM 包 —— 现在靠 Node 的 `require(esm)` 撑着

`apps/desktop/src/agent.ts` 从 `@fanhe/shared` 取的是**值**（不是类型），而 shared 是纯 ESM 包。desktop 是 CJS。现在能跑，是因为 **Electron 44.7.0 内置的 Node 24.21.0** 支持 `require(esm)`。

**已实测**（`ELECTRON_RUN_AS_NODE=1 <electron.exe> -e "require('@fanhe/shared')"`）：Electron 运行时下 `require(esm)` **成功**，`isAbsoluteExecutablePath` 拿到 `function`、`LAUNCH_PROFILE_LIMITS` 拿到 `object`；开发用的 Node 22.22.2 同样成功。**即这条桥在两个运行时上都是通的** —— 它现在不是隐患，但它是「打包后为什么还能跑」的解释，写下来免得将来有人把它当成可疑代码改掉。

打包不会改变这件事，但**打包会改变「这个包在哪」**：electron-builder 默认只收 `dependencies`，而 `@fanhe/shared` 用的是 `workspace:*` 协议、且经 pnpm 符号链接挂载。**这是 pnpm workspace + electron-builder 的已知摩擦点。**

**解法（两条，优先取第一条）**：
1. 在 electron-builder 的 `files` 里显式列出 `node_modules/@fanhe/shared/dist/**`（electron-builder 复制时会解引用符号链接）；
2. 若第 1 条在实跑中不成立，退到把 `packages/shared/dist` 作为 `extraResources` 投进 `resources/`，并让壳侧的 import 走一条显式解析（代价是引入一处非标准的模块解析）。

> 判据：打包后**在安装目录里**（不是在工作区里）跑一次冒烟，断言 `预加载桥=有` 且「一键启动」通道可用 —— 3.4 一旦断，`agent.ts` 会在加载期就抛，而报错会指向 shared 的解析失败。

### 3.5 投出去的那份 `agent.ts` 旁边**必须**放一个 `package.json`

这是上一条实证过程中顺带撞出来的，属于「不预先钉住就会在别人机器上炸」的一类。`agent.ts` 是 ESM 语法的 `.ts`，而它被加载时的模块类型由**最近的 `package.json`** 决定。实测三种情形：

| `resources/agent/` 旁的 `package.json` | 结果 |
|---|---|
| **不存在** | 加载成功，但每次告警：`MODULE_TYPELESS_PACKAGE_JSON … Reparsing as ES module` |
| `{"type": "module"}` | **干净加载，无告警** |
| `{"type": "commonjs"}` | **加载失败**：`SyntaxError: Cannot use import statement outside a module` |

第三种不是假想：**外壳自身的 `package.json` 确实是 CommonJS 形态**（这正是它能产出 CJS 的原因）。安装目录里那份外壳 `package.json` 在 `app.asar` 内、不在真实文件系统路径上，所以默认落到第一种；但**一旦有人（或某个工具链）在安装目录、上级目录、甚至用户主目录放了一份 `"type": "commonjs"` 的 `package.json`，这条链路就会突然全断**，而报错是一个与「打包」看起来毫无关系的 `SyntaxError`。

**解法**：`extraResources` 里除了 `agent.ts`，**一并投一份 `{"type": "module"}` 的 `package.json`** 到同一目录。它同时解决两件事：消掉告警（冒烟脚本要匹配 stdout，噪音会干扰），以及把这个文件的解释方式**钉死**，不受任何上层目录影响。

> 判据：装完之后，用安装目录里的 electron 以 `ELECTRON_RUN_AS_NODE=1` 加载那份资源，断言 **stdout 里既无 `MODULE_TYPELESS_PACKAGE_JSON` 也无 `SyntaxError`**。反例测试：把旁边那份 `package.json` 临时改成 `commonjs`，断言加载**确实失败** —— 证明这条断言不是恒真的。

### 3.6 `productName: 梵禾 Work` 含空格与非 ASCII —— 不影响，但要知道

安装目录默认 `%LOCALAPPDATA%\Programs\梵禾 Work`，路径带空格与中文。**当前代码里没有把路径拼进命令行的地方**（`spawn` 走 `execFile` 语义、参数是数组），所以不构成问题；但**任何新加的自检脚本都不要用字符串拼路径**。这条写在这里是为了防止将来有人「顺手」加一处 shell 调用。

---

## 四、发布载体落地（GitHub）

### 4.1 仓库是 public —— 这是一个有后果的事实

`api.github.com/repos/dy00001/fanhe-work` 返回 `private: false` / `visibility: public`。

后果两方面，都要说清：

- **好的一面**：electron-updater 拉 `latest.yml` 与安装包时**不需要任何凭据**。这是最省事、最不容易坏的形态（凭据一旦要进客户端，就等于把 PAT 发给每个用户）。
- **要认的一面**：**任何拿到仓库地址的人都能下载安装包**。安装包里有前端产物、本机代理源码，没有用户数据、没有凭据、没有服务地址密钥 —— 即「公开它不泄露任何机密」，但它把产品的分发面放开了。

因此这一条要用户确认（§十.3）：**接受公开发布**，还是**换一个私有仓库专门放 Release**（那样 updater 就得带凭据，形态会显著变复杂）。

### 4.2 零 tag —— 首次发版要建 tag

远端现在一个 tag 都没有。`electron-updater` 靠 `latest.yml`（发布在 Release 资产里）判断版本，不靠 tag，**但要用 tag 让「哪个提交对应哪个安装包」可追溯**。建议发版时 `v<版本号>` 打 tag 并推到远端。

### 4.3 版本号单一来源会被 `version: 0.0.0` 打破 —— 必须收口

T6-01 定下的不变量是：**产品版本号的唯一来源是仓库根 `package.json`（= `projects/fanhe-work/package.json`，现为 `0.1.0`）**。
- web：构建期由 `vite.config.ts` 注入（`define.__APP_VERSION__`）；
- api：运行时向上找 `pnpm-workspace.yaml` 为根后读它；
- **但 `apps/desktop/package.json` 是 `0.0.0`** —— 而 electron-builder 打的包，其 `app.getVersion()` 读的正是**被打包的那份 `package.json`**。

于是不解决的话，装出来的客户端会自称 `0.0.0`，而 `0.0.0` 恰好是「比任何正式版都旧」的值 —— 这正是 9.49 里记下的那个「看起来完全合法的错误答案」，届时更新提示会**永远为真**。

**解法**：加一个 `prebuild` 步骤（Node 脚本），在 electron-builder 运行前把根 `package.json` 的 `version` 写进 `apps/desktop/package.json`，并在 `pnpm build`/`pnpm test` 之外的路径上不留副作用。**必须配一条断言**：打包后读安装目录里那份 `package.json` 的 `version`，断言它等于仓库根的值。

> 也可以反过来「让 electron-builder 在打包时注入版本」，但那样 `app.getVersion()` 与磁盘上那份清单会分叉，排查时更乱。写回源文件更直白，代价是 `apps/desktop/package.json` 会被改（要确认它**不进** `format:check` 的失败面，并接受一次 diff）。

### 4.4 发版动作怎么做（本机无 `gh` CLI）

三条路，按可靠性排序：

1. **electron-builder 内置的 GitHub publish**（`publish: { provider: 'github', owner, repo }` + `GH_TOKEN` 环境变量）。它负责建 Release、传三个资产、算 blockmap。**首选**，因为 `latest.yml` 的生成与资产名匹配由它保证（手工传最容易漏 `.blockmap`）。
2. 走 GitHub API + PAT 手工建 Release 并上传（`curl -X POST .../releases` + `uploads.github.com`）。作为第 1 条的降级。
3. GitHub 连接器 —— **只读，写入返回 403，不可用**。

凭据复用已有的那份细粒度 PAT（推送已在用，说明它有 `Contents: write`）。**注意不要把它落盘**：发版命令里内联传环境变量，跑完即弃，与既有推送纪律一致。

### 4.5 网络

electron-builder 首次运行会去 GitHub Releases 下载 `winCodeSign`、`nsis`、`nsis-resources` 三个工具包，缓存到 `%LOCALAPPDATA%\electron-builder\Cache`。本机对 GitHub 的连通性有历史问题（三条代理路都可能失败），**因此这一步要预留重试**，且缓存一旦建好就不再依赖网络。这一点要在实施时先单独跑通再动其他东西。

---

## 五、本项目特有的环境陷阱（不预先记下就会踩）

### 5.1 `build/` 已被 `.gitignore` 忽略 —— `buildResources` 默认值正好撞上

`projects/fanhe-work/.gitignore` 第 10 行忽略 `build/`，而 electron-builder 的 `directories.buildResources` **默认就是 `build/`**。

后果很隐蔽：图标与配置放进 `build/` 能打包成功，但**永远进不了版本控制** —— 换台机器拉下来就没有图标，而报错是构建时的「找不到图标」，看起来像有人删了文件。

**解法**：显式指定 `directories.buildResources` 到**被跟踪**的目录（建议 `deploy/`，`docker-compose.yml` 同级已有 `apps/*/deploy/` 的先例），或把 `apps/desktop/build/` 从忽略规则里排除（用 `!` 反排除）。前者更干净。

### 5.2 electron-builder 默认输出目录是 `dist` —— 与 tsc 输出撞车

`apps/desktop/dist` 是 `tsc` 的 `outDir`（`main.js` / `preload.js` 就在里面）。electron-builder 默认把安装包也写到 `dist`。

后果：产物与源码产物混在一起，而且 `files` 匹配到 `dist/**` 时**可能把上一轮的安装包也读进去**（一轮比一轮大）。

**解法**：`directories.output` 设成 `release/`，并把 `release/` 加进 `.gitignore`。**判据**：跑两次 `build`，断言第二次的输入文件集合没有变大。

### 5.3 `onlyBuiltDependencies` 是白名单

`pnpm-workspace.yaml` 里现在只有 `electron` 一项，且注释明确写了 **esbuild 是刻意不在名单里的**（它的二进制走可选平台包）。

`electron-builder` 与 `electron-updater` 自身**没有安装脚本**（`app-builder-bin` 也是预编译二进制），所以**大概率不需要动这张白名单**。但若装完出现「某个包需要跑脚本」，**不要顺手把 esbuild 加进去** —— 那条注释记着加它会以 EBUSY 失败。

### 5.4 安装包的下载与「差分」在本地无法用真网验

在**本机**验证「updater 能拉到线上最新版」这件事，只有两条路：让本机真的去访问 `api.github.com`/`github.com`（网络不稳），或者起一个**本地静态目录**冒充 update server（electron-updater 支持 `provider: 'generic'` 指向任意 URL）。

**推荐后者作为本轮的验收手段**：起一个本地 HTTP 服务托管 `latest.yml` + `.exe` + `.blockmap`，把 `dev-app-update.yml`（或 `app-update.yml`）指向 `http://127.0.0.1:<port>`，从而把「通道是否真的能差分下载并安装」变成**可离线重复**的断言。真网那一次留作最后的端到端确认。

> 本地端口一律加 `--noproxy '*'`，且 electron-updater 在主进程里走 Node 的 fetch —— 注意 `main.ts` 已经 `appendSwitch('no-proxy-server')`，那只影响 Chromium 层，不影响 Node 层，**Node 层要自己确认没被 `HTTPS_PROXY` 劫持**。

### 5.5 冒烟模式必须能在**打包后**跑

现有 `--smoke` 是开发态入口（`scripts/launch.mjs` 拉起 electron，且它依赖 `require('electron')` 返回可执行路径这套把戏 —— 打包后不适用）。

**解法**：让打包产物也能接 `--smoke`（`process.argv` 判断已经是现成的），并在验收脚本里用 `"%LOCALAPPDATA%\Programs\梵禾 Work\梵禾 Work.exe" --smoke` 直接跑，取退出码与 stdout。

### 5.6 换盘符

工作区在可移动介质上，盘符在 `E:` / `F:` 之间变。**发包配置里禁止出现绝对路径**（`directories.output`、`files`、`extraResources` 全部用相对路径；`source`/`from` 亦同）。这条是阶段零就立下的规矩，写在这里是因为 electron-builder 的配置里最容易顺手写路径。

---

## 六、签名方案（**待决**，三选一）

`DEVELOPMENT-PLAN.md` §6.3 第 6 条的约定是「**更新签名密钥与工作空间分开保管，不随盘移动**」。所以判据不只是「能不能签」，还包括「密钥放哪」。

先把「签名」这件事的两层说清楚 —— 它们经常被混为一谈，而**验收里那句「安装包签名校验生效」指的是哪一层，决定了要走哪条路**：

- **A 层（Authenticode 代码签名）**：给 `.exe` 与安装包加盖证书。Windows 会验它（SmartScreen 据此判断信誉）。electron-updater **也能验它** —— electron-builder 会把证书的 `publisherName` 写进 `app-update.yml`，updater 在安装前比对新包的发布者名。
- **B 层（更新载荷完整性）**：electron-updater 默认对下载到的安装包**校验 `latest.yml` 里的 sha512**。这一层**不需要任何证书**，开箱即有。

| 方案 | 能证的「签名校验」 | 成本 | 密钥保管 | 风险 |
|---|---|---|---|---|
| **① 不做 A 层，只认 B 层** | sha512 完整性（防传输损坏 / 防资产被替换） | 零 | 无需密钥 | **不满足 §6.3 第 6 条的隐含前提**（没有密钥可保管）；且 SmartScreen 会报警，用户首次安装要点「仍要运行」 |
| **② 自签证书，装进 Windows 证书库** | A + B 两层，且 updater 真的会验 `publisherName` | 零现金成本，需生成与管理证书 | **Windows 证书库（`CurrentUser\My`）天然「随机器不随盘」**，正好符合 §6.3 第 6 条 | 只对**已装该自签根证书**的机器有效；换机器要重新导入（与「工作区随介质走」的形态有摩擦） |
| **③ 买 OV 代码签名证书** | A + B 两层，且对外可信 | 约 ¥2000+/年，需企业身份核验；**2023 起私钥必须存放于 HSM / 硬件令牌** | 硬件令牌本身就是「不随盘移动」的最佳形态 | 采购周期与年费对「单用户内部工具」偏重 |

**建议：② 自签证书**。理由是它是唯一能给出**双层且可在本机真实断言**的方案，同时天然满足「不随盘移动」；代价（换机要重导证书）与这个产品当前的部署形态（少数几台自己人的机器）匹配。它把「安装包签名校验生效」变成一条**可真跑真验**的断言 —— 而这正是验收最需要的东西。

要点是「把签名做成一条可断言的链路」而不是「买没买证书」：选 ③ 若无采购，方案 ① 会让这条验收判据退化成「sha512 对得上」，与计划文档里写的不是同一件事。

---

## 七、实施分解（建议切成三段，各自可验、可回滚）

切成三段的理由：**打包链路**与**更新逻辑**与**签名**的失败面完全不同，混在一起做时任何一步红了都定位不到是哪一层。这与项目既有的「一次一件事、代码与文档分两笔提交」的纪律一致。

### T6-03a 打包与发布链路（不接 updater）
- 加 `electron-builder`（devDep）与 `apps/desktop/electron-builder.yml`（或 package.json 的 `build` 字段）；
- 版本号同步脚本（§4.3）；
- `extraResources`：`apps/web/dist` → `resources/web`；`apps/api/src/launch/agent.ts` → `resources/agent/agent.ts`，**外加一份 `resources/agent/package.json`（内容 `{"type":"module"}`）**（§3.5）；
- `main.ts` 的 `DIST_ROOT` 分派（§3.1）与 `paths.ts` 的降级路径（§3.2）；
- `release/` 加进忽略；`buildResources` 指向被跟踪目录（§5.1、§5.2）；
- **产物**：`release/梵禾 Work Setup <版本>.exe`，且**打包后冒烟 PASS**、**安装后「一键启动」真的起得来进程**。
- **不接** updater、不发版。

### T6-03b 更新通道（接 `electron-updater`）
- 加 `electron-updater`（如果是依赖，需评估它是 dependency 还是随 builder 注入 —— **它必须在 `app.getVersion()` 之后可用，且要在打包产物里**)；
- 主进程接 `autoUpdater`：启动后检查 → 有新版则下载 → 用户确认后安装并退出；
- 与 T6-02 的提示合流（§3.3 的文案分派）；
- 首个版本之前必须有一个「已发布的前一版」才能验差分 —— 所以要先发一次 v0（即 T6-03a 的产物）作为垫脚石。

### T6-03c 签名
- 按 §六 的决策落地；证书不进版本控制（进 `.gitignore` 与 Windows 证书库）；
- 断言：用错误发布者名的包会让 updater 拒绝安装（**反例测试**，见 §八）。

---

## 八、验收脚本与反例测试

**「全绿」必须能被证伪。** 本任务的验收脚本至少要有三条反例：

1. **差分下载**：把 `latest.yml` 里的 sha512 改一位，断言 updater **拒绝安装**（证明它真的在校验，而不是「下了就装」）；恢复后断言通过。
2. **发布者校验**（选了 ②/③ 才有）：换一个未签名/异证书签的包，断言拒绝。
3. **版本号单一来源**：临时把根 `package.json` 改成 `0.1.1` 再打包，断言安装目录里的版本是 `0.1.1`（证明 §4.3 那条收口真的生效，而不是恰好都是 `0.0.0`）。

另外两条正向断言：
4. 安装 A → 发布 B → 检查 → 下载 → 安装 → 重启，`app.getVersion() === B`。
5. 只传 `.exe` 不传 `.blockmap` 时，**断言差分不可用**（把「差分」这件事本身也钉住，否则它可能一直是整包下载而没人发现）。

---

## 九、风险与回滚

| 风险 | 症状 | 应对 |
|---|---|---|
| electron-builder 首次下载工具包失败 | 打包在「downloading winCodeSign」处卡住/报错 | 已有代理三条路；缓存建成后不再依赖网络。**先单独跑通这一步再动别的** |
| electron-builder 对 pnpm + `workspace:*` 解析失败 | 安装后壳启动即抛模块解析错误 | §3.4 的两条解法，第 2 条是兜底 |
| electron-builder 整体不可用（下载源彻底不通） | 打包无法产出 | **兜底路径**：主目录已有 `@electron/asar` + `resedit`（`C:\Users\Administrator\package.json`），可手工装 asar 并改 exe 资源 —— 但**没有 `latest.yml` 与 blockmap 生成**，等于放弃差分更新，只保留「重装即升级」。属降级，不是等价替代 |
| 打包破坏现有 496 项门禁 | desktop 用例如数下降 | 打包是新增脚本，**不改现有 `build`/`test`/`smoke` 语义**；门禁在改动后必跑 |
| 公开发布安装包 | 见 §4.1 | 待用户确认（§十.3） |
| 走错签名层 | 验收写成「sha512 对得上」但文档写的是「签名校验」 | §六 先定层，再写断言 |
| 打包后跑的是 Node 24 而开发跑的是 Node 22 | 「开发机上好好的」 | §二 已记录；任何依赖 Node 版本行为的新代码要在打包产物上再验一次 |

**回滚**：T6-03a/b/c 三段各自独立提交，任一段出问题只需 `git revert` 那一段；打包改动**不触及**运行时代码路径（`DIST_ROOT` 与 `apiLaunchModule` 的分派都带「开发态维持原行为」的分支），因此回滚后开发态不受影响。

---

## 十、待用户决策

1. **签名方案**（§六）：① 只做 sha512 完整性 / ② 自签证书进 Windows 证书库（**建议**）/ ③ 买 OV 代码签名证书。
2. **打包后外壳的前端来源**（§3.1/§3.3）：**内置产物**（现状，更新通道是唯一的更新途径，与 T4-01 形态一致）/ 改为**加载远程地址**（前端随服务端更新即生效，但壳的本地静态服务与「服务地址切换」会退化）。
3. **公开发布**（§4.1）：接受在公开仓库发 Release / 另建私有仓库专门放 Release。

> 三条都定了之后，按 §七 从 T6-03a 开工。**在 1 未定之前不要动签名相关代码** —— 那是唯一会因决策不同而重写的部分。
