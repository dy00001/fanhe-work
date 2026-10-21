# 把本地 Docker 服务部署到 GitHub 的可行性、路线与边界

> 2026-10-21。对照现状：`docker-compose.yml` 五服务编排（db / migrate / api / web / cloudflared）、
> `apps/api/Dockerfile` 三阶段、`apps/web/Dockerfile` 两阶段、`apps/web/deploy/nginx.conf` 反代。
> 本文所有结论都指向这几个文件的具体改动，不做泛泛而谈。

## 一、结论先行

GitHub 本身没有可以长期运行容器的地方。它是四个东西的组合：代码托管、CI 执行器、容器镜像仓库、静态站托管。所以「把本地 Docker 服务器部署到 GitHub」这件事只有在一种拆法下成立：

**GitHub 负责构建、存镜像、触发发布；真正的运行位必须落在能跑容器的宿主上（自己的机器、云主机，或第三方容器平台）。**

如果诉求只是「让外网能稳定访问这套系统」，现状已经具备条件，因为 `cloudflared` 走的是出站连接，源站不需要公网入站端口。这种情况下把整套搬到 GitHub 的云上并不会让系统更可用，反而会引入新的失败点。

如果诉求是「让部署过程自动化、可回滚、有构建产物留痕」，GitHub 能覆盖其中约七成，剩下三成（运行位、持久卷、数据库）必须在宿主侧解决。

## 二、GitHub 各服务的实际承载能力

| 服务 | 能否承载常驻服务 | 在本项目里能承担的角色 | 关键限制 |
| --- | --- | --- | --- |
| GitHub Actions | 不能 | 跑门禁、构建两个镜像、推 GHCR、触发远端部署 | 单个 job 上限 6 小时，runner 用后销毁，无持久状态 |
| GHCR（容器镜像仓库） | 只存不算跑 | 存放 `api` 与 `web` 镜像，宿主 `docker pull` | 镜像名必须全小写；私有包拉取要凭据 |
| GitHub Pages | 不能 | 只能托管 `apps/web/dist` 的静态产物 | 无服务端，无真正的反向代理，`/api` 必须指向外部域名 |
| Codespaces | 能跑但不能当生产 | 临时演示、复现线上环境问题 | 空闲自动停止，转发域名随实例变化，有月度核心小时配额 |
| Releases | 不能 | 发布 Electron 安装包（现有发版链路） | 与服务端运行无关 |

配额方面，据 GitHub 文档，个人 Free 计划包含 Actions 每月 2000 分钟；Packages 私有存储 500MB 与每月 1GB 传输，但**容器镜像的存储与带宽目前单独声明为免费**，且文档注明政策变更会提前一个月通知。这意味着当前把 594MB 的 api 镜像推上去不会立刻触配额，但这条免费属于政策而非合同，值得记一笔。

## 三、三条可行路线

### 路线 A：本机继续当宿主，GitHub 做 CI 与发布（改动最小）

`cloudflared` 已经解决对外访问，运行位不需要搬家。GitHub 承担的部分：

1. push 到 `main` 触发四道门禁（`test` / `lint` / `typecheck` / `format:check`）。
2. 门禁通过后构建 `api` 与 `web` 镜像，打版本标签推到 GHCR。
3. 本机注册一个 self-hosted runner（或用一个部署专用 PAT），由 workflow 触发 `docker compose pull && up -d`。

需要新增或改动的文件：

- `.github/workflows/ci.yml`（目前仓库没有 `.github/` 目录）
- `docker-compose.prod.yml`：把 `build:` 换成 `image: ghcr.io/dy00001/fanhe-work-api:0.2.0`，`target:` 保留在构建侧
- 本机 runner 服务，或一个 `infra/portable/deploy.cmd`

优点：运行位、卷、数据全部不动，风险最低，一天内可落地。
缺点：可用性等于家里那台机器加网络。电脑关机、断网、重启，站点就没了。
适用：当前阶段（单用户、内部使用、数据量小）。

### 路线 B：整栈迁到一台能跑 Docker 的云主机，Tunnel 复用（推荐用于真正上线）

一台 2C4G 的 VPS 就够跑现有五个服务。`cloudflared` 原样复用，域名与证书都不用改，因为 Tunnel 是出站连接，与宿主 IP 无关。

