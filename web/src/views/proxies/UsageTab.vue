<script setup lang="ts">
// 代理用量:选时间范围(今天 / 7 / 30 / 90 天,按 UTC 天算),顶上统计卡片,按天的流量柱状图(已发送、已接收叠在一起,
// 鼠标放上去看当天明细,可切成表格看),下面是用量最高的代理、账户,按请求类型、按代理组的占比。每分钟自动刷新。
// 只统计经代理的 Steam 网页请求和代理检测(字节数是估算);登录长连接、手机确认、交易报价不在里面。
import {computed, onMounted, onUnmounted, ref, watch} from 'vue';
import {NAlert, NButton, NDataTable, NRadioButton, NRadioGroup, NTooltip} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {ProxyUsageReport, UsageTotals} from '../../api/types.ts';
import AppIcon from '../../components/AppIcon.vue';
import GroupChip from '../../components/GroupChip.vue';
import {USAGE_KIND_LABEL, busiestDay, formatBytes, percent, proxyLabel, timeAgo, totalBytes, usageByGroup} from '../../lib/proxy.ts';
import {fetchUsage, proxy} from '../../stores/proxy.ts';

const emit = defineEmits<{'edit-proxy': [id: string]}>();

const RANGES = [{days: 1, label: '今天'}, {days: 7, label: '7 天'}, {days: 30, label: '30 天'}, {days: 90, label: '90 天'}];
const days = ref(7);
const report = ref<ProxyUsageReport | null>(null);
const loading = ref(false);
const error = ref('');
const loadedAt = ref(0);
const now = ref(Date.now());
const showTable = ref(false);

async function load(): Promise<void> {
	loading.value = true;
	try {
		report.value = await fetchUsage(days.value);
		loadedAt.value = Date.now();
		error.value = '';
	} catch (err) {
		error.value = errorText(err);
	} finally {
		loading.value = false;
	}
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	void load();
	timer = setInterval(() => {
		now.value = Date.now();
		void load();
	}, 60000);
});
onUnmounted(() => clearInterval(timer));
watch(days, () => void load());

const total = computed(() => (report.value ? totalBytes(report.value.total) : 0));
const proxyById = computed(() => new Map(proxy.data.proxies.map(item => [item.id, item])));
/** 有流量的代理(还在的;删掉的不算) */
const activeProxies = computed(() => report.value?.byProxy.filter(item => totalBytes(item) > 0 && proxyById.value.has(item.proxyId)).length ?? 0);
const busiest = computed(() => (report.value ? busiestDay(report.value) : null));
const groups = computed(() => (report.value ? usageByGroup(report.value, proxy.data.proxies, proxy.data.groups) : []));

// ===== 图 =====
/** 纵轴上限:取最大一天往上凑个整 */
const axisMax = computed(() => {
	const max = Math.max(0, ...(report.value?.byDay.map(totalBytes) ?? [0]));
	if (!max) {
		return 1;
	}
	const magnitude = 10 ** Math.floor(Math.log10(max));
	return [1, 2, 2.5, 5, 10].map(step => step * magnitude).find(value => value >= max) ?? max;
});

const bars = computed(() => {
	const list = report.value?.byDay ?? [];
	const every = Math.max(1, Math.ceil(list.length / 8));
	const top = busiest.value?.day ?? '';
	return list.map((day, index) => ({
		...day,
		total: totalBytes(day),
		sentPct: (day.sent / axisMax.value) * 100,
		receivedPct: (day.received / axisMax.value) * 100,
		label: index % every === 0 || index === list.length - 1 ? day.day.slice(5) : '',
		/** 只给最高那天标数字(不在每根柱子上标) */
		peak: day.day === top
	}));
});

const ticks = computed(() => [axisMax.value, axisMax.value / 2, 0].map(value => ({value, label: formatBytes(value)})));

const dayColumns: DataTableColumns<UsageTotals & {day: string}> = [
	{title: '日期(UTC)', key: 'day'},
	{title: '请求', key: 'requests', align: 'right'},
	{title: '已发送', key: 'sent', align: 'right', render: row => formatBytes(row.sent)},
	{title: '已接收', key: 'received', align: 'right', render: row => formatBytes(row.received)},
	{title: '总计', key: 'total', align: 'right', render: row => formatBytes(totalBytes(row))}
];

const subtitle = computed(() => {
	if (!report.value) {
		return '';
	}
	const latest = report.value.lastAt ? timeAgo(report.value.lastAt, now.value) : report.value.latestDay || '没有';
	return `更新于 ${timeAgo(loadedAt.value, now.value)} · 最近数据 ${latest} · 天数按 UTC 计算(${report.value.since} 到 ${report.value.until})`;
});
</script>

