import {test} from 'node:test';
import assert from 'node:assert/strict';
import {migrate, openDatabase} from '../core/db.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {createAccountGroupStore} from '../store/account-groups.ts';
import {normalizeStoredAccount} from '../store/accounts.ts';
import type {AccountStore, StoredAccount} from '../store/accounts.ts';
import {MIGRATIONS} from '../store/schema.ts';
import {createCountryLookup} from './country.ts';
import {createAccountService, createProfiles, resolveAccountCountry} from './index.ts';
import {findStoredAccount, mergeClientAccountSecrets, publicStoredAccount} from './profiles.ts';

const COOKIES = 'cookies';
const CACHE = 'account_cache.json';

function memoryAccounts(initial: unknown[] = []): AccountStore {
	let list = initial.map(normalizeStoredAccount).filter(Boolean) as StoredAccount[];
	let initialized = false;
	return {
		list: () => structuredClone(list),
		get: name => structuredClone(list.find(a => a.accountName.toLowerCase() === name.toLowerCase()) ?? null),
		replaceAll(items) {
			list = items.map(normalizeStoredAccount).filter(Boolean) as StoredAccount[];
			initialized = true;
			return structuredClone(list);
		},
		removeByNames(names) {
			const before = list.length;
			list = list.filter(a => !names.some(n => n.toLowerCase() === a.accountName.toLowerCase()));
			return list.length !== before;
		},
		isInitialized: () => initialized
	};
}

function world(files: Record<string, unknown> = {}, mafiles: Record<string, Record<string, unknown>> = {}, sessions: Record<string, Record<string, unknown>> = {}) {
	const mafileMap = new Map(Object.entries(mafiles).map(([k, v]) => [k.toLowerCase(), v]));
	const sessionMap = new Map(Object.entries(sessions));
	const store = {
		mafiles: {get: (name: string) => mafileMap.get(name.toLowerCase()) ?? null, put: (name: string, value: Record<string, unknown>) => void mafileMap.set(name.toLowerCase(), value)},
		sessions: {
			get: (key: string) => sessionMap.get(key) ?? null,
			remove: (keys: readonly string[]) => keys.filter(key => sessionMap.delete(key)).length
		}
	};
	const profiles = createProfiles({
		mafiles: store.mafiles, sessions: store.sessions, cookiesDir: COOKIES, accountCacheFile: CACHE,
		readJson: file => files[file.replace(/\\/g, '/')] ?? null
	});
	return {store, profiles, mafileMap, sessionMap};
}

test('账号资料:maFile 的令牌密钥和 refreshToken;旧版 cookies 文件兜底 refreshToken;缓存给钱包和国家', () => {
	const {profiles} = world({
		'cookies/bravo.json': {refreshToken: ' RT-file '},
		'cookies/alpha.json': {refreshToken: 'RT-ignored'},
		[CACHE]: {Alpha: {currency: 23, balance: 3.5, country: 'jp'}, bravo: {currency: null, currencyISO: '', balance: null, country: 'jp'}}
	}, {alpha: {shared_secret: ' SS ', identity_secret: 'IS', SteamID: '7656a', Session: {RefreshToken: 'RT-ma'}}});
	assert.deepEqual(profiles.local(' alpha '), {
		accountName: 'alpha', hasMaFile: true, sharedSecret: 'SS', identitySecret: 'IS', refreshToken: 'RT-ma', steamID: '7656a',
		country: 'CN', hasWallet: true, currency: 23, currencyISO: 'CNY', balance: 3.5
	});
	const bravo = profiles.local('bravo');
	assert.deepEqual([bravo.hasMaFile, bravo.refreshToken, bravo.country, bravo.hasWallet], [false, 'RT-file', 'JP', false], '没有币种时用缓存里的国家');
	assert.equal(profiles.local('').accountName, '');
});

