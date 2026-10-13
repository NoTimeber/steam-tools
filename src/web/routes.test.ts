// 各模块路由:完整路由表(防止拆分/改动时漏掉旧前端还在用的路径)和几处有讲究的处理。服务都是假的。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountRoutes} from '../accounts/routes.ts';
import type {AccountService} from '../accounts/index.ts';
import {buyGameRoutes} from '../buygame/routes.ts';
import type {BuyGameService} from '../buygame/index.ts';
import type {LauncherBridge} from '../core/launcher.ts';
import {inventoryRoutes} from '../inventory/routes.ts';
import {marketRoutes} from '../market/routes.ts';
import type {MarketService} from '../market/index.ts';
import {purchaseRoutes} from '../purchase/routes.ts';
import type {PurchaseService} from '../purchase/index.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {terminalRoutes} from '../terminal/routes.ts';
import type {TerminalService} from '../terminal/index.ts';
import {uuRoutes} from '../uu/routes.ts';
import type {UuService} from '../uu/index.ts';
import {walletRoutes} from '../wallet/routes.ts';
import type {WalletService} from '../wallet/index.ts';
import {debugOnly} from './http.ts';
import type {Handler, Request, Router} from './http.ts';
import {systemRoutes} from './system-routes.ts';

function recordingRouter() {
	const table = new Map<string, Handler[]>();
	const add = (method: string) => (path: string, ...handlers: Handler[]) => {
		assert.ok(!table.has(`${method} ${path}`), `重复注册 ${method} ${path}`);
		table.set(`${method} ${path}`, handlers);
	};
	const router: Router = {get: add('GET'), post: add('POST'), delete: add('DELETE')};
	return {router, table};
}

interface Reply {
	status: number;
	body: any;
}

/** 依次跑一条路由的处理函数(含 debugOnly 这类中间件),返回响应 */
async function call(table: Map<string, Handler[]>, route: string, req: Partial<Request> = {}): Promise<Reply> {
	const handlers = table.get(route);
	assert.ok(handlers, `没有路由 ${route}`);
	const reply: Reply = {status: 200, body: undefined};
	const res = {
		headersSent: false,
		status(code: number) {
			reply.status = code;
			return res;
		},
		json(body: unknown) {
			reply.body = body;
			return res;
		},
		setHeader() {
			return res;
		},
		redirect() {
			return res;
		},
		sendFile() {
			return res;
		}
	};
	const request = {params: {}, query: {}, body: {}, headers: {}, method: 'GET', path: '/', ...req} as Request;
	for (const handler of handlers) {
		let advanced = false;
		await handler(request, res, () => {
			advanced = true;
		});
		if (!advanced) {
			break;
		}
	}
	return reply;
}

const stub = <T>(value: Partial<Record<keyof T, unknown>>) => value as unknown as T;

function registerAll(overrides: {
	purchase?: Partial<Record<keyof PurchaseService, unknown>>;
	market?: Partial<Record<keyof MarketService, unknown>>;
	uu?: Partial<Record<keyof UuService, unknown>>;
	launcher?: Partial<LauncherBridge>;
	getAttempt?: (id: string) => Attempt | undefined;
	debug?: boolean;
} = {}) {
	const {router, table} = recordingRouter();
	const debug = debugOnly(!!overrides.debug);
	systemRoutes(router, {sessionCount: () => 3, launcher: stub<LauncherBridge>(overrides.launcher ?? {}), uptime: () => 12});
	accountRoutes(router, {accounts: stub<AccountService>({cookies: async (id: string) => ({id, cookies: ['c']})}), debug});
	inventoryRoutes(router, {
		inventory: {get: async () => ({source: 'community', items: []}) as never},
		getAttempt: overrides.getAttempt ?? (() => undefined),
		publicAttempt: attempt => ({id: attempt.id}) as never
	});
	terminalRoutes(router, {terminal: stub<TerminalService>({})});
	purchaseRoutes(router, {purchase: stub<PurchaseService>(overrides.purchase ?? {})});
	buyGameRoutes(router, {buyGame: stub<BuyGameService>({testPurchase: async () => ({ok: true})}), listAccounts: () => [], debug});
	marketRoutes(router, {market: stub<MarketService>(overrides.market ?? {}), listAccounts: () => []});
	uuRoutes(router, {uu: stub<UuService>(overrides.uu ?? {})});
	walletRoutes(router, {wallet: stub<WalletService>({})});
	return table;
}

