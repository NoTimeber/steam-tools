import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNameDb} from '../items/names.ts';
import type {Attempt} from '../steam/session-manager.ts';
import type {CreateBuyOrderParams, CreateBuyOrderResult, LiveBuyOrder, MarketClient, MarketContext} from './client.ts';
import type {BuyOrderConfirmer, ConfirmBuyOrderParams} from '../steam/confirmations.ts';
import {createMarketService, runWithConcurrency} from './index.ts';
import type {MarketServiceOptions} from './index.ts';
import type {BuyOrderRecord} from './ledger.ts';

const URL_AK = 'https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20(Field-Tested)';
const AK = 'AK-47 | Redline (Field-Tested)';

function attempt(name: string, overrides: Partial<Attempt> = {}): Attempt {
	return {
		id: name[0] + '1', accountName: name, status: 'web_session', currency: 1, currencyISO: 'USD', balance: 10, hasWallet: true,
		identitySecret: 'IS-' + name, webSessionID: 'sid-' + name, userAgent: 'UA', steamID: '7656' + name, country: 'US', loginGeoCountry: '',
		...overrides
	} as Attempt;
}

type Step = Partial<CreateBuyOrderResult> | Error;

interface Harness {
	service: ReturnType<typeof createMarketService>;
	files: Map<string, unknown>;
	calls: string[];
	/** 每个账号 createBuyOrder 依次返回的结果 */
	create: Record<string, Step[]>;
	mine: Record<string, LiveBuyOrder[] | Error>;
	/** 设了就让 fetchMyBuyOrders 等它 */
	mineGate?: Promise<void>;
	confirmError: Error | null;
	listConfError: Error | null;
	cancelError: Error | null;
	confirmParams: ConfirmBuyOrderParams[];
	createParams: CreateBuyOrderParams[];
	sleeps: number[];
	clock: {now: number};
	/** fetchGroupName 返回的分组名;Error 则抛 */
	groupName: string | Error;
}