test('国家:币种能对上国家就用它,没有币种才用缓存的国家', () => {
	assert.equal(resolveAccountCountry({currency: 23}), 'CN');
	assert.equal(resolveAccountCountry({currencyISO: 'eur', country: 'jp'}), 'EU', '有币种就不看缓存的国家');
	assert.equal(resolveAccountCountry({currencyISO: 'XYZ', country: 'jp'}), '', '币种对不上国家时也不看缓存的国家');
	assert.equal(resolveAccountCountry({country: 'jp'}), 'JP');
	assert.equal(resolveAccountCountry(null), '');
});

test('cookies:内存里的 → 会话库 → 旧版 cookies 文件(cookies 数组或 cookieHeader)', () => {
	const {profiles} = world({
		'cookies/legacy.json': {cookieHeader: 'a=1; b=2'},
		'cookies/arr.json': {cookies: ['c=3']}
	}, {}, {saved: {cookies: ['s=1']}, '7656': {cookies: ['by-steamid=1']}});
	assert.deepEqual(profiles.cookiesFor({accountName: 'x', cookies: ['live=1']}), ['live=1']);
	assert.deepEqual(profiles.cookiesFor({accountName: 'saved', cookies: []}), ['s=1']);
	assert.deepEqual(profiles.cookiesFor({accountName: '', steamID: '7656'}), ['by-steamid=1']);
	assert.deepEqual(profiles.cookiesFor({accountName: 'legacy'}), ['a=1', 'b=2']);
	assert.deepEqual(profiles.cookiesFor({accountName: 'arr'}), ['c=3']);
	assert.deepEqual(profiles.cookiesFor({accountName: 'none'}), []);
});

test('名单:下发不含密钥;推回来的空密钥沿用已存的', () => {
	const accounts = memoryAccounts([{accountName: 'Alpha', password: 'pw', sharedSecret: 'SS', twoFactorCode: '1'}]);
	const merged = mergeClientAccountSecrets(accounts, [{accountName: 'alpha', password: ''}, {accountName: 'new', password: 'pw-n'}, null, {}]);
	assert.deepEqual(merged.map(a => [a.accountName, a.password, a.sharedSecret, a.twoFactorCode]), [['alpha', 'pw', 'SS', '1'], ['new', 'pw-n', '', '']]);
	const pub = publicStoredAccount(merged[0] as StoredAccount);
	assert.ok(!('password' in pub) && !('sharedSecret' in pub) && !('twoFactorCode' in pub));
	assert.deepEqual([pub.hasPassword, pub.hasSharedSecret], [true, true]);
	assert.equal(findStoredAccount(accounts, ' ALPHA ')?.accountName, 'Alpha');
	assert.equal(findStoredAccount(accounts, ''), null);
});

// ===== 商店账户页查国家 =====

function accountPage(script: (cookie: string) => Response) {
	const seen: string[] = [];
	const http = (async (url: string, init: RequestInit) => {
		const cookie = String((init.headers as Record<string, string>).Cookie);
		seen.push(`${url} | ${cookie}`);
		return script(cookie);
	}) as unknown as typeof fetch;
	return {http, seen};
}

const loggedInPage = (country: string) => new Response(`<div id="account_pulldown"></div><div data-config="{&quot;COUNTRY&quot;:&quot;${country}&quot;}"></div>`);

