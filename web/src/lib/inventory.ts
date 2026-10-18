// 库存页的纯逻辑(不依赖 Vue):物品分类、副标题、时间显示(规则照搬旧版前端);分块页的稀有度、交易状态、磨损、筛选排序、堆叠。

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
	marketable?: boolean | null;
	/** 社区库存 Rarity 标签带的颜色(#d32ce6);没有时按稀有度名补 */
	rarityColor?: string;
	/** 磨损值、图案模板:只有连着 GC 时有 */
	paintWear?: number | null;
	paintSeed?: number | null;
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

// ===== 分块库存页:稀有度、交易状态、磨损、筛选排序、堆叠 =====

// CS2 各稀有度的标准颜色(和社区库存标签带的一致),GC 来源没有颜色时按名字补
const RARITY_TIERS: ReadonlyArray<readonly [tier: number, color: string, names: readonly string[]]> = [
	[1, '#b0c3d9', ['消费级', '普通级']],
	[2, '#5e98d9', ['工业级']],
	[3, '#4b69ff', ['军规级', '高级']],
	[4, '#8847ff', ['受限', '奇异']],
	[5, '#d32ce6', ['保密', '卓越']],
	[6, '#eb4b4b', ['隐秘', '非凡', '大师']],
	[7, '#e4ae39', ['违禁']]
];

function rarityTier(rarity: string): [number, string] | null {
	const entry = RARITY_TIERS.find(([, , names]) => names.includes(rarity));
	return entry ? [entry[0], entry[1]] : null;
}

/** 稀有度颜色:标签带的优先,没有按名字补,都没有为 '' */
export function rarityColorOf(item: Pick<InventoryItem, 'rarity' | 'rarityColor'>): string {
	return item.rarityColor || rarityTier(item.rarity)?.[1] || '';
}

export type TradeState = 'tradable' | 'cooling' | 'locked';

