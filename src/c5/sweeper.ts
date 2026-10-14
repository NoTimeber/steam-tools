// 监控 + 扫货核心逻辑(从 c5 项目的 c5bot/sweeper.py 移来):每轮查一次行情,最低价跌到目标价以内就买,
// 买满数量或花完预算为止。下单前先落库,超时 / 断连的单按「结果未知」占住额度,之后按商户单号向平台对账。

import {randomInt} from 'node:crypto';
import type {C5Purchase, C5Store, C5Total, C5WatchItem} from '../store/c5.ts';
import {C5_COUNTED} from '../store/c5.ts';
import {C5Error, C5NetworkError} from './client.ts';
import type {C5Api, C5ItemStat} from './client.ts';
import type {C5Settings} from './config.ts';

export const EPS = 1e-6;
/** 买失败的在售,这段时间内不再尝试 */
export const FAILED_SKIP_MS = 60_000;
/** 结果未知的单多久查一次 */
export const UNKNOWN_RECHECK_MS = 5_000;
/** 结果未知、平台也没给过订单号的单,超过这么久仍查不到,按未成交处理 */
export const UNKNOWN_GIVEUP_MS = 120_000;
/** 未完结订单多久刷新一次状态 */
export const ORDER_RECHECK_MS = 300_000;
/** 每轮最多查几笔订单,避免拖慢监控 */
export const REFRESH_PER_CYCLE = 3;
/** 已取消 / 已撤回 */
export const ORDER_CANCELLED: readonly number[] = [11, 220];
/** 已收货 / 已结算 */
export const ORDER_FINAL: readonly number[] = [10, 200];

export interface Listing {
	productId: string;
	price: number;
	amount: number;
}

export type C5LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

