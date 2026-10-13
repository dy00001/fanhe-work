import {
  PERMISSIONS,
  type ManagedUser,
  type NavItem,
  type PermissionCatalogResponse,
  type PermissionCode,
} from '@fanhe/shared'
import { useCallback, useEffect, useState } from 'react'

import { useAuth } from '../auth/useAuth'
import { ErrorState, LoadingState } from '../components/StateView'
import {
  PermissionDialog,
  ResetPasswordDialog,
  UserFormDialog,
  UserStatusBadge,
  type UserFormRole,
  type UserFormValues,
} from '../components/system/UserDialogs'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table'
import {
  createManagedUser,
  deleteManagedUser,
  describeUserAdminError,
  diffPermissions,
  loadManagedUserDetail,
  loadManagedUsers,
  loadPermissionCatalog,
  loadRoles,
  resetManagedUserPassword,
  setManagedUserPermissions,
  updateManagedUser,
} from '../lib/system-users'

/**
 * 账号与权限管理页。
 *
 * 由超级管理员给公司员工建账号、分配权限。挂在「系统设置」这个导航项下 ——
 * 它已绑 `system` 段权限，owner 天然可见，而普通成员拿不到任何 system 权限，
 * 侧栏里根本不会出现这一项。
 *
 * ## 页面自己不做的事
 *
 * **它不算权限。** 所有判断都来自服务端返回的 `canBeManaged`、`isOwner`，以及
 * `/api/system/permissions` 给的清单。勾选框只决定「提交什么」，最终生效的权限由
 * 服务端重算，并在下一次请求就应用。
 *
 * **它不缓存列表。** 每次操作后整表重拉。账号数量在几十这个量级，一次请求的成本
 * 可以忽略；而「本地改一份再与服务端同步」会带来一种更糟的情况 —— 界面上显示的
 * 权限与服务端实际生效的不一致，且这种不一致不会报错。
 */

type DialogState =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; user: ManagedUser }
  | { kind: 'permissions'; user: ManagedUser }
  | { kind: 'reset'; user: ManagedUser }