function harness(attempts: Attempt[], files: Record<string, unknown> = {}, extra: Partial<MarketServiceOptions> = {}): Harness {
	const store = new Map<string, unknown>(Object.entries(files));
	const who = (params: {cookies?: readonly string[]}) => String(params.cookies?.[0] ?? '').replace('steamLoginSecure=', '');
	const h = {
		files: store, calls: [] as string[], create: {} as Harness['create'], mine: {} as Harness['mine'],
		confirmError: null, listConfError: null, cancelError: null, confirmParams: [] as ConfirmBuyOrderParams[],
		createParams: [] as CreateBuyOrderParams[], sleeps: [] as number[], clock: {now: Date.parse('2026-10-13T00:00:00Z')},
		groupName: ''
	} as Omit<Harness, 'service'> as Harness;
	const cursor = new Map<string, number>();
	const client: MarketClient = {
		async fetchMarketContext(params) {
			h.calls.push(`context ${params.marketHashName} nameid=${params.itemNameId} cur=${params.currency} ${params.country}`);
			return {...params, currency: Number(params.currency), itemNameId: params.itemNameId || '', itemName: 'N', highestBuyOrderCents: 1, lowestSellOrderCents: 2, lowestPrice: '', medianPrice: '', volume: ''} as MarketContext;
		},
		async createBuyOrder(params) {
			const name = who(params);
			h.createParams.push(params);
			h.calls.push(`create ${name} ${params.priceTotalCents}x${params.quantity}${params.confirmation ? ' conf=' + params.confirmation : ''}`);
			const steps = h.create[name] ?? [{buyOrderId: 'BO-' + name}];
			const index = Math.min(cursor.get(name) ?? 0, steps.length - 1);
			cursor.set(name, index + 1);
			const step = steps[index] as Step;
			if (step instanceof Error) {
				throw step;
			}
			return {success: true, buyOrderId: '', confirmationId: '', needsConfirmation: false, ...step};
		},
		async cancelBuyOrder(params) {
			h.calls.push(`cancel ${who(params)} ${params.buyOrderId} sid=${params.sessionid}`);
			if (h.cancelError) {
				throw h.cancelError;
			}
			return {success: true};
		},
		async fetchMyBuyOrders(params) {
			const name = who(params);
			h.calls.push(`mine ${name}`);
			await h.mineGate;
			const mine = h.mine[name] ?? [];
			if (mine instanceof Error) {
				throw mine;
			}
			return mine;
		},
		async fetchGroupName(params) {
			h.calls.push(`group ${params.appid} ${params.groupId}`);
			if (h.groupName instanceof Error) {
				throw h.groupName;
			}
			return h.groupName;
		}
	};
	const confirmer: BuyOrderConfirmer = {
		async listConfirmationIds(params) {
			h.calls.push(`snapshot ${who(params)}`);
			if (h.listConfError) {
				throw h.listConfError;
			}
			return new Set(['old']);
		},
		async confirmBuyOrder(params) {
			h.calls.push(`confirm ${who(params)}`);
			h.confirmParams.push(params);
			if (h.confirmError) {
				throw h.confirmError;
			}
			return {confirmed: true, buyOrderId: 'creator'};
		}
	};
	let ids = 0;
	h.service = createMarketService({
		findAttempt: key => attempts.find(a => a.id === key || a.accountName.toLowerCase() === key.toLowerCase()) ?? null,
		cookiesFor: a => a.accountName === 'nocookie' ? [] : ['steamLoginSecure=' + a.accountName],
		ledgerFile: 'LEDGER', nameIdCacheFile: 'NAMEIDS', nameIdDbDir: '/nonexistent',
		readJson: file => store.has(file) ? structuredClone(store.get(file)) : null,
		writeJson: (file, value) => void store.set(file, structuredClone(value)),
		writeText: () => {},
		names: createNameDb({
			'Kilowatt Case': '千瓦武器箱', 'Kilowatt Case Key': '千瓦武器箱钥匙', [AK]: 'AK-47 | 红线 (久经沙场)',
			['StatTrak™ ' + AK]: 'AK-47（StatTrak™） | 红线 (久经沙场)', 'AWP | Redline (Field-Tested)': 'AWP | 红线 (久经沙场)'
		}),
		client, confirmer,
		fetch: (async () => {
			throw new TypeError('offline');
		}) as typeof fetch,
		sleep: async ms => void h.sleeps.push(ms),
		now: () => h.clock.now,
		randomId: () => 'rec-' + (++ids),
		logger: {log() {}, warn() {}},
		...extra
	});
	return h;
}

const ledgerOf = (h: Harness) => (h.files.get('LEDGER') ?? []) as BuyOrderRecord[];

test('并发执行:结果与输入同序,同时最多 limit 个', async () => {
	let running = 0;
	let peak = 0;
	const results = await runWithConcurrency([30, 10, 20, 5], 2, async (ms, index) => {
		peak = Math.max(peak, ++running);
		await new Promise(resolve => setTimeout(resolve, ms));
		running--;
		return index;
	});
	assert.deepEqual(results, [0, 1, 2, 3]);
	assert.equal(peak, 2);
	assert.deepEqual(await runWithConcurrency([], 3, async () => 1), []);
});

test('挂求购:不用确认的直接成交,记账本;按 id/账号名去重', async () => {
	const h = harness([attempt('alpha'), attempt('bravo')]);
	const result = await h.service.place({accountIds: ['a1', 'ALPHA', 'bravo', 'nobody'], url: URL_AK, pricePerItem: 1.5, quantity: 2, itemName: ' 红线 '});
	assert.deepEqual(result, {placed: 2, failed: 0, results: [
		{account: 'alpha', attemptId: 'a1', ok: true, buyOrderId: 'BO-alpha', recordId: 'rec-1'},
		{account: 'bravo', attemptId: 'b1', ok: true, buyOrderId: 'BO-bravo', recordId: 'rec-2'}
	]});
	assert.deepEqual(h.createParams[0], {
		// UA 用会话的(登录时已从新版 UA 池里挑好,见 src/steam/session-manager.ts)
		cookies: ['steamLoginSecure=alpha'], sessionid: 'sid-alpha', userAgent: 'UA', appid: 730, marketHashName: AK, currency: 1, priceTotalCents: 300, quantity: 2
	});
	assert.deepEqual(ledgerOf(h).map(r => [r.id, r.account, r.buyOrderId, r.status, r.itemName, r.pricePerItemCents, r.priceTotalCents, r.currencyISO]), [
		['rec-2', 'bravo', 'BO-bravo', 'active', '红线', 150, 300, 'USD'],
		['rec-1', 'alpha', 'BO-alpha', 'active', '红线', 150, 300, 'USD']
	]);
	assert.equal(ledgerOf(h)[0]?.createdAt, '2026-10-13T00:00:00.000Z');
});

