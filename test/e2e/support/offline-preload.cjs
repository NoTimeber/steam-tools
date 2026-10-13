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
// 3. 外网拦截:全局 fetch 只放行本机;汇率接口返回固定数据;其余外部请求直接失败。
//
// logOn / logOff / gamesPlayed / sendToGC / 被拦的外部请求都追加一行 JSON 到 FAKE_STEAM_LOG(设置了才写)。

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

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
	if (appid === 730) {
		return {
			welcome: load('globaloffensive/protobufs/generated/_load').CMsgClientWelcome,
			storeResponse: load('globaloffensive/protobufs/generated/base_gcmessages').CMsgStoreGetUserDataResponse
		};
	}
	const tf2 = load('tf2/protobufs/generated/_load');
	return {welcome: tf2.CMsgClientWelcome, storeResponse: tf2.CMsgStoreGetUserDataResponse};
}

const encode = (type, body) => Buffer.from(type.encode(body).finish());

let seq = 0;

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
			this.emit('wallet', true, 1, 10);
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

	sendToGC(appid, msgType) {
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
			}
		});
	}

	async _apiRequest() {
		throw new Error('fake steam-user: offline');
	}
}

Object.assign(FakeSteamUser, {EResult: real.EResult, EConnectionProtocol: real.EConnectionProtocol});
require.cache[realPath] = {id: realPath, filename: realPath, loaded: true, exports: FakeSteamUser, children: [], paths: []};

// ===== 外网拦截 =====
const FIXED_USD_RATES = {result: 'success', base_code: 'USD', rates: {USD: 1, EUR: 0.9, GBP: 0.78, CNY: 7.1, UYU: 40, JPY: 150, RUB: 90}};
const realFetch = globalThis.fetch;
globalThis.fetch = async function offlineFetch(input, init) {
	const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
	if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') {
		return realFetch(input, init);
	}
	if (url.origin + url.pathname === 'https://open.er-api.com/v6/latest/USD') {
		return new Response(JSON.stringify(FIXED_USD_RATES), {status: 200, headers: {'content-type': 'application/json'}});
	}
	record({event: 'blockedFetch', url: url.origin + url.pathname});
	throw new TypeError(`e2e 离线环境:不允许访问外部地址 ${url.origin}`);
};