export function UsersPage({ item }: { item: NavItem }) {
  const { can } = useAuth()

  const [users, setUsers] = useState<readonly ManagedUser[] | null>(null)
  const [catalog, setCatalog] = useState<PermissionCatalogResponse | null>(null)
  const [roles, setRoles] = useState<readonly UserFormRole[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })
  const [submitting, setSubmitting] = useState(false)

  const canManage = can(PERMISSIONS.SYSTEM_USER_MANAGE)
  const canDelete = can(PERMISSIONS.SYSTEM_USER_DELETE)

  /**
   * 拉取列表、权限点清单与角色清单。
   *
   * 三个请求并发发出而不是串行：它们之间没有依赖，而账号管理页每次打开都要用全
   * 这三份数据。串行会让首屏多等两个往返。
   */
  const reload = useCallback(async (): Promise<void> => {
    try {
      const [list, catalogResult, roleResult] = await Promise.all([
        loadManagedUsers(),
        loadPermissionCatalog(),
        loadRoles(),
      ])
      setUsers(list)
      setCatalog(catalogResult)
      setRoles(
        roleResult.roles.map((role) => ({
          code: role.code,
          name: role.name,
          rank: role.rank,
        })),
      )
      setLoadError(null)
    } catch (error) {
      setLoadError(describeUserAdminError(error))
    }
  }, [])

  useEffect(() => {
    // 异步 IIFE 而非直接 `void reload()`：eslint 的 set-state-in-effect 规则拦的是
    // 「在 effect 体内同步调 setState」，而 reload 里的 setState 都在 await 之后。
    // 直接调用会让规则误判成同步更新，实际行为与既有面板（NotesPanel）一致。
    void (async () => {
      await reload()
    })()
  }, [reload])

  /** 关闭对话框并清掉上一次的错误，否则下次打开会看到上一次的红字。 */
  const closeDialog = useCallback((): void => {
    setDialog({ kind: 'none' })
    setActionError(null)
  }, [])

  const handleCreate = async (values: UserFormValues): Promise<void> => {
    setSubmitting(true)
    setActionError(null)
    try {
      await createManagedUser({
        username: values.username.trim(),
        password: values.password,
        displayName: values.displayName.trim(),
        // 空部门不传。服务端把空串归一成 null，两者等价，但不传能少走一次判断。
        ...(values.department.trim() === '' ? {} : { department: values.department.trim() }),
        roleCode: values.roleCode,
      })
      closeDialog()
      await reload()
    } catch (error) {
      setActionError(describeUserAdminError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const handleUpdate = async (user: ManagedUser, values: UserFormValues): Promise<void> => {
    setSubmitting(true)
    setActionError(null)
    try {
      await updateManagedUser(user.id, {
        displayName: values.displayName.trim(),
        department: values.department.trim() === '' ? null : values.department.trim(),
        roleCode: values.roleCode,
        ...(values.status === 'active' || values.status === 'disabled'
          ? { status: values.status }
          : {}),
      })
      closeDialog()
      await reload()
    } catch (error) {
      setActionError(describeUserAdminError(error))
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * 保存权限。
   *
   * 关键在 `diffPermissions`：把界面上那一片勾选翻译成「相对角色默认改变了什么」。
   * 直接把选中的当授予提交，界面就会陷入「取消一个角色自带的权限却存不住」的死循环。
   */
  const handleSavePermissions = async (
    user: ManagedUser,
    selected: ReadonlySet<PermissionCode>,
  ): Promise<void> => {
    setSubmitting(true)
    setActionError(null)
    try {
      const detail = await loadManagedUserDetail(user.id)
      const diff = diffPermissions(selected, new Set(detail.rolePermissions))
      await setManagedUserPermissions(user.id, diff)
      closeDialog()
      await reload()
    } catch (error) {
      setActionError(describeUserAdminError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const handleResetPassword = async (user: ManagedUser, newPassword: string): Promise<void> => {
    setSubmitting(true)
    setActionError(null)
    try {
      await resetManagedUserPassword(user.id, newPassword)
      closeDialog()
      await reload()
    } catch (error) {
      setActionError(describeUserAdminError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (user: ManagedUser): Promise<void> => {
    if (!window.confirm(`确定删除账号「${user.displayName}」？该操作不可撤销。`)) {
      return
    }
    try {
      await deleteManagedUser(user.id)
      await reload()
    } catch (error) {
      setActionError(describeUserAdminError(error))
    }
  }

  if (loadError !== null) {
    return (
      <ErrorState title="账号列表加载失败" description={loadError} onRetry={() => void reload()} />
    )
  }

  if (users === null || catalog === null) {
    return <LoadingState label="正在加载账号列表…" />
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-medium text-foreground">{item.label}</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              为公司员工创建账号，分配角色与权限点。角色决定默认权限，
              「配置权限」可以在此基础上逐项增减。
            </p>
          </div>
          {canManage && (
            <Button type="button" onClick={() => setDialog({ kind: 'create' })}>
              创建账号
            </Button>
          )}
        </div>
      </section>

      {actionError !== null && (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </p>
      )}

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>姓名</TableHead>
              <TableHead>登录账号</TableHead>
              <TableHead>部门</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium text-foreground">
                  <span className="flex items-center gap-2">
                    {user.displayName}
                    {user.isOwner && <Badge variant="secondary">超级管理员</Badge>}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {user.username}
                </TableCell>
                <TableCell className="text-muted-foreground">{user.department ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{user.role.name}</TableCell>
                <TableCell>
                  <UserStatusBadge status={user.status} />
                </TableCell>
                <TableCell className="text-right">
                  {user.canBeManaged ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setDialog({ kind: 'permissions', user })}
                      >
                        配置权限
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setDialog({ kind: 'edit', user })}
                      >
                        编辑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setDialog({ kind: 'reset', user })}
                      >
                        重置密码
                      </Button>
                      {canDelete && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => void handleDelete(user)}
                        >
                          删除
                        </Button>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground-weak">当前账号</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      {dialog.kind === 'create' && (
        <UserFormDialog
          key="create"
          open
          onOpenChange={(open) => {
            if (!open) closeDialog()
          }}
          mode="create"
          roles={roles}
          // owner 是最高 rank，它下面的层级都可分配。这一页只有 owner 进得来
          // （导航项绑 system 段权限），因此不需要按查看者的 rank 再收窄。
          maxAssignableRank={Number.MAX_SAFE_INTEGER}
          submitting={submitting}
          error={actionError}
          onSubmit={handleCreate}
        />
      )}

      {dialog.kind === 'edit' && (
        <UserFormDialog
          key={`edit-${dialog.user.id}`}
          open
          onOpenChange={(open) => {
            if (!open) closeDialog()
          }}
          mode="edit"
          initial={{
            displayName: dialog.user.displayName,
            department: dialog.user.department ?? '',
            roleCode: dialog.user.role.code,
            status: dialog.user.status,
          }}
          roles={roles}
          maxAssignableRank={Number.MAX_SAFE_INTEGER}
          submitting={submitting}
          error={actionError}
          onSubmit={(values) => handleUpdate(dialog.user, values)}
        />
      )}

      {dialog.kind === 'permissions' && (
        <PermissionDialog
          key={`perm-${dialog.user.id}`}
          open
          onOpenChange={(open) => {
            if (!open) closeDialog()
          }}
          userDisplayName={dialog.user.displayName}
          currentPermissions={dialog.user.permissions}
          catalog={catalog.permissions}
          readOnly={dialog.user.isOwner}
          submitting={submitting}
          error={actionError}
          onSubmit={(selected) => handleSavePermissions(dialog.user, selected)}
        />
      )}

      {dialog.kind === 'reset' && (
        <ResetPasswordDialog
          key={`reset-${dialog.user.id}`}
          open
          onOpenChange={(open) => {
            if (!open) closeDialog()
          }}
          userDisplayName={dialog.user.displayName}
          submitting={submitting}
          error={actionError}
          onSubmit={(newPassword) => handleResetPassword(dialog.user, newPassword)}
        />
      )}
    </div>
  )
}