test('路由表:与拆分前 app/server.js 注册的完全一致', () => {
	const purchaseAliases = ['purchase', 'cs2', 'tf2'].flatMap(prefix => [
		`GET /api/${prefix}/online-accounts`,
		`GET /api/${prefix}/items`,
		`POST /api/${prefix}/refresh-items`,
		`${prefix === 'purchase' ? 'POST' : 'GET'} /api/${prefix}/refresh-rates`
	]);
	const expected = [
		'GET /api/health', 'GET /api/update/status', 'POST /api/update/check', 'POST /api/update/restart',
		'GET /api/attempts', 'GET /api/accounts/list', 'POST /api/accounts/list', 'POST /api/accounts/meta', 'POST /api/mafile/import',
		'POST /api/auth-code', 'POST /api/login', 'POST /api/login-refresh', 'POST /api/guard/:id', 'POST /api/web-session/:id',
		'POST /api/logout/:id', 'POST /api/accounts/cleanup', 'POST /api/gc/connect/:id', 'POST /api/gc/disconnect/:id', 'GET /api/cookies/:id',
		'GET /api/inventory/:id',
		'POST /api/terminal/unseal', 'POST /api/terminal/probe', 'POST /api/terminal/advance-offer', 'POST /api/terminal/request-offers',
		'POST /api/terminal/selftest', 'POST /api/terminal/resolve-offers', 'GET /api/terminal/state',
		...purchaseAliases,
		'GET /api/purchase/tasks', 'POST /api/purchase/tasks', 'POST /api/task/cs2-purchase', 'POST /api/task/tf2-purchase',
		'POST /api/steam-purchase/test', 'GET /api/buygame/online-accounts', 'GET /api/buygame/resolve', 'GET /api/buygame/tasks', 'POST /api/buygame/tasks',
		'GET /api/market/online-accounts', 'GET /api/market/context', 'POST /api/market/buyorder', 'GET /api/market/buyorders',
		'POST /api/market/buyorder/cancel', 'POST /api/market/buyorders/sync',
		'GET /api/uu/state', 'POST /api/uu/bind', 'POST /api/uu/auto', 'POST /api/uu/scan', 'GET /api/uu/orders/:account',
		'POST /api/uu/list/auto', 'POST /api/uu/list/scan', 'POST /api/uu/poll-interval', 'POST /api/uu/login/start',
		'POST /api/uu/login/verify', 'POST /api/uu/login/cancel', 'POST /api/uu/token/acquire', 'GET /api/uu/tokens', 'DELETE /api/uu/token',
		'POST /api/wallet/redeem'
	];
	assert.deepEqual([...registerAll().keys()].sort(), [...expected].sort());
});

test('调试端点(读 cookies、单次真实购买)默认 404,打开后才放行', async () => {
	const closed = registerAll();
	assert.equal((await call(closed, 'GET /api/cookies/:id', {params: {id: 'a1'}})).status, 404);
	assert.equal((await call(closed, 'POST /api/steam-purchase/test')).status, 404);
	const open = registerAll({debug: true});
	assert.deepEqual((await call(open, 'GET /api/cookies/:id', {params: {id: 'a1'}})).body, {success: true, id: 'a1', cookies: ['c']});
	assert.deepEqual((await call(open, 'POST /api/steam-purchase/test')).body, {success: true, result: {ok: true}});
});

