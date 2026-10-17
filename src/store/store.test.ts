import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore, uuTokenId, VaultError} from './index.ts';
import type {Store} from './index.ts';

const silent = {log() {}, warn() {}, error() {}};

function freshStore(key = randomBytes(32)): {store: Store; dir: string; key: Buffer} {
	const dir = mkdtempSync(join(tmpdir(), 'store-'));
	const store = openStore({dataDir: dir, defaultKeyFile: join(dir, 'unused.key'), env: {MASTER_KEY: key.toString('base64')}, logger: silent});
	return {store, dir, key};
}

function dbBytes(dir: string): string {
	// WAL 模式下新写入可能还在 -wal 文件里,两个一起查
	const read = (file: string) => {
		try {
			return readFileSync(file).toString('latin1');
		} catch {
			return '';
		}
	};
	return read(join(dir, 'steam-tools.db')) + read(join(dir, 'steam-tools.db-wal'));
}

test('账户名单:整表替换、按名去重、保持顺序、密文落盘', () => {
	const {store, dir} = freshStore();
	assert.equal(store.accounts.isInitialized(), false);
	const saved = store.accounts.replaceAll([
		{accountName: 'Alice', password: 'pw-alice-1', sharedSecret: 'c2VjcmV0LWFsaWNl', balance: '12.5', currency: 23},
		{accountName: 'bob', password: 'pw-bob'},
		{accountName: 'ALICE', password: 'pw-alice-2'},
		{accountName: '   '},
		null
	]);
	assert.deepEqual(saved.map(a => a.accountName), ['ALICE', 'bob']);
	assert.equal(store.accounts.isInitialized(), true);

	const list = store.accounts.list();
	assert.deepEqual(list.map(a => [a.accountName, a.password]), [['ALICE', 'pw-alice-2'], ['bob', 'pw-bob']]);
	assert.equal(store.accounts.get('alice')?.password, 'pw-alice-2');
	assert.equal(store.accounts.get('nobody'), null);

	const raw = dbBytes(dir);
	assert.ok(!raw.includes('pw-alice'), '密码不能明文落盘');
	assert.ok(!raw.includes('pw-bob'));

	assert.equal(store.accounts.removeByNames(['Bob', 'ghost']), true);
	assert.equal(store.accounts.removeByNames(['ghost']), false);
	assert.deepEqual(store.accounts.list().map(a => a.accountName), ['ALICE']);

	store.accounts.replaceAll([]);
	assert.equal(store.accounts.list().length, 0);
	assert.equal(store.accounts.isInitialized(), true, '清空后仍算已初始化');
	store.close();
});

test('账户字段原样往返(含数字规范化)', () => {
	const {store} = freshStore();
	store.accounts.replaceAll([{
		id: 'client-1', accountName: 'acc', password: 'p', sharedSecret: 's', twoFactorCode: '',
		remember: false, hasMaFile: true, steamId: '76561190000000001', country: 'US',
		balance: 3.21, currency: 1, hasWallet: true, activeGame: 'tf2', source: 'maFile'
	}, {accountName: 'nan', balance: 'abc', currency: null}]);
	const [acc, nan] = store.accounts.list();
	assert.deepEqual(acc, {
		id: 'client-1', accountName: 'acc', password: 'p', sharedSecret: 's', twoFactorCode: '',
		remember: false, hasMaFile: true, steamID: '76561190000000001', country: 'US',
		balance: 3.21, currency: 1, hasWallet: true, activeGame: 'tf2', source: 'maFile'
	});
	assert.equal(nan?.balance, null);
	assert.equal(nan?.currency, null);
	assert.equal(nan?.activeGame, 'cs2');
	store.close();
});

