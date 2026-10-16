import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSessionManager, safeName} from './session-manager.ts';
import type {Attempt, Fingerprint, RestoreCredentials, SessionManagerOptions} from './session-manager.ts';
import type {SteamSession, SteamSessionStore} from '../store/steam-sessions.ts';
import type {LoginIntentStore} from '../store/login-intents.ts';

const LOGGED_IN_ELSEWHERE = 6;

class FakeClient extends EventEmitter {
	steamID: {getSteamID64(): string} | null = null;
	publicIP = '203.0.113.1';
	cellID = 7;
	logOnCalls: Record<string, unknown>[] = [];
	logOffCalls = 0;
	webLogOnCalls = 0;
	apiFails = true;
	logOn(details: Record<string, unknown>) {
		this.logOnCalls.push(details);
	}
	logOff() {
		this.logOffCalls++;
	}
	webLogOn() {
		this.webLogOnCalls++;
	}
	async _apiRequest(..._args: unknown[]): Promise<unknown> {
		if (this.apiFails) {
			throw new Error('network down');
		}
		return {ok: true};
	}
	/** 模拟一次完整登录成功 */
	succeed(steamId = '76561190000000001') {
		this.steamID = {getSteamID64: () => steamId};
		this.emit('loggedOn', {});
		this.emit('refreshToken', 'RT-' + steamId);
		this.emit('webSession', 'sessionid-1', ['steamLoginSecure=abc', 'sessionid=sessionid-1']);
	}
}

function fakeSessions(): SteamSessionStore & {data: Map<string, SteamSession>} {
	const data = new Map<string, SteamSession>();
	return {
		data,
		get: key => data.get(key) ?? null,
		put: (key, value) => void data.set(key, value),
		has: key => data.has(key),
		remove: keys => keys.filter(key => data.delete(key)).length
	};
}

function fakeIntents(initial: string[] = []): LoginIntentStore & {data: Map<string, boolean>} {
	const data = new Map<string, boolean>(initial.map(name => [name.toLowerCase(), true]));
	const names = new Map<string, string>(initial.map(name => [name.toLowerCase(), name]));
	return {
		data,
		setOnline(name, online) {
			data.set(name.toLowerCase(), online);
			names.set(name.toLowerCase(), name);
		},
		listOnline: () => [...data].filter(([, online]) => online).map(([key]) => names.get(key) ?? key),
		isOnline: name => data.get(name.toLowerCase()) === true,
		remove(list) {
			for (const name of list) {
				data.delete(name.toLowerCase());
			}
		}
	};
}

function setup(t: TestContext, overrides: Partial<SessionManagerOptions> = {}, intentsInitial: string[] = []) {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000});
	const clients: FakeClient[] = [];
	const changes: Attempt[] = [];
	const sessions = fakeSessions();
	const intents = fakeIntents(intentsInitial);
	const fingerprint: Fingerprint = {machineName: 'DESKTOP-TEST', machineIdFormat: null, userAgent: 'UA/1'};
	const manager = createSessionManager({
		createClient: () => {
			const client = new FakeClient();
			clients.push(client);
			return client;
		},
		getFingerprint: () => fingerprint,
		generateAuthCode: secret => 'C' + secret.slice(0, 4).toUpperCase(),
		fatalEResults: new Set([LOGGED_IN_ELSEWHERE]),
		cmFallbackServers: ['cm-fallback:443'],
		sessions,
		intents,
		onChange: attempt => void changes.push(attempt),
		currencyIdToIso: currency => (currency === 1 ? 'USD' : ''),
		resolveWalletCountry: attempt => (attempt.currencyISO === 'USD' ? 'US' : ''),
		logger: {log() {}, warn() {}},
		...overrides,
		timing: {
			loginTimeoutMs: 1000, loginRetryMax: 2, retryDelayMs: 100, reconnectGraceMs: 5000,
			reconnectBackoffBaseMs: 1000, reconnectBackoffCapMs: 4000, reconnectMaxAttempts: 2, restoreIntervalMs: 500,
			...overrides.timing
		}
	});
	const last = () => clients[clients.length - 1] as FakeClient;
	return {manager, clients, changes, sessions, intents, last, tick: (ms: number) => t.mock.timers.tick(ms)};
}

