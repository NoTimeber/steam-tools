// 市场的出售 / 我的在售 / 成交记录:状态放在这里,切标签页、切走页面再回来不丢(待上架列表、参考价缓存、筛选)。
// 在线账号沿用 ./market.ts 的 market.accounts(/api/market/online-accounts)。价格一律是钱包币种的分。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import {
	batchItems, expandPending, flattenListings, groupInventory, groupResults, matchOutcomes, newPendingRow, rebindPending, remainingAfterSell, sellPayload,
	sentTotals
} from '../lib/market-sell.ts';
import type {
	GroupResult, HistoryPage, HistoryType, ListingRow, ListingsAccount, ListingStatus, PendingRow, SellGroup, SellInventory, SellPrice, SellResponse,
	SentItem, WalletCurrency
} from '../lib/market-sell.ts';
import {addLog} from './logs.ts';

// ===== 出售 =====

export interface PriceEntry {
	loading: boolean;
	/** 最近一次查到的;重查中、重查失败时还留着旧的 */
	data: SellPrice | null;
	error: string;
	/** data 是什么时候查到的(毫秒) */
	fetchedAt: number | null;
}

/** 批量重查参考价的进度(全部刷新 / 上架前核对) */
export interface PriceRefresh {
	mode: 'refresh' | 'recheck';
	done: number;
	total: number;
}

/** 一次上架(可能分几批)的结果 */
export interface SellRun {
	account: string;
	currency: WalletCurrency | null;
	groups: GroupResult[];
	sent: SentItem[];
	listed: number;
	pendingConfirmation: number;
	failed: number;
	confirmed: number;
	needsMobile: boolean;
	/** 中途出错(后面的批次没提交)的原因 */
	error: string;
}

export const sell = reactive({
	account: null as string | null,
	appid: 730,
	inventory: null as SellInventory | null,
	inventoryLoading: false,
	inventoryError: '',
	filterText: '',
	onlyMarketable: true,
	/** 待上架,一组一行 */
	pending: [] as PendingRow[],
	/** 参考价缓存:账号|appid|英文名 → 结果 */
	prices: {} as Record<string, PriceEntry>,
	selling: false,
	/** 上架进度:第几批 / 共几批 */
	progress: {batch: 0, batches: 0},
	lastResult: null as SellRun | null,
	/** 正在批量重查参考价;null = 没有 */
	refreshing: null as PriceRefresh | null
});

/** 当前库存叠成的组 */
export const sellGroups = computed<SellGroup[]>(() => groupInventory(sell.inventory?.items ?? []));

let inventorySeq = 0;

export async function loadInventory(refresh = false): Promise<void> {
	const account = sell.account;
	if (!account) {
		sell.inventory = null;
		return;
	}
	const seq = ++inventorySeq;
	sell.inventoryLoading = true;
	sell.inventoryError = '';
	try {
		const query = new URLSearchParams({account, appid: String(sell.appid), contextid: '2'});
		if (refresh) {
			query.set('refresh', '1');
		}
		const data = await api.get<SellInventory>('/api/market/sell/inventory?' + query);
		if (seq === inventorySeq) {
			sell.inventory = data;
			// 待上架里这个游戏的组换成新库存里的(卖掉的资产不再用;别的游戏的行不动)
			const fresh = rebindPending(sell.pending.filter(row => row.group.appid === data.appid), groupInventory(data.items));
			sell.pending = sell.pending.flatMap(row => (row.group.appid !== data.appid ? [row] : fresh.filter(entry => entry.key === row.key)));
		}
	} catch (err) {
		if (seq === inventorySeq) {
			sell.inventory = null;
			sell.inventoryError = errorText(err);
		}
	} finally {
		if (seq === inventorySeq) {
			sell.inventoryLoading = false;
		}
	}
}

/** 换账号:待上架列表是这个账号的,一起清掉 */
export function setSellAccount(account: string | null): void {
	if (account === sell.account) {
		return;
	}
	sell.account = account;
	sell.pending = [];
	sell.lastResult = null;
	sell.inventory = null;
	void loadInventory();
}

export function setSellGame(appid: number): void {
	if (appid === sell.appid) {
		return;
	}
	sell.appid = appid;
	void loadInventory();
}

export function priceKey(account: string, appid: number, marketHashName: string): string {
	return `${account}|${appid}|${marketHashName}`;
}

// 参考价每个要查一次 Steam 行情,同时最多查 2 个
const PRICE_CONCURRENCY = 2;
const priceQueue: Array<() => Promise<void>> = [];
let priceRunning = 0;

