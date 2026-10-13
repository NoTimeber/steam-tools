// 加密数据层:旧版明文 JSON 启动时导入并归档、接口从库里读写、库里没有明文、主密钥校验。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {Client, removeDir, startExpectingExit, startServer, tempDir} from './support/server.ts';
import type {TestServer} from './support/server.ts';

const require = createRequire(import.meta.url);
const SteamTotp = require('steam-totp') as {generateAuthCode(secret: string, timeOffset?: number): string};

const FIX = {
	pwA: 'FIXTURE-PW-ALPHA',
	pwB: 'FIXTURE-PW-BRAVO',
	maShared: Buffer.from('fixture-shared-secret-20b').subarray(0, 20).toString('base64'),
	maIdentity: 'FIXTURE-IDENTITY-SECRET',
	refresh: 'FIXTURE-REFRESH-TOKEN',
	uuToken: 'FIXTURE-UU-TOKEN-0123456789abcdef',
	uuToken2: 'FIXTURE-UU-TOKEN2-0123456789abcdef'
};

/** 按旧版目录结构写一份明文数据 */
function writeLegacyData(dataDir: string): void {
	mkdirSync(join(dataDir, 'config', 'mafile'), {recursive: true});
	mkdirSync(join(dataDir, 'sessions'), {recursive: true});
	mkdirSync(join(dataDir, 'uu'), {recursive: true});
	writeFileSync(join(dataDir, 'config', 'accounts.json'), JSON.stringify([
		{id: 'c1', accountName: 'alpha', password: FIX.pwA, sharedSecret: '', remember: true, steamID: '76561190000000011', country: 'US', balance: 5, currency: 1, hasWallet: true},
		{id: 'c2', accountName: 'bravo', password: FIX.pwB, remember: true}
	]));
	writeFileSync(join(dataDir, 'config', 'mafile', 'alpha.maFile'), JSON.stringify({
		account_name: 'alpha', shared_secret: FIX.maShared, identity_secret: FIX.maIdentity, SteamID: '76561190000000011'
	}));
	writeFileSync(join(dataDir, 'sessions', 'alpha.json'), JSON.stringify({
		accountName: 'alpha', steamID: '76561190000000011', refreshToken: FIX.refresh,
		cookies: ['steamLoginSecure=FIXTURE-COOKIE'], cookieHeader: 'steamLoginSecure=FIXTURE-COOKIE'
	}));
	writeFileSync(join(dataDir, 'uu', 'tokens.json'), JSON.stringify([
		{token: FIX.uuToken, userId: '9001', nickname: 'uu-alpha', linkedSteamId: '76561190000000011', jwtExp: 4102444800, acquiredAt: '2026-10-01T00:00:00Z'},
		{token: FIX.uuToken2, userId: '9002', nickname: 'uu-orphan', linkedSteamId: '76561190000009999', jwtExp: 4102444800, acquiredAt: '2026-10-02T00:00:00Z'}
	]));
	writeFileSync(join(dataDir, 'uu', 'delivery-config.json'), JSON.stringify({
		__settings__: {pollIntervalMs: 600000},
		alpha: {token: FIX.uuToken, gameId: '730', nickname: 'uu-alpha', userId: '9001', jwtExp: 4102444800, boundAt: '2026-10-01T00:00:00Z',
			delivery: {'730': {auto: false}, '440': {auto: false}}, listAuto: false, listConfig: null}
	}));
	writeFileSync(join(dataDir, 'uu', 'last-token.txt'), FIX.uuToken);
}

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, {recursive: true, withFileTypes: true})
		.filter(entry => entry.isFile())
		.map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1).replaceAll('\\', '/'))
		.sort();
}

function dbBytes(dataDir: string): string {
	const read = (file: string) => (existsSync(file) ? readFileSync(file).toString('latin1') : '');
	return read(join(dataDir, 'steam-tools.db')) + read(join(dataDir, 'steam-tools.db-wal'));
}

