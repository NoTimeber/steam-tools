# 服务器部署（Docker）

部署形态：服务端跑在 Docker 里，所有数据存在服务器的 `data/` 目录；本地用浏览器打开反代后的 HTTPS 地址访问。

```
浏览器(本地) ──HTTPS──> 反代(Caddy/Nginx) ──> 127.0.0.1:53110 ──> 容器 steam-tools ──> ./data
```

## 1. 准备

- 一台 Linux 服务器，装好 Docker 和 compose 插件（`docker compose version` 能输出版本）。
- 一个域名，A 记录指向服务器。
- 服务器能直连 `steamcommunity.com`、`store.steampowered.com`、Steam CM 节点和 `youpin898.com`。

## 2. 拉代码、写配置

```bash
git clone <你的私有仓库地址> steam-tools
cd steam-tools
cp .env.example .env
```

按需修改 `.env`。Docker 部署一般只需要改这两项：

- `DOMAIN=tools.example.com`：用自带 Caddy 时必填。
- `UU_POLL_INTERVAL_MS`、`INSPECT_SERVICE_URL` 等业务参数。

`DATA_DIR`、`HOST`、`PORT`、`TRUST_PROXY` 已在 `docker-compose.yml` 里设好，不用再改。

## 3. 生成主密钥

账号密码、shared_secret、maFile、Steam session、UU token 在数据库里都是 AES-256-GCM 密文，解密全靠这把主密钥。

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

## 5. 启动

自带 Caddy（自动申请 HTTPS 证书）：

```bash
docker compose --profile caddy up -d --build
```

已有 Nginx 时，只启动应用，再按 `deploy/nginx.conf.example` 配反代：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f steam-tools
```

## 6. 首次登录

- 迁移过来的 `data/config/auth.json` 会保留原来的访问口令。
- 全新部署时打开 `https://你的域名/login` 设置口令。页面会要求输入「初始化令牌」，令牌打印在启动日志里：

```bash
docker compose logs steam-tools | grep 初始化令牌
```

口令至少 8 位。同一 IP 连续输错 5 次锁定 15 分钟。

新版界面（Vue，逐个模块迁移中）在 `https://你的域名/next/`，镜像构建时一起打包；旧版界面仍在 `/`，两个可以同时用。详见 [web/README.md](web/README.md)。

## 7. 更新

```bash
git pull
docker compose up -d --build
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
- 账号密码、shared_secret、maFile、Steam session、UU token 在数据库里是 AES-256-GCM 密文，主密钥单独挂载。
- 浏览器不再保存或接收 Steam 密码、shared_secret、UU token 原文。
- 返回 Steam cookies 的 `/api/cookies/:id`，以及能真实下单的 `/api/steam-purchase/test`，默认都关闭。需要时在 `.env` 里设 `ENABLE_DEBUG_ENDPOINTS=1`。

## 注意事项

- **所有账号都会从服务器 IP 登录 Steam 和 UU。**
  - 账号以前常用的登录地区和服务器所在地区差得远时，可能触发 Steam 的风控或邮件提醒。
  - UU 那边同样会看到 IP 变化。
- **服务器在大陆时**，连 Steam 社区和 raw.githubusercontent.com（皮肤库、nameid 库）可能不稳定。
- **UA 随机化依赖 `data/ua_cache.json`。** 全新部署的数据目录里没有这个文件，日志会提示「User-Agent 随机化已跳过」；从本地迁移数据时会一并带过去。