test('挂求购:要手机确认 → 用挂单前快照确认 → 带 confirmation 重发拿到 buy_orderid', async () => {
	const h = harness([attempt('alpha')], {}, {deviceIdFor: name => name === 'alpha' ? 'android:mafile-alpha' : ''});
	h.create.alpha = [{confirmationId: '555', needsConfirmation: true}, {needsConfirmation: true}, {buyOrderId: 'BO-final'}];
	const result = await h.service.place({accountIds: ['alpha'], appid: 730, marketHashName: AK, pricePerItem: 2, quantity: 1});
	assert.equal(result.placed, 1);
	assert.equal(result.results[0]?.buyOrderId, 'BO-final');
	assert.deepEqual(h.calls, ['snapshot alpha', 'create alpha 200x1', 'confirm alpha', 'create alpha 200x1 conf=555', 'create alpha 200x1 conf=555']);
	assert.deepEqual(h.confirmParams[0]?.priorConfIds, new Set(['old']));
	assert.equal(h.confirmParams[0]?.confirmationId, '555');
	// 手机确认用会话的 SteamID、UA 和 maFile 的设备 ID
	const {cookies, steamID, deviceId, userAgent, identitySecret} = h.confirmParams[0] ?? {};
	assert.deepEqual({cookies, steamID, deviceId, userAgent, identitySecret},
		{cookies: ['steamLoginSecure=alpha'], steamID: '7656alpha', deviceId: 'android:mafile-alpha', userAgent: 'UA', identitySecret: 'IS-alpha'});
	assert.deepEqual(h.sleeps, [1500]);
	assert.equal(ledgerOf(h)[0]?.status, 'active');
});

test('挂求购:确认没走完时如实报告;有 buy_orderid 的记成 pending_confirm', async () => {
	const h = harness([attempt('alpha'), attempt('bravo', {identitySecret: ''}), attempt('charlie')]);
	h.create.alpha = [{buyOrderId: 'BO-a', confirmationId: '1', needsConfirmation: true}, {needsConfirmation: true}];
	h.create.bravo = [{confirmationId: '2', needsConfirmation: true}];
	h.create.charlie = [{needsConfirmation: true}];
	h.listConfError = new Error('mobileconf 429');
	const result = await h.service.place({accountIds: ['alpha', 'bravo', 'charlie'], url: URL_AK, pricePerItem: 1, quantity: 1, concurrency: 1});
	assert.equal(result.placed, 0);
	assert.match(result.results[0]?.error ?? '', /带 confirmation 重发仍未拿到 buy_orderid/);
	assert.equal(result.results[0]?.needsConfirmation, true);
	assert.equal(h.sleeps.length, 4, '重发 4 次都还要确认');
	assert.match(result.results[1]?.error ?? '', /未导入 maFile/);
	assert.match(result.results[2]?.error ?? '', /无法定位确认项/, '快照失败、又没有任何 id');
	assert.deepEqual(ledgerOf(h).map(r => [r.account, r.buyOrderId, r.status]), [['alpha', 'BO-a', 'pending_confirm']]);
	assert.deepEqual(result.results.map(r => r.recordId), ['rec-1', '', '']);

	const failing = harness([attempt('alpha')]);
	failing.create.alpha = [{confirmationId: '1', needsConfirmation: true}];
	failing.confirmError = new Error('Steam 拒绝确认');
	const failed = await failing.service.place({accountIds: ['alpha'], url: URL_AK, pricePerItem: 1, quantity: 1});
	assert.match(failed.results[0]?.error ?? '', /自动确认\/最终下单失败:Steam 拒绝确认/);
});

