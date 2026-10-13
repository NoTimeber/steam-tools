// 凭据数据层入口:打开数据库、加载主密钥、跑迁移、导入旧版 JSON。
// 旧代码(app/server.js,CommonJS)通过 require('../src/store/index.ts') 使用。

import {join} from 'node:path';
import {migrate, openDatabase} from '../core/db.ts';
import type {Db} from '../core/db.ts';
import {createVault, loadMasterKey, VaultError} from '../core/vault.ts';
import type {Vault} from '../core/vault.ts';
import {createAccountStore} from './accounts.ts';
import type {AccountStore} from './accounts.ts';
import {importLegacyFiles} from './legacy-import.ts';
import type {ImportReport, LegacyPaths} from './legacy-import.ts';
import {createMaFileStore} from './mafiles.ts';
import type {MaFileStore} from './mafiles.ts';
import {MIGRATIONS} from './schema.ts';
import {createSettingsStore} from './settings.ts';
import type {SettingsStore} from './settings.ts';
import {createSteamSessionStore} from './steam-sessions.ts';
import type {SteamSessionStore} from './steam-sessions.ts';
import {createUuStore} from './uu.ts';
import type {UuStore} from './uu.ts';

export {normalizeStoredAccount} from './accounts.ts';
export {uuTokenId} from './uu.ts';
export {VaultError} from '../core/vault.ts';

export interface Logger {
	log(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface OpenStoreOptions {
	dataDir: string;
	/** 没设 MASTER_KEY / MASTER_KEY_FILE 时使用的密钥文件 */
	defaultKeyFile: string;
	env: Record<string, string | undefined>;
	logger?: Logger;
	/** 提供时,启动时把这些旧版明文文件导入数据库 */
	legacy?: LegacyPaths;
	/** 默认 <dataDir>/steam-tools.db */
	dbFile?: string;
}

export interface Store {
	db: Db;
	vault: Vault;
	settings: SettingsStore;
	accounts: AccountStore;
	mafiles: MaFileStore;
	sessions: SteamSessionStore;
	uu: UuStore;
	legacyImport: ImportReport | null;
	close(): void;
}

const KEY_ID_SETTING = 'vault.keyId';

export function openStore(options: OpenStoreOptions): Store {
	const logger = options.logger ?? console;
	const master = loadMasterKey({env: options.env, defaultKeyFile: options.defaultKeyFile, logger});
	const vault = createVault(master.key);
	const dbFile = options.dbFile ?? join(options.dataDir, 'steam-tools.db');
	const db = openDatabase(dbFile);
	try {
		migrate(db, MIGRATIONS);
		const settings = createSettingsStore(db);

		// 数据库只认第一次写入时的那把主密钥:挂错密钥文件时立刻报错,
		// 而不是一边解不开旧数据、一边用新密钥写入,把库弄成两把钥匙混着的状态。
		const storedKeyId = settings.get<string>(KEY_ID_SETTING);
		if (storedKeyId && storedKeyId !== vault.keyId) {
			throw new VaultError(
				`主密钥不匹配:数据库 ${dbFile} 是用指纹 ${storedKeyId} 的密钥加密的,当前加载的密钥(${master.source})指纹是 ${vault.keyId}。` +
				'请换回原来的 master.key。'
			);
		}
		if (!storedKeyId) {
			settings.set(KEY_ID_SETTING, vault.keyId);
		}

		const accounts = createAccountStore(db, vault, settings);
		const mafiles = createMaFileStore(db, vault);
		const sessions = createSteamSessionStore(db, vault);
		const uu = createUuStore(db, vault, settings);
		const legacyImport = options.legacy
			? importLegacyFiles({db, accounts, mafiles, sessions, uu}, options.legacy, options.dataDir, logger)
			: null;

		logger.log(`[store] 数据库 ${dbFile} 已就绪(主密钥指纹 ${vault.keyId},来源 ${master.source === 'env' ? 'MASTER_KEY 环境变量' : master.source})`);
		return {
			db,
			vault,
			settings,
			accounts,
			mafiles,
			sessions,
			uu,
			legacyImport,
			close: () => db.close()
		};
	} catch (err) {
		db.close();
		throw err;
	}
}
