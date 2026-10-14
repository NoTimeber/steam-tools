# 前端

Vue 3 + Naive UI + TypeScript，用 Vite 构建。构建产物 `web/dist` 由服务端挂在 `/`。登录页不在这里：它是服务端自带的独立页面（[src/web/login.html](../src/web/login.html)），前端没构建也能登录。

9 个模块：账户管理、库存管理、内购任务、买游戏、市场求购、UU 发货、终端机开箱、充值码兑换、运行设置。原来的旧版界面（`app/public`，原生 JS）已经删掉；新版迁移期间挂过的 `/next/` 现在跳回 `/`。

## 开发

需要 Node 24 及以上。前端有自己的 `package.json`，依赖装在 `web/node_modules`，和服务端的分开。

```bash
cd web
npm install
npm run dev         # http://127.0.0.1:5173 ,接口和 socket.io 转给 127.0.0.1:53110
npm run build       # 产物在 web/dist,服务端在 / 下提供
npm run typecheck   # vue-tsc
npm test            # src/**/*.test.ts(纯逻辑,node:test)
```

开发时服务端可以用离线演示服务，不碰真实账号（假 Steam，见 [test/demo/server.ts](../test/demo/server.ts)）：

```bash
node test/demo/server.ts
```

然后打开 `http://127.0.0.1:5173`，会跳到登录页（开发服务器把 `/login` 转给服务端，演示口令见那个文件开头），登录后回到开发服务器的首页。

## 结构

| 目录 | 内容 |
|---|---|
| `src/api/` | 调接口(`http.ts`,401 跳登录页)、socket.io 连接、后端数据类型 |
| `src/stores/` | 全局状态：账户列表(名单 + 账号资料 + 实时会话)、运行日志、远程更新 |
| `src/lib/` | 不依赖 Vue 的纯逻辑，带单元测试 |
| `src/layout/` | 页面骨架：侧边栏、更新提示、实时运行日志 |
| `src/views/` | 各模块页面(大的模块在同名子目录里拆组件) |
| `src/modules.ts` | 侧边栏模块列表，路由按它生成 |

和旧版界面的区别：

- 账户名单以服务端为准，浏览器里不再存账号和密码（旧版存在 localStorage）。导入走 `/api/accounts/upsert` 按账号名合并。
- 删除账户前会确认。
- 内购：购物车每个账号可展开逐件改数量；有「最近任务」列表。
- 买游戏：有「试运行」开关(只验证到最终价、不扣款，默认关)。
- UU 发货：行可展开看最近发货记录和日志；从账号行「绑定 Token」后短信登录拿到的 token 直接绑到这个账号。
- 停在库存 / 内购 / 买游戏 / 求购页时，账号登录、连 GC、余额变化会自动刷新相关列表。
