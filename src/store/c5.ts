// C5 扫货的数据:app-key(vault 密文,存在 settings 表)、运行设置和运行状态(settings 表明文 JSON)、
// 监控列表(c5_watch_items)、购买流水(c5_purchases)。校验在 src/c5/config.ts,这里只管存取。

import type {Db, Row} from '../core/db.ts';
import {nowIso, num, str, strOrNull, transaction} from '../core/db.ts';
import type {Vault} from '../core/vault.ts';
import type {SettingsStore} from './settings.ts';

const APP_KEY_SETTING = 'c5.appKey';
const APP_KEY_PURPOSE = 'c5.app_key';
const SETTINGS_KEY = 'c5.settings';
const RUN_STATE_KEY = 'c5.run';

/** dry 是旧版本模拟模式留下的记录(现在不再写入、也不显示);live 是真实下单 */
export type C5Mode = 'dry' | 'live';
export type C5PurchaseStatus = 'unknown' | 'ok' | 'failed' | 'cancelled';

/** 占用数量和预算的状态:结果未知的按已花费算,宁可少买 */
export const C5_COUNTED: readonly C5PurchaseStatus[] = ['ok', 'unknown'];

export interface C5WatchItem {
	/** Steam 市场英文名(marketHashName),如 Kilowatt Case */
	name: string;
	/** 单价不高于此值才买 */
	maxPrice: number;
	/** 累计最多买几个,重启不清零 */
	maxQty: number;
	/** 这个饰品累计花费上限,0 不限(仍受总预算约束) */
	maxSpend: number;
	/** 730 = CS2 */
	appId: number;
	/** 0 不限 / 1 只要人工发货 / 2 只要自动发货 */
	delivery: number;
	/** 1 普通在售 / 2 冷却期在售 */
	assetType: number;
}

export interface C5Purchase {
	/** 商户单号,我方生成 */
	outTradeNo: string;
	ts: number;
	mode: C5Mode;
	name: string;
	/** 在售 id;快速购买下单前不知道,为空 */
	productId: string;
	/** 下单价(快速购买记目标价) */
	price: number;
	status: C5PurchaseStatus;
	orderId: string | null;
	actualPay: number | null;
	/** 平台订单状态码和文字,见 src/c5/sweeper.ts 的 ORDER_* */
	orderStatus: number | null;
	orderStatusName: string | null;
	/** 上次向平台查询这笔单的时间 */
	checkedAt: number;
	error: string | null;
}

export type C5PurchaseUpdate = Partial<Pick<C5Purchase, 'status' | 'productId' | 'orderId' | 'actualPay' | 'orderStatus' | 'orderStatusName' | 'checkedAt' | 'error'>>;

export interface C5Total {
	qty: number;
	spent: number;
}

/** 实际成交价;平台没给时按下单价 */
export function purchaseCost(purchase: Pick<C5Purchase, 'actualPay' | 'price'>): number {
	return purchase.actualPay ?? purchase.price;
}

export interface C5Store {
	/** 没存过返回 '' */
	getAppKey(): string;
	/** 传 '' 删除 */
	setAppKey(appKey: string): void;
	loadSettings(): Record<string, unknown> | undefined;
	saveSettings(settings: object): void;
	loadRunState(): string | undefined;
	saveRunState(state: string): void;

	listItems(): C5WatchItem[];
	replaceItems(items: readonly C5WatchItem[]): void;

	addPurchase(purchase: Pick<C5Purchase, 'outTradeNo' | 'ts' | 'mode' | 'name' | 'productId' | 'price' | 'status'>): void;
	updatePurchase(outTradeNo: string, fields: C5PurchaseUpdate): void;
	getPurchase(outTradeNo: string): C5Purchase | null;
	/** 按时间先后 */
	selectPurchases(mode: C5Mode, statuses?: readonly C5PurchaseStatus[]): C5Purchase[];
	/** 最近的 limit 笔,新的在前 */
	recentPurchases(mode: C5Mode, limit: number): C5Purchase[];
	/** 每个饰品已占用的数量和花费 */
	totals(mode: C5Mode): Map<string, C5Total>;
	/** 已经下过单(含结果未知)的在售 id,不再重复买 */
	productIds(mode: C5Mode): Set<string>;
}

const UPDATABLE: Record<keyof C5PurchaseUpdate, string> = {
	status: 'status',
	productId: 'product_id',
	orderId: 'order_id',
	actualPay: 'actual_pay',
	orderStatus: 'order_status',
	orderStatusName: 'order_status_name',
	checkedAt: 'checked_at',
	error: 'error'
};

