// GC 商店价目表(StoreGetUserDataResponse.price_sheet)的解码与价格提取(从 app/server.js 原样移来)。
// 只做纯计算:解压 + BinaryKV 解析 + 从各种节点形状里抽出 {币种: 分} 价格表。
// 条目名 → defIndex 依赖物品 schema,由调用方通过 resolveDefIndex 回调提供。

import {createRequire} from 'node:module';
import {CURRENCY_ISO_TO_COUNTRY} from './currencies.ts';

const require = createRequire(import.meta.url);
const lzma = require('lzma-native') as {decompress(input: Buffer): Promise<Buffer | Uint8Array>};
const BinaryKvParser = require('binarykvparser') as {parse(input: Buffer): unknown};

// 价目表里认作币种的键。CURRENCY_ISO_TO_COUNTRY 故意不含 USD(USD 推不出国家),
// 旧代码直接拿它当白名单,导致商品节点上直接写的 USD 价格被丢掉;这里补上 USD。
const PRICE_CURRENCIES: ReadonlySet<string> = new Set([...Object.keys(CURRENCY_ISO_TO_COUNTRY), 'USD']);

export type KvNode = Record<string, unknown>;
/** 币种 ISO → 价格(最小货币单位,如美分) */
export type PriceMap = Record<string, number>;

export interface DecodedPriceSheet {
	parsed: KvNode;
	/** raw-binarykv / valve-lzma-binarykv / lzma-binarykv / raw-binarykv-fallback */
	source: string;
	/** 解压后的 BinaryKV 字节(落盘留样用) */
	sourceBuffer: Buffer;
}

export interface StorePriceItem {
	defIndex: number;
	prices: PriceMap;
	/** 来自 store.entries 的条目;只在其它节点里找到价格的为 null */
	entry: KvNode | null;
	entryName: string;
}

function priceSheetError(message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode: 502});
}

function isObject(value: unknown): value is KvNode {
	return !!value && typeof value === 'object';
}

function parseKv(buffer: Buffer): KvNode {
	return BinaryKvParser.parse(buffer) as KvNode;
}

