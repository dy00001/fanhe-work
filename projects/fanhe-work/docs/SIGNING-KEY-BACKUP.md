# 签名私钥的保管、读取与多设备一致性

> **这份文档补的是全项目唯一一处「有机制、没备份」的缺口。** 2026-10-14 的签名身份轮换之所以发生，根因不是证书过期、也不是配置写错，而是**私钥从来没有被备份过** —— 它只存在于一个会随会话消失的证书库里，四路穷尽检索（全机四盘按扩展名 / 压缩包内部 / 内容特征 / 证书库逐库枚举）全部落空。
> 整理于 2026-10-14。关联：`apps/desktop/scripts/create-signing-cert.ps1`（脚本头部是本文的原始依据）、`docs/SIGNING-ROTATION-RUNBOOK.md`（轮换手册）、`docs/DEVELOPMENT-PLAN.md` 6.3 第 6 条、`docs/P0-UPDATE-VERIFICATION.md`。

## 零、结论先行

| 资产 | 放在哪 | 谁需要 | 进版本控制吗 |
| -- | -- | -- | -- |
| **私钥**（`.pfx` 或证书库里的 `CurrentUser\My`） | **只放打包机** + **两份加密备份** | **只有打包机** | ❌ **绝不** |
| **公钥**（`fanhe-work-signing-public.cer`） | `apps/desktop/scripts/` | 所有机器 | ✅ **必须** |
| **身份档案**（`signing-identity.json`） | `%LOCALAPPDATA%\FanheWork\signing\` | 打包机（目标机可有可无） | ❌ 逐机状态 |

**当前身份**：`CN=Fanhe Work` / `095CB390A4CD0A64EF89B4364CC095A6A8A2A9BB`，RSA 2048 / SHA256，有效期至 2031-10-14。

## 一、为什么私钥不进工作空间（三条实测事实）

**这不是洁癖，是有具体后果的。** 2026-10-14 实测：

| # | 事实 | 后果 |
| -- | -- | -- |
| 1 | 工作空间根仓库实测为 **`public`**（未认证访问 `HTTP 200`、`private=false`） | 私钥进版本控制 = **公开泄露** |
| 2 | 补规则之前，工作空间里**没有任何**针对私钥的忽略规则 | `.pfx` 是「未跟踪但**未被忽略**」，一条 `git add -A` 就进暂存区 |
| 3 | `create-signing-cert.ps1` 第 755 行**刻意拒绝**把私钥导出到工作空间内 | 这是一道有意加的守卫，绕过它需要显式 `-AllowWorkspaceExport` |

第 2 条已修：工作空间根 `.gitignore` 现在忽略 `*.pfx` / `*.p12` / `*.pvk` / `*.jks` / `*.keystore` / `*.key` / `*.pem`，**且刻意不忽略 `.cer`** —— 公钥必须继续可跟踪，因为「身份一变就在 `git diff` 里显形」正是轮换的绊线（见第三节）。

**并且 `DEVELOPMENT-PLAN.md` 6.3 第 6 条本来就有约定**：「更新签名密钥与工作空间分开保管，不随盘移动。」本文档不推翻它，而是**给它补上缺的那一半**：既然要分开保管，就必须有备份，否则「分开」就退化成「只有一个地方」。

## 二、保管位置（两份副本）

工作空间在可移动介质上。**「只放一份」这个形态正是上次丢私钥的形态** —— 所以本方案要两份，且**两份在不同介质上**：

| 副本 | 位置 | 作用 |
| -- | -- | -- |
| **A（随盘走）** | `<工作空间根>/keys/fanhe-work-signing-095cb390.pfx` | 换机时插上盘就有；已被 `.gitignore` 挡住，不会进版本控制 |
| **B（不随盘走）** | 工作空间**之外**：密码管理器附件 / 网盘 / 另一块盘 | U 盘丢失或损坏时的唯一退路 |

`<工作空间根>` 是**靠向上查找 `.ws-root` 定位的**，不要写死盘符 —— 换机后盘符会变（本机当前是 `E:\fanhe Work`，另一台机器上可能是 `F:\` 或别的）。

🔴 **两份都必须是加密的 `.pfx`。** 私钥**不能**以明文形式落在任何介质上。加密口令只存在你的密码管理器里，**不写进任何文件、不进版本控制、不进对话记录**。

## 三、导出（你自己执行 —— 口令不经过我）

**为什么你自己跑**：口令一旦经过我或出现在对话记录里，就等于泄露过一次（对话记录存在工作空间 `.workbuddy-ai/` 与云端）。所以这一步刻意留给你。

### 步骤 1　开一个 PowerShell 窗口，设口令

```powershell
# 用 Read-Host 而不是直接赋值：Read-Host 的输入不进 PSReadLine 历史，
# 而 `$env:X = '明文'` 会被历史文件记下来。
$sec = Read-Host -Prompt 'PFX 口令' -AsSecureString
$env:FANHE_SIGNING_PFX_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
```

### 步骤 2　导出到副本 A（工作空间内）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "E:\fanhe Work\projects\fanhe-work\apps\desktop\scripts\create-signing-cert.ps1" `
  -ExportPath "E:\fanhe Work\keys\fanhe-work-signing-095cb390.pfx" `
  -AllowWorkspaceExport
```

