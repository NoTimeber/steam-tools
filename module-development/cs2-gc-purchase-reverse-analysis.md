# CS2 GC Purchase Reverse Analysis

Last updated: 2026-04-29

## Goal

This note records the reverse-analysis result for the real `CS2` in-game purchase flow.

Important correction:

- the current `purchase-management.md` implementation is only a local simulated deduction flow
- the original program's `CS2` purchase is not the Steam store web checkout path
- the real path is a `GC` purchase flow

## Files Inspected

- `D:\csggooo\codex\dist\extracted\app.dec.js`
- `D:\csggooo\codex\dist\extracted\server.blob`
- `D:\csggooo\codex\dist\extracted\license.src.js`
- `D:\csggooo\codex\dist\node_modules\globaloffensive\language.js`
- `D:\csggooo\codex\dist\node_modules\globaloffensive\protobufs\base_gcmessages.proto`
- `D:\csggooo\codex\dist\node_modules\steam-user\components\gamecoordinator.js`
- `D:\csggooo\codex\dist\tf2-store-debug.log`

## Confirmed Frontend Flow

The original frontend already exposes the CS2 purchase orchestration shape very clearly.

### 1. Account list

`cs2RefreshAccounts()` calls:

- `GET /api/cs2/online-accounts`

The returned account objects are used with fields consistent with:

- `account`
- `balance`
- `currency`
- `currencyISO`
- `country`

The frontend also reacts to runtime account updates:

- if an account's `currencyISO` changes, the cart price for that account is recalculated

### 2. Item catalog

`loadCS2Items()` and `refreshCS2Items()` show the catalog flow:

- `GET /api/cs2/items`
- `POST /api/cs2/refresh-items`
- `GET /api/cs2/refresh-rates`

Local frontend processing:

- `buildCS2PricesMap(list)` stores `prices` by `def_index`
- `getCS2Price(defIndex, currencyISO)` reads `prices[currencyISO]`, then falls back to `USD`

This means the backend does not return a single fixed price.
It returns a multi-currency price table per `def_index`.

### 3. Cart structure

The cart is maintained per account in `cs2Cart`.

When an item is added, the frontend:

- picks the account's `currencyISO`
- calls `getCS2Price(defIndex, currencyISO)`
- stores the chosen per-account price into `priceCents`

### 4. Submit payload

`startCS2Purchase()` builds the final payload as:

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

It then sends:

- `POST /api/task/cs2-purchase`

This part is confirmed from the original frontend code.

## Confirmed Backend Task Shape

The original backend bytecode still exposes key CS2 purchase fields in `server.blob`.

Confirmed strings:

- `./core/cs2-worker`
- `CS2IdleWorker`
- `cs2_purchase`
- `item_def_id`
- `item_name`
- `cost_in_local_currency`
- `quantity_per_account`

`license.src.js` also contains:

- `cs2-worker:purchase`

This confirms:

- the real purchase logic lives in a dedicated CS2 worker
- the worker is not a pure frontend mock
- the worker accepts normalized purchase item data that matches the frontend cart payload after field conversion

## Confirmed GC Protocol

The local `globaloffensive` package contains the CS2/CS:GO GC purchase message IDs and protobuf definitions.

### Message IDs

From `node_modules/globaloffensive/language.js`:

- `StoreGetUserData = 2500`
- `StoreGetUserDataResponse = 2501`
- `StorePurchaseFinalize = 2504`
- `StorePurchaseFinalizeResponse = 2505`
- `StorePurchaseInit = 2510`
- `StorePurchaseInitResponse = 2511`

### Purchase protobufs

From `node_modules/globaloffensive/protobufs/base_gcmessages.proto`:

`CGCStorePurchaseInit_LineItem`:

- `item_def_id`
- `quantity`
- `cost_in_local_currency`
- `purchase_type`

`CMsgGCStorePurchaseInit`:

- `country`
- `language`
- `currency`
- `line_items`

`CMsgGCStorePurchaseInitResponse`:

- `result`
- `txn_id`
- `url`
- `item_ids`

`CMsgGCStorePurchaseFinalize`:

- `txn_id`

`CMsgGCStorePurchaseFinalizeResponse`:

- `result`
- `item_ids`

### Catalog / price-sheet protobufs

