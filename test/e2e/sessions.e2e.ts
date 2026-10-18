// Steam 会话:同账号复用/强制重登、登录意图持久化、重启后自动恢复(refreshToken 优先,失效回退密码)。
// steam-user 被换成离线假客户端(support/fake-steam-user.cjs):RT-GOOD-* / pw-good 登录成功,其余失败。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Client, removeDir, sleep, startServer, tempDir} from './support/server.ts';
import type {TestServer} from './support/server.ts';

interface PublicAttempt {
	id: string;
	accountName: string;
	status: string;
	logs: Array<{level: string; message: string}>;
}

async function attemptsByName(client: Client): Promise<Record<string, PublicAttempt[]>> {
	const res = await client.get('/api/attempts');
	const map: Record<string, PublicAttempt[]> = {};
	for (const attempt of res.json.attempts as PublicAttempt[]) {
		(map[attempt.accountName] ??= []).push(attempt);
	}
	return map;
}

/** 轮询直到条件成立(假 Steam 的登录是异步的) */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!ok(value) && Date.now() < deadline) {
		await sleep(100);
		value = await read();
	}
	return value;
}

describe('Steam 会话', () => {
	const password = randomBytes(9).toString('base64url');
	const env = {APP_PASSWORD: password, SESSION_RESTORE_INTERVAL_MS: '1000'};
	let appRoot: string;
	let server: TestServer;
	let client: Client;

	before(() => {
		appRoot = tempDir('sessions');
		mkdirSync(join(appRoot, 'data', 'config'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([
			{accountName: 'alpha', password: 'pw-good'},
			{accountName: 'bravo', password: 'pw-good'},
			{accountName: 'charlie', password: 'pw-bad'},
			{accountName: 'delta', password: 'pw-good'}
		]));
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
	});

	describe('第 1 轮:手动登录', () => {
		let alphaFirstId = '';

		before(async () => {
			server = await startServer({appRoot, env, run: 1});
			client = new Client(server.baseUrl);
			await client.login(password);
		});

		test('浏览器不传密码,服务端用名单里的密码登录成功', async () => {
			const res = await client.post('/api/login', {accountName: 'alpha'});
			assert.equal(res.status, 200);
			assert.notEqual(res.json.reused, true);
			alphaFirstId = res.json.attempt.id;
			const byName = await until(() => attemptsByName(client), m => m.alpha?.[0]?.status === 'web_session');
			assert.equal(byName.alpha?.[0]?.status, 'web_session');
		});

		test('再次登录同一账号:复用现有会话,不新建客户端', async () => {
			const res = await client.post('/api/login', {accountName: 'alpha'});
			assert.equal(res.json.reused, true);
			assert.equal(res.json.attempt.id, alphaFirstId);
			const logons = server.steamEvents().filter(e => e.event === 'logOn' && e.details?.accountName === 'alpha');
			assert.equal(logons.length, 1);
		});

		test('force 重登:换新会话、登出旧客户端,会话表里只剩一个', async () => {
			const res = await client.post('/api/login', {accountName: 'alpha', force: true});
			assert.notEqual(res.json.attempt.id, alphaFirstId);
			const byName = await until(() => attemptsByName(client), m => m.alpha?.[0]?.status === 'web_session');
			assert.equal(byName.alpha?.length, 1);
			assert.equal(byName.alpha?.[0]?.status, 'web_session');
			assert.ok(server.steamEvents().some(e => e.event === 'logOff'));
		});

		test('密码错误的账号失败,失败原因在推送日志里', async () => {
			await client.post('/api/login', {accountName: 'bravo'});
			await client.post('/api/login', {accountName: 'charlie'});
			await client.post('/api/login', {accountName: 'delta'});
			const byName = await until(() => attemptsByName(client),
				m => m.bravo?.[0]?.status === 'web_session' && m.charlie?.[0]?.status === 'failed' && m.delta?.[0]?.status === 'web_session');
			assert.equal(byName.bravo?.[0]?.status, 'web_session');
			assert.equal(byName.charlie?.[0]?.status, 'failed');
			assert.ok(byName.charlie?.[0]?.logs.some(l => l.level === 'error' && /InvalidPassword/.test(l.message)));
		});

		test('推送的会话日志不含 debug,最多 30 条', async () => {
			const byName = await attemptsByName(client);
			for (const attempt of Object.values(byName).flat()) {
				assert.ok(attempt.logs.length <= 30);
				assert.ok(attempt.logs.every(l => l.level !== 'debug'));
			}
		});

		test('手动登出 delta', async () => {
			const byName = await attemptsByName(client);
			const res = await client.post(`/api/logout/${byName.delta?.[0]?.id}`, {});
			assert.equal(res.json.attempt.status, 'logged_out');
		});

		test('登录意图与 session 已加密保存', async () => {
			await server.kill();
			const store = server.openStore();
			try {
				assert.deepEqual(store.loginIntents.listOnline().sort(), ['alpha', 'bravo']);
				assert.equal(store.sessions.get('bravo')?.refreshToken, 'RT-GOOD-bravo');
				// 让 bravo 的 refreshToken 失效,下一轮验证回退到密码
				store.sessions.put('bravo', {...store.sessions.get('bravo'), refreshToken: 'RT-EXPIRED'});
			} finally {
				store.close();
			}
		});
	});

	describe('第 2 轮:进程被杀后重启,自动恢复', () => {
		before(async () => {
			server = await startServer({appRoot, env, run: 2});
			client = new Client(server.baseUrl);
			await client.login(password);
		});

		test('alpha、bravo 自动恢复在线;登出过的 delta、密码错误的 charlie 不恢复', async () => {
			const byName = await until(() => attemptsByName(client),
				m => m.alpha?.[0]?.status === 'web_session' && m.bravo?.[0]?.status === 'web_session', 8000);
			assert.equal(byName.alpha?.[0]?.status, 'web_session');
			assert.equal(byName.bravo?.[0]?.status, 'web_session');
			assert.equal(byName.charlie, undefined);
			assert.equal(byName.delta, undefined);
			assert.match(server.output(), /将自动恢复 2 个账号的登录/);
		});

		test('alpha 用 refreshToken 恢复,没用密码', () => {
			const logons = server.steamEvents().filter(e => e.event === 'logOn'
				&& (e.details?.refreshToken === 'RT-GOOD-alpha' || e.details?.accountName === 'alpha'));
			assert.equal(logons.length, 1);
			assert.equal(logons[0]?.details?.refreshToken, 'RT-GOOD-alpha');
			assert.equal(logons[0]?.details?.password, undefined);
		});

		test('bravo:refreshToken 失效后改用密码', async () => {
			const logons = server.steamEvents().filter(e => e.event === 'logOn'
				&& (e.details?.refreshToken === 'RT-EXPIRED' || e.details?.accountName === 'bravo'));
			assert.equal(logons.length, 2);
			assert.equal(logons[0]?.details?.refreshToken, 'RT-EXPIRED');
			assert.equal(logons[1]?.details?.password, '<pw-good>');
			const byName = await attemptsByName(client);
			assert.ok(byName.bravo?.[0]?.logs.some(l => /refreshToken 登录失败/.test(l.message)));
			assert.ok(byName.alpha?.[0]?.logs.some(l => /服务重启后自动恢复登录/.test(l.message)));
			assert.ok(byName.alpha?.[0]?.logs.some(l => /用保存的 refreshToken 登录/.test(l.message)));
		});

		test('删除 alpha 后不再自动恢复', async () => {
			const res = await client.post('/api/accounts/cleanup', {accounts: [{accountName: 'alpha'}]});
			assert.equal(res.json.removedAttempts, 1);
			assert.ok(res.json.removedFiles >= 1);
			await server.kill();
			const store = server.openStore();
			try {
				assert.deepEqual(store.loginIntents.listOnline(), ['bravo']);
			} finally {
				store.close();
			}
		});
	});

	describe('第 3 轮:SESSION_RESTORE=0', () => {
		before(async () => {
			server = await startServer({appRoot, env: {...env, SESSION_RESTORE: '0'}, run: 3});
			client = new Client(server.baseUrl);
			await client.login(password);
		});

		test('不自动登录任何账号', async () => {
			await sleep(1500);
			assert.deepEqual(await attemptsByName(client), {});
			assert.deepEqual(server.steamEvents().filter(e => e.event === 'logOn'), []);
		});
	});
});
