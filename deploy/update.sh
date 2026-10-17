#!/usr/bin/env bash
# 面板「立即更新」的宿主机部分:拉新代码、拉新镜像、重建容器,进度写到 updater/status.json 给面板看。
# 由 systemd 触发(deploy/install-updater.sh 装的 steam-tools-updater.path:面板在 data/update/ 里放了 request.json 就跑一次),
# 也可以手动执行:sudo ./deploy/update.sh
#
# 安全上的约定(这个脚本以 root 跑,容器能写 data/):
#   - 不读 request.json 的内容,只把它删掉(它只是个信号;删符号链接只删链接本身);
#   - 进度只写进 updater/ —— 这个目录归 root,只读挂进容器,容器改不了;不往 data/ 里写任何东西;
#   - 执行的命令是固定的:git pull --ff-only、docker compose pull、docker compose up -d --wait(源码构建时 up -d --build --wait)。
#
# 环境变量(install-updater.sh 写进 systemd 单元):
#   STEAM_TOOLS_DIR            项目目录,默认这个脚本的上一级
#   STEAM_TOOLS_DATA           数据目录,默认 <项目目录>/data
#   STEAM_TOOLS_STATE_DIR      进度目录,默认 <项目目录>/updater
#   STEAM_TOOLS_COMPOSE_FILES  compose 文件(空格分开),默认 docker-compose.yml
#
# 整个脚本包在 main 里:git pull 会换掉这个文件本身,bash 先读完整个函数再执行,不会读到一半变成新内容。

main() {
	set -uo pipefail

	local dir data state files
	dir=${STEAM_TOOLS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
	data=${STEAM_TOOLS_DATA:-$dir/data}
	state=${STEAM_TOOLS_STATE_DIR:-$dir/updater}
	files=${STEAM_TOOLS_COMPOSE_FILES:-docker-compose.yml}

	cd "$dir" || { echo "进不去项目目录 $dir" >&2; return 1; }
	mkdir -p "$state" || return 1
	# 信号收到了就删掉(不删的话 systemd 的 PathExists 会一直触发)
	rm -f "$data/update/request.json"

	# 同一时间只跑一个(systemd 本身不会并发,这里防手动执行撞上)
	if command -v flock >/dev/null 2>&1; then
		exec 9>"$state/.lock" || return 1
		if ! flock -n 9; then
			echo "已经有一个更新在跑" >&2
			return 0
		fi
	fi

	local compose=()
	local file
	for file in $files; do
		compose+=(-f "$file")
	done

	local started from log
	started=$(now_ms)
	from=$(package_version)
	log=$(mktemp "$state/.log.XXXXXX") || return 1
	# shellcheck disable=SC2064
	trap "rm -f '$log'" EXIT

	# 拉代码:用项目目录的主人去拉(root 去拉别人的仓库 git 会拒绝,拉下来的文件也会变成 root 的)
	write_status "$state" running git "$started" 0 "正在拉取新代码" "" "$from" ""
	if ! as_owner "$dir" git pull --ff-only >"$log" 2>&1; then
		fail "$state" git "$started" "拉取新代码失败(git pull --ff-only;部署目录里有改过的文件时会这样)" "$log" "$from"
		return 1
	fi

	# 源码构建(compose 里有 build:)时不拉镜像,up 的时候重新构建
	# (先存下输出再 grep:直接接管道时 grep -q 提前退出,pipefail 下会被当成没找到)
	local build=0 config
	config=$(docker compose "${compose[@]}" config 2>/dev/null) || config=''
	if grep -qE '^[[:space:]]+build:' <<<"$config"; then
		build=1
	fi

	if [ "$build" = 0 ]; then
		write_status "$state" running pull "$started" 0 "正在拉取新镜像" "" "$from" ""
		if ! docker compose "${compose[@]}" pull >"$log" 2>&1; then
			fail "$state" pull "$started" "拉取新镜像失败(docker compose pull)" "$log" "$from"
			return 1
		fi
	fi

	write_status "$state" running up "$started" 0 "正在重启服务" "" "$from" ""
	local up=(up -d --wait)
	if [ "$build" = 1 ]; then
		up=(up -d --build --wait)
	fi
	if ! docker compose "${compose[@]}" "${up[@]}" >"$log" 2>&1; then
		# 很老的 compose 插件(2.1 以前)没有 --wait:不等健康检查再来一次
		local nowait=() arg
		for arg in "${up[@]}"; do
			[ "$arg" = --wait ] || nowait+=("$arg")
		done
		if grep -q 'unknown flag: --wait' "$log" && docker compose "${compose[@]}" "${nowait[@]}" >"$log" 2>&1; then
			:
		else
			fail "$state" up "$started" "重启服务失败(docker compose ${up[*]})" "$log" "$from"
			return 1
		fi
	fi

	local to
	to=$(package_version)
	write_status "$state" done "" "$started" "$(now_ms)" "已更新到 v$to" "" "$from" "$to"
	echo "已更新到 v$to"
}

now_ms() {
	date +%s%3N
}

package_version() {
	sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1
}

# 以项目目录的主人执行(本来就是那个用户、或者主人就是 root 时直接执行)。HOME 设成主人的家目录:
# runuser 不换环境变量,git 要从那里读配置和 SSH 密钥(远程是 git@github.com 时);systemd 跑的 root 服务也可能没有 HOME
as_owner() {
	local dir=$1
	shift
	local owner home
	owner=$(stat -c %U "$dir" 2>/dev/null || echo "")
	if [ "$(id -u)" = 0 ] && [ -n "$owner" ] && [ "$owner" != root ] && command -v runuser >/dev/null 2>&1; then
		home=$(getent passwd "$owner" 2>/dev/null | cut -d: -f6)
		runuser -u "$owner" -- env HOME="${home:-/}" "$@"
	elif [ "$(id -u)" = 0 ]; then
		HOME=${HOME:-/root} "$@"
	else
		"$@"
	fi
}

# JSON 字符串:去掉控制字符,转义反斜杠、引号、制表符,换行变 \n
json_str() {
	printf '%s' "$1" \
		| tr -d '\000-\010\013\014\016-\037' \
		| sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r$//' \
		| awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}

# 写进度:先写同目录临时文件再改名,面板读到的要么是旧的要么是新的
write_status() {
	local dir=$1 state=$2 step=$3 started=$4 finished=$5 message=$6 output=$7 from=$8 to=$9
	local tmp
	tmp=$(mktemp "$dir/.status.XXXXXX") || return 1
	printf '{"state":"%s","step":"%s","startedAt":%s,"finishedAt":%s,"updatedAt":%s,"message":"%s","log":"%s","from":"%s","to":"%s"}\n' \
		"$state" "$step" "$started" "$finished" "$(now_ms)" "$(json_str "$message")" "$(json_str "$output")" "$(json_str "$from")" "$(json_str "$to")" >"$tmp"
	chmod 644 "$tmp"
	mv -f "$tmp" "$dir/status.json"
}

# 失败:进度里带上那一步最后 30 行输出
fail() {
	local dir=$1 step=$2 started=$3 message=$4 log=$5 from=$6
	write_status "$dir" failed "$step" "$started" "$(now_ms)" "$message" "$(tail -n 30 "$log" | cut -c 1-300)" "$from" ""
	echo "$message" >&2
	tail -n 30 "$log" >&2
}

main "$@"
exit $?