function loginWithPassword(manager: ReturnType<typeof setup>['manager'], accountName = 'alice', extra: Partial<Attempt> = {}) {
	const attempt = manager.createAttempt({accountName, remember: true, sharedSecret: (extra.sharedSecret as string) ?? ''});
	manager.startLogon(attempt, {accountName, password: 'pw', twoFactorCode: 'ONE-TIME'});
	return attempt;
}

test('密码登录成功:状态流转、保存 session、记下登录意图', t => {
	const {manager, last, sessions, intents, changes} = setup(t);
	const attempt = loginWithPassword(manager);
	const client = last();
	assert.equal(attempt.status, 'connecting');
	assert.deepEqual(client.logOnCalls[0], {accountName: 'alice', password: 'pw', twoFactorCode: 'ONE-TIME', machineName: 'DESKTOP-TEST'});
	assert.equal(attempt.userAgent, 'UA/1');

	client.emit('debug', 'some noisy line');
	const changesBeforeDebug = changes.length;
	client.emit('debug', 'another noisy line');
	assert.equal(changes.length, changesBeforeDebug, 'debug 不触发推送');

	client.emit('wallet', true, 1, 12.5);
	assert.equal(attempt.currencyISO, 'USD');
	assert.equal(attempt.country, 'US');

	client.succeed();
	assert.equal(attempt.status, 'web_session');
	assert.equal(attempt.steamID, '76561190000000001');
	assert.equal(client.webLogOnCalls, 1);
	assert.equal(attempt.webSessionID, 'sessionid-1');
	assert.deepEqual(sessions.get('alice')?.cookies, ['steamLoginSecure=abc', 'sessionid=sessionid-1']);
	assert.equal(sessions.get('alice')?.refreshToken, 'RT-76561190000000001');
	assert.equal(intents.isOnline('alice'), true);

	const pub = manager.publicAttempt(attempt);
	assert.ok(pub.logs.length > 0 && pub.logs.every(entry => entry.level !== 'debug'), '推送给前端的日志不含 debug');
	assert.ok(!('client' in pub) && !('refreshToken' in pub) && !('cookies' in pub), '不暴露客户端和凭据');

	t.mock.timers.tick(5000);
	assert.equal(attempt.status, 'web_session', '登录完成后看门狗不再触发');
});

test('同一账号再次登录:旧会话被登出并移出会话表,旧事件不再推送', t => {
	const {manager, clients, changes} = setup(t);
	const first = loginWithPassword(manager, 'Alice');
	clients[0]?.succeed();
	assert.equal(manager.activeAttemptFor('alice'), first);

	const second = manager.createAttempt({accountName: 'ALICE'});
	assert.equal(clients[0]?.logOffCalls, 1);
	assert.equal(manager.get(first.id), undefined);
	assert.equal(manager.attempts.size, 1);
	assert.equal(first.disposed, true);

	const before = changes.length;
	clients[0]?.emit('disconnected', 0, 'bye');
	clients[0]?.emit('error', {eresult: 2, message: 'late error'});
	assert.equal(changes.length, before, '被替换的会话不再推送');
	assert.notEqual(first.status, 'disconnected');

	manager.startLogon(second, {accountName: 'ALICE', password: 'pw'});
	assert.equal(manager.activeAttemptFor('alice'), second);
});

test('移动令牌:有 shared_secret 自动提交;没有则等用户输入', t => {
	const {manager, last, tick} = setup(t);
	const auto = manager.createAttempt({accountName: 'auto', sharedSecret: 'secretXYZ'});
	manager.startLogon(auto, {accountName: 'auto', password: 'pw'});
	let submitted = '';
	last().emit('steamGuard', null, (code: string) => {
		submitted = code;
	}, false);
	assert.equal(submitted, 'CSECR');
	assert.equal(auto.status, 'connecting');

	const manual = manager.createAttempt({accountName: 'manual'});
	manager.startLogon(manual, {accountName: 'manual', password: 'pw'});
	let manualCode = '';
	last().emit('steamGuard', 'gmail.com', (code: string) => {
		manualCode = code;
	}, true);
	assert.equal(manual.status, 'guard_required');
	assert.deepEqual(manual.guard, {type: 'email', domain: 'gmail.com', lastCodeWrong: true});
	tick(5000);
	assert.equal(manual.status, 'guard_required', '等验证码期间看门狗暂停');
	manager.submitGuardCode(manual, 'ABCDE');
	assert.equal(manualCode, 'ABCDE');
	assert.equal(manual.status, 'connecting');
	assert.equal(manual.guard, null);
});

