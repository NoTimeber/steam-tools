'use strict';
// 端到端测试的离线环境:在服务端入口 src/main.ts 之前预加载(node --require),保证测试不碰任何外部服务。
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
//    接受、手机确认只记日志,不连 Steam。充值码兑换的 steamstore 也换成替身,按码的前缀决定结果。
// 6. 假 Steam 市场(steamcommunity.com/market/*),有状态:挂求购、手机确认、撤单、我的求购单,见 fakeMarket();
//    场景开关在 FAKE_MARKET_FILE。手机确认 mobileconf/getlist、ajaxop(求购确认自己发,见 fakeMobileconf)列出 / 确认待确认的求购单;
//    steam-totp 的 getTimeOffset 换成离线版(返回 0)。
// 7. 假 Steam 商店结算(store / api / checkout.steampowered.com 上买游戏用到的那几个端点),有状态:
//    每个账号钱包 10.00 美元、已拥有的包,见 fakeStore();商品可用 FAKE_STORE_PACKAGES 追加。
//    购买记录页(store.steampowered.com/account/history/ + AjaxLoadMoreHistory):每个账号 37 条,每页 15 条,见 historyRow()。
// 8. 假社区库存(steamcommunity.com/inventory/<steamID>/730/2):两页共 3 件;FAKE_INVENTORY_FILE 可设成私密(403)或整个换掉(assets + descriptions,演示服务用),见 fakeInventory()。
//    交易报价隐私设置页(steamcommunity.com/profiles/<steamID>/tradeoffers/privacy):带会话 cookie 时给出这个账号的
//    交易链接(partner = SteamID 低 32 位),没 cookie 时 302 去登录页,见 fakeTradeUrlPage()。
// 9. 假 C5GAME 开放平台(openapi.c5game.com),有状态:余额、在售(64 位 id)、批量购买 / 快速购买、订单详情,
//    初始场景在 FAKE_C5_FILE,见 fakeC5()。app-key 以 bad 开头的一律拒绝,以 ip 开头的查在售时报不在白名单。
// 10. 外网拦截:全局 fetch 只放行本机;汇率接口返回固定数据;其余外部请求直接失败。
//
// logOn / logOff / gamesPlayed / sendToGC / 下单各步 / 悠悠请求 / 报价接受 / 市场请求和确认 / 商店结算请求 / 社区库存请求 / C5 请求 /
// 被拦的外部请求都追加一行 JSON 到 FAKE_STEAM_LOG(设置了才写)。

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

// GC 消息的 protobuf 类型(在用到时才加载,不改变服务端自己的模块加载顺序)
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
			if (details.password === 'pw-guard' && !details.twoFactorCode) {
				this.askGuard(name, false);
				return;
			}
			const ok = (details.refreshToken && String(details.refreshToken).startsWith('RT-GOOD-')) || details.password === 'pw-good';
			if (!ok) {
				const err = new Error(details.refreshToken ? 'AccessDenied' : 'InvalidPassword');
				err.eresult = details.refreshToken ? 15 : 5;
				this.emit('error', err);
				return;
			}
			this.succeed(name);
		}, 30);
	}

	// 密码 pw-guard:要移动令牌验证码,24680 才对
	askGuard(name, lastCodeWrong) {
		this.emit('steamGuard', null, code => {
			record({event: 'guardCode', client: this.n, code});
			setTimeout(() => (code === '24680' ? this.succeed(name) : this.askGuard(name, true)), 10);
		}, lastCodeWrong);
	}

	succeed(name) {
		this.steamID = {getSteamID64: () => '76561190' + String(100000000 + name.length * 1111)};
		this.emit('loggedOn', {});
		this.emit('wallet', true, 1, this.walletCents / 100);
		this.emit('refreshToken', 'RT-GOOD-' + name);
		this.emit('webSession', 'sid-' + this.n, ['steamLoginSecure=fake-' + this.n]);
		this.sessionReady = true;
	}

	logOff() {
		record({event: 'logOff', client: this.n});
		for (const appid of this.playing) {
			this.emit('appQuit', appid);
		}
		this.playing = [];
	}

	// 登录完成后再调(手动刷新 WebSession、进游戏时)才回新的 webSession;登录过程中那次由 succeed() 发
	webLogOn() {
		if (!this.sessionReady) {
			return;
		}
		record({event: 'webLogOn', client: this.n});
		setTimeout(() => this.emit('webSession', 'sid-' + this.n, ['steamLoginSecure=fake-' + this.n]), 10);
	}

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
}

