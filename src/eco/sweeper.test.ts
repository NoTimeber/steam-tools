import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {migrate, openDatabase} from '../core/db.ts';
import {createVault} from '../core/vault.ts';
import {createEcoStore} from '../store/eco.ts';
import type {EcoStore, EcoWatchItem} from '../store/eco.ts';
import {MIGRATIONS} from '../store/schema.ts';
import {createSettingsStore} from '../store/settings.ts';
import {ECO_CODE, EcoError, EcoNetworkError} from './client.ts';
import type {EcoApi, EcoBuyResult, EcoOrderStatus} from './client.ts';
import {DEFAULT_SETTINGS, buildItems, normalizeSettings, sweepBlocker} from './config.ts';
import type {EcoSettings} from './config.ts';
import {createSweeper, pickListings, UNKNOWN_GIVEUP_MS} from './sweeper.ts';

const TRADE_URL = 'https://steamcommunity.com/tradeoffer/new/?partner=123&token=abc';

function memoryStore(): EcoStore {
	const db = openDatabase(':memory:');
	migrate(db, MIGRATIONS);
	return createEcoStore(db, createVault(randomBytes(32)), createSettingsStore(db));
}

/** 假平台:每个饰品一组在售 {goodsNum, price};buy 按脚本返回或抛错 */
class FakeEco implements EcoApi {
	money = 100;
	listings = new Map<string, Array<{GoodsNum: string; SellingPrice: number}>>();
	buyErrors = new Map<string, Error>();
	quickResult: EcoBuyResult[] | Error = [];
	orders: EcoOrderStatus[] = [];
	bought: string[] = [];
	statusQueries: string[][] = [];

	async balance() {
		return {Money: this.money};
	}
	async steamAccounts() {
		return [];
	}
	async itemStats(_gameId: number, names: readonly string[]) {
		return Object.fromEntries(names.map(name => {
			const prices = (this.listings.get(name) ?? []).map(listing => listing.SellingPrice);
			return [name, {MinPrice: prices.length ? String(Math.min(...prices)) : '0', SellCount: String(prices.length)}];
		}));
	}
	async sellGoods({name}: {name: string}) {
		return this.listings.get(name) ?? [];
	}
	async buyByGoodsNum({goodsNum, price, merchantNo}: {goodsNum: string; price: number; merchantNo: string}) {
		const error = this.buyErrors.get(goodsNum);
		if (error) {
			throw error;
		}
		this.bought.push(goodsNum);
		return {OrderNo: `DB-${goodsNum}`, MerchantNo: merchantNo, PaymentPrice: price};
	}
	async buyByHashName() {
		if (this.quickResult instanceof Error) {
			throw this.quickResult;
		}
		return this.quickResult;
	}
	async importGuardAccount() {
		return true;
	}
	async checkTradeLink() {
		return true;
	}
	async updateSteam() {
		return {};
	}
	async orderStatus(merchantNos: readonly string[]) {
		this.statusQueries.push([...merchantNos]);
		return this.orders.filter(order => merchantNos.includes(String(order.MerchantNo)));
	}
}

function setup(items: EcoWatchItem[], settings: Partial<EcoSettings> = {}) {
	const store = memoryStore();
	store.replaceItems(items);
	const api = new FakeEco();
	const logs: string[] = [];
	let clock = 1_000_000;
	let seq = 0;
	const sweeper = createSweeper({
		store,
		client: () => api,
		settings: () => ({...DEFAULT_SETTINGS, tradeUrl: TRADE_URL, maxTotalSpend: 100, ...settings}),
		items: () => store.listItems(),
		canBuy: () => true,
		log: (level, message) => logs.push(`${level}: ${message}`),
		now: () => clock,
		newMerchantNo: () => `M${++seq}`
	});
	return {store, api, logs, sweeper, advance: (ms: number) => {
		clock += ms;
	}};
}

const item = (name: string, maxPrice: number, maxQty: number, extra: Partial<EcoWatchItem> = {}): EcoWatchItem =>
	({name, maxPrice, maxQty, maxSpend: 0, gameId: 730, ...extra});

test('pickListings:从低到高挑,受目标价、数量、预算、跳过列表约束', () => {
	const listings = [{goodsNum: 'c', price: 3}, {goodsNum: 'a', price: 1}, {goodsNum: 'b', price: 2}, {goodsNum: 'd', price: 9}];
	assert.deepEqual(pickListings(listings, {maxPrice: 5, qtyLeft: 10, budgetLeft: 100}).map(l => l.goodsNum), ['a', 'b', 'c']);
	assert.deepEqual(pickListings(listings, {maxPrice: 5, qtyLeft: 2, budgetLeft: 100}).map(l => l.goodsNum), ['a', 'b']);
	assert.deepEqual(pickListings(listings, {maxPrice: 5, qtyLeft: 10, budgetLeft: 3.5}).map(l => l.goodsNum), ['a', 'b']);
	assert.deepEqual(pickListings(listings, {maxPrice: 5, qtyLeft: 10, budgetLeft: 100, skipIds: new Set(['a'])}).map(l => l.goodsNum), ['b', 'c']);
});

