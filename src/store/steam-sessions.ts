import type {Db} from '../core/db.ts';
import {nowIso, str, transaction} from '../core/db.ts';
import type {Vault} from '../core/vault.ts';

const PURPOSE = 'steam_session';

// 与旧版 data/sessions/<key>.json 内容一致:{accountName, steamID, refreshToken, cookies, cookieHeader, ...}
export type SteamSession = Record<string, unknown>;

export interface SteamSessionStore {
	get(sessionKey: string): SteamSession | null;
	put(sessionKey: string, session: SteamSession): void;
	has(sessionKey: string): boolean;
	/** 删除若干 key,返回实际删掉的条数。 */
	remove(sessionKeys: readonly string[]): number;
}

export function createSteamSessionStore(db: Db, vault: Vault): SteamSessionStore {
	const selectOne = db.prepare('SELECT data FROM steam_sessions WHERE session_key = ?');
	const exists = db.prepare('SELECT 1 AS hit FROM steam_sessions WHERE session_key = ?');
	const deleteOne = db.prepare('DELETE FROM steam_sessions WHERE session_key = ?');
	const upsert = db.prepare(`
		INSERT INTO steam_sessions (session_key, account_name, steam_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(session_key) DO UPDATE SET
			account_name = excluded.account_name,
			steam_id = excluded.steam_id,
			data = excluded.data,
			updated_at = excluded.updated_at
	`);

	return {
		get(sessionKey) {
			const row = selectOne.get(sessionKey);
			return row ? vault.decryptJson<SteamSession>(str(row, 'data'), PURPOSE) : null;
		},
		put(sessionKey, session) {
			upsert.run(
				sessionKey,
				String(session.accountName ?? ''),
				String(session.steamID ?? ''),
				vault.encryptJson(session, PURPOSE),
				nowIso()
			);
		},
		has(sessionKey) {
			return !!exists.get(sessionKey);
		},
		remove(sessionKeys) {
			let removed = 0;
			transaction(db, () => {
				for (const key of new Set(sessionKeys)) {
					removed += Number(deleteOne.run(key).changes);
				}
			});
			return removed;
		}
	};
}
