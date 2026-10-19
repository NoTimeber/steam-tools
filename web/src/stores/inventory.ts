// 库存:选一个已登录的账号,拉 /api/inventory/:attemptId(后端先让账号连上 CS2 GC 再拉社区库存,交易冷却、磨损才全;社区拉不到时用 GC 缓存)。
// 状态放在模块里,切到别的页面再回来不用重新加载。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import type {PublicAttempt} from '../api/types.ts';
import type {InventoryItem, InventorySort, TradeFilter} from '../lib/inventory.ts';
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

const VIEW_KEY = 'steam-tools.inventory-view';

function savedView(): Partial<{mode: InventoryMode; layout: InventoryLayout; pageSize: number}> {
	try {
		return JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') || {};
	} catch {
		return {};
	}
}

export type InventoryMode = 'single' | 'stack';
export type InventoryLayout = 'grid' | 'list';
export const PAGE_SIZES = [30, 60, 120] as const;

const initialView = savedView();

/** 页面上的筛选和显示方式;逐件/堆叠、网格/列表、每页条数记在本机 */
export const inventoryView = reactive({
	mode: (initialView.mode === 'stack' ? 'stack' : 'single') as InventoryMode,
	layout: (initialView.layout === 'list' ? 'list' : 'grid') as InventoryLayout,
	pageSize: (PAGE_SIZES as readonly number[]).includes(Number(initialView.pageSize)) ? Number(initialView.pageSize) : 60,
	page: 1,
	search: '',
	trade: 'all' as TradeFilter,
	rarity: '',
	sort: 'default' as InventorySort
});

export function saveInventoryView(): void {
	try {
		localStorage.setItem(VIEW_KEY, JSON.stringify({mode: inventoryView.mode, layout: inventoryView.layout, pageSize: inventoryView.pageSize}));
	} catch {
		// 本机存不了就算了
	}
}

let version = 0;

/** 能看库存的账号:已登录的(没连 CS2 GC 的,加载时后端会替它连上) */
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
