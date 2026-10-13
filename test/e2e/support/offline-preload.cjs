'use strict';
// 端到端测试的离线环境:在 app/server.js 之前预加载(node --require),保证测试不碰任何外部服务。
//
// 1. 假 steam-user:
//    - refreshToken 以 "RT-GOOD-" 开头,或密码是 "pw-good" → 登录成功
//      (依次触发 loggedOn / wallet / refreshToken / webSession);
//    - 其它 → error(refreshToken 登录报 AccessDenied=15,密码登录报 InvalidPassword=5)。
// 2. 最小 GC 模拟(CS2 730 / TF2 440):
//    - gamesPlayed 进入游戏 → appLaunched,GC 模块随后发 ClientHello,这里回 ClientWelcome(→ connectedToGC);
//    - StoreGetUserData(2500)→ 回 StoreGetUserDataResponse(2501),price_sheet 用 test/fixtures 里的真实样本
//      (可用 FAKE_GC_PRICE_SHEET_730 / FAKE_GC_PRICE_SHEET_440 换文件)。
// 3. GC 商店下单(钱包初始 10.00 美元):
//    - StorePurchaseInit(2510)→ 回 txn_id,随后经 steam-user 的消息分发推一条 ClientMicroTxnAuthRequest;
//      按真实 GC 实测的规则拒单:带 currency=1(美元)或 purchase_type=0 → result=8,不推授权请求;
//    - ClientMicroTxnAuthorize(_send)→ 记下已授权,回 OK;
//    - StorePurchaseFinalize(CS2 2504 / TF2 2512)→ 已授权的回 result=1 和新 item_id,扣钱包并发 wallet 事件;未授权回 5。
// 4. 假悠悠接口(*.youpin898.com):按 FAKE_UU_FILE 里的场景回包(测试随时改这个文件),见 fakeUu();
//    token 不在场景里的一律回登录失效(84101)。
// 5. 报价接受:steam-tradeoffer-manager / steamcommunity 换成替身,报价从场景的 offers 里取;
//    接受、手机确认只记日志,不连 Steam。
// 6. 假 Steam 市场(steamcommunity.com/market/*),有状态:挂求购、手机确认、撤单、我的求购单,见 fakeMarket();
//    场景开关在 FAKE_MARKET_FILE。steamcommunity 替身的 getConfirmations 列出待确认的求购单;
//    steam-totp 的 getTimeOffset 换成离线版(返回 0)。
// 7. 外网拦截:全局 fetch 只放行本机;汇率接口返回固定数据;其余外部请求直接失败。
//
// logOn / logOff / gamesPlayed / sendToGC / 下单各步 / 悠悠请求 / 报价接受 / 市场请求和确认 / 被拦的外部请求
// 都追加一行 JSON 到 FAKE_STEAM_LOG(设置了才写)。

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const {microTxnAuthRequestBody} = require('../../support/binary-kv.cjs');

const ROOT = path.join(__dirname, '..', '..', '..');
const appDir = path.join(ROOT, 'app');
const realPath = require.resolve('steam-user', {paths: [appDir]});
const real = require(realPath);
const LOG = process.env.FAKE_STEAM_LOG || '';
const RUN = process.env.FAKE_STEAM_RUN || '0';

const GC_CLIENT_HELLO = 4006;
const GC_CLIENT_WELCOME = 4004;
const GC_STORE_GET_USER_DATA = 2500;
const GC_STORE_GET_USER_DATA_RESPONSE = 2501;
const GC_STORE_PURCHASE_INIT = 2510;
const GC_STORE_PURCHASE_INIT_RESPONSE = 2511;
const GC_STORE_PURCHASE_FINALIZE = {730: 2504, 440: 2512};
const GC_STORE_PURCHASE_FINALIZE_RESPONSE = {730: 2505, 440: 2513};
const INITIAL_WALLET_CENTS = 1000;
const PRICE_SHEETS = {
	730: process.env.FAKE_GC_PRICE_SHEET_730 || path.join(ROOT, 'test', 'fixtures', 'price-sheets', 'cs2-usd.bkv'),
	440: process.env.FAKE_GC_PRICE_SHEET_440 || path.join(ROOT, 'test', 'fixtures', 'price-sheets', 'tf2-usd.bkv')
};

function record(entry) {
	if (LOG) {
		fs.appendFileSync(LOG, JSON.stringify({run: RUN, ...entry}) + '\n');
	}
}

