<script setup lang="ts">
// 库存管理(照 SteamLabs 的库存页):选一个已登录的账号(加载时先连上 CS2 GC),顶部数字卡,逐件/堆叠两种看法,网格卡片或列表,筛选、排序、翻页,点物品看详情。
import {computed, h, onMounted, onUnmounted, ref, watch} from 'vue';
import {NButton, NDataTable, NInput, NPagination, NSelect, NSpin, NTab, NTabs, NTooltip} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import {formatBalance} from '../lib/accounts.ts';
import {
	categoryCounts, filterItems, formatInventorySource, formatTradableAt, formatUnlockShort, formatWear, hasWear, inventoryStats,
	pageOf, rarityColorOf, rarityCounts, sortItems, stackItems, tradeBadge
} from '../lib/inventory.ts';
import type {InventoryItem, InventorySort, InventoryStack, TradeFilter} from '../lib/inventory.ts';
import {
	PAGE_SIZES, ensureLoaded, inventory, inventoryAccounts, inventoryView, refreshInventory, saveInventoryView, selectAccount, selectedAccount
} from '../stores/inventory.ts';
import type {InventoryLayout, InventoryMode} from '../stores/inventory.ts';
import InventoryCard from './inventory/InventoryCard.vue';
import ItemDetailModal from './inventory/ItemDetailModal.vue';

onMounted(ensureLoaded);
// 有账号登录/登出时,选中项可能要换
watch(() => inventoryAccounts.value.map(row => row.key).join(','), ensureLoaded);

// 交易冷却到期要跟着变,每分钟刷新一次「现在」
const now = ref(Date.now());
let clock = 0;
onMounted(() => (clock = window.setInterval(() => (now.value = Date.now()), 60_000)));
onUnmounted(() => window.clearInterval(clock));

const accountOptions = computed<SelectOption[]>(() => inventoryAccounts.value.map(row => ({
	value: row.key,
	label: `${row.accountName}(${row.country || '-'} · ${formatBalance(row)} · 物品 ${row.inventoryCount})`
})));

const loaded = computed(() => !!selectedAccount.value && inventory.loadedKey === selectedAccount.value.key);
const items = computed(() => (loaded.value ? inventory.items : []));
const stats = computed(() => inventoryStats(items.value, now.value));

const fetchedAt = computed(() => {
	const date = new Date(inventory.fetchedAt || '');
	return loaded.value && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit'}) : '';
});

const coolingSub = computed(() => {
	const parts = [];
	if (stats.value.nextUnlock) parts.push(`最早 ${formatUnlockShort(stats.value.nextUnlock, now.value)} 解锁`);
	if (stats.value.locked) parts.push(`已锁定 ${stats.value.locked} 件`);
	return parts.join(' · ') || '没有冷却中的物品';
});

// ===== 筛选 =====
const categories = computed(() => categoryCounts(items.value));
// 换账号后原来选的分类、稀有度可能没了,当作「全部」
const activeCategory = computed(() => (categories.value.some(entry => entry.category === inventory.categoryFilter) ? inventory.categoryFilter : 'all'));
const categoryOptions = computed<SelectOption[]>(() => [
	{value: 'all', label: `全部分类 (${items.value.length})`},
	...categories.value.map(entry => ({value: entry.category, label: `${entry.category} (${entry.count})`}))
]);

const rarities = computed(() => rarityCounts(items.value));
const activeRarity = computed(() => (rarities.value.some(entry => entry.rarity === inventoryView.rarity) ? inventoryView.rarity : ''));
const rarityOptions = computed<SelectOption[]>(() => [
	{value: '', label: '全部稀有度'},
	...rarities.value.map(entry => ({value: entry.rarity, label: `${entry.rarity} (${entry.count})`, color: entry.color}))
]);
const renderRarityLabel = (option: SelectOption) => (option.color
	? h('span', {class: 'rarity-option'}, [h('i', {style: {background: String(option.color)}}), String(option.label)])
	: String(option.label));

const tradeOptions: SelectOption[] = [
	{value: 'all', label: '全部交易状态'},
	{value: 'tradable', label: '可交易'},
	{value: 'cooling', label: '冷却中'},
	{value: 'locked', label: '已锁定'}
];
const sortOptions: SelectOption[] = [
	{value: 'default', label: '默认顺序'},
	{value: 'name', label: '名称'},
	{value: 'rarity', label: '稀有度(高到低)'},
	{value: 'unlock', label: '可交易时间'},
	{value: 'wear', label: '磨损(低到高)'}
];

function setCategory(value: string): void {
	inventory.categoryFilter = value;
}

