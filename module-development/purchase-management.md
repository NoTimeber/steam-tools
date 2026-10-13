# Purchase Management

Last updated: 2026-04-30

## Current Scope

`steam-login-replica` 的 `内购任务` 模块已经切换为真实 `CS2 GC` 购买链路。

当前实现目标：

- 复刻原程序的 `CS2` 内购编排方式
- 继续保留账户选择、商品目录、按账号购物车、异步任务执行
- 使用已登录的 `steam-user + globaloffensive` 运行时直接向 `GC` 查询目录并发起下单

当前非目标：

- 不做 Steam 商店网页 checkout
- 不再使用本地商品预设和模拟扣款

## Current Backend APIs

当前页面仍使用：

- `GET /api/purchase/online-accounts`
- `GET /api/purchase/items`
- `POST /api/purchase/refresh-items`
- `POST /api/purchase/refresh-rates`
- `GET /api/purchase/tasks`
- `POST /api/purchase/tasks`

为对齐原程序，同时补了兼容入口：

- `GET /api/cs2/online-accounts`
- `GET /api/cs2/items`
- `POST /api/cs2/refresh-items`
- `GET /api/cs2/refresh-rates`
- `POST /api/task/cs2-purchase`

当前 socket 事件保持不变：

- `purchase:task-created`
- `purchase:task-updated`
- `purchase:task-completed`

## Catalog Source

当前商品目录不再来自本地预设。

实际流程：

1. 选择一个在线且已连接 `GC` 的账号
2. 发送 `StoreGetUserData (2500)`
3. 解码 `CMsgStoreGetUserDataResponse (2501)`
4. 解析 `price_sheet`
5. 从 `store.entries` 与 `store.inventoryvalvegcpricesheet` 组装 `def_index -> prices`

当前实现会把解析后的 `price_sheet` dump 到：

- `data/price-sheets/`

这样后续可以直接拿真实样本继续修正解析细节。

## Purchase Execution

当前每个账号的执行步骤：

1. 校验账号在线、钱包可用、`GC` 已连接
2. 再次查询该账号的最新 `price_sheet`
3. 按该账号币种重算购物车商品价格
4. 组装 `CMsgGCStorePurchaseInit.line_items`
5. 发送 `StorePurchaseInit (2510)`
6. 读取 `txn_id`
7. 发送 `StorePurchaseFinalize (2504)`
8. 读取 `result` 和 `item_ids`
9. 输出任务日志并等待 `wallet` 事件更新余额

重要实现细节：

- 前端 `cartData.costInLocalCurrency` 仍沿用原页面的“单价”字段
- 后端发送给 `GC` 时会转换成“单行总价”

## Runtime Integration

该模块继续复用 `server.js` 现有运行时：

- `attempts` map
- `attempt.client`
- `attempt.csgo`
- `attempt.gcConnected`
- `wallet` 事件中的币种与余额

当前展示行为：

- 只有运行时在线账号会出现在内购列表
- 商品价格优先显示当前选择账号的币种
- 任务成功后会记录真实 `txn_id` 和返回的 `item_ids`

## Current Limitation

当前版本已经是真实 `GC` 下单，不再是模拟器。

仍然存在的限制：

- `price_sheet` 的字段结构目前按 TF2/CS2 通用 BinaryKV 方式解析，真实样本覆盖后还可以继续收紧规则
- 购买完成后的余额刷新依赖 Steam 推送 `wallet` 事件，若未及时推送，任务仍会成功但 `balanceAfter` 可能为空
- 当前没有在任务完成后主动刷新库存页，只依赖现有 `GC itemAcquired/itemChanged` 事件

## Relevant Files

- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `server.js`
- `src/items/schema.ts`(原 `items-game-schema.js`)
- `module-development/cs2-gc-purchase-reverse-analysis.md`
