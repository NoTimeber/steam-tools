// 终端机报价皮肤的中文名、图片、品质(从 app/server.js 移来):def_index + paint_index → ByMykel CSGO-API(zh-CN)的皮肤库。
// 本地 items_game.txt 对较新的 paint 只有英文开发名(如 "P2000 Deep RED"),所以名字用 ByMykel;外观档仍用本地 schema。
//
// 皮肤库来源依次:运行时缓存 data/cs2-skin-db.json(上次联网刷新的)→ 随包副本 app/data/cs2-skin-db.json
// (raw.githubusercontent 在国内常被墙,靠它离线也能用)→ 都没有才联网拉。拿到本地副本后后台联网刷新一次。

import {existsSync, readFileSync} from 'node:fs';

export const SKIN_DB_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/zh-CN/skins.json';

export interface SkinInfo {
	name: string;
	image: string;
	rarity: string;
}

export type SkinMap = Record<string, SkinInfo>;

/** ByMykel skins.json → {"def_paint": {name, image, rarity}} */
export function buildSkinMap(list: unknown): SkinMap {
	const map: SkinMap = {};
	for (const skin of Array.isArray(list) ? list : []) {
		const def = Number(skin && skin.weapon && skin.weapon.weapon_id);
		const paint = skin && skin.paint_index != null ? Number(skin.paint_index) : NaN;
		if (def && Number.isFinite(paint)) {
			map[`${def}_${paint}`] = {name: skin.name || '', image: skin.image || '', rarity: (skin.rarity && skin.rarity.name) || ''};
		}
	}
	return map;
}

function loadFile(file: string): SkinMap | null {
	try {
		if (existsSync(file)) {
			const data = JSON.parse(readFileSync(file, 'utf8'));
			if (data && data.map && Object.keys(data.map).length) {
				return data.map;
			}
		}
	} catch {
		// 坏文件当没有
	}
	return null;
}

export interface SkinDbOptions {
	cacheFile: string;
	bundledFile: string;
	writeJson(file: string, value: unknown): void;
	fetch?: typeof fetch;
	now?: () => number;
	logger?: Pick<Console, 'warn'>;
}

export function createSkinDb(options: SkinDbOptions) {
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const now = options.now ?? Date.now;
	const logger = options.logger ?? console;
	let map: SkinMap | null = null;
	let loading: Promise<SkinMap> | null = null;
	let refreshed = false;

	async function download(): Promise<SkinMap | null> {
		try {
			const res = await http(SKIN_DB_URL, {headers: {'User-Agent': 'steam-tools'}, signal: AbortSignal.timeout(30000)});
			if (res.ok) {
				const fresh = buildSkinMap(await res.json());
				if (Object.keys(fresh).length) {
					try {
						options.writeJson(options.cacheFile, {fetchedAt: new Date(now()).toISOString(), map: fresh});
					} catch {
						// 写不了缓存也照样用
					}
					return fresh;
				}
			}
		} catch (err) {
			logger.warn('[terminal] 拉 CS2 皮肤库(ByMykel zh-CN)失败:', err instanceof Error ? err.message : err);
		}
		return null;
	}

	function refreshInBackground(): void {
		if (refreshed) {
			return;
		}
		refreshed = true;
		download().then(fresh => {
			if (fresh) {
				map = fresh;
			}
		}).catch(() => {});
	}

	/** 确保皮肤库已加载(并发调用共用一次加载) */
	async function ensure(): Promise<SkinMap> {
		if (map) {
			return map;
		}
		if (loading) {
			return loading;
		}
		loading = (async () => {
			const local = loadFile(options.cacheFile) || loadFile(options.bundledFile);
			if (local) {
				map = local;
				refreshInBackground();
				return map;
			}
			return (map = (await download()) || {});
		})();
		try {
			return await loading;
		} finally {
			loading = null;
		}
	}

	function resolve(defIndex: unknown, paintIndex: unknown): SkinInfo | null {
		return map ? map[`${Number(defIndex)}_${Number(paintIndex)}`] || null : null;
	}

	return {ensure, resolve};
}

export type SkinDb = ReturnType<typeof createSkinDb>;

export interface RawOffer {
	defindex?: unknown;
	paintindex?: unknown;
	paintwear?: unknown;
	paintseed?: unknown;
	priceCents?: number | null;
	[key: string]: unknown;
}

export interface EnrichedOffer extends RawOffer {
	name: string;
	exterior: string;
	rarity: string;
	wear: number | null;
	priceText: string;
	image: string;
}

/** 本地 schema 的 describeGcItem(已绑定 CS2 schema) */
export type DescribeItem = (item: Record<string, unknown>) => {name?: string; rarity?: string; exterior?: string} | null;

/** 给一个报价补中文名、图片、外观档(去掉尾部磨损值)、品质、价格文字 */
export function enrichTerminalOffer<T extends RawOffer | null | undefined>(offer: T, describe: DescribeItem, skins: Pick<SkinDb, 'resolve'>): T | EnrichedOffer {
	if (!offer) {
		return offer;
	}
	const def = Number(offer.defindex || 0);
	const paint = Number(offer.paintindex || 0);
	const wear = offer.paintwear != null ? Number(offer.paintwear) : null;
	let localName = '';
	let exterior = '';
	let localRarity = '';
	try {
		const details = describe({def_index: def, paint_index: paint, paint_wear: wear != null ? wear : undefined, paint_seed: offer.paintseed});
		if (details) {
			localName = details.name || '';
			localRarity = details.rarity || '';
			exterior = String(details.exterior || '').replace(/\s*[\d.]+\s*$/, '').trim();
		}
	} catch {
		// schema 描述不了就只用皮肤库
	}
	const skin = skins.resolve(def, paint);
	return {
		...offer,
		name: (skin && skin.name) || localName || `def${def} · paint${paint}`,
		exterior,
		rarity: (skin && skin.rarity) || localRarity || '',
		wear,
		priceText: offer.priceCents != null ? '$' + (offer.priceCents / 100).toFixed(2) : '',
		image: (skin && skin.image) || ''
	};
}