function pumpPrices(): void {
	while (priceRunning < PRICE_CONCURRENCY && priceQueue.length) {
		const job = priceQueue.shift()!;
		priceRunning++;
		void job().finally(() => {
			priceRunning--;
			pumpPrices();
		});
	}
}

/** 取消一批重查用的标记:还没开始的不再查 */
export interface CancelToken {
	cancelled: boolean;
}

const inflight = new Map<string, Promise<boolean>>();

/**
 * 某组的参考价(按账号币种,同名缓存;Steam 实时查,服务端不缓存)。force 重查;返回这次有没有拿到新数据。
 * 重查时旧数据留着照常显示;失败也留着旧的,只记错误
 */
export function ensurePrice(account: string, appid: number, marketHashName: string, force = false, token?: CancelToken): Promise<boolean> {
	const key = priceKey(account, appid, marketHashName);
	const running = inflight.get(key);
	if (running) {
		return running;
	}
	const cached = sell.prices[key];
	if (cached && !force && !cached.error) {
		return Promise.resolve(true);
	}
	sell.prices[key] = {loading: true, data: cached?.data ?? null, error: '', fetchedAt: cached?.fetchedAt ?? null};
	const promise = new Promise<boolean>(resolve => {
		priceQueue.push(async () => {
			const previous = sell.prices[key];
			if (token?.cancelled) {
				sell.prices[key] = {loading: false, data: previous?.data ?? null, error: previous?.error ?? '', fetchedAt: previous?.fetchedAt ?? null};
				resolve(false);
				return;
			}
			try {
				const query = new URLSearchParams({account, appid: String(appid), marketHashName});
				const data = await api.get<SellPrice>('/api/market/sell/price?' + query);
				sell.prices[key] = {loading: false, data, error: '', fetchedAt: Date.now()};
				resolve(true);
			} catch (err) {
				sell.prices[key] = {loading: false, data: previous?.data ?? null, error: errorText(err) || '参考价获取失败', fetchedAt: previous?.fetchedAt ?? null};
				resolve(false);
			}
		});
		pumpPrices();
	}).finally(() => inflight.delete(key));
	inflight.set(key, promise);
	return promise;
}

/**
 * 强制重查这些组的参考价(走同一个队列,同时 2 个),进度写进 sell.refreshing。
 * token 取消后没开始的不再查;返回每组 key → 这次有没有拿到新数据
 */
export async function refreshPrices(rows: readonly PendingRow[], mode: PriceRefresh['mode'], token: CancelToken = {cancelled: false}): Promise<Map<string, boolean>> {
	const account = sell.account;
	const result = new Map<string, boolean>();
	if (!account || !rows.length) {
		return result;
	}
	sell.refreshing = {mode, done: 0, total: rows.length};
	try {
		await Promise.all(rows.map(async row => {
			const ok = await ensurePrice(account, row.group.appid, row.group.marketHashName, true, token);
			result.set(row.key, ok);
			if (sell.refreshing) {
				sell.refreshing.done++;
			}
		}));
	} finally {
		sell.refreshing = null;
	}
	return result;
}

/** 勾选 / 取消一组(有可出售的才能勾);勾上默认卖 1 件 */
export function togglePending(group: SellGroup, checked: boolean): void {
	const inventory = sell.inventory;
	const exists = sell.pending.some(row => row.key === group.key);
	if (checked && !exists && group.sellable > 0 && inventory && sell.account) {
		sell.pending.push(newPendingRow(group, inventory.fees));
		void ensurePrice(sell.account, group.appid, group.marketHashName);
	} else if (!checked && exists) {
		sell.pending = sell.pending.filter(row => row.key !== group.key);
	}
}

export function replacePending(rows: PendingRow[]): void {
	sell.pending = rows;
}

/**
 * 上架待上架列表里的全部(界面先确认、先检查):按数量展开成资产,每批最多 50 件依次提交;
 * 一批出错就停,这一批和后面的都记失败。完了每组只留失败的件数,库存重新拉
 */
