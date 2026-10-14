import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {migrate, openDatabase} from '../core/db.ts';
import {createVault} from '../core/vault.ts';
import {createC5Store} from '../store/c5.ts';
import type {C5WatchItem} from '../store/c5.ts';
import {MIGRATIONS} from '../store/schema.ts';
import {createSettingsStore} from '../store/settings.ts';
import {C5Error, C5NetworkError} from './client.ts';
import type {C5Api, C5BuyProduct, C5ItemStat, C5QuickBuyOptions} from './client.ts';
import {DEFAULT_SETTINGS} from './config.ts';
import type {C5Settings} from './config.ts';
import {createSweeper, newOutTradeNo, parseListing, pickListings, UNKNOWN_GIVEUP_MS} from './sweeper.ts';
import type {Listing} from './sweeper.ts';

const CASE: C5WatchItem = {name: 'Kilowatt Case', maxPrice: 5.5, maxQty: 5, maxSpend: 0, appId: 730, delivery: 0, assetType: 1};

function memoryStore() {
	const db = openDatabase(':memory:');
	migrate(db, MIGRATIONS);
	return createC5Store(db, createVault(randomBytes(32)), createSettingsStore(db));
}

type Call = [string, ...unknown[]];

/** 假 C5:行情、在售、余额、下单、订单都可以按用例改 */
class FakeClient implements C5Api {
	stats: Record<string, C5ItemStat> = {};
	listings: Array<{productId: string; price: number; assetInfo?: {amount?: number}}> = [];
	money = 1000;
	buyResult: Error | {successList?: any[]; failedList?: any[]} | null = null;   // null = 全部成功
	quickResults: Array<Error | Record<string, unknown>> = [];
	orders: Record<string, Error | Record<string, unknown> | null> = {};
	calls: Call[] = [];

	count(name: string): number {
		return this.calls.filter(call => call[0] === name).length;
	}

	async balance() {
		this.calls.push(['balance']);
		return {moneyAmount: this.money};
	}
	async steamInfo() {
		return {steamList: []};
	}
	async itemStats(appId: number, names: readonly string[]) {
		this.calls.push(['itemStats', appId, [...names]]);
		return Object.fromEntries(names.filter(name => name in this.stats).map(name => [name, this.stats[name]!]));
	}
	async searchProducts(options: {priceMax: number}) {
		this.calls.push(['searchProducts', options]);
		return this.listings.filter(listing => listing.price <= options.priceMax);
	}
	async batchBuy(tradeUrl: string, products: readonly C5BuyProduct[]) {
		this.calls.push(['batchBuy', tradeUrl, products]);
		if (this.buyResult instanceof Error) {
			throw this.buyResult;
		}
		if (this.buyResult) {
			return this.buyResult;
		}
		return {
			successList: products.map(p => ({outTradeNo: p.outTradeNo, productId: p.productId, actualPay: p.buyPrice, orderId: `o${p.productId}`})),
			failedList: []
		};
	}
	async quickBuy(options: C5QuickBuyOptions) {
		this.calls.push(['quickBuy', options]);
		const next = this.quickResults.shift() ?? {actualPay: 5.0, orderId: 1, payStatus: 1};
		if (next instanceof Error) {
			throw next;
		}
		return next;
	}
	async orderDetail(outTradeNo: string) {
		this.calls.push(['orderDetail', outTradeNo]);
		const result = this.orders[outTradeNo];
		if (result instanceof Error) {
			throw result;
		}
		return result ?? null;
	}
}

const listing = (productId: string | number, price: number, amount = 1) => ({productId: String(productId), price, assetInfo: {amount}});

function env({items = [CASE], canBuy = true, ...overrides}: Partial<C5Settings> & {items?: C5WatchItem[]; canBuy?: boolean} = {}) {
	const settings: C5Settings = {...DEFAULT_SETTINGS, mode: 'live', tradeUrl: 'https://t', maxTotalSpend: 100, ...overrides};
	const client = new FakeClient();
	client.stats = {[CASE.name]: {sellPrice: 5.0, sellCount: 10}};
	const store = memoryStore();
	const clock = {now: 1_000_000_000};
	const state = {items, canBuy};
	const logs: string[] = [];
	const sweeper = createSweeper({
		store,
		client: () => client,
		settings: () => settings,
		items: () => state.items,
		canBuy: () => state.canBuy,
		log: (level, message) => logs.push(`${level} ${message}`),
		now: () => clock.now
	});
	return {sweeper, client, store, clock, state, settings, logs};
}

// ===== 纯函数 =====