function setSearch(value: string): void {
	inventoryView.search = value;
}

function setTrade(value: TradeFilter): void {
	inventoryView.trade = value;
}

function setRarity(value: string): void {
	inventoryView.rarity = value;
}

function setSort(value: InventorySort): void {
	inventoryView.sort = value;
}

function setPage(page: number): void {
	inventoryView.page = page;
}

const filtered = computed(() => sortItems(filterItems(items.value, {
	search: inventoryView.search,
	category: activeCategory.value,
	trade: inventoryView.trade,
	rarity: activeRarity.value
}, now.value), inventoryView.sort, now.value));

// 逐件时每件一块;堆叠时同名的合成一块
const entries = computed<InventoryStack[]>(() => (inventoryView.mode === 'stack'
	? stackItems(filtered.value, now.value)
	: filtered.value.map(item => ({key: item.assetid, item, items: [item], tradableCount: 0}))));
const paged = computed(() => pageOf(entries.value, inventoryView.page, inventoryView.pageSize));

// 筛选、换账号、换看法都回到第一页
watch(() => [inventoryView.search, inventoryView.trade, inventoryView.rarity, inventoryView.sort, inventoryView.mode, inventory.categoryFilter, inventory.selectedKey], () => {
	inventoryView.page = 1;
});

function setMode(mode: InventoryMode): void {
	inventoryView.mode = mode;
	saveInventoryView();
}

function setLayout(layout: InventoryLayout): void {
	inventoryView.layout = layout;
	saveInventoryView();
}

function setPageSize(size: number): void {
	inventoryView.pageSize = size;
	inventoryView.page = 1;
	saveInventoryView();
}

const emptyText = computed(() => {
	if (!selectedAccount.value) return '请先在「账户管理」里登录账号,再来这里选账户';
	if (inventory.loading && !loaded.value) return selectedAccount.value.cs2GcConnected ? '正在加载库存...' : '正在连接 CS2 GC,连上后加载库存...';
	if (inventory.error) return inventory.error;
	if (!loaded.value) return '点「刷新库存」开始加载';
	if (!items.value.length) return '当前账户暂无库存';
	return '没有符合筛选条件的物品';
});

// ===== 详情 =====
const detailItems = ref<InventoryItem[]>([]);

function openEntry(entry: InventoryStack): void {
	detailItems.value = entry.items;
}

// ===== 列表看法 =====
const tradeKind = (item: InventoryItem) => {
	const state = tradeBadge(item, now.value).state;
	return state === 'tradable' ? 'ok' : state === 'cooling' ? 'warn' : 'muted';
};

const columns = computed<DataTableColumns<InventoryStack>>(() => [
	{
		title: '饰品',
		key: 'name',
		minWidth: 280,
		render: ({item}) => h('div', {class: 'item-cell', style: {'--rarity': rarityColorOf(item) || 'var(--line)'}}, [
			item.iconUrl ? h('img', {class: 'item-thumb', src: item.iconUrl, alt: '', loading: 'lazy'}) : h('div', {class: 'item-thumb'}),
			h('div', {class: 'item-name'}, [
				h('strong', {title: item.name}, item.name || '-'),
				item.marketHashName && item.marketHashName !== item.name ? h('span', {class: 'muted', title: item.marketHashName}, item.marketHashName) : null
			])
		])
	},
	...(inventoryView.mode === 'stack' ? [{title: '数量', key: 'count', width: 80, render: (entry: InventoryStack) => h('span', {class: 'mono'}, `×${entry.items.length}`)}] : []),
	{title: '类型', key: 'type', width: 120, ellipsis: {tooltip: true}, render: ({item}) => item.type || '-'},
	{
		title: '稀有度',
		key: 'rarity',
		width: 110,
		render: ({item}) => (item.rarity
			? h('span', {class: 'inv-chip rarity', style: {'--rarity': rarityColorOf(item) || 'var(--line)'}}, [h('i'), item.rarity])
			: '-')
	},
	{
		title: '磨损/外观',
		key: 'exterior',
		width: 150,
		render: ({item, items: group}) => (group.length === 1 && hasWear(item)
			? h('span', [h('span', {class: 'mono'}, formatWear(item.paintWear).slice(0, 8)), ' ', h('span', {class: 'muted'}, item.exterior)])
			: item.exterior || '-')
	},
	{
		title: '可交易',
		key: 'tradable',
		width: 170,
		render: entry => {
			if (entry.items.length > 1) {
				const count = entry.items.length;
				const kind = entry.tradableCount === count ? 'ok' : entry.tradableCount ? 'warn' : 'muted';
				return h('span', {class: ['inv-chip', kind]}, `${entry.tradableCount}/${count} 可交易`);
			}
			return h('span', {class: ['inv-chip', tradeKind(entry.item)]}, tradeBadge(entry.item, now.value).label);
		}
	},
	{
		title: '可交易时间',
		key: 'tradableAfter',
		width: 190,
		render: ({item, items: group}) => h('span', {class: 'mono'}, group.length === 1 ? formatTradableAt(item.tradableAfter) : '-')
	}
]);

