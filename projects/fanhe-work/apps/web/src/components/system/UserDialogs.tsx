import type { PermissionCode } from '@fanhe/shared'
import { useState } from 'react'

import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

/**
 * 账号管理的三个对话框：权限勾选、创建/编辑表单、重置密码。
 *
 * 放同一个文件而不是三个，因为它们共享「对话框骨架 + 提交中禁用 + 错误内联显示」
 * 这三件事。拆开后那三样要在三处各写一遍，改一次漏一处时表现是「某个对话框的
 * 错误飘到了对话框外面」。
 */

export type PermissionCatalogEntry = {
  code: PermissionCode
  module: string
  object: string
  action: string
  description: string
}

// ---------------------------------------------------------------------------
// 权限勾选
// ---------------------------------------------------------------------------

const MODULE_LABELS: Readonly<Record<string, string>> = {
  system: '系统管理',
  personal: '个人工作台',
}

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** 按模块分组，组内保持清单里的顺序（清单本身已按模块与对象排好）。 */
function groupByModule(
  catalog: readonly PermissionCatalogEntry[],
): readonly { module: string; entries: readonly PermissionCatalogEntry[] }[] {
  const groups = new Map<string, PermissionCatalogEntry[]>()
  for (const entry of catalog) {
    const bucket = groups.get(entry.module)
    if (bucket === undefined) groups.set(entry.module, [entry])
    else bucket.push(entry)
  }
  return [...groups.entries()].map(([module, entries]) => ({ module, entries }))
}

/**
 * 权限勾选对话框。
 *
 * ## 为什么勾选框只有两态，而提交的是两组
 *
 * 勾选框是「选中 / 未选中」，服务端要的是「相对角色默认权限改变了什么」。
 * 两者不是一回事：一个角色自带的权限，用户在界面上取消勾选后，服务端必须知道要
 * **显式拒绝**它，而不能简单地「不写这一行」—— 不写的话它仍然来自角色，保存后
 * 又变回勾选，界面上则显示已取消。用户会看到一个怎么点都存不住的勾选框。
 *
 * 转换规则集中在 `diffPermissions`（lib/system-users.ts），本组件只负责收集选中
 * 集合后交给它算。
 *
 * ## 为什么 owner 不可调整
 *
 * 服务端对 owner 短路返回全部权限点，`user_permissions` 里写什么都不生效。
 * 在这里展示一份可勾选的列表却不让提交，等于骗用户。与其给一个「保存了但没用」的
 * 界面，不如直接说清楚：这一档由系统固定，不可调整。
 *
 * **全选放在模块级而不是逐项**，是因为权限点已经有十几个，逐项勾是这份清单的
 * 实际用法。没有放「全不选」按钮：把「全部拒绝」放在显眼位置容易被误点，
 * 而那通常不是用户想要的结果。
 */
