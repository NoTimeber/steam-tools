// 游戏内购(CS2/TF2 GC 商店):在线账号、商品目录与汇率、按游戏分开的购物车、内购任务。
// 购物车只在浏览器内存里(和旧版一样),按「游戏 → 账号名 → 商品」存,随时按余额封顶。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import type {GameId} from '../api/types.ts';
import {
	MAX_ITEM_QUANTITY, dominantCurrency, normalizeCart, setCartQuantity, taskLogLine
} from '../lib/purchase.ts';
import type {CartEntry, CatalogItem, PurchaseAccount, PurchaseTask, Rates} from '../lib/purchase.ts';
import {addLog} from './logs.ts';

export const purchase = reactive({
	game: 'cs2' as GameId,
	/** 页面是否打开着(打开时账号状态变化才去刷新在线账号) */
	active: false,
	accounts: [] as PurchaseAccount[],
	accountError: '',
	loadingAccounts: false,
	selected: new Set<string>(),
	items: [] as CatalogItem[],
	itemError: '',
	loadingItems: false,
	itemsFetchedAt: '',
	rates: {} as Rates,
	ratesSource: '',
	search: '',
	collapsed: new Set<string>(),
	carts: {cs2: {}, tf2: {}} as Record<GameId, Record<string, CartEntry[]>>,
	submitting: false,
	tasks: [] as PurchaseTask[],
	tasksLoadedFor: '' as GameId | ''
});

export const gameLabel = computed(() => (purchase.game === 'tf2' ? 'TF2' : 'CS2'));

const itemIndex = computed(() => new Map(purchase.items.map(item => [Number(item.def_index), item])));
export const findItem = (defIndex: number) => itemIndex.value.get(Number(defIndex));

export const selectedAccounts = computed(() => purchase.accounts.filter(account => purchase.selected.has(account.account)));
export const currentCurrency = computed(() => dominantCurrency(selectedAccounts.value));

const accountByName = (name: string) => purchase.accounts.find(account => account.account === name) ?? null;
const cartStore = () => purchase.carts[purchase.game];

export function cartOf(accountName: string): CartEntry[] {
	return cartStore()[accountName] ?? [];
}

function storeCart(accountName: string, entries: CartEntry[]): void {
	if (entries.length) {
		cartStore()[accountName] = entries;
	} else {
		delete cartStore()[accountName];
	}
}

/** 余额、单价、在线账号变了之后,把所有购物车重新按余额整理一遍;不在线的账号购物车清掉 */
function renormalizeCarts(): void {
	for (const name of Object.keys(cartStore())) {
		storeCart(name, normalizeCart(cartOf(name), accountByName(name), findItem));
	}
}

// ===== 在线账号 =====

let accountVersion = 0;

export async function refreshAccounts(options: {silent?: boolean} = {}): Promise<void> {
	const version = ++accountVersion;
	const label = gameLabel.value;
	purchase.loadingAccounts = true;
	purchase.accountError = '';
	try {
		const data = await api.get<{accounts?: PurchaseAccount[]}>(`/api/purchase/online-accounts?game=${purchase.game}`);
		if (version !== accountVersion) {
			return;
		}
		purchase.accounts = (data.accounts || []).map(account => ({
			...account,
			currencyISO: String(account.currencyISO || 'USD').trim().toUpperCase() || 'USD'
		}));
		const online = new Set(purchase.accounts.map(account => account.account));
		for (const name of [...purchase.selected]) {
			if (!online.has(name)) {
				purchase.selected.delete(name);
			}
		}
		renormalizeCarts();
		if (!options.silent) {
			addLog('success', `${label} 内购在线账户已刷新: ${purchase.accounts.length} 个`);
		}
	} catch (err) {
		if (version !== accountVersion) {
			return;
		}
		purchase.accountError = errorText(err);
		if (!options.silent) {
			addLog('error', `${label} 内购在线账户刷新失败: ${purchase.accountError}`);
		}
	} finally {
		if (version === accountVersion) {
			purchase.loadingAccounts = false;
		}
	}
}

// ===== 商品目录与汇率 =====

let itemVersion = 0;

const CATALOG_ACTIONS = {
	load: {method: 'get', path: '/api/purchase/items', done: '内购商品目录已加载', failed: '内购商品目录加载失败'},
	items: {method: 'post', path: '/api/purchase/refresh-items', done: '内购商品目录已刷新', failed: '内购商品目录刷新失败'},
	rates: {method: 'post', path: '/api/purchase/refresh-rates', done: '内购汇率已刷新', failed: '内购汇率刷新失败'}
} as const;

interface CatalogResponse {
	list?: CatalogItem[];
	rates?: Rates;
	ratesSource?: string;
	fetchedAt?: string;
	needsRefresh?: boolean;
}

