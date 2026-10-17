#!/usr/bin/env bash
# 装面板「立即更新」的宿主机部分(systemd)。在部署目录执行一次:
#
#   sudo ./deploy/install-updater.sh                                         # compose 文件自动找(docker-compose.yml,有 compose.override.yaml 就带上)
#   sudo ./deploy/install-updater.sh -f docker-compose.yml -f compose.override.yaml   # 和你平时 docker compose 带的 -f 一样
#   sudo ./deploy/install-updater.sh --data /srv/steam-data                  # 数据目录不是 ./data 时
#   sudo ./deploy/install-updater.sh --uninstall                             # 卸载
#
# 装好后:面板点「立即更新」→ 容器在 data/update/ 里放一个 request.json → systemd(steam-tools-updater.path)看到就跑
# deploy/update.sh(git pull、docker compose pull、docker compose up -d --wait),进度写进 updater/,面板显示。
# 容器本身不加任何权限:它只能放这个信号文件,进度目录 updater/ 归 root、只读挂进容器。
set -euo pipefail

UNIT=steam-tools-updater
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DATA=$DIR/data
FILES=()
UNINSTALL=0
ARGS="$*"

usage() {
	sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

while [ $# -gt 0 ]; do
	case $1 in
		-f | --file)
			[ $# -ge 2 ] || usage 2
			FILES+=("$2")
			shift 2
			;;
		--data)
			[ $# -ge 2 ] || usage 2
			DATA=$(cd "$2" && pwd)
			shift 2
			;;
		--uninstall)
			UNINSTALL=1
			shift
			;;
		-h | --help)
			usage 0
			;;
		*)
			echo "不认识的参数:$1" >&2
			usage 2
			;;
	esac
done

if [ "$(id -u)" != 0 ]; then
	echo "要用 root 执行:sudo $0 $ARGS" >&2
	exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
	echo "这台服务器没有 systemd(systemctl),装不了;更新照旧在服务器上执行 git pull && docker compose pull && docker compose up -d" >&2
	exit 1
fi

if [ "$UNINSTALL" = 1 ]; then
	systemctl disable --now "$UNIT.path" 2>/dev/null || true
	rm -f "/etc/systemd/system/$UNIT.path" "/etc/systemd/system/$UNIT.service"
	rm -f "$DIR/updater/installed.json"
	systemctl daemon-reload
	echo "已卸载。面板上不再显示「立即更新」(刷新一下页面)。"
	exit 0
fi

# systemd 单元里的路径不转义,含空格等特殊字符的路径不支持
for path in "$DIR" "$DATA"; do
	if ! printf '%s' "$path" | grep -qE '^/[A-Za-z0-9._/@+-]+$'; then
		echo "路径 $path 里有空格或特殊字符,不支持;把项目放到简单的路径下(如 /srv/steam-tools)" >&2
		exit 1
	fi
done

cd "$DIR"
if [ ${#FILES[@]} = 0 ]; then
	FILES=(docker-compose.yml)
	if [ -f compose.override.yaml ]; then
		FILES+=(compose.override.yaml)
	fi
fi
COMPOSE=()
for file in "${FILES[@]}"; do
	if ! printf '%s' "$file" | grep -qE '^[A-Za-z0-9._/-]+$' || [ ! -f "$file" ]; then
		echo "compose 文件 $file 不存在(或名字里有特殊字符);-f 后面写相对部署目录的文件名" >&2
		exit 1
	fi
	COMPOSE+=(-f "$file")
done
if ! CONFIG=$(docker compose "${COMPOSE[@]}" config); then
	echo "docker compose ${COMPOSE[*]} config 不通过,先确认平时的部署命令能用" >&2
	exit 1
fi
if ! grep -q '/updater' <<<"$CONFIG"; then
	echo "注意:compose 里没有把 ./updater 挂进容器(1.6.17 起的 docker-compose.yml 自带)。先照常更新一次:" >&2
	echo "  git pull && docker compose ${COMPOSE[*]} pull && docker compose ${COMPOSE[*]} up -d" >&2
	exit 1
fi

# 进度目录:归 root,容器只读;信号目录:容器(uid 1000)能写
install -d -o root -g root -m 755 "$DIR/updater"
install -d -o 1000 -g 1000 -m 700 "$DATA/update"
chmod 755 "$DIR/deploy/update.sh"

cat >"/etc/systemd/system/$UNIT.service" <<EOF
[Unit]
Description=Steam 工具台:拉新代码和镜像、重建容器(面板「立即更新」)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=STEAM_TOOLS_DIR=$DIR
Environment=STEAM_TOOLS_DATA=$DATA
Environment="STEAM_TOOLS_COMPOSE_FILES=${FILES[*]}"
ExecStart=$DIR/deploy/update.sh
TimeoutStartSec=30min
EOF

cat >"/etc/systemd/system/$UNIT.path" <<EOF
[Unit]
Description=Steam 工具台:面板请求更新时触发 $UNIT.service

[Path]
PathExists=$DATA/update/request.json
Unit=$UNIT.service

[Install]
WantedBy=multi-user.target
EOF

tmp=$(mktemp "$DIR/updater/.installed.XXXXXX")
printf '{"version":1,"installedAt":%s,"composeFiles":"%s"}\n' "$(date +%s%3N)" "${FILES[*]}" >"$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$DIR/updater/installed.json"

systemctl daemon-reload
systemctl enable --now "$UNIT.path"

echo "已装好:面板「运行设置」和新版本提示里会出现「立即更新」(刷新一下页面)。"
echo "  compose 文件:${FILES[*]}"
echo "  看状态:systemctl status $UNIT.path    看更新日志:journalctl -u $UNIT.service"
echo "  卸载:sudo $0 --uninstall"
