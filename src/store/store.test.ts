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

/** 直接写一份旧版(1.6.8–1.6.15)格式的代理设置,模拟升级前存下的 */
function writeLegacyProxy(store: Store, value: unknown): void {
	store.settings.set('proxy.config', store.vault.encryptJson(value, 'proxy.config'));
}

/** 去掉随机的 id 和创建时间,比较其它各项 */
function withoutIds(config: ReturnType<Store['proxies']['load']>) {
	const ids = new Map(config.proxies.map((proxy, index) => [proxy.id, `#${index}`]));
	return {
		proxies: config.proxies.map(({id: _id, createdAt: _at, ...rest}) => rest),
		accounts: Object.fromEntries(Object.entries(config.accounts).map(([key, binding]) => [key, binding.mode === 'bind'
			? {...binding, proxyIds: binding.proxyIds.map(id => ids.get(id))}
			: binding]))
	};
}

const migratedProxy = (fields: Record<string, unknown>) => ({
	protocol: 'http', host: '', port: 0, type: 'static', username: '', password: '', poolSize: 0, loginsPerMinute: 0,
	enabled: true, notes: '', groupIds: [], check: null, ...fields
});

test('代理池:没存过是空的;加密存取(代理密码不明文落盘);指向不存在的代理、代理组的引用读的时候去掉', () => {
	const {store, dir} = freshStore();
	assert.deepEqual(store.proxies.load(), {proxies: [], groups: [], accounts: {}, accountGroups: {}});
	const proxy = {
		id: 'p1', protocol: 'http', host: 'p.example.io', port: 80, type: 'rotating', username: 'user-rotate', password: 'PROXY-PLAINTEXT',
		poolSize: 100, loginsPerMinute: 5, enabled: true, notes: '备注', groupIds: ['g1', 'gone'], createdAt: 1700000000000,
		check: {status: 'healthy', latencyMs: 300, ip: '203.0.113.1', country: 'US', ips: ['203.0.113.1'], samples: 3, error: '', checkedAt: 1700000001000}
	} as const;
	store.proxies.save({
		proxies: [structuredClone(proxy) as never],
		groups: [{id: 'g1', name: '开箱', color: 'blue', createdAt: 1}],
		accounts: {alpha: {mode: 'direct'}, bravo: {mode: 'bind', proxyIds: ['p1', 'gone'], groupIds: []}, charlie: {mode: 'bind', proxyIds: ['gone'], groupIds: []}},
		accountGroups: {ag1: ['g1', 'gone'], ag2: ['gone']}
	});
	assert.deepEqual(store.proxies.load(), {
		proxies: [{...proxy, groupIds: ['g1'], check: {...proxy.check, ips: ['203.0.113.1']}}],
		groups: [{id: 'g1', name: '开箱', color: 'blue', createdAt: 1}],
		accounts: {alpha: {mode: 'direct'}, bravo: {mode: 'bind', proxyIds: ['p1'], groupIds: []}},
		accountGroups: {ag1: ['g1']}
	});
	assert.ok(!dbBytes(dir).includes('PROXY-PLAINTEXT'), '代理密码不能明文落盘');

	// 以前的检测结果:「Steam 已封禁」(连得上、Steam 页面打不开)现在只看连通,算健康;市场页的状态码不要了
	store.proxies.save({...store.proxies.load(), proxies: [{...structuredClone(proxy), check: {
		status: 'blocked', latencyMs: 300, ip: '203.0.113.1', country: 'US', ips: ['203.0.113.1'], samples: 1, market: 429, error: 'Steam 社区回 HTTP 403', checkedAt: 1
	}} as never]});
	assert.deepEqual(store.proxies.load().proxies[0]?.check, {status: 'healthy', latencyMs: 300, ip: '203.0.113.1', country: 'US', ips: ['203.0.113.1'], samples: 1, error: '', checkedAt: 1});
	store.close();
});

