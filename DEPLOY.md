# 服务器部署（Docker）

部署形态：服务端跑在 Docker 里，所有数据存在服务器的 `data/` 目录；本地用浏览器打开反代后的 HTTPS 地址访问。

```
浏览器(本地) ──HTTPS──> 你的反代 ──> 127.0.0.1:53110 ──> 容器 steam-tools ──> ./data
```

## 1. 准备

- 一台 Linux 服务器，装好 Docker 和 compose 插件（`docker compose version` 能输出版本）。
- 反代和 HTTPS 证书自己配（Nginx、Caddy 等都行），要求见第 5 节。
- 服务器能直连 `steamcommunity.com`、`store.steampowered.com`、Steam CM 节点和 `youpin898.com`；用 C5 扫货的话还要能连 `openapi.c5game.com`。
- 服务器能拉 `ghcr.io` 的镜像。镜像在发版时由 GitHub Actions 构建好（只有 amd64，ARM 服务器跑不了），服务器上不用构建；拉不到时见第 7 节最后。

## 2. 拉代码、写配置

```bash
git clone https://github.com/NoTimeber/steam-tools.git steam-tools
cd steam-tools
cp .env.example .env
```

按需修改 `.env`，Docker 部署一般只用改 `UU_POLL_INTERVAL_MS`、`INSPECT_SERVICE_URL` 这类业务参数。

`DATA_DIR`、`HOST`、`PORT`、`TRUST_PROXY` 已在 `docker-compose.yml` 里设好，不用再改。

## 3. 生成主密钥

账号密码、shared_secret、maFile、Steam session、UU token、C5 app-key 在数据库里都是 AES-256-GCM 密文，解密全靠这把主密钥。

```bash
mkdir -p secrets
openssl rand -base64 32 > secrets/master.key
sudo chown 1000:1000 secrets/master.key && chmod 400 secrets/master.key
```

- 容器里以 uid 1000 运行，密钥文件要归它所有，否则读不到。
- **丢了 `master.key`，数据库里的凭据就再也解不开。** 把它和 `data/` 分开备份，比如放进密码管理器。
- 数据库会记住第一次用的密钥。挂错密钥文件时服务直接拒绝启动，不会用新密钥混写。

## 4. 迁移现有数据（可选）

本地已有账号数据时，把本地安装目录下的 `data/` 整个拷到服务器项目目录下：

```bash
# 在本地执行。先停掉本地程序，避免两边同时登录同一批账号互相顶号(LoggedInElsewhere)
scp -r data/ user@server:~/steam-tools/
```

旧版 `data/` 里的账号密码、maFile、refreshToken、UU token **全部是明文**，传输过程要当作密码库对待。

容器里以 uid 1000 运行，所以宿主机上的数据目录要归它所有：

```bash
mkdir -p data && sudo chown -R 1000:1000 data && chmod 700 data
```

首次启动时，服务端会自动把这些明文文件导入加密数据库 `data/steam-tools.db`：

- 导入的有：`config/accounts.json`、`config/mafile/*.maFile`、`sessions/*.json`、`uu/tokens.json`、`uu/delivery-config.json`。
- 原文件会挪到 `data/_migrated_plaintext/<时间>/` 下，不会删除。启动日志里有导入数量。
- 登录网页确认账号、maFile、UU 绑定都正常后，**手动删除 `data/_migrated_plaintext/`**：

```bash
docker compose logs steam-tools | grep legacy-import
sudo rm -rf data/_migrated_plaintext
```

- 数据库里已有某类数据时，同类旧文件只归档、不导入，防止旧备份覆盖新数据。

## 5. 启动和反代

```bash
docker compose up -d
```

第一次启动会先从 `ghcr.io/notimeber/steam-tools` 拉镜像。

查看日志：

```bash
docker compose logs -f steam-tools
```

应用只监听宿主机的 `127.0.0.1:53110`，再用你自己的反代把 HTTPS 转进来。反代要满足这几点：