// ===== 充值码兑换(steamstore)替身 =====
// 码按前缀决定结果:GOOD- 成功(余额 +5.00);USED- 码已被使用(steamstore 抛错);
// LIMIT- 被限流(steamstore 不抛错,而是回 eresult=2 / detail=53,真实库就是这样)
class FakeSteamStore {
	constructor() {
		this.cookies = [];
	}
	setCookies(cookies) {
		this.cookies = cookies;
	}
	async redeemWalletCode(code) {
		record({event: 'walletRedeem', code, owner: cookieValue(this.cookies.join('; '), 'steamLoginSecure')});
		if (code.startsWith('GOOD-')) {
			return {eresult: 1, detail: 0, formattedNewWalletBalance: '$15.00', amount: 500};
		}
		if (code.startsWith('USED-')) {
			throw Object.assign(new Error('Wallet code is not valid'), {eresult: 2, purchaseresultdetail: 15});
		}
		if (code.startsWith('LIMIT-')) {
			return {eresult: 2, detail: 53, formattedNewWalletBalance: undefined, amount: undefined};
		}
		throw Object.assign(new Error('Wallet code is not valid'), {eresult: 2, purchaseresultdetail: 14});
	}
}

for (const [name, exports] of [['steam-tradeoffer-manager', FakeTradeOfferManager], ['steamcommunity', FakeSteamCommunity], ['steamstore', FakeSteamStore]]) {
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

// 新版市场的分组页(分组 id 和真实 Steam 一致):标题是分组名
const MARKET_GROUPS = {G18A8263004: 'Kilowatt Case', G1807209A023004: 'AK-47 | Redline', G18072096023004: 'AWP | Redline'};

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

// 手机令牌确认(steamcommunity.com/mobileconf/*):getlist 列出这个账号还没确认的求购单,ajaxop 按 cid + ck(nonce)确认
function fakeMobileconf(url, init) {
	const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
	const owner = cookieValue(headers.cookie, 'steamLoginSecure');
	const params = Object.fromEntries(url.searchParams);
	const json = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
	if (!owner) {
		return json({success: false, needauth: true});
	}
	if (url.pathname === '/mobileconf/getlist') {
		record({event: 'marketConfirmList', owner, tag: params.tag, params});
		const conf = [...market.confs.entries()]
			.filter(([, item]) => item.owner === owner && !item.allowed)
			.map(([id, item]) => ({id, creator_id: item.creator, nonce: 'nonce-' + id, type: 12, headline: item.form.market_hash_name}));
		return json({success: true, conf});
	}
	if (url.pathname === '/mobileconf/ajaxop') {
		const item = market.confs.get(params.cid);
		record({event: 'marketConfirm', owner, confId: params.cid, tag: params.tag, accept: params.op === 'allow', params});
		if (!item || item.owner !== owner || params.ck !== 'nonce-' + params.cid) {
			return json({success: false});
		}
		item.allowed = params.op === 'allow';
		return json({success: true});
	}
	return json({success: false});
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
		// 新版分组页(真实的有好几 MB,标题在开头)
		if (/^G[0-9A-F]{8,}$/i.test(name)) {
			return MARKET_GROUPS[name]
				? new Response(`<!DOCTYPE html><html><head><title>${MARKET_GROUPS[name]} - Steam Community Market</title></head><body>${'x'.repeat(100000)}</body></html>`, {status: 200})
				: new Response('Not Found', {status: 404});
		}
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

// ===== 假 Steam 商店结算 =====
// 商品默认:10 = 4.99 美元的游戏,20 = 免费包;FAKE_STORE_PACKAGES(JSON)可追加,形如 {"30": {"name": "...", "final": 5000}}。
// 账号按 cookie 里的 steamLoginSecure 区分,webapi_token 是 "WT-" + 它;inittransaction 的 sessionid 必须等于 cookie 里的。
// 钱包:每个账号 1000 分,finalizetransaction 成功才扣;已拥有的包再买,交易状态回 purchaseresultdetail=9。
const store = {seq: 0, wallets: new Map(), owned: new Map(), carts: new Map(), txns: new Map()};

function storePackages() {
	let extra = {};
	try {
		extra = JSON.parse(process.env.FAKE_STORE_PACKAGES || '{}');
	} catch (_) {}
	return {10: {name: 'Fake Game', final: 499, appid: 1010}, 20: {name: 'Free Pack', final: 0, appid: 2020, free: true}, ...extra};
}

function storeWallet(owner) {
	if (!store.wallets.has(owner)) {
		store.wallets.set(owner, 1000);
	}
	return store.wallets.get(owner);
}

function cartTotal(items, packages) {
	return items.reduce((sum, id) => sum + Number(packages[id].final || 0), 0);
}

// 购买记录(消费记录用):每个账号 37 条,结构照真实页面(列 class、.wth_payment、g_historyCursor);
// 第一页 15 条在整页 HTML 里,「加载更多」按游标里的页号每次再给 15 条,最后一页不带游标。
const HISTORY_TOTAL = 37;
const HISTORY_PAGE = 15;

function historyRow(index) {
	const date = new Date(Date.UTC(2026, 9, 14) - index * 3 * 86400000);
	const dateText = `${date.getUTCFullYear()} 年 ${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`;
	const balance = `$${(20 + index * 0.37).toFixed(2)}`;
	const cell = (cls, html) => `<td class="${cls}">${html}</td>`;
	const divs = texts => texts.map(text => `<div>${text}</div>`).join('');
	const pay = texts => `<div class="wth_payment">${texts.length > 1 ? divs(texts) : texts.join('')}</div>`;
	const row = (items, type, payment, total, change, refunded = false) => `
<tr class="wallet_table_row wallet_table_row_amt_change " onclick="HandleTransactionClick( event, 'https://help.steampowered.com/zh-cn/wizard/HelpWithPurchase?transid=${700000 + index}' )">
	${cell('wht_date', dateText)}
	${cell('wht_items', items)}
	${cell(refunded ? 'wht_type wht_refunded' : 'wht_type ', type + payment)}
	${cell('wht_total ', total)}
	${cell('wht_wallet_change wallet_column', change)}
	${cell('wht_wallet_balance wallet_column', change ? balance : '')}
</tr>`;
	switch (index % 6) {
		case 0: {
			const count = 1 + (index % 4);
			const amount = (0.42 * count).toFixed(2);
			return row(divs(['Counter-Strike 2']) + '<div class="wth_payment">Steam 社区市场</div>', divs([count > 1 ? `${count} 笔市场交易` : '市场交易']), pay([]), `$${amount}`, `+$${amount}`);
		}
		case 1:
			return row(divs([`Fake Game ${index}`]), divs(['购买']), pay(['$1.00 Steam 钱包', '$3.99 Visa']), '$4.99', '-$1.00');
		case 2:
			return row(divs(['Counter-Strike 2', '武器箱钥匙']), divs(['游戏内购买']), pay(['Steam 钱包']), '$2.49', '-$2.49');
		case 3:
			return row(divs(['Counter-Strike 2']) + '<div class="wth_payment">Steam 社区市场</div>', divs(['市场交易']), pay([]), '$0.35', '-$0.35');
		case 4:
			return row(divs(['$10.00 钱包资金']), divs(['购买']), pay(['支付宝']), '$10.00', '+$10.00');
		default:
			return index % 12 === 5
				? row(divs(['Stardew Valley']), divs(['礼物购买']), pay(['Visa']), '$14.99', '')
				: row(divs([`Fake Game ${index - 10}`]), divs(['退款']), pay(['Steam 钱包']), '$4.99', '+$4.99', true);
	}
}

function historyChunk(page) {
	const start = (page - 1) * HISTORY_PAGE;
	const html = Array.from({length: Math.max(0, Math.min(HISTORY_PAGE, HISTORY_TOTAL - start))}, (_, i) => historyRow(start + i)).join('');
	const more = start + HISTORY_PAGE < HISTORY_TOTAL;
	return {html, ...(more ? {cursor: {wallet_txnid: String(page + 1), timestamp_newest: 1760400000 - page * 86400, balance: '2000', currency: 1}} : {})};
}

function historyPage(owner, sessionid) {
	const first = historyChunk(1);
	return `<!DOCTYPE html><html><body><div id="account_pulldown">${owner}</div>
<table class="wallet_history_table"><thead><tr><th class="wht_date">日期</th><th class="wht_items">物品</th><th class="wht_type">类型</th><th class="wht_total">总计</th></tr></thead>
<tbody>${first.html}
<tr id="more_history"><td colspan="6"><a id="load_more_button">加载更多交易</a></td></tr></tbody></table>
<script>var g_sessionID = "${sessionid}"; var g_historyCursor = ${first.cursor ? JSON.stringify(first.cursor) : 'null'};</script></body></html>`;
}

// 不认识的路径返回 null(交给外网拦截)
function fakeStore(url, init) {
	const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
	const owner = cookieValue(headers.cookie, 'steamLoginSecure');
	const body = init && init.body ? String(init.body) : '';
	const form = body && !body.startsWith('input_json=') ? Object.fromEntries(new URLSearchParams(body)) : {};
	const rawInput = body.startsWith('input_json=') ? decodeURIComponent(body.slice('input_json='.length)) : url.searchParams.get('input_json');
	const input = rawInput ? JSON.parse(rawInput) : null;
	const where = url.hostname + url.pathname;
	const json = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
	const packages = storePackages();
	const tokenOk = !!owner && url.searchParams.get('access_token') === 'WT-' + owner;

	switch (where) {
		// 账户页(查真实国家用),只在设了 FAKE_STORE_COUNTRY 时模拟,否则照旧被拦(其它测试的国家不受影响)。
		// 和真实 Steam 一样:第一次没有 browserid 会 302 回自己并下发 cookie
		case 'store.steampowered.com/account/': {
			const country = process.env.FAKE_STORE_COUNTRY;
			if (!country) {
				return null;
			}
			record({event: 'storeRequest', method: 'GET', path: where, owner});
			if (!owner) {
				return new Response('', {status: 302, headers: {location: 'https://store.steampowered.com/login/'}});
			}
			if (!cookieValue(headers.cookie, 'browserid')) {
				return new Response('', {status: 302, headers: {location: '/account/', 'set-cookie': 'browserid=4242; Path=/'}});
			}
			return new Response(`<div id="account_pulldown">${owner}</div><div id="application_config" data-config="{&quot;COUNTRY&quot;:&quot;${country}&quot;}"></div>`, {status: 200});
		}
		// 购买记录页:和账户页一样第一次 302 下发 browserid(cookie 里没 sessionid 的也一并下发);
		// 「加载更多」的表单 sessionid 必须和 cookie 里的一致,否则回 success: false
		case 'store.steampowered.com/account/history/': {
			record({event: 'storeRequest', method: 'GET', path: where, owner});
			if (!owner) {
				return new Response('', {status: 302, headers: {location: 'https://store.steampowered.com/login/'}});
			}
			if (!cookieValue(headers.cookie, 'browserid')) {
				const setCookies = [['set-cookie', 'browserid=4242; Path=/']];
				if (!cookieValue(headers.cookie, 'sessionid')) {
					setCookies.push(['set-cookie', `sessionid=store-${owner}; Path=/`]);
				}
				return new Response('', {status: 302, headers: [['location', '/account/history/?l=schinese'], ...setCookies]});
			}
			return new Response(historyPage(owner, cookieValue(headers.cookie, 'sessionid')), {status: 200});
		}
		case 'store.steampowered.com/account/AjaxLoadMoreHistory/': {
			record({event: 'storeRequest', method: 'POST', path: where, owner, form});
			if (!owner || !form.sessionid || form.sessionid !== cookieValue(headers.cookie, 'sessionid')) {
				return json({success: false});
			}
			return json(historyChunk(Number(form['cursor[wallet_txnid]'])));
		}
		case 'store.steampowered.com/api/packagedetails': {
			record({event: 'storeRequest', method: 'GET', path: where, owner, query: Object.fromEntries(url.searchParams)});
			const ids = String(url.searchParams.get('packageids') || '').split(',');
			return json(Object.fromEntries(ids.map(id => {
				const pkg = packages[id];
				if (!pkg) {
					return [id, {success: false}];
				}
				const data = {name: pkg.name, apps: [{id: pkg.appid || 0, name: pkg.name}]};
				if (pkg.free) {
					data.is_free_license = true;
				} else {
					data.price = {currency: 'USD', initial: pkg.final, final: pkg.final, discount_percent: 0};
				}
				return [id, {success: true, data}];
			})));
		}
		case 'store.steampowered.com/pointssummary/ajaxgetasyncconfig':
			record({event: 'storeRequest', method: 'GET', path: where, owner});
			return json(owner ? {success: 1, data: {webapi_token: 'WT-' + owner}} : {success: 1, data: {}});
		case 'api.steampowered.com/IShoppingCartService/CreateNewShoppingCart/v1/': {
			record({event: 'storeRequest', method: 'POST', path: where, owner});
			if (!tokenOk) {
				return new Response('Unauthorized', {status: 401});
			}
			const gid = String(8800000000 + ++store.seq);
			store.carts.set(gid, {owner, items: []});
			return json({response: {gidshoppingcart: gid}});
		}
		case 'api.steampowered.com/IShoppingCartService/AddPackages/v1/': {
			record({event: 'storeRequest', method: 'POST', path: where, owner, input});
			const cart = store.carts.get(String(input && input.gidshoppingcart));
			if (!tokenOk || !cart || cart.owner !== owner) {
				return json({response: {}});
			}
			for (const item of input.cart_items || []) {
				if (packages[item.packageid]) {
					cart.items.push(Number(item.packageid));
				}
			}
			return json({response: {contents: {lineitems: cart.items.map(packageid => ({packageid}))}}});
		}
		case 'api.steampowered.com/ICheckoutService/ValidateCart/v1/': {
			record({event: 'storeRequest', method: 'GET', path: where, owner});
			const cart = store.carts.get(String(input && input.gidshoppingcart));
			if (!tokenOk || !cart) {
				return json({response: {}});
			}
			const subtotal = cartTotal(cart.items, packages);
			const wallet = storeWallet(owner);
			const money = cents => ({amount_in_cents: String(cents), formatted_amount: '$' + (cents / 100).toFixed(2)});
			return json({response: {estimated_totals: {subtotal: money(subtotal), wallet_balance: money(wallet), exceeding_wallet_balance: money(Math.max(0, subtotal - wallet))}}});
		}
		case 'checkout.steampowered.com/checkout/inittransaction/': {
			record({event: 'storeRequest', method: 'POST', path: where, owner, form});
			const cart = store.carts.get(String(form.gidShoppingCart));
			if (!owner || form.sessionid !== cookieValue(headers.cookie, 'sessionid') || !cart || cart.owner !== owner) {
				return json({success: 2});
			}
			const transid = String(7700000000 + ++store.seq);
			store.txns.set(transid, {owner, items: cart.items.slice(), done: false, detail: null});
			return json({success: 1, transid, paymentmethod: 'steamaccount'});
		}
		case 'checkout.steampowered.com/checkout/getfinalprice/': {
			record({event: 'storeRequest', method: 'GET', path: where, owner});
			const txn = store.txns.get(String(url.searchParams.get('transid')));
			if (!txn || txn.owner !== owner) {
				return json({success: 2});
			}
			return json({success: 1, base: cartTotal(txn.items, packages), discount: 0, tax: 0, shipping: 0, importfee: 0, currencycode: 1});
		}
		case 'checkout.steampowered.com/checkout/finalizetransaction/': {
			record({event: 'storeRequest', method: 'POST', path: where, owner, form});
			const txn = store.txns.get(String(form.transid));
			if (!txn || txn.owner !== owner) {
				return json({success: 2});
			}
			const owned = store.owned.get(owner) || new Set();
			const total = cartTotal(txn.items, packages);
			if (txn.items.some(id => owned.has(id))) {
				txn.detail = 9;
			} else if (total > storeWallet(owner)) {
				txn.detail = 2;
			} else {
				store.wallets.set(owner, storeWallet(owner) - total);
				txn.items.forEach(id => owned.add(id));
				store.owned.set(owner, owned);
				txn.detail = 0;
			}
			txn.done = true;
			return json({success: 22});
		}
		case 'checkout.steampowered.com/checkout/transactionstatus/': {
			record({event: 'storeRequest', method: 'GET', path: where, owner});
			const txn = store.txns.get(String(url.searchParams.get('transid')));
			if (!txn || !txn.done) {
				return json({success: 22});
			}
			return json({success: txn.detail === 0 ? 1 : 2, purchaseresultdetail: txn.detail});
		}
	}
	return null;
}

// ===== 假社区库存 =====
// steamcommunity.com/inventory/<steamID>/730/2:两页共 3 件(第一页 2 件,带 more_items / last_assetid)。
// FAKE_INVENTORY_FILE 里写 {"private": true} 时回 403(和库存设为私密时一样),写了 assets + descriptions 就一页回这些;测试随时改这个文件。
function fakeInventory(url, init) {
	const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
	const owner = cookieValue(headers.cookie, 'steamLoginSecure');
	record({event: 'inventoryRequest', path: url.pathname, query: Object.fromEntries(url.searchParams), owner});
	let scenario = {};
	try {
		scenario = process.env.FAKE_INVENTORY_FILE ? JSON.parse(fs.readFileSync(process.env.FAKE_INVENTORY_FILE, 'utf8')) : {};
	} catch (_) {}
	if (!owner || scenario.private) {
		return new Response('Forbidden', {status: 403});
	}
	const json = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
	if (Array.isArray(scenario.assets) && Array.isArray(scenario.descriptions)) {
		return json({success: 1, total_inventory_count: scenario.assets.length, assets: scenario.assets, descriptions: scenario.descriptions});
	}
	const rifle = {
		classid: '1', instanceid: '0', name: 'AK-47 | 红线 (久经沙场)', market_hash_name: 'AK-47 | Redline (Field-Tested)', tradable: 1, marketable: 1, icon_url: 'ak',
		tags: [{category: 'Type', internal_name: 'CSGO_Type_Rifle', localized_tag_name: '步枪'}, {category: 'Rarity', internal_name: 'Rarity_Legendary_Weapon', localized_tag_name: '保密', color: 'd32ce6'}, {category: 'Exterior', internal_name: 'WearCategory2', localized_tag_name: '久经沙场'}]
	};
	const key = {
		classid: '2', instanceid: '0', name: '武器箱钥匙', market_hash_name: 'CS:GO Case Key', tradable: 0, marketable: 0,
		owner_descriptions: [{value: 'Tradable After Feb 03, 2099 (7:00:00) GMT'}], tags: [{category: 'Type', internal_name: 'CSGO_Tool_WeaponCase_KeyTag', localized_tag_name: '钥匙'}]
	};
	if (!url.searchParams.get('start_assetid')) {
		return json({
			success: 1, more_items: 1, last_assetid: '102', total_inventory_count: 3, descriptions: [rifle, key],
			assets: [{assetid: '101', classid: '1', instanceid: '0', amount: '1'}, {assetid: '102', classid: '2', instanceid: '0', amount: '1'}]
		});
	}
	return json({success: 1, total_inventory_count: 3, descriptions: [rifle], assets: [{assetid: '103', classid: '1', instanceid: '0', amount: '1'}]});
}

// ===== 假交易报价隐私设置页 =====
function fakeTradeUrlPage(url, init) {
	const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
	if (!cookieValue(headers.cookie, 'steamLoginSecure')) {
		return new Response('', {status: 302, headers: {location: 'https://steamcommunity.com/login/home/'}});
	}
	const steamId = url.pathname.split('/')[2];
	const link = `https://steamcommunity.com/tradeoffer/new/?partner=${BigInt(steamId) & 0xFFFFFFFFn}&amp;token=demo${steamId.slice(-4)}`;
	return new Response(`<html><body><input class="trade_offer_access_url" id="trade_offer_access_url" type="text" value="${link}" readonly></body></html>`,
		{status: 200, headers: {'content-type': 'text/html'}});
}

// ===== 假 C5GAME 开放平台 =====
// 场景文件 FAKE_C5_FILE(启动时读一次,之后状态都在内存里):
// {balance: 20, steamId, steamAccounts: [{steamId, nickname, username, autoType, accountStatus}], items: {<marketHashName>: {listings: [价格, ...], purchaseMax}}, restock: false}
// 在售 id 是 19 位整数(JS 数字放不下),回包里按原样的数字写,收到的请求体也按原文解析,方便测试核对没丢精度。
// restock: true 时每次查行情都可能在原价附近补一件新在售(演示服务用,让页面有东西可看)。
const c5 = {loaded: false, balance: 0, steamId: '', steamAccounts: [], items: new Map(), orders: new Map(), seq: 0, restock: false};

function c5State() {
	if (!c5.loaded) {
		c5.loaded = true;
		let scenario = {};
		try {
			scenario = process.env.FAKE_C5_FILE ? JSON.parse(fs.readFileSync(process.env.FAKE_C5_FILE, 'utf8')) : {};
		} catch (_) {}
		c5.balance = Number(scenario.balance ?? 100);
		c5.steamId = String(scenario.steamId || '76561190100005555');
		// C5 上绑定的 Steam 账号;默认只有 alpha(假 steam-user 按账号名长度算出来的 SteamID)
		c5.steamAccounts = Array.isArray(scenario.steamAccounts) ? scenario.steamAccounts
			: [{steamId: c5.steamId, nickname: '演示收货号', username: 'alpha', autoType: 0, accountStatus: 1}];
		c5.restock = !!scenario.restock;
		for (const [name, item] of Object.entries(scenario.items || {})) {
			const prices = item.listings || [];
			c5.items.set(name, {
				base: prices.length ? Math.min(...prices) : 1,
				purchaseMax: item.purchaseMax ?? null,
				listings: prices.map(price => ({productId: c5ProductId(), price}))
			});
		}
	}
	return c5;
}

function c5ProductId() {
	c5.seq += 1;
	return String(1444544795338000000n + BigInt(c5.seq));
}

function c5Restock() {
	if (!c5.restock) {
		return;
	}
	for (const item of c5.items.values()) {
		if (item.listings.length < 25 && Math.random() < 0.35) {
			const price = Math.round(item.base * (0.92 + Math.random() * 0.16) * 100) / 100;
			item.listings.push({productId: c5ProductId(), price});
		}
	}
}

function c5Buy(item, listing) {
	item.listings.splice(item.listings.indexOf(listing), 1);
	c5.balance = Math.round((c5.balance - listing.price) * 100) / 100;
	return String(9000000000000000000n + BigInt(++c5.seq));
}

function fakeC5(url, init) {
	const state = c5State();
	const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
	const parse = text => JSON.parse(text, (key, value, context) =>
		typeof value === 'number' && !Number.isSafeInteger(value) && context && /^-?\d+$/.test(context.source) ? context.source : value);
	const body = init && init.body ? parse(String(init.body)) : {};
	const appKey = url.searchParams.get('app-key') || '';
	record({event: 'c5Request', method: (init && init.method) || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), acceptEncoding: headers['accept-encoding'] || '', body});
	const raw = id => JSON.rawJSON(id);
	const ok = data => new Response(JSON.stringify({success: true, data, errorCode: 0, errorMsg: null}), {status: 200, headers: {'content-type': 'application/json'}});
	const fail = (errorCode, errorMsg) => new Response(JSON.stringify({success: false, data: null, errorCode, errorMsg}), {status: 200, headers: {'content-type': 'application/json'}});
	if (!appKey || appKey.startsWith('bad')) {
		return fail(400001, '请输入正确的 app-Key');
	}
	const findListing = productId => {
		for (const item of state.items.values()) {
			const listing = item.listings.find(entry => entry.productId === String(productId));
			if (listing) {
				return {item, listing};
			}
		}
		return null;
	};
	const placeOrder = (outTradeNo, name, item, listing) => {
		const orderId = c5Buy(item, listing);
		state.orders.set(String(outTradeNo), {orderId, productId: listing.productId, name, price: listing.price});
		return orderId;
	};
	switch (url.pathname) {
		case '/merchant/account/v2/balance':
			return ok({moneyAmount: state.balance, tradeSettleAmount: 0, depositAmount: 0});
		case '/merchant/account/v1/steamInfo':
			return ok({steamList: state.steamAccounts});
		case '/merchant/market/v2/item/stat/hash/name': {
			c5Restock();
			const out = {};
			for (const name of body.marketHashNames || []) {
				const item = state.items.get(name);
				if (item) {
					const prices = item.listings.map(listing => listing.price);
					out[name] = {sellPrice: prices.length ? Math.min(...prices) : null, sellCount: prices.length, purchaseMaxPrice: item.purchaseMax};
				}
			}
			return ok(out);
		}
		case '/merchant/market/v2/products/search': {
			if (appKey.startsWith('ip')) {
				return fail(403, '当前 IP 不在白名单');
			}
			const item = state.items.get(body.marketHashName);
			const list = (item ? item.listings : []).filter(listing => listing.price <= Number(body.priceMax))
				.map(listing => ({productId: raw(listing.productId), price: listing.price, delivery: 2, assetInfo: {amount: 1}}));
			return ok({list, total: list.length});
		}
		case '/merchant/trade/v1/batch/buy': {
			const successList = [];
			const failedList = [];
			for (const product of body.productList || []) {
				const found = findListing(product.productId);
				if (!found || found.listing.price > Number(product.buyPrice)) {
					failedList.push({productId: raw(String(product.productId)), outTradeNo: product.outTradeNo, failReason: '商品已售出或价格已变'});
				} else if (state.balance < found.listing.price) {
					failedList.push({productId: raw(String(product.productId)), outTradeNo: product.outTradeNo, failReason: '余额不足'});
				} else {
					const name = [...state.items].find(([, item]) => item === found.item)[0];
					const orderId = placeOrder(product.outTradeNo, name, found.item, found.listing);
					successList.push({productId: raw(found.listing.productId), outTradeNo: product.outTradeNo, orderId: raw(orderId), actualPay: found.listing.price});
				}
			}
			return ok({successList, failedList});
		}
		case '/merchant/trade/v2/quick-buy': {
			const item = state.items.get(body.marketHashName);
			const listing = item && item.listings.filter(entry => entry.price <= Number(body.maxPrice)).sort((a, b) => a.price - b.price)[0];
			if (!listing) {
				return fail(500102, '没有符合条件的在售');
			}
			if (state.balance < listing.price) {
				return fail(500103, '余额不足');
			}
			const orderId = placeOrder(body.outTradeNo, body.marketHashName, item, listing);
			return ok({orderId: raw(orderId), actualPay: listing.price, payStatus: 1});
		}
		case '/merchant/order/v2/buy/detail': {
			const order = state.orders.get(url.searchParams.get('outTradeNo') || '');
			if (!order) {
				return fail(500404, '订单不存在');
			}
			return ok({orderId: raw(order.orderId), productId: raw(order.productId), status: 1, statusName: '待发货', marketHashName: order.name});
		}
	}
	return new Response('not found', {status: 404});
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
	if (url.hostname === 'openapi.c5game.com') {
		return fakeC5(url, init);
	}
	if (url.hostname === 'steamcommunity.com' && url.pathname.startsWith('/market/')) {
		return fakeMarket(url, init);
	}
	if (url.hostname === 'steamcommunity.com' && url.pathname.startsWith('/mobileconf/')) {
		return fakeMobileconf(url, init);
	}
	// Steam 时间(求购确认签 key 用)
	if (url.origin + url.pathname === 'https://api.steampowered.com/ITwoFactorService/QueryTime/v1/') {
		record({event: 'timeOffset'});
		return new Response(JSON.stringify({response: {server_time: String(Math.floor(Date.now() / 1000))}}), {status: 200, headers: {'content-type': 'application/json'}});
	}
	if (url.hostname === 'steamcommunity.com' && /^\/inventory\/\d+\/730\/2$/.test(url.pathname)) {
		return fakeInventory(url, init);
	}
	if (url.hostname === 'steamcommunity.com' && /^\/profiles\/\d{17}\/tradeoffers\/privacy$/.test(url.pathname)) {
		return fakeTradeUrlPage(url, init);
	}
	if (['store.steampowered.com', 'api.steampowered.com', 'checkout.steampowered.com'].includes(url.hostname)) {
		const reply = fakeStore(url, init);
		if (reply) {
			return reply;
		}
	}
	if (url.origin + url.pathname === 'https://open.er-api.com/v6/latest/USD') {
		return new Response(JSON.stringify(FIXED_USD_RATES), {status: 200, headers: {'content-type': 'application/json'}});
	}
	record({event: 'blockedFetch', url: url.origin + url.pathname});
	throw new TypeError(`e2e 离线环境:不允许访问外部地址 ${url.origin}`);
};
