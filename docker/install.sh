#!/usr/bin/env bash
#
# Steam 工具台 —— 服务器一键部署 / 更新
#
#   bash docker/install.sh --help        看全部参数
#
# 首次部署(全新 VPS):
#   1) 先在本地把解密密钥传上去(它绝不进仓库,所以只能手动一趟):
#        ssh user@server 'mkdir -p /srv/steam-tools'
#        scp update-key.bin user@server:/srv/steam-tools/
#   2) 服务器上跑:
#        curl -fsSL https://raw.githubusercontent.com/NoTimeber/steam-tools/main/docker/install.sh \
#          | bash -s -- --domain tools.example.com --password '你的强口令'
#
# 之后每次更新(服务器上,一条命令;骨架会顺带刷新到最新):
#   cd /srv/steam-tools && bash docker/install.sh
#
# 做的四件事:
#   1. 把部署骨架从仓库 main 同步到安装目录(compose/Dockerfile/Caddyfile/fetch-release.js ...)
#   2. 缺 Docker 就装(get.docker.com 官方脚本)
#   3. 生成/补齐 .env(GITHUB_REPO、DOMAIN、COOKIE_SECURE、APP_PASSWORD),校验 update-key.bin
#   4. 调 docker/update.sh:拉 GitHub latest 发布 → 验签 → 校验 sha256 → AES 解密 → 构建镜像 → 重启容器
#
# 本脚本刻意不搬运 update-key.bin(不走参数、不走 URL),只检测它是否存在:
# 密钥一旦进过 shell history / 进程参数 / 镜像层,加密发布的意义就没了。

set -euo pipefail

REPO_DEFAULT="NoTimeber/steam-tools"
SKELETON_REF="main"
RAW_HOST="https://raw.githubusercontent.com"

ROOT="/srv/steam-tools"
ROOT_EXPLICIT=0
REPO="$REPO_DEFAULT"
DOMAIN=""
PASSWORD=""
KEY_FILE=""
WITH_CADDY="auto"
SYNC=1
INSTALL_DOCKER=1
PREFIX=""
UPDATE_ARGS=()
ORIG_ARGS=("$@")

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[警告]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<-'EOF'
	用法: bash docker/install.sh [选项]

	安装位置
	  --dir DIR            安装目录(默认 /srv/steam-tools)
	  --ref BRANCH|TAG     骨架取哪个分支/标签(默认 main)
	  --prefix URL         骨架下载加速前缀,拼在 raw.githubusercontent.com 之前
	                       (国内墙 raw 时用,如 --prefix https://ghproxy.com/)

	站点
	  --domain DOMAIN      域名。给了就顺带起 Caddy 自动签 HTTPS 证书
	  --password PASS       APP_PASSWORD 初始口令;不给则首次打开 /login 自己设
	  --no-caddy           不起 Caddy(自己配 Nginx 等)
	  --no-sync            不刷新骨架文件(改动过 compose/Caddyfile 时用)

	密钥与更新
	  --repo owner/repo    覆盖 GITHUB_REPO(默认 NoTimeber/steam-tools)
	  --key PATH           update-key.bin 位置(默认 <dir>/update-key.bin)
	  --no-install-docker  缺 Docker 时只报错,不自动安装
	  --source             透传给 update.sh:用本地 app/ 构建(开发用)
	  --local DIR          透传给 update.sh:用本地 release/ 目录构建(离线验证)

	  -h, --help           显示本帮助

	例:
	  # 全新服务器(密钥先 scp 上去)
	  curl -fsSL https://raw.githubusercontent.com/NoTimeber/steam-tools/main/docker/install.sh \
	    | bash -s -- --domain tools.example.com --password '强口令'

	  # 发版后更新线上
	  cd /srv/steam-tools && bash docker/install.sh

	  # 先在服务器上试跑本地包,确认再 gh release create
	  bash docker/install.sh --local release
	EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dir)               ROOT="${2:?--dir 需要目录}"; ROOT_EXPLICIT=1; shift 2 ;;
		--ref)               SKELETON_REF="${2:?--ref 需要分支名}"; shift 2 ;;
		--prefix)            PREFIX="${2:?--prefix 需要 URL}"; shift 2 ;;
		--domain)            DOMAIN="${2:?--domain 需要域名}"; shift 2 ;;
		--password)          PASSWORD="${2:?--password 需要口令}"; shift 2 ;;
		--repo)              REPO="${2:?--repo 需要 owner/repo}"; shift 2 ;;
		--key)               KEY_FILE="${2:?--key 需要路径}"; shift 2 ;;
		--no-caddy)          WITH_CADDY=0; shift ;;
		--no-sync)           SYNC=0; shift ;;
		--no-install-docker) INSTALL_DOCKER=0; shift ;;
		--source)            UPDATE_ARGS+=(--source); shift ;;
		--local)             UPDATE_ARGS+=(--local "${2:?--local 需要目录}"); shift 2 ;;
		-h|--help)           usage; exit 0 ;;
		*)                   usage >&2; die "未知参数: $1" ;;
	esac
