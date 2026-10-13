// 充值码兑换:账号/充值码 1:1 配对 → 每条临时登录 → 兑换 → 登出,结果经 wallet:redeem 推送。
// steam-user 和 steamstore 都是假的(support/offline-preload.cjs):码的前缀决定兑换结果。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client, removeDir, SocketListener, startServer, tempDir} from './support/server.ts';
import type {FakeSteamEvent, TestServer} from './support/server.ts';

describe('充值码兑换', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let server: TestServer;
	let client: Client;
	let socket: SocketListener;

	const events = (name: FakeSteamEvent['event']) => server.steamEvents().filter(event => event.event === name);

	before(async () => {
		appRoot = tempDir('wallet');
		mkdirSync(join(appRoot, 'data', 'config', 'mafile'), {recursive: true});
		// bravo 不填密码:用 maFile 里的 refreshToken 登录,shared_secret 自动过令牌
		writeFileSync(join(appRoot, 'data', 'config', 'mafile', 'bravo.maFile'), JSON.stringify({
			account_name: 'bravo', shared_secret: Buffer.from('bravo-shared').toString('base64'), Session: {RefreshToken: 'RT-GOOD-bravo'}
		}));
		server = await startServer({appRoot, env: {APP_PASSWORD: password}});
		client = new Client(server.baseUrl);
		await client.login(password);
		socket = await SocketListener.connect(client);
	});

	after(async () => {
		socket?.close();
		await server?.kill();
		removeDir(appRoot);
	});

	test('批量兑换:每条临时登录、兑换、登出;成功、码已用、被限流、登录失败各自如实推送', async () => {
		const pairs = [
			{account: 'alpha', password: 'pw-good', code: 'GOOD-1'},
			{account: 'bravo', password: '', code: 'GOOD-2'},
			{account: 'alpha', password: 'pw-good', code: 'USED-3'},
			{account: 'alpha', password: 'pw-good', code: 'LIMIT-4'},
			{account: 'charlie', password: 'wrong', code: 'GOOD-5'}
		];
		const res = await client.post('/api/wallet/redeem', {pairs, concurrency: 2});
		assert.equal(res.status, 200, res.text);
		assert.deepEqual([res.json.total, res.json.concurrency], [5, 2]);
		const jobId = res.json.jobId as string;

		await socket.waitFor('wallet:redeem', p => p.jobId === jobId && p.status === 'done');
		const finals = socket.named('wallet:redeem').filter(p => p.jobId === jobId && (p.status === 'success' || p.status === 'error'));
		const byIndex = Object.fromEntries(finals.map(p => [p.index, [p.status, p.message, p.balance ?? '']]));
		assert.deepEqual(byIndex, {
			0: ['success', '兑换成功,余额 $15.00', '$15.00'],
			1: ['success', '兑换成功,余额 $15.00', '$15.00'],
			2: ['error', '充值码已被使用(DuplicateActivationCode)', ''],
			3: ['error', '操作过于频繁,已被限流,请稍后再试(RateLimited)', ''],
			4: ['error', 'InvalidPassword', '']
		});
		// 过程日志也推给前端
		assert.ok(socket.named('wallet:redeem').some(p => p.jobId === jobId && p.index === 0 && p.logMessage === '正在兑换充值码…'));

		const logOns = events('logOn');
		assert.equal(logOns.length, 5);
		assert.deepEqual(logOns.find(e => e.details?.refreshToken)?.details, {refreshToken: 'RT-GOOD-bravo'});
		assert.ok(logOns.some(e => e.details?.accountName === 'alpha' && e.details?.password === '<pw-good>'));
		assert.equal(events('logOff').length, 5, '每个临时登录都登出了');
		assert.deepEqual(events('walletRedeem').map(e => e.code).sort(), ['GOOD-1', 'GOOD-2', 'LIMIT-4', 'USED-3']);
	});

	test('临时登录不进账户列表', async () => {
		const res = await client.get('/api/attempts');
		assert.deepEqual(res.json.attempts, []);
	});

	test('没有有效配对 / 超过 500 条报 400', async () => {
		const empty = await client.post('/api/wallet/redeem', {pairs: [{account: 'alpha', code: ' '}]});
		assert.equal(empty.status, 400);
		assert.equal(empty.json.error, '没有可兑换的账户/充值码配对');
		const many = await client.post('/api/wallet/redeem', {pairs: Array.from({length: 501}, (_, i) => ({account: 'a', code: 'c' + i}))});
		assert.equal(many.status, 400);
		assert.equal(many.json.error, '单次最多兑换 500 条');
	});
});
