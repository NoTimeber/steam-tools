// 悠悠有品 API 客户端(从 app/lib/uuyoupin.js 移来,请求与旧版逐字一致)。
// 基于 2026-06-03 对安卓 App v5.45.4 的抓包逆向:
//   - TF2 发货走新网关 g3-api.youpin898.com,CS2 走 api.youpin898.com;
//   - g3-api 不强校验 signature 头,只要 Bearer token + gameid + apptype + 随机 uk;
//   - 发货链路的响应都是明文 JSON。
// CS2 上架/改价/查价对齐 Steamauto 的 uuyoupinapi;短信登录的静态方法打旧接口。

import {randomInt, randomUUID} from 'node:crypto';
import {UuApiCrypt} from './crypt.ts';

export const TF2_HOST = 'g3-api.youpin898.com';
export const CS2_HOST = 'api.youpin898.com';
const APP_VERSION = '5.45.4';
const USER_AGENT = 'Android/9 official com.uu898.uuhavequality/5.45.4 okhttp/4.9.3';
// 登录失效(bff 网关用小写 code,commodity 网关用大写 Code)
const CODE_LOGIN_EXPIRED = 84101;
// 悠悠的「交易撤回须知」合规确认门:账号要先在 App 里手动上架一次并确认
const CODE_SCENE_CONFIRM = 7000002;

/** 待发货子状态 1103 =「待您确认报价」(报价已由 UU 发出,等卖家确认) */
export const SUBSTATUS_WAIT_CONFIRM = 1103;

export type UuLogger = (level: string, message: string) => void;

// UU 接口的原始 JSON;字段很多且不稳定,只在这一层用宽松类型
type Json = any;

export interface UuResponse {
	code?: number;
	Code?: number;
	msg?: string;
	Msg?: string;
	data?: Json;
	Data?: Json;
	errorData?: {sceneCode?: unknown; sceneName?: string; sceneTitle?: string};
}

export interface UuOrder {
	orderNo: string;
	orderId?: unknown;
	orderStatus?: unknown;
	orderSubStatus?: number | string;
	subStatusName?: string;
	statusName?: string;
	itemName?: string;
	hashName?: string;
	templateId?: unknown;
	sellAmount?: unknown;
	raw?: unknown;
}

export interface UuDeliverableOrder extends UuOrder {
	tradeOfferId: string | number | null;
	offerSendResult: unknown;
}

export interface UuOrderDetail {
	tradeOfferId?: string | number | null;
	offerSendResult?: unknown;
	buyer?: {steamId?: string};
	commodity?: {assetId?: string | number; assertId?: string | number};
	[key: string]: unknown;
}

export interface UuInventoryItem {
	SteamAssetId?: string | number;
	Tradable?: boolean;
	AssetStatus?: number;
	TemplateInfo?: {Id?: string | number; CommodityName?: string};
	AssetInfo?: {Abrade?: string | number | null} | null;
	ActionLink?: string;
	[key: string]: unknown;
}

export interface UuSellListItem {
	id?: string | number;
	templateId?: string | number;
	name?: string;
	sellAmount?: string | number;
	abrade?: string | number;
	steamAssetId?: string | number;
	[key: string]: unknown;
}

export interface UuMarketSale {
	price?: string | number;
	commodityName?: string;
	[key: string]: unknown;
}

export interface UuJwt {
	Id?: string | number;
	Name?: string;
	exp?: number;
	[key: string]: unknown;
}

export interface UuAccountOptions {
	/** TF2=440(默认)、CS2=730 */
	gameId?: string | number;
	/** 覆盖网关;默认 CS2 用 api、TF2 用 g3-api */
	host?: string;
	/** 设备/会话 id;默认随机 24 位 */
	deviceToken?: string;
	apptype?: string | number;
	appVersion?: string;
	userAgent?: string;
	userId?: string | number;
	logger?: UuLogger;
	debug?: boolean;
}

export interface CallApiOptions {
	/** 覆盖网关(CS2 上架/查价打 api.youpin898.com) */
	host?: string;
	/** 覆盖 platform 头('pc' 用于 PC 端市场查价) */
	platform?: string;
	/** random:随机 uk(默认);none:不带 uk(对齐 Steamauto 写接口);real:deviceW2 握手取真 uk(市场查价) */
	uk?: 'random' | 'none' | 'real';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function generateRandomString(length: number): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < length; i++) {
		out += chars[randomInt(chars.length)];
	}
	return out;
}