test('挂满:每个账号按自己的余额算件数;余额未知或不够买 1 件的单独报错', async () => {
	const h = harness([
		attempt('alpha', {balance: 10}), attempt('bravo', {balance: 2.99}), attempt('charlie', {balance: null}),
		attempt('delta', {hasWallet: false}), attempt('echo', {balance: 0.5})
	]);
	const result = await h.service.place({accountIds: ['alpha', 'bravo', 'charlie', 'delta', 'echo'], url: URL_AK, pricePerItem: 1.5, quantity: 'ignored', perAccountMax: true});
	assert.deepEqual(h.calls.filter(c => c.startsWith('create')), ['create alpha 900x6', 'create bravo 150x1']);
	assert.deepEqual(result.results.map(r => r.error ?? 'ok'), [
		'ok', 'ok', '钱包余额未知,无法按余额挂满(请刷新账户/确认账号有钱包)', '钱包余额未知,无法按余额挂满(请刷新账户/确认账号有钱包)', '钱包余额 0.50 不足以按当前单价求购 1 件'
	]);
});

test('挂求购:参数和账号校验按顺序报错,带状态码;单个账号出错不影响别的', async () => {
	const h = harness([attempt('alpha'), attempt('eur', {currency: 3}), attempt('nowallet', {currency: null}), attempt('nocookie')]);
	const reject = async (body: Record<string, unknown>, status: number, message: RegExp) => {
		await assert.rejects(h.service.place(body), (err: Error & {statusCode?: number}) => err.statusCode === status && message.test(err.message));
	};
	await reject({accountIds: ['alpha'], url: 'bad', pricePerItem: 1, quantity: 1}, 400, /链接格式不对/);
	await reject({accountIds: ['alpha'], pricePerItem: 1, quantity: 1}, 400, /请提供商品链接/);
	await reject({accountIds: ['ghost'], url: URL_AK, pricePerItem: 1, quantity: 1}, 400, /没有有效的在线账号/);
	await reject({accounts: 'alpha', url: URL_AK, pricePerItem: 1, quantity: 1}, 400, /没有有效的在线账号/);
	await reject({accountIds: ['alpha'], url: URL_AK, pricePerItem: 'abc', quantity: 1}, 400, /每件求购价无效/);
	await reject({accountIds: ['alpha'], url: URL_AK, pricePerItem: 0.004, quantity: 1}, 400, /每件求购价过低/);
	await reject({accountIds: ['alpha'], url: URL_AK, pricePerItem: 1, quantity: 0}, 400, /求购数量必须为正整数/);
	await reject({accountIds: ['alpha', 'nowallet'], url: URL_AK, pricePerItem: 1, quantity: 1}, 409, /钱包币种未知/);
	await reject({accountIds: ['alpha', 'eur'], url: URL_AK, pricePerItem: 1, quantity: 1}, 409, /币种不一致/);
	assert.deepEqual(h.calls, []);

	h.create.alpha = [new Error('已达求购单数量上限')];
	const result = await h.service.place({accounts: ['alpha', 'nocookie'], url: URL_AK, pricePerItem: 1, quantity: 1});
	assert.deepEqual(result.results.map(r => [r.account, r.ok, r.error]), [
		['alpha', false, '已达求购单数量上限'], ['nocookie', false, '没有可用的 WebSession cookies,请重新登录']
	]);
	assert.equal(h.files.has('LEDGER'), false, '没有新记录就不写账本');
});

