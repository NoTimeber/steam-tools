import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import EventEmitter from 'node:events';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFingerprintStore} from '../steam/fingerprint.ts';
import {webUserAgentPool} from '../steam/user-agent.ts';
import {readJsonFileSafe, writeJsonAtomic} from './atomic-file.ts';
import {createAuth, parseCookies} from './auth.ts';
import type {AuthRequest, AuthResponse} from './auth.ts';
import {createOriginCheck, parseCookieSecure, parseTrustProxy} from './http.ts';
import {compareVersions, createVersionCheck} from './version-check.ts';

function tempDir(t: {after(fn: () => void): void}, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	return dir;
}

test('原子写盘:写完没有临时文件残留;坏 JSON 读成 null 并只备份一次', t => {
	const dir = tempDir(t, 'atomic-');
	const file = join(dir, 'sub', 'a.json');
	writeJsonAtomic(file, {a: 1});
	writeJsonAtomic(file, {a: 2}, 0);
	assert.equal(readFileSync(file, 'utf8'), '{"a":2}');
	assert.deepEqual(readdirSync(join(dir, 'sub')), ['a.json']);
	assert.equal(readJsonFileSafe(join(dir, 'missing.json')), null);

	const broken = join(dir, 'broken.json');
	writeFileSync(broken, '{"x": ');
	const errors: string[] = [];
	const logger = {error: (message: string) => void errors.push(message)};
	assert.equal(readJsonFileSafe(broken, logger), null);
	assert.equal(readJsonFileSafe(broken, logger), null);
	const backups = readdirSync(dir).filter(name => name.startsWith('broken.json.corrupt-'));
	assert.equal(backups.length, 1);
	assert.equal(readFileSync(join(dir, backups[0] as string), 'utf8'), '{"x": ');
	assert.equal(errors.length, 1);
});

// ===== 鉴权 =====

function harness(t: {after(fn: () => void): void}, options: Record<string, unknown> = {}) {
	const dir = tempDir(t, 'auth-');
	let clock = 1_000_000;
	let counter = 0;
	const auth = createAuth({
		authFile: join(dir, 'auth.json'), setupToken: 'SETUP', logger: {warn() {}, error() {}},
		now: () => clock, random: n => createHash('sha512').update(String(counter++)).digest().subarray(0, n),
		...options
	});
	let cookie = '';
	function call(handler: (req: AuthRequest, res: AuthResponse) => unknown, body: unknown = {}, extra: Partial<AuthRequest> = {}) {
		const out: {status: number; body?: any; headers: Record<string, string>} = {status: 200, headers: {}};
		const res: AuthResponse = {
			setHeader: (name, value) => void (out.headers[name] = value),
			status(code) {
				out.status = code;
				return res;
			},
			json(value) {
				out.body = value;
				return res;
			},
			redirect(url) {
				out.body = {redirect: url};
				return res;
			}
		};
		handler({ip: '1.1.1.1', body, headers: cookie ? {cookie: 'sid=' + cookie} : {}, ...extra}, res);
		const match = /sid=([^;]*)/.exec(out.headers['Set-Cookie'] || '');
		if (match) {
			cookie = match[1] as string;
		}
		return out;
	}
	return {auth, call, dir, tick: (ms: number) => void (clock += ms), cookie: () => cookie, setCookie: (value: string) => void (cookie = value)};
}

test('鉴权:未配置时锁定,带初始化令牌才能设置口令;设置后自动登录、写 scrypt 哈希', t => {
	const h = harness(t);
	assert.equal(h.auth.configured, false);
	assert.equal(h.call(h.auth.login, {password: 'x'}).status, 409);
	assert.equal(h.call(h.auth.setup, {setupToken: 'nope', password: 'long-enough'}).status, 403);
	assert.equal(h.call(h.auth.setup, {setupToken: ' SETUP ', password: 'short'}).status, 400);
	const ok = h.call(h.auth.setup, {setupToken: 'SETUP', password: 'long-enough'});
	assert.equal(ok.status, 200);
	assert.match(ok.headers['Set-Cookie'] ?? '', /^sid=[0-9a-f]{64}; HttpOnly; Path=\/; SameSite=Lax; Max-Age=604800$/);
	const saved = JSON.parse(readFileSync(join(h.dir, 'auth.json'), 'utf8'));
	assert.ok(saved.salt && saved.hash && !JSON.stringify(saved).includes('long-enough'));
	assert.equal(h.call(h.auth.setup, {setupToken: 'SETUP', password: 'another-one'}).status, 409);
	assert.equal(h.auth.isAuthed({headers: {cookie: 'sid=' + h.cookie()}}), true);
});

