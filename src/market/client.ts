// Steam 社区市场「求购单」的 HTTP 调用(从 app/services/steamMarketBuyOrder.js 移来)。
// 用登录账号的 WebSession cookie 重放网页上「求购」对话框发的请求,买家出价等卖家成交。
//
// 用到的 Steam 端点(2026-06,与网页 market JS 一致):
//   1. 商品页(取 item_nameid / 物品名)  GET  steamcommunity.com/market/listings/<appid>/<market_hash_name>
//   2. 求购/在售盘口(行情参考)          GET  steamcommunity.com/market/itemordershistogram?...&item_nameid=..
//   3. 概览价(成交均价/在售最低/销量)    GET  steamcommunity.com/market/priceoverview/?...&market_hash_name=..
//   4. 挂求购单                          POST steamcommunity.com/market/createbuyorder/
//   5. 撤求购单                          POST steamcommunity.com/market/cancelbuyorder/
//   6. 我的求购单                        GET  steamcommunity.com/market/mylistings/?norender=1
//   7. 新版分组页(取分组名)            GET  steamcommunity.com/market/listings/<appid>/<分组 id>
//
// 2026 新版市场:/market/listings/<appid>/<英文名> 会 302 到 /market/listings/<appid>/G1807209A023004 这种分组地址,
// 一组是同一皮肤的全部磨损 / StatTrak / 纪念品,从地址栏复制的分组链接定位不到具体哪一件,所以页面改成按名字搜
// (搜随包的中英文名词库,见 ./index.ts;Steam 的 market/search/render 对机房 / 代理 IP 一律 429,用不了)。
//
// 要点:
//   - createbuyorder 是表单 POST,字段 sessionid / currency(钱包数字货币枚举) / appid / market_hash_name /
//     price_total / quantity。price_total 是总价的最小货币单位(分)= 每件分价 × 数量;currency 必须等于账号钱包币种。
//   - 必须带 Referer = 该商品的上架页,否则 Steam 会拒。
//   - sessionid 既在 Cookie 里、又要作为表单字段一起带(CSRF)。
//   - User-Agent 必须是够新的 Chrome:Steam 对「非浏览器 HTTP 栈 + 老 Chrome UA」的市场请求回 429(2026-10 实测
//     priceoverview 老 UA 每次都 429、Chrome/150 就是 200;用户挂单 429 也是它),和换不换代理无关。
//     调用方传会话的 UA(登录时从新版 UA 池里挑的,见 src/steam/user-agent.ts),没传用 STEAM_WEB_USER_AGENT。
//   - item_nameid 没有独立 API。Steam 2025/2026 把商品页改成了 React SSR,HTML 里多半已经没有
//     Market_LoadOrderSpread( <id> ),所以 nameid 主要靠调用方传(本地缓存 / 社区 nameid 库,见 ./nameids.ts)。
//     行情只是参考,抓不到不影响挂单。

import {STEAM_WEB_USER_AGENT} from '../steam/user-agent.ts';

const COMMUNITY = 'https://steamcommunity.com';

export type MarketLog = (level: 'info' | 'warn', message: string) => void;

export interface MarketTarget {
	appid: number;
	marketHashName: string;
}

export interface MarketContext extends MarketTarget {
	currency: number;
	itemNameId: string;
	itemName: string;
	/** 最高求购价 / 最低在售价(钱包币种的分);拿不到为 null */
	highestBuyOrderCents: number | null;
	lowestSellOrderCents: number | null;
	/** priceoverview 返回的带币种符号的文本 */
	lowestPrice: string;
	medianPrice: string;
	volume: string;
	currencyISO?: string;
	/** 没拿到的部分和原因(如「盘口:Steam 限流(HTTP 429)…」),页面上照着显示;都拿到了是空数组 */
	issues: string[];
}

export interface WebSessionParams {
	cookies?: readonly string[];
	/** cookies 里没有 sessionid 时用这个(登录拿到的 webSessionID) */
	sessionid?: string;
	userAgent?: string;
}

export interface ContextParams extends MarketTarget {
	cookies?: readonly string[];
	userAgent?: string;
	currency?: number | null;
	country?: string;
	language?: string;
	/** 已知的 item_nameid(本地缓存或社区库);没有才回退到抓商品页 */
	itemNameId?: string;
}

