# CS2 Purchase Implementation Log

Date: 2026-04-30

## Goal

将 `steam-login-replica` 的第三个模块 `内购任务` 从本地模拟扣款切换为真实 `CS2 GC` 下单。

## Confirmed Inputs

已确认的原程序链路：

- 商品目录不是本地预设
- 商品目录来自 `StoreGetUserData -> price_sheet`
- 下单不是 Steam 商店网页
- 下单走 `GC StorePurchaseInit / StorePurchaseFinalize`

已确认的当前项目基础：

- 已有 `steam-user` 登录态
- 已有 `globaloffensive` GC 会话
- 已有 `wallet` 事件维护余额与币种
- 现有购买页面和任务列表可以复用

## Implementation Strategy

为了减少前端返工，先保留当前购买页面和 `/api/purchase/*` 路由。

同时补充原程序兼容接口：

- `/api/cs2/*`
- `/api/task/cs2-purchase`

这样当前页面能继续跑，后续如果需要对齐原程序前端，也不必再改后端核心。

## Code Changes

### 1. Remove simulated catalog model

删除了：

- 本地汇率表
- 本地商品预设
- `USD -> 多币种` 的伪价格换算

替换为：

- 选取一个已连接 `GC` 的在线账号
- 发 `StoreGetUserData`
- 解码并解析真实 `price_sheet`
- 从 `store.entries` 和 `store.inventoryvalvegcpricesheet` 生成目录

### 2. Add real GC request helpers

新增了统一 `sendCs2GcRequest(...)`：

- 使用 `attempt.client.sendToGC(...)`
- 校验回包 `appid`
- 校验回包 `msgType`
- 按 protobuf 解码
- 支持超时失败

### 3. Add price_sheet parser

实现方式：

- 优先按原始 BinaryKV 解析
- 若不是 raw BinaryKV，则尝试 `lzma-native` 解压
- 解压后用 `binarykvparser` 解析

为便于后续实机校验，解析后的原始数据会保存到：

- `data/price-sheets/`

### 4. Replace simulated task worker

原来的执行逻辑是：

- 校验余额
- 本地减 `attempt.balance`

现在改为：

1. 每个账号重新查询自己的 `price_sheet`
2. 按账号币种重算价格
3. 构造 `line_items`
4. 发 `StorePurchaseInit`
5. 取 `txn_id`
6. 发 `StorePurchaseFinalize`
7. 记录 `item_ids`

### 5. Keep frontend payload stable

当前前端购物车 payload 没改：

```json
{
  "cartData": {
    "accountA": [
      {
        "itemDefId": 4758,
        "costInLocalCurrency": 1499,
        "quantity": 1
      }
    ]
  }
}
```

注意：

- 前端这里保存的是单价
- 后端发送给 `GC` 时转换为整行总价

## Validation

已完成：

- `node --check server.js`

未完成：

- 实机在线账号联调
- 真实 `price_sheet` 样本校验
- 真实 `PurchaseInit/Finalize` 成功日志验证

## Current Risks

- `price_sheet` 的字段结构虽然大概率与 TF2 类似，但仍需用真实 CS2 样本验证
- `PurchaseInit.language` 当前先固定为 `6`
- `wallet` 余额刷新依赖 Steam 异步推送，交易成功后未必立刻拿到 `balanceAfter`

## Next Suggested Step

下一步最有价值的是用一个真实在线账号测试以下三件事：

1. `/api/purchase/items` 是否能拉到真实目录
2. 是否能正确映射 `def_index -> prices`
3. `PurchaseInit/Finalize` 返回的 `result / txn_id / item_ids` 是否符合预期
