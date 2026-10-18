// Steam 社区库存(从 app/server.js 移来):steamcommunity.com/inventory/<steamID>/730/2,中文名、标签、能否交易/上架都以它为准。
// 分页拉取(每页 2000,最多 20 页);GC 库存里有同一件物品时,用 GC 的 tradable_after 判断交易冷却(比社区的更准)。

import {serializeForJson} from '../core/serialize.ts';
import {STEAM_WEB_USER_AGENT} from '../steam/user-agent.ts';

const APP_ID = 730;
const CONTEXT_ID = 2;
const PAGE_SIZE = 2000;
const MAX_PAGES = 20;
const ICON_BASE = 'https://community.cloudflare.steamstatic.com/economy/image/';

export interface InventoryItem {
	assetid: string;
	name: string;
	marketHashName: string;
	type: string;
	category: string;
	rarity: string;
	exterior: string;
	iconUrl: string;
	tradable: boolean;
	marketable: boolean | null;
	tradableAfter: string;
	/** 稀有度颜色(社区库存 Rarity 标签带的,如 #d32ce6);GC 来源没有,前端按稀有度名补 */
	rarityColor?: string;
	/** 磨损值、图案模板:只有 GC 里有这件物品时才有 */
	paintWear?: number | null;
	paintSeed?: number | null;
	amount: number;
	position: number;
	source: 'community' | 'gc';
	raw: unknown;
	[extra: string]: unknown;
}

export interface InventorySnapshot {
	source: 'community' | 'gc';
	fetchedAt: string;
	fetchedAtMs: number;
	itemCount: number;
	items: InventoryItem[];
	raw: unknown;
}

export function inventoryError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

