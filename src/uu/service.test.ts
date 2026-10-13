import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {Attempt} from '../steam/session-manager.ts';
import type {UuDeliveryConfig, UuStore, UuTokenEntry} from '../store/uu.ts';
import {uuTokenId} from '../store/uu.ts';
import {createUuService} from './index.ts';
import type {UuApi, UuClient} from './index.ts';
import {applyConfig, buildConfig, clampPollMs, createAccountState, maskUuToken, normalizeUuGameId, uuDefaultGameId} from './state.ts';
import type {AccountState} from './state.ts';

const jwt = (id: number, name: string) => 'h.' + Buffer.from(JSON.stringify({Id: id, Name: name, exp: 4102444800})).toString('base64url') + '.s';
const TOKEN_A = jwt(9001, 'uu-alpha');
const TOKEN_B = jwt(9002, 'uu-bravo');
const STEAM_ALPHA = '76561190000000011';

function memoryStore(config: UuDeliveryConfig | null = null, tokens: UuTokenEntry[] = []): UuStore & {config: UuDeliveryConfig | null; tokens: UuTokenEntry[]} {
	return {
		config,
		tokens,
		listTokens() {
			return this.tokens.map(entry => ({...entry}));
		},
		replaceTokens(entries) {
			this.tokens = entries.map(entry => ({...entry}));
		},
		findToken(id) {
			return this.tokens.find(entry => uuTokenId(entry) === id) ?? null;
		},
		loadDeliveryConfig() {
			return this.config ? JSON.parse(JSON.stringify(this.config)) : null;
		},
		saveDeliveryConfig(next) {
			this.config = JSON.parse(JSON.stringify(next));
		}
	};
}

interface Harness {
	service: ReturnType<typeof createUuService>;
	store: ReturnType<typeof memoryStore>;
	attempts: Map<string, Attempt>;
	events: Array<{event: string; payload: Record<string, unknown>}>;
	api: UuApi & {calls: string[]; smsMsg: string; smsUp: boolean; signInToken: string; linkedSteamId: Record<string, string>; invalid: Set<string>};
}

function harness(t: TestContext, store = memoryStore()): Harness {
	const calls: string[] = [];
	const fakeClient = (token: string, gameId: string): UuClient => ({
		async getWaitDeliverList() {
			calls.push(`list ${gameId} ${token === TOKEN_A ? 'A' : 'B'}`);
			return [];
		},
		async getSteamCookiePull() {
			calls.push(`pull ${gameId}`);
			const steamId = api.linkedSteamId[token];
			if (!steamId) {
				throw new Error('未绑定 Steam');
			}
			return {steamId};
		},
		getOrderDetail: async () => ({}),
		sendOffer: async () => true,
		getOfferStatus: async () => ({status: 3}),
		confirmOffer: async () => true,
		getDeliverableOrders: async () => [],
		getInventory: async () => [],
		sellItems: async () => ({success: 0, fail: 0}),
		getSellList: async () => [],
		changeSalePrice: async () => ({success: 0, fail: 0}),
		getMarketSaleListWithAbrade: async () => []
	});
	const api: Harness['api'] = {
		calls,
		smsMsg: '发送成功',
		smsUp: true,
		signInToken: TOKEN_A,
		linkedSteamId: {[TOKEN_A]: STEAM_ALPHA},
		invalid: new Set(),
		client: (token, opts) => fakeClient(token, opts.gameId),
		async connect(token, opts) {
			calls.push(`connect ${opts.gameId}`);
			if (api.invalid.has(token)) {
				throw new Error('获取待发货列表失败: 登录状态失效');
			}
			const payload = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString());
			return {getUserNickname: () => payload.Name, userId: payload.Id, jwtExp: payload.exp};
		},
		async getUk() {
			calls.push('uk');
			return 'REAL-UK';
		},
		async sendLoginSmsCode(phone, session, opts) {
			calls.push(`sms ${phone} uk=${opts.uk} headerUk=${opts.headers.uk}`);
			return {Msg: api.smsMsg};
		},
		async getSmsUpSignInConfig() {
			return api.smsUp ? {Code: 0, Data: {SmsUpContent: '登录', SmsUpNumber: '1069'}} : {Code: 1};
		},
		async smsSignIn(phone, code, session) {
			calls.push(`signIn ${phone} code=${code} session=${session.length}`);
			return api.signInToken ? {Data: {Token: api.signInToken}} : {Msg: '验证码错误'};
		}
	};
	const attempts = new Map<string, Attempt>();
	const events: Harness['events'] = [];
	const service = createUuService({
		store,
		attempts: () => attempts.values(),
		emit: (event, payload) => void events.push({event, payload: payload as Record<string, unknown>}),
		hasMaFile: name => name === 'has-mafile',
		api,
		sleep: async () => {},
		logger: {log() {}, warn() {}, error() {}}
	});
	t.after(() => service.stop());
	return {service, store, attempts, events, api};
}