export function PermissionDialog({
  open,
  onOpenChange,
  userDisplayName,
  currentPermissions,
  catalog,
  readOnly,
  submitting,
  error,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  userDisplayName: string
  /** 该账号现有的最终权限，作为打开时的初始选中集合。 */
  currentPermissions: readonly PermissionCode[]
  catalog: readonly PermissionCatalogEntry[]
  /** owner 账号不可调整权限。 */
  readOnly: boolean
  submitting: boolean
  error: string | null
  /** 由外层算两组差异并提交。这里只交出选中集合。 */
  onSubmit: (selected: ReadonlySet<PermissionCode>) => Promise<void>
}) {
  // 初始选中集合只算一次。放在 useState 的初值里而非每次渲染重算，因为对话框打开
  // 期间要允许用户自由勾选 —— 若跟着 props 重算，用户点一下就被外部数据覆盖回去了。
  const [selected, setSelected] = useState<ReadonlySet<PermissionCode>>(
    () => new Set(currentPermissions),
  )

  const groups = groupByModule(catalog)

  const toggle = (code: PermissionCode, checked: boolean): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(code)
      else next.delete(code)
      return next
    })
  }

  const selectGroup = (entries: readonly PermissionCatalogEntry[], checked: boolean): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      for (const entry of entries) {
        if (checked) next.add(entry.code)
        else next.delete(entry.code)
      }
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>配置权限：{userDisplayName}</DialogTitle>
          <DialogDescription>
            勾选该账号可以访问的页面与操作。取消勾选「角色默认」的权限会让它被显式拒绝。
          </DialogDescription>
        </DialogHeader>

        {readOnly ? (
          <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm leading-relaxed text-muted-foreground">
            超级管理员固定拥有全部权限，这一档不可调整。系统里必须始终保留一个能进入
            账号管理的入口，否则所有人都被锁在外面时没有人能解开。
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground-weak">
                已选 {selected.size} 项，共 {catalog.length} 项
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelected(new Set(catalog.map((entry) => entry.code)))}
              >
                全选
              </Button>
            </div>

            <div className="max-h-80 space-y-4 overflow-y-auto pr-1">
              {groups.map((group) => (
                <section key={group.module} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-foreground">
                      {MODULE_LABELS[group.module] ?? group.module}
                    </h3>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => selectGroup(group.entries, true)}
                    >
                      整组全选
                    </Button>
                  </div>
                  <div className="space-y-1 rounded-lg border border-border p-3">
                    {group.entries.map((entry) => (
                      <label
                        key={entry.code}
                        className="flex cursor-pointer items-start gap-3 py-1.5"
                      >
                        <Checkbox
                          checked={selected.has(entry.code)}
                          onCheckedChange={(checked) => toggle(entry.code, checked === true)}
                        />
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm text-foreground">{entry.description}</span>
                          <code className="text-xs text-muted-foreground-weak">{entry.code}</code>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            关闭
          </Button>
          {!readOnly && (
            <Button
              type="button"
              disabled={submitting}
              onClick={() => {
                void onSubmit(selected)
              }}
            >
              {submitting ? '保存中' : '保存权限'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 创建与编辑表单
// ---------------------------------------------------------------------------

export type UserFormValues = {
  username: string
  password: string
  displayName: string
  department: string
  roleCode: string
  status: string
}

export type UserFormRole = {
  code: string
  name: string
  rank: number
}

/**
 * 创建与编辑共用一个表单：字段几乎相同，拆成两份的话「新增时部门可空、编辑时
 * 也可空」这类差异会各自漂移。
 *
 * 真正需要区分的是登录账号与密码 —— 编辑时这两项不可改，改密码走独立的重置入口。
 * 理由在对话框描述里写明了：重置密码会吊销会话，属于另一件事。
 */
export function UserFormDialog({
  open,
  onOpenChange,
  mode,
  initial,
  roles,
  maxAssignableRank,
  submitting,
  error,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  initial?: Partial<UserFormValues> | undefined
  roles: readonly UserFormRole[]
  /**
   * 可分配角色的 rank 上限。低于它的才允许选 —— 与服务端的层级判定一致，让不可选
   * 项在界面上就不出现，而不是等提交后被拒。
   */
  maxAssignableRank: number
  submitting: boolean
  error: string | null
  onSubmit: (values: UserFormValues) => Promise<void>
}) {
  const editing = mode === 'edit'
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '')
  const [department, setDepartment] = useState(initial?.department ?? '')
  const [roleCode, setRoleCode] = useState(initial?.roleCode ?? '')
  const [status, setStatus] = useState(initial?.status ?? 'active')

  const assignable = roles.filter((role) => role.rank < maxAssignableRank)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑账号' : '创建账号'}</DialogTitle>
          <DialogDescription>
            {editing
              ? '登录账号与密码不可在此修改，改密码请用「重置密码」。'
              : '新账号创建后即可登录。初始密码请当面告知员工，并提醒其妥善保管。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!editing && (
            <div className="space-y-1.5">
              <Label htmlFor="su-username">登录账号</Label>
              <Input
                id="su-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="小写字母、数字、下划线与短横线"
              />
            </div>
          )}

          {!editing && (
            <div className="space-y-1.5">
              <Label htmlFor="su-password">初始密码</Label>
              <Input
                id="su-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 12 位"
              />
              <p className="text-xs text-muted-foreground-weak">
                明文显示而非掩码：管理员需要看到并转述它，掩码只会让两边都猜错字符。
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="su-display-name">姓名</Label>
            <Input
              id="su-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="张三"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="su-department">所属部门</Label>
            <Input
              id="su-department"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              placeholder="设计部（可留空）"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="su-role">角色</Label>
            <select
              id="su-role"
              value={roleCode}
              onChange={(event) => setRoleCode(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">选择角色</option>
              {assignable.map((role) => (
                <option key={role.code} value={role.code}>
                  {role.name}
                </option>
              ))}
            </select>
            {assignable.length === 0 && (
              <p className="text-xs text-destructive" role="alert">
                没有可分配的角色：你的层级之下没有更低级角色。
              </p>
            )}
            <p className="text-xs text-muted-foreground-weak">
              角色决定默认权限，之后可在「配置权限」里逐项调整。
            </p>
          </div>

          {editing && (
            <div className="space-y-1.5">
              <Label htmlFor="su-status">账号状态</Label>
              <select
                id="su-status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className={SELECT_CLASS}
              >
                <option value="active">正常</option>
                <option value="disabled">停用</option>
              </select>
              <p className="text-xs text-muted-foreground-weak">
                停用会立刻吊销该账号的全部登录状态，下次起无法登录。
              </p>
            </div>
          )}
        </div>

        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={submitting}
            onClick={() => {
              void onSubmit({ username, password, displayName, department, roleCode, status })
            }}
          >
            {submitting ? '提交中' : editing ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 重置密码
// ---------------------------------------------------------------------------

/**
 * 重置密码对话框。
 *
 * 密码可见是刻意的，理由与创建表单相同：管理员需要把密码转述给员工。
 *
 * 生成按钮给的是一段随机串，省得现场想一个够长的密码 —— 短密码是最常被「为了好记」
 * 而选中的那一档。
 */
export function ResetPasswordDialog({
  open,
  onOpenChange,
  userDisplayName,
  submitting,
  error,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  userDisplayName: string
  submitting: boolean
  error: string | null
  onSubmit: (newPassword: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')

  const generate = (): void => {
    // 取 Math.random 是够的：这段口令活不过「当面告知」这一次，用不着密码学强度。
    // 真正需要不可预测的凭据（API Key、令牌）都走 crypto，这里不该引入那种错觉。
    // 排除 0/O、1/I/L 这些易混字符，避免口头转述时出错。
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let out = ''
    for (let i = 0; i < 16; i += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
    setPassword(out)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重置密码：{userDisplayName}</DialogTitle>
          <DialogDescription>
            重置后该账号在所有设备上的登录状态都会失效，需要用新密码重新登录。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="su-reset-password">新密码</Label>
          <div className="flex gap-2">
            <Input
              id="su-reset-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 12 位"
            />
            <Button type="button" variant="outline" onClick={generate}>
              生成
            </Button>
          </div>
        </div>

        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={submitting}
            onClick={() => {
              void onSubmit(password)
            }}
          >
            {submitting ? '提交中' : '确认重置'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 账号状态徽标。 */
export function UserStatusBadge({ status }: { status: string }) {
  if (status === 'active') return <Badge variant="secondary">正常</Badge>
  if (status === 'locked') return <Badge variant="outline">已锁定</Badge>
  return <Badge variant="destructive">已停用</Badge>
}