test('内购:别名路径的游戏写死,新路径看 ?game= / body.game;购物车无效 400', async () => {
	const seen: unknown[] = [];
	const table = registerAll({
		purchase: {
			listOnlineAccounts: (game: unknown) => {
				seen.push(game);
				return [];
			},
			catalog: {
				ensureLoaded: async (game: unknown) => seen.push(`load:${game}`),
				refreshRates: async () => seen.push('rates'),
				response: (game: unknown) => ({success: true, game})
			}
		}
	});
	const tf2 = await call(table, 'GET /api/tf2/online-accounts', {query: {game: 'cs2'}});
	assert.deepEqual(tf2.body, {success: true, game: 'tf2', gameLabel: 'TF2', accounts: []});
	await call(table, 'GET /api/purchase/online-accounts', {query: {game: 'tf2'}});
	assert.deepEqual((await call(table, 'GET /api/purchase/items', {body: {game: 'tf2'}})).body, {success: true, game: 'tf2'});
	assert.deepEqual((await call(table, 'GET /api/cs2/refresh-rates', {query: {game: 'tf2'}})).body, {success: true, game: 'cs2'});
	assert.deepEqual(seen, ['tf2', 'tf2', 'load:tf2', 'rates']);

	const bad = await call(table, 'POST /api/purchase/tasks', {body: {cartData: 'x'}});
	assert.equal(bad.status, 400);
	assert.equal(bad.body.success, false);
});

test('库存:会话不存在 404', async () => {
	const missing = await call(registerAll(), 'GET /api/inventory/:id', {params: {id: 'nope'}});
	assert.deepEqual([missing.status, missing.body], [404, {success: false, error: '任务不存在'}]);
	const found = await call(registerAll({getAttempt: id => ({id}) as Attempt}), 'GET /api/inventory/:id', {params: {id: 'a1'}});
	assert.deepEqual(found.body, {success: true, attempt: {id: 'a1'}, inventory: {source: 'community', items: []}});
});

test('市场:撤单只回 success;对账结果整理成 summary', async () => {
	const table = registerAll({
		market: {
			cancel: async () => ({ignored: true}),
			sync: async () => ({orders: [1], syncedAccounts: ['a'], removed: 2, updated: 3, accounts: [{account: 'a'}]})
		}
	});
	assert.deepEqual((await call(table, 'POST /api/market/buyorder/cancel')).body, {success: true});
	assert.deepEqual((await call(table, 'POST /api/market/buyorders/sync')).body, {
		success: true, orders: [1], syncedAccounts: ['a'], summary: {removed: 2, updated: 3, accounts: [{account: 'a'}]}
	});
});

test('UU:删 token 时解绑了账号才回 account;同步方法抛的错按 statusCode 返回', async () => {
	let account: unknown = null;
	const table = registerAll({
		uu: {
			deleteToken: () => account,
			setAuto: () => {
				throw Object.assign(new Error('未绑定 token'), {statusCode: 400});
			}
		}
	});
	assert.deepEqual((await call(table, 'DELETE /api/uu/token')).body, {success: true});
	account = {accountName: 'a'};
	assert.deepEqual((await call(table, 'DELETE /api/uu/token')).body, {success: true, account: {accountName: 'a'}});
	const failed = await call(table, 'POST /api/uu/auto', {body: {accountName: 'a'}});
	assert.deepEqual([failed.status, failed.body], [400, {success: false, error: '未绑定 token'}]);
});

test('系统:运行状态;启动器忙时检查更新 409', async () => {
	assert.deepEqual((await call(registerAll(), 'GET /api/health')).body, {success: true, uptime: 12, attempts: 3});
	const busy = await call(registerAll({launcher: {check: async () => ({busy: true})}}), 'POST /api/update/check');
	assert.equal(busy.status, 409);
	const done = await call(registerAll({launcher: {check: async () => ({checked: true, status: {pending: true}})}}), 'POST /api/update/check');
	assert.deepEqual(done.body, {success: true, checked: true, status: {pending: true}});
});
