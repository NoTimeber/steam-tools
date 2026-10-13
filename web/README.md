# 新版前端

Vue 3 + Naive UI + TypeScript，用 Vite 构建。构建产物 `web/dist` 由服务端挂在 **`/next/`** 下，和旧版界面（`app/public`，挂在 `/`）并存。模块一个一个迁过来，全部迁完后再把 `/` 换成新版。

已迁移：账户管理、库存管理、内购任务、买游戏、运行设置。其余模块在侧边栏标着「(旧版)」，点进去会引导回旧版界面。

## 开发

需要 Node 24 及以上。前端有自己的 `package.json`，依赖装在 `web/node_modules`，和服务端的分开。

```bash
cd web
npm install
npm run dev         # http://127.0.0.1:5173 ,接口和 socket.io 转给 127.0.0.1:53110
npm run build       # 产物在 web/dist,服务端在 /next/ 下提供
npm run typecheck   # vue-tsc
npm test            # src/**/*.test.ts(纯逻辑,node:test)
```

开发时服务端可以用离线演示服务，不碰真实账号（假 Steam，见 [test/demo/server.ts](../test/demo/server.ts)）：

```bash
node test/demo/server.ts
```

先打开 `http://127.0.0.1:53110/login` 登录（演示口令见那个文件开头），再打开 `http://127.0.0.1:5173`：cookie 按主机名共享、不分端口，开发服务器转发的请求带着它。

## 结构

| 目录 | 内容 |
|---|---|
| `src/api/` | 调接口(`http.ts`,401 跳登录页)、socket.io 连接、后端数据类型 |
| `src/stores/` | 全局状态：账户列表(名单 + 账号资料 + 实时会话)、运行日志、远程更新 |
| `src/lib/` | 不依赖 Vue 的纯逻辑，带单元测试 |
| `src/layout/` | 页面骨架：侧边栏、更新提示、实时运行日志 |
| `src/views/` | 各模块页面；没迁的模块走 `LegacyView.vue` |
| `src/modules.ts` | 侧边栏模块列表；迁好一个模块就在这里挂上页面 |

和旧版的区别：

- 账户名单以服务端为准，浏览器里不再存账号和密码（旧版存在 localStorage）。导入走 `/api/accounts/upsert` 按账号名合并，不会和旧版界面互相覆盖整份名单。
- 删除账户前会确认。
