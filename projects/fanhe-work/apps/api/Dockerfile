# 没有 `# syntax=docker/dockerfile:1` 那一行。
#
# 它是为 `--mount=type=cache` 之类的实验特性准备的，用不上。而它有个实际代价：
# **BuildKit 会先去 docker.io 拉一个 `docker/dockerfile:1` 镜像**，而这一步与基础
# 镜像是两次独立拉取—— 网络不通时它会是第一个失败点，报错还指向 `# syntax` 那一行，
# 让人以为是 Dockerfile 写错了。
#
# api 的镜像。
#
# ## 为什么要多阶段
#
# 三个理由，按重要性排：
#
# 1. **产物只需要构建期依赖。** tsc、Prisma CLI、tsx 占了镜像里绝大部分体积，而
#    运行时只用到 `node` 与 `@prisma/client` 的产物。单阶段镜像会把它们全都带进
#    最终镜像 —— 一个几百 MB 的镜像在换机时拉取就是几分钟。
# 2. **构建工具链版本会漂。** 单阶段镜像里那个 tsc 是构建机装的版本，某天它变了而
#    代码没变，构建结果就变了。分阶段后构建环境被固定在镜像里。
# 3. **构建失败不该留下半个运行时。** 分阶段下构建失败就没有镜像，不会有「一个能
#    起来但行为不对」的状态。
#
# ## 为什么在容器里装全部依赖而不是只装运行时的
#
# pnpm 的 workspace 是硬链接的，只装一个包无法解析 `@fanhe/shared`。而 `--filter`
# 装出来的 `node_modules` 里是符号链接，指向 workspace 里的其他包 —— 那些包必须也在。
# 因此装依赖这一步没法只取一个包，只能全量（dev 依赖也装），**在构建阶段全量、
# 在运行阶段只 COPY 产物**，靠分阶段把体积压回来。

# ---- 构建阶段 -------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# pnpm 用 corepack 启用，不装全局 pnpm：版本由 package.json 的 packageManager 字段
# 固定，换机器构建出的镜像才一致。`--frozen-lockfile` 让 lockfile 与 package.json
# 不一致时直接失败，而不是悄悄改 lockfile 装出一份与本机不同的依赖树。
RUN corepack enable

WORKDIR /repo

# 先只 COPY 清单。依赖清单很少变、源码经常变 —— 这一层因此能在改代码时命中缓存，
# 而 `pnpm install` 那一步（最慢的一步）不必重跑。**这个顺序反过来就会每次全量装。**
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/desktop/package.json apps/desktop/
COPY apps/web/package.json apps/web/

# **必须禁用安装脚本。** 根 `package.json` 的 `postinstall` 调
# `apps/desktop/scripts/ensure-electron.mjs`（T4-01 加的，为把 Electron 二进制拉下来），
# 而容器里不COPY desktop 的脚本 —— 于是安装会以 `MODULE_NOT_FOUND` 失败。
#
# 两条路的取舍：补上那个文件（于是镜像构建时要下一个几百 MB 的 Electron，而服务端
# 根本用不到）vs 禁掉所有安装脚本（`--ignore-scripts`）。选后者，代价是要**自己**
# 补上真正需要的那个：Prisma 的引擎下载。
#
# 因此下面显式跑一次 `prisma generate`（`pnpm build` 里也有，但那时 schema 还没 COPY
# 进来），**不能靠 postinstall 顺带做**。
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --ignore-scripts

# 再 COPY 其余源码。构建顺序上 shared 必须在 api 之前：api 的类型检查与运行都
# 要它的 `dist`（它是构建型包，`main` 指向 `./dist/index.js`）。
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @fanhe/shared build \
 && pnpm --filter @fanhe/api exec prisma generate \
 && pnpm --filter @fanhe/api build

# ---- 运行阶段 -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini 做 PID 1：没有它，node 收不到 SIGTERM，`docker compose stop` 之后容器会
# 变成「已停止但进程还在」，而 db 那边会等着这个连接正常关闭而多等 10 秒。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

ENV NODE_ENV=production \
    # **容器内必须绑 0.0.0.0，不能用代码里的默认 127.0.0.1。** 那是「只让本机访问」
    # 的意思，而容器里的 127.0.0.1 指向容器自己，端口映射进来的请求永远到不了。
    # 换句话说：端口映射把请求送到容器的 eth0 上，而进程只听 loopback。
    HOST=0.0.0.0 \
    PORT=8787

# 运行时需要 node_modules（Prisma 客户端的运行时依赖）。**只取生产依赖**，
# 而工作区的 pnpm 布局是链接式的，所以连整个仓库的清单都要带上，否则解析不了。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/desktop/package.json apps/desktop/
COPY apps/web/package.json apps/web/