- 宿主只暴露 22（或干脆只留平台的控制台通道），不映射 80/443。
- 镜像从 GHCR 拉，`compose` 里 `build` 全部换成 `image`。
- `pgdata` 卷落在宿主磁盘，配 `pg_dump` 每日备份到对象存储。
- 部署由 Actions 通过 SSH 触发，或由宿主上的 runner 拉取。

优点：可用性与家宽解耦，域名不变，改动集中在 compose 与一份 workflow。
缺点：多一台机器要维护，备份要自己做，数据库仍是单实例。
适用：需要 7×24 可访问、但规模仍是单租户。

### 路线 C：拆成平台服务，数据库换托管（改动最大）

把 `api` 与 `web` 拆成两个平台服务（Fly.io、Render、Railway 一类），PostgreSQL 用平台托管或 Neon/Supabase。

这条路线会触碰三处结构性假设：

1. **nginx 反代失去意义**。平台自己路由，`api_upstream` 指向 compose 服务名 `api` 的写法失效，前端要么与 api 同域由平台网关聚合，要么跨域并处理 CORS 与 Cookie 的 `SameSite`。
2. **迁移的执行者要换**。`migrate` 作为一次性服务、靠 `service_completed_successfully` 卡住 `api` 的这套保证，在平台上没有对应物，得改成平台的 release command，或者由 `api` 启动时串行执行。
3. **果实是托管库的排序规则与 TLS**。现编排用 `--icu-locale=zh-CN` 建库，托管 PG 通常不给你改这个，中文姓名的 `ORDER BY` 会退化为码位序。同时 `PGSSLMODE: disable` 必须改成 `require`，否则连不上。

优点：托管库有备份与高可用，扩缩容有现成路径。
缺点：改动跨代码与编排两侧，验收面最大。建议等路线 B 稳定运行一段时间后再评估。

## 四、逐项配置调整

### 4.1 端口

| 服务 | 容器内 | 本地宿主 | 远程建议 |
| --- | --- | --- | --- |
| web（nginx） | 80 | `127.0.0.1:8080` | 平台注入的 `$PORT`，或由反代/隧道终结 TLS |
| api | 8787 | `127.0.0.1:8787` | 不对公网映射，只在内网可达 |
| db | 5432 | `127.0.0.1:5432` | 完全不映射，或只绑私网网卡 |
| cloudflared | 无 | 无 | 无 |

三处要点：

- `HOST=127.0.0.1` 与 `HOST=0.0.0.0` 的差别在容器里是「谁都连不上」与「连得上」。现 Dockerfile 的 `ENV HOST=0.0.0.0` 已经写对，迁移时别丢。
- 本地绑 `127.0.0.1` 防的是局域网，远程环境下这条防护自动失效，暴露面变成平台公网入口。两者是不同层面的防护，验收要分别做。
- nginx 的 `listen 80` 是写死的。若平台要求监听 `$PORT`，需要在启动时用 `envsubst` 渲染模板，或让平台的网关做 TLS 终结后再转发到 80。

### 4.2 镜像与构建

- 镜像名必须全小写。`ghcr.io/dy00001/fanhe-work-api` 合规。
- 标签用版本号（与仓库根 `package.json` 的 `version` 对齐），`latest` 只做别名。回滚靠改标签，不靠改代码。
- `target:` 不能省。api 的 `migrate` 阶段在文件末尾，不写 `target` 就停在那一阶段，症状是 api 反复重启、日志全是 `No pending migrations to apply`、healthcheck 却报 healthy。
- GHCR 私有镜像在宿主上拉取需要 `read:packages` 凭据，用 fine-grained PAT 或 deploy token，写进宿主的 `docker login` 而非仓库。
- 镜像里安装依赖用了 `--ignore-scripts`，Actions 侧构建不受影响，但要注意 Actions 的 runner 本身不能缓存 pnpm store 之外的层，首次构建会重新拉基础镜像，耗时以分钟计。

### 4.3 持久化

命名卷 `fanhe-work-pgdata` 在本机就是一个目录，换到远程后有三条路：

