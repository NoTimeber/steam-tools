# Docker 部署

## 0. 这套东西长什么样

```
你的 Mac（开发机）                        云服务器
├── app/            源码                  /srv/steam-tools/
├── tools/build-release.js                 ├── docker-compose.yml
│     ↓ 打包+加密+签名                     ├── Dockerfile
│   release/app.zip（密文）                ├── Caddyfile
│   release/manifest.json（已签名）        ├── docker/fetch-release.js
│     ↓ gh release create                  ├── docker/update.sh
└── GitHub Releases ────────────────────→  ├── public-key.pem   ← 验签用
      app.zip / manifest.json              ├── update-key.bin    ← 解密用
                                           └── .env
                                                 ↓ bash docker/update.sh
                                           解密发布包 → docker/dist → 构建镜像 → 重启容器
```

三件需要先明确的事：

1. **镜像代码不是从本仓库的 `app/` 目录构建的**，而是由 `docker/fetch-release.js` 从 GitHub Releases
   拉你已发布的加密包，验签 → 校验 sha256 → AES-256-GCM 解密 → 解压成构建上下文 `docker/dist`，
   再 `docker build`。也就是说：**服务器上不需要你的源码，只需要能解开加密包的密钥。**
2. **`launcher.js` 不参与**。它是桌面版的更新器/崩溃守护，用 PowerShell 解压，在 Linux 上跑不了。
   容器里只跑 `app/server.js`，版本更新由镜像 tag 承担。
3. **`update-key.bin` 必须放到服务器**（它是解密发布包的 AES 密钥）。它本来就随桌面客户端分发，
   不算最高机密，但服务器被入侵 = 你的源码可被解密。放好后 `chmod 600`。
仓库 `NoTimeber/steam-tools`（公开）里只放**部署骨架**和 Release 附件，不放 `app/` 源码 ——
骨架由服务器上的 `docker/install.sh` 从 `main` 分支拉取，见 §1.1；源码只以加密包形式存在于
Release 里，靠 `update-key.bin` 解开。所以往这个仓库推东西时，白名单比 `git add .` 安全得多
（仓库根有 `.gitignore` 兜底，见文末附录）。
## 1. 首次部署

### 1.1 一键部署（推荐）

部署骨架（`docker/`、`Dockerfile`、`docker-compose.yml`、`Caddyfile`、`public-key.pem`）现在跟着仓库
`main` 分支一起分发，服务器上一条命令就能拉齐骨架 → 构建镜像 → 起容器：

```bash
# 1) 先传解密密钥。它绝不能进公开仓库，所以只有这一步必须手动。
ssh user@server 'mkdir -p /srv/steam-tools'
scp update-key.bin user@server:/srv/steam-tools/

# 2) 服务器上，一条命令
curl -fsSL https://raw.githubusercontent.com/NoTimeber/steam-tools/main/docker/install.sh \
  | bash -s -- --domain tools.example.com --password '你的强口令'
```

`docker/install.sh` 依次做这些事：

1. 从仓库 `main` 同步骨架到 `/srv/steam-tools`。重跑一次就是「更新骨架 + 更新应用」，
   `--no-sync` 可以关掉（改过 compose 或 Caddyfile 时用）。
2. 检查 Docker，缺了就装（官方 `get.docker.com` 脚本；`--no-install-docker` 只检测不装）。
   当前用户不在 docker 组时会自动用 `sudo` 重跑自己。
3. 生成/补齐 `.env`（`GITHUB_REPO`、`DOMAIN`、`COOKIE_SECURE=1`、`APP_PASSWORD`），
   并校验 `update-key.bin` 确实是 32 字节。
4. 调 `docker/update.sh`：拉 GitHub 最新发布 → 验签 → sha256 → AES 解密 → 构建 → 重启容器。
5. 给了 `--domain` 就顺带起 Caddy，最后等 `/api/health` 通过并打印访问地址。

常用变体：

| 场景 | 命令 |
|---|---|
| 发版后更新线上 | `cd /srv/steam-tools && bash docker/install.sh` |
| 固定版本 / 回滚 | `UPDATE_MANIFEST_URL=... bash docker/update.sh`（见 §2） |
| 先用本地包试跑再决定发不发版 | 把 `release/` 传上去，`bash docker/install.sh --local release` |
| `raw.githubusercontent.com` 被墙 | 加 `--prefix https://ghproxy.com/` |
| 自己配 Nginx，不用 Caddy | 加 `--no-caddy`，配置见 §5 |
| 看全部参数 | `bash docker/install.sh --help` |

