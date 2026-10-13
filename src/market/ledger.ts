// 求购单本地账本(data/market-buyorders.json,从 app/server.js 移来):只记本工具挂出的求购,
// 供「我的求购单」列表、撤单和对账用。新记录在前。
//
// 每次改动都是「读文件 → 改 → 原子写回」一气呵成,中间没有 await。
// 旧代码在挂单请求开头读账本、几分钟后(多账号挂单 + 手机确认)才写回,
// 期间的撤单、刷新、另一批挂单都会被这次写回覆盖掉。

import type {LiveBuyOrder} from './client.ts';
import type {MarketLog} from './client.ts';

export interface BuyOrderRecord {
	id: string;
	createdAt: string;
	account: string;
	attemptId: string;
	steamID: string;
	appid: number;
	marketHashName: string;
	itemName: string;
	currency: number;
	currencyISO: string;
	pricePerItemCents: number;
	quantity: number;
	priceTotalCents: number;
	buyOrderId: string;
	/** pending_confirm:已提交但手机确认没走完 */
	status: 'active' | 'pending_confirm';
	/** 对账时从 Steam 拿到的剩余数量 */
	quantityRemaining?: number | null;
}

export interface LedgerOptions {
	file: string;
	readJson(file: string): unknown;
	writeJson(file: string, value: unknown): void;
	log?: MarketLog;
}

export interface ReconcileResult {
	orders: BuyOrderRecord[];
	removed: number;
	updated: number;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createBuyOrderLedger(options: LedgerOptions) {
	const log: MarketLog = options.log ?? (() => {});

	function list(): BuyOrderRecord[] {
		const data = options.readJson(options.file);
		return Array.isArray(data) ? data as BuyOrderRecord[] : [];
	}

	function save(records: BuyOrderRecord[]): void {
		try {
			options.writeJson(options.file, records);
		} catch (err) {
			log('warn', `[market-buyorder] 账本保存失败: ${errorText(err)}`);
		}
	}

	function find(id: string): BuyOrderRecord | null {
		return list().find(record => record.id === id) ?? null;
	}

	function add(record: BuyOrderRecord): void {
		save([record, ...list()]);
	}

	/** 撤单成功后删掉这个 buy_orderid 的所有记录 */
	function removeBuyOrder(buyOrderId: string): void {
		save(list().filter(record => record.buyOrderId !== buyOrderId));
	}

	/**
	 * 用 Steam 上实拉的求购单对账。live:账号名 → (buy_orderid → 求购单),只含拉取成功的账号。
	 * 这些账号的记录:Steam 上已经没有的(成交/撤销/过期)删掉,还在的标成 active 并更新剩余数量。
	 * 其它账号(离线/拉取失败)和 since 之后才记下的(拉取时 Steam 上可能还没有)原样保留。
	 */
	function reconcile(live: ReadonlyMap<string, ReadonlyMap<string, LiveBuyOrder>>, since: number): ReconcileResult {
		let removed = 0;
		let updated = 0;
		const orders: BuyOrderRecord[] = [];
		for (const record of list()) {
			const liveOrders = live.get(record.account);
			const createdAt = Date.parse(record.createdAt);
			if (!liveOrders || (Number.isFinite(createdAt) && createdAt >= since)) {
				orders.push(record);
				continue;
			}
			const found = record.buyOrderId ? liveOrders.get(String(record.buyOrderId)) : undefined;
			if (!found) {
				removed++;
				continue;
			}
			const remaining = found.quantityRemaining != null ? found.quantityRemaining : record.quantityRemaining;
			if (record.status !== 'active' || record.quantityRemaining !== remaining) {
				updated++;
			}
			orders.push({...record, status: 'active', quantityRemaining: remaining});
		}
		save(orders);
		return {orders, removed, updated};
	}

	return {list, find, add, removeBuyOrder, reconcile};
}

export type BuyOrderLedger = ReturnType<typeof createBuyOrderLedger>;
