// ECOSteam(ECO)开放平台客户端。接口文档:https://s.apifox.cn/8dd30eef-e628-4390-b503-846412c608ee
//
// - 所有接口都是 POST + JSON,body 里带公共参数 PartnerId、Timestamp(秒)、Sign。
// - 签名(SHA256withRSA,结果 base64):除 Sign 外的第一层参数按名字不区分大小写排序(同名小写在前),
//   拼成 key=value&key=value;数组 / 对象的值写成不带空格的 JSON。空值不传、也不参与签名。
//   请求里不放布尔值:各语言把 true 拼成 "true" 还是 "True" 不一致,容易验签失败。
// - 错误分两种:EcoError = 平台明确拒绝 / 根本没连上,请求肯定没生效;
//   EcoNetworkError = 超时、断连、5xx、ResultCode -1(系统异常),下单的话结果未知。

import {createPrivateKey, createPublicKey, generateKeyPairSync, sign as rsaSign} from 'node:crypto';
import type {KeyObject} from 'node:crypto';

export const ECO_BASE_URL = 'https://openapi.ecosteam.cn';

/** ResultCode:7005 商品不可购买 / 7006 余额不足 / 7008 商户单号重复 / 7009 价格变了 / 6001 请求太快 */
export const ECO_CODE = {
	ok: 0,
	systemError: -1,
	failed: 1,
	tooFast: 6001,
	notBuyable: 7005,
	noBalance: 7006,
	duplicateMerchantNo: 7008,
	priceChanged: 7009
} as const;

export class EcoError extends Error {
	override name = 'EcoError';
	readonly code: number | null;
	/** 平台返回的 ResultData(7009 时有 NewPrice、7008 时有 OrderIdList) */
	readonly data: unknown;

	constructor(message: string, options: {code?: number | null; data?: unknown} = {}) {
		super(message);
		this.code = options.code ?? null;
		this.data = options.data ?? null;
	}
}

/** 超时、断连、5xx、系统异常:请求可能已经生效,结果未知 */
export class EcoNetworkError extends EcoError {
	override name = 'EcoNetworkError';
}

// 平台返回的原始 JSON 字段很多,只在这一层用宽松类型
type Json = any;

export interface EcoBalance {
	UserName?: string;
	/** 钱包金额 */
	Money?: number;
	LockMoney?: number;
	WaitSettlementMoney?: number;
	[key: string]: unknown;
}

export interface EcoSteamAccount {
	SteamId?: string;
	NickName?: string;
	TradeLink?: string;
	TradeLinkIsEnable?: boolean;
	/** 0 无 / 1 正常 / 2 异常 / 3 暂挂 */
	AccountStatus?: number;
	IsDefaultSteam?: boolean;
	Remark?: string;
	[key: string]: unknown;
}

/** 批量查在售价格的一行(数字都是字符串) */
export interface EcoItemStat {
	GoodsName?: string | null;
	/** 在售最低价 */
	MinPrice?: string | number | null;
	SellCount?: string | number | null;
	/** 求购最高价 */
	QGMaxPrice?: string | number | null;
	[key: string]: unknown;
}

export interface EcoBuyResult {
	OrderNo?: string | null;
	MerchantNo?: string | null;
	/** 支付金额(余额 + 待结算金额) */
	PaymentPrice?: number | null;
	/** 7009 时当前可买的最低价 */
	NewPrice?: number | null;
	/** 同一个商户单号重复下单时,已存在的订单号 */
	OrderIdList?: string[] | null;
	[key: string]: unknown;
}

export interface EcoOrderStatus {
	OrderNum?: string | null;
	MerchantNo?: string | null;
	OrderAmount?: number | null;
	OrderState?: string | null;
	/** 待付款 7 / 等待发货 1 / 发货中 8 / 等待对方确认 2 / 交易取消 3 / 交易成功 6 / 交易暂挂 9 / 交易保护 30 */
	OrderStateCode?: number | null;
	Reason?: string | null;
	[key: string]: unknown;
}

export interface EcoApi {
	balance(): Promise<EcoBalance>;
	/** ECO 上绑定的 Steam 账号(带交易链接) */
	steamAccounts(): Promise<EcoSteamAccount[]>;
	/** 按 HashName 批量查在售最低价、在售数、求购最高价。返回 {HashName: 统计} */
	itemStats(gameId: number, names: readonly string[]): Promise<Record<string, EcoItemStat>>;
	/** 某个饰品的在售商品(第一页,最多 100 条) */
	sellGoods(options: {gameId: number; name: string; pageSize?: number}): Promise<Json[]>;
	/** 按商品编号买一件;price 要和当前售价一致,变了平台回 7009 */
	buyByGoodsNum(options: {goodsNum: string; price: number; tradeLink: string; merchantNo: string; gameId: number}): Promise<EcoBuyResult>;
	/** 平台挑一件不高于 price 的在售买入 */
	buyByHashName(options: {gameId: number; name: string; price: number; tradeLink: string; merchantNo: string}): Promise<EcoBuyResult[]>;
	/** 按商户单号批量查订单状态(单次最多 100 个);查不到的不在返回里 */
	orderStatus(merchantNos: readonly string[]): Promise<EcoOrderStatus[]>;
	/** 导入令牌(maFile JSON)+ Steam 账号密码,把账号绑到 ECO;groupName 非空时放进这个分组(没有就新建) */
	importGuardAccount(options: {guardContent: string; account: string; password: string; groupName?: string}): Promise<boolean>;
	/** 验证交易链接是否有效 */
	checkTradeLink(tradeLink: string): Promise<boolean>;
	/** 用账号的 refreshToken 让 ECO 重新绑定 / 更新这个 Steam 账号,返回 ECO 从 Steam 取到的最新交易链接 */
	updateSteam(options: {steamId: string; refreshToken: string; accessToken?: string}): Promise<{SteamId?: string | null; TradeLink?: string | null; InventoryPublic?: boolean}>;
}

