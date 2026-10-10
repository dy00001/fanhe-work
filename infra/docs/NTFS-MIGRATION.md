# 迁移到 NTFS 操作手册

适用前提：开发的软件全部在 Windows 上运行，不需要在 macOS 或 Linux 上读写该盘。

> **执行状态：已于 2026-10-10 完成。** 卷已由 exFAT 迁移为 NTFS，卷标 `WORK`，分配单元 4096 字节。109 个文件全部还原，独立比对 0 缺失、0 大小不符、合计 22,768,668 字节。本手册保留作为执行记录与日后重做参考。

---

## 一、结论

**推荐整盘格式化为 NTFS，分配单元 4096 字节。**

理由是 Windows 单平台这个前提消除了 exFAT 的唯一真实优势。exFAT 存在的意义是跨平台互通，而 macOS 与 Linux 对 NTFS 的写入支持不好，反过来 NTFS 对 Windows 是一切原生。既然不需要跨平台，就没有理由继续承担 exFAT 的语义缺失。

## 二、为什么优先整盘 NTFS，而不是 VHDX 容器

VHDX 方案的价值在于「不动现有数据」，代价则集中在运行时。

| 维度 | 整盘 NTFS | VHDX 容器 |
| --- | --- | --- |
| 日常使用 | 直接访问，无附加步骤 | 每次使用前需挂载，通常需管理员 |
| IO 路径 | 一层 | 两层，构建速度进一步下降 |
| 故障影响面 | 单文件损坏只影响该文件 | 容器损坏影响整个工作空间 |
| 底层文件系统 | NTFS，具备日志 | 仍是 exFAT，无日志，容器本身可能被异常拔出损坏 |
| 空间管理 | 直接 | 固定大小需预留，动态扩展在 exFAT 上易碎片化 |
| 迁移成本 | 需备份并重建 | 无需重建 |

结论很明确。VHDX 适合「实在无法清盘」的场合，作为退路。只要能够完成一次备份与还原，整盘 NTFS 在性能、可靠性、日常便利三方面全面占优。

## 三、迁移前必须确认

> **警告：格式化会清空整块磁盘，包括「昔年AI电商 分析」在内的全部数据，且不可恢复。备份未完成并通过校验之前，不得执行任何格式化操作。**

当前盘上除本工作空间外，还有「昔年AI电商 分析」目录，必须一并纳入备份范围。

实测规模如下，说明备份成本极低，迁移在数据层面的风险很小。

| 对象 | 大小 |
| --- | --- |
| `fanhe Work` 工作空间 | 约 0.7 MB |
| `昔年AI电商 分析` | 约 24 MB |
| 整盘已用 | 约 27 MB |
| 盘容量 | 30 GB |

待备份总量不到 30 MB，任何一块空闲磁盘都能容纳，C 盘当前可用约 181 GB，D 盘约 462 GB。真正的成本在重建与重新安装依赖，而不在数据搬运。

## 四、操作步骤

### 步骤 1 整盘备份

```
robocopy "E:\" "D:\usb-backup-20261010" /E /COPY:DAT /DCOPY:DAT /R:2 /W:2 /XJ /XD "E:\System Volume Information"
```

`/COPY:DAT` 保留数据、属性与时间戳，`/XJ` 跳过 junction 以免递归异常，`/XD` 排除系统目录。

### 步骤 2 校验备份

备份完成后必须比对文件数与总字节数，两项都吻合才算通过。

```powershell
$src = Get-ChildItem "E:\" -Recurse -File -Force -ErrorAction SilentlyContinue |
       Where-Object { $_.FullName -notlike "*System Volume Information*" }
$dst = Get-ChildItem "D:\usb-backup-20261010" -Recurse -File -Force -ErrorAction SilentlyContinue
"source: {0} files, {1} bytes" -f $src.Count, ($src | Measure-Object Length -Sum).Sum
"backup: {0} files, {1} bytes" -f $dst.Count, ($dst | Measure-Object Length -Sum).Sum
```

### 步骤 3 决定分区布局