Also from `base_gcmessages.proto`:

`CMsgStoreGetUserData`:

- `price_sheet_version`
- `currency`

`CMsgStoreGetUserDataResponse`:

- `result`
- `currency_deprecated`
- `country_deprecated`
- `price_sheet_version`
- `price_sheet`

This is the strongest protocol-level evidence for how the original program queries the purchase catalog:

- it first asks GC for store user data
- GC returns a `price_sheet`
- the item catalog prices are then derived from that `price_sheet`

## Price Sheet Parsing Reference

The patched local `steam-user` implementation contains a working direct-store reference in:

- `node_modules/steam-user/components/gamecoordinator.js`

For TF2, it does the following:

1. `sendToGC(appid, 2500, ...)` for `StoreGetUserData`
2. decode `CMsgStoreGetUserDataResponse`
3. read `price_sheet`
4. parse the blob with:
   - `lzma-native`
   - `binarykvparser`
5. cache per-currency prices by `item_def_id`
6. send purchase init
7. receive `txn_id`
8. send purchase finalize
9. receive `item_ids`

The debug log `tf2-store-debug.log` confirms that the real direct purchase flow is:

1. `DirectStorePurchaseInit`
2. `DirectStorePurchaseInitResponse`
3. `DirectStorePurchaseFinalizeResponse`

For CS2, the exact app and schema differ, but the store purchase pattern matches the CS2 protobufs above.

## Real CS2 Purchase Flow

Based on the original frontend, the original backend task fields, and the local CS2 GC protobufs, the real CS2 purchase flow should be:

1. Ensure the account is already online and has a live CS2 GC session.
2. Query the account's store state from GC with `StoreGetUserData (2500)`.
3. Read `price_sheet_version` and `price_sheet` from `StoreGetUserDataResponse (2501)`.
4. Parse the `price_sheet` into a per-item, per-currency catalog.
5. Build `line_items` from frontend `cartData`:
   - `itemDefId -> item_def_id`
   - `costInLocalCurrency -> cost_in_local_currency`
   - `quantity -> quantity`
6. Fill purchase header fields:
   - `country`
   - `language`
   - `currency`
7. Publish `StorePurchaseInit (2510)` to GC.
8. Read `txn_id` from `StorePurchaseInitResponse (2511)`.
9. Publish `StorePurchaseFinalize (2504)` with that `txn_id`.
10. Read `item_ids` and `result` from `StorePurchaseFinalizeResponse (2505)`.
11. Mark the task success or failure and refresh wallet / inventory state.

## Important Implementation Conclusion

The current replica module is not source-aligned because it stops at:

- local item presets
- local price conversion
- local balance deduction

The replacement implementation needs to switch to:

- original endpoints and task shape
- per-account GC store query
- real `price_sheet` parsing
- real `StorePurchaseInit`
- real `StorePurchaseFinalize`

## Confirmed vs Inferred

Confirmed:

- frontend endpoints and payload shape
- original backend worker name and task field names
- CS2 GC message IDs
- CS2 purchase protobuf structure
- GC store catalog is available through `StoreGetUserDataResponse.price_sheet`

High-confidence inference:

- the original `./core/cs2-worker` queries the CS2 store catalog from GC, not from the Steam store checkout web flow
- the worker converts frontend `cartData` into `CMsgGCStorePurchaseInit.line_items`
- the worker completes purchase by sending `StorePurchaseFinalize` after receiving `txn_id`

Still needs live verification:

- whether the original CS2 worker always includes `purchase_type`
- whether it uses only `StoreGetUserData.price_sheet`, or also an extra CS2 sales-data probe
- exact logging / retry behavior around insufficient funds, stale price sheet, or currency mismatch

## Next Coding Work

Next implementation stage in `steam-login-replica` should do all of the following:

1. Remove the current simulated deduction path from the CS2 purchase module.
2. Reuse `globaloffensive` + `steam-user` GC session state for each online account.
3. Add a real CS2 store service:
   - query `StoreGetUserData`
   - parse and cache `price_sheet`
   - expose the parsed catalog to `/api/cs2/items`
4. Replace task execution with real GC order submission:
   - `StorePurchaseInit`
   - `StorePurchaseFinalize`
5. Return real `txn_id`, `item_ids`, and GC result codes in task logs.