test('撤单:按账本记录或账号 + buy_orderid;成功后从账本删掉', async () => {
	const records = [
		{id: 'r1', createdAt: '2026-10-01T00:00:00Z', account: 'alpha', attemptId: 'a1', buyOrderId: 'B1'},
		{id: 'r2', createdAt: '2026-10-01T00:00:00Z', account: 'gone', attemptId: 'b1', buyOrderId: 'B2'},
		{id: 'r3', createdAt: '2026-10-01T00:00:00Z', account: 'alpha', attemptId: 'a1', buyOrderId: ''},
		{id: 'r4', createdAt: '2026-10-01T00:00:00Z', account: 'zulu', attemptId: 'z1', buyOrderId: 'B4'}
	];
	const h = harness([attempt('alpha'), attempt('bravo')], {LEDGER: records});
	await h.service.cancel({id: 'r1'});
	await h.service.cancel({id: 'r2'});   // 账号名对不上时按 attemptId 找
	await h.service.cancel({accountId: 'bravo', buyOrderId: ' B9 '});
	assert.deepEqual(h.calls, ['cancel alpha B1 sid=sid-alpha', 'cancel bravo B2 sid=sid-bravo', 'cancel bravo B9 sid=sid-bravo']);
	assert.deepEqual(ledgerOf(h).map(r => r.id), ['r3', 'r4']);

	const status = async (body: Record<string, unknown>) => {
		try {
			await h.service.cancel(body);
			return 200;
		} catch (err) {
			return (err as {statusCode: number}).statusCode;
		}
	};
	assert.equal(await status({id: 'nope'}), 404);
	assert.equal(await status({id: 'r3'}), 400);
	assert.equal(await status({id: 'r4'}), 409);
	h.cancelError = new Error('撤单被拒');
	await assert.rejects(h.service.cancel({accountId: 'alpha', buyOrderId: 'B5'}), (err: Error & {statusCode?: number}) => err.statusCode === 502 && err.message === '撤单被拒');
});

test('对账:逐账号实拉,账号可传 attemptId;离线/失败的照实汇报,记录不动', async () => {
	const h = harness([attempt('alpha'), attempt('bravo'), attempt('nocookie')], {LEDGER: [
		{id: 'r1', createdAt: '2026-10-01T00:00:00Z', account: 'alpha', buyOrderId: 'B1', status: 'pending_confirm'},
		{id: 'r2', createdAt: '2026-10-01T00:00:00Z', account: 'alpha', buyOrderId: 'B2', status: 'active'},
		{id: 'r3', createdAt: '2026-10-01T00:00:00Z', account: 'bravo', buyOrderId: 'B3', status: 'active'},
		{id: 'r4', createdAt: '2026-10-01T00:00:00Z', account: 'zulu', buyOrderId: 'B4', status: 'active'}
	]});
	h.mine.alpha = [{buyOrderId: 'B1', priceCents: 100, quantity: 2, quantityRemaining: 1, appid: 730, marketHashName: AK}];
	h.mine.bravo = new Error('mylistings 失败');
	const result = await h.service.sync({accounts: ['a1', 'alpha', 'bravo', 'zulu', 'nocookie', '']});
	assert.deepEqual(result.accounts, [
		{account: 'alpha', ok: true, count: 1}, {account: 'bravo', ok: false, error: 'mylistings 失败'},
		{account: 'zulu', ok: false, error: '未在线'}, {account: 'nocookie', ok: false, error: '无可用 cookie(请重新登录)'}
	]);
	assert.deepEqual(result.syncedAccounts, ['alpha']);
	assert.deepEqual([result.removed, result.updated], [1, 1]);
	assert.deepEqual(result.orders.map(r => [r.id, r.status, r.quantityRemaining]), [['r1', 'active', 1], ['r3', 'active', undefined], ['r4', 'active', undefined]]);

	// 不传账号:对账本里出现过的所有账号
	const all = await h.service.sync({});
	assert.deepEqual(all.accounts.map(a => a.account), ['alpha', 'bravo', 'zulu']);
});

