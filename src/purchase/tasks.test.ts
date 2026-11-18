import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {Attempt} from '../steam/session-manager.ts';
import {clampItemsToBalance, createPurchaseTasks, formatMoney, MAX_UNITS_PER_ORDER, normalizeCartData, PURCHASE_MAX_ITEM_QUANTITY, splitIntoOrders} from './tasks.ts';
import type {PublicTask, TaskAccount, TaskEvent, TaskItem} from './tasks.ts';
import type {CatalogItem} from './catalog-items.ts';
import type {PurchaseOrder, PurchaseResult, StoreData} from './store-gc.ts';

test('购物车校验:跳过空账号和空购物车,数量夹到 1~9999,价格取整非负', () => {
	assert.deepEqual(normalizeCartData({
		alpha: [{itemDefId: '1200', quantity: 0, costInLocalCurrency: 199.6}, {itemDefId: 5021, quantity: 1e9, costInLocalCurrency: -5}],
		'  ': [{itemDefId: 1}],
		beta: [],
		gamma: 'x'
	}), {
		alpha: [{itemDefId: 1200, quantity: 1, costInLocalCurrency: 200}, {itemDefId: 5021, quantity: PURCHASE_MAX_ITEM_QUANTITY, costInLocalCurrency: 0}]
	});
	assert.throws(() => normalizeCartData(null), /不能为空/);
	assert.throws(() => normalizeCartData({alpha: []}), /购物车为空/);
	assert.throws(() => normalizeCartData({alpha: [{itemDefId: 'abc'}]}), /账号 alpha 存在无效商品编号/);
	assert.throws(() => normalizeCartData({alpha: [null]}), /无效商品编号/);
	assert.throws(() => normalizeCartData({alpha: [{itemDefId: 1, quantity: 'many'}]}), /购买数量无效/);
});

function account(items: Array<[number, number]>, balanceBefore: number | null): TaskAccount {
	return {
		account: 'alpha', game: 'cs2', attemptId: '', status: 'queued', country: '', currencyISO: 'USD', balanceBefore, balanceAfter: null,
		totalCostCents: 0, totalUnits: 0, error: '', logs: [], updatedAt: '',
		items: items.map(([unitPriceCents, quantity], index) => ({itemDefId: index + 1, name: `#${index + 1}`, type: '工具', quantity, unitPriceCents, totalPriceCents: unitPriceCents * quantity}))
	};
}

test('按余额裁剪:从前往后买得起几件留几件,买不起的去掉', () => {
	const target = account([[199, 3], [249, 1], [50, 2]], 5);
	clampItemsToBalance(target);
	assert.deepEqual(target.items.map(item => [item.itemDefId, item.quantity, item.totalPriceCents]), [[1, 2, 398], [3, 2, 100]]);
	assert.equal(target.totalUnits, 4);
	assert.equal(target.totalCostCents, 498);

	const unknownBalance = account([[199, 3]], null);
	clampItemsToBalance(unknownBalance);
	assert.equal(unknownBalance.items[0]?.quantity, 3, '余额未知不裁剪');

	const free = account([[0, 5]], 0);
	clampItemsToBalance(free);
	assert.equal(free.items[0]?.quantity, 5, '免费商品不受余额限制');
});

test('金额格式', () => {
	assert.equal(formatMoney(12345, 'eur'), 'EUR 123.45');
	assert.equal(formatMoney(0, ''), 'USD 0.00');
});

// ===== 执行器 =====

const NAME_TAG: CatalogItem = {def_index: 1200, name: '名称标签', type: '工具', category: '工具', prices: {USD: 199, EUR: 185}};

class FakeClient extends EventEmitter {
	steamID = {getSteamID64: () => '76561190000000001'};
	played: number[][] = [];
	onPlay: (() => void) | null = null;
	gamesPlayed(apps: number[]) {
		this.played.push(apps);
		if (this.onPlay) {
			setImmediate(this.onPlay);
		}
	}
	webLogOn() {}
}

function makeAttempt(name: string, overrides: Partial<Attempt> = {}): Attempt & {client: FakeClient} {
	return {
		id: `id-${name}`, accountName: name, status: 'web_session', createdAt: 1, client: new FakeClient(), csgo: new EventEmitter(), tf2: new EventEmitter(),
		cs2GcConnected: true, tf2GcConnected: false, gcConnected: true, activeGame: 'cs2', hasWallet: true, balance: 10, currency: 1, currencyISO: 'USD',
		country: 'US', loginGeoCountry: '', logs: [], ...overrides
	} as unknown as Attempt & {client: FakeClient};
}

