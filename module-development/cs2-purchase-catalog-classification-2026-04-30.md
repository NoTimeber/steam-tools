# CS2 Purchase Catalog Classification Log

Date: 2026-04-30

## Goal

将 `steam-login-replica` 内购模块的真实 `GC` 商品目录统一整理为以下五类：

- `工具`
- `钥匙`
- `音乐盒`
- `胶囊`
- `印花`

并确保关键工具项使用明确中文名展示。

## Confirmed Inputs

本次分类基于真实接口：

- `GET /api/purchase/items`
- 来源账号：`ahij4889`
- 来源链路：`GC StoreGetUserData -> price_sheet`

用户额外确认：

- `XpShopTicket1` 就是 `武库通行证`

## Implemented Changes

### 1. Backend classification normalization

在 `server.js` 新增目录分类逻辑，统一在后端输出最终类型：

- `工具`
- `钥匙`
- `音乐盒`
- `胶囊`
- `印花`

分类依据：

- 工具类优先按 `def_index`、`tool.type`、`prefab`
- 其余优先按名称、内部名、`loot_list_name`、`image_inventory`

### 2. Explicit tool name mapping

对关键工具项增加明确映射：

- `1200 -> 名称标签`
- `1201 -> 库存存储组件`
- `1324 -> StatTrak™ 数据互换器`
- `1354 -> 武库通行证`
- `4000 -> 印花展示柜`
- `4950 -> 钥匙扣拆卸工具包`

### 3. Edge item folding

将不适合散落在默认 `Misc` 的目录项折叠回五类：

- 各类 `Coupon ... Musickit ...` 归入 `音乐盒`
- 各类 `Sticker Capsule / 印花胶囊 / 收藏胸章胶囊` 归入 `胶囊`
- `涂鸦箱`、`X 射线包裹` 也归入 `胶囊`
- 单张 `印花 / 布章` 归入 `印花`

### 4. Catalog sorting

目录排序改为：

1. `工具`
2. `钥匙`
3. `音乐盒`
4. `胶囊`
5. `印花`

分类内再按名称排序。

### 5. Frontend grouped rendering

前端商品表改为按分类插入分组行：

- 搜索后仍按过滤结果分组
- 行内副标题显示 `type`
- 第二列显示 `category`

## Validation

已完成：

- `node --check server.js`
- 真实 `GET /api/purchase/items` 回查

重点核验项：

- `1354` 不再显示 `XpShopTicket1`
- `1354` 现在显示为 `武库通行证`
- 目录输出按五大类排序
- 前端表格支持分类分组显示

## Notes

本次仅调整目录分类与展示，不改动真实下单链路：

- `StorePurchaseInit`
- `StorePurchaseFinalize`

购买请求仍保持走 `GC` 真实下单。
