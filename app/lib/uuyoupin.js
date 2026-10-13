'use strict';

// 悠悠有品 API 客户端（TF2 发货）。
// 基于 2026-06-03 对安卓 App v5.45.4 的真实抓包逆向：
//   - TF2 发货走新网关 g3-api.youpin898.com（CS2 才是 api.youpin898.com）
//   - 关键发现：g3-api 不强校验 signature 头，只需 Bearer token + gameid + apptype + 随机 uk
//   - 发货链路所有响应均为明文 JSON（getUserInfoForApp 等是加密的，发货用不到）
// 仅依赖 Node 内置 fetch / crypto。SMS 登录静态方法保留（打旧 api，备用）。

const crypto = require('crypto');
const {UuApiCrypt} = require('./uu-crypt');

const TF2_HOST = 'g3-api.youpin898.com'; // TF2 / 新版 App 网关
const CS2_HOST = 'api.youpin898.com';    // CS2 / 旧接口
const APP_VERSION = '5.45.4';
const USER_AGENT = 'Android/9 official com.uu898.uuhavequality/5.45.4 okhttp/4.9.3';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function generateRandomString(length) {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < length; i++) out += chars[crypto.randomInt(chars.length)];
	return out;
}

function isJson(text) {
	try { JSON.parse(text); return true; } catch (err) { return false; }
}

// 解码 JWT（不验签，只取 payload 里的 Id / Name）
function decodeJwt(token) {
	try {
		const part = String(token).split('.')[1];
		const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
		return JSON.parse(json);
	} catch (err) {
		return null;
	}
}

// 旧版(api.youpin898.com)请求头，仅供 SMS 登录静态方法使用。
// 与 Steamauto uuyoupinapi.generate_headers 对齐：必须带 Device-Info 设备指纹，
// 否则上行短信(SmsUpSignIn / GetSmsUpSignInConfig)会被风控拒绝并返回误导性的“手机号格式错误”。
function generateHeaders(deviceToken, deviceId, token = '', gameId = '730') {
	return {
		uk: generateRandomString(65),
		authorization: 'Bearer ' + token,
		'content-type': 'application/json; charset=utf-8',
		'user-agent': 'okhttp/3.14.9',
		'App-Version': '5.28.3',
		AppType: '4',
		deviceType: '1',
		'package-type': 'uuyp',
		DeviceToken: deviceToken,
		DeviceId: deviceId,
		platform: 'android',
		'accept-encoding': 'gzip',
		Gameid: String(gameId),
		'Device-Info': JSON.stringify({
			deviceId: deviceId,
			deviceType: deviceId,
			hasSteamApp: 1,
			requestTag: generateRandomString(32).toUpperCase(),
			'systemName ': 'Android',
			systemVersion: '15'
		})
	};
}

function createDefaultLogger(debug) {
	return (level, message) => {
		if (level === 'debug' && !debug) return;
		const line = '[uuyoupin] ' + message;
		if (level === 'error') console.error(line);
		else if (level === 'warn') console.warn(line);
		else console.log(line);
	};
}

// 待发货子状态：1103 = “待您确认报价”（报价已由 UU 发出，等卖家确认）
const SUBSTATUS_WAIT_CONFIRM = 1103;

class UuAccount {
	/**
	 * @param {string} token 悠悠 Bearer token（抓包或短信登录获得）
	 * @param {object} [opts]
	 * @param {string|number} [opts.gameId=440] 游戏 ID，TF2=440，CS2=730
	 * @param {string} [opts.host] 覆盖网关；默认 TF2 用 g3-api，CS2 用 api
	 * @param {string} [opts.deviceToken] 设备/会话 id；默认随机 24 位
	 * @param {function} [opts.logger] (level, message) => void
	 * @param {boolean} [opts.debug=false]
	 */
	constructor(token, opts = {}) {
		this.token = String(token || '').trim();
		this.gameId = String(opts.gameId || '440');
		this.host = opts.host || (this.gameId === '730' ? CS2_HOST : TF2_HOST);
		this.deviceToken = opts.deviceToken || generateRandomString(24);
		this.apptype = String(opts.apptype || '7');
		this.appVersion = opts.appVersion || APP_VERSION;
		this.userAgent = opts.userAgent || USER_AGENT;
		this.log = typeof opts.logger === 'function' ? opts.logger : createDefaultLogger(!!opts.debug);

		const jwt = decodeJwt(this.token) || {};
		this.userId = opts.userId || jwt.Id || null;
		this.nickname = jwt.Name || '';
		this.jwtExp = jwt.exp || null;
	}

