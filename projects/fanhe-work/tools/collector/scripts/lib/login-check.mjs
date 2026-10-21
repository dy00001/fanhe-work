/**
 * 登录态判定（唯一判据）
 *
 * 为什么抽出来
 *   日增采集、单店登录引导、批量巡检都要回答同一个问题：这个浏览器里的账号
 *   现在还能不能用。判据写三份就会漂：采集端按 A 判、登录引导按 B 判，
 *   结果是人以为登录成功了，采集端却判定未登录 —— 两边都「有理由」。
 *
 * 判据的由来（10-20 踩过的两次）
 *   ① 把「账号限流」误判成脚本 bug，查了很久：限流页面有内容、不跳登录页，
 *      只看 URL 判不出来，必须看正文里的过期/失效提示。
 *   ② 反过来，正常首页里有「立即登录」这类营销文案，只看关键词会把好状态判成
 *      未登录。所以「登录表单」类信号额外要求正文稀疏（实测登录页 innerText
 *      只有一两百字），首页正文量大，不会误伤。
 */

const LOGIN_URL = /login\.taobao\.com|login\.tmall\.com|passport\.taobao\.com|\/member\/login|\/custom\/login/i
const LOGIN_FORM = /扫码登录|账号密码登录|密码登录|亲，请登录/
const EXPIRED = /登录超时|会话已失效|登录信息已失效|请重新登录/

/** 纯函数：给页面快照，给判定。便于单测与反例验证。
 *  返回 code 而不只是 reason：调用方要按类别分支（「页面没加载」不该提示去登录）。 */
export function classifyLogin(info) {
  const href = String(info?.href ?? '')
  const text = String(info?.text ?? '')
  const len = Number(info?.len ?? text.length)

  if (!href || href === 'about:blank' || href === 'chrome://newtab/') {
    return { ok: false, code: 'no-page', reason: '控制标签没有加载出页面' }
  }
  if (LOGIN_URL.test(href)) return { ok: false, code: 'login-url', reason: '被重定向到登录页' }
  if (EXPIRED.test(text)) return { ok: false, code: 'expired', reason: '页面提示登录已过期' }
  if (len < 1500 && LOGIN_FORM.test(text)) {
    return { ok: false, code: 'login-form', reason: `页面出现登录表单（正文仅 ${len} 字）` }
  }
  return { ok: true, code: 'ok', reason: '' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读一次页面快照（不做判定）。 */
async function readSnapshot(send) {
  let info = { href: '', title: '', text: '', len: 0 }
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{const t=document.body?document.body.innerText:'';return JSON.stringify({href:location.href,title:document.title,text:t.slice(0,500),len:t.length})})()`,
      returnByValue: true,
    })
    info = Object.assign(info, JSON.parse(r.result.value || '{}'))
  } catch (e) {
    return Object.assign(info, { readError: e.message })
  }
  return info
}

/**
 * 在当前控制标签上读页面快照并判定。
 * `send` 是 CDP 的 Runtime.evaluate 发送函数（各脚本自己实现，签名一致）。
 *
 * 为什么要重试：新建的标签偶尔停在 about:blank（新 profile 首次启动被
 * 「欢迎 / 导入」向导挡住时必现）。把它直接判成「未登录」会让人白跑一趟去
 * 重新登录一个其实还有效的账号 —— 2026-10-21 实测复现过。所以「页面没加载」
 * 先等，等到页面出来再判；等不到就报「无法判定」，不冒充登录结论。
 */
export async function checkLogin(send, options = {}) {
  const retries = Number(options.retries ?? 3)
  const delay = Number(options.delay ?? 3000)

  let info = { href: '', title: '', text: '', len: 0 }
  for (let attempt = 0; attempt < retries; attempt++) {
    info = await readSnapshot(send)
    if (info.readError !== undefined) {
      return Object.assign(info, {
        ok: false,
        code: 'read-error',
        reason: '无法读取页面状态（' + info.readError + '）',
      })
    }
    const verdict = classifyLogin(info)
    if (verdict.code !== 'no-page' || attempt === retries - 1) {
      return Object.assign(info, verdict)
    }
    await sleep(delay)
  }
  return Object.assign(info, classifyLogin(info))
}

/** 当前登录的是哪家店。用于发现「profile 里的号被换过」——这类错位不报错，只会串数据。 */
export async function readShopIdentity(send) {
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{
        const t = document.body ? document.body.innerText : '';
        /* 生意参谋顶部会显示当前店铺名与账号；取不到就返回空，由调用方决定是否强校验 */
        const m = t.match(/当前店铺[:：]\\s*([^\\n]{1,40})/) || t.match(/店铺[:：]\\s*([^\\n]{1,40})/);
        return JSON.stringify({ shopName: m ? m[1].trim() : '', href: location.href });
      })()`,
      returnByValue: true,
    })
    return JSON.parse(r.result.value || '{}')
  } catch {
    return { shopName: '', href: '' }
  }
}
