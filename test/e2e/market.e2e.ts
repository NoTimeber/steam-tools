// 市场求购:行情参考 → 挂求购(含手机确认)→ 刷新对账 → 撤单,走真实的 app/server.js 和 HTTP 接口。
// Steam 市场和手机确认是假的(support/offline-preload.cjs 的 fakeMarket),场景写在 FAKE_MARKET_FILE 里,测试随时改。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client, removeDir, sleep, startServer, tempDir} from './support/server.ts';
import type {FakeSteamEvent, TestServer} from './support/server.ts';

const AK = 'AK-47 | Redline (Field-Tested)';
const AK_URL = 'https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20(Field-Tested)';
// app/services/nameid-db/CS2.json 里这件物品的 item_nameid
const AK_NAMEID = '7178002';

interface OnlineAccount {
	account: string;
	attemptId: string;
	currency: number;
	currencyISO: string;
	balance: number;
}

interface PlaceResult {
	account: string;
	ok: boolean;
	buyOrderId?: string;
	recordId?: string;
	needsConfirmation?: boolean;
	error?: string;
}

interface LedgerRecord {
	id: string;
	account: string;
	buyOrderId: string;
	status: string;
	quantity: number;
	pricePerItemCents: number;
	priceTotalCents: number;
	quantityRemaining?: number;
	itemName: string;
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!ok(value) && Date.now() < deadline) {
		await sleep(100);
		value = await read();
	}
	return value;
}

