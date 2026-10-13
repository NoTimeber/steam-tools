import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Attempt} from '../steam/session-manager.ts';
import type {MessageBody, MessageHeader} from '../steam/microtxn.ts';
import {EMSG_MICROTXN_AUTHORIZE_RESPONSE, rememberMicroTxnRequest} from '../steam/microtxn.ts';
import {buildPurchaseInit, createStoreGc, longToString, normalizeStoreCurrency, UY_STORE_CURRENCY} from './store-gc.ts';
import type {PurchaseOrder, StoreData} from './store-gc.ts';
import type {CatalogItem, CatalogItemBuilder} from './catalog-items.ts';

const require = createRequire(import.meta.url);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'price-sheets');

const KEY: CatalogItem = {def_index: 5021, name: 'Key', type: '钥匙', category: '钥匙', prices: {USD: 249, UYU: 9900}};

function storeData(overrides: Partial<StoreData> = {}): StoreData {
	return {
		source: 'gc', fetchedAt: '', account: 'alpha', attemptId: 'a1', game: 'cs2', country: 'US', currency: 1, currencyISO: 'USD',
		balance: 10, priceSheetVersion: 1, list: [KEY], ...overrides
	};
}

function order(items: PurchaseOrder['items'], overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
	return {currencyISO: 'USD', country: 'US', items, ...overrides};
}

const attemptInfo = {currency: 1, country: 'US', loginGeoCountry: ''};

test('乌拉圭商店币种:钱包 41 / ISO UYU / 未知都归成 40,其它原样', () => {
	assert.equal(normalizeStoreCurrency(41, 'UY', ''), UY_STORE_CURRENCY);
	assert.equal(normalizeStoreCurrency(0, 'uy', ''), UY_STORE_CURRENCY);
	assert.equal(normalizeStoreCurrency(1, 'UY', 'UYU'), UY_STORE_CURRENCY);
	assert.equal(normalizeStoreCurrency(1, 'UY', 'USD'), 1);
	assert.equal(normalizeStoreCurrency(41, 'US', 'UYU'), 41);
	assert.equal(normalizeStoreCurrency('3', 'DE', 'EUR'), 3);
});

test('64 位 id 转字符串', () => {
	assert.equal(longToString(null), '');
	assert.equal(longToString('12'), '12');
	assert.equal(longToString(12n), '12');
	assert.equal(longToString({toString: () => '34'}), '34');
});

test('CS2 下单载荷:美元省略 currency,行项总价 = 单价 × 数量,不发 purchase_type', () => {
	const plan = buildPurchaseInit('cs2', order([{itemDefId: 1200, quantity: 3, unitPriceCents: 199}]), storeData(), attemptInfo);
	assert.deepEqual(plan.body, {country: 'US', language: 6, line_items: [{item_def_id: 1200, quantity: 3, cost_in_local_currency: 597}]});
	assert.match(plan.describe, /currency=省略\(USD基准币种\)/);
});

test('CS2 下单载荷:非美元带 currency;乌拉圭钱包 41 换成商店 40', () => {
	const euro = buildPurchaseInit('cs2', order([{itemDefId: 1200, quantity: 1, unitPriceCents: 185}], {currencyISO: 'EUR'}), storeData({currency: 3, country: 'DE', currencyISO: 'EUR'}), attemptInfo);
	assert.equal(euro.body.currency, 3);
	const uy = buildPurchaseInit('cs2', order([{itemDefId: 1200, quantity: 1, unitPriceCents: 8000}], {currencyISO: 'UYU'}), storeData({currency: 41, country: 'UY', currencyISO: 'UYU'}), attemptInfo);
	assert.equal(uy.body.currency, 40);
	assert.match(uy.describe, /钱包41→商店40/);
	assert.match(uy.failureDetail, /currency=40/);
});