test('对账期间挂出的单不会被当成「Steam 上已没有」删掉;撤单也不会被挂单请求覆盖', async () => {
	// 对账开始 → 卡在实拉 → 期间挂出一单并落账 → 实拉返回(里面没有这张新单)→ 写回
	const h = harness([attempt('alpha')], {LEDGER: [{id: 'old', createdAt: '2026-10-01T00:00:00Z', account: 'alpha', buyOrderId: 'B-old', status: 'active'}]});
	let release!: () => void;
	h.mineGate = new Promise<void>(resolve => {
		release = resolve;
	});
	h.mine.alpha = [];
	const syncing = h.service.sync({accounts: ['alpha']});
	h.clock.now += 1000;
	await h.service.place({accountIds: ['alpha'], url: URL_AK, pricePerItem: 1, quantity: 1});
	release();
	const result = await syncing;
	assert.deepEqual(result.orders.map(r => r.buyOrderId), ['BO-alpha'], '旧单 Steam 上没了被删,新单保留');
	assert.equal(result.removed, 1);
	assert.deepEqual(ledgerOf(h).map(r => r.buyOrderId), ['BO-alpha']);

	// 挂单在等手机确认时,另一个请求撤掉了一张旧单:挂单落账后旧单不能复活
	const h2 = harness([attempt('alpha')], {LEDGER: [{id: 'old', createdAt: '2026-10-01T00:00:00Z', account: 'alpha', buyOrderId: 'B-old', status: 'active'}]});
	h2.create.alpha = [{confirmationId: '1', needsConfirmation: true}, {buyOrderId: 'B-new'}];
	const placing = h2.service.place({accountIds: ['alpha'], url: URL_AK, pricePerItem: 1, quantity: 1});
	await h2.service.cancel({id: 'old'});
	await placing;
	assert.deepEqual(ledgerOf(h2).map(r => r.buyOrderId), ['B-new']);
});