test('按在售列表:到价逐件买;价格变了的跳过接着买下一件;买满后不再买', async () => {
	const {store, api, sweeper} = setup([item('Kilowatt Case', 0.65, 2)]);
	api.listings.set('Kilowatt Case', [
		{GoodsNum: 'G3', SellingPrice: 0.9}, {GoodsNum: 'G1', SellingPrice: 0.6}, {GoodsNum: 'G2', SellingPrice: 0.62}, {GoodsNum: 'G4', SellingPrice: 0.64}
	]);
	api.buyErrors.set('G1', new EcoError('价格变了', {code: ECO_CODE.priceChanged, data: {NewPrice: 0.7}}));
	assert.equal(await sweeper.runCycle(), true);
	assert.deepEqual(api.bought, ['G2', 'G4']);
	const purchases = store.selectPurchases();
	assert.deepEqual(purchases.map(p => [p.merchantNo, p.goodsNum, p.status, p.orderNo]), [
		['M1', 'G1', 'failed', null], ['M2', 'G2', 'ok', 'DB-G2'], ['M3', 'G4', 'ok', 'DB-G4']
	]);
	assert.deepEqual(store.totals().get('Kilowatt Case'), {qty: 2, spent: 1.26});
	// 买满了:下一轮只查行情,不买
	assert.equal(await sweeper.runCycle(), false);
	assert.equal(api.bought.length, 2);
});

test('余额不足等其它拒绝:这个饰品暂停冷却,不再继续买', async () => {
	const {api, logs, sweeper} = setup([item('Recoil Case', 2, 5)], {errorCooldownSec: 30});
	api.listings.set('Recoil Case', [{GoodsNum: 'R1', SellingPrice: 1}, {GoodsNum: 'R2', SellingPrice: 1.1}]);
	api.buyErrors.set('R1', new EcoError('余额不足', {code: ECO_CODE.failed}));
	await sweeper.runCycle();
	assert.deepEqual(api.bought, []);
	assert.ok(logs.some(line => /Recoil Case 下单被拒,暂停 30 秒/.test(line)));
	assert.ok(sweeper.view().pauseUntil['Recoil Case']! > 0);
});

test('结果未知(超时)的单按已花费占住额度;对账查到订单就转成交,平台一直没有就按未成交释放', async () => {
	const {store, api, sweeper, advance} = setup([item('Kilowatt Case', 1, 3)]);
	api.listings.set('Kilowatt Case', [{GoodsNum: 'G1', SellingPrice: 0.5}, {GoodsNum: 'G2', SellingPrice: 0.6}]);
	api.buyErrors.set('G1', new EcoNetworkError('超时'));
	await sweeper.runCycle();
	assert.deepEqual(store.selectPurchases().map(p => [p.goodsNum, p.status]), [['G1', 'unknown']], '超时后这一轮不再接着买');
	assert.deepEqual(store.totals().get('Kilowatt Case'), {qty: 1, spent: 0.5});
	assert.ok(store.goodsNums().has('G1'), '结果未知的商品不重复买');

	// 平台上其实成交了
	api.orders = [{MerchantNo: 'M1', OrderNum: 'DB9', OrderStateCode: 1, OrderState: '等待发货', OrderAmount: 0.5}];
	advance(10_000);
	assert.equal(await sweeper.refreshOrders(), 1);
	assert.deepEqual(store.getPurchase('M1'), {...store.getPurchase('M1')!, status: 'ok', orderNo: 'DB9', orderState: 1, orderStateName: '等待发货', actualPay: 0.5});

	// 另一笔超时、平台始终查不到:过了放弃时限按未成交处理
	api.buyErrors.set('G2', new EcoNetworkError('超时'));
	api.orders = [];
	await sweeper.runCycle();
	assert.equal(store.getPurchase('M2')?.status, 'unknown');
	advance(UNKNOWN_GIVEUP_MS + 1);
	await sweeper.refreshOrders();
	assert.deepEqual([store.getPurchase('M2')?.status, store.getPurchase('M2')?.error], ['failed', '对账:平台没有这笔订单']);
});