export function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/** 解 JWT(不验签,只取 payload 里的 Id / Name / exp);解不出来为 null */
export function decodeJwt(token: unknown): UuJwt | null {
	try {
		const part = String(token).split('.')[1] as string;
		return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as UuJwt;
	} catch {
		return null;
	}
}

/**
 * 旧版(api.youpin898.com)请求头,只给短信登录用。与 Steamauto generate_headers 对齐:必须带 Device-Info,
 * 否则上行短信会被风控拒绝并返回误导性的「手机号格式错误」。
 */
export function generateHeaders(deviceToken: string, deviceId: string, token = '', gameId: string | number = '730'): Record<string, string> {
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
			deviceId,
			deviceType: deviceId,
			hasSteamApp: 1,
			requestTag: generateRandomString(32).toUpperCase(),
			'systemName ': 'Android',
			systemVersion: '15'
		})
	};
}

function createDefaultLogger(debug: boolean): UuLogger {
	return (level, message) => {
		if (level === 'debug' && !debug) {
			return;
		}
		const line = '[uuyoupin] ' + message;
		if (level === 'error') {
			console.error(line);
		} else if (level === 'warn') {
			console.warn(line);
		} else {
			console.log(line);
		}
	};
}

function responseCode(rsp: UuResponse, upperFirst: boolean): number | undefined {
	return upperFirst ? (rsp.Code != null ? rsp.Code : rsp.code) : (rsp.code != null ? rsp.code : rsp.Code);
}

/** 撞上合规确认门时返回场景名,否则 null */
function sceneConfirmName(rsp: UuResponse, code: number | undefined): string | null {
	if (code !== CODE_SCENE_CONFIRM && !(rsp.errorData && rsp.errorData.sceneCode)) {
		return null;
	}
	return (rsp.errorData && (rsp.errorData.sceneName || rsp.errorData.sceneTitle)) || '交易合规确认';
}

function sceneConfirmError(message: string): Error {
	return Object.assign(new Error(message), {uuSceneConfirm: true});
}

// 旧调用方可能传自己的 undici dispatcher(代理),原样透传给 fetch
type FetchInit = Omit<RequestInit, 'dispatcher'> & {dispatcher?: unknown};

export class UuAccount {
	readonly token: string;
	readonly gameId: string;
	readonly host: string;
	readonly deviceToken: string;
	readonly apptype: string;
	readonly appVersion: string;
	readonly userAgent: string;
	readonly userId: string | number | null;
	readonly nickname: string;
	readonly jwtExp: number | null;
	private readonly log: UuLogger;
	private realUk = '';
	private realUkTime = 0;

