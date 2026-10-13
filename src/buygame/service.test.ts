import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Attempt} from '../steam/session-manager.ts';
import {findAttemptByKey, listCookieFlowAccounts} from '../steam/attempts.ts';
import type {PurchaseParams, PurchaseResult, StoreCheckout} from './checkout.ts';
import {createBuyGameService} from './index.ts';
import type {BuyGameEvent, PublicBuyGameTask} from './index.ts';

function attempt(name: string, overrides: Partial<Attempt> = {}): Attempt {
	return {
		id: name[0] + '1', accountName: name, status: 'web_session', country: 'US', loginGeoCountry: '', currency: 1, currencyISO: 'USD',
		balance: 10, hasWallet: true, webSessionID: 'sid-' + name, userAgent: 'UA', personaName: name.toUpperCase(), ...overrides
	} as Attempt;
}

function harness(list: Attempt[]) {
	const attempts = new Map(list.map(a => [a.id, a]));
	const events: Array<[BuyGameEvent, PublicBuyGameTask]> = [];
	const purchases: PurchaseParams[] = [];
	const failures = new Map<string, Error>();
	let release: (() => void) | null = null;
	let gate: Promise<void> | null = null;
	const checkout: StoreCheckout = {
		async purchasePackages(params) {
			purchases.push(params);
			if (gate) {
				await gate;
			}
			const name = String(params.cookies?.[0]).replace('steamLoginSecure=', '');
			const failure = failures.get(name);
			if (failure) {
				throw failure;
			}
			return {success: true, dryRun: params.dryRun !== false, transId: 'T-' + name, price: {finalCents: 1999}} as unknown as PurchaseResult;
		},
		async resolvePackage(packageId, country) {
			return {packageId, name: 'Game ' + country, appid: 1, priceCents: 1, currencyISO: 'USD', discountPercent: 0, available: true};
		}
	};
	let ids = 0;
	const service = createBuyGameService({
		findAttempt: key => findAttemptByKey(attempts, key),
		cookiesFor: a => a.accountName === 'nocookie' ? [] : ['steamLoginSecure=' + a.accountName],
		emit: (event, task) => void events.push([event, structuredClone(task)]),
		checkout,
		now: () => new Date('2026-10-13T00:00:00Z'),
		randomId: () => 'task-' + (++ids),
		logger: {log() {}, error() {}}
	});
	return {
		service, events, purchases, failures, attempts,
		hold() {
			gate = new Promise(resolve => {
				release = resolve;
			});
		},
		release: () => release?.(),
		done: async () => {
			for (let i = 0; i < 200 && events.filter(e => e[0] === 'buygame:task-completed').length < events.filter(e => e[0] === 'buygame:task-created').length; i++) {
				await new Promise(resolve => setTimeout(resolve, 2));
			}
		}
	};
}

test('账号下拉:没被登出、有 cookie 的会话,按账号名排序;id/账号名都能找', () => {
	const list = [attempt('charlie', {status: 'disconnected', currencyISO: '', currency: 23}), attempt('alpha'), attempt('bravo', {status: 'logged_out'}), attempt('nocookie')];
	const attempts = new Map(list.map(a => [a.id, a]));
	const accounts = listCookieFlowAccounts(attempts.values(), a => a.accountName === 'nocookie' ? [] : ['x=1']);
	assert.deepEqual(accounts.map(a => [a.account, a.currencyISO]), [['alpha', 'USD'], ['charlie', 'CNY']]);
	assert.equal(findAttemptByKey(attempts, 'c1')?.accountName, 'charlie');
	assert.equal(findAttemptByKey(attempts, 'ALPHA')?.id, 'a1');
	assert.equal(findAttemptByKey(attempts, ''), null);
});

test('购买任务:每个账号按自己的国家/币种结算,并发执行,逐步推送进度', async () => {
	const h = harness([attempt('alpha'), attempt('bravo', {country: '', loginGeoCountry: 'UY', currency: 41, currencyISO: ''})]);
	const task = h.service.createTask({items: [{accountId: 'a1', packageIds: [10, '10', 20]}, {account: 'BRAVO', packageIds: [30]}, {account: 'ghost', packageIds: [1]}, {account: 'alpha', packageIds: ['x']}], concurrency: 2});
	assert.deepEqual([task.status, task.dryRun, task.concurrency, task.totalAccounts], ['queued', false, 2, 2]);
	assert.deepEqual(task.accounts.map(a => [a.account, a.packageIds, a.currencyISO, a.country]), [['alpha', [10, 20], 'USD', 'US'], ['bravo', [30], 'UYU', 'UY']]);
	await h.done();
	assert.deepEqual(h.purchases.map(p => [p.cookies?.[0], p.country, p.currency, p.packageIds, p.dryRun, p.sessionid]), [
		['steamLoginSecure=alpha', 'US', 1, [10, 20], false, 'sid-alpha'], ['steamLoginSecure=bravo', 'UY', 41, [30], false, 'sid-bravo']
	]);
	const [finished] = h.service.listTasks();
	assert.deepEqual([finished?.status, finished?.successCount, finished?.failCount, finished?.processedAccounts], ['completed', 2, 0, 2]);
	assert.deepEqual(finished?.accounts.map(a => [a.status, a.transId, a.spentCents]), [['success', 'T-alpha', 1999], ['success', 'T-bravo', 1999]]);
	assert.equal(h.events[0]?.[0], 'buygame:task-created');
	assert.equal(h.events.at(-1)?.[0], 'buygame:task-completed');
	assert.ok(h.events.some(([, t]) => t.accounts.some(a => a.status === 'running')));
});

