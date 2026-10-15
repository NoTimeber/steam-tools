// C5 扫货:网页设置 app-key / 监控列表 → 检查连接、查在售 → 自动扫货(真实下单,批量)→ 对账 → 重启后恢复。
// C5GAME 开放平台是假的(support/offline-preload.cjs 的 fakeC5):在售 id 是 19 位整数,下单按 id 扣在售和余额。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Client, removeDir, sleep, SocketListener, startServer, tempDir} from './support/server.ts';
import type {TestServer} from './support/server.ts';

const APP_KEY = 'e2e-c5-app-key-123456';
const TRADE_URL = 'https://steamcommunity.com/tradeoffer/new/?partner=123456&token=abcdefgh';

describe('C5 扫货', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let scenarioFile: string;
	let server: TestServer;
	let client: Client;
	let socket: SocketListener;

	const c5Requests = (path?: string) => server.steamEvents().filter(event => event.event === 'c5Request' && (!path || event.path === path));

	async function start(run: string): Promise<void> {
		server = await startServer({appRoot, run, env: {APP_PASSWORD: password, FAKE_C5_FILE: scenarioFile}});
		client = new Client(server.baseUrl);
		await client.login(password);
		socket = await SocketListener.connect(client);
	}

	async function state(): Promise<any> {
		const res = await client.get('/api/c5/state');
		assert.equal(res.status, 200, res.text);
		return res.json.state;
	}

	async function waitState(ok: (value: any) => boolean, timeoutMs = 15000): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = await state();
			if (ok(value)) {
				return value;
			}
			if (Date.now() > deadline) {
				assert.fail('等待超时,最后状态: ' + JSON.stringify({run: value.run, cycle: value.cycle, items: value.items, purchases: value.purchases}));
			}
			await sleep(150);
		}
	}

	before(async () => {
		appRoot = tempDir('c5');
		scenarioFile = join(appRoot, 'fake-c5.json');
		writeFileSync(scenarioFile, JSON.stringify({
			balance: 20,
			items: {
				'Kilowatt Case': {listings: [0.6, 0.62, 0.9], purchaseMax: 0.55},
				'Recoil Case': {listings: [1.6], purchaseMax: 1.2}
			}
		}));
		// 收货账号用:alpha 登录后能取交易链接(假 C5 上绑定的也是 alpha 的 SteamID)
		mkdirSync(join(appRoot, 'data', 'config'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([{accountName: 'alpha', password: 'pw-good'}]));
		await start('1');
	});

	after(async () => {
		socket?.close();
		await server?.kill();
		removeDir(appRoot);
	});

	test('没填 app-key:不能开;填了只回后 4 位,库里是密文', async () => {
		assert.equal((await state()).configured, false);
		const run = await client.post('/api/c5/run', {state: 'sweeping'});
		assert.equal(run.status, 409, run.text);

		const saved = await client.post('/api/c5/settings', {appKey: APP_KEY, pollIntervalSec: 1});
		assert.equal(saved.status, 200, saved.text);
		assert.deepEqual([saved.json.state.configured, saved.json.state.appKeyMasked], [true, '****3456']);
		assert.ok(!saved.text.includes(APP_KEY));

		const dbText = ['steam-tools.db', 'steam-tools.db-wal']
			.map(file => {
				try {
					return readFileSync(join(server.dataDir, file)).toString('latin1');
				} catch {
					return '';
				}
			}).join('');
		assert.ok(!dbText.includes(APP_KEY), 'app-key 明文不落盘');
	});

	test('监控列表校验;按中文搜饰品、填中文名拒收;检查连接;查在售时 64 位 id 不丢精度', async () => {
		const bad = await client.post('/api/c5/watchlist', {items: [{name: 'Kilowatt Case', maxPrice: 0, maxQty: 1}]});
		assert.equal(bad.status, 400);
		assert.match(bad.json.error, /目标价必须大于 0/);

		const names = await client.get('/api/c5/names?q=' + encodeURIComponent('千瓦'));
		assert.equal(names.status, 200, names.text);
		assert.deepEqual(names.json.options[0], {name: 'Kilowatt Case', zh: '千瓦武器箱', lowest: 0.6, sellCount: 3}, '带 C5 在售最低价');
		assert.deepEqual([names.json.priced, names.json.priceError], [true, null]);
		const chinese = await client.post('/api/c5/watchlist', {items: [{name: '千瓦武器箱', maxPrice: 0.65, maxQty: 5}]});
		assert.equal(chinese.status, 400);
		assert.match(chinese.json.error, /应填 Kilowatt Case/);

		const saved = await client.post('/api/c5/watchlist', {items: [
			{name: 'Kilowatt Case', maxPrice: 0.65, maxQty: 5},
			{name: 'Recoil Case', maxPrice: 1.5, maxQty: 1}
		]});
		assert.equal(saved.status, 200, saved.text);
		assert.deepEqual(saved.json.state.items.map((item: any) => [item.name, item.zh, item.maxPrice, item.maxQty, item.delivery]), [
			['Kilowatt Case', '千瓦武器箱', 0.65, 5, 0], ['Recoil Case', '反冲武器箱', 1.5, 1, 0]
		]);

		const check = await client.post('/api/c5/check');
		assert.equal(check.status, 200, check.text);
		assert.deepEqual(check.json.result, {
			balance: {money: 20, settle: 0, deposit: 0},
			steamAccounts: [{steamId: '76561190100005555', nickname: '演示收货号', status: '正常'}]
		});

		const listings = await client.post('/api/c5/listings', {name: 'Kilowatt Case'});
		assert.equal(listings.status, 200, listings.text);
		assert.deepEqual(listings.json.listings, [
			{productId: '1444544795338000001', price: 0.6, amount: 1},
			{productId: '1444544795338000002', price: 0.62, amount: 1}
		]);

		const requests = c5Requests();
		assert.ok(requests.length >= 3);
		for (const request of requests) {
			assert.equal(request.query?.['app-key'], APP_KEY);
			assert.equal(request.acceptEncoding, 'gzip, br, zstd, deflate');
		}
	});

	test('开扫前要交易链接和总预算;自动扫货按在售 id 下单,对账拿到平台订单状态', async () => {
		const noUrl = await client.post('/api/c5/run', {state: 'sweeping'});
		assert.equal(noUrl.status, 400);
		assert.match(noUrl.json.error, /交易链接/);
		const ready = await client.post('/api/c5/settings', {tradeUrl: TRADE_URL, maxTotalSpend: 10});
		assert.equal(ready.status, 200, ready.text);

		const run = await client.post('/api/c5/run', {state: 'sweeping'});
		assert.equal(run.status, 200, run.text);
		// 买完下一轮行情里最低价变成 0.9
		const bought = await waitState(value => value.purchases.length === 2 && value.purchases.every((p: any) => p.status === 'ok') && value.items[0].lowest === 0.9);
		assert.deepEqual(bought.purchases.map((p: any) => [p.mode, p.name, p.productId, p.cost]).reverse(), [
			['live', 'Kilowatt Case', '1444544795338000001', 0.6],
			['live', 'Kilowatt Case', '1444544795338000002', 0.62]
		]);
		assert.ok(bought.purchases.every((p: any) => /^9000000000000000\d{3}$/.test(p.orderId)), '订单号也是 64 位整数');
		assert.deepEqual(bought.items.map((item: any) => [item.name, item.status, item.bought]), [['Kilowatt Case', 'watch', 2], ['Recoil Case', 'watch', 0]]);

		const buys = c5Requests('/merchant/trade/v1/batch/buy');
		assert.equal(buys.length, 1);
		assert.equal(buys[0]!.body?.tradeUrl, TRADE_URL);
		assert.deepEqual((buys[0]!.body?.productList as any[]).map(p => [p.productId, p.buyPrice]), [
			['1444544795338000001', 0.6], ['1444544795338000002', 0.62]
		]);
		await socket.waitFor('c5:log', payload => payload.level === 'success' && payload.message.startsWith('买入 千瓦武器箱 0.60'));

		const refreshed = await client.post('/api/c5/orders/refresh');
		assert.equal(refreshed.status, 200, refreshed.text);
		assert.equal(refreshed.json.checked, 2);
		assert.deepEqual(refreshed.json.state.purchases.map((p: any) => [p.orderStatus, p.orderStatusName]), [[1, '待发货'], [1, '待发货']]);
	});

	test('重启后运行状态、设置、流水都在,接着跑', async () => {
		socket.close();
		await server.kill();
		await start('2');
		const resumed = await state();
		assert.deepEqual([resumed.run, resumed.settings.maxTotalSpend, resumed.purchases.length, resumed.budget.qty], ['sweeping', 10, 2, 2]);
		await waitState(value => value.cycle.n >= 1 && value.items[0].lowest === 0.6);
		assert.match(server.output(), /\[c5\] 恢复上次的运行状态:自动扫货\(真实下单\)/);

		const stopped = await client.post('/api/c5/run', {state: 'stopped'});
		assert.equal(stopped.json.state.run, 'stopped');
	});

	test('收货账号:账户管理里的账号都列出来,登录过的用网页会话取交易链接;状态里认得出账号和 C5 绑定', async () => {
		assert.equal((await state()).receiver.account, null, '原来的链接不是本工具的账号');
		const listed = await client.get('/api/c5/receivers');
		assert.deepEqual(listed.json.accounts.map((account: any) => [account.account, account.online, account.selectable]), [['alpha', false, false]], '没登录过也列出来,但不能选');
		const neverLoggedIn = await client.post('/api/c5/trade-url', {account: 'alpha'});
		assert.equal(neverLoggedIn.status, 409, neverLoggedIn.text);

		await client.post('/api/login', {accountName: 'alpha'});
		const deadline = Date.now() + 10000;
		let receivers = await client.get('/api/c5/receivers');
		while (!receivers.json.accounts?.[0]?.online && Date.now() < deadline) {
			await sleep(100);
			receivers = await client.get('/api/c5/receivers');
		}
		assert.deepEqual(receivers.json.accounts.map((account: any) => [account.account, account.steamId, account.online, account.selectable, account.c5Bound]), [
			['alpha', '76561190100005555', true, true, true]
		]);

		const fetched = await client.post('/api/c5/trade-url', {account: 'alpha'});
		assert.equal(fetched.status, 200, fetched.text);
		assert.equal(fetched.json.tradeUrl, `https://steamcommunity.com/tradeoffer/new/?partner=${76561190100005555n & 0xFFFFFFFFn}&token=demo5555`);
		const blockedCommunity = server.steamEvents().filter(event => event.event === 'blockedFetch' && String(event.url).includes('steamcommunity.com'));
		assert.deepEqual(blockedCommunity, [], '取链接走的是社区的交易报价隐私设置页');

		const saved = await client.post('/api/c5/settings', {tradeUrl: fetched.json.tradeUrl});
		assert.equal(saved.status, 200, saved.text);
		assert.deepEqual(saved.json.state.receiver, {
			steamId: '76561190100005555', account: 'alpha', personaName: saved.json.state.receiver.personaName,
			c5: {steamId: '76561190100005555', nickname: '演示收货号', status: '正常'}, c5Checked: true
		});
	});

	test('app-key 不对:检查连接回 502,带平台的错误码', async () => {
		await client.post('/api/c5/settings', {appKey: 'bad-key-000000'});
		const check = await client.post('/api/c5/check');
		assert.equal(check.status, 502);
		assert.match(check.json.error, /400001/);
	});
});