test('鉴权:同一 IP 错 5 次锁 15 分钟(带 Retry-After),窗口过了解锁;成功登录清掉计数', t => {
	const h = harness(t, {envPassword: 'env-password'});
	for (let i = 0; i < 4; i++) {
		assert.equal(h.call(h.auth.login, {password: 'bad'}).status, 401);
	}
	assert.equal(h.call(h.auth.login, {password: 'env-password'}).status, 200, '成功登录清掉计数');
	for (let i = 0; i < 5; i++) {
		h.call(h.auth.login, {password: 'bad'});
	}
	const locked = h.call(h.auth.login, {password: 'env-password'});
	assert.deepEqual([locked.status, locked.headers['Retry-After']], [429, '900']);
	assert.equal(h.call(h.auth.login, {password: 'env-password'}, {ip: '2.2.2.2'}).status, 200, '别的 IP 不受影响');
	h.tick(15 * 60 * 1000 + 1);
	assert.equal(h.call(h.auth.login, {password: 'env-password'}).status, 200);
});

test('鉴权:会话过期失效;改口令要验证当前口令,成功后旧会话全部失效;登出清 cookie', t => {
	const h = harness(t, {envPassword: 'env-password', ttlMs: 120000});
	h.call(h.auth.login, {password: 'env-password'});
	const first = h.cookie();
	assert.equal(h.call(h.auth.changePassword, {currentPassword: 'wrong', newPassword: 'new-password'}).status, 401);
	assert.equal(h.call(h.auth.changePassword, {currentPassword: 'env-password', newPassword: 'new-password'}).status, 200);
	assert.notEqual(h.cookie(), first);
	assert.equal(h.auth.isAuthed({headers: {cookie: 'sid=' + first}}), false, '旧会话失效');
	assert.equal(h.call(h.auth.login, {password: 'env-password'}).status, 401, '文件里的口令优先于环境变量');
	assert.equal(h.auth.isAuthed({headers: {cookie: 'sid=' + h.cookie()}}), true);
	h.tick(120001);
	assert.equal(h.auth.isAuthed({headers: {cookie: 'sid=' + h.cookie()}}), false, '过期');
	h.call(h.auth.login, {password: 'new-password'});
	const out = h.call(h.auth.logout);
	assert.match(out.headers['Set-Cookie'] ?? '', /^sid=; .*Max-Age=0/);
});

test('鉴权:网关放行健康检查/鉴权端点/登录页/socket.io,未登录 API 401、页面跳登录;Secure 按设置', t => {
	const h = harness(t, {envPassword: 'env-password', cookieSecure: 'auto'});
	const pass = (path: string, cookie = '') => {
		let nexted = false;
		const res = {setHeader() {}, status: () => res, json: () => res, redirect: (url: string) => (nexted = url === 'x') || res} as unknown as AuthResponse;
		h.auth.middleware({path, headers: cookie ? {cookie} : {}}, res, () => void (nexted = true));
		return nexted;
	};
	for (const path of ['/healthz', '/api/auth/status', '/login', '/socket.io/?EIO=4']) {
		assert.equal(pass(path), true, path);
	}
	assert.equal(pass('/api/attempts'), false);
	assert.equal(pass('/login.html'), false, '登录页只有 /login 一个地址');
	assert.equal(h.call(h.auth.middleware as never, {}, {path: '/api/x'}).status, 401);
	assert.deepEqual(h.call(h.auth.middleware as never, {}, {path: '/'}).body, {redirect: '/login'});
	const secure = h.call(h.auth.login, {password: 'env-password'}, {secure: true});
	assert.match(secure.headers['Set-Cookie'] ?? '', /; Secure$/);
	assert.equal(pass('/api/attempts', 'sid=' + h.cookie()), true);
	let socketResult = '';
	h.auth.socketAuth({handshake: {headers: {cookie: 'sid=%E0%A4%A'}}}, err => void (socketResult = err ? err.message : 'ok'));
	assert.equal(socketResult, 'unauthorized', '畸形 cookie 不抛错');
	assert.deepEqual({...parseCookies('a=1; b=%E0%A4%A; =x; c')}, {a: '1', b: '%E0%A4%A'});
	assert.equal(Object.getPrototypeOf(parseCookies('__proto__=x')), null, '没有原型,__proto__ 当普通键');
});

test('反代 / cookie / 同源设置', () => {
	assert.equal(parseTrustProxy(''), 'loopback');
	assert.equal(parseTrustProxy('2'), 2);
	assert.equal(parseTrustProxy('loopback,uniquelocal'), 'loopback,uniquelocal');
	assert.equal(parseTrustProxy('false'), false);
	assert.deepEqual([parseCookieSecure('1'), parseCookieSecure('FALSE'), parseCookieSecure('')], [true, false, 'auto']);
	const check = createOriginCheck('https://tools.example.com/');
	assert.equal(check({}), true, '非浏览器不带 Origin 放行');
	assert.equal(check({origin: 'http://127.0.0.1:5000', host: '127.0.0.1:5000'}), true);
	assert.equal(check({origin: 'https://evil.example', host: '127.0.0.1:5000'}), false);
	assert.equal(check({origin: 'https://panel.example', host: '10.0.0.2', 'x-forwarded-host': 'panel.example, proxy'}), true);
	assert.equal(check({origin: 'https://TOOLS.example.com', host: 'x'}), true, 'ALLOWED_ORIGINS');
	assert.equal(check({origin: 'null', host: 'x'}), false);
});

