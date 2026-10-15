// C5GAME 开放平台客户端(从 c5 项目的 c5bot/client.py 移来)。接口文档:https://opendoc.c5game.com
//
// - 所有请求在 query 里带 app-key,请求头带 Accept-Encoding: gzip, br, zstd, deflate(官方要求,Node 的 fetch 都能解)。
// - 在售 id、订单 id 是 64 位整数,超出 JS 数字精度:响应里的大整数按原文转成字符串,下单时再按原样的数字写回请求体。
// - 错误分两种:C5Error = 平台明确拒绝 / 根本没连上,请求肯定没生效;C5NetworkError = 超时、断连、5xx(带不带 JSON 都算),结果未知。
//   报错文字里不带 URL(URL 里有 app-key)。

export const C5_BASE_URL = 'https://openapi.c5game.com';
export const ACCEPT_ENCODING = 'gzip, br, zstd, deflate';

export class C5Error extends Error {
	override name = 'C5Error';
	readonly code: number | null;
	readonly codeStr: string | null;

	constructor(message: string, options: {code?: number | null; codeStr?: string | null} = {}) {
		super(message);
		this.code = options.code ?? null;
		this.codeStr = options.codeStr ?? null;
	}
}

/** 超时、断连、5xx:请求可能已经生效,结果未知 */
export class C5NetworkError extends C5Error {
	override name = 'C5NetworkError';
}

// 平台返回的原始 JSON 字段很多且不稳定,只在这一层用宽松类型
type Json = any;

export interface C5Balance {
	/** 可用余额 */
	moneyAmount?: number | string;
	tradeSettleAmount?: number | string;
	depositAmount?: number | string;
	[key: string]: unknown;
}

export interface C5SteamAccount {
	steamId?: string;
	nickname?: string;
	/** Steam 登录名 */
	username?: string;
	/** 0 普通 Steam 账号 / 2 交易助手 */
	autoType?: number;
	/** 1 正常 / 2 暂挂 / 3 不可交易(库存未公开、交易链接未填写或失效、账号不可交易等) */
	accountStatus?: number;
	[key: string]: unknown;
}

export interface C5ItemStat {
	/** 在售最低价 */
	sellPrice?: number | string | null;
	sellCount?: number | null;
	/** 求购最高价 */
	purchaseMaxPrice?: number | string | null;
	[key: string]: unknown;
}

export interface C5BuyProduct {
	/** 在售 id(64 位整数的十进制文本) */
	productId: string;
	buyPrice: number;
	outTradeNo: string;
}

export interface C5SearchOptions {
	appId: number;
	name: string;
	priceMax: number;
	delivery?: number;
	assetType?: number;
	pageSize?: number;
}

export interface C5QuickBuyOptions {
	outTradeNo: string;
	tradeUrl: string;
	appId: number;
	name: string;
	maxPrice: number;
	delivery?: number;
}

export interface C5Api {
	balance(): Promise<C5Balance>;
	steamInfo(): Promise<{steamList?: C5SteamAccount[]; [key: string]: unknown}>;
	/** 按 marketHashName 批量查在售最低价、在售数、求购最高价。返回 {名称: 统计} */
	itemStats(appId: number, names: readonly string[]): Promise<Record<string, C5ItemStat>>;
	/** 查某个饰品 priceMax 以内的在售。内测接口,要在官网把服务器公网 IP 加进白名单 */
	searchProducts(options: C5SearchOptions): Promise<Json[]>;
	/** 按在售 id 批量购买 */
	batchBuy(tradeUrl: string, products: readonly C5BuyProduct[]): Promise<{successList?: Json[]; failedList?: Json[]; [key: string]: unknown}>;
	/** 由平台挑一件不高于 maxPrice 的最低价在售买入 */
	quickBuy(options: C5QuickBuyOptions): Promise<{orderId?: unknown; actualPay?: unknown; payStatus?: unknown; [key: string]: unknown}>;
	/** 按商户单号查订单,查不到返回 null */
	orderDetail(outTradeNo: string): Promise<Json | null>;
}

export interface C5ClientOptions {
	appKey: string;
	timeoutMs?: number;
	baseUrl?: string;
	fetch?: typeof fetch;
}

// ===== 64 位整数 =====
// Node 24 的 JSON.parse 会把原文交给 reviver,JSON.rawJSON 能原样写出数字;es2024 的类型声明里还没有这两个

type Reviver = (key: string, value: unknown, context?: {source?: string}) => unknown;
const parseJson = JSON.parse as (text: string, reviver: Reviver) => unknown;
const rawJson = (JSON as unknown as {rawJSON(text: string): unknown}).rawJSON;

/** 解析 JSON,超出安全范围的整数保留原文(字符串) */
export function parseJsonKeepingBigInts(text: string): unknown {
	return parseJson(text, (key, value, context) => {
		if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) {
			return context.source;
		}
		return value;
	});
}

/** 纯数字的 id 按数字写进请求体(不经过 JS 数字,不丢精度);其它原样 */
function integerId(id: string): unknown {
	return /^\d+$/.test(id) ? rawJson(id) : id;
}

// ===== 请求 =====

