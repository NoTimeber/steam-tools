import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {
	authorizeMicroTxn,
	EMSG_MICROTXN_AUTH_REQUEST,
	EMSG_MICROTXN_AUTHORIZE,
	EMSG_MICROTXN_AUTHORIZE_RESPONSE,
	installMicroTxnHooks,
	matchMicroTxnRequest,
	normalizeIdValue,
	parseMicroTxnAuthRequest,
	rememberMicroTxnRequest,
	waitForMicroTxnRequest
} from './microtxn.ts';
import type {MessageBody, MessageHeader, MicroTxnRequest} from './microtxn.ts';

const require = createRequire(import.meta.url);
const {microTxnAuthRequestBody} = require('../../test/support/binary-kv.cjs') as {
	microTxnAuthRequestBody(fields: {orderId: string; transId: string; appId: number; billingTotal?: number}): Buffer;
};

const ORDER = '9876543210123';
const TRANS = '18446744073709551000';   // 超过 2^53,必须按字符串处理

class FakeClient extends EventEmitter {
	sent: Array<{header: {msg: number}; body: Buffer}> = [];
	reply: ((body: MessageBody, header?: MessageHeader) => void) | null = null;
	_send(header: {msg: number}, body: Buffer, callback: (body: MessageBody, header?: MessageHeader) => void) {
		this.sent.push({header, body});
		this.reply = callback;
	}
}

test('EMsg 编号与 steam-user 的枚举一致', () => {
	const SteamUser = require('steam-user') as {EMsg: Record<string, number>};
	assert.equal(SteamUser.EMsg.ClientMicroTxnAuthRequest, EMSG_MICROTXN_AUTH_REQUEST);
	assert.equal(SteamUser.EMsg.ClientMicroTxnAuthorize, EMSG_MICROTXN_AUTHORIZE);
	assert.equal(SteamUser.EMsg.ClientMicroTxnAuthorizeResponse, EMSG_MICROTXN_AUTHORIZE_RESPONSE);
});

test('解析授权请求:orderid / transid(64 位)、appid、金额', () => {
	const request = parseMicroTxnAuthRequest(microTxnAuthRequestBody({orderId: ORDER, transId: TRANS, appId: 730, billingTotal: 249}), {msg: 5504, sourceJobID: 'j1'});
	assert.equal(request.orderId, ORDER);
	assert.equal(request.transId, TRANS);
	assert.equal(request.appId, 730);
	assert.equal(request.billingTotal, '249');
	assert.equal(request.leadingByte, 1);
	assert.equal(request.parseError, '');
	assert.deepEqual(request.header, {msg: 5504, sourceJobID: 'j1', targetJobID: ''});

	// ByteBuffer 形态(steam-user 交给处理器的是 ByteBuffer)
	const wrapped = parseMicroTxnAuthRequest({toBuffer: () => microTxnAuthRequestBody({orderId: '1', transId: '2', appId: 440})});
	assert.deepEqual([wrapped.orderId, wrapped.transId, wrapped.appId], ['1', '2', 440]);

	const broken = parseMicroTxnAuthRequest(Buffer.from([1, 0, 0x41]));
	assert.ok(broken.parseError);
	assert.equal(broken.transId, '');
	assert.equal(parseMicroTxnAuthRequest(null).rawHex, '');
});

test('id 归一:字符串、数字、bigint、Long、{value}', () => {
	assert.equal(normalizeIdValue(' 12 '), '12');
	assert.equal(normalizeIdValue(12), '12');
	assert.equal(normalizeIdValue(12n), '12');
	assert.equal(normalizeIdValue({toString: () => '99'}), '99');
	assert.equal(normalizeIdValue({value: 7}), '7');
	assert.equal(normalizeIdValue(null), '');
});

test('匹配规则:orderid 和 appid 任一方为空不比;至少要有 transid 或 orderid', () => {
	const base = {orderId: ORDER, transId: TRANS, appId: 730} as MicroTxnRequest;
	assert.equal(matchMicroTxnRequest(base, ORDER, 730), true);
	assert.equal(matchMicroTxnRequest(base, '1', 730), false);
	assert.equal(matchMicroTxnRequest(base, ORDER, 440), false);
	assert.equal(matchMicroTxnRequest({...base, appId: 0}, ORDER, 440), true);
	assert.equal(matchMicroTxnRequest({...base, orderId: ''}, ORDER, 730), true);
	assert.equal(matchMicroTxnRequest({...base, orderId: '', transId: ''}, ORDER, 730), false);
	assert.equal(matchMicroTxnRequest(null, ORDER), false);
});

