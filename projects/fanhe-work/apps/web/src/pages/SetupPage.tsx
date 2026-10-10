import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  isValidUsername,
  normalizeUsername,
} from '@fanhe/shared'
import { useState, type FormEvent } from 'react'

import { useAuth } from '../auth/useAuth'
import { AuthLayout } from '../components/AuthLayout'
import { TextField } from '../components/TextField'
import { Button } from '../components/ui/button'
import { ApiError, initializeOwnerRequest } from '../lib/api'

/**
 * 首次初始化引导。
 *
 * 只在系统里还没有任何 owner 账号时出现，这是唯一一处不需要登录就能创建账号的
 * 界面。服务端对它的门禁比别处更严（判据是「存在任意 owner」，不过滤状态与
 * 软删除），界面这一侧只负责把输入整理成服务端期望的形式。
 *
 * 校验规则直接引用 `@fanhe/shared`，与服务端同一份。前端说「可以」而服务端说
 * 「不行」这类不一致只会在联调时暴露，把规则共用是从源头消掉它。
 */

/** 账号名提示文案。由常量拼出，避免规则改了而提示没改。 */
const USERNAME_HINT = `小写字母、数字与 . _ -，以字母或数字开头，${USERNAME_MIN_LENGTH} 到 ${USERNAME_MAX_LENGTH} 位`
const PASSWORD_HINT = `至少 ${PASSWORD_MIN_LENGTH} 位。这是系统里权限最高的账号，请勿使用弱口令`

function describeSetupError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'already_initialized') {
      return '系统已完成初始化，请刷新页面后登录'
    }
    if (error.code === 'username_taken') {
      return '该账号名已被占用，请换一个'
    }
    return error.message
  }
  return '初始化失败，请稍后重试'
}

export function SetupPage() {
  const { markInitialized } = useAuth()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting) return

    setError(null)

    const normalized = normalizeUsername(username)
    if (!isValidUsername(normalized)) {
      setError('账号名不符合要求')
      return
    }
    if (displayName.trim() === '') {
      setError('请填写显示名')
      return
    }
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      setError(`密码长度须在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 之间`)
      return
    }
    // 二次确认只在客户端校验。服务端没有这个字段，也不该有：把确认密码发过去
    // 等于多传一份等价的秘密，而它的作用只是防止输入手误，属于界面职责。
    if (password !== confirmation) {
      setError('两次输入的密码不一致')
      return
    }

    setSubmitting(true)
    try {
      await initializeOwnerRequest({
        username: normalized,
        password,
        displayName: displayName.trim(),
      })
      // 初始化成功后不自动登录，切回登录页让用户亲手登录一次。服务端刻意不在这条
      // 路径上签发令牌，客户端也就没有令牌可存。
      markInitialized()
    } catch (caught) {
      setError(describeSetupError(caught))
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout subtitle="创建超级管理员">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <p className="text-sm leading-relaxed text-muted-foreground">
          这是系统的首次初始化。创建的账号拥有全部权限，完成后初始化入口将自动关闭。
        </p>

        <TextField
          id="setup-username"
          label="账号"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          hint={USERNAME_HINT}
          autoFocus
          disabled={submitting}
        />

        <TextField
          id="setup-display-name"
          label="显示名"
          value={displayName}
          onChange={setDisplayName}
          autoComplete="name"
          hint={`展示用，允许中文，最多 ${DISPLAY_NAME_MAX_LENGTH} 字`}
          disabled={submitting}
        />

        <TextField
          id="setup-password"
          label="密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          disabled={submitting}
        />

        <TextField
          id="setup-password-confirm"
          label="确认密码"
          type="password"
          value={confirmation}
          onChange={setConfirmation}
          autoComplete="new-password"
          disabled={submitting}
        />

        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="mt-1">
          {submitting ? '创建中…' : '创建账号'}
        </Button>
      </form>
    </AuthLayout>
  )
}
