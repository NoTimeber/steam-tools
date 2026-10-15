import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {migrate, openDatabase} from '../core/db.ts';
import type {Db} from '../core/db.ts';
import {createVault} from '../core/vault.ts';
import type {Vault} from '../core/vault.ts';
import {createC5Store} from '../store/c5.ts';
import {MIGRATIONS} from '../store/schema.ts';
import {createSettingsStore} from '../store/settings.ts';
import {createNameDb} from '../items/names.ts';
import type {NameDb} from '../items/names.ts';
import {C5Error} from './client.ts';
import type {C5Api} from './client.ts';
import {buildItems, DEFAULT_SETTINGS, normalizeSettings, sweepBlocker} from './config.ts';
import {createC5Service, maskAppKey} from './index.ts';
import type {C5LogLine} from './index.ts';

const KEY = 'c5-app-key-0123456789';
const TRADE_URL = 'https://steamcommunity.com/tradeoffer/new/?partner=123456&token=abcdefgh';
const ITEM = {name: 'Kilowatt Case', maxPrice: 5.5, maxQty: 3};
/** 能开始自动扫货的最少设置 */
const READY = {appKey: KEY, tradeUrl: TRADE_URL, maxTotalSpend: 50};

function memoryDb(): {db: Db; vault: Vault} {
	const db = openDatabase(':memory:');
	migrate(db, MIGRATIONS);
	return {db, vault: createVault(randomBytes(32))};
}

/** 手动触发的定时器:fire() 跑掉当前排着的那一轮 */
function manualTimers() {
	let pending: {fn: () => Promise<void>; ms: number} | null = null;
	return {
		set(fn: () => Promise<void>, ms: number) {
			pending = {fn, ms};
			return pending;
		},
		clear(handle: unknown) {
			if (pending === handle) {
				pending = null;
			}
		},
		get delay(): number | null {
			return pending ? pending.ms : null;
		},
		async fire(): Promise<void> {
			const next = pending;
			assert.ok(next, '没有排着的一轮');
			pending = null;
			await next.fn();
		}
	};
}

function fakeApi(overrides: Partial<C5Api> = {}): C5Api & {calls: string[]} {
	const calls: string[] = [];
	return {
		calls,
		async balance() {
			calls.push('balance');
			return {moneyAmount: '88.50', tradeSettleAmount: 1, depositAmount: 0};
		},
		async steamInfo() {
			calls.push('steamInfo');
			return {steamList: [{steamId: '76561190000000001', nickname: '收货号', accountStatus: 1}]};
		},
		async itemStats(appId, names) {
			calls.push('itemStats');
			return Object.fromEntries(names.map(name => [name, {sellPrice: 5.0, sellCount: 12, purchaseMaxPrice: 4.6}]));
		},
		async searchProducts() {
			calls.push('searchProducts');
			return [{productId: '11', price: 5.0}, {productId: '12', price: 5.2}];
		},
		async batchBuy(tradeUrl, products) {
			calls.push('batchBuy');
			return {successList: products.map(p => ({outTradeNo: p.outTradeNo, actualPay: p.buyPrice, orderId: 'o' + p.productId}))};
		},
		async quickBuy() {
			calls.push('quickBuy');
			return {actualPay: 5, orderId: 1, payStatus: 1};
		},
		async orderDetail() {
			calls.push('orderDetail');
			return null;
		},
		...overrides
	};
}

function setup({api = fakeApi(), db = memoryDb(), names}: {api?: C5Api; db?: {db: Db; vault: Vault}; names?: NameDb} = {}) {
	const settingsStore = createSettingsStore(db.db);
	const store = createC5Store(db.db, db.vault, settingsStore);
	const timers = manualTimers();
	const emitted: C5LogLine[] = [];
	const clients: Array<{appKey: string; timeoutMs: number}> = [];
	const clock = {now: 1_700_000_000_000};
	const service = createC5Service({
		store,
		names,
		emit: (event, line) => emitted.push(line),
		createClient: options => {
			clients.push(options);
			return api;
		},
		now: () => clock.now,
		timers,
		logger: {log() {}, warn() {}, error() {}}
	});
	return {service, store, settingsStore, timers, emitted, clients, clock, db};
}

const statusOf = (err: unknown) => (err as {statusCode?: number}).statusCode;

// ===== 设置和监控列表的校验 =====

