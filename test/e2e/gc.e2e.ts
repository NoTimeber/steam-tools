// GC:连接/断开 CS2 GC、通过 GC 拉 CS2 商店价目表生成内购目录(价目表用真实样本,与解析快照对比)。
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
		server = await startServer({appRoot, env: {APP_PASSWORD: password}});
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

	test('外部网络全部被拦截,只有预期内的请求', () => {
		const blocked = server.steamEvents().filter(e => e.event === 'blockedFetch').map(e => e.url);
		// 登录成功后会去 Steam 商店账户页查国家;除此之外不应有任何外部请求
		assert.deepEqual([...new Set(blocked)].filter(url => !String(url).startsWith('https://store.steampowered.com/')), []);
	});
});