test('代理池迁移:1.6.8–1.6.10 的整串全局地址变成池里一个轮换代理(带 {n} 的 IP 数量取编号范围结束值);账号的单独代理变成绑定给它的静态代理', () => {
	const {store} = freshStore();
	writeLegacyProxy(store, {
		global: 'https://kxk-{n}:p%40ss%3Aword@P.Example.io:8443',
		range: {from: 2, to: 9},
		accounts: {Alpha: 'direct', bravo: 'http://u:p@1.2.3.4:8080', charlie: 'http://u:p@1.2.3.4:8080', delta: 'global', echo: 'not a url::'},
		assigned: {bravo: 3}
	});
	const first = store.proxies.load();
	assert.deepEqual(withoutIds(first), {
		proxies: [
			migratedProxy({protocol: 'https', host: 'p.example.io', port: 8443, type: 'rotating', username: 'kxk-{n}', password: 'p@ss:word', poolSize: 9, notes: '原来的全局代理'}),
			migratedProxy({host: '1.2.3.4', port: 8080, username: 'u', password: 'p', notes: '原来 bravo 的单独代理'})
		],
		accounts: {alpha: {mode: 'direct'}, bravo: {mode: 'bind', proxyIds: ['#1'], groupIds: []}, charlie: {mode: 'bind', proxyIds: ['#1'], groupIds: []}}
	});
	assert.deepEqual(store.proxies.load(), first, '迁移后马上按新格式存了,id 不再变');

	writeLegacyProxy(store, {global: '10.0.0.1:3128', accounts: {}});
	assert.deepEqual(withoutIds(store.proxies.load()).proxies, [migratedProxy({host: '10.0.0.1', port: 3128, type: 'rotating', notes: '原来的全局代理'})]);
	writeLegacyProxy(store, {global: 'http://u-{n}:p@h.example.io:80', accounts: {}});
	assert.equal(store.proxies.load().proxies[0]!.poolSize, 1, '带 {n} 没有编号范围的(旧版用编号 1):IP 数量记 1');
	writeLegacyProxy(store, {global: '', accounts: {}});
	assert.deepEqual(store.proxies.load().proxies, [], '没设过的还是没有');
	store.close();
});

test('代理池迁移:1.6.11 起按各项存的全局代理(关着的照样关着;「按账号固定 IP」并进轮换,IP 数量取编号范围结束值)', () => {
	const {store} = freshStore();
	const legacy = (fields: Record<string, unknown>) => ({
		global: {enabled: true, protocol: 'http', host: 'p.webshare.io', port: 80, type: 'rotating', username: 'kxk-rotate', password: 'pw', loginsPerMinute: 3, ...fields},
		range: {from: 1, to: 50},
		accounts: {},
		assigned: {alpha: 7}
	});
	const webshare = {host: 'p.webshare.io', port: 80, type: 'rotating', username: 'kxk-rotate', password: 'pw', loginsPerMinute: 3, notes: '原来的全局代理'};
	writeLegacyProxy(store, legacy({type: 'sticky', username: 'kxk-{n}'}));
	assert.deepEqual(withoutIds(store.proxies.load()).proxies, [migratedProxy({...webshare, username: 'kxk-{n}', poolSize: 50})]);
	writeLegacyProxy(store, legacy({poolSize: 100, enabled: false}));
	assert.deepEqual(withoutIds(store.proxies.load()).proxies, [migratedProxy({...webshare, poolSize: 100, enabled: false})]);
	writeLegacyProxy(store, legacy({type: 'static'}));
	assert.deepEqual(withoutIds(store.proxies.load()).proxies, [migratedProxy({...webshare, type: 'static'})]);
	writeLegacyProxy(store, legacy({host: ''}));
	assert.deepEqual(store.proxies.load().proxies, [], '没填主机的当没设');
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

test('账户分组:新建排最后、改名、排序;成员移入移出;名单整表替换不丢分组;删分组连带清掉成员;重开库还在', () => {
	const {store, dir, key} = freshStore();
	const groups = store.groups;
	assert.deepEqual(groups.list(), []);
	const main = groups.create('主号');
	const vault = groups.create('仓库');
	const spare = groups.create('备用');
	assert.deepEqual(groups.list().map(g => g.name), ['主号', '仓库', '备用']);
	assert.throws(() => groups.create('主号'), '库里也挡重名');

	assert.equal(groups.rename(vault.id, '仓库号'), true);
	assert.equal(groups.rename('nope', 'x'), false);
	groups.reorder([spare.id, 'nope', main.id, spare.id]);
	assert.deepEqual(groups.list().map(g => g.name), ['备用', '主号', '仓库号'], '列到的在前,没列到的按原来顺序排后面');

	store.accounts.replaceAll([{accountName: 'Alice'}, {accountName: 'bob'}, {accountName: 'carol'}]);
	groups.assign(['ALICE', ' bob ', ''], main.id);
	groups.assign(['carol'], vault.id);
	groups.assign(['bob'], '');
	assert.deepEqual([...groups.members()].sort(), [['alice', main.id], ['carol', vault.id]]);

	store.accounts.replaceAll([{accountName: 'carol'}, {accountName: 'alice'}]);
	assert.equal(groups.members().get('alice'), main.id, '名单整表替换后分组还在');

	assert.equal(groups.remove(main.id), true);
	assert.equal(groups.remove(main.id), false);
	assert.deepEqual([...groups.members()], [['carol', vault.id]]);
	store.close();

	const again = openStore({dataDir: dir, defaultKeyFile: join(dir, 'unused.key'), env: {MASTER_KEY: key.toString('base64')}, logger: silent});
	assert.deepEqual(again.groups.list().map(g => g.name), ['备用', '仓库号']);
	assert.equal(again.groups.members().get('carol'), vault.id);
	again.close();
});