> **路径按你机器上的实际盘符改。** 用 `-File` 直调而不是经 `pnpm`：这个脚本**不依赖 node/pnpm**，少两层参数转发就少两种出错方式，而且路径里有空格。

🔴 **`-AllowWorkspaceExport` 是必须的，而且它是本次唯一一处刻意绕过守卫。** 脚本**不会**悄悄绕过 —— 报告里会出现一行 `EXPORT_IN_WORKSPACE=True reason=guard-bypassed-by-AllowWorkspaceExport`，让这次决定可被审计。

⚠️ **期望看到 `ACTION=reuse`，而不是 `ACTION=created`。** 主流程是**刻意幂等**的（源码注释：*Idempotent on purpose: re-running must not rotate the signing identity*）—— 证书已在 `CurrentUser\My` 且还剩 1826 天，所以它会**复用**现有证书并直接导出：

```
ACTION=reuse thumbprint=095CB390A4CD0A64EF89B4364CC095A6A8A2A9BB daysLeft=1826
EXPORT=…\keys\fanhe-work-signing-095cb390.pfx
EXPORT_THUMBPRINT=095CB390A4CD0A64EF89B4364CC095A6A8A2A9BB
EXPORT_IN_WORKSPACE=True reason=guard-bypassed-by-AllowWorkspaceExport
```

**若出现 `ACTION=created` —— 立刻停下。** 那意味着它造了一张新证书，也就意味着一次计划外的轮换（后果见 `SIGNING-ROTATION-RUNBOOK.md` 第一、二节）。此时**不要**继续，先用 `-ImportPath` 把正确身份导回来。

### 步骤 3　复制到副本 B（工作空间之外）

```powershell
Copy-Item "E:\fanhe Work\keys\fanhe-work-signing-095cb390.pfx" `
          "<空间外的目录>\fanhe-work-signing-095cb390.pfx"