test('maFile 与 session:加密存取、按账号名不区分大小写', () => {
	const {store, dir} = freshStore();
	const ma = {account_name: 'Alice', shared_secret: 'SS-PLAINTEXT', identity_secret: 'IS-PLAINTEXT', Session: {SteamID: 76561190000000002}};
	store.mafiles.put('Alice', ma);
	assert.deepEqual(store.mafiles.get('alice'), ma);
	assert.equal(store.mafiles.has('ALICE'), true);
	assert.equal(store.mafiles.count(), 1);

	store.sessions.put('Alice', {accountName: 'Alice', steamID: '7656', refreshToken: 'RT-PLAINTEXT', cookies: ['a=1']});
	assert.equal(store.sessions.get('Alice')?.refreshToken, 'RT-PLAINTEXT');
	const raw = dbBytes(dir);
	for (const secret of ['SS-PLAINTEXT', 'IS-PLAINTEXT', 'RT-PLAINTEXT']) {
		assert.ok(!raw.includes(secret), `${secret} 不能明文落盘`);
	}
	assert.equal(store.sessions.remove(['Alice', 'Alice', 'none']), 1);
	assert.equal(store.sessions.get('Alice'), null);
	store.close();
});

test('代理设置:没存过是空的;加密存取,代理密码不明文落盘', () => {
	const {store, dir} = freshStore();
	const empty = {enabled: false, protocol: 'http', host: '', port: 0, type: 'rotating', username: '', password: '', poolSize: 0, loginsPerMinute: 0} as const;
	assert.deepEqual(store.proxies.load(), {global: empty, accounts: {}});
	const config = {
		global: {enabled: true, protocol: 'http', host: 'p.example.io', port: 80, type: 'rotating', username: 'user-rotate', password: 'PROXY-PLAINTEXT', poolSize: 100, loginsPerMinute: 5},
		accounts: {alpha: 'direct', bravo: 'http://u:p@1.2.3.4:8080'}
	} as const;
	store.proxies.save(structuredClone(config) as never);
	assert.deepEqual(store.proxies.load(), config);
	assert.ok(!dbBytes(dir).includes('PROXY-PLAINTEXT'), '代理密码不能明文落盘');
	store.close();
});

test('代理设置:1.6.8–1.6.10 存的整串全局地址拆成各项(开着、轮换;带 {n} 的 IP 数量取编号范围结束值),旧的编号不再读,账号设置照旧', () => {
	const {store} = freshStore();
	const old = (global: string) => ({global, range: {from: 2, to: 9}, accounts: {alpha: 'direct'}, assigned: {bravo: 3}});
	store.proxies.save(old('http://kxk-rotate:p%40ss%3Aword@p.webshare.io:80') as never);
	assert.deepEqual(store.proxies.load(), {
		global: {enabled: true, protocol: 'http', host: 'p.webshare.io', port: 80, type: 'rotating', username: 'kxk-rotate', password: 'p@ss:word', poolSize: 0, loginsPerMinute: 0},
		accounts: {alpha: 'direct'}
	});
	store.proxies.save(old('https://kxk-{n}:pw@P.Example.io:8443') as never);
	assert.deepEqual(store.proxies.load().global, {enabled: true, protocol: 'https', host: 'p.example.io', port: 8443, type: 'rotating', username: 'kxk-{n}', password: 'pw', poolSize: 9, loginsPerMinute: 0});
	store.proxies.save(old('10.0.0.1:3128') as never);
	assert.deepEqual(store.proxies.load().global, {enabled: true, protocol: 'http', host: '10.0.0.1', port: 3128, type: 'rotating', username: '', password: '', poolSize: 0, loginsPerMinute: 0});
	store.proxies.save(old('') as never);
	assert.equal(store.proxies.load().global.enabled, false, '没设过的还是没设');
	assert.equal(store.proxies.load().global.host, '');
	store.close();
});

test('代理设置:1.6.11 的「按账号固定 IP」并进轮换(IP 数量取编号范围结束值),静态照旧', () => {
	const {store} = freshStore();
	const v1611 = (type: string) => ({
		global: {enabled: true, protocol: 'http', host: 'p.webshare.io', port: 80, type, username: 'kxk-{n}', password: 'pw', loginsPerMinute: 3},
		range: {from: 1, to: 50},
		accounts: {},
		assigned: {alpha: 7}
	});
	store.proxies.save(v1611('sticky') as never);
	assert.deepEqual(store.proxies.load(), {
		global: {enabled: true, protocol: 'http', host: 'p.webshare.io', port: 80, type: 'rotating', username: 'kxk-{n}', password: 'pw', poolSize: 50, loginsPerMinute: 3},
		accounts: {}
	});
	assert.deepEqual([store.proxies.load().global.type, store.proxies.load().global.poolSize], ['rotating', 50]);
	store.proxies.save(v1611('static') as never);
	assert.deepEqual([store.proxies.load().global.type, store.proxies.load().global.poolSize], ['static', 0]);
	store.close();
});