function online(name: string, steamID: string, overrides: Partial<Attempt> = {}): Attempt {
	return {id: 'id-' + name, accountName: name, status: 'web_session', createdAt: 1, steamID, cookies: ['c=1'], identitySecret: 'ID', ...overrides} as unknown as Attempt;
}

test('游戏 id 归一、轮询间隔夹到 30 秒~120 分钟、token 掩码', () => {
	assert.equal(normalizeUuGameId('CS2'), '730');
	assert.equal(normalizeUuGameId('730'), '730');
	assert.equal(normalizeUuGameId(undefined), '440', '发货开关缺省 TF2');
	assert.equal(uuDefaultGameId(undefined), '730', '绑定/获取缺省 CS2');
	assert.equal(uuDefaultGameId('tf2'), '440');
	assert.equal(clampPollMs(1000), 30000);
	assert.equal(clampPollMs(999 * 60000), 120 * 60000);
	assert.equal(clampPollMs('abc'), 5 * 60000);
	assert.equal(maskUuToken('abcdefghijklmnopqrstuvwxyz'), 'abcd…uvwxyz');
	assert.equal(maskUuToken('short'), '****');
	assert.equal(maskUuToken(''), '');
});

test('配置:旧格式(单游戏 auto)迁移成对应游戏开关;存回去是新格式', () => {
	const states = new Map<string, AccountState>();
	const ensure = (name: string) => {
		const state = states.get(name) ?? createAccountState(name);
		states.set(name, state);
		return state;
	};
	const poll = applyConfig({
		__settings__: {pollIntervalMs: 10},
		legacy: {token: 'T1', gameId: '730'},
		legacyOff: {token: 'T2', auto: false},
		modern: {token: 'T3', gameId: '440', userId: 9, jwtExp: '100', delivery: {730: {auto: true}}, listAuto: true, listConfig: {maxPrice: 5}},
		noToken: {gameId: '730'}
	}, ensure);
	assert.equal(poll, 30000);
	assert.deepEqual([...states.keys()], ['legacy', 'legacyOff', 'modern']);
	assert.equal(states.get('legacy')?.byGame['730']?.auto, true);
	assert.equal(states.get('legacyOff')?.byGame['440']?.auto, false);
	assert.deepEqual([states.get('modern')?.byGame['730']?.auto, states.get('modern')?.byGame['440']?.auto], [true, false]);
	assert.deepEqual([states.get('modern')?.userId, states.get('modern')?.jwtExp, states.get('modern')?.listConfig], ['9', 100, {maxPrice: 5}]);

	const saved = buildConfig(states, 60000);
	assert.deepEqual(saved.__settings__, {pollIntervalMs: 60000});
	assert.deepEqual(saved.legacy?.delivery, {730: {auto: true}});
	assert.deepEqual(saved.modern?.delivery, {730: {auto: true}, 440: {auto: false}});
	assert.equal(applyConfig(null, ensure), null);
});

test('绑定:校验 token 后记下身份并持久化;校验失败报 400', async (t: TestContext) => {
	const h = harness(t);
	const account = await h.service.bind({accountName: 'alpha', token: TOKEN_A});
	assert.deepEqual([account.bound, account.nickname, account.userId, account.gameId, account.tokenMask], [true, 'uu-alpha', '9001', '730', maskUuToken(TOKEN_A)]);
	assert.equal(h.store.config?.alpha?.token, TOKEN_A);
	assert.ok(h.api.calls.includes('connect 730'), '不传游戏用 CS2 网关校验');
	assert.ok(h.events.some(e => e.event === 'uu:update' && e.payload.accountName === 'alpha'));
	assert.ok(h.events.some(e => e.event === 'uu:log' && String(e.payload.message).startsWith('已绑定 token：uu-alpha')));

	h.api.invalid.add(TOKEN_B);
	await assert.rejects(h.service.bind({accountName: 'bravo', token: TOKEN_B}), (err: Error & {statusCode?: number}) =>
		err.statusCode === 400 && err.message === 'token 校验失败: 获取待发货列表失败: 登录状态失效');
	await assert.rejects(h.service.bind({accountName: '', token: TOKEN_B}), /账号不能为空/);
	await assert.rejects(h.service.bind({accountName: 'x'}), /token 不能为空/);
	await assert.rejects(h.service.bind({accountName: 'x', tokenId: 'nope'}), (err: Error & {statusCode?: number}) => err.statusCode === 404);
});

