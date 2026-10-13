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

每个测试文件都会启动一个真实的 `app/server.js` 子进程：

- 使用独立的临时目录（运行数据、主密钥都在里面），用完即删，不碰仓库里的 `data/`。
- 使用随机端口，只监听 `127.0.0.1`。
- 预加载 [`support/offline-preload.cjs`](e2e/support/offline-preload.cjs)，保证测试**完全离线**：
  - **假 steam-user**：refreshToken 以 `RT-GOOD-` 开头、或者密码是 `pw-good` 时登录成功，其余都登录失败。
  - **最小 GC 模拟**：进入游戏后回欢迎消息；收到商店数据请求时，回 `test/fixtures/price-sheets/` 里的真实价目表样本。
  - **外网拦截**：`fetch` 只放行本机；汇率接口返回固定数据；其它外部请求直接失败，并记进日志供测试断言。

[`support/server.ts`](e2e/support/server.ts) 提供这些工具：

- `startServer()`：启动被测服务。传入同一个 `appRoot` 再启动一次，就能模拟重启。
- `Client`：带 cookie、同源 `Origin` 和 `X-Forwarded-For` 的 HTTP 客户端。
- `server.steamEvents()`：本次启动以来假 Steam 收到的调用。
- `server.openStore()`：用同一把主密钥打开数据库核对数据。

| 文件 | 覆盖内容 |
|---|---|
| `security.e2e.ts` | 初始化令牌、口令限速、cookie 属性、同源校验、凭据不下发、调试端点、socket.io 握手、损坏文件备份 |
| `store.e2e.ts` | 旧版明文数据导入与归档、加密落盘、maFile/UU token 读写、主密钥校验 |
| `sessions.e2e.ts` | 同账号复用和强制重登、进程被杀后自动恢复（refreshToken 优先，失效回退密码）、`SESSION_RESTORE=0` |
| `gc.e2e.ts` | 连接和断开 CS2 GC、通过 GC 拉价目表生成内购目录（与解析快照对比）、外网拦截 |

## 价目表样本

见 [fixtures/price-sheets/README.md](fixtures/price-sheets/README.md)。
