import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {disconnectGameSession, ensureGameSession, sendGcRequest, waitForGcConnection} from './gc-client.ts';
import type {ProtoType} from './gc-client.ts';
import {normalizeGame, gameConfig} from './games.ts';
import type {Attempt} from './session-manager.ts';

const REQUEST_MSG = 2500;
const RESPONSE_MSG = 2501;

class FakeGcClient extends EventEmitter {
	sent: Array<{appid: number; msgType: number; payload: Uint8Array}> = [];
	played: number[][] = [];
	webLogOns = 0;
	callback: ((appid: number, msgType: number, payload: Uint8Array) => void) | null = null;
	sendToGC(appid: number, msgType: number, _header: unknown, payload: Uint8Array, callback?: (appid: number, msgType: number, payload: Uint8Array) => void) {
		this.sent.push({appid, msgType, payload});
		this.callback = callback ?? null;
	}
	gamesPlayed(apps: number[]) {
		this.played.push(apps);
	}
	webLogOn() {
		this.webLogOns++;
	}
}

// 用 JSON 冒充 protobuf 编解码
const jsonProto: ProtoType = {
	encode: message => ({finish: () => Buffer.from(JSON.stringify(message))}),
	decode: payload => JSON.parse(Buffer.from(payload).toString('utf8')),
	toObject: message => message as Record<string, unknown>
};

function makeAttempt(overrides: Partial<Attempt> = {}): {attempt: Attempt; client: FakeGcClient} {
	const client = new FakeGcClient();
	const attempt = {
		client, cs2GcConnected: true, tf2GcConnected: false, gcConnected: true, activeGame: 'cs2',
		inventoryCount: 5, inventorySource: 'gc', inventoryCache: {x: 1}, communityInvTriedAt: 9, inventoryInflight: null,
		csgo: new EventEmitter(), tf2: new EventEmitter(),
		...overrides
	} as unknown as Attempt;
	return {attempt, client};
}

const reply = (body: unknown) => Buffer.from(JSON.stringify(body));

test('游戏名归一', () => {
	assert.equal(normalizeGame('TF2'), 'tf2');
	assert.equal(normalizeGame('440'), 'tf2');
	assert.equal(normalizeGame('Team Fortress 2'), 'tf2');
	assert.equal(normalizeGame(undefined), 'cs2');
	assert.equal(gameConfig('tf2').appId, 440);
	assert.equal(gameConfig('whatever').gcStateKey, 'cs2GcConnected');
});

test('GC 请求:receivedFromGC 事件里等到匹配的回包', async () => {
	const {attempt, client} = makeAttempt();
	const pending = sendGcRequest(attempt, 'cs2', REQUEST_MSG, jsonProto, {price_sheet_version: 0}, RESPONSE_MSG, jsonProto);
	assert.equal(client.sent.length, 1);
	assert.equal(client.sent[0]?.appid, 730);
	assert.deepEqual(JSON.parse(Buffer.from(client.sent[0]?.payload ?? []).toString()), {price_sheet_version: 0});
	client.emit('receivedFromGC', 440, RESPONSE_MSG, reply({wrong: 'app'}));
	client.emit('receivedFromGC', 730, 9999, reply({wrong: 'msg'}));
	client.emit('receivedFromGC', 730, RESPONSE_MSG, reply({ok: true}));
	assert.deepEqual(await pending, {ok: true});
	assert.equal(client.listenerCount('receivedFromGC'), 0, '完成后移除监听');
});

test('GC 请求:回包走 sendToGC 回调也行,只处理一次', async () => {
	const {attempt, client} = makeAttempt();
	const pending = sendGcRequest(attempt, 'cs2', REQUEST_MSG, jsonProto, {}, RESPONSE_MSG, jsonProto);
	client.callback?.(730, RESPONSE_MSG, reply({via: 'callback'}));
	client.emit('receivedFromGC', 730, RESPONSE_MSG, reply({via: 'event'}));
	assert.deepEqual(await pending, {via: 'callback'});
});

