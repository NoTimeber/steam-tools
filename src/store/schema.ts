import type {Migration} from '../core/db.ts';

// 敏感列(密码、shared_secret、maFile、session、UU token)存的都是 vault 密文,
// 其余列明文,方便查询和排查。C5 app-key 是 settings 表里的一条 vault 密文(见 ./c5.ts)。
export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: 'credential-store',
		sql: `
			CREATE TABLE settings (
				key        TEXT PRIMARY KEY,
				value      TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			-- 账户名单(原 data/config/accounts.json)。position 保持名单顺序。
			CREATE TABLE accounts (
				account_key     TEXT PRIMARY KEY,
				account_name    TEXT NOT NULL,
				position        INTEGER NOT NULL,
				client_id       TEXT NOT NULL DEFAULT '',
				password        TEXT,
				shared_secret   TEXT,
				two_factor_code TEXT,
				remember        INTEGER NOT NULL DEFAULT 1,
				has_mafile      INTEGER NOT NULL DEFAULT 0,
				steam_id        TEXT NOT NULL DEFAULT '',
				country         TEXT NOT NULL DEFAULT '',
				balance         REAL,
				currency        INTEGER,
				has_wallet      INTEGER NOT NULL DEFAULT 0,
				active_game     TEXT NOT NULL DEFAULT 'cs2',
				source          TEXT NOT NULL DEFAULT '',
				updated_at      TEXT NOT NULL
			);

			-- maFile 全文(原 data/config/mafile/*.maFile)。
			CREATE TABLE mafiles (
				account_key  TEXT PRIMARY KEY,
				account_name TEXT NOT NULL,
				steam_id     TEXT NOT NULL DEFAULT '',
				data         TEXT NOT NULL,
				updated_at   TEXT NOT NULL
			);

			-- Steam 登录会话:refreshToken + cookies(原 data/sessions/*.json)。
			-- session_key 沿用旧文件名规则 safeName(accountName || steamID || attemptId)。
			CREATE TABLE steam_sessions (
				session_key  TEXT PRIMARY KEY,
				account_name TEXT NOT NULL DEFAULT '',
				steam_id     TEXT NOT NULL DEFAULT '',
				data         TEXT NOT NULL,
				updated_at   TEXT NOT NULL
			);

			-- 已获取的 UU token(原 data/uu/tokens.json)。id = UU userId,没有时用 token 哈希。
			CREATE TABLE uu_tokens (
				id              TEXT PRIMARY KEY,
				position        INTEGER NOT NULL,
				linked_steam_id TEXT NOT NULL DEFAULT '',
				data            TEXT NOT NULL,
				updated_at      TEXT NOT NULL
			);

			-- 账号的 UU 发货绑定与开关(原 data/uu/delivery-config.json)。token 列加密,其余配置明文 JSON。
			CREATE TABLE uu_delivery (
				account_name TEXT PRIMARY KEY,
				position     INTEGER NOT NULL,
				token        TEXT NOT NULL,
				config       TEXT NOT NULL,
				updated_at   TEXT NOT NULL
			);
		`
	},
	{
		version: 2,
		name: 'steam-login-intents',
		sql: `
			-- 哪些账号应当保持在线(重启后自动恢复登录用)
			CREATE TABLE steam_login_intents (
				account_key  TEXT PRIMARY KEY,
				account_name TEXT NOT NULL,
				want_online  INTEGER NOT NULL,
				updated_at   TEXT NOT NULL
			);
		`
	},
	{
		version: 3,
		name: 'c5-sweeper',
		sql: `
			-- C5 扫货的监控列表(原 c5 项目的 watchlist.toml)。整表替换,position 保持顺序。
			CREATE TABLE c5_watch_items (
				name       TEXT PRIMARY KEY,
				position   INTEGER NOT NULL,
				max_price  REAL NOT NULL,
				max_qty    INTEGER NOT NULL,
				max_spend  REAL NOT NULL DEFAULT 0,
				app_id     INTEGER NOT NULL DEFAULT 730,
				delivery   INTEGER NOT NULL DEFAULT 0,
				asset_type INTEGER NOT NULL DEFAULT 1,
				updated_at TEXT NOT NULL
			);

			-- C5 购买流水(原 c5 项目的 data/c5bot.sqlite)。数量和预算上限都从这里累计,重启不清零。
			-- 时间都是毫秒;product_id / order_id 是 64 位整数,按文本存(JS 数字放不下)。
			CREATE TABLE c5_purchases (
				out_trade_no      TEXT PRIMARY KEY,
				ts                INTEGER NOT NULL,
				mode              TEXT NOT NULL,
				name              TEXT NOT NULL,
				product_id        TEXT NOT NULL DEFAULT '',
				price             REAL NOT NULL,
				status            TEXT NOT NULL,
				order_id          TEXT,
				actual_pay        REAL,
				order_status      INTEGER,
				order_status_name TEXT,
				checked_at        INTEGER NOT NULL DEFAULT 0,
				error             TEXT
			);
			CREATE INDEX idx_c5_purchases_mode_status ON c5_purchases (mode, status);
		`
	},
	{
		version: 4,
		name: 'account-groups',
		sql: `
			-- 账户分组(账户管理里用户自己建的)。position 保持显示顺序,名字不分大小写不重复。
			CREATE TABLE account_groups (
				id         TEXT PRIMARY KEY,
				name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
				position   INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			);

			-- 账号在哪个分组(一个账号最多一个)。单独一张表:名单整表替换时不丢;删分组时连带删掉。
			CREATE TABLE account_group_members (
				account_key TEXT PRIMARY KEY,
				group_id    TEXT NOT NULL REFERENCES account_groups (id) ON DELETE CASCADE,
				updated_at  TEXT NOT NULL
			);
			CREATE INDEX idx_account_group_members_group ON account_group_members (group_id);
		`
	},
	{
		version: 5,
		name: 'proxy-usage',
		sql: `
			-- 代理用量:经代理的 Steam 网页请求按天(UTC)、代理、账号、请求类型累计次数和收发字节(估算)。
			-- account 是账号名小写,'' 为认不出账号的请求;kind 见 src/proxy/usage.ts。只留最近 90 天。
			CREATE TABLE proxy_usage (
				day      TEXT NOT NULL,
				proxy_id TEXT NOT NULL,
				account  TEXT NOT NULL,
				kind     TEXT NOT NULL,
				requests INTEGER NOT NULL DEFAULT 0,
				sent     INTEGER NOT NULL DEFAULT 0,
				received INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (day, proxy_id, account, kind)
			);
		`
	}
];
