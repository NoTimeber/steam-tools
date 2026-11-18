// ECO 监控 + 扫货核心逻辑:每轮批量查一次行情,最低价跌到目标价以内就买,买满数量或花完预算为止。
// 下单前先落库,超时 / 断连 / 系统异常的单按「结果未知」占住额度,之后按商户单号向平台对账。

import {randomInt} from 'node:crypto';
import type {EcoPurchase, EcoStore, EcoTotal, EcoWatchItem} from '../store/eco.ts';
import {ECO_COUNTED} from '../store/eco.ts';
import {ECO_CODE, EcoError, EcoNetworkError} from './client.ts';
import type {EcoApi, EcoBuyResult, EcoItemStat, EcoOrderStatus} from './client.ts';
import type {EcoSettings} from './config.ts';

export const EPS = 1e-6;
/** 买失败(价格变了、不可购买)的商品,这段时间内不再尝试 */
export const FAILED_SKIP_MS = 60_000;
/** 结果未知的单多久查一次 */
export const UNKNOWN_RECHECK_MS = 5_000;
/** 结果未知、平台也没给过订单号的单,超过这么久仍查不到,按未成交处理 */
export const UNKNOWN_GIVEUP_MS = 120_000;
/** 未完结订单多久刷新一次状态 */
export const ORDER_RECHECK_MS = 300_000;
/** 每轮最多对账几笔(一个批量请求),避免拖慢监控 */
export const REFRESH_PER_CYCLE = 20;
/** 交易取消 */
export const ORDER_CANCELLED: readonly number[] = [3];
/** 交易成功 */
export const ORDER_FINAL: readonly number[] = [6];

export interface Listing {
	goodsNum: string;
	price: number;
}

export type EcoLogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

/** 每轮结束后发布的快照(整体替换,不原地改) */
export interface SweepView {
	at: number | null;
	stats: Record<string, EcoItemStat>;
	pauseUntil: Record<string, number>;
	/** 没有要监控的、或所有目标都已买满 / 预算用完 */
	done: boolean;
}

