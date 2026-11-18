// ECO 扫货:网页设置 PartnerId / 私钥 / 监控列表 → 检查连接、查在售 → 选收货账号 → 自动扫货(真实下单)→ 对账 → 重启后恢复。
// ECOSteam 开放平台是假的(support/offline-preload.cjs 的 fakeEco):场景里给了公钥,每个请求都按官方示例的规则独立验签。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Client, removeDir, sleep, SocketListener, startServer, tempDir} from './support/server.ts';
import type {TestServer} from './support/server.ts';

const PARTNER_ID = 'e2e-partner-0001';
const ALPHA = '76561190100005555';
const ALPHA_TRADE_URL = `https://steamcommunity.com/tradeoffer/new/?partner=${BigInt(ALPHA) & 0xFFFFFFFFn}&token=eco5555`;

describe('ECO 扫货', () => {
	const password = randomBytes(9).toString('base64url');
	const keys = generateKeyPairSync('rsa', {modulusLength: 2048});
	const privateKey = keys.privateKey.export({type: 'pkcs8', format: 'der'}).toString('base64');
	const publicKey = keys.publicKey.export({type: 'spki', format: 'der'}).toString('base64');
	let appRoot: string;
	let scenarioFile: string;
	let server: TestServer;
	let client: Client;
	let socket: SocketListener;

	const ecoRequests = (path?: string) => server.steamEvents().filter(event => event.event === 'ecoRequest' && (!path || event.path === path));

	async function start(run: string): Promise<void> {
		server = await startServer({appRoot, run, env: {APP_PASSWORD: password, FAKE_ECO_FILE: scenarioFile}});
		client = new Client(server.baseUrl);
		await client.login(password);
		socket = await SocketListener.connect(client);
	}

	async function state(): Promise<any> {
		const res = await client.get('/api/eco/state');
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
		appRoot = tempDir('eco');
		scenarioFile = join(appRoot, 'fake-eco.json');
		writeFileSync(scenarioFile, JSON.stringify({
			partnerId: PARTNER_ID,
			publicKey,
			balance: 20,
			steamId: ALPHA,
			items: {
				'Kilowatt Case': {goodsName: '千瓦武器箱', listings: [0.6, 0.62, 0.9], qgMax: 0.55},
				'Recoil Case': {goodsName: '反冲武器箱', listings: [1.6], qgMax: 1.2}
			}
		}));
		// 导入令牌绑定用:alpha / delta 带 maFile(alpha 的 SteamID 是 17 位数字,导入时会被 JSON 舍入;delta 密码错),bravo 没有 maFile
		mkdirSync(join(appRoot, 'data', 'config', 'mafile'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([
			{accountName: 'alpha', password: 'pw-good', hasMaFile: true},
			{accountName: 'bravo', password: 'pw-good'},
			{accountName: 'delta', password: 'pw-wrong', hasMaFile: true}
		]));
		writeFileSync(join(appRoot, 'data', 'config', 'mafile', 'alpha.maFile'),
			`{"account_name":"alpha","shared_secret":"ZGVtby1zaGFyZWQtc2VjcmV0LTEyMw==","identity_secret":"aWQ=","Session":{"SteamID":${ALPHA}}}`);
		writeFileSync(join(appRoot, 'data', 'config', 'mafile', 'delta.maFile'),
			JSON.stringify({account_name: 'delta', shared_secret: 'c2VjcmV0', Session: {SteamID: '76561190100009999'}}));
		await start('1');
	});

	after(async () => {
		socket?.close();
		await server?.kill();
		removeDir(appRoot);
	});

	test('没填密钥:不能开;私钥格式不对拒收;填了只回公钥,库里是密文', async () => {
		assert.equal((await state()).configured, false);
		const run = await client.post('/api/eco/run', {state: 'sweeping'});
		assert.equal(run.status, 409, run.text);

		const badKey = await client.post('/api/eco/settings', {partnerId: PARTNER_ID, privateKey: 'not-a-key'});
		assert.equal(badKey.status, 400, badKey.text);
		assert.match(badKey.json.error, /私钥格式不对/);

		const saved = await client.post('/api/eco/settings', {partnerId: PARTNER_ID, privateKey, pollIntervalSec: 1});
		assert.equal(saved.status, 200, saved.text);
		assert.deepEqual([saved.json.state.configured, saved.json.state.partnerId, saved.json.state.publicKey, saved.json.state.keyError],
			[true, PARTNER_ID, publicKey, null]);
		assert.ok(!saved.text.includes(privateKey));

		const dbText = ['steam-tools.db', 'steam-tools.db-wal']
			.map(file => {
				try {
					return readFileSync(join(server.dataDir, file)).toString('latin1');
				} catch {
					return '';
				}
			}).join('');
		assert.ok(!dbText.includes(privateKey.slice(40, 120)), '私钥明文不落盘');
	});

	test('监控列表校验;按中文搜饰品带 ECO 价格、填中文名拒收;检查连接;查在售按价格排好', async () => {
		const bad = await client.post('/api/eco/watchlist', {items: [{name: 'Kilowatt Case', maxPrice: 0, maxQty: 1}]});
		assert.equal(bad.status, 400);
		assert.match(bad.json.error, /目标价至少 0.01/);
		const badGame = await client.post('/api/eco/watchlist', {items: [{name: 'Kilowatt Case', maxPrice: 1, maxQty: 1, gameId: 1}]});
		assert.equal(badGame.status, 400);

		const names = await client.get('/api/eco/names?q=' + encodeURIComponent('千瓦'));
		assert.equal(names.status, 200, names.text);
		assert.deepEqual(names.json.options[0], {name: 'Kilowatt Case', zh: '千瓦武器箱', lowest: 0.6, sellCount: 3}, '带 ECO 在售最低价');
		assert.deepEqual([names.json.priced, names.json.priceError], [true, null]);
		const chinese = await client.post('/api/eco/watchlist', {items: [{name: '千瓦武器箱', maxPrice: 0.65, maxQty: 5}]});
		assert.equal(chinese.status, 400);
		assert.match(chinese.json.error, /应填 Kilowatt Case/);

		const saved = await client.post('/api/eco/watchlist', {items: [
			{name: 'Kilowatt Case', maxPrice: 0.65, maxQty: 5},
			{name: 'Recoil Case', maxPrice: 1.5, maxQty: 1}
		]});
		assert.equal(saved.status, 200, saved.text);
		assert.deepEqual(saved.json.state.items.map((item: any) => [item.name, item.zh, item.maxPrice, item.maxQty, item.gameId]), [
			['Kilowatt Case', '千瓦武器箱', 0.65, 5, 730], ['Recoil Case', '反冲武器箱', 1.5, 1, 730]
		]);

		const check = await client.post('/api/eco/check');
		assert.equal(check.status, 200, check.text);
		assert.deepEqual(check.json.result, {
			balance: {money: 20, locked: 0, waitSettlement: 0},
			steamAccounts: [{steamId: ALPHA, nickname: '演示收货号', tradeUrl: ALPHA_TRADE_URL, tradeUrlOk: true, status: '正常', isDefault: true, remark: ''}]
		});

		const listings = await client.post('/api/eco/listings', {name: 'Kilowatt Case'});
		assert.equal(listings.status, 200, listings.text);
		assert.deepEqual(listings.json.listings, [{goodsNum: 'G00000001', price: 0.6}, {goodsNum: 'G00000002', price: 0.62}]);

		const requests = ecoRequests();
		assert.ok(requests.length >= 3);
		for (const request of requests) {
			assert.equal(request.body?.PartnerId, PARTNER_ID);
			assert.match(String(request.body?.Sign), /^[A-Za-z0-9+/]+=*$/);
		}
	});

	test('收货账号从 ECO 绑定的账号里选(带交易链接);开扫前要交易链接和总预算;按商品编号下单,对账拿到订单状态', async () => {
		const noUrl = await client.post('/api/eco/run', {state: 'sweeping'});
		assert.equal(noUrl.status, 400);
		assert.match(noUrl.json.error, /交易链接/);

		const receivers = await client.get('/api/eco/receivers');
		assert.equal(receivers.status, 200, receivers.text);
		assert.deepEqual(receivers.json.accounts.map((account: any) => [account.steamId, account.nickname, account.tradeUrl]),
			[[ALPHA, '演示收货号', ALPHA_TRADE_URL]]);

		const ready = await client.post('/api/eco/settings', {tradeUrl: ALPHA_TRADE_URL, maxTotalSpend: 10});
		assert.equal(ready.status, 200, ready.text);
		assert.deepEqual([ready.json.state.receiver.steamId, ready.json.state.receiver.eco?.nickname], [ALPHA, '演示收货号']);

		const run = await client.post('/api/eco/run', {state: 'sweeping'});
		assert.equal(run.status, 200, run.text);
		// 买完下一轮行情里最低价变成 0.9
		const bought = await waitState(value => value.purchases.length === 2 && value.purchases.every((p: any) => p.status === 'ok') && value.items[0].lowest === 0.9);
		assert.deepEqual(bought.purchases.map((p: any) => [p.name, p.goodsNum, p.cost]).reverse(), [
			['Kilowatt Case', 'G00000001', 0.6],
			['Kilowatt Case', 'G00000002', 0.62]
		]);
		assert.ok(bought.purchases.every((p: any) => /^DB\d{10}$/.test(p.orderNo)));
		assert.deepEqual(bought.items.map((item: any) => [item.name, item.status, item.bought]), [['Kilowatt Case', 'watch', 2], ['Recoil Case', 'watch', 0]]);

		const buys = ecoRequests('/Api/open/buy/BuyByGoodsNum');
		assert.deepEqual(buys.map(buy => [buy.body?.GoodsNum, buy.body?.Price, buy.body?.TradeLink, buy.body?.GameId]), [
			['G00000001', 0.6, ALPHA_TRADE_URL, '730'], ['G00000002', 0.62, ALPHA_TRADE_URL, '730']
		]);
		await socket.waitFor('eco:log', payload => payload.level === 'success' && payload.message.startsWith('买入 千瓦武器箱 0.60'));

		const refreshed = await client.post('/api/eco/orders/refresh');
		assert.equal(refreshed.status, 200, refreshed.text);
		assert.equal(refreshed.json.checked, 2);
		assert.deepEqual(refreshed.json.state.purchases.map((p: any) => [p.orderState, p.orderStateName]), [[1, '等待发货'], [1, '等待发货']]);
	});

	test('重启后运行状态、设置、流水都在,接着跑;快速购买由平台挑价', async () => {
		socket.close();
		await server.kill();
		await start('2');
		const resumed = await state();
		assert.deepEqual([resumed.run, resumed.settings.maxTotalSpend, resumed.purchases.length, resumed.budget.qty], ['sweeping', 10, 2, 2]);
		await waitState(value => value.cycle.n >= 1);
		assert.match(server.output(), /\[eco\] 恢复上次的运行状态:自动扫货\(真实下单\)/);

		// 假平台是新进程,在售回到初始状态:先停下再改,免得改到一半按旧设置多买
		await client.post('/api/eco/run', {state: 'stopped'});
		await client.post('/api/eco/settings', {strategy: 'quick'});
		const raised = await client.post('/api/eco/watchlist', {items: [
			{name: 'Kilowatt Case', maxPrice: 0.65, maxQty: 2},
			{name: 'Recoil Case', maxPrice: 1.7, maxQty: 1}
		]});
		assert.equal(raised.status, 200, raised.text);
		assert.equal((await client.post('/api/eco/run', {state: 'sweeping'})).status, 200);
		const quick = await waitState(value => value.items[1].bought === 1);
		assert.deepEqual([quick.purchases[0].name, quick.purchases[0].status, quick.purchases[0].cost, quick.items[1].status], ['Recoil Case', 'ok', 1.6, 'done']);
		const quickBuys = ecoRequests('/Api/open/buy/BuyByHashName');
		assert.deepEqual([quickBuys[0]?.body?.HashName, quickBuys[0]?.body?.Price, quickBuys[0]?.body?.MaxCount], ['Recoil Case', 1.7, 1]);

		const stopped = await client.post('/api/eco/run', {state: 'stopped'});
		assert.equal(stopped.json.state.run, 'stopped');
	});

	test('导入令牌绑定:列出能绑的账号;SteamID 精度丢了的要先登录;按原文发精确 SteamID;密码错、没 maFile 各自报错', async () => {
		const list = await client.get('/api/eco/bind/accounts?refresh=1');
		assert.equal(list.status, 200, list.text);
		assert.deepEqual(list.json.accounts.map((a: any) => [a.account, a.ready, a.reason]), [
			['alpha', true, null], ['bravo', false, '没有 maFile'], ['delta', true, null]
		]);

		const early = await client.post('/api/eco/bind/import', {accounts: ['alpha'], groupMode: 'none'});
		assert.equal(early.status, 200, early.text);
		assert.equal(early.json.results[0].status, 'failed');
		assert.match(early.json.results[0].message, /先在账户管理里登录一次/, 'alpha 还没登录,不知道精确的 SteamID');

		await client.post('/api/login', {accountName: 'alpha'});
		const deadline = Date.now() + 10000;
		while ((await client.get('/api/eco/bind/accounts')).json.accounts[0].steamId !== ALPHA && Date.now() < deadline) {
			await sleep(100);
		}
		const noGroup = await client.post('/api/eco/bind/import', {accounts: ['alpha'], groupMode: 'fixed', groupName: ''});
		assert.equal(noGroup.status, 400);

		const done = await client.post('/api/eco/bind/import', {accounts: ['alpha', 'bravo', 'delta', 'nobody'], groupMode: 'fixed', groupName: 'ECO组'});
		assert.equal(done.status, 200, done.text);
		assert.deepEqual(done.json.results.map((r: any) => [r.account, r.status]), [
			['alpha', 'ok'], ['bravo', 'failed'], ['delta', 'failed'], ['nobody', 'failed']
		]);
		assert.match(done.json.results[2].message, /\[1\] Steam账号或密码错误/);
		assert.equal(done.json.accounts.find((a: any) => a.account === 'alpha').bound?.steamId, ALPHA);

		const sent = ecoRequests('/Api/Merchant/ImportSteamGuardAccount');
		const alphaSent = sent.filter(request => request.body?.Account === 'alpha').at(-1)!;
		assert.ok(String(alphaSent.body?.GuardContent).includes(`"SteamID":${ALPHA}`), '令牌 JSON 里是精确的 17 位 SteamID');
		assert.deepEqual([alphaSent.body?.Password, alphaSent.body?.GroupName], ['pw-good', 'ECO组']);
		assert.ok(!sent.some(request => request.body?.Account === 'bravo'), '没 maFile 的不发请求');
	});

	test('验证交易链接;用工具里的 refreshToken 让 ECO 更新链接,当前收货账号的链接跟着换;不在账户管理里的不能更新', async () => {
		const verified = await client.post('/api/eco/receivers/verify', {});
		assert.equal(verified.status, 200, verified.text);
		const alpha = verified.json.accounts.find((account: any) => account.steamId === ALPHA);
		assert.deepEqual([alpha.linkCheck?.valid, alpha.linkCheck?.error, alpha.account, alpha.canUpdate], [true, null, 'alpha', true]);
		assert.equal(ecoRequests('/Api/Merchant/CheckTradeLink').at(-1)?.body?.TradeLink, ALPHA_TRADE_URL);
		assert.equal((await state()).settings.tradeUrl, ALPHA_TRADE_URL);

		const updated = await client.post('/api/eco/receivers/update-link', {steamId: ALPHA});
		assert.equal(updated.status, 200, updated.text);
		const newLink = `https://steamcommunity.com/tradeoffer/new/?partner=${BigInt(ALPHA) & 0xFFFFFFFFn}&token=new5555`;
		assert.deepEqual([updated.json.tradeUrl, updated.json.valid, updated.json.state.settings.tradeUrl], [newLink, true, newLink]);
		const sent = ecoRequests('/Api/Merchant/UserSteamHandle').at(-1)!;
		assert.deepEqual([sent.body?.SteamID, sent.body?.RefreshToken], [ALPHA, 'RT-GOOD-alpha'], '用的是 alpha 登录拿到的 refreshToken');
		assert.equal(updated.json.accounts.find((account: any) => account.steamId === ALPHA).linkCheck.valid, true);

		const stranger = await client.post('/api/eco/receivers/update-link', {steamId: '76561198012345678'});
		assert.equal(stranger.status, 409);
		assert.match(stranger.json.error, /账户管理里没有这个账号/);
		const badId = await client.post('/api/eco/receivers/update-link', {steamId: '123'});
		assert.equal(badId.status, 400);
	});

	test('换一对新密钥后,平台上还是旧公钥:检查连接回 502,带验签失败的错误码', async () => {
		const generated = await client.post('/api/eco/keypair');
		assert.equal(generated.status, 200, generated.text);
		assert.notEqual(generated.json.state.publicKey, publicKey);
		assert.match(generated.json.state.publicKey, /^MIIBIjAN/, '2048 位 RSA 公钥(SPKI)');
		const check = await client.post('/api/eco/check');
		assert.equal(check.status, 502);
		assert.match(check.json.error, /5004/);
	});
});