/** 读目录(load)、从 GC 重新拉目录(items)、刷新汇率(rates) */
export async function loadCatalog(kind: keyof typeof CATALOG_ACTIONS, options: {silent?: boolean} = {}): Promise<void> {
	const action = CATALOG_ACTIONS[kind];
	const version = ++itemVersion;
	const label = gameLabel.value;
	const url = `${action.path}?game=${purchase.game}`;
	purchase.loadingItems = true;
	purchase.itemError = '';
	try {
		const data = action.method === 'get' ? await api.get<CatalogResponse>(url) : await api.post<CatalogResponse>(url, {game: purchase.game});
		if (version !== itemVersion) {
			return;
		}
		purchase.items = Array.isArray(data.list) ? data.list : [];
		purchase.rates = data.rates && typeof data.rates === 'object' ? data.rates : {};
		purchase.ratesSource = String(data.ratesSource || '').trim();
		purchase.itemsFetchedAt = data.fetchedAt || '';
		purchase.itemError = data.needsRefresh ? '当前没有本地商品缓存,请点「刷新商品」后再使用' : '';
		renormalizeCarts();
		if (!options.silent) {
			addLog('success', `${label} ${action.done}`);
		}
	} catch (err) {
		if (version !== itemVersion) {
			return;
		}
		purchase.itemError = errorText(err);
		if (!options.silent) {
			addLog('error', `${label} ${action.failed}: ${purchase.itemError}`);
		}
	} finally {
		if (version === itemVersion) {
			purchase.loadingItems = false;
		}
	}
}

// ===== 任务 =====

/** 每个任务上次看到的样子(两个游戏的都记,用来判断状态变化写日志) */
const lastSeen = new Map<string, PurchaseTask>();