/** 令牌 JSON 最长 10240 个字符(文档限制) */
export const GUARD_CONTENT_MAX = 10240;

export interface EcoClientOptions {
	partnerId: string;
	privateKey: string;
	timeoutMs?: number;
	baseUrl?: string;
	fetch?: typeof fetch;
	/** 秒级时间戳;测试用 */
	now?: () => number;
}

// ===== 密钥 =====

/** 私钥:PEM(带头尾)或去掉头尾和换行的 base64(PKCS#8 或 PKCS#1)都认。不是 RSA 私钥抛错 */
export function parsePrivateKey(text: string): KeyObject {
	const raw = String(text || '').trim();
	if (!raw) {
		throw new Error('私钥是空的');
	}
	let key: KeyObject | null = null;
	if (raw.includes('-----BEGIN')) {
		try {
			key = createPrivateKey(raw);
		} catch {
			key = null;
		}
	} else {
		const der = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
		for (const type of ['pkcs8', 'pkcs1'] as const) {
			try {
				key = createPrivateKey({key: der, format: 'der', type});
				break;
			} catch {
				// 换下一种格式
			}
		}
	}
	if (!key) {
		throw new Error('私钥格式不对:要 RSA 私钥(PEM,或去掉头尾和换行的 base64)');
	}
	if (key.asymmetricKeyType !== 'rsa') {
		throw new Error(`私钥要是 RSA 的,收到的是 ${key.asymmetricKeyType}`);
	}
	return key;
}

/** 私钥对应的公钥,去掉头尾和换行(ECO 开放平台要填这个格式) */
export function publicKeyOf(privateKey: KeyObject): string {
	return createPublicKey(privateKey).export({type: 'spki', format: 'der'}).toString('base64');
}

/** 新生成一对 2048 位 RSA 密钥,都是去掉头尾和换行的 base64(私钥 PKCS#8) */
export function generateEcoKeyPair(): {privateKey: string; publicKey: string} {
	const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
	return {
		privateKey: privateKey.export({type: 'pkcs8', format: 'der'}).toString('base64'),
		publicKey: publicKey.export({type: 'spki', format: 'der'}).toString('base64')
	};
}

// ===== 签名 =====

/** 参数名排序:不区分大小写,相同时小写在前 */
function compareKeys(a: string, b: string): number {
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	if (la !== lb) {
		return la < lb ? -1 : 1;
	}
	return a === b ? 0 : a > b ? -1 : 1;   // 'a' > 'A',小写排前
}

