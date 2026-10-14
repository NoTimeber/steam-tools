# syntax=docker/dockerfile:1

# ---- 依赖层:唯一的原生模块 lzma-native 自带 linux-x64 预编译包,不需要编译工具 ----
# (它 8.0.6 版里的 linux-arm64 预编译文件其实是 x86-64 的,arm64 上会退回源码编译而失败,所以只支持 amd64)
FROM node:24-bookworm-slim AS deps
WORKDIR /srv/steam-tools
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- 新版前端(web/,Vue 3 + Naive UI):构建出静态文件,运行层只要 web/dist ----
# 产物和平台无关,多平台构建时只在构建机的原生平台上跑一次,不经 QEMU 模拟
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS web
WORKDIR /srv/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 运行层 ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
	TZ=Asia/Shanghai \
	APP_ROOT=/srv/steam-tools \
	DATA_DIR=/data \
	MASTER_KEY_FILE=/run/secrets/master_key \
	HOST=0.0.0.0 \
	PORT=53110
RUN apt-get update \
	&& apt-get install -y --no-install-recommends tzdata \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data \
	&& chown node:node /data
WORKDIR /srv/steam-tools
COPY --from=deps /srv/steam-tools/node_modules ./node_modules
COPY package.json ./
COPY app ./app
# 新代码是 TypeScript,Node 24 直接运行(类型擦除),不需要构建步骤
COPY src ./src
COPY --from=web /srv/web/dist ./web/dist

# 以非 root 运行;/data 挂卷存放账号、maFile、session、UU token 等全部运行数据
USER node
VOLUME ["/data"]
EXPOSE 53110
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||53110)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 镜像由 GitHub Actions 在发版时构建(.github/workflows/image.yml);服务器上 docker compose pull 拉新镜像(面板只提示有新版)
CMD ["node", "src/main.ts"]