interface Harness {
	attempts: Map<string, Attempt>;
	purchases: Array<{account: string; order: PurchaseOrder}>;
	adopted: string[];
	accountLogs: string[];
	saved: string[];
	events: Array<{event: TaskEvent; task: PublicTask}>;
	tasks: ReturnType<typeof createPurchaseTasks>;
}

function harness(options: {list?: CatalogItem[]; purchase?: (attempt: Attempt, order: PurchaseOrder) => Promise<PurchaseResult>; queryFails?: boolean} = {}): Harness {
	const h = {attempts: new Map<string, Attempt>(), purchases: [], adopted: [], accountLogs: [], saved: [], events: []} as unknown as Harness;
	const list = options.list ?? [NAME_TAG];
	h.tasks = createPurchaseTasks({
		attempts: () => h.attempts.values(),
		catalog: {
			findItem: defIndex => list.find(item => item.def_index === Number(defIndex)) ?? null,
			adoptStoreData: (_game, attempt) => void h.adopted.push(attempt.accountName)
		},
		gc: {
			async queryUserData(attempt): Promise<StoreData> {
				if (options.queryFails) {
					throw new Error('GC 请求超时 msg=2500');
				}
				return {
					source: 'gc', fetchedAt: '', account: attempt.accountName, attemptId: attempt.id, game: 'cs2', country: 'US', currency: 1,
					currencyISO: 'USD', balance: attempt.balance, priceSheetVersion: 1, list
				};
			},
			async purchase(attempt, _game, order) {
				h.purchases.push({account: attempt.accountName, order: JSON.parse(JSON.stringify(order))});
				return options.purchase
					? options.purchase(attempt, order)
					: {txnId: 'T1', itemIds: ['1', '2'], initResult: 1, finalizeResult: 1, balanceAfter: Number(attempt.balance) - 3.98};
			}
		},
		events: {
			addLog: (attempt, level, message) => void h.accountLogs.push(`${attempt.accountName} ${level} ${message}`),
			emit() {},
			saveSession: attempt => void h.saved.push(attempt.accountName)
		},
		emitTask: (event, task) => void h.events.push({event, task}),
		gcTimeoutMs: 1000
	});
	return h;
}

test('任务:在线账号按最新价下单成功,不在线的账号失败,整体为部分完成', async () => {
	const h = harness();
	const alpha = makeAttempt('Alpha');
	h.attempts.set(alpha.id, alpha);
	const task = h.tasks.create('cs2', {alpha: [{itemDefId: 1200, quantity: 2, costInLocalCurrency: 150}], ghost: [{itemDefId: 1200, quantity: 1, costInLocalCurrency: 199}]});
	assert.equal(task.status, 'queued');
	assert.equal(task.type, 'cs2-purchase');
	assert.equal(task.accounts[0]?.attemptId, 'id-Alpha', '账号名不区分大小写');
	assert.equal(task.accounts[0]?.items[0]?.unitPriceCents, 199, '建任务时按目录价估算');
	assert.equal(task.accounts[1]?.items[0]?.name, '名称标签');

	await h.tasks.start(task);
	assert.equal(task.status, 'partial');
	const [first, second] = task.accounts;
	assert.equal(first?.status, 'completed');
	assert.equal(first?.balanceBefore, 10);
	assert.equal(first?.balanceAfter, 6.02);
	assert.equal(alpha.balance, 6.02);
	assert.equal(second?.status, 'failed');
	assert.equal(second?.error, '账号当前不在线，无法执行内购');

	assert.equal(h.purchases.length, 1);
	assert.deepEqual(h.purchases[0]?.order.items.map(item => [item.itemDefId, item.quantity, item.unitPriceCents]), [[1200, 2, 199]]);
	assert.deepEqual(h.adopted, ['Alpha']);
	assert.deepEqual(h.saved, ['Alpha']);
	assert.ok(h.accountLogs.some(line => line.includes('CS2 GC 内购成功 USD 3.98，共 2 件商品')));
	assert.ok(task.logs.some(log => log.message.includes('GC 下单成功，交易 T1，新增 2 个 item_id')));
	assert.deepEqual(task.summary, {totalAccounts: 2, processedAccounts: 2, successCount: 1, failCount: 1, totalLineItems: 2, totalUnits: 3});

	const events = h.events.map(entry => entry.event);
	assert.equal(events[0], 'purchase:task-created');
	assert.equal(events.at(-1), 'purchase:task-completed');
	assert.equal(h.events.at(-1)?.task.status, 'partial');
	assert.equal('cartData' in (h.events.at(-1)?.task ?? {}), false, '推给前端的任务不带原始购物车');
});

