'use strict';

// 悠悠有品 CS2 上架定价（按磨损分段对标市场在售价）。
// 纯逻辑，无网络：通过传入的 uu 实例调用 uu.getMarketSaleListWithAbrade(...)。
// 移植自 Steamauto plugins/ExternalUUAutoSell.py 的定价部分：
//   - getAbradeRelatedPrice: 磨损 → 区间 → 查价；查不到货源时逐步放宽磨损上限重试
//   - computePrice: 高价(>阈值)取最低两价择优 / 低价(<=阈值)从第N低取价防恶意低挂
//   - 5 分钟价格缓存（按 templateId + 磨损区间）

// 默认磨损分段（可被 data/uu/abrade-ranges.json 覆盖）。对齐 Steamauto 内置 25 段。
const DEFAULT_ABRADE_RANGES = [
	{min: 0.001, max: 0.01}, {min: 0.01, max: 0.02}, {min: 0.02, max: 0.03},
	{min: 0.03, max: 0.04}, {min: 0.04, max: 0.07}, {min: 0.07, max: 0.08},
	{min: 0.08, max: 0.09}, {min: 0.09, max: 0.10}, {min: 0.10, max: 0.11},
	{min: 0.11, max: 0.15}, {min: 0.15, max: 0.18}, {min: 0.18, max: 0.21},
	{min: 0.21, max: 0.24}, {min: 0.24, max: 0.27}, {min: 0.27, max: 0.38},
	{min: 0.38, max: 0.39}, {min: 0.39, max: 0.40}, {min: 0.40, max: 0.41},
	{min: 0.41, max: 0.42}, {min: 0.42, max: 0.45}, {min: 0.45, max: 0.50},
	{min: 0.50, max: 0.63}, {min: 0.63, max: 0.76}, {min: 0.76, max: 0.9},
	{min: 0.9, max: 1}
];

// 可调参数（对齐 ExternalUUAutoSell.py 顶部）。
const PRICE_DIFF_PERCENTAGE = 0.05;        // 最低两价差距 < 5% 取最低价，否则取第二低
const PRICE_THRESHOLD = 10.0;              // 高/低价分流阈值（元）
const LOW_PRICE_STRATEGY_START_INDEX = 2;  // 低价物品从排序列表第 3 低开始取价
const CACHE_TTL_MS = 5 * 60 * 1000;