export interface CreateBuyOrderParams extends WebSessionParams, MarketTarget {
	currency: number | null | undefined;
	priceTotalCents: number;
	quantity: number;
	/** 手机确认后重发时带上 createbuyorder 第一次返回的 confirmation_id */
	confirmation?: string;
}

export interface CreateBuyOrderResult {
	success: true;
	buyOrderId: string;
	confirmationId: string;
	needsConfirmation: boolean;
}

export interface LiveBuyOrder {
	buyOrderId: string;
	/** 每件价格(分) */
	priceCents: number;
	quantity: number;
	quantityRemaining: number | null;
	appid: number;
	marketHashName: string;
}

/** createbuyorder 返回的 success 非 1 时的常见含义(EResult 子集 + Steam 自定义码) */
const BUY_ORDER_ERROR: Readonly<Record<number, string>> = {
	2: '操作失败(Steam 通用错误,稍后重试)',
	8: '参数无效(物品名或价格不正确)',
	15: '没有访问权限(cookie 可能已失效,请重新登录该账号)',
	16: '操作超时,请重试',
	20: 'Steam 市场服务暂时不可用,请稍后重试',
	21: '该账号登录态已失效,请重新登录后再挂求购',
	// 22 = Pending:求购单已建但要手机令牌确认。挂单时单独处理(自动确认),这里只是其它路径的兜底文案
	22: '操作待 Steam 手机令牌确认(Pending),请在 Steam 手机 App 确认',
	24: '钱包余额/参数不足以挂此求购',
	25: '已达求购单数量上限(请先撤掉部分旧求购)',
	26: '物品不存在或不可在市场交易',
	29: '重复的求购请求(可能上一单仍在处理),请稍后再试',
	78: '该求购已存在或与现有求购冲突'
};

const NO_JSON_ERROR = 'Steam 未返回有效响应,cookie 可能已失效,请重新登录该账号';

/** HTML 页面的标题;不是 HTML 或没有标题为 null */
function pageTitle(text: string): string | null {
	const match = /<title[^>]*>([^<]*)<\/title>/i.exec(text);
	return match ? decodeEntities(match[1] ?? '').replace(/\s+/g, ' ').trim() : null;
}

/** 响应摘要(日志和报错用):状态码、被跳转到哪、HTML 只取标题,其它取开头一段 */
function responseSummary(res: Response, text: string, max = 200): string {
	const parts = [`HTTP ${res.status}`];
	if (res.redirected && res.url) {
		parts.push(`跳转到 ${res.url}`);
	}
	const title = pageTitle(text);
	const body = title != null ? `页面「${title}」` : truncate(text.replace(/\s+/g, ' ').trim(), max);
	if (body) {
		parts.push(body);
	}
	return parts.join(' ');
}

/**
 * Steam 没回 JSON 时说清楚是哪种情况:429 是出口 IP 被限流(账号走机房代理时 Steam 常对市场请求这样);
 * 被带到登录页才是 cookie 失效;别的带上状态码、跳转地址和页面标题,免得一律说成 cookie 失效
 */
function noJsonError(res: Response, text: string): Error {
	if (res.status === 429) {
		return new Error('Steam 拒绝了这个出口 IP 的市场请求(HTTP 429 限流)。账号走代理时多半是代理 IP 被限制,换个代理或让这个账号不走代理再试');
	}
	const title = pageTitle(text);
	const toLogin = res.redirected && /\/login/i.test(res.url);
	// 没有标题的短页面(老代码见过的「login」一类)也按登录页算;完整的 Steam 页面导航里都有「登录」,不能按正文判断
	const loginPage = title != null ? /sign in|login|登录/i.test(title) : text.length < 500 && /sign in|login|登录/i.test(text);
	if (res.ok && (toLogin || loginPage)) {
		return new Error(NO_JSON_ERROR);
	}
	return new Error(`Steam 返回的不是 JSON(${responseSummary(res, text, 120)})`);
}

export function describeBuyOrderError(code: unknown, message?: unknown, rawText?: string, action = '挂求购单失败'): string {
	if (message) {
		return `${message}(success=${code})`;
	}
	const text = BUY_ORDER_ERROR[Number(code)];
	if (text) {
		return text;
	}
	// 未知码:带上 Steam 原始返回的片段,便于排查
	const extra = rawText ? `:${truncate(rawText, 160)}` : '';
	return `${action}(success=${code})${extra}`;
}