> **口令里不要有单引号。** `.env` 的写法得同时满足 Node 的 `--env-file` 和 compose 的 dotenv
> 两个解析器，而它们对转义的脾气不一样（实测：双引号内 `\"` 不被当转义、裸值里的 `#` 会被当注释
> 截断、只有单引号是两边都原样保留的）。脚本因此统一用单引号包裹；值里真含单引号时会**明确警告并跳过
> 写入**，不会静默改写你的口令——起来后打开 `/login` 设初始口令即可（未设口令时应用除登录页外全部锁定）。

### 1.2 手动分步部署（备选：不跑一键脚本）

#### 1.2.1 上传部署骨架（约 30KB，不含源码和数据）

```bash
# 在 Mac 上，项目根目录执行
rsync -avz --delete \
  --include 'docker/' --include 'docker/***' \
  --include 'docker-compose.yml' --include 'Dockerfile' --include 'Caddyfile' \
  --include 'package.json' --include 'package-lock.json' \
  --exclude '*' \
  ./ user@server:/srv/steam-tools/
```

#### 1.2.2 上传配置与密钥（一次性，之后发版不用再传）

```bash
scp .env public-key.pem update-key.bin user@server:/srv/steam-tools/
ssh user@server 'cd /srv/steam-tools && chmod 600 update-key.bin && chmod 644 public-key.pem'
```

服务器上的 `.env` 是**独立**的，除了从本地拷过来的 `GITHUB_REPO`，还要加两项：

| 变量 | 值 | 说明 |
|---|---|---|
| `APP_PASSWORD` | 强口令 | 不设的话容器起来后除登录页外全部锁定，得先用浏览器打开 `/login` 设初始口令。要上公网，直接设。 |
| `DOMAIN` | 你的域名 | 用 compose 里的 Caddy 时必填（compose 读它做变量插值）。 |
| `COOKIE_SECURE` | 不用改 | compose 已强制注入 `1`。只有改成裸 http 直连才需要 0。 |

#### 1.2.3 拉包构建并启动

```bash
ssh user@server
cd /srv/steam-tools
bash docker/update.sh              # 拉 GitHub 最新发布 → 构建 → 起容器
docker compose --profile proxy up -d caddy   # 首次启用自带 HTTPS 的 Caddy
```

DNS 把域名 A 记录指向服务器，安全组放通 80 / 443（Caddy 用 80 做 ACME 验证、443 提供 HTTPS）。
然后访问 `https://你的域名/login`。

> 服务器不需要装 Node.js。`docker/update.sh` 本机有 `node` 就用本机的，没有就借 `node:22` 容器跑
> 拉包/解密那一步。

## 2. 日常更新

### 发版（在 Mac 上，流程和以前一样）

```bash
# 1. 改 app/ 下的代码
# 2. 打包（加密 + 签名）
node tools/build-release.js 1.1.0 "修复 xxx"
# 3. 上传 Release（两个附件名必须保持 app.zip / manifest.json）
gh release create v1.1.0 release/app.zip release/manifest.json \
   -R NoTimeber/steam-tools -t "v1.1.0" -n "修复 xxx"
```

### 上线（在服务器上，一条命令）

`install.sh` 就是 `update.sh` 外面又包了一层：先刷新骨架 `.env`，再调 `update.sh`。
只想更新应用、不碰骨架和 `.env` 时，直接调 `update.sh` 也一样。

```bash
cd /srv/steam-tools && bash docker/install.sh
```

`update.sh` 依次做：拉 `releases/latest` 的清单 → 验签 → 下载 → 校验 sha256 → 解密 → 解压到
`docker/dist` → `docker compose build app` → `docker compose up -d app` → 删掉除当前版本外的旧镜像。
Caddy 不受影响（它在 `proxy` profile 里，且 `up -d app` 不会碰它）。

想固定到某个版本而不是 latest，用 `UPDATE_MANIFEST_URL` 指向具体 tag：

```bash
UPDATE_MANIFEST_URL=https://github.com/NoTimeber/steam-tools/releases/download/v1.1.0/manifest.json \
  bash docker/update.sh
```

### 其他模式

