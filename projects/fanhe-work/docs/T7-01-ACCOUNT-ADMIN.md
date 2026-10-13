# T7-01 账号与权限管理

`fanhe`（owner 角色）在「系统设置」页创建公司员工账号，并为每个账号单独配置权限。

## 一、权限模型

一个账号的最终权限由三处共同决定：

```
最终权限 = 角色自带权限 ∪ 账号级授予 − 账号级拒绝
```

合并规则由共享包 `mergePermissions` 实现，**拒绝优先于授予**。角色权限由种子维护
（代码定义），账号级覆盖存在 `user_permissions` 表，是本功能新增的部分。

### 为什么必须有「拒绝」这一侧

只做「额外授予」的话，收回某个权限只能改角色，而改角色会影响所有同角色的人。于是
「给张三单独加个查看权限」做完之后，想撤销就只能把他降级成 viewer，连他原本自带的
权限一起丢。显式拒绝让收回成为一次精确操作。

### owner 的短路规则

服务端在解析权限时对 owner 直接返回全部权限点，不查 `user_permissions`。这让
「owner 不可降权」成为服务端的一条硬规则：即便有人往 owner 的覆盖表里写了 denied
行也不生效。同一规则在 `guard.ts`（请求路径）与 `user-admin.ts`（列表展示）两处
各实现一次，**必须同步修改**，否则会出现「列表里显示的权限」与「实际能做的」不一致。

### 层级判定

写操作还要过一道层级判定：**只能管理 rank 严格小于自己的账号**。

| 规则 | 理由 |
|---|---|
| 不能操作自己 | 自我提权路径。允许的话，一个持有 manage 的账号能改掉自己的角色 |
| target.rank 必须严格小于 actor.rank | 相等也不行。两个 owner 互删的结果取决于谁先点 |
| owner 不可被非 owner 操作 | 独立不变量，不因将来调高某角色 rank 而失效 |

这条判定不能靠权限点表达——权限点是二值的。当前 `admin` 角色就持有
`system.user.manage`，若不加层级判定，它能改掉 owner 的角色。

## 二、数据库表结构

### 新增表 `user_permissions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | UUID PK | uuid(7) |
| `user_id` | UUID FK → users | 级联删除 |
| `permission_id` | UUID FK → permissions | 级联删除 |
| `granted` | BOOLEAN | true=额外授予，false=显式拒绝 |
| `created_at` | TIMESTAMPTZ(3) | |

复合唯一索引 `(user_id, permission_id)`。缺了它，「勾上再取消」会插出第二行，
而哪一行生效取决于查询顺序。

### 新增列 `users.department`

VARCHAR(64)，可为空。**纯展示用途，不参与任何授权判断**——授权只看 `role_id`
与 `user_permissions` 两处。把部门接进权限判断会让「调岗」变成一次授权变更，
而调岗本身不该影响权限。

### 新增权限点 `system.user.delete`

与 `system.user.manage` 分开。软删除会让账号立刻无法登录，比改个姓名严重得多——
混在 manage 里的话，能改名的账号就能删人。只有 owner 持有该权限点。

## 三、接口清单

| 方法 | 路径 | 所需权限 | 说明 |
|---|---|---|---|
| GET | `/api/system/users` | `system.user.read` | 只返回 actor 能管理的账号 + actor 自己 |
| GET | `/api/system/users/:id` | `system.user.read` | 含角色默认权限与账号级覆盖 |
| POST | `/api/system/users` | `system.user.manage` | 创建 |
| PATCH | `/api/system/users/:id` | `system.user.manage` | 改姓名/部门/角色/状态 |
| DELETE | `/api/system/users/:id` | `system.user.delete` | 软删除 |
| POST | `/api/system/users/:id/reset-password` | `system.user.manage` | 重置密码 |
| PUT | `/api/system/users/:id/permissions` | `system.user.manage` | 整体替换权限覆盖 |
| GET | `/api/system/permissions` | 登录即可 | 权限点清单 |
| GET | `/api/system/roles` | 登录即可 | 角色清单 |

### 状态码约定

