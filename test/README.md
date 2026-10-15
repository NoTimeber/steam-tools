# 测试

需要 Node 24 及以上。

```bash
npm test            # 单元测试:src/**/*.test.ts
npm run test:e2e    # 端到端:test/e2e/*.e2e.ts
npm run typecheck   # 类型检查(src/ 和 test/)
```

## 单元测试

和被测代码放在一起（`src/**/*.test.ts`），用 Node 自带的 `node:test`。依赖都用假对象替代，不启动服务、不碰网络。

## 端到端测试

每个测试文件都会启动一个真实的服务端子进程（入口 `src/main.ts`）：

- 使用独立的临时目录（运行数据、主密钥都在里面），用完即删，不碰仓库里的 `data/`。
- 使用随机端口，只监听 `127.0.0.1`。
- 预加载 [`support/offline-preload.cjs`](e2e/support/offline-preload.cjs)，保证测试**完全离线**：
  - **假 steam-user**：refreshToken 以 `RT-GOOD-` 开头、或者密码是 `pw-good` 时登录成功，其余都登录失败；密码 `pw-guard` 要移动令牌验证码（`24680` 才对）。
  - **最小 GC 模拟**：进入游戏后回欢迎消息；收到商店数据请求时，回 `test/fixtures/price-sheets/` 里的真实价目表样本。
  - **GC 商店下单**：按真实 GC 实测的规则拒单，授权、扣款后钱包余额跟着变。
  - **假悠悠接口、报价接受替身**：按 `FAKE_UU_FILE` 里的场景回包。
  - **充值码兑换替身**（steamstore）：码的前缀决定结果（`GOOD-` 成功、`USED-` 已使用、`LIMIT-` 被限流）。
  - **假 Steam 市场**：挂求购、手机确认、撤单、我的求购单都有状态；开关（要不要手机确认、拒单、已成交）在 `FAKE_MARKET_FILE`。
  - **假 Steam 商店结算**：买游戏用到的 store / api / checkout 端点，每个账号钱包 10.00 美元、记住已拥有的包；商品可用 `FAKE_STORE_PACKAGES` 追加。设了 `FAKE_STORE_COUNTRY` 时还模拟商店账户页（查真实国家用）。
  - **假社区库存**：两页共 3 件；`FAKE_INVENTORY_FILE` 可设成私密（403）。
  - **假 C5GAME 开放平台**：余额、在售（19 位整数 id）、批量购买 / 快速购买、订单详情都有状态；初始场景在 `FAKE_C5_FILE`。app-key 以 `bad` 开头的一律拒绝，以 `ip` 开头的查在售时报不在白名单。
  - **外网拦截**：`fetch` 只放行本机；汇率接口返回固定数据；其它外部请求直接失败，并记进日志供测试断言。

[`support/server.ts`](e2e/support/server.ts) 提供这些工具：

- `startServer()`：启动被测服务。传入同一个 `appRoot` 再启动一次，就能模拟重启。
- `Client`：带 cookie、同源 `Origin` 和 `X-Forwarded-For` 的 HTTP 客户端。
- `SocketListener`：用登录后的 cookie 连 socket.io，收集服务端推送（任务进度等）。
- `server.steamEvents()`：本次启动以来假 Steam 收到的调用。
- `server.openStore()`：用同一把主密钥打开数据库核对数据。

| 文件 | 覆盖内容 |
|---|---|
| `security.e2e.ts` | 初始化令牌、口令限速、cookie 属性、同源校验、凭据不下发、调试端点、socket.io 握手、损坏文件备份 |
| `store.e2e.ts` | 旧版明文数据导入与归档、加密落盘、maFile/UU token 读写、主密钥校验 |
| `sessions.e2e.ts` | 同账号复用和强制重登、进程被杀后自动恢复（refreshToken 优先，失效回退密码）、`SESSION_RESTORE=0` |
| `gc.e2e.ts` | 连接和断开 CS2 GC、通过 GC 拉价目表生成内购目录（与解析快照对比）、库存（社区分页、缓存、私密时报错）、终端机接口（抓包挂载、解封校验、拉报价发到 GC）、外网拦截 |
| `purchase.e2e.ts` | 从 HTTP 接口下单：GC 下单 → 钱包扣款授权 → 确认，余额变化；下单载荷不合 GC 规则时被拒 |
| `uu.e2e.ts` | UU 短信登录拿 token、按 SteamID 自动绑定、自动发货（报价严格校验后接受 + 手机确认）、fail-closed |
| `buygame.e2e.ts` | 买游戏：解析 subid、试运行不扣款、真扣款、重复购买被拒、余额不足预检拦截 |
| `accounts.e2e.ts` | refreshToken 登录、Steam Guard 验证码（错码重来）、手动刷新 WebSession、登录后查商店账户页拿真实国家、账户列表补全国家 |
| `wallet.e2e.ts` | 充值码批量兑换：临时登录（密码 / maFile refreshToken）→ 兑换 → 登出，成功/已使用/限流/登录失败的推送，临时登录不进账户列表 |
| `market.e2e.ts` | 市场求购：行情（社区 nameid 库）、多账号挂求购、手机确认后重发落单、刷新对账、撤单、挂满 |
| `c5.e2e.ts` | C5 扫货：app-key 加密落库、监控列表校验、检查连接、查在售（64 位 id 不丢精度）、自动扫货批量下单（开扫前要交易链接和总预算）、按中文搜饰品、对账、重启后恢复运行状态 |

## 离线演示服务

[`demo/server.ts`](demo/server.ts)：用上面的假 Steam 跑真实的服务端，带几个演示账号（登录成功 / 要令牌验证码 / 密码错误），开发前端时用。

```bash
node test/demo/server.ts
```

## 价目表样本

见 [fixtures/price-sheets/README.md](fixtures/price-sheets/README.md)。