test('查国家:手动跟随重定向并累积 cookie;跳登录页、没登录、HTTP 错误都报错', async () => {
	const page = accountPage(cookie => cookie.includes('browserid=')
		? loggedInPage('uy')
		: new Response('', {status: 302, headers: {location: '/account/', 'set-cookie': 'browserid=42; Path=/'}}));
	const events = {addLog() {}, saveSession() {}, emit() {}};
	const lookup = createCountryLookup({cookiesFor: () => ['steamLoginSecure=x'], events, fetch: page.http});
	assert.equal(await lookup.lookup({accountName: 'a'}), 'UY');
	assert.deepEqual(page.seen, [
		'https://store.steampowered.com/account/ | steamLoginSecure=x',
		'https://store.steampowered.com/account/ | steamLoginSecure=x; browserid=42'
	]);

	const login = accountPage(() => new Response('', {status: 302, headers: {location: 'https://store.steampowered.com/login/?redir=account'}}));
	await assert.rejects(createCountryLookup({cookiesFor: () => ['a=1'], events, fetch: login.http}).lookup({accountName: 'a'}), /跳转到登录页/);
	const guest = accountPage(() => new Response('<html>guest</html>'));
	await assert.rejects(createCountryLookup({cookiesFor: () => ['a=1'], events, fetch: guest.http}).lookup({accountName: 'a'}), /未登录/);
	const byId = accountPage(() => new Response('7656x "countrycode":"jp"'));
	assert.equal(await createCountryLookup({cookiesFor: () => ['a=1'], events, fetch: byId.http}).lookup({accountName: 'a', steamID: '7656x'}), 'JP', '页面里有自己的 SteamID 也算已登录');
	assert.equal(await createCountryLookup({cookiesFor: () => [], events, fetch: guest.http}).lookup({accountName: 'a'}), '', '没 cookie 不查');
});

test('登录后刷新国家:变了才更新、记日志、保存、推送;失败记 warn', async () => {
	const calls: string[] = [];
	const events = {
		addLog: (a: Attempt, level: string, message: string) => void calls.push(`${level}:${message}`),
		saveSession: () => void calls.push('save'),
		emit: () => void calls.push('emit')
	};
	const attempt = {accountName: 'alpha', country: 'US'} as Attempt;
	createCountryLookup({cookiesFor: () => ['a=1'], events, fetch: accountPage(() => loggedInPage('UY')).http}).refresh(attempt);
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(attempt.country, 'UY');
	assert.deepEqual(calls, ['info:账户国家/地区: UY', 'save', 'emit']);

	calls.length = 0;
	createCountryLookup({cookiesFor: () => ['a=1'], events, fetch: accountPage(() => new Response('', {status: 500})).http}).refresh(attempt);
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.deepEqual(calls, ['warn:获取账户国家失败: 账户页 HTTP 500(cookie 可能已失效)']);
});

test('账户列表补国家:命中缓存不再请求;失败的 5 分钟内不再查', async () => {
	let clock = 1_000_000;
	let requests = 0;
	const events = {addLog() {}, saveSession() {}, emit() {}};
	const page = accountPage(cookie => {
		requests++;
		return cookie.includes('dead') ? new Response('', {status: 500}) : loggedInPage('UY');
	});
	const lookup = createCountryLookup({cookiesFor: a => a.accountName === 'none' ? [] : [`steamLoginSecure=${a.accountName}`], events, fetch: page.http, now: () => clock});
	const accounts = {good: {country: ''}, dead: {country: ''}, known: {country: 'CN'}};
	await lookup.fillMissing(accounts);
	assert.deepEqual([accounts.good.country, accounts.dead.country, accounts.known.country], ['UY', '', 'CN']);
	assert.equal(requests, 2);
	const again = {good: {country: ''}, dead: {country: ''}};
	await lookup.fillMissing(again);
	assert.equal(again.good.country, 'UY');
	assert.equal(requests, 2, '成功的走缓存,失败的在冷却期');
	clock += 6 * 60 * 1000;
	await lookup.fillMissing({dead: {country: ''}});
	assert.equal(requests, 3);
});

// ===== 服务 =====

