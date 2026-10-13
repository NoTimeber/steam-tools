import type {Db, Row, SqlParam} from '../core/db.ts';
import {bool, nowIso, num, str, strOrNull, transaction} from '../core/db.ts';
import type {Vault} from '../core/vault.ts';
import type {SettingsStore} from './settings.ts';

// 与旧版 accounts.json 每一项的结构一致(账号模块仍按这个形状使用)。
export interface StoredAccount {
	id: string;
	accountName: string;
	password: string;
	sharedSecret: string;
	twoFactorCode: string;
	remember: boolean;
	hasMaFile: boolean;
	steamID: string;
	country: string;
	balance: number | null;
	currency: number | null;
	hasWallet: boolean;
	activeGame: string;
	source: string;
}

const INITIALIZED_KEY = 'accounts.initialized';
const PURPOSE = {
	password: 'account.password',
	sharedSecret: 'account.shared_secret',
	twoFactorCode: 'account.two_factor_code'
} as const;

function finiteOrNull(value: unknown): number | null {
	if (value == null || value === '') {
		return null;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

// 只保留"耐久"字段;运行态(status/gcConnected...)不入库。非法项返回 null。
export function normalizeStoredAccount(input: unknown): StoredAccount | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const a = input as Record<string, unknown>;
	const accountName = String(a.accountName ?? '').trim();
	if (!accountName) {
		return null;
	}
	const text = (value: unknown) => (value == null ? '' : String(value));
	return {
		id: a.id ? String(a.id) : '',
		accountName,
		password: text(a.password),
		sharedSecret: text(a.sharedSecret),
		twoFactorCode: text(a.twoFactorCode),
		remember: a.remember !== false,
		hasMaFile: !!a.hasMaFile,
		steamID: String(a.steamID || a.steamId || '').trim(),
		country: String(a.country || '').trim(),
		balance: finiteOrNull(a.balance),
		currency: finiteOrNull(a.currency),
		hasWallet: !!a.hasWallet,
		activeGame: String(a.activeGame || 'cs2'),
		source: String(a.source || '').trim()
	};
}

export function accountKey(accountName: string): string {
	return String(accountName || '').trim().toLowerCase();
}

export interface AccountStore {
	list(): StoredAccount[];
	get(accountName: string): StoredAccount | null;
	/** 整表替换(规范化 + 按账号名去重:保留首次出现的位置,取最后一次的值),返回实际保存的名单。 */
	replaceAll(list: readonly unknown[]): StoredAccount[];
	/** 按账号名删除,返回是否有改动。 */
	removeByNames(accountNames: readonly string[]): boolean;
	/** 名单是否写过(区分"从没同步过"和"被清空了")。 */
	isInitialized(): boolean;
}

export function createAccountStore(db: Db, vault: Vault, settings: SettingsStore): AccountStore {
	const selectAll = db.prepare('SELECT * FROM accounts ORDER BY position');
	const selectOne = db.prepare('SELECT * FROM accounts WHERE account_key = ?');
	const deleteAll = db.prepare('DELETE FROM accounts');
	const deleteOne = db.prepare('DELETE FROM accounts WHERE account_key = ?');
	const insert = db.prepare(`
		INSERT INTO accounts (
			account_key, account_name, position, client_id, password, shared_secret, two_factor_code,
			remember, has_mafile, steam_id, country, balance, currency, has_wallet, active_game, source, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const seal = (value: string, purpose: string): string | null => (value ? vault.encrypt(value, purpose) : null);
	const open = (row: Row, column: string, purpose: string): string => {
		const sealed = strOrNull(row, column);
		return sealed ? vault.decrypt(sealed, purpose) : '';
	};

	function fromRow(row: Row): StoredAccount {
		return {
			id: str(row, 'client_id'),
			accountName: str(row, 'account_name'),
			password: open(row, 'password', PURPOSE.password),
			sharedSecret: open(row, 'shared_secret', PURPOSE.sharedSecret),
			twoFactorCode: open(row, 'two_factor_code', PURPOSE.twoFactorCode),
			remember: bool(row, 'remember'),
			hasMaFile: bool(row, 'has_mafile'),
			steamID: str(row, 'steam_id'),
			country: str(row, 'country'),
			balance: num(row, 'balance'),
			currency: num(row, 'currency'),
			hasWallet: bool(row, 'has_wallet'),
			activeGame: str(row, 'active_game') || 'cs2',
			source: str(row, 'source')
		};
	}

	function insertAccount(account: StoredAccount, position: number, updatedAt: string): void {
		const params: SqlParam[] = [
			accountKey(account.accountName),
			account.accountName,
			position,
			account.id,
			seal(account.password, PURPOSE.password),
			seal(account.sharedSecret, PURPOSE.sharedSecret),
			seal(account.twoFactorCode, PURPOSE.twoFactorCode),
			account.remember ? 1 : 0,
			account.hasMaFile ? 1 : 0,
			account.steamID,
			account.country,
			account.balance,
			account.currency == null ? null : Math.trunc(account.currency),
			account.hasWallet ? 1 : 0,
			account.activeGame,
			account.source,
			updatedAt
		];
		insert.run(...params);
	}

	function list(): StoredAccount[] {
		return selectAll.all().map(fromRow);
	}

	return {
		list,
		get(accountName) {
			const key = accountKey(accountName);
			if (!key) {
				return null;
			}
			const row = selectOne.get(key);
			return row ? fromRow(row) : null;
		},
		replaceAll(input) {
			const order: string[] = [];
			const byKey = new Map<string, StoredAccount>();
			for (const item of input) {
				const account = normalizeStoredAccount(item);
				if (!account) {
					continue;
				}
				const key = accountKey(account.accountName);
				if (!byKey.has(key)) {
					order.push(key);
				}
				byKey.set(key, account);
			}
			const deduped = order.map(key => byKey.get(key) as StoredAccount);
			const updatedAt = nowIso();
			transaction(db, () => {
				deleteAll.run();
				deduped.forEach((account, index) => insertAccount(account, index, updatedAt));
				settings.set(INITIALIZED_KEY, true);
			});
			return deduped;
		},
		removeByNames(accountNames) {
			const keys = [...new Set(accountNames.map(accountKey).filter(Boolean))];
			if (!keys.length) {
				return false;
			}
			let changed = 0;
			transaction(db, () => {
				for (const key of keys) {
					changed += Number(deleteOne.run(key).changes);
				}
			});
			return changed > 0;
		},
		isInitialized() {
			return settings.get<boolean>(INITIALIZED_KEY) === true;
		}
	};
}
