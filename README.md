# steam-tools

Steam 工具台 —— 服务端部署骨架 + 加密发布包。

这个仓库**不含 `app/` 源码**。源码只以 AES-256-GCM 加密的发布包形式挂在
[Releases](../../releases)，解开它需要 `update-key.bin`（随桌面客户端分发，不在本仓库）。
仓库里只有部署骨架、发布记录，和下面这个部署脚本。

## 服务器一键部署

```bash
# 1) 先把解密密钥传到服务器。它绝不能进公开仓库，所以只有这一步必须手动。
ssh user@server 'mkdir -p /srv/steam-tools'
scp update-key.bin user@server:/srv/steam-tools/

# 2) 服务器上一条命令：拉骨架 → 缺 Docker 就装 → 生成 .env → 拉最新发布
#    → 验签 → sha256 → 解密 → 构建镜像 → 起容器 → 等健康检查
curl -fsSL https://raw.githubusercontent.com/NoTimeber/steam-tools/main/docker/install.sh \
  | bash -s -- --domain tools.example.com --password '你的强口令'
```

之后每次更新（服务器上，骨架也会顺带刷到最新）：

```bash
cd /srv/steam-tools && bash docker/install.sh
```

全部参数见 `bash docker/install.sh --help`，完整说明见 **[DOCKER.md](DOCKER.md)**
（含 Nginx 反代配置、数据备份/恢复、版本回滚、排错表）。

## 仓库内容

| 路径 | 说明 |
|---|---|
| `docker/install.sh` | 服务器一键部署 / 更新（入口脚本） |
| `Dockerfile` | 容器镜像定义（`node:22-bookworm-slim`；**不要换 alpine**，理由见 DOCKER.md §7） |
| `docker-compose.yml` | 应用 + 可选 Caddy 反代（`proxy` profile） |
| `Caddyfile` | Caddy 配置，自动申请 HTTPS 证书 |
| `docker/update.sh` | 拉发布包 → 构建镜像 → 重启容器 |
| `docker/fetch-release.js` | 验签 → 校验 sha256 → AES 解密 → 解压成构建上下文 |
| `public-key.pem` | Ed25519 **公钥**，校验发布清单签名（私钥不在仓库里） |
| `.env.example` | 环境变量模板 |

## 为什么源码不在仓库里

发布包在本地由 `tools/build-release.js` 加密签名后上传到 Releases，服务器侧任何一步不过就中止：
发布包在本地由 `tools/build-release.js`（在开发机的本地检出里，不在本仓库）加密签名后上传到
Releases，服务器侧任何一步不过就中止：
| 步骤 | 失败后果 |
|---|---|
| 清单 Ed25519 验签 | 拒绝该版本（清单被篡改或换源都会失败） |
| 密文 `app.zip` 的 sha256 比对 | 拒绝（下载被截断或在途中被改包） |
| AES-256-GCM 解密（校验 authTag） | 解密直接报错（密文被改动则认证失败） |
| 解压后检查 `app/server.js` 存在 | 包结构不对则中止，不构建 |

运行数据（Steam 会话、maFile、cookie、网页口令哈希、各类缓存）全在数据卷 `steam-tools-data` 里，
既不在这个仓库，也不进镜像。

## 安全提醒

- **别把应用端口直接暴露到公网**：里面是 Steam 账号、令牌和 cookie，必须走 HTTPS 反代 + 强口令。
  compose 默认只绑 `127.0.0.1`。
- `update-key.bin`、`tools/keys/update-private.pem`、`.env`、`data/` 绝不入库；
  仓库根的 `.gitignore` 已经挡住，但提交前 `git status` 那一眼别省。
- `APP_PASSWORD` 里不要有**单引号**。含 `#`、`"`、空格等字符时会被自动用单引号包裹
  （`.env` 的写法要同时满足 Node 的 `--env-file` 与 compose 的 dotenv 两个解析器，细节见 DOCKER.md §1.1）。
