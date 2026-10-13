import type {Db} from '../core/db.ts';
import {nowIso, str} from '../core/db.ts';

// 非敏感的小配置(JSON 明文),如 UU 轮询间隔、名单是否已初始化。
export interface SettingsStore {
	get<T>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	delete(key: string): void;
}

export function createSettingsStore(db: Db): SettingsStore {
	const select = db.prepare('SELECT value FROM settings WHERE key = ?');
	const upsert = db.prepare(`
		INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`);
	const remove = db.prepare('DELETE FROM settings WHERE key = ?');

	return {
		get<T>(key: string): T | undefined {
			const row = select.get(key);
			return row ? (JSON.parse(str(row, 'value')) as T) : undefined;
		},
		set(key, value) {
			upsert.run(key, JSON.stringify(value), nowIso());
		},
		delete(key) {
			remove.run(key);
		}
	};
}