// GC 消息的 protobuf 类型(在用到时才加载,不改变 server.js 自己的模块加载顺序)
function gcProtos(appid) {
	const load = name => require(require.resolve(name, {paths: [appDir]}));
	const store = protos => ({
		storeResponse: protos.CMsgStoreGetUserDataResponse,
		purchaseInit: protos.CMsgGCStorePurchaseInit,
		purchaseInitResponse: protos.CMsgGCStorePurchaseInitResponse,
		purchaseFinalize: protos.CMsgGCStorePurchaseFinalize,
		purchaseFinalizeResponse: protos.CMsgGCStorePurchaseFinalizeResponse
	});
	if (appid === 730) {
		return {welcome: load('globaloffensive/protobufs/generated/_load').CMsgClientWelcome, ...store(load('globaloffensive/protobufs/generated/base_gcmessages'))};
	}
	const tf2 = load('tf2/protobufs/generated/_load');
	return {welcome: tf2.CMsgClientWelcome, ...store(tf2)};
}

const decode = (type, payload) => type.toObject(type.decode(payload), {longs: String});

const encode = (type, body) => Buffer.from(type.encode(body).finish());

let seq = 0;
let txnSeq = 0;
// steam-user 的消息分发表:app 用 installMicroTxnHooks 往这里挂 ClientMicroTxnAuthRequest 的处理器
const messageHandlers = new Map();

class FakeSteamUser extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		// globaloffensive / tf2 会校验这两个字段
		this.packageName = 'steam-user';
		this.packageVersion = '5.3.0';
		this.steamID = null;
		this.publicIP = '203.0.113.9';
		this.cellID = 1;
		this.playing = [];
		this.n = `${RUN}.${++seq}`;
		this.walletCents = INITIAL_WALLET_CENTS;
		this.txns = new Map();   // txn_id -> {appid, total, transId, authorized}
	}

	logOn(details) {
		record({
			event: 'logOn',
			client: this.n,
			details: {...details, password: details.password ? `<${details.password}>` : undefined}
		});
		setTimeout(() => {
			const name = details.accountName || String(details.refreshToken || '').replace(/^RT-GOOD-/, '');
			const ok = (details.refreshToken && String(details.refreshToken).startsWith('RT-GOOD-')) || details.password === 'pw-good';
			if (!ok) {
				const err = new Error(details.refreshToken ? 'AccessDenied' : 'InvalidPassword');
				err.eresult = details.refreshToken ? 15 : 5;
				this.emit('error', err);
				return;
			}
			this.steamID = {getSteamID64: () => '76561190' + String(100000000 + name.length * 1111)};
			this.emit('loggedOn', {});
			this.emit('wallet', true, 1, this.walletCents / 100);
			this.emit('refreshToken', 'RT-GOOD-' + name);
			this.emit('webSession', 'sid-' + this.n, ['steamLoginSecure=fake-' + this.n]);
		}, 30);
	}

	logOff() {
		record({event: 'logOff', client: this.n});
		for (const appid of this.playing) {
			this.emit('appQuit', appid);
		}
		this.playing = [];
	}

	webLogOn() {}

	gamesPlayed(apps) {
		const next = (apps || []).map(Number);
		record({event: 'gamesPlayed', client: this.n, apps: next});
		const quit = this.playing.filter(appid => !next.includes(appid));
		const launched = next.filter(appid => !this.playing.includes(appid));
		this.playing = next;
		setImmediate(() => {
			quit.forEach(appid => this.emit('appQuit', appid));
			launched.forEach(appid => this.emit('appLaunched', appid));
		});
	}

	sendToGC(appid, msgType, protoHeader, payload) {
		record({event: 'sendToGC', client: this.n, appid, msgType});
		if (!this.playing.includes(appid)) {
			return;
		}
		setImmediate(() => {
			if (msgType === GC_CLIENT_HELLO) {
				this.emit('receivedFromGC', appid, GC_CLIENT_WELCOME, encode(gcProtos(appid).welcome, {version: 1}));
			} else if (msgType === GC_STORE_GET_USER_DATA) {
				const priceSheet = fs.readFileSync(PRICE_SHEETS[appid]);
				this.emit('receivedFromGC', appid, GC_STORE_GET_USER_DATA_RESPONSE, encode(gcProtos(appid).storeResponse, {
					result: 1,
					price_sheet_version: 1,
					price_sheet: priceSheet
				}));
			} else if (msgType === GC_STORE_PURCHASE_INIT) {
				this.purchaseInit(appid, decode(gcProtos(appid).purchaseInit, payload));
			} else if (msgType === GC_STORE_PURCHASE_FINALIZE[appid]) {
				this.purchaseFinalize(appid, decode(gcProtos(appid).purchaseFinalize, payload));
			}
		});
	}

	purchaseInit(appid, body) {
		const lines = body.line_items || [];
		const total = lines.reduce((sum, line) => sum + Number(line.cost_in_local_currency || 0), 0);
		// 真实 GC 实测:美元账号带 currency=1、或行项带 purchase_type=0,都会 InvalidParam(8)
		const invalid = Number(body.currency) === 1 || lines.some(line => line.purchase_type === 0);
		const txnId = invalid ? '0' : String(1700000000000n * 1000n + BigInt(++txnSeq));
		record({event: 'purchaseInit', client: this.n, appid, body, txnId});
		this.emit('receivedFromGC', appid, GC_STORE_PURCHASE_INIT_RESPONSE, encode(gcProtos(appid).purchaseInitResponse, {result: invalid ? 8 : 1, txn_id: txnId}));
		if (invalid) {
			return;
		}
		const transId = String(9000000000000000000n + BigInt(txnSeq));
		this.txns.set(txnId, {appid, total, transId, authorized: false});
		setImmediate(() => {
			const handler = messageHandlers.get(real.EMsg.ClientMicroTxnAuthRequest);
			if (handler) {
				handler.call(this, microTxnAuthRequestBody({orderId: txnId, transId, appId: appid, billingTotal: total}), {msg: real.EMsg.ClientMicroTxnAuthRequest});
			}
		});
	}

	purchaseFinalize(appid, body) {
		const txnId = String(body.txn_id || '');
		const txn = this.txns.get(txnId);
		const ok = !!(txn && txn.authorized && txn.appid === appid);
		record({event: 'purchaseFinalize', client: this.n, appid, txnId, ok});
		this.emit('receivedFromGC', appid, GC_STORE_PURCHASE_FINALIZE_RESPONSE[appid], encode(gcProtos(appid).purchaseFinalizeResponse, {
			result: ok ? 1 : 5,
			item_ids: ok ? [String(BigInt(txnId) + 1n)] : []
		}));
		if (ok) {
			this.txns.delete(txnId);
			this.walletCents -= txn.total;
			setTimeout(() => this.emit('wallet', true, 1, this.walletCents / 100), 10);
		}
	}

	_send(header, body, callback) {
		if (header.msg !== real.EMsg.ClientMicroTxnAuthorize) {
			return;
		}
		const transId = body.readBigUInt64LE(0).toString();
		const approve = body.readUInt32LE(8);
		const txn = [...this.txns.values()].find(item => item.transId === transId);
		record({event: 'microTxnAuthorize', client: this.n, transId, approve});
		if (txn && approve === 1) {
			txn.authorized = true;
		}
		const result = Buffer.alloc(4);
		result.writeUInt32LE(txn ? 1 : 2);
		setImmediate(() => callback(result, {msg: real.EMsg.ClientMicroTxnAuthorizeResponse}));
	}

	async _apiRequest() {
		throw new Error('fake steam-user: offline');
	}
}

