<script setup lang="ts">
// 市场 → 我的在售:选在线账号(默认全部)从 Steam 拉在售列表(在售 / 待确认 / 暂挂),按账号和状态筛,逐个或批量下架。
import {computed, h, onMounted, watch} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NSelect, NSpace, NTag, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey, SelectOption} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {filterListings, formatUnixTime, LISTING_STATUS_LABELS, listingCounts, listingTotals, money} from '../../lib/market-sell.ts';
import type {ListingRow, ListingStatus} from '../../lib/market-sell.ts';
import {market} from '../../stores/market.ts';
import {cancelListing, cancelListings, listings, loadListings} from '../../stores/market-sell.ts';

const message = useMessage();
const dialog = useDialog();

const accountOptions = computed<SelectOption[]>(() => market.accounts.map(account => ({value: account.account, label: account.account})));
/** 要看的账号:没选过就是全部在线账号 */
const chosen = computed(() => listings.accounts ?? market.accounts.map(account => account.account));

function setAccounts(value: string[]): void {
	listings.accounts = value;
}

async function load(): Promise<void> {
	if (!chosen.value.length) {
		message.warning('先选账号(没有在线账户就先去账户页登录)');
		return;
	}
	await loadListings(chosen.value);
	if (listings.error) {
		message.error('读取在售失败:' + listings.error);
	}
}

// 第一次进来、在线账号到了就自动拉一次
onMounted(() => {
	if (!listings.loaded && chosen.value.length) {
		void load();
	}
});
watch(() => market.accounts.length, count => {
	if (count && !listings.loaded && !listings.loading) {
		void load();
	}
});

const failedAccounts = computed(() => listings.results.filter(entry => !entry.ok));

const filterAccountOptions = computed<SelectOption[]>(() => [
	{value: '', label: '全部账号'},
	...[...new Set(listings.rows.map(row => row.account))].map(account => ({value: account, label: account}))
]);
const STATUS_OPTIONS: SelectOption[] = [
	{value: '', label: '全部状态'},
	...(Object.keys(LISTING_STATUS_LABELS) as ListingStatus[]).map(status => ({value: status, label: LISTING_STATUS_LABELS[status].label}))
];

function setFilterAccount(value: string): void {
	listings.filterAccount = value || null;
}

function setFilterStatus(value: string): void {
	listings.filterStatus = (value || null) as ListingStatus | null;
}

function setSelected(keys: DataTableRowKey[]): void {
	listings.selected = keys.map(String);
}

const visible = computed(() => filterListings(listings.rows, {account: listings.filterAccount, status: listings.filterStatus}));
const counts = computed(() => listingCounts(visible.value));
const totals = computed(() => listingTotals(visible.value.filter(row => row.status === 'active')));
/** 批量下架只动看得见的勾选行(换了筛选,藏起来的勾选不算) */
const selectedRows = computed(() => visible.value.filter(row => listings.selected.includes(row.rowKey)));

function confirmCancel(row: ListingRow): void {
	dialog.warning({
		title: '下架',
		content: `下架 ${row.account} 的 ${row.name || row.marketHashName}(买家付 ${money(row.buyerPriceCents, row.currency)})?`,
		positiveText: '下架',
		negativeText: '取消',
		onPositiveClick: async () => {
			try {
				await cancelListing(row);
				message.success('已下架');
			} catch (err) {
				message.error('下架失败:' + errorText(err));
			}
		}
	});
}

function confirmBatchCancel(): void {
	const rows = selectedRows.value;
	if (!rows.length) {
		return;
	}
	dialog.warning({
		title: `批量下架 ${rows.length} 件`,
		content: `逐个下架勾选的 ${rows.length} 件(涉及 ${new Set(rows.map(row => row.account)).size} 个账号),一个失败不影响别的。确定?`,
		positiveText: '下架',
		negativeText: '取消',
		onPositiveClick: async () => {
			const failed = await cancelListings(rows);
			if (!failed.length) {
				message.success(`已下架 ${rows.length} 件`);
				return;
			}
			message.warning(`下架成功 ${rows.length - failed.length} 件,失败 ${failed.length} 件`);
			dialog.warning({
				title: '部分下架失败',
				content: () => h('div', {style: 'white-space: pre-wrap'}, failed.map(entry => `${entry.row.account} · ${entry.row.name || entry.row.marketHashName}:${entry.error}`).join('\n')),
				positiveText: '知道了'
			});
		}
	});
}