test('任务:提交的价格与最新价不同会提示并按最新价重算;余额不够的件数裁掉', async () => {
	const h = harness();
	const alpha = makeAttempt('alpha', {balance: 5});
	h.attempts.set(alpha.id, alpha);
	const task = h.tasks.create('cs2', {alpha: [{itemDefId: 1200, quantity: 5, costInLocalCurrency: 100}]});
	task.accounts[0]!.items[0]!.unitPriceCents = 100;   // 模拟建任务后目录价变了
	await h.tasks.start(task);
	assert.equal(task.status, 'completed');
	assert.ok(task.logs.some(log => log.level === 'warn' && log.message.includes('检测到价格变化')));
	assert.deepEqual(h.purchases[0]?.order.items.map(item => [item.quantity, item.unitPriceCents]), [[2, 199]]);
	assert.equal(task.accounts[0]?.totalCostCents, 398);
});

test('任务失败:余额一件都买不起、商品不在目录、缺该币种价格、没钱包、查目录失败、下单失败', async () => {
	const run = async (options: Parameters<typeof harness>[0], attemptOverrides: Partial<Attempt>, itemDefId = 1200) => {
		const h = harness(options);
		const alpha = makeAttempt('alpha', attemptOverrides);
		h.attempts.set(alpha.id, alpha);
		const task = h.tasks.create('cs2', {alpha: [{itemDefId, quantity: 1, costInLocalCurrency: 1}]});
		await h.tasks.start(task);
		assert.equal(task.status, 'failed');
		return {error: task.accounts[0]?.error, h};
	};
	assert.equal((await run({}, {balance: 1})).error, '当前购物车在余额约束下没有可购买数量');
	assert.equal((await run({}, {}, 999)).error, '商品 999 不存在于当前目录');
	assert.equal((await run({list: [{...NAME_TAG, prices: {}}]}, {currencyISO: 'JPY'})).error, '商品 名称标签 缺少 USD 价格', '以价目表回包的币种为准');
	assert.equal((await run({}, {hasWallet: false})).error, '当前账号没有可用钱包余额');
	assert.equal((await run({}, {balance: null})).error, '当前账号没有可用钱包余额');
	assert.equal((await run({queryFails: true}, {})).error, '查询 GC 商品目录失败: GC 请求超时 msg=2500');

	const failed = await run({purchase: async () => {
		throw new Error('PurchaseInit 返回失败 result=8');
	}}, {});
	assert.equal(failed.error, 'PurchaseInit 返回失败 result=8');
	assert.ok(failed.h.accountLogs.includes('alpha error CS2 内购失败: PurchaseInit 返回失败 result=8'));
	assert.deepEqual(failed.h.saved, []);
});

test('任务:账号没连 GC 时先进游戏等连接,连上再下单;连不上则失败', async (t) => {
	const h = harness();
	const alpha = makeAttempt('alpha', {cs2GcConnected: false, gcConnected: false, activeGame: ''});
	alpha.client.onPlay = () => {
		alpha.cs2GcConnected = true;
		(alpha.csgo as EventEmitter).emit('connectedToGC');
	};
	h.attempts.set(alpha.id, alpha);
	const task = h.tasks.create('cs2', {alpha: [{itemDefId: 1200, quantity: 1, costInLocalCurrency: 199}]});
	await h.tasks.start(task);
	assert.equal(task.status, 'completed');
	assert.deepEqual(alpha.client.played, [[730]]);

	const offline = harness();
	const beta = makeAttempt('beta', {cs2GcConnected: false});
	offline.attempts.set(beta.id, beta);
	const failing = offline.tasks.create('cs2', {beta: [{itemDefId: 1200, quantity: 1, costInLocalCurrency: 199}]});
	t.mock.timers.enable({apis: ['setTimeout']});
	const done = offline.tasks.start(failing);
	t.mock.timers.tick(0);
	await new Promise(resolve => setImmediate(resolve));
	t.mock.timers.tick(1000);
	await done;
	assert.equal(failing.accounts[0]?.error, '等待 CS2 GC 连接超时');
	assert.deepEqual(offline.purchases, []);
});

test('任务列表:按创建时间倒序,最多保留 60 个', () => {
	const h = harness();
	for (let i = 0; i < 61; i++) {
		h.tasks.create(i % 2 ? 'tf2' : 'cs2', {alpha: [{itemDefId: 1200, quantity: 1, costInLocalCurrency: 1}]});
	}
	const list = h.tasks.list();
	assert.equal(list.length, 60);
	assert.ok(list.every((task, index) => index === 0 || String(list[index - 1]?.createdAt) >= String(task.createdAt)));
	assert.equal(h.tasks.get(list[0]!.id)?.id, list[0]?.id);
	assert.equal(list.find(task => task.game === 'tf2')?.type, 'tf2-purchase');
});

// ===== 拆单:GC 一笔订单最多 20 件 =====