test('GC 请求:解码失败、超时、未连接、没有客户端', async (t: TestContext) => {
	const {attempt, client} = makeAttempt();
	const broken = sendGcRequest(attempt, 'cs2', REQUEST_MSG, jsonProto, {}, RESPONSE_MSG, jsonProto);
	client.emit('receivedFromGC', 730, RESPONSE_MSG, Buffer.from('not json'));
	await assert.rejects(broken, /GC 响应解码失败/);

	t.mock.timers.enable({apis: ['setTimeout']});
	const slow = sendGcRequest(attempt, 'cs2', REQUEST_MSG, jsonProto, {}, RESPONSE_MSG, jsonProto, {timeoutMs: 2000});
	t.mock.timers.tick(2000);
	await assert.rejects(slow, /GC 请求超时 msg=2500/);
	assert.equal(client.listenerCount('receivedFromGC'), 0);
	t.mock.timers.reset();

	const offline = makeAttempt({cs2GcConnected: false}).attempt;
	await assert.rejects(sendGcRequest(offline, 'cs2', REQUEST_MSG, jsonProto, {}, RESPONSE_MSG, jsonProto),
		(err: Error & {statusCode?: number}) => /尚未连接 CS2 GC/.test(err.message) && err.statusCode === 409);
	const noClient = makeAttempt({client: null}).attempt;
	await assert.rejects(sendGcRequest(noClient, 'cs2', REQUEST_MSG, jsonProto, {}, RESPONSE_MSG, jsonProto), /没有可用的 Steam GC 客户端/);
});

test('切换游戏:进 TF2 会断开 CS2 的 GC 标记,并刷新 web 会话;已在该游戏且已连接则不动', () => {
	const {attempt, client} = makeAttempt();
	assert.equal(ensureGameSession(attempt, 'cs2'), true);
	assert.deepEqual(client.played, [], '已在 CS2 且已连接');

	assert.equal(ensureGameSession(attempt, 'tf2'), true);
	assert.deepEqual(client.played, [[440]]);
	assert.equal(client.webLogOns, 1);
	assert.equal(attempt.activeGame, 'tf2');
	assert.equal(attempt.cs2GcConnected, false);
	assert.equal(attempt.gcConnected, false);
	assert.equal(attempt.tf2GcConnected, false, '等 connectedToGC 再置位');

	assert.equal(ensureGameSession(makeAttempt({client: null}).attempt, 'cs2'), false);
});

test('断开游戏:退出游戏并清掉 GC 标记和 GC 来源的库存缓存;社区库存缓存留着', () => {
	const {attempt, client} = makeAttempt({inventoryCache: {source: 'gc', itemCount: 3}, inventoryCount: 3, inventorySource: 'gc'});
	assert.equal(disconnectGameSession(attempt, 'tf2'), true);
	assert.deepEqual(client.played, [[]]);
	assert.equal(attempt.cs2GcConnected, false);
	assert.equal(attempt.inventoryCache, null);
	assert.equal(attempt.inventoryCount, 0);
	assert.equal(attempt.activeGame, 'tf2');

	const community = {source: 'community', itemCount: 5};
	const kept = makeAttempt({inventoryCache: community, inventoryCount: 4, inventorySource: 'gc'}).attempt;
	disconnectGameSession(kept);
	assert.deepEqual([kept.inventoryCache, kept.inventoryCount, kept.inventorySource], [community, 5, 'community']);
});

test('等 GC 连上:已连上立即返回;连上/报错/超时/缺模块', async (t: TestContext) => {
	await waitForGcConnection(makeAttempt().attempt, 'cs2');

	const {attempt} = makeAttempt({tf2GcConnected: false});
	const tf2 = attempt.tf2 as EventEmitter;
	const waiting = waitForGcConnection(attempt, 'tf2');
	tf2.emit('connectedToGC');
	await waiting;
	assert.equal(tf2.listenerCount('connectedToGC') + tf2.listenerCount('error'), 0);

	const failing = waitForGcConnection(attempt, 'tf2');
	tf2.emit('error', new Error('GC down'));
	await assert.rejects(failing, /GC down/);

	t.mock.timers.enable({apis: ['setTimeout']});
	const slow = waitForGcConnection(attempt, 'tf2', 3000);
	t.mock.timers.tick(3000);
	await assert.rejects(slow, /等待 TF2 GC 连接超时/);
	t.mock.timers.reset();

	await assert.rejects(waitForGcConnection(makeAttempt({cs2GcConnected: false, csgo: null}).attempt, 'cs2'), /缺少 CS2 GC 模块/);
});