test('登录看门狗:超时后用同一客户端重试(丢掉一次性验证码),超过次数判失败', t => {
	const {manager, last, tick} = setup(t);
	const attempt = loginWithPassword(manager);
	const client = last();
	tick(1000);
	assert.equal(client.logOffCalls, 1);
	tick(100);
	assert.equal(client.logOnCalls.length, 2);
	assert.equal(client.logOnCalls[1]?.twoFactorCode, undefined, '重试时去掉过期的一次性验证码');
	assert.equal(client.logOnCalls[1]?.password, 'pw');
	tick(1000);
	tick(100);
	assert.equal(client.logOnCalls.length, 3);
	tick(1000);
	assert.equal(attempt.status, 'failed');
	assert.match(attempt.logs.at(-1)?.message ?? '', /重试 2 次仍未成功/);
});

test('致命错误(被顶号):判失败、不自动重连、清掉登录意图', t => {
	const {manager, last, intents, tick} = setup(t);
	const attempt = loginWithPassword(manager);
	last().succeed();
	assert.equal(intents.isOnline('alice'), true);
	last().emit('error', {eresult: LOGGED_IN_ELSEWHERE, message: 'LoggedInElsewhere'});
	assert.equal(attempt.status, 'failed');
	assert.equal(attempt.reconnectBlocked, true);
	assert.equal(intents.isOnline('alice'), false);
	tick(60_000);
	manager.reconnectTick();
	assert.equal(last().logOnCalls.length, 1, '致命错误后不重连');
});

test('掉线重连看门狗:过了宽限期才重连,指数退避,超过次数放弃', t => {
	// 登录看门狗调长,只看重连看门狗本身的行为
	const {manager, last, tick, intents} = setup(t, {timing: {loginTimeoutMs: 600_000}});
	const attempt = loginWithPassword(manager);
	const client = last();
	client.succeed();
	client.emit('disconnected', 3, 'NoConnection');
	assert.equal(attempt.status, 'disconnected');

	tick(4000);
	manager.reconnectTick();
	assert.equal(client.logOnCalls.length, 1, '宽限期内交给 autoRelogin');

	tick(1000);
	manager.reconnectTick();
	assert.equal(attempt.reconnectAttempts, 1);
	tick(100);
	assert.equal(client.logOnCalls.length, 2);
	attempt.status = 'disconnected';   // 模拟重连没成功又断了

	manager.reconnectTick();
	assert.equal(attempt.reconnectAttempts, 1, '退避期内不重连');
	tick(1000);
	manager.reconnectTick();
	assert.equal(attempt.reconnectAttempts, 2);
	tick(100);
	attempt.status = 'disconnected';
	tick(2000);
	manager.reconnectTick();
	assert.equal(attempt.reconnectGaveUp, true);
	assert.match(attempt.logs.at(-1)?.message ?? '', /已停止自动重连/);
	assert.equal(intents.isOnline('alice'), true, '网络问题放弃重连不清意图,重启后仍会恢复');
});

test('手动登出:清掉登录意图', t => {
	const {manager, last, intents} = setup(t);
	const attempt = loginWithPassword(manager);
	last().succeed();
	manager.logout(attempt);
	assert.equal(attempt.status, 'logged_out');
	assert.equal(intents.isOnline('alice'), false);
	assert.equal(manager.activeAttemptFor('alice'), null);
});

