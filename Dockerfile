# syntax=docker/dockerfile:1

# ---- 依赖层:唯一的原生模块 lzma-native 自带 linux-x64/arm64 预编译包,不需要编译工具 ----
FROM node:24-bookworm-slim AS deps
WORKDIR /srv/steam-tools
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

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

# 以非 root 运行;/data 挂卷存放账号、maFile、session、UU token 等全部运行数据
USER node
VOLUME ["/data"]
EXPOSE 53110
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||53110)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接跑 server.js;旧版 launcher 的自更新在容器里不用,更新走重新构建镜像
CMD ["node", "app/server.js"]
