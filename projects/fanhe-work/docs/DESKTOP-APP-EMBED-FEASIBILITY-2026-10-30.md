# 桌面客户端内嵌工作台 技术可行性评估与方案

> 评估日期 2026-10-30 · 对象 QQ / 微信 / 千牛 · 目标宿主 梵禾 Work 桌面端（Electron 44.7.0）
> 状态：**待阿阳确认，未做任何代码改动**

---

## 一、结论先行

**"把 QQ、微信、千牛完整内嵌进工作台窗口内使用"这个目标，在 Windows + Electron 组合下没有一条同时满足「功能完整、稳定、合规」的路径。**

三个关键判断：

1. **真内嵌（窗口重父化）在 Electron 里是高风险路线**。技术上能跑通，但 Electron 的窗口由 Chromium 与 DWM 合成，把外部 HWND 塞进这个层级会引发 DPI、z-order、焦点、弹窗不跟随等一系列问题，属于长期维护负担。
2. **截屏串流（捕获 + 输入转发）被三条硬约束否决**。最小化后无 DWM 表面无法捕获；目标若是 Chromium 系（QQ 确认是 Electron），被完全遮挡时会停止渲染导致冻结帧；目标若启用内容保护则跨进程无法解除。三者都有实测或源码级证据。
3. **网页版替代只能覆盖千牛的一部分**。微信网页版对新账号基本关闭且功能残缺，QQ 无网页版，千牛网页版的客服接待能力需实测。

**务实结论：可行，但需要把目标从「内嵌」降级为「同屏聚合」。** 推荐三层递进方案，第一层零风险且能覆盖日常 80% 需求，第二层对千牛做真嵌入，第三层作为可选技术验证。

---

## 二、现状基线（已具备的能力）

工作台不是从零开始，桌面壳已经有三块可复用的地基：

| 已有能力 | 位置 | 对内嵌的价值 |
|---|---|---|
| 三个客户端的安装探测与启动 | `apps/desktop/src/launch-registry.ts`，已内置 `qq` / `wechat` / `qianniu` 三个 matcher，能从注册表 `DisplayIcon` 与 `InstallLocation` 反推主程序路径 | 省掉「找 exe」这一步，`launch:run` 通道已通 |
| 外部进程拉起 + 失败如实上报 | `ops-shop-login.ts`，`spawn` + 日志回读 + `collector_missing` 等结构化失败原因 | 提供了「不假装成功」的工程范式，可直接沿用 |
| 受控 IPC 面 | `preload.ts` 经 `contextBridge` 暴露 `window.fanheDesktop`，`contextIsolation: true` / `nodeIntegration: false` | 新增窗口能力要走同一条受控通道，不破坏现有安全模型 |

注意一个既有约束：打包态的安装目录里**没有** `tools/collector`，`ops:shop-login` 在安装版常返回 `collector_missing`。任何依赖工作区脚本的新能力，都要先想清楚它在安装态是否存在。

---

## 三、四条技术路径逐条评估

### 路径 A：窗口重父化（SetParent）

把目标进程的顶层 HWND 设为工作台窗口的子窗口，实现"视觉上在内部"。

**成立条件**：目标窗口是标准 Win32 顶层窗口、DPI 感知模式与宿主一致、不自行创建额外顶层弹窗、权限级别与宿主相同。

**优点**
- 唯一能做到"真正嵌在内部"的路径，目标窗口随宿主裁剪、随宿主移动，无性能损耗
- 输入法、文件拖拽、右键菜单、滚动全部原生，无需转发
- 不读取目标进程内存，不注入代码