<template>
	<p class="muted intro">
		工具台经代理发出的 Steam 网页请求(商店、市场、库存、消费记录等)和代理检测的流量,按天统计,字节数是估算。登录长连接、手机确认、交易报价走别的通道,不在里面。
	</p>

	<div class="range-row">
		<NRadioGroup v-model:value="days" size="small">
			<NRadioButton v-for="range in RANGES" :key="range.days" :value="range.days">{{ range.label }}</NRadioButton>
		</NRadioGroup>
		<span class="muted small">{{ subtitle }}</span>
		<NButton size="small" quaternary :loading="loading" aria-label="刷新" @click="load"><template #icon><AppIcon name="radio" :size="16" /></template>刷新</NButton>
	</div>

	<NAlert v-if="error" type="error" :bordered="false">读取代理用量失败:{{ error }}</NAlert>

	<template v-if="report">
		<section class="stats panel">
			<div class="stat">
				<div class="stat-label">总流量</div>
				<div class="stat-value">{{ formatBytes(total) }}</div>
				<div class="stat-sub muted">已发送 {{ formatBytes(report.total.sent) }},已接收 {{ formatBytes(report.total.received) }}</div>
			</div>
			<div class="stat">
				<div class="stat-label">有流量的代理</div>
				<div class="stat-value">{{ proxy.data.proxies.length }} 个中的 {{ activeProxies }} 个</div>
				<div class="stat-sub muted">{{ activeProxies ? `每个代理平均 ${formatBytes(total / activeProxies)}` : '这段时间没有经代理的请求' }}</div>
			</div>
			<div class="stat">
				<div class="stat-label">最繁忙的一天</div>
				<div class="stat-value">{{ busiest ? formatBytes(totalBytes(busiest)) : '—' }}</div>
				<div class="stat-sub muted">{{ busiest ? busiest.day : '没有流量' }}</div>
			</div>
			<div class="stat">
				<div class="stat-label">请求数</div>
				<div class="stat-value">{{ report.total.requests.toLocaleString() }}</div>
				<div class="stat-sub muted">日均 {{ Math.round(report.total.requests / report.days).toLocaleString() }} 次</div>
			</div>
		</section>

		<section class="panel">
			<header class="panel-head">
				<div>
					<div class="head-title">流量随时间变化</div>
					<div class="muted small">按天,已发送和已接收</div>
				</div>
				<div class="head-tools">
					<span class="legend"><i class="swatch-sent" />已发送</span>
					<span class="legend"><i class="swatch-received" />已接收</span>
					<NButton size="tiny" quaternary @click="showTable = !showTable">{{ showTable ? '看图' : '看表格' }}</NButton>
				</div>
			</header>
			<div v-if="showTable" class="table-wrap">
				<NDataTable size="small" :bordered="false" :single-line="true" :columns="dayColumns" :data="[...report.byDay].reverse()" :max-height="320" />
			</div>
			<div v-else class="chart" role="img" :aria-label="`最近 ${report.days} 天每天的代理流量`">
				<div class="y-axis">
					<span v-for="tick in ticks" :key="tick.value">{{ tick.label }}</span>
				</div>
				<div class="plot">
					<div class="grid">
						<i v-for="tick in ticks" :key="tick.value" />
					</div>
					<div class="bars" :class="{dense: bars.length > 31}">
						<NTooltip v-for="bar in bars" :key="bar.day" placement="top">
							<template #trigger>
								<div class="bar-hit">
									<div class="bar">
										<span v-if="bar.peak && bar.total" class="peak-label">{{ formatBytes(bar.total) }}</span>
										<div v-if="bar.received" class="seg seg-received" :class="{top: true}" :style="{height: `${bar.receivedPct}%`}" />
										<div v-if="bar.sent" class="seg seg-sent" :class="{top: !bar.received}" :style="{height: `${bar.sentPct}%`}" />
									</div>
								</div>
							</template>
							<div class="tip">
								<div class="tip-title">{{ bar.day }}</div>
								<div><i class="swatch-sent" />已发送 {{ formatBytes(bar.sent) }}</div>
								<div><i class="swatch-received" />已接收 {{ formatBytes(bar.received) }}</div>
								<div class="muted">共 {{ formatBytes(bar.total) }} · {{ bar.requests }} 次请求</div>
							</div>
						</NTooltip>
					</div>
					<div class="x-axis">
						<span v-for="bar in bars" :key="bar.day">{{ bar.label }}</span>
					</div>
				</div>
			</div>
		</section>

		<div class="grid-2">
			<section class="panel">
				<header class="panel-head">
					<div>
						<div class="head-title">用量最高的代理</div>
						<div class="muted small">这段时间承载流量最多的代理</div>
					</div>
				</header>
				<ul v-if="report.byProxy.length" class="rank">
					<li v-for="item in report.byProxy.slice(0, 10)" :key="item.proxyId">
						<div class="rank-main">
							<a v-if="proxyById.get(item.proxyId)" class="rank-name link" @click="emit('edit-proxy', item.proxyId)">{{ proxyLabel(proxyById.get(item.proxyId)!) }}</a>
							<span v-else class="rank-name muted">已删除的代理</span>
							<span class="chips">
								<template v-for="id in proxyById.get(item.proxyId)?.groupIds ?? []" :key="id">
									<GroupChip v-if="proxy.data.groups.find(group => group.id === id)" :name="proxy.data.groups.find(group => group.id === id)!.name" :color="proxy.data.groups.find(group => group.id === id)!.color" />
								</template>
							</span>
						</div>
						<div class="muted small">已发送 {{ formatBytes(item.sent) }} · 已接收 {{ formatBytes(item.received) }}</div>
						<div class="rank-value">{{ formatBytes(totalBytes(item)) }}</div>
						<div class="share"><span class="share-bar"><i :style="{width: `${percent(totalBytes(item), total)}%`}" /></span>{{ percent(totalBytes(item), total) }}%</div>
					</li>
				</ul>
				<p v-else class="muted empty-note">没有数据</p>
			</section>

			<section class="panel">
				<header class="panel-head">
					<div>
						<div class="head-title">用量最高的账户</div>
						<div class="muted small">请求流量最多的账户</div>
					</div>
				</header>
				<ul v-if="report.byAccount.length" class="rank">
					<li v-for="item in report.byAccount.slice(0, 10)" :key="item.account">
						<div class="rank-main"><span class="rank-name">{{ item.account || '认不出账号的请求' }}</span><span class="muted small">{{ item.requests }} 次</span></div>
						<div class="muted small">已发送 {{ formatBytes(item.sent) }} · 已接收 {{ formatBytes(item.received) }}</div>
						<div class="rank-value">{{ formatBytes(totalBytes(item)) }}</div>
						<div class="share"><span class="share-bar"><i :style="{width: `${percent(totalBytes(item), total)}%`}" /></span>{{ percent(totalBytes(item), total) }}%</div>
					</li>
				</ul>
				<p v-else class="muted empty-note">没有数据</p>
			</section>

			<section class="panel">
				<header class="panel-head">
					<div>
						<div class="head-title">按请求类型的用量</div>
						<div class="muted small">流量用在了什么上</div>
					</div>
				</header>
				<ul v-if="report.byKind.length" class="rank">
					<li v-for="item in report.byKind" :key="item.kind">
						<div class="rank-main"><span class="rank-name">{{ USAGE_KIND_LABEL[item.kind] ?? item.kind }}</span><span class="muted small">{{ item.requests }} 次</span></div>
						<div />
						<div class="rank-value">{{ formatBytes(totalBytes(item)) }}</div>
						<div class="share"><span class="share-bar"><i :style="{width: `${percent(totalBytes(item), total)}%`}" /></span>{{ percent(totalBytes(item), total) }}%</div>
					</li>
				</ul>
				<p v-else class="muted empty-note">没有数据</p>
			</section>

			<section class="panel">
				<header class="panel-head">
					<div>
						<div class="head-title">按代理组的用量</div>
						<div class="muted small">每个组的流量,没分组的代理单独算;同时在两个组的代理两边都算</div>
					</div>
				</header>
				<ul v-if="groups.length" class="rank">
					<li v-for="item in groups" :key="item.groupId">
						<div class="rank-main"><GroupChip :name="item.name" :color="item.color" /><span class="muted small">{{ item.proxies }} 个代理</span></div>
						<div />
						<div class="rank-value">{{ formatBytes(item.bytes) }}</div>
						<div class="share"><span class="share-bar"><i :style="{width: `${percent(item.bytes, total)}%`}" /></span>{{ percent(item.bytes, total) }}%</div>
					</li>
				</ul>
				<p v-else class="muted empty-note">没有数据</p>
			</section>
		</div>
	</template>
