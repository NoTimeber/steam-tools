import type {Migration} from '../core/db.ts';

// 敏感列(密码、shared_secret、maFile、session、UU token)存的都是 vault 密文,
// 其余列明文,方便查询和排查。
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
	}
];
