<script setup lang="ts">
// 市场 → 成交记录:选一个在线账号,从 Steam 拉市场历史(每页 50 条,上一页 / 下一页),本页内按类型筛。
import {computed, h} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NSelect, NSpace, NTag} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import {filterHistory, formatUnixTime, HISTORY_TYPE_LABELS, historyPrice, money, pageInfo} from '../../lib/market-sell.ts';
import type {HistoryEvent, HistoryType} from '../../lib/market-sell.ts';
import {market} from '../../stores/market.ts';
import {history, HISTORY_PAGE_SIZE, loadHistory, setHistoryAccount} from '../../stores/market-sell.ts';

const accountOptions = computed<SelectOption[]>(() => market.accounts.map(account => ({value: account.account, label: account.account})));

const TYPE_OPTIONS: SelectOption[] = [
	{value: '', label: '全部类型'},
	...(['sold', 'bought', 'listed', 'cancelled'] as HistoryType[]).map(type => ({value: type, label: HISTORY_TYPE_LABELS[type].label}))
];

function setType(value: string): void {
	history.type = (value || null) as HistoryType | null;
}

const events = computed(() => filterHistory(history.page?.events ?? [], history.type));
const paging = computed(() => (history.page ? pageInfo(history.page.start, HISTORY_PAGE_SIZE, history.page.totalCount) : null));

const columns = computed<DataTableColumns<HistoryEvent>>(() => [
	{title: '时间', key: 'time', width: 140, render: event => (event.time ? formatUnixTime(event.time) : event.date || '-')},
	{
		title: '类型',
		key: 'type',
		width: 70,
		render: event => {
			const type = HISTORY_TYPE_LABELS[event.type] ?? HISTORY_TYPE_LABELS.unknown;
			return h(NTag, {size: 'small', bordered: false, type: type.tone}, () => type.label);
		}
	},
	{
		title: '物品',
		key: 'name',
		minWidth: 240,
		render: event => h('div', {class: 'item-cell'}, [
			event.icon ? h('img', {class: 'item-thumb', src: event.icon, alt: '', loading: 'lazy'}) : h('div', {class: 'item-thumb'}),
			h('span', {class: 'item-main', title: event.marketHashName}, event.name || event.marketHashName)
		])
	},
	{
		title: '价格',
		key: 'price',
		width: 110,
		render: event => h('span', {title: event.type === 'sold' ? '卖出:到手' : event.type === 'bought' ? '买入:实付' : '挂的买家价'}, money(historyPrice(event), history.page?.currency))
	},
	{
		title: '对方',
		key: 'counterpart',
		width: 160,
		ellipsis: {tooltip: true},
		render: event => (event.counterpart ? h('span', {title: event.counterpart.steamId}, event.counterpart.persona || event.counterpart.steamId) : '-')
	}
]);
</script>

<template>
	<NCard size="small" :bordered="false" title="成交记录">
		<div class="toolbar">
			<NSelect
				class="account-select"
				filterable
				:value="history.account"
				:options="accountOptions"
				:placeholder="market.accounts.length ? '选一个在线账户' : '暂无在线账户'"
				:disabled="history.loading"
				@update:value="setHistoryAccount"
			/>
			<NSelect class="type-select" :value="history.type ?? ''" :options="TYPE_OPTIONS" @update:value="setType" />
			<NButton :loading="history.loading" :disabled="!history.account" @click="loadHistory()">刷新</NButton>
			<NSpace v-if="paging" class="pager" align="center" :size="8">
				<span class="muted small">第 {{ paging.page }} / {{ paging.pages }} 页 · 共 {{ history.page?.totalCount }} 条</span>
				<NButton size="small" :disabled="!paging.hasPrev || history.loading" @click="loadHistory(Math.max(0, history.start - HISTORY_PAGE_SIZE))">上一页</NButton>
				<NButton size="small" :disabled="!paging.hasNext || history.loading" @click="loadHistory(history.start + HISTORY_PAGE_SIZE)">下一页</NButton>
			</NSpace>
		</div>
		<NAlert v-if="history.error" type="error" :bordered="false" class="block">读取成交记录失败:{{ history.error }}</NAlert>
		<NDataTable size="small" :columns="columns" :data="events" :loading="history.loading" :row-key="(event: HistoryEvent) => event.key" :scroll-x="760">
			<template #empty>
				<span class="muted">{{ !history.account ? '先选一个在线账户' : history.page?.events.length ? '本页没有这种类型的记录' : '没有记录' }}</span>
			</template>
		</NDataTable>
		<p class="muted small hint">类型筛选只在当前这一页里筛;卖出显示到手价,买入显示实付,上架 / 下架显示挂的买家价。</p>
	</NCard>
</template>

<style scoped>
.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	margin-bottom: 10px;
}

.account-select {
	width: 260px;
}

.type-select {
	width: 130px;
}

.pager {
	margin-left: auto;
}

.block {
	margin-bottom: 10px;
}

.small {
	font-size: 12px;
}

.hint {
	margin: 8px 0 0;
}

:deep(.item-cell) {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

:deep(.item-thumb) {
	width: 40px;
	height: 30px;
	flex: none;
	object-fit: contain;
}

:deep(.item-main) {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
