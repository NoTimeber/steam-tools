// 公网部署相关的安全行为:初始化令牌、口令限速、cookie 属性、同源校验、凭据不下发、调试端点、socket.io 握手。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Client, removeDir, startServer} from './support/server.ts';
import type {TestServer} from './support/server.ts';

describe('安全', () => {
	let server: TestServer;
	let client: Client;
	const pw1 = randomBytes(9).toString('base64url');
	const pw2 = randomBytes(9).toString('base64url');
	const secretA = randomBytes(20).toString('base64');

	before(async () => {
		server = await startServer();
		client = new Client(server.baseUrl);
	});

	after(async () => {
		await server.kill();
		removeDir(server.appRoot);
	});

	describe('未登录', () => {
		test('/healthz 免登录,不暴露状态', async () => {
			const res = await client.get('/healthz');
			assert.equal(res.status, 200);
			assert.deepEqual(res.json, {ok: true});
		});

		test('/api/health 需要登录;/api/auth/debug 已删除', async () => {
			assert.equal((await client.get('/api/health')).status, 401);
			assert.equal((await client.get('/api/auth/debug')).status, 404);
		});

		test('访问首页跳转登录页', async () => {
			const res = await client.get('/');
			assert.equal(res.status, 302);
			assert.match(res.headers.get('location') ?? '', /\/login$/);
		});

		test('安全响应头齐全,不暴露 X-Powered-By', async () => {
			const res = await client.get('/login');
			assert.equal(res.status, 200);
			assert.equal(res.headers.get('x-frame-options'), 'DENY');
			assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
			assert.equal(res.headers.get('referrer-policy'), 'same-origin');
			assert.equal(res.headers.get('x-powered-by'), null);
		});

		test('未设置口令,最短 8 位', async () => {
			const res = await client.get('/api/auth/status');
			assert.equal(res.json.configured, false);
			assert.equal(res.json.minLength, 8);
		});
	});

	describe('首次设置口令', () => {
		test('不带令牌或令牌错误 → 403', async () => {
			assert.equal((await client.post('/api/auth/setup', {password: pw1})).status, 403);
			assert.equal((await client.post('/api/auth/setup', {password: pw1, setupToken: 'deadbeef'})).status, 403);
		});

		test('口令太短 → 400;跨站 Origin → 403', async () => {
			const setupToken = server.setupToken();
			assert.ok(setupToken, '启动日志里有初始化令牌');
			assert.equal((await client.post('/api/auth/setup', {password: 'short', setupToken})).status, 400);
			assert.equal((await client.post('/api/auth/setup', {password: pw1, setupToken}, {origin: 'https://evil.example'})).status, 403);
		});

		test('正确设置:cookie 带 HttpOnly + SameSite=Lax,HTTP 下不加 Secure;之后不能再设置', async () => {
			const res = await client.post('/api/auth/setup', {password: pw1, setupToken: server.setupToken()});
			assert.equal(res.status, 200);
			const setCookie = res.headers.get('set-cookie') ?? '';
			assert.match(setCookie, /HttpOnly/);
			assert.match(setCookie, /SameSite=Lax/);
			assert.doesNotMatch(setCookie, /Secure/);
			assert.equal((await client.post('/api/auth/setup', {password: pw1, setupToken: server.setupToken()})).status, 409);
		});
	});

	describe('登录', () => {
		test('经 HTTPS 反代登录时 cookie 带 Secure', async () => {
			const res = await client.post('/api/auth/login', {password: pw1}, {headers: {'x-forwarded-proto': 'https'}});
			assert.equal(res.status, 200);
			assert.match(res.headers.get('set-cookie') ?? '', /Secure/);
		});

		test('Origin: null 被拒', async () => {
			assert.equal((await client.post('/api/auth/login', {password: pw1}, {origin: 'null'})).status, 403);
		});

		test('同一 IP 连错 5 次后锁定(口令正确也 429),换 IP 不受影响', async () => {
			const attacker = '203.0.113.7';
			for (let i = 0; i < 5; i++) {
				assert.equal((await client.post('/api/auth/login', {password: 'wrong-' + i}, {ip: attacker})).status, 401);
			}
			const locked = await client.post('/api/auth/login', {password: pw1}, {ip: attacker});
			assert.equal(locked.status, 429);
			assert.ok(Number(locked.headers.get('retry-after')) > 0);
			const other = await client.post('/api/auth/login', {password: pw1}, {ip: '203.0.113.8'});
			assert.equal(other.status, 200);
			client.adoptCookie(other);
			assert.equal((await client.get('/api/health')).status, 200);
		});
	});

	describe('账户名单不下发凭据', () => {
		test('POST/GET 名单都不含密码字段,只有标记', async () => {
			const res = await client.post('/api/accounts/list', {accounts: [
				{accountName: 'smoke_a', password: 'pw-smoke-a', sharedSecret: secretA},
				{accountName: 'smoke_b', password: 'pw-smoke-b'}
			]});
			assert.equal(res.status, 200);
			assert.doesNotMatch(res.text, /"password"|"sharedSecret"|"twoFactorCode"/);
			const a = res.json.accounts.find((x: {accountName: string}) => x.accountName === 'smoke_a');
			assert.equal(a.hasPassword, true);
			assert.equal(a.hasSharedSecret, true);
			const list = await client.get('/api/accounts/list');
			assert.ok(!list.text.includes('pw-smoke') && !list.text.includes(secretA));
		});

		test('库里保存了密码和 shared_secret', () => {
			const store = server.openStore();
			try {
				const a = store.accounts.get('smoke_a');
				assert.equal(a?.password, 'pw-smoke-a');
				assert.equal(a?.sharedSecret, secretA);
			} finally {
				store.close();
			}
		});

		test('推回空密码:沿用库里的值;没推的账号被移除', async () => {
			await client.post('/api/accounts/list', {accounts: [{accountName: 'smoke_a', password: '', sharedSecret: ''}]});
			const store = server.openStore();
			try {
				assert.equal(store.accounts.get('smoke_a')?.password, 'pw-smoke-a');
				assert.equal(store.accounts.get('smoke_a')?.sharedSecret, secretA);
				assert.equal(store.accounts.get('smoke_b'), null);
			} finally {
				store.close();
			}
		});

		test('验证码:不传 shared_secret 时用库里的', async () => {
			const res = await client.post('/api/auth-code', {accountName: 'smoke_a'});
			assert.equal(res.status, 200);
			assert.match(res.json.code, /^[A-Z0-9]{5}$/);
		});

		test('Steam 登录:名单里没有、也没传密码 → 400', async () => {
			assert.equal((await client.post('/api/login', {accountName: 'nobody_smoke'})).status, 400);
		});

		test('已登录但跨站 POST 被拒,名单没被清空', async () => {
			const res = await client.post('/api/accounts/list', {accounts: []}, {origin: 'https://evil.example'});
			assert.equal(res.status, 403);
			assert.equal((await client.get('/api/accounts/list')).json.accounts.length, 1);
		});
	});

	describe('调试端点默认关闭', () => {
		test('/api/cookies/:id 与 /api/steam-purchase/test 返回 404', async () => {
			assert.equal((await client.get('/api/cookies/anything')).status, 404);
			assert.equal((await client.post('/api/steam-purchase/test', {})).status, 404);
		});
	});

	describe('修改口令', () => {
		test('当前口令错 → 401;新口令太短 → 400', async () => {
			const ip = '203.0.113.20';
			assert.equal((await client.post('/api/auth/password', {currentPassword: 'nope', newPassword: pw2}, {ip})).status, 401);
			assert.equal((await client.post('/api/auth/password', {currentPassword: pw1, newPassword: 'short'}, {ip})).status, 400);
		});

		test('改成功后旧会话失效,新会话可用;auth.json 只存哈希', async () => {
			const oldCookie = client.cookie;
			const res = await client.post('/api/auth/password', {currentPassword: pw1, newPassword: pw2}, {ip: '203.0.113.21'});
			assert.equal(res.status, 200);
			client.adoptCookie(res);
			assert.equal((await client.get('/api/health', {headers: {cookie: oldCookie}})).status, 401);
			assert.equal((await client.get('/api/health')).status, 200);
			const auth = JSON.parse(readFileSync(join(server.dataDir, 'config', 'auth.json'), 'utf8'));
			assert.ok(auth.salt && auth.hash);
			assert.ok(!JSON.stringify(auth).includes(pw2));
		});
	});

	describe('socket.io', () => {
		test('跨站轮询握手被拒,同源正常', async () => {
			const evil = await client.get('/socket.io/?EIO=4&transport=polling', {headers: {origin: 'https://evil.example'}});
			assert.equal(evil.status, 403);
			const ok = await client.get('/socket.io/?EIO=4&transport=polling');
			assert.equal(ok.status, 200);
			assert.ok(ok.text.startsWith('0{'));
		});

		async function wsHandshake(headers: Record<string, string>): Promise<string[]> {
			return new Promise(resolve => {
				const messages: string[] = [];
				const url = server.baseUrl.replace('http', 'ws') + '/socket.io/?EIO=4&transport=websocket';
				// Node 的 WebSocket(undici)支持自定义握手头
				const ws = new WebSocket(url, {headers} as unknown as string[]);
				const done = () => {
					clearTimeout(timer);
					try {
						ws.close();
					} catch {
						// 忽略
					}
					resolve(messages);
				};
				const timer = setTimeout(done, 4000);
				ws.onmessage = event => {
					const message = String(event.data);
					messages.push(message);
					if (message.startsWith('0{')) {
						ws.send('40');
					}
					if (message.startsWith('44') || message.startsWith('42["hello"')) {
						done();
					}
				};
				ws.onerror = done;
				ws.onclose = done;
			});
		}

		test('带有效 cookie 同源连接,收到 hello', async () => {
			const messages = await wsHandshake({cookie: client.cookie, origin: server.baseUrl});
			assert.ok(messages.some(m => m.startsWith('40{')));
			assert.ok(messages.some(m => m.startsWith('42["hello"')));
		});

		test('不带 cookie → unauthorized', async () => {
			const messages = await wsHandshake({origin: server.baseUrl});
			assert.ok(messages.some(m => m.startsWith('44') && m.includes('unauthorized')));
		});

		test('跨站 Origin 即使带 cookie 也握手失败', async () => {
			const messages = await wsHandshake({cookie: client.cookie, origin: 'https://evil.example'});
			assert.ok(!messages.some(m => m.startsWith('0{')));
		});
	});

	describe('损坏的 JSON 数据文件', () => {
		test('读成空、不崩溃,坏文件只备份一次', async () => {
			const ledger = join(server.dataDir, 'market-buyorders.json');
			writeFileSync(ledger, '{"broken": ', 'utf8');
			const res = await client.get('/api/market/buyorders');
			assert.equal(res.status, 200);
			assert.deepEqual(res.json.orders, []);
			await client.get('/api/market/buyorders');
			const backups = readdirSync(server.dataDir).filter(f => f.startsWith('market-buyorders.json.corrupt-'));
			assert.equal(backups.length, 1);
			assert.equal(readFileSync(join(server.dataDir, backups[0] as string), 'utf8'), '{"broken": ');
		});

		test('名单在加密库里,数据目录没有 accounts.json', () => {
			assert.equal(existsSync(join(server.dataDir, 'config', 'accounts.json')), false);
		});
	});
});
