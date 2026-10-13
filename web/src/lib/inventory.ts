// 库存页的纯逻辑(不依赖 Vue):物品分类、副标题、时间显示。规则照搬旧版前端(app/public/app.js)。

/** 后端 /api/inventory/:id 返回的物品(src/inventory/community.ts 的 InventoryItem,只列用到的) */
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
	tradableAfter: string;
	source: 'community' | 'gc';
	/** GC 来源才有:稳定的物品种类枚举(src/items/schema.ts 的 ItemKind) */
	kind?: string;
	/** 社区来源:{asset, description};分类要用 description.tags 里 Type 标签的 internal_name */
	raw?: unknown;
}

/** 分类下拉的顺序。「消费级/工业级」这类是稀有度不是类型;基础武器、探员、音乐盒等杂项不单独归类,只在「全部」里 */
export const INVENTORY_CATEGORIES = ['武器皮肤', '武器箱', '印花胶囊', '印花', '涂鸦', '工具'] as const;
export type InventoryCategory = typeof INVENTORY_CATEGORIES[number];

const KIND_LABELS: Readonly<Record<string, InventoryCategory>> = {
	weapon_skin: '武器皮肤',
	weapon_case: '武器箱',
	graffiti: '涂鸦',
	sticker: '印花',
	tool: '工具'
};

// 社区库存的 type 是「普通级 武器箱」这种稀有度 + 类型拼接,不能直接用;改用 Type 标签的 internal_name
const COMMUNITY_TYPE_LABELS: Readonly<Record<string, InventoryCategory>> = {
	CSGO_Type_WeaponCase: '武器箱',
	CSGO_Type_Spray: '涂鸦',
	CSGO_Type_Sticker: '印花',
	CSGO_Type_Tool: '工具'
};

const COMMUNITY_WEAPON_TYPES: ReadonlySet<string> = new Set([
	'CSGO_Type_Pistol', 'CSGO_Type_SMG', 'CSGO_Type_Rifle', 'CSGO_Type_Shotgun',
	'CSGO_Type_Machinegun', 'CSGO_Type_SniperRifle', 'CSGO_Type_Knife', 'CSGO_Type_Hands', 'CSGO_Type_Gloves'
]);

function communityTypeTag(item: InventoryItem): string {
	const raw = item.raw as {description?: {tags?: unknown}} | null | undefined;
	const tags = raw && raw.description && Array.isArray(raw.description.tags) ? raw.description.tags as Array<Record<string, unknown>> : null;
	const typeTag = tags?.find(tag => tag && (tag.category === 'Type' || tag.category_name === 'Type'));
	return typeTag ? String(typeTag.internal_name || '') : '';
}

/** 物品归到哪个分类;'' 表示不归类(只在「全部」里出现) */
export function inventoryCategoryOf(item: InventoryItem): InventoryCategory | '' {
	const byKind = item.kind ? KIND_LABELS[item.kind] : undefined;
	if (byKind) {
		return byKind;
	}
	const internal = communityTypeTag(item);
	if (internal) {
		if (COMMUNITY_TYPE_LABELS[internal]) {
			return COMMUNITY_TYPE_LABELS[internal]!;
		}
		// 武器类:名字带「|」= 有涂装 = 武器皮肤;没涂装的基础武器不归类
		if (COMMUNITY_WEAPON_TYPES.has(internal)) {
			return /\|/.test(item.name || '') ? '武器皮肤' : '';
		}
		return '';
	}
	// 回退:GC 的 type 正好是分类名
	const type = String(item.type || '').trim();
	return (INVENTORY_CATEGORIES as readonly string[]).includes(type) ? type as InventoryCategory : '';
}

/** 库存里实际有的分类及数量,按下拉顺序 */
export function categoryCounts(items: readonly InventoryItem[]): Array<{category: InventoryCategory; count: number}> {
	const counts = new Map<InventoryCategory, number>();
	for (const item of items) {
		const category = inventoryCategoryOf(item);
		if (category) {
			counts.set(category, (counts.get(category) ?? 0) + 1);
		}
	}
	return INVENTORY_CATEGORIES.filter(category => counts.has(category)).map(category => ({category, count: counts.get(category)!}));
}

/** 名称下面那行小字:GC 来源用英文市场名或收藏品,社区来源用收藏品;和名称/类型重复的、「系列 N」不显示 */
export function itemSubtitle(item: InventoryItem): string {
	const name = String(item.name || '').trim();
	const type = String(item.type || '').trim();
	const candidates = item.source === 'community' ? [item.category] : [item.marketHashName, item.category];
	for (const raw of candidates) {
		const candidate = String(raw || '').trim();
		if (candidate && candidate !== name && candidate !== type && !/^系列\s+\d+$/u.test(candidate)) {
			return candidate;
		}
	}
	return '';
}

export function formatInventorySource(source: string): string {
	return source === 'community' ? '社区库存' : source === 'gc' ? 'GC缓存' : '-';
}

/** 可交易时间按 Steam 的写法显示 GMT */
export function formatTradableAt(value: string): string {
	const date = new Date(value || '');
	if (!value || Number.isNaN(date.getTime())) {
		return '-';
	}
	const two = (n: number) => String(n).padStart(2, '0');
	return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} GMT`;
}
