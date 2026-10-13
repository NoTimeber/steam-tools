<script setup lang="ts">
// 商品目录:按分类分组(可收起)、搜索、当前币种的价格、查看各币种价格、给选中账号加入购物车。
import {computed, h, ref} from 'vue';
import {NButton, NDataTable, NInput, NTag} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey} from 'naive-ui';
import {filterItems, formatCents, groupItems, itemPrice, ratesSummary} from '../../lib/purchase.ts';
import type {CatalogItem} from '../../lib/purchase.ts';
import {addToCart, currentCurrency, gameLabel, purchase, selectedAccounts} from '../../stores/purchase.ts';
import PriceModal from './PriceModal.vue';

type Row =
	| {kind: 'group'; key: string; category: string; type: string; count: number; children: Row[]}
	| {kind: 'item'; key: string; item: CatalogItem};

const visible = computed(() => filterItems(purchase.items, purchase.search));

const rows = computed<Row[]>(() => groupItems(visible.value).map(group => ({
	kind: 'group' as const,
	key: 'group:' + group.category,
	category: group.category,
	type: group.items[0]?.type || group.category,
	count: group.items.length,
	children: group.items.map(item => ({kind: 'item' as const, key: 'item:' + item.def_index, item}))
})));

// 收起的分类(切游戏、搜索都保留)
const expandedKeys = computed(() => rows.value.map(row => row.key).filter(key => !purchase.collapsed.has(key)));

function onExpandedChange(keys: DataTableRowKey[]): void {
	const open = new Set(keys.map(String));
	for (const row of rows.value) {
		if (open.has(row.key)) {
			purchase.collapsed.delete(row.key);
		} else {
			purchase.collapsed.add(row.key);
		}
	}
}

const rates = computed(() => ratesSummary(purchase.rates, currentCurrency.value, purchase.ratesSource));

const fetchedAt = computed(() => {
	const date = new Date(purchase.itemsFetchedAt || '');
	return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', {hour12: false});
});

const emptyText = computed(() => {
	if (purchase.loadingItems) return `正在加载 ${gameLabel.value} 商品目录...`;
	if (purchase.itemError) return purchase.itemError;
	if (!purchase.items.length) return `当前没有可用的 ${gameLabel.value} 商品`;
	return '没有匹配当前搜索条件的商品';
});

const priceItem = ref<CatalogItem | null>(null);
const priceCurrency = ref('USD');

function showPrices(item: CatalogItem): void {
	priceCurrency.value = currentCurrency.value;
	priceItem.value = item;
}

const columns: DataTableColumns<Row> = [
	{
		title: '商品',
		key: 'name',
		minWidth: 220,
		colSpan: row => (row.kind === 'group' ? 3 : 1),
		render: row => row.kind === 'group'
			? h('span', {class: 'group-title'}, [
				h('strong', row.category),
				h(NTag, {size: 'small', round: true, bordered: false}, () => `${row.count} 项`),
				row.type !== row.category ? h('span', {class: 'muted'}, row.type) : null
			])
			: h('div', {class: 'item-name'}, [
				h('strong', {title: row.item.name}, row.item.name || '-'),
				h('span', {class: 'muted', title: row.item.type || row.item.category}, row.item.type || row.item.category || '-')
			])
	},
	{
		title: '价格',
		key: 'price',
		width: 130,
		render: row => (row.kind === 'item'
			? h('span', {class: 'price'}, [
				h('strong', formatCents(itemPrice(row.item, currentCurrency.value), currentCurrency.value)),
				h('span', {class: 'muted'}, ' ' + currentCurrency.value)
			])
			: null)
	},
	{
		title: '操作',
		key: 'actions',
		width: 190,
		render: row => {
			if (row.kind !== 'item') return null;
			const count = Object.keys(row.item.prices || {}).length;
			return h('div', {class: 'actions'}, [
				h(NButton, {size: 'tiny', quaternary: true, onClick: () => showPrices(row.item)}, () => `查看价格(${count})`),
				h(NButton, {size: 'tiny', type: 'primary', secondary: true, disabled: !selectedAccounts.value.length, onClick: () => addToCart(row.item)}, () => '加入购物车')
			]);
		}
	}
];
</script>

<template>
	<section class="panel">
		<header class="panel-header">
			<h2>商品列表</h2>
			<NInput v-model:value="purchase.search" size="small" clearable placeholder="搜索商品名称 / 类型 / 编号" class="search" />
		</header>
		<div class="summary muted">
			<span>游戏:{{ gameLabel }}</span>
			<span>已选账号:{{ selectedAccounts.length }}</span>
			<span>当前币种:{{ currentCurrency }}</span>
			<span>价格源:GC 商品目录</span>
			<span :title="rates.title">{{ rates.text }}</span>
			<span>更新时间:{{ fetchedAt }}</span>
		</div>
		<NDataTable
			class="catalog-table"
			flex-height
			size="small"
			:columns="columns"
			:data="rows"
			:row-key="(row: Row) => row.key"
			:expanded-row-keys="expandedKeys"
			:row-class-name="(row: Row) => (row.kind === 'group' ? 'group-row' : '')"
			:indent="0"
			:loading="purchase.loadingItems"
			:min-row-height="40"
			virtual-scroll
			@update:expanded-row-keys="onExpandedChange"
		>
			<template #empty>
				<span :class="purchase.itemError ? 'error-text' : 'muted'">{{ emptyText }}</span>
			</template>
		</NDataTable>
		<PriceModal :item="priceItem" :currency="priceCurrency" :rates="purchase.rates" @close="priceItem = null" />
	</section>
</template>

<style scoped>
.panel {
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-height: 0;
}

.panel-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

h2 {
	margin: 0;
	font-size: 15px;
	font-weight: 600;
}

.search {
	max-width: 280px;
}

.summary {
	display: flex;
	flex-wrap: wrap;
	gap: 6px 14px;
	font-size: 12px;
}

.catalog-table {
	flex: 1;
	min-height: 300px;
}

.error-text {
	color: var(--danger);
}

:deep(.group-row td) {
	background: #12161c;
}

:deep(.group-title) {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}

:deep(.item-name) {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

:deep(.item-name strong),
:deep(.item-name span) {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

:deep(.item-name span) {
	font-size: 12px;
}

:deep(.actions) {
	display: flex;
	gap: 4px;
	justify-content: flex-end;
}
</style>
