# 没有 `# syntax=` 那一行，理由与 api 镜像那份一样：它会多触发一次 docker.io 拉取，
# 而这里没用到它带来的任何特性。
#
# web 的镜像。
#
# ## 结构与 api 镜像不同：只有一个阶段
#
# web 没有「构建」与「运行」的区分 —— 产物是一堆静态文件，交给 nginx 读就完了。
# 真正需要留在镜像里的只有三样：nginx 本身、`dist` 产物、反代配置。
# 构建工具链（vite、tsc）只在构建期用一次，所以**构建在宿主机的 builder 镜像里完成**，
# 最终镜像只有 nginx + 静态文件 —— 比 api 镜像还小。

# ---- 构建阶段 -------------------------------------------------------------
FROM node:22-bookworm-slim AS build

RUN corepack enable

WORKDIR /repo

# 清单先COPY，与 api 镜像同理由：依赖层要在改源码时保持命中。
# 注意 web 的构建要 `@fanhe/shared` 的类型（`pnpm build` 里先跑 tsc），所以它也在。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/desktop/package.json apps/desktop/
COPY apps/web/package.json apps/web/

# 同样禁用安装脚本：根 postinstall 调的是 desktop 的 ensure-electron 脚本，
# 容器里没有那个文件（也不该有——web 镜像不需要 Electron）。理由与取舍见 api 那份。
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages/shared packages/shared
COPY apps/web apps/web

# `pnpm build` 内部是 `tsc --noEmit && vite build`：类型不过就没有产物，
# 这正是我们要的 —— 镜像里的东西必须是编译通过的版本。
RUN pnpm --filter @fanhe/shared build \
 && pnpm --filter @fanhe/web build

# ---- 运行阶段 -------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# 覆盖默认站点配置。nginx 镜像自带的 default.conf 监听 80 且指向它自己的
# 欢迎页，不换掉的话容器能起来但返回的是 nginx 欢迎页 —— 表现为「web 起来了，
# 页面却不对」，很容易被误判成构建问题。
# **路径相对构建上下文根，不是相对这个 Dockerfile。** 构建上下文是仓库根
# （见 docker-compose.yml 里的 `context: .`），所以这里要写 `apps/web/deploy/...`。
# 写成 `deploy/nginx.conf` 会报 `"/deploy/nginx.conf": not found` —— 而那句报错
# 出现在校验阶段，早于任何 COPY 执行，容易被当成文件缺失而不是路径写错。
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/web/deploy/nginx.conf /etc/nginx/conf.d/app.conf

# 用 root 起 nginx 的原因很实际：nginx 官方镜像的主进程要**写** `/var/cache/nginx`
# 与 `/var/run`，而那个目录属于 root，非 root 起会直接启动失败。子进程降权由
# nginx 自己的配置负责（`worker_processes` 与 worker 段的 `user`）。
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=4s --retries=6 --start-period=10s \
  CMD wget --spider -q http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]