test('TF2 下单载荷:钥匙不发 purchase_type,其它商品发 0;美元省略 currency', () => {
	const plan = buildPurchaseInit('tf2', order([
		{itemDefId: 5021, quantity: 2, unitPriceCents: 249},
		{itemDefId: 1, quantity: 1, unitPriceCents: 100}
	]), storeData({game: 'tf2'}), attemptInfo);
	assert.deepEqual(plan.body, {
		country: 'US',
		language: 6,
		line_items: [
			{item_def_id: 5021, quantity: 2, cost_in_local_currency: 498},
			{item_def_id: 1, quantity: 1, cost_in_local_currency: 100, purchase_type: 0}
		]
	});
	assert.match(plan.failureDetail, /ptype=省略\/0/);
});

test('TF2 乌拉圭钥匙:按价目表里的 UYU 价计价,没有就用 9600;国家缺失时由币种推出 UY', () => {
	const uyStore = storeData({game: 'tf2', currency: 41, country: 'UY', currencyISO: 'UYU'});
	const uyOrder = (quantity: number) => order([{itemDefId: 5021, quantity, unitPriceCents: 1}], {currencyISO: 'UYU', country: ''});
	const withPrice = buildPurchaseInit('tf2', uyOrder(2), uyStore, attemptInfo);
	assert.deepEqual(withPrice.body, {country: 'UY', language: 6, currency: 40, line_items: [{item_def_id: 5021, quantity: 2, cost_in_local_currency: 19800}]});
	const noPrice = buildPurchaseInit('tf2', uyOrder(1), {...uyStore, list: []}, attemptInfo);
	assert.equal(noPrice.body.line_items[0]?.cost_in_local_currency, 9600);
	const inferred = buildPurchaseInit('tf2', uyOrder(1), {...uyStore, currency: 40, country: ''}, attemptInfo);
	assert.equal(inferred.body.country, 'UY', '商店币种 40 推出乌拉圭');
	assert.equal(inferred.body.line_items[0]?.cost_in_local_currency, 9900);
});

// ===== 下单流程:用真实 protobuf 编解码的假 GC =====

const protos = require('globaloffensive/protobufs/generated/base_gcmessages') as Record<string, {
	encode(message: unknown): {finish(): Uint8Array};
	decode(payload: Uint8Array): unknown;
	toObject(message: unknown, options: Record<string, unknown>): Record<string, unknown>;
}>;
const MSG = {getUserData: 2500, getUserDataResponse: 2501, init: 2510, initResponse: 2511, finalize: 2504, finalizeResponse: 2505};

interface GcScript {
	initResult?: number;
	txnId?: string;
	/** 收到 Init 后推来的扣款授权请求;null 表示不推 */
	microTxn?: {orderId?: string; transId: string; appId: number} | null;
	authorizeResult?: number;
	finalizeResult?: number;
	wallet?: [boolean, number, number] | null;
}

