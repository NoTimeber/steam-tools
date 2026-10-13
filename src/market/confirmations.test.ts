import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBuyOrderConfirmer} from './confirmations.ts';
import type {Confirmation, ConfirmationCommunity, Totp} from './confirmations.ts';

interface FakeSteam {
	/** 每次 getConfirmations 依次返回的列表(用完后一直返回最后一个) */
	lists: Array<Array<{id: string; creator: string}>>;
	accepted: string[];
	keys: string[];
	cookies: string[][];
	offsetCalls: number;
	listCalls: number;
	respondError?: Error;
}

function fakeSteam(lists: FakeSteam['lists']): FakeSteam & {createCommunity: () => ConfirmationCommunity; totp: Totp} {
	const steam: FakeSteam = {lists, accepted: [], keys: [], cookies: [], offsetCalls: 0, listCalls: 0};
	const toConfirmation = (raw: {id: string; creator: string}): Confirmation => ({
		...raw,
		type: 12,
		respond(time, key, accept, callback) {
			steam.keys.push(`${key.tag}:${key.key}`);
			if (steam.respondError) {
				callback(steam.respondError);
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
				setImmediate(() => callback(null, list.map(toConfirmation)));
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
	assert.deepEqual(waits, [2000, 2000]);
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
