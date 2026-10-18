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

	local started from log gitcfg
	started=$(now_ms)
	from=$(package_version)
	log=$(mktemp "$state/.log.XXXXXX") || return 1
	gitcfg=$(mktemp "$state/.gitconfig.XXXXXX") || return 1
	# shellcheck disable=SC2064
	trap "rm -f '$log' '$gitcfg'" EXIT

	write_status "$state" running git "$started" 0 "正在拉取新代码" "" "$from" ""
	if ! git_pull "$dir" "$gitcfg" >"$log" 2>&1; then
		fail "$state" git "$started" "拉取新代码失败(git pull --ff-only):$(git_hint "$log" "$dir")" "$log" "$from"
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

# git pull --ff-only,以仓库(.git)的主人执行:拉下来的对象和文件归属不变(root 去拉别人的仓库,
# 之后那个用户自己 git pull 会因为 .git 里有 root 的文件而失败)。
# 项目目录和 .git 的主人不一样时(比如 sudo git clone 之后只把项目目录 chown 给了自己),不管以谁的身份跑,
# git 2.35.2 起都会报 dubious ownership。所以给 git 一份临时的全局配置(GIT_CONFIG_GLOBAL,git 2.32+):
# 把项目目录标成 safe.directory,再 include 主人原来的全局配置,代理、凭据之类照旧生效
git_pull() {
	local dir=$1 cfg=$2
	local owner home real
	owner=$(stat -c %U "$dir/.git" 2>/dev/null || stat -c %U "$dir" 2>/dev/null || echo "")
	home=$(user_home "$owner")
	real=$(cd "$dir" && pwd -P) || real=$dir
	{
		printf '[include]\n\tpath = %s\n\tpath = %s\n' "$(git_quote "$home/.gitconfig")" "$(git_quote "$home/.config/git/config")"
		printf '[safe]\n\tdirectory = %s\n\tdirectory = %s\n' "$(git_quote "$dir")" "$(git_quote "$real")"
	} >"$cfg" || return 1
	# 以别的用户跑时要能读到(内容只有路径)
	chmod 644 "$cfg"
	as_user "$owner" "$home" env GIT_CONFIG_GLOBAL="$cfg" git -C "$dir" pull --ff-only
}

# gitconfig 的值:加双引号,转义反斜杠和双引号
git_quote() {
	local value=${1//\\/\\\\}
	printf '"%s"' "${value//\"/\\\"}"
}

user_home() {
	local home=''
	if [ -n "$1" ]; then
		home=$(getent passwd "$1" 2>/dev/null | cut -d: -f6)
	fi
	if [ -z "$home" ] && [ "$1" = root ]; then
		home=/root
	fi
	printf '%s' "${home:-/}"
}

# 以指定用户执行(本来就是那个用户、或者那个用户是 root 时直接执行)。HOME 设成那个用户的家目录:
# runuser 不换环境变量,git 要从那里读配置和凭据;systemd 跑的 root 服务也可能没有 HOME
as_user() {
	local owner=$1 home=$2
	shift 2
	if [ "$(id -u)" = 0 ] && [ -n "$owner" ] && [ "$owner" != root ] && command -v runuser >/dev/null 2>&1; then
		runuser -u "$owner" -- env HOME="$home" "$@"
	elif [ "$(id -u)" = 0 ]; then
		HOME=${HOME:-/root} "$@"
	else
		"$@"
	fi
}

# 拉代码失败时给页面一句看得懂的原因(详细输出另外显示)
git_hint() {
	local log=$1 dir=$2
	if grep -q 'dubious ownership' "$log"; then
		echo "项目目录和 .git 的归属不一致,git 不肯操作。在服务器上执行 sudo git config --system --add safe.directory $dir 后重试"
	elif grep -qiE 'would be overwritten|local changes|untracked working tree files' "$log"; then
		echo "部署目录里有改过的文件,和新代码冲突"
	elif grep -qiE 'not possible to fast-forward|diverg' "$log"; then
		echo "部署目录里有本地提交,没法直接快进"
	elif grep -q 'publickey' "$log"; then
		echo "SSH 密钥认证失败(远程地址是 git@github.com 时要用 .git 主人的密钥)"
	elif grep -qiE 'permission denied|insufficient permission' "$log"; then
		echo "没有写入权限,部署目录里有归属不对的文件"
	elif grep -qiE "could not resolve host|failed to connect|timed out|unable to access 'http" "$log"; then
		echo "连不上 GitHub"
	else
		echo "原因见下面服务器上的输出"
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