	static async create(token, opts = {}) {
		const account = new UuAccount(token, opts);
		await account.init();
		return account;
	}

	// 解 JWT 即可拿到身份；用一次 waitDeliverList 验证 token 仍有效
	async init() {
		if (!this.userId) throw new Error('无法从 token 解析出用户ID，token 可能无效');
		await this.getWaitDeliverList(); // 抛错即 token 失效/被拒
		return this;
	}

	getUserNickname() { return this.nickname; }

	// g3-api 请求头：免签名(已验证 signature 不校验)，但写接口(confirmOffer)
	// 会校验设备头，故补全 deviceid/devicetoken/requesttag/device-info 等。
	_headers() {
		const requestTag = generateRandomString(32).toUpperCase();
		return {
			authorization: 'Bearer ' + this.token,
			gameid: this.gameId,
			apptype: this.apptype,
			platform: 'android',
			devicetype: '1',
			devicebrand: 'xiaomi',
			'package-type': 'uuyp',
			'app-version': this.appVersion,
			'user-agent': this.userAgent,
			currenttheme: 'Light',
			deviceid: this.deviceToken,
			devicetoken: this.deviceToken,
			requesttag: requestTag,
			uk: generateRandomString(65),
			deviceuk: generateRandomString(65),
			'device-info': JSON.stringify({
				deviceType: 'Node', 'systemName ': 'Android', hasSteamApp: 0,
				deviceId: this.deviceToken, requestTag, systemVersion: '9'
			}),
			'content-type': 'application/json; charset=utf-8'
		};
	}

