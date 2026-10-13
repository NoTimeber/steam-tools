# 价目表样本

GC 商店价目表样本（`StoreGetUserDataResponse.price_sheet` 解压后的 BinaryKV），由运行时的价目表留样功能导出，供解析回归测试使用。

| 文件 | 内容 |
|---|---|
| `cs2-usd.bkv` | CS2 价目表，美元钱包账号取得，250 个商店条目，含 37 个币种价格 |
| `tf2-usd.bkv` | TF2 价目表，美元钱包账号取得，1337 个商店条目 + 按价位的全币种价格表 |
| `*.expected.json` | 用重构前 `app/server.js` 里原样的解析函数，在样本上算出的结果 |

价目表是 Steam 商店的全局数据，不含账号信息；文件名已去掉导出时带的账号名。

`*.expected.json` 里有三部分：

- `entryDefIndex`：条目名到 defIndex 的对应关系。旧代码靠物品 schema 解析，测试里直接复用这份结果。
- `order` 和 `itemDigests`：每个商品的顺序，以及各币种价格的摘要。
- `spot`：几个商品的完整价格，方便出错时直接对照。

新实现（`src/steam/price-sheet.ts`）必须和快照逐项一致。只有确认是有意改变解析结果时才更新快照。

## 重新生成快照

快照由 [make-snapshot.cjs](make-snapshot.cjs) 生成。它从旧版 `server.js` 里原样取出解析函数来跑；这些函数在 `da1808e` 之后已经移到 `src/steam/price-sheet.ts`。

```bash
git show da1808e:app/server.js > /tmp/legacy-server.js
node test/fixtures/price-sheets/make-snapshot.cjs . /tmp/legacy-server.js test/fixtures/price-sheets/cs2-usd.bkv cs2 test/fixtures/price-sheets/cs2-usd.expected.json
```

## 与旧代码的一处有意差异

旧代码判断「节点上的键是不是币种」时，用的是钱包币种推国家的那张表，而那张表故意不含 USD。结果商品节点上直接写着的 USD 价格会被丢掉。

新实现把 USD 补进了价目表的币种白名单。两份真实样本里的 USD 价格都在 `prices` 子表或价位表里，不走这条路径，所以快照不受影响。