1. **宿主本地卷**（推荐在路线 B）：就是现在这份 compose，什么都不改。备份责任在自己，`pg_dump` 加定时任务。
2. **平台挂载卷**（路线 C）：Fly 的 volumes 绑定可用区，Render 的 disk 绑定单实例，扩容时不能跨节点共享。
3. **托管 PG**：`DATABASE_URL` 指向外部串，`PGSSLMODE` 改为 `require`，编排里的 `db` 与 `migrate` 服务同时删掉，迁移改由平台 release command 执行。

一个容易忽略的点：`api` 容器是 `USER node`，若挂载宿主目录做卷，宿主的 uid 与容器内 uid 不一致会导致权限报错，表现为启动即退出且日志只有一行 `EACCES`。

### 4.4 环境变量与密钥

| 变量 | 本地来源 | 远程来源 | 是否可跨环境复用 |
| --- | --- | --- | --- |
| `FANHE_JWT_SECRET` | `.env.compose` | 平台环境变量 / Actions secret | 不可，每个环境一份 |
| `FANHE_TUNNEL_TOKEN` | `.env.compose` | 宿主 `.env` 或平台 secret | 可，同一 Tunnel 通用 |
| `OPS_INGEST_TOKEN` | `.env.compose` | 平台环境变量 | 可，但采集机要同步改 |
| `DATABASE_URL` | compose 锚点 | 平台环境变量 | 不可，随库变 |

三条必须说清的机制：

- **Actions 的 secrets 只在 workflow 进程里可见，不会自动进入运行中的容器。** 运行期变量必须由宿主平台注入，这是最常见的误解。把 secret 写进 workflow 却不落到宿主，结果是容器启动时 `JWT_SECRET` 为空。
- `JWT_SECRET: ${FANHE_JWT_SECRET:?...}` 的 `:?` 会让缺值时 compose 直接拒绝启动。这个行为是正确的，但报错文案指向 `.env.compose`，远程环境下那个文件不存在，接手的人会照着文案找一个不存在的文件。
- `OPS_INGEST_TOKEN` 刻意不给默认值也不加 `:?`，缺值时接口返回 503 而页面照常。这个设计在远程环境下依然成立，别顺手改成强制。

### 4.5 反向代理与采集入口（本项目专属的两处硬伤）

**其一，`proxy_pass` 指向 compose 服务名。** `nginx.conf` 里 `api_upstream` 解析的是容器网络里的 `api`。一旦 api 与 web 不在同一个 compose 网络（路线 C），这里必须改成具体地址，否则 nginx 启动即 `host not found in upstream`。

**其二，采集入口的回环校验在远程必然 403。** `apps/api/src/routes/ops.ts:238` 用 `isLoopbackAddress(request.ip)` 判断来源，非回环直接返回 `403 forbidden_origin`。采集机在本地，一旦 api 上云，请求源地址变成公网 IP，这条判断会拦掉全部写入。

可选的改法，按安全强度排序：

1. 采集机与 api 之间走 Tunnel 或 WireGuard，让流量在 api 侧看起来来自私网地址，同时把判据扩展到 RFC1918 网段。
2. 保留 `x-ops-token` 作为唯一凭据，去掉回环判断，补上限流与失败审计。
3. 加一层专用入口（独立端口或独立路径），只允许 token 加 IP 允许列表。

第一条改动最小且不降低安全性，只是把「回环」换成「私网」。

### 4.6 迁移与种子

`migrate` 服务同时做 `prisma migrate deploy` 和 `db:seed`，两者用 `&&` 串联，任一失败即非零退出，从而挡住 api 启动。这套语义在路线 A 与 B 完整保留。到了路线 C 必须显式重建，否则会出现「表建好了但权限表是空的」这种状态，症状是初始化向导返回 500，提示「库里没有 owner 角色」。

## 五、前提条件清单

动工前逐条确认，缺一条都会在部署当天以难以归因的方式暴露：