	constructor(token: unknown, opts: UuAccountOptions = {}) {
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

	/** 解 JWT 拿身份,再打一次待发货列表确认 token 有效(失败抛错) */
	static async create(token: unknown, opts: UuAccountOptions = {}): Promise<UuAccount> {
		const account = new UuAccount(token, opts);
		await account.init();
		return account;
	}

	async init(): Promise<this> {
		if (!this.userId) {
			throw new Error('无法从 token 解析出用户ID，token 可能无效');
		}
		await this.getWaitDeliverList();
		return this;
	}

	getUserNickname(): string {
		return this.nickname;
	}

	// g3-api 请求头:不校验签名,但写接口(confirmOffer)会校验设备头,所以 deviceid/devicetoken/requesttag/device-info 都带上
	private headers(): Record<string, string> {
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

	async callApi(method: string, path: string, data: Record<string, unknown> | null = null, opts: CallApiOptions = {}): Promise<UuResponse> {
		let url = 'https://' + (opts.host || this.host) + path;
		const headers = this.headers();
		if (opts.platform) {
			headers.platform = opts.platform;
		}
		const ukMode = opts.uk || 'random';
		if (ukMode === 'none') {
			delete headers.uk;
		} else if (ukMode === 'real') {
			headers.uk = await this.getRealUk();
		}
		const init: RequestInit = {method, headers};
		if (method === 'GET') {
			if (data && typeof data === 'object') {
				const qs = new URLSearchParams();
				for (const [key, value] of Object.entries(data)) {
					if (value != null) {
						qs.set(key, String(value));
					}
				}
				const query = qs.toString();
				if (query) {
					url += (url.includes('?') ? '&' : '?') + query;
				}
			}
		} else if (data != null) {
			init.body = JSON.stringify(data);
		}

		const response = await fetch(url, init);
		const text = await response.text();
		if (!isJson(text)) {
			throw new Error(`UU 返回非 JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
		}
		const json = JSON.parse(text) as UuResponse;
		this.log('debug', `${method} ${path} ${data ? JSON.stringify(data) : ''} -> ${text.slice(0, 400)}`);
		if (json.code === CODE_LOGIN_EXPIRED || json.Code === CODE_LOGIN_EXPIRED) {
			throw new Error('登录状态失效，请重新登录');
		}
		return json;
	}

	// deviceW2 握手取真 uk,缓存 30 秒;只有 PC 端市场查价要(对齐 Steamauto 的 uk_verify)
	private async getRealUk(): Promise<string> {
		const now = Date.now();
		if (this.realUk && this.realUkTime && now - this.realUkTime < 30000) {
			return this.realUk;
		}
		try {
			const uk = await UuAccount.getUuUk();
			if (uk) {
				this.realUk = uk;
				this.realUkTime = now;
				return uk;
			}
			this.log('warn', '获取悠悠校验参数(uk)失败，本次使用随机 uk');
		} catch (err) {
			this.log('warn', '获取悠悠校验参数(uk)异常: ' + (err as Error).message);
		}
		return generateRandomString(65);
	}

	/** 待发货列表 */
	async getWaitDeliverList({gameId, pageSize = 100}: {gameId?: string | number; pageSize?: number} = {}): Promise<UuOrder[]> {
		const gid = gameId != null ? Number(gameId) : Number(this.gameId);
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/sell/page/v1/waitDeliver/waitDeliverList', {
			gameId: gid, pageIndex: 1, pageSize, Sessionid: this.deviceToken
		});
		if (rsp.code !== 0) {
			throw new Error('获取待发货列表失败: ' + rsp.msg);
		}
		const list: Json[] = (rsp.data && rsp.data.waitDeliverList) || [];
		return list.map(item => {
			const order = item.orderInfoVO || {};
			const commodity = item.commodityInfoVO || {};
			return {
				orderNo: order.orderNo,
				orderId: order.orderId,
				orderStatus: order.orderStatus,
				orderSubStatus: order.orderSubStatus,
				subStatusName: order.orderSubStatusName,
				statusName: order.orderStatusName,
				itemName: commodity.commodityName,
				hashName: commodity.commodityHashName,
				templateId: commodity.commodityTemplateId,
				sellAmount: order.sellAmount,
				raw: item
			};
		});
	}

	/** 订单详情(含 Steam 报价号 tradeOfferId、offerSendResult) */
	async getOrderDetail(orderNo: string): Promise<UuOrderDetail> {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/v1/order/query/detail', {
			orderNo, userId: Number(this.userId), Sessionid: this.deviceToken
		});
		if (rsp.code !== 0) {
			throw new Error('获取订单详情失败: ' + rsp.msg);
		}
		return rsp.data;
	}

	/** 发送报价(买家下单后「待发送报价」的订单要卖家先发出 Steam 报价)。成功 true,否则错误消息 */
	async sendOffer(orderNo: string): Promise<true | string | undefined> {
		const rsp = await this.callApi('PUT', '/api/youpin/bff/trade/v1/order/sell/delivery/send-offer', {orderNo, Sessionid: this.deviceToken});
		return rsp.code === 0 ? true : rsp.msg;
	}

	/** 报价发送状态:成功返回 data(status=3 表示已发出),否则错误消息 */
	async getOfferStatus(orderNo: string): Promise<{status?: number | string; [key: string]: unknown} | string | undefined> {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/v1/order/sell/delivery/get-offer-status', {orderNo, Sessionid: this.deviceToken});
		return rsp.code === 0 ? rsp.data : rsp.msg;
	}

	/** 确认报价:成功 true,UU 拒绝时返回错误消息,data.success 不为 true 时 false */
	async confirmOffer(orderNo: string, tradeOfferId: string | number): Promise<boolean | string | undefined> {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/v1/order/sell/delivery/confirmOffer', {
			confirmOrder: {orderNo, tradeOfferId: Number(tradeOfferId)}, Sessionid: this.deviceToken
		});
		if (rsp.code !== 0) {
			return rsp.msg;
		}
		return !!(rsp.data && rsp.data.success === true);
	}

	async confirmOfferStatus(orderNo: string): Promise<unknown> {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/v1/order/sell/delivery/confirmOfferStatus', {orderNo, Sessionid: this.deviceToken});
		return rsp.code !== 0 ? rsp.msg : rsp.data;
	}

	/** 待办计数(轻量轮询用) */
	async getOrderTodoTopList(): Promise<unknown> {
		const rsp = await this.callApi('POST', '/api/youpin/bff/trade/todo/v1/orderTodo/topList', {userId: String(this.userId), Sessionid: this.deviceToken});
		return rsp.data;
	}

	/** 待发货列表 + 每单的 tradeOfferId / offerSendResult(逐单取详情,间隔 3 秒,对齐 Steamauto) */
	async getDeliverableOrders({gameId}: {gameId?: string | number} = {}): Promise<UuDeliverableOrder[]> {
		const orders = await this.getWaitDeliverList({gameId});
		const out: UuDeliverableOrder[] = [];
		for (let i = 0; i < orders.length; i++) {
			const order = orders[i] as UuOrder;
			let tradeOfferId: string | number | null = null;
			let offerSendResult: unknown = null;
			try {
				const detail = await this.getOrderDetail(order.orderNo);
				tradeOfferId = detail.tradeOfferId || null;
				offerSendResult = detail.offerSendResult;
			} catch (err) {
				this.log('warn', `订单 ${order.orderNo} 取详情失败: ${(err as Error).message}`);
			}
			out.push({...order, tradeOfferId, offerSendResult});
			if (i < orders.length - 1) {
				await sleep(3000);
			}
		}
		return out;
	}

	/** 这个 UU 账号绑定的 Steam 账号(旧接口 steam/cookie/pull,固定 CS2);steamId 是 SteamID64 字符串 */
	async getSteamCookiePull(): Promise<{steamId: string; cookieData: unknown; raw: unknown}> {
		const requestTag = generateRandomString(32).toUpperCase();
		const headers = {
			DeviceToken: this.deviceToken,
			DeviceId: this.deviceToken,
			requestTag,
			Gameid: '730',
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
			body: JSON.stringify({sceneCode: '1001', Sessionid: this.deviceToken})
		});
		const json = await resp.json() as UuResponse;
		if (json.code !== 0) {
			throw new Error('获取绑定 Steam 信息失败: ' + (json.msg || '未知错误'));
		}
		let steamId = '';
		let cookieData: unknown = null;
		try {
			const steamCookie = JSON.parse(json.data && json.data.steamCookie);
			steamId = steamCookie.steamId || '';
			cookieData = steamCookie;
		} catch {
			// steamCookie 解析失败不致命
		}
		return {steamId, cookieData, raw: json.data};
	}

	// ===== CS2 上架(打 api.youpin898.com,对齐 Steamauto 的出售部分) =====

	/** 本账号 CS2 库存(ItemsInfos 原样) */
	async getInventory({refresh = false, pageSize = 1000}: {refresh?: boolean; pageSize?: number} = {}): Promise<UuInventoryItem[]> {
		const data: Record<string, unknown> = {pageIndex: 1, pageSize, AppType: 4, IsMerge: 0, Sessionid: this.deviceToken};
		if (refresh) {
			data.IsRefresh = true;
			data.RefreshType = 2;
		}
		const rsp = await this.callApi('POST', '/api/commodity/Inventory/GetUserInventoryDataListV3', data, {host: CS2_HOST, uk: 'none'});
		const code = responseCode(rsp, true);
		if (code !== 0) {
			throw new Error('获取悠悠库存失败: ' + (rsp.Msg || rsp.msg || code));
		}
		return (rsp.Data && rsp.Data.ItemsInfos) || [];
	}

	/** 某模板的市场在售列表(可按磨损区间过滤);要真 uk + PC 平台 */
	async getMarketSaleListWithAbrade(templateId: string | number, {pageIndex = 1, pageSize = 20, minAbrade = null, maxAbrade = null}: {
		pageIndex?: number;
		pageSize?: number;
		minAbrade?: number | null;
		maxAbrade?: number | null;
	} = {}): Promise<UuMarketSale[]> {
		const data: Record<string, unknown> = {pageIndex, pageSize, templateId: String(templateId)};
		if (minAbrade != null) {
			data.minAbrade = String(minAbrade);
		}
		if (maxAbrade != null) {
			data.maxAbrade = String(maxAbrade);
		}
		const rsp = await this.callApi('POST', '/api/homepage/pc/goods/market/queryOnSaleCommodityList', data, {host: CS2_HOST, uk: 'real', platform: 'pc'});
		const code = responseCode(rsp, true);
		if (code !== 0) {
			throw new Error('查询出售价格失败: ' + (rsp.Msg || rsp.msg || code));
		}
		return rsp.Data || rsp.data || [];
	}

	/** 上架出售(只卖不租),50 个一批 */
	async sellItems(items: Array<{AssetId: string | number | undefined; Price: number; Remark?: string}>): Promise<{success: number; fail: number; results: unknown[]}> {
		const list = (items || []).map(item => ({AssetId: item.AssetId, IsCanLease: false, IsCanSold: true, Price: item.Price, Remark: item.Remark || ''}));
		let success = 0;
		let fail = 0;
		const results: unknown[] = [];
		for (let i = 0; i < list.length; i += 50) {
			const rsp = await this.callApi('POST', '/api/commodity/Inventory/SellInventoryWithLeaseV2',
				{GameId: 730, ItemInfos: list.slice(i, i + 50), Sessionid: this.deviceToken}, {host: CS2_HOST, uk: 'none'});
			const code = responseCode(rsp, true);
			if (code !== 0) {
				const scene = sceneConfirmName(rsp, code);
				throw scene
					? sceneConfirmError(`需先在悠悠有品 App 内手动上架一次并确认「${scene}」（一次性合规确认），之后自动上架即可正常工作 (code ${code})`)
					: new Error('上架失败: code=' + code + ' ' + (rsp.Msg || rsp.msg || ''));
			}
			for (const result of (rsp.Data || rsp.data || []) as Array<{Status?: number}>) {
				results.push(result);
				if (result.Status === 1) {
					success++;
				} else {
					fail++;
				}
			}
		}
		return {success, fail, results};
	}

	/** 改在售价格,500 个一批 */
	async changeSalePrice(items: Array<{CommodityId: string | number; Price: number; Remark?: string}>): Promise<{success: number; fail: number}> {
		const list = (items || []).map(item => ({CommodityId: item.CommodityId, IsCanLease: false, IsCanSold: true, Price: item.Price, Remark: item.Remark || ''}));
		let success = 0;
		let fail = 0;
		for (let i = 0; i < list.length; i += 500) {
			const batch = list.slice(i, i + 500);
			const rsp = await this.callApi('PUT', '/api/commodity/Commodity/PriceChangeWithLeaseV2',
				{Commoditys: batch, Sessionid: this.deviceToken}, {host: CS2_HOST, uk: 'none'});
			const code = responseCode(rsp, true);
			if (code !== 0) {
				const scene = sceneConfirmName(rsp, code);
				throw scene
					? sceneConfirmError(`需先在悠悠有品 App 内确认「${scene}」（一次性合规确认）后再改价 (code ${code})`)
					: new Error('改价失败: code=' + code + ' ' + (rsp.Msg || rsp.msg || ''));
			}
			const section = rsp.Data || rsp.data || {};
			if (Array.isArray(section.Commoditys)) {
				for (const result of section.Commoditys as Array<{IsSuccess?: number}>) {
					if (result.IsSuccess === 1) {
						success++;
					} else {
						fail++;
					}
				}
				if (section.SuccessCount != null) {
					success = section.SuccessCount;
					fail = section.FailCount != null ? section.FailCount : fail;
				}
			} else {
				success += batch.length;   // Code==0 但没有明细,算全部成功
			}
		}
		return {success, fail};
	}

	/** 在售列表(CS2),分页拉全,最多 100 页 */
	async getSellList({pageSize = 100}: {pageSize?: number} = {}): Promise<UuSellListItem[]> {
		const out: UuSellListItem[] = [];
		let pageIndex = 0;
		for (let guard = 0; guard < 100; guard++) {
			pageIndex += 1;
			const rsp = await this.callApi('POST', '/api/youpin/bff/new/commodity/v1/commodity/list/sell', {pageIndex, pageSize, whetherMerge: 0}, {host: CS2_HOST});
			if (responseCode(rsp, false) !== 0) {
				break;
			}
			const list: UuSellListItem[] = (rsp.data && rsp.data.commodityInfoList) || [];
			if (!list.length) {
				break;
			}
			for (const item of list) {
				if ('steamAssetId' in item) {
					out.push(item);
				}
			}
			if (list.length < pageSize) {
				break;
			}
		}
		return out;
	}

	// ===== 短信登录 / uk 握手(打旧 api.youpin898.com) =====

	static async getUuUk(headers: Record<string, string> = {}, dispatcher: unknown = null): Promise<string> {
		const apiCrypt = new UuApiCrypt(generateRandomString(16));
		const init: FetchInit = {
			method: 'POST',
			headers: {'content-type': 'application/json; charset=utf-8', ...headers},
			body: JSON.stringify({encryptedData: apiCrypt.encrypt(JSON.stringify({iud: randomUUID()})), encryptedAesKey: apiCrypt.getEncryptedAesKey()})
		};
		if (dispatcher) {
			init.dispatcher = dispatcher;
		}
		const resp = await fetch('https://' + CS2_HOST + '/api/deviceW2', init as RequestInit);
		if (resp.status !== 200) {
			return '';
		}
		try {
			return JSON.parse(apiCrypt.decrypt(await resp.text())).u;
		} catch {
			return '';
		}
	}

	static async getSmsUpSignInConfig(headers: Record<string, string> = {}, dispatcher: unknown = null): Promise<Json> {
		const init: FetchInit = {method: 'GET', headers};
		if (dispatcher) {
			init.dispatcher = dispatcher;
		}
		const resp = await fetch('https://' + CS2_HOST + '/api/user/Auth/GetSmsUpSignInConfig', init as RequestInit);
		return resp.json();
	}

	static async sendLoginSmsCode(phone: string, session: string, {headers = {}, regionCode = 86, uk = '', dispatcher = null}: {
		headers?: Record<string, string>;
		regionCode?: number;
		uk?: string;
		dispatcher?: unknown;
	} = {}): Promise<Json> {
		const reqHeaders: Record<string, string> = {'content-type': 'application/json; charset=utf-8', ...headers};
		if (uk) {
			reqHeaders.uk = uk;
		}
		const init: FetchInit = {method: 'POST', headers: reqHeaders, body: JSON.stringify({Area: regionCode, Mobile: phone, Sessionid: session, Code: ''})};
		if (dispatcher) {
			init.dispatcher = dispatcher;
		}
		const resp = await fetch('https://' + CS2_HOST + '/api/user/Auth/SendSignInSmsCode', init as RequestInit);
		return resp.json();
	}

	/** code 为空走上行短信登录 */
	static async smsSignIn(phone: string, code: string, session: string, {headers = {}, dispatcher = null}: {headers?: Record<string, string>; dispatcher?: unknown} = {}): Promise<Json> {
		const url = 'https://' + CS2_HOST + (code === '' ? '/api/user/Auth/SmsUpSignIn' : '/api/user/Auth/SmsSignIn');
		const init: FetchInit = {
			method: 'POST',
			headers: {'content-type': 'application/json; charset=utf-8', ...headers},
			body: JSON.stringify({Area: 86, Code: code, DeviceName: session, Sessionid: session, Mobile: phone})
		};
		if (dispatcher) {
			init.dispatcher = dispatcher;
		}
		const resp = await fetch(url, init as RequestInit);
		return resp.json();
	}
}
