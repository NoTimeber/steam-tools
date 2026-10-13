<script setup lang="ts">
// 库存管理:选一个已连 CS2 GC 的账号看库存,可按分类筛选。
import {computed, h, onMounted, watch} from 'vue';
import {NButton, NDataTable, NSelect, NSpace, NTag} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import {formatBalance} from '../lib/accounts.ts';
import {categoryCounts, formatInventorySource, formatTradableAt, inventoryCategoryOf, itemSubtitle} from '../lib/inventory.ts';
import type {InventoryItem} from '../lib/inventory.ts';
import {ensureLoaded, gcAccounts, inventory, refreshInventory, selectAccount, selectedAccount} from '../stores/inventory.ts';

onMounted(ensureLoaded);
// 有账号连上/断开 CS2 GC 时,选中项可能要换
watch(() => gcAccounts.value.map(row => row.key).join(','), ensureLoaded);

const accountOptions = computed<SelectOption[]>(() => gcAccounts.value.map(row => ({
	value: row.key,
	label: `${row.accountName}(${row.country || '-'} · ${formatBalance(row)} · 物品 ${row.inventoryCount})`
})));

const loaded = computed(() => !!selectedAccount.value && inventory.loadedKey === selectedAccount.value.key);
const items = computed(() => (loaded.value ? inventory.items : []));

const categories = computed(() => categoryCounts(items.value));
// 换账号后原来的分类可能没了,回到「全部」
const activeCategory = computed(() => (categories.value.some(entry => entry.category === inventory.categoryFilter) ? inventory.categoryFilter : 'all'));
const categoryOptions = computed<SelectOption[]>(() => [
	{value: 'all', label: `全部 (${items.value.length})`},
	...categories.value.map(entry => ({value: entry.category, label: `${entry.category} (${entry.count})`}))
]);

function setCategory(value: string): void {
	inventory.categoryFilter = value;
}

const visibleItems = computed(() => (activeCategory.value === 'all' ? items.value : items.value.filter(item => inventoryCategoryOf(item) === activeCategory.value)));

const emptyText = computed(() => {
	if (!selectedAccount.value) return '请先在「账户管理」里连接 CS2 GC,再来这里选账户';
	if (inventory.loading) return '正在加载库存...';
	if (inventory.error) return inventory.error;
	if (!loaded.value) return '点「刷新库存」开始加载';
	if (!items.value.length) return '当前账户暂无库存';
	return `「${activeCategory.value}」分类下暂无饰品`;
});

const fetchedAt = computed(() => {
	const date = new Date(inventory.fetchedAt || '');
	return loaded.value && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('zh-CN', {hour12: false}) : '-';
});

const columns: DataTableColumns<InventoryItem> = [
	{
		title: '饰品',
		key: 'name',
		minWidth: 280,
		render: item => {
			const subtitle = itemSubtitle(item);
			return h('div', {class: 'item-cell'}, [
				item.iconUrl ? h('img', {class: 'item-thumb', src: item.iconUrl, alt: '', loading: 'lazy'}) : h('div', {class: 'item-thumb'}),
				h('div', {class: 'item-name'}, [
					h('strong', {title: item.name}, item.name || '-'),
					subtitle ? h('span', {class: 'muted', title: subtitle}, subtitle) : null
				])
			]);
		}
	},
	{title: '类型', key: 'type', width: 150, ellipsis: {tooltip: true}, render: item => item.type || '-'},
	{title: '稀有度', key: 'rarity', width: 110, render: item => item.rarity || '-'},
	{title: '磨损/外观', key: 'exterior', width: 110, render: item => item.exterior || '-'},
	{
		title: '可交易',
		key: 'tradable',
		width: 90,
		render: item => h(NTag, {size: 'small', bordered: false, type: item.tradable ? 'success' : 'error'}, () => (item.tradable ? '可交易' : '不可交易'))
	},
	{title: '可交易时间', key: 'tradableAfter', width: 190, render: item => h('span', {class: 'mono'}, formatTradableAt(item.tradableAfter))}
];
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>库存管理</h1>
				<div class="module-counts">
					<span>GC在线账户:{{ gcAccounts.length }}</span>
					<span>物品数:{{ items.length }}</span>
					<span>来源:{{ loaded ? formatInventorySource(inventory.source) : '-' }}</span>
				</div>
			</div>
			<NSpace align="center">
				<NSelect
					class="account-select"
					:value="selectedAccount?.key ?? null"
					:options="accountOptions"
					:disabled="!gcAccounts.length"
					placeholder="暂无已连接 CS2 GC 的账户"
					@update:value="(key: string) => selectAccount(key)"
				/>
				<NButton :disabled="!selectedAccount" :loading="inventory.loading" @click="refreshInventory({forceRefresh: true})">刷新库存</NButton>
			</NSpace>
		</header>

		<div v-if="selectedAccount" class="summary muted">
			<span>账号:{{ selectedAccount.accountName }}</span>
			<span>国家:{{ selectedAccount.country || '-' }}</span>
			<span>余额:{{ formatBalance(selectedAccount) }}</span>
			<span>CS2 GC:已连接</span>
			<span>来源:{{ loaded ? formatInventorySource(inventory.source) : '-' }}</span>
			<span>更新时间:{{ fetchedAt }}</span>
		</div>

		<NSpace align="center" :size="8">
			<span class="muted">分类筛选</span>
			<NSelect
				class="category-select"
				size="small"
				:value="activeCategory"
				:options="categoryOptions"
				:disabled="!items.length"
				@update:value="setCategory"
			/>
		</NSpace>

		<div class="module-body">
			<NDataTable
				class="inventory-table"
				flex-height
				size="small"
				:columns="columns"
				:data="visibleItems"
				:row-key="(item: InventoryItem) => item.assetid"
				:loading="inventory.loading"
				:scroll-x="930"
				:min-row-height="52"
				virtual-scroll
			>
				<template #empty>
					<span :class="inventory.error ? 'error-text' : 'muted'">{{ emptyText }}</span>
				</template>
			</NDataTable>
		</div>
	</div>
</template>

<style scoped>
.account-select {
	width: 360px;
}

.category-select {
	width: 180px;
}

.summary {
	display: flex;
	flex-wrap: wrap;
	gap: 16px;
	font-size: 13px;
}

.module-body {
	display: flex;
	flex-direction: column;
}

.inventory-table {
	flex: 1;
	min-height: 240px;
}

.error-text {
	color: var(--danger);
}

:deep(.item-cell) {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
}

:deep(.item-thumb) {
	flex: none;
	width: 48px;
	height: 36px;
	object-fit: contain;
	border-radius: 4px;
	background: var(--surface-2);
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
</style>