done

# ---- 自己是谁:能定位到本地文件就是 git 检出,否则是 curl|bash ----
SELF_DIR=""
SRC_ROOT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
	SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	_cand="$(cd "$SELF_DIR/.." && pwd)"
	if [ -f "$_cand/docker/fetch-release.js" ]; then SRC_ROOT="$_cand"; fi
fi
# 在 git 检出里直接跑(且没指定 --dir)就装到检出里,别莫名其妙去动 /srv。
if [ "$ROOT_EXPLICIT" = 0 ] && [ -n "$SRC_ROOT" ]; then
	ROOT="$SRC_ROOT"
fi
ROOT="$(mkdir -p "$ROOT" && cd "$ROOT" && pwd)"

command -v curl >/dev/null 2>&1 || die "找不到 curl"

# ============================ 1. 骨架同步 ============================
# 只带「运行必须」的文件。app/ 源码不在其中:它由发布包提供,仓库里没有也不必。
SKELETON_FILES=(
	Dockerfile
	docker-compose.yml
	Caddyfile
	.dockerignore
	.env.example
	public-key.pem
	package.json
	package-lock.json
	docker/install.sh
	docker/update.sh
	docker/fetch-release.js
)

fetch_skeleton_file() {
	local rel="$1" dst="$2" url tmp
	url="${PREFIX}${RAW_HOST}/${REPO}/${SKELETON_REF}/${rel}"
	tmp="$dst.tmp.$$"
	mkdir -p "$(dirname "$dst")"
	log "下载 $rel"
	curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 "$url" -o "$tmp" \
		|| { rm -f "$tmp"; die "下载失败: $url
    仓库名/分支不对,或 raw.githubusercontent.com 被墙(--prefix https://ghproxy.com/ 走加速)"; }
	mv -f "$tmp" "$dst"
}

sync_skeleton() {
	local rel dst src
	if [ -n "$SRC_ROOT" ] && [ "$SRC_ROOT" = "$ROOT" ]; then
		log "骨架已就位($ROOT),跳过同步"
		return 0
	fi
	for rel in "${SKELETON_FILES[@]}"; do
		dst="$ROOT/$rel"
		if [ -n "$SRC_ROOT" ]; then
			src="$SRC_ROOT/$rel"
			[ -f "$src" ] || { warn "本地缺 $rel,跳过"; continue; }
			mkdir -p "$(dirname "$dst")"
			cp -f "$src" "$dst"
		else
			fetch_skeleton_file "$rel" "$dst"
		fi
	done
}

if [ "$SYNC" = 1 ]; then
	log "同步部署骨架 → $ROOT"
	sync_skeleton
else
	log "跳过骨架同步(--no-sync)"
fi

for _f in docker-compose.yml Dockerfile docker/update.sh docker/fetch-release.js .env.example; do
	[ -f "$ROOT/$_f" ] || die "骨架不完整,缺 $ROOT/$_f(去掉 --no-sync 重跑,或检查 --dir)"
done

# --source 只有 git 检出里才成立(源码在 app/)。服务器上没有 app/,
# 撞上去只会得到 fetch-release 里一句「仓库里的 app/server.js 不存在」,不如提前说清楚。
case " ${UPDATE_ARGS[*]-} " in
	*" --source "*)
		[ -f "$ROOT/app/server.js" ] || die "--source 需要 $ROOT/app/server.js(源码只在 git 检出里)。
    服务器上更新请直接跑:bash $ROOT/docker/install.sh" ;;
esac
# ============================ 2. 解密密钥 ============================
KEY_FILE="${KEY_FILE:-$ROOT/update-key.bin}"
if [ ! -f "$KEY_FILE" ]; then
	cat >&2 <<-EOF

	[错误] 找不到解密密钥: $KEY_FILE

	update-key.bin 是解开 GitHub 发布包的 AES-256-GCM 密钥,绝不能进公开仓库,
	所以只能手动传一次(在**本地开发机**上执行,不是服务器):

	    ssh $(whoami)@<服务器> 'mkdir -p $ROOT'
	    scp update-key.bin $(whoami)@<服务器>:$ROOT/
	    ssh $(whoami)@<服务器> 'chmod 600 $ROOT/update-key.bin'

	传完在这台服务器上重跑本脚本即可。密钥也可用 --key <路径> 指定别处。

	EOF
	exit 1
fi
if [ "$KEY_FILE" != "$ROOT/update-key.bin" ]; then
	log "把密钥复制到 $ROOT/update-key.bin"
	cp -f "$KEY_FILE" "$ROOT/update-key.bin"
fi
chmod 600 "$ROOT/update-key.bin" 2>/dev/null || true
# 32 字节 = AES-256 单密钥。长度不对就别等到解密时才炸。
_key_len="$(wc -c < "$ROOT/update-key.bin" | tr -d ' ')"
[ "$_key_len" = 32 ] || die "update-key.bin 必须是 32 字节,实为 $_key_len —— 文件传错或传坏了"
[ -f "$ROOT/public-key.pem" ] || die "缺 public-key.pem(验签用),骨架没同步成功"

# ============================ 3. Docker ============================
ensure_docker() {
	if command -v docker >/dev/null 2>&1; then
		docker info >/dev/null 2>&1 && return 0
		# daemon 只是没起(重装后常见)
		if [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null 2>&1; then
			systemctl start docker >/dev/null 2>&1 || true
			docker info >/dev/null 2>&1 && return 0
		fi
		# 装是装了,但当前用户不在 docker 组 —— 用 sudo 把整个脚本重跑一遍,
		# 免得后面 update.sh 里每一句 docker 命令都失败。
		if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
			log "当前用户不在 docker 组,改用 sudo 重新执行本脚本"
			if [ -n "$SELF_DIR" ]; then
				exec sudo bash "$SELF_DIR/install.sh" "${ORIG_ARGS[@]}"
			fi
			exec sudo bash -c "$(curl -fsSL "${PREFIX}${RAW_HOST}/${REPO}/${SKELETON_REF}/docker/install.sh")" -- "${ORIG_ARGS[@]}"
		fi
		die "Docker 已安装但当前用户用不了:
    sudo usermod -aG docker $(whoami) && newgrp docker    # 然后重登
    或直接: sudo bash $ROOT/docker/install.sh"
	fi

	[ "$INSTALL_DOCKER" = 1 ] || die "服务器上没装 Docker。装好再跑,或去掉 --no-install-docker 让本脚本装:
    curl -fsSL https://get.docker.com | sh"
	[ "$(id -u)" = 0 ] || die "自动装 Docker 需要 root: sudo bash $ROOT/docker/install.sh"
	log "安装 Docker(官方 get.docker.com 脚本)"
	curl -fsSL https://get.docker.com | sh
	command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
	docker info >/dev/null 2>&1 || die "Docker 装完起不来,看 systemctl status docker"
}

log "检查 Docker"
ensure_docker
docker compose version >/dev/null 2>&1 || die "缺 docker compose v2 插件:
    Debian/Ubuntu: sudo apt-get install -y docker-compose-plugin
    其他: https://docs.docker.com/compose/install/linux/"

# ============================ 4. .env ============================
# 与 compose 的 env_file 是同一个文件:compose 用它做 ${DOMAIN} 插值,
# fetch-release.js / app/server.js 用 process.loadEnvFile 读它。
#
# 值的写法必须同时骗过两个解析器(Node 的 --env-file 与 compose 的 dotenv),实测差异:
#   裸值  x#y      → Node 解析成 x        (# 被当注释截断)
#   双引号 "x\"y"    → Node 解析成 x\       (双引号内不处理 \" 转义)
#   单引号 'x"y#z w' → Node 解析成 x"y#z w   (原样保留,两边行为一致)
# 所以:安全字符集内裸写,否则用单引号 —— 绝不写双引号+反斜杠那种写法。

encode_env_value() {
	local v="$1"
	case "$v" in
		*$'\n'*|*$'\r'*) return 1 ;;           # .env 一行一个值,换行没法表达
		*"'"*) return 1 ;;                       # 值里有单引号:单引号包不住,裸写各家行为又不一致,只能拒绝
	esac
	case "$v" in
		*[!A-Za-z0-9._:/@%+,=~^-]*) printf "'%s'" "$v" ;;   # 有空格/#/"/\ 等 → 单引号
		*) printf '%s' "$v" ;;
	esac
}