test('UU token:按 userId 去重(后写覆盖)、按 id 查找、没有 userId 时用哈希', () => {
	const {store, dir} = freshStore();
	store.uu.replaceTokens([
		{token: 'TOKEN-A1', userId: 101, nickname: 'a', linkedSteamId: '1'},
		{token: 'TOKEN-B', userId: '202', nickname: 'b'},
		{token: 'TOKEN-A2', userId: '101', nickname: 'a2'},
		{token: 'TOKEN-ANON'},
		{token: ''} as never
	]);
	const tokens = store.uu.listTokens();
	assert.deepEqual(tokens.map(t => t.token), ['TOKEN-B', 'TOKEN-A2', 'TOKEN-ANON']);
	assert.equal(store.uu.findToken('101')?.token, 'TOKEN-A2');
	const anonId = uuTokenId({token: 'TOKEN-ANON', userId: null});
	assert.match(anonId, /^h[0-9a-f]{16}$/);
	assert.equal(store.uu.findToken(anonId)?.token, 'TOKEN-ANON');
	assert.ok(!dbBytes(dir).includes('TOKEN-'), 'UU token 不能明文落盘');
	store.close();
});

test('UU 发货配置:与旧 delivery-config.json 形状往返', () => {
	const {store, dir} = freshStore();
	assert.equal(store.uu.loadDeliveryConfig(), null);
	const config = {
		__settings__: {pollIntervalMs: 60000},
		acc1: {token: 'DELIVERY-TOKEN-1', gameId: '730', nickname: 'n', userId: '9', jwtExp: 1, boundAt: 'x', delivery: {'730': {auto: true}}, listAuto: false, listConfig: null},
		acc2: {token: '', gameId: '440'}
	};
	store.uu.saveDeliveryConfig(config);
	assert.deepEqual(store.uu.loadDeliveryConfig(), {__settings__: config.__settings__, acc1: config.acc1});
	assert.ok(!dbBytes(dir).includes('DELIVERY-TOKEN'));
	store.close();
});

test('换了主密钥打开同一个库会直接报错,不会混写', () => {
	const {store, dir} = freshStore();
	store.accounts.replaceAll([{accountName: 'a', password: 'p'}]);
	store.close();
	const otherKey = randomBytes(32).toString('base64');
	assert.throws(
		() => openStore({dataDir: dir, defaultKeyFile: join(dir, 'unused.key'), env: {MASTER_KEY: otherKey}, logger: silent}),
		(err: unknown) => err instanceof VaultError && /主密钥不匹配/.test(err.message)
	);
});

test('同一把密钥重新打开,数据都在', () => {
	const {store, dir, key} = freshStore();
	store.accounts.replaceAll([{accountName: 'a', password: 'p'}]);
	store.close();
	const again = openStore({dataDir: dir, defaultKeyFile: join(dir, 'unused.key'), env: {MASTER_KEY: key.toString('base64')}, logger: silent});
	assert.equal(again.accounts.get('a')?.password, 'p');
	again.close();
});

test('登录意图:设在线/离线、按账号名不区分大小写、删除', () => {
	const {store} = freshStore();
	assert.deepEqual(store.loginIntents.listOnline(), []);
	store.loginIntents.setOnline('Alice', true);
	store.loginIntents.setOnline('bob', true);
	store.loginIntents.setOnline('carol', false);
	assert.deepEqual(store.loginIntents.listOnline().sort(), ['Alice', 'bob']);
	assert.equal(store.loginIntents.isOnline('ALICE'), true);
	store.loginIntents.setOnline('alice', false);
	assert.equal(store.loginIntents.isOnline('Alice'), false);
	store.loginIntents.remove(['BOB', 'nobody']);
	assert.deepEqual(store.loginIntents.listOnline(), []);
	store.close();
});
