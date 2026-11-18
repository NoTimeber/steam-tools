// Steam 社区市场「出售」的 HTTP 调用和返回解析:上架、我的在售、下架、成交记录。
// 和求购一样用登录账号的 WebSession cookie 重放网页请求(会话、sessionid、UA 规则见 ./client.ts 文件头)。
//
// 用到的 Steam 端点(和网页库存页 / 市场页的 JS 一致):
//   1. 上架        POST steamcommunity.com/market/sellitem/            表单 sessionid appid contextid assetid amount price
//                  price 是卖家「到手」的分(每件);Referer 必须是自己的库存页。
//                  返回 {success, requires_confirmation, needs_mobile_confirmation, needs_email_confirmation, email_domain, message}
//   2. 我的在售    GET  steamcommunity.com/market/mylistings/?norender=1&start=&count=   (求购对账用的同一个接口,见 ./client.ts)
//                  listings(在售)/ listings_to_confirm(待手机确认)/ listings_on_hold(暂挂);price = 到手,fee = 两项手续费
//   3. 下架        POST steamcommunity.com/market/removelisting/<listingid>  表单 sessionid;成功回 200(内容一般是 [])
//   4. 成交记录    GET  steamcommunity.com/market/myhistory/render/?query=&start=&count=&norender=1
//                  events[{listingid, purchaseid, event_type, time_event, steamid_actor}] + listings{} + purchases{} + assets{}
//                  event_type:1 上架、2 下架、3 卖出、4 买入

import {STEAM_WEB_USER_AGENT} from '../steam/user-agent.ts';
import {buildCookieHeader, noJsonError, readJson, responseSummary, truncate} from './client.ts';
import type {MarketLog, WebSessionParams} from './client.ts';

const COMMUNITY = 'https://steamcommunity.com';
const ICON_BASE = 'https://community.cloudflare.steamstatic.com/economy/image/';
/** mylistings 一页最多 100 条,最多翻几页 */
const LISTINGS_PAGE = 100;
const LISTINGS_MAX_PAGES = 10;

export interface SellItemParams extends WebSessionParams {
	steamID: string;
	appid: number;
	contextid: string;
	assetid: string;
	amount: number;
	/** 卖家到手(分,每件) */
	receiveCents: number;
}

export interface SellItemResult {
	/** Steam 接受了上架请求 */
	ok: boolean;
	/** 还要手机确认 / 邮件确认才会真正上架 */
	needsMobileConfirmation: boolean;
	needsEmailConfirmation: boolean;
	/** Steam 的原话(失败原因等);没有为 '' */
	message: string;
}

export type ListingStatus = 'active' | 'to_confirm' | 'on_hold';

export interface MyListing {
	listingId: string;
	status: ListingStatus;
	appid: number;
	contextid: string;
	/** 上架后物品在市场里的 id */
	assetid: string;
	/** 上架前在库存里的 assetid(unowned_id);Steam 没给时同 assetid */
	originalAssetid: string;
	amount: number;
	marketHashName: string;
	name: string;
	icon: string;
	/** 买家付(分)= receiveCents + feeCents */
	buyerPriceCents: number;
	/** 卖家到手(分) */
	receiveCents: number;
	feeCents: number;
	/** 钱包币种 ID(Steam 的 currencyid 去掉 2000) */
	currencyId: number;
	/** 上架时间(秒);没有为 0 */
	timeCreated: number;
	createdAt: string;
}

export interface MyListingsPage {
	totalCount: number;
	listings: MyListing[];
}

export type HistoryEventType = 'listed' | 'cancelled' | 'sold' | 'bought' | 'unknown';

export interface HistoryCounterpart {
	steamId: string;
	persona: string;
	avatar: string;
}

export interface HistoryEvent {
	/** 同一页里唯一:listingid_purchaseid_类型_时间 */
	key: string;
	type: HistoryEventType;
	/** Steam 原始 event_type */
	eventType: number;
	/** 秒 */
	time: number;
	date: string;
	listingId: string;
	purchaseId: string;
	appid: number;
	contextid: string;
	assetid: string;
	marketHashName: string;
	name: string;
	icon: string;
	/** 买家付(分);卖出/买入是成交价,上架/下架是挂的价;拿不到为 null */
	buyerPriceCents: number | null;
	/** 卖家到手(分);买入时为 null */
	receiveCents: number | null;
	currencyId: number;
	/** 对方(卖出时是买家,买入时是卖家);没有为 null */
	counterpart: HistoryCounterpart | null;
}

