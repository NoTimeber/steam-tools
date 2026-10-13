// Steam 钱包扣款授权 MicroTxn(从 app/server.js 移来)。
// GC 内购:StorePurchaseInit 之后,Steam 会推来一条 ClientMicroTxnAuthRequest(带 orderid=GC 的 txn_id 和 transid);
// 必须回 ClientMicroTxnAuthorize 同意扣款,之后的 StorePurchaseFinalize 才会成功(否则 result=5)。
// steam-user 不处理这条消息:installMicroTxnHooks 往它的消息分发表里挂处理器,把请求暂存起来并发
// microTxnAuthRequest 事件;waitForMicroTxnRequest 取暂存或等事件,authorizeMicroTxn 发授权并等回包。

import type {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const BinaryKvParser = require('binarykvparser') as {parse(input: Buffer): unknown};

// steam-user 的 EMsg 编号(单元测试里和库里的枚举核对)
export const EMSG_MICROTXN_AUTH_REQUEST = 5504;
export const EMSG_MICROTXN_AUTHORIZE = 5505;
export const EMSG_MICROTXN_AUTHORIZE_RESPONSE = 5506;
export const DEFAULT_MICROTXN_TIMEOUT_MS = 15000;
const STEAM_OK_RESULT = 1;
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_LIMIT = 12;

/** steam-user 交给消息处理器的 body:ByteBuffer 或 Buffer */
export type MessageBody = Buffer | Uint8Array | {toBuffer(): Buffer} | {buffer: Buffer} | null | undefined;

export interface MessageHeader {
	msg?: number;
	sourceJobID?: unknown;
	targetJobID?: unknown;
}

export interface MicroTxnRequest {
	receivedAt: string;
	appId: number;
	orderId: string;
	transId: string;
	billingTotal: string;
	leadingByte: number | null;
	header: {msg: unknown; sourceJobID: unknown; targetJobID: unknown} | null;
	messageObject: Record<string, unknown>;
	parseError: string;
	rawHex: string;
}

export interface MicroTxnClient extends EventEmitter {
	_send(header: {msg: number}, body: Buffer, callback: (body: MessageBody, header?: MessageHeader) => void): void;
}

type Handler = (this: EventEmitter, body: MessageBody, header?: MessageHeader) => void;

export interface SteamUserClass {
	prototype: {_handlerManager?: {add(emsg: number, handler: Handler): void}};
}

// 每个客户端上暂存的授权请求(可能先于 waitForMicroTxnRequest 到达)
const pendingByClient = new WeakMap<object, Array<{request: MicroTxnRequest; createdAtMs: number}>>();
const hookedClasses = new WeakSet<object>();

function toBuffer(body: MessageBody): Buffer {
	if (!body) {
		return Buffer.alloc(0);
	}
	if (Buffer.isBuffer(body)) {
		return body;
	}
	if (typeof (body as {toBuffer?: unknown}).toBuffer === 'function') {
		return (body as {toBuffer(): Buffer}).toBuffer();
	}
	const inner = (body as {buffer?: unknown}).buffer;
	if (inner && Buffer.isBuffer(inner)) {
		return inner;
	}
	return Buffer.from(body as Uint8Array);
}

/** 取字段:先精确匹配,再不区分大小写 */
function readField(source: unknown, names: string[]): unknown {
	if (!source || typeof source !== 'object') {
		return null;
	}
	const record = source as Record<string, unknown>;
	const keys = Object.keys(record);
	for (const name of names) {
		if (Object.prototype.hasOwnProperty.call(record, name)) {
			return record[name];
		}
		const matchedKey = keys.find(key => key.toLowerCase() === name.toLowerCase());
		if (matchedKey) {
			return record[matchedKey];
		}
	}
	return null;
}

/** orderid / transid 是 64 位整数,BinaryKV 解出来可能是字符串、数字、bigint 或 Long 对象 */
export function normalizeIdValue(value: unknown): string {
	if (value == null) {
		return '';
	}
	if (typeof value === 'string') {
		return value.trim();
	}
	if (typeof value === 'number' || typeof value === 'bigint') {
		return String(value);
	}
	if (typeof value === 'object') {
		const toText = (value as {toString?: unknown}).toString;
		if (typeof toText === 'function') {
			const text = String(toText.call(value)).trim();
			if (text && text !== '[object Object]') {
				return text;
			}
		}
		if (Object.prototype.hasOwnProperty.call(value, 'value')) {
			return normalizeIdValue((value as {value: unknown}).value);
		}
	}
	return String(value).trim();
}

/** 消息体:1 字节前缀 + BinaryKV({MessageObject: {orderid, transid, appid, BillingTotal, ...}}) */
export function parseMicroTxnAuthRequest(body: MessageBody, header?: MessageHeader | null): MicroTxnRequest {
	const buffer = toBuffer(body);
	const leadingByte = buffer.length ? buffer.readUInt8(0) : null;
	let parsed: unknown = null;
	let parseError = '';
	try {
		parsed = buffer.length > 1 ? BinaryKvParser.parse(buffer.subarray(1)) : null;
	} catch (err) {
		parseError = err instanceof Error ? err.message : String(err || 'parse failed');
	}

	let messageObject: Record<string, unknown> = {};
	if (parsed && typeof parsed === 'object') {
		const root = parsed as Record<string, unknown>;
		const nested = ['MessageObject', 'messageObject', 'messageobject'].map(key => root[key]).find(value => value && typeof value === 'object');
		messageObject = (nested as Record<string, unknown> | undefined) ?? root;
	}
	const appId = Number(readField(messageObject, ['appid', 'app_id', 'appId', 'AppID']) || 0);
	return {
		receivedAt: new Date().toISOString(),
		appId: Number.isFinite(appId) && appId > 0 ? appId : 0,
		orderId: normalizeIdValue(readField(messageObject, ['orderid', 'order_id', 'orderId', 'OrderID'])),
		transId: normalizeIdValue(readField(messageObject, ['transid', 'trans_id', 'transId', 'TransID'])),
		billingTotal: normalizeIdValue(readField(messageObject, ['BillingTotal', 'billingtotal', 'billing_total', 'total'])),
		leadingByte,
		header: header ? {msg: header.msg, sourceJobID: header.sourceJobID || '', targetJobID: header.targetJobID || ''} : null,
		messageObject,
		parseError,
		rawHex: buffer.toString('hex')
	};
}

/** 暂存一条授权请求:丢掉超过 10 分钟的,最多留最近 12 条 */
export function rememberMicroTxnRequest(client: object, request: MicroTxnRequest, now = Date.now()): void {
	const fresh = (pendingByClient.get(client) ?? []).filter(entry => now - entry.createdAtMs <= PENDING_TTL_MS);
	fresh.push({request, createdAtMs: now});
	pendingByClient.set(client, fresh.slice(-PENDING_LIMIT));
}

function takePending(client: object, matcher: (request: MicroTxnRequest) => boolean): MicroTxnRequest | null {
	const list = pendingByClient.get(client);
	const index = list ? list.findIndex(entry => matcher(entry.request)) : -1;
	if (!list || index < 0) {
		return null;
	}
	return list.splice(index, 1)[0]?.request ?? null;
}

/** orderid 对得上(任一方为空不比)、appid 对得上(任一方为 0 不比),且至少带 transid 或 orderid */
export function matchMicroTxnRequest(request: MicroTxnRequest | null | undefined, expectedOrderId: unknown, expectedAppId = 0): boolean {
	if (!request) {
		return false;
	}
	const requestOrderId = normalizeIdValue(request.orderId);
	const targetOrderId = normalizeIdValue(expectedOrderId);
	if (targetOrderId && requestOrderId && requestOrderId !== targetOrderId) {
		return false;
	}
	if (expectedAppId && Number(request.appId || 0) && Number(request.appId || 0) !== Number(expectedAppId)) {
		return false;
	}
	return !!(request.transId || request.orderId);
}

/** 给 steam-user 挂 ClientMicroTxnAuthRequest 处理器(每个类只挂一次)。库没有消息分发表时返回 false。 */
export function installMicroTxnHooks(SteamUser: SteamUserClass): boolean {
	if (hookedClasses.has(SteamUser)) {
		return true;
	}
	const handlers = SteamUser.prototype._handlerManager;
	if (!handlers || typeof handlers.add !== 'function') {
		return false;
	}
	handlers.add(EMSG_MICROTXN_AUTH_REQUEST, function(body, header) {
		const request = parseMicroTxnAuthRequest(body, header);
		rememberMicroTxnRequest(this, request);
		this.emit('microTxnAuthRequest', request);
	});
	hookedClasses.add(SteamUser);
	return true;
}

/** 等 orderid=expectedOrderId 的授权请求:已暂存的直接取,否则等 microTxnAuthRequest 事件 */
export function waitForMicroTxnRequest(client: EventEmitter, expectedOrderId: unknown, expectedAppId = 0, timeoutMs = DEFAULT_MICROTXN_TIMEOUT_MS): Promise<MicroTxnRequest> {
	const immediate = takePending(client, request => matchMicroTxnRequest(request, expectedOrderId, expectedAppId));
	if (immediate) {
		return Promise.resolve(immediate);
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (handler: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			client.removeListener('microTxnAuthRequest', onRequest);
			handler();
		};
		const onRequest = (request: MicroTxnRequest) => {
			if (!matchMicroTxnRequest(request, expectedOrderId, expectedAppId)) {
				return;
			}
			// 处理器已经把它暂存了,取走免得下次误用
			takePending(client, entry => entry === request);
			finish(() => resolve(request));
		};
		timer = setTimeout(() => {
			finish(() => reject(new Error('等待 Steam MicroTxn 授权请求超时')));
		}, Math.max(1000, Number(timeoutMs || DEFAULT_MICROTXN_TIMEOUT_MS)));
		client.on('microTxnAuthRequest', onRequest);
	});
}