Object.assign(FakeSteamUser, {EResult: real.EResult, EConnectionProtocol: real.EConnectionProtocol, EMsg: real.EMsg});
FakeSteamUser.prototype._handlerManager = {add: (msg, handler) => messageHandlers.set(msg, handler)};
require.cache[realPath] = {id: realPath, filename: realPath, loaded: true, exports: FakeSteamUser, children: [], paths: []};

// ===== 假悠悠接口 =====
// 场景文件形如:
// {tokens: {<token>: {steamId}}, smsToken, orders: {730: [{orderNo, subStatus, subStatusName, itemName}], 440: [...]},
//  details: {<orderNo>: {tradeOfferId, buyer: {steamId}, commodity: {assetId}}},
//  offers: {<tradeOfferId>: {partner, state, give: [{appid, assetid}], receive: []}}}
function uuScenario() {
	const file = process.env.FAKE_UU_FILE;
	try {
		return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
	} catch (_) {
		return {};
	}
}

function fakeUu(url, init) {
	const scenario = uuScenario();
	const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
	const body = init && init.body ? JSON.parse(String(init.body)) : {};
	const token = String(headers.authorization || '').replace(/^Bearer /, '');
	record({event: 'uuRequest', host: url.hostname, path: url.pathname, gameid: headers.gameid || headers.Gameid || '', body});
	const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
	const known = (scenario.tokens || {})[token];
	switch (url.pathname) {
		case '/api/deviceW2':
			return new Response('fake uu: no uk', {status: 500});
		case '/api/user/Auth/SendSignInSmsCode':
			return json({Code: 0, Msg: '发送成功'});
		case '/api/user/Auth/SmsSignIn':
			return json(scenario.smsToken ? {Code: 0, Data: {Token: scenario.smsToken}} : {Code: 1, Msg: '验证码错误'});
	}
	if (!known) {
		return json({code: 84101, msg: '登录状态失效'});
	}
	switch (url.pathname) {
		case '/api/youpin/bff/steam/cookie/pull':
			return json({code: 0, data: {steamCookie: JSON.stringify({steamId: known.steamId})}});
		case '/api/youpin/bff/trade/sell/page/v1/waitDeliver/waitDeliverList':
			return json({code: 0, data: {waitDeliverList: ((scenario.orders || {})[String(body.gameId)] || []).map(order => ({
				orderInfoVO: {orderNo: order.orderNo, orderSubStatus: order.subStatus, orderSubStatusName: order.subStatusName},
				commodityInfoVO: {commodityName: order.itemName}
			}))}});
		case '/api/youpin/bff/trade/v1/order/query/detail': {
			const detail = (scenario.details || {})[body.orderNo];
			return json(detail ? {code: 0, data: detail} : {code: 1, msg: '订单不存在'});
		}
		case '/api/youpin/bff/trade/v1/order/sell/delivery/confirmOffer':
			return json({code: 0, data: {success: true}});
	}
	return json({code: -1, msg: 'fake uu: 未实现 ' + url.pathname});
}

