<script setup lang="ts">
// 消费记录:服务端在后台一页页读完 Steam「购买记录」,这里轮询进度;读完显示明细
// (可按日期范围、类型、关键字筛选),当前列表里花钱的记录可导出 CSV(日期、商品、金额和合计)。
import {computed, h, onBeforeUnmount, reactive, watch} from 'vue';
import type {VNode} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NInput, NModal, NSelect, NSpace, NSpin, NTag, useMessage} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {HistoryKind, HistoryMoney, HistoryRow, PublicHistory} from '../../api/types.ts';
import {countKinds, csvFileName, filterHistory, historyCsv, inDateRange, kindLabel, spendingRows} from '../../lib/history.ts';
import {fetchHistory, startHistory} from '../../stores/accounts.ts';
import DateRangePicker from './DateRangePicker.vue';

const props = defineProps<{accountName: string}>();
const emit = defineEmits<{close: []}>();
const message = useMessage();

const POLL_MS = 1500;

const view = reactive({
	history: null as PublicHistory | null,
	/** 接口请求本身失败(读取任务出错在 history.error 里) */
	error: '',
	starting: false,
	kind: null as HistoryKind | null,
	keyword: '',
	/** 日期范围(YYYY-MM-DD,含两端);null 不限 */
	range: null as [string, string] | null
});

let timer: number | undefined;
/** 换账号、关掉弹窗后加一,之前发出的请求回来就丢掉 */
let generation = 0;

function stop(): void {
	window.clearTimeout(timer);
	timer = undefined;
}

function apply(history: PublicHistory | null, name: string, gen: number): void {
	if (gen !== generation) {
		return;
	}
	view.history = history;
	if (history?.status === 'loading') {
		stop();
		timer = window.setTimeout(() => poll(name, gen), POLL_MS);
	}
}

async function poll(name: string, gen: number): Promise<void> {
	try {
		const history = await fetchHistory(name);
		if (gen === generation) {
			view.error = '';
		}
		apply(history, name, gen);
	} catch (err) {
		if (gen !== generation) {
			return;
		}
		// 查进度失败(断网等)不停,过一会再查
		view.error = errorText(err);
		stop();
		timer = window.setTimeout(() => poll(name, gen), POLL_MS * 2);
	}
}

/** 读过的服务端直接返回上次的结果;force 重读 */
async function start(force: boolean): Promise<void> {
	const name = props.accountName;
	const gen = generation;
	view.starting = true;
	view.error = '';
	try {
		apply(await startHistory(name, force), name, gen);
	} catch (err) {
		if (gen === generation) {
			view.error = errorText(err);
		}
	} finally {
		if (gen === generation) {
			view.starting = false;
		}
	}
}

watch(() => props.accountName, name => {
	generation++;
	stop();
	Object.assign(view, {history: null, error: '', starting: false, kind: null, keyword: '', range: null});
	if (name) {
		start(false);
	}
}, {immediate: true});

onBeforeUnmount(() => {
	generation++;
	stop();
});

const loading = computed(() => view.history?.status === 'loading');
const rows = computed(() => view.history?.rows ?? []);
/** 日期范围内的;类型下拉的条数按它算,类型和关键字再在它上面筛 */
const ranged = computed(() => inDateRange(rows.value, view.range));
const filtered = computed(() => filterHistory(ranged.value, view.kind ?? '', view.keyword));
/** 行的 key:在全部记录里的序号(筛选后不变) */
const rowIndex = computed(() => new Map(rows.value.map((row, index) => [row, index])));
/** 记录多时表格固定高度,筛选时弹窗不跟着变高变矮、上下跳 */
const tallTable = computed(() => rows.value.length > 10);
const kindOptions = computed(() => countKinds(ranged.value).map(item => ({label: `${item.label}(${item.count})`, value: item.kind})));

/** 当前列表里花钱的记录,导出 CSV 用 */
const spending = computed(() => spendingRows(filtered.value));

/** 导出当前列表(日期范围、类型、关键字筛过的)里花钱的记录和合计 */
function exportCsv(): void {
	const list = spending.value;
	const url = URL.createObjectURL(new Blob([historyCsv(list)], {type: 'text/csv;charset=utf-8'}));
	const link = document.createElement('a');
	link.href = url;
	link.download = csvFileName(props.accountName, view.range);
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	message.success(`已导出 ${list.length} 条`);
}

function formatTime(iso: string): string {
	return iso ? new Date(iso).toLocaleString('zh-CN', {hour12: false}) : '';
}

const KIND_TAG: Record<HistoryKind, 'default' | 'info' | 'success' | 'warning'> = {
	purchase: 'info',
	gift: 'info',
	ingame: 'info',
	market_buy: 'default',
	market_sell: 'success',
	wallet: 'success',
	refund: 'warning',
	conversion: 'default',
	other: 'default'
};

function lines(texts: readonly string[]): VNode {
	return texts.length ? h('div', {class: 'lines'}, texts.map(text => h('div', text))) : h('span', {class: 'muted'}, '-');
}

function moneyCell(money: HistoryMoney | null, signed = false): VNode {
	if (!money) {
		return h('span', {class: 'muted'}, '-');
	}
	const tone = signed && money.amount ? (money.amount > 0 ? 'gain' : 'loss') : '';
	return h('span', {class: ['mono', tone]}, money.text);
}