test('绑定可以只给 tokenId(浏览器拿不到原文);列表只给掩码和 id', async (t: TestContext) => {
	const h = harness(t, memoryStore(null, [{token: TOKEN_A, userId: '9001', nickname: 'uu-alpha'}]));
	const [entry] = h.service.listTokens();
	assert.deepEqual(entry, {userId: '9001', nickname: 'uu-alpha', id: '9001', tokenMask: maskUuToken(TOKEN_A)});
	assert.ok(!JSON.stringify(h.service.listTokens()).includes(TOKEN_A));
	const account = await h.service.bind({accountName: 'alpha', tokenId: '9001'});
	assert.equal(account.bound, true);
});

test('自动发货开关:开了立即扫一轮并按间隔轮询;状态和账号列表', async (t: TestContext) => {
	t.mock.timers.enable({apis: ['setInterval']});
	const h = harness(t);
	h.attempts.set('a', online('alpha', STEAM_ALPHA));
	await h.service.bind({accountName: 'alpha', token: TOKEN_A});
	h.api.calls.length = 0;
	const view = h.service.setAuto('alpha', 'tf2', true);
	assert.equal(view.delivery['440']?.auto, true);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(h.api.calls, ['list 440 A'], '开启后马上扫一轮');
	t.mock.timers.tick(5 * 60 * 1000);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(h.api.calls, ['list 440 A', 'list 440 A'], '默认 5 分钟一轮');
	assert.deepEqual(h.store.config?.alpha?.delivery, {440: {auto: true}});

	const state = h.service.state();
	assert.equal(state.pollIntervalMs, 5 * 60 * 1000);
	assert.deepEqual(state.accounts.map(a => [a.accountName, a.online, a.hasIdentitySecret, a.steamID]), [['alpha', true, true, STEAM_ALPHA]]);

	assert.equal(h.service.setPollIntervalMinutes(1), 60000);
	assert.equal(h.store.config?.__settings__?.pollIntervalMs, 60000);
	await new Promise(resolve => setImmediate(resolve));
	h.api.calls.length = 0;
	t.mock.timers.tick(60000);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(h.api.calls, ['list 440 A'], '改间隔后按新间隔轮询');
	assert.throws(() => h.service.setPollIntervalMinutes(0), /有效的轮询分钟数/);

	h.service.setAuto('alpha', '440', false);
	h.api.calls.length = 0;
	t.mock.timers.tick(60 * 60 * 1000);
	assert.deepEqual(h.api.calls, [], '关掉后不再轮询');
	assert.throws(() => h.service.setAuto('nobody', '730', true), (err: Error & {statusCode?: number}) => err.statusCode === 409);
});

test('启动时读配置,开着的自动发货/上架恢复轮询', async (t: TestContext) => {
	t.mock.timers.enable({apis: ['setInterval']});
	const store = memoryStore({
		__settings__: {pollIntervalMs: 120000},
		alpha: {token: TOKEN_A, gameId: '730', userId: '9001', delivery: {730: {auto: true}, 440: {auto: false}}, listAuto: false}
	});
	const h = harness(t, store);
	h.service.start();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.service.pollIntervalMs(), 120000);
	assert.deepEqual(h.api.calls, [], '账号不在线:就绪检查不过,不打 UU 接口');
	const [account] = h.service.state().accounts;
	assert.equal(account?.delivery['730']?.auto, true);
	assert.equal(account?.delivery['730']?.stats.scans, 1, '启动时扫了一轮');
	assert.ok(account?.logs.some(log => log.message.includes('Steam 账号未在线')));
});

