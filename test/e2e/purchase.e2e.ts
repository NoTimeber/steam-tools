// 游戏内购:从 HTTP 接口下单,走完 GC 下单 → Steam 钱包扣款授权 → 确认,余额跟着变。
// 假 GC(support/offline-preload.cjs)按真实 GC 实测的规则拒单:美元账号带 currency=1、或带 purchase_type=0 → result=8,
// 所以下单载荷规则写错的话这里会失败。钱包初始 10.00 美元。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client, removeDir, sleep, startServer, tempDir} from './support/server.ts';
import type {FakeSteamEvent, TestServer} from './support/server.ts';

interface CatalogItem {
	def_index: number;
	name: string;
	prices: Record<string, number>;
}

interface TaskView {
	id: string;
	status: string;
	accounts: Array<{account: string; status: string; error: string; balanceBefore: number | null; balanceAfter: number | null; totalCostCents: number; items: Array<{itemDefId: number; quantity: number; unitPriceCents: number}>}>;
}

async function attemptOf(client: Client, accountName: string) {
	const res = await client.get('/api/attempts');
	return (res.json.attempts as Array<Record<string, unknown>>).find(a => a.accountName === accountName);
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!ok(value) && Date.now() < deadline) {
		await sleep(100);
		value = await read();
	}
	return value;
}