- [ ] 仓库能推（远端 `dy00001/fanhe-work`），且 Actions 对仓库启用
- [ ] `apps/api/Dockerfile` 与 `apps/web/Dockerfile` 都能在干净环境构建（不依赖 `node_modules`、不依赖 `.env`）
- [ ] `target:` 在 compose 里显式声明
- [ ] `.dockerignore` 生效（`node_modules`、`**/dist`、`.env` 都不进上下文）
- [ ] 三个密钥已生成并落到目标环境的变量系统，不与本机共用
- [ ] 运行位选好，且能拉私有镜像（凭据已在宿主 `docker login`）
- [ ] 迁移执行者明确（compose 一次性服务 / 平台 release command / 手动）
- [ ] 备份方案（`pg_dump` 目标与保留期）
- [ ] 采集链路的上游地址与来源判据已按 4.5 调整
- [ ] 首次部署准备在**全新空卷**上跑，这是唯一能验出「空卷到可用」这条链的方式

## 六、本地与远程的主要差异

按「出问题的概率」排序：

1. **生命周期**。本机 `docker compose up -d` 是人触发的；远程靠平台调度。现编排的 `restart: unless-stopped` 与 healthcheck 已经写了，迁移后行为基本一致，但平台可能在容器健康之前就判定部署成功，验收要以第一个真实请求为准。
2. **网络可见性**。本机绑回环是一道防护，远程没有这道防护的等价物。公网入口一旦打开，`api` 就可能被直接扫描到，除非只让 Tunnel 出站。
3. **存储可靠性**。本机卷与机器同生共死，反而不会出现「卷在 A 可用区、容器调度到 B」的问题。平台卷有这类失败模式。
4. **配置注入**。`.env` 文件变成环境变量系统，改一个值要重新部署容器才生效。
5. **数据库区域与排序规则**。`--icu-locale=zh-CN` 是建库时定死的。托管 PG 如果给的是 `C` 或 `en_US.UTF-8`，中文姓名列表的排序会变。判据是插两条中文姓名做 `ORDER BY` 对比，别靠猜。
6. **TLS 与头信息**。本地 nginx 后面没有 TLS，远程一定有。`Secure` Cookie、`X-Forwarded-Proto`、跨域重定向都可能因此行为改变。
7. **构建缓存与速率**。远程构建没有本机层缓存，首次构建时间以分钟计；基础镜像拉取受 registry 速率限制。
8. **成本与配额**。本机零边际成本，远程按小时计费，Actions 有分钟配额，Codespaces 有核心小时配额。

## 七、GitHub 侧的硬限制

1. Actions 的单个 job 最长 6 小时，超过即终止，所以它当不了长驻服务的宿主。
2. Actions runner 是一次性环境，job 结束即销毁，没有可用的持久磁盘。
3. Pages 只解析静态文件与有限的重定向、头配置，无法执行 Node 进程，也无法把 `/api` 反代到别处。
4. Codespaces 有空闲超时与配额，转发出的 URL 带实例前缀，重启即变，只适合演示。
5. GitHub 不提供托管数据库，也不提供持久块存储。
6. 私有仓库的 Actions 分钟数计入配额，公开仓库的 Actions 分钟数免费。这条对私有的 `fanhe-work` 是实际约束。
7. GHCR 的容器镜像存储与带宽当前免费，属于政策承诺而非计费合同。

## 八、建议的落地顺序

1. 先做路线 A 的第一段：只加 CI 门禁，不碰部署。收益是每次 push 都有四道门禁跑一遍，风险为零。
2. 再加镜像构建与推 GHCR，仍然不改运行位。此时可以在本机用 `docker compose pull` 验证「从镜像仓拉到可运行」这条链。
3. 本机接入 self-hosted runner 或部署脚本，把部署自动化。这一步结束，路线 A 闭环。
4. 评估是否要 7×24 可用。要，就走路线 B，把整栈搬上 VPS，Tunnel 复用，域名不变。
5. 路线 C 留到单店假设拆除、多店数据进来之后再考虑，因为托管库的排序规则与迁移执行者这两件事都要在那之前定下来。

## 参考来源

- GitHub Docs，GitHub Packages billing（私有包配额与容器镜像免费的说明）：https://docs.github.com/en/billing/managing-billing-for-github-packages
- GitHub Docs，每个计划中包含的产品使用量（Actions 分钟数、Codespaces 配额）：https://docs.github.com/zh/billing/reference/product-usage-included
- GitHub Docs，Publishing Docker images（GHCR 登录与 build-push 流程）：https://docs.github.com/en/actions/publishing-packages/publishing-docker-images