const columns: DataTableColumns<HistoryRow> = [
	{title: '日期', key: 'date', width: 100, render: row => row.date || row.dateText},
	{title: '商品', key: 'items', minWidth: 220, render: row => lines(row.items)},
	{
		title: '类型',
		key: 'kind',
		width: 170,
		render: row => h('span', {class: 'type-cell'}, [
			h(NTag, {size: 'small', bordered: false, type: KIND_TAG[row.kind], title: row.typeText}, () => kindLabel(row.kind)),
			row.marketCount > 1 ? h('span', {class: 'muted'}, `${row.marketCount} 笔`) : null,
			row.refunded && row.kind !== 'refund' ? h(NTag, {size: 'small', bordered: false, type: 'warning'}, () => '含退款') : null
		].filter((node): node is VNode => !!node))
	},
	{title: '付款方式', key: 'payment', width: 170, render: row => lines(row.payment)},
	{title: '总额', key: 'total', width: 110, render: row => moneyCell(row.total)},
	{title: '钱包变动', key: 'walletChange', width: 110, render: row => moneyCell(row.walletChange, true)},
	{title: '钱包余额', key: 'walletBalance', width: 110, render: row => moneyCell(row.walletBalance)}
];
</script>

<template>
	<NModal :show="!!accountName" @update:show="(show: boolean) => !show && emit('close')">
		<NCard :title="`${accountName} 消费记录`" class="history-card" :bordered="false" role="dialog" aria-modal="true">
			<div class="status">
				<template v-if="loading && view.history">
					<NSpin :size="14" />
					<span>正在从 Steam 读取:已读 {{ view.history.pages }} 页、{{ view.history.count }} 条(一页页翻,记录多的账号要等一会)</span>
				</template>
				<span v-else-if="view.starting" class="muted">正在读取...</span>
				<span v-else-if="view.history?.status === 'done'" class="muted">
					共 {{ view.history.count }} 条、{{ view.history.pages }} 页,读取于 {{ formatTime(view.history.finishedAt) }}
				</span>
			</div>

			<NAlert v-if="view.error" type="error" :bordered="false" class="block">{{ view.error }}</NAlert>
			<NAlert v-if="view.history?.status === 'error'" type="error" :bordered="false" class="block" title="读取中断">
				{{ view.history.error }}
				<template v-if="view.history.count">。下面是已读到的 {{ view.history.count }} 条,可以点「重新读取」再试。</template>
			</NAlert>
			<NAlert v-if="view.history?.truncated" type="warning" :bordered="false" class="block">
				读到 {{ view.history.pages }} 页就停了,更早的记录没有读。
			</NAlert>

			<template v-if="rows.length">
				<div class="toolbar block">
					<NSpace :size="8" align="center">
						<DateRangePicker v-model="view.range" />
						<NSelect v-model:value="view.kind" :options="kindOptions" clearable placeholder="全部类型" size="small" class="kind-select" />
						<NInput v-model:value="view.keyword" clearable placeholder="搜索商品、类型、付款方式、日期" size="small" class="keyword" />
						<span class="muted">显示 {{ filtered.length }} / {{ rows.length }} 条</span>
					</NSpace>
					<NButton
						size="small"
						:disabled="!spending.length"
						title="导出当前列表里花钱的记录(商店购买、礼物购买、游戏内购买、市场买入):日期、商品、金额,最后一行合计"
						@click="exportCsv"
					>
						导出 CSV({{ spending.length }} 条)
					</NButton>
				</div>

				<NDataTable
					size="small"
					:columns="columns"
					:data="filtered"
					:row-key="(row: HistoryRow) => rowIndex.get(row) ?? -1"
					:class="{'tall-table': tallTable}"
					:flex-height="tallTable"
					:max-height="tallTable ? undefined : '50vh'"
					:scroll-x="990"
					virtual-scroll
				>
					<template #empty>
						<span class="muted">没有符合条件的记录</span>
					</template>
				</NDataTable>
			</template>
			<div v-else-if="view.history && !loading && view.history.status === 'done'" class="empty muted">这个账号没有消费记录</div>

			<p class="muted note">
				数据来自 Steam 网页「购买记录」。市场交易只有合并后的金额,看不到具体是哪件饰品。
			</p>

			<template #footer>
				<NSpace justify="end">
					<NButton :loading="view.starting" :disabled="loading" @click="start(true)">重新读取</NButton>
					<NButton @click="emit('close')">关闭</NButton>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.history-card {
	width: 1080px;
	max-width: calc(100vw - 32px);
}

.status {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 22px;
	margin-bottom: 8px;
}

.block {
	margin-bottom: 10px;
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.kind-select {
	width: 180px;
}

.keyword {
	width: 260px;
}

.tall-table {
	height: 50vh;
}

.empty {
	padding: 32px 0;
	text-align: center;
}

.note {
	margin: 10px 0 0;
	font-size: 12px;
}

:deep(.lines) {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

:deep(.type-cell) {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px;
}

:deep(.gain) {
	color: var(--ok);
}

:deep(.loss) {
	color: var(--danger);
}
</style>
