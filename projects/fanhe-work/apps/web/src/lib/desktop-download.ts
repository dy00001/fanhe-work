/**
 * 桌面端安装包的下载去向。
 *
 * ## 为什么指向 `releases/latest` 而不是某个具体版本的 exe
 *
 * `releases/latest/download/<asset>` 看起来很直接，但 asset 名里带版本号
 * （`fanhe-work-setup-0.4.0.exe`，见 `electron-builder.yml` 的 `artifactName`），
 * 而那个版本号不能从这份前端产物里读出来当路径用 —— 网页版的版本可能落后于线上
 * 最新版（服务端还没更新），照着产物版本拼出来的链接会把人引到一个旧包上。
 *
 * 改 asset 名为不带版本也不行：`latest.yml` 里记的就是那个带版本的文件名，
 * 差分下载靠它对上号，改了会让更新链路断掉。
 *
 * 所以入口指向发布页。多一次点击，换来「总是最新、永不过期」。
 *
 * ## 为什么是常量而不是从接口取
 *
 * 仓库地址是编译期就确定的事实，不需要服务端告诉前端。走接口反而多一处失败可能：
 * 接口没起时这个入口会消失，而它恰恰是「客户端没装好、只能靠网页版」时最需要的东西。
 */
export const DESKTOP_RELEASES_URL = 'https://github.com/dy00001/fanhe-work/releases/latest'

/**
 * 下载入口的说明文字。
 *
 * 平台限定写在文案里而不是做 UA 判断：当前只产出 Windows 安装包（`win.target`
 * 只有 nsis x64），用 UA 去猜会让 macOS 与 Linux 上的同事看不到入口 —— 而他们
 * 看到的「没有入口」与「功能坏了」长得一样。写明「Windows」既诚实又不用猜。
 */
export const DESKTOP_DOWNLOAD_LABEL = '下载桌面端（Windows）'
