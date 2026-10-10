/**
 * 判断一个来源地址是不是本机回环。
 *
 * **这条判断存在的理由，是「本机代理」这个板块天生带着一个攻击面。** 任何能在
 * 用户机器上跑起来的东西 —— 另一个程序、浏览器里的任意一个页面、一个被注入的
 * 脚本 —— 都能向 `127.0.0.1` 上的端口发请求。而这条接口的动作是「创建进程」。
 * 只靠登录态挡不住浏览器发起的请求：会话令牌在 httpOnly 之外的地方（本项目的
 * 访问令牌在内存里，但请求是可以由页面主动构造的），而同源策略并不阻止页面向
 * 回环地址发起「简单请求」。
 *
 * 两道防线叠在一起才有意义：**来源必须是回环**（挡住局域网与远程），**并且**
 * 必须持有有效会话与写权限（挡住同机的其它程序）。缺任何一道都留下整整一类攻击：
 * 只判回环则本机任何程序都能启动进程，只判登录则远程（阶段五容器化后 API 会绑到
 * 非回环地址）也能。
 *
 * 三种形态都要认，因为地址的写法取决于 socket 类型与操作系统：
 *
 *   `127.0.0.1`           IPv4 回环
 *   `::1`                 IPv6 回环
 *   `::ffff:127.0.0.1`    IPv4 映射到 IPv6（Node 在双栈监听下的常见形态）
 *
 * 整个 `127.0.0.0/8` 段都算回环而不是只认 `127.0.0.1`：这一整段在 RFC 1122 里
 * 都定义为回环，Windows 与 Linux 都默认把整段指向 lo 接口。只认单个地址会在有人
 * 用 `127.0.0.2` 之类的地址访问时误判为远程。
 *
 * `undefined` 一律判否。拿不到来源地址时（连接已断开、非常规的传输层）应当拒绝，
 * 而不是当成回环放过去 —— 默认放行的那一侧永远是错的一侧。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address === '') return false

  // IPv4 映射形态先归一，否则下面两条都匹配不到。
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address

  if (normalized === '::1') return true

  const octets = normalized.split('.')
  if (octets.length !== 4) return false
  // 逐段校验是数字且落在 0-255，避免把 `127.0.0.1.5` 或 `127.0.0.abc` 这类
  // 畸形串当成回环。Node 正常情况下给不出这种地址，但这条函数是安全边界，
  // 边界上的宽松判断等于没有判断。
  if (!octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  return octets[0] === '127'
}