describe('加密数据层', () => {
	const password = randomBytes(9).toString('base64url');
	const bravoShared = randomBytes(20).toString('base64');
	let appRoot: string;
	let server: TestServer;
	let client: Client;

	before(async () => {
		appRoot = tempDir('store');
		writeLegacyData(join(appRoot, 'data'));
		server = await startServer({appRoot, env: {APP_PASSWORD: password}});
		client = new Client(server.baseUrl);
		await client.login(password);
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
	});

	describe('旧版明文数据导入', () => {
		test('启动日志报告导入数量,开发环境自动生成主密钥', () => {
			const log = server.output();
			assert.match(log, /账户 2、maFile 1、session 1、UU token 2、UU 发货配置 1/);
			assert.match(log, /确认数据正常后请删除该目录/);
			assert.match(log, /已生成新密钥/);
			assert.ok(existsSync(join(appRoot, 'secrets', 'master.key')));
		});

		test('明文文件全部挪进 _migrated_plaintext,数据目录不再有明文凭据', () => {
			const archiveRoot = join(server.dataDir, '_migrated_plaintext');
			const stamps = readdirSync(archiveRoot);
			assert.equal(stamps.length, 1);
			assert.deepEqual(listFiles(join(archiveRoot, stamps[0] as string)), [
				'config/accounts.json', 'config/mafile/alpha.maFile', 'sessions/alpha.json',
				'uu/delivery-config.json', 'uu/last-token.txt', 'uu/tokens.json'
			]);
			const leftover = listFiles(server.dataDir).filter(f => !f.startsWith('_migrated_plaintext/') && !f.startsWith('steam-tools.db'));
			assert.ok(!leftover.some(f => /accounts\.json|\.maFile|sessions\/|uu\/tokens|delivery-config|last-token/.test(f)), leftover.join(','));
		});
	});

	describe('账户与 maFile 从库里读写', () => {
		test('名单来自导入数据,不含密码', async () => {
			const res = await client.get('/api/accounts/list');
			assert.equal(res.json.initialized, true);
			assert.deepEqual(res.json.accounts.map((a: {accountName: string}) => a.accountName), ['alpha', 'bravo']);
			assert.ok(!res.text.includes('FIXTURE-PW'));
		});

		test('maFile 从库里读,查找不区分大小写', async () => {
			const res = await client.post('/api/accounts/meta', {accountNames: ['alpha', 'ALPHA', 'bravo']});
			const meta = res.json.accounts;
			assert.equal(meta.alpha.hasMaFile, true);
			assert.equal(meta.alpha.hasIdentitySecret, true);
			assert.equal(meta.alpha.steamId, '76561190000000011');
			assert.equal(meta.ALPHA.hasMaFile, true);
			assert.equal(meta.bravo.hasMaFile, false);
		});

		test('验证码由库里 maFile 的 shared_secret 生成', async () => {
			const res = await client.post('/api/auth-code', {accountName: 'alpha'});
			const expected = [-30, 0, 30].map(offset => SteamTotp.generateAuthCode(FIX.maShared, offset));
			assert.ok(expected.includes(res.json.code), `${res.json.code} 不在 ${expected.join('/')}`);
		});

		test('导入新 maFile:进库,不写文件', async () => {
			const res = await client.post('/api/mafile/import', {mafiles: [{account_name: 'bravo', shared_secret: bravoShared, identity_secret: 'FIXTURE-BRAVO-IS'}]});
			assert.equal(res.json.saved, 1);
			assert.equal(res.json.results[0].hasIdentitySecret, true);
			assert.equal(existsSync(join(server.dataDir, 'config', 'mafile', 'bravo.maFile')), false);
			const meta = await client.post('/api/accounts/meta', {accountNames: ['bravo']});
			assert.equal(meta.json.accounts.bravo.hasMaFile, true);
		});

		test('推回空密码沿用库里的值', async () => {
			await client.post('/api/accounts/list', {accounts: [{accountName: 'alpha', password: ''}, {accountName: 'bravo', password: '', remember: false}]});
			const store = server.openStore();
			try {
				assert.equal(store.accounts.get('bravo')?.password, FIX.pwB);
				assert.equal(store.accounts.get('bravo')?.remember, false);
				assert.equal(store.mafiles.get('bravo')?.identity_secret, 'FIXTURE-BRAVO-IS');
			} finally {
				store.close();
			}
		});
	});

	describe('UU token 不下发浏览器', () => {
		test('token 列表只有 id 和掩码', async () => {
			const res = await client.get('/api/uu/tokens');
			assert.ok(!res.text.includes('FIXTURE-UU-TOKEN'));
			assert.deepEqual(res.json.tokens.map((t: {id: string}) => t.id), ['9001', '9002']);
			for (const token of res.json.tokens) {
				assert.ok(!('token' in token));
				assert.match(token.tokenMask, /…/);
			}
		});

		test('发货绑定和轮询间隔从库里恢复', async () => {
			const res = await client.get('/api/uu/state');
			assert.equal(res.json.pollIntervalMs, 600000);
			const alpha = res.json.accounts.find((a: {accountName: string}) => a.accountName === 'alpha');
			assert.equal(alpha.bound, true);
			assert.equal(alpha.userId, '9001');
			assert.ok(!res.text.includes('FIXTURE-UU-TOKEN'));
		});

		test('按不存在的 tokenId 绑定 → 404;按 tokenId 删除', async () => {
			assert.equal((await client.post('/api/uu/bind', {accountName: 'bravo', tokenId: 'no-such-id'})).status, 404);
			assert.equal((await client.delete('/api/uu/token', {tokenId: '9002'})).status, 200);
			const res = await client.get('/api/uu/tokens');
			assert.deepEqual(res.json.tokens.map((t: {id: string}) => t.id), ['9001']);
		});
	});

	describe('删除账号与落盘', () => {
		test('删除账号:会话、session、名单一并清掉', async () => {
			const res = await client.post('/api/accounts/cleanup', {accounts: [{accountName: 'alpha'}]});
			assert.equal(res.json.removedFiles, 1);
			assert.equal(res.json.removedFromList, true);
			const list = await client.get('/api/accounts/list');
			assert.deepEqual(list.json.accounts.map((a: {accountName: string}) => a.accountName), ['bravo']);
		});

		test('数据库文件里没有任何明文凭据', () => {
			const raw = dbBytes(server.dataDir);
			const leaks = ['FIXTURE-PW', 'FIXTURE-IDENTITY', 'FIXTURE-REFRESH', 'FIXTURE-COOKIE', 'FIXTURE-UU-TOKEN', 'FIXTURE-BRAVO-IS', FIX.maShared, bravoShared]
				.filter(secret => raw.includes(secret));
			assert.deepEqual(leaks, []);
		});
	});

	describe('主密钥', () => {
		test('换错主密钥:拒绝启动', async () => {
			await server.kill();
			const wrongKey = randomBytes(32).toString('base64');
			const result = await startExpectingExit({appRoot, env: {MASTER_KEY: wrongKey}});
			assert.equal(result.code, 1);
			assert.match(result.output, /主密钥不匹配/);
		});

		test('生产环境缺主密钥:拒绝启动,不自动生成', async () => {
			const freshRoot = tempDir('nokey');
			try {
				const result = await startExpectingExit({appRoot: freshRoot, env: {NODE_ENV: 'production'}});
				assert.equal(result.code, 1);
				assert.match(result.output, /生产环境不会自动生成/);
				assert.equal(existsSync(join(freshRoot, 'secrets', 'master.key')), false);
			} finally {
				removeDir(freshRoot);
			}
		});

		test('原密钥重启:正常,不重复导入', async () => {
			server = await startServer({appRoot, env: {APP_PASSWORD: password}, run: 2});
			assert.doesNotMatch(server.output(), /legacy-import/);
			const again = new Client(server.baseUrl);
			await again.login(password);
			const res = await again.get('/api/accounts/list');
			assert.deepEqual(res.json.accounts.map((a: {accountName: string}) => a.accountName), ['bravo']);
		});
	});
});
