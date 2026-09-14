#!/usr/bin/env bash
#
# 一条命令更新线上服务:拉发布包 → 构建镜像 → 重启容器。
#
#   bash docker/update.sh                  # 拉 GitHub 最新发布
#   bash docker/update.sh --local release  # 用本地 release/ 目录(离线;适合先本地验证)
#   bash docker/update.sh --source         # 用仓库里的 app/ 直接构建(开发用,跳过验签解密)
#
# 参数会原样透传给 docker/fetch-release.js。
# 需要:Node.js(只用来拉包/验签/解密,不参与运行)、docker compose、
#       以及 public-key.pem + update-key.bin(.env 里配 GITHUB_REPO)。

set -euo pipefail

cd "$(dirname "$0")/.."

# 拉包/验签/解密需要 JS 运行时。服务器上没装 Node.js 也能跑:借用 node:22 容器。
fetch_release() {
	if command -v node >/dev/null 2>&1; then
		node docker/fetch-release.js "$@"
	else
		echo "==> 本机没有 Node.js,改用 node:22 容器执行拉包/解密"
		docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/repo -w /repo \
			node:22-bookworm-slim node docker/fetch-release.js "$@"
	fi
}
command -v docker >/dev/null 2>&1 || { echo "[错误] 找不到 docker" >&2; exit 1; }

# 可选:给 docker compose 追加全局参数,例 COMPOSE_ARGS="--profile proxy" bash docker/update.sh
COMPOSE_ARGS="${COMPOSE_ARGS:-}"

echo "==> 生成构建上下文"
fetch_release "$@"

APP_VERSION="$(tr -d '[:space:]' < docker/dist/VERSION)"
[ -n "$APP_VERSION" ] || { echo "[错误] 读不到 docker/dist/VERSION" >&2; exit 1; }
export APP_VERSION

echo "==> 构建镜像 steam-tools:${APP_VERSION}"
# shellcheck disable=SC2086  # COMPOSE_ARGS 需要按词拆分
docker compose ${COMPOSE_ARGS} build app

echo "==> 重启容器"
# 只动 app:caddy 不在 proxy profile 里就不会被牵连,已经在跑的 Caddy 也不受影响。
docker compose ${COMPOSE_ARGS} up -d app

echo "==> 清理旧镜像(保留当前版本)"
docker images --format '{{.Repository}}:{{.Tag}}' steam-tools 2>/dev/null \
	| grep -v ":${APP_VERSION}\$" \
	| xargs -r -n1 docker rmi 2>/dev/null || true

# docker/dist 里是解密后的源码副本,留在服务器上没问题(服务器本来就要能访问密钥),
# 但如果不想留,取消下面这行的注释:
# rm -rf docker/dist

echo
echo "已更新到 ${APP_VERSION}"
docker compose ps app
