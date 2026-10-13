// UU 发货:短信登录拿 token → 按 SteamID 自动绑定 → 开自动发货 → UU 确认报价 → Steam 上严格校验后接受 + 手机确认。
// 悠悠接口和 Steam 报价都是假的(support/offline-preload.cjs),场景写在 FAKE_UU_FILE 里,测试随时改。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client, removeDir, sleep, startServer, tempDir} from './support/server.ts';
import type {FakeSteamEvent, TestServer} from './support/server.ts';

// 假 steam-user 给 alpha 的 SteamID(见 offline-preload.cjs:'76561190' + (100000000 + 账号名长度 × 1111))
const ALPHA_STEAM_ID = '76561190100005555';
const BUYER = '76561198000000001';
const IDENTITY_SECRET = 'E2E-IDENTITY-SECRET';
const TOKEN = 'h.' + Buffer.from(JSON.stringify({Id: 9001, Name: 'uu-alpha', exp: 4102444800})).toString('base64url') + '.s';

interface DeliveryView {
	auto: boolean;
	status: string;
	stats: {scans: number; delivered: number; failed: number; skipped: number};
}

interface UuAccountView {
	accountName: string;
	bound: boolean;
	online: boolean;
	hasIdentitySecret: boolean;
	steamID: string;
	delivery: Record<string, DeliveryView>;
	recentOrders: Array<{orderNo: string; ok: boolean; reason: string; tradeOfferId: string}>;
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

describe('UU 发货', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let uuFile: string;
	let server: TestServer;
	let client: Client;

	const scenario = (value: Record<string, unknown>) => writeFileSync(uuFile, JSON.stringify({tokens: {[TOKEN]: {steamId: ALPHA_STEAM_ID}}, smsToken: TOKEN, ...value}));
	const events = (name: FakeSteamEvent['event']) => server.steamEvents().filter(event => event.event === name);
	const uuState = async () => (await client.get('/api/uu/state')).json as {pollIntervalMs: number; accounts: UuAccountView[]};
	const alpha = async () => (await uuState()).accounts.find(account => account.accountName === 'alpha');

	async function boot(run: number): Promise<void> {
		server = await startServer({appRoot, run, env: {APP_PASSWORD: password, FAKE_UU_FILE: uuFile}});
		client = new Client(server.baseUrl);
		await client.login(password);
	}

	before(async () => {
		appRoot = tempDir('uu');
		uuFile = join(appRoot, 'fake-uu.json');
		mkdirSync(join(appRoot, 'data', 'config', 'mafile'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([{accountName: 'alpha', password: 'pw-good'}]));
		writeFileSync(join(appRoot, 'data', 'config', 'mafile', 'alpha.maFile'), JSON.stringify({account_name: 'alpha', identity_secret: IDENTITY_SECRET}));
		scenario({});
		await boot(1);
		await client.post('/api/login', {accountName: 'alpha'});
		const attempts = await until(() => client.get('/api/attempts'), res => res.json.attempts.some((a: {status: string}) => a.status === 'web_session'));
		assert.equal(attempts.json.attempts[0].steamID, ALPHA_STEAM_ID);
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
	});

	test('短信登录拿 token,按 UU 绑定的 SteamID 自动绑到已登录账号;返回里没有 token 原文', async () => {
		const start = await client.post('/api/uu/login/start', {phone: '13800000000'});
		assert.equal(start.status, 200, start.text);
		assert.equal(start.json.mode, 'sms');
		const verify = await client.post('/api/uu/login/verify', {loginSessionId: start.json.loginSessionId, code: '1234'});
		assert.equal(verify.status, 200, verify.text);
		assert.deepEqual([verify.json.bound, verify.json.autoBoundAccount, verify.json.tokenId, verify.json.linkedSteamId], [true, 'alpha', '9001', ALPHA_STEAM_ID]);
		assert.ok(!verify.text.includes(TOKEN));
		assert.ok(events('uuRequest').some(e => e.path === '/api/youpin/bff/steam/cookie/pull' && e.host === 'api.youpin898.com'));
	});

	test('token 列表和发货状态只给掩码;账号在线、有 identity_secret', async () => {
		const tokens = await client.get('/api/uu/tokens');
		assert.deepEqual(tokens.json.tokens.map((t: {id: string; nickname: string}) => [t.id, t.nickname]), [['9001', 'uu-alpha']]);
		assert.ok(!tokens.text.includes(TOKEN));
		const state = await client.get('/api/uu/state');
		assert.ok(!state.text.includes(TOKEN));
		const account = await alpha();
		assert.deepEqual([account?.bound, account?.online, account?.hasIdentitySecret, account?.steamID], [true, true, true, ALPHA_STEAM_ID]);
	});

	test('开 CS2 自动发货:立即扫一轮,UU 确认报价 → 校验报价 → 接受 + 用 identity_secret 手机确认', async () => {
		scenario({
			orders: {730: [{orderNo: 'CS-1', subStatus: 1103, subStatusName: '待您确认报价', itemName: 'AK-47 | 红线'}]},
			details: {'CS-1': {tradeOfferId: '5551', buyer: {steamId: BUYER}, commodity: {assetId: '42'}}},
			offers: {5551: {partner: BUYER, give: [{appid: 730, assetid: '42', market_hash_name: 'AK-47 | Redline'}]}}
		});
		const res = await client.post('/api/uu/auto', {accountName: 'alpha', gameId: '730', enabled: true});
		assert.equal(res.status, 200, res.text);
		const account = await until(alpha, a => a?.delivery['730']?.stats.delivered === 1);
		assert.equal(account?.delivery['730']?.stats.delivered, 1, JSON.stringify(account?.recentOrders));
		assert.equal(account?.recentOrders[0]?.ok, true);

		const confirm = events('uuRequest').find(e => e.path === '/api/youpin/bff/trade/v1/order/sell/delivery/confirmOffer');
		assert.deepEqual(confirm?.body?.confirmOrder, {orderNo: 'CS-1', tradeOfferId: 5551});
		assert.equal(confirm?.host, 'api.youpin898.com');
		assert.deepEqual(events('offerAccept').map(e => e.offerId), ['5551']);
		assert.deepEqual(events('offerConfirm').map(e => [e.offerId, e.identitySecret]), [['5551', IDENTITY_SECRET]]);
	});

	test('报价的对方不是订单买家:fail-closed,绝不接受', async () => {
		scenario({
			orders: {730: [{orderNo: 'CS-2', subStatus: 1103, subStatusName: '待您确认报价', itemName: 'M4A4 | 龙王'}]},
			details: {'CS-2': {tradeOfferId: '5552', buyer: {steamId: BUYER}, commodity: {assetId: '43'}}},
			offers: {5552: {partner: '76561198000000666', give: [{appid: 730, assetid: '43'}]}}
		});
		const res = await client.post('/api/uu/scan', {accountName: 'alpha', gameId: '730'});
		assert.equal(res.status, 200, res.text);
		const account = res.json.account as UuAccountView;
		assert.equal(account.delivery['730']?.stats.failed, 1);
		assert.match(account.recentOrders[0]?.reason ?? '', /^partner-mismatch/);
		assert.deepEqual(events('offerAccept').map(e => e.offerId), ['5551'], '5552 没有被接受');
	});

	test('TF2 走 g3 网关;待发货列表两款游戏合并', async () => {
		const scan = await client.post('/api/uu/scan', {accountName: 'alpha', gameId: '440'});
		assert.equal(scan.status, 200);
		const tf2 = events('uuRequest').filter(e => e.path?.endsWith('/waitDeliverList') && e.gameid === '440');
		assert.ok(tf2.length >= 1 && tf2.every(e => e.host === 'g3-api.youpin898.com'));

		const orders = await client.get('/api/uu/orders/alpha');
		assert.equal(orders.status, 200);
		assert.deepEqual(orders.json.orders.map((o: {gameLabel: string; orderNo: string; tradeOfferId: string}) => [o.gameLabel, o.orderNo, o.tradeOfferId]), [['CS2', 'CS-2', '5552']]);
		assert.equal((await client.get('/api/uu/orders/nobody')).status, 409);
	});

	test('轮询间隔和自动发货开关存在加密库里,重启后还在', async () => {
		const res = await client.post('/api/uu/poll-interval', {minutes: 2});
		assert.equal(res.json.pollIntervalMs, 120000);
		assert.equal((await client.post('/api/uu/poll-interval', {minutes: 0})).status, 400);
		await server.kill();
		await boot(2);
		const state = await uuState();
		assert.equal(state.pollIntervalMs, 120000);
		const account = state.accounts.find(a => a.accountName === 'alpha');
		assert.deepEqual([account?.bound, account?.delivery['730']?.auto, account?.delivery['440']?.auto], [true, true, false]);
	});

	test('删除 token:解绑、停发货、从 token 列表移除', async () => {
		const res = await client.delete('/api/uu/token', {accountName: 'alpha'});
		assert.equal(res.status, 200, res.text);
		assert.equal(res.json.account.bound, false);
		assert.deepEqual((await client.get('/api/uu/tokens')).json.tokens, []);
		assert.deepEqual((await uuState()).accounts, []);
	});

	test('外部网络只有预期内的请求', () => {
		const blocked = events('blockedFetch').map(e => e.url);
		assert.deepEqual([...new Set(blocked)].filter(url => !String(url).startsWith('https://store.steampowered.com/')), []);
	});
});