test('挑在售:从便宜的开始,不超过数量', () => {
	const ls: Listing[] = [{productId: '1', price: 5.4, amount: 1}, {productId: '2', price: 5.0, amount: 1}, {productId: '3', price: 5.2, amount: 1}, {productId: '4', price: 5.6, amount: 1}];
	assert.deepEqual(pickListings(ls, {maxPrice: 5.5, qtyLeft: 2, budgetLeft: 100}).map(l => l.productId), ['2', '3']);
});

test('挑在售:受预算约束,跳过已买过的、0 元的、堆叠的', () => {
	const ls: Listing[] = [
		{productId: '1', price: 5, amount: 1}, {productId: '2', price: 5, amount: 1}, {productId: '3', price: 5, amount: 1},
		{productId: '4', price: 0, amount: 1}, {productId: '5', price: 5, amount: 3}
	];
	assert.deepEqual(pickListings(ls, {maxPrice: 5.5, qtyLeft: 10, budgetLeft: 10, skipIds: new Set(['1'])}).map(l => l.productId), ['2', '3']);
});

test('解析在售:64 位 id 保持原文,缺字段的丢掉', () => {
	assert.equal(parseListing({productId: '1444544795338493955', price: 2.2})!.productId, '1444544795338493955');
	assert.equal(parseListing({price: 1}), null);
	assert.equal(parseListing({productId: 'abc', price: 1}), null);
	assert.equal(parseListing(listing(1, 2.0, 4))!.amount, 4);
});

test('商户单号:纯数字,毫秒时间戳开头', () => {
	const no = newOutTradeNo(1_700_000_000_123);
	assert.match(no, /^1700000000123\d{6}$/);
});

// ===== 监控 =====

test('最低价高于目标价:不查在售、不下单', async () => {
	const {sweeper, client, store} = env();
	client.stats[CASE.name]!.sellPrice = 5.51;
	assert.equal(await sweeper.runCycle(), true);
	assert.equal(client.count('searchProducts') + client.count('batchBuy'), 0);
	assert.deepEqual(store.selectPurchases('live'), []);
});

test('模拟:不调下单和余额,同一个在售不重复买', async () => {
	const {sweeper, client, store} = env({mode: 'dry'});
	client.listings = [listing(1, 5.0), listing(2, 5.2)];
	await sweeper.runCycle();
	await sweeper.runCycle();
	assert.equal(client.count('batchBuy') + client.count('balance'), 0);
	assert.deepEqual(store.selectPurchases('dry').map(p => p.productId), ['1', '2']);
});

test('只看行情:到价也不下单', async () => {
	const {sweeper, client, store, state} = env({canBuy: false});
	client.listings = [listing(1, 5.0)];
	assert.equal(await sweeper.runCycle(), true);
	assert.equal(client.count('searchProducts') + client.count('batchBuy'), 0);
	assert.equal(sweeper.view().stats[CASE.name]!.sellPrice, 5.0, '行情照常更新');
	state.canBuy = true;
	await sweeper.runCycle();
	assert.equal(store.selectPurchases('live').length, 1);
});

// ===== 实盘下单 =====

test('实盘:按在售 id 批量下单并记账', async () => {
	const {sweeper, client, store} = env();
	client.listings = [listing('1444544795338493955', 5.0), listing(2, 5.2), listing(3, 5.9)];
	await sweeper.runCycle();
	const buys = client.calls.filter(call => call[0] === 'batchBuy');
	assert.equal(buys.length, 1);
	const [, url, products] = buys[0] as [string, string, C5BuyProduct[]];
	assert.equal(url, 'https://t');
	assert.deepEqual(products.map(p => [p.productId, p.buyPrice]), [['1444544795338493955', 5.0], ['2', 5.2]]);
	const rows = store.selectPurchases('live');
	assert.deepEqual(rows.map(r => r.status), ['ok', 'ok']);
	assert.equal(rows[0]!.orderId, 'o1444544795338493955');
	assert.ok(Math.abs(store.totals('live').get(CASE.name)!.spent - 10.2) < 1e-9);
});

test('数量上限跨轮累计,买满后这一轮返回 false', async () => {
	const {sweeper, client, store} = env();
	client.listings = [1, 2, 3].map(i => listing(i, 5.0));
	await sweeper.runCycle();
	client.listings = Array.from({length: 10}, (_, i) => listing(10 + i, 5.0));
	await sweeper.runCycle();
	assert.equal(store.totals('live').get(CASE.name)!.qty, CASE.maxQty);
	client.stats[CASE.name]!.sellPrice = 4.8;
	assert.equal(await sweeper.runCycle(), false);
	assert.equal(client.count('batchBuy'), 2);
	assert.deepEqual([sweeper.view().done, sweeper.view().stats[CASE.name]?.sellPrice], [true, 4.8], '买满的照常更新行情');
});