- **转发到 `http://127.0.0.1:53110`**，并且支持 WebSocket 升级：实时日志和任务进度走 socket.io。长连接的读写超时调大，比如 1 小时。
- **Host 头保留浏览器访问的域名**，或者另外传 `X-Forwarded-Host`。服务端会拿它和浏览器 `Origin` 里的域名比对，对不上的写请求一律 403。
- **传 `X-Forwarded-For` 和 `X-Forwarded-Proto`**。登录失败锁定按真实客户端 IP 算；经 HTTPS 访问时登录 cookie 才会带 `Secure`。
- **请求体上限不低于 1 MB**（服务端自己的上限）。批量导入 maFile 时请求比较大，Nginx 可以设 `client_max_body_size 2m`。

反代跑在宿主机上就行。`docker-compose.yml` 已经设好信任经 Docker 网桥（`172.16.0.0/12` 等内网段）转发进来的 `X-Forwarded-*`。

## 6. 首次登录

- 迁移过来的 `data/config/auth.json` 会保留原来的访问口令。
- 全新部署时打开 `https://你的域名/login` 设置口令。页面会要求输入「初始化令牌」，令牌打印在启动日志里：

```bash
docker compose logs steam-tools | grep 初始化令牌
```

口令至少 8 位。同一 IP 连续输错 5 次锁定 15 分钟。

界面（Vue，源码在 `web/`）已经构建好打包在镜像里，打开 `https://你的域名/` 即可。以前试用新版用的 `/next/` 会跳回首页。详见 [web/README.md](web/README.md)。

## 7. 更新

有新版本时，面板顶部会提示（服务端每 6 小时查一次 GitHub 上的最新 Release，「运行设置 → 检查更新」可以手动查）。装了下面的「面板一键更新」就能在面板上点「立即更新」；没装时在服务器上执行：

```bash
git pull
docker compose pull
docker compose up -d
```

- `git pull` 拿到新的 `docker-compose.yml` 和文档，`docker compose pull` 拉新镜像，`up -d` 用新镜像重建容器。镜像没变时 `up -d` 什么都不做。
- 发版后 GitHub Actions 构建镜像要几分钟，Release 页面出来后马上拉可能还是旧镜像，等一会儿再拉。
- 默认跟最新版（`latest`）。要固定在某个版本，在 `.env` 里设 `STEAM_TOOLS_TAG=1.6.1` 这样的版本号；回退也是改这个再 `docker compose up -d`。
- 旧镜像不会自动删，攒多了用 `docker image prune -f` 清掉。

服务器连不上 GitHub 或者不想让它访问外网，在 `.env` 里设 `UPDATE_CHECK=0` 关掉检查。

### 面板一键更新（可选）

在服务器上装一个小更新器后，面板顶部的新版本提示和「运行设置」里会出现「立即更新」，点一下就在服务器上执行上面那三条命令，进度显示在面板上。

先照常更新到 1.6.17 或更新的版本（从这个版本起 `docker-compose.yml` 才把 `./updater` 挂进容器），再在部署目录执行一次：

```bash
sudo ./deploy/install-updater.sh
```

- 平时 `docker compose` 带 `-f` 的，装的时候带上一样的，比如 `sudo ./deploy/install-updater.sh -f docker-compose.yml -f compose.override.yaml`。不带时用 `docker-compose.yml`，部署目录里有 `compose.override.yaml` 也一起带上。数据目录不是 `./data` 时加 `--data 目录`。
- 需要 Linux + systemd。装的是两个 systemd 单元：`steam-tools-updater.path`（盯着 `data/update/request.json`）和 `steam-tools-updater.service`（执行 `deploy/update.sh`）。
- 点「立即更新」后，容器在 `data/update/` 里放一个请求文件。更新器看到后删掉它，依次执行 `git pull --ff-only`、`docker compose pull`、`docker compose up -d --wait`（等新容器健康），每一步的进度写进 `updater/status.json`，面板读这个文件显示。失败时面板上显示是哪一步、服务器上的最后几十行输出，可以重试。
- compose 里有 `build:`（源码构建）时不拉镜像，改成 `up -d --build --wait`。
- `git pull` 用部署目录主人的身份执行。部署目录里改过跟踪的文件时 `git pull --ff-only` 会失败，面板上能看到原因。
- 更新时服务会重启：在线的 Steam 账号断开后自动恢复，面板要重新登录一次，登录后能看到更新结果。
- 看更新日志：`journalctl -u steam-tools-updater.service`。卸载：`sudo ./deploy/install-updater.sh --uninstall`。

