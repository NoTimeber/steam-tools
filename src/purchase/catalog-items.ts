// 内购商品目录:价目表条目 → 商品(defIndex、名称、类型、分类、各币种价格)。从 app/server.js 移来,逻辑不变。
// 名称和分类依赖物品 schema(../items/schema.ts 解析 items_game.txt),由调用方注入,
// 这里只做查表和分类规则。回归快照见 test/fixtures/price-sheets/catalog.expected.json。

import {normalizeGame} from '../steam/games.ts';
import type {GameId} from '../steam/games.ts';
import {extractStorePrices, normalizePriceMap} from '../steam/price-sheet.ts';
import type {KvNode, PriceMap} from '../steam/price-sheet.ts';

/** items_game.txt 里的物品定义(只列用到的字段) */
export interface ItemDefinition {
	name?: string;
	item_name?: string;
	item_class?: string;
	prefab?: string;
	tool?: {type?: string};
	loot_list_name?: string;
	image_inventory?: string;
	[key: string]: unknown;
}

export interface ItemSchema {
	items?: Record<string, ItemDefinition>;
	error?: string;
}

/** 用到的 ../items/schema.ts 描述字段 */
export interface ItemDescription {
	name?: string;
	definitionDisplayName?: string;
	type?: string;
	category?: string;
}

export type DescribeGcItem = (schema: ItemSchema, item: {def_index: number}) => ItemDescription | null | undefined;

export interface CatalogItem {
	def_index: number;
	name: string;
	type: string;
	category: string;
	prices: PriceMap;
}

export interface Classification {
	name: string;
	type: string;
	category: string;
}

export const CATEGORY_ORDER: readonly string[] = Object.freeze(['工具', '钥匙', '票券', '音乐盒', '胶囊', '武器', '帽子', '套装', '饰品', '印花', '其他']);
const CATEGORY_INDEX: ReadonlyMap<string, number> = new Map(CATEGORY_ORDER.map((name, index) => [name, index]));

// ===== TF2 曼恩公司补给箱钥匙:TF2 内购只卖它 =====
export const TF2_KEY_DEF_INDEX = 5021;
// 钥匙在 TF2 商店里是 249 价位($2.49),price_sheet 的 inventoryvalvegcpricesheet 里该价位就是全币种价格
export const TF2_KEY_PRICE_TIER = 249;
export const UYU_TF2_KEY_COST = 9600;
// 真实 price_sheet 249 价位的全区价格(含 USD),本地没有可解析的 TF2 价目表留样时兜底
export const TF2_KEY_FALLBACK_PRICES: Readonly<PriceMap> = Object.freeze({
	USD: TF2_KEY_PRICE_TIER,
	GBP: 185, EUR: 219, RUB: 19100, BRL: 1249, JPY: 38500, NOK: 2350,
	IDR: 4289900, MYR: 975, PHP: 14800, SGD: 330, THB: 8100, VND: 6600000,
	KRW: 369000, UAH: 10800, MXN: 4399, CAD: 339, AUD: 355, NZD: 415,
	CNY: 1700, TWD: 7900, HKD: 1930, INR: 22700, AED: 925, SAR: 935,
	ZAR: 4099, COP: 890000, PEN: 840, CLP: 220500, CHF: 190, CRC: 114000,
	ILS: 745, KZT: 115000, KWD: 75, PLN: 890, QAR: 899, UYU: UYU_TF2_KEY_COST
});

// CS2 几个工具类商品的固定中文名(本地化文本里没有或有错字)
const EXPLICIT_NAMES: Readonly<Record<number, string>> = Object.freeze({
	1200: '名称标签',
	1201: '库存存储组件',
	1324: 'StatTrak™ 数据互换器',
	1354: '武库通行证',
	4000: '印花展示柜',
	4950: '钥匙扣拆卸工具包'
});
const CS2_TOOL_DEF_INDEXES: ReadonlySet<number> = new Set([1200, 1201, 1324, 1354, 4000, 4950]);
const TICKET_DEF_INDEX = 725;

export function findCatalogItem(list: readonly CatalogItem[] | null | undefined, defIndex: unknown): CatalogItem | null {
	return Array.isArray(list) ? list.find(item => Number(item.def_index) === Number(defIndex)) || null : null;
}

/** 商品在某币种下的单价(最小货币单位);没有该币种退到 USD,都没有为 0 */
export function itemPrice(item: CatalogItem | null | undefined, currencyISO: unknown): number {
	if (!item || !item.prices || typeof item.prices !== 'object') {
		return 0;
	}
	const iso = String(currencyISO || 'USD').trim().toUpperCase();
	if (item.prices[iso] != null) {
		return Number(item.prices[iso] || 0);
	}
	if (item.prices.USD != null) {
		return Number(item.prices.USD || 0);
	}
	return 0;
}