export function toNumber(value: unknown): number | null {
	if (value == null || value === '') {
		return null;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/** 行情里的在售最低价;没有或不是正数返回 null */
export function lowestPrice(stat: EcoItemStat | null | undefined): number | null {
	const value = toNumber(stat?.MinPrice);
	return value != null && value > 0 ? value : null;
}

function left(cap: number, used: number): number {
	return cap > 0 ? cap - used : Infinity;
}

/** 商户单号:毫秒时间戳 + 6 位随机数,纯数字 */
export function newMerchantNo(now: number = Date.now()): string {
	return `${Math.floor(now)}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

export function parseListing(raw: unknown): Listing | null {
	const row = raw as {GoodsNum?: unknown; SellingPrice?: unknown} | null;
	const goodsNum = row?.GoodsNum == null ? '' : String(row.GoodsNum).trim();
	const price = toNumber(row?.SellingPrice);
	if (!goodsNum || price == null || price <= 0) {
		return null;
	}
	return {goodsNum, price};
}

/** 从在售里挑要买的:价格从低到高,直到数量或预算用完 */
export function pickListings(listings: readonly Listing[], {maxPrice, qtyLeft, budgetLeft, skipIds = new Set<string>()}: {
	maxPrice: number;
	qtyLeft: number;
	budgetLeft: number;
	skipIds?: ReadonlySet<string>;
}): Listing[] {
	const picks: Listing[] = [];
	let budget = budgetLeft;
	for (const listing of [...listings].sort((a, b) => a.price - b.price)) {
		if (picks.length >= qtyLeft || listing.price > maxPrice + EPS) {
			break;
		}
		if (skipIds.has(listing.goodsNum)) {
			continue;
		}
		if (listing.price > budget + EPS) {
			break;
		}
		picks.push(listing);
		budget -= listing.price;
	}
	return picks;
}

export interface SweeperDeps {
	store: EcoStore;
	client(): EcoApi;
	settings(): EcoSettings;
	/** 监控列表。网页上保存时整个换掉(不原地改),每轮开始时取一次快照 */
	items(): readonly EcoWatchItem[];
	/** false = 已停止,不再下单(随时可能变,每次下单前都看一眼) */
	canBuy(): boolean;
	log(level: EcoLogLevel, message: string): void;
	/** 日志里显示的饰品名(有中文用中文);默认就是英文名 */
	label?: (name: string) => string;
	now?: () => number;
	newMerchantNo?: (now: number) => string;
}

export function createSweeper(deps: SweeperDeps) {
	const {store, log} = deps;
	const now = deps.now ?? Date.now;
	const nextMerchantNo = deps.newMerchantNo ?? newMerchantNo;
	const label = deps.label ?? ((name: string) => name);
	let skipUntil = new Map<string, number>();     // 商品编号 -> 此时间前不再尝试
	const pauseUntil = new Map<string, number>();  // 饰品名 -> 此时间前不再下单
	const lastPrice = new Map<string, string>();
	let refreshRequested = false;
	let view: SweepView = {at: null, stats: {}, pauseUntil: {}, done: false};

	const qtyLeft = (item: EcoWatchItem, totals: Map<string, EcoTotal>) => item.maxQty - (totals.get(item.name)?.qty ?? 0);
	const spendLeft = (item: EcoWatchItem, totals: Map<string, EcoTotal>) => left(item.maxSpend, totals.get(item.name)?.spent ?? 0);

	function logPrice(item: EcoWatchItem, stat: EcoItemStat, price: number | null): void {
		// 价格或目标价有变化才记一条,避免每轮刷屏
		const key = `${price}|${item.maxPrice}`;
		if (lastPrice.get(item.name) === key) {
			return;
		}
		lastPrice.set(item.name, key);
		if (price == null) {
			log('warn', label(item.name) === item.name
				? `查不到 ${item.name} 的行情,检查饰品名是不是正确的 HashName(Steam 市场英文名)`
				: `查不到 ${label(item.name)}(${item.name})的行情,ECO 上可能暂时没有在售`);
		} else {
			log('debug', `${label(item.name)} 最低 ${price.toFixed(2)}(目标 ≤ ${item.maxPrice.toFixed(2)}) 在售 ${stat.SellCount ?? '-'} 求购最高 ${stat.QGMaxPrice ?? '-'}`);
		}
	}

	function pause(item: EcoWatchItem, reason: unknown, what = '下单被拒'): void {
		const cooldown = deps.settings().errorCooldownSec;
		pauseUntil.set(item.name, now() + cooldown * 1000);
		log('warn', `${label(item.name)} ${what},暂停 ${cooldown} 秒: ${reason instanceof Error ? reason.message : String(reason)}`);
	}

	// ===== 主循环的一轮 =====

	/** 跑一轮。返回 false 表示没有要监控的、或所有目标都已买满 / 预算用完(且没有结果未知的单) */
	async function runCycle(): Promise<boolean> {
		const settings = deps.settings();
		const force = refreshRequested;
		refreshRequested = false;
		await refreshOrders(force ? null : REFRESH_PER_CYCLE, {force});
		const items = deps.items();
		// 行情整张列表一起查(每个游戏一个请求),买满的也照常显示最新价
		const stats: Record<string, EcoItemStat> = {};
		const client = deps.client();
		for (const gameId of [...new Set(items.map(item => item.gameId))].sort((a, b) => a - b)) {
			Object.assign(stats, await client.itemStats(gameId, items.filter(item => item.gameId === gameId).map(item => item.name)));
		}

		const totals = store.totals();
		let budget = left(settings.maxTotalSpend, [...totals.values()].reduce((sum, total) => sum + total.spent, 0));
		const todo = items.filter(item => qtyLeft(item, totals) > 0 && spendLeft(item, totals) > EPS);
		if (!todo.length || budget <= EPS) {
			view = {at: now(), stats, pauseUntil: Object.fromEntries(pauseUntil), done: true};
			// 还有结果未知的单时先不算完:对账后可能释放额度
			return store.selectPurchases(['unknown']).length > 0;
		}

		let cycleLeft = settings.maxBuyPerCycle;
		let balance: number | null = null;   // 有饰品到价时才查
		for (const item of todo) {
			const stat = stats[item.name] ?? {};
			const price = lowestPrice(stat);
			logPrice(item, stat, price);
			if (price == null || price > item.maxPrice + EPS) {
				continue;
			}
			if (!deps.canBuy() || cycleLeft <= 0 || now() < (pauseUntil.get(item.name) ?? 0)) {
				continue;
			}
			balance ??= (toNumber((await client.balance()).Money) ?? 0) - settings.minBalanceReserve;
			const money = Math.min(budget, spendLeft(item, totals), balance);
			const qty = Math.min(qtyLeft(item, totals), cycleLeft);
			const [bought, cost] = settings.strategy === 'quick'
				? await sweepQuick(item, qty, money, settings)
				: await sweepListing(item, qty, money, settings);
			cycleLeft -= bought;
			budget -= cost;
			balance -= cost;
		}
		view = {at: now(), stats, pauseUntil: Object.fromEntries(pauseUntil), done: false};
		return true;
	}

	/** 下单成功:记成交 */
	function recordOk(item: EcoWatchItem, merchantNo: string, result: EcoBuyResult, fallbackPrice: number): number {
		const pay = toNumber(result.PaymentPrice) || fallbackPrice;
		const orderNo = String(result.OrderNo ?? '');
		store.updatePurchase(merchantNo, {status: 'ok', orderNo: orderNo || null, actualPay: pay});
		log('success', `买入 ${label(item.name)} ${pay.toFixed(2)},订单 ${orderNo || '-'}`);
		return pay;
	}

	/** 商户单号重复:平台上已经有这笔单(重发了),保持未知、记下订单号,交给对账 */
	function recordDuplicate(item: EcoWatchItem, merchantNo: string, err: EcoError): void {
		const ids = (err.data as {OrderIdList?: unknown} | null)?.OrderIdList;
		const orderNo = Array.isArray(ids) && ids.length ? String(ids[0]) : null;
		store.updatePurchase(merchantNo, {orderNo, error: err.message});
		log('warn', `${label(item.name)} 单号 ${merchantNo} 平台说已下过单${orderNo ? `(订单 ${orderNo})` : ''},先按已花费计入预算,稍后自动对账`);
	}

	// ===== listing 策略:查在售列表,按商品编号逐件买 =====

	async function sweepListing(item: EcoWatchItem, qty: number, money: number, settings: EcoSettings): Promise<[number, number]> {
		let raw: unknown[];
		try {
			raw = await deps.client().sellGoods({gameId: item.gameId, name: item.name});
		} catch (err) {
			// 只是查询,没下单。只暂停这一个饰品,别的饰品这一轮照常扫
			if (!(err instanceof EcoError)) {
				throw err;
			}
			pause(item, err, '查在售失败');
			return [0, 0];
		}
		const at = now();
		skipUntil = new Map([...skipUntil].filter(([, until]) => until > at));
		const skipIds = new Set([...store.goodsNums(), ...skipUntil.keys()]);
		// 目标价以内、没买过的全部候选,从低到高;某件没买到(价格变了 / 被买走)就接着试下一件,直到数量或预算用完
		const candidates = pickListings(raw.map(parseListing).filter((listing): listing is Listing => !!listing), {
			maxPrice: item.maxPrice, qtyLeft: Infinity, budgetLeft: Infinity, skipIds
		});

		let bought = 0;
		let cost = 0;
		for (const pick of candidates) {
			if (bought >= qty || pick.price > money - cost + EPS || !deps.canBuy()) {
				break;
			}
			// 先落库再发请求:进程中途挂掉或超时,这笔也会按「结果未知」占住预算
			const merchantNo = nextMerchantNo(now());
			store.addPurchase({merchantNo, ts: now(), name: item.name, goodsNum: pick.goodsNum, price: pick.price, status: 'unknown'});
			try {
				const result = await deps.client().buyByGoodsNum({
					goodsNum: pick.goodsNum, price: pick.price, tradeLink: settings.tradeUrl, merchantNo, gameId: item.gameId
				});
				cost += recordOk(item, merchantNo, result, pick.price);
				bought += 1;
			} catch (err) {
				if (err instanceof EcoNetworkError) {
					log('error', `${label(item.name)} 下单结果未知(${err.message}),先按 ${pick.price.toFixed(2)} 计入预算,稍后自动对账`);
					return [bought + 1, cost + pick.price];
				}
				if (!(err instanceof EcoError)) {
					throw err;
				}
				if (err.code === ECO_CODE.duplicateMerchantNo) {
					recordDuplicate(item, merchantNo, err);
					bought += 1;
					cost += pick.price;
					continue;
				}
				store.updatePurchase(merchantNo, {status: 'failed', error: err.message});
				if (err.code === ECO_CODE.priceChanged || err.code === ECO_CODE.notBuyable) {
					// 这件被别人买走 / 改价了,跳过它接着买下一件
					skipUntil.set(pick.goodsNum, now() + FAILED_SKIP_MS);
					log('info', `没买到 ${label(item.name)} ${pick.price.toFixed(2)}(商品 ${pick.goodsNum}): ${err.message}`);
					continue;
				}
				// 余额不足、交易链接失效、没开购买权限、请求太快……这个饰品先停一会
				pause(item, err);
				break;
			}
		}
		return [bought, cost];
	}

	// ===== quick 策略:指定类别购买,平台挑不高于目标价的一件,一次一件 =====

	async function sweepQuick(item: EcoWatchItem, qty: number, money: number, settings: EcoSettings): Promise<[number, number]> {
		const target = item.maxPrice;
		let bought = 0;
		let cost = 0;
		// 成交价事先不知道,预算按目标价预留
		while (bought < qty && target <= money - cost + EPS && deps.canBuy()) {
			const merchantNo = nextMerchantNo(now());
			store.addPurchase({merchantNo, ts: now(), name: item.name, goodsNum: '', price: target, status: 'unknown'});
			let results: EcoBuyResult[];
			try {
				results = await deps.client().buyByHashName({gameId: item.gameId, name: item.name, price: target, tradeLink: settings.tradeUrl, merchantNo});
			} catch (err) {
				if (err instanceof EcoNetworkError) {
					log('error', `${label(item.name)} 下单结果未知(${err.message}),先按 ${target.toFixed(2)} 计入预算,稍后自动对账`);
					return [bought + 1, cost + target];
				}
				if (!(err instanceof EcoError)) {
					throw err;
				}
				if (err.code === ECO_CODE.duplicateMerchantNo) {
					recordDuplicate(item, merchantNo, err);
					return [bought + 1, cost + target];
				}
				store.updatePurchase(merchantNo, {status: 'failed', error: err.message});
				pause(item, err);
				break;
			}
			const result = results.find(row => row?.OrderNo);
			if (!result) {
				// 平台说成功但没给订单:多半是目标价以内已经没货了。不占额度,下一轮再看
				store.updatePurchase(merchantNo, {status: 'failed', error: '平台没有返回订单(目标价以内可能已没货)'});
				log('info', `${label(item.name)} 目标价 ${target.toFixed(2)} 以内没买到`);
				break;
			}
			cost += recordOk(item, merchantNo, result, target);
			bought += 1;
		}
		return [bought, cost];
	}

	// ===== 对账 =====

	/** 结果未知的单查清楚,未完结的单刷新状态;被取消的不再占用数量和预算。limit = null 不限。返回查了几笔 */
	async function refreshOrders(limit: number | null = null, {force = false}: {force?: boolean} = {}): Promise<number> {
		const at = now();
		const due = store.selectPurchases(ECO_COUNTED)
			.filter(purchase => !ORDER_FINAL.includes(purchase.orderState ?? -1))
			.filter(purchase => force || at - purchase.checkedAt >= (purchase.status === 'unknown' ? UNKNOWN_RECHECK_MS : ORDER_RECHECK_MS))
			.sort((a, b) => a.checkedAt - b.checkedAt)   // 最久没查的优先,谁也不会被饿死
			.slice(0, limit ?? undefined);
		if (!due.length) {
			return 0;
		}
		let rows: EcoOrderStatus[];
		try {
			rows = await deps.client().orderStatus(due.map(purchase => purchase.merchantNo));
		} catch (err) {
			if (!(err instanceof EcoError)) {
				throw err;
			}
			// 查询本身失败不代表订单不存在,状态保持不变
			for (const purchase of due) {
				store.updatePurchase(purchase.merchantNo, {checkedAt: at});
			}
			log('warn', `查询订单状态失败(${due.length} 笔): ${err.message}`);
			return due.length;
		}
		const byMerchantNo = new Map(rows.filter(row => row?.MerchantNo).map(row => [String(row.MerchantNo), row]));
		for (const purchase of due) {
			applyStatus(purchase, byMerchantNo.get(purchase.merchantNo) ?? null, at);
		}
		return due.length;
	}

	function applyStatus(purchase: EcoPurchase, row: EcoOrderStatus | null, at: number): void {
		if (!row) {
			// 平台已经给过订单号的确实下了单,查不到是查询的问题,不按未成交释放,留给手工核对
			if (purchase.status === 'unknown' && !purchase.orderNo && at - purchase.ts > UNKNOWN_GIVEUP_MS) {
				store.updatePurchase(purchase.merchantNo, {status: 'failed', error: '对账:平台没有这笔订单', checkedAt: at});
				log('info', `对账:${label(purchase.name)} 单号 ${purchase.merchantNo} 平台没有订单,按未成交处理`);
			} else {
				store.updatePurchase(purchase.merchantNo, {checkedAt: at});
			}
			return;
		}
		const orderState = toNumber(row.OrderStateCode) ?? 0;
		const orderNo = String(row.OrderNum || purchase.orderNo || '');
		const fields: Parameters<EcoStore['updatePurchase']>[1] = {
			orderState,
			orderStateName: row.OrderState == null ? null : String(row.OrderState),
			checkedAt: at,
			orderNo: orderNo || null
		};
		if (purchase.actualPay == null && toNumber(row.OrderAmount) != null) {
			fields.actualPay = toNumber(row.OrderAmount);
		}
		if (ORDER_CANCELLED.includes(orderState)) {
			fields.status = 'cancelled';
			fields.error = String(row.Reason || row.OrderState || '已取消');
			log('warn', `${label(purchase.name)} 订单 ${orderNo || purchase.merchantNo} 已取消(${fields.error}),释放额度`);
		} else if (purchase.status === 'unknown') {
			fields.status = 'ok';
			log('success', `对账:${label(purchase.name)} 单号 ${purchase.merchantNo} 已成交`);
		}
		store.updatePurchase(purchase.merchantNo, fields);
	}

	return {
		runCycle,
		refreshOrders,
		/** 下一轮开头对全部未完结订单对账 */
		requestRefresh(): void {
			refreshRequested = true;
		},
		view(): SweepView {
			return view;
		}
	};
}

export type Sweeper = ReturnType<typeof createSweeper>;