```bash
bash docker/update.sh --local release   # 用本地 release/ 目录的包(离线；先在服务器上验证再发版)
bash docker/update.sh --source          # 用仓库里的 app/ 直接构建(开发；跳过验签解密，需要源码)
```

`--local` 很适合「先本地 `build-release.js` 生成包 → 传到服务器试跑 → 确认没问题再 `gh release create`」。

### 回滚

镜像 tag 就是发版号，但 `docker/dist` 会被覆盖，所以回滚等于重新拉上一个版本：

```bash
UPDATE_MANIFEST_URL=https://github.com/NoTimeber/steam-tools/releases/download/v1.0.8/manifest.json \
  bash docker/update.sh
```

数据卷不受影响（`data/` 一直是那一个 named volume）。

### 看当前跑的是哪个版本

```bash
docker compose exec app cat /app/VERSION
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' steam-tools:1.0.9
```

## 3. 更新链路的校验强度

`fetch-release.js` 与桌面版 launcher 的更新流程同源，任何一步不过就中止，绝不产出上下文：

| 步骤 | 失败后果 |
|---|---|
| 清单 Ed25519 验签（`public-key.pem`） | 拒绝该版本（清单被篡改/换源都会失败） |
| 密文 `app.zip` 的 sha256 比对 | 拒绝（下载被截断或中间人改包） |
| AES-256-GCM 解密（`authTag` 校验） | 解密即报错（密文被改动则认证失败） |
| 解压后检查 `app/server.js` 存在 | 包结构不对则中止，不构建 |

解压用的 zip 解析器是脚本内实现的（纯 Node + zlib，不依赖 `unzip`/`python3`），已与系统 `unzip`
对同一个真实发布包逐字节比对验证过。

**安全边界**：`docker/dist/` 里会有解密后的源码副本（每次更新覆盖）。不想让源码留在服务器上，
取消 `docker/update.sh` 末尾 `# rm -rf docker/dist` 的注释。注意这不影响已构建的镜像。

## 4. 数据与备份

运行数据在 named volume `steam-tools-data`（挂到容器 `/app/data`）：

```
data/sessions/        Steam 登录会话
data/config/mafile/   令牌文件（敏感）
data/config/cookies/  账号 cookie（敏感）
data/config/auth.json 网页口令的 scrypt 哈希
data/uu/tokens.json   UU token
data/price-sheets/    价格/目录缓存
```

**不挂这个卷，每次重启容器都等于换了一台机器**，Steam 会反复要 Steam Guard，maFile 也白存。

```bash
# 备份
docker run --rm -v steam-tools-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/steam-tools-data-$(date +%F).tgz -C /data .

# 恢复（先停服务）
docker compose down
docker run --rm -v steam-tools-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/steam-tools-data-2026-01-01.tgz -C /data'
docker compose up -d app
```

想直接用宿主目录，把 compose 里的卷换成绑定挂载，属主对上容器内 uid 1000：

```yaml
    volumes:
      - ./data:/app/data
```

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

## 5. 反代

compose 里的 Caddy 已配好（`Caddyfile`，含 `flush_interval -1`，Socket.IO 长轮询不被缓冲）。
用 Nginx 的话：

```nginx
server {
    listen 443 ssl http2;
    server_name tools.example.com;

    ssl_certificate     /etc/letsencrypt/live/tools.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tools.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:53110;   # compose 只把这个端口绑在回环上
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade    $http_upgrade;   # Socket.IO WebSocket 升级
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;                    # 长连接别被默认 60s 掐断
        proxy_buffering off;                         # 同 Caddy 的 flush_interval -1
        client_max_body_size 20m;
    }
}
```

## 6. 排查

```bash
docker compose ps                    # healthy / unhealthy
docker compose logs -f app           # 服务日志
docker compose exec app cat /app/VERSION
docker compose exec app node -e "fetch('http://127.0.0.1:53110/api/health').then(r=>r.json()).then(console.log)"
docker stats steam-tools-app-1       # 内存占用

# 更新链路单独试跑，不碰容器
node docker/fetch-release.js --local release     # 或 --source
ls -la docker/dist && head -c 200 docker/dist/VERSION
```

常见错误：