export function stripHtml(value: unknown): string {
	return String(value == null ? '' : value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function toIsoString(value: unknown): string {
	if (!value) {
		return '';
	}
	const date = value instanceof Date ? value : new Date(value as string | number);
	return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

interface Tag {
	category?: string;
	category_name?: string;
	localized_tag_name?: string;
	name?: string;
	internal_name?: string;
	color?: string;
}

function pickTag(tags: Tag[], category: string): string {
	const tag = tags.find(item => item && (item.category === category || item.category_name === category));
	return tag ? (tag.localized_tag_name || tag.name || tag.internal_name || '') : '';
}

function tagColor(tags: Tag[], category: string): string {
	const tag = tags.find(item => item && (item.category === category || item.category_name === category));
	const color = String(tag && tag.color || '').trim();
	return /^[0-9a-f]{6}$/i.test(color) ? `#${color.toLowerCase()}` : '';
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 中文库存(l=schinese)里的日期写成「2026年10月25日 (7:00:00) GMT」,Date 解析不了;要带时刻才认(没时刻按 0 点算会提前显示可交易)
const ZH_DATE_TIME = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[(（]?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/;

function parseZhDateTime(text: string): string {
	const match = ZH_DATE_TIME.exec(text);
	if (!match) {
		return '';
	}
	const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part || 0)) as [number, number, number, number, number, number];
	return toIsoString(new Date(Date.UTC(year, month - 1, day, hour, minute, second)));
}

/** 社区描述里的交易冷却截止时间:过期字段,或说明文字里的「Tradable After ...」(英文或中文日期,按 GMT) */
export function extractCommunityTradableAfter(description: any): string {
	if (!description || typeof description !== 'object') {
		return '';
	}
	for (const candidate of [description.cache_expiration, description.item_expiration]) {
		const iso = toIsoString(candidate);
		if (iso) {
			return iso;
		}
	}
	for (const field of [description.owner_descriptions, description.descriptions, description.fraudwarnings]) {
		if (!Array.isArray(field)) {
			continue;
		}
		for (const entry of field) {
			const text = stripHtml(entry && entry.value ? entry.value : entry);
			if (!text) {
				continue;
			}
			// 先去掉前缀和括号再解析:V8 会把「Feb 03, 2099 (7:00:00) GMT」里括号当注释,直接解析会丢掉时刻变成当天 0 点
			// (旧代码先直接解析,解锁当天 0~7 点会把还在冷却的物品显示成可交易)
			const normalized = text
				.replace(/Tradable\s*After\s*/i, '')
				.replace(/Marketable\s*After\s*/i, '')
				.replace(/[()]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();
			const parsed = parseZhDateTime(text) || toIsoString(normalized) || toIsoString(text);
			if (parsed) {
				return parsed;
			}
		}
	}
	return '';
}

/** 一页社区库存 → 物品列表 */
export function normalizeCommunityInventoryPage(payload: any, gcItemsByAssetId: ReadonlyMap<string, any> | null = null, now = Date.now()): InventoryItem[] {
	const descriptions = new Map<string, any>();
	for (const description of payload.descriptions || []) {
		descriptions.set(`${description.classid}_${description.instanceid}`, description);
	}
	return (payload.assets || []).map((asset: any): InventoryItem => {
		const assetid = String(asset.assetid || asset.id || '');
		const description = descriptions.get(`${asset.classid}_${asset.instanceid}`) || {};
		const tags: Tag[] = Array.isArray(description.tags) ? description.tags : [];
		const gcItem = gcItemsByAssetId instanceof Map ? gcItemsByAssetId.get(assetid) : null;
		const tradableAfter = toIsoString(gcItem && gcItem.tradable_after) || extractCommunityTradableAfter(description);
		return {
			assetid,
			name: String(description.name || description.market_name || description.market_hash_name || `Asset ${asset.assetid || ''}`),
			marketHashName: String(description.market_hash_name || ''),
			type: String(pickTag(tags, 'Type') || description.type || '-'),
			category: String(pickTag(tags, 'Category') || ''),
			rarity: String(pickTag(tags, 'Rarity') || ''),
			exterior: String(pickTag(tags, 'Exterior') || ''),
			rarityColor: tagColor(tags, 'Rarity'),
			paintWear: finiteOrNull(gcItem && gcItem.paint_wear),
			paintSeed: finiteOrNull(gcItem && gcItem.paint_seed),
			iconUrl: description.icon_url ? `${ICON_BASE}${description.icon_url}/96fx96f` : '',
			tradable: tradableAfter ? new Date(tradableAfter).getTime() <= now : description.tradable !== 0,
			marketable: description.marketable !== 0,
			tradableAfter,
			amount: Number(asset.amount || 1),
			position: 0,
			source: 'community',
			raw: {asset, description, gcItem: gcItem ? serializeForJson(gcItem) : null}
		};
	});
}

export interface CommunityFetchParams {
	steamID: string;
	cookies: readonly string[];
	userAgent?: string;
	/** GC 库存里的物品(按 assetid),用来校正交易冷却 */
	gcItemsByAssetId?: ReadonlyMap<string, any> | null;
}

export async function fetchCommunityInventory(params: CommunityFetchParams, http: typeof fetch = (input, init) => fetch(input, init), now: () => number = Date.now): Promise<InventorySnapshot> {
	if (!params.steamID) {
		throw inventoryError(409, '当前账号缺少 SteamID，无法读取库存');
	}
	if (!params.cookies.length) {
		throw inventoryError(409, '当前账号没有可用的 WebSession cookies,请重新登录');
	}
	const cookieHeader = params.cookies.join('; ');
	const items: InventoryItem[] = [];
	const pages: unknown[] = [];
	let startAssetId = '';
	let count = 0;
	do {
		const payload = await fetchPage(params.steamID, cookieHeader, startAssetId, params.userAgent, http);
		pages.push(payload);
		items.push(...normalizeCommunityInventoryPage(payload, params.gcItemsByAssetId ?? null, now()));
		startAssetId = payload.more_items ? String(payload.last_assetid || '') : '';
		count++;
	} while (startAssetId && count < MAX_PAGES);

	return {
		source: 'community',
		fetchedAt: new Date(now()).toISOString(),
		fetchedAtMs: now(),
		itemCount: items.length,
		items,
		raw: {source: 'community', pages}
	};
}

async function fetchPage(steamID: string, cookieHeader: string, startAssetId: string, userAgent: string | undefined, http: typeof fetch): Promise<any> {
	const url = new URL(`https://steamcommunity.com/inventory/${steamID}/${APP_ID}/${CONTEXT_ID}`);
	url.searchParams.set('l', 'schinese');
	url.searchParams.set('count', String(PAGE_SIZE));
	if (startAssetId) {
		url.searchParams.set('start_assetid', startAssetId);
	}
	const response = await http(url, {
		headers: {
			Accept: 'application/json, text/plain, */*',
			Cookie: cookieHeader,
			Referer: `https://steamcommunity.com/profiles/${steamID}/inventory/`,
			'User-Agent': userAgent || STEAM_WEB_USER_AGENT
		}
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw inventoryError(response.status === 401 || response.status === 403 ? 409 : 502, body && body.length < 160 ? body : `库存请求失败: HTTP ${response.status}`);
	}
	const payload: any = await response.json();
	if (!payload || (payload.success !== 1 && payload.success !== true)) {
		throw inventoryError(502, payload && payload.error ? payload.error : '库存响应无效');
	}
	return payload;
}