test('删除账号:登出、移出会话表、清意图,并给出要删的 session key', t => {
	const {manager, last, intents} = setup(t);
	const attempt = loginWithPassword(manager, 'Bob.X');
	last().succeed('76561190000000099');
	const result = manager.removeAccounts(['Bob.X'], ['some-id']);
	assert.equal(result.removedAttempts, 1);
	assert.equal(manager.get(attempt.id), undefined);
	assert.equal(last().logOffCalls, 1);
	assert.equal(intents.isOnline('Bob.X'), false);
	assert.deepEqual(result.sessionKeys.sort(), ['Bob.X', 'some-id'].map(safeName).sort());
});

test('目录服务不可达时改用本地 CM 列表', async t => {
	const {manager, last} = setup(t);
	const attempt = loginWithPassword(manager);
	const client = last();
	const result = await client._apiRequest('GET', 'ISteamDirectory', 'GetCMListForConnect', 1, {});
	assert.deepEqual(result, {response: {serverlist: ['cm-fallback:443']}});
	assert.equal(attempt.cmFallbackApplied, true);
	await assert.rejects(client._apiRequest('GET', 'IOther', 'Method', 1, {}), /network down/);
});

test('重启恢复:按意图逐个登录,优先 refreshToken,没有就用密码', t => {
	const {manager, clients, tick, intents} = setup(t, {}, ['alice', 'bob', 'ghost', 'nocreds']);
	const creds: Record<string, RestoreCredentials | null> = {
		alice: {profile: {accountName: 'alice', remember: true, sharedSecret: 'aaaa1111'}, refreshToken: 'RT-ALICE', password: 'pw-a'},
		bob: {profile: {accountName: 'bob', remember: true, sharedSecret: 'bbbb2222', identitySecret: 'IS'}, refreshToken: '', password: 'pw-b'},
		ghost: null,
		nocreds: {profile: {accountName: 'nocreds'}, refreshToken: '', password: ''}
	};
	const scheduled = manager.restoreAll(name => creds[name] ?? null);
	assert.deepEqual(scheduled, ['alice', 'bob', 'ghost', 'nocreds']);

	tick(0);
	assert.equal(clients.length, 1);
	assert.deepEqual(clients[0]?.logOnCalls[0], {refreshToken: 'RT-ALICE', machineName: 'DESKTOP-TEST'});
	tick(500);
	assert.equal(clients.length, 2);
	assert.deepEqual(clients[1]?.logOnCalls[0], {accountName: 'bob', password: 'pw-b', twoFactorCode: 'CBBBB', machineName: 'DESKTOP-TEST'});
	assert.equal(manager.activeAttemptFor('bob')?.identitySecret, 'IS');
	tick(500);
	assert.equal(intents.data.has('ghost'), false, '账号已删除:清掉意图');
	tick(500);
	assert.equal(intents.isOnline('nocreds'), false, '没有任何凭据:放弃并清意图');
	assert.equal(clients.length, 2);
});

test('重启恢复:refreshToken 失效时改用密码登录一次', t => {
	const {manager, clients, tick} = setup(t, {}, ['alice']);
	manager.restoreAll(() => ({profile: {accountName: 'alice', sharedSecret: 'aaaa1111'}, refreshToken: 'RT-OLD', password: 'pw-a'}));
	tick(0);
	const client = clients[0] as FakeClient;
	const attempt = manager.activeAttemptFor('alice') as Attempt;
	client.emit('error', {eresult: 15, message: 'AccessDenied'});
	assert.equal(attempt.status, 'connecting', '不判失败,转去用密码');
	tick(100);
	assert.equal(client.logOnCalls.length, 2);
	assert.equal(client.logOnCalls[1]?.password, 'pw-a');
	assert.equal(client.logOnCalls[1]?.refreshToken, undefined);
	client.succeed();
	assert.equal(attempt.status, 'web_session');

	client.emit('error', {eresult: 2, message: 'Fail'});
	assert.equal(attempt.status, 'failed', '只回退一次');
});

test('已经手动登录的账号不再自动恢复', t => {
	const {manager, clients, tick} = setup(t, {}, ['alice']);
	loginWithPassword(manager);
	manager.restoreAll(() => ({profile: {accountName: 'alice'}, refreshToken: 'RT', password: 'pw'}));
	tick(0);
	assert.equal(clients.length, 1);
});