/** 发 ClientMicroTxnAuthorize(transid u64 + 同意 u32=1),回包 EResult 必须是 OK */
export function authorizeMicroTxn(client: MicroTxnClient | null | undefined, transId: unknown, timeoutMs = DEFAULT_MICROTXN_TIMEOUT_MS): Promise<{result: number; rawHex: string}> {
	if (!client || typeof client._send !== 'function') {
		return Promise.reject(new Error('当前账号没有可用的 Steam 客户端发送通道'));
	}
	const transIdText = normalizeIdValue(transId);
	if (!transIdText) {
		return Promise.reject(new Error('Steam MicroTxn 请求缺少 transid'));
	}
	const payload = Buffer.alloc(12);
	payload.writeBigUInt64LE(BigInt(transIdText), 0);
	payload.writeUInt32LE(1, 8);

	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (handler: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			handler();
		};
		timer = setTimeout(() => {
			finish(() => reject(new Error('等待 Steam MicroTxnAuthorizeResponse 超时')));
		}, Math.max(1000, Number(timeoutMs || DEFAULT_MICROTXN_TIMEOUT_MS)));
		try {
			client._send({msg: EMSG_MICROTXN_AUTHORIZE}, payload, (body, header) => {
				const bodyBuffer = toBuffer(body);
				const eresult = bodyBuffer.length >= 4 ? bodyBuffer.readUInt32LE(0) : 0;
				finish(() => {
					if (header && header.msg && header.msg !== EMSG_MICROTXN_AUTHORIZE_RESPONSE) {
						reject(new Error(`Steam MicroTxn 返回了意外消息 ${header.msg}`));
						return;
					}
					if (eresult !== STEAM_OK_RESULT) {
						reject(new Error(`Steam MicroTxnAuthorize 返回失败 result=${eresult}`));
						return;
					}
					resolve({result: eresult, rawHex: bodyBuffer.toString('hex')});
				});
			});
		} catch (err) {
			finish(() => reject(err));
		}
	});
}