/** 分类顺序(工具、钥匙……其他)优先,同类按名称 */
export function compareCatalogItems(left: Classification | null | undefined, right: Classification | null | undefined): number {
	const leftIndex = CATEGORY_INDEX.get(String(left?.category)) ?? Number.MAX_SAFE_INTEGER;
	const rightIndex = CATEGORY_INDEX.get(String(right?.category)) ?? Number.MAX_SAFE_INTEGER;
	if (leftIndex !== rightIndex) {
		return leftIndex - rightIndex;
	}
	return String(left?.name || '').localeCompare(String(right?.name || ''), 'zh-CN');
}

function lower(value: unknown): string {
	return String(value || '').trim().toLowerCase();
}

function normalizeCatalogName(defIndex: number, fallbackName: string, definition: ItemDefinition | null): string {
	const explicit = EXPLICIT_NAMES[defIndex];
	if (explicit) {
		return explicit;
	}
	const normalized = String(fallbackName || '').trim();
	if (normalized) {
		return normalized;
	}
	const tokenName = String(definition?.item_name || '').trim();
	return tokenName || `DefIndex ${defIndex || '-'}`;
}

interface Cs2Signals {
	defIndex: number;
	searchName: string;
	internalName: string;
	itemToken: string;
	lootListName: string;
	imageInventory: string;
}

function isCs2Ticket(s: Cs2Signals): boolean {
	return s.defIndex === TICKET_DEF_INDEX
		|| s.searchName.includes('ticket')
		|| s.searchName.includes('票')
		|| s.internalName.includes('ticket')
		|| s.itemToken.includes('ticket')
		|| s.lootListName.includes('ticket');
}

function isCs2MusicKit(s: Cs2Signals): boolean {
	return s.searchName.includes('音乐盒')
		|| s.searchName.includes('musickit')
		|| s.searchName.includes('music kit')
		|| s.internalName.includes('musickit')
		|| s.lootListName.includes('musickit')
		|| s.imageInventory.includes('music_kits')
		|| s.itemToken.includes('music');
}

function isCs2Capsule(s: Cs2Signals): boolean {
	if (s.searchName.includes('胶囊') || s.searchName.includes('capsule')) {
		return true;
	}
	if (s.searchName.includes('涂鸦箱') || s.searchName.includes('x 射线 包裹') || s.searchName.includes('x-ray package')) {
		return true;
	}
	return s.internalName.includes('capsule')
		|| s.internalName.includes('crate_sprays')
		|| s.internalName.includes('crate_xray')
		|| s.itemToken.includes('capsule')
		|| s.lootListName.includes('capsule')
		|| s.lootListName.includes('crate_sprays')
		|| s.lootListName.includes('crate_xray');
}

function isCs2Weapon(s: Cs2Signals): boolean {
	return s.searchName.includes('武器')
		|| s.searchName.includes('weapon')
		|| s.internalName.includes('weapon')
		|| s.itemToken.includes('weapon')
		|| s.imageInventory.includes('weapon');
}

function isCs2Hat(s: Cs2Signals): boolean {
	return s.searchName.includes('帽')
		|| s.searchName.includes('hat')
		|| s.searchName.includes('头饰')
		|| s.internalName.includes('hat')
		|| s.itemToken.includes('hat')
		|| s.imageInventory.includes('hat');
}

function isCs2Bundle(s: Cs2Signals): boolean {
	return s.searchName.includes('bundle')
		|| s.searchName.includes('套装')
		|| s.internalName.includes('bundle')
		|| s.itemToken.includes('bundle')
		|| s.lootListName.includes('bundle');
}

function isCs2Accessory(s: Cs2Signals): boolean {
	return s.searchName.includes('饰品')
		|| s.searchName.includes('cosmetic')
		|| s.searchName.includes('taunt')
		|| s.internalName.includes('cosmetic')
		|| s.internalName.includes('taunt')
		|| s.itemToken.includes('cosmetic')
		|| s.itemToken.includes('taunt')
		|| s.imageInventory.includes('cosmetic');
}

function mapTf2StoreCategory(rawCategory: string): string {
	if (!rawCategory) {
		return '';
	}
	if (rawCategory.includes('tool')) {
		return '工具';
	}
	if (rawCategory.includes('weapon')) {
		return '武器';
	}
	if (rawCategory.includes('cosmetic')) {
		return '饰品';
	}
	if (rawCategory.includes('bundle')) {
		return '套装';
	}
	if (rawCategory.includes('taunt')) {
		return '饰品';
	}
	return '';
}

