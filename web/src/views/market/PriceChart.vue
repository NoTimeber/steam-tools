<script setup lang="ts">
// 价格走势:上面是成交中位价的折线,下面是售出数量的柱子,共用时间轴(两个面板各自的纵轴,不做双纵轴)。
// 时间范围 24小时 / 7天 / 30天 / 3个月 / 1年 / 全部;鼠标移上去有十字线和提示。给了 markPriceCents 时画一条虚线(我的价)。
// 只用 SVG 画,宽度跟着容器(ResizeObserver);颜色全用主题变量,深色模式也能看。数据挂载时才查(./stores/pricehistory.ts 缓存)。
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {NAlert, NButton, NRadioButton, NRadioGroup, NSpin} from 'naive-ui';
import {formatCentsIn} from '../../lib/market.ts';
import {
	aggregate, axisTimeLabel, bucketMs, DEFAULT_RANGE, filterRange, formatPointTime, nearestIndex, niceTicks, rangeDays, rangeOption, RANGES, summarize
} from '../../lib/pricehistory.ts';
import type {PricePoint, RangeKey} from '../../lib/pricehistory.ts';
import {historyKey, loadPriceHistory, priceHistories} from '../../stores/pricehistory.ts';

const props = withDefaults(defineProps<{
	/** 账号名或 attemptId(按它的钱包币种查) */
	account: string;
	appid: number;
	marketHashName: string;
	/** 钱包币种 id(显示符号用);不知道就用 ISO 代码 */
	currencyId?: number | null;
	currencyIso?: string;
	/** 参考价(买家价,分),画成虚线 */
	markPriceCents?: number | null;
}>(), {currencyId: null, currencyIso: '', markPriceCents: null});

const range = ref<RangeKey>(DEFAULT_RANGE);

// ===== 数据 =====
const entry = computed(() => (props.account ? priceHistories[historyKey(props.account, props.appid, props.marketHashName)] : undefined));

function load(refresh = false): void {
	if (props.account && props.marketHashName) {
		void loadPriceHistory(props.account, props.appid, props.marketHashName, refresh);
	}
}

watch(() => [props.account, props.appid, props.marketHashName], () => load(), {immediate: true});

const iso = computed(() => props.currencyIso || entry.value?.data?.currencyISO || '');

function money(cents: number | null | undefined): string {
	if (cents == null) {
		return '—';
	}
	return props.currencyId != null ? formatCentsIn(cents, props.currencyId, iso.value) : `${iso.value ? iso.value + ' ' : ''}${(cents / 100).toFixed(2)}`;
}

const option = computed(() => rangeOption(range.value));
/** 统一的「现在」,范围变了才重算 */
const now = computed(() => {
	void range.value;
	void entry.value?.data?.cachedAt;
	return Date.now();
});
const points = computed<PricePoint[]>(() => aggregate(filterRange(entry.value?.data?.points ?? [], option.value, now.value), option.value.bucket));
const summary = computed(() => summarize(points.value, rangeDays(option.value, points.value, now.value)));

// ===== 尺寸 =====
const box = ref<HTMLElement | null>(null);
const width = ref(600);
let observer: ResizeObserver | null = null;

onMounted(() => {
	if (box.value) {
		width.value = box.value.clientWidth || 600;
		observer = new ResizeObserver(entries => {
			width.value = Math.max(280, Math.round(entries[0]?.contentRect.width ?? width.value));
		});
		observer.observe(box.value);
	}
});
onBeforeUnmount(() => observer?.disconnect());

const PAD_L = 58;
const PAD_R = 12;
const TOP = 10;
const PRICE_H = 150;
const GAP = 16;
const VOL_H = 60;
const AXIS_H = 20;
const HEIGHT = TOP + PRICE_H + GAP + VOL_H + AXIS_H;
const VOL_TOP = TOP + PRICE_H + GAP;
const VOL_BASE = VOL_TOP + VOL_H;

const plotW = computed(() => Math.max(10, width.value - PAD_L - PAD_R));

// ===== 比例尺 =====
const step = computed(() => bucketMs(option.value.bucket));
const timeDomain = computed<[number, number]>(() => {
	const list = points.value;
	const end = now.value;
	if (option.value.ms != null) {
		return [end - option.value.ms, end];
	}
	return list.length ? [list[0]!.time, Math.max(end, list[list.length - 1]!.time + step.value)] : [end - 30 * 86_400_000, end];
});

function x(time: number): number {
	const [t0, t1] = timeDomain.value;
	return PAD_L + (time - t0) / Math.max(1, t1 - t0) * plotW.value;
}

const priceTicks = computed(() => {
	const prices = points.value.map(point => point.priceCents);
	if (props.markPriceCents != null && props.markPriceCents > 0) {
		prices.push(props.markPriceCents);
	}
	return prices.length ? niceTicks(Math.min(...prices), Math.max(...prices), 4) : [];
});

