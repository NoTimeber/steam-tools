// 买游戏:解析 subid → 试运行 → 真扣款 → 重复购买被拒 → 余额不足,走真实的 app/server.js 和 HTTP 接口。
// Steam 商店结算是假的(support/offline-preload.cjs 的 fakeStore):每个账号钱包 10.00 美元,10 号包 4.99 美元,30 号包 50.00 美元。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client, removeDir, sleep, SocketListener, startServer, tempDir} from './support/server.ts';
import type {FakeSteamEvent, TestServer} from './support/server.ts';

interface TaskAccount {
	account: string;
	status: string;
	spentCents: number | null;
	transId: string;
	error: string;
	packageIds: number[];
	currencyISO: string;
}

interface Task {
	id: string;
	status: string;
	dryRun: boolean;
	successCount: number;
	failCount: number;
	accounts: TaskAccount[];
}

describe('买游戏', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let server: TestServer;
	let client: Client;
	let alphaId: string;
	let socket: SocketListener;

	const events = (name: FakeSteamEvent['event']) => server.steamEvents().filter(event => event.event === name);
	const storeCalls = (path: string) => events('storeRequest').filter(event => event.path === path);

	/** 建任务并等它跑完 */
	async function runTask(body: Record<string, unknown>): Promise<Task> {
		const res = await client.post('/api/buygame/tasks', body);
		assert.equal(res.status, 200, res.text);
		const id = res.json.task.id as string;
		for (let i = 0; i < 100; i++) {
			const tasks = (await client.get('/api/buygame/tasks')).json.tasks as Task[];
			const task = tasks.find(t => t.id === id);
			if (task?.status === 'completed') {
				return task;
			}
			await sleep(100);
		}
		throw new Error('任务没跑完');
	}

	before(async () => {
		appRoot = tempDir('buygame');
		mkdirSync(join(appRoot, 'data', 'config'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([{accountName: 'alpha', password: 'pw-good'}, {accountName: 'charlie', password: 'pw-good'}]));
		server = await startServer({appRoot, env: {APP_PASSWORD: password, FAKE_STORE_PACKAGES: JSON.stringify({30: {name: 'Pricey Game', final: 5000, appid: 3030}})}});
		client = new Client(server.baseUrl);
		await client.login(password);
		socket = await SocketListener.connect(client);
		await client.post('/api/login', {accountName: 'alpha'});
		await client.post('/api/login', {accountName: 'charlie'});
		let accounts: Array<{account: string; attemptId: string}> = [];
		for (let i = 0; i < 100 && accounts.length < 2; i++) {
			accounts = (await client.get('/api/buygame/online-accounts')).json.accounts;
			await sleep(100);
		}
		alphaId = accounts.find(a => a.account === 'alpha')?.attemptId ?? '';
	});

	after(async () => {
		await server?.kill();
		socket?.close();
		removeDir(appRoot);
	});

	test('可购买账号:登录成功、有 cookie 的两个账号', async () => {
		const res = await client.get('/api/buygame/online-accounts');
		assert.deepEqual(res.json.accounts.map((a: {account: string; currencyISO: string; balance: number}) => [a.account, a.currencyISO, a.balance]), [['alpha', 'USD', 10], ['charlie', 'USD', 10]]);
	});

	test('解析 subid:按账号国家取区域价;不存在报 502,id 无效报 400', async () => {
		const res = await client.get(`/api/buygame/resolve?packageId=10&accountId=${alphaId}`);
		assert.equal(res.status, 200, res.text);
		assert.deepEqual(res.json.package, {packageId: 10, name: 'Fake Game', appid: 1010, priceCents: 499, currencyISO: 'USD', discountPercent: 0, available: true});
		const query = storeCalls('store.steampowered.com/api/packagedetails').at(-1)?.query;
		assert.deepEqual([query?.packageids, query?.l], ['10', 'schinese']);

		assert.equal((await client.get('/api/buygame/resolve?subid=999')).status, 502);
		assert.equal((await client.get('/api/buygame/resolve?packageId=abc')).status, 400);
	});

	test('试运行:验证到最终价就停,不扣款', async () => {
		const task = await runTask({items: [{accountId: alphaId, packageIds: [10]}], dryRun: true});
		assert.deepEqual(task.accounts.map(a => [a.account, a.status, a.spentCents, a.error]), [['alpha', 'verified', 499, '']]);
		assert.equal(task.successCount, 0);
		assert.equal(storeCalls('checkout.steampowered.com/checkout/finalizetransaction/').length, 0);
		const init = storeCalls('checkout.steampowered.com/checkout/inittransaction/')[0];
		assert.equal(init?.form?.PaymentMethod, 'steamaccount');
		assert.ok(init?.form?.sessionid, '表单带 sessionid,且与 cookie 一致(假商店不一致会回 success=2)');
		const add = storeCalls('api.steampowered.com/IShoppingCartService/AddPackages/v1/')[0];
		assert.deepEqual(add?.input?.cart_items, [{packageid: 10, quantity: 1, is_gift: false, costwhenadded: {amount: 499, currencycode: 1}}]);
	});

	test('真扣款:两个账号各买一份,交易成功;再买一次报已拥有', async () => {
		const task = await runTask({items: [{account: 'alpha', packageIds: [10]}, {account: 'charlie', packageIds: [10, '10']}], concurrency: 2});
		assert.deepEqual(task.accounts.map(a => [a.account, a.status, a.spentCents, a.packageIds]), [['alpha', 'success', 499, [10]], ['charlie', 'success', 499, [10]]]);
		assert.ok(task.accounts.every(a => a.transId));
		assert.equal(task.successCount, 2);
		assert.equal(storeCalls('checkout.steampowered.com/checkout/finalizetransaction/').length, 2);

		const again = await runTask({items: [{account: 'alpha', packageIds: [10]}]});
		assert.equal(again.accounts[0]?.status, 'failed');
		assert.match(again.accounts[0]?.error ?? '', /已拥有该商品/);
	});

	test('余额不足:预检就拦下,不发起交易', async () => {
		const inits = storeCalls('checkout.steampowered.com/checkout/inittransaction/').length;
		const task = await runTask({items: [{account: 'charlie', packageIds: [30]}]});
		assert.equal(task.accounts[0]?.status, 'failed');
		assert.equal(task.accounts[0]?.error, '余额不足:本单需 $50.00,钱包余额 $5.01', '买过一份 4.99 后剩 5.01');
		assert.equal(storeCalls('checkout.steampowered.com/checkout/inittransaction/').length, inits);
	});

	test('进度推送:建任务、每个账号状态变化、完成都经 socket.io 推给前端', async () => {
		const task = await runTask({items: [{account: 'charlie', packageIds: [20]}], dryRun: true});
		const created = await socket.waitFor('buygame:task-created', t => t.id === task.id);
		assert.equal(created.status, 'queued');
		const completed = await socket.waitFor('buygame:task-completed', t => t.id === task.id);
		assert.deepEqual(completed.accounts.map((a: TaskAccount) => [a.account, a.status]), [['charlie', 'verified']]);
		const updates = socket.named('buygame:task-updated').filter(t => t.id === task.id);
		assert.ok(updates.some(t => t.accounts[0].status === 'running'));
	});

	test('没有有效购买项报 400', async () => {
		const res = await client.post('/api/buygame/tasks', {items: [{account: 'ghost', packageIds: [10]}]});
		assert.equal(res.status, 400);
		assert.equal(res.json.error, '没有有效的购买项(账号未在线或 subid 无效)');
	});

	test('外部网络:商店结算全走假接口,没有漏出去的请求', () => {
		// 登录成功后会去 Steam 商店账户页查国家(被拦截,不影响);除此之外不应有任何外部请求
		const blocked = events('blockedFetch').map(e => e.url);
		assert.deepEqual([...new Set(blocked)].filter(url => url !== 'https://store.steampowered.com/account/'), []);
	});
});