export interface HistoryPage {
	start: number;
	totalCount: number;
	events: HistoryEvent[];
}

const str = (value: unknown): string => (value == null ? '' : String(value));
const int = (value: unknown): number => {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
};

function iconUrl(icon: unknown): string {
	const text = str(icon);
	return text ? (/^https?:\/\//i.test(text) ? text : `${ICON_BASE}${text}/96fx96f`) : '';
}

function isoOf(seconds: number): string {
	return seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
}

/** Steam 的 currencyid 是 2000 + 钱包币种(2001 = USD) */
function walletCurrency(value: unknown): number {
	const id = int(value);
	return id > 2000 ? id - 2000 : id;
}

/** 顶层 assets[appid][contextid][assetid] 里的描述 */
function assetFrom(assets: any, appid: unknown, contextid: unknown, assetid: unknown): any {
	return assets?.[str(appid)]?.[str(contextid)]?.[str(assetid)] ?? null;
}

/** listing.asset 本身常带完整描述;没有就去顶层 assets 找 */
function describeAsset(asset: any, assets: any): {appid: number; contextid: string; assetid: string; marketHashName: string; name: string; icon: string; amount: number} {
	const appid = int(asset?.appid);
	const contextid = str(asset?.contextid);
	const assetid = str(asset?.id);
	const full = {...(assetFrom(assets, appid, contextid, assetid) ?? {}), ...(asset ?? {})};
	return {
		appid,
		contextid,
		assetid,
		marketHashName: str(full.market_hash_name || full.market_name || full.name),
		name: str(full.name || full.market_name || full.market_hash_name),
		icon: iconUrl(full.icon_url),
		amount: int(full.original_amount || full.amount) || 1
	};
}

function toListing(raw: any, status: ListingStatus, assets: any): MyListing | null {
	const listingId = str(raw?.listingid);
	if (!listingId) {
		return null;
	}
	const asset = describeAsset(raw.asset, assets);
	const receiveCents = int(raw.price) || int(raw.original_price);
	const feeCents = int(raw.fee);
	const timeCreated = int(raw.time_created);
	return {
		listingId,
		status,
		...asset,
		originalAssetid: str(raw.asset?.unowned_id) || asset.assetid,
		buyerPriceCents: receiveCents + feeCents,
		receiveCents,
		feeCents,
		currencyId: walletCurrency(raw.currencyid),
		timeCreated,
		createdAt: isoOf(timeCreated)
	};
}

/** mylistings(norender=1)的一页 → 在售 / 待确认 / 暂挂的出售单(同一 listingid 只留一条) */
export function parseMyListings(json: any): MyListingsPage {
	const assets = json?.assets;
	const seen = new Set<string>();
	const listings: MyListing[] = [];
	const groups: Array<[unknown, ListingStatus]> = [[json?.listings_to_confirm, 'to_confirm'], [json?.listings_on_hold, 'on_hold'], [json?.listings, 'active']];
	for (const [list, status] of groups) {
		for (const raw of Array.isArray(list) ? list : []) {
			const listing = toListing(raw, status, assets);
			if (listing && !seen.has(listing.listingId)) {
				seen.add(listing.listingId);
				listings.push(listing);
			}
		}
	}
	return {totalCount: int(json?.total_count ?? json?.num_active_listings), listings};
}

const EVENT_TYPES: Readonly<Record<number, HistoryEventType>> = {1: 'listed', 2: 'cancelled', 3: 'sold', 4: 'bought'};

/** myhistory/render(norender=1)的一页 → 成交记录事件(和网页上的顺序一样,新的在前) */
export function parseMyHistory(json: any): HistoryPage {
	const assets = json?.assets;
	const listings = json?.listings && typeof json.listings === 'object' ? json.listings : {};
	const purchases = json?.purchases && typeof json.purchases === 'object' ? json.purchases : {};
	const events: HistoryEvent[] = (Array.isArray(json?.events) ? json.events : []).map((raw: any): HistoryEvent => {
		const eventType = int(raw?.event_type);
		const type = EVENT_TYPES[eventType] ?? 'unknown';
		const listingId = str(raw?.listingid);
		const purchaseId = str(raw?.purchaseid);
		const listing = listings[listingId] ?? null;
		const purchase = purchaseId ? purchases[`${listingId}_${purchaseId}`] ?? null : null;
		const asset = describeAsset(purchase?.asset ?? listing?.asset ?? {}, assets);
		const time = int(raw?.time_event);
		let buyerPriceCents: number | null = null;
		let receiveCents: number | null = null;
		let currencyId = 0;
		if (purchase && (type === 'sold' || type === 'bought')) {
			buyerPriceCents = int(purchase.paid_amount) + int(purchase.paid_fee);
			receiveCents = type === 'sold' ? int(purchase.received_amount ?? purchase.paid_amount) : null;
			currencyId = walletCurrency(type === 'sold' ? purchase.received_currencyid ?? purchase.currencyid : purchase.currencyid);
		} else if (listing) {
			receiveCents = int(listing.price) || int(listing.original_price);
			buyerPriceCents = receiveCents + int(listing.fee);
			currencyId = walletCurrency(listing.currencyid);
		}
		const actor = str(raw?.steamid_actor || (type === 'sold' ? purchase?.steamid_purchaser : ''));
		const counterpart = (type === 'sold' || type === 'bought') && (actor || purchase?.persona_actor)
			? {steamId: actor, persona: str(purchase?.persona_actor), avatar: str(purchase?.avatar_actor)}
			: null;
		return {
			key: `${listingId}_${purchaseId}_${eventType}_${time}`,
			type,
			eventType,
			time,
			date: isoOf(time),
			listingId,
			purchaseId,
			appid: asset.appid,
			contextid: asset.contextid,
			assetid: asset.assetid,
			marketHashName: asset.marketHashName,
			name: asset.name,
			icon: asset.icon,
			buyerPriceCents,
			receiveCents,
			currencyId,
			counterpart
		};
	});
	return {start: int(json?.start), totalCount: int(json?.total_count), events};
}

export interface SellClientOptions {
	fetch?: typeof fetch;
	log?: MarketLog;
}

function webHeaders(cookieHeader: string, userAgent: string | undefined, referer: string, post: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		Cookie: cookieHeader,
		'User-Agent': userAgent || STEAM_WEB_USER_AGENT,
		Referer: referer,
		'X-Requested-With': 'XMLHttpRequest',
		Accept: '*/*'
	};
	if (post) {
		headers.Origin = COMMUNITY;
		headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
	}
	return headers;
}