function toPurchase(row: Row): C5Purchase {
	return {
		outTradeNo: str(row, 'out_trade_no'),
		ts: num(row, 'ts') ?? 0,
		mode: str(row, 'mode') === 'live' ? 'live' : 'dry',
		name: str(row, 'name'),
		productId: str(row, 'product_id'),
		price: num(row, 'price') ?? 0,
		status: str(row, 'status') as C5PurchaseStatus,
		orderId: strOrNull(row, 'order_id'),
		actualPay: num(row, 'actual_pay'),
		orderStatus: num(row, 'order_status'),
		orderStatusName: strOrNull(row, 'order_status_name'),
		checkedAt: num(row, 'checked_at') ?? 0,
		error: strOrNull(row, 'error')
	};
}

function toItem(row: Row): C5WatchItem {
	return {
		name: str(row, 'name'),
		maxPrice: num(row, 'max_price') ?? 0,
		maxQty: num(row, 'max_qty') ?? 0,
		maxSpend: num(row, 'max_spend') ?? 0,
		appId: num(row, 'app_id') ?? 730,
		delivery: num(row, 'delivery') ?? 0,
		assetType: num(row, 'asset_type') ?? 1
	};
}

export function createC5Store(db: Db, vault: Vault, settings: SettingsStore): C5Store {
	const selectItems = db.prepare('SELECT * FROM c5_watch_items ORDER BY position');
	const deleteItems = db.prepare('DELETE FROM c5_watch_items');
	const insertItem = db.prepare(`
		INSERT INTO c5_watch_items (name, position, max_price, max_qty, max_spend, app_id, delivery, asset_type, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertPurchase = db.prepare(`
		INSERT INTO c5_purchases (out_trade_no, ts, mode, name, product_id, price, status) VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	const selectPurchase = db.prepare('SELECT * FROM c5_purchases WHERE out_trade_no = ?');
	const selectByMode = db.prepare('SELECT * FROM c5_purchases WHERE mode = ? ORDER BY ts, rowid');
	const selectRecent = db.prepare('SELECT * FROM c5_purchases WHERE mode = ? ORDER BY ts DESC, rowid DESC LIMIT ?');

	function selectPurchases(mode: C5Mode, statuses?: readonly C5PurchaseStatus[]): C5Purchase[] {
		const rows = selectByMode.all(mode).map(toPurchase);
		return statuses ? rows.filter(row => statuses.includes(row.status)) : rows;
	}

	return {
		getAppKey() {
			const sealed = settings.get<string>(APP_KEY_SETTING);
			return sealed ? vault.decrypt(sealed, APP_KEY_PURPOSE) : '';
		},
		setAppKey(appKey) {
			const value = String(appKey || '').trim();
			if (value) {
				settings.set(APP_KEY_SETTING, vault.encrypt(value, APP_KEY_PURPOSE));
			} else {
				settings.delete(APP_KEY_SETTING);
			}
		},
		loadSettings() {
			return settings.get<Record<string, unknown>>(SETTINGS_KEY);
		},
		saveSettings(value) {
			settings.set(SETTINGS_KEY, value);
		},
		loadRunState() {
			return settings.get<string>(RUN_STATE_KEY);
		},
		saveRunState(state) {
			settings.set(RUN_STATE_KEY, state);
		},

		listItems() {
			return selectItems.all().map(toItem);
		},
		replaceItems(items) {
			const updatedAt = nowIso();
			transaction(db, () => {
				deleteItems.run();
				items.forEach((item, position) => {
					insertItem.run(item.name, position, item.maxPrice, item.maxQty, item.maxSpend, item.appId, item.delivery, item.assetType, updatedAt);
				});
			});
		},

		addPurchase(purchase) {
			insertPurchase.run(purchase.outTradeNo, purchase.ts, purchase.mode, purchase.name, purchase.productId, purchase.price, purchase.status);
		},
		updatePurchase(outTradeNo, fields) {
			const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
			const unknown = entries.filter(([key]) => !(key in UPDATABLE));
			if (unknown.length) {
				throw new Error(`不能更新的字段: ${unknown.map(([key]) => key).join(', ')}`);
			}
			if (!entries.length) {
				return;
			}
			const sets = entries.map(([key]) => `${UPDATABLE[key as keyof C5PurchaseUpdate]} = ?`).join(', ');
			db.prepare(`UPDATE c5_purchases SET ${sets} WHERE out_trade_no = ?`)
				.run(...entries.map(([, value]) => value as string | number | null), outTradeNo);
		},
		getPurchase(outTradeNo) {
			const row = selectPurchase.get(outTradeNo);
			return row ? toPurchase(row) : null;
		},
		selectPurchases,
		recentPurchases(mode, limit) {
			return selectRecent.all(mode, limit).map(toPurchase);
		},
		totals(mode) {
			const totals = new Map<string, C5Total>();
			for (const purchase of selectPurchases(mode, C5_COUNTED)) {
				const total = totals.get(purchase.name) ?? {qty: 0, spent: 0};
				totals.set(purchase.name, {qty: total.qty + 1, spent: total.spent + purchaseCost(purchase)});
			}
			return totals;
		},
		productIds(mode) {
			return new Set(selectPurchases(mode, C5_COUNTED).map(purchase => purchase.productId).filter(Boolean));
		}
	};
}