function yPrice(cents: number): number {
	const ticks = priceTicks.value;
	const lo = ticks[0] ?? 0;
	const hi = ticks[ticks.length - 1] ?? 1;
	return TOP + PRICE_H - (cents - lo) / Math.max(1e-9, hi - lo) * PRICE_H;
}

const volTicks = computed(() => niceTicks(0, Math.max(1, ...points.value.map(point => point.volume)), 2));

function yVol(volume: number): number {
	const hi = volTicks.value[volTicks.value.length - 1] ?? 1;
	return VOL_BASE - volume / Math.max(1, hi) * VOL_H;
}

// ===== 图形 =====
/** 折线;两点之间隔了 3 个桶以上(那段时间没成交)就断开 */
const linePath = computed(() => {
	let path = '';
	let previous: PricePoint | null = null;
	for (const point of points.value) {
		const center = x(point.time + step.value / 2);
		const cmd = !previous || point.time - previous.time > 3 * step.value ? 'M' : 'L';
		path += `${cmd}${center.toFixed(1)},${yPrice(point.priceCents).toFixed(1)}`;
		previous = point;
	}
	return path;
});

/** 柱子:贴着底线,顶上小圆角,相邻留 1px 空 */
const bars = computed(() => points.value.map((point, index) => {
	const left = x(point.time);
	const w = Math.max(1, x(point.time + step.value) - left - 1);
	const top = yVol(point.volume);
	const h = VOL_BASE - top;
	const r = Math.min(2, w / 2, h);
	const d = h <= 0 ? '' : `M${left},${VOL_BASE}V${top + r}Q${left},${top} ${left + r},${top}H${left + w - r}Q${left + w},${top} ${left + w},${top + r}V${VOL_BASE}Z`;
	return {index, d};
}));

const timeTicks = computed(() => {
	const [t0, t1] = timeDomain.value;
	const count = Math.max(2, Math.min(6, Math.floor(plotW.value / 110)));
	return Array.from({length: count + 1}, (_, i) => t0 + (t1 - t0) * i / count)
		.map(time => ({x: x(time), label: axisTimeLabel(time, option.value.bucket, t1 - t0)}));
});

const markY = computed(() => (props.markPriceCents != null && props.markPriceCents > 0 && points.value.length ? yPrice(props.markPriceCents) : null));

// ===== 悬停 =====
const hover = ref(-1);

function onMove(event: MouseEvent): void {
	const svg = event.currentTarget as SVGElement;
	const rect = svg.getBoundingClientRect();
	const px = (event.clientX - rect.left) * (width.value / Math.max(1, rect.width));
	const [t0, t1] = timeDomain.value;
	const time = t0 + (px - PAD_L) / plotW.value * (t1 - t0) - step.value / 2;
	hover.value = nearestIndex(points.value, time);
}

const hovered = computed(() => (hover.value >= 0 ? points.value[hover.value] ?? null : null));
const hoverX = computed(() => (hovered.value ? x(hovered.value.time + step.value / 2) : 0));
const tooltipStyle = computed(() => {
	const left = hoverX.value + 180 > width.value ? hoverX.value - 170 : hoverX.value + 10;
	return {left: `${Math.max(0, left)}px`, top: `${TOP}px`};
});

function changeText(): string {
	const s = summary.value;
	if (!s) return '—';
	const sign = s.change > 0 ? '+' : s.change < 0 ? '−' : '';
	const pct = s.changePercent == null ? '' : `(${sign}${Math.abs(s.changePercent).toFixed(1)}%)`;
	return `${sign}${money(Math.abs(s.change))}${pct}`;
}
</script>

