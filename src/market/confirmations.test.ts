import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBuyOrderConfirmer} from './confirmations.ts';
import type {Confirmation, ConfirmationCommunity, Totp} from './confirmations.ts';

interface FakeSteam {
	/** 每次 getConfirmations 依次返回的列表或错误(用完后一直返回最后一个) */
	lists: Array<Array<{id: string; creator: string}> | Error>;
	accepted: string[];
	keys: string[];
	cookies: string[][];
	offsetCalls: number;
	listCalls: number;
	respondError?: Error;
	/** 依次给 respond 的错误(用完就成功) */
	respondErrors: Error[];
}

function fakeSteam(lists: FakeSteam['lists']): FakeSteam & {createCommunity: () => ConfirmationCommunity; totp: Totp} {
	const steam: FakeSteam = {lists, accepted: [], keys: [], cookies: [], offsetCalls: 0, listCalls: 0, respondErrors: []};
	const toConfirmation = (raw: {id: string; creator: string}): Confirmation => ({
		...raw,
		type: 12,
		respond(time, key, accept, callback) {
			steam.keys.push(`${key.tag}:${key.key}`);
			const error = steam.respondError ?? steam.respondErrors.shift();
			if (error) {
				callback(error);
				return;
			}
			if (accept) {
				steam.accepted.push(raw.id);
			}
			callback(null);
		}
	});
	return Object.assign(steam, {
		createCommunity: (): ConfirmationCommunity => ({
			setCookies(cookies) {
				steam.cookies.push(cookies);
			},
			getConfirmations(time, key, callback) {
				steam.keys.push(`${key.tag}:${key.key}`);
				const list = steam.lists[Math.min(steam.listCalls++, steam.lists.length - 1)] ?? [];
				setImmediate(() => list instanceof Error ? callback(list) : callback(null, list.map(toConfirmation)));
			}
		}),
		totp: {
			time: (offset = 0) => 1000 + offset,
			getConfirmationKey: (secret: string, time: number, tag: string) => `${secret}@${time}/${tag}`,
			getTimeOffset(callback: (err: Error | null, offset?: number) => void) {
				steam.offsetCalls++;
				callback(null, 5);
			}
		}
	});
}

const noSleep = async () => {};
const COOKIES = ['steamLoginSecure=x'];

test('快照:挂单前的待确认项 id;没有 maFile 时不查', async () => {
	const steam = fakeSteam([[{id: '1', creator: 'a'}, {id: '2', creator: 'b'}]]);
	const confirmer = createBuyOrderConfirmer({createCommunity: steam.createCommunity, totp: steam.totp});
	assert.deepEqual(await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'}), new Set(['1', '2']));
	assert.deepEqual(steam.keys, ['list:IS@1005/list'], '用 Steam 时间差签 list key');
	assert.deepEqual(steam.cookies, [COOKIES]);
	assert.deepEqual(await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: ' '}), new Set());
	assert.equal(steam.listCalls, 1);
});

test('快照差分:挂单后新冒出来的那条就是本单,确认它并带回 creator', async () => {
	const steam = fakeSteam([[{id: 'old', creator: 'trade-1'}, {id: 'new', creator: '9001'}]]);
	const confirmer = createBuyOrderConfirmer({createCommunity: steam.createCommunity, totp: steam.totp, sleep: noSleep});
	const result = await confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: 'mismatch', priorConfIds: new Set(['old'])});
	assert.deepEqual(result, {confirmed: true, buyOrderId: '9001'});
	assert.deepEqual(steam.accepted, ['new']);
	assert.ok(steam.keys.includes('accept:IS@1005/accept'));
});

test('没有快照时用 confirmation_id 比 id 或 creator;多条分不清就报错,绝不乱确认', async () => {
	const steam = fakeSteam([[{id: '1', creator: 'trade-1'}, {id: '2', creator: '555'}]]);
	const confirmer = createBuyOrderConfirmer({createCommunity: steam.createCommunity, totp: steam.totp, sleep: noSleep});
	await confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '555'});
	assert.deepEqual(steam.accepted, ['2']);

	const ambiguous = fakeSteam([[{id: '1', creator: 'trade-1'}, {id: '2', creator: 'trade-2'}]]);
	const strict = createBuyOrderConfirmer({createCommunity: ambiguous.createCommunity, totp: ambiguous.totp, sleep: noSleep});
	await assert.rejects(strict.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '777'}), /检测到 2 个待确认项/);
	assert.deepEqual(ambiguous.accepted, []);
});