// ===== 报价接受的替身 =====
const ACTIVE_OFFER_STATE = 2;
class FakeTradeOfferManager {
	constructor() {}
	setCookies(cookies, callback) {
		callback(null);
	}
	getOffer(id, callback) {
		const offer = (uuScenario().offers || {})[id];
		if (!offer) {
			callback(new Error('fake steam: 报价不存在 ' + id));
			return;
		}
		callback(null, {
			id: String(id),
			partner: {getSteamID64: () => String(offer.partner)},
			state: offer.state == null ? ACTIVE_OFFER_STATE : offer.state,
			isOurOffer: false,
			itemsToGive: offer.give || [],
			itemsToReceive: offer.receive || [],
			accept(done) {
				record({event: 'offerAccept', offerId: String(id)});
				done(null, 'pending');
			}
		});
	}
}
FakeTradeOfferManager.ETradeOfferState = {Active: ACTIVE_OFFER_STATE};

class FakeSteamCommunity {
	constructor() {
		this.owner = '';
	}
	setCookies(cookies) {
		this.owner = cookieValue((cookies || []).join('; '), 'steamLoginSecure');
	}
	acceptConfirmationForObject(identitySecret, objectId, callback) {
		record({event: 'offerConfirm', offerId: String(objectId), identitySecret});
		callback(null);
	}
	// 手机令牌确认列表:这个账号还没确认的求购单
	getConfirmations(time, key, callback) {
		record({event: 'marketConfirmList', owner: this.owner, tag: key && key.tag});
		const list = [...market.confs.entries()]
			.filter(([, conf]) => conf.owner === this.owner && !conf.allowed)
			.map(([id, conf]) => ({
				id,
				creator: conf.creator,
				type: 3,
				respond(respondTime, respondKey, accept, done) {
					record({event: 'marketConfirm', owner: conf.owner, confId: id, tag: respondKey && respondKey.tag, accept});
					conf.allowed = !!accept;
					done(null);
				}
			}));
		setImmediate(() => callback(null, list));
	}
}

for (const [name, exports] of [['steam-tradeoffer-manager', FakeTradeOfferManager], ['steamcommunity', FakeSteamCommunity]]) {
	const resolved = require.resolve(name, {paths: [ROOT]});
	require.cache[resolved] = {id: resolved, filename: resolved, loaded: true, exports, children: [], paths: []};
}

// steam-totp 查 Steam 时间差走的是 https 模块(不经 fetch),换成离线版
const steamTotp = require(require.resolve('steam-totp', {paths: [ROOT]}));
steamTotp.getTimeOffset = callback => {
	record({event: 'timeOffset'});
	setImmediate(() => callback(null, 0, 0));
};

// ===== 假 Steam 市场 =====
// 场景文件(可选)形如:{needConfirmation: true, createFail: {success: 25}, filled: [<buy_orderid>...]}
//   needConfirmation:挂单先回 success=22,手机确认后带 confirmation 重发才落单(和真实流程一样);
//   createFail:挂单一律回这个;filled:这些求购单已成交,从「我的求购单」里消失。
// 账号按 cookie 里的 steamLoginSecure 区分;表单里的 sessionid 必须等于 cookie 里的(CSRF),否则回 success=15。
const market = {seq: 0, orders: new Map(), confs: new Map()};