安全上：

- 容器没有任何新权限：不挂 `docker.sock`，它只能往 `data/update/` 里放请求文件。
- `updater/` 归 root、只读挂进容器，容器改不了。更新器不读请求文件的内容，也不往 `data/` 里写东西，执行的命令是写死的。
- `deploy/update.sh` 以 root 运行，会随 `git pull` 一起更新，相当于信任这个仓库。这和你平时 `git pull` 之后执行部署命令是一样的。

服务器拉不到 `ghcr.io`（或者太慢）时，可以改在服务器上从源码构建，以后更新也用这条：

```bash
git pull && docker compose -f docker-compose.yml -f compose.build.yaml up -d --build
```

容器停止时会先登出所有 Steam 会话。重启后会自动恢复上次在线的账号：

- 优先用保存的 refreshToken 免密登录；refreshToken 失效时改用名单里的密码，加 maFile 生成的令牌。
- 账号之间间隔 3 秒逐个登录（`SESSION_RESTORE_INTERVAL_MS`），避免触发 Steam 限频。
- 手动登出、删除账号，或者遇到被顶号、密码错误这类错误的账号，不会被自动恢复。
- 不想自动恢复可在 `.env` 里设 `SESSION_RESTORE=0`。

## 8. 备份

需要备份两样东西，**分开存放**：

- `data/`：其中 `steam-tools.db`（含 `-wal`、`-shm`）是加密数据库。备份前先 `docker compose stop`，或者用 `sqlite3 data/steam-tools.db ".backup backup.db"` 做在线备份。
- `secrets/master.key`：没有它，数据库备份就是一堆解不开的密文。

## 安全说明

- 应用端口只绑定宿主机 `127.0.0.1`，公网只能经反代的 HTTPS 访问。不要把 53110 直接开到公网。
- cookie 已设置 `HttpOnly` 和 `SameSite=Lax`；经 HTTPS 访问时自动加上 `Secure`。
- 所有写请求和 WebSocket 握手都会校验 `Origin`，跨站请求会被拒绝。
- 账号密码、shared_secret、maFile、Steam session、UU token、C5 app-key 在数据库里是 AES-256-GCM 密文，主密钥单独挂载。
- 浏览器不再保存或接收 Steam 密码、shared_secret、UU token、C5 app-key 原文。
- 返回 Steam cookies 的 `/api/cookies/:id`，以及能真实下单的 `/api/steam-purchase/test`，默认都关闭。需要时在 `.env` 里设 `ENABLE_DEBUG_ENDPOINTS=1`。

## 注意事项

- **所有账号都会从服务器 IP 登录 Steam 和 UU。**
  - 账号以前常用的登录地区和服务器所在地区差得远时，可能触发 Steam 的风控或邮件提醒。
  - UU 那边同样会看到 IP 变化。
- **C5 扫货的 IP 白名单要填服务器的公网出口 IP。** 「按在售列表」策略用到的在售查询是内测接口，C5 官网 API 管理里没加白名单会被拒；拿不到权限就在页面设置里换「快速购买」。
- **服务器在大陆时**，连 Steam 社区和 raw.githubusercontent.com（皮肤库、nameid 库）可能不稳定。
- **UA 随机化依赖 `data/ua_cache.json`。** 全新部署的数据目录里没有这个文件，日志会提示「User-Agent 随机化已跳过」；从本地迁移数据时会一并带过去。
