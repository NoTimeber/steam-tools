# Account Management

Last updated: 2026-04-28

## Current UI

The `账户管理` module is the active work surface.

Layout:

- Left sidebar: module navigation
- Center: account list and toolbar
- Right: runtime result log

Top toolbar actions:

- `导入账户`
- `导入 maFile`
- `登录选中`
- `登出选中`
- `删除选中`

Top statistics:

- total account count
- online count
- offline count
- selected count

## Account Import

### Import account

`导入账户` opens a modal input box.

Expected format:

```text
account1----password1
account2----password2
```

Rules:

- one account per line
- separator is `----`
- invalid lines are rejected with line-number feedback

### Import maFile

`导入 maFile` accepts multiple `.maFile` or `.json` files.

Imported fields currently used:

- `account_name`
- `shared_secret`
- optional `password`

## Account List

Current columns:

- checkbox
- 账号
- maFile
- 状态
- GC连接
- 国家
- 余额
- SteamID
- GC操作

Removed from the list:

- cookies
- nickname
- row action column

`maFile` column meaning:

- `有`: local or imported maFile is available
- `无`: no maFile detected for that account

`maFile` column action:

- `验证码`: read the current Steam login TOTP from `shared_secret`

`GC连接` column meaning:

- `已连接`: current runtime session has connected to CS2 GC
- `未连接`: no active GC session for this account

`GC操作` column actions:

- `连接GC`: request launching app `730` for the logged-in account
- `取消连接`: request leaving app `730` while keeping the Steam login session

## Status Rules

The center table uses result-oriented login status instead of verbose runtime states.

Displayed states:

- `未登录`
- `登录中`
- `登录成功`
- `登录失败`

Online/offline counters are derived from these rules:

- `登录成功` => online
- all other states => offline

## Runtime Log

The right log panel only keeps meaningful login result output.

Current retained result lines:

- login success
- login failure
- GC connection success/disconnect
- manual actions such as import, logout, delete

Verbose runtime steps are intentionally suppressed in the frontend view.

## Backend Integration

The server reads local shared data from the parent `config` directory.

Current local sources:

- `../config/mafile/<account>.maFile`
- `../config/cookies/<account>.json`
- `../config/data/account_cache.json`

Used data:

- `shared_secret`
- optional refresh token
- cached wallet currency / currency ISO
- cached wallet balance and currency

## Login Flow Notes

Current behavior:

- login can auto-fill `shared_secret` from local maFile
- account `国家` no longer uses `steam-user` GeoIP country directly
- displayed `国家` is treated as account region, resolved from wallet currency when possible
- `accountInfo.country` is only the current login GeoIP region and is not shown in the account table
- account wallet balance is pushed to the frontend
- login success triggers `gamesPlayed(730)` for CS2 GC connection
- account runtime state is refreshed from `GET /api/attempts` after page load
- first-time missing `machineAuthToken.<account>.txt` debug noise is filtered
- when Steam directory lookup fails, the server falls back to `cm0.steampowered.com:443`
- duplicate login is blocked in `loginAccount`: an account holding an `attemptId` whose
  normalized status is `登录成功` or `登录中` is skipped with a warning log.
- since 2026-10 the server enforces one session per account as well
  (`src/steam/session-manager.ts`): `POST /api/login` returns the existing attempt
  (`reused: true`) while the account is connecting/online, and creating a new attempt
  logs off and removes the account's previous one. `force: true` forces a fresh login
  (the UU row's `登录账户` button sends it).
- the server remembers which accounts should stay online (`steam_login_intents` table)
  and restores them after a restart, refreshToken first, then password + maFile code.
  Manual logout, account deletion and fatal errors (LoggedInElsewhere, InvalidPassword…)
  clear the intent.

Current logout behavior:

- selected accounts can be batch logged out
- local UI status is reset to `未登录`

Current delete behavior:

- selected accounts can be batch removed from the current list
- deleted accounts ignore late runtime updates so they do not reappear immediately

## Current APIs Used By This Module

- `POST /api/accounts/meta`
- `POST /api/auth-code`
- `POST /api/login`
- `POST /api/login-refresh`
- `POST /api/guard/:id`
- `POST /api/logout/:id`
- `POST /api/gc/connect/:id`
- `POST /api/gc/disconnect/:id`
- `GET /api/attempts`
- `GET /api/health`

## Next Development Baseline

If later changes are made to this module, update this file first for:

- new toolbar actions
- changed status rules
- new columns
- login/session handling changes
- backend data source changes