export async function submitSell(): Promise<SellRun> {
	const account = sell.account;
	if (!account) {
		throw new Error('先选账号');
	}
	const rows = [...sell.pending];
	const batches = batchItems(expandPending(rows));
	const sent: SentItem[] = [];
	let confirmed = 0;
	let currency: WalletCurrency | null = sell.inventory?.currency ?? null;
	let error = '';
	sell.selling = true;
	sell.progress = {batch: 0, batches: batches.length};
	try {
		for (const [index, batch] of batches.entries()) {
			if (error) {
				sent.push(...matchOutcomes(batch, null, `没有提交:前面一批出错(${error})`));
				continue;
			}
			sell.progress = {batch: index + 1, batches: batches.length};
			try {
				const data = await api.post<SellResponse>('/api/market/sell', {account, items: sellPayload(batch), autoConfirm: true});
				sent.push(...matchOutcomes(batch, data));
				confirmed += Number(data.confirmed) || 0;
				currency = data.currency ?? currency;
			} catch (err) {
				error = errorText(err) || '上架失败';
				sent.push(...matchOutcomes(batch, null, error));
			}
		}
	} finally {
		sell.selling = false;
	}
	const totals = sentTotals(sent);
	const run: SellRun = {
		account, currency, groups: groupResults(rows, sent), sent, ...totals, confirmed,
		needsMobile: totals.pendingConfirmation > 0, error
	};
	sell.lastResult = run;
	if (sell.account === account) {
		sell.pending = remainingAfterSell(sell.pending, sent);
		void loadInventory(true);
	}
	addLog(totals.failed ? 'warn' : 'success', `市场出售:${account} 上架 ${totals.listed} 件,待确认 ${totals.pendingConfirmation} 件,失败 ${totals.failed} 件${error ? `(${error})` : ''}`);
	return run;
}

// ===== 我的在售 =====

export const listings = reactive({
	/** 要看的账号;null = 还没选过(默认全部在线账号) */
	accounts: null as string[] | null,
	loading: false,
	error: '',
	results: [] as ListingsAccount[],
	rows: [] as ListingRow[],
	loaded: false,
	filterAccount: null as string | null,
	filterStatus: null as ListingStatus | null,
	/** 勾选的行(rowKey) */
	selected: [] as string[],
	cancelling: false,
	cancelProgress: {done: 0, total: 0}
});

export async function loadListings(accounts: string[]): Promise<void> {
	if (!accounts.length) {
		listings.results = [];
		listings.rows = [];
		return;
	}
	listings.loading = true;
	listings.error = '';
	try {
		const data = await api.post<{accounts: ListingsAccount[]}>('/api/market/listings', {accounts, concurrency: 2});
		listings.results = data.accounts || [];
		listings.rows = flattenListings(listings.results);
		const keys = new Set(listings.rows.map(row => row.rowKey));
		listings.selected = listings.selected.filter(key => keys.has(key));
		listings.loaded = true;
	} catch (err) {
		listings.error = errorText(err);
	} finally {
		listings.loading = false;
	}
}

/** 下架一件;成功后从列表里拿掉 */
export async function cancelListing(row: ListingRow): Promise<void> {
	await api.post('/api/market/listing/cancel', {account: row.account, listingId: row.listingId});
	listings.rows = listings.rows.filter(entry => entry.rowKey !== row.rowKey);
	listings.selected = listings.selected.filter(key => key !== row.rowKey);
	addLog('success', `市场出售:已下架 ${row.account} 的 ${row.name || row.marketHashName}`);
}

/** 批量下架(逐个,一个失败不影响别的);返回失败的 */
export async function cancelListings(rows: ListingRow[]): Promise<Array<{row: ListingRow; error: string}>> {
	const failed: Array<{row: ListingRow; error: string}> = [];
	listings.cancelling = true;
	listings.cancelProgress = {done: 0, total: rows.length};
	try {
		for (const row of rows) {
			try {
				await cancelListing(row);
			} catch (err) {
				failed.push({row, error: errorText(err)});
			}
			listings.cancelProgress.done++;
		}
	} finally {
		listings.cancelling = false;
	}
	return failed;
}

// ===== 成交记录 =====

export const HISTORY_PAGE_SIZE = 50;

export const history = reactive({
	account: null as string | null,
	start: 0,
	loading: false,
	error: '',
	page: null as HistoryPage | null,
	type: null as HistoryType | null
});

let historySeq = 0;

export async function loadHistory(start = history.start): Promise<void> {
	const account = history.account;
	if (!account) {
		history.page = null;
		return;
	}
	const seq = ++historySeq;
	history.loading = true;
	history.error = '';
	try {
		const data = await api.post<HistoryPage>('/api/market/history', {account, start, count: HISTORY_PAGE_SIZE});
		if (seq === historySeq) {
			history.page = data;
			history.start = start;
		}
	} catch (err) {
		if (seq === historySeq) {
			history.error = errorText(err);
		}
	} finally {
		if (seq === historySeq) {
			history.loading = false;
		}
	}
}

export function setHistoryAccount(account: string | null): void {
	if (account === history.account) {
		return;
	}
	history.account = account;
	history.page = null;
	history.start = 0;
	void loadHistory(0);
}
