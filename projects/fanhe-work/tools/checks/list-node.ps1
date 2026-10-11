# 列出所有 node.exe 进程及其父进程与完整命令行。
#
# 用于排查 EADDRINUSE 与「残留的 dev 服务」：清残留要对着命令行按整条链杀，
# 只知道 PID 不够 —— 往往真正压着端口的是 tsx watch 拉起的子进程。
#
# 本文件由 .tmp 归档而来（原版把输出写到写死的 E: 盘路径），盘符换成由脚本位置
# 推导出的工作区根。

$ErrorActionPreference = 'Continue'

$wsRoot = if ($env:WS_ROOT) {
    $env:WS_ROOT
} else {
    Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
}

$tmp = Join-Path $wsRoot '.tmp'

if (-not (Test-Path -LiteralPath $tmp)) {
    $null = New-Item -ItemType Directory -Path $tmp -Force
}

$rows = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Select-Object ProcessId, ParentProcessId, CommandLine
$lines = foreach ($r in $rows) {
    "PID $($r.ProcessId)  PPID $($r.ParentProcessId)"
    "    $($r.CommandLine)"
}
$lines | Out-File -Encoding UTF8 (Join-Path $tmp 'node-procs.txt')
