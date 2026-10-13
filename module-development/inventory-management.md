# Inventory Management

Last updated: 2026-04-29

## Current UI

The `库存管理` module is now implemented.

Layout:

- top bar: connected-account count, item count, source, refresh action
- left panel: GC-connected account list
- right panel: selected account summary and inventory table

Current actions:

- `刷新库存`

## Account Source

Only accounts that are currently connected to CS2 GC are shown in this module.

The account list is driven by runtime attempt state from:

- `GET /api/attempts`

Each account card currently shows:

- account name
- country
- wallet balance
- current inventory count

## Inventory Loading Rules

Current loading behavior:

- account login success triggers `gamesPlayed(730)`
- `node-globaloffensive` emits `connectedToGC` when the CS2 GC session is ready
- once GC is ready, the account is eligible for the inventory module

Inventory fetch order:

1. try Steam community inventory endpoint
2. if that fails, fall back to GC in-memory inventory snapshot

Current HTTP endpoint used for community inventory:

- `/inventory/{steamId}/730/2`

This path was confirmed from the original program reference during reverse-analysis.

## Current Table Columns

- 饰品
- 类型
- 稀有度
- 磨损/外观
- 可交易
- 可交易时间

Current table display adjustments:

- removed `AssetID` from the visible table
- removed the `730` placeholder text when an item icon is unavailable
- suppressed noisy GC fallback subtitles such as `系列 375`

Current item source labels:

- `社区库存`: data came from Steam community inventory response
- `GC缓存`: data came from the `node-globaloffensive` in-memory GC inventory

When the source is `GC缓存`, item display data is now resolved from the local:

- `D:/csggooo/codex/dist/items_game.txt`
- optional container-name override from `D:/csggooo/codex/dist/node_modules/@protobufjs/locale/schema.json`
- official localization tokens from:
  - `D:/csggooo/codex/dist/steam-login-replica/data/csgo_schinese.txt`
  - `D:/csggooo/codex/dist/steam-login-replica/data/csgo_english.txt`

Implemented schema resolution:

- merge repeated top-level `items`, `paint_kits`, `sticker_kits`, `prefabs`
- resolve prefab inheritance before rendering item type/name
- map `def_index`, `paint_index`, graffiti/sticker kit ids into readable item names
- expose parsed fields on each normalized item so the detail panel can show both parsed and raw data

Current limitation:

- localized names now prefer official CS localization tokens when a matching token exists
- some container names in local `items_game.txt` are stale, and some current market names do not map cleanly back to an official Chinese token
- in those stale/mismatched cases, community inventory remains the most reliable source for exact current official naming

## Runtime State Added To Accounts

The `账户管理` module now also carries GC runtime fields:

- `GC连接`
- inventory item count
- inventory source

`GC连接` is based on the actual `connectedToGC` / `disconnectedFromGC` event stream.

## Backend Integration

New server-side pieces added for this module:

- `GET /api/attempts`
- `GET /api/inventory/:id`

Current frontend raw info panels:

- `当前饰品完整信息`
- `库存完整返回`

Panel behavior:

- `当前饰品完整信息`: selected normalized item object, including parsed schema fields and nested `raw`
- `库存完整返回`: full module payload, including raw GC item payloads or raw community inventory pages

Runtime integrations:

- `globaloffensive`
- `steam-user`

Current server behavior:

- after `loggedOn`, the account launches app `730`
- WebSession cookies are requested for community inventory access
- GC item updates refresh the in-memory inventory snapshot
- community inventory name display now prefers localized market/community name fields before `market_hash_name`

## GC Fallback Filtering

The raw `csgo.inventory` payload is not equal to the user's visible CS2 inventory.

Current GC fallback display filtering removes:

- preview/xray-style entries with `flags & 24`
- free-reward placeholder entries with `origin === 24` and attribute `277`
- casket-contained items

Practical result:

- the visible inventory table stays aligned with the actual owned CS2 inventory
- the raw panel still keeps the complete unfiltered GC return for debugging

## Reference Notes

Reference inputs used for implementation:

- original program binary via IDA MCP
- local extracted source artifact `D:/csggooo/codex/dist/data/inventory-sync.js`
- `DoctorMcKay/node-globaloffensive`
- `Citrinate/CS2Interface`

Practical conclusion used in this module:

- real GC connection state comes from `node-globaloffensive`
- display inventory can safely use Steam inventory endpoint when cookies are available
- GC memory snapshot is a usable fallback when community inventory is unavailable