class FakeGcClient extends EventEmitter {
	steamID = {getSteamID64: () => '76561190000000001'};
	sent: Array<{msgType: number; body: Record<string, unknown>}> = [];
	authorized: string[] = [];
	script: GcScript;
	constructor(script: GcScript) {
		super();
		this.script = script;
	}
	reply(msgType: number, type: string, body: unknown) {
		setImmediate(() => this.emit('receivedFromGC', 730, msgType, protos[type]!.encode(body).finish()));
	}
	sendToGC(_appid: number, msgType: number, _header: unknown, payload: Uint8Array) {
		const decode = (type: string) => protos[type]!.toObject(protos[type]!.decode(payload), {longs: String});
		if (msgType === MSG.getUserData) {
			this.sent.push({msgType, body: decode('CMsgStoreGetUserData')});
			this.reply(MSG.getUserDataResponse, 'CMsgStoreGetUserDataResponse', {result: 1, price_sheet_version: 7, currency: 1, price_sheet: readFileSync(join(FIXTURES, 'cs2-usd.bkv'))});
		} else if (msgType === MSG.init) {
			this.sent.push({msgType, body: decode('CMsgGCStorePurchaseInit')});
			const txnId = this.script.txnId ?? '1234567890123';
			this.reply(MSG.initResponse, 'CMsgGCStorePurchaseInitResponse', {result: this.script.initResult ?? 1, txn_id: txnId});
			const microTxn = this.script.microTxn === undefined ? {transId: '555', appId: 730} : this.script.microTxn;
			if (microTxn) {
				setImmediate(() => {
					const request = {receivedAt: '', appId: microTxn.appId, orderId: microTxn.orderId ?? txnId, transId: microTxn.transId, billingTotal: '', leadingByte: 1, header: null, messageObject: {}, parseError: '', rawHex: ''};
					rememberMicroTxnRequest(this, request);
					this.emit('microTxnAuthRequest', request);
				});
			}
		} else if (msgType === MSG.finalize) {
			this.sent.push({msgType, body: decode('CMsgGCStorePurchaseFinalize')});
			this.reply(MSG.finalizeResponse, 'CMsgGCStorePurchaseFinalizeResponse', {result: this.script.finalizeResult ?? 1, item_ids: ['111', '222']});
			const wallet = this.script.wallet === undefined ? [true, 1, 5.02] : this.script.wallet;
			if (wallet) {
				setTimeout(() => this.emit('wallet', ...wallet), 5);
			}
		}
	}
	_send(header: {msg: number}, body: Buffer, callback: (body: MessageBody, header?: MessageHeader) => void) {
		this.authorized.push(String(body.readBigUInt64LE(0)));
		const result = Buffer.alloc(4);
		result.writeUInt32LE(this.script.authorizeResult ?? 1);
		setImmediate(() => callback(result, {msg: EMSG_MICROTXN_AUTHORIZE_RESPONSE}));
	}
}

function setup(t: TestContext, script: GcScript = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'store-gc-'));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	const client = new FakeGcClient(script);
	const attempt = {
		id: 'a1', accountName: 'alpha', status: 'web_session', client, csgo: new EventEmitter(), cs2GcConnected: true,
		currency: 1, currencyISO: 'USD', country: 'US', loginGeoCountry: '', balance: 9.99, logs: []
	} as unknown as Attempt;
	const logs: string[] = [];
	let emits = 0;
	const items = {buildCatalog: () => [KEY]} as unknown as CatalogItemBuilder;
	const gc = createStoreGc({
		items,
		events: {addLog: (_attempt, level, message) => logs.push(`${level} ${message}`), emit: () => void emits++},
		priceSheetDir: dir,
		timeoutMs: 1000,
		logger: {warn() {}}
	});
	return {gc, client, attempt, logs, dir, emits: () => emits};
}

const keyOrder = order([{itemDefId: 5021, quantity: 2, unitPriceCents: 249}]);

/** 让假 GC 用 setImmediate 发的回包都处理完(之后只剩定时器在等) */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise(resolve => setImmediate(resolve));
	}
}

test('查商店数据:带钱包币种请求,解析价目表,留样一份', async (t: TestContext) => {
	const {gc, client, attempt, dir} = setup(t);
	const data = await gc.queryUserData(attempt, 'cs2');
	// 请求里带了钱包币种,但实际生效的是 TF2 版消息类型(没有 currency 字段),编码时被丢掉;见 store-gc.ts 的 messagesFor
	assert.deepEqual(client.sent[0], {msgType: MSG.getUserData, body: {price_sheet_version: 0}});
	assert.equal(data.currency, 1);
	assert.equal(data.currencyISO, 'USD');
	assert.equal(data.country, 'US');
	assert.equal(data.priceSheetVersion, 7);
	assert.equal(data.parsedPriceSheet?.source, 'raw-binarykv');
	assert.deepEqual(data.list, [KEY]);
	assert.deepEqual(readdirSync(dir), ['cs2-price-sheet-alpha-USD-7-raw-binarykv.bkv']);
	await gc.queryUserData(attempt, 'cs2');
	assert.equal(readdirSync(dir).length, 1, '同一份不重复写');
});