write_env_line() {
	local key="$1" encoded="$2" file="$3" tmp found=0 line
	tmp="$file.tmp.$$"
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
			"$key="*|"# $key="*|"#$key="*|"#  $key="*)
				if [ "$found" = 0 ]; then
					printf '%s=%s\n' "$key" "$encoded" >> "$tmp"
					found=1
				fi ;;
			*) printf '%s\n' "$line" >> "$tmp" ;;
		esac
	done < "$file"
	[ "$found" = 1 ] || printf '%s=%s\n' "$key" "$encoded" >> "$tmp"
	mv -f "$tmp" "$file"
}

# 值没法安全表达时返回 1,交给调用方决定是「报错」还是「跳过并警告」。
try_set_env() {
	local key="$1" val="$2" file="$3" encoded
	encoded="$(encode_env_value "$val")" || return 1
	write_env_line "$key" "$encoded" "$file"
}

set_env() {
	try_set_env "$@" || die "$1 的值写不进 .env(含换行或单引号),请换一个值"
}

ENV_FILE="$ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
	[ -f "$ROOT/.env.example" ] || die "缺 $ROOT/.env.example,骨架没同步成功"
	cp "$ROOT/.env.example" "$ENV_FILE"
	chmod 600 "$ENV_FILE"
	log "生成 $ENV_FILE(基于 .env.example)"