# **这里不构建 @fanhe/shared。** 它是构建型包（`main` 指向 `./dist/index.js`），
# 而构建它需要 typescript —— 那是 devDependency，被 `--prod` 排除，于是 `tsc: not found`。
#
# 两条路的取舍：把 typescript 装进运行镜像（为一个构建工具链付运行期体积）vs 从
# 构建阶段 COPY 已构建好的 dist。选后者 —— 同一份源码、同一份产物，不存在两处
# 构建结果不一致的可能。
#
# ## 已知限制：镜像里有约 150MB 用不上的 devDependency
#
# `--prod` 只影响链接到包的那部分，被间接引用到的 devDependency 仍留在
# `node_modules/.pnpm` 里（`@prisma/studio-core` 43MB 是 `db:studio` 的依赖、
# typescript 24MB 等），所以运行镜像约 594MB 而真正需要的大约 440MB。
#
# **试过 `pnpm prune --prod`，它会失败**：prune 本身触发 postinstall，而那个
# postinstall 调的是 desktop 的 `ensure-electron` 脚本（见上），此时不在镜像里。
# 要修得先给 prune 加 `--ignore-scripts`，而它在 workspace 下的语义本就模糊
# （可能连带删掉链接到 workspace 包的那些）。**594MB 对单用户部署完全可接受**，
# 因此记为已知限制而不是加一个会失败、语义又不确定的步骤。要压体积的话，
# 正路是给 api 与 desktop 拆 lockfile 作用域，那是另一笔的量。
RUN corepack enable \
 && pnpm install --frozen-lockfile --filter @fanhe/api... --prod --ignore-scripts

# 产物**从构建阶段 COPY，而不是从构建上下文取。** 这两者的区别很要紧：
# `.dockerignore` 里排除了 `**/dist`（本机的产物不进上下文，那是刻意的，见那份文件），
# 所以运行阶段 `COPY apps/api/dist` 会直接报 `not found`。正确形状是 `--from=build`。
#
# **Prisma 7 的客户端输出到 `apps/api/src/generated/prisma`**（schema 里自定义了
# `output`），不是默认的 `node_modules/.prisma`。那份 `.ts` 会被 tsc 一起编译进
# `dist/generated/prisma`，所以这里只要 dist —— 早期版本额外 COPY 了
# `node_modules/.prisma`，而那个路径在本项目的 Prisma 版本下根本不存在。
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
# prisma 目录要带上的是 **schema 与迁移**，不是生成产物：api 启动时要读 schema 才能
# 判断有无待应用的迁移，缺了它启动就失败。
COPY apps/api/prisma apps/api/prisma

# 以非 root 运行。api 不需要特权，而容器逃逸的门槛与容器内 uid 直接相关。
USER node

EXPOSE 8787

# 健康检查打在 `/api/` 上：这个路径不需要认证（否则健康检查会一直 401，
# 而「一直不健康」与「服务真的坏了」在编排层看起来一样）。
# 间隔 10 秒、start_period 给 30 秒：api 启动要跑迁移之外的初始化，且要等 db 健康，
# 太紧会反复失败。
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]

# ---- 迁移阶段（T5-02）----------------------------------------------------
#
# **为什么单独一个阶段，而不是让运行镜像带上 Prisma CLI。**
#
# 迁移必须有人执行，而 T5-01 把它漏掉了：换一台机器、卷是空的，`docker compose
# up -d --wait` 会一路绿到三个容器 healthy —— 因为 api 连得上库（**连接成功与
# 库里有表是两件事**），而库里 0 张表。症状要等到第一个请求打进来才出现，且是
# `P2021: The table public.xxx does not exist`，看起来像代码问题而不是部署问题。
#
# 两条路的取舍：运行镜像装 Prisma CLI（`prisma` 是 devDependency，为一个只在
# 部署时跑一次的命令给运行期加几十 MB）vs 单独一个基于 build 阶段的短命容器。
# 选后者 —— 迁移容器跑完就退出，它的体积不进任何长期运行的容器。
#
# **这个阶段刻意不做 `--prod` 安装**：它需要 Prisma CLI 与 tsx，而两者都是
# devDependency。它也不需要 `--ignore-scripts` 之外的妥协 —— 根 postinstall 的
# 那个 `ensure-electron` 在 build 阶段就被跳过了（见上），这里同样跳过。
FROM build AS migrate

WORKDIR /repo

ENV NODE_ENV=production \
    PRISMA_SKIP_POSTINSTALL_GENERATE=true

# `migrate deploy` 只读 schema 与迁移目录并建表，不需要类型化客户端，因此
# **不重跑 generate**（上面 build 阶段已经生成过，那份产物在这个阶段用不上，
# 而多跑一次要多等十几秒）。
#
# 命令选 `migrate deploy` 而不是 `migrate dev`：dev 会试图创建一个影子库来验证
# 迁移，那需要影子库所在的实例有建库权限，而部署环境通常不给。deploy 只应用
# 已有的迁移文件，正是部署该做的事。
#
# ## ⚠️ 这个阶段在文件末尾，而那本身是个陷阱
#
# **不写 `target` 的构建会停在最后一个 FROM**，也就是这个 `migrate`。于是任何
# 不显式指定 target 的服务都会拿到跑迁移的镜像 —— 症状是「api 容器反复重启，
# 日志里全是 `No pending migrations to apply`」，而 healthcheck 报 healthy
# （它在 `restart` 循环里被短暂满足）。
#
# 这个坑在 T5-01 时不存在，因为那时 `runtime` 恰好是最后一个阶段 —— **那是巧合，
# 不是设计**。所以 compose 里的 api 服务**必须**写 `target: runtime`。本行注释
# 就是为了下一个人别把它当默认值。
CMD ["pnpm", "--filter", "@fanhe/api", "exec", "prisma", "migrate", "deploy"]