test('下单成功:Init → 授权 transid → Finalize(同一 txn),余额按钱包事件更新', async (t: TestContext) => {
	const {gc, client, attempt, logs, emits} = setup(t);
	const result = await gc.purchase(attempt, 'cs2', keyOrder, storeData());
	assert.deepEqual(result, {txnId: '1234567890123', itemIds: ['111', '222'], initResult: 1, finalizeResult: 1, balanceAfter: 5.02});
	assert.deepEqual(client.sent.map(entry => entry.msgType), [MSG.init, MSG.finalize]);
	assert.deepEqual(client.sent[0]?.body, {country: 'US', language: 6, line_items: [{item_def_id: 5021, quantity: 2, cost_in_local_currency: 498}]});
	assert.deepEqual(client.sent[1]?.body, {txn_id: '1234567890123'});
	assert.deepEqual(client.authorized, ['555']);
	assert.equal(attempt.balance, 5.02);
	assert.ok(logs.some(line => line.includes('[CS2内购] Steam MicroTxn 授权完成: transid=555')));
	assert.equal(emits(), 2);
});

test('下单失败:Init 被拒时不授权、不 Finalize,错误里带载荷摘要', async (t: TestContext) => {
	const {gc, client, attempt} = setup(t, {initResult: 8, microTxn: null});
	await assert.rejects(gc.purchase(attempt, 'cs2', keyOrder, storeData()), /PurchaseInit 返回失败 result=8\(载荷 country=US currency=省略 cost=498\)/);
	assert.deepEqual(client.sent.map(entry => entry.msgType), [MSG.init]);
	assert.deepEqual(client.authorized, []);
});

test('下单失败:没有 txn_id、等不到授权请求、授权被拒、Finalize 失败', async (t: TestContext) => {
	let ctx = setup(t, {txnId: '0', microTxn: null});
	await assert.rejects(ctx.gc.purchase(ctx.attempt, 'cs2', keyOrder, storeData()), /未返回有效 txn_id/);

	// 授权请求的 orderid 对不上 → 等不到
	ctx = setup(t, {microTxn: {orderId: '999', transId: '1', appId: 730}});
	t.mock.timers.enable({apis: ['setTimeout']});
	const waiting = ctx.gc.purchase(ctx.attempt, 'cs2', keyOrder, storeData());
	await settle();
	t.mock.timers.tick(1000);
	await assert.rejects(waiting, /等待 Steam MicroTxn 授权请求失败: 等待 Steam MicroTxn 授权请求超时/);
	assert.deepEqual(ctx.client.sent.map(entry => entry.msgType), [MSG.init]);
	t.mock.timers.reset();

	ctx = setup(t, {authorizeResult: 2});
	await assert.rejects(ctx.gc.purchase(ctx.attempt, 'cs2', keyOrder, storeData()), /Steam MicroTxn 授权失败: .*result=2/);
	assert.deepEqual(ctx.client.sent.map(entry => entry.msgType), [MSG.init], '授权失败不 Finalize');

	ctx = setup(t, {finalizeResult: 5, wallet: null});
	await assert.rejects(ctx.gc.purchase(ctx.attempt, 'cs2', keyOrder, storeData()), /PurchaseFinalize 返回失败 result=5/);
	assert.equal(ctx.attempt.balance, 9.99);
});

test('下单成功但没等到钱包更新:余额不变,balanceAfter 为 null', async (t: TestContext) => {
	const {gc, attempt} = setup(t, {wallet: null});
	t.mock.timers.enable({apis: ['setTimeout']});
	const pending = gc.purchase(attempt, 'cs2', keyOrder, storeData());
	await settle();
	t.mock.timers.tick(5000);
	const result = await pending;
	assert.equal(result.balanceAfter, null);
	assert.equal(attempt.balance, 9.99);
});
