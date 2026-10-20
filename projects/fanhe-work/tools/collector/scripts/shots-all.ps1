param([switch]$Check)

# Screenshot runner (headless).
# No remote-debugging port and no Stop-Process, so it is safe to run while the
# user has Edge open. The previous version drove a debug instance and ended with
# "Stop-Process msedge", which closed every Edge window on the machine.
# All paths derive from this script's location: the workspace lives on a USB
# drive and the letter changes between machines. Never hard-code it here.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { throw 'cannot resolve workspace root from script location' }

$edgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $edge) { throw 'msedge.exe not found (tried x86, x64, per-user)' }

$page = Join-Path $root 'preview\ops-dashboard-preview.html'
$uri  = 'file:///' + ($page -replace '\\', '/')
# Profile goes to TEMP, not the workspace: an Edge profile is 12-16 MB and
# useless on another machine (cookies are DPAPI-bound to the current account).
$prof = Join-Path $env:TEMP 'qianniu-shot-profile'

Write-Output "root=$root"
Write-Output "edge=$edge"
Write-Output "page=$page"

if ($Check) {
  Write-Output ("exists={0}  {1}" -f (Test-Path $page), $page)
  Write-Output 'check-only'
  exit 0
}

if (-not (Test-Path $page)) { throw "page not found: $page" }

# States worth capturing for the current build. Comparison mode no longer takes
# an explicit b1/b2: defaultB now picks the equal-length window right before A
# (for 7 days that is 10-05 ~ 10-11), so hard-coded dates would fight the code.
$jobs = @(
  @{ name = 'screen-30d';   url = '#/screen?g=day&p=30d&cmp=0&q=80000&s=main';  w = 1680; h = 1180 },
  @{ name = 'screen-7d';    url = '#/screen?g=day&p=7d&cmp=0&q=80000&s=main';   w = 1680; h = 1180 },
  @{ name = 'screen-d1';    url = '#/screen?g=day&p=d1&cmp=0&q=80000&s=main';   w = 1680; h = 1080 },
  @{ name = 'screen-s4';    url = '#/screen?g=day&p=30d&cmp=0&q=80000&s=s4';    w = 1680; h = 1180 },
  @{ name = 'trade-30d';    url = '#/trade?g=day&p=30d&cmp=0&q=80000&s=main';   w = 1680; h = 1500 },
  @{ name = 'trade-cmp-7d'; url = '#/trade?g=day&p=7d&cmp=1&q=80000&s=main';    w = 1680; h = 1500 },
  @{ name = 'items-30d';    url = '#/items?g=day&p=30d&cmp=0&q=80000&s=main';   w = 1680; h = 1700 },
  @{ name = 'flow-30d';     url = '#/flow?g=day&p=30d&cmp=0&q=80000&s=main';    w = 1680; h = 1600 },
  @{ name = 'service-30d';  url = '#/service?g=day&p=30d&cmp=0&q=80000&s=main'; w = 1680; h = 800 },
  @{ name = 'ads-30d';      url = '#/ads?g=day&p=30d&cmp=0&q=80000&s=main';     w = 1680; h = 800 },
  @{ name = 'content-30d';  url = '#/content?g=day&p=30d&cmp=0&q=80000&s=main'; w = 1680; h = 800 }
)

$fail = 0
foreach ($j in $jobs) {
  $out = Join-Path $root ('preview\' + $j.name + '.png')
  if (Test-Path $out) { Remove-Item $out -Force }

  $cliArgs = @(
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    "--window-size=$($j.w),$($j.h)",
    "--user-data-dir=$prof",
    "--screenshot=$out",
    ($uri + $j.url)
  )
  # Edge prints "N bytes written" on stderr; PowerShell 5.1 turns native stderr
  # into an error record, and with ErrorActionPreference=Stop that aborts the run
  # even though the screenshot was written. Relax the preference for this call.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $edge @cliArgs 2>&1 | Out-Null
  $ErrorActionPreference = $prev

  if (Test-Path $out) {
    $kb = [math]::Round((Get-Item $out).Length / 1KB)
    Write-Output ("ok    {0,-14} {1} KB" -f $j.name, $kb)
  } else {
    $fail++
    Write-Output ("FAIL  {0}" -f $j.name)
  }
}

Write-Output ("done, {0}/{1} ok, failed={2}" -f ($jobs.Count - $fail), $jobs.Count, $fail)
if ($fail -gt 0) { exit 1 }