**限制与缺陷（有据可查）**
- **DPI 缩放错乱**：宿主与目标进程的 DPI 感知级别不一致时，子窗口内容会模糊或尺寸跳变，需要 `SetProcessDpiAwarenessContext` 对齐，跨显示器拖动时仍可能失效
- **resize 时窗口可能被重建**：Qt 侧有直接复现记录，`QMainWindow` 在被 dock 时会销毁并重建窗口（`keithel/qt6_surfacechange_on_setparent`）；WinUI3 侧有 SetParent 后无法调整尺寸的记录（`danielancines/winUI3-setParent`，Win11）
- **弹窗不跟随**：目标程序新建的对话框、通知窗、悬浮窗是独立顶层窗口，不会成为子窗口，会脱离宿主跑到屏幕别处
- **跨权限级输入阻断**：Windows 的 UIPI 会阻断管理员窗口与普通窗口之间的输入。`leafOfTree/WindowTabs` README 原文："Run as administrator? Not needed and not recommended. Windows blocks some input between admin and normal windows"。千牛若以管理员身份运行，这条路直接断
- **对话框不参与分组**：同一 README 原文 "Dialogs don't get tabs"，说明成熟产品也无法接管对话框
- **最小化/还原状态机冲突**：父子窗口的 `IsIconic` 状态互相干扰，容易出现"宿主还原了但内容区空白"
- **在 Electron 里尤其别扭**：Electron 主窗口的内容由 Chromium 合成到 GPU 表面，再交给 DWM。插入一个外部 HWND 相当于在合成层里开洞，z-order 与 DWM 圆角/阴影会打架，Electron 官方没有任何 API 支持这件事

**合规**：SetParent 不改目标进程内存、不 hook、不读 token，属于窗口管理范畴，风险低于注入。但目标客户端若检测异常窗口状态（千牛有 SafeGuard 类保护），行为不可预期。

**结论**：不建议作为主线。可作为技术验证分支。

---

### 路径 B：窗口捕获 + 输入转发（截屏串流）

用 `desktopCapturer` / WGC 拿到目标窗口画面，渲染到工作台的 `<video>`，再通过 `SendInput` 把鼠标键盘事件投回目标窗口。

**优点**
- 零侵入，安全边界最清晰，完全不碰目标进程
- 天然支持任意客户端，与客户端技术栈无关
- 可在画面上叠加自己的 UI（标注、快捷回复面板）

**三条否决性约束**