function fakeSessions() {
	const attempts = new Map<string, Attempt>();
	const calls: unknown[] = [];
	let seq = 0;
	return {
		calls,
		attempts,
		list: () => Array.from(attempts.values()),
		activeAttemptFor: (name: string) => Array.from(attempts.values()).find(a => a.accountName === name && a.status === 'web_session') ?? null,
		createAttempt(profile: Record<string, unknown>) {
			const attempt = {...profile, id: 'att-' + (++seq), status: 'created', logs: [], guardCallback: null, client: null} as unknown as Attempt;
			attempts.set(attempt.id, attempt);
			calls.push(['create', profile]);
			return attempt;
		},
		startLogon: (attempt: Attempt, details: unknown) => void calls.push(['startLogon', attempt.id, details]),
		startPreferredLogon: (attempt: Attempt, refreshToken: string, passwordDetails: unknown) => void calls.push(['preferred', attempt.id, refreshToken, passwordDetails]),
		submitGuardCode: (attempt: Attempt, code: string) => void calls.push(['guard', attempt.id, code]),
		logout: (attempt: Attempt) => void calls.push(['logout', attempt.id]),
		removeAccounts: (names: readonly string[], ids: readonly string[]) => ({removedAttempts: names.length + ids.length, sessionKeys: ['alpha', 'gone']}),
		saveSession: () => {},
		addLog: (attempt: Attempt, level: string, message: string) => void (attempt.logs as unknown as string[]).push(`${level}:${message}`),
		emit: (attempt: Attempt) => void calls.push(['emit', attempt.id]),
		publicAttempt: (attempt: Attempt) => ({id: attempt.id, status: attempt.status, logs: attempt.logs}) as never
	};
}

function service(accounts: unknown[] = [], files: Record<string, unknown> = {}, mafiles: Record<string, Record<string, unknown>> = {}) {
	const w = world(files, mafiles, {alpha: {refreshToken: 'RT-saved'}});
	const sessions = fakeSessions();
	const accountStore = memoryAccounts(accounts);
	const db = openDatabase(':memory:');
	migrate(db, MIGRATIONS);
	const groupStore = createAccountGroupStore(db);
	const svc = createAccountService({
		store: {accounts: accountStore, groups: groupStore, mafiles: w.store.mafiles, sessions: w.store.sessions},
		sessions: sessions as never,
		profiles: w.profiles,
		totp: {generateAuthCode: secret => {
			if (secret === 'BAD') {
				throw new Error('bad secret');
			}
			return 'C-' + secret;
		}, time: () => 1700000017},
		now: () => Date.parse('2026-10-13T00:00:00Z'),
		fetch: (async () => new Response('', {status: 500})) as typeof fetch,
		sleep: async () => {},
		logger: {warn() {}}
	});
	return {svc, sessions, accountStore, groupStore, ...w};
}