test('订单被取消:释放数量和预算;对账一个批量请求查完', async () => {
	const {store, api, sweeper, advance} = setup([item('Kilowatt Case', 1, 1)]);
	api.listings.set('Kilowatt Case', [{GoodsNum: 'G1', SellingPrice: 0.5}]);
	await sweeper.runCycle();
	assert.equal(store.totals().get('Kilowatt Case')?.qty, 1);
	api.orders = [{MerchantNo: 'M1', OrderNum: 'DB-G1', OrderStateCode: 3, OrderState: '交易取消', Reason: '超时未发送报价'}];
	advance(400_000);
	await sweeper.refreshOrders();
	assert.deepEqual([store.getPurchase('M1')?.status, store.getPurchase('M1')?.error], ['cancelled', '超时未发送报价']);
	assert.equal(store.totals().get('Kilowatt Case'), undefined, '取消的不占额度');
	assert.deepEqual(api.statusQueries, [['M1']]);
});

test('商户单号重复(7008):按平台已有的订单号记下,保持未知交给对账', async () => {
	const {store, api, sweeper} = setup([item('Kilowatt Case', 1, 1)]);
	api.listings.set('Kilowatt Case', [{GoodsNum: 'G1', SellingPrice: 0.5}]);
	api.buyErrors.set('G1', new EcoError('商户号重复', {code: ECO_CODE.duplicateMerchantNo, data: {OrderIdList: ['DB77']}}));
	await sweeper.runCycle();
	assert.deepEqual([store.getPurchase('M1')?.status, store.getPurchase('M1')?.orderNo], ['unknown', 'DB77']);
});

test('快速购买:平台挑价,一次一件,按支付金额记;平台没给订单时不占额度', async () => {
	const {store, api, sweeper} = setup([item('Recoil Case', 2, 2)], {strategy: 'quick'});
	api.listings.set('Recoil Case', [{GoodsNum: 'R1', SellingPrice: 1.5}]);
	api.quickResult = [{OrderNo: 'DB1', MerchantNo: 'M1', PaymentPrice: 1.5}];
	await sweeper.runCycle();
	// 第二件同样返回(假平台不扣货),两件都记成交
	assert.deepEqual(store.selectPurchases().map(p => [p.merchantNo, p.status, p.actualPay, p.price]), [['M1', 'ok', 1.5, 2], ['M2', 'ok', 1.5, 2]]);

	const second = setup([item('Recoil Case', 2, 2)], {strategy: 'quick'});
	second.api.listings.set('Recoil Case', [{GoodsNum: 'R1', SellingPrice: 1.5}]);
	second.api.quickResult = [];
	await second.sweeper.runCycle();
	assert.deepEqual(second.store.selectPurchases().map(p => p.status), ['failed']);
	assert.equal(second.store.totals().size, 0);
});

test('总预算和余额保留会限制下单', async () => {
	const {api, sweeper} = setup([item('Kilowatt Case', 1, 10)], {maxTotalSpend: 1.2, minBalanceReserve: 0});
	api.listings.set('Kilowatt Case', [{GoodsNum: 'G1', SellingPrice: 0.5}, {GoodsNum: 'G2', SellingPrice: 0.6}, {GoodsNum: 'G3', SellingPrice: 0.7}]);
	await sweeper.runCycle();
	assert.deepEqual(api.bought, ['G1', 'G2']);

	const low = setup([item('Kilowatt Case', 1, 10)], {minBalanceReserve: 99.4});
	low.api.listings.set('Kilowatt Case', [{GoodsNum: 'G1', SellingPrice: 0.5}, {GoodsNum: 'G2', SellingPrice: 0.6}]);
	await low.sweeper.runCycle();
	assert.deepEqual(low.api.bought, ['G1'], '余额 100 留 99.4,只够 0.6 以内');
});

test('设置和监控列表校验', () => {
	assert.equal(sweepBlocker(DEFAULT_SETTINGS), '没填收货账号的交易链接');
	assert.equal(sweepBlocker({...DEFAULT_SETTINGS, tradeUrl: TRADE_URL}), '没设总预算(要大于 0)');
	assert.throws(() => normalizeSettings({tradeUrl: 'https://example.com'}), /交易链接不对/);
	assert.throws(() => normalizeSettings({strategy: 'x'}), /策略只能是/);
	assert.equal(normalizeSettings({pollIntervalSec: '3'}).pollIntervalSec, 3);
	assert.deepEqual(buildItems([{name: ' Kilowatt Case ', maxPrice: '0.5', maxQty: 2}]), [{name: 'Kilowatt Case', maxPrice: 0.5, maxQty: 2, maxSpend: 0, gameId: 730}]);
	assert.throws(() => buildItems([{name: 'A', maxPrice: 1, maxQty: 1}, {name: 'A', maxPrice: 2, maxQty: 1}]), /重复/);
	assert.throws(() => buildItems([{name: 'A', maxPrice: 1, maxQty: 1, gameId: 1}]), /游戏只能是/);
});