else
	log "沿用已有 $ENV_FILE"
fi

set_env GITHUB_REPO "$REPO" "$ENV_FILE"
# 经 HTTPS 反代访问必须是 1,否则浏览器拿不到登录 cookie,会一直在登录页打转。
set_env COOKIE_SECURE "1" "$ENV_FILE"

if [ -z "$DOMAIN" ]; then
	# compose 里 caddy 用了 ${DOMAIN:?...},变量缺失会让**整个** compose 文件解析失败
	# (哪怕只 up app)。所以这里必须留一个占位值。
	if ! grep -q '^DOMAIN=' "$ENV_FILE"; then
		set_env DOMAIN "localhost" "$ENV_FILE"
	fi
	if [ "$WITH_CADDY" = auto ]; then WITH_CADDY=0; fi
else
	set_env DOMAIN "$DOMAIN" "$ENV_FILE"
	if [ "$WITH_CADDY" = auto ]; then WITH_CADDY=1; fi
fi

# 口令优先级:--password > .env 里已有 > 交互输入 > 留空(首次打开 /login 自己设)
# 用 sed 而不是 grep 取值:开了 pipefail 之后,grep 无匹配会让 $(...) 直接把脚本带走。
_env_pw="$(sed -n 's/^APP_PASSWORD=//p' "$ENV_FILE" | tail -1 | sed "s/^'//; s/'$//; s/^\"//; s/\"$//")"

