import type {Db} from '../core/db.ts';
import {nowIso, str} from '../core/db.ts';
import type {Vault} from '../core/vault.ts';
import {accountKey} from './accounts.ts';

const PURPOSE = 'mafile';

export type MaFile = Record<string, unknown>;

export interface MaFileStore {
	get(accountName: string): MaFile | null;
	put(accountName: string, maFile: MaFile): void;
	has(accountName: string): boolean;
	count(): number;
}

// maFile 里有 shared_secret / identity_secret / revocation_code 等,整份加密存。
export function createMaFileStore(db: Db, vault: Vault): MaFileStore {
	const selectOne = db.prepare('SELECT data FROM mafiles WHERE account_key = ?');
	const exists = db.prepare('SELECT 1 AS hit FROM mafiles WHERE account_key = ?');
	const countAll = db.prepare('SELECT COUNT(*) AS n FROM mafiles');
	const upsert = db.prepare(`
		INSERT INTO mafiles (account_key, account_name, steam_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(account_key) DO UPDATE SET
			account_name = excluded.account_name,
			steam_id = excluded.steam_id,
			data = excluded.data,
			updated_at = excluded.updated_at
	`);

	return {
		get(accountName) {
			const row = selectOne.get(accountKey(accountName));
			return row ? vault.decryptJson<MaFile>(str(row, 'data'), PURPOSE) : null;
		},
		put(accountName, maFile) {
			const name = String(accountName || '').trim();
			if (!name) {
				throw new Error('maFile 缺少账号名');
			}
			const steamId = String(maFile.SteamID ?? maFile.steamID ?? (maFile.Session as Record<string, unknown> | undefined)?.SteamID ?? '');
			upsert.run(accountKey(name), name, steamId, vault.encryptJson(maFile, PURPOSE), nowIso());
		},
		has(accountName) {
			return !!exists.get(accountKey(accountName));
		},
		count() {
			return Number(countAll.get()?.n ?? 0);
		}
	};
}