test('删除账号 token:停轮询、清绑定、按 UU userId 从 token 列表移除(含旧的重复条目)', async (t: TestContext) => {
	const store = memoryStore(null, [
		{token: TOKEN_A, userId: '9001'},
		{token: 'OLD-' + TOKEN_A, userId: '9001'},
		{token: TOKEN_B, userId: '9002'}
	]);
	const h = harness(t, store);
	await h.service.bind({accountName: 'alpha', token: TOKEN_A});
	h.service.setListAuto('alpha', true);
	const view = h.service.deleteToken({accountName: 'alpha'});
	assert.deepEqual([view?.bound, view?.listAuto, view?.userId], [false, false, '']);
	assert.deepEqual(store.tokens.map(entry => entry.userId), ['9002']);
	assert.equal(store.config?.alpha, undefined, '没 token 的账号不存配置');
	assert.deepEqual(h.service.state().accounts, []);
	assert.throws(() => h.service.deleteToken({accountName: 'alpha'}), (err: Error & {statusCode?: number}) => err.statusCode === 409);

	assert.equal(h.service.deleteToken({tokenId: '9002'}), null);
	assert.deepEqual(store.tokens, []);
	store.tokens = [{token: 'RAW', userId: ''}];
	h.service.deleteToken({token: 'RAW'});
	assert.deepEqual(store.tokens, []);
	assert.throws(() => h.service.deleteToken({}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
});

test('手动粘贴 token:解出身份、查绑定的 Steam,按 userId 去重存进列表', async (t: TestContext) => {
	const h = harness(t, memoryStore(null, [{token: 'STALE', userId: '9001'}]));
	const entry = await h.service.acquireToken({token: TOKEN_A});
	assert.deepEqual({...entry, acquiredAt: undefined}, {userId: '9001', nickname: 'uu-alpha', linkedSteamId: STEAM_ALPHA, jwtExp: 4102444800, acquiredAt: undefined, id: '9001', tokenMask: maskUuToken(TOKEN_A)});
	assert.deepEqual(h.store.tokens.map(t2 => t2.token), [TOKEN_A], '同一个 UU 账号覆盖旧条目');
	await h.service.acquireToken({token: TOKEN_B});
	assert.equal(h.store.tokens.length, 2);
	assert.equal(h.store.tokens[1]?.linkedSteamId, '', '查不到绑定的 Steam 不报错');
	await assert.rejects(h.service.acquireToken({token: ' '}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
});

test('短信登录:下行发码成功走验证码;失败改上行;都不行报 502;手机号要校验', async (t: TestContext) => {
	const h = harness(t);
	const sms = await h.service.loginStart('13800000000');
	assert.equal(sms.mode, 'sms');
	assert.ok(h.api.calls.includes('sms 13800000000 uk=REAL-UK headerUk=REAL-UK'), '真 uk 同时写进共享请求头');

	h.api.smsMsg = '该手机号需上行验证';
	const up = await h.service.loginStart('13800000001');
	assert.deepEqual([up.mode, up.smsUpContent, up.smsUpNumber], ['sms-up', '登录', '1069']);

	h.api.smsUp = false;
	await assert.rejects(h.service.loginStart('13800000002'), (err: Error & {statusCode?: number}) => err.statusCode === 502 && /上行短信配置也获取失败/.test(err.message));
	await assert.rejects(h.service.loginStart('abc'), (err: Error & {statusCode?: number}) => err.statusCode === 400);

	await assert.rejects(h.service.loginVerify({loginSessionId: sms.loginSessionId}), /请输入短信验证码/);
	await assert.rejects(h.service.loginVerify({loginSessionId: 'nope', code: '1'}), /登录会话不存在或已过期/);
	h.service.loginCancel(up.loginSessionId);
	await assert.rejects(h.service.loginVerify({loginSessionId: up.loginSessionId}), /登录会话不存在/);
});

test('短信登录验证:拿到 token 存进列表,按 UU 绑定的 SteamID 自动绑到已登录账号;返回里没有 token 原文', async (t: TestContext) => {
	const h = harness(t);
	h.attempts.set('a', online('alpha', STEAM_ALPHA));
	const {loginSessionId} = await h.service.loginStart('13800000000');
	const result = await h.service.loginVerify({loginSessionId, code: '1234'});
	assert.deepEqual([result.bound, result.autoBoundAccount, result.tokenId, result.linkedSteamId], [true, 'alpha', '9001', STEAM_ALPHA]);
	assert.equal(result.account?.nickname, 'uu-alpha');
	assert.ok(!JSON.stringify(result).includes(TOKEN_A), '不回传 token 原文');
	assert.equal(h.store.tokens[0]?.token, TOKEN_A);
	await assert.rejects(h.service.loginVerify({loginSessionId, code: '1234'}), /登录会话不存在/, '会话用过就删');

	// 指定账号:绑到指定的;没有匹配的已登录账号:只存不绑
	h.api.signInToken = TOKEN_B;
	const second = await h.service.loginStart('13800000000');
	const explicit = await h.service.loginVerify({loginSessionId: second.loginSessionId, code: '1', accountName: 'bravo'});
	assert.deepEqual([explicit.bound, explicit.autoBoundAccount, explicit.account?.accountName], [true, undefined, 'bravo']);
	const third = await h.service.loginStart('13800000000');
	h.api.linkedSteamId[TOKEN_B] = '76561190000099999';
	const unmatched = await h.service.loginVerify({loginSessionId: third.loginSessionId, code: '1'});
	assert.equal(unmatched.bound, false);

	h.api.signInToken = '';
	const fourth = await h.service.loginStart('13800000000');
	await assert.rejects(h.service.loginVerify({loginSessionId: fourth.loginSessionId, code: '1'}), /UU 登录失败: 验证码错误/);
});

test('未绑定账号的视图:有没有 maFile 看本地', (t: TestContext) => {
	const h = harness(t);
	assert.equal(h.service.view('has-mafile').hasMaFile, true);
	assert.deepEqual([h.service.view('other').hasMaFile, h.service.view('other').bound, h.service.view('other').gameId], [false, false, '440']);
});