const MUSIC_KIT: CatalogItem = {def_index: 7059, name: '音乐盒 | Vicetone & Cozi Zuehlsdorff, 内华达', type: '音乐盒', category: '音乐盒', prices: {USD: 499}};

const taskItem = (itemDefId: number, quantity: number, unitPriceCents: number): TaskItem =>
	({itemDefId, name: String(itemDefId), type: '', quantity, unitPriceCents, totalPriceCents: unitPriceCents * quantity});
const shape = (orders: TaskItem[][]) => orders.map(order => order.map(item => `${item.itemDefId}x${item.quantity}=${item.totalPriceCents}`).join('+'));

test('拆单规则:每笔 ≤ 20 件,按购物车顺序装满再开下一笔,超出的拆到下一笔,小计按拆出的数量重算', () => {
	assert.equal(MAX_UNITS_PER_ORDER, 20);
	assert.deepEqual(shape(splitIntoOrders([taskItem(7059, 24, 499)])), ['7059x20=9980', '7059x4=1996']);
	assert.deepEqual(shape(splitIntoOrders([taskItem(7059, 20, 499)])), ['7059x20=9980'], '正好 20 件不拆');
	assert.deepEqual(shape(splitIntoOrders([taskItem(1200, 15, 199), taskItem(7059, 10, 499)])), ['1200x15=2985+7059x5=2495', '7059x5=2495']);
	assert.deepEqual(shape(splitIntoOrders([taskItem(1, 45, 100)])), ['1x20=2000', '1x20=2000', '1x5=500']);
	assert.deepEqual(splitIntoOrders([taskItem(1, 0, 100)]), [], '数量 0 的不下单');
});

test('任务:24 个音乐盒拆成 20 + 4 两笔,余额按每笔回包更新', async () => {
	let balance = 169;
	const h = harness({list: [MUSIC_KIT], purchase: async (attempt, order) => {
		const cost = order.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
		balance = Math.round(balance * 100 - cost) / 100;
		return {txnId: `T${h.purchases.length}`, itemIds: [], initResult: 1, finalizeResult: 1, balanceAfter: balance};
	}});
	const viiy = makeAttempt('viiy9563', {balance: 169});
	h.attempts.set(viiy.id, viiy);
	const task = h.tasks.create('cs2', {viiy9563: [{itemDefId: 7059, quantity: 24, costInLocalCurrency: 499}]});
	await h.tasks.start(task);
	const account = task.accounts[0]!;
	assert.equal(account.status, 'completed', account.error);
	assert.deepEqual(h.purchases.map(p => p.order.items.map(item => [item.itemDefId, item.quantity, item.unitPriceCents])), [[[7059, 20, 499]], [[7059, 4, 499]]]);
	assert.equal(account.balanceAfter, 49.24);
	assert.equal(viiy.balance, 49.24);
	assert.ok(task.logs.some(log => log.message.includes('共 24 件，超过每笔 20 件的上限，拆成 2 笔下单')));
	assert.ok(task.logs.some(log => log.message.includes('第 2/2 笔成交:4 件 USD 19.96，交易 T2')));
	assert.ok(task.logs.some(log => log.message.includes('GC 下单成功，交易 T1, T2')));
	assert.ok(h.accountLogs.some(line => line.includes('共 24 件商品(分 2 笔)')));
});

test('任务:拆单后某一笔失败就停,报清已成交多少;第一笔就失败时报原始错误', async () => {
	const h = harness({list: [MUSIC_KIT], purchase: async (attempt, order) => {
		if (h.purchases.length === 2) {
			throw new Error('PurchaseInit 返回失败 result=2(载荷 country=US currency=省略 cost=4990)');
		}
		attempt.balance = Number(attempt.balance) - 99.8;
		return {txnId: 'T1', itemIds: [], initResult: 1, finalizeResult: 1, balanceAfter: Number(attempt.balance)};
	}});
	const viiy = makeAttempt('viiy9563', {balance: 300});
	h.attempts.set(viiy.id, viiy);
	const task = h.tasks.create('cs2', {viiy9563: [{itemDefId: 7059, quantity: 50, costInLocalCurrency: 499}]});
	await h.tasks.start(task);
	const account = task.accounts[0]!;
	assert.equal(account.status, 'failed');
	assert.equal(h.purchases.length, 2, '第 2 笔失败后第 3 笔不再下');
	assert.equal(account.error, '已成交 20/50 件(1 笔，USD 99.80)后第 2 笔失败: PurchaseInit 返回失败 result=2(载荷 country=US currency=省略 cost=4990)');
	assert.equal(account.balanceAfter, 200.2);
	assert.deepEqual(h.saved, ['viiy9563'], '已成交的部分照样存会话(余额已变)');
});