test('版本检查:查 GitHub 最新 Release 比版本号;同时只发一个请求;过期才在后台重查;失败记原因', async () => {
	assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
	assert.equal(compareVersions('1.5', '1.5.0'), 0);
	assert.ok(compareVersions('1.5.0', '1.5.1') < 0);

	let clock = 1_000_000;
	const urls: string[] = [];
	let reply: () => Response = () => Response.json({tag_name: 'v1.6.0', body: ' 修了点东西 ', html_url: 'https://github.com/o/r/releases/tag/v1.6.0'});
	const fetchStub = (async (url: string) => {
		urls.push(url);
		return reply();
	}) as typeof fetch;
	const versions = createVersionCheck({current: '1.5.0', repo: 'o/r', fetch: fetchStub, now: () => clock});

	const [first, second] = await Promise.all([versions.check(), versions.check()]);
	assert.deepEqual(urls, ['https://api.github.com/repos/o/r/releases/latest']);
	assert.deepEqual(first, second);
	assert.deepEqual(first, {
		current: '1.5.0', disabled: false, hasUpdate: true, latest: '1.6.0', notes: '修了点东西',
		url: 'https://github.com/o/r/releases/tag/v1.6.0', checkedAt: new Date(clock).toISOString()
	});

	clock += 60 * 60 * 1000;
	versions.status();
	assert.equal(urls.length, 1, '没过期不重查');
	clock += 6 * 60 * 60 * 1000;
	reply = () => new Response('', {status: 404});
	versions.status();
	assert.equal(urls.length, 2, '过期了后台重查');
	const failed = await versions.check();
	assert.equal(failed.error, 'o/r 还没有发布 Release');
	assert.equal(failed.latest, '1.6.0', '查失败时保留上次查到的版本');

	reply = () => Response.json({tag_name: '1.5.0'});
	assert.equal((await versions.check()).hasUpdate, false);
	assert.equal(versions.status().error, undefined);

	const off = createVersionCheck({current: '1.5.0', repo: '', fetch: fetchStub});
	assert.deepEqual(await off.check(), {current: '1.5.0', disabled: true, hasUpdate: false});
	assert.equal(urls.length, 3, '关了不发请求');
});

test('指纹:按账号名(不区分大小写)稳定复用并落盘;匿名一次性;UA 从新版池里挑,缓存里的老 UA 换掉', t => {
	const dir = tempDir(t, 'fp-');
	const pool = webUserAgentPool();
	const store = createFingerprintStore({dataDir: dir});
	const first = store.getAccountFingerprint('Alpha');
	assert.match(first.machineName, /^(DESKTOP|LAPTOP)-[A-Z0-9]{7}$/);
	assert.equal(first.machineIdFormat.length, 3);
	assert.ok(pool.includes(first.userAgent), first.userAgent);
	assert.deepEqual(store.getAccountFingerprint(' alpha '), first);
	assert.deepEqual(createFingerprintStore({dataDir: dir}).getAccountFingerprint('ALPHA'), first, '重启后从文件复用');
	assert.notDeepEqual(store.getAccountFingerprint('').machineIdFormat, store.getAccountFingerprint('').machineIdFormat);
	assert.ok(pool.includes(store.getAccountFingerprint('').userAgent));

	// 以前从 data/ua_cache.json 挑的老 Chrome UA(会被 Steam 429)、空的:换成池里的,机器名和 machineID 不动
	const OLD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.84 Safari/537.36';
	const old = tempDir(t, 'fp-old-');
	writeFileSync(join(old, 'ua_cache.json'), JSON.stringify([OLD]));
	writeFileSync(join(old, 'fingerprint_cache.json'), JSON.stringify({
		bravo: {machineName: 'DESKTOP-OLD0001', machineIdFormat: ['a', 'b', 'c'], userAgent: OLD},
		charlie: {machineName: 'DESKTOP-OLD0002', machineIdFormat: ['d', 'e', 'f'], userAgent: ''}
	}));
	const migrated = createFingerprintStore({dataDir: old});
	const bravo = migrated.getAccountFingerprint('bravo');
	assert.deepEqual([bravo.machineName, bravo.machineIdFormat], ['DESKTOP-OLD0001', ['a', 'b', 'c']]);
	assert.ok(pool.includes(bravo.userAgent), bravo.userAgent);
	assert.ok(pool.includes(migrated.getAccountFingerprint('charlie').userAgent));
	const saved = JSON.parse(readFileSync(join(old, 'fingerprint_cache.json'), 'utf8'));
	assert.equal(saved.bravo.userAgent, bravo.userAgent, '换好的落盘,下次不再换');

	// 池可以注入;随机数决定挑哪条
	const picks = [0, 1];
	const fixed = createFingerprintStore({dataDir: tempDir(t, 'fp-fixed-'), userAgents: ['UA-A', 'UA-B'],
		random: {bytes: size => Buffer.alloc(size), int: (min, max) => (max === 2 ? picks.shift()! : min)}});
	assert.deepEqual([fixed.getAccountFingerprint('x').userAgent, fixed.getAccountFingerprint('y').userAgent], ['UA-A', 'UA-B']);
});