test('行情:nameid 按手填 → 缓存的顺序;用账号的币种和地区;拿到的 nameid 记进缓存', async () => {
	const h = harness([attempt('alpha', {currency: 23, currencyISO: '', country: '', loginGeoCountry: 'CN'})], {NAMEIDS: {'730|Cached': '555'}});
	const context = await h.service.context({accountId: 'a1', appid: '730', marketHashName: 'Cached'});
	assert.equal(context.itemNameId, '555');
	assert.equal(context.currencyISO, 'CNY');
	await h.service.context({account: 'alpha', url: URL_AK, itemNameId: 'id-77'});
	assert.deepEqual(h.calls, ['context Cached nameid=555 cur=23 CN', `context ${AK} nameid=77 cur=23 CN`]);
	assert.deepEqual(h.files.get('NAMEIDS'), {'730|Cached': '555', [`730|${AK}`]: '77'});

	await assert.rejects(h.service.context({accountId: 'ghost', url: URL_AK}), (err: Error & {statusCode?: number}) => err.statusCode === 404);
	await assert.rejects(h.service.context({accountId: 'a1', url: 'nope'}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
});


type StatusError = Error & {statusCode?: number};

test('搜商品:只搜本地词库(中文或英文),不发 Steam 请求;像英文全名又不在词库里的附一个按原文用的选项', async () => {
	const h = harness([attempt('alpha')]);
	assert.deepEqual(await h.service.search({q: '  '}), {items: []});
	assert.deepEqual((await h.service.search({q: ' 千瓦 '})).items, [
		{appid: 730, marketHashName: 'Kilowatt Case', zh: '千瓦武器箱'}, {appid: 730, marketHashName: 'Kilowatt Case Key', zh: '千瓦武器箱钥匙'}
	]);
	assert.deepEqual((await h.service.search({q: 'Kilowatt Case'})).items.map(i => i.marketHashName), ['Kilowatt Case', 'Kilowatt Case Key'], '已有的不重复');
	assert.deepEqual((await h.service.search({q: 'Gallery Case'})).items, [{appid: 730, marketHashName: 'Gallery Case', zh: null}], '词库里没有的英文名按原文用');
	assert.deepEqual((await h.service.search({q: '不存在'})).items, [], '中文搜不到不给原文选项');
	assert.deepEqual((await h.service.search({q: 'zz'})).items, [], '太短不给');
	assert.deepEqual(h.calls, []);
});

test('搜商品:粘贴老链接就是那一件(CS2 查中文名,其它游戏照样能用);新版分组链接读分组名再搜词库', async () => {
	const h = harness([]);
	assert.deepEqual((await h.service.search({q: URL_AK})).items, [{appid: 730, marketHashName: AK, zh: 'AK-47 | 红线 (久经沙场)'}]);
	assert.deepEqual((await h.service.search({q: 'https://steamcommunity.com/market/listings/570/Inscribed%20Pauldron'})).items,
		[{appid: 570, marketHashName: 'Inscribed Pauldron', zh: null}]);
	h.groupName = 'AK-47 | Redline';
	const group = await h.service.search({q: 'https://steamcommunity.com/market/listings/730/G1807209A023004?l=schinese'});
	assert.deepEqual(group.items.map(i => i.marketHashName), [AK, 'StatTrak™ ' + AK]);
	assert.deepEqual(h.calls, ['group 730 G1807209A023004']);
	h.groupName = 'Brand New Case';
	assert.deepEqual((await h.service.search({q: '/market/listings/730/G18A8263004'})).items, [], '分组名不在词库里就是空,不附按原文用的选项');

	h.groupName = new Error('HTTP 429');
	await assert.rejects(h.service.search({q: '/market/listings/730/G1807209A023004'}),
		(err: StatusError) => err.statusCode === 502 && /分组链接.*HTTP 429.*直接输名字搜/.test(err.message));
	await assert.rejects(h.service.search({q: '/market/listings/570/G1807209A023004'}), (err: StatusError) => err.statusCode === 400 && /只有 CS2/.test(err.message));
	await assert.rejects(h.service.search({q: '/market/listings/0/x'}), (err: StatusError) => err.statusCode === 400);
});

test('搜商品:TF2 在 nameid 库的英文名里搜(钥匙有中文名);和 CS2 一起时 TF2 不会被挤掉;老链接、分组链接也认 TF2', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'market-tf2-'));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	const KEY = 'Mann Co. Supply Crate Key';
	const tf2Names = {[KEY]: 1, 'Tour of Duty Ticket': 2, ...Object.fromEntries(Array.from({length: 40}, (_, i) => [`Summer Crate Key ${i}`, 100 + i]))};
	writeFileSync(join(dir, 'TF2.json'), JSON.stringify(tf2Names));
	const h = harness([], {}, {nameIdDbDir: dir});
	const key = {appid: 440, marketHashName: KEY, zh: '曼恩公司补给箱钥匙'};

	assert.deepEqual((await h.service.search({q: 'mann co. supply crate key'})).items[0], key, '完全一致的排最前');
	assert.deepEqual((await h.service.search({q: '曼恩'})).items, [key], '中文名也能搜到');
	assert.deepEqual((await h.service.search({q: KEY})).items, [key], '找到了就不附 CS2 按原文用的选项');
	assert.deepEqual((await h.service.search({q: 'tour duty'})).items[0], {appid: 440, marketHashName: 'Tour of Duty Ticket', zh: null});

	// 「key」:CS2 词库里 1 个、TF2 里 41 个,词库结果一共最多 30 个,CS2 的在前;最后是按原文用的选项
	const keys = (await h.service.search({q: 'key'})).items;
	assert.equal(keys.length, 31);
	assert.deepEqual(keys.at(-1), {appid: 730, marketHashName: 'key', zh: null});
	assert.deepEqual(keys[0], {appid: 730, marketHashName: 'Kilowatt Case Key', zh: '千瓦武器箱钥匙'});
	assert.equal(keys.filter(item => item.appid === 440).length, 29);
	assert.equal(keys.filter(item => item.zh != null || item.appid === 440).length, 30);

	assert.deepEqual((await h.service.search({q: 'https://steamcommunity.com/market/listings/440/Mann%20Co.%20Supply%20Crate%20Key'})).items, [key]);
	h.groupName = KEY;
	assert.deepEqual((await h.service.search({q: '/market/listings/440/G1234567890'})).items, [key], 'TF2 的分组链接只在 TF2 里搜');
	assert.deepEqual(h.calls, ['group 440 G1234567890']);
});