describe('游戏内购', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let server: TestServer;
	let client: Client;
	let cheap: CatalogItem;

	async function runTask(path: string, body: unknown): Promise<TaskView> {
		const res = await client.post(path, body);
		assert.equal(res.status, 200, res.text.slice(0, 300));
		const id = res.json.task.id as string;
		const done = await until(async () => {
			const list = await client.get('/api/purchase/tasks');
			return (list.json.tasks as TaskView[]).find(task => task.id === id);
		}, task => !!task && !['queued', 'running'].includes(task.status), 15000);
		assert.ok(done, '任务存在');
		return done;
	}

	const events = (name: FakeSteamEvent['event']) => server.steamEvents().filter(event => event.event === name);

	before(async () => {
		appRoot = tempDir('purchase');
		mkdirSync(join(appRoot, 'data', 'config'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([{accountName: 'alpha', password: 'pw-good'}]));
		server = await startServer({appRoot, env: {APP_PASSWORD: password}});
		client = new Client(server.baseUrl);
		await client.login(password);
		await client.post('/api/login', {accountName: 'alpha'});
		await until(() => attemptOf(client, 'alpha'), a => a?.status === 'web_session');
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
	});

	test('在线账号列表带钱包信息', async () => {
		const res = await client.get('/api/purchase/online-accounts?game=cs2');
		assert.equal(res.status, 200);
		assert.deepEqual(res.json.accounts.map((a: Record<string, unknown>) => [a.account, a.currencyISO, a.balance, a.hasWallet]), [['alpha', 'USD', 10, true]]);
		const legacy = await client.get('/api/tf2/online-accounts');
		assert.equal(legacy.json.game, 'tf2');
		assert.equal(legacy.json.accounts.length, 1);
	});

	test('购物车无效返回 400,不建任务', async () => {
		const res = await client.post('/api/purchase/tasks', {game: 'cs2', cartData: {alpha: []}});
		assert.equal(res.status, 400);
		assert.equal(res.json.error, '购物车为空');
		assert.deepEqual((await client.get('/api/purchase/tasks')).json.tasks, []);
	});

	test('CS2 下单:Init(美元不带 currency)→ 授权同一笔 → Finalize,余额扣掉', async () => {
		const items = await client.post('/api/purchase/refresh-items?game=cs2', {});
		assert.equal(items.status, 200, items.text.slice(0, 200));
		cheap = (items.json.list as CatalogItem[])
			.filter(item => Number(item.prices.USD) > 0)
			.sort((left, right) => Number(left.prices.USD) - Number(right.prices.USD))[0] as CatalogItem;
		const price = Number(cheap.prices.USD);
		assert.ok(price > 0 && price * 2 <= 1000, `最便宜的商品 ${cheap.name} ${price}`);

		const task = await runTask('/api/purchase/tasks', {game: 'cs2', cartData: {alpha: [{itemDefId: cheap.def_index, quantity: 2, costInLocalCurrency: price}]}});
		assert.equal(task.status, 'completed', JSON.stringify(task.accounts));
		const [account] = task.accounts;
		assert.equal(account?.balanceBefore, 10);
		assert.equal(account?.balanceAfter, (1000 - price * 2) / 100);

		const [init] = events('purchaseInit');
		assert.equal(init?.appid, 730);
		assert.equal(init?.body?.currency, undefined, '美元账号不带 currency');
		assert.equal(init?.body?.language, 6);
		assert.deepEqual(init?.body?.line_items, [{item_def_id: cheap.def_index, quantity: 2, cost_in_local_currency: price * 2}]);
		const [authorize] = events('microTxnAuthorize');
		assert.equal(authorize?.approve, 1);
		const [finalize] = events('purchaseFinalize');
		assert.deepEqual([finalize?.appid, finalize?.txnId, finalize?.ok], [730, init?.txnId, true]);
		assert.ok(server.steamEvents().some(e => e.event === 'sendToGC' && e.msgType === 2504), 'CS2 的 Finalize 是 2504');

		const alpha = await until(() => attemptOf(client, 'alpha'), a => a?.balance === (1000 - price * 2) / 100);
		assert.equal(alpha?.balance, (1000 - price * 2) / 100);
	});

	test('TF2 钥匙:数量按余额裁剪,不带 purchase_type,Finalize 用 TF2 的 2512', async () => {
		const items = await client.get('/api/purchase/items?game=tf2');
		assert.deepEqual((items.json.list as CatalogItem[]).map(item => item.def_index), [5021]);
		const before = Number((await attemptOf(client, 'alpha'))?.balance);
		const affordable = Math.floor(Math.round(before * 100) / 249);
		assert.ok(affordable >= 1);

		const task = await runTask('/api/purchase/tasks', {game: 'tf2', cartData: {alpha: [{itemDefId: 5021, quantity: 100, costInLocalCurrency: 249}]}});
		assert.equal(task.status, 'completed', JSON.stringify(task.accounts));
		assert.deepEqual(task.accounts[0]?.items.map(item => [item.quantity, item.unitPriceCents]), [[affordable, 249]]);

		const init = events('purchaseInit').at(-1);
		assert.equal(init?.appid, 440);
		assert.deepEqual(init?.body?.line_items, [{item_def_id: 5021, quantity: affordable, cost_in_local_currency: affordable * 249}]);
		assert.equal(init?.body?.currency, undefined);
		assert.equal(events('purchaseFinalize').at(-1)?.ok, true);
		assert.ok(server.steamEvents().some(e => e.event === 'sendToGC' && e.msgType === 2512), 'TF2 的 Finalize 是 2512');
		assert.ok(server.steamEvents().some(e => e.event === 'gamesPlayed' && e.apps?.[0] === 440), '先切到 TF2');
	});

	test('部分完成:不在线的账号失败,不影响其它账号;余额不够时不下单', async () => {
		const balance = Number((await attemptOf(client, 'alpha'))?.balance);
		const inits = events('purchaseInit').length;
		const task = await runTask('/api/task/cs2-purchase', {cartData: {
			ghost: [{itemDefId: cheap.def_index, quantity: 1, costInLocalCurrency: 1}],
			alpha: [{itemDefId: cheap.def_index, quantity: 1, costInLocalCurrency: 1}]
		}});
		const byName = Object.fromEntries(task.accounts.map(account => [account.account, account]));
		assert.equal(byName.ghost?.error, '账号当前不在线，无法执行内购');
		if (Math.round(balance * 100) >= Number(cheap.prices.USD)) {
			assert.equal(task.status, 'partial');
			assert.equal(events('purchaseInit').length, inits + 1);
		} else {
			assert.equal(task.status, 'failed');
			assert.equal(byName.alpha?.error, '当前购物车在余额约束下没有可购买数量');
			assert.equal(events('purchaseInit').length, inits, '买不起就不发 Init');
		}
	});

	test('旧别名:GET /api/cs2/refresh-rates、/api/cs2/items 仍可用', async () => {
		const rates = await client.get('/api/cs2/refresh-rates');
		assert.equal(rates.status, 200);
		assert.equal(rates.json.rates.EUR, 0.9);
		const items = await client.get('/api/cs2/items');
		assert.equal(items.json.game, 'cs2');
		assert.ok(items.json.count > 0);
	});

	test('外部网络只有预期内的请求', () => {
		const blocked = events('blockedFetch').map(e => e.url);
		assert.deepEqual([...new Set(blocked)].filter(url => !String(url).startsWith('https://store.steampowered.com/')), []);
	});
});
