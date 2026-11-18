// ECO 扫货的数据:PartnerId(settings 表明文)、RSA 私钥(vault 密文,存在 settings 表)、
// 运行设置和运行状态(settings 表明文 JSON)、监控列表(eco_watch_items)、购买流水(eco_purchases)。
// 校验在 src/eco/config.ts,这里只管存取。

import type {Db, Row} from '../core/db.ts';
import {nowIso, num, str, strOrNull, transaction} from '../core/db.ts';
import type {Vault} from '../core/vault.ts';
import type {SettingsStore} from './settings.ts';

const PARTNER_ID_SETTING = 'eco.partnerId';
const PRIVATE_KEY_SETTING = 'eco.privateKey';
const PRIVATE_KEY_PURPOSE = 'eco.private_key';
const SETTINGS_KEY = 'eco.settings';
const RUN_STATE_KEY = 'eco.run';

export type EcoPurchaseStatus = 'unknown' | 'ok' | 'failed' | 'cancelled';

/** 占用数量和预算的状态:结果未知的按已花费算,宁可少买 */
export const ECO_COUNTED: readonly EcoPurchaseStatus[] = ['ok', 'unknown'];

export interface EcoWatchItem {
	/** Steam 市场英文名(HashName),如 Kilowatt Case */
	name: string;
	/** 单价不高于此值才买 */
	maxPrice: number;
	/** 累计最多买几个,重启不清零 */
	maxQty: number;
	/** 这个饰品累计花费上限,0 不限(仍受总预算约束) */
	maxSpend: number;
	/** 730 CS2 / 570 Dota2 / 440 TF2 / 252490 Rust */
	gameId: number;
}

export interface EcoPurchase {
	/** 商户单号(MerchantNo),我方生成 */
	merchantNo: string;
	ts: number;
	name: string;
	/** ECO 商品编号;快速购买下单前不知道,为空 */
	goodsNum: string;
	/** 下单价(快速购买记目标价) */
	price: number;
	status: EcoPurchaseStatus;
	/** ECO 订单编号 */
	orderNo: string | null;
	actualPay: number | null;
	/** 平台订单状态码和文字,见 src/eco/sweeper.ts 的 ORDER_* */
	orderState: number | null;
	orderStateName: string | null;
	/** 上次向平台查询这笔单的时间 */
	checkedAt: number;
	error: string | null;
}

export type EcoPurchaseUpdate = Partial<Pick<EcoPurchase, 'status' | 'goodsNum' | 'orderNo' | 'actualPay' | 'orderState' | 'orderStateName' | 'checkedAt' | 'error'>>;

export interface EcoTotal {
	qty: number;
	spent: number;
}

/** 实际成交价;平台没给时按下单价 */
export function purchaseCost(purchase: Pick<EcoPurchase, 'actualPay' | 'price'>): number {
	return purchase.actualPay ?? purchase.price;
}

export interface EcoStore {
	/** 没存过返回 '' */
	getPartnerId(): string;
	/** 传 '' 删除 */
	setPartnerId(partnerId: string): void;
	/** 没存过返回 '' */
	getPrivateKey(): string;
	/** 传 '' 删除 */
	setPrivateKey(privateKey: string): void;
	loadSettings(): Record<string, unknown> | undefined;
	saveSettings(settings: object): void;
	loadRunState(): string | undefined;
	saveRunState(state: string): void;

	listItems(): EcoWatchItem[];
	replaceItems(items: readonly EcoWatchItem[]): void;

	addPurchase(purchase: Pick<EcoPurchase, 'merchantNo' | 'ts' | 'name' | 'goodsNum' | 'price' | 'status'>): void;
	updatePurchase(merchantNo: string, fields: EcoPurchaseUpdate): void;
	getPurchase(merchantNo: string): EcoPurchase | null;
	/** 按时间先后 */
	selectPurchases(statuses?: readonly EcoPurchaseStatus[]): EcoPurchase[];
	/** 最近的 limit 笔,新的在前 */
	recentPurchases(limit: number): EcoPurchase[];
	/** 每个饰品已占用的数量和花费 */
	totals(): Map<string, EcoTotal>;
	/** 已经下过单(含结果未知)的商品编号,不再重复买 */
	goodsNums(): Set<string>;
}

const UPDATABLE: Record<keyof EcoPurchaseUpdate, string> = {
	status: 'status',
	goodsNum: 'goods_num',
	orderNo: 'order_no',
	actualPay: 'actual_pay',
	orderState: 'order_state',
	orderStateName: 'order_state_name',
	checkedAt: 'checked_at',
	error: 'error'
};