若今后仍需向 Mac 或 Linux 交接文件，建议在重建分区时顺手留一块小的 exFAT 分区，专门用于跨平台中转，开发数据全部放在 NTFS 分区。这一步在重建分区时做，成本为零。exFAT 无法在磁盘管理中收缩，事后想加会很麻烦。

32GB 盘的参考布局。

| 分区 | 大小 | 文件系统 | 用途 |
| --- | --- | --- | --- |
| 1 | 约 27 GB | NTFS | 开发工作空间 |
| 2 | 约 4 GB | exFAT | 跨平台中转 |

若确定永不跨平台，直接整盘 NTFS 即可。

### 步骤 4 格式化

需管理员权限。使用 diskpart 更可控，注意核对磁盘编号，选错会清空错误的磁盘。

```
diskpart
list disk
select disk <编号>
clean
create partition primary
format fs=ntfs quick label=WORK unit=4096
assign letter=E
```

`unit=4096` 即 4KB 簇，适合 `node_modules` 这类海量小文件。

### 补充说明：NTFS 不存在 4GB 单文件限制

这是一个经常被问到的问题，答案是否定的，NTFS 没有 4GB 限制，那个限制属于 FAT32。

Microsoft 的文件系统功能对照表给出的最大单文件尺寸如下。

| 文件系统 | 最大单文件尺寸 | 最大卷尺寸 |
| --- | --- | --- |
| NTFS | 2^64 减 1 字节 | 16 TB（4KB 簇）或 256 TB（64KB 簇） |
| exFAT | 2^64 减 1 字节 | 2^32 减 1 个簇 |
| UDF | 2^64 减 1 字节 | 2^32 个块 |
| FAT32 | 4 GiB | 2^32 个块 |

需要补充三点。

第一，NTFS 的实际上限由簇大小决定。按 Microsoft 的对照表，4KB 簇对应 16 TB，8KB 对应 32 TB，16KB 对应 64 TB，64KB 对应 256 TB，最大簇 2048KB 对应 8 PB。本手册推荐 4096 字节簇，对应 16 TB 上限，相对 30 GB 的盘完全不构成约束。

第二，真正会遇到 4GB 限制的场景与文件系统选择无关，需要单独留意。把文件压缩成传统 ZIP 时存在 4GB 上限，需要 ZIP64 才能突破。制作 UEFI 启动盘时引导分区必须是 FAT32，因此镜像内的 `install.wim` 超过 4GB 时需要拆分。FAT16 与 MS-DOS 环境另有 2GB 到 4GB 的卷限制。这些都不影响把工作空间放在 NTFS 上。

第三，建议用于跨平台中转的那块小 exFAT 分区同样没有 4GB 限制，exFAT 的最大单文件尺寸也是 2^64 减 1 字节。

### 步骤 5 放宽权限，避免换机后拒绝访问

NTFS 的 ACL 记录 SID，而 SID 由创建它的机器分配，换机后无法解析，可能出现拒绝访问。用知名 SID 而不是本地化的「Everyone」名称，可以避开中英文系统名称差异。

```
icacls "E:\" /grant "*S-1-1-0:(OI)(CI)F" /T /C
```

`*S-1-1-0` 是 Everyone 的知名 SID，`(OI)(CI)F` 表示容器与对象继承完全控制。

这里需要点明一个之前提过的判断。既然为了避免跨机拒绝访问而把权限放宽到 Everyone 完全控制，就等于放弃了用 ACL 限制写入范围这条路。这与前面的结论一致，换成 NTFS 拿到的是链接与日志，拿不到跨机的权限强制，写入范围控制仍然依靠重定向加审计。

### 步骤 6 开启长路径支持

Windows 默认 260 字符上限，深层依赖目录容易超限。需管理员权限。

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name "LongPathsEnabled" -Value 1 -PropertyType DWord -Force
```

### 步骤 7 开启开发者模式

用于免提权创建符号链接。也可在设置的「隐私和安全性」下的「开发者选项」中手动开启。

```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" `
  -Name "AllowDevelopmentWithoutDevLicense" -Value 1 -PropertyType DWord -Force