function truncate(value: unknown, max = 400): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	if (!text) {
		return '';
	}
	return text.length > max ? text.slice(0, max) + '…' : text;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function extractSessionId(cookies: readonly string[]): string {
	for (const raw of cookies) {
		const match = /^sessionid=([^;]+)/.exec(String(raw).trim());
		if (match?.[1]) {
			return decodeURIComponent(match[1]);
		}
	}
	return '';
}

function buildCookieHeader(cookies: readonly string[] | undefined, sessionidFallback?: string): {cookieHeader: string; sessionid: string} {
	const list = (Array.isArray(cookies) ? cookies : []).filter(Boolean);
	let sessionid = extractSessionId(list);
	if (!sessionid && sessionidFallback) {
		sessionid = String(sessionidFallback).trim();
		if (sessionid) {
			list.push('sessionid=' + sessionid);
		}
	}
	return {cookieHeader: list.join('; '), sessionid};
}

function finiteOrNull(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

async function readJson(response: Response): Promise<{text: string; json: any}> {
	const text = await response.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	return {text, json};
}

/** 新版市场的分组 id(G 开头的十六进制,如 G1807209A023004) */
export function isGroupId(value: string): boolean {
	return /^G[0-9A-F]{8,}$/i.test(value);
}

/** 链接里的 appid 和最后一段(URL 解码一次;可能是物品英文名,也可能是分组 id);不是商品链接返回 null */
export function matchListingUrl(input: string): {appid: number; segment: string} | null {
	const match = /\/market\/listings\/(\d+)\/([^/?#]+)/i.exec(input);
	if (!match) {
		return null;
	}
	let segment = match[2] ?? '';
	try {
		segment = decodeURIComponent(segment);
	} catch {
		// 已经是解码态(含 % 等字符)时解码会抛错,保留原值
	}
	return {appid: Number(match[1]), segment};
}

/**
 * 解析市场商品链接 → {appid, marketHashName}。
 * 接受完整 URL(https://steamcommunity.com/market/listings/730/AK-47...)或只有路径;物品名会 URL 解码一次。
 * 新版市场的分组链接定位不到具体物品,报错让人按名字搜。
 */
export function parseListingUrl(input: unknown): MarketTarget {
	const raw = String(input || '').trim();
	if (!raw) {
		throw new Error('请填写市场商品链接');
	}
	const match = matchListingUrl(raw);
	if (!match) {
		throw new Error('链接格式不对,应形如 https://steamcommunity.com/market/listings/730/物品名');
	}
	const {appid, segment: marketHashName} = match;
	if (!Number.isInteger(appid) || appid <= 0 || !marketHashName) {
		throw new Error('链接中缺少有效的 appid 或物品名');
	}
	if (isGroupId(marketHashName)) {
		throw new Error('这是新版市场的分组链接(同一皮肤的各磨损都在一组),定位不到具体物品,请按名字搜索后选择');
	}
	return {appid, marketHashName};
}

const ENTITIES: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
		if (code[0] === '#') {
			const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
			return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all;
		}
		return ENTITIES[code.toLowerCase()] ?? all;
	});
}

