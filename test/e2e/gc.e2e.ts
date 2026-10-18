// GC:连接/断开 CS2 GC、通过 GC 拉 CS2 商店价目表生成内购目录(价目表用真实样本,与解析快照对比)、库存、终端机接口。
// GC 由 support/offline-preload.cjs 模拟;外部网络被拦截(汇率返回固定数据)。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client, REPO_ROOT, removeDir, sleep, startServer, tempDir} from './support/server.ts';
import type {TestServer} from './support/server.ts';

interface CatalogItem {
	def_index: number;
	name: string;
	category: string;
	prices: Record<string, number>;
}

const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'price-sheets', 'cs2-usd.expected.json'), 'utf8')) as {
	itemCount: number;
	itemDigests: Record<string, string>;
};
const sortKeys = (prices: Record<string, number>) => Object.fromEntries(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)));
const digest = (prices: Record<string, number>) => createHash('sha256').update(JSON.stringify(sortKeys(prices))).digest('hex').slice(0, 16);

async function attemptOf(client: Client, accountName: string) {
	const res = await client.get('/api/attempts');
	return (res.json.attempts as Array<Record<string, unknown>>).find(a => a.accountName === accountName);
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!ok(value) && Date.now() < deadline) {
		await sleep(100);
		value = await read();
	}
	return value;
}