test('确认项晚到:按间隔重试;一直没有就报错', async () => {
	const steam = fakeSteam([[], [], [{id: 'n', creator: '1'}]]);
	const waits: number[] = [];
	const confirmer = createBuyOrderConfirmer({createCommunity: steam.createCommunity, totp: steam.totp, sleep: async ms => void waits.push(ms)});
	await confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', buyOrderId: '1', priorConfIds: new Set()});
	assert.deepEqual(waits, [5000, 5000]);
	assert.deepEqual(steam.accepted, ['n']);

	const never = fakeSteam([[{id: 'old', creator: 'x'}]]);
	const giveUp = createBuyOrderConfirmer({createCommunity: never.createCommunity, totp: never.totp, sleep: noSleep});
	await assert.rejects(giveUp.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', priorConfIds: new Set(['old']), attempts: 3}), /重试 3 次仍没找到/);
	assert.equal(never.listCalls, 3);
	assert.deepEqual(never.accepted, []);
});

test('前置条件:没 cookie、没 identity_secret、什么线索都没有时直接报错', async () => {
	const steam = fakeSteam([[]]);
	const confirmer = createBuyOrderConfirmer({createCommunity: steam.createCommunity, totp: steam.totp});
	await assert.rejects(confirmer.confirmBuyOrder({cookies: [], identitySecret: 'IS', confirmationId: '1'}), /缺少 WebSession cookies/);
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: '', confirmationId: '1'}), /未导入 maFile/);
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', priorConfIds: null}), /无法定位/);
	assert.equal(steam.listCalls, 0);
});

test('Steam 时间差缓存 1 小时;确认失败把错误抛给调用方', async () => {
	let clock = 0;
	const steam = fakeSteam([[{id: 'a', creator: '1'}]]);
	const confirmer = createBuyOrderConfirmer({createCommunity: steam.createCommunity, totp: steam.totp, now: () => clock});
	await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'});
	clock = 59 * 60 * 1000;
	await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'});
	assert.equal(steam.offsetCalls, 1);
	clock = 61 * 60 * 1000;
	await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'});
	assert.equal(steam.offsetCalls, 2);

	steam.respondError = new Error('Steam 拒绝确认');
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: 'a'}), /Steam 拒绝确认/);
});

test('超时:getConfirmations 不回就按 timeoutMs 报错', async () => {
	const confirmer = createBuyOrderConfirmer({
		createCommunity: () => ({setCookies() {}, getConfirmations() {}}),
		totp: fakeSteam([]).totp
	});
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '1', timeoutMs: 20}), /超时: getConfirmations/);
});

/** steamcommunity 的 HTTP 错误长这样 */
function httpError(status: number): Error {
	return Object.assign(new Error('HTTP error ' + status), {code: status});
}

test('限流:读列表、提交确认回 429 时等一会再试,日志里写清楚', async () => {
	const steam = fakeSteam([httpError(429), [{id: 'new', creator: '9001'}]]);
	steam.respondErrors.push(httpError(429));
	const waits: number[] = [];
	const logs: string[] = [];
	const confirmer = createBuyOrderConfirmer({
		createCommunity: steam.createCommunity, totp: steam.totp,
		sleep: async ms => void waits.push(ms), log: (level, message) => void logs.push(`${level} ${message}`)
	});
	const result = await confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', priorConfIds: new Set()});
	assert.deepEqual(result, {confirmed: true, buyOrderId: '9001'});
	assert.deepEqual(waits, [10000, 10000], '读列表、提交确认各等了一次');
	assert.equal(steam.listCalls, 2);
	assert.deepEqual(steam.accepted, ['new']);
	assert.deepEqual(steam.keys.filter(key => key.startsWith('accept')), ['accept:IS@1005/accept', 'accept:IS@1005/accept'], '提交确认发了两次');
	assert.match(logs[0] ?? '', /^warn .*读取确认列表被 Steam 限流\(HTTP 429\),10 秒后重试\(1\/2\)/);
	assert.match(logs[1] ?? '', /提交确认被 Steam 限流/);
});

test('限流:一直 429 就按顺序等完再报限流;别的错误不重试', async () => {
	const limited = fakeSteam([httpError(429)]);
	const waits: number[] = [];
	const confirmer = createBuyOrderConfirmer({createCommunity: limited.createCommunity, totp: limited.totp, sleep: async ms => void waits.push(ms)});
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '1'}), /Steam 手机确认接口限流\(HTTP 429\),重试 2 次仍不行/);
	assert.deepEqual(waits, [10000, 20000]);
	assert.equal(limited.listCalls, 3);

	const broken = fakeSteam([httpError(500)]);
	const strict = createBuyOrderConfirmer({createCommunity: broken.createCommunity, totp: broken.totp, sleep: async () => assert.fail('不该等')});
	await assert.rejects(strict.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '1'}), /HTTP error 500/);
	assert.equal(broken.listCalls, 1);
});