```

`<空间外的目录>` 由你定（密码管理器附件 / 网盘 / 另一块盘）。**不要**放在工作空间内的任何子目录里 —— 那样两份副本会同时随盘走，等于只有一份。

### 步骤 4　清掉窗口里的口令

```powershell
Remove-Item Env:FANHE_SIGNING_PFX_PASSWORD
```

## 四、校验（四步，缺一不可）

### 4.1 文件确实是有效的、且属于当前身份

```powershell
$sec = Read-Host -Prompt 'PFX 口令' -AsSecureString
$c = Get-PfxCertificate -FilePath "E:\fanhe Work\keys\fanhe-work-signing-095cb390.pfx"
"THUMBPRINT=$($c.Thumbprint)"
"SUBJECT=$($c.Subject)"
```

期望 `THUMBPRINT=095CB390A4CD0A64EF89B4364CC095A6A8A2A9BB`、`SUBJECT=CN=Fanhe Work`。

### 4.2 🔴 文件里**确实有私钥**（这一步最容易漏）

`Get-PfxCertificate` 只看公钥部分 —— **它读不出私钥在不在**。用一次**非持久导入**来证明（不加 `PersistKeySet`，密钥容器在对象释放时即被清理，不留痕迹）：

```powershell
$sec = Read-Host -Prompt 'PFX 口令' -AsSecureString
$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
  "E:\fanhe Work\keys\fanhe-work-signing-095cb390.pfx", $sec,
  [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
"HAS_PRIVATE_KEY=$($c.HasPrivateKey)"
"KEY_SIZE=$($c.PrivateKey.KeySize)"
$c.Dispose()
```

期望 `HAS_PRIVATE_KEY=True`、`KEY_SIZE=2048`。**若为 `False`，这份备份是废的** —— 它只备份了公钥，而公钥本来就在版本控制里。

> 另一个弱信号：带私钥的 `.pfx` 明显大于 766 字节（纯公钥 `.cer` 的大小）。但**不要**把它当判据 —— 大小对不上时说明有问题，大小对得上**不**说明没问题。

### 4.3 两份副本逐字节一致

```powershell
$a = (Get-FileHash "E:\fanhe Work\keys\fanhe-work-signing-095cb390.pfx" -Algorithm SHA256).Hash
$b = (Get-FileHash "<空间外的目录>\fanhe-work-signing-095cb390.pfx" -Algorithm SHA256).Hash
"A=$a"; "B=$b"; "MATCH=$($a -eq $b)"
```

### 4.4 这台机器的身份仍与档案一致

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "E:\fanhe Work\projects\fanhe-work\apps\desktop\scripts\create-signing-cert.ps1" -CheckOnly
```

期望 `RESULT=OK`、`CURRENT_THUMBPRINT` 与 `IDENTITY_RECORD_THUMBPRINT` **相同**（都是 `095CB390…`）、退出码 0。

## 五、换机 / 恢复

### 5.1 新机器要当**打包机**（要签名、要发版）

```powershell
# 1) 取副本（A 或 B 都行）
# 2) 设口令（同第三节步骤 1）
$env:FANHE_SIGNING_PFX_PASSWORD = '<你的口令>'

# 3) 导入。这一步会把私钥装进 CurrentUser\My 并重建本机身份档案
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "<工作空间根>\projects\fanhe-work\apps\desktop\scripts\create-signing-cert.ps1" `
  -ImportPath "<副本路径>\fanhe-work-signing-095cb390.pfx"

# 4) 自检：指纹必须与档案一致
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "<工作空间根>\projects\fanhe-work\apps\desktop\scripts\create-signing-cert.ps1" -CheckOnly

# 5) 清口令
Remove-Item Env:FANHE_SIGNING_PFX_PASSWORD
```

🔴 **判据是 `RESULT=OK` 且 `CURRENT_THUMBPRINT` 等于 `095CB390…`。** 若报告里出现 `WARN_SUBJECT_MISMATCH` 或 `IDENTITY_CHANGE=…`，**停下**，不要带 `-AllowRotate` 重跑。

### 5.2 新机器只当**目标机**（只接收更新，不签名）

**不要导入私钥。** 只装公钥根：

```powershell
certutil -user -addstore -f Root "<工作空间根>\projects\fanhe-work\apps\desktop\scripts\fanhe-work-signing-public.cer"
certutil -user -addstore -f TrustedPublisher "<工作空间根>\projects\fanhe-work\apps\desktop\scripts\fanhe-work-signing-public.cer"
```

或用仓库里的脚本能力（它按**固定文件名**取公钥，**只装根、不建证书**）：

```powershell
pnpm --filter @fanhe/desktop signing:trust
pnpm --filter @fanhe/desktop signing:trust-check   # 期望退出码 0
```

🔴 **绝对不要在目标机上跑 `signing:cert`。** 它会在那台机器上**造出一张新证书**，根与已发布包的签名者不是同一个，装了也没用 —— 那才是真正「永久弄坏」的操作。

## 六、多设备一致性：靠什么保证「所有人用同一个私钥」

**这是本文最要紧的一节，因为「把私钥复制到每台设备」是错的解法。**

**私钥只在打包机上需要。** 目标机要的是公钥，而公钥在版本控制里 —— 复制私钥到更多机器只会放大暴露面，对「保持一致」这个目标**一分都不多**。

真正保证一致的是**四件公开的东西**：

| # | 机制 | 它挡住什么 |
| -- | -- | -- |
| 1 | **公钥 `.cer` 在版本控制里**（`apps/desktop/scripts/fanhe-work-signing-public.cer`） | 身份一变就在 `git diff` 里显形。这是**绊线**，不是备份 |
| 2 | **每台机器的身份档案**（`%LOCALAPPDATA%\FanheWork\signing\signing-identity.json`） | 记住「这台机器该用哪一张」，含被替换身份的 `history` |
| 3 | **轮换闸**：有档案而无证书时**拒绝静默新建** | 拦住「重跑一次 `signing:cert` 看起来无害」这个动作。**刻意不提供 `--force`** |
| 4 | **逐机自检**：打包机 `signing:check`、目标机 `signing:trust-check` | 让「这台机器对不对」变成一条可执行的判据，而不是印象 |

**加起来的实际效果**：任何人都无法在不留痕迹的情况下换掉签名身份 —— 要么轮换闸拦下，要么公钥在 `git diff` 里显形，要么自检退出码非 0。

### 6.1 冲突时以哪个为准

三处可能记录身份，**优先级从高到低**：

1. **打包机上的 `signing-identity.json`** —— 记着「该用哪一张」。
2. **版本控制里的 `.cer`** —— 记着「哪一张被发布过」。
3. **已发布安装包的内嵌签名** —— 记着「哪一个真的签过包」。

🔴 **三者不一致时不要猜，先停。** 这通常意味着发生过一次**未记录在案的轮换**。查法：`git log --follow -- apps/desktop/scripts/fanhe-work-signing-public.cer` 看公钥什么时候变的，再对照档案里的 `history`。若仍对不上，用 `signing:adopt -ArtifactPath <已签名产物>` 从产物把身份认回来。

### 6.2 「避免生成或使用其他私钥」由什么保证

| 风险 | 拦它的东西 |
| -- | -- |
| 手滑重跑 `signing:cert` 造出新证书 | **轮换闸**（有档案无证书时抛错，须显式 `-AllowRotate`） |
| 证书快到期时被静默换掉 | 到期前 `ROTATE_WITHIN_DAYS` 内才允许自动轮换，且仍要过闸 |
| 换了身份但没人发现 | **公钥入库** ⇒ `git diff` 显形 |
| 机器上装着别的同主体证书 | `signing:check` 比对指纹与档案，不一致即报 |
| 目标机被误当打包机 | 两种机器命令分开（`signing:cert` vs `signing:trust`），且**绝不在目标机跑 `signing:cert`** |

## 七、明确不该做的事

- ❌ **不要把私钥或口令写进任何版本控制的文件。** 这个仓库实测为 **public**。
- ❌ **不要把私钥放到工作空间之外的其他「随手位置」**（桌面、下载目录、聊天工具传输）—— 那些地方既不备份也不加密。
- ❌ **不要在命令行上直接传口令**（`-Password '明文'`）：进程表里能看到。脚本**只从环境变量取**口令，这是刻意设计。
- ❌ **不要把两份副本放在同一介质上**（比如都放 U 盘的不同目录）—— 那不是两份。
- ❌ **不要在目标机上导入私钥。** 目标机只需要公钥。
- ❌ **不要用 `--force` 绕过轮换闸** —— 它刻意没有这个开关。

## 八、轮换（证书到期或私钥确已丢失）

**流程与后果见 `docs/SIGNING-ROTATION-RUNBOOK.md`**，此处只强调三点：

1. **先确认真的没有备份了。** 上次的教训是「以为有备份，实际没有」；这一次**两份副本**就是为了不再重演。
2. **轮换会换掉信任根**，已装机器上不补装新根就收不到更新，且**报错不会说明是根的问题**。顺序是「装新根 → 发布 → 验证」。
3. **同 CN 换证书后更新仍能通**（`publisherName` 由 Subject DN 推出，比对退化成 CN 相等，指纹不参与）—— 这一点已于 2026-10-14 由源码级论证**升级为端到端实测**，证据见轮换手册第八节。

## 九、回填清单

1. 本文件登记进 `docs/WORK-STATUS.md` 的文档索引。
2. `docs/SIGNING-ROTATION-RUNBOOK.md` §零「结论先行」补一句「私钥已有两份加密备份」。
3. 导出完成后，把**副本 B 的位置**记进你自己的密码管理器（**不要**写进本文件 —— 本文件是公开的）。
4. 每次轮换后：更新本文档的「当前身份」指纹与文件名，并把旧副本**标记为退役**（不要直接删，`SIGNING-ROTATION-RUNBOOK.md` §零的做法是另存为 `…-retired-<旧指纹前 8 位>.pfx`）。