// 没连上服务器(请求肯定没发出去)的底层错误码;其余网络错误都按结果未知处理
const NOT_SENT_CODES = new Set([
	'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
	'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

function networkError(where: string, err: unknown): C5Error {
	const error = err as {name?: string; code?: string; cause?: {code?: string; name?: string}} | null;
	const code = String(error?.cause?.code || error?.code || '');
	if (NOT_SENT_CODES.has(code)) {
		return new C5Error(`${where} 连不上服务器: ${code}`);
	}
	if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
		return new C5NetworkError(`${where} 超时`);
	}
	return new C5NetworkError(`${where} 网络错误: ${code || error?.cause?.name || error?.name || 'unknown'}`);
}

export function createC5Client(options: C5ClientOptions): C5Api {
	const appKey = String(options.appKey || '');
	const base = String(options.baseUrl || C5_BASE_URL).replace(/\/+$/, '');
	const timeoutMs = options.timeoutMs ?? 10_000;
	const http = options.fetch ?? ((input, init) => fetch(input, init));

	async function request(method: 'GET' | 'POST', path: string, {params, body}: {params?: Record<string, string>; body?: object} = {}): Promise<Json> {
		const where = `${method} ${path}`;
		const url = new URL(base + path);
		for (const [key, value] of Object.entries(params ?? {})) {
			url.searchParams.set(key, value);
		}
		url.searchParams.set('app-key', appKey);
		const headers: Record<string, string> = {'Accept-Encoding': ACCEPT_ENCODING, Accept: 'application/json'};
		if (body) {
			headers['Content-Type'] = 'application/json';
		}

		let status: number;
		let text: string;
		try {
			const response = await http(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(timeoutMs)
			});
			status = response.status;
			text = await response.text();
		} catch (err) {
			throw networkError(where, err);
		}

		let payload: Json = null;
		try {
			payload = parseJsonKeepingBigInts(text);
		} catch {
			// 不是 JSON,下面按无法识别处理
		}
		if (!payload || typeof payload !== 'object' || !('success' in payload)) {
			const message = `${where} HTTP ${status},返回内容无法识别`;
			throw status >= 400 && status < 500 ? new C5Error(message, {code: status}) : new C5NetworkError(message, {code: status});
		}
		if (!payload.success) {
			const message = `${where} 失败: [${payload.errorCode ?? ''}] ${payload.errorMsg ?? ''}`;
			const codes = {
				code: typeof payload.errorCode === 'number' ? payload.errorCode : Number(payload.errorCode) || null,
				codeStr: payload.errorCodeStr == null ? null : String(payload.errorCodeStr)
			};
			// 5xx 带 JSON(如「系统异常」)也可能是处理到一半出的错,下单可能已经生效,按结果未知
			throw status >= 500 ? new C5NetworkError(message, codes) : new C5Error(message, codes);
		}
		return payload.data;
	}

	return {
		async balance() {
			return (await request('GET', '/merchant/account/v2/balance')) || {};
		},
		async steamInfo() {
			return (await request('GET', '/merchant/account/v1/steamInfo')) || {};
		},
		async itemStats(appId, names) {
			const out: Record<string, C5ItemStat> = {};
			for (let i = 0; i < names.length; i += 100) {   // 单次最多 100 个
				const data = await request('POST', '/merchant/market/v2/item/stat/hash/name', {
					body: {appId, marketHashNames: names.slice(i, i + 100)}
				});
				Object.assign(out, data || {});
			}
			return out;
		},
		async searchProducts({appId, name, priceMax, delivery = 0, assetType = 1, pageSize = 50}) {
			const body: Record<string, unknown> = {appId, marketHashName: name, priceMax, assetType, pageSize};
			if (delivery) {
				body.delivery = delivery;
			}
			const data = await request('POST', '/merchant/market/v2/products/search', {body});
			return Array.isArray(data?.list) ? data.list : [];
		},
		async batchBuy(tradeUrl, products) {
			const productList = products.map(product => ({
				productId: integerId(product.productId),
				buyPrice: product.buyPrice,
				outTradeNo: product.outTradeNo
			}));
			return (await request('POST', '/merchant/trade/v1/batch/buy', {body: {tradeUrl, productList}})) || {};
		},
		async quickBuy({outTradeNo, tradeUrl, appId, name, maxPrice, delivery = 0}) {
			const body: Record<string, unknown> = {outTradeNo, tradeUrl, appId, marketHashName: name, maxPrice, lowPrice: 1};
			if (delivery) {
				body.delivery = delivery;
			}
			return (await request('POST', '/merchant/trade/v2/quick-buy', {body})) || {};
		},
		async orderDetail(outTradeNo) {
			try {
				return (await request('GET', '/merchant/order/v2/buy/detail', {params: {outTradeNo}})) || null;
			} catch (err) {
				if (err instanceof C5NetworkError || !(err instanceof C5Error)) {
					throw err;
				}
				// 「订单不存在」的错误码文档没写,按文案猜;猜不中原样抛出,调用方按「未知」保守处理
				const text = `${err.message} ${err.codeStr || ''}`.toLowerCase();
				if (['不存在', 'not_exist', 'not_found', 'not exist'].some(word => text.includes(word))) {
					return null;
				}
				throw err;
			}
		}
	};
}