test('设置:数字范围、交易链接格式;开始扫货前要有交易链接和总预算;旧版本的 mode 忽略', () => {
	assert.equal(sweepBlocker(normalizeSettings({})), '没填收货账号的交易链接');
	assert.equal(sweepBlocker(normalizeSettings({tradeUrl: TRADE_URL})), '没设总预算(要大于 0)');
	assert.throws(() => normalizeSettings({tradeUrl: 'https://steamcommunity.com/id/me'}), /交易链接不对/);
	assert.throws(() => normalizeSettings({tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1'}), /交易链接不对/);
	assert.throws(() => normalizeSettings({pollIntervalSec: 0.5}), /轮询间隔/);
	assert.throws(() => normalizeSettings({maxBuyPerCycle: 2.5}), /整数/);
	assert.throws(() => normalizeSettings({strategy: 'fast'}), /策略/);
	const ready = normalizeSettings({mode: 'dry', tradeUrl: ` ${TRADE_URL} `, maxTotalSpend: '500', strategy: 'QUICK'});
	assert.deepEqual(ready, {...DEFAULT_SETTINGS, tradeUrl: TRADE_URL, maxTotalSpend: 500, strategy: 'quick'});
	assert.equal(sweepBlocker(ready), null);
	// 没提交的字段沿用当前值
	assert.equal(normalizeSettings({pollIntervalSec: 5}, ready).tradeUrl, TRADE_URL);
});

test('监控列表:逐项校验,名字不重复,默认 CS2 / 不限发货 / 普通在售', () => {
	assert.deepEqual(buildItems([{name: ' Kilowatt Case ', maxPrice: '0.66', maxQty: 100}]), [
		{name: 'Kilowatt Case', maxPrice: 0.66, maxQty: 100, maxSpend: 0, appId: 730, delivery: 0, assetType: 1}
	]);
	assert.deepEqual(buildItems([]), []);
	assert.throws(() => buildItems({}), /items/);
	assert.throws(() => buildItems([{name: '', maxPrice: 1, maxQty: 1}]), /第 1 项: 饰品名不能为空/);
	assert.throws(() => buildItems([{name: 'A', maxPrice: 0, maxQty: 1}]), /目标价必须大于 0/);
	assert.throws(() => buildItems([{name: 'A', maxPrice: 1, maxQty: 0}]), /数量上限至少 1/);
	assert.throws(() => buildItems([{name: 'A', maxPrice: 1, maxQty: 1.5}]), /整数/);
	assert.throws(() => buildItems([{name: 'A', maxPrice: 'abc', maxQty: 1}]), /不是数字/);
	assert.throws(() => buildItems([{name: 'A', maxPrice: 1, maxQty: 1, delivery: 3}]), /发货方式/);
	assert.throws(() => buildItems([{name: 'A', maxPrice: 1, maxQty: 1}, {name: 'A', maxPrice: 2, maxQty: 1}]), /A 重复了/);
});

// ===== app-key =====

test('app-key 加密存库,状态里只给后 4 位;留空不改,clearAppKey 删除并停止', () => {
	const {service, settingsStore, clients} = setup();
	assert.equal(service.state().configured, false);
	service.saveSettings({appKey: KEY});
	const sealed = settingsStore.get<string>('c5.appKey')!;
	assert.ok(sealed.startsWith('v1.') && !sealed.includes(KEY));
	const state = service.state();
	assert.equal(state.configured, true);
	assert.equal(state.appKeyMasked, '****6789');
	assert.ok(!JSON.stringify(state).includes(KEY));

	service.saveSettings({appKey: '', pollIntervalSec: 5, tradeUrl: TRADE_URL, maxTotalSpend: 50});
	assert.equal(service.state().configured, true, '留空不改');
	service.setRun('sweeping');
	assert.throws(() => service.saveSettings({appKey: 'another-key-0000', clearAppKey: true, pollIntervalSec: 7}), err => statusOf(err) === 400);
	assert.deepEqual([service.state().appKeyMasked, service.state().run, service.state().settings.pollIntervalSec], ['****6789', 'sweeping', 5], '既填新 key 又勾删除:报错,什么都不改');
	service.saveSettings({clearAppKey: true});
	assert.deepEqual([service.state().configured, service.state().run], [false, 'stopped']);
	assert.throws(() => service.saveSettings({appKey: 'has space'}), /空白/);
	assert.equal(clients.length, 0, '没跑过就不建客户端');
	assert.equal(maskAppKey('short'), '****');
});

// ===== 运行状态 =====

test('运行状态:没有 app-key、交易链接、总预算不能开;状态存库,重启后恢复并马上跑一轮', async () => {
	const db = memoryDb();
	const first = setup({db});
	assert.throws(() => first.service.setRun('sweeping'), err => statusOf(err) === 409);
	assert.throws(() => first.service.setRun('watching'), err => statusOf(err) === 400, '没有只看行情了');
	first.service.saveSettings({appKey: KEY});
	assert.throws(() => first.service.setRun('sweeping'), err => statusOf(err) === 400 && /交易链接/.test((err as Error).message));
	first.service.saveSettings({tradeUrl: TRADE_URL});
	assert.throws(() => first.service.setRun('sweeping'), err => statusOf(err) === 400 && /总预算/.test((err as Error).message));
	first.service.saveSettings(READY);
	first.service.saveWatchlist([ITEM]);
	first.service.setRun('sweeping');
	assert.equal(first.timers.delay, 0, '开了马上跑');
	assert.ok(first.emitted.some(line => line.level === 'warn' && line.message === '运行状态:自动扫货(真实下单)'));
	assert.throws(() => first.service.saveSettings({maxTotalSpend: 0}), err => statusOf(err) === 400 && /正在自动扫货/.test((err as Error).message));
	assert.equal(first.service.state().settings.maxTotalSpend, 50, '扫货中清空总预算:报错,不改');
	first.service.stop();
	assert.equal(first.timers.delay, null, '停服务清掉定时器');

	const second = setup({db});
	assert.equal(second.service.state().run, 'sweeping');
	second.service.start();
	assert.equal(second.timers.delay, 0);
	await second.timers.fire();
	assert.equal(second.service.state().items[0]!.bought, 2);
	assert.ok(second.emitted.some(line => line.message.startsWith('恢复上次的运行状态:自动扫货(真实下单)')));
});

test('旧版本的只看行情、模拟扫货升级后不自动恢复;旧版本实盘扫货照常恢复', () => {
	const legacy = (settings: unknown, run: string) => {
		const db = memoryDb();
		const seed = setup({db});
		seed.store.setAppKey(KEY);
		createSettingsStore(db.db).set('c5.settings', settings);
		seed.store.saveRunState(run);
		const {service, emitted} = setup({db});
		service.start();
		return {run: service.state().run, saved: seed.store.loadRunState(), messages: emitted.map(line => line.message)};
	};
	const old = {strategy: 'listing', tradeUrl: TRADE_URL, maxTotalSpend: 50};

	const watching = legacy({...old, mode: 'live'}, 'watching');
	assert.deepEqual([watching.run, watching.saved], ['stopped', 'stopped']);
	assert.ok(watching.messages.some(message => message.includes('上次的只看行情不再自动恢复')));

	const dry = legacy({...old, mode: 'dry'}, 'sweeping');
	assert.deepEqual([dry.run, dry.saved], ['stopped', 'stopped']);
	assert.ok(dry.messages.some(message => message.includes('上次的模拟扫货不再自动恢复')));
	assert.equal(legacy(null, 'sweeping').run, 'stopped', '没存过设置就是默认的模拟');

	assert.equal(legacy({...old, mode: 'live'}, 'sweeping').run, 'sweeping');
	assert.equal(legacy(old, 'sweeping').run, 'sweeping', '新版本存的设置没有 mode');
	assert.equal(legacy({...old, maxTotalSpend: 0}, 'sweeping').run, 'stopped', '设置不全不恢复');
});

// ===== 轮询 =====

test('自动扫货:一轮买到目标价以内的,按间隔排下一轮;状态里有行情和已买', async () => {
	const api = fakeApi();
	const {service, timers, clients, emitted} = setup({api});
	service.saveSettings({...READY, pollIntervalSec: 4, timeoutSec: 7});
	service.saveWatchlist([ITEM]);
	service.setRun('sweeping');
	await timers.fire();
	assert.deepEqual(clients, [{appKey: KEY, timeoutMs: 7000}]);
	assert.equal(timers.delay, 4000);
	const state = service.state();
	assert.equal(state.cycle.n, 1);
	assert.deepEqual(state.items.map(item => [item.status, item.lowest, item.sellCount, item.purchaseMax, item.bought]), [['hit', 5, 12, 4.6, 2]]);
	assert.deepEqual(state.purchases.map(p => [p.mode, p.status, p.productId, p.cost]), [['live', 'ok', '12', 5.2], ['live', 'ok', '11', 5]]);
	assert.equal(state.budget.qty, 2);
	assert.ok(emitted.some(line => line.level === 'success' && line.message.startsWith('买入 Kilowatt Case 5.00')));
	assert.ok(!emitted.some(line => line.level === 'debug'), '行情日志不推到右侧日志');
	assert.ok(state.logs.some(line => line.level === 'debug' && line.message.includes('最低 5.00')), '但页面上的日志里有');
	assert.equal(api.calls.filter(call => call === 'batchBuy').length, 1);
});

test('每分钟查一次余额,这一轮下过单就马上查', async () => {
	const listings = [{productId: '11', price: 5.0}];
	const {service, timers, clock} = setup({api: fakeApi({async searchProducts() {
		return listings;
	}})});
	service.saveSettings(READY);
	service.saveWatchlist([ITEM]);
	service.setRun('sweeping');
	await timers.fire();
	const first = service.state().balance!.at;
	assert.equal(first, clock.now);
	clock.now += 10_000;
	await timers.fire();
	assert.equal(service.state().balance!.at, first, '没下单、没到一分钟,不查');
	listings.push({productId: '12', price: 5.1});
	clock.now += 10_000;
	await timers.fire();
	assert.equal(service.state().purchases.length, 2);
	assert.equal(service.state().balance!.at, clock.now, '下了单马上查');
});

test('本轮失败:记下原因,连续失败按倍数退避;成功后恢复', async () => {
	let fail = true;
	const api = fakeApi({
		async itemStats(appId, names) {
			if (fail) {
				throw new C5Error('POST /merchant/market/v2/item/stat/hash/name 失败: [429] 请求过于频繁');
			}
			return Object.fromEntries(names.map(name => [name, {sellPrice: 9}]));
		}
	});
	const {service, timers, emitted} = setup({api});
	service.saveSettings({...READY, pollIntervalSec: 3});
	service.saveWatchlist([ITEM]);
	service.setRun('sweeping');
	await timers.fire();
	assert.equal(timers.delay, 6000);
	await timers.fire();
	assert.equal(timers.delay, 12000);
	assert.deepEqual([service.state().cycle.errors, service.state().cycle.error], [2, 'POST /merchant/market/v2/item/stat/hash/name 失败: [429] 请求过于频繁']);
	assert.ok(emitted.some(line => line.level === 'warn' && line.message.startsWith('本轮失败(连续第 2 次)')));
	fail = false;
	await timers.fire();
	assert.deepEqual([timers.delay, service.state().cycle.errors, service.state().items[0]!.status], [3000, 0, 'watch']);
});

test('停止后不再排下一轮;保存监控列表马上跑一轮', async () => {
	const {service, timers} = setup();
	service.saveSettings(READY);
	service.setRun('sweeping');
	await timers.fire();
	assert.ok(service.state().cycle.done, '列表是空的');
	service.saveWatchlist([ITEM]);
	assert.equal(timers.delay, 0);
	service.setRun('stopped');
	assert.equal(timers.delay, null);
	service.saveWatchlist([{...ITEM, maxPrice: 6}]);
	assert.equal(timers.delay, null, '停止时保存不触发');
});

// ===== 其它操作 =====

test('检查连接:余额和绑定的 Steam 账号;平台报错回 502', async () => {
	const {service} = setup();
	await assert.rejects(service.check(), err => statusOf(err) === 409);
	service.saveSettings({appKey: KEY});
	assert.deepEqual(await service.check(), {
		balance: {money: 88.5, settle: 1, deposit: 0},
		steamAccounts: [{steamId: '76561190000000001', nickname: '收货号', status: '正常'}]
	});
	assert.deepEqual(service.state().balance?.value, 88.5);

	const bad = setup({api: fakeApi({async balance() {
		throw new C5Error('GET /merchant/account/v2/balance 失败: [400001] 请输入正确的 app-Key', {code: 400001});
	}})});
	bad.service.saveSettings({appKey: KEY});
	await assert.rejects(bad.service.check(), err => statusOf(err) === 502 && /400001/.test((err as Error).message));
});

test('查在售:只查已保存的饰品,按价格排序', async () => {
	const {service} = setup();
	service.saveSettings({appKey: KEY});
	service.saveWatchlist([ITEM]);
	await assert.rejects(service.listings('Nope'), err => statusOf(err) === 404);
	const result = await service.listings('Kilowatt Case');
	assert.deepEqual(result.listings.map(l => [l.productId, l.price]), [['11', 5], ['12', 5.2]]);
});

test('对账;手工标记结果未知的单;旧版本的模拟记录不显示、不占额度', async () => {
	const {service, store, clock} = setup();
	await assert.rejects(service.refreshOrders(), err => statusOf(err) === 409);
	service.saveSettings({appKey: KEY});

	store.addPurchase({outTradeNo: 'd1', ts: clock.now, mode: 'dry', name: ITEM.name, productId: '2', price: 5, status: 'ok'});
	store.addPurchase({outTradeNo: 'n1', ts: clock.now, mode: 'live', name: ITEM.name, productId: '1', price: 5, status: 'unknown'});
	service.saveWatchlist([ITEM]);
	assert.deepEqual(service.state().purchases.map(purchase => purchase.outTradeNo), ['n1']);
	assert.deepEqual([service.state().budget.qty, service.state().items[0]!.bought], [1, 1]);
	assert.equal(service.state().unknown, 1);
	const {checked} = await service.refreshOrders();
	assert.equal(checked, 1);
	assert.equal(store.getPurchase('n1')!.status, 'unknown', '刚下的单平台还查不到,先不放弃');
	await assert.rejects(service.resolvePurchase('n1', 'maybe'), err => statusOf(err) === 400);
	await assert.rejects(service.resolvePurchase('nope', 'ok'), err => statusOf(err) === 404);
	const state = await service.resolvePurchase('n1', 'ok');
	assert.deepEqual([state.unknown, store.getPurchase('n1')!.status, store.getPurchase('n1')!.error], [0, 'ok', '手工标记']);
});

test('数据库里的设置坏了退回默认值,启动时提示', () => {
	const db = memoryDb();
	createSettingsStore(db.db).set('c5.settings', {pollIntervalSec: 0});
	const {service, emitted} = setup({db});
	assert.deepEqual(service.state().settings, DEFAULT_SETTINGS);
	service.start();
	assert.ok(emitted.some(line => line.level === 'warn' && line.message.includes('已退回默认值')));
});

test('中文名:按中文搜到英文名;填中文名拒收;状态、流水、日志带中文名', async () => {
	const names = createNameDb({'Kilowatt Case': '千瓦武器箱', 'Kilowatt Case Key': '千瓦武器箱钥匙'});
	const {service, timers, emitted} = setup({names});
	assert.deepEqual(service.searchNames(' 千瓦 ').options, [
		{name: 'Kilowatt Case', zh: '千瓦武器箱'}, {name: 'Kilowatt Case Key', zh: '千瓦武器箱钥匙'}
	]);
	assert.deepEqual(service.searchNames('Gallery Case').options, [{name: 'Gallery Case', zh: null}], '词库里没有的英文名按原文用');
	assert.deepEqual(service.searchNames('Kilowatt Case').options.map(option => option.zh), ['千瓦武器箱', '千瓦武器箱钥匙'], '已有的不重复');
	assert.deepEqual(service.searchNames('不存在').options, [], '中文搜不到不给原文选项');
	assert.deepEqual(service.searchNames('').options, []);

	assert.throws(() => service.saveWatchlist([{...ITEM, name: '千瓦武器箱'}]), err => statusOf(err) === 400 && /应填 Kilowatt Case/.test((err as Error).message));
	assert.deepEqual(service.state().items, []);

	service.saveSettings(READY);
	service.saveWatchlist([ITEM, {name: 'Gallery Case', maxPrice: 1, maxQty: 1}]);
	assert.ok(emitted.some(line => line.message.includes('新增 千瓦武器箱 ≤ 5.50 × 3') && line.message.includes('新增 Gallery Case')));
	service.setRun('sweeping');
	await timers.fire();
	const state = service.state();
	assert.deepEqual(state.items.map(item => [item.name, item.zh]), [['Kilowatt Case', '千瓦武器箱'], ['Gallery Case', null]]);
	assert.deepEqual(state.purchases.map(purchase => [purchase.name, purchase.zh]), [['Kilowatt Case', '千瓦武器箱'], ['Kilowatt Case', '千瓦武器箱']]);
	assert.ok(emitted.some(line => line.message.startsWith('买入 千瓦武器箱 5.00')));
});
