/**
 * 拼内嵌 AI 助手的地址。
 *
 * 地址上有三个参数，用途完全不同，混在一起拼很容易出两种错（漏转义、覆盖已有 query），
 * 所以单独抽成纯函数：这两个错在界面上都不报错，只表现为「配色不跟」或「历史串号」。
 *
 * - `theme`：宿主当前配色（`light` / `dark`）。助手那一侧优先读它，覆盖本地存过的
 *   偏好，于是梵禾切深色助手跟着深色。
 * - `t`：身份令牌，让助手的对话历史按梵禾账号隔离。**没有时不能写空串** ——
 *   助手会把空令牌当成「没有身份」，静默退回共享身份；而写空串在它那边等同于
 *   「带了一个无效令牌」，是另一条不同的分支。宁可整段不出现。
 * - `host`：固定 `fanhe`，声明「这个页面是从梵禾里打开的」。它存在的唯一理由是
 *   区分下面这种状态：**嵌入模式但没拿到令牌**。此时助手必须把上一次留在浏览器里
 *   的令牌清掉，否则这一轮对话会记在前一个人名下 —— 取不到令牌本来只是退化成共享
 *   身份，却因此变成了串号。没有这个标记就无从判断是「嵌入」还是「桌面版自用」。
 *
 * 令牌可能含 `+/=`（取决于签发时用的编码），一律交给 `URLSearchParams` 转义，
 * 不手拼字符串。
 */
export type AssistantUrlInput = {
  /** 助手页根地址，例如 `https://ai.fanhe.dpdns.org`。可能已经带 query。 */
  baseUrl: string
  /** 宿主当前配色。 */
  theme: 'light' | 'dark'
  /** 身份令牌；`null` 表示拿不到（未配置或请求失败），此时退回共享身份。 */
  token: string | null
}

/** 宿主标记。助手那一侧靠它判断「该不该清掉上一次的令牌」。 */
export const ASSISTANT_HOST_MARKER = 'fanhe'

export function buildAssistantUrl(input: AssistantUrlInput): string {
  // 先把 hash 摘出来再拼 query：`...#/chat` 这类地址上直接改 search 会把片段
  // 当成 query 的一部分，得到 `?theme=dark#/chat` 之外的错位结果。
  const hashIndex = input.baseUrl.indexOf('#')
  const withoutHash = hashIndex === -1 ? input.baseUrl : input.baseUrl.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : input.baseUrl.slice(hashIndex)

  const separator = withoutHash.includes('?') ? '&' : '?'
  const params = new URLSearchParams()
  params.set('theme', input.theme)
  params.set('host', ASSISTANT_HOST_MARKER)
  if (input.token !== null && input.token !== '') {
    params.set('t', input.token)
  }

  return `${withoutHash}${separator}${params.toString()}${hash}`
}
