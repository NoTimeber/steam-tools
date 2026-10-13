// 悠悠有品 CS2 上架定价:按磨损分段对标市场在售价(从 app/lib/uu-pricing.js 移来,
// 移植自 Steamauto plugins/ExternalUUAutoSell.py 的定价部分)。
//   - getAbradeRelatedPrice:磨损 → 区间 → 查价;区间内没货就逐步放宽磨损上限重试;
//   - computePrice:高价(> 阈值)比较最低两价择优;低价从第 N 低取价,避开恶意超低挂单;
//   - 同一模板 + 磨损区间的价格缓存 5 分钟。

import type {UuMarketSale} from './client.ts';

export interface AbradeRange {
	min: number;
	max: number;
}

// 对齐 Steamauto 内置的 25 段
export const DEFAULT_ABRADE_RANGES: readonly AbradeRange[] = Object.freeze([
	{min: 0.001, max: 0.01}, {min: 0.01, max: 0.02}, {min: 0.02, max: 0.03},
	{min: 0.03, max: 0.04}, {min: 0.04, max: 0.07}, {min: 0.07, max: 0.08},
	{min: 0.08, max: 0.09}, {min: 0.09, max: 0.10}, {min: 0.10, max: 0.11},
	{min: 0.11, max: 0.15}, {min: 0.15, max: 0.18}, {min: 0.18, max: 0.21},
	{min: 0.21, max: 0.24}, {min: 0.24, max: 0.27}, {min: 0.27, max: 0.38},
	{min: 0.38, max: 0.39}, {min: 0.39, max: 0.40}, {min: 0.40, max: 0.41},
	{min: 0.41, max: 0.42}, {min: 0.42, max: 0.45}, {min: 0.45, max: 0.50},
	{min: 0.50, max: 0.63}, {min: 0.63, max: 0.76}, {min: 0.76, max: 0.9},
	{min: 0.9, max: 1}
]);

export const PRICE_DIFF_PERCENTAGE = 0.05;        // 最低两价差距 < 5% 取最低价,否则取第二低
export const PRICE_THRESHOLD = 10.0;              // 高/低价分流阈值(元)
export const LOW_PRICE_STRATEGY_START_INDEX = 2;  // 低价物品从排序后第 3 低开始取价
const CACHE_TTL_MS = 5 * 60 * 1000;

export const round2 = (x: unknown): number => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 查市场在售价需要的 UU 客户端能力 */
export interface MarketQuery {
	getMarketSaleListWithAbrade(templateId: string | number, opts: {pageSize?: number; minAbrade?: number | null; maxAbrade?: number | null}): Promise<UuMarketSale[]>;
}

export interface PriceEngineOptions {
	ranges?: AbradeRange[];
	logger?: (level: string, message: string) => void;
	params?: {
		priceThreshold?: number;
		priceDiffPercentage?: number;
		lowPriceStartIndex?: number;
		/** 每次真实查价(缓存未命中)前随机等待 min~max 毫秒,避开 UU 限流 */
		requestGap?: {min?: number; max?: number};
		requestGapMs?: number;
	};
}

export class UuPriceEngine {
	readonly ranges: readonly AbradeRange[];
	readonly priceThreshold: number;
	readonly priceDiffPercentage: number;
	readonly lowPriceStartIndex: number;
	readonly requestGapMin: number;
	readonly requestGapMax: number;
	private readonly log: (level: string, message: string) => void;
	private readonly cache = new Map<string, {price: number; name: string; time: number}>();

	constructor(opts: PriceEngineOptions = {}) {
		this.ranges = Array.isArray(opts.ranges) && opts.ranges.length ? opts.ranges : DEFAULT_ABRADE_RANGES;
		this.log = typeof opts.logger === 'function' ? opts.logger : () => {};
		const p = opts.params || {};
		this.priceThreshold = p.priceThreshold != null ? p.priceThreshold : PRICE_THRESHOLD;
		this.priceDiffPercentage = p.priceDiffPercentage != null ? p.priceDiffPercentage : PRICE_DIFF_PERCENTAGE;
		this.lowPriceStartIndex = p.lowPriceStartIndex != null ? p.lowPriceStartIndex : LOW_PRICE_STRATEGY_START_INDEX;
		// CS2 市场查价接口限流较严,对齐 Steamauto operate_sleep;默认 0(调用方自己控速时不阻塞)
		const gap = p.requestGap || (p.requestGapMs != null ? {min: p.requestGapMs, max: p.requestGapMs} : null);
		this.requestGapMin = gap ? (gap.min || 0) : 0;
		this.requestGapMax = gap ? (gap.max != null ? gap.max : gap.min || 0) : 0;
	}

