// 市场求购的纯逻辑(不依赖 Vue):搜商品的显示、多账号同币种约束、按余额挂满的件数、金额显示、确认和结果文案。
// 除了搜商品(新加的),规则照搬旧版前端。

import {currencySymbol} from './accounts.ts';
import type {CookieAccount} from './buygame.ts';

export type MarketAccount = CookieAccount;

/** 行情参考(src/market/client.ts 的 MarketContext);价格都是钱包币种的分 */
export interface MarketContext {
	appid: number;
	marketHashName: string;
	itemName: string;
	currency: number;
	currencyISO?: string;
	highestBuyOrderCents: number | null;
	lowestSellOrderCents: number | null;
	/** priceoverview 的带符号文本 */
	lowestPrice: string;
	medianPrice: string;
	volume: string;
}

/** 搜商品的一条(src/market/index.ts 的 MarketSearchItem) */
export interface MarketItem {
	appid: number;
	/** Steam 英文名 */
	marketHashName: string;
	/** 中文名;词库里没有(新出的饰品按英文名用、其它游戏的链接)为 null */
	zh: string | null;
}

/** 下拉选项的 value:同名物品在不同游戏里可能都有 */
export function itemKey(item: Pick<MarketItem, 'appid' | 'marketHashName'>): string {
	return `${item.appid}|${item.marketHashName}`;
}

/** 页面上显示的名字:有中文用中文 */
export function itemLabel(item: MarketItem): string {
	return item.zh || item.marketHashName;
}

/** 名字后面的小字:有中文时是英文名;没有时说明是怎么来的 */
export function itemSubText(item: MarketItem): string {
	if (item.zh) {
		return item.marketHashName;
	}
	return item.appid === 730 ? '词库里没有,按英文名使用(要和 Steam 英文名完全一致)' : `其它游戏(appid ${item.appid})`;
}

/** 本工具挂出的求购单(src/market/ledger.ts 的 BuyOrderRecord) */
export interface BuyOrder {
	id: string;
	createdAt: string;
	account: string;
	marketHashName: string;
	itemName: string;
	currency: number;
	currencyISO: string;
	pricePerItemCents: number;
	quantity: number;
	status: 'active' | 'pending_confirm' | string;
	quantityRemaining?: number | null;
}

export interface PlaceResult {
	account: string;
	ok: boolean;
	recordId?: string;
	needsConfirmation?: boolean;
	error?: string;
}

export interface SelectedCurrency {
	currency: number | null;
	currencyISO: string;
	/** 选了不同币种的账号(一张求购单只能用一种币种的价格) */
	mixed: boolean;
}

export function selectedCurrency(accounts: readonly MarketAccount[]): SelectedCurrency {
	if (!accounts.length) {
		return {currency: null, currencyISO: '', mixed: false};
	}
	if (new Set(accounts.map(account => Number(account.currency))).size > 1) {
		return {currency: null, currencyISO: '', mixed: true};
	}
	return {currency: Number(accounts[0]!.currency), currencyISO: accounts[0]!.currencyISO || '', mixed: false};
}

/** 已经选了某币种的账号时,别的币种的账号不能再选 */
export function lockedOut(account: MarketAccount, current: SelectedCurrency, checked: boolean): boolean {
	return !checked && !current.mixed && current.currency != null && Number(account.currency) !== current.currency;
}

/** 全选:选满当前币种(还没选就按列表第一个账号的币种) */
export function selectAllSameCurrency(accounts: readonly MarketAccount[], current: SelectedCurrency): string[] {
	if (!accounts.length) {
		return [];
	}
	const target = !current.mixed && current.currency != null ? current.currency : Number(accounts[0]!.currency);
	return accounts.filter(account => Number(account.currency) === target).map(account => account.account);
}

/** 钱包币种的符号;不认识就用 ISO 代码 */
export function currencyPrefix(currency: number | null | undefined, currencyISO = ''): string {
	return currency != null ? (currencySymbol(currency) || currencyISO || '') : '';
}

export function formatCentsIn(cents: number | null | undefined, currency: number | null | undefined, currencyISO = ''): string {
	return cents == null || !Number.isFinite(Number(cents)) ? '—' : `${currencyPrefix(currency, currencyISO)}${(Number(cents) / 100).toFixed(2)}`;
}

export interface PerAccountMax {
	/** false:算不了(没选账号 / 币种混合 / 单价无效) */
	ok: boolean;
	items: Array<{account: string; balance: number | null; qty: number; known: boolean}>;
	total: number;
	/** 有账号余额未知(按 0 件跳过) */
	unknown: boolean;
}

