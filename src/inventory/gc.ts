// GC 库存(从 app/server.js 移来):连上 CS2 GC 后 globaloffensive 模块里的 inventory。
// 社区库存拉不到时用它兜底;名字靠本地物品 schema 解析(较新的饰品可能只有英文开发名,所以优先用社区库存)。

import {serializeForJson} from '../core/serialize.ts';
import type {InventoryItem, InventorySnapshot} from './community.ts';

/** describeGcItem(app/items-game-schema.js)的返回里用到的字段 */
export interface GcItemDetails {
	name: string;
	marketHashName: string;
	type?: string;
	category: string;
	rarity: string;
	exterior: string;
	iconUrl: string;
	tradableAfter?: string | null;
	stickers?: unknown[];
	kind?: unknown;
	quality?: unknown;
	definitionIndex?: unknown;
	definitionInternalName?: unknown;
	definitionDisplayName?: unknown;
	paintKit?: unknown;
	sprayKit?: unknown;
}

export type DescribeGcItem = (item: Record<string, any>) => GcItemDetails;

interface GcInventoryHolder {
	inventory?: unknown;
}

function hasAttribute(item: any, defIndex: number): boolean {
	return Array.isArray(item && item.attribute) && item.attribute.some((attribute: any) => Number(attribute && attribute.def_index) === defIndex);
}

/** 库存页要显示的物品:不在储物柜里;flags 24 是 GC 内部物品;origin 24 + 属性 277 是「未展示」的奖励物品 */
export function isGcDisplayInventoryItem(item: any): boolean {
	if (!item || item.casket_id) {
		return false;
	}
	if ((Number(item.flags || 0) & 24) === 24) {
		return false;
	}
	return !(Number(item.origin || 0) === 24 && hasAttribute(item, 277));
}

export function getGcInventoryItems(csgo: GcInventoryHolder | null | undefined): any[] {
	if (!csgo || !Array.isArray(csgo.inventory)) {
		return [];
	}
	return csgo.inventory.filter(isGcDisplayInventoryItem);
}

export function buildGcInventoryItemMap(csgo: GcInventoryHolder | null | undefined): Map<string, any> {
	const map = new Map<string, any>();
	for (const item of getGcInventoryItems(csgo)) {
		const assetid = String(item && item.id || '');
		if (assetid) {
			map.set(assetid, item);
		}
	}
	return map;
}

export function normalizeGcInventoryItem(item: any, describe: DescribeGcItem, now = Date.now()): InventoryItem {
	const details = describe(item);
	const tradableAfter = details.tradableAfter ? new Date(details.tradableAfter) : null;
	return {
		assetid: String(item.id || ''),
		name: details.name,
		marketHashName: details.marketHashName,
		type: details.type || (item.def_index ? `DefIndex ${item.def_index}` : '-'),
		category: details.category,
		rarity: details.rarity,
		exterior: details.exterior,
		iconUrl: details.iconUrl,
		tradable: !tradableAfter || tradableAfter.getTime() <= now,
		marketable: null,
		amount: 1,
		position: Number(item.position || 0),
		paintIndex: Number.isFinite(item.paint_index) ? item.paint_index : null,
		paintSeed: Number.isFinite(item.paint_seed) ? item.paint_seed : null,
		paintWear: Number.isFinite(item.paint_wear) ? item.paint_wear : null,
		stickerCount: Array.isArray(details.stickers) ? details.stickers.length : 0,
		kind: details.kind,
		quality: details.quality,
		definitionIndex: details.definitionIndex,
		definitionInternalName: details.definitionInternalName,
		definitionDisplayName: details.definitionDisplayName,
		paintKit: details.paintKit,
		sprayKit: details.sprayKit,
		stickers: details.stickers,
		tradableAfter: details.tradableAfter as string,
		source: 'gc',
		raw: serializeForJson(item)
	};
}

/** GC 库存快照:按背包位置排序,raw 里带上全部原始物品(含不显示的) */
export function buildGcInventorySnapshot(csgo: GcInventoryHolder | null | undefined, describe: DescribeGcItem, now = Date.now()): InventorySnapshot {
	const items = getGcInventoryItems(csgo)
		.map(item => normalizeGcInventoryItem(item, describe, now))
		.sort((left, right) => {
			const leftPos = Number(left.position || 0);
			const rightPos = Number(right.position || 0);
			return leftPos !== rightPos ? leftPos - rightPos : String(left.assetid).localeCompare(String(right.assetid));
		});
	return {
		source: 'gc',
		fetchedAt: new Date(now).toISOString(),
		fetchedAtMs: now,
		itemCount: items.length,
		items,
		raw: {source: 'gc', items: Array.isArray(csgo && csgo.inventory) ? (csgo?.inventory as unknown[]).map(item => serializeForJson(item)) : []}
	};
}
