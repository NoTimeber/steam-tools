// Steam 代理:按各项读写和校验(密码不下发、留空保留)、测代理(经本地假代理拿出口 IP)、设了全局代理后 Steam 请求真的走代理(带认证)、关掉后恢复直连。
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

describe('Steam 代理', () => {
	const password = randomBytes(9).toString('base64url');
	const auth = 'Basic ' + Buffer.from('e2e-user:e2e:pass').toString('base64');
	const plain: Array<{url: string; auth: string}> = [];
	const connects: Array<{target: string; auth: string}> = [];
	let proxyServer: http.Server;
	let proxyUrl: string;
	/** 全局代理各项(指向本地假代理) */
	let fields: Record<string, unknown>;
	let appRoot: string;
	let server: TestServer;
	let client: Client;

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

	before(async () => {
		proxyServer = http.createServer((req, res) => {
			plain.push({url: String(req.url), auth: String(req.headers['proxy-authorization'] ?? '')});
			// 「Steam 社区」测试地址回 429,模拟这个出口 IP 被 Steam 限流
			if (String(req.url).startsWith('http://steam.example.test/')) {
				res.writeHead(429);
				res.end('Too Many Requests');
				return;
			}
			res.writeHead(200, {'content-type': 'application/json'});
			res.end(JSON.stringify({ip: '203.0.113.9'}));
		});
		proxyServer.on('connect', (req, socket) => {
			socket.on('error', () => {});   // 对方在我们回 403 时就断开,不算错
			connects.push({target: String(req.url), auth: String(req.headers['proxy-authorization'] ?? '')});
			socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
		});
		await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
		const port = (proxyServer.address() as AddressInfo).port;
		proxyUrl = `http://e2e-user:e2e%3Apass@127.0.0.1:${port}`;
		fields = {enabled: true, protocol: 'http', host: '127.0.0.1', port, type: 'rotating', username: 'e2e-user', password: 'e2e:pass', loginsPerMinute: ''};

		appRoot = tempDir('proxy');
		mkdirSync(join(appRoot, 'data', 'config'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([{accountName: 'hotel', password: 'pw-good'}]));
		server = await startServer({appRoot, env: {APP_PASSWORD: password, PROXY_TEST_URL: 'http://ip.example.test/', PROXY_STEAM_TEST_URL: 'http://steam.example.test/market/'}});
		client = new Client(server.baseUrl);
		await client.login(password);
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
		proxyServer?.closeAllConnections();
		await new Promise<void>(resolve => proxyServer?.close(() => resolve()));
	});

	test('设置:没设时为空;不对的 400;保存后下发各项(不带密码)和打码的地址;密码留空保留', async () => {
		const empty = {enabled: false, protocol: 'http', host: '', port: 0, type: 'rotating', username: '', hasPassword: false, loginsPerMinute: 0};
		assert.deepEqual((await client.get('/api/proxy')).json.proxy, {global: '', settings: empty, sticky: false, range: {from: 1, to: 1}, accounts: {}, assigned: {}});
		const bad = await client.post('/api/proxy/global', {...fields, protocol: 'socks5'});
		assert.equal(bad.status, 400);
		assert.match(bad.json.error, /SOCKS/);
		assert.equal((await client.post('/api/proxy/global', {...fields, port: ''})).status, 400, '端口必填');
		const saved = await client.post('/api/proxy/global', fields);
		assert.equal(saved.status, 200, saved.text);
		assert.equal(saved.json.proxy.global, proxyUrl.replace('e2e%3Apass', '****'));
		assert.deepEqual([saved.json.proxy.settings.username, saved.json.proxy.settings.hasPassword], ['e2e-user', true]);
		const again = await client.post('/api/proxy/global', {...fields, password: '', type: 'static'});
		assert.equal(again.json.proxy.settings.type, 'static');
		const body = JSON.stringify((await client.get('/api/proxy')).json);
		assert.ok(!body.includes('e2e%3Apass') && !body.includes('e2e:pass'), '密码不下发');

		const account = await client.post('/api/proxy/account', {accountName: 'Hotel', mode: 'direct'});
		assert.deepEqual(account.json.proxy.accounts, {hotel: {mode: 'direct', url: ''}});
		await client.post('/api/proxy/account', {accountName: 'hotel', mode: 'global'});
	});

	test('测代理:经代理请求测试地址回出口 IP,再打开 Steam 社区看有没有被限流;代理认证按解码后的密码带', async () => {
		const res = await client.post('/api/proxy/test', {});
		assert.equal(res.status, 200, res.text);
		assert.equal(res.json.ip, '203.0.113.9');
		assert.deepEqual([res.json.steam.status, res.json.steam.error], [429, '']);
		assert.deepEqual(plain.slice(-2), [{url: 'http://ip.example.test/', auth}, {url: 'http://steam.example.test/market/', auth}]);
	});

	test('设了全局代理:Steam 请求经代理(CONNECT 带认证);清掉后恢复直连', async () => {
		const login = await client.post('/api/login', {accountName: 'hotel'});
		assert.equal(login.status, 200, login.text);
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const attempts = (await client.get('/api/attempts')).json.attempts as Array<{accountName: string; status: string}>;
			if (attempts.some(a => a.accountName === 'hotel' && a.status === 'web_session')) {
				break;
			}
			await sleep(50);
		}

		const proxied = await readHistory(true);
		assert.equal(proxied.status, 'error');
		assert.match(proxied.error, /通过代理请求失败/);
		assert.ok(connects.some(c => c.target === 'store.steampowered.com:443' && c.auth === auth), JSON.stringify(connects));

		const off = await client.post('/api/proxy/global', {enabled: false});
		assert.deepEqual([off.json.proxy.global, off.json.proxy.settings.host], ['', '127.0.0.1'], '关了直连,填的留着');
		const directly = await readHistory(true);
		assert.deepEqual([directly.status, directly.count], ['done', 37]);
	});

	test('按账号固定 IP:用户名带 {n},账号分到的编号记下来;手动重新登录换一个,测试按编号连代理', async () => {
		const saved = await client.post('/api/proxy/global', {enabled: true, type: 'sticky', username: 'e2e-{n}', from: 1, to: 5});
		assert.equal(saved.status, 200, saved.text);
		assert.deepEqual([saved.json.proxy.sticky, saved.json.proxy.range], [true, {from: 1, to: 5}]);

		const tested = await client.post('/api/proxy/test', {accountName: 'hotel'});
		assert.equal(tested.status, 200, tested.text);
		const first = (await client.get('/api/proxy')).json.proxy.assigned.hotel as number;
		assert.ok(first >= 1 && first <= 5, String(first));
		assert.equal(plain.at(-1)?.auth, 'Basic ' + Buffer.from(`e2e-${first}:e2e:pass`).toString('base64'), '用分到的编号连代理');

		const relogin = await client.post('/api/login', {accountName: 'hotel', force: true});
		assert.equal(relogin.status, 200, relogin.text);
		const second = (await client.get('/api/proxy')).json.proxy.assigned.hotel as number;
		assert.ok(second >= 1 && second <= 5 && second !== first, `${first} → ${second}`);

		const again = await client.post('/api/login', {accountName: 'hotel'});
		assert.equal(again.json.reused, true);
		assert.equal((await client.get('/api/proxy')).json.proxy.assigned.hotel, second, '在线时再点登录不换');
		await client.post('/api/proxy/global', {enabled: false});
	});
});
