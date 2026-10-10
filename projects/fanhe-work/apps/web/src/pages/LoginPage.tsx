import { useState, type FormEvent } from 'react'

import { useAuth } from '../auth/useAuth'
import { AuthLayout } from '../components/AuthLayout'
import { TextField } from '../components/TextField'
import { ApiError } from '../lib/api'

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
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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
      // 成功后 Provider 会切走界面，本组件随即卸载，不需要再收尾。
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