	/**
	 * @param {object} [opts]
	 * @param {string} [opts.host] 覆盖网关（CS2 上架/查价类接口需打 api.youpin898.com）
	 * @param {string} [opts.platform] 覆盖 platform 头（'pc' 用于 PC 端市场查价接口）
	 * @param {'random'|'none'|'real'} [opts.uk] uk 处理：random(默认,保持原行为) / none(删除,
	 *        对齐 Steamauto 写接口 uk_verify=false) / real(deviceW2 取真 uk, 用于市场查价)
	 */
	async callApi(method, path, data = null, opts = {}) {
		const host = opts.host || this.host;
		let url = 'https://' + host + path;
		const headers = this._headers();
		if (opts.platform) headers.platform = opts.platform;
		const ukMode = opts.uk || 'random';
		if (ukMode === 'none') {
			delete headers.uk;
		} else if (ukMode === 'real') {
			headers.uk = await this._getRealUk();
		}
		const init = {method, headers};
		if (method === 'GET') {
			if (data && typeof data === 'object') {
				const qs = new URLSearchParams();
				for (const [k, v] of Object.entries(data)) if (v != null) qs.set(k, String(v));
				const q = qs.toString();
				if (q) url += (url.includes('?') ? '&' : '?') + q;
			}
		} else if (data != null) {
			init.body = JSON.stringify(data);
		}

		const response = await fetch(url, init);
		const text = await response.text();
		if (!isJson(text)) {
			throw new Error(`UU 返回非 JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
		}
		const json = JSON.parse(text);
		this.log('debug', `${method} ${path} ${data ? JSON.stringify(data) : ''} -> ${text.slice(0, 400)}`);
		// 登录失效检测（bff 网关用小写 code；commodity 网关用大写 Code）
		if (json.code === 84101 || json.Code === 84101) throw new Error('登录状态失效，请重新登录');
		return json;
	}

	// 取真实 uk（deviceW2 加密握手获得），缓存 30s。仅 PC 端市场查价类接口需要。
	// 对齐 Steamauto uuyoupinapi.call_api 的 uk_verify 分支。
	async _getRealUk() {
		const now = Date.now();
		if (this._realUk && this._realUkTime && now - this._realUkTime < 30000) return this._realUk;
		try {
			const uk = await UuAccount.getUuUk();
			if (uk) {
				this._realUk = uk;
				this._realUkTime = now;
				return uk;
			}
			this.log('warn', '获取悠悠校验参数(uk)失败，本次使用随机 uk');
		} catch (err) {
			this.log('warn', '获取悠悠校验参数(uk)异常: ' + err.message);
		}
		return generateRandomString(65);
	}

	/**
	 * 待发货列表。
	 * @returns {Promise<Array>} 每项 {orderNo, orderId, orderStatus, orderSubStatus, subStatusName, statusName, itemName, hashName, templateId, sellAmount, raw}
	 */
	async getWaitDeliverList({gameId, pageSize = 100} = {}) {
		const gid = gameId != null ? Number(gameId) : Number(this.gameId);
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/sell/page/v1/waitDeliver/waitDeliverList', {
			gameId: gid, pageIndex: 1, pageSize, Sessionid: this.deviceToken
		});
		if (rsp.code !== 0) throw new Error('获取待发货列表失败: ' + rsp.msg);
		const list = (rsp.data && rsp.data.waitDeliverList) || [];
		return list.map(it => {
			const o = it.orderInfoVO || {};
			const c = it.commodityInfoVO || {};
			return {
				orderNo: o.orderNo,
				orderId: o.orderId,
				orderStatus: o.orderStatus,
				orderSubStatus: o.orderSubStatus,
				subStatusName: o.orderSubStatusName,
				statusName: o.orderStatusName,
				itemName: c.commodityName,
				hashName: c.commodityHashName,
				templateId: c.commodityTemplateId,
				sellAmount: o.sellAmount,
				raw: it
			};
		});
	}

	// 订单详情（含 Steam 报价号 tradeOfferId、offerSendResult）
	async getOrderDetail(orderNo) {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/v1/order/query/detail', {
			orderNo, userId: Number(this.userId), Sessionid: this.deviceToken
		});
		if (rsp.code !== 0) throw new Error('获取订单详情失败: ' + rsp.msg);
		return rsp.data;
	}

	// 发送报价（卖家主动发起：买家下单后处于“待发送报价”的订单，需卖家先发出 Steam 报价）。
	// 对齐 Steamauto uuyoupinapi.send_offer。成功返回 true，否则返回错误消息字符串。
	async sendOffer(orderNo) {
		const rsp = await this.callApi('PUT', '/api/youpin/bff/trade/v1/order/sell/delivery/send-offer', {
			orderNo, Sessionid: this.deviceToken
		});
		if (rsp.code === 0) return true;
		return rsp.msg;
	}

	// 查询报价发送状态。对齐 Steamauto uuyoupinapi.get_offer_status。
	// 成功返回 data 对象（含 status，3=发送成功），否则返回错误消息字符串。
	async getOfferStatus(orderNo) {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/v1/order/sell/delivery/get-offer-status', {
			orderNo, Sessionid: this.deviceToken
		});
		if (rsp.code === 0) return rsp.data;
		return rsp.msg;
	}

	// 确认报价。成功返回 true，否则返回错误消息字符串。
	async confirmOffer(orderNo, tradeOfferId) {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/v1/order/sell/delivery/confirmOffer', {
			confirmOrder: {orderNo, tradeOfferId: Number(tradeOfferId)}, Sessionid: this.deviceToken
		});
		if (rsp.code !== 0) return rsp.msg;
		return !!(rsp.data && rsp.data.success === true);
	}

	// 确认状态轮询，返回 {status, orderNo}
	async confirmOfferStatus(orderNo) {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/v1/order/sell/delivery/confirmOfferStatus', {
			orderNo, Sessionid: this.deviceToken
		});
		if (rsp.code !== 0) return rsp.msg;
		return rsp.data;
	}

	// 待办计数（轻量轮询用），返回 {list, count}
	async getOrderTodoTopList() {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/todo/v1/orderTodo/topList', {
			userId: String(this.userId), Sessionid: this.deviceToken
		});
		return rsp.data;
	}

	/**
	 * 高层：取待发货列表并为每单补上 tradeOfferId / offerSendResult。
	 * 只返回处于“待确认报价”(subStatus 1103) 的可发货订单。
	 */
	async getDeliverableOrders({gameId} = {}) {
		const orders = await this.getWaitDeliverList({gameId});
		const out = [];
		for (let i = 0; i < orders.length; i++) {
			const o = orders[i];
			let tradeOfferId = null, offerSendResult = null;
			try {
				const d = await this.getOrderDetail(o.orderNo);
				tradeOfferId = d.tradeOfferId || null;
				offerSendResult = d.offerSendResult;
			} catch (err) {
				this.log('warn', `订单 ${o.orderNo} 取详情失败: ${err.message}`);
			}
			out.push({...o, tradeOfferId, offerSendResult});
			// 逐笔取详情之间留间隔，避免频繁访问 UU 接口（对齐 Steamauto 取报价号时每笔间隔 3s）
			if (i < orders.length - 1) {
				await sleep(3000);
			}
		}
		return out;
	}

	/**
	 * 查询此 UU 账号绑定的 Steam 账号信息。
	 * 调旧 API (api.youpin898.com) 的 steam/cookie/pull，
	 * 返回 {steamId, cookieData}。steamId 是 SteamID64 字符串。
	 */
	async getSteamCookiePull() {
		const requestTag = generateRandomString(32).toUpperCase();
		const body = JSON.stringify({sceneCode: '1001', Sessionid: this.deviceToken});
		const headers = {
			DeviceToken: this.deviceToken,
			DeviceId: this.deviceToken,
			requestTag,
			Gameid: '730', // steam/cookie/pull 固定走旧 API CS2
			deviceType: '1',
			platform: 'android',
			'User-Agent': this.userAgent,
			currentTheme: 'Light',
			'package-type': 'uuyp',
			'App-Version': this.appVersion,
			uk: generateRandomString(65),
			deviceUk: generateRandomString(65),
			'Device-Info': JSON.stringify({
				deviceType: 'Node', 'systemName ': 'Android', hasSteamApp: 0,
				deviceId: this.deviceToken, requestTag, systemVersion: '9'
			}),
			AppType: '7',
			Authorization: 'Bearer ' + this.token,
			deviceBrand: 'xiaomi',
			'Content-Type': 'application/json; charset=utf-8'
		};
		const resp = await fetch('https://' + CS2_HOST + '/api/youpin/bff/steam/cookie/pull', {
			method: 'POST',
			headers,
			body
		});
		const json = await resp.json();
		if (json.code !== 0) {
			throw new Error('获取绑定 Steam 信息失败: ' + (json.msg || '未知错误'));
		}
		let steamId = '';
		let cookieData = null;
		try {
			const sc = JSON.parse(json.data && json.data.steamCookie);
			steamId = sc.steamId || '';
			cookieData = sc;
		} catch (err) {
			// steamCookie 解析失败，非致命
		}
		return {steamId, cookieData, raw: json.data};
	}

	// ===== CS2 上架相关（打 api.youpin898.com，对齐 Steamauto uuyoupinapi 出售部分） =====

	/**
	 * 获取本账号悠悠库存（CS2）。对齐 Steamauto get_inventory。
	 * @returns {Promise<Array>} ItemsInfos 原始数组。每项含 SteamAssetId / TemplateInfo{Id,CommodityName}
	 *          / AssetInfo{Abrade,...} / AssetBuyPrice / Tradable / AssetStatus / ActionLink
	 */
	async getInventory({refresh = false, pageSize = 1000} = {}) {
		const data = {pageIndex: 1, pageSize, AppType: 4, IsMerge: 0, Sessionid: this.deviceToken};
		if (refresh) {
			data.IsRefresh = true;
			data.RefreshType = 2;
		}
		const rsp = await this.callApi('POST', '/api/commodity/Inventory/GetUserInventoryDataListV3', data, {host: CS2_HOST, uk: 'none'});
		const code = rsp.Code != null ? rsp.Code : rsp.code;
		if (code !== 0) throw new Error('获取悠悠库存失败: ' + (rsp.Msg || rsp.msg || code));
		return (rsp.Data && rsp.Data.ItemsInfos) || [];
	}

	/**
	 * 查询市场某模板在售列表（支持按磨损区间过滤）。需真 uk + PC 平台。
	 * 对齐 Steamauto get_market_sale_list_with_abrade。
	 * @returns {Promise<Array>} 在售商品数组，每项含 commodityName / price
	 */
	async getMarketSaleListWithAbrade(templateId, {pageIndex = 1, pageSize = 20, minAbrade = null, maxAbrade = null} = {}) {
		const data = {pageIndex, pageSize, templateId: String(templateId)};
		if (minAbrade != null) data.minAbrade = String(minAbrade);
		if (maxAbrade != null) data.maxAbrade = String(maxAbrade);
		const rsp = await this.callApi('POST', '/api/homepage/pc/goods/market/queryOnSaleCommodityList', data, {host: CS2_HOST, uk: 'real', platform: 'pc'});
		const code = rsp.Code != null ? rsp.Code : rsp.code;
		if (code !== 0) throw new Error('查询出售价格失败: ' + (rsp.Msg || rsp.msg || code));
		return rsp.Data || rsp.data || [];
	}

	/**
	 * 上架出售（仅出售，不含出租）。对齐 Steamauto SellInventoryWithLeaseV2，50 个一批。
	 * @param {Array<{AssetId:(string|number), Price:number, Remark?:string}>} items
	 * @returns {Promise<{success:number, fail:number, results:Array}>}
	 */
	async sellItems(items) {
		const list = (items || []).map(it => ({
			AssetId: it.AssetId,
			IsCanLease: false,
			IsCanSold: true,
			Price: it.Price,
			Remark: it.Remark || ''
		}));
		let success = 0;
		let fail = 0;
		const results = [];
		for (let i = 0; i < list.length; i += 50) {
			const batch = list.slice(i, i + 50);
			const rsp = await this.callApi('POST', '/api/commodity/Inventory/SellInventoryWithLeaseV2',
				{GameId: 730, ItemInfos: batch, Sessionid: this.deviceToken}, {host: CS2_HOST, uk: 'none'});
			const code = rsp.Code != null ? rsp.Code : rsp.code;
			if (code !== 0) {
				// 7000002 + errorData.sceneCode：悠悠的“交易撤回须知”合规确认门，需账号先在 App 内手动上架一次并确认（一次性）
				if (code === 7000002 || (rsp.errorData && rsp.errorData.sceneCode)) {
					const sceneName = (rsp.errorData && (rsp.errorData.sceneName || rsp.errorData.sceneTitle)) || '交易合规确认';
					const err = new Error(`需先在悠悠有品 App 内手动上架一次并确认「${sceneName}」（一次性合规确认），之后自动上架即可正常工作 (code ${code})`);
					err.uuSceneConfirm = true;
					throw err;
				}
				throw new Error('上架失败: code=' + code + ' ' + (rsp.Msg || rsp.msg || ''));
			}
			const data = rsp.Data || rsp.data || [];
			for (const r of data) {
				results.push(r);
				if (r.Status === 1) success++;
				else fail++;
			}
		}
		return {success, fail, results};
	}

	/**
	 * 修改已上架物品价格。对齐 Steamauto PriceChangeWithLeaseV2 / change_items_price_v2，500 个一批。
	 * @param {Array<{CommodityId:(string|number), Price:number, Remark?:string}>} items
	 * @returns {Promise<{success:number, fail:number}>}
	 */
	async changeSalePrice(items) {
		const list = (items || []).map(it => ({
			CommodityId: it.CommodityId,
			IsCanLease: false,
			IsCanSold: true,
			Price: it.Price,
			Remark: it.Remark || ''
		}));
		let success = 0;
		let fail = 0;
		for (let i = 0; i < list.length; i += 500) {
			const batch = list.slice(i, i + 500);
			const rsp = await this.callApi('PUT', '/api/commodity/Commodity/PriceChangeWithLeaseV2',
				{Commoditys: batch, Sessionid: this.deviceToken}, {host: CS2_HOST, uk: 'none'});
			const code = rsp.Code != null ? rsp.Code : rsp.code;
			if (code !== 0) {
				if (code === 7000002 || (rsp.errorData && rsp.errorData.sceneCode)) {
					const sceneName = (rsp.errorData && (rsp.errorData.sceneName || rsp.errorData.sceneTitle)) || '交易合规确认';
					const err = new Error(`需先在悠悠有品 App 内确认「${sceneName}」（一次性合规确认）后再改价 (code ${code})`);
					err.uuSceneConfirm = true;
					throw err;
				}
				throw new Error('改价失败: code=' + code + ' ' + (rsp.Msg || rsp.msg || ''));
			}
			const section = rsp.Data || rsp.data || {};
			if (Array.isArray(section.Commoditys)) {
				for (const r of section.Commoditys) {
					if (r.IsSuccess === 1) success++;
					else fail++;
				}
				if (section.SuccessCount != null) {
					success = section.SuccessCount;
					fail = section.FailCount != null ? section.FailCount : fail;
				}
			} else {
				success += batch.length; // Code==0 但无明细，视为全成功
			}
		}
		return {success, fail};
	}

	/**
	 * 获取本账号当前在售列表（CS2）。对齐 Steamauto get_sell_list。分页拉全。
	 * @returns {Promise<Array>} 每项含 id(=CommodityId) / templateId / name / sellAmount(当前价) / abrade / steamAssetId
	 */
	async getSellList({pageSize = 100} = {}) {
		const out = [];
		let pageIndex = 0;
		// 防御性上限：最多 100 页（1 万件），避免异常分页死循环
		for (let guard = 0; guard < 100; guard++) {
			pageIndex += 1;
			const rsp = await this.callApi('POST', '/api/youpin/bff/new/commodity/v1/commodity/list/sell',
				{pageIndex, pageSize, whetherMerge: 0}, {host: CS2_HOST});
			const code = rsp.code != null ? rsp.code : rsp.Code;
			if (code !== 0) break;
			const list = (rsp.data && rsp.data.commodityInfoList) || [];
			if (!list.length) break;
			for (const it of list) {
				if ('steamAssetId' in it) out.push(it);
			}
			if (list.length < pageSize) break; // 最后一页
		}
		return out;
	}

	// ===== SMS 登录 / UK 加密（打旧 api.youpin898.com，备用，发货不需要） =====

	static async getUuUk(headers = {}, dispatcher = null) {
		const apiCrypt = new UuApiCrypt(generateRandomString(16));
		const data = {iud: crypto.randomUUID()};
		const init = {
			method: 'POST',
			headers: Object.assign({'content-type': 'application/json; charset=utf-8'}, headers),
			body: JSON.stringify({encryptedData: apiCrypt.encrypt(JSON.stringify(data)), encryptedAesKey: apiCrypt.getEncryptedAesKey()})
		};
		if (dispatcher) init.dispatcher = dispatcher;
		const resp = await fetch('https://' + CS2_HOST + '/api/deviceW2', init);
		if (resp.status !== 200) return '';
		try {
			const body = await resp.text();
			return JSON.parse(apiCrypt.decrypt(body)).u;
		} catch (err) {
			return '';
		}
	}

	static async getSmsUpSignInConfig(headers = {}, dispatcher = null) {
		const init = {method: 'GET', headers};
		if (dispatcher) init.dispatcher = dispatcher;
		const resp = await fetch('https://' + CS2_HOST + '/api/user/Auth/GetSmsUpSignInConfig', init);
		return resp.json();
	}

	static async sendLoginSmsCode(phone, session, {headers = {}, regionCode = 86, uk = '', dispatcher = null} = {}) {
		const reqHeaders = Object.assign({'content-type': 'application/json; charset=utf-8'}, headers);
		if (uk) reqHeaders.uk = uk;
		const init = {method: 'POST', headers: reqHeaders, body: JSON.stringify({Area: regionCode, Mobile: phone, Sessionid: session, Code: ''})};
		if (dispatcher) init.dispatcher = dispatcher;
		const resp = await fetch('https://' + CS2_HOST + '/api/user/Auth/SendSignInSmsCode', init);
		return resp.json();
	}

	static async smsSignIn(phone, code, session, {headers = {}, dispatcher = null} = {}) {
		const url = 'https://' + CS2_HOST + (code === '' ? '/api/user/Auth/SmsUpSignIn' : '/api/user/Auth/SmsSignIn');
		const init = {method: 'POST', headers: Object.assign({'content-type': 'application/json; charset=utf-8'}, headers), body: JSON.stringify({Area: 86, Code: code, DeviceName: session, Sessionid: session, Mobile: phone})};
		if (dispatcher) init.dispatcher = dispatcher;
		const resp = await fetch(url, init);
		return resp.json();
	}
}

module.exports = {UuAccount, generateHeaders, generateRandomString, isJson, decodeJwt, SUBSTATUS_WAIT_CONFIRM, TF2_HOST, CS2_HOST};
