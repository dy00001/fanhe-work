@echo off
chcp 65001 >nul
setlocal
rem ===========================================================================
rem  start-plugin-edge.cmd — 采集 / 调试浏览器（固定调试端口 + 每店独立 profile）
rem
rem  为什么要这个入口
rem    生意参谋、千牛这些后台页，数据接口全藏在页面发出的 XHR 里，页面源码里
rem    看不到。要知道某个页面调了哪个接口，得能观察它发出的请求 —— 那要求浏览器
rem    带着调试端口跑。而浏览器必须活在一次自动化调用之外（调用一返回，它起的
rem    进程就会被收掉），所以「启动」这一步只能由人双击。
rem
rem  🔴 为什么不再用 --load-extension
rem    实测（Edge 156，2026-10-30，三组对照）：
rem      profile + 调试端口             → 进程存活，端口通
rem      profile + 调试端口 + 扩展加载  → 进程存活，**端口根本不监听**（netstat 无影子）
rem      fanhe-main + 调试端口          → 进程存活，端口通
rem    带扩展加载时调试端口绑不上，CDP 永远连不过来，症状是「浏览器明明开着，
rem    却说连不上 9222」。所以插件改成在 profile 里手动装一次（本脚本会打开
rem    扩展管理页），不要再从命令行加载。
rem
rem  用法
rem      start-plugin-edge.cmd            默认 fanhe-main，端口 9222
rem      start-plugin-edge.cmd s2         端口 9223
rem
rem  打开后做两件事，各做一次，之后不用再做
rem      1. 在弹出的生意参谋页面登录
rem         cookie 会留在这个 profile 里，以后启动就是登录态
rem      2. 只有还想用这个浏览器采集时才需要：扩展页 → 打开「开发人员模式」
rem         → 加载解压缩的扩展 → 选下面打印的 plugin 路径
rem ===========================================================================

set "SHOP=%~1"
if "%SHOP%"=="" set "SHOP=fanhe-main"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if /i "%SHOP%"=="fanhe-main" set "PORT=9222"
if /i "%SHOP%"=="s2" set "PORT=9223"
if /i "%SHOP%"=="s3" set "PORT=9224"
if /i "%SHOP%"=="s4" set "PORT=9225"
if /i "%SHOP%"=="s5" set "PORT=9226"
if "%PORT%"=="" (
  echo Unknown shop code: %SHOP%
  echo Known codes: fanhe-main, s2, s3, s4, s5
  pause
  exit /b 1
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo Edge not found. Please install Microsoft Edge first.
  pause
  exit /b 1
)

rem 一店一份 profile。共用 profile 会静默串店：桥照样看到「已登录」，只是背后的
rem 店铺换了，数据顶着别人的名字入库，全程不报错。
set "PROFILE=%ROOT%\.browser-profile\%SHOP%"
if not exist "%PROFILE%" mkdir "%PROFILE%"

rem 工作区根在 tools\collector 往上四层。
set "EXT=%ROOT%\..\..\..\..\runtime\sycm-cli\extension\unpacked"

echo shop    : %SHOP%
echo port    : %PORT%
echo profile : %PROFILE%
echo plugin  : %EXT%
if not exist "%EXT%\manifest.json" echo           ^(插件文件不在，采集前需先解压 runtime\sycm-cli^)
echo.
echo 浏览器打开后：
echo   1. 登录生意参谋（只需一次）
echo   2. 要采集的话，到扩展页加载上面那个 plugin 路径（也只需一次）
echo.
echo 这个窗口可以关掉，浏览器会继续开着。
echo.

start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --new-window "https://sycm.taobao.com/portal/home.htm" "edge://extensions"

timeout /t 4 >nul
echo 已启动。验证端口：powershell -c "irm http://127.0.0.1:%PORT%/json/version"
pause