async function lzmaDecompress(input: Buffer): Promise<Buffer> {
	const output = await lzma.decompress(input);
	return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

/**
 * 解码 price_sheet。GC 回包有三种形态:
 *   - 首字节 0:未压缩的 BinaryKV;
 *   - "LZMA" 开头:Valve 自定义头(魔数 + 解压后大小 u32 + 压缩后大小 u32 + 5 字节属性 + 数据),
 *     需要改写成标准 .lzma 头再解压;
 *   - 其它:当作标准 .lzma / xz 直接解压。
 * 解压失败时退回按未压缩 BinaryKV 解析,都失败抛 statusCode=502 的错误。
 */
export async function decodePriceSheet(raw: Buffer): Promise<DecodedPriceSheet> {
	if (!raw || !raw.length) {
		throw priceSheetError('GC 返回的 price_sheet 为空');
	}

	if (raw[0] === 0) {
		return {parsed: parseKv(raw), source: 'raw-binarykv', sourceBuffer: raw};
	}

	if (raw.subarray(0, 4).toString('ascii') === 'LZMA' && raw.length > 17) {
		try {
			const declaredSize = raw.readUInt32LE(4);
			const properties = raw.subarray(12, 17);
			const compressedData = raw.subarray(17);
			const uncompressedSizeBuffer = Buffer.alloc(8);
			uncompressedSizeBuffer.writeUInt32LE(declaredSize, 0);
			uncompressedSizeBuffer.writeUInt32LE(0, 4);
			const buffer = await lzmaDecompress(Buffer.concat([properties, uncompressedSizeBuffer, compressedData]));
			return {parsed: parseKv(buffer), source: 'valve-lzma-binarykv', sourceBuffer: buffer};
		} catch (valveLzmaError) {
			try {
				return {parsed: parseKv(raw), source: 'raw-binarykv-fallback', sourceBuffer: raw};
			} catch (rawError) {
				throw priceSheetError(`price_sheet 解析失败: ${(valveLzmaError as Error).message}; raw fallback: ${(rawError as Error).message}`);
			}
		}
	}

	try {
		const buffer = await lzmaDecompress(raw);
		return {parsed: parseKv(buffer), source: 'lzma-binarykv', sourceBuffer: buffer};
	} catch (lzmaError) {
		try {
			return {parsed: parseKv(raw), source: 'raw-binarykv-fallback', sourceBuffer: raw};
		} catch (rawError) {
			throw priceSheetError(`price_sheet 解析失败: ${(lzmaError as Error).message}; raw fallback: ${(rawError as Error).message}`);
		}
	}
}

/** 价格值可能是 number / string / bigint / protobuf Long({low, high});统一成整数,非法为 0 */
export function normalizePriceValue(value: unknown): number {
	if (value == null || value === '') {
		return 0;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? Math.round(value) : 0;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? Math.round(parsed) : 0;
	}
	if (typeof value === 'object') {
		const long = value as {low?: unknown; high?: unknown; toString?: () => string};
		if (typeof long.low === 'number' && typeof long.high === 'number') {
			const low = BigInt(long.low >>> 0);
			const high = BigInt(long.high >>> 0);
			return Number((high << 32n) | low);
		}
		if (typeof long.toString === 'function' && long.toString !== Object.prototype.toString) {
			const parsed = Number(long.toString());
			return Number.isFinite(parsed) ? Math.round(parsed) : 0;
		}
	}
	return 0;
}

/** 只保留键为非空币种、值为正数的项,币种转大写 */
export function normalizePriceMap(prices: unknown): PriceMap {
	const normalized: PriceMap = {};
	for (const [key, value] of Object.entries(isObject(prices) ? prices : {})) {
		const iso = String(key || '').trim().toUpperCase();
		const cents = normalizePriceValue(value);
		if (iso && Number.isFinite(cents) && cents > 0) {
			normalized[iso] = cents;
		}
	}
	return normalized;
}

// 价目档位(base_price 等)→ 各币种价格:inventoryvalvegcpricesheet[档位] = {ISO: 分}
function applyLocalPriceTier(prices: PriceMap, tier: unknown, localPriceSheet: KvNode): void {
	const numeric = Number(tier);
	if (!(numeric > 0)) {
		return;
	}
	const mapped = localPriceSheet[String(numeric)];
	if (!isObject(mapped)) {
		return;
	}
	for (const [iso, value] of Object.entries(mapped)) {
		const cents = normalizePriceValue(value);
		if (Number.isFinite(cents) && cents > 0) {
			prices[String(iso).trim().toUpperCase()] = cents;
		}
	}
}

/** 从一个节点里抽价格:节点自身的币种键、prices 子表、base_price 等档位映射 */
export function extractPriceMapFromNode(node: unknown, localPriceSheet: KvNode): PriceMap {
	const prices: PriceMap = {};
	if (!isObject(node)) {
		return prices;
	}
	for (const [key, value] of Object.entries(node)) {
		const iso = String(key || '').trim().toUpperCase();
		const cents = normalizePriceValue(value);
		if (PRICE_CURRENCIES.has(iso) && Number.isFinite(cents) && cents > 0) {
			prices[iso] = cents;
		}
	}
	if (isObject(node.prices)) {
		Object.assign(prices, normalizePriceMap(node.prices));
	}
	for (const tier of [node.base_price, node.price, node.regular_price, node.current_price]) {
		applyLocalPriceTier(prices, tier, localPriceSheet);
	}
	return normalizePriceMap(prices);
}

/** 深度遍历整棵树,凡是带 defIndex 字段且能抽出价格的节点都收集起来(同一 defIndex 合并) */
export function collectPriceSheetItemPrices(root: unknown, localPriceSheet: KvNode): Map<number, PriceMap> {
	const map = new Map<number, PriceMap>();
	const visit = (value: unknown, depth: number): void => {
		if (!isObject(value) || depth > 12) {
			return;
		}
		const defIndex = Number(
			value.item_def
			|| value.item_def_id
			|| value.def_index
			|| value.defindex
			|| value.item_definition_index
			|| value.itemdef
			|| value.id
		);
		if (defIndex > 0) {
			const prices = extractPriceMapFromNode(value, localPriceSheet);
			if (Object.keys(prices).length) {
				map.set(defIndex, {...(map.get(defIndex) || {}), ...prices});
			}
		}
		for (const child of Object.values(value)) {
			visit(child, depth + 1);
		}
	};
	visit(root, 0);
	return map;
}

/** 一个商店条目的价格:先用遍历时收集到的,再叠加条目自带 prices 和档位映射 */
export function resolvePricesForStoreEntry(entry: unknown, localPriceSheet: KvNode, directPrices: PriceMap | null = null): PriceMap {
	const prices: PriceMap = directPrices ? {...directPrices} : {};
	const node = isObject(entry) ? entry : null;
	if (node && isObject(node.prices)) {
		Object.assign(prices, normalizePriceMap(node.prices));
	}
	if (node) {
		applyLocalPriceTier(prices, Number(node.base_price || node.price || node.regular_price || node.current_price), localPriceSheet);
	}
	return normalizePriceMap(prices);
}

/**
 * 从解析后的价目表里取出所有有价格的商品:先按 store.entries 的顺序(条目名经 resolveDefIndex 换成 defIndex),
 * 再补上只在其它节点里出现的 defIndex。同一 defIndex 只取第一次。
 */
export function extractStorePrices(parsed: unknown, resolveDefIndex: (entryName: string, entry: KvNode) => number): StorePriceItem[] {
	const root = isObject(parsed) ? parsed : null;
	const store = root && isObject(root.store) ? root.store : root;
	const entries = store && isObject(store.entries) ? store.entries : {};
	const localPriceSheet = store && isObject(store.inventoryvalvegcpricesheet) ? store.inventoryvalvegcpricesheet : {};
	const directItems = collectPriceSheetItemPrices(root, localPriceSheet);
	const items: StorePriceItem[] = [];
	const seen = new Set<number>();

	for (const [entryName, entry] of Object.entries(entries)) {
		const node = isObject(entry) ? entry : {};
		const defIndex = resolveDefIndex(entryName, node);
		if (!defIndex || seen.has(defIndex)) {
			continue;
		}
		const prices = resolvePricesForStoreEntry(entry, localPriceSheet, directItems.get(defIndex) || null);
		if (!Object.keys(prices).length) {
			continue;
		}
		items.push({defIndex, prices, entry: node, entryName});
		seen.add(defIndex);
	}

	for (const [defIndex, prices] of directItems.entries()) {
		if (seen.has(defIndex) || !Object.keys(prices).length) {
			continue;
		}
		items.push({defIndex, prices, entry: null, entryName: ''});
		seen.add(defIndex);
	}
	return items;
}