const rowProps = (entry: InventoryStack) => ({style: 'cursor: pointer', onClick: () => openEntry(entry)});
</script>

<template>
	<div class="module-page inventory-page">
		<header class="page-header">
			<div>
				<nav class="breadcrumb">
					<span>库存</span>
					<AppIcon name="chevronRight" :size="14" />
					<span>CS2</span>
				</nav>
				<h1 class="page-title">库存管理</h1>
			</div>
			<div class="header-actions">
				<NSelect
					class="account-select"
					:value="selectedAccount?.key ?? null"
					:options="accountOptions"
					:disabled="!inventoryAccounts.length"
					filterable
					placeholder="暂无已登录的账户"
					@update:value="(key: string) => selectAccount(key)"
				/>
				<NButton :disabled="!selectedAccount" :loading="inventory.loading" @click="refreshInventory({forceRefresh: true})">
					<template #icon><AppIcon name="refresh" :size="16" /></template>刷新库存
				</NButton>
			</div>
		</header>

		<section class="stats panel">
			<div class="stat">
				<div class="stat-label"><AppIcon name="package" :size="16" />物品总数</div>
				<div class="stat-value">{{ stats.total.toLocaleString() }}</div>
				<div class="stat-sub muted">{{ loaded ? `${formatInventorySource(inventory.source)}${fetchedAt ? ` · ${fetchedAt} 更新` : ''}` : '—' }}</div>
			</div>
			<div class="stat">
				<div class="stat-label"><AppIcon name="layers" :size="16" />不同物品</div>
				<div class="stat-value">{{ stats.distinct.toLocaleString() }}</div>
				<div class="stat-sub muted">CS2 GC {{ selectedAccount?.cs2GcConnected ? '已连接' : '未连接' }}</div>
			</div>
			<div class="stat">
				<div class="stat-label"><AppIcon name="check" :size="16" />可交易</div>
				<div class="stat-value">{{ stats.tradable.toLocaleString() }}</div>
				<div class="stat-sub ok">{{ stats.total ? `占 ${Math.round((stats.tradable / stats.total) * 100)}%` : '—' }}</div>
			</div>
			<div class="stat">
				<div class="stat-label"><AppIcon name="clock" :size="16" />冷却中</div>
				<div class="stat-value">{{ stats.cooling.toLocaleString() }}</div>
				<div class="stat-sub" :class="stats.cooling || stats.locked ? 'warn' : 'muted'">{{ loaded ? coolingSub : '—' }}</div>
			</div>
		</section>

		<section class="panel list-panel">
			<NTabs type="line" :value="inventoryView.mode" class="mode-tabs" @update:value="setMode">
				<NTab name="single"><span class="tab-label"><AppIcon name="package" :size="16" />逐件</span></NTab>
				<NTab name="stack"><span class="tab-label"><AppIcon name="layers" :size="16" />堆叠</span></NTab>
			</NTabs>

			<div class="toolbar">
				<div class="toolbar-left">
					<NInput :value="inventoryView.search" class="search" clearable placeholder="搜索名称、英文名、Asset ID" @update:value="setSearch">
						<template #prefix><AppIcon name="search" :size="16" class="muted" /></template>
					</NInput>
					<NSelect class="filter" :value="activeCategory" :options="categoryOptions" :disabled="!items.length" @update:value="setCategory" />
					<NSelect class="filter" :value="inventoryView.trade" :options="tradeOptions" :disabled="!items.length" @update:value="setTrade" />
					<NSelect
						class="filter"
						:value="activeRarity"
						:options="rarityOptions"
						:render-label="renderRarityLabel"
						:disabled="!items.length"
						@update:value="setRarity"
					/>
				</div>
				<div class="toolbar-right">
					<NSelect class="sort" :value="inventoryView.sort" :options="sortOptions" @update:value="setSort" />
					<div class="layout-toggle">
						<NTooltip>
							<template #trigger>
								<button type="button" :class="{active: inventoryView.layout === 'grid'}" aria-label="网格" @click="setLayout('grid')"><AppIcon name="grid" :size="16" /></button>
							</template>
							网格
						</NTooltip>
						<NTooltip>
							<template #trigger>
								<button type="button" :class="{active: inventoryView.layout === 'list'}" aria-label="列表" @click="setLayout('list')"><AppIcon name="list" :size="16" /></button>
							</template>
							列表
						</NTooltip>
					</div>
				</div>
			</div>

			<NSpin :show="inventory.loading && loaded" class="content">
				<div v-if="!paged.rows.length" class="empty" :class="{error: !!inventory.error}">{{ emptyText }}</div>
				<div v-else-if="inventoryView.layout === 'grid'" class="grid">
					<InventoryCard
						v-for="entry in paged.rows"
						:key="entry.key"
						:item="entry.item"
						:items="inventoryView.mode === 'stack' ? entry.items : undefined"
						:now="now"
						@open="openEntry(entry)"
					/>
				</div>
				<NDataTable
					v-else
					size="small"
					:columns="columns"
					:data="paged.rows"
					:row-key="(entry: InventoryStack) => entry.key"
					:row-props="rowProps"
					:scroll-x="1000"
				/>
			</NSpin>

			<footer v-if="entries.length" class="foot">
				<span class="muted">共 {{ entries.length.toLocaleString() }} {{ inventoryView.mode === 'stack' ? '种' : '件' }}</span>
				<NPagination
					:page="paged.page"
					:page-count="paged.pageCount"
					:page-size="inventoryView.pageSize"
					:page-sizes="[...PAGE_SIZES]"
					show-size-picker
					@update:page="setPage"
					@update:page-size="setPageSize"
				/>
			</footer>
		</section>

		<ItemDetailModal :items="detailItems" :now="now" :steamID="selectedAccount?.steamID ?? ''" @close="detailItems = []" />
	</div>