const columns = computed<DataTableColumns<ListingRow>>(() => [
	{type: 'selection', disabled: () => listings.cancelling},
	{
		title: '物品',
		key: 'name',
		minWidth: 240,
		render: row => h('div', {class: 'item-cell'}, [
			row.icon ? h('img', {class: 'item-thumb', src: row.icon, alt: '', loading: 'lazy'}) : h('div', {class: 'item-thumb'}),
			h('span', {class: 'item-main', title: row.marketHashName}, row.name || row.marketHashName)
		])
	},
	{
		title: '状态',
		key: 'status',
		width: 80,
		render: row => {
			const status = LISTING_STATUS_LABELS[row.status] ?? {label: row.status, tone: 'default'};
			return h(NTag, {size: 'small', bordered: false, type: status.tone}, () => status.label);
		}
	},
	{title: '买家付', key: 'buyer', width: 100, render: row => money(row.buyerPriceCents, row.currency)},
	{title: '到手', key: 'receive', width: 100, render: row => money(row.receiveCents, row.currency)},
	{title: '上架时间', key: 'time', width: 140, render: row => (row.timeCreated ? formatUnixTime(row.timeCreated) : row.createdAt || '-')},
	{title: '账号', key: 'account', width: 120, ellipsis: {tooltip: true}},
	{
		title: '',
		key: 'cancel',
		width: 70,
		render: row => h(NButton, {size: 'tiny', type: 'error', secondary: true, disabled: listings.cancelling, onClick: () => confirmCancel(row)}, () => '下架')
	}
]);

const empty = computed(() => {
	if (listings.loading) return '正在读取…';
	if (!listings.loaded) return '选好账号后点「读取在售」';
	return listings.rows.length ? '没有符合筛选的在售' : '这些账号没有在售的物品';
});
</script>

<template>
	<NCard size="small" :bordered="false" title="我的在售">
		<div class="toolbar">
			<NSelect
				class="accounts-select"
				multiple
				filterable
				max-tag-count="responsive"
				:value="chosen"
				:options="accountOptions"
				:placeholder="market.accounts.length ? '选账号(默认全部在线账户)' : '暂无在线账户'"
				:disabled="listings.loading || listings.cancelling"
				@update:value="setAccounts"
			/>
			<NButton size="small" quaternary :disabled="!market.accounts.length" @click="setAccounts(market.accounts.map(account => account.account))">全选</NButton>
			<NButton type="primary" :loading="listings.loading" :disabled="listings.cancelling" @click="load">读取在售</NButton>
		</div>

		<NAlert v-if="failedAccounts.length" type="warning" :bordered="false" class="block">
			{{ failedAccounts.length }} 个账号没读到:{{ failedAccounts.map(entry => `${entry.account}:${entry.error}`).join(';') }}
		</NAlert>

		<div class="toolbar">
			<NSelect class="filter-select" :value="listings.filterAccount ?? ''" :options="filterAccountOptions" @update:value="setFilterAccount" />
			<NSelect class="filter-select" :value="listings.filterStatus ?? ''" :options="STATUS_OPTIONS" @update:value="setFilterStatus" />
			<span class="counts">
				共 {{ counts.total }} 件 · 在售 {{ counts.active }} · 待确认 {{ counts.to_confirm }} · 暂挂 {{ counts.on_hold }}
				<template v-for="group in totals" :key="group.currency?.iso ?? '?'">
					· 在售合计买家付 {{ money(group.buyer, group.currency) }}(到手 {{ money(group.receive, group.currency) }})
				</template>
			</span>
			<NSpace class="batch" align="center" :size="8">
				<span v-if="listings.cancelling" class="muted small">正在下架 {{ listings.cancelProgress.done }} / {{ listings.cancelProgress.total }}…</span>
				<NButton size="small" type="error" secondary :disabled="!selectedRows.length" :loading="listings.cancelling" @click="confirmBatchCancel">
					批量下架{{ selectedRows.length ? `(${selectedRows.length})` : '' }}
				</NButton>
			</NSpace>
		</div>

		<NDataTable
			size="small"
			:columns="columns"
			:data="visible"
			:loading="listings.loading"
			:row-key="(row: ListingRow) => row.rowKey"
			:checked-row-keys="listings.selected"
			:pagination="{pageSize: 50}"
			:scroll-x="900"
			@update:checked-row-keys="setSelected"
		>
			<template #empty>
				<span class="muted">{{ empty }}</span>
			</template>
		</NDataTable>
		<p class="muted small hint">「待确认」的要在 Steam 手机 App 里确认后才会出现在市场上;「暂挂」是 Steam 的交易暂挂期,到期后自动在售。</p>
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

.accounts-select {
	flex: 1;
	min-width: 260px;
	max-width: 640px;
}

.filter-select {
	width: 140px;
}

.counts {
	font-size: 13px;
}

.batch {
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
