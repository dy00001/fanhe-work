import { useEffect, useState } from 'react'

type Health = {
  status: string
  service: string
  time: string
}

const stack = [
  ['前端', 'React 19 + TypeScript + Vite'],
  ['样式', 'Tailwind CSS 4'],
  ['后端', 'Node + Fastify'],
  ['数据', 'PostgreSQL + Prisma'],
  ['外壳', 'Electron'],
] as const

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [apiState, setApiState] = useState<'checking' | 'online' | 'offline'>('checking')

  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: Health) => {
        if (cancelled) return
        setHealth(data)
        setApiState('online')
      })
      .catch(() => {
        if (cancelled) return
        setApiState('offline')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-h-screen bg-surface text-ink">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="flex items-center gap-4">
          <img src="/brand/logo.png" alt="梵禾" className="h-14 w-auto" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">梵禾 Work</h1>
            <p className="text-sm text-ink-soft">实验版开发环境</p>
          </div>
        </div>

        <div className="mt-10 rounded-xl border border-line bg-card p-6">
          <h2 className="text-base font-medium">技术栈</h2>
          <dl className="mt-4 divide-y divide-line-soft">
            {stack.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between py-2.5 text-sm">
                <dt className="text-ink-soft">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-4 rounded-xl border border-line bg-card p-6">
          <h2 className="text-base font-medium">服务连通性</h2>
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span
              className={
                'inline-block h-2 w-2 rounded-full ' +
                (apiState === 'online'
                  ? 'bg-emerald-500'
                  : apiState === 'offline'
                    ? 'bg-amber-500'
                    : 'bg-ink-faint')
              }
            />
            <span className="text-ink-soft">后端接口</span>
            <span>
              {apiState === 'online' && health
                ? `已连接 ${health.service}`
                : apiState === 'offline'
                  ? '未连接，请先启动 pnpm dev:api'
                  : '检测中'}
            </span>
          </div>
        </div>

        <p className="mt-6 text-xs leading-relaxed text-ink-faint">
          本页为阶段零的环境验证页。主框架、左侧导航与个人工作台三板块在阶段二与阶段三实现，
          界面方向已确定为方案 B 现代极简。
        </p>
      </div>
    </div>
  )
}