</template>

<style scoped>
/* 侧边栏不收起,按内容区宽度(不是窗口宽度)调整排版 */
.inventory-page {
	height: auto;
	min-height: 100%;
	container-type: inline-size;
}

.header-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.account-select {
	width: 340px;
	max-width: 100%;
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
	display: flex;
	align-items: center;
	gap: 6px;
	color: var(--muted);
	font-size: 13px;
	font-weight: 500;
}

.stat-value {
	font-size: 28px;
	font-weight: 700;
	letter-spacing: -0.02em;
	line-height: 1.15;
	white-space: nowrap;
}

.stat-sub {
	overflow: hidden;
	font-size: 13px;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.ok {
	color: var(--ok);
}

.warn {
	color: var(--warn);
}

.list-panel {
	display: flex;
	flex-direction: column;
	flex: none;
}

.mode-tabs {
	padding: 0 12px;
}

.tab-label {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px 12px;
	padding: 10px 12px;
	border-bottom: 1px solid var(--line);
}

.toolbar-left,
.toolbar-right {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.search {
	width: 240px;
}

.filter {
	width: 160px;
}

.sort {
	width: 150px;
}

.layout-toggle {
	display: inline-flex;
	padding: 2px;
	border: 1px solid var(--line);
	border-radius: 8px;
}

.layout-toggle button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 26px;
	padding: 0;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
}

.layout-toggle button:hover {
	color: var(--text);
}

.layout-toggle button.active {
	background: var(--accent-soft);
	color: var(--accent-text);
}

.content {
	min-height: 240px;
}

.grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(160px, 100%), 1fr));
	gap: 12px;
	padding: 12px;
}

.empty {
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 240px;
	padding: 24px;
	color: var(--muted);
	text-align: center;
}

.empty.error {
	color: var(--danger);
}

.foot {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px 12px;
	padding: 10px 14px;
	border-top: 1px solid var(--line);
	font-size: 13px;
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
	border-radius: 4px;
	object-fit: contain;
	background: linear-gradient(to top, color-mix(in srgb, var(--rarity) 30%, transparent), transparent 75%), var(--surface-2);
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

:deep(.rarity-option) {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

:deep(.rarity-option > i) {
	width: 8px;
	height: 8px;
	border-radius: 50%;
}

:deep(.n-pagination) {
	flex-wrap: wrap;
	row-gap: 6px;
}

@container (max-width: 760px) {
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

@container (max-width: 480px) {
	.stats {
		grid-template-columns: minmax(0, 1fr);
	}

	.stat + .stat {
		border-top: 1px solid var(--line);
		border-left: 0;
	}

	.header-actions,
	.search,
	.filter,
	.sort,
	.account-select {
		width: 100%;
	}

	.grid {
		gap: 8px;
		padding: 8px;
	}
}
</style>
