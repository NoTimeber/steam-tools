import type {Db} from '../core/db.ts';
import {nowIso, str, transaction} from '../core/db.ts';
import {accountKey} from './accounts.ts';

// 「这个账号应当保持在线」的意图。登录成功时记为在线;手动登出、删除账号、被顶号/密码错误等
// 致命错误时清除。服务重启后据此自动恢复登录;正常停服(docker stop)不改意图。
export interface LoginIntentStore {
	setOnline(accountName: string, online: boolean): void;
	/** 需要恢复登录的账号名(按最近一次登录成功的时间顺序) */
	listOnline(): string[];
	isOnline(accountName: string): boolean;
	remove(accountNames: readonly string[]): void;
}

export function createLoginIntentStore(db: Db): LoginIntentStore {
	const upsert = db.prepare(`
		INSERT INTO steam_login_intents (account_key, account_name, want_online, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(account_key) DO UPDATE SET
			account_name = excluded.account_name,
			want_online = excluded.want_online,
			updated_at = excluded.updated_at
	`);
	const selectOnline = db.prepare('SELECT account_name FROM steam_login_intents WHERE want_online = 1 ORDER BY updated_at, account_key');
	const selectOne = db.prepare('SELECT want_online FROM steam_login_intents WHERE account_key = ?');
	const deleteOne = db.prepare('DELETE FROM steam_login_intents WHERE account_key = ?');

	return {
		setOnline(accountName, online) {
			const name = String(accountName || '').trim();
			if (!name) {
				return;
			}
			upsert.run(accountKey(name), name, online ? 1 : 0, nowIso());
		},
		listOnline() {
			return selectOnline.all().map(row => str(row, 'account_name'));
		},
		isOnline(accountName) {
			const row = selectOne.get(accountKey(accountName));
			return !!row && Number(row.want_online) === 1;
		},
		remove(accountNames) {
			transaction(db, () => {
				for (const name of accountNames) {
					deleteOne.run(accountKey(name));
				}
			});
		}
	};
}