	private async throttle(): Promise<void> {
		if (this.requestGapMax <= 0) {
			return;
		}
		const ms = this.requestGapMin + Math.floor(Math.random() * (this.requestGapMax - this.requestGapMin + 1));
		if (ms > 0) {
			this.log('debug', `查价限频：等待 ${ms}ms`);
			await sleep(ms);
		}
	}

	/** 在售价列表 → 最终定价;0 表示没有有效价 */
	computePrice(saleList: UuMarketSale[] | null | undefined, commodityName?: string): number {
		const prices = (saleList || [])
			.map(sale => parseFloat(String(sale.price)))
			.filter(price => Number.isFinite(price) && price > 0);
		if (prices.length === 0) {
			return 0;
		}
		if (prices.length === 1) {
			return round2(prices[0]);
		}
		prices.sort((a, b) => a - b);
		const lowest = prices[0] as number;
		const second = prices[1] as number;
		let price: number;
		if (lowest > this.priceThreshold) {
			price = second < lowest * (1 + this.priceDiffPercentage) ? lowest : second;
			this.log('debug', `${commodityName || ''} 高价策略 -> ${price}`);
		} else if (this.lowPriceStartIndex < prices.length) {
			price = prices[this.lowPriceStartIndex] as number;
			this.log('debug', `${commodityName || ''} 低价策略(索引${this.lowPriceStartIndex}) -> ${price}`);
		} else {
			price = prices[prices.length - 1] as number;
			this.log('debug', `${commodityName || ''} 低价策略索引越界，取最高 -> ${price}`);
		}
		return round2(price);
	}

	/** 某磨损区间的定价(带缓存) */
	async getMarketSalePrice(uu: MarketQuery, templateId: string | number, {abradeMin = null, abradeMax = null, goodName = ''}: {
		abradeMin?: number | null;
		abradeMax?: number | null;
		goodName?: string;
	} = {}): Promise<number> {
		const key = `${templateId}|${abradeMin}|${abradeMax}`;
		const hit = this.cache.get(key);
		if (hit && Date.now() - hit.time <= CACHE_TTL_MS) {
			this.log('debug', `${hit.name || goodName} 命中价格缓存 -> ${hit.price}`);
			return hit.price;
		}
		await this.throttle();
		const list = await uu.getMarketSaleListWithAbrade(templateId, {pageSize: 20, minAbrade: abradeMin, maxAbrade: abradeMax});
		if (!list || list.length === 0) {
			this.log('debug', `${goodName} 磨损 ${abradeMin}-${abradeMax} 市场无在售`);
			return 0;
		}
		const name = list[0]?.commodityName || goodName;
		const price = this.computePrice(list, name);
		if (price > 0) {
			this.cache.set(key, {price, name, time: Date.now()});
		}
		return price;
	}

	private findRangeIndex(abrade: number): number {
		return this.ranges.findIndex(range => range.min <= abrade && abrade < range.max);
	}

	/** 磨损 → 区间 → 价格;区间内没货就逐步放宽磨损上限。0 表示放弃(不该上架) */
	async getAbradeRelatedPrice(uu: MarketQuery, templateId: string | number, goodName: string, abradeInput: unknown): Promise<number> {
		const abrade = parseFloat(String(abradeInput));
		if (!Number.isFinite(abrade)) {
			this.log('warn', `${goodName} 磨损值无效(${abrade})，不会上架`);
			return 0;
		}
		let move = 0;
		for (let guard = 0; guard < this.ranges.length + 5; guard++) {
			const index = this.findRangeIndex(abrade);
			if (index === -1) {
				this.log('warn', `未匹配到 ${goodName} (磨损 ${abrade}) 的磨损区间，不会上架`);
				return 0;
			}
			const range = this.ranges[index] as AbradeRange;
			const abradeMin = range.min;
			let abradeMax = range.max;
			if (move !== 0) {
				const target = this.ranges[Math.max(0, index + move)];
				if (!target) {
					move = -1;
					abradeMax = 1;
				} else {
					abradeMax = target.max;
					if (abradeMax > 1) {
						abradeMax = 1;
						move = -1;
					}
				}
			}
			const price = await this.getMarketSalePrice(uu, templateId, {abradeMin, abradeMax, goodName});
			if (price > 0) {
				return price;
			}
			if (move !== -1) {
				move += 1;
			} else {
				this.log('warn', `未找到 ${goodName} 的磨损段价格，不会上架`);
				return 0;
			}
		}
		this.log('warn', `${goodName} 放宽磨损区间仍无价，放弃`);
		return 0;
	}
}
