# syntax=docker/dockerfile:1
#
# Steam 工具台 —— 容器里只跑 app/server.js（Web 服务本体）。
#
# 为什么不跑 launcher.js：launcher 是「自动更新 + 崩溃回滚」的桌面守护进程，
# 内部用 PowerShell 的 Expand-Archive 解压更新包（launcher.js:180-190），只能在 Windows 上工作。
# 容器里的版本更新由镜像 tag 承担，所以这里直接起 app/server.js。
# APP_ROOT 显式指向 /app，等价于 launcher 注入的「安装根」，data/ 与 .env 的解析路径不变。

# ---------- 依赖层 ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /build
# lzma-native 自带 linux-x64 / linux-arm64 的 NAPI 预编译（node_modules/lzma-native/prebuilds），
# 所以这里不需要 gcc / python / node-gyp。请勿换成 alpine：预编译产物是 glibc 的，
# 换 musl 会退化成现场源码编译。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- 运行层 ----------
FROM node:22-bookworm-slim

# 版本号由 docker/update.sh 从 docker/dist/VERSION 注入,用于 docker inspect 溯源。
ARG APP_VERSION=unknown
LABEL org.opencontainers.image.title="Steam 工具台" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/NoTimeber/steam-tools"

ENV NODE_ENV=production \
    APP_ROOT=/app \
    PORT=53110 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=deps --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node package.json ./
# app/ 内含 schema/（CS2/TF2 物品名与中文文案，约 25MB）与 public/ 前端资源，必须一起进镜像。
# 运行时不会写 app/ 下任何文件，只有 data/ 需要可写。
COPY --chown=node:node app ./app
# 当前镜像对应的发版号,由 docker/fetch-release.js 写进构建上下文。
COPY --chown=node:node VERSION ./VERSION

# 运行数据（sessions / mafile / cookies / uu token / auth.json / 各类缓存）全在 /app/data。
# 用 named volume 挂载到这里时，Docker 会继承本目录的属主，非 root 用户也能写。
RUN mkdir -p /app/data && chown node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 53110

# /api/health 是免鉴权的公开路由（见 app/lib/auth.js:205），无需额外安装 curl/wget。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 53110) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "app/server.js"]
