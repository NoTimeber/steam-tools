// Steam 代理池:新建代理的校验(密码不下发、留空保留)、检测(经本地假代理拿出口 IP、Steam 社区首页和市场页)、
// 池里有代理时 Steam 请求真的走代理(带认证)、停用后恢复直连、轮换代理按账号固定编号、账号绑定(不走代理、绑定的全停用就不登录)、
// 导入、代理组、用量。
// 假代理在测试进程里:普通请求(HTTP 目标)由它当源站回出口 IP;CONNECT(HTTPS 目标)记下来就拒绝,
// 所以走代理的 Steam 请求会失败,但能看到它确实连到了代理、带了账号密码。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client, removeDir, sleep, startServer, tempDir} from './support/server.ts';
import type {TestServer} from './support/server.ts';

describe('Steam 代理池', () => {
	const password = randomBytes(9).toString('base64url');
	const basic = (user: string) => 'Basic ' + Buffer.from(`${user}:e2e:pass`).toString('base64');
	const plain: Array<{url: string; auth: string}> = [];
	const connects: Array<{target: string; auth: string}> = [];
	let proxyServer: http.Server;
	let port: number;
	let appRoot: string;
	let server: TestServer;
	let client: Client;
	let proxyId = '';

	async function readHistory(force: boolean) {
		const res = await client.post('/api/accounts/history', {accountName: 'hotel', force});
		assert.equal(res.status, 200, res.text);
		let history = res.json.history;
		const deadline = Date.now() + 20000;
		while (history.status === 'loading' && Date.now() < deadline) {
			await sleep(100);
			history = (await client.get('/api/accounts/history?accountName=hotel')).json.history;
		}
		return history;
	}

	async function waitAttempt(predicate: (attempt: {status: string; logs: Array<{message: string}>}) => boolean) {
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			const attempts = (await client.get('/api/attempts')).json.attempts as Array<{accountName: string; status: string; logs: Array<{message: string}>}>;
			const hotel = attempts.find(a => a.accountName === 'hotel');
			if (hotel && predicate(hotel)) {
				return hotel;
			}
			await sleep(50);
		}
		assert.fail('等不到 hotel 的会话状态');
	}

	const login = async (force = false) => {
		const res = await client.post('/api/login', {accountName: 'hotel', force});
		assert.equal(res.status, 200, res.text);
	};

	async function proxies() {
		return (await client.get('/api/proxies')).json.proxies;
	}

	/** 等 hotel 登录时分到编号 */
	async function assignedIndex(): Promise<number> {
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			const index = (await proxies()).assigned.hotel?.index;
			if (index) {
				return index;
			}
			await sleep(50);
		}
		assert.fail('hotel 没分到编号');
	}

	before(async () => {
		proxyServer = http.createServer((req, res) => {
			plain.push({url: String(req.url), auth: String(req.headers['proxy-authorization'] ?? '')});
			// 「Steam 社区市场」回 429,模拟工具台的市场请求被拒;社区首页正常
			if (String(req.url).startsWith('http://steam.example.test/market/')) {
				res.writeHead(429);
				res.end('Too Many Requests');
				return;
			}
			if (String(req.url).startsWith('http://steam.example.test/')) {
				res.writeHead(200, {'content-type': 'text/html'});
				res.end('<html></html>');
				return;
			}
			res.writeHead(200, {'content-type': 'application/json'});
			res.end(JSON.stringify({ip: '203.0.113.9', country: 'us'}));
		});
		proxyServer.on('connect', (req, socket) => {
			socket.on('error', () => {});   // 对方在我们回 403 时就断开,不算错
			connects.push({target: String(req.url), auth: String(req.headers['proxy-authorization'] ?? '')});
			socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
		});
		await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
		port = (proxyServer.address() as AddressInfo).port;

		appRoot = tempDir('proxy');
		mkdirSync(join(appRoot, 'data', 'config'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([{accountName: 'hotel', password: 'pw-good'}]));
		server = await startServer({appRoot, env: {
			APP_PASSWORD: password,
			PROXY_TEST_URL: 'http://ip.example.test/',
			PROXY_STEAM_HOME_URL: 'http://steam.example.test/',
			PROXY_STEAM_TEST_URL: 'http://steam.example.test/market/'
		}});
		client = new Client(server.baseUrl);
		await client.login(password);
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
		proxyServer?.closeAllConnections();
		await new Promise<void>(resolve => proxyServer?.close(() => resolve()));
	});

	test('新建代理:没有时为空;不对的 400;保存后下发各项(不带密码);密码留空保留', async () => {
		assert.deepEqual(await proxies(), {proxies: [], groups: [], accounts: {}, accountGroups: {}, assigned: {}});
		const fields = {protocol: 'http', host: '127.0.0.1', port, type: 'static', username: 'e2e-user', password: 'e2e:pass', loginsPerMinute: ''};
		const bad = await client.post('/api/proxies/create', {...fields, protocol: 'socks5'});
		assert.equal(bad.status, 400);
		assert.match(bad.json.error, /SOCKS5/);
		assert.equal((await client.post('/api/proxies/create', {...fields, port: ''})).status, 400, '端口必填');
		const created = await client.post('/api/proxies/create', fields);
		assert.equal(created.status, 200, created.text);
		proxyId = created.json.proxy.id;
		assert.deepEqual([created.json.proxy.endpoint, created.json.proxy.username, created.json.proxy.hasPassword, created.json.proxy.status],
			[`127.0.0.1:${port}`, 'e2e-user', true, 'untested']);
		assert.equal((await client.post('/api/proxies/create', fields)).status, 409, '重复的不让加');
		const again = await client.post('/api/proxies/update', {id: proxyId, password: '', notes: '测试用'});
		assert.equal(again.json.proxy.notes, '测试用');
		const body = JSON.stringify(await proxies());
		assert.ok(!body.includes('e2e%3Apass') && !body.includes('e2e:pass'), '密码不下发');
	});

	test('检测:后台经代理查出口 IP,再打开 Steam 社区首页和市场页;代理认证按解码后的密码带', async () => {
		const res = await client.post('/api/proxies/test', {ids: [proxyId]});
		assert.equal(res.status, 200, res.text);
		assert.equal(res.json.proxies.proxies[0].status, 'checking');
		let proxy = res.json.proxies.proxies[0];
		const deadline = Date.now() + 10000;
		while (proxy.status === 'checking' && Date.now() < deadline) {
			await sleep(50);
			proxy = (await proxies()).proxies[0];
		}
		assert.deepEqual([proxy.status, proxy.check.ip, proxy.check.country, proxy.check.market, proxy.check.samples], ['healthy', '203.0.113.9', 'US', 429, 1]);
		assert.deepEqual(plain.slice(-3), [
			{url: 'http://ip.example.test/', auth: basic('e2e-user')},
			{url: 'http://steam.example.test/', auth: basic('e2e-user')},
			{url: 'http://steam.example.test/market/', auth: basic('e2e-user')}
		]);
		const usage = (await client.get('/api/proxies/usage?days=1')).json.usage;
		assert.ok(usage.byKind.some((item: {kind: string; requests: number}) => item.kind === 'check' && item.requests >= 3), JSON.stringify(usage.byKind));
		assert.equal(usage.byProxy[0].proxyId, proxyId);

		const draft = await client.post('/api/proxies/test-draft', {id: proxyId, password: ''});
		assert.equal(draft.status, 200, draft.text);
		assert.deepEqual([draft.json.check.status, draft.json.proxy], ['healthy', `http://e2e-user:****@127.0.0.1:${port}`]);
	});

	test('池里有代理:Steam 请求经代理(CONNECT 带认证);停用后恢复直连;设成不走代理去掉原来的分配', async () => {
		await login();
		await waitAttempt(attempt => attempt.status === 'web_session');
		assert.deepEqual((await proxies()).assigned.hotel, {proxyId, index: 0}, '登录时分到这个代理');

		const proxied = await readHistory(true);
		assert.equal(proxied.status, 'error');
		assert.match(proxied.error, /通过代理请求失败/);
		assert.ok(connects.some(c => c.target === 'store.steampowered.com:443' && c.auth === basic('e2e-user')), JSON.stringify(connects));

		const off = await client.post('/api/proxies/bulk', {ids: [proxyId], action: 'disable'});
		assert.equal(off.json.proxies.proxies[0].enabled, false);
		const directly = await readHistory(true);
		assert.deepEqual([directly.status, directly.count], ['done', 37]);

		// 假 Steam 登录给的 cookie 不带 SteamID,网页请求认不出账号(按账号选代理的部分在单元测试里)
		await client.post('/api/proxies/bulk', {ids: [proxyId], action: 'enable'});
		const bound = await client.post('/api/proxies/accounts/bind', {accountNames: ['Hotel'], mode: 'direct'});
		assert.deepEqual([bound.json.proxies.accounts, bound.json.proxies.assigned.hotel], [{hotel: {mode: 'direct'}}, undefined], '不走代理:原来的分配去掉');
		await client.post('/api/proxies/accounts/bind', {accountNames: ['hotel'], mode: 'pool'});
	});

	test('轮换:webshare 的 -rotate 换成 -编号,账号分到一个编号一直用,重新登录也不换', async () => {
		const saved = await client.post('/api/proxies/update', {id: proxyId, type: 'rotating', username: 'e2e-rotate', poolSize: 5});
		assert.equal(saved.status, 200, saved.text);
		assert.deepEqual([saved.json.proxy.sticky, saved.json.proxy.username, saved.json.proxy.poolSize, saved.json.proxy.status], [true, 'e2e-rotate', 5, 'untested']);

		assert.equal(saved.json.proxies.assigned.hotel, undefined, '改成按账号固定 IP,原来的分配作废');
		await login(true);
		const first = await assignedIndex();
		assert.ok(first >= 1 && first <= 5, String(first));
		// 假 Steam 的 cookie 认不出账号:消费记录请求用「认不出账号」那份编号
		await readHistory(true);
		const anonymous = (await proxies()).assigned[''].index as number;
		assert.ok(anonymous >= 1 && anonymous <= 5 && anonymous !== first, '和 hotel 分开编号');
		assert.equal(connects.at(-1)?.auth, basic(`e2e-${anonymous}`), '用分到的编号连代理');

		await login(true);
		await waitAttempt(attempt => attempt.status === 'web_session');
		assert.equal((await proxies()).assigned.hotel.index, first, '重新登录不换');

		const unpinned = await client.post('/api/proxies/update', {id: proxyId, username: 'e2e-user'});
		assert.equal(unpinned.status, 400, '填了 IP 数量又不知道编号写哪的不让存');
		assert.match(unpinned.json.error, /填了 IP 数量要能把编号写进地址/);
	});

	test('导入、代理组、绑定:绑定的代理全停用就不登录', async () => {
		const imported = await client.post('/api/proxies/import', {text: `127.0.0.1:${port}:other:pw\nbad\nsocks5://1.2.3.4:1080`, protocol: 'http', type: 'static', enabled: false});
		assert.equal(imported.status, 200, imported.text);
		assert.deepEqual([imported.json.added, imported.json.duplicates, imported.json.errors.map((error: {line: number}) => error.line)], [1, 0, [2, 3]]);
		const other = imported.json.proxies.proxies.find((proxy: {username: string}) => proxy.username === 'other');

		const group = await client.post('/api/proxies/groups/create', {name: '备用', color: 'green', proxyIds: [other.id]});
		assert.equal(group.status, 200, group.text);
		const bound = await client.post('/api/proxies/accounts/bind', {accountNames: ['hotel'], mode: 'bind', groupIds: [group.json.group.id]});
		assert.deepEqual(bound.json.proxies.accounts.hotel, {mode: 'bind', proxyIds: [], groupIds: [group.json.group.id]});

		await login(true);
		const refused = await waitAttempt(attempt => attempt.status === 'failed');
		assert.ok(refused.logs.some(entry => /没有登录:绑定的 1 个代理都已停用/.test(entry.message)), JSON.stringify(refused.logs));

		const removed = await client.post('/api/proxies/groups/delete', {id: group.json.group.id});
		assert.deepEqual(removed.json.proxies.accounts, {}, '删了组,只绑了这个组的账号退回代理池');
		const deleted = await client.post('/api/proxies/delete', {ids: [other.id, proxyId]});
		assert.deepEqual(deleted.json.proxies.proxies, []);
	});
});