test('挂钩子:收到消息时暂存并发事件;同一个类只挂一次;没有分发表返回 false', async (t: TestContext) => {
	const handlers = new Map<number, (this: EventEmitter, body: MessageBody, header?: MessageHeader) => void>();
	let adds = 0;
	class FakeSteamUser extends EventEmitter {}
	(FakeSteamUser.prototype as unknown as {_handlerManager: unknown})._handlerManager = {
		add(emsg: number, handler: (this: EventEmitter, body: MessageBody, header?: MessageHeader) => void) {
			adds++;
			handlers.set(emsg, handler);
		}
	};
	assert.equal(installMicroTxnHooks(FakeSteamUser as never), true);
	assert.equal(installMicroTxnHooks(FakeSteamUser as never), true);
	assert.equal(adds, 1);
	assert.equal(installMicroTxnHooks(class Plain {} as never), false);

	const client = new FakeSteamUser();
	const events: MicroTxnRequest[] = [];
	client.on('microTxnAuthRequest', request => events.push(request));
	handlers.get(EMSG_MICROTXN_AUTH_REQUEST)?.call(client, microTxnAuthRequestBody({orderId: ORDER, transId: TRANS, appId: 730}), {msg: 5504});
	assert.equal(events.length, 1);
	// 事件先到、waitFor 后调:直接取暂存的,取一次就没了
	const request = await waitForMicroTxnRequest(client, ORDER, 730, 1000);
	assert.equal(request.transId, TRANS);
	t.mock.timers.enable({apis: ['setTimeout']});
	const again = waitForMicroTxnRequest(client, ORDER, 730, 1000);
	t.mock.timers.tick(1000);
	await assert.rejects(again, /超时/);
});

test('等授权请求:不匹配的忽略,匹配的取走(不会被下一次误用)', async (t: TestContext) => {
	t.mock.timers.enable({apis: ['setTimeout']});
	const client = new EventEmitter();
	const pending = waitForMicroTxnRequest(client, ORDER, 730, 2000);
	const other = {orderId: '1', transId: '5', appId: 730} as MicroTxnRequest;
	const mine = {orderId: ORDER, transId: TRANS, appId: 730} as MicroTxnRequest;
	// 模拟钩子:先暂存再发事件
	for (const request of [other, mine]) {
		rememberMicroTxnRequest(client, request);
		client.emit('microTxnAuthRequest', request);
	}
	assert.equal(await pending, mine);
	assert.equal(client.listenerCount('microTxnAuthRequest'), 0);
	assert.equal(await waitForMicroTxnRequest(client, '1', 730, 1000), other, '没匹配上的还留着');
	const again = waitForMicroTxnRequest(client, ORDER, 730, 1000);
	t.mock.timers.tick(1000);
	await assert.rejects(again, /超时/);
});

test('暂存的请求超过 10 分钟作废,最多留 12 条', async (t: TestContext) => {
	const client = new EventEmitter();
	const now = Date.now();
	rememberMicroTxnRequest(client, {orderId: 'old', transId: '1', appId: 730} as MicroTxnRequest, now - 11 * 60 * 1000);
	for (let i = 0; i < 13; i++) {
		rememberMicroTxnRequest(client, {orderId: `n${i}`, transId: '1', appId: 730} as MicroTxnRequest, now);
	}
	t.mock.timers.enable({apis: ['setTimeout']});
	const expired = waitForMicroTxnRequest(client, 'old', 730, 1000);
	const dropped = waitForMicroTxnRequest(client, 'n0', 730, 1000);
	t.mock.timers.tick(1000);
	await assert.rejects(expired, /超时/);
	await assert.rejects(dropped, /超时/);
	assert.equal((await waitForMicroTxnRequest(client, 'n12', 730, 1000)).orderId, 'n12');
});

test('授权:载荷是 transid(u64) + 1,回包 OK 才算成功', async () => {
	const client = new FakeClient();
	const pending = authorizeMicroTxn(client, TRANS, 1000);
	assert.equal(client.sent[0]?.header.msg, EMSG_MICROTXN_AUTHORIZE);
	assert.equal(client.sent[0]?.body.readBigUInt64LE(0), BigInt(TRANS));
	assert.equal(client.sent[0]?.body.readUInt32LE(8), 1);
	const ok = Buffer.alloc(4);
	ok.writeUInt32LE(1);
	client.reply?.(ok, {msg: EMSG_MICROTXN_AUTHORIZE_RESPONSE});
	assert.deepEqual(await pending, {result: 1, rawHex: '01000000'});
});

test('授权失败:EResult 不是 OK、回了别的消息、超时、没有发送通道、缺 transid', async (t: TestContext) => {
	const fail = Buffer.alloc(4);
	fail.writeUInt32LE(2);
	let client = new FakeClient();
	let pending = authorizeMicroTxn(client, TRANS, 1000);
	client.reply?.(fail, {msg: EMSG_MICROTXN_AUTHORIZE_RESPONSE});
	await assert.rejects(pending, /result=2/);

	client = new FakeClient();
	pending = authorizeMicroTxn(client, TRANS, 1000);
	client.reply?.(fail, {msg: 1234});
	await assert.rejects(pending, /意外消息 1234/);

	await assert.rejects(authorizeMicroTxn(null, TRANS), /发送通道/);
	await assert.rejects(authorizeMicroTxn(new FakeClient(), ''), /缺少 transid/);

	t.mock.timers.enable({apis: ['setTimeout']});
	client = new FakeClient();
	pending = authorizeMicroTxn(client, TRANS, 1000);
	t.mock.timers.tick(1000);
	await assert.rejects(pending, /超时/);
});
