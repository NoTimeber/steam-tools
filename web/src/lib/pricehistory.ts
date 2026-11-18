// 价格走势的纯逻辑(不依赖 Vue):按时间范围取点、合并成小时 / 6 小时 / 天的桶(价格按成交量加权)、区间统计、坐标轴刻度。
// 点来自后端 GET /api/market/pricehistory(src/market/client.ts 的 PricePoint):time 是时段开始的毫秒(UTC),
// priceCents 是这个时段的成交中位价(钱包币种的分),volume 是售出数量。最近一个月按小时,更早的按天。

export interface PricePoint {
	time: number;
	priceCents: number;
	volume: number;
}

export interface PriceHistory {
	appid: number;
	marketHashName: string;
	currencyISO: string;
	points: PricePoint[];
	cachedAt: number;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export type Bucket = 'hour' | '6h' | 'day';
export type RangeKey = '1d' | '7d' | '30d' | '90d' | '1y' | 'all';

export interface RangeOption {
	key: RangeKey;
	label: string;
	/** 范围长度;全部为 null */
	ms: number | null;
	/** 画图用的桶 */
	bucket: Bucket;
}

/** 24 小时、7 天按小时;30 天按 6 小时;更长按天(Steam 一个月前的数据本来就只有按天的) */
export const RANGES: readonly RangeOption[] = [
	{key: '1d', label: '24小时', ms: DAY_MS, bucket: 'hour'},
	{key: '7d', label: '7天', ms: 7 * DAY_MS, bucket: 'hour'},
	{key: '30d', label: '30天', ms: 30 * DAY_MS, bucket: '6h'},
	{key: '90d', label: '3个月', ms: 90 * DAY_MS, bucket: 'day'},
	{key: '1y', label: '1年', ms: 365 * DAY_MS, bucket: 'day'},
	{key: 'all', label: '全部', ms: null, bucket: 'day'}
];

export const DEFAULT_RANGE: RangeKey = '7d';

export function rangeOption(key: RangeKey): RangeOption {
	return RANGES.find(range => range.key === key) ?? RANGES[1]!;
}

/** 范围内的点(time ≥ now − 范围);全部就是全部 */
export function filterRange(points: readonly PricePoint[], range: RangeOption, now: number): PricePoint[] {
	if (range.ms == null) {
		return [...points];
	}
	const from = now - range.ms;
	return points.filter(point => point.time >= from);
}

export function bucketMs(bucket: Bucket): number {
	return bucket === 'hour' ? HOUR_MS : bucket === '6h' ? 6 * HOUR_MS : DAY_MS;
}

/** 桶的开始时间(按 UTC 对齐,和 Steam 的时段一致) */
export function bucketStart(time: number, bucket: Bucket): number {
	const size = bucketMs(bucket);
	return Math.floor(time / size) * size;
}

/** 合并成桶:价格按成交量加权平均(都没成交量时取平均),数量相加;按时间排好 */
export function aggregate(points: readonly PricePoint[], bucket: Bucket): PricePoint[] {
	const buckets = new Map<number, {weighted: number; volume: number; sum: number; count: number}>();
	for (const point of points) {
		const key = bucketStart(point.time, bucket);
		const entry = buckets.get(key) ?? {weighted: 0, volume: 0, sum: 0, count: 0};
		entry.weighted += point.priceCents * point.volume;
		entry.volume += point.volume;
		entry.sum += point.priceCents;
		entry.count++;
		buckets.set(key, entry);
	}
	return [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([time, entry]) => ({
			time,
			priceCents: Math.round(entry.volume > 0 ? entry.weighted / entry.volume : entry.sum / entry.count),
			volume: entry.volume
		}));
}

export interface PriceSummary {
	/** 最后一个点的价 */
	latest: number;
	/** 区间涨跌:最后一个点 − 第一个点,和百分比 */
	change: number;
	changePercent: number | null;
	high: number;
	low: number;
	totalVolume: number;
	/** 日均售出 */
	dailyVolume: number;
}

/** 区间统计;days 是区间天数(全部时按第一个点到 now 算),没有点为 null */
export function summarize(points: readonly PricePoint[], days?: number): PriceSummary | null {
	if (!points.length) {
		return null;
	}
	const first = points[0]!;
	const last = points[points.length - 1]!;
	const prices = points.map(point => point.priceCents);
	const totalVolume = points.reduce((sum, point) => sum + point.volume, 0);
	const span = days ?? Math.max(1, (last.time - first.time) / DAY_MS);
	return {
		latest: last.priceCents,
		change: last.priceCents - first.priceCents,
		changePercent: first.priceCents > 0 ? (last.priceCents - first.priceCents) / first.priceCents * 100 : null,
		high: Math.max(...prices),
		low: Math.min(...prices),
		totalVolume,
		dailyVolume: totalVolume / Math.max(span, 1 / 24)
	};
}

/** 区间天数:有固定长度用固定长度,全部按第一个点到 now */
export function rangeDays(range: RangeOption, points: readonly PricePoint[], now: number): number {
	if (range.ms != null) {
		return range.ms / DAY_MS;
	}
	return points.length ? Math.max(1, (now - points[0]!.time) / DAY_MS) : 1;
}

/** 好看的刻度(1 / 2 / 5 × 10^n 的步长),覆盖 [min, max];min == max 时上下各放一点 */
export function niceTicks(min: number, max: number, count = 4): number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		return [];
	}
	if (min > max) {
		[min, max] = [max, min];
	}
	if (min === max) {
		const pad = Math.abs(min) * 0.1 || 1;
		min -= pad;
		max += pad;
	}
	const raw = (max - min) / Math.max(1, count);
	const power = 10 ** Math.floor(Math.log10(raw));
	const fraction = raw / power;
	const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
	const start = Math.floor(min / step) * step;
	const end = Math.ceil(max / step) * step;
	const ticks: number[] = [];
	for (let value = start; value <= end + step / 2; value += step) {
		ticks.push(Math.round(value / step) * step);
	}
	return ticks;
}

/** 横轴 / 提示里的时间(本地时间):按小时的给「月-日 时:00」,按天的给「年-月-日」 */
export function formatPointTime(time: number, bucket: Bucket): string {
	const d = new Date(time);
	const pad = (n: number) => String(n).padStart(2, '0');
	const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return bucket === 'day' ? `${d.getFullYear()}-${day}` : `${day} ${pad(d.getHours())}:00`;
}

/** 横轴的短标签:按天的只给「月-日」(跨年的给年) */
export function axisTimeLabel(time: number, bucket: Bucket, spanMs: number): string {
	const d = new Date(time);
	const pad = (n: number) => String(n).padStart(2, '0');
	if (bucket !== 'day') {
		return spanMs <= DAY_MS ? `${pad(d.getHours())}:00` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
	return spanMs > 400 * DAY_MS ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 离 x(毫秒)最近的点的下标;没有点为 -1 */
export function nearestIndex(points: readonly PricePoint[], time: number): number {
	let best = -1;
	let bestGap = Infinity;
	points.forEach((point, index) => {
		const gap = Math.abs(point.time - time);
		if (gap < bestGap) {
			best = index;
			bestGap = gap;
		}
	});
	return best;
}