const round2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class UuPriceEngine {
	/**
	 * @param {object} [opts]
	 * @param {Array<{min:number,max:number}>} [opts.ranges] 覆盖磨损分段
	 * @param {function} [opts.logger] (level, message) => void
	 * @param {object} [opts.params] 覆盖 {priceThreshold, priceDiffPercentage, lowPriceStartIndex}
	 */
	constructor(opts = {}) {
		this.ranges = Array.isArray(opts.ranges) && opts.ranges.length ? opts.ranges : DEFAULT_ABRADE_RANGES;
		this.log = typeof opts.logger === 'function' ? opts.logger : () => {};
		const p = opts.params || {};
		this.priceThreshold = p.priceThreshold != null ? p.priceThreshold : PRICE_THRESHOLD;
		this.priceDiffPercentage = p.priceDiffPercentage != null ? p.priceDiffPercentage : PRICE_DIFF_PERCENTAGE;
		this.lowPriceStartIndex = p.lowPriceStartIndex != null ? p.lowPriceStartIndex : LOW_PRICE_STRATEGY_START_INDEX;
		// 市场查价限频：每次“真实查价”(缓存未命中)前等待，避开 UU 的“操作太频繁”限流。
		// 实测 CS2 市场查价接口限流较严，对齐 Steamauto operate_sleep(5~15s)。{min,max} 取随机；
		// 也兼容传单个数字 requestGapMs。默认 0（单测/调用方自行控速时不阻塞）。
		const gap = p.requestGap || (p.requestGapMs != null ? {min: p.requestGapMs, max: p.requestGapMs} : null);
		this.requestGapMin = gap ? (gap.min || 0) : 0;
		this.requestGapMax = gap ? (gap.max != null ? gap.max : gap.min || 0) : 0;
		this.cache = new Map(); // key: templateId|min|max -> {price, name, time}
	}

	async _throttle() {
		if (this.requestGapMax <= 0) return;
		const ms = this.requestGapMin + Math.floor(Math.random() * (this.requestGapMax - this.requestGapMin + 1));
		if (ms > 0) {
			this.log('debug', `查价限频：等待 ${ms}ms`);
			await sleep(ms);
		}
	}

	// 在售价列表 -> 最终定价。saleList: [{price, commodityName}]。返回 0 表示无有效价。
	computePrice(saleList, commodityName) {
		const prices = (saleList || [])
			.map(c => parseFloat(c.price))
			.filter(p => Number.isFinite(p) && p > 0);
		if (prices.length === 0) return 0;
		if (prices.length === 1) return round2(prices[0]);

		prices.sort((a, b) => a - b);
		const base = prices[0];
		let price;
		if (base > this.priceThreshold) {
			// 高价：比较最低两价，差距小取最低，差距大取第二低
			price = prices[1] < prices[0] * (1 + this.priceDiffPercentage) ? prices[0] : prices[1];
			this.log('debug', `${commodityName || ''} 高价策略 -> ${price}`);
		} else if (this.lowPriceStartIndex < prices.length) {
			// 低价：从第 N 低取价，避开恶意超低挂单
			price = prices[this.lowPriceStartIndex];
			this.log('debug', `${commodityName || ''} 低价策略(索引${this.lowPriceStartIndex}) -> ${price}`);
		} else {
			price = prices[prices.length - 1];
			this.log('debug', `${commodityName || ''} 低价策略索引越界，取最高 -> ${price}`);
		}
		return round2(price);
	}

	// 查某磨损区间的定价（带缓存）。templateId 为 UU 模板 id。
	async getMarketSalePrice(uu, templateId, {abradeMin = null, abradeMax = null, goodName = ''} = {}) {
		const key = `${templateId}|${abradeMin}|${abradeMax}`;
		const hit = this.cache.get(key);
		if (hit && Date.now() - hit.time <= CACHE_TTL_MS) {
			this.log('debug', `${hit.name || goodName} 命中价格缓存 -> ${hit.price}`);
			return hit.price;
		}

		await this._throttle();
		const list = await uu.getMarketSaleListWithAbrade(templateId, {pageSize: 20, minAbrade: abradeMin, maxAbrade: abradeMax});
		if (!list || list.length === 0) {
			this.log('debug', `${goodName} 磨损 ${abradeMin}-${abradeMax} 市场无在售`);
			return 0;
		}
		const name = list[0].commodityName || goodName;
		const price = this.computePrice(list, name);
		if (price > 0) this.cache.set(key, {price, name, time: Date.now()});
		return price;
	}

	_findRangeIndex(abrade) {
		for (let i = 0; i < this.ranges.length; i++) {
			if (this.ranges[i].min <= abrade && abrade < this.ranges[i].max) return i;
		}
		return -1;
	}

	/**
	 * 磨损 -> 区间 -> 价格。区间内无货源则逐步放宽磨损上限重试。返回 0 表示放弃（不应上架）。
	 * 对齐 ExternalUUAutoSell.getAbradeRelatedPrice。
	 */
	async getAbradeRelatedPrice(uu, templateId, goodName, abrade) {
		abrade = parseFloat(abrade);
		if (!Number.isFinite(abrade)) {
			this.log('warn', `${goodName} 磨损值无效(${abrade})，不会上架`);
			return 0;
		}
		let move = 0;
		// 防御性上限：区间数 + 缓冲，避免异常死循环
		for (let guard = 0; guard < this.ranges.length + 5; guard++) {
			const idx = this._findRangeIndex(abrade);
			if (idx === -1) {
				this.log('warn', `未匹配到 ${goodName} (磨损 ${abrade}) 的磨损区间，不会上架`);
				return 0;
			}
			const range = this.ranges[idx];
			let abradeMin = range.min;
			let abradeMax = range.max;
			if (move !== 0) {
				const targetIndex = Math.max(0, idx + move);
				const target = this.ranges[targetIndex];
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
			if (price > 0) return price;

			if (move !== -1) {
				move += 1; // 放宽磨损上限再试
			} else {
				this.log('warn', `未找到 ${goodName} 的磨损段价格，不会上架`);
				return 0;
			}
		}
		this.log('warn', `${goodName} 放宽磨损区间仍无价，放弃`);
		return 0;
	}
}

module.exports = {
	UuPriceEngine,
	DEFAULT_ABRADE_RANGES,
	PRICE_DIFF_PERCENTAGE,
	PRICE_THRESHOLD,
	LOW_PRICE_STRATEGY_START_INDEX,
	round2
};