describe('市场求购', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let marketFile: string;
	let server: TestServer;
	let client: Client;
	let alpha: OnlineAccount;
	let charlie: OnlineAccount;

	const scenario = (value: Record<string, unknown>) => writeFileSync(marketFile, JSON.stringify(value));
	const events = (name: FakeSteamEvent['event']) => server.steamEvents().filter(event => event.event === name);
	const marketCalls = (path: string) => events('marketRequest').filter(event => event.path === path);
	const ledger = async () => (await client.get('/api/market/buyorders')).json.orders as LedgerRecord[];
	const place = async (body: Record<string, unknown>) => {
		const res = await client.post('/api/market/buyorder', body);
		assert.equal(res.status, 200, res.text);
		return res.json as {placed: number; failed: number; results: PlaceResult[]};
	};

	before(async () => {
		appRoot = tempDir('market');
		marketFile = join(appRoot, 'fake-market.json');
		mkdirSync(join(appRoot, 'data', 'config', 'mafile'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([
			{accountName: 'alpha', password: 'pw-good'},
			{accountName: 'charlie', password: 'pw-good'}
		]));
		// 只有 alpha 有 maFile(identity_secret),能自动手机确认
		writeFileSync(join(appRoot, 'data', 'config', 'mafile', 'alpha.maFile'), JSON.stringify({account_name: 'alpha', identity_secret: 'E2E-IDENTITY-SECRET'}));
		scenario({});
		server = await startServer({appRoot, env: {APP_PASSWORD: password, FAKE_MARKET_FILE: marketFile}});
		client = new Client(server.baseUrl);
		await client.login(password);
		await client.post('/api/login', {accountName: 'alpha'});
		await client.post('/api/login', {accountName: 'charlie'});
		const online = await until(() => client.get('/api/market/online-accounts'), res => res.json.accounts.length === 2);
		const accounts = online.json.accounts as OnlineAccount[];
		alpha = accounts.find(a => a.account === 'alpha') as OnlineAccount;
		charlie = accounts.find(a => a.account === 'charlie') as OnlineAccount;
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
	});

	test('可挂求购的账号:登录成功、有 cookie,带钱包币种和余额', () => {
		assert.deepEqual([alpha, charlie].map(a => [a.account, a.currency, a.currencyISO, a.balance]), [['alpha', 1, 'USD', 10], ['charlie', 1, 'USD', 10]]);
	});

	test('行情:nameid 从随程序打包的社区库查到,盘口和概览价按账号币种查,nameid 记进缓存', async () => {
		const res = await client.get(`/api/market/context?accountId=${encodeURIComponent(alpha.attemptId)}&url=${encodeURIComponent(AK_URL)}`);
		assert.equal(res.status, 200, res.text);
		assert.deepEqual(res.json.context, {
			appid: 730, marketHashName: AK, currency: 1, itemNameId: AK_NAMEID, itemName: AK,
			highestBuyOrderCents: 120, lowestSellOrderCents: 150, lowestPrice: '$1.50', medianPrice: '$1.40', volume: '321', currencyISO: 'USD'
		});
		const histogram = marketCalls('/market/itemordershistogram')[0];
		assert.equal(histogram?.query?.item_nameid, AK_NAMEID);
		assert.equal(histogram?.query?.currency, '1');
		const cache = JSON.parse(readFileSync(join(server.dataDir, 'market-nameids.json'), 'utf8'));
		assert.equal(cache[`730|${AK}`], AK_NAMEID);

		const missing = await client.get(`/api/market/context?accountId=nobody&url=${encodeURIComponent(AK_URL)}`);
		assert.equal(missing.status, 404);
		const badUrl = await client.get(`/api/market/context?accountId=${alpha.attemptId}&url=nope`);
		assert.equal(badUrl.status, 400);
	});

	test('挂求购(不用手机确认):两个账号各挂一张;表单、CSRF、Referer 和网页一致;记进账本', async () => {
		const result = await place({accountIds: [alpha.attemptId, 'charlie'], url: AK_URL, pricePerItem: 1.5, quantity: 2, itemName: '红线'});
		assert.equal(result.placed, 2, JSON.stringify(result.results));
		const created = marketCalls('/market/createbuyorder/');
		assert.equal(created.length, 2);
		for (const call of created) {
			assert.equal(call.method, 'POST');
			assert.deepEqual({...call.form, sessionid: undefined}, {
				sessionid: undefined, currency: '1', appid: '730', market_hash_name: AK, price_total: '300', quantity: '2', billing_state: '', save_my_address: '0'
			});
			assert.ok(call.form?.sessionid, '表单带 sessionid,且与 cookie 一致(假市场不一致会回 success=15)');
			assert.equal(call.referer, AK_URL);
		}
		assert.notEqual(created[0]?.owner, created[1]?.owner);
		// alpha 有 maFile:挂单前先拍一次确认项快照
		assert.deepEqual(events('marketConfirmList').map(e => e.tag), ['list']);

		const orders = await ledger();
		assert.deepEqual(orders.map(o => [o.account, o.status, o.quantity, o.pricePerItemCents, o.priceTotalCents, o.itemName]).sort(), [
			['alpha', 'active', 2, 150, 300, '红线'], ['charlie', 'active', 2, 150, 300, '红线']
		]);
		assert.deepEqual(orders.map(o => o.buyOrderId).sort(), result.results.map(r => r.buyOrderId).sort());
		assert.deepEqual(orders.map(o => o.id).sort(), result.results.map(r => r.recordId).sort());
	});

	test('挂求购(要手机确认):有 maFile 的自动确认后带 confirmation 重发落单;没 maFile 的如实报告', async () => {
		scenario({needConfirmation: true});
		const before = (await ledger()).length;
		const result = await place({accountIds: ['alpha', 'charlie'], url: AK_URL, pricePerItem: 2, quantity: 1, concurrency: 1});
		const [a, c] = result.results;
		assert.equal(a?.ok, true, a?.error);
		assert.ok(a?.buyOrderId);
		assert.equal(c?.ok, false);
		assert.equal(c?.needsConfirmation, true);
		assert.match(c?.error ?? '', /未导入 maFile/);

		const confirms = events('marketConfirm');
		assert.equal(confirms.length, 1);
		assert.deepEqual([confirms[0]?.tag, confirms[0]?.accept], ['accept', true]);
		const resend = marketCalls('/market/createbuyorder/').filter(e => e.form?.confirmation);
		assert.deepEqual(resend.map(e => e.form?.confirmation), [confirms[0]?.confId]);

		const orders = await ledger();
		assert.equal(orders.length, before + 1, 'charlie 没拿到 buy_orderid,不记账');
		assert.equal(orders[0]?.buyOrderId, a?.buyOrderId);
		assert.equal(orders[0]?.status, 'active');
		assert.ok(events('timeOffset').length >= 1, 'Steam 时间差走离线替身');
	});

	test('刷新:Steam 上已成交的从账本移除,其余转 active 并带剩余数量', async () => {
		const orders = await ledger();
		const filled = orders.find(o => o.account === 'alpha' && o.quantity === 2) as LedgerRecord;
		scenario({filled: [filled.buyOrderId]});
		const res = await client.post('/api/market/buyorders/sync', {accounts: [alpha.attemptId, 'charlie']});
		assert.equal(res.status, 200, res.text);
		assert.deepEqual(res.json.syncedAccounts, ['alpha', 'charlie']);
		assert.deepEqual([res.json.summary.removed, res.json.summary.updated], [1, 2]);
		assert.deepEqual(res.json.summary.accounts, [{account: 'alpha', ok: true, count: 1}, {account: 'charlie', ok: true, count: 1}]);
		assert.ok(!res.json.orders.some((o: LedgerRecord) => o.buyOrderId === filled.buyOrderId));
		assert.deepEqual(res.json.orders.map((o: LedgerRecord) => [o.status, o.quantityRemaining]), [['active', 1], ['active', 2]]);
		assert.deepEqual(await ledger(), res.json.orders);
	});

	test('撤单:Steam 上撤掉并从账本删除,再刷新也不会回来', async () => {
		scenario({});
		const target = (await ledger()).find(o => o.account === 'charlie') as LedgerRecord;
		const res = await client.post('/api/market/buyorder/cancel', {id: target.id});
		assert.equal(res.status, 200, res.text);
		const cancel = marketCalls('/market/cancelbuyorder/');
		assert.equal(cancel.length, 1);
		assert.equal(cancel[0]?.form?.buy_orderid, target.buyOrderId);
		assert.ok(!(await ledger()).some(o => o.id === target.id));

		const sync = await client.post('/api/market/buyorders/sync', {accounts: ['charlie']});
		assert.equal(sync.json.summary.accounts[0].count, 0);

		const again = await client.post('/api/market/buyorder/cancel', {id: target.id});
		assert.equal(again.status, 404);
	});

	test('挂满:每个账号按钱包余额算件数(10.00 ÷ 3.00 = 3 件)', async () => {
		const result = await place({accountIds: ['alpha'], url: AK_URL, pricePerItem: 3, perAccountMax: true});
		assert.equal(result.placed, 1, JSON.stringify(result.results));
		const last = marketCalls('/market/createbuyorder/').at(-1);
		assert.deepEqual([last?.form?.quantity, last?.form?.price_total], ['3', '900']);
	});

	test('Steam 拒绝时带出原因;参数不对直接 400,不发请求', async () => {
		scenario({createFail: {success: 25}});
		const result = await place({accountIds: ['alpha'], url: AK_URL, pricePerItem: 1, quantity: 1});
		assert.equal(result.placed, 0);
		assert.match(result.results[0]?.error ?? '', /已达求购单数量上限/);

		const count = marketCalls('/market/createbuyorder/').length;
		const bad = await client.post('/api/market/buyorder', {accountIds: ['alpha'], url: AK_URL, pricePerItem: 0, quantity: 1});
		assert.equal(bad.status, 400);
		assert.equal(bad.json.error, '每件求购价无效');
		const nobody = await client.post('/api/market/buyorder', {accountIds: ['ghost'], url: AK_URL, pricePerItem: 1, quantity: 1});
		assert.equal(nobody.status, 400);
		assert.equal(marketCalls('/market/createbuyorder/').length, count);
	});

	test('外部网络:Steam 市场全走假接口,没有漏出去的请求', () => {
		// 登录成功后会去 Steam 商店账户页查国家(被拦截,不影响);除此之外不应有任何外部请求
		const blocked = events('blockedFetch').map(e => e.url);
		assert.deepEqual([...new Set(blocked)].filter(url => !String(url).startsWith('https://store.steampowered.com/')), []);
	});
});
