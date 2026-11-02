# 本机 Docker 数据与配置向仓库迁移

> 2026-10-30 勘查。目的：让任意一台装了 Docker 的机器，克隆仓库后能复现这套服务。
> 本文只记录「本机有、仓库没有」的部分如何落地，已有资产的用途一并说明。

## 一、先厘清一件事

GitHub 不能承载这套服务。Actions 的 runner 是一次性的，容器和卷在任务结束后销毁，
它适合构建镜像、跑门禁、推 ghcr.io，不适合跑有状态服务。

所以「迁移到 GitHub 项目」的准确含义是两件事：

1. **资产入库**：把复现所需的定义文件纳入版本控制，让 git 成为唯一真相来源。
2. **数据可搬运**：把本机卷里的业务数据变成可校验、可恢复的归档，走独立通道。

这两件事的边界必须分开。定义文件入库，业务数据不入库。理由见第四节。

## 二、范围梳理

### 2.1 容器（4 个在运行）

| 容器 | 镜像 | 端口 | 用途 |
| --- | --- | --- | --- |
| `fanhe-work-db` | postgres:16-alpine | 127.0.0.1:5432 | 业务库，ICU zh-CN 排序，健康检查靠 `pg_isready` |
| `fanhe-work-api` | fanhe-work-api:latest | 127.0.0.1:8787 | 后端，跑 `node dist/index.js`，`HOST=0.0.0.0` |
| `fanhe-work-web` | fanhe-work-web:latest | 127.0.0.1:8080 | nginx 托管前端静态产物，并把 `/api` 反代给 api |
| `fanhe-work-cloudflared` | cloudflare/cloudflared:2025.8.1 | 无 | 出站隧道，把外部流量转给 web。不绑宿主端口，这是「无公网入站暴露」的全部依据 |
| `fanhe-work-migrate-1` | fanhe-work-migrate:latest | 无 | 一次性容器，应用 14 个 Prisma 迁移后退出（`restart: no`） |

全部定义在 `projects/fanhe-work/docker-compose.yml`，**已在仓库内，无需迁移**。

### 2.2 镜像

| 镜像 | 归属 | 处理 |
| --- | --- | --- |
| `fanhe-work-api` / `fanhe-work-web` / `fanhe-work-migrate` | 本项目，本地构建 | 不迁移。新环境 `build` 重建，约 3 到 5 分钟 |
| `postgres:16-alpine` / `nginx:1.27-alpine` / `cloudflare/cloudflared:2025.8.1` / `node:22-bookworm-slim` | 上游基础镜像 | 不迁移。拉取即可，版本已钉在 compose 与 Dockerfile 里 |
| `t502-*` / `t503-*` | 2026-10-12 的阶段性实验，无容器引用 | 可清理，与本项目无关 |
| `sub2api*` / `redis:7-alpine` / `metacubex/mihomo` | 其他项目 | 不迁移，不属于梵禾 |

镜像不构成迁移对象。**镜像可由 Dockerfile 与锁文件确定性地重建，把它当资产搬运反而会掩盖构建不可复现的问题。**

### 2.3 数据卷

| 卷 | 占用 | 用途 |
| --- | --- | --- |
| `fanhe-work-pgdata` | 71.49 MB | 业务库唯一落盘位置，挂到 `/var/lib/postgresql/data` |
| `66964a22...`（匿名） | 47.74 MB | 悬空卷，无容器引用，来源不明 |

这是整套部署里**唯一的单点**。代码能重拉、镜像能重建、配置能重写，卷里的数据只有一份。

当前库实况（2026-10-30 勘查）：

- 26 张表，14 条迁移记录，21 个权限点
- `ecom_dimension_snapshots` 1898 行，`customer_order_steps` 812 行，`audit_logs` 247 行
- `customer_orders` 58 行，`customers` 53 行，`users` 3 行
- `case_uploads` 13 行，图片字节存在 bytea 列里，不落容器磁盘

数据量很小（全量 dump 1.5 MB），用逻辑备份搬运足够，不需要拷贝物理卷。

### 2.4 环境变量

| 变量 | 位置 | 是否必填 | 用途 |
| --- | --- | --- | --- |
| `FANHE_JWT_SECRET` | `.env.compose` | 必填，缺失即拒绝启动 | 访问令牌签名密钥 |
| `FANHE_TUNNEL_TOKEN` | `.env.compose` | 必填，缺失即拒绝启动 | cloudflared 出站凭据 |
| `OPS_INGEST_TOKEN` | `.env.compose` | 可空 | 保护 `POST /api/ops/ingest` 这一个写路由，未配则 503 |
| `FANHE_DB_USER` / `FANHE_DB_PASSWORD` / `FANHE_DB_NAME` | compose 锚点，带默认值 | 可选 | 连接串与 db 服务共用同一锚点，改一处两边生效 |
| `TUNNEL_TRANSPORT_PROTOCOL` | compose 内固定 `http2` | 固定 | 绕开 Clash Verge TUN 抢 UDP 导致的隧道反复断线 |
| `DATABASE_URL` / `JWT_SECRET` | `apps/api/.env` | 必填 | 本机开发用，连 127.0.0.1，与容器那份刻意不同 |