function mergeTask(task: PurchaseTask, created: boolean): void {
	if (!task || !task.id) {
		return;
	}
	// 日志不管当前在看哪个游戏都写;列表只放当前游戏的
	const line = taskLogLine(task, lastSeen.get(task.id) ?? null, created);
	lastSeen.set(task.id, task);
	if (line) {
		addLog(line.level, line.message);
	}
	if ((task.game === 'tf2' ? 'tf2' : 'cs2') !== purchase.game) {
		return;
	}
	const index = purchase.tasks.findIndex(item => item.id === task.id);
	if (index >= 0) {
		purchase.tasks[index] = task;
	} else {
		purchase.tasks.unshift(task);
	}
	purchase.tasks.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

export async function loadTasks(): Promise<void> {
	const game = purchase.game;
	try {
		const data = await api.get<{tasks?: PurchaseTask[]}>('/api/purchase/tasks');
		for (const task of data.tasks || []) {
			if (!lastSeen.has(task.id)) {
				lastSeen.set(task.id, task);
			}
		}
		if (game !== purchase.game) {
			return;
		}
		purchase.tasks = (data.tasks || []).filter(task => (task.game === 'tf2' ? 'tf2' : 'cs2') === game)
			.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
		purchase.tasksLoadedFor = game;
	} catch {
		// 任务列表拿不到不影响下单,推送来了照样显示
	}
}

// ===== 页面进出、切游戏 =====

/** 每次进页面:刷新在线账号(刚登录的账号马上能选),目录和任务没加载过才加载 */
export function enterPurchase(): void {
	purchase.active = true;
	if (!purchase.loadingAccounts) {
		refreshAccounts({silent: true});
	}
	if (!purchase.items.length && !purchase.loadingItems) {
		loadCatalog('load', {silent: true});
	}
	if (purchase.tasksLoadedFor !== purchase.game) {
		loadTasks();
	}
}

export function leavePurchase(): void {
	purchase.active = false;
}

/** 切游戏:账号、目录、任务都换成另一个游戏的;购物车按游戏分开保留 */
export function switchGame(game: GameId): void {
	if (game === purchase.game) {
		return;
	}
	Object.assign(purchase, {
		game,
		accounts: [],
		items: [],
		tasks: [],
		tasksLoadedFor: '',
		accountError: '',
		itemError: '',
		search: ''
	});
	purchase.selected.clear();
	accountVersion++;
	itemVersion++;
	enterPurchase();
}

// ===== 购物车操作 =====

/** 给每个选中的账号加 1 件;余额不够的账号跳过并提示 */
export function addToCart(item: CatalogItem): void {
	const accounts = selectedAccounts.value;
	if (!accounts.length) {
		return;
	}
	const name = item.name || `DefIndex ${item.def_index}`;
	let added = 0;
	for (const account of accounts) {
		const current = cartOf(account.account).find(entry => entry.itemDefId === Number(item.def_index));
		const requested = (current?.quantity ?? 0) + 1;
		const result = setCartQuantity(cartOf(account.account), account, item.def_index, requested, findItem);
		storeCart(account.account, result.entries);
		if (result.appliedQuantity >= requested) {
			added++;
		} else {
			addLog('warn', `${account.account}: ${name} 已达到最大购买量${result.maxQuantity > 0 ? `,最大可买 ${result.maxQuantity}` : ''}`);
		}
	}
	if (added) {
		addLog('success', `${name}: 已加入 ${added} 个账号的购物车`);
	}
}

/** 购物车里的数量手动改;被余额压低时提示 */
export function setQuantity(accountName: string, itemDefId: number, quantity: number): void {
	const account = accountByName(accountName);
	const result = setCartQuantity(cartOf(accountName), account, itemDefId, quantity, findItem);
	storeCart(accountName, result.entries);
	if (quantity > 0 && result.appliedQuantity !== quantity) {
		const name = findItem(itemDefId)?.name || `DefIndex ${itemDefId}`;
		addLog('warn', `${accountName}: ${name} 数量已调整为 ${result.appliedQuantity}(${result.maxQuantity > 0 ? `最大可买 ${result.maxQuantity}` : '当前余额不足'})`);
	}
}

/** 选中账号购物车里的每件商品都按余额买满(前面的商品先占余额) */
export function maxOutCart(): void {
	let touched = 0;
	for (const account of selectedAccounts.value) {
		const entries = cartOf(account.account);
		if (!entries.length) {
			continue;
		}
		storeCart(account.account, normalizeCart(entries.map(entry => ({...entry, quantity: MAX_ITEM_QUANTITY})), account, findItem));
		touched++;
	}
	if (!touched) {
		addLog('warn', selectedAccounts.value.length ? '当前账户购物车为空,请先加入商品' : '请先选择购买账户');
		return;
	}
	addLog('success', '已按余额为购物车设置最大购买数量');
}

/** 清空选中账号的购物车;没选账号时清空当前游戏的全部购物车 */
export function clearCart(options: {silent?: boolean} = {}): void {
	if (selectedAccounts.value.length) {
		for (const account of selectedAccounts.value) {
			storeCart(account.account, []);
		}
	} else {
		purchase.carts[purchase.game] = {};
	}
	if (!options.silent) {
		addLog('success', `${gameLabel.value} 内购购物车已清空`);
	}
}

export function clearAccountCart(accountName: string): void {
	storeCart(accountName, []);
}

/** 选中账号里购物车非空的那些 */
export const cartGroups = computed(() => selectedAccounts.value
	.map(account => ({account, entries: cartOf(account.account)}))
	.filter(group => group.entries.length));

export async function submitTask(): Promise<void> {
	const groups = cartGroups.value;
	const label = gameLabel.value;
	if (!groups.length) {
		addLog('warn', `当前没有可提交的 ${label} 内购购物车`);
		return;
	}
	const cartData: Record<string, Array<{itemDefId: number; costInLocalCurrency: number; quantity: number}>> = {};
	for (const group of groups) {
		cartData[group.account.account] = group.entries.map(entry => ({
			itemDefId: entry.itemDefId,
			costInLocalCurrency: entry.costInLocalCurrency,
			quantity: entry.quantity
		}));
	}
	purchase.submitting = true;
	try {
		const data = await api.post<{task?: PurchaseTask}>('/api/purchase/tasks', {game: purchase.game, cartData});
		for (const group of groups) {
			storeCart(group.account.account, []);
		}
		// 推送往往比这个响应先到;响应里的是提交那一刻的快照,已经有更新的就不用它(否则状态会倒回去、日志重复)
		if (data.task && !lastSeen.has(data.task.id)) {
			mergeTask(data.task, true);
		}
		addLog('success', `已提交 ${label} 内购任务: ${groups.length} 个账号`);
	} catch (err) {
		addLog('error', `${label} 内购任务提交失败: ${errorText(err)}`);
	} finally {
		purchase.submitting = false;
	}
}

// ===== 推送 =====

let started = false;
let accountRefreshTimer: number | undefined;

/** 进程启动时调一次:任务推送随时写日志;账号状态变了且内购页开着时,防抖刷新在线账号(余额、刚登录的账号) */
export function startPurchase(): void {
	if (started) {
		return;
	}
	started = true;
	socket.on('purchase:task-created', (task: PurchaseTask) => mergeTask(task, true));
	socket.on('purchase:task-updated', (task: PurchaseTask) => mergeTask(task, false));
	socket.on('purchase:task-completed', (task: PurchaseTask) => mergeTask(task, false));
	socket.on('attempt:update', () => {
		if (!purchase.active) {
			return;
		}
		window.clearTimeout(accountRefreshTimer);
		accountRefreshTimer = window.setTimeout(() => {
			if (purchase.active && !purchase.loadingAccounts) {
				refreshAccounts({silent: true});
			}
		}, 800);
	});
}
