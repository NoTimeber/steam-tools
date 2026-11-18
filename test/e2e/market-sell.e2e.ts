// 市场出售:可上架库存 → 参考价 → 上架(只自动确认本批)→ 我的在售 → 下架 → 成交记录,走真实的服务端和 HTTP 接口。
// Steam 市场、库存和手机确认是假的(support/offline-preload.cjs 的 fakeSell / fakeInventory / fakeMobileconf),
// 场景写在 FAKE_MARKET_FILE、FAKE_INVENTORY_FILE、FAKE_CONFIRMATIONS_FILE 里。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client, removeDir, sleep, startServer, tempDir} from './support/server.ts';
import type {FakeSteamEvent, TestServer} from './support/server.ts';

const AK = 'AK-47 | Redline (Field-Tested)';

interface SellResult {
	assetid: string;
	status: 'listed' | 'pending_confirmation' | 'failed';
	listingId?: string;
	buyerPriceCents: number;
	receivePriceCents: number;
	marketHashName: string;
	message: string;
}

interface SellResponse {
	account: string;
	results: SellResult[];
	listed: number;
	pendingConfirmation: number;
	failed: number;
	confirmed: number;
	needsMobile: boolean;
}

interface Listing {
	listingId: string;
	status: string;
	originalAssetid: string;
	marketHashName: string;
	buyerPriceCents: number;
	receiveCents: number;
}

interface ListingsAccount {
	account: string;
	ok: boolean;
	error?: string;
	counts?: {active: number; toConfirm: number; onHold: number};
	listings?: Listing[];
}

// 卖家库存:4 件能上架,1 件交易冷却中不能上架
const description = (classid: string, name: string, hash: string, marketable = 1) => ({
	classid, instanceid: '0', name, market_hash_name: hash, tradable: marketable, marketable, icon_url: 'icon' + classid,
	...(marketable ? {} : {owner_descriptions: [{value: 'Tradable After Feb 03, 2099 (7:00:00) GMT'}]})
});
const INVENTORY = {
	descriptions: [
		description('1', 'AK-47 | 红线 (久经沙场)', AK),
		description('2', '千瓦武器箱', 'Kilowatt Case'),
		description('3', '冷却中的箱子', 'Revolution Case', 0)
	],
	assets: [
		{assetid: '201', classid: '1', instanceid: '0', amount: '1'},
		{assetid: '202', classid: '2', instanceid: '0', amount: '1'},
		{assetid: '203', classid: '2', instanceid: '0', amount: '1'},
		{assetid: '204', classid: '2', instanceid: '0', amount: '1'},
		{assetid: '205', classid: '3', instanceid: '0', amount: '1'}
	]
};
// 一条和出售无关的待确认交易报价:自动确认绝不能碰它
const UNRELATED_CONF = {id: '7001', creator_id: '4242', type: 2, type_name: 'Trade Offer', headline: 'trade with someone'};

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!ok(value) && Date.now() < deadline) {
		await sleep(100);
		value = await read();
	}
	return value;
}

