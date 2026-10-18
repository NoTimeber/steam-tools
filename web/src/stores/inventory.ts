// 库存:选一个已登录的账号,拉 /api/inventory/:attemptId(社区库存为准,不用连 GC;连着 CS2 GC 时拉不到用 GC 缓存)。
// 状态放在模块里,切到别的页面再回来不用重新加载。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import type {PublicAttempt} from '../api/types.ts';
import type {InventoryItem} from '../lib/inventory.ts';
import {accounts, mergeAttempt} from './accounts.ts';
import type {AccountRow} from './accounts.ts';
import {addLog} from './logs.ts';

export const inventory = reactive({
	/** 选中账号的 key(账号名小写) */
	selectedKey: '',
	/** 当前 items 属于哪个账号;和 selectedKey 不同说明还没加载 */
	loadedKey: '',
	items: [] as InventoryItem[],
	source: '',
	fetchedAt: '',
	error: '',
	loading: false,
	categoryFilter: 'all'
});

let version = 0;

/** 能看库存的账号:已登录的(要网页 cookie,不用连 GC) */
export const inventoryAccounts = computed<AccountRow[]>(() => accounts.rows.filter(row => !!row.attemptId && row.status === '登录成功'));

export const selectedAccount = computed<AccountRow | null>(() => inventoryAccounts.value.find(row => row.key === inventory.selectedKey) ?? null);

function clearLoaded(): void {
	version++;
	Object.assign(inventory, {loadedKey: '', items: [], source: '', fetchedAt: '', error: '', loading: false});
}

/** 选中的账号登出了(或还没选)时,换成第一个能用的账号 */
export function ensureSelection(): AccountRow | null {
	if (selectedAccount.value) {
		return selectedAccount.value;
	}
	const first = inventoryAccounts.value[0] ?? null;
	inventory.selectedKey = first?.key ?? '';
	clearLoaded();
	return first;
}

export function selectAccount(key: string): void {
	if (inventory.selectedKey !== key) {
		inventory.selectedKey = key;
		clearLoaded();
	}
	ensureLoaded();
}

/** 进页面、换账号时调:没加载过(或上次失败)才拉 */
export function ensureLoaded(): void {
	const account = ensureSelection();
	if (!account || inventory.loading || (inventory.loadedKey === account.key && !inventory.error)) {
		return;
	}
	refreshInventory({silent: true});
}

interface InventoryResponse {
	attempt?: PublicAttempt;
	inventory?: {source?: string; fetchedAt?: string; items?: InventoryItem[]};
}

/** 拉库存;forceRefresh 跳过服务端 15 秒缓存。silent 时不写运行日志 */
export async function refreshInventory(options: {forceRefresh?: boolean; silent?: boolean} = {}): Promise<void> {
	const account = ensureSelection();
	if (!account) {
		return;
	}
	const current = ++version;
	inventory.loading = true;
	inventory.error = '';
	try {
		const data = await api.get<InventoryResponse>(`/api/inventory/${encodeURIComponent(account.attemptId)}${options.forceRefresh ? '?refresh=1' : ''}`);
		if (current !== version) {
			return;
		}
		if (data.attempt) {
			mergeAttempt(data.attempt, {silent: true});
		}
		Object.assign(inventory, {
			loadedKey: account.key,
			items: Array.isArray(data.inventory?.items) ? data.inventory!.items : [],
			source: data.inventory?.source || '',
			fetchedAt: data.inventory?.fetchedAt || ''
		});
		if (!options.silent) {
			addLog('success', `${account.accountName}: 库存已刷新`);
		}
	} catch (err) {
		if (current !== version) {
			return;
		}
		Object.assign(inventory, {loadedKey: '', items: [], source: '', fetchedAt: '', error: errorText(err)});
		if (!options.silent) {
			addLog('error', `${account.accountName}: ${inventory.error}`);
		}
	} finally {
		if (current === version) {
			inventory.loading = false;
		}
	}
}