/** 读响应体直到出现 marker 或读满 maxBytes 就断开(新版商品页好几 MB,只要开头的 <title>) */
async function readUntil(response: Response, marker: string, maxBytes: number): Promise<string> {
	if (!response.body) {
		return response.text();
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let bytes = 0;
	try {
		while (!text.includes(marker) && bytes < maxBytes) {
			const {done, value} = await reader.read();
			if (done) {
				break;
			}
			bytes += value.byteLength;
			text += decoder.decode(value, {stream: true});
		}
	} finally {
		reader.cancel().catch(() => {});
	}
	return text;
}

export function listingUrl(appid: number, marketHashName: string): string {
	return `${COMMUNITY}/market/listings/${appid}/${encodeURIComponent(marketHashName)}`;
}

export interface MarketClientOptions {
	fetch?: typeof fetch;
	log?: MarketLog;
	sleep?: (ms: number) => Promise<void>;
}

/** 行情接口回 429 时等多久再试一次 */
const CONTEXT_RETRY_MS = 2000;

export function createMarketClient(options: MarketClientOptions = {}) {
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const log: MarketLog = options.log ?? (() => {});
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

	/** 行情参考(尽力而为):商品页名称/nameid → 盘口 → 概览价。任何一步失败都不抛,返回已拿到的部分,没拿到的原因在 issues 里 */
	async function fetchMarketContext(params: ContextParams): Promise<MarketContext> {
		const {appid, marketHashName} = params;
		const cookies = (params.cookies ?? []).filter(Boolean);
		const userAgent = params.userAgent || STEAM_WEB_USER_AGENT;
		const currency = Number(params.currency || 0);
		const country = String(params.country || 'US').trim().toUpperCase() || 'US';
		const language = params.language || 'english';
		const pageUrl = listingUrl(appid, marketHashName);
		const baseHeaders: Record<string, string> = {'User-Agent': userAgent};
		if (cookies.length) {
			baseHeaders.Cookie = cookies.join('; ');
		}

		const result: MarketContext = {
			appid,
			marketHashName,
			currency,
			itemNameId: String(params.itemNameId || '').replace(/\D/g, ''),
			itemName: '',
			highestBuyOrderCents: null,
			lowestSellOrderCents: null,
			lowestPrice: '',
			medianPrice: '',
			volume: '',
			issues: []
		};

		/** 查一个行情接口,回 Steam 的 JSON(accept 为真的);拿不到就记一条原因(日志和页面都看得到)、返回 null。429 等一会再试一次 */
		async function contextJson(label: string, url: URL, headers: Record<string, string>, accept: (json: any) => boolean): Promise<any> {
			for (let attempt = 0; ; attempt++) {
				let issue: string;
				try {
					const res = await http(url, {headers});
					const {text, json} = await readJson(res);
					if (res.ok && json && accept(json)) {
						return json;
					}
					if (res.status === 429 && attempt === 0) {
						await sleep(CONTEXT_RETRY_MS);
						continue;
					}
					issue = res.status === 429 ? 'Steam 限流(HTTP 429),过一会再查'
						: !res.ok || !json ? responseSummary(res, text, 120)
						: `Steam 返回 success=${json.success}`;
				} catch (err) {
					issue = errorText(err);
				}
				result.issues.push(`${label}:${issue}`);
				log('warn', `[market-buyorder] 行情 ${marketHashName} 的${label}没拿到:${issue}`);
				return null;
			}
		}

		// 1) 调用方没给 nameid 时抓商品页试老正则(还没改版的游戏能抓到),顺便取展示名。
		//    有 nameid 就不抓:新版页面会 302 到好几 MB 的分组页,里面既没有 nameid 也不是这一件的名字
		if (!result.itemNameId) {
			try {
				const page = await http(pageUrl, {headers: {...baseHeaders, Accept: 'text/html'}});
				const html = await page.text();
				const idMatch = /Market_LoadOrderSpread\(\s*(\d+)\s*\)/.exec(html);
				if (idMatch?.[1]) {
					result.itemNameId = idMatch[1];
				}
				const nameMatch = /id="largeiteminfo_item_name"[^>]*>([^<]+)</.exec(html)
					|| /<title>[^<]*?(?:Listings for|的)\s*(.+?)<\/title>/.exec(html);
				if (nameMatch?.[1]) {
					result.itemName = decodeEntities(nameMatch[1].trim());
				}
			} catch (err) {
				log('warn', `[market-buyorder] 商品页抓取失败: ${errorText(err)}`);
			}
		}

		// 2) 盘口:最高求购 / 最低在售(要 item_nameid)
		if (result.itemNameId) {
			const url = new URL(COMMUNITY + '/market/itemordershistogram');
			url.searchParams.set('country', country);
			url.searchParams.set('language', language);
			url.searchParams.set('currency', String(currency));
			url.searchParams.set('item_nameid', result.itemNameId);
			url.searchParams.set('two_factor', '0');
			const json = await contextJson('盘口', url, {...baseHeaders, Accept: 'application/json', Referer: pageUrl}, body => Number(body.success) === 1);
			if (json) {
				// 没有求购/在售时 Steam 给 null,这里得到 0(和旧版一致):前端把 null 当成「缺 nameid」,
				// 而最高求购 0 时它会建议出价 0.01,正合适
				result.highestBuyOrderCents = finiteOrNull(json.highest_buy_order);
				result.lowestSellOrderCents = finiteOrNull(json.lowest_sell_order);
			}
		} else {
			result.issues.push('盘口:找不到这件的 item_nameid,查不了最高求购和最低在售');
		}

		// 3) 概览价:成交均价 / 在售最低 / 近 24h 销量
		const url = new URL(COMMUNITY + '/market/priceoverview/');
		url.searchParams.set('country', country);
		url.searchParams.set('currency', String(currency));
		url.searchParams.set('appid', String(appid));
		url.searchParams.set('market_hash_name', marketHashName);
		const json = await contextJson('概览价', url, {...baseHeaders, Accept: 'application/json', Referer: pageUrl}, body => !!body.success);
		if (json) {
			result.lowestPrice = String(json.lowest_price || '');
			result.medianPrice = String(json.median_price || '');
			result.volume = String(json.volume || '');
		}

		return result;
	}

	/**
	 * 挂一张求购单。要手机确认时的完整流程(对照 aiosteampy place_buy_order):
	 *   1) 首次提交(不带 confirmation)→ Steam 回 success=22 + confirmation.confirmation_id,订单还没真正建立;
	 *   2) 用手机令牌 allow 这个确认项(../steam/confirmations.ts);
	 *   3) 带 confirmation=<confirmation_id> 再提交一次,Steam 才返回 buy_orderid,订单这时才落地。
	 *   只 allow 不重发第 3 步,订单会被丢弃(网页「我的求购单」查不到)。
	 */
	async function createBuyOrder(params: CreateBuyOrderParams): Promise<CreateBuyOrderResult> {
		const cookies = (params.cookies ?? []).filter(Boolean);
		const userAgent = params.userAgent || STEAM_WEB_USER_AGENT;
		const appid = Number(params.appid);
		const marketHashName = String(params.marketHashName || '');
		const currency = Number(params.currency || 0);
		const priceTotalCents = Math.round(Number(params.priceTotalCents));
		const quantity = Math.round(Number(params.quantity));

		if (!cookies.length && !params.sessionid) {
			throw new Error('缺少 WebSession cookies,无法挂求购');
		}
		if (!Number.isInteger(appid) || appid <= 0) {
			throw new Error('appid 无效');
		}
		if (!marketHashName) {
			throw new Error('物品名(market_hash_name)为空');
		}
		if (!Number.isInteger(currency) || currency <= 0) {
			throw new Error('账号钱包币种未知,无法挂求购(请确认该账号有钱包)');
		}
		if (!Number.isInteger(quantity) || quantity <= 0) {
			throw new Error('求购数量必须为正整数');
		}
		if (!Number.isInteger(priceTotalCents) || priceTotalCents <= 0) {
			throw new Error('求购价格无效');
		}

		const {cookieHeader, sessionid} = buildCookieHeader(cookies, params.sessionid);
		if (!sessionid) {
			throw new Error('cookies 中找不到 sessionid,且未单独提供');
		}

		const form = new URLSearchParams({
			sessionid,
			currency: String(currency),
			appid: String(appid),
			market_hash_name: marketHashName,
			price_total: String(priceTotalCents),
			quantity: String(quantity),
			billing_state: '',
			save_my_address: '0'
		});
		const confirmation = String(params.confirmation || '').replace(/\D/g, '');
		if (confirmation) {
			form.set('confirmation', confirmation);
		}

		const res = await http(COMMUNITY + '/market/createbuyorder/', {
			method: 'POST',
			headers: {
				Cookie: cookieHeader,
				'User-Agent': userAgent,
				Origin: COMMUNITY,
				Referer: listingUrl(appid, marketHashName),
				'X-Requested-With': 'XMLHttpRequest',
				Accept: '*/*',
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
			},
			body: form.toString()
		});
		const {text, json} = await readJson(res);
		log('info', `[market-buyorder] createbuyorder ${marketHashName} 总价=${priceTotalCents} x${quantity} → ${responseSummary(res, text)}`);

		if (!json) {
			throw noJsonError(res, text);
		}
		const code = Number(json.success);
		// 1 = 已挂单(可能仍带 need_confirmation);22 = Pending,要手机确认才生效。其余都是失败
		if (code !== 1 && code !== 22) {
			throw new Error(describeBuyOrderError(json.success, json.message, text));
		}
		const buyOrderId = json.buy_orderid ? String(json.buy_orderid) : '';
		// 实测 success=22 形如 {"need_confirmation":true,"confirmation":{"confirmation_id":"..."},"success":22}
		const confirmationId = json.confirmation && json.confirmation.confirmation_id ? String(json.confirmation.confirmation_id) : '';
		const needsConfirmation = code === 22 || !!json.need_confirmation
			|| !!json.needs_mobile_confirmation || !!json.mobile_confirmation_required || !!confirmationId;
		return {success: true, buyOrderId, confirmationId, needsConfirmation};
	}

	/** 撤一张求购单;只有明确 success=1 才算成功 */
	async function cancelBuyOrder(params: WebSessionParams & {buyOrderId: string}): Promise<{success: true}> {
		const userAgent = params.userAgent || STEAM_WEB_USER_AGENT;
		const buyOrderId = String(params.buyOrderId || '').trim();
		if (!buyOrderId) {
			throw new Error('缺少 buy_orderid');
		}
		const {cookieHeader, sessionid} = buildCookieHeader(params.cookies, params.sessionid);
		if (!sessionid) {
			throw new Error('cookies 中找不到 sessionid,且未单独提供');
		}

		const res = await http(COMMUNITY + '/market/cancelbuyorder/', {
			method: 'POST',
			headers: {
				Cookie: cookieHeader,
				'User-Agent': userAgent,
				Origin: COMMUNITY,
				Referer: COMMUNITY + '/market/',
				'X-Requested-With': 'XMLHttpRequest',
				Accept: '*/*',
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
			},
			body: new URLSearchParams({sessionid, buy_orderid: buyOrderId}).toString()
		});
		const {text, json} = await readJson(res);
		log('info', `[market-buyorder] cancelbuyorder ${buyOrderId} → ${responseSummary(res, text, 160)}`);
		if (json && Number(json.success) === 1) {
			return {success: true};
		}
		if (!json) {
			throw noJsonError(res, text);
		}
		throw new Error(describeBuyOrderError(json.success, json.message, text, '撤销求购单失败'));
	}

	/** 该账号在 Steam 上的真实求购单(刷新对账用);price 是每件的分,与挂单时一致 */
	async function fetchMyBuyOrders(params: WebSessionParams): Promise<LiveBuyOrder[]> {
		const cookies = (params.cookies ?? []).filter(Boolean);
		if (!cookies.length && !params.sessionid) {
			throw new Error('缺少 WebSession cookies,无法读取求购单');
		}
		const {cookieHeader} = buildCookieHeader(cookies, params.sessionid);
		const res = await http(COMMUNITY + '/market/mylistings/?norender=1&start=0&count=100', {
			method: 'GET',
			headers: {
				Cookie: cookieHeader,
				'User-Agent': params.userAgent || STEAM_WEB_USER_AGENT,
				Referer: COMMUNITY + '/market/',
				'X-Requested-With': 'XMLHttpRequest',
				Accept: '*/*'
			}
		});
		const {text, json} = await readJson(res);
		if (!json) {
			throw noJsonError(res, text);
		}
		if (!json.success) {
			throw new Error(describeBuyOrderError(json.success, json.message, text, '读取求购单失败'));
		}
		const raw: any[] = Array.isArray(json.buy_orders) ? json.buy_orders : [];
		return raw.map(order => {
			const description = order.description || {};
			return {
				buyOrderId: String(order.buy_orderid || ''),
				priceCents: Number(order.price) || 0,
				quantity: Number(order.quantity) || 0,
				quantityRemaining: order.quantity_remaining != null ? Number(order.quantity_remaining) : null,
				appid: Number(description.appid) || 0,
				marketHashName: String(description.market_hash_name || description.name || '')
			};
		}).filter(order => order.buyOrderId);
	}

	/** 分组链接 → 分组名(页面标题去掉「 - Steam Community Market」,如「AK-47 | Redline」) */
	async function fetchGroupName(params: {appid: number; groupId: string; userAgent?: string}): Promise<string> {
		const res = await http(listingUrl(params.appid, params.groupId), {headers: {'User-Agent': params.userAgent || STEAM_WEB_USER_AGENT, Accept: 'text/html'}});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		const head = await readUntil(res, '</title>', 512 * 1024);
		const title = decodeEntities(/<title>([^<]*)<\/title>/i.exec(head)?.[1] ?? '').trim();
		const name = title.replace(/\s+-\s+Steam\b.*$/i, '').trim();
		if (!name) {
			throw new Error('页面里没有分组名');
		}
		return name;
	}

	return {fetchMarketContext, createBuyOrder, cancelBuyOrder, fetchMyBuyOrders, fetchGroupName};
}

export type MarketClient = ReturnType<typeof createMarketClient>;
