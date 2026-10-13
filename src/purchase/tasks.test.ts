import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {Attempt} from '../steam/session-manager.ts';
import {clampItemsToBalance, createPurchaseTasks, formatMoney, normalizeCartData, PURCHASE_MAX_ITEM_QUANTITY} from './tasks.ts';
import type {PublicTask, TaskAccount, TaskEvent} from './tasks.ts';
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