function classifyTf2(defIndex: number, name: string, searchName: string, rawCategory: string): Classification {
	const as = (category: string): Classification => ({name, type: category, category});
	if (defIndex === TICKET_DEF_INDEX || searchName.includes('ticket') || searchName.includes('pass') || searchName.includes('票')) {
		return as('票券');
	}
	if (defIndex === TF2_KEY_DEF_INDEX
		|| searchName.includes('key')
		|| searchName.includes('钥匙')
		|| (rawCategory.includes('tool') && searchName.includes('crate'))) {
		return as('钥匙');
	}
	if (searchName.includes('bundle') || searchName.includes('starter pack') || searchName.includes('套装') || rawCategory.includes('bundle')) {
		return as('套装');
	}
	if (['hat', 'helmet', 'hood', 'mask', 'crown', 'cap', '帽'].some(word => searchName.includes(word))) {
		return as('帽子');
	}
	if (rawCategory.includes('weapon')
		|| ['weapon', 'rifle', 'launcher', 'shotgun', 'blaster', 'wrench', 'sword', 'boots'].some(word => searchName.includes(word))) {
		return as('武器');
	}
	if (rawCategory.includes('cosmetic')
		|| rawCategory.includes('taunt')
		|| ['cosmetic', 'taunt', 'paint', 'war paint', '饰品'].some(word => searchName.includes(word))) {
		return as('饰品');
	}
	const mapped = mapTf2StoreCategory(rawCategory);
	return as(mapped || '其他');
}

export interface ClassifyInput {
	game?: unknown;
	defIndex?: number;
	name?: string;
	/** 商店条目或 schema 给的原始分类(TF2 商店条目的 category_tags) */
	category?: string;
	definition?: ItemDefinition | null;
}

/** 按名称和 schema 定义里的各种线索归类:票券、工具、钥匙、音乐盒、胶囊、武器、帽子、套装、饰品、印花、其他 */
export function classifyCatalogItem(input: ClassifyInput): Classification {
	const game = normalizeGame(input.game || 'cs2');
	const defIndex = Number(input.defIndex || 0);
	const definition = input.definition && typeof input.definition === 'object' ? input.definition : null;
	const originalName = String(input.name || '').trim() || `DefIndex ${defIndex || '-'}`;
	const name = normalizeCatalogName(defIndex, originalName, definition);
	const searchName = name.toLowerCase();
	if (game === 'tf2') {
		return classifyTf2(defIndex, name, searchName, lower(input.category));
	}

	const signals: Cs2Signals = {
		defIndex,
		searchName,
		internalName: lower(definition?.name),
		itemToken: lower(definition?.item_name),
		lootListName: lower(definition?.loot_list_name),
		imageInventory: lower(definition?.image_inventory)
	};
	const prefab = lower(definition?.prefab);
	const toolType = lower(definition?.tool?.type);
	const as = (category: string): Classification => ({name, type: category, category});

	if (isCs2Ticket(signals)) {
		return as('票券');
	}
	if (CS2_TOOL_DEF_INDEXES.has(defIndex) || toolType || prefab.includes('tool') || searchName.includes('工具')) {
		return as('工具');
	}
	if (searchName.includes('钥匙') || /\bkey\b/i.test(name)) {
		return as('钥匙');
	}
	if (isCs2MusicKit(signals)) {
		return as('音乐盒');
	}
	if (isCs2Capsule(signals)) {
		return as('胶囊');
	}
	if (isCs2Weapon(signals)) {
		return as('武器');
	}
	if (isCs2Hat(signals)) {
		return as('帽子');
	}
	if (isCs2Bundle(signals)) {
		return as('套装');
	}
	if (isCs2Accessory(signals)) {
		return as('饰品');
	}
	return as(name.includes('印花') ? '印花' : '其他');
}

/**
 * TF2 目录只留曼恩公司钥匙。实时价目表偶尔缺某个币种(如美元账号解析不出 USD 档),
 * 用全币种兜底表补缺:实时价优先,兜底只填空。
 */
export function keepTf2KeyOnly(items: CatalogItem[], log?: (message: string) => void): CatalogItem[] {
	return items
		.filter(item => Number(item.def_index) === TF2_KEY_DEF_INDEX)
		.map(item => {
			const prices = normalizePriceMap({...TF2_KEY_FALLBACK_PRICES, ...item.prices});
			const filled = Object.keys(prices).filter(iso => !(Number(item.prices[iso]) > 0));
			if (filled.length && log) {
				log(`[TF2] Mann Co. Key 价格补缺(实时 sheet 未含): ${filled.join(',')}`);
			}
			return {...item, prices};
		});
}

export interface CatalogItemBuilderOptions {
	schemas: Record<GameId, ItemSchema>;
	describeGcItem: DescribeGcItem;
	logger?: Pick<Console, 'log'>;
}

