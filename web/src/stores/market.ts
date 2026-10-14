// 市场求购(Steam 社区市场 createbuyorder):在线账号(限同币种多选)、行情参考、挂单(固定数量或按余额挂满)、
// 我的求购单(本工具挂出的账本)的对账和撤销。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import {clampMarketConcurrency, perAccountMax, selectedCurrency} from '../lib/market.ts';
import type {BuyOrder, MarketAccount, MarketContext, PlaceResult} from '../lib/market.ts';
import {addLog} from './logs.ts';

export const market = reactive({
	active: false,
	accounts: [] as MarketAccount[],
	accountError: '',
	loadingAccounts: false,
	selected: [] as string[],
	url: '',
	context: null as MarketContext | null,
	contextLoading: false,
	price: null as number | null,
	quantity: 1 as number | null,
	perAccountMax: false,
	concurrency: 2,
	placing: false,
	syncing: false,
	/** 账本全量(本工具挂出的求购单) */
	orders: [] as BuyOrder[],
	/**
	 * 面板显示哪几条:null = 不显示(刚进页面)。只显示「本次挂出的这一批」或「本次对过账的账号」的单,
	 * 免得一进来把历史全铺出来、一刷新就报一堆账号未在线
	 */
	visibleIds: null as Set<string> | null
});

export const selectedAccounts = computed(() => market.selected
	.map(name => market.accounts.find(account => account.account === name))
	.filter((account): account is MarketAccount => !!account));

export const currency = computed(() => selectedCurrency(selectedAccounts.value));

export const maxPreview = computed(() => (market.perAccountMax ? perAccountMax(selectedAccounts.value, market.price) : null));

export const visibleOrders = computed(() => (market.visibleIds ? market.orders.filter(order => market.visibleIds!.has(order.id)) : []));

export async function refreshAccounts(options: {silent?: boolean} = {}): Promise<void> {
	market.loadingAccounts = true;
	market.accountError = '';
	try {
		const data = await api.get<{accounts?: MarketAccount[]}>('/api/market/online-accounts');
		market.accounts = data.accounts || [];
		const online = new Set(market.accounts.map(account => account.account));
		market.selected = market.selected.filter(name => online.has(name));
	} catch (err) {
		market.accountError = errorText(err) || '加载账户失败';
		if (!options.silent) {
			addLog('error', `市场求购在线账户刷新失败: ${market.accountError}`);
		}
	} finally {
		market.loadingAccounts = false;
	}
}

export async function loadOrders(): Promise<void> {
	try {
		const data = await api.get<{orders?: BuyOrder[]}>('/api/market/buyorders');
		market.orders = data.orders || [];
	} catch {
		// 拿不到就先空着
	}
}

/** 行情参考:按第一个已选账号的钱包币种查 */
export async function fetchContext(): Promise<void> {
	const first = selectedAccounts.value[0];
	if (!market.url.trim() || !first) {
		return;
	}
	market.contextLoading = true;
	try {
		const data = await api.get<{context?: MarketContext}>(`/api/market/context?accountId=${encodeURIComponent(first.attemptId)}&url=${encodeURIComponent(market.url.trim())}`);
		market.context = data.context ?? null;
	} catch (err) {
		market.context = null;
		throw err;
	} finally {
		market.contextLoading = false;
	}
}

export interface PlaceOutcome {
	placed: number;
	results: PlaceResult[];
}

/** 挂单(界面先确认);面板随后只显示这一批 */
export async function placeOrders(): Promise<PlaceOutcome> {
	const payload: Record<string, unknown> = {
		accountIds: selectedAccounts.value.map(account => account.attemptId),
		url: market.url.trim(),
		pricePerItem: Number(market.price),
		itemName: market.context?.itemName || '',
		concurrency: clampMarketConcurrency(market.concurrency)
	};
	if (market.perAccountMax) {
		payload.perAccountMax = true;
	} else {
		payload.quantity = Math.round(Number(market.quantity));
	}
	market.placing = true;
	try {
		const data = await api.post<{placed?: number; results?: PlaceResult[]}>('/api/market/buyorder', payload);
		const results = data.results || [];
		market.visibleIds = new Set(results.map(result => result.recordId).filter((id): id is string => !!id));
		const failed = results.filter(result => !result.ok);
		addLog(failed.length ? 'warn' : 'success', `市场求购:挂出 ${Number(data.placed || 0)} 张${failed.length ? `,失败 ${failed.length} 张(${failed.map(result => `${result.account}: ${result.error}`).join('; ')})` : ''}`);
		await loadOrders();
		return {placed: Number(data.placed || 0), results};
	} finally {
		market.placing = false;
	}
}

export async function cancelOrder(id: string): Promise<void> {
	const order = market.orders.find(item => item.id === id);
	await api.post('/api/market/buyorder/cancel', {id});
	addLog('success', `市场求购:已撤销 ${order ? `${order.account} 的 ${order.itemName || order.marketHashName}` : id}`);
	await loadOrders();
}

export interface SyncOutcome {
	summary: {removed?: number; updated?: number; accounts?: Array<{account: string; ok: boolean; error?: string}>};
}

/**
 * 刷新(对账):对选中的在线账号从 Steam 实拉真实求购单(成交/撤销/过期的移除,剩余数量更新),面板收窄到这些账号。
 * 没选账号就对当前面板里显示的账号。返回 null 表示没有可刷新的账号
 */
export async function syncOrders(): Promise<SyncOutcome | null> {
	const targets = market.selected.length
		? [...market.selected]
		: [...new Set(visibleOrders.value.map(order => order.account).filter(Boolean))];
	if (!targets.length) {
		return null;
	}
	market.syncing = true;
	try {
		const data = await api.post<{orders?: BuyOrder[]; syncedAccounts?: string[]; summary?: SyncOutcome['summary']}>('/api/market/buyorders/sync', {
			concurrency: clampMarketConcurrency(market.concurrency),
			accounts: targets
		});
		if (Array.isArray(data.orders)) {
			market.orders = data.orders;
		}
		const synced = new Set(data.syncedAccounts || []);
		market.visibleIds = new Set(market.orders.filter(order => synced.has(order.account)).map(order => order.id));
		return {summary: data.summary || {}};
	} finally {
		market.syncing = false;
	}
}

let started = false;
let accountRefreshTimer: number | undefined;

export function startMarket(): void {
	if (started) {
		return;
	}
	started = true;
	socket.on('attempt:update', () => {
		if (!market.active) {
			return;
		}
		window.clearTimeout(accountRefreshTimer);
		accountRefreshTimer = window.setTimeout(() => {
			if (market.active && !market.loadingAccounts) {
				refreshAccounts({silent: true});
			}
		}, 800);
	});
}

export function enterMarket(): void {
	market.active = true;
	if (!market.loadingAccounts) {
		refreshAccounts({silent: true});
	}
	loadOrders();
}

export function leaveMarket(): void {
	market.active = false;
}
