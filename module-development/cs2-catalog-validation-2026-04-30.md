# CS2 Catalog Validation 2026-04-30

## Background

在 `steam-login-replica` 中，CS2 内购已经改成真实 `GC` 链路：

- 目录查询：`StoreGetUserData (2500)`
- 下单初始化：`StorePurchaseInit (2510)`
- 下单确认：`StorePurchaseFinalize (2504)`

本次工作的目标是验证“能否拉到真实目录”，并修复目录为空的问题。

## Root Cause

真实 `price_sheet` 已经成功从 `GC` 返回并解码，但目录接口最初返回：

- `count = 0`

实际根因有两点：

1. 当前账号返回的真实 CS2 `price_sheet` 中，主商品目录在：
   - `store.entries`

2. 每个条目的价格直接位于：
   - `entry.prices`

而不是必须依赖：

- `store.inventoryvalvegcpricesheet`

另外，`USD` 字段不是普通数字，而是类似：

```json
{
  "low": 199,
  "high": 0,
  "unsigned": true
}
```

旧实现没有把这种结构规整成数值，导致价格映射丢失。

## Fix

修复文件：

- `steam-login-replica/server.js`

修复内容：

1. `resolvePricesForStoreEntry()` 直接读取 `entry.prices`
2. `extractPriceMapFromNode()` 支持 `node.prices`
3. 新增 `normalizePriceValue()`，统一处理：
   - number
   - string
   - bigint
   - `{ low, high, unsigned }`

## Validation

重启最新服务后，重新登录账号：

- `account = ahij4889`
- `currencyISO = UYU`
- `gcConnected = true`

验证接口：

- `GET /api/purchase/items`

结果：

- `success = true`
- `count = 236`
- `source = gc`
- `priceSheetVersion = 1777415070`

示例商品：

- `1200` `吊称标签`
- `1203` `反恐精英武器箱钥匙`
- `1324` `StatTrak 交换工具`
- `1354` `XpShopTicket1`
- `4950` `Remove Keychain Tool Pack`

说明当前已经可以从真实 `GC` 拉到完整商品目录。

## Notes

这次验证说明：

1. `StoreGetUserData -> price_sheet` 这条真实目录链路已经可用
2. 当前目录构建不再是“模拟目录”
3. 下一步可以继续验证真实下单：
   - `StorePurchaseInit`
   - `StorePurchaseFinalize`