function toPurchase(row: Row): EcoPurchase {
	return {
		merchantNo: str(row, 'merchant_no'),
		ts: num(row, 'ts') ?? 0,
		name: str(row, 'name'),
		goodsNum: str(row, 'goods_num'),
		price: num(row, 'price') ?? 0,
		status: str(row, 'status') as EcoPurchaseStatus,
		orderNo: strOrNull(row, 'order_no'),
		actualPay: num(row, 'actual_pay'),
		orderState: num(row, 'order_state'),
		orderStateName: strOrNull(row, 'order_state_name'),
		checkedAt: num(row, 'checked_at') ?? 0,
		error: strOrNull(row, 'error')
	};
}

function toItem(row: Row): EcoWatchItem {
	return {
		name: str(row, 'name'),
		maxPrice: num(row, 'max_price') ?? 0,
		maxQty: num(row, 'max_qty') ?? 0,
		maxSpend: num(row, 'max_spend') ?? 0,
		gameId: num(row, 'game_id') ?? 730
	};
}

export function createEcoStore(db: Db, vault: Vault, settings: SettingsStore): EcoStore {
	const selectItems = db.prepare('SELECT * FROM eco_watch_items ORDER BY position');
	const deleteItems = db.prepare('DELETE FROM eco_watch_items');
	const insertItem = db.prepare(`
		INSERT INTO eco_watch_items (name, position, max_price, max_qty, max_spend, game_id, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	const insertPurchase = db.prepare(`
		INSERT INTO eco_purchases (merchant_no, ts, name, goods_num, price, status) VALUES (?, ?, ?, ?, ?, ?)
	`);
	const selectPurchase = db.prepare('SELECT * FROM eco_purchases WHERE merchant_no = ?');
	const selectAll = db.prepare('SELECT * FROM eco_purchases ORDER BY ts, rowid');
	const selectRecent = db.prepare('SELECT * FROM eco_purchases ORDER BY ts DESC, rowid DESC LIMIT ?');

	function selectPurchases(statuses?: readonly EcoPurchaseStatus[]): EcoPurchase[] {
		const rows = selectAll.all().map(toPurchase);
		return statuses ? rows.filter(row => statuses.includes(row.status)) : rows;
	}

	return {
		getPartnerId() {
			return settings.get<string>(PARTNER_ID_SETTING) ?? '';
		},
		setPartnerId(partnerId) {
			const value = String(partnerId || '').trim();
			if (value) {
				settings.set(PARTNER_ID_SETTING, value);
			} else {
				settings.delete(PARTNER_ID_SETTING);
			}
		},
		getPrivateKey() {
			const sealed = settings.get<string>(PRIVATE_KEY_SETTING);
			return sealed ? vault.decrypt(sealed, PRIVATE_KEY_PURPOSE) : '';
		},
		setPrivateKey(privateKey) {
			const value = String(privateKey || '').trim();
			if (value) {
				settings.set(PRIVATE_KEY_SETTING, vault.encrypt(value, PRIVATE_KEY_PURPOSE));
			} else {
				settings.delete(PRIVATE_KEY_SETTING);
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
					insertItem.run(item.name, position, item.maxPrice, item.maxQty, item.maxSpend, item.gameId, updatedAt);
				});
			});
		},

		addPurchase(purchase) {
			insertPurchase.run(purchase.merchantNo, purchase.ts, purchase.name, purchase.goodsNum, purchase.price, purchase.status);
		},
		updatePurchase(merchantNo, fields) {
			const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
			const unknown = entries.filter(([key]) => !(key in UPDATABLE));
			if (unknown.length) {
				throw new Error(`不能更新的字段: ${unknown.map(([key]) => key).join(', ')}`);
			}
			if (!entries.length) {
				return;
			}
			const sets = entries.map(([key]) => `${UPDATABLE[key as keyof EcoPurchaseUpdate]} = ?`).join(', ');
			db.prepare(`UPDATE eco_purchases SET ${sets} WHERE merchant_no = ?`)
				.run(...entries.map(([, value]) => value as string | number | null), merchantNo);
		},
		getPurchase(merchantNo) {
			const row = selectPurchase.get(merchantNo);
			return row ? toPurchase(row) : null;
		},
		selectPurchases,
		recentPurchases(limit) {
			return selectRecent.all(limit).map(toPurchase);
		},
		totals() {
			const totals = new Map<string, EcoTotal>();
			for (const purchase of selectPurchases(ECO_COUNTED)) {
				const total = totals.get(purchase.name) ?? {qty: 0, spent: 0};
				totals.set(purchase.name, {qty: total.qty + 1, spent: total.spent + purchaseCost(purchase)});
			}
			return totals;
		},
		goodsNums() {
			return new Set(selectPurchases(ECO_COUNTED).map(purchase => purchase.goodsNum).filter(Boolean));
		}
	};
}
