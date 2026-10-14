// Express 外壳:真实 express 起在随机端口,鉴权用假的(带 x-test-auth: 1 头算已登录)。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWebApp} from './app.ts';
import {debugOnly, keyedRoute, requestGame, spreadRoute} from './http.ts';
import type {AuthRequest, AuthResponse} from '../core/auth.ts';

const ok = (req: AuthRequest, res: AuthResponse) => res.json({success: true});
const fakeAuth = {
	login: ok,
	logout: ok,
	status: ok,
	setup: ok,
	changePassword: ok,
	middleware(req: AuthRequest, res: AuthResponse, next: () => void): unknown {
		const path = req.path || '';
		if (path === '/healthz' || path.startsWith('/api/auth/') || path === '/login' || req.headers?.['x-test-auth'] === '1') {
			return next();
		}
		return path.startsWith('/api/') ? res.status(401).json({success: false, error: 'unauthorized'}) : res.redirect('/login');
	}
};

const json = (res: globalThis.Response): Promise<any> => res.json();

async function listen(app: (req: unknown, res: unknown) => void): Promise<{server: Server; base: string}> {
	const server = createServer((req, res) => app(req, res));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	return {server, base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`};
}

describe('Web 外壳', () => {
	let webDir: string;
	let server: Server;
	let base: string;
	const logged: unknown[] = [];

	before(async () => {
		webDir = mkdtempSync(join(tmpdir(), 'steam-tools-web-'));
		writeFileSync(join(webDir, 'index.html'), '<p>app</p>');
		mkdirSync(join(webDir, 'assets'));
		writeFileSync(join(webDir, 'assets', 'main-abc123.js'), 'console.log(1)');
		const app = createWebApp({
			auth: fakeAuth,
			isAllowedOrigin: headers => !headers.origin || headers.origin === 'http://ok.example',
			trustProxy: false,
			webDir,
			logger: {error: (...args: unknown[]) => logged.push(args)},
			routes: [
				router => router.post('/api/echo', spreadRoute(req => ({body: req.body, game: requestGame(req)}), '回显失败')),
				router => {
					router.get('/api/boom', () => {
						throw new Error('C:\\secret\\path 内部细节');
					});
					router.get('/api/bad', spreadRoute(() => {
						throw Object.assign(new Error('参数不对'), {statusCode: 400});
					}, '兜底'));
					router.get('/api/empty-error', keyedRoute('value', async () => {
						throw {};
					}, '兜底文案'));
					router.get('/api/keyed', keyedRoute('value', async () => 42, '不会用到'));
					router.get('/api/debug-off', debugOnly(false), (req, res) => res.json({reached: true}));
					router.get('/api/debug-on', debugOnly(true), (req, res) => res.json({reached: true}));
				}
			]
		});
		({server, base} = await listen(app));
	});

	after(() => {
		server?.close();
		rmSync(webDir, {recursive: true, force: true});
	});

	const authed = {'x-test-auth': '1'};
	const send = (path: string, init: RequestInit = {}) => fetch(base + path, {redirect: 'manual', ...init});

	test('健康检查、登录页不用登录;都带安全头,不带 x-powered-by', async () => {
		const health = await send('/healthz');
		assert.deepEqual(await json(health), {ok: true});
		assert.equal(health.headers.get('x-frame-options'), 'DENY');
		assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
		assert.equal(health.headers.get('referrer-policy'), 'same-origin');
		assert.equal(health.headers.get('x-powered-by'), null);
		const login = await send('/login');
		assert.match(await login.text(), /<form class="card" id="login-form">/, '服务端自带的登录页,不在前端构建产物里');
		assert.match(login.headers.get('cache-control') ?? '', /no-store/);
	});

	test('网关:没登录时 API 401、页面跳登录', async () => {
		assert.equal((await send('/api/keyed')).status, 401);
		for (const path of ['/', '/assets/main-abc123.js', '/next/']) {
			const page = await send(path);
			assert.equal(page.status, 302, path);
			assert.equal(page.headers.get('location'), '/login', path);
		}
	});

	test('前端挂在 /:带哈希的 assets 长缓存,入口不缓存;老的 /next/ 跳回首页', async () => {
		const index = await send('/', {headers: authed});
		assert.equal(await index.text(), '<p>app</p>');
		assert.match(index.headers.get('cache-control') ?? '', /no-store/);
		const asset = await send('/assets/main-abc123.js', {headers: authed});
		assert.equal(asset.status, 200);
		assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
		for (const path of ['/next', '/next/', '/next/index.html']) {
			const old = await send(path, {headers: authed});
			assert.equal(old.status, 302, path);
			assert.equal(old.headers.get('location'), '/', path);
		}
	});

	test('同源校验:跨站写请求 403(鉴权端点也拦),GET 不拦', async () => {
		const evil = {...authed, origin: 'http://evil.example', 'content-type': 'application/json'};
		const res = await send('/api/echo', {method: 'POST', headers: evil, body: '{}'});
		assert.equal(res.status, 403);
		assert.equal((await json(res)).error, '来源校验失败,跨站请求已拒绝');
		assert.equal((await send('/api/auth/login', {method: 'POST', headers: evil, body: '{}'})).status, 403);
		assert.equal((await send('/api/keyed', {headers: {...authed, origin: 'http://evil.example'}})).status, 200);
		const allowed = await send('/api/echo?game=tf2', {method: 'POST', headers: {...authed, origin: 'http://ok.example', 'content-type': 'application/json'}, body: '{"a":1}'});
		assert.deepEqual(await json(allowed), {success: true, body: {a: 1}, game: 'tf2'});
	});

	test('路由包装:按 statusCode 返回,没有 message 用兜底文案', async () => {
		assert.deepEqual(await json(await send('/api/keyed', {headers: authed})), {success: true, value: 42});
		const bad = await send('/api/bad', {headers: authed});
		assert.equal(bad.status, 400);
		assert.deepEqual(await json(bad), {success: false, error: '参数不对'});
		const empty = await send('/api/empty-error', {headers: authed});
		assert.equal(empty.status, 500);
		assert.deepEqual(await json(empty), {success: false, error: '兜底文案'});
	});

	test('调试端点关闭时 404', async () => {
		const off = await send('/api/debug-off', {headers: authed});
		assert.equal(off.status, 404);
		assert.deepEqual(await json(off), {success: false, error: 'not found'});
		assert.deepEqual(await json(await send('/api/debug-on', {headers: authed})), {reached: true});
	});

	test('兜底错误处理:请求体不是 JSON 回 400 JSON;路由抛错回 500 且不带内部细节和堆栈', async () => {
		const malformed = await send('/api/echo', {method: 'POST', headers: {...authed, 'content-type': 'application/json'}, body: '{bad'});
		assert.equal(malformed.status, 400);
		assert.match(malformed.headers.get('content-type') ?? '', /application\/json/);
		const body = await json(malformed);
		assert.equal(body.success, false);
		assert.doesNotMatch(body.error, /node_modules|at JSON\.parse/);

		const boom = await send('/api/boom', {headers: authed});
		assert.equal(boom.status, 500);
		const text = await boom.text();
		assert.deepEqual(JSON.parse(text), {success: false, error: '服务器内部错误'});
		assert.doesNotMatch(text, /secret/);
		assert.equal(logged.length, 1);
	});

	test('请求体超过 1MB:413', async () => {
		const big = JSON.stringify({blob: 'x'.repeat(1024 * 1024 + 10)});
		const res = await send('/api/echo', {method: 'POST', headers: {...authed, 'content-type': 'application/json'}, body: big});
		assert.equal(res.status, 413);
		assert.equal((await json(res)).success, false);
	});
});

test('前端没构建:首页 503 并提示怎么构建,登录页照常', async () => {
	const app = createWebApp({
		auth: fakeAuth,
		isAllowedOrigin: () => true,
		trustProxy: false,
		webDir: join(tmpdir(), 'steam-tools-web-missing-dist'),
		routes: []
	});
	const {server, base} = await listen(app);
	try {
		const res = await fetch(base + '/', {headers: {'x-test-auth': '1'}});
		assert.equal(res.status, 503);
		assert.match((await json(res)).error, /npm run build/);
		assert.equal((await fetch(base + '/login')).status, 200);
	} finally {
		server.close();
	}
});