export function createCatalogItemBuilder(options: CatalogItemBuilderOptions) {
	const {schemas, describeGcItem} = options;
	const logger = options.logger ?? console;
	const nameIndexes: Partial<Record<GameId, Record<string, number>>> = {};
	const definitionNameIndexes: Partial<Record<GameId, Map<string, number>>> = {};

	function schemaFor(game: unknown): ItemSchema {
		return schemas[normalizeGame(game)];
	}

	function describe(schema: ItemSchema, defIndex: number): ItemDescription | null {
		try {
			return describeGcItem(schema, {def_index: defIndex}) ?? null;
		} catch {
			return null;
		}
	}

	/** 小写名称(内部名、#token、class、显示名)→ defIndex,先到先得;每款游戏建一次 */
	function nameIndex(game: unknown): Record<string, number> {
		const id = normalizeGame(game);
		const cached = nameIndexes[id];
		if (cached) {
			return cached;
		}
		const schema = schemaFor(id);
		const index: Record<string, number> = Object.create(null);
		for (const [defIndex, definition] of Object.entries(schema.items || {})) {
			const names = new Set([
				String(definition?.name || '').trim(),
				String(definition?.item_name || '').trim(),
				String(definition?.item_class || '').trim()
			]);
			const details = describe(schema, Number(defIndex));
			names.add(String(details?.name || '').trim());
			names.add(String(details?.definitionDisplayName || '').trim());
			for (const rawName of names) {
				const key = rawName.toLowerCase().replace(/^#/, '');
				if (key && !index[key]) {
					index[key] = Number(defIndex);
				}
			}
		}
		nameIndexes[id] = index;
		return index;
	}

	/** 小写内部名 / 去掉 # 的 item_name → defIndex,按 schema 顺序先到先得 */
	function definitionNameIndex(game: unknown): Map<string, number> {
		const id = normalizeGame(game);
		let index = definitionNameIndexes[id];
		if (!index) {
			index = new Map();
			for (const [defIndex, definition] of Object.entries(schemaFor(id).items || {})) {
				for (const key of [lower(definition?.name), lower(definition?.item_name).replace(/^#/, '')]) {
					if (!index.has(key)) {
						index.set(key, Number(defIndex));
					}
				}
			}
			definitionNameIndexes[id] = index;
		}
		return index;
	}

	/** 商店条目 → defIndex:条目自带的编号字段优先,其次按条目名在 schema 里找(内部名/item_name,再退到显示名) */
	function resolveDefIndex(entryName: string, entry: KvNode | null | undefined, game: unknown): number {
		for (const candidate of [entry?.item_def, entry?.item_def_id, entry?.def_index, entry?.defindex, entry?.item_definition_index]) {
			const numeric = Number(candidate);
			if (Number.isFinite(numeric) && numeric > 0) {
				return numeric;
			}
		}
		const key = lower(entryName);
		if (!key) {
			return 0;
		}
		return definitionNameIndex(game).get(key) ?? Number(nameIndex(game)[key] || 0);
	}

	function buildItem(defIndex: number, prices: PriceMap, entry: KvNode | null = null, entryName = '', game: unknown = 'cs2'): CatalogItem {
		const id = normalizeGame(game);
		const schema = schemaFor(id);
		const details = describeGcItem(schema, {def_index: defIndex});
		const definition = schema.items?.[String(defIndex)] ?? null;
		const entryLabel = String(entryName || entry?.item_link || '').trim();
		const entryCategory = String(entry?.category_tags || '').trim();
		const rawName = details?.name && !/^DefIndex\b/i.test(details.name) ? details.name : (entryLabel || `DefIndex ${defIndex}`);
		// TF2 以商店条目自己的分类为准;CS2 以 schema 为准
		const rawCategory = id === 'tf2' ? (entryCategory || details?.category || '') : (details?.category ? details.category : entryCategory);
		const classified = classifyCatalogItem({game: id, defIndex, name: rawName, category: rawCategory, definition});
		return {
			def_index: Number(defIndex),
			name: classified.name,
			type: classified.type,
			category: classified.category,
			prices: normalizePriceMap(prices)
		};
	}

	/** 解析好的价目表 → 排好序的商品目录(TF2 只留钥匙) */
	function buildCatalog(parsedSheet: {parsed?: unknown} | null | undefined, game: unknown): CatalogItem[] {
		const id = normalizeGame(game);
		const items = extractStorePrices(parsedSheet?.parsed ?? null, (entryName, entry) => resolveDefIndex(entryName, entry, id))
			.map(item => buildItem(item.defIndex, item.prices, item.entry, item.entryName, id));
		items.sort(compareCatalogItems);
		return id === 'tf2' ? keepTf2KeyOnly(items, message => logger.log(message)) : items;
	}

	return {resolveDefIndex, buildItem, buildCatalog};
}

export type CatalogItemBuilder = ReturnType<typeof createCatalogItemBuilder>;