1. **最小化后完全无法捕获**。实测记录原文："A minimised window has no DWM surface, so it cannot be captured at all … Minimised: zero frames, IsIconic true. Restored: 83 frames."（pioneering.app 博客，覆盖窗口捕获实测）
2. **Chromium 系目标被遮挡时停止渲染**。同一实测指出 Chrome 在 Windows 上计算原生窗口遮挡，窗口被完全覆盖时停止渲染前台标签页，捕获"delivers the same still frame forever, which looks like a bug in the capture code"。规避办法是给目标加 `--disable-features=CalculateNativeWinOcclusion`，**而你无法给别人的 QQ 加启动参数**。QQ NT 已确认是 Electron 架构（LiteLoaderQQNT 通过代理 `BrowserWindow` 构造函数注入 preload，是公开证据），因此大概率命中这条
3. **内容保护无法跨进程解除**。若目标调用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`，窗口从所有 WGC 管线中消失。IOActive 对 Signal Desktop 的分析明确记录：跨进程直接调用该 API 返回 `ERROR_ACCESS_DENIED`，提权同样失败，所有权检查在 `win32kfull!NtUserSetWindowDisplayAffinity` 内。千牛这类涉及店铺资金与交易数据的客户端，启用内容保护并非不可能

**其他不可接受点**
- **输入法候选框不在捕获画面内**。IME 候选窗是独立窗口，中文输入时用户看不到候选词，对以中文沟通为主的场景是硬伤
- 无法选中文本复制、无法拖拽文件进出、无法使用系统右键菜单
- 延迟与画质需要折衷，长时间盯屏有视觉疲劳

**结论**：适合"远程旁观/演示"，不适合作为日常办公替代。**不推荐**。

---

### 路径 C：网页版真嵌入（WebContentsView）

用 Electron 的 `WebContentsView`（Electron 30+ 引入，替代已废弃的 `BrowserView`）加载各家网页版，做真正的标签页式内嵌。

**优点**
- 唯一"官方支持、长期稳定、可维护"的嵌入方式
- 可做多标签、可注入 CSS/JS 做界面适配、可统一未读角标与通知
- 有成熟参照：`ferdium/ferdium-app`（4759 star，TypeScript + Electron）已用这套思路聚合数十种服务多年，其 `ferdium-recipes` 用声明式 recipe 描述每个服务的 URL、未读判断、通知注入

**逐家可行性**

| 客户端 | 网页版现状 | 判定 |
|---|---|---|
| 千牛 | 淘宝有官方 web 卖家后台。`qianniu.taobao.com` 实际指向「千牛应用平台」开发者站，卖家工作台入口需另行确认 | 部分可行，客服接待能力待实测 |
| 微信 | `wx.qq.com` 域名可访问，但新注册账号基本提示"不支持网页版登录"，功能残缺（无朋友圈、无支付、无小程序，语音视频不支持） | 不可行 |
| QQ | 无可用网页版 | 不可行 |

**限制**
- 千牛网页版登录要过淘宝的风控（扫码、滑块、设备指纹），嵌入在 WebContentsView 里可能被判定为异常环境而拒绝，需要实测
- 网页版能力是客户端能力的子集，客服工作台的很多功能（快捷短语、自动回复、多店切换）在网页端未必齐全
- 必须用独立 `partition`（如 `persist:qianniu`）隔离会话，不能与工作台主 session 混用，否则 cookie 与权限边界混乱

**结论**：对千牛值得做，对微信与 QQ 无效。

---

### 路径 D：协议层 / RPA / 客户端插件

代表项目：`wechaty/wechaty`（23450 star）、`wechatferry/wechatferry`（2109 star）、LiteLoaderQQNT 生态。

**明确排除。** 三条理由：
1. 违反工作台既有红线（不读 AuthSDK token、不注入 DLL、不绕过 SafeGuard）
2. 违反平台用户协议，账号封禁风险由阿阳本人承担
3. 与需求不符。阿阳要的是"在同一个窗口里用这些软件"，不是"用程序替人发消息"。协议层解决的是自动化，不解决界面聚合

---

## 四、GitHub 开源项目检索结果

检索方式：GitHub 仓库搜索 API，按关键词与 topic 组合，按星标排序。以下为可参考性评级。

| 项目 | 星标 | 语言 | 许可 | 与本需求的关系 | 可参考性 |
|---|---|---|---|---|---|
| `leafOfTree/WindowTabs` | 1019 | F# / .NET 4.8 | MIT | Windows 桌面窗口标签化，与"把多个客户端聚成一个窗口"目标最接近。README 明确记录了管理员权限、对话框、DPI 三类限制 | **高**，作为限制清单的权威来源，架构可借鉴，代码不可直接复用（F#/WinForms 栈不匹配） |
| `ferdium/ferdium-app` | 4759 | TypeScript / Electron | Apache-2.0 | 网页版聚合的成熟实现，recipe 机制、未读角标、通知统一 | **高**，路径 C 的直接参照，技术栈与工作台一致 |
| `sentialx/node-window-manager` | 437 | C++ (Node addon) | MIT | Node 侧枚举/移动/监听窗口，封装 Win32 | **中高**，路径 A 与"窗口停靠"的现成底座，可省掉自己写 FFI |
| `wechaty/wechaty` | 23450 | TypeScript | Apache-2.0 | 协议/RPA 机器人 | **排除**，不合规 |
| `wechatferry/wechatferry` | 2109 | TypeScript | MIT | 微信 hook | **排除**，不合规 |
| `keithel/qt6_surfacechange_on_setparent` | 0 | C++ | 未标注 | 复现 SetParent 导致窗口销毁重建 | 证据价值高，代码价值无 |
| `danielancines/winUI3-setParent` | 0 | C# | 未标注 | 复现 Win11 下 SetParent 后无法调整尺寸 | 同上 |
| `kkyule12322/dahua2-multi-boxing-tool` | 1 | C | 描述称"零 SetParent，含 8 条跨进程置前/收编/热键踩坑" | 反面经验集 | 值得读，星标低需自行判断可信度 |

**检索结论**：没有一个项目直接实现"把 QQ/微信/千牛嵌进 Electron 工作台"。WindowTabs 证明了窗口标签化在 Win32 层可行但限制众多；Ferdium 证明了网页版聚合可行但只对提供网页版的服务有效。**没有可以直接 fork 迭代的现成方案，只能借鉴思路。**

---

## 五、硬约束汇总

按影响程度排序，这些决定了方案的形态：

1. **最小化窗口不可捕获**（DWM 无表面），排除捕获路线作为主交互
2. **Chromium 系目标被遮挡即停止渲染**，且无法修改他人启动参数，同上
3. **UIPI 跨权限级输入阻断**，若千牛以管理员运行，SetParent 与输入转发同时失效
4. **中文输入法候选框是独立窗口**，任何"画面搬运"方案都无法让用户看到候选词
5. **微信网页版对新账号关闭**，微信只能走原生客户端
6. **Electron 无官方 API 支持嵌入外部 HWND**，路径 A 全程依赖非官方手段
7. **打包态不含 `tools/collector`**，任何依赖工作区脚本的能力在安装版失效

---

## 六、推荐方案：三层递进（同屏聚合，而非窗口内嵌）

把目标从"内嵌"改为"聚合"，用三层覆盖不同紧迫度。

### 第 0 层：一键唤起与状态感知（已具备 80%）

复用 `launch-registry` + `launch:run`，补齐"已运行则前置而非重复启动"。

- 用 `node-window-manager` 或 Win32 `FindWindow` 按进程名找已有窗口，存在则 `SetForegroundWindow` 前置，不存在则 `spawn` 启动
- 工作台侧边栏给出三个入口，显示运行状态与未读提示（未读需另想办法，见第 8 节）
- 成本最低、零合规风险、当天可完成

### 第 1 层：窗口停靠（推荐主线）

**不做 SetParent，做窗口随动。** 外部客户端保持独立顶层窗口，但被工作台"吸附"到内容区的指定位置，跟随工作台移动、缩放、最小化、失焦。

技术要点：
- 工作台渲染层预留占位区（一个 DOM 元素），主进程通过 IPC 拿到它的屏幕坐标
- 主进程用 `SetWinEventHook` 监听目标窗口的 `EVENT_OBJECT_LOCATIONCHANGE` 与 `EVENT_SYSTEM_MINIMIZEEND`，用 `SetWindowPos` 把目标窗口摆到占位区矩形上
- 监听宿主窗口的 `move` / `resize` / `minimize` / `blur`，同步驱动目标窗口
- 处理 z-order：目标窗口是独立顶层窗口，会盖住工作台的下拉菜单与弹窗。需要在工作台打开浮层时把目标窗口临时移出（移出屏幕或最小化），关闭浮层后复位

**为什么优于 SetParent**
- 不改变窗口所有权，不碰目标进程，稳定性接近原生
- 输入法、拖拽、右键、快捷键全部原生可用，没有候选框问题
- 目标程序弹窗虽不跟随，但因为它本来就在屏幕坐标上，用户不会觉得"丢了"
- 崩溃隔离：目标客户端崩溃不影响工作台

**局限（需如实告知）**
- 视觉上不是"真的在里面"。切换 Alt+Tab 时目标窗口仍是独立条目，任务栏可能有两个图标
- 需要处理 DWM 圆角与阴影，边缘会有视觉接缝
- 目标窗口全屏或最大化时会脱离停靠区
- 多显示器与不同 DPI 混合时，坐标换算需实测校正

### 第 2 层：千牛网页版真嵌入（可选，取决于实测）

用 `WebContentsView` + `persist:qianniu` 分区加载淘宝卖家后台，做真正的标签内嵌。

- 前置验证：**先手工在浏览器里确认客服接待、订单处理、快捷回复三项在网页版是否可用**。不可用则本层直接放弃
- 若可用，参照 Ferdium 的 recipe 结构做一层薄封装：URL、未读判断、通知注入

### 明确不做的

- SetParent 窗口重父化（作为独立技术验证可做，不进主线）
- 捕获串流 + 输入转发（硬约束过多）
- 任何形式的注入、hook、协议对接

---

## 七、功能范围

**范围内**
- 三个客户端的一键唤起、运行状态显示、窗口前置
- 窗口停靠：位置跟随、缩放跟随、最小化联动、失焦联动
- 停靠区布局可切换（左侧栏 / 右侧栏 / 全宽 / 隐藏）
- 工作台浮层打开时自动让位
- 异常兜底：目标窗口找不到、客户端未安装、权限级别不一致时给出可执行的提示文案

**范围外**
- 消息读取、未读计数、消息搜索（需要协议层，已排除）
- 在工作台内转发消息、批量回复
- 多开、账号切换
- 修改客户端界面

未读提示若确实需要，可考虑第 1 层的附带能力：读取目标窗口标题栏的未读数字（微信/QQ 标题会带角标），这条路不碰进程内存，只读窗口标题，风险可控。但属于加分项，不进第一版。

---

## 八、关键难点与风险

| 难点 | 具体表现 | 应对 |
|---|---|---|
| 坐标换算 | DOM 占位区坐标 → 屏幕坐标，要叠加 DPI scaleFactor、窗口边框、标题栏高度、多显示器偏移 | 先写一个坐标自检页，用截图比对校准，不靠公式推导 |
| z-order 冲突 | 外部窗口盖住工作台的下拉菜单、Dialog、Toast | 浮层打开时移出目标窗口，用统一的浮层状态机驱动，不在各处散写 |
| 目标窗口生命周期 | 用户手动关闭/重开客户端、客户端自更新重启、进程崩溃 | 监听进程退出 + 定时兜底轮询，状态机收敛到单一真值 |
| 权限级别不一致 | 千牛以管理员运行、工作台普通权限，`SetWindowPos` 可能被拒 | 启动时检测目标进程完整性级别，不一致时降级为"仅唤起不停靠"并说明原因 |
| 与现有 Dialog 布局问题的叠加 | 记忆里记着 `DialogContent` 基类是 `fixed`，调用处加定位类会被 tailwind-merge 覆盖导致面板出视口（2026-10-30 真实故障，门禁全绿） | 停靠区若用 Dialog/Popover 承载，必须避开定位类冲突，补一条布局断言用例 |
| 打包后原生依赖 | `node-window-manager` 是 C++ addon，需要针对 Electron 44 的 ABI rebuild | 在 `electron-builder` 配置里走 `asarUnpack`，并把 rebuild 纳入 `dist` 前置检查；否则安装版白屏 |
| 门禁适配 | 新增原生依赖与 `.node` 文件会撞 lint / prettier / 忽略规则 | 三处忽略规则同步（`.gitignore`、`eslint.config.js` 的 `ignores`、`.prettierignore`） |

**合规风险分层**
- 自用（阿阳单机）：风险低。窗口管理不违反客户端协议
- 分发（装到别人机器）：风险显著上升。可能被判定为篡改客户端环境，千牛侧尤其敏感
- 建议：第一版按自用设计，不对外分发。若将来要分发，需重新做合规评估

---

## 九、实施步骤与优先级

### P0 唤起与前置（预估 1 天）
1. 扩展 `launch-registry` 增加"按进程名查已有窗口"能力
2. 新增 IPC 通道 `launch:focusOrStart`，走既有 preload 受控通道
3. 工作台侧边栏接入三个入口与运行状态
4. 验收：重复点击不产生第二个实例；未安装时给出可执行提示

### P1 窗口停靠（预估 3 到 5 天，主线）
1. 引入原生窗口库，先只做 `getWindows` + `setPosition`，跑通 ABI rebuild 与打包
2. 写坐标自检页，用真实截图校准 DOM → 屏幕的换算，覆盖 100% / 125% / 150% 三档缩放
3. 实现 `SetWinEventHook` 监听与 `SetWindowPos` 同步，先做"移动跟随"，再做"缩放跟随"
4. 接最小化 / 失焦联动
5. 接浮层让位状态机
6. 补反例测试：目标窗口被手动拖走、被关闭、客户端以管理员运行三种场景下不出现"卡死但不报错"

### P2 千牛网页版嵌入（预估 2 天，前置验证不过则放弃）
1. 手工验证网页版客服接待可用性（这是 Go / No-Go 门槛）
2. `WebContentsView` + `persist:qianniu` 分区
3. 标签切换、登录态保持、退出清理

### P3 可选技术验证（不进主线）
- SetParent 最小原型，仅用于验证 Electron 44 + Win11 下的实际表现，产出结论文档，不合并到主线

---

## 十、技术栈假设前提

方案成立依赖以下假设，任一不成立需要重新评估：

1. **桌面端继续使用 Electron**（当前 44.7.0），不改用 Tauri 或原生
2. **只支持 Windows 10 1809+ / 11 x64**，不承诺 macOS 与 Linux（`SetWinEventHook` 是 Win32 专有）
3. **单机自用，不对第三方分发**，不触发客户端安全策略的商业级审视
4. **接受引入原生 C++ 依赖**（`node-window-manager` 或 `koffi`），并接受它为打包与 CI 带来的额外复杂度
5. **主窗口维持单窗口单 renderer 架构**，停靠区作为页面内的一块区域存在，不改造为多窗口
6. **不新增后端服务**，全部能力落在桌面壳主进程，API 与数据库不动
7. **不使用注入、hook、协议对接**，红线不变
8. **接受"聚合"而非"内嵌"的产品形态**，即视觉上目标客户端是贴在旁边的独立窗口，而非真的渲染在工作台的 DOM 层级里

第 8 条是整个方案的成败关键。若阿阳要求"必须看起来像工作台内部的一个标签页，切换标签时客户端跟着切换"，那么第 1 层的窗口停靠无法满足，只能退回路径 A（SetParent），并接受其全部缺陷与维护成本。

---

## 十一、待确认的决策点

1. **产品形态**：接受"同屏聚合"（窗口停靠，稳定），还是坚持"真内嵌"（SetParent，脆弱）？
2. **优先级**：三个客户端是同等重要，还是千牛优先（因为它与运营看板、采集器直接相关）？
3. **未读提示**：是否需要在工作台侧边栏显示未读数？若需要，是否接受"读窗口标题"这种近似方案？
4. **是否做 P2**：千牛网页版嵌入要不要先做一次手工验证再决定？
5. **分发范围**：确认只自用，还是要考虑将来给同事装？

---

## 参考来源

- `leafOfTree/WindowTabs` README（1019 star，MIT）：https://github.com/leafOfTree/WindowTabs
- `sentialx/node-window-manager`（437 star，MIT）：https://github.com/sentialx/node-window-manager
- `ferdium/ferdium-app`（4759 star，Apache-2.0）：https://github.com/ferdium/ferdium-app
- `wechaty/wechaty`（23450 star）：https://github.com/wechaty/wechaty
- `wechatferry/wechatferry`（2109 star）：https://github.com/wechatferry/wechatferry
- SetParent 缺陷复现：`keithel/qt6_surfacechange_on_setparent`、`danielancines/winUI3-setParent`
- 窗口捕获实测与最小化限制：https://pioneering.app/blog/capturing-a-covered-window
- WGC / BitBlt / DXGI 捕获能力对比与黑屏成因：https://ryanpromax.github.io/zh/blog/pc-window-capture
- `WDA_EXCLUDEFROMCAPTURE` 跨进程不可解除（Signal Desktop 分析，含 `win32kfull!NtUserSetWindowDisplayAffinity` 所有权检查）：https://www.ioactive.com/signal-windows-desktop-contentprotection-bypass/
- QQ NT 为 Electron 架构（LiteLoaderQQNT 代理 `BrowserWindow` 注入 preload）：https://github.com/LiteLoaderQQNT/LiteLoaderQQNT
- 千牛开放平台（`qianniu.taobao.com` 实际指向）：https://qndoc.taobao.com/
- 微信网页版限制（多来源二手信息，需实测确认）：`wx.qq.com` 域名可访问，新账号基本不支持登录