test('每轮最多下几单', async () => {
	const {sweeper, client, store} = env({maxBuyPerCycle: 2});
	client.listings = [1, 2, 3, 4, 5].map(i => listing(i, 5.0));
	await sweeper.runCycle();
	assert.equal(store.totals('live').get(CASE.name)!.qty, 2);
});

test('总预算和余额保留额', async () => {
	{
		const {sweeper, client, store} = env({maxTotalSpend: 12});
		client.listings = [1, 2, 3, 4, 5].map(i => listing(i, 5.0));
		await sweeper.runCycle();
		assert.equal(store.totals('live').get(CASE.name)!.qty, 2, '12 元只够 2 个');
	}
	{
		const {sweeper, client, store} = env({minBalanceReserve: 990});
		client.listings = [1, 2, 3, 4, 5].map(i => listing(i, 5.0));
		await sweeper.runCycle();
		assert.equal(store.totals('live').get(CASE.name)!.qty, 2, '余额 1000 留 990,可用 10');
	}
});

test('单个饰品的花费上限', async () => {
	const {sweeper, client, store} = env({items: [{...CASE, maxSpend: 11}]});
	client.listings = [1, 2, 3, 4, 5].map(i => listing(i, 5.0));
	await sweeper.runCycle();
	assert.equal(store.totals('live').get(CASE.name)!.qty, 2);
});

test('没买到的在售:冷却期内不再试,过了再试', async () => {
	const {sweeper, client, store, clock} = env();
	client.listings = [listing(1, 5.0)];
	client.batchBuy = async (tradeUrl, products) => {
		client.calls.push(['batchBuy', tradeUrl, products]);
		return {successList: [], failedList: products.map(p => ({productId: p.productId, outTradeNo: p.outTradeNo}))};
	};
	await sweeper.runCycle();
	await sweeper.runCycle();
	assert.equal(client.count('batchBuy'), 1, '冷却期内不重复尝试');
	assert.equal(store.totals('live').size, 0);
	clock.now += 61_000;
	await sweeper.runCycle();
	assert.equal(client.count('batchBuy'), 2);
});

test('下单被拒:释放额度,这个饰品暂停一会', async () => {
	const {sweeper, client, store, clock} = env();
	client.listings = [listing(1, 5.0)];
	client.buyResult = new C5Error('余额不足');
	await sweeper.runCycle();
	assert.deepEqual(store.selectPurchases('live').map(r => r.status), ['failed']);
	await sweeper.runCycle();
	assert.equal(client.count('batchBuy'), 1, '暂停中');
	assert.ok((sweeper.view().pauseUntil[CASE.name] ?? 0) > clock.now);
	clock.now += 11_000;
	await sweeper.runCycle();
	assert.equal(client.count('batchBuy'), 2);
});

// ===== 结果未知与对账 =====

test('超时的单先按已花费占额度,对账后转成交或释放', async () => {
	const {sweeper, client, store, clock} = env({maxTotalSpend: 10});
	client.listings = [listing(1, 5.0), listing(2, 5.0)];
	client.buyResult = new C5NetworkError('超时');
	await sweeper.runCycle();
	assert.deepEqual(store.selectPurchases('live').map(r => r.status), ['unknown', 'unknown']);
	assert.equal(store.totals('live').get(CASE.name)!.spent, 10);

	// 预算被未知单占满:不再下单,但也不算完
	client.buyResult = null;
	client.listings = [listing(3, 5.0)];
	assert.equal(await sweeper.runCycle(), true);
	assert.equal(client.count('batchBuy'), 1);

	// 一笔查到已成交,一笔平台没有 -> 超过等待时间后按未成交释放额度
	const [first, second] = store.selectPurchases('live');
	client.orders = {[first!.outTradeNo]: {orderId: '77', productId: '1', status: '1', statusName: '待发货'}};
	clock.now += UNKNOWN_GIVEUP_MS + 1;
	await sweeper.runCycle();
	assert.equal(store.getPurchase(first!.outTradeNo)!.status, 'ok');
	assert.equal(store.getPurchase(first!.outTradeNo)!.orderId, '77');
	assert.equal(store.getPurchase(first!.outTradeNo)!.orderStatusName, '待发货');
	assert.equal(store.getPurchase(second!.outTradeNo)!.status, 'failed');
	await sweeper.runCycle();
	assert.equal(client.count('batchBuy'), 2);
});

test('返回结果里没有的单保持未知', async () => {
	const {sweeper, client, store} = env();
	client.listings = [listing(1, 5.0), listing(2, 5.0)];
	client.batchBuy = async (tradeUrl, products) => ({successList: [{outTradeNo: products[0]!.outTradeNo, actualPay: 5, orderId: 1}], failedList: []});
	await sweeper.runCycle();
	assert.deepEqual(store.selectPurchases('live').map(r => r.status), ['ok', 'unknown']);
});

