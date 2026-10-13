<script setup lang="ts">
// 购物车:选购买账号(多选),每个账号一行(余额 / 消耗 / 件数),展开可逐件改数量;最大购买数量、清空、提交任务。
import {computed, h} from 'vue';
import {NButton, NDataTable, NInputNumber, NSelect, NSpace} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import {formatBalance} from '../../lib/accounts.ts';
import {MAX_ITEM_QUANTITY, cartTotals, formatCents} from '../../lib/purchase.ts';
import type {CartEntry, PurchaseAccount} from '../../lib/purchase.ts';
import {
	cartGroups, cartOf, clearAccountCart, clearCart, gameLabel, maxOutCart, purchase, selectedAccounts, setQuantity, submitTask
} from '../../stores/purchase.ts';

const accountOptions = computed<SelectOption[]>(() => purchase.accounts.map(account => ({
	value: account.account,
	label: `${account.account} · 余额 ${formatBalance(account)}`
})));

const selectedNames = computed(() => [...purchase.selected]);

function onSelect(names: string[]): void {
	purchase.selected.clear();
	for (const name of names) {
		purchase.selected.add(name);
	}
}

function selectAll(): void {
	onSelect(purchase.accounts.map(account => account.account));
}

const placeholder = computed(() => {
	if (purchase.accounts.length) return '请选择在线账户';
	if (purchase.loadingAccounts) return `正在加载 ${gameLabel.value} 在线账户...`;
	if (purchase.accountError) return purchase.accountError;
	return `暂无可用 ${gameLabel.value} 在线账户`;
});

const totalUnits = computed(() => cartGroups.value.reduce((sum, group) => sum + cartTotals(group.entries).units, 0));

interface Row {
	account: PurchaseAccount;
	entries: CartEntry[];
}

const rows = computed<Row[]>(() => selectedAccounts.value.map(account => ({account, entries: cartOf(account.account)})));

function entryColumns(accountName: string): DataTableColumns<CartEntry> {
	return [
		{title: '商品', key: 'name', ellipsis: {tooltip: true}},
		{title: '单价', key: 'cost', width: 100, render: entry => formatCents(entry.costInLocalCurrency, entry.currencyISO)},
		{
			title: '数量',
			key: 'quantity',
			width: 120,
			render: entry => h(NInputNumber, {
				size: 'tiny',
				value: entry.quantity,
				min: 0,
				max: MAX_ITEM_QUANTITY,
				precision: 0,
				'onUpdate:value': (value: number | null) => setQuantity(accountName, entry.itemDefId, Number(value || 0))
			})
		},
		{
			title: '',
			key: 'remove',
			width: 60,
			render: entry => h(NButton, {size: 'tiny', quaternary: true, onClick: () => setQuantity(accountName, entry.itemDefId, 0)}, () => '移除')
		}
	];
}

const columns: DataTableColumns<Row> = [
	{
		type: 'expand',
		expandable: row => row.entries.length > 0,
		renderExpand: row => h(NDataTable, {
			size: 'small',
			columns: entryColumns(row.account.account),
			data: row.entries,
			rowKey: (entry: CartEntry) => entry.itemDefId
		})
	},
	{title: '账户名', key: 'account', ellipsis: {tooltip: true}, render: row => row.account.account},
	{title: '余额', key: 'balance', width: 100, render: row => formatBalance(row.account)},
	{title: '消耗余额', key: 'cost', width: 100, render: row => formatCents(cartTotals(row.entries).costCents, row.account.currencyISO)},
	{title: '件数', key: 'units', width: 60, render: row => String(cartTotals(row.entries).units)},
	{
		title: '',
		key: 'clear',
		width: 60,
		render: row => h(NButton, {size: 'tiny', quaternary: true, disabled: !row.entries.length, onClick: () => clearAccountCart(row.account.account)}, () => '清空')
	}
];
</script>

<template>
	<section class="panel">
		<header class="panel-header">
			<h2>购物车</h2>
			<NSpace :size="6">
				<NButton size="small" :disabled="!cartGroups.length" @click="maxOutCart">最大购买数量</NButton>
				<NButton size="small" :disabled="!cartGroups.length" @click="clearCart()">清空</NButton>
				<NButton size="small" type="primary" :disabled="!cartGroups.length" :loading="purchase.submitting" @click="submitTask">提交任务</NButton>
			</NSpace>
		</header>

		<div class="picker">
			<span class="muted">购买账户</span>
			<NSelect
				multiple
				filterable
				max-tag-count="responsive"
				:value="selectedNames"
				:options="accountOptions"
				:placeholder="placeholder"
				:disabled="!purchase.accounts.length"
				@update:value="onSelect"
			/>
			<NButton size="small" quaternary :disabled="!purchase.accounts.length" @click="selectAll">全选</NButton>
			<NButton size="small" quaternary :disabled="!purchase.selected.size" @click="onSelect([])">清空选择</NButton>
		</div>

		<div class="summary muted">
			<span>游戏:{{ gameLabel }}</span>
			<span>已选账号:{{ selectedAccounts.length }}</span>
			<span>含商品账号:{{ cartGroups.length }}</span>
			<span>商品件数:{{ totalUnits }}</span>
		</div>

		<NDataTable size="small" :columns="columns" :data="rows" :row-key="(row: Row) => row.account.account" :max-height="360">
			<template #empty>
				<span class="muted">{{ selectedAccounts.length ? '从左侧商品表加入购物车' : '先选择购买账户,再从左侧商品表加入购物车' }}</span>
			</template>
		</NDataTable>
	</section>
</template>

<style scoped>
.panel {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.panel-header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

h2 {
	margin: 0;
	font-size: 15px;
	font-weight: 600;
}

.picker {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr) auto auto;
	align-items: center;
	gap: 6px;
}

.summary {
	display: flex;
	flex-wrap: wrap;
	gap: 6px 14px;
	font-size: 12px;
}
</style>