describe('市场出售', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let marketFile: string;
	let server: TestServer;
	let client: Client;
	/** 本批自动确认前就在等确认的那件(203)的 listingid */
	let priorListingId = '';
	let batch: SellResult[] = [];

	const scenario = (value: Record<string, unknown>) => writeFileSync(marketFile, JSON.stringify(value));
	const events = (name: FakeSteamEvent['event']) => server.steamEvents().filter(event => event.event === name);
	const marketCalls = (path: string) => events('marketRequest').filter(event => event.path === path);
	const sell = async (body: Record<string, unknown>) => {
		const res = await client.post('/api/market/sell', body);
		assert.equal(res.status, 200, res.text);
		return res.json as SellResponse;
	};
	const listingsOf = async (accounts: string[]) => {
		const res = await client.post('/api/market/listings', {accounts});
		assert.equal(res.status, 200, res.text);
		return res.json.accounts as ListingsAccount[];
	};
	const inventoryIds = async (account: string) => {
		const res = await client.get(`/api/market/sell/inventory?account=${account}&refresh=1`);
		assert.equal(res.status, 200, res.text);
		return (res.json.items as Array<{assetid: string}>).map(item => item.assetid);
	};

	before(async () => {
		appRoot = tempDir('market-sell');
		marketFile = join(appRoot, 'fake-market.json');
		const inventoryFile = join(appRoot, 'fake-inventory.json');
		const confirmationsFile = join(appRoot, 'fake-confirmations.json');
		mkdirSync(join(appRoot, 'data', 'config', 'mafile'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([
			{accountName: 'alpha', password: 'pw-good'},
			{accountName: 'charlie', password: 'pw-good'}
		]));
		// 只有 alpha 有 maFile(identity_secret),能自动手机确认
		writeFileSync(join(appRoot, 'data', 'config', 'mafile', 'alpha.maFile'), JSON.stringify({account_name: 'alpha', identity_secret: 'E2E-IDENTITY-SECRET', device_id: 'android:e2e-alpha-device'}));
		writeFileSync(inventoryFile, JSON.stringify(INVENTORY));
		writeFileSync(confirmationsFile, JSON.stringify([UNRELATED_CONF]));
		scenario({});
		server = await startServer({appRoot, env: {
			APP_PASSWORD: password, FAKE_MARKET_FILE: marketFile, FAKE_INVENTORY_FILE: inventoryFile, FAKE_CONFIRMATIONS_FILE: confirmationsFile
		}});
		client = new Client(server.baseUrl);
		await client.login(password);
		await client.post('/api/login', {accountName: 'alpha'});
		await client.post('/api/login', {accountName: 'charlie'});
		await until(() => client.get('/api/market/online-accounts'), res => res.json.accounts.length === 2);
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
	});

	test('可上架库存:全部物品带 marketable / 冷却,钱包币种和手续费参数;账号不在 404', async () => {
		const res = await client.get('/api/market/sell/inventory?account=alpha');
		assert.equal(res.status, 200, res.text);
		assert.deepEqual([res.json.account, res.json.appid, res.json.contextid, res.json.currency, res.json.publisherFeePercent, res.json.total, res.json.marketableCount],
			['alpha', 730, '2', {id: 1, iso: 'USD'}, 0.1, 5, 4]);
		assert.deepEqual(res.json.fees, {steamFeePercent: 0.05, steamFeeMinimum: 1, steamFeeBase: 0, publisherFeePercent: 0.1});
		const byId = new Map((res.json.items as Array<Record<string, unknown>>).map(item => [item.assetid, item]));
		assert.deepEqual(byId.get('201'), {
			appid: 730, contextid: '2', assetid: '201', amount: 1, marketHashName: AK, name: 'AK-47 | 红线 (久经沙场)', zh: 'AK-47 | 红线 (久经沙场)',
			icon: 'https://community.cloudflare.steamstatic.com/economy/image/icon1/96fx96f', type: '-', rarity: '', rarityColor: '', exterior: '',
			marketable: true, tradable: true, cooldownUntil: null
		});
		assert.equal(byId.get('205')?.marketable, false);
		assert.equal(byId.get('205')?.cooldownUntil, '2099-02-03T07:00:00.000Z');
		assert.match(String(events('inventoryRequest').at(-1)?.path), /^\/inventory\/\d+\/730\/2$/);

		const missing = await client.get('/api/market/sell/inventory?account=ghost');
		assert.equal(missing.status, 404);
		assert.equal(missing.json.success, false);
	});

	test('参考价:最低在售 / 最高求购按账号币种查,各自拆出到手价;手续费换算接口', async () => {
		const res = await client.get(`/api/market/sell/price?account=alpha&appid=730&marketHashName=${encodeURIComponent(AK)}`);
		assert.equal(res.status, 200, res.text);
		assert.deepEqual([res.json.context.lowestSellOrderCents, res.json.context.highestBuyOrderCents, res.json.context.currencyISO], [150, 120, 'USD']);
		assert.deepEqual(res.json.lowestSell, {buyerPrice: 150, receive: 131, steamFee: 6, publisherFee: 13, fees: 19});
		assert.deepEqual(res.json.highestBuyOrder, {buyerPrice: 120, receive: 105, steamFee: 5, publisherFee: 10, fees: 15});
		assert.equal(marketCalls('/market/itemordershistogram').at(-1)?.query?.currency, '1');

		const quote = await client.get('/api/market/sell/quote?buyerPriceCents=3');
		assert.deepEqual(quote.json.quote, {buyerPrice: 3, receive: 1, steamFee: 1, publisherFee: 1, fees: 2});
		const both = await client.get('/api/market/sell/quote?buyerPriceCents=3&receivePriceCents=1');
		assert.equal(both.status, 400);
	});

	test('不开自动确认:上架后留在待确认(之后这条不能被别的批次顺手确认)', async () => {
		const result = await sell({account: 'alpha', items: [{appid: 730, contextid: '2', assetid: '203', receivePriceCents: 50}], autoConfirm: false});
		assert.equal(result.results[0]?.status, 'pending_confirmation', JSON.stringify(result));
		assert.match(result.results[0]?.message ?? '', /手机上确认/);
		priorListingId = result.results[0]?.listingId ?? '';
		assert.ok(priorListingId, '从 listings_to_confirm 对上了 listingid');
		assert.equal(events('sellConfirm').length, 0);
	});

	test('上架两件 + 自动确认:表单 / Referer 和网页一致;只确认本批两件,先前的上架和交易报价不碰', async () => {
		const result = await sell({account: 'alpha', items: [
			{appid: 730, contextid: '2', assetid: '201', buyerPriceCents: 115},
			{appid: 730, contextid: '2', assetid: '202', receivePriceCents: 200}
		]});
		batch = result.results;
		assert.deepEqual(result.results.map(r => [r.assetid, r.status, r.buyerPriceCents, r.receivePriceCents, r.marketHashName]), [
			['201', 'listed', 115, 100, AK],
			['202', 'listed', 230, 200, 'Kilowatt Case']
		], JSON.stringify(result));
		assert.deepEqual([result.listed, result.pendingConfirmation, result.failed, result.confirmed, result.needsMobile], [2, 0, 0, 2, false]);

		const sold = marketCalls('/market/sellitem/').slice(-2);
		assert.deepEqual(sold.map(call => ({...call.form, sessionid: undefined})), [
			{sessionid: undefined, appid: '730', contextid: '2', assetid: '201', amount: '1', price: '100'},
			{sessionid: undefined, appid: '730', contextid: '2', assetid: '202', amount: '1', price: '200'}
		]);
		for (const call of sold) {
			assert.equal(call.method, 'POST');
			assert.ok(call.form?.sessionid);
			assert.match(call.referer ?? '', /^https:\/\/steamcommunity\.com\/profiles\/\d+\/inventory\/$/);
		}

		const confirms = events('sellConfirm');
		assert.equal(confirms.length, 1, '一次 multiajaxop 确认两条');
		assert.deepEqual([...confirms[0]!.listingIds!].sort(), result.results.map(r => r.listingId).sort());
		assert.deepEqual([confirms[0]?.op, confirms[0]?.accept, confirms[0]?.params?.p], ['allow', true, 'android:e2e-alpha-device']);
		assert.ok(!confirms[0]!.listingIds!.includes(priorListingId));
		assert.equal(events('mobileconfRespond').length, 0, '无关的交易报价确认项没被处理');
	});

	test('我的在售:多账号;本批在售、先前那件仍待确认;上架的物品不在库存里', async () => {
		const accounts = await listingsOf(['alpha', 'charlie', 'ghost']);
		assert.deepEqual(accounts.map(a => [a.account, a.ok, a.counts ?? null]), [
			['alpha', true, {active: 2, toConfirm: 1, onHold: 0}],
			['charlie', true, {active: 0, toConfirm: 0, onHold: 0}],
			['ghost', false, null]
		]);
		const alpha = accounts[0]!.listings!;
		assert.deepEqual(alpha.map(l => [l.listingId, l.status, l.originalAssetid, l.buyerPriceCents, l.receiveCents]).sort(), [
			[batch[0]!.listingId, 'active', '201', 115, 100],
			[batch[1]!.listingId, 'active', '202', 230, 200],
			[priorListingId, 'to_confirm', '203', 57, 50]
		].sort());
		assert.deepEqual(await inventoryIds('alpha'), ['204', '205']);
		// 令牌确认页看到的:无关的交易报价、先前那件的上架都还在待确认
		const confs = await client.post('/api/accounts/confirmations/list', {accountName: 'alpha'});
		assert.equal(confs.status, 200, confs.text);
		assert.deepEqual((confs.json.confirmations as Array<{id: string; creator: string}>).map(c => c.creator).sort(), ['4242', priorListingId].sort());
	});

	test('下架:Steam 上撤掉,物品回到库存;再撤报错', async () => {
		const target = batch[0]!.listingId!;
		const res = await client.post('/api/market/listing/cancel', {account: 'alpha', listingId: target});
		assert.equal(res.status, 200, res.text);
		assert.deepEqual(res.json, {success: true, account: 'alpha', listingId: target});
		const call = marketCalls(`/market/removelisting/${target}`);
		assert.equal(call.length, 1);
		assert.equal(call[0]?.method, 'POST');
		assert.ok(call[0]?.form?.sessionid);
		const [alpha] = await listingsOf(['alpha']);
		assert.deepEqual(alpha?.counts, {active: 1, toConfirm: 1, onHold: 0});
		assert.ok((await inventoryIds('alpha')).includes('201'));

		const again = await client.post('/api/market/listing/cancel', {account: 'alpha', listingId: target});
		assert.equal(again.status, 502);
		const bad = await client.post('/api/market/listing/cancel', {account: 'alpha', listingId: 'abc'});
		assert.equal(bad.status, 400);
	});

	test('成交记录:卖出(带买家、成交价、到手)/ 下架 / 上架,分页', async () => {
		scenario({soldListings: [batch[1]!.listingId]});
		const res = await client.post('/api/market/history', {account: 'alpha', start: 0, count: 50});
		assert.equal(res.status, 200, res.text);
		assert.equal(res.json.totalCount, 5);
		type Event = {type: string; listingId: string; marketHashName: string; buyerPriceCents: number; receiveCents: number | null; counterpart: {steamId: string; persona: string} | null; date: string};
		const list = res.json.events as Event[];
		assert.deepEqual(list.map(e => [e.type, e.listingId]), [
			['sold', batch[1]!.listingId],
			['cancelled', batch[0]!.listingId],
			['listed', batch[1]!.listingId],
			['listed', batch[0]!.listingId],
			['listed', priorListingId]
		]);
		assert.deepEqual([list[0]?.marketHashName, list[0]?.buyerPriceCents, list[0]?.receiveCents, list[0]?.counterpart], [
			'Kilowatt Case', 230, 200, {steamId: '76561190000099999', persona: 'Fake Buyer', avatar: ''}
		]);
		assert.ok(list.every(e => !Number.isNaN(Date.parse(e.date))));
		assert.equal(marketCalls('/market/myhistory/render/').at(-1)?.query?.norender, '1');

		const page = await client.post('/api/market/history', {account: 'alpha', start: 3, count: 2});
		assert.deepEqual((page.json.events as Event[]).map(e => e.listingId), [batch[0]!.listingId, priorListingId]);
		assert.deepEqual([page.json.start, page.json.count], [3, 2]);
		const bad = await client.post('/api/market/history', {account: 'alpha', count: 500});
		assert.equal(bad.status, 400);
		scenario({});
	});

	test('没 maFile 的账号:上架成功但留待手机确认;不能上架的、Steam 拒绝的各自失败,不影响其它', async () => {
		scenario({sellFail: {'203': 'You have too many listings pending confirmation.'}});
		const before = events('sellConfirm').length;
		const calls = marketCalls('/market/sellitem/').length;
		const result = await sell({account: 'charlie', items: [
			{appid: 730, assetid: '204', receivePriceCents: 10},
			{appid: 730, assetid: '205', receivePriceCents: 10},
			{appid: 730, assetid: '203', receivePriceCents: 10}
		]});
		assert.deepEqual(result.results.map(r => [r.assetid, r.status]), [['204', 'pending_confirmation'], ['205', 'failed'], ['203', 'failed']]);
		assert.match(result.results[0]!.message, /需要在手机上确认/);
		assert.ok(result.results[0]!.listingId);
		assert.match(result.results[1]!.message, /冷却/);
		assert.match(result.results[2]!.message, /too many listings/);
		assert.equal(result.needsMobile, true);
		assert.equal(marketCalls('/market/sellitem/').length, calls + 2, '不能上架的那件不发 sellitem');
		assert.equal(events('sellConfirm').length, before);
		scenario({});
	});

	test('参数不对整批 400,不发请求', async () => {
		const calls = marketCalls('/market/sellitem/').length;
		const cases: Array<[Record<string, unknown>, number]> = [
			[{account: 'alpha', items: [{appid: 730, assetid: '204', buyerPriceCents: 2}]}, 400],
			[{account: 'alpha', items: [{appid: 730, assetid: '204', receivePriceCents: 1.5}]}, 400],
			[{account: 'alpha', items: [{appid: 730, assetid: '204'}]}, 400],
			[{account: 'alpha', items: [{appid: 730, assetid: '204', buyerPriceCents: 300000}]}, 400],
			[{account: 'alpha', items: []}, 400],
			[{account: 'ghost', items: [{appid: 730, assetid: '204', receivePriceCents: 5}]}, 404]
		];
		for (const [body, status] of cases) {
			const res = await client.post('/api/market/sell', body);
			assert.equal(res.status, status, JSON.stringify(body) + ' ' + res.text);
			assert.equal(res.json.success, false);
		}
		assert.equal(marketCalls('/market/sellitem/').length, calls);
	});

	test('外部网络:没有漏出去的请求;响应里没有 cookie', async () => {
		const blocked = events('blockedFetch').map(e => e.url);
		assert.deepEqual([...new Set(blocked)].filter(url => !String(url).startsWith('https://store.steampowered.com/')), []);
		const res = await client.post('/api/market/listings', {accounts: ['alpha']});
		assert.doesNotMatch(res.text, /steamLoginSecure|sessionid/i);
	});
});
