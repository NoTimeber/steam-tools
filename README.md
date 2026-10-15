# Steam 工具台

多账号 Steam 工具的 Web 服务。部署在服务器上（Docker），用浏览器访问：统一管理一批 Steam 账号的登录和库存，批量做 CS2 / TF2 游戏内购、买游戏、市场求购、悠悠有品自动发货、C5 到价扫货和充值码兑换。

当前版本 **v1.6.1**，更新说明见 [Releases](https://github.com/NoTimeber/steam-tools/releases)。

## 功能

| 模块 | 做什么 |
|---|---|
| 账户管理 | 导入账号名单和 maFile，密码或 refreshToken 登录、Steam 令牌验证码、余额和真实国家；服务重启后自动恢复上次在线的账号 |
| 库存管理 | 查看各账号库存（社区库存为准，拉不到时用 GC 库存兜底），显示交易冷却到期时间 |
| 内购任务 | CS2 / TF2 游戏内商店（GC）下单：多账号购物车，按各账号余额封顶，任务进度实时推送 |
| 买游戏 | 按 subid 走 Steam 商店结算，多账号并发购买；可以试运行（只验证到最终价，不扣款） |
| 市场求购 | 社区市场行情参考，多账号挂求购单（含手机确认）、撤单、和 Steam 对账 |
| UU 发货 | 悠悠有品短信登录拿 token，按账号、按游戏轮询自动发货（自动接受报价），CS2 自动上架 |
| C5 扫货 | 添加饰品可按中文搜，填好目标价，轮询 C5GAME 开放平台的在售最低价，到价自动买（真实下单，没有模拟），买满数量或用完预算为止；下单结果未知的自动对账，运行状态重启后恢复 |
| 终端机开箱 | CS2 终端机：解封、读取和推进报价、状态查看（解封和推进不可逆） |
| 充值码兑换 | 「账号----密码」和充值码按行配对，并发兑换，可以只重试失败的 |
| 运行设置 | 查看当前版本和检查新版本、修改访问口令、退出登录 |

## 部署

需要一台装好 Docker（含 compose 插件）的 Linux 服务器。反代和 HTTPS 自己配：应用只监听宿主机的 `127.0.0.1:53110`，反代要满足的几点（WebSocket、Host 头等）见 [DEPLOY.md 第 5 节](DEPLOY.md#5-启动和反代)。

```bash
git clone https://github.com/NoTimeber/steam-tools.git steam-tools && cd steam-tools
cp .env.example .env
mkdir -p secrets && openssl rand -base64 32 > secrets/master.key
sudo chown 1000:1000 secrets/master.key && chmod 400 secrets/master.key
docker compose up -d
```

镜像在发版时由 GitHub Actions 构建好（`ghcr.io/notimeber/steam-tools`，只有 amd64），服务器只拉镜像、不用构建。

然后打开 `https://你的域名/login` 设置访问口令，页面要的「初始化令牌」在启动日志里：

```bash
docker compose logs steam-tools | grep 初始化令牌
```

更新：`git pull && docker compose pull && docker compose up -d`。有新版本时面板顶部会提示（查的是 GitHub 上的最新 Release）。固定版本、回退、服务器拉不到镜像时从源码构建，见 [DEPLOY.md 第 7 节](DEPLOY.md#7-更新)。

迁移旧版数据、备份和恢复，见 **[DEPLOY.md](DEPLOY.md)**。

## 数据和安全

- 账号密码、shared_secret、maFile、Steam 会话、UU token、C5 app-key 都以 AES-256-GCM 密文存在 `data/steam-tools.db`，解密靠 `secrets/master.key`。**主密钥丢了数据就解不开**，要和 `data/` 分开备份。
- 浏览器拿不到 Steam 密码、shared_secret、UU token 和 C5 app-key 原文；账号名单只存在服务端。
- 应用端口只绑定宿主机 `127.0.0.1`，公网只能经反代的 HTTPS 访问。
- 访问口令至少 8 位，同一 IP 连续输错 5 次锁定 15 分钟；写请求和 WebSocket 都校验来源。
- 会返回 Steam cookies、能真实下单的调试端点默认关闭（`ENABLE_DEBUG_ENDPOINTS`）。

所有账号都会从服务器的 IP 登录 Steam 和悠悠有品。服务器所在地区和账号平时的登录地区差得远时，可能触发风控或邮件提醒。C5 扫货要在 C5 官网 API 管理里把服务器的公网 IP 加进白名单。

## 本地运行和开发

需要 Node 24 及以上。服务端是 TypeScript，Node 直接运行，不需要构建；前端在 `web/`，要先构建一次。

```bash
npm install
cd web && npm install && npm run build && cd ..
npm start                       # http://127.0.0.1:53110
```

本地运行时数据在 `data/`，缺主密钥会自动生成到 `secrets/master.key`。配置项见 [.env.example](.env.example)。

不想碰真实账号时，用离线演示服务（假 Steam，演示账号 alpha / bravo / charlie / delta，口令 `demo-password`）：

```bash
npm run demo
```

前端开发（热更新、接口转给本机服务端）见 [web/README.md](web/README.md)。

### 测试

```bash
npm test               # 服务端单元测试
npm run test:e2e       # 端到端测试：启动真实服务端，Steam / GC / 悠悠有品 全部用离线替身
npm run typecheck      # 类型检查
cd web && npm test && npm run typecheck
```

测试替身和覆盖范围见 [test/README.md](test/README.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | 服务端。`main.ts` 是入口，各模块一个目录（`accounts/`、`inventory/`、`purchase/`、`buygame/`、`market/`、`uu/`、`c5/`、`terminal/`、`wallet/`），`steam/` 是 Steam 会话和 GC，`store/` 是加密数据库，`web/` 是 HTTP 外壳和登录页 |
| `web/` | 前端（Vue 3 + Naive UI），构建产物 `web/dist` 由服务端挂在 `/` |
| `app/` | 随代码发布的静态资料：物品 schema、皮肤中文名库、市场 nameid 库，以及几个一次性命令行脚本 |
| `test/` | 端到端测试、离线替身、演示服务 |
| `Dockerfile`、`docker-compose.yml` | 镜像和部署编排；`compose.build.yaml` 是在服务器上从源码构建时叠加用的 |
| `.github/workflows/image.yml` | 推 `v*` 标签时构建镜像，推到 `ghcr.io` |
| `module-development/`、`re-tools/` | 早期的模块设计笔记和 GC 抓包工具 |