test('试运行记 verified 不算成功;单个账号失败不影响别的', async () => {
	const h = harness([attempt('alpha'), attempt('bravo'), attempt('nocookie')]);
	h.failures.set('bravo', new Error('余额不足'));
	h.service.createTask({items: ['alpha', 'bravo', 'nocookie'].map(account => ({account, packageIds: [1]})), dryRun: true});
	await h.done();
	const [task] = h.service.listTasks();
	assert.deepEqual(task?.accounts.map(a => [a.account, a.status, a.error]), [
		['alpha', 'verified', ''], ['bravo', 'failed', '余额不足'], ['nocookie', 'failed', '账号缺少 WebSession cookies,请重新登录']
	]);
	assert.deepEqual([task?.successCount, task?.failCount], [0, 2]);
	assert.equal(h.purchases[0]?.dryRun, true);
});

test('并发上限:同时只跑 concurrency 个', async () => {
	const h = harness(['alpha', 'bravo', 'charlie'].map(name => attempt(name)));
	h.hold();
	h.service.createTask({items: ['alpha', 'bravo', 'charlie'].map(account => ({account, packageIds: [1]})), concurrency: 2});
	for (let i = 0; i < 50 && h.purchases.length < 2; i++) {
		await new Promise(resolve => setTimeout(resolve, 2));
	}
	assert.equal(h.purchases.length, 2);
	h.release();
	await h.done();
	assert.equal(h.purchases.length, 3);
});

test('没有有效购买项报 400;任务最多留 50 个', () => {
	const h = harness([attempt('alpha')]);
	assert.throws(() => h.service.createTask({items: [{account: 'ghost', packageIds: [1]}]}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
	assert.throws(() => h.service.createTask({items: 'x'}), /没有有效的购买项/);
	for (let i = 0; i < 52; i++) {
		h.service.createTask({items: [{account: 'alpha', packageIds: [1]}], concurrency: 99});
	}
	const tasks = h.service.listTasks();
	assert.equal(tasks.length, 50);
	assert.equal(tasks[0]?.id, 'task-52');
	assert.equal(tasks[0]?.concurrency, 10);
});

test('解析 subid:按账号国家取区域价,没指定账号用 US;id 无效报 400', async () => {
	const h = harness([attempt('alpha', {country: '', loginGeoCountry: 'CN'})]);
	assert.equal((await h.service.resolvePackage({subid: '730', account: 'alpha'})).name, 'Game CN');
	assert.equal((await h.service.resolvePackage({packageId: 730})).name, 'Game US');
	await assert.rejects(h.service.resolvePackage({packageId: 'x'}), (err: Error & {statusCode?: number}) => err.statusCode === 400);
});

test('调试购买:默认试运行、国家缺省 CN;找不到账号 404,没 cookie 409', async () => {
	const h = harness([attempt('alpha', {country: '', loginGeoCountry: ''}), attempt('nocookie')]);
	await h.service.testPurchase({accountName: 'alpha', packageId: 7});
	assert.deepEqual([h.purchases[0]?.packageIds, h.purchases[0]?.dryRun, h.purchases[0]?.country], [[7], true, 'CN']);
	await h.service.testPurchase({id: 'a1', packageIds: [1, 2], dryRun: false});
	assert.equal(h.purchases[1]?.dryRun, false);
	await assert.rejects(h.service.testPurchase({id: 'ghost'}), (err: Error & {statusCode?: number}) => err.statusCode === 404);
	await assert.rejects(h.service.testPurchase({accountId: 'nocookie'}), (err: Error & {statusCode?: number}) => err.statusCode === 409);
	h.failures.set('alpha', new Error('inittransaction 失败'));
	await assert.rejects(h.service.testPurchase({id: 'a1'}), (err: Error & {statusCode?: number}) => err.statusCode === 500 && err.message === 'inittransaction 失败');
});