function session(params: WebSessionParams, what: string): {cookieHeader: string; sessionid: string} {
	const cookies = (params.cookies ?? []).filter(Boolean);
	if (!cookies.length) {
		throw new Error(`缺少 WebSession cookies,无法${what}`);
	}
	const result = buildCookieHeader(cookies, params.sessionid);
	if (!result.sessionid) {
		throw new Error('cookies 中找不到 sessionid,且未单独提供');
	}
	return result;
}

export function createSellClient(options: SellClientOptions = {}) {
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const log: MarketLog = options.log ?? (() => {});

	/** 上架一件(或一叠)。Steam 明确拒绝时 ok=false 带原因;网络错误、不是 JSON 才抛 */
	async function sellItem(params: SellItemParams): Promise<SellItemResult> {
		const {cookieHeader, sessionid} = session(params, '上架');
		const form = new URLSearchParams({
			sessionid,
			appid: String(params.appid),
			contextid: String(params.contextid),
			assetid: String(params.assetid),
			amount: String(params.amount),
			price: String(params.receiveCents)
		});
		const res = await http(COMMUNITY + '/market/sellitem/', {
			method: 'POST',
			headers: webHeaders(cookieHeader, params.userAgent, `${COMMUNITY}/profiles/${params.steamID}/inventory/`, true),
			body: form.toString()
		});
		const {text, json} = await readJson(res);
		log('info', `[market-sell] sellitem ${params.appid}/${params.contextid}/${params.assetid} x${params.amount} 到手=${params.receiveCents} → ${responseSummary(res, text)}`);
		if (!json || typeof json !== 'object') {
			throw noJsonError(res, text);
		}
		const message = str(json.message).trim();
		if (json.success !== true && Number(json.success) !== 1) {
			return {ok: false, needsMobileConfirmation: false, needsEmailConfirmation: false, message: message || `Steam 拒绝上架(HTTP ${res.status} ${truncate(text, 120)})`};
		}
		const needsEmail = !!json.needs_email_confirmation;
		const needsMobile = !!json.needs_mobile_confirmation || (!!Number(json.requires_confirmation) && !needsEmail);
		return {ok: true, needsMobileConfirmation: needsMobile, needsEmailConfirmation: needsEmail, message};
	}

	async function getJson(url: string, params: WebSessionParams, what: string): Promise<any> {
		const {cookieHeader} = session(params, what);
		const res = await http(url, {method: 'GET', headers: webHeaders(cookieHeader, params.userAgent, COMMUNITY + '/market/', false)});
		const {text, json} = await readJson(res);
		if (!json || typeof json !== 'object') {
			throw noJsonError(res, text);
		}
		if (!json.success) {
			throw new Error(`${what}失败:${str(json.message) || `Steam 返回 success=${json.success}`}`);
		}
		return json;
	}

	/** 我的在售(含待确认、暂挂)。在售多于一页时接着翻,同一 listingid 只留一条 */
	async function fetchMyListings(params: WebSessionParams): Promise<MyListing[]> {
		const all = new Map<string, MyListing>();
		for (let page = 0; page < LISTINGS_MAX_PAGES; page++) {
			const start = page * LISTINGS_PAGE;
			const json = await getJson(`${COMMUNITY}/market/mylistings/?norender=1&start=${start}&count=${LISTINGS_PAGE}`, params, '读取在售');
			const parsed = parseMyListings(json);
			for (const listing of parsed.listings) {
				if (!all.has(listing.listingId)) {
					all.set(listing.listingId, listing);
				}
			}
			const activeOnPage = Array.isArray(json.listings) ? json.listings.length : 0;
			if (!activeOnPage || start + LISTINGS_PAGE >= parsed.totalCount) {
				break;
			}
		}
		return [...all.values()];
	}

	/** 下架一个出售单;Steam 回非 200 或明确 success=false 抛错 */
	async function removeListing(params: WebSessionParams & {listingId: string}): Promise<void> {
		const listingId = str(params.listingId).replace(/\D/g, '');
		if (!listingId) {
			throw new Error('缺少 listingid');
		}
		const {cookieHeader, sessionid} = session(params, '下架');
		const res = await http(`${COMMUNITY}/market/removelisting/${listingId}`, {
			method: 'POST',
			headers: webHeaders(cookieHeader, params.userAgent, COMMUNITY + '/market/', true),
			body: new URLSearchParams({sessionid}).toString()
		});
		const {text, json} = await readJson(res);
		log('info', `[market-sell] removelisting ${listingId} → ${responseSummary(res, text, 160)}`);
		if (res.status === 429) {
			throw noJsonError(res, text);
		}
		if (!res.ok) {
			throw new Error(`下架失败(${responseSummary(res, text, 120)}),可能已卖出或已下架,请刷新在售列表`);
		}
		if (json === null && text.trim()) {
			throw noJsonError(res, text);
		}
		if (json && typeof json === 'object' && !Array.isArray(json) && json.success === false) {
			throw new Error(`下架失败:${str(json.message) || 'Steam 拒绝'}`);
		}
	}

	/** 成交记录一页(start 从 0 开始,count 最多 100) */
	async function fetchMyHistory(params: WebSessionParams & {start: number; count: number}): Promise<HistoryPage> {
		const url = `${COMMUNITY}/market/myhistory/render/?query=&start=${params.start}&count=${params.count}&norender=1`;
		const parsed = parseMyHistory(await getJson(url, params, '读取成交记录'));
		return {...parsed, start: params.start};
	}

	return {sellItem, fetchMyListings, removeListing, fetchMyHistory};
}

export type SellClient = ReturnType<typeof createSellClient>;