/** 待签名字符串:除 Sign 外的第一层参数,空值跳过 */
export function signingString(params: Record<string, unknown>): string {
	return Object.keys(params)
		.filter(key => key !== 'Sign' && params[key] != null && params[key] !== '')
		.sort(compareKeys)
		.map(key => {
			const value = params[key];
			return `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
		})
		.join('&');
}

export function signParams(params: Record<string, unknown>, privateKey: KeyObject): string {
	return rsaSign('sha256', Buffer.from(signingString(params), 'utf8'), privateKey).toString('base64');
}

// ===== 请求 =====

// 没连上服务器(请求肯定没发出去)的底层错误码;其余网络错误都按结果未知处理
const NOT_SENT_CODES = new Set([
	'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
	'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

function networkError(where: string, err: unknown): EcoError {
	const error = err as {name?: string; code?: string; cause?: {code?: string; name?: string}} | null;
	const code = String(error?.cause?.code || error?.code || '');
	if (NOT_SENT_CODES.has(code)) {
		return new EcoError(`${where} 连不上服务器: ${code}`);
	}
	if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
		return new EcoNetworkError(`${where} 超时`);
	}
	return new EcoNetworkError(`${where} 网络错误: ${code || error?.cause?.name || error?.name || 'unknown'}`);
}

/** 金额统一保留两位小数,避免 0.1 + 0.2 这类浮点尾巴进签名 */
function money(value: number): number {
	return Math.round(value * 100) / 100;
}

export function createEcoClient(options: EcoClientOptions): EcoApi {
	const partnerId = String(options.partnerId || '').trim();
	const key = parsePrivateKey(options.privateKey);
	const base = String(options.baseUrl || ECO_BASE_URL).replace(/\/+$/, '');
	const timeoutMs = options.timeoutMs ?? 10_000;
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const nowSec = options.now ?? (() => Math.floor(Date.now() / 1000));

	async function request(path: string, body: Record<string, unknown> = {}): Promise<Json> {
		const where = path.replace(/^\/Api\//, '');
		const params: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(body)) {
			if (value != null && value !== '') {
				params[name] = value;
			}
		}
		params.PartnerId = partnerId;
		params.Timestamp = String(nowSec());
		params.Sign = signParams(params, key);

		let status: number;
		let text: string;
		try {
			const response = await http(base + path, {
				method: 'POST',
				headers: {'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json'},
				body: JSON.stringify(params),
				signal: AbortSignal.timeout(timeoutMs)
			});
			status = response.status;
			text = await response.text();
		} catch (err) {
			throw networkError(where, err);
		}

		let payload: Json = null;
		try {
			payload = JSON.parse(text);
		} catch {
			// 不是 JSON,下面按无法识别处理
		}
		if (!payload || typeof payload !== 'object' || !('ResultCode' in payload)) {
			const message = `${where} HTTP ${status},返回内容无法识别`;
			throw status >= 400 && status < 500 ? new EcoError(message, {code: status}) : new EcoNetworkError(message, {code: status});
		}
		const code = Number(payload.ResultCode);
		if (code !== ECO_CODE.ok) {
			const message = `${where} 失败: [${payload.ResultCode}] ${payload.ResultMsg ?? ''}`.trim();
			const detail = {code: Number.isFinite(code) ? code : null, data: payload.ResultData ?? null};
			// 5xx 或「系统异常」可能是处理到一半出的错,下单的话可能已经生效,按结果未知
			throw status >= 500 || code === ECO_CODE.systemError ? new EcoNetworkError(message, detail) : new EcoError(message, detail);
		}
		return payload.ResultData;
	}

	return {
		async balance() {
			return (await request('/Api/Merchant/GetTotalMoney')) || {};
		},
		async steamAccounts() {
			const out: EcoSteamAccount[] = [];
			for (let page = 1; page <= 10; page++) {
				const data = await request('/Api/Merchant/QuerySteamAccountPageList', {PageIndex: page, PageSize: 100});
				const rows: EcoSteamAccount[] = Array.isArray(data?.PageResult) ? data.PageResult : [];
				out.push(...rows);
				if (rows.length < 100 || out.length >= Number(data?.TotalRecord ?? 0)) {
					break;
				}
			}
			return out;
		},
		async itemStats(gameId, names) {
			const out: Record<string, EcoItemStat> = {};
			for (let i = 0; i < names.length; i += 100) {   // 单次最多 100 个
				const data = await request('/Api/Market/BatchSearchSellingPrice', {GameID: String(gameId), HashName: names.slice(i, i + 100)});
				for (const row of Array.isArray(data) ? data : []) {
					if (row?.HashName) {
						out[String(row.HashName)] = row;
					}
				}
			}
			return out;
		},
		async sellGoods({gameId, name, pageSize = 100}) {
			const data = await request('/Api/Market/SellGoodsList', {
				GameId: String(gameId), HashName: name, PageIndex: 1, PageSize: pageSize, GoodRange: 1
			});
			return Array.isArray(data?.PageResult) ? data.PageResult : [];
		},
		async buyByGoodsNum({goodsNum, price, tradeLink, merchantNo, gameId}) {
			return (await request('/Api/open/buy/BuyByGoodsNum', {
				GoodsNum: goodsNum, Price: money(price), TradeLink: tradeLink, MerchantNo: merchantNo, GameId: String(gameId)
			})) || {};
		},
		async buyByHashName({gameId, name, price, tradeLink, merchantNo}) {
			const data = await request('/Api/open/buy/BuyByHashName', {
				GameId: String(gameId), HashName: name, Price: money(price), TradeLink: tradeLink, MaxCount: 1, MerchantNo: merchantNo
			});
			return Array.isArray(data) ? data : data ? [data] : [];
		},
		async orderStatus(merchantNos) {
			const out: EcoOrderStatus[] = [];
			for (let i = 0; i < merchantNos.length; i += 100) {
				const data = await request('/Api/open/order/OrderStatusQuery', {MerchantNos: merchantNos.slice(i, i + 100)});
				out.push(...(Array.isArray(data) ? data : []));
			}
			return out;
		},
		async importGuardAccount({guardContent, account, password, groupName}) {
			const data = await request('/Api/Merchant/ImportSteamGuardAccount', {
				GuardContent: guardContent, Account: account, Password: password, GroupName: groupName || undefined
			});
			return data !== false;
		},
		async checkTradeLink(tradeLink) {
			return (await request('/Api/Merchant/CheckTradeLink', {TradeLink: tradeLink})) === true;
		},
		async updateSteam({steamId, refreshToken, accessToken}) {
			return (await request('/Api/Merchant/UserSteamHandle', {SteamID: steamId, RefreshToken: refreshToken, AccessToken: accessToken || undefined})) || {};
		}
	};
}