/** 「各账号按余额挂满」:每个账号各自 floor(余额 ÷ 单价) 件;用分做整除免浮点误差 */
export function perAccountMax(accounts: readonly MarketAccount[], pricePerItem: number | null): PerAccountMax {
	const current = selectedCurrency(accounts);
	const price = Number(pricePerItem);
	if (!accounts.length || current.mixed || current.currency == null || !Number.isFinite(price) || price <= 0) {
		return {ok: false, items: [], total: 0, unknown: false};
	}
	const priceCents = Math.round(price * 100);
	let unknown = false;
	const items = accounts.map(account => {
		const known = account.hasWallet && account.balance != null && Number.isFinite(Number(account.balance));
		if (!known) {
			unknown = true;
			return {account: account.account, balance: null, qty: 0, known: false};
		}
		const qty = priceCents > 0 ? Math.floor(Math.round(Number(account.balance) * 100) / priceCents) : 0;
		return {account: account.account, balance: Number(account.balance), qty: Math.max(0, qty), known: true};
	});
	return {ok: true, items, total: items.reduce((sum, item) => sum + item.qty, 0), unknown};
}

/** 挂单/刷新的并发线程数:1-8,填错用 2 */
export function clampMarketConcurrency(value: unknown): number {
	const n = Math.round(Number(value));
	return Math.max(1, Math.min(8, Number.isFinite(n) && n > 0 ? n : 2));
}

/** 「比最高求购高一档」:最高求购价 + 1 分(主单位) */
export function suggestedPrice(highestBuyOrderCents: number | null): number | null {
	return highestBuyOrderCents == null ? null : (Number(highestBuyOrderCents) + 1) / 100;
}

/** 数量:对账后有部分成交时显示「剩余/总」 */
export function quantityText(order: BuyOrder): string {
	const total = Number(order.quantity);
	const remaining = order.quantityRemaining;
	return remaining != null && Number(remaining) !== total ? `${Number(remaining)}/${total}` : String(total);
}

export interface PlaceSummary {
	level: 'success' | 'warning' | 'error';
	message: string;
	failed: PlaceResult[];
}

export function placeSummary(placed: number, results: readonly PlaceResult[]): PlaceSummary {
	const failed = results.filter(result => !result.ok);
	if (placed > 0 && !failed.length) {
		return {level: 'success', message: `已挂 ${placed} 张求购单`, failed};
	}
	if (placed > 0) {
		return {level: 'warning', message: `成功 ${placed} 张,失败 ${failed.length} 张`, failed};
	}
	return {level: 'error', message: '挂单失败:' + (failed[0]?.error || '未知错误'), failed};
}

/** 挂单确认框的文字 */
export function placeConfirmText(options: {
	accounts: number;
	itemName: string;
	concurrency: number;
	prefix: string;
	pricePerItem: number;
	quantity: number;
	max: PerAccountMax | null;
}): string {
	const item = options.itemName ? ':' + options.itemName : '';
	const price = `${options.prefix}${options.pricePerItem.toFixed(2)}`;
	const tail = '求购单只在卖家成交时才从钱包扣款。确认挂单?';
	if (options.max) {
		const lines = options.max.items.slice(0, 8).map(row => `· ${row.account}:${row.known ? row.qty + ' 件' : '余额未知(跳过)'}`);
		if (options.max.items.length > 8) {
			lines.push(`· …等 ${options.max.items.length} 个账号`);
		}
		return `将用 ${options.accounts} 个账号「按各自余额挂满」求购${item}(并发 ${options.concurrency} 线程)。\n`
			+ `每件 ${price},每个账号各自 floor(余额 ÷ 单价) 件,合计约 ${options.max.total} 件:\n${lines.join('\n')}\n${tail}`;
	}
	return `将用 ${options.accounts} 个账号挂求购单(并发 ${options.concurrency} 线程)${item}。\n`
		+ `每件 ${price} × ${options.quantity} 件 = 单账号总出价 ${options.prefix}${(options.pricePerItem * options.quantity).toFixed(2)}。\n${tail}`;
}

/** 刷新(对账)结果的提示 */
export function syncSummaryText(summary: {removed?: number; updated?: number} | null | undefined): string {
	const parts: string[] = [];
	if (summary?.removed) parts.push(`移除 ${summary.removed}`);
	if (summary?.updated) parts.push(`更新 ${summary.updated}`);
	return parts.length ? '已刷新:' + parts.join(',') : '已是最新';
}