function marketScenario() {
	const file = process.env.FAKE_MARKET_FILE;
	try {
		return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
	} catch (_) {
		return {};
	}
}

function cookieValue(header, name) {
	const match = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(String(header || ''));
	return match ? decodeURIComponent(match[1]) : '';
}

function placeMarketOrder(owner, form) {
	const id = String(7000000000 + ++market.seq);
	const quantity = Number(form.quantity);
	market.orders.set(id, {owner, appid: Number(form.appid), name: form.market_hash_name, price: Number(form.price_total) / quantity, quantity, currency: Number(form.currency)});
	return id;
}

function fakeMarket(url, init) {
	const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
	const owner = cookieValue(headers.cookie, 'steamLoginSecure');
	const form = init && init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
	const scenario = marketScenario();
	record({event: 'marketRequest', method: (init && init.method) || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), owner, form, referer: headers.referer || ''});
	const json = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
	if (url.pathname.startsWith('/market/listings/')) {
		const name = decodeURIComponent(url.pathname.split('/')[4] || '');
		return new Response(`<html><title>Steam Community Market :: Listings for ${name}</title></html>`, {status: 200});
	}
	if (url.pathname === '/market/itemordershistogram') {
		return json({success: 1, highest_buy_order: '120', lowest_sell_order: '150'});
	}
	if (url.pathname === '/market/priceoverview/') {
		return json({success: true, lowest_price: '$1.50', median_price: '$1.40', volume: '321'});
	}
	if (!owner) {
		return new Response('<html>Sign In</html>', {status: 200});   // 没登录:Steam 回登录页
	}
	const csrfOk = !!form.sessionid && form.sessionid === cookieValue(headers.cookie, 'sessionid');
	switch (url.pathname) {
		case '/market/createbuyorder/': {
			if (!csrfOk) {
				return json({success: 15});
			}
			if (scenario.createFail) {
				return json(scenario.createFail);
			}
			if (form.confirmation) {
				const conf = market.confs.get(form.confirmation);
				if (conf && conf.owner === owner && conf.allowed) {
					market.confs.delete(form.confirmation);
					return json({success: 1, buy_orderid: placeMarketOrder(owner, conf.form)});
				}
				return json({success: 22, need_confirmation: true, confirmation: {confirmation_id: form.confirmation}});
			}
			if (scenario.needConfirmation) {
				const confId = String(9000 + ++market.seq);
				market.confs.set(confId, {owner, form, creator: String(5000 + market.seq), allowed: false});
				return json({success: 22, need_confirmation: true, confirmation: {confirmation_id: confId}});
			}
			return json({success: 1, buy_orderid: placeMarketOrder(owner, form)});
		}
		case '/market/cancelbuyorder/': {
			const order = market.orders.get(form.buy_orderid);
			if (!csrfOk || !order || order.owner !== owner) {
				return json({success: csrfOk ? 8 : 15});
			}
			market.orders.delete(form.buy_orderid);
			return json({success: 1});
		}
		case '/market/mylistings/': {
			const filled = new Set((scenario.filled || []).map(String));
			const buyOrders = [...market.orders.entries()]
				.filter(([id, order]) => order.owner === owner && !filled.has(id))
				.map(([id, order]) => ({buy_orderid: id, price: String(order.price), quantity: String(order.quantity), quantity_remaining: String(order.quantity),
					description: {appid: order.appid, market_hash_name: order.name}}));
			return json({success: true, buy_orders: buyOrders});
		}
	}
	return json({success: 8});
}

// ===== 外网拦截 =====
const FIXED_USD_RATES = {result: 'success', base_code: 'USD', rates: {USD: 1, EUR: 0.9, GBP: 0.78, CNY: 7.1, UYU: 40, JPY: 150, RUB: 90}};
const realFetch = globalThis.fetch;
globalThis.fetch = async function offlineFetch(input, init) {
	const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
	if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') {
		return realFetch(input, init);
	}
	if (url.hostname.endsWith('.youpin898.com')) {
		return fakeUu(url, init);
	}
	if (url.hostname === 'steamcommunity.com' && url.pathname.startsWith('/market/')) {
		return fakeMarket(url, init);
	}
	if (url.origin + url.pathname === 'https://open.er-api.com/v6/latest/USD') {
		return new Response(JSON.stringify(FIXED_USD_RATES), {status: 200, headers: {'content-type': 'application/json'}});
	}
	record({event: 'blockedFetch', url: url.origin + url.pathname});
	throw new TypeError(`e2e 离线环境:不允许访问外部地址 ${url.origin}`);
};