/** 每轮结束后发布的快照(整体替换,不原地改) */
export interface SweepView {
	at: number | null;
	stats: Record<string, C5ItemStat>;
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

/** 行情接口里的在售最低价;没有或不是正数返回 null */
export function lowestPrice(stat: C5ItemStat | null | undefined): number | null {
	const value = toNumber(stat?.sellPrice);
	return value != null && value > 0 ? value : null;
}

function left(cap: number, used: number): number {
	return cap > 0 ? cap - used : Infinity;
}

/** 商户单号:毫秒时间戳 + 6 位随机数,纯数字 */
export function newOutTradeNo(now: number = Date.now()): string {
	return `${Math.floor(now)}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

export function parseListing(raw: unknown): Listing | null {
	const row = raw as {productId?: unknown; price?: unknown; assetInfo?: {amount?: unknown}} | null;
	const productId = row?.productId == null ? '' : String(row.productId).trim();
	const price = toNumber(row?.price);
	if (!/^\d+$/.test(productId) || price == null) {
		return null;
	}
	const amount = toNumber(row?.assetInfo?.amount) || 1;
	return {productId, price, amount: Number.isInteger(amount) ? amount : 1};
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
		// amount > 1 的堆叠在售不确定 price 是单价还是总价,不碰
		if (listing.price <= 0 || listing.amount !== 1 || skipIds.has(listing.productId)) {
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
	store: C5Store;
	client(): C5Api;
	settings(): C5Settings;
	/** 监控列表。网页上保存时整个换掉(不原地改),每轮开始时取一次快照 */
	items(): readonly C5WatchItem[];
	/** false = 只看行情不下单(随时可能变,每次下单前都看一眼) */
	canBuy(): boolean;
	log(level: C5LogLevel, message: string): void;
	now?: () => number;
	newOutTradeNo?: (now: number) => string;
}

export function createSweeper(deps: SweeperDeps) {
	const {store, log} = deps;
	const now = deps.now ?? Date.now;
	const nextOutTradeNo = deps.newOutTradeNo ?? newOutTradeNo;
	let skipUntil = new Map<string, number>();     // 在售 id -> 此时间前不再尝试
	const pauseUntil = new Map<string, number>();  // 饰品名 -> 此时间前不再下单
	const lastPrice = new Map<string, string>();
	let refreshRequested = false;
	let view: SweepView = {at: null, stats: {}, pauseUntil: {}, done: false};

	const qtyLeft = (item: C5WatchItem, totals: Map<string, C5Total>) => item.maxQty - (totals.get(item.name)?.qty ?? 0);
	const spendLeft = (item: C5WatchItem, totals: Map<string, C5Total>) => left(item.maxSpend, totals.get(item.name)?.spent ?? 0);

	function logPrice(item: C5WatchItem, stat: C5ItemStat, price: number | null): void {
		// 价格或目标价有变化才记一条,避免每 3 秒刷屏
		const key = `${price}|${item.maxPrice}`;
		if (lastPrice.get(item.name) === key) {
			return;
		}
		lastPrice.set(item.name, key);
		if (price == null) {
			log('warn', `查不到 ${item.name} 的行情,检查饰品名是不是正确的 marketHashName`);
		} else {
			log('debug', `${item.name} 最低 ${price.toFixed(2)}(目标 ≤ ${item.maxPrice.toFixed(2)}) 在售 ${stat.sellCount ?? '-'} 求购最高 ${stat.purchaseMaxPrice ?? '-'}`);
		}
	}

	function pause(item: C5WatchItem, reason: unknown, what = '下单被拒'): void {
		const cooldown = deps.settings().errorCooldownSec;
		pauseUntil.set(item.name, now() + cooldown * 1000);
		log('warn', `${item.name} ${what},暂停 ${cooldown} 秒: ${reason instanceof Error ? reason.message : String(reason)}`);
	}

	// ===== 主循环的一轮 =====

	/** 跑一轮。返回 false 表示没有要监控的、或所有目标都已买满 / 预算用完(且没有结果未知的单) */
	async function runCycle(): Promise<boolean> {
		const settings = deps.settings();
		const live = settings.mode === 'live';
		if (live) {
			const force = refreshRequested;
			refreshRequested = false;
			await refreshOrders(force ? null : REFRESH_PER_CYCLE, {force});
		}
		const items = deps.items();
		// 行情整张列表一起查(每个 appId 一个请求),买满的也照常显示最新价
		const stats: Record<string, C5ItemStat> = {};
		const client = deps.client();
		for (const appId of [...new Set(items.map(item => item.appId))].sort((a, b) => a - b)) {
			Object.assign(stats, await client.itemStats(appId, items.filter(item => item.appId === appId).map(item => item.name)));
		}

		const totals = store.totals(settings.mode);
		let budget = left(settings.maxTotalSpend, [...totals.values()].reduce((sum, total) => sum + total.spent, 0));
		const todo = items.filter(item => qtyLeft(item, totals) > 0 && spendLeft(item, totals) > EPS);
		if (!todo.length || budget <= EPS) {
			view = {at: now(), stats, pauseUntil: Object.fromEntries(pauseUntil), done: true};
			// 还有结果未知的单时先不算完:对账后可能释放额度
			return store.selectPurchases(settings.mode, ['unknown']).length > 0;
		}

		let cycleLeft = settings.maxBuyPerCycle;
		let balance: number | null = null;   // 实盘下有触发时才查
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
			if (live && balance == null) {
				balance = (toNumber((await client.balance()).moneyAmount) ?? 0) - settings.minBalanceReserve;
			}
			const money = Math.min(budget, spendLeft(item, totals), balance ?? Infinity);
			const qty = Math.min(qtyLeft(item, totals), cycleLeft);
			const [bought, cost] = settings.strategy === 'quick'
				? await sweepQuick(item, price, qty, money, settings)
				: await sweepListing(item, qty, money, settings);
			cycleLeft -= bought;
			budget -= cost;
			if (balance != null) {
				balance -= cost;
			}
		}
		view = {at: now(), stats, pauseUntil: Object.fromEntries(pauseUntil), done: false};
		return true;
	}

	// ===== listing 策略:查在售列表,按在售 id 批量买 =====

	async function sweepListing(item: C5WatchItem, qty: number, money: number, settings: C5Settings): Promise<[number, number]> {
		let raw: unknown[];
		try {
			raw = await deps.client().searchProducts({
				appId: item.appId, name: item.name, priceMax: item.maxPrice, delivery: item.delivery, assetType: item.assetType
			});
		} catch (err) {
			// 只是查询,没下单。只暂停这一个饰品,别的饰品这一轮照常扫(没加 IP 白名单时每个都会这样)
			if (!(err instanceof C5Error)) {
				throw err;
			}
			pause(item, err, '查在售失败');
			return [0, 0];
		}
		const at = now();
		skipUntil = new Map([...skipUntil].filter(([, until]) => until > at));
		const skipIds = new Set([...store.productIds(settings.mode), ...skipUntil.keys()]);
		const picks = pickListings(raw.map(parseListing).filter((listing): listing is Listing => !!listing), {
			maxPrice: item.maxPrice, qtyLeft: qty, budgetLeft: money, skipIds
		});
		if (!picks.length || !deps.canBuy()) {
			return [0, 0];
		}
		if (settings.mode === 'dry') {
			for (const pick of picks) {
				store.addPurchase({outTradeNo: nextOutTradeNo(at), ts: at, mode: 'dry', name: item.name, productId: pick.productId, price: pick.price, status: 'ok'});
			}
			const total = picks.reduce((sum, pick) => sum + pick.price, 0);
			log('success', `[模拟] 买入 ${item.name} × ${picks.length},合计 ${total.toFixed(2)}(${picks.map(pick => pick.price.toFixed(2)).join(' ')})`);
			return [picks.length, total];
		}
		return batchBuy(item, picks, settings);
	}

	async function batchBuy(item: C5WatchItem, picks: readonly Listing[], settings: C5Settings): Promise<[number, number]> {
		// 先落库再发请求:进程中途挂掉或超时,这几笔也会按「结果未知」占住预算
		const orders = new Map<string, Listing>();
		for (const pick of picks) {
			const outTradeNo = nextOutTradeNo(now());
			orders.set(outTradeNo, pick);
			store.addPurchase({outTradeNo, ts: now(), mode: 'live', name: item.name, productId: pick.productId, price: pick.price, status: 'unknown'});
		}
		let data: Awaited<ReturnType<C5Api['batchBuy']>>;
		try {
			data = await deps.client().batchBuy(settings.tradeUrl, [...orders].map(([outTradeNo, pick]) => ({
				productId: pick.productId, buyPrice: pick.price, outTradeNo
			})));
		} catch (err) {
			if (err instanceof C5NetworkError) {
				log('error', `${item.name} 下单结果未知(${err.message}),${picks.length} 笔先按已花费计入预算,稍后自动对账`);
				return [picks.length, picks.reduce((sum, pick) => sum + pick.price, 0)];
			}
			if (err instanceof C5Error) {
				for (const outTradeNo of orders.keys()) {
					store.updatePurchase(outTradeNo, {status: 'failed', error: err.message});
				}
				pause(item, err);
				return [0, 0];
			}
			throw err;
		}

		let bought = 0;
		let cost = 0;
		for (const row of Array.isArray(data.successList) ? data.successList : []) {
			const outTradeNo = String(row?.outTradeNo ?? '');
			const pick = orders.get(outTradeNo);
			if (!pick) {
				continue;
			}
			orders.delete(outTradeNo);
			const pay = toNumber(row.actualPay) || pick.price;
			store.updatePurchase(outTradeNo, {status: 'ok', orderId: String(row.orderId ?? ''), actualPay: pay});
			log('success', `买入 ${item.name} ${pay.toFixed(2)},订单 ${row.orderId ?? '-'}`);
			bought += 1;
			cost += pay;
		}
		for (const row of Array.isArray(data.failedList) ? data.failedList : []) {
			const outTradeNo = String(row?.outTradeNo ?? '');
			const pick = orders.get(outTradeNo);
			if (!pick) {
				continue;
			}
			orders.delete(outTradeNo);
			store.updatePurchase(outTradeNo, {status: 'failed', error: row.failReason ? `平台返回购买失败: ${row.failReason}` : '平台返回购买失败'});
			skipUntil.set(pick.productId, now() + FAILED_SKIP_MS);
			log('info', `没买到 ${item.name} ${pick.price.toFixed(2)}(在售 ${pick.productId})`);
		}
		for (const [outTradeNo, pick] of orders) {   // 两个列表里都没有的,保持未知,等对账
			log('warn', `${item.name} 单号 ${outTradeNo} 不在返回结果里,先按已花费计入预算`);
			bought += 1;
			cost += pick.price;
		}
		return [bought, cost];
	}

	// ===== quick 策略:平台挑最低价,一次一件 =====

	async function sweepQuick(item: C5WatchItem, price: number, qty: number, money: number, settings: C5Settings): Promise<[number, number]> {
		const target = item.maxPrice;
		if (settings.mode === 'dry') {
			// 拿不到在售明细,每轮按当前最低价模拟买一件
			if (price > money + EPS) {
				return [0, 0];
			}
			store.addPurchase({outTradeNo: nextOutTradeNo(now()), ts: now(), mode: 'dry', name: item.name, productId: '', price, status: 'ok'});
			log('success', `[模拟] 快速购买 ${item.name} ${price.toFixed(2)}`);
			return [1, price];
		}

		let bought = 0;
		let cost = 0;
		// 成交价事先不知道,预算按目标价预留
		while (bought < qty && target <= money - cost + EPS && deps.canBuy()) {
			const outTradeNo = nextOutTradeNo(now());
			store.addPurchase({outTradeNo, ts: now(), mode: 'live', name: item.name, productId: '', price: target, status: 'unknown'});
			let data: Awaited<ReturnType<C5Api['quickBuy']>>;
			try {
				data = await deps.client().quickBuy({
					outTradeNo, tradeUrl: settings.tradeUrl, appId: item.appId, name: item.name, maxPrice: target, delivery: item.delivery
				});
			} catch (err) {
				if (err instanceof C5NetworkError) {
					log('error', `${item.name} 下单结果未知(${err.message}),先按 ${target.toFixed(2)} 计入预算,稍后自动对账`);
					return [bought + 1, cost + target];
				}
				if (err instanceof C5Error) {
					store.updatePurchase(outTradeNo, {status: 'failed', error: err.message});
					pause(item, err);
					break;
				}
				throw err;
			}
			// payStatus:0 支付中 / 1 支付成功 / 2 支付失败
			const payStatus = toNumber(data.payStatus);
			if (payStatus === 2) {
				store.updatePurchase(outTradeNo, {status: 'failed', error: '支付失败'});
				pause(item, '支付失败');
				break;
			}
			const pay = toNumber(data.actualPay) || target;
			const orderId = String(data.orderId ?? '');
			if (payStatus === 1) {
				store.updatePurchase(outTradeNo, {status: 'ok', orderId, actualPay: pay});
				log('success', `买入 ${item.name} ${pay.toFixed(2)},订单 ${orderId || '-'}`);
			} else {
				// 支付中(或没给支付状态):成没成交还不知道,保持未知、照样占额度,交给对账
				store.updatePurchase(outTradeNo, {orderId, actualPay: pay});
				log('info', `${item.name} 已下单,平台${payStatus === 0 ? '支付中' : '没返回支付状态'},先按 ${pay.toFixed(2)} 计入预算,稍后自动对账`);
			}
			bought += 1;
			cost += pay;
		}
		return [bought, cost];
	}

	// ===== 对账 =====

	/** 结果未知的单查清楚,未完结的单刷新状态;被取消的不再占用数量和预算。limit = null 不限。返回查了几笔 */
	async function refreshOrders(limit: number | null = null, {force = false}: {force?: boolean} = {}): Promise<number> {
		const at = now();
		const due = store.selectPurchases('live', C5_COUNTED)
			.filter(purchase => !ORDER_FINAL.includes(purchase.orderStatus ?? -1))
			.filter(purchase => force || at - purchase.checkedAt >= (purchase.status === 'unknown' ? UNKNOWN_RECHECK_MS : ORDER_RECHECK_MS))
			.sort((a, b) => a.checkedAt - b.checkedAt)   // 最久没查的优先,谁也不会被饿死
			.slice(0, limit ?? undefined);
		for (const purchase of due) {
			await refreshOne(purchase, at);
		}
		return due.length;
	}

	async function refreshOne(purchase: C5Purchase, at: number): Promise<void> {
		let detail: any;
		try {
			detail = await deps.client().orderDetail(purchase.outTradeNo);
		} catch (err) {
			if (!(err instanceof C5Error)) {
				throw err;
			}
			// 查询本身失败不代表订单不存在,状态保持不变
			store.updatePurchase(purchase.outTradeNo, {checkedAt: at});
			log('warn', `查询订单 ${purchase.outTradeNo} 失败: ${err.message}`);
			return;
		}
		if (detail == null) {
			// 平台已经给过订单号的(快速购买支付中)确实下了单,查不到是查询的问题,不按未成交释放,留给手工核对
			if (purchase.status === 'unknown' && !purchase.orderId && at - purchase.ts > UNKNOWN_GIVEUP_MS) {
				store.updatePurchase(purchase.outTradeNo, {status: 'failed', error: '对账:平台没有这笔订单', checkedAt: at});
				log('info', `对账:${purchase.name} 单号 ${purchase.outTradeNo} 平台没有订单,按未成交处理`);
			} else {
				store.updatePurchase(purchase.outTradeNo, {checkedAt: at});
			}
			return;
		}

		// 订单详情里的金额文档写的是美元,和在售价的单位对不上,不拿来改花费
		const orderStatus = toNumber(detail.status) ?? 0;
		const orderId = String(detail.orderId || purchase.orderId || '');
		const fields: Parameters<C5Store['updatePurchase']>[1] = {
			orderStatus,
			orderStatusName: detail.statusName == null ? null : String(detail.statusName),
			checkedAt: at,
			orderId,
			productId: String(detail.productId || purchase.productId)
		};
		if (ORDER_CANCELLED.includes(orderStatus)) {
			fields.status = 'cancelled';
			fields.error = String(detail.failedDesc || detail.statusName || '已取消');
			log('warn', `${purchase.name} 订单 ${orderId} 已取消(${fields.error}),释放额度`);
		} else if (purchase.status === 'unknown') {
			fields.status = 'ok';
			log('success', `对账:${purchase.name} 单号 ${purchase.outTradeNo} 已成交`);
		}
		store.updatePurchase(purchase.outTradeNo, fields);
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