test('登录:有存下的 refreshToken 先用它(账密作后备,不预先生成令牌);在线时复用,force 才重登;请求里带了密码或验证码按账密登', () => {
	const {svc, sessions} = service([{accountName: 'alpha', password: 'pw-list', remember: false}], {}, {alpha: {shared_secret: 'SS', identity_secret: 'IS'}});
	const first = svc.login({accountName: ' alpha '});
	assert.equal(first.reused, undefined);
	assert.deepEqual(sessions.calls[0], ['create', {
		accountName: 'alpha', remember: false, sharedSecret: 'SS', identitySecret: 'IS', hasMaFile: true, country: '', hasWallet: false, currency: null, currencyISO: '', balance: null
	}]);
	assert.deepEqual(sessions.calls[1], ['preferred', 'att-1', 'RT-saved', {accountName: 'alpha', password: 'pw-list', twoFactorCode: undefined}]);
	assert.deepEqual(first.attempt, {id: 'att-1', status: 'created', logs: [
		'info:已从本地 maFile 载入 shared_secret', 'info:已从本地 maFile 载入 identity_secret（用于发货确认）'
	]});

	(sessions.attempts.get('att-1') as Attempt).status = 'web_session';
	assert.equal(svc.login({accountName: 'alpha'}).reused, true);
	assert.equal(svc.login({accountName: 'alpha', force: true, twoFactorCode: '99999', password: 'pw-body'}).attempt.id, 'att-2');
	assert.deepEqual(sessions.calls.at(-1), ['preferred', 'att-2', '', {accountName: 'alpha', password: 'pw-body', twoFactorCode: '99999'}]);
	assert.throws(() => svc.login({accountName: 'nobody'}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
});

test('登录:没存 refreshToken 的按账密登(shared_secret 预先生成令牌);名单里没密码但有 refreshToken 的也能登', () => {
	const noToken = service([{accountName: 'bravo', password: 'pw-b'}], {}, {bravo: {shared_secret: 'SB'}});
	noToken.svc.login({accountName: 'bravo'});
	assert.deepEqual(noToken.sessions.calls.at(-1), ['preferred', 'att-1', '', {accountName: 'bravo', password: 'pw-b', twoFactorCode: 'C-SB'}]);

	const tokenOnly = service([{accountName: 'alpha'}]);
	tokenOnly.svc.login({accountName: 'alpha'});
	assert.deepEqual(tokenOnly.sessions.calls.at(-1), ['preferred', 'att-1', 'RT-saved', null]);
});

test('令牌生成失败只记 warn,照样登录;refreshToken 登录', () => {
	const {svc, sessions} = service([{accountName: 'echo', password: 'pw', sharedSecret: 'BAD'}]);
	const res = svc.login({accountName: 'echo'});
	assert.ok((res.attempt as unknown as {logs: string[]}).logs.includes('warn:shared_secret 无法生成验证码: bad secret'));
	assert.deepEqual(sessions.calls.at(-1), ['preferred', 'att-1', '', {accountName: 'echo', password: 'pw', twoFactorCode: undefined}]);

	svc.loginWithRefreshToken({accountName: 'echo', refreshToken: ' RT ', remember: 1});
	assert.deepEqual(sessions.calls.at(-1), ['startLogon', 'att-2', {refreshToken: 'RT'}]);
	assert.throws(() => svc.loginWithRefreshToken({accountName: 'echo'}), /refreshToken 不能为空/);
});

test('Guard / WebSession / 登出 / GC:按 id 找会话,状态不对给 4xx', () => {
	const {svc, sessions} = service();
	const attempt = sessions.createAttempt({accountName: 'alpha'});
	assert.throws(() => svc.submitGuard('nope', {code: '1'}), (err: Error & {statusCode?: number}) => err.statusCode === 404);
	assert.throws(() => svc.submitGuard(attempt.id, {code: ' '}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
	assert.throws(() => svc.submitGuard(attempt.id, {code: '1'}), (err: Error & {statusCode?: number}) => err.statusCode === 409);
	attempt.guardCallback = () => {};
	svc.submitGuard(attempt.id, {code: ' 24680 '});
	assert.deepEqual(sessions.calls.at(-1), ['guard', attempt.id, '24680']);

	assert.throws(() => svc.requestWebSession(attempt.id), (err: Error & {statusCode?: number}) => err.statusCode === 409);
	const played: unknown[] = [];
	attempt.client = {steamID: {}, webLogOn: () => void played.push('webLogOn'), gamesPlayed: (apps: unknown) => void played.push(apps)} as never;
	assert.equal(svc.requestWebSession(attempt.id).attempt.status, 'web_session_pending');
	svc.connectGc(attempt.id, '440');
	assert.deepEqual(played, ['webLogOn', [440], 'webLogOn', 'webLogOn']);
	assert.equal(attempt.activeGame, 'tf2');
	svc.disconnectGc(attempt.id, 'cs2');
	assert.deepEqual(played.at(-1), []);
	attempt.status = 'logged_out';
	assert.throws(() => svc.connectGc(attempt.id, 'cs2'), (err: Error & {statusCode?: number}) => err.statusCode === 409);

	svc.logout(attempt.id);
	assert.deepEqual(sessions.calls.at(-1), ['logout', attempt.id]);
	assert.throws(() => svc.cookies(attempt.id), (err: Error & {statusCode?: number}) => err.statusCode === 404);
	attempt.cookies = ['a=1', 'b=2'];
	assert.deepEqual(svc.cookies(attempt.id), {cookies: ['a=1', 'b=2'], cookieHeader: 'a=1; b=2'});
});

test('删除账号:会话、加密库里的 session、名单一并清掉', () => {
	const {svc, sessionMap, accountStore} = service([{accountName: 'alpha'}, {accountName: 'bravo'}]);
	assert.deepEqual(svc.cleanup({accounts: [{accountName: ' alpha ', attemptId: 'att-9'}, null, {attemptId: 'x'}]}), {removedAttempts: 3, removedFiles: 1, removedFromList: true});
	assert.equal(sessionMap.has('alpha'), false);
	assert.deepEqual(accountStore.list().map(a => a.accountName), ['bravo']);
});

test('maFile 导入:按账号名存加密库,非法账号名和缺 account_name 的逐条报错', () => {
	const {svc, mafileMap} = service();
	const result = svc.importMaFiles({mafiles: [{account_name: 'alpha', shared_secret: 'SS'}, {accountName: 'bad name'}, {}, 'x']});
	assert.equal(result.saved, 1);
	assert.deepEqual(result.results.map(r => [r.accountName, r.ok, 'error' in r ? r.error : '']), [
		['alpha', true, ''], ['bad name', false, '账号名包含非法字符,无法保存'], ['', false, '缺少 account_name'], ['', false, '缺少 account_name']
	]);
	assert.equal(mafileMap.get('alpha')?.shared_secret, 'SS');
	assert.throws(() => svc.importMaFiles({}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
});

test('令牌验证码:优先请求里的,再 maFile,再名单;都没有 409', () => {
	const {svc} = service([{accountName: 'bravo', sharedSecret: 'SS-list'}], {}, {alpha: {shared_secret: 'SS-ma'}});
	assert.deepEqual(svc.authCode({accountName: 'alpha'}), {accountName: 'alpha', code: 'C-SS-ma', expiresIn: 23, expiresAt: '2026-10-13T00:00:23.000Z'});
	assert.equal(svc.authCode({accountName: 'bravo'}).code, 'C-SS-list');
	assert.equal(svc.authCode({accountName: 'bravo', sharedSecret: 'SS-body'}).code, 'C-SS-body');
	assert.throws(() => svc.authCode({accountName: 'nobody'}), (err: Error & {statusCode?: number}) => err.statusCode === 409);
	assert.throws(() => svc.authCode({accountName: 'x', sharedSecret: 'BAD'}), (err: Error & {statusCode?: number}) => err.statusCode === 500);
});

test('批量令牌验证码:名单里有 maFile 或 shared_secret 的都给,坏的跳过;可以只要几个', () => {
	const {svc} = service([
		{accountName: 'alpha'}, {accountName: 'Bravo', sharedSecret: 'SS-list'}, {accountName: 'charlie'}, {accountName: 'echo', sharedSecret: 'BAD'}
	], {}, {alpha: {shared_secret: 'SS-ma'}});
	assert.deepEqual(svc.authCodes({}), {codes: {alpha: 'C-SS-ma', Bravo: 'C-SS-list'}, expiresIn: 23, period: 30});
	assert.deepEqual(svc.authCodes({accountNames: ['bravo', 'charlie']}).codes, {Bravo: 'C-SS-list'});
});

test('自动恢复凭据:保存的 refreshToken + 名单密码 + maFile 令牌;已删除的账号返回 null', () => {
	const {svc} = service([{accountName: 'alpha', password: 'pw', sharedSecret: 'SS-list', country: 'jp', currency: 23, balance: 4, hasWallet: true}], {}, {alpha: {identity_secret: 'IS'}});
	assert.deepEqual(svc.restoreCredentials('ALPHA'), {
		profile: {accountName: 'alpha', remember: true, sharedSecret: 'SS-list', identitySecret: 'IS', hasMaFile: true, country: 'jp', hasWallet: true, currency: 23, currencyISO: '', balance: 4},
		refreshToken: 'RT-saved',
		password: 'pw'
	});
	assert.equal(svc.restoreCredentials('gone'), null);
});

test('名单读写:写过才算 initialized;下发不含密钥', () => {
	const {svc} = service([{accountName: 'alpha', password: 'pw'}]);
	assert.equal(svc.listAccounts().initialized, false);
	const saved = svc.saveAccounts({accounts: [{accountName: 'alpha', password: ''}, {accountName: 'zulu'}]});
	assert.deepEqual(saved.accounts.map(a => [a.accountName, a.hasPassword]), [['alpha', true], ['zulu', false]]);
	assert.equal(svc.listAccounts().initialized, true);
});

test('导入(upsert):按账号名合并,不动其它账号;已有账号只覆盖非空密钥,hasMaFile 只会被置上', () => {
	const {svc} = service([
		{id: 'id-a', accountName: 'alpha', password: 'pw-a', sharedSecret: 'SS-a', hasMaFile: true, country: 'JP', source: 'import'},
		{id: 'id-b', accountName: 'bravo', password: 'pw-b'}
	]);
	const result = svc.upsertAccounts({accounts: [
		{accountName: 'ALPHA', password: '', sharedSecret: 'SS-new', hasMaFile: false, source: 'maFile'},
		{accountName: 'charlie', password: 'pw-c'},
		{accountName: '  '}
	]});
	assert.deepEqual([result.added, result.updated], [1, 1]);
	assert.deepEqual(result.accounts.map(a => [a.accountName, a.hasPassword, a.hasSharedSecret, a.hasMaFile, a.source]), [
		['alpha', true, true, true, 'maFile'],
		['bravo', true, false, false, ''],
		['charlie', true, false, false, '']
	]);
	assert.equal(result.accounts[0]!.country, 'JP');
	assert.equal(result.accounts[0]!.id, 'id-a');
	assert.ok(result.accounts[2]!.id, '新账号要有 id');
	assert.ok(!('password' in result.accounts[2]!), '下发不含密码');
	// 存进去的是合并后的密钥
	assert.deepEqual(svc.restoreCredentials('alpha')?.password, 'pw-a');
	assert.deepEqual(svc.restoreCredentials('alpha')?.profile.sharedSecret, 'SS-new');
	assert.throws(() => svc.upsertAccounts({accounts: [{accountName: ''}]}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
});

test('分组:名字去空白、不能空、不超过 20 字、不分大小写不重名;新建可顺便移入账号(名单里没有的忽略)', () => {
	const {svc} = service([{accountName: 'Alpha'}, {accountName: 'bravo'}, {accountName: 'charlie'}]);
	const status = (run: () => unknown) => {
		try {
			run();
		} catch (err) {
			return (err as {statusCode?: number}).statusCode;
		}
		return 200;
	};
	assert.equal(status(() => svc.createGroup({name: '  '})), 400);
	assert.equal(status(() => svc.createGroup({name: '一'.repeat(21)})), 400);
	const created = svc.createGroup({name: '  主号   一组 ', accountNames: ['ALPHA', 'zulu', 'alpha']});
	assert.equal(created.group.name, '主号 一组');
	assert.deepEqual(created.groups, [created.group]);
	assert.deepEqual(created.accounts.map(a => [a.accountName, a.groupId]), [['Alpha', created.group.id], ['bravo', ''], ['charlie', '']]);
	assert.ok(!('password' in created.accounts[0]!), '下发不含密码');
	assert.equal(status(() => svc.createGroup({name: '主号 一组'})), 409);
	const vault = svc.createGroup({name: 'Vault'}).group;
	assert.equal(status(() => svc.renameGroup(vault.id, {name: '主号 一组'})), 409);
	assert.equal(svc.renameGroup(vault.id, {name: 'VAULT'}).groups[1]!.name, 'VAULT', '只改大小写不算重名');
	assert.equal(status(() => svc.renameGroup('nope', {name: 'x'})), 404);
	assert.equal(svc.createGroup({name: '一'.repeat(20)}).groups.length, 3);
});

test('分组:移入移出、排序、删分组(账号变未分组);名单接口带分组;删账号清掉分组', () => {
	const {svc} = service([{accountName: 'alpha'}, {accountName: 'bravo'}, {accountName: 'charlie'}]);
	const main = svc.createGroup({name: '主号'}).group;
	const spare = svc.createGroup({name: '备用'}).group;
	const groupOf = (accounts: Array<{accountName: string; groupId: string}>) => Object.fromEntries(accounts.map(a => [a.accountName, a.groupId]));

	assert.deepEqual(groupOf(svc.moveToGroup({accountNames: ['alpha', 'BRAVO'], groupId: main.id}).accounts), {alpha: main.id, bravo: main.id, charlie: ''});
	assert.deepEqual(groupOf(svc.moveToGroup({accountNames: ['bravo'], groupId: spare.id}).accounts), {alpha: main.id, bravo: spare.id, charlie: ''});
	assert.deepEqual(groupOf(svc.moveToGroup({accountNames: ['alpha'], groupId: ''}).accounts), {alpha: '', bravo: spare.id, charlie: ''});
	assert.throws(() => svc.moveToGroup({accountNames: ['alpha'], groupId: 'nope'}), (err: Error & {statusCode?: number}) => err.statusCode === 404);
	assert.throws(() => svc.moveToGroup({accountNames: ['zulu'], groupId: main.id}), (err: Error & {statusCode?: number}) => err.statusCode === 400);

	assert.deepEqual(svc.reorderGroups({ids: [spare.id]}).groups.map(g => g.name), ['备用', '主号']);
	const listed = svc.listAccounts();
	assert.deepEqual(listed.groups.map(g => g.name), ['备用', '主号']);
	assert.equal(groupOf(listed.accounts).bravo, spare.id);
	assert.equal(groupOf(svc.saveAccounts({accounts: [{accountName: 'bravo'}, {accountName: 'charlie'}]}).accounts).bravo, spare.id, '整表替换后分组还在');

	const afterDelete = svc.deleteGroup(spare.id);
	assert.deepEqual(afterDelete.groups.map(g => g.name), ['主号']);
	assert.equal(groupOf(afterDelete.accounts).bravo, '');
	assert.throws(() => svc.deleteGroup(spare.id), (err: Error & {statusCode?: number}) => err.statusCode === 404);

	svc.moveToGroup({accountNames: ['charlie'], groupId: main.id});
	svc.cleanup({accounts: [{accountName: 'charlie'}]});
	const readded = svc.upsertAccounts({accounts: [{accountName: 'charlie', password: 'pw'}]});
	assert.equal(groupOf(readded.accounts).charlie, '', '删掉再导入的账号是未分组');
});

test('消费记录:只读名单里的账号;没网页会话 409;在线账号用会话的 cookie 在后台读', async () => {
	const {svc, sessions} = service([{accountName: 'Alpha', password: 'pw'}, {accountName: 'bravo', password: 'pw'}]);
	const status = (run: () => unknown) => {
		try {
			run();
		} catch (err) {
			return (err as {statusCode?: number}).statusCode;
		}
		return 200;
	};
	assert.equal(status(() => svc.loadHistory({accountName: ' '})), 400);
	assert.equal(status(() => svc.loadHistory({accountName: 'zulu'})), 404);
	assert.equal(status(() => svc.loadHistory({accountName: 'bravo'})), 409, '没登录过、也没存下 cookie');
	assert.equal(svc.getHistory('alpha'), null);

	sessions.attempts.set('att-9', {id: 'att-9', accountName: 'Alpha', status: 'web_session', cookies: ['steamLoginSecure=x']} as unknown as Attempt);
	const started = svc.loadHistory({accountName: 'ALPHA'});
	assert.deepEqual([started.accountName, started.status], ['Alpha', 'loading'], '用名单里的账号名');
	for (let i = 0; i < 100 && svc.getHistory('alpha')?.status === 'loading'; i++) {
		await new Promise(resolve => setImmediate(resolve));
	}
	// 测试里的 fetch 一律回 500(重试后)读取失败
	assert.match(String(svc.getHistory('alpha')?.error), /消费记录页 HTTP 500/);
});