test('停服:登出全部会话、取消待执行的恢复,不改登录意图', t => {
	const {manager, clients, tick, intents} = setup(t, {}, ['alice', 'bob']);
	manager.restoreAll(name => ({profile: {accountName: name}, refreshToken: 'RT-' + name, password: ''}));
	tick(0);
	clients[0]?.succeed();
	assert.equal(manager.shutdown(), 1);
	assert.equal(clients[0]?.logOffCalls, 1);
	tick(10_000);
	assert.equal(clients.length, 1, 'bob 的恢复被取消');
	assert.equal(intents.isOnline('alice'), true);
	assert.equal(intents.isOnline('bob'), true);
});

test('代理的登录速率限制:排队时先不 logOn、不计登录超时,轮到再登(移动令牌重新生成);排队中登出或重试的那次不再登', async t => {
	const queued: Array<{accountName: string; cancelled: () => boolean; release(granted: boolean): void}> = [];
	const {manager, last, tick} = setup(t, {
		queueLogon: (accountName, cancelled) => {
			let release!: (granted: boolean) => void;
			const ready = new Promise<boolean>(resolve => (release = resolve));
			queued.push({accountName, cancelled, release});
			return {waitMs: 42000, ready};
		}
	});
	const flush = () => new Promise<void>(resolve => setImmediate(resolve));

	const attempt = loginWithPassword(manager, 'alice', {sharedSecret: 'secretXYZ'});
	const client = last();
	assert.deepEqual(queued.map(item => item.accountName), ['alice']);
	assert.equal(client.logOnCalls.length, 0, '排队时不登');
	assert.equal(attempt.status, 'connecting');
	assert.match(attempt.logs.at(-1)?.message ?? '', /排队中\(约 42 秒后开始\)/);
	tick(5000);
	assert.equal(client.logOffCalls, 0, '排队的时间不算登录超时');

	queued[0]!.release(true);
	await flush();
	assert.deepEqual(client.logOnCalls[0], {accountName: 'alice', password: 'pw', twoFactorCode: 'CSECR', machineName: 'DESKTOP-TEST'}, '排过队的验证码重新生成');
	tick(1000);
	tick(100);
	assert.equal(queued.length, 2, '超时重试也排队');
	assert.equal(client.logOnCalls.length, 1);
	manager.logout(attempt);
	assert.equal(queued[1]!.cancelled(), true, '登出了,轮到时跳过');
	queued[1]!.release(true);
	await flush();
	assert.equal(client.logOnCalls.length, 1, '登出后不再登');

	const bob = loginWithPassword(manager, 'bob');
	const bobClient = last();
	manager.startLogon(bob, {accountName: 'bob', password: 'pw2'});
	assert.equal(queued[2]!.cancelled(), true, '同一会话又发起了登录(换了客户端),前一次作废');
	assert.equal(bobClient.logOnCalls.length, 0);
});

test('代理的登录速率限制:掉线重连排着队时 steam-user 自己重登回来了,轮到时不再登', async t => {
	const queued: Array<{cancelled: () => boolean; release(granted: boolean): void}> = [];
	let limited = false;
	const {manager, last, tick} = setup(t, {
		timing: {loginTimeoutMs: 600_000},
		queueLogon: (_accountName, cancelled) => {
			if (!limited) {
				return null;
			}
			let release!: (granted: boolean) => void;
			const ready = new Promise<boolean>(resolve => (release = resolve));
			queued.push({cancelled, release});
			return {waitMs: 60000, ready};
		}
	});
	const attempt = loginWithPassword(manager);
	const client = last();
	client.succeed();
	assert.equal(attempt.status, 'web_session');
	limited = true;
	client.emit('disconnected', 3, 'NoConnection');
	tick(5000);
	manager.reconnectTick();
	tick(100);
	assert.equal(queued.length, 1, '掉线重连在排队');
	client.succeed();
	assert.equal(queued[0]!.cancelled(), true, '已经在线了,这次作废');
	queued[0]!.release(true);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(client.logOnCalls.length, 1, '不再 logOn');
	assert.equal(attempt.status, 'web_session');
});