- **越权一律 404，不返回 403。** 403 等于告诉调用者「这个账号存在，只是你管不了」，
  而账号列表与详情不该成为枚举接口。
- **「可见但不许做」才返回 403**，例如 `cannot_modify_owner`、`cannot_manage_self`。
  这两类混用会让断言与排查都打不中目标分支。

## 四、几个容易踩的语义

### 前端勾选与服务端两组数据

勾选框只有「选中/未选中」两态，服务端要的是「相对角色默认权限改变了什么」。
转换规则在 `diffPermissions`（`apps/web/src/lib/system-users.ts`）：

| 角色默认 | 勾选状态 | 提交 |
|---|---|---|
| 有 | 勾选 | 无变化，不写行 |
| 无 | 勾选 | `granted` |
| 有 | 取消 | `denied` |
| 无 | 未勾 | 无变化，不写行 |

若只把「勾中的」当成 granted，「取消一个角色自带的权限」就表达不出来——界面上
取消掉了，保存后又回来，且界面仍显示已取消。

### 三处「立刻生效」

停用、改角色、重置密码、删除，都**吊销该账号的全部 refresh token**。
少了这一步，换完密码别人手机上的旧登录状态还能继续用；停用只拦下一次登录，
已登录的人照样能用。

### 不允许手工解锁

`updateManagedUser` 接受 `status=active`，但**不允许把 `locked` 改成 `active`**。
解除锁定会让「猜密码」的成本下降，而锁定到期自动恢复已经够用。

### 改密不改权限

重置密码只动密码与锁定状态，不改角色与权限。重置完也不恢复 `disabled`——
管理员可能刚停用某人就误点了重置，一并恢复会让停用凭空失效。

## 五、改动文件清单

### 数据库
- `apps/api/prisma/schema.prisma`：`users.department` 列、`UserPermission` 模型及三处反向关系
- `apps/api/prisma/migrations/20261012094234_user_permissions/migration.sql`：手写迁移

### 共享包
- `packages/shared/src/permissions.ts`：新增 `system.user.delete` 与 `mergePermissions`
- `packages/shared/src/audit.ts`：新增 5 个账号管理动作码
- `packages/shared/src/user-admin.ts`（新）：传输类型
- `packages/shared/src/index.ts`：导出上述
- `packages/shared/src/navigation.ts`：`system-settings` 的 `planned` 置 false
- `packages/shared/test/permissions.test.mjs`：点数断言改为派生，新增 delete 归属断言

### 服务端
- `apps/api/src/auth/guard.ts`：权限解析改为三路合并，owner 短路，`AuthContext` 加 `roleRank`
- `apps/api/src/auth/user-admin.ts`（新）：账号管理服务层与越权防护
- `apps/api/src/routes/system-users.ts`（新）：路由与失败原因到状态码的映射
- `apps/api/src/app.ts`：注册路由、注入权限清单
- `apps/api/test/user-admin.test.ts`（新）：22 个集成用例

### 前端
- `apps/web/src/lib/api.ts`：9 个请求函数
- `apps/web/src/lib/system-users.ts`（新）：数据层与 `diffPermissions`
- `apps/web/src/components/system/UserDialogs.tsx`（新）：三个对话框
- `apps/web/src/pages/UsersPage.tsx`（新）：账号管理页
- `apps/web/src/routes.tsx`：分发到 UsersPage

## 六、已知限制

1. **权限调整需要在页面上重新进入**才会刷新显示。服务端在下一次请求就生效，
   前端菜单则要等 `/me` 重新拉取。当前页面每次操作后整表重拉，但**别的标签页或
   另一个用户的界面不会自动更新**。
2. **子账号之间看不到对方的数据**。notes / events / launch_profiles 都按
   `user_id` 隔离，权限点只管功能开关，不管数据范围。主账号想汇总查看需要额外的数据层授权。
3. **角色清单接口对所有登录用户开放**，其中包含 rank。这不是秘密，但将来若引入
   跨公司的层级概念，需要按角色裁剪。
4. **删除的账号无法恢复**。软删除后列表不再显示，没有回收站界面。