```

### 步骤 8 还原数据

把备份内容写回，保留原有的目录结构。

```
robocopy "D:\usb-backup-20261010" "E:\" /E /COPY:DAT /DCOPY:DAT /R:2 /W:2
```

### 步骤 9 复核

```
infra\portable\ws-run.cmd --version
infra\portable\ws-doctor.ps1
```

第一条触发盘符自适应并重建状态文件，第二条确认没有硬编码路径。换文件系统后盘符可能变化，这一步会顺带验证自适应机制仍然有效。

### 步骤 10 放开机制中原本受限的两处

改走 NTFS 之后，之前为了绕开 exFAT 而关闭的两项能力可以打开。

1. **pnpm 硬链接模式**。删除 `infra/portable/config/.npmrc` 中的复制模式相关设置，改用 pnpm 默认的内容寻址存储加硬链接，多项目共用依赖时可显著节省空间。
2. **Git 符号链接**。把 `infra/portable/ws-env.ps1` 与 `infra/portable/ws-env.sh` 中的 `core.symlinks` 由 `false` 改为 `true`，依赖符号链接的项目才能正常检出。

同时可以移除 `.gitattributes` 中为 exFAT 添加的说明性注释，并把记忆文件中「介质约束」一节改写为 NTFS 下的新约定。

---

## 五、风险与回滚

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 备份不完整 | 最常见也最致命 | 步骤 2 的文件数与字节数比对必须通过 |
| 选错磁盘 | diskpart 中编号选错会清空其他磁盘 | 执行 `list disk` 后按容量核对，32GB 盘容易识别 |
| 换机后拒绝访问 | NTFS 的 SID 跨机无法解析 | 步骤 5 放宽到 Everyone 完全控制 |
| 安全弹出被忽略 | 改为更好的性能后，写缓存不会自动刷新 | 要么保持快速删除策略，要么养成安全弹出习惯 |
| 无回滚路径 | 格式化不可逆 | 备份是唯一的回滚手段，保留备份直到确认新盘可用 |

关于移除策略的取舍值得说明。可移动设备默认采用快速删除策略，会关闭写缓存以换取随意拔出，代价是写入变慢。改为更好的性能会启用写缓存，构建明显变快，但必须每次安全弹出，否则有丢数据风险。若选择更好的性能，务必把安全弹出变成固定习惯。

---

## 六、配套硬件建议

这一条的重要性高于文件系统选择。

当前介质是 32GB U 盘，属闪存颗粒，随机 IO 性能差，且存在写入寿命限制。`node_modules` 与构建缓存恰好是高随机 IO、高写入量的场景，正是闪存盘最不擅长的负载。

把介质换成 USB 硬盘盒加 SSD，收益体现在三处。构建与依赖安装速度会有量级提升；介质寿命不再成为顾虑；SSD 在 Windows 中被识别为固定磁盘，NTFS 的各项特性工作得更自然。

需要注意的是，部分 USB 转 SATA 桥接芯片不透传 TRIM 指令，长期使用后写入性能会下降。选购时确认支持 UASP 与 TRIM 透传。

顺序建议是先完成 NTFS 迁移，因为这一步没有额外成本；硬件升级视预算安排，两者并不冲突。

---

## 七、资料来源

1. Microsoft Learn，Shrink a basic volume（英文版），https://learn.microsoft.com/en-us/windows-server/storage/disk-management/shrink-a-basic-volume 。用于说明只有无文件系统或 NTFS 的卷可以收缩，据此判断 exFAT 无法事后收缩。
2. Microsoft Learn，exFAT File System Specification（英文版），https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification 。用于说明 exFAT 的设计目标与事务安全语义归属 TexFAT 扩展。
3. Microsoft Learn，File System Functionality Comparison（英文版），https://learn.microsoft.com/en-us/windows/win32/fileio/filesystem-functionality-comparison 。用于说明 NTFS、exFAT、UDF、FAT32 的最大单文件尺寸与最大卷尺寸，据此判断 4 GiB 限制归属 FAT32。
4. Microsoft Learn，NTFS overview（英文版），https://learn.microsoft.com/en-us/windows-server/storage/file-server/ntfs-overview 。用于说明 NTFS 上限随簇大小变化的对照关系，以及大文件卷的格式化建议。
5. 检索过程中搜索服务返回了中文站点结果，与既定信源要求不符，未予采用。