**缺口在这里。** `.env.compose` 被 `.gitignore` 排除，新克隆的仓库没有这个文件，
`ws-compose.cmd` 会直接退出并提示缺失。这是「复现失败」的第一道坎。

### 2.5 配置文件

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `docker-compose.yml` | 已入库 | 5 服务编排，含三条迁移依赖约束 |
| `apps/api/Dockerfile` | 已入库 | 三阶段 build / runtime / migrate，`migrate` 在文件末尾 |
| `apps/web/Dockerfile` | 已入库 | 两阶段 build / runtime |
| `apps/api/.env.example` | 已入库 | 本机开发模板 |
| `apps/api/prisma/migrations/` | 已入库 | 14 个迁移，空卷到可用这条链的唯一依据 |
| `tools/checks/db-backup.mjs` | 已入库 | 备份 / 列表 / 校验 / 恢复 |
| `.env.compose` | **未入库** | 含真实密钥，本次补模板 |
| `keys/*.pfx` | **未入库** | 桌面端签名私钥，`/keys/` 整目录忽略 |
| `data/backups/*.dump` | **未入库** | `data/*` 忽略，备份走独立通道 |

## 三、落地方式与文件变更清单

### 3.1 本次新增

| 文件 | 作用 |
| --- | --- |
| `projects/fanhe-work/.env.compose.example` | 环境变量模板，三个密钥全部留空并附生成命令。新环境复制后填值即可启动 |
| `docs/ops/DOCKER-MIGRATION-2026-10-30.md` | 本文 |

### 3.2 刻意不改

- `docker-compose.yml`。三条迁移依赖约束、`HOST=0.0.0.0`、`restart: no`、`http2` 都是踩过坑之后定下的，改动会重新引入故障。
- `.gitignore`。`.env.compose`、`/keys/`、`data/*` 的排除规则是对的，放宽等于把密钥与客户数据推到远端。
- `db-backup.mjs`。已验证可用，见第五节。

### 3.3 新环境复现步骤

```bash
# 1. 克隆
git clone https://github.com/dy00001/fanhe-work.git
cd fanhe-work/projects/fanhe-work

# 2. 准备环境变量
cp .env.compose.example .env.compose
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # 填 FANHE_JWT_SECRET
# FANHE_TUNNEL_TOKEN 从 Cloudflare 控制台复制；不对外则留空并注释掉 cloudflared 服务

# 3. 起栈（必须经包装脚本，它负责 --env-file）
../../infra/portable/ws-compose.cmd up -d --wait

# 4. 确认
../../infra/portable/ws-compose.cmd ps
curl --noproxy '*' http://127.0.0.1:8787/api/health
curl --noproxy '*' -I http://127.0.0.1:8080
```

首次 `up` 会自动执行 `migrate`，把 14 个迁移应用到空卷，然后跑种子写入 21 个权限点。
若库需要业务数据，走第五节恢复流程。

### 3.4 建议但未实施

把字典表（`roles`、`permissions`、`role_permissions`、`launch_profiles`）导出为
`prisma/seed-data/` 下的 JSON，由种子脚本读取。这样空卷启动后权限点与角色是确定的，
不依赖 `db:seed` 的代码常量。**客户数据（`customers`、`customer_orders`、`case_uploads`）
不进这条链**，它们只能经 dump 恢复。

## 四、敏感信息处理

| 类别 | 处理 | 依据 |
| --- | --- | --- |
| JWT 密钥 | 模板留空，附生成命令 | 每套部署独立，不复用 |
| Tunnel token | 模板留空，注明获取路径 | 每条 Tunnel 一个，泄漏即可被接入 |
| ingest token | 模板留空，注明可空语义 | 只保护一个写路由 |
| 数据库口令 | 只在 compose 锚点带默认值，模板里注释掉 | 单一来源，避免两处不一致 |
| 签名私钥 `.pfx` | `/keys/` 整目录忽略，另有 `docs/SIGNING-KEY-BACKUP.md` | 私钥永不入库 |
| 业务数据 | `data/*` 忽略，dump 不进仓库 | 含客户手机号与订单金额，属于个人信息 |

**业务数据为什么不入库。** 这 26 张表里有 53 条客户记录、58 条订单、13 份案例图字节。
推到公开仓库（该仓库 2026-10-11 已由私有转公开）等于泄露客户信息，且 git 历史不可撤销。
即使后续删文件，历史里仍然取得到。

## 五、验证方式

### 5.1 已验证（2026-10-30 实测）