# 口令写不进去(含单引号/换行)时不静默改写,也不中断部署 ——
# 未设口令时应用除登录页外全部锁定,是安全的失败方向,用浏览器 /login 设即可。
set_password() {
	if try_set_env APP_PASSWORD "$1" "$ENV_FILE"; then
		log "APP_PASSWORD 已写入 $ENV_FILE"
	else
		warn "口令含单引号或其他无法写进 .env 的字符,已跳过(不会静默改你的口令)。"
		warn "部署照常继续;起来后用浏览器打开 /login 设置初始口令即可。"
		return 1
	fi
}

_pw_set=0
if [ -n "$PASSWORD" ]; then
	set_password "$PASSWORD" && _pw_set=1
elif [ -z "$_env_pw" ] && [ -t 0 ] && [ -t 1 ]; then
	printf '设置网页访问口令(直接回车 = 首次打开 /login 时再设): '
	read -r -s _pw || true
	printf '\n'
	if [ -n "${_pw:-}" ]; then set_password "$_pw" && _pw_set=1; fi
	unset _pw
elif [ -n "$_env_pw" ]; then
	_pw_set=1
fi

chmod 600 "$ENV_FILE"
if [ "$_pw_set" = 0 ]; then
	warn "APP_PASSWORD 未设置:容器起来后除登录页外全部锁定,请用浏览器打开 /login 设初始口令"
fi
unset _env_pw _pw_set

# ============================ 5. 更新上线 ============================
log "拉取发布包并构建镜像(验签 → sha256 → 解密 → 构建)"
( cd "$ROOT" && bash docker/update.sh ${UPDATE_ARGS[@]+"${UPDATE_ARGS[@]}"} )

APP_VERSION="$(tr -d '[:space:]' < "$ROOT/docker/dist/VERSION" 2>/dev/null || echo unknown)"

if [ "$WITH_CADDY" = 1 ]; then
	log "启用 Caddy(自动申请 HTTPS 证书)"
	( cd "$ROOT" && docker compose --profile proxy up -d caddy )
	command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active' \
		&& warn "ufw 是启用状态:Caddy 签证书要走 80,别忘 sudo ufw allow 80,443/tcp"
fi

log "等健康检查(/api/health)"
_ok=0
for _i in $(seq 1 30); do
	if curl -fsS --max-time 3 "http://127.0.0.1:53110/api/health" >/dev/null 2>&1; then
		_ok=1; break
	fi
	sleep 2
done
[ "$_ok" = 1 ] && log "健康检查通过" \
	|| warn "60 秒内没通过健康检查,看日志:cd $ROOT && docker compose logs -f app"

if [ -n "$DOMAIN" ]; then
	cat <<-EOF

	------------------------------------------------------------------
	部署完成:版本 $APP_VERSION
	  访问    https://$DOMAIN/login
	  日志    cd $ROOT && docker compose logs -f app
	  下回更新 cd $ROOT && bash docker/install.sh
	  备份    docker run --rm -v steam-tools-data:/data -v "\$PWD":/backup alpine \\
	            tar czf /backup/steam-tools-data-\$(date +%F).tgz -C /data .
	------------------------------------------------------------------
	EOF
else
	cat <<-EOF

	------------------------------------------------------------------
	部署完成:版本 $APP_VERSION
	  app 只监听 127.0.0.1:53110,还没配反代 —— 现在从外网访问不到。
	  要自带 HTTPS 的 Caddy:bash docker/install.sh --domain 你的域名
	  用 Nginx 自己配:Caddyfile 旁边的 DOCKER.md 第 5 节有现成配置
	  日志    cd $ROOT && docker compose logs -f app
	  下回更新 cd $ROOT && bash docker/install.sh
	------------------------------------------------------------------
	EOF
fi