/** 交易状态按现在的时间算(后端的 tradable 是拉库存那一刻的):有解锁时间看时间,没有看 Steam 的标记 */
export function tradeStateOf(item: Pick<InventoryItem, 'tradable' | 'tradableAfter'>, now: number): TradeState {
	const unlockAt = Date.parse(item.tradableAfter || '');
	if (Number.isFinite(unlockAt)) {
		return unlockAt > now ? 'cooling' : 'tradable';
	}
	return item.tradable ? 'tradable' : 'locked';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 解锁时间的短写法(本地时间):今年的写「10-25 15:00」,跨年带年份 */
export function formatUnlockShort(value: string, now: number): string {
	const date = new Date(value || '');
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	const day = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
	return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()}-${day}`;
}

/** 还要等多久:「3 天 5 小时」「5 小时 20 分」「12 分钟」 */
export function formatWait(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days) return hours ? `${days} 天 ${hours} 小时` : `${days} 天`;
	if (hours) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
	return `${minutes} 分钟`;
}

/** 卡片上的交易标签和悬停说明 */
export function tradeBadge(item: Pick<InventoryItem, 'tradable' | 'tradableAfter'>, now: number): {state: TradeState; label: string; tip: string} {
	const state = tradeStateOf(item, now);
	if (state === 'cooling') {
		const unlockAt = Date.parse(item.tradableAfter);
		return {state, label: `${formatUnlockShort(item.tradableAfter, now)} 可交易`, tip: `交易冷却到 ${formatTradableAt(item.tradableAfter)},还有 ${formatWait(unlockAt - now)}`};
	}
	if (state === 'locked') {
		return {state, label: '已锁定', tip: 'Steam 标记为不可交易,没有给解锁时间'};
	}
	return {state, label: '可交易', tip: ''};
}

// 磨损区间(和 Steam 外观一致),色条按区间宽度画
export const WEAR_RANGES: ReadonlyArray<{name: string; min: number; max: number}> = [
	{name: '崭新出厂', min: 0, max: 0.07},
	{name: '略有磨损', min: 0.07, max: 0.15},
	{name: '久经沙场', min: 0.15, max: 0.38},
	{name: '破损不堪', min: 0.38, max: 0.45},
	{name: '战痕累累', min: 0.45, max: 1}
];

export function wearNameOf(wear: number): string {
	return (WEAR_RANGES.find(range => wear < range.max) ?? WEAR_RANGES[WEAR_RANGES.length - 1]!).name;
}

export function hasWear(item: Pick<InventoryItem, 'paintWear'>): item is {paintWear: number} {
	return typeof item.paintWear === 'number' && Number.isFinite(item.paintWear) && item.paintWear >= 0 && item.paintWear <= 1;
}

/** 磨损值显示:去掉多余的 0,最多 10 位小数 */
export function formatWear(wear: number): string {
	return wear.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

export type TradeFilter = 'all' | TradeState;
export type InventorySort = 'default' | 'name' | 'rarity' | 'unlock' | 'wear';

export interface InventoryFilters {
	search: string;
	category: string;
	trade: TradeFilter;
	rarity: string;
}

export function filterItems(items: readonly InventoryItem[], filters: InventoryFilters, now: number): InventoryItem[] {
	const words = filters.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return items.filter(item => {
		if (filters.category !== 'all' && inventoryCategoryOf(item) !== filters.category) return false;
		if (filters.trade !== 'all' && tradeStateOf(item, now) !== filters.trade) return false;
		if (filters.rarity && item.rarity !== filters.rarity) return false;
		if (words.length) {
			const text = `${item.name} ${item.marketHashName} ${item.type} ${item.assetid}`.toLowerCase();
			return words.every(word => text.includes(word));
		}
		return true;
	});
}

const nameCollator = new Intl.Collator('zh-CN', {numeric: true});

/** 排序:默认保持 Steam 给的顺序(新获得的在前);可交易时间是可交易的在前,冷却的按解锁早晚,锁定的最后 */
export function sortItems(items: readonly InventoryItem[], sort: InventorySort, now: number): InventoryItem[] {
	const list = [...items];
	const byName = (a: InventoryItem, b: InventoryItem) => nameCollator.compare(a.name, b.name);
	if (sort === 'name') {
		return list.sort(byName);
	}
	if (sort === 'rarity') {
		return list.sort((a, b) => (rarityTier(b.rarity)?.[0] ?? 0) - (rarityTier(a.rarity)?.[0] ?? 0) || byName(a, b));
	}
	if (sort === 'unlock') {
		const RANK: Record<TradeState, number> = {tradable: 0, cooling: 1, locked: 2};
		const key = (item: InventoryItem): [number, number] => {
			const state = tradeStateOf(item, now);
			return [RANK[state], state === 'cooling' ? Date.parse(item.tradableAfter) : 0];
		};
		return list.sort((a, b) => {
			const [rankA, timeA] = key(a);
			const [rankB, timeB] = key(b);
			return rankA - rankB || timeA - timeB || byName(a, b);
		});
	}
	if (sort === 'wear') {
		return list.sort((a, b) => (hasWear(a) ? a.paintWear : 2) - (hasWear(b) ? b.paintWear : 2) || byName(a, b));
	}
	return list;
}

/** 库存里有的稀有度及件数,按稀有度从高到低 */
export function rarityCounts(items: readonly InventoryItem[]): Array<{rarity: string; color: string; count: number}> {
	const counts = new Map<string, {color: string; count: number}>();
	for (const item of items) {
		if (!item.rarity) continue;
		const entry = counts.get(item.rarity) ?? {color: rarityColorOf(item), count: 0};
		entry.count++;
		counts.set(item.rarity, entry);
	}
	return [...counts].map(([rarity, entry]) => ({rarity, ...entry}))
		.sort((a, b) => (rarityTier(b.rarity)?.[0] ?? 0) - (rarityTier(a.rarity)?.[0] ?? 0) || nameCollator.compare(a.rarity, b.rarity));
}

/** 同一种物品(英文市场名相同,没有就按名字)算一堆 */
export function stackKeyOf(item: Pick<InventoryItem, 'marketHashName' | 'name'>): string {
	return item.marketHashName || item.name;
}

export interface InventoryStack {
	key: string;
	/** 代表这一堆的物品(排序后的第一件) */
	item: InventoryItem;
	items: InventoryItem[];
	tradableCount: number;
}

/** 堆叠:按 stackKeyOf 分组,保持传入顺序(先排序再堆叠,第一件决定这堆的位置) */
export function stackItems(items: readonly InventoryItem[], now: number): InventoryStack[] {
	const stacks = new Map<string, InventoryStack>();
	for (const item of items) {
		const key = stackKeyOf(item);
		let stack = stacks.get(key);
		if (!stack) {
			stack = {key, item, items: [], tradableCount: 0};
			stacks.set(key, stack);
		}
		stack.items.push(item);
		if (tradeStateOf(item, now) === 'tradable') stack.tradableCount++;
	}
	return [...stacks.values()];
}

export interface InventoryStats {
	total: number;
	distinct: number;
	tradable: number;
	cooling: number;
	locked: number;
	/** 最早解锁的时间(ISO);没有冷却中的为 '' */
	nextUnlock: string;
}

export function inventoryStats(items: readonly InventoryItem[], now: number): InventoryStats {
	const stats: InventoryStats = {total: items.length, distinct: new Set(items.map(stackKeyOf)).size, tradable: 0, cooling: 0, locked: 0, nextUnlock: ''};
	for (const item of items) {
		const state = tradeStateOf(item, now);
		stats[state]++;
		if (state === 'cooling' && (!stats.nextUnlock || Date.parse(item.tradableAfter) < Date.parse(stats.nextUnlock))) {
			stats.nextUnlock = item.tradableAfter;
		}
	}
	return stats;
}

/** 当前页:页码从 1 开始,超出范围的拉回最后一页 */
export function pageOf<T>(list: readonly T[], page: number, pageSize: number): {rows: T[]; page: number; pageCount: number} {
	const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
	const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
	return {rows: list.slice((current - 1) * pageSize, current * pageSize), page: current, pageCount};
}

/** Steam 市场页地址;不能上架或没有英文市场名的为 '' */
export function marketUrlOf(item: Pick<InventoryItem, 'marketHashName' | 'marketable'>): string {
	return item.marketHashName && item.marketable !== false ? `https://steamcommunity.com/market/listings/730/${encodeURIComponent(item.marketHashName)}` : '';
}

/** Steam 网页库存里这件物品的地址 */
export function inventoryUrlOf(steamID: string, assetid: string): string {
	return steamID && assetid ? `https://steamcommunity.com/profiles/${steamID}/inventory/#730_2_${assetid}` : '';
}
