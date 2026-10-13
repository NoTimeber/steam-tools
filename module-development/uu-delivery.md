# UU发货 (UU Delivery)

## Current UI

Section `#module-uu` in `app/public/index.html`.

Top statistics:

- `账号` — number of token-bound accounts
- `已绑定` — accounts with a valid UU token
- `在线` — online / total, where online means "ready to deliver"
- `累计发货` — sum of delivered across CS2 + TF2
- `轮询` — poll interval

Toolbar actions:

- 轮询间隔 + `保存`
- `获取 Token`

The list is a flex-row list (`.uu-row`), not a `<table>`. Columns:

`账号 | UU昵称 | 在线状态 | 发货状态 | 开关 | 统计 | 操作`

## Driving Model

**The list is driven by UU tokens, not by online Steam accounts.**

The user obtains a token themselves (SMS login or manual paste). Each token carries a
`linkedSteamId` — the Steam account bound on the UU side. That SteamID is compared against
the accounts in 账户管理 to decide which local account the token belongs to.

Online status is only a *hint* on the row. It never decides whether a row appears.

Consequences:

- an offline account with a token still appears, with a `离线` hint and a `登录账户` button
- an online account with no token does **not** appear — being online is not a reason to bind UU
- a token whose SteamID matches nothing local appears as its own row, so the user gets
  feedback instead of silence after acquiring a token

## Token → Account Matching

Client-side, `autoBindMatchedTokens` (`app/public/app.js`):

```js
const matchedAccount = attempts.find(a => a.steamID === t.linkedSteamId);
```

`attempts` here is `state.accounts` — the 账户管理 list, which persists `steamID` per account.
So matching works for offline accounts too, as long as the account has logged in at least once
and a `steamID` was stored. An account that has never logged in has no known SteamID and
cannot be matched.

Server-side `verifyUuSmsLogin` also attempts a match via `findAttemptBySteamId`, but that only
sees in-memory login attempts, so the client-side path is the reliable one.

`publicUuAccount` exposes `userId` so the frontend can tell which entries in `tokens.json`
are already represented by an account row and which are still unmatched.

## Online Status Rules

The row badge comes from the backend `online` field, produced by `uuAttemptReadiness` →
`findPurchaseAttemptByAccount` → `isAttemptOnlineForPurchase`
(`PURCHASE_ONLINE_STATUSES = logged_on | web_session | web_session_pending`).

This is deliberately **not** the 账户管理 display status. That status is sticky — once
`登录成功` it never falls back to offline even if the Steam client disconnects (see
`collapseAttemptStatus`), so using it here would show `在线` for a session that cannot deliver.

Badge states:

- `在线` — ready
- `在线·缺 cookies` — online but no WebSession cookies
- `在线·缺 maFile` — online but no `identity_secret`
- `离线` — no usable attempt; row shows a `登录账户` button
- `账户管理无此账号` — the bound account name is not in the local account list

## 登录账户 Button

Calls `loginAccount(local, {force: true})` then refreshes UU state.

`force` is required: the row's offline verdict comes from the backend readiness check, while
the local account status may still be stuck at `登录成功` due to stickiness. Without `force`
the duplicate-login guard in `loginAccount` (see `account-management.md`) would reject the
very reconnect the user is asking for.

## Token Acquisition

Both paths are account-agnostic — neither requires picking an online account first:

- SMS login → `POST /api/uu/login/start` → `POST /api/uu/login/verify`
- manual paste → `POST /api/uu/token/acquire`

Both persist to `data/uu/tokens.json` (deduped by `userId`), after which
`refreshUuTokens` → `autoBindMatchedTokens` performs the SteamID match and binds.

`POST /api/uu/bind` with an explicit `accountName` still exists for direct binding.

## Delivery Gate

`runUuDeliveryPass` refuses to deliver unless `uuAttemptReadiness` reports
`online + hasCookies + hasIdentitySecret`. The failure reason goes to the `uu:log` socket and
the global log panel; the row badge is the at-a-glance version of the same condition.

## Current APIs Used By This Module

- `GET /api/uu/state`
- `GET /api/uu/tokens`
- `POST /api/uu/bind`
- `POST /api/uu/token/acquire`
- `DELETE /api/uu/token` (by `accountName` or by `token`)
- `POST /api/uu/auto`
- `POST /api/uu/scan`
- `POST /api/uu/list/auto`
- `POST /api/uu/list/scan`
- `POST /api/uu/poll-interval`
- `POST /api/uu/login/start` / `verify` / `cancel`
- sockets: `uu:update`, `uu:log`

## Next Development Baseline

If later changes are made to this module, update this file first for:

- changes to what drives the row list (currently: tokens, not online accounts)
- changes to token → account matching
- changes to the online/readiness rules
- new toolbar or row actions
- backend endpoint changes