备份与恢复链路：

```
node tools/checks/db-backup.mjs backup
→ data/backups/fanhe-work-2026-10-30T06-33-53.dump，1517.9 KB，sha256 前 16 位 9f28407023934d9d

node tools/checks/db-backup.mjs verify
→ PASS 文件头是 PGDMP
→ PASS 校验和一致
→ PASS 恢复过程无错误（--exit-on-error）
→ PASS 全部 26 张表行数与备份时一致
```

`verify` 是真恢复，会在库里建临时库、灌进去、逐表比行数、再删除。这是唯一能证明备份可用的判据。

### 5.2 新环境验收（需在空卷上做）

| 项 | 判据 | 反例测试 |
| --- | --- | --- |
| 迁移链完整 | 空卷 `up` 后 `_prisma_migrations` 有 14 行 | 少一个迁移应当导致 api 报 `P2021` |
| 权限点完整 | `permissions` 表 21 行 | 少一个权限点会导致整组导航静默消失，零报错 |
| 服务健康 | `compose ps` 四个容器 healthy | 停掉 db 后 api 应转为 unhealthy |
| 端口仅回环 | `netstat` 只见 127.0.0.1:5432 / 8787 / 8080 | 若出现 0.0.0.0 即公网暴露 |
| 隧道出站 | 外网域名返回 200 且响应头有 etag | 断网后应返回 530 / 1033，而本地仍 200 |
| 数据恢复 | 恢复 dump 后 26 表行数与源一致 | 故意改一行再恢复，应被覆盖 |

**空卷是必要条件。** 在已有数据的卷上验收，会掩盖「迁移链缺环」这类问题，因为旧数据把表补齐了。

## 六、兼容性问题

| 风险 | 表现 | 应对 |
| --- | --- | --- |
| 盘符变化 | 换机后 `ws-compose.cmd` 找不到仓库 | 它用 `%~dp0` 定位，不写死盘符。工作区根靠 `.ws-root` 探测 |
| `--env-file` 遗漏 | 报 `required variable FANHE_JWT_SECRET is missing` | 必须经 `ws-compose.cmd`，它补这个参数 |
| `target` 遗漏 | api 反复重启、日志全是 `No pending migrations to apply` | compose 已显式写 `target`，改动时不要删 |
| 前端改动不生效 | 页面还是旧的 | 前端是构建产物，需 `build web` 加 `--force-recreate` |
| Docker 未启动 | `docker ps` 报 `cannot find the file specified` | 开工第一件事启动 Docker Desktop |
| Tunnel 掉线 | 本地全绿、外网 530 | 查宿主机 TUN 模式，确认 `TUNNEL_TRANSPORT_PROTOCOL=http2` |
| 跨平台行尾 | Windows 克隆后脚本报 `\r` 错误 | `.gitattributes` 已设 `text=auto`，Linux 侧注意 `core.autocrlf` |
| 架构差异 | Apple Silicon 上 `node:22-bookworm-slim` 为 arm64 | 镜像本身多架构可用，若出现原生模块问题加 `--platform linux/amd64` |

## 七、回滚方案

按影响面从大到小，三条路径。

**1. 数据回滚（最常用）**

```bash
node tools/checks/db-backup.mjs list
node tools/checks/db-backup.mjs restore fanhe-work-2026-10-30T06-33-53.dump --force
```

`restore` 默认拒绝覆盖，必须显式加 `--force`。这是有意的，恢复是唯一会主动破坏现有数据的操作。
缺 `--force` 时它会先打印源库与备份的行数对比，让人判断该不该做。

**2. 编排回滚**

```bash
../../infra/portable/ws-compose.cmd down          # 停容器，保留卷
git checkout -- projects/fanhe-work/docker-compose.yml
../../infra/portable/ws-compose.cmd up -d --wait
```

**绝不要 `down -v`。** 那个参数会连卷一起删，业务数据随即消失。需要重置库时用
`restore` 覆盖，不用删卷。

**3. 镜像回滚**

```bash
docker tag fanhe-work-api:latest fanhe-work-api:rollback
# 重新构建后若异常
docker tag fanhe-work-api:rollback fanhe-work-api:latest
../../infra/portable/ws-compose.cmd up -d --force-recreate api
```

镜像可从 git 任意提交重建，所以回滚的可靠做法是 `git checkout <commit>` 后重建，
而不是长期保留旧镜像。

## 八、待办

1. 决定是否实施 3.4 的字典表种子导出。
2. 清理 `t502-*` / `t503-*` 实验镜像与 47.74 MB 悬空卷，释放约 2.9 GB。
3. 若要在 GitHub 上跑 CI，用 Actions 做门禁与镜像构建，推 ghcr.io，部署仍留在宿主。
   参见 `docs/ops/GITHUB-DEPLOY-2026-10-21.md` 的路线 A。