<template>
	<div class="price-chart">
		<div class="chart-head">
			<NRadioGroup v-model:value="range" size="small">
				<NRadioButton v-for="item in RANGES" :key="item.key" :value="item.key">{{ item.label }}</NRadioButton>
			</NRadioGroup>
			<NButton size="small" quaternary :loading="entry?.loading" @click="load(true)">刷新</NButton>
		</div>
		<div v-if="summary" class="chart-summary">
			<span>最新成交价 <strong>{{ money(summary.latest) }}</strong></span>
			<span>区间涨跌 <strong>{{ changeText() }}</strong></span>
			<span>最高 / 最低 <strong>{{ money(summary.high) }}</strong> / <strong>{{ money(summary.low) }}</strong></span>
			<span>总售出 <strong>{{ summary.totalVolume }}</strong></span>
			<span>日均售出 <strong>{{ summary.dailyVolume >= 10 ? Math.round(summary.dailyVolume) : summary.dailyVolume.toFixed(1) }}</strong></span>
		</div>
		<NAlert v-if="entry?.error" type="error" :bordered="false" class="chart-error">价格走势获取失败:{{ entry.error }}</NAlert>
		<div ref="box" class="chart-box">
			<NSpin :show="!!entry?.loading && !entry?.data" size="small">
				<svg
					v-if="points.length"
					:width="width"
					:height="HEIGHT"
					:viewBox="`0 0 ${width} ${HEIGHT}`"
					role="img"
					:aria-label="`价格走势:${option.label}内 ${points.length} 个时段`"
					@mousemove="onMove"
					@mouseleave="hover = -1"
				>
					<!-- 价格面板 -->
					<g class="grid">
						<line v-for="tick in priceTicks" :key="`p${tick}`" :x1="PAD_L" :x2="width - PAD_R" :y1="yPrice(tick)" :y2="yPrice(tick)" />
						<line v-for="tick in volTicks" :key="`v${tick}`" :x1="PAD_L" :x2="width - PAD_R" :y1="yVol(tick)" :y2="yVol(tick)" />
					</g>
					<g class="axis-text">
						<text v-for="tick in priceTicks" :key="`pt${tick}`" :x="PAD_L - 6" :y="yPrice(tick) + 4" text-anchor="end">{{ (tick / 100).toFixed(2) }}</text>
						<text v-for="tick in volTicks" :key="`vt${tick}`" :x="PAD_L - 6" :y="yVol(tick) + 4" text-anchor="end">{{ tick }}</text>
						<text v-for="tick in timeTicks" :key="`t${tick.x}`" :x="tick.x" :y="HEIGHT - 5" text-anchor="middle">{{ tick.label }}</text>
						<text :x="PAD_L" :y="VOL_TOP - 4" class="panel-label">售出数量</text>
					</g>
					<g class="bars">
						<path v-for="bar in bars" :key="bar.index" :d="bar.d" :class="{active: bar.index === hover}" />
					</g>
					<path class="price-line" :d="linePath" />
					<g v-if="markY != null" class="mark">
						<line :x1="PAD_L" :x2="width - PAD_R" :y1="markY" :y2="markY" />
						<text :x="width - PAD_R" :y="markY - 4" text-anchor="end">我的价 {{ money(markPriceCents) }}</text>
					</g>
					<g v-if="hovered" class="crosshair">
						<line :x1="hoverX" :x2="hoverX" :y1="TOP" :y2="VOL_BASE" />
						<circle :cx="hoverX" :cy="yPrice(hovered.priceCents)" r="4" />
					</g>
					<rect :x="PAD_L" :y="TOP" :width="plotW" :height="VOL_BASE - TOP" fill="transparent" />
				</svg>
				<div v-else class="chart-empty muted">
					{{ entry?.loading ? '正在读取价格走势…' : entry?.error ? '' : `${option.label}内没有成交记录` }}
				</div>
			</NSpin>
			<div v-if="hovered" class="chart-tip" :style="tooltipStyle">
				<div class="muted">{{ formatPointTime(hovered.time, option.bucket) }}{{ option.bucket === '6h' ? ' 起 6 小时' : '' }}</div>
				<div>成交价 <strong>{{ money(hovered.priceCents) }}</strong></div>
				<div>售出 <strong>{{ hovered.volume }}</strong></div>
			</div>
		</div>
		<div class="muted chart-foot">成交价是每个时段的中位价{{ option.bucket === 'hour' ? '' : '(多个时段合并时按售出数量加权)' }};数据来自 Steam,服务器缓存 5 分钟。</div>
	</div>
</template>

<style scoped>
.price-chart {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
}

.chart-head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.chart-summary {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 16px;
	font-size: 12px;
	color: var(--muted);
}

.chart-summary strong {
	color: var(--text);
	font-weight: 600;
}

.chart-box {
	position: relative;
	width: 100%;
	min-width: 0;
}

.chart-box svg {
	display: block;
}

.chart-empty {
	padding: 40px 0;
	text-align: center;
	font-size: 13px;
}

.chart-error {
	font-size: 12px;
}

.chart-foot {
	font-size: 11px;
}

.grid line {
	stroke: var(--line-soft);
	stroke-width: 1;
}

.axis-text text {
	fill: var(--muted);
	font-size: 11px;
}

.panel-label {
	text-anchor: start;
}

.bars path {
	fill: var(--muted);
	opacity: 0.45;
}

.bars path.active {
	opacity: 0.85;
}

.price-line {
	fill: none;
	stroke: var(--info);
	stroke-width: 2;
	stroke-linejoin: round;
	stroke-linecap: round;
}

.mark line {
	stroke: var(--warn);
	stroke-width: 1.5;
	stroke-dasharray: 5 4;
}

.mark text {
	fill: var(--text);
	font-size: 11px;
}

.crosshair line {
	stroke: var(--muted);
	stroke-width: 1;
	stroke-dasharray: 3 3;
}

.crosshair circle {
	fill: var(--info);
	stroke: var(--surface);
	stroke-width: 2;
}

.chart-tip {
	position: absolute;
	z-index: 2;
	width: 160px;
	padding: 6px 8px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--surface);
	box-shadow: var(--shadow);
	color: var(--text);
	font-size: 12px;
	line-height: 1.5;
	pointer-events: none;
}
</style>
