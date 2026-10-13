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

## 3. 迁移现有数据（可选）

本地已有账号数据时，把本地安装目录下的 `data/` 整个拷到服务器项目目录下：

```bash
# 在本地执行。先停掉本地程序，避免两边同时登录同一批账号互相顶号(LoggedInElsewhere)
scp -r data/ user@server:~/steam-tools/
```

`data/` 里有账号密码、maFile（shared_secret / identity_secret）、refreshToken 和 UU token，**全部是明文**。传输和备份都要当作密码库对待。

容器里以 uid 1000 运行，所以宿主机上的数据目录要归它所有：

```bash
mkdir -p data && sudo chown -R 1000:1000 data && chmod 700 data
```

## 4. 启动

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

## 5. 首次登录

- 迁移过来的 `data/config/auth.json` 会保留原来的访问口令。
- 全新部署时打开 `https://你的域名/login` 设置口令。页面会要求输入「初始化令牌」，令牌打印在启动日志里：

```bash
docker compose logs steam-tools | grep 初始化令牌
```

口令至少 8 位。同一 IP 连续输错 5 次锁定 15 分钟。

## 6. 更新

```bash
git pull
docker compose up -d --build
```

容器停止时会先登出所有 Steam 会话。重启后需要在「账户管理」里重新登录账号（与以前本地重启一样）。

## 安全说明

- 应用端口只绑定宿主机 `127.0.0.1`，公网只能经反代的 HTTPS 访问。不要把 53110 直接开到公网。
- cookie 已设置 `HttpOnly` 和 `SameSite=Lax`；经 HTTPS 访问时自动加上 `Secure`。
- 所有写请求和 WebSocket 握手都会校验 `Origin`，跨站请求会被拒绝。
- 浏览器不再保存或接收 Steam 密码、shared_secret，这些只存在服务端 `data/config/accounts.json`。
- 返回 Steam cookies 的 `/api/cookies/:id`，以及能真实下单的 `/api/steam-purchase/test`，默认都关闭。需要时在 `.env` 里设 `ENABLE_DEBUG_ENDPOINTS=1`。

## 注意事项

- **所有账号都会从服务器 IP 登录 Steam 和 UU。**
  - 账号以前常用的登录地区和服务器所在地区差得远时，可能触发 Steam 的风控或邮件提醒。
  - UU 那边同样会看到 IP 变化。
- **服务器在大陆时**，连 Steam 社区和 raw.githubusercontent.com（皮肤库、nameid 库）可能不稳定。
- **UA 随机化依赖 `data/ua_cache.json`。** 全新部署的数据目录里没有这个文件，日志会提示「User-Agent 随机化已跳过」；从本地迁移数据时会一并带过去。
