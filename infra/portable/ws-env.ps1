<#
  ws-env.ps1
  Portable workspace environment resolver. Drive-letter agnostic.

  Apply to the current PowerShell session by dot-sourcing:
      . "$PSScriptRoot\ws-env.ps1"

  The entry points (ws-run.cmd / ws-run.ps1 / ws-run.sh) call this
  automatically, so interactive shells and build tools launched through them
  inherit the redirected environment.

  The workspace root is derived from THIS FILE'S location. No absolute path is
  ever persisted into a tracked file, therefore changing the drive letter is
  transparent.

  Parameters
      -NoRepair   skip the relocation repair routine
      -Quiet      suppress informational output
#>
[CmdletBinding()]
param(
    [switch]$NoRepair,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Write-WsLog {
    param([string]$Message, [string]$Level = 'info')
    if ($Quiet -and $Level -eq 'info') { return }
    $color = 'DarkCyan'
    if ($Level -eq 'warn')  { $color = 'Yellow' }
    if ($Level -eq 'error') { $color = 'Red' }
    Write-Host ('[ws] ' + $Message) -ForegroundColor $color
}

# ---------------------------------------------------------------------------
# 1. Self-location. The workspace root is found by walking up from this script
#    until a directory containing the .ws-root marker is reached.
#    Using the marker instead of a fixed relative depth means the mechanism
#    keeps working no matter how the directory layout is reorganised later.
# ---------------------------------------------------------------------------
function Get-WsRootPath {
    param([string]$Start)
    $probe = [System.IO.Path]::GetFullPath($Start)
    while ($probe) {
        if (Test-Path -LiteralPath (Join-Path $probe '.ws-root')) {
            return $probe.TrimEnd([char]92)
        }
        $parent = Split-Path -Parent $probe
        if (-not $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }
    # Fallback for a workspace whose marker is missing, one level above portable.
    return [System.IO.Path]::GetFullPath((Join-Path $Start '..')).TrimEnd([char]92)
}

$script:WsPortableDir = $PSScriptRoot
$script:WsRoot        = Get-WsRootPath $PSScriptRoot
$script:WsStateDir    = Join-Path $PSScriptRoot 'state'
$script:WsConfigDir   = Join-Path $PSScriptRoot 'config'

# ---------------------------------------------------------------------------
# 2. Workspace-internal directory map. Every value is relative to the root.
#    Adding a new tool means adding one row here, nothing else.
# ---------------------------------------------------------------------------
$wsRelative = [ordered]@{
    'tmp'        = '.tmp'
    'cache'      = '.cache'
    'local'      = '.local'
    'config'     = '.config'
    'logs'       = 'logs'
    'venv'       = '.venv'
    'npmCache'   = '.cache\npm'
    'npmPrefix'  = '.local\npm-global'
    'pipCache'   = '.cache\pip'
    'pyCache'    = '.cache\pycache'
    'pyUserBase' = '.local\python'
    'yarnCache'  = '.cache\yarn'
    'pnpmStore'  = '.cache\pnpm-store'
    'pnpmHome'   = '.local\pnpm'
    'gradleHome' = '.gradle'
    'mavenRepo'  = '.m2\repository'
    'cargoHome'  = '.cargo'
    'rustupHome' = '.rustup'
    'goPath'     = '.go'
    'goBuild'    = '.cache\go-build'
    'ccache'     = '.cache\ccache'
    'pwBrowsers' = '.cache\ms-playwright'
    'electron'   = '.cache\electron'
    'nuget'      = '.nuget\packages'
    'runtime'    = 'runtime'
}

$wsPath = [ordered]@{}
foreach ($key in $wsRelative.Keys) {
    $full = Join-Path $script:WsRoot $wsRelative[$key]
    $wsPath[$key] = $full
    if (-not (Test-Path -LiteralPath $full)) {
        New-Item -ItemType Directory -Path $full -Force | Out-Null
    }
}
$script:WsPath = $wsPath

# ---------------------------------------------------------------------------
# 3. Redirect every writable tool path into the workspace.
#    These are per-process variables. They never touch the host's persistent
#    user or system environment.
# ---------------------------------------------------------------------------
$env:WS_ROOT         = $script:WsRoot
$env:WS_PORTABLE_DIR = $script:WsPortableDir
$env:WS_LOGS         = $wsPath['logs']

# Process scratch space
$env:TMP  = $wsPath['tmp']
$env:TEMP = $wsPath['tmp']

# XDG style bases (honoured by many cross platform tools)
$env:XDG_CACHE_HOME  = $wsPath['cache']
$env:XDG_CONFIG_HOME = $wsPath['config']
$env:XDG_DATA_HOME   = $wsPath['local']

# Python
$env:VIRTUAL_ENV                 = $wsPath['venv']
$env:PIP_CACHE_DIR               = $wsPath['pipCache']
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONPYCACHEPREFIX         = $wsPath['pyCache']
$env:PYTHONUSERBASE              = $wsPath['pyUserBase']

# Node and the JavaScript ecosystem
$env:npm_config_cache      = $wsPath['npmCache']
$env:npm_config_prefix     = $wsPath['npmPrefix']
$env:npm_config_userconfig = Join-Path $script:WsConfigDir '.npmrc'
$env:NODE_REPL_HISTORY     = Join-Path $wsPath['cache'] 'node_repl_history'
$env:YARN_CACHE_FOLDER     = $wsPath['yarnCache']
$env:PNPM_HOME             = $wsPath['pnpmHome']
$env:npm_config_store_dir  = $wsPath['pnpmStore']

# JVM ecosystem
$env:GRADLE_USER_HOME = $wsPath['gradleHome']
$env:MAVEN_OPTS       = ('-Dmaven.repo.local=' + $wsPath['mavenRepo'])

# Rust
$env:CARGO_HOME  = $wsPath['cargoHome']
$env:RUSTUP_HOME = $wsPath['rustupHome']

# Go
$env:GOPATH     = $wsPath['goPath']
$env:GOCACHE    = $wsPath['goBuild']
$env:GOMODCACHE = Join-Path $wsPath['goPath'] 'pkg\mod'

# Other build and tool caches
$env:CCACHE_DIR               = $wsPath['ccache']
$env:PLAYWRIGHT_BROWSERS_PATH = $wsPath['pwBrowsers']
$env:NUGET_PACKAGES           = $wsPath['nuget']

# Docker is deliberately NOT redirected.
#
# DOCKER_CONFIG is not a cache, it is where the CLI keeps its contexts, registry
# credentials and cli-plugins. Pointing it at an empty workspace directory has
# two consequences, both measured on 2026-10-10:
#
#   1. `docker compose` stops existing. The compose plugin is discovered under
#      $DOCKER_CONFIG/cli-plugins, so an empty directory turns it into
#      "docker: unknown command: docker compose". Every container workflow in
#      this workspace would break, silently, with a confusing message.
#   2. The desktop-linux context disappears and only the bare `default` context
#      remains. Plain `docker ps` still happens to work because Docker Desktop
#      publishes both named pipes, which is exactly the kind of accidental
#      success that hides the defect until it matters.
#
# Redirecting it would also carry machine specific endpoints across machines,
# which is the same reason the mechanism does not rely on ACLs.

# Electron. Three separate variables are involved, they are not
# interchangeable, and only the middle one decides where the binary lands.
#
#   ELECTRON_CACHE          no longer read anywhere in the install chain. Kept
#                           because third party tooling still looks for it.
#   electron_config_cache   the name the `electron` npm package actually reads
#                           in its install script and forwards to @electron/get
#                           as cacheRoot. @electron/get itself has no
#                           ELECTRON_CACHE fallback: without this variable the
#                           zip is written to %LOCALAPPDATA%\electron\Cache on
#                           the system drive.
#   ELECTRON_BUILDER_CACHE  read by electron-builder for its own cache.
#
# Windows environment lookups ignore case, so the upper case spelling already
# satisfies the lower case read there. Both are set so the same block keeps
# working on a case sensitive system.
$env:ELECTRON_CACHE                 = $wsPath['electron']
$env:ELECTRON_CONFIG_CACHE          = $wsPath['electron']
$env:electron_config_cache          = $wsPath['electron']
$env:ELECTRON_BUILDER_CACHE         = Join-Path $wsPath['electron'] 'builder'

# Binaries are fetched from GitHub releases by default, which is slow or
# unreachable from a mainland China network. The npm registry is already pinned
# to npmmirror in infra/portable/config/.npmrc, so the mirrors follow that host.
# ELECTRON_MIRROR is read by @electron/get, the other one by electron-builder.
$env:ELECTRON_MIRROR                  = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# Git on a removable filesystem. GIT_CONFIG_COUNT injects these settings for
# this process only, so the user's own global git configuration is untouched.
#
# The medium is NTFS since 2026-10-10, so the exFAT restrictions are gone and
# the execute bit and long paths are available.
#
# core.symlinks is true because Developer Mode is enabled on this host
# (AllowDevelopmentWithoutDevLicense = 1), which is what lets git create
# symbolic links without elevation. Verified by materialising a symlink entry
# out of the index.
#
# Two things to keep in mind. PowerShell's own New-Item -ItemType SymbolicLink
# still fails without elevation, because Windows PowerShell 5.1 does not pass
# SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE; git and node both do, so this
# setting is safe. And the capability is a property of the host, not of the
# workspace: on a machine without Developer Mode git degrades gracefully by
# writing the link target as a plain file, but a checkout that depends on
# symlinks will not behave the same there.
$env:GIT_CONFIG_COUNT    = '4'
$env:GIT_CONFIG_KEY_0    = 'core.filemode';  $env:GIT_CONFIG_VALUE_0 = 'false'
$env:GIT_CONFIG_KEY_1    = 'core.autocrlf';  $env:GIT_CONFIG_VALUE_1 = 'false'
$env:GIT_CONFIG_KEY_2    = 'core.symlinks';  $env:GIT_CONFIG_VALUE_2 = 'true'
$env:GIT_CONFIG_KEY_3    = 'core.longpaths'; $env:GIT_CONFIG_VALUE_3 = 'true'

# Prefer workspace-local runtimes and shims when they exist, so a bundled
# interpreter always wins over whatever the host machine happens to have.
$prepend = @(
    (Join-Path $wsPath['runtime'] 'python'),
    (Join-Path $wsPath['runtime'] 'python\Scripts'),
    (Join-Path $wsPath['runtime'] 'node'),
    (Join-Path $wsPath['venv'] 'Scripts'),
    $wsPath['npmPrefix']
)
$existing = ($env:PATH -split ';') | Where-Object { $_ }
$env:PATH = (($prepend + $existing) -join ';')

# ---------------------------------------------------------------------------
# 4. Change detection and the repair trigger.
#    Two independent signals are compared by ws-state.ps1, which owns the
#    logic for every entry point.
#      root  the drive letter changed
#      host  the workspace was carried to another computer
#    The host signal matters because a new computer can hand out the same drive
#    letter, in which case host dependent artifacts such as the venv base
#    interpreter recorded in pyvenv.cfg may still be broken.
# ---------------------------------------------------------------------------
$stateScript = Join-Path $PSScriptRoot 'ws-state.ps1'
if (Test-Path -LiteralPath $stateScript) {
    $stateArgs = @{ Root = $script:WsRoot }
    if ($NoRepair) { $stateArgs['NoRepair'] = $true }
    if ($Quiet)    { $stateArgs['Quiet']    = $true }
    & $stateScript @stateArgs
} else {
    Write-WsLog ('state manager not found: ' + $stateScript) 'warn'
}