| 报错 | 原因 |
|---|---|
| 清单 HTTP 404 | `.env` 里的 `GITHUB_REPO` 不对，或该仓库没有 Release |
| 清单签名校验失败 | 服务器上的 `public-key.pem` 和发版用的私钥不是一对 |
| 找不到 `update-key.bin` / 解密失败 | 密钥没传、传错，或不是生成该发布包时的那个密钥 |
| sha256 不匹配 | 下载被镜像/代理改写，或 Release 附件被替换过 |
| 缺少 `docker/dist/Dockerfile` | 直接跑了 `docker compose up -d --build`，没先跑 `docker/update.sh` |

## 7. 已知限制与注意点

- **首次启动前是锁定状态**：`data/config/auth.json` 与 `APP_PASSWORD` 都没有时，除登录页和
  `/api/*/auth/*` 外一律拒绝。容器里开不了浏览器，所以要么设 `APP_PASSWORD`，要么通过反代打开
  `/login` 设初始口令。
- **网页登录会话存内存**：重启容器后网页要重新输口令（Steam 侧会话在 `data/sessions` 里，不用重登 Steam）。
- **容器时钟必须准**：Steam Guard 的 TOTP 依赖时间，Docker 用宿主时钟，宿主开了 NTP 就没事。
- **健康检查**：`/api/health` 是免鉴权公开路由，同时也是存活探针 —— 反代别给它单独加访问控制，
  否则 Caddy 的 `depends_on: service_healthy` 会一直等。
- **别把 53110 直接暴露到公网**：里面是 Steam 账号、令牌和 cookie，必须过 HTTPS 反代 + 强口令。
  compose 默认只绑 `127.0.0.1`。
- **架构**：`lzma-native` 的预编译覆盖 `linux/amd64` 与 `linux/arm64`。**不要换 alpine**：
  预编译产物是 glibc 的，musl 下会退化成现场源码编译。
- **发版即上线**：`releases/latest` 同时被桌面客户端和服务器消费，所以发版前用
  `--local release` 在服务器上先试跑一遍；另外 `gh release create` 之前可以有草稿，
  但一旦不是 latest 就会被 `update.sh` 忽略。

- **骨架要刷到最新才认得出新参数**：`install.sh` 默认每次重跑都会从 `main` 覆盖骨架文件
  （`Dockerfile`/`docker-compose.yml`/`Caddyfile`/`docker/*.js`/`docker/*.sh`）。改过这些文件
  就必须加 `--no-sync`，否则改动会被静默覆盖，只留下 `.env`、`update-key.bin` 和 `data/`。

## 附录 A. 把部署骨架推到仓库（只需做一次）

`docker/install.sh` 是从仓库 `main` 分支拉骨架的，所以骨架不在仓库里时那条 `curl` 会 404。
第一次要先推一遍。**这个仓库是公开的，而 `app/` 源码正是 `update-key.bin` 保护的东西 ——
所以别用 `git add .`，白名单加文件，再用 `git status` 复核。**

```bash
cd <项目根>

git init -b main          # 已经是 git 仓库就跳过
git add .env.example .dockerignore .gitignore Dockerfile docker-compose.yml Caddyfile \
        public-key.pem package.json package-lock.json DOCKER.md README.md \
        docker/install.sh docker/update.sh docker/fetch-release.js

git status --short        # 最后一道闸：肉眼过一遍列表
git commit -F <提交说明文件>

# 接上远端。注意：如果远端只有过一个 README 提交，而本地是全新 git init，
# 两边是「无关历史」，直接 push 会被拒。把本地提交重放到远端之上，推成快进：
git remote add origin https://github.com/NoTimeber/steam-tools.git
git fetch origin
git reset --soft origin/main
git commit -F <提交说明文件>
git push origin main

`git status --short` 那一眼重点确认下面三样**不在**待提交列表里：

| 绝不该进仓库 | 一旦泄露的后果 |
|---|---|
| `app/`（源码） | 公开仓库 = AES 加密发布这件事白做了 |
| `update-key.bin` | 谁拿到谁就能解开发布包 |
| `tools/keys/update-private.pem` | 拿到它就能伪造发布清单，桌面客户端和服务器都会照单全收 |

仓库根的 `.gitignore` 已经把这些都挡住了（`/app/`、`update-key.bin`、`/tools/keys/`、`data/`、
`release/`、`docker/dist/`、`.env`、`*.maFile`），但要记住它是兜底，不是许可 ——
`git add -A` 之前先 `git status` 看一眼，成本一秒。