describe('GC', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let server: TestServer;
	let client: Client;
	let attemptId = '';

	before(async () => {
		appRoot = tempDir('gc');
		mkdirSync(join(appRoot, 'data', 'config'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([{accountName: 'alpha', password: 'pw-good'}]));
		server = await startServer({appRoot, env: {APP_PASSWORD: password, FAKE_INVENTORY_FILE: join(appRoot, 'fake-inventory.json')}});
		client = new Client(server.baseUrl);
		await client.login(password);
		const res = await client.post('/api/login', {accountName: 'alpha'});
		attemptId = res.json.attempt.id;
		await until(() => attemptOf(client, 'alpha'), a => a?.status === 'web_session');
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
	});

	test('没有连 GC 的账号时,刷新 CS2 目录会先自动进游戏连 GC', async () => {
		const res = await client.post('/api/cs2/refresh-items', {});
		assert.equal(res.status, 200, res.text.slice(0, 200));
		const alpha = await attemptOf(client, 'alpha');
		assert.equal(alpha?.cs2GcConnected, true);
		assert.ok(server.steamEvents().some(e => e.event === 'gamesPlayed' && e.apps?.[0] === 730));
		assert.ok(server.steamEvents().some(e => e.event === 'sendToGC' && e.msgType === 2500), '发过 StoreGetUserData');
	});

	test('CS2 内购目录:商品数与每个商品的价格和价目表解析快照一致', async () => {
		const res = await client.get('/api/cs2/items');
		assert.equal(res.status, 200);
		const list = res.json.list as CatalogItem[];
		assert.equal(res.json.count, snapshot.itemCount);
		assert.equal(list.length, snapshot.itemCount);
		const mismatched = list.filter(item => digest(item.prices) !== snapshot.itemDigests[item.def_index]).map(item => item.def_index);
		assert.deepEqual(mismatched, []);
		assert.ok(list.every(item => item.name && item.category), '商品名称和分类由 schema 补上');
		assert.equal(res.json.account, 'alpha');
	});

	test('价目表留样和目录缓存写到数据目录', () => {
		const dumps = readdirSync(join(server.dataDir, 'price-sheets')).filter(f => f.startsWith('cs2-price-sheet-'));
		assert.equal(dumps.length, 1);
		assert.ok(readFileSync(join(server.dataDir, 'price-sheets', dumps[0] as string)).equals(readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'price-sheets', 'cs2-usd.bkv'))));
		assert.ok(existsSync(join(server.dataDir, 'purchase-catalogs', 'cs2.json')));
	});

	test('断开 GC:退出游戏,连接标记清掉', async () => {
		const res = await client.post(`/api/gc/disconnect/${attemptId}`, {game: 'cs2'});
		assert.equal(res.status, 200);
		assert.equal(res.json.attempt.cs2GcConnected, false);
		const played = server.steamEvents().filter(e => e.event === 'gamesPlayed');
		assert.deepEqual(played.at(-1)?.apps, []);
	});

	test('手动连 GC:进游戏后收到 GC 欢迎消息,连接标记置位', async () => {
		const res = await client.post(`/api/gc/connect/${attemptId}`, {game: 'cs2'});
		assert.equal(res.status, 200);
		const alpha = await until(() => attemptOf(client, 'alpha'), a => a?.cs2GcConnected === true);
		assert.equal(alpha?.cs2GcConnected, true);
		assert.equal(alpha?.gcConnected, true);
	});

	test('库存:以社区库存为准,分页拉完;中文名、标签、交易冷却都来自社区', async () => {
		const res = await client.get(`/api/inventory/${attemptId}`);
		assert.equal(res.status, 200, res.text.slice(0, 300));
		const inventory = res.json.inventory;
		assert.deepEqual([inventory.source, inventory.itemCount], ['community', 3]);
		const [rifle, key] = inventory.items;
		assert.deepEqual([rifle.assetid, rifle.name, rifle.type, rifle.rarity, rifle.exterior, rifle.tradable, rifle.marketable], ['101', 'AK-47 | 红线 (久经沙场)', '步枪', '保密', '久经沙场', true, true]);
		assert.ok(rifle.iconUrl.endsWith('/economy/image/ak/96fx96f'));
		assert.deepEqual([key.tradable, key.tradableAfter], [false, new Date('Feb 03, 2099 07:00:00 GMT').toISOString()]);
		const requests = server.steamEvents().filter(e => e.event === 'inventoryRequest');
		assert.deepEqual(requests.map(e => [e.query?.l, e.query?.count, e.query?.start_assetid]), [['schinese', '2000', undefined], ['schinese', '2000', '102']]);
		const alpha = await attemptOf(client, 'alpha');
		assert.deepEqual([alpha?.inventoryCount, alpha?.inventorySource], [3, 'community']);
	});

	test('库存:15 秒内再开直接用缓存;库存私密时强制刷新报 409(GC 库存是空的,没法兜底)', async () => {
		const before = server.steamEvents().filter(e => e.event === 'inventoryRequest').length;
		assert.equal((await client.get(`/api/inventory/${attemptId}`)).status, 200);
		assert.equal(server.steamEvents().filter(e => e.event === 'inventoryRequest').length, before);

		writeFileSync(join(appRoot, 'fake-inventory.json'), JSON.stringify({private: true}));
		const res = await client.get(`/api/inventory/${attemptId}?refresh=1`);
		assert.equal(res.status, 409);
		assert.equal(res.json.error, 'Forbidden');
		assert.equal((await client.get('/api/inventory/no-such-id')).status, 404);
	});

	test('终端机:抓包已挂上;没有终端机时状态为空、解封被拒;拉报价的消息发到了 GC;找不到账号 404', async () => {
		const state = await client.get(`/api/terminal/state?accountId=${attemptId}`);
		assert.equal(state.status, 200, state.text.slice(0, 300));
		assert.deepEqual([state.json.state.attached, state.json.state.terminals], [true, []]);

		const unseal = await client.post('/api/terminal/unseal', {accountId: attemptId, gcItemId: '', assetid: '123'});
		assert.equal(unseal.status, 400);
		assert.match(unseal.json.error, /GC 库存里没有 id\/original_id=123 的终端机/);

		const before = server.steamEvents().filter(e => e.event === 'sendToGC').length;
		const request = await client.post('/api/terminal/request-offers', {account: 'alpha', defidx: 5176});
		assert.equal(request.status, 200, request.text);
		assert.deepEqual(request.json.result, {sent: true, defidx: 5176, itemId: null});
		const sent = server.steamEvents().filter(e => e.event === 'sendToGC').slice(before).map(e => [e.appid, e.msgType]);
		assert.deepEqual(sent, [[730, 9195], [730, 9228]]);

		assert.equal((await client.get('/api/terminal/state?accountId=nobody')).status, 404);
	});

	test('库存不用连 GC:断开 GC 后照样拉社区库存', async () => {
		writeFileSync(join(appRoot, 'fake-inventory.json'), JSON.stringify({}));
		assert.equal((await client.post(`/api/gc/disconnect/${attemptId}`, {game: 'cs2'})).status, 200);
		const res = await client.get(`/api/inventory/${attemptId}?refresh=1`);
		assert.equal(res.status, 200, res.text.slice(0, 300));
		assert.deepEqual([res.json.inventory.source, res.json.inventory.itemCount, res.json.attempt.cs2GcConnected], ['community', 3, false]);
		assert.equal(res.json.attempt.inventoryCount, 3);
	});

	test('外部网络全部被拦截,只有预期内的请求', () => {
		const blocked = server.steamEvents().filter(e => e.event === 'blockedFetch').map(e => e.url);
		// 登录成功后会去 Steam 商店账户页查国家;终端机皮肤库用随包副本,后台联网刷新被拦;除此之外不应有任何外部请求
		const expected = (url: string) => url.startsWith('https://store.steampowered.com/') || url === 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/zh-CN/skins.json';
		assert.deepEqual([...new Set(blocked)].filter(url => !expected(String(url))), []);
	});
});
