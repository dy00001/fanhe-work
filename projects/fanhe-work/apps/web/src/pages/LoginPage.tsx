import { useEffect, useState, type FormEvent } from 'react'

import { useAuth } from '../auth/useAuth'
import { AuthLayout } from '../components/AuthLayout'
import { TextField } from '../components/TextField'
import { ApiError } from '../lib/api'
import {
  clearCredential,
  hasStoredCredential,
  loadCredential,
  saveCredential,
} from '../lib/credential'

/**
 * 把错误翻译成一句能给用户看的话。
 *
 * 服务端已经保证「账号不存在」与「密码错误」返回同一句话，因此这里直接把
 * message 展示出来是安全的，不会变成账号枚举的旁路。唯一的例外是限速：它
 * 不涉及账号信息，把「还要等多久」告诉用户可以避免他在窗口内反复重试。
 */
function describeLoginError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isRateLimited && error.retryAfterSeconds !== null) {
      const minutes = Math.ceil(error.retryAfterSeconds / 60)
      return `${error.message}（约 ${minutes} 分钟后可再试）`
    }
    return error.message
  }
  return '登录失败，请稍后重试'
}

export function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // 惰性初始化，让第一帧的勾选状态就是对的。密文在不在是一次同步读取，
  // 不必等异步解密完成再把勾选框点亮。
  const [remember, setRemember] = useState(() => hasStoredCredential())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /**
   * 把上次记住的凭据填进输入框。
   *
   * 只在输入框还空着时填。浏览器自带的密码管理器可能已经填过一份，那一份是
   * 用户刚在浏览器里更新过的，覆盖它会把密码换回旧的，而界面上看不出发生过什么。
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const saved = await loadCredential()
      if (cancelled) return

      if (saved === null) {
        // 密文在但解不开（密钥被清、内容被改），`loadCredential` 已经把它删掉了。
        // 勾选框跟着回到未勾选，与「本机没有可用凭据」这个事实保持一致。
        setRemember(false)
        return
      }

      setUsername((current) => (current === '' ? saved.username : current))
      setPassword((current) => (current === '' ? saved.password : current))
    })()

    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting) return

    setError(null)

    // 只做「有没有填」这一层。账号名格式不在这里判：登录路径上格式不合法与
    // 密码不对是同一件事，服务端也已经把它们合并成同一个响应，前端多判一层
    // 只会给出一句比服务端更具体、但同样无法据以行动的话。
    if (username.trim() === '' || password === '') {
      setError('请输入账号与密码')
      return
    }

    setSubmitting(true)
    try {
      await login(username, password)
      // 凭据在登录成功之后才处理。放在提交时会把输错的密码一并记住，而用户下次
      // 看到密码框已经被填满，会以为那个密码是对的。
      //
      // 这一步在组件卸载之后才跑完（登录成功会切走界面），因此不能碰任何 state。
      // `saveCredential` 自身不抛错，失败只是没记住，不影响已经完成的登录。
      if (remember) {
        await saveCredential({ username, password })
      } else {
        clearCredential()
      }
    } catch (caught) {
      setError(describeLoginError(caught))
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout subtitle="登录以继续">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <TextField
          id="login-username"
          label="账号"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          autoFocus
          disabled={submitting}
        />

        <TextField
          id="login-password"
          label="密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={submitting}
        />

        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              id="login-remember"
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              disabled={submitting}
              className="h-4 w-4 accent-accent"
            />
            记住账号密码
          </label>
          {/* 把凭据的去向直接写在界面上。用户勾选时有权知道它去了哪里，
              而这件事在实现里看得到、在界面上看不到。 */}
          <p className="text-xs text-ink-faint">加密后只保存在本机，不会上传到服务器</p>
        </div>

        {error !== null && (
          <p
            role="alert"
            className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </AuthLayout>
  )
}