</template>

<style scoped>
.intro {
	margin: -4px 0 0;
	font-size: 13px;
}

.range-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 14px;
}

.small {
	font-size: 12px;
}

.stats {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	flex: none;
}

.stat {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
	padding: 16px 20px;
}

.stat + .stat {
	border-left: 1px solid var(--line);
}

.stat-label {
	color: var(--muted);
	font-size: 13px;
	font-weight: 500;
}

.stat-value {
	overflow: hidden;
	font-size: 24px;
	font-weight: 700;
	letter-spacing: -0.02em;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.stat-sub {
	overflow: hidden;
	font-size: 13px;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.panel-head {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-start;
	justify-content: space-between;
	gap: 8px 12px;
	padding: 14px 20px;
	border-bottom: 1px solid var(--line);
}

.head-title {
	font-weight: 600;
}

.head-tools {
	display: flex;
	align-items: center;
	gap: 12px;
	font-size: 12px;
}

.legend {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: var(--muted);
}

.swatch-sent,
.swatch-received {
	display: inline-block;
	width: 10px;
	height: 10px;
	margin-right: 6px;
	border-radius: 3px;
	vertical-align: -1px;
}

.legend .swatch-sent,
.legend .swatch-received {
	margin-right: 0;
}

.swatch-sent {
	background: var(--chart-sent);
}

.swatch-received {
	background: var(--chart-received);
}

.table-wrap {
	padding: 4px 8px 8px;
}

/* 柱状图:左边纵轴刻度,右边是网格 + 柱子 + 横轴日期 */
.chart {
	display: grid;
	grid-template-columns: 64px minmax(0, 1fr);
	gap: 8px;
	padding: 20px 20px 12px 12px;
}

.y-axis {
	display: flex;
	flex-direction: column;
	justify-content: space-between;
	height: 220px;
	color: var(--muted);
	font-size: 11px;
	text-align: right;
	transform: translateY(-6px);
}

.plot {
	position: relative;
	min-width: 0;
}

.grid {
	position: absolute;
	inset: 0 0 auto;
	display: flex;
	flex-direction: column;
	justify-content: space-between;
	height: 220px;
	pointer-events: none;
}

.grid i {
	display: block;
	border-top: 1px dashed var(--line);
}

.grid i:last-child {
	border-top: 1px solid var(--line);
}

.bars {
	position: relative;
	display: flex;
	align-items: stretch;
	gap: 6px;
	height: 220px;
}

.bars.dense {
	gap: 2px;
}

/* 整根柱子那么高的一列都能悬停(比柱子本身大) */
.bar-hit {
	position: relative;
	display: flex;
	flex: 1;
	flex-direction: column;
	justify-content: flex-end;
	min-width: 0;
	cursor: default;
}

.bar-hit:hover {
	background: var(--hover);
	border-radius: 4px;
}

.bar {
	display: flex;
	flex-direction: column;
	justify-content: flex-end;
	gap: 2px;
	height: 100%;
	margin: 0 auto;
	width: min(100%, 28px);
}

/* 柱子按比例定高,不被上面的数字挤矮(挤不下时数字伸到图上方的留白里) */
.seg {
	flex-shrink: 0;
	min-height: 2px;
}

.seg.top {
	border-radius: 4px 4px 0 0;
}

.seg-sent {
	background: var(--chart-sent);
}

.seg-received {
	background: var(--chart-received);
}

.peak-label {
	flex-shrink: 0;
	align-self: center;
	color: var(--text);
	font-size: 11px;
	font-weight: 600;
	line-height: 14px;
	white-space: nowrap;
	pointer-events: none;
}

.x-axis {
	display: flex;
	gap: 6px;
	margin-top: 6px;
	color: var(--muted);
	font-size: 11px;
}

.bars.dense + .x-axis {
	gap: 2px;
}

.x-axis span {
	flex: 1;
	min-width: 0;
	overflow: visible;
	text-align: center;
	white-space: nowrap;
}

.tip {
	display: flex;
	flex-direction: column;
	gap: 3px;
	font-size: 12px;
}

.tip-title {
	font-weight: 600;
}

.grid-2 {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 16px;
}

.rank {
	margin: 0;
	padding: 4px 20px 12px;
	list-style: none;
}

.rank li {
	display: grid;
	grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 80px 96px;
	align-items: center;
	gap: 12px;
	padding: 9px 0;
	border-bottom: 1px solid var(--line-soft);
	font-size: 13px;
}

.rank li:last-child {
	border-bottom: 0;
}

.rank-main {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 8px;
	min-width: 0;
}

.rank-name {
	overflow: hidden;
	font-weight: 500;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.link {
	color: var(--text);
	cursor: pointer;
}

.link:hover {
	color: var(--accent-text);
}

.chips {
	display: inline-flex;
	flex-wrap: wrap;
	gap: 4px;
}

.rank-value {
	font-weight: 600;
	text-align: right;
}

.share {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
	color: var(--muted);
	font-size: 12px;
}

.share-bar {
	display: block;
	overflow: hidden;
	width: 48px;
	height: 4px;
	border-radius: 2px;
	background: var(--line);
}

.share-bar i {
	display: block;
	height: 100%;
	border-radius: 2px;
	background: var(--accent);
}

.empty-note {
	margin: 0;
	padding: 16px 20px;
	font-size: 13px;
}

@media (max-width: 1100px) {
	.grid-2 {
		grid-template-columns: minmax(0, 1fr);
	}
}

@media (max-width: 900px) {
	.stats {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.stat:nth-child(3) {
		border-left: 0;
	}

	.stat:nth-child(n + 3) {
		border-top: 1px solid var(--line);
	}
}
</style>