test('查询失败:结果未知的单保持未知', async () => {
	const {sweeper, client, store, clock} = env();
	store.addPurchase({outTradeNo: 'n1', ts: clock.now, mode: 'live', name: CASE.name, productId: '1', price: 5, status: 'unknown'});
	client.orders = {n1: new C5Error('限流')};
	clock.now += UNKNOWN_GIVEUP_MS + 1;
	await sweeper.refreshOrders();
	assert.equal(store.getPurchase('n1')!.status, 'unknown');
});

test('被取消的订单释放数量和预算', async () => {
	const {sweeper, client, store, clock} = env();
	store.addPurchase({outTradeNo: 'n1', ts: clock.now, mode: 'live', name: CASE.name, productId: '1', price: 5, status: 'ok'});
	client.orders = {n1: {orderId: 9, productId: 1, status: '11', failedDesc: '卖家未发货'}};
	await sweeper.refreshOrders();
	assert.equal(store.getPurchase('n1')!.status, 'cancelled');
	assert.equal(store.getPurchase('n1')!.error, '卖家未发货');
	assert.equal(store.totals('live').size, 0);
});

test('已收货的订单不再查', async () => {
	const {sweeper, client, store, clock} = env();
	store.addPurchase({outTradeNo: 'n1', ts: clock.now, mode: 'live', name: CASE.name, productId: '1', price: 5, status: 'ok'});
	client.orders = {n1: {orderId: 9, productId: 1, status: '10'}};
	assert.equal(await sweeper.refreshOrders(null, {force: true}), 1);
	assert.equal(await sweeper.refreshOrders(null, {force: true}), 0);
});

test('请求对账后,下一轮开头查全部未完结订单', async () => {
	const {sweeper, client, store, clock} = env();
	for (const no of ['a', 'b', 'c', 'd', 'e']) {
		store.addPurchase({outTradeNo: no, ts: clock.now, mode: 'live', name: CASE.name, productId: no, price: 5, status: 'ok'});
		store.updatePurchase(no, {checkedAt: clock.now});
	}
	client.stats = {};
	await sweeper.runCycle();
	assert.equal(client.count('orderDetail'), 0, '刚查过的不到时间不查');
	sweeper.requestRefresh();
	await sweeper.runCycle();
	assert.equal(client.count('orderDetail'), 5);
});

// ===== quick 策略 =====

test('快速购买:一件一件买,平台说没有就停', async () => {
	const {sweeper, client, store} = env({strategy: 'quick'});
	client.quickResults = [{actualPay: 5.0, orderId: 1, payStatus: 1}, {actualPay: 5.1, orderId: 2, payStatus: 1}, new C5Error('没有符合条件的在售')];
	await sweeper.runCycle();
	assert.equal(client.count('searchProducts'), 0);
	assert.deepEqual(store.selectPurchases('live').map(r => r.status), ['ok', 'ok', 'failed']);
	assert.ok(Math.abs(store.totals('live').get(CASE.name)!.spent - 10.1) < 1e-9);
});

test('快速购买:每件按目标价预留预算', async () => {
	const {sweeper, client} = env({strategy: 'quick', maxTotalSpend: 12});
	await sweeper.runCycle();
	// 成交 5.0 两次后剩 2.0,不够目标价 5.5,停手
	assert.equal(client.count('quickBuy'), 2);
});

test('快速购买:支付失败暂停', async () => {
	const {sweeper, client, store} = env({strategy: 'quick'});
	client.quickResults = [{payStatus: 2}];
	await sweeper.runCycle();
	assert.deepEqual(store.selectPurchases('live').map(r => [r.status, r.error]), [['failed', '支付失败']]);
	assert.equal(client.count('quickBuy'), 1);
});

// ===== 监控列表在运行中被换掉 =====

test('两轮之间换掉监控列表,下一轮生效', async () => {
	const {sweeper, client, store, state} = env();
	client.listings = [listing(1, 5.0)];
	state.items = [{...CASE, maxPrice: 4.9}];   // 目标价降到行情之下:不买
	await sweeper.runCycle();
	assert.equal(client.count('searchProducts'), 0);
	assert.deepEqual(store.selectPurchases('live'), []);
	state.items = [{...CASE, maxPrice: 5.0}];   // 改回来:下一轮就买
	await sweeper.runCycle();
	assert.deepEqual(store.selectPurchases('live').map(p => p.productId), ['1']);
	state.items = [];                           // 全删掉:没事可做
	assert.equal(await sweeper.runCycle(), false);
});
