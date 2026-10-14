<script setup lang="ts">
// 市场求购:左边挂求购单(多账号限同币种、行情参考、固定数量或按余额挂满),右边「我的求购单」(对账、撤销)。
import {computed, h, onMounted, onUnmounted} from 'vue';
import {NButton, NCard, NCheckbox, NDataTable, NInput, NInputNumber, NSelect, NSpace, NTag, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import {errorText} from '../api/http.ts';
import {formatBalance} from '../lib/accounts.ts';
import {
	clampMarketConcurrency, currencyPrefix, formatCentsIn, lockedOut, placeConfirmText, placeSummary, quantityText, selectAllSameCurrency,
	suggestedPrice, syncSummaryText
} from '../lib/market.ts';
import type {BuyOrder} from '../lib/market.ts';
import {
	cancelOrder, currency, enterMarket, fetchContext, leaveMarket, market, maxPreview, placeOrders, refreshAccounts, selectedAccounts,
	syncOrders, visibleOrders
} from '../stores/market.ts';

const message = useMessage();
const dialog = useDialog();

onMounted(enterMarket);
onUnmounted(leaveMarket);

const prefix = computed(() => currencyPrefix(currency.value.currency, currency.value.currencyISO) || '-');

const currencyHint = computed(() => {
	if (currency.value.mixed) return '混合(需统一)';
	if (currency.value.currency != null) return currency.value.currencyISO || String(currency.value.currency);
	return '-';
});

// ===== 账号 =====
const accountOptions = computed<SelectOption[]>(() => market.accounts.map(account => ({
	value: account.account,
	label: `${account.account} · ${account.currencyISO || ''} · ${formatBalance(account)}`,
	// 已选了某币种后,别的币种的账号置灰
	disabled: lockedOut(account, currency.value, market.selected.includes(account.account))
})));

const placeholder = computed(() => {
	if (market.accounts.length) return '请选择在线账户';
	if (market.loadingAccounts) return '正在加载在线账户...';
	if (market.accountError) return market.accountError;
	return '暂无在线账户,先在账户页登录';
});

function setSelected(names: string[]): void {
	market.selected = names;
}

// ===== 行情 =====
function onUrlInput(value: string): void {
	market.url = value;
	market.context = null;
}

async function queryContext(): Promise<void> {
	if (!market.url.trim()) {
		message.warning('请先粘贴商品链接');
		return;
	}
	if (!selectedAccounts.value.length) {
		message.warning('请先选择一个账户(按其钱包币种获取行情)');
		return;
	}
	try {
		await fetchContext();
	} catch (err) {
		message.error('行情获取失败:' + errorText(err));
	}
}

const contextCurrency = computed(() => market.context ? currencyPrefix(market.context.currency, market.context.currencyISO) : '');
const suggestion = computed(() => (market.context ? suggestedPrice(market.context.highestBuyOrderCents) : null));

// ===== 价格 / 数量 =====
function setPrice(value: number | null): void {
	market.price = value;
}

function setQuantity(value: number | null): void {
	market.quantity = value;
}

const validPrice = computed(() => Number.isFinite(Number(market.price)) && Number(market.price) > 0);
const validQuantity = computed(() => Number.isInteger(Number(market.quantity)) && Number(market.quantity) > 0);
const quantityOk = computed(() => (market.perAccountMax ? !!maxPreview.value?.ok && maxPreview.value.total > 0 : validQuantity.value));

const totalText = computed(() => {
	if (market.perAccountMax) {
		return maxPreview.value?.ok && maxPreview.value.total > 0 ? `约 ${maxPreview.value.total} 件` : '-';
	}
	if (currency.value.currency == null || !validPrice.value || !validQuantity.value) {
		return '-';
	}
	return `${prefix.value}${(Number(market.price) * Number(market.quantity)).toFixed(2)}`;
});

const canPlace = computed(() => !market.placing && selectedAccounts.value.length > 0 && !currency.value.mixed && currency.value.currency != null
	&& validPrice.value && quantityOk.value && !!market.url.trim());

function place(): void {
	if (!canPlace.value) {
		return;
	}
	const text = placeConfirmText({
		accounts: selectedAccounts.value.length,
		itemName: market.context?.itemName || '',
		concurrency: clampMarketConcurrency(market.concurrency),
		prefix: currencyPrefix(currency.value.currency, currency.value.currencyISO),
		pricePerItem: Number(market.price),
		quantity: Math.round(Number(market.quantity)),
		max: market.perAccountMax ? maxPreview.value : null
	});
	dialog.warning({
		title: '确认挂求购单',
		content: () => h('div', {style: 'white-space: pre-wrap'}, text),
		positiveText: '确认挂单',
		negativeText: '取消',
		onPositiveClick: () => {
			doPlace();
		}
	});
}

async function doPlace(): Promise<void> {
	try {
		const outcome = await placeOrders();
		const summary = placeSummary(outcome.placed, outcome.results);
		message[summary.level](summary.message);
		if (summary.failed.length) {
			dialog.warning({
				title: '部分账号挂单失败',
				content: () => h('div', {style: 'white-space: pre-wrap'}, summary.failed.map(result => `${result.account}:${result.error}`).join('\n')),
				positiveText: '知道了'
			});
		}
	} catch (err) {
		message.error('挂单失败:' + errorText(err));
	}
}

// ===== 我的求购单 =====
async function sync(): Promise<void> {
	try {
		const outcome = await syncOrders();
		if (!outcome) {
			message.warning('请先在左侧选择要查看求购单的在线账户');
			return;
		}
		message.success(syncSummaryText(outcome.summary));
		const offline = (outcome.summary.accounts || []).filter(account => !account.ok);
		if (offline.length) {
			message.warning(`${offline.length} 个账号未刷新(${offline.map(account => `${account.account}:${account.error}`).join(';')})`);
		}
	} catch (err) {
		message.error('刷新失败:' + errorText(err));
	}
}

function confirmCancel(order: BuyOrder): void {
	dialog.warning({
		title: '撤销求购单',
		content: `撤销该求购单:${order.itemName || order.marketHashName}?`,
		positiveText: '撤销',
		negativeText: '取消',
		onPositiveClick: async () => {
			try {
				await cancelOrder(order.id);
				message.success('已撤销');
			} catch (err) {
				message.error('撤销失败:' + errorText(err));
			}
		}
	});
}

const orderColumns: DataTableColumns<BuyOrder> = [
	{title: '账号', key: 'account', width: 110, ellipsis: {tooltip: true}},
	{
		title: '物品',
		key: 'item',
		ellipsis: {tooltip: true},
		render: order => h('span', {class: 'order-item'}, [
			order.itemName || order.marketHashName,
			order.status === 'pending_confirm'
				? h(NTag, {size: 'small', type: 'warning', bordered: false, title: '该求购单尚未经 Steam 手机令牌确认,需在 Steam 手机 App 确认后才会生效'}, () => '待手机确认')
				: null
		])
	},
	{title: '单价', key: 'price', width: 90, render: order => formatCentsIn(order.pricePerItemCents, order.currency, order.currencyISO)},
	{title: '数量', key: 'quantity', width: 70, render: order => h('span', {title: '剩余/总数量'}, quantityText(order))},
	{
		title: '操作',
		key: 'cancel',
		width: 70,
		render: order => h(NButton, {size: 'tiny', type: 'error', secondary: true, onClick: () => confirmCancel(order)}, () => '撤销')
	}
];

const ordersEmpty = computed(() => (market.visibleIds
	? '本次没有可显示的求购单'
	: '挂完求购单后显示本次结果;查看/撤销之前挂出的单,请在左侧选中对应在线账户后点「刷新」'));
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>市场求购</h1>
				<div class="module-counts">
					<span>在线账户:{{ market.accounts.length }}</span>
					<span>已选账户:{{ selectedAccounts.length }}</span>
					<span>币种:{{ currencyHint }}</span>
					<span>我的求购:{{ visibleOrders.length }}</span>
				</div>
			</div>
			<NButton :loading="market.loadingAccounts" @click="refreshAccounts()">刷新账户</NButton>
		</header>

		<div class="market-layout">
			<NCard size="small" :bordered="false" title="挂求购单">
				<div class="form">
					<label class="field-label">求购账户(可多选,限同一币种)</label>
					<div class="picker">
						<NSelect
							multiple
							filterable
							max-tag-count="responsive"
							:value="market.selected"
							:options="accountOptions"
							:placeholder="placeholder"
							:disabled="!market.accounts.length"
							@update:value="setSelected"
						/>
						<NButton size="small" quaternary :disabled="!market.accounts.length" @click="setSelected(selectAllSameCurrency(market.accounts, currency))">全选</NButton>
						<NButton size="small" quaternary :disabled="!market.selected.length" @click="setSelected([])">清空选择</NButton>
					</div>

					<label class="field-label">商品链接</label>
					<div class="url-row">
						<NInput :value="market.url" placeholder="粘贴 https://steamcommunity.com/market/listings/730/..." @update:value="onUrlInput" @keyup.enter="queryContext" />
						<NButton :loading="market.contextLoading" @click="queryContext">查行情</NButton>
					</div>
					<p class="hint muted">从商品页地址栏直接复制即可。「查行情」看当前最高求购价 / 最低在售价,辅助定价(选填,需先选一个账户)。</p>

					<div v-if="market.context" class="context">
						<div class="context-name">{{ market.context.itemName || market.context.marketHashName }}</div>
						<NSpace :size="6">
							<NTag type="success" :bordered="false">最高求购 <strong>{{ formatCentsIn(market.context.highestBuyOrderCents, market.context.currency, market.context.currencyISO) }}</strong></NTag>
							<NTag type="warning" :bordered="false">最低在售 <strong>{{ market.context.lowestSellOrderCents != null ? formatCentsIn(market.context.lowestSellOrderCents, market.context.currency, market.context.currencyISO) : (market.context.lowestPrice || '—') }}</strong></NTag>
							<NTag v-if="market.context.medianPrice" :bordered="false">成交均价 <strong>{{ market.context.medianPrice }}</strong></NTag>
							<NTag v-if="market.context.volume" :bordered="false">24h 销量 <strong>{{ market.context.volume }}</strong></NTag>
						</NSpace>
						<NButton v-if="suggestion != null" size="small" secondary type="primary" class="suggest" @click="setPrice(suggestion)">
							↑ 比最高求购高一档 {{ contextCurrency }}{{ suggestion.toFixed(2) }}
						</NButton>
						<p v-else class="hint muted">未取到「最高求购」。CS2/TF2 会自动从本地数据库解析;若仍为空,多为冷门物品或其它游戏(最低在售/均价/销量不受影响)。</p>
					</div>

					<div class="price-grid">
						<div>
							<label class="field-label">每件求购价</label>
							<NInputNumber v-model:value="market.price" :min="0" :step="0.01" :precision="2" placeholder="0.00">
								<template #prefix>{{ prefix }}</template>
							</NInputNumber>
						</div>
						<div>
							<label class="field-label">求购数量</label>
							<NInputNumber
								:value="market.perAccountMax ? (maxPreview?.total ?? null) : market.quantity"
								:min="1"
								:precision="0"
								:disabled="market.perAccountMax"
								@update:value="setQuantity"
							/>
						</div>
					</div>

					<NCheckbox v-model:checked="market.perAccountMax" title="勾选后忽略上方数量,每个所选账号各自按 floor(该账号钱包余额 ÷ 单价) 挂满,不同余额的账号数量各不相同">
						各账号按余额挂满(每个账号单独取最大数量)
					</NCheckbox>
					<div v-if="market.perAccountMax && selectedAccounts.length && validPrice" class="max-preview">
						<template v-if="maxPreview?.ok && maxPreview.total > 0">
							<div class="muted">各账号按余额挂满,合计约 {{ maxPreview.total }} 件<span v-if="maxPreview.unknown">(部分账号余额未知,按 0 件跳过,请先刷新账户)</span></div>
							<div v-for="row in maxPreview.items" :key="row.account" class="max-row">
								<span>{{ row.account }}</span>
								<span class="muted">{{ row.known ? `${prefix}${row.balance!.toFixed(2)}` : '余额未知' }}</span>
								<span>{{ row.known ? `${row.qty} 件` : '跳过' }}</span>
							</div>
						</template>
						<div v-else class="muted">所选账号余额均不足以按当前单价求购 1 件(或余额未知,请刷新账户)</div>
					</div>

					<div class="total-row">
						<span class="muted">{{ market.perAccountMax ? '各账号合计求购' : '单账号总出价' }}</span>
						<strong>{{ totalText }}</strong>
					</div>

					<div class="actions">
						<NSpace align="center" :size="6" title="同时挂单的并发数(线程数),默认 2。多账号时更快,过高可能触发 Steam 风控">
							<span class="muted">线程</span>
							<NInputNumber v-model:value="market.concurrency" size="small" :min="1" :max="8" :precision="0" class="threads" />
						</NSpace>
						<NButton type="primary" :disabled="!canPlace" :loading="market.placing" @click="place">挂求购单</NButton>
					</div>
				</div>
			</NCard>

			<NCard size="small" :bordered="false" title="我的求购单">
				<template #header-extra>
					<NButton size="small" :loading="market.syncing" title="对左侧选中的在线账户从 Steam 实拉真实求购单:成交/撤销/过期的自动移除,剩余数量更新,拉到的单可在此撤销" @click="sync">刷新</NButton>
				</template>
				<NDataTable size="small" :columns="orderColumns" :data="visibleOrders" :row-key="(order: BuyOrder) => order.id" :max-height="520">
					<template #empty>
						<span class="muted">{{ ordersEmpty }}</span>
					</template>
				</NDataTable>
			</NCard>
		</div>
	</div>
</template>

<style scoped>
.market-layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	gap: 16px;
	align-items: start;
}

.form {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.field-label {
	display: block;
	margin-bottom: 4px;
	color: var(--muted);
	font-size: 13px;
}

.picker {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto auto;
	gap: 6px;
	align-items: center;
}

.url-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: 6px;
}

.hint {
	margin: 0;
	font-size: 12px;
}

.context {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 10px 12px;
	border-radius: 6px;
	background: var(--surface-2);
}

.context-name {
	font-weight: 600;
}

.suggest {
	align-self: flex-start;
}

.price-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
}

.max-preview {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 8px 12px;
	border-radius: 6px;
	background: var(--surface-2);
	font-size: 13px;
}

.max-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto 70px;
	gap: 8px;
}

.total-row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
}

.actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 12px;
}

.threads {
	width: 90px;
}

:deep(.order-item) {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

@media (max-width: 1280px) {
	.market-layout {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
