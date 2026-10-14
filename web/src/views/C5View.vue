<script setup lang="ts">
// C5 扫货:顶栏是运行状态(停止 / 只看行情 / 自动扫货)和汇总;中间是监控列表(直接改目标价、数量、花费上限,
// 改过没保存的格子标黄,点「保存」后下一轮按新价扫);下面是购买流水和运行日志。设置、查在售在弹窗里。
import {computed, h, onMounted, onUnmounted, reactive, ref} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NInput, NInputNumber, NRadioButton, NRadioGroup, NSelect, NSpace, NTag, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import type {VNodeChild} from 'vue';
import {errorText} from '../api/http.ts';
import {
	ASSET_TYPE_OPTIONS, budgetText, DELIVERY_OPTIONS, dirtyFields, formatTime, itemStatus, liveConfirmText, money, purchaseStatus, removedNames, RUN_LABELS
} from '../lib/c5.ts';
import type {C5Purchase, C5RunState, DraftField, DraftRow} from '../lib/c5.ts';
import {
	addDraft, c5, checkConnection, clearDryPurchases, dirty, discardDrafts, enterC5, leaveC5, refreshOrders, removeDraft, resolvePurchase,
	saveWatchlist, serverItems, setRun
} from '../stores/c5.ts';
import ListingsModal from './c5/ListingsModal.vue';
import SettingsModal from './c5/SettingsModal.vue';

const message = useMessage();
const dialog = useDialog();

function warnUnsaved(event: BeforeUnloadEvent): void {
	if (dirty.value) {
		event.preventDefault();
		event.returnValue = '';
	}
}

onMounted(() => {
	enterC5();
	window.addEventListener('beforeunload', warnUnsaved);
});
onUnmounted(() => {
	leaveC5();
	window.removeEventListener('beforeunload', warnUnsaved);
});

const state = computed(() => c5.state);
const live = computed(() => state.value?.settings.mode === 'live');
const viewByName = computed(() => new Map((state.value?.items ?? []).map(item => [item.name, item])));
const removed = computed(() => removedNames(c5.drafts, serverItems.value));

const settingsOpen = ref(false);
const listingsName = ref('');

const cycleText = computed(() => {
	const value = state.value;
	if (!value || value.run === 'stopped') return '未运行';
	if (!value.cycle.at) return '等待第一轮';
	return `第 ${value.cycle.n} 轮 · ${formatTime(value.cycle.at)}`;
});

// ===== 运行状态 =====
const runBusy = ref(false);

async function doRun(next: C5RunState): Promise<void> {
	runBusy.value = true;
	try {
		await setRun(next);
		if (next === 'sweeping' && dirty.value) {
			message.warning('监控列表有改动还没保存,扫货按已保存的列表进行');
		}
	} catch (err) {
		message.error('操作失败:' + errorText(err));
	} finally {
		runBusy.value = false;
	}
}

function changeRun(next: C5RunState): void {
	const value = state.value;
	if (!value || next === value.run) return;
	if (next !== 'stopped' && !value.configured) {
		message.warning('先在「设置」里填 C5 app-key');
		settingsOpen.value = true;
		return;
	}
	if (next === 'sweeping' && value.settings.mode === 'live') {
		dialog.warning({
			title: '开始实盘扫货',
			content: () => h('div', {class: 'pre'}, liveConfirmText(value.settings, serverItems.value.length)),
			positiveText: '开始',
			negativeText: '取消',
			onPositiveClick: () => {
				doRun(next);
			}
		});
		return;
	}
	doRun(next);
}

// ===== 检查连接 =====
const checking = ref(false);

async function check(): Promise<void> {
	if (!state.value?.configured) {
		message.warning('先在「设置」里填 C5 app-key');
		settingsOpen.value = true;
		return;
	}
	checking.value = true;
	try {
		const result = await checkConnection();
		dialog.success({
			title: '连接正常,app-key 有效',
			content: () => h('div', {class: 'check-result'}, [
				h('div', `可用余额 ${money(result.balance.money)}(待结算 ${money(result.balance.settle)},保证金 ${money(result.balance.deposit)})`),
				...(result.steamAccounts.length
					? result.steamAccounts.map(account => h('div', `Steam 账号 ${account.steamId} ${account.nickname} · ${account.status}`))
					: [h('div', {class: 'muted'}, 'C5 上没有绑定 Steam 账号,先去官网绑定收货账号')])
			]),
			positiveText: '知道了'
		});
	} catch (err) {
		message.error('检查连接失败:' + errorText(err));
	} finally {
		checking.value = false;
	}
}

// ===== 监控列表 =====
function cell(row: DraftRow, field: DraftField, content: VNodeChild) {
	return h('div', {class: ['cell', dirtyFields(row, serverItems.value).has(field) ? 'cell-dirty' : '']}, [content]);
}

function numberInput(row: DraftRow, field: 'maxPrice' | 'maxQty' | 'maxSpend', props: Record<string, unknown>) {
	return cell(row, field, h(NInputNumber, {
		size: 'small',
		showButton: false,
		value: field === 'maxSpend' ? (row.maxSpend || null) : row[field],
		'onUpdate:value': (value: number | null) => {
			row[field] = field === 'maxSpend' ? (value ?? 0) : value;
		},
		...props
	}));
}

function selectInput(row: DraftRow, field: 'delivery' | 'assetType', options: Array<{value: number; label: string}>) {
	return cell(row, field, h(NSelect, {
		size: 'small',
		value: row[field],
		options,
		consistentMenuWidth: false,
		'onUpdate:value': (value: number) => {
			row[field] = value;
		}
	}));
}

const columns: DataTableColumns<DraftRow> = [
	{
		title: '饰品(Steam 英文名)',
		key: 'name',
		width: 230,
		render: row => (row.origName == null
			? cell(row, 'name', h(NInput, {size: 'small', value: row.name, placeholder: '如 Kilowatt Case', 'onUpdate:value': (value: string) => { row.name = value; }}))
			: h('span', {class: 'item-name', title: row.name}, row.name))
	},
	{
		title: '状态',
		key: 'status',
		width: 84,
		render: row => {
			const view = row.origName == null ? null : viewByName.value.get(row.origName);
			const status = itemStatus(view ? view.status : 'new');
			const title = view?.status === 'cooldown' && view.pauseUntil ? `下单被拒,${formatTime(view.pauseUntil)} 前不再下单` : undefined;
			return h(NTag, {size: 'small', bordered: false, type: status.tone, title}, () => status.label);
		}
	},
	{
		title: 'C5 最低',
		key: 'lowest',
		width: 84,
		render: row => {
			const view = row.origName == null ? null : viewByName.value.get(row.origName);
			const lowest = view?.lowest ?? null;
			const hit = lowest != null && row.maxPrice != null && lowest <= row.maxPrice + 1e-6;
			return h('span', {class: hit ? 'price-hit' : ''}, money(lowest));
		}
	},
	{
		title: '在售 / 求购最高',
		key: 'market',
		width: 120,
		render: row => {
			const view = row.origName == null ? null : viewByName.value.get(row.origName);
			return view ? `${view.sellCount ?? '-'} / ${money(view.purchaseMax)}` : '-';
		}
	},
	{title: '目标价 ≤', key: 'maxPrice', width: 104, render: row => numberInput(row, 'maxPrice', {min: 0, step: 0.01, placeholder: '必填'})},
	{title: '数量上限', key: 'maxQty', width: 92, render: row => numberInput(row, 'maxQty', {min: 1, precision: 0, placeholder: '必填'})},
	{title: '花费上限', key: 'maxSpend', width: 98, render: row => numberInput(row, 'maxSpend', {min: 0, step: 1, placeholder: '不限'})},
	{title: '发货', key: 'delivery', width: 108, render: row => selectInput(row, 'delivery', DELIVERY_OPTIONS)},
	{title: '在售类型', key: 'assetType', width: 116, render: row => selectInput(row, 'assetType', ASSET_TYPE_OPTIONS)},
	{
		title: '已买 · 已花',
		key: 'bought',
		width: 112,
		render: row => {
			const view = row.origName == null ? null : viewByName.value.get(row.origName);
			return h('span', [`${view?.bought ?? 0} / ${row.maxQty ?? '-'}`, h('span', {class: 'muted'}, ` · ${money(view?.spent ?? 0)}`)]);
		}
	},
	{
		title: '操作',
		key: 'actions',
		width: 128,
		render: row => h(NSpace, {size: 4, wrap: false}, () => [
			h(NButton, {
				size: 'tiny',
				secondary: true,
				disabled: row.origName == null,
				title: row.origName == null ? '先保存' : '看目标价以内的在售(也能验证 IP 白名单)',
				onClick: () => {
					listingsName.value = row.origName || '';
				}
			}, () => '查在售'),
			h(NButton, {size: 'tiny', type: 'error', secondary: true, onClick: () => removeDraft(row.uid)}, () => '删除')
		])
	}
];

const newItem = reactive({name: '', maxPrice: null as number | null, maxQty: null as number | null});

function add(): void {
	const name = newItem.name.trim();
	if (!name) {
		message.warning('填饰品的 Steam 英文名(marketHashName),要和市场上的完全一致');
		return;
	}
	if (c5.drafts.some(row => row.name.trim() === name)) {
		message.warning(`${name} 已经在列表里了`);
		return;
	}
	addDraft({name, maxPrice: newItem.maxPrice, maxQty: newItem.maxQty});
	newItem.name = '';
	newItem.maxPrice = null;
	newItem.maxQty = null;
}

async function save(): Promise<void> {
	try {
		await saveWatchlist();
		message.success('监控列表已保存,下一轮按新价扫');
	} catch (err) {
		message.error('保存失败:' + errorText(err));
	}
}

// ===== 购买流水 =====
const syncing = ref(false);

async function sync(): Promise<void> {
	syncing.value = true;
	try {
		const checked = await refreshOrders();
		message.success(`已向平台同步 ${checked} 笔未完结订单`);
	} catch (err) {
		message.error('同步失败:' + errorText(err));
	} finally {
		syncing.value = false;
	}
}

function confirmResolve(purchase: C5Purchase, status: 'ok' | 'failed'): void {
	dialog.warning({
		title: status === 'ok' ? '标记为已成交' : '标记为未成交',
		content: `${purchase.name} 单号 ${purchase.outTradeNo}:先去 C5 官网核对这笔单的真实结果。`
			+ (status === 'ok' ? '标记已成交后会继续占用数量和预算。' : '标记未成交后会释放数量和预算,可能再买一件。'),
		positiveText: '标记',
		negativeText: '取消',
		onPositiveClick: async () => {
			try {
				await resolvePurchase(purchase.outTradeNo, status);
				message.success('已标记');
			} catch (err) {
				message.error('标记失败:' + errorText(err));
			}
		}
	});
}

function confirmClearDry(): void {
	dialog.warning({
		title: '清空模拟记录',
		content: '删掉全部模拟买入记录,模拟的数量和预算从零算。实盘流水不受影响。',
		positiveText: '清空',
		negativeText: '取消',
		onPositiveClick: async () => {
			try {
				await clearDryPurchases();
				message.success('已清空模拟记录');
			} catch (err) {
				message.error('清空失败:' + errorText(err));
			}
		}
	});
}

const purchaseColumns: DataTableColumns<C5Purchase> = [
	{title: '时间', key: 'ts', width: 130, render: purchase => formatTime(purchase.ts)},
	{title: '饰品', key: 'name', minWidth: 150, ellipsis: {tooltip: true}},
	{title: '价格', key: 'cost', width: 70, render: purchase => money(purchase.cost)},
	{
		title: '状态',
		key: 'status',
		width: 88,
		render: purchase => {
			const status = purchaseStatus(purchase.status);
			return h(NTag, {size: 'small', bordered: false, type: status.tone, title: purchase.error || undefined}, () => status.label);
		}
	},
	{
		title: '平台订单',
		key: 'order',
		minWidth: 150,
		ellipsis: {tooltip: true},
		render: purchase => {
			if (purchase.mode === 'dry') return h('span', {class: 'muted'}, '模拟');
			const parts = [purchase.orderId || '-', purchase.orderStatusName || (purchase.orderStatus != null ? `状态 ${purchase.orderStatus}` : '')].filter(Boolean);
			return h('span', {title: `商户单号 ${purchase.outTradeNo}${purchase.error ? '\n' + purchase.error : ''}`}, parts.join(' · '));
		}
	},
	{
		title: '',
		key: 'actions',
		width: 140,
		render: purchase => (purchase.status === 'unknown' && purchase.mode === 'live'
			? h(NSpace, {size: 4, wrap: false}, () => [
				h(NButton, {size: 'tiny', secondary: true, onClick: () => confirmResolve(purchase, 'ok')}, () => '标记成交'),
				h(NButton, {size: 'tiny', secondary: true, onClick: () => confirmResolve(purchase, 'failed')}, () => '标记失败')
			])
			: null)
	}
];

// ===== 日志 =====
const logLines = computed(() => (state.value?.logs ?? []).slice().reverse());

async function copyLogs(): Promise<void> {
	const text = (state.value?.logs ?? []).map(line => `${formatTime(line.time)} ${line.message}`).join('\n');
	try {
		await navigator.clipboard.writeText(text);
		message.success('已复制');
	} catch {
		message.error('复制失败(浏览器不允许访问剪贴板)');
	}
}
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>C5 扫货</h1>
				<div class="module-counts">
					<span>模式:<NTag size="small" :bordered="false" :type="live ? 'error' : 'default'">{{ live ? '实盘' : '模拟' }}</NTag></span>
					<span>策略:{{ state?.settings.strategy === 'quick' ? '快速购买' : '按在售列表' }}</span>
					<span>已花 / 预算:{{ state ? budgetText(state.budget) : '-' }}</span>
					<span>已买:{{ state?.budget.qty ?? 0 }} 件</span>
					<span v-if="live">C5 余额:{{ money(state?.balance?.value) }}</span>
					<span>{{ cycleText }}</span>
				</div>
			</div>
			<NSpace align="center">
				<NRadioGroup :value="state?.run ?? 'stopped'" :disabled="!state || runBusy" size="small" @update:value="changeRun">
					<NRadioButton value="stopped">{{ RUN_LABELS.stopped }}</NRadioButton>
					<NRadioButton value="watching">{{ RUN_LABELS.watching }}</NRadioButton>
					<NRadioButton value="sweeping">{{ RUN_LABELS.sweeping }}</NRadioButton>
				</NRadioGroup>
				<NButton :loading="checking" @click="check">检查连接</NButton>
				<NButton type="primary" @click="settingsOpen = true">设置</NButton>
			</NSpace>
		</header>

		<NAlert v-if="c5.error && !state" type="error" :bordered="false">加载失败:{{ c5.error }}</NAlert>
		<template v-if="state">
			<NAlert v-if="!state.configured" type="warning" :bordered="false">
				还没填 C5 app-key。点右上角「设置」填写(C5GAME 官网 → 个人中心 → API 管理 申请),并在同一页把服务器的公网 IP 加进白名单。
			</NAlert>
			<NAlert v-if="state.settingsError" type="warning" :bordered="false">数据库里的设置无效,已退回默认值:{{ state.settingsError }}</NAlert>
			<NAlert v-if="state.run !== 'stopped' && state.cycle.error" type="error" :bordered="false">
				本轮失败(连续 {{ state.cycle.errors }} 次,自动退避重试):{{ state.cycle.error }}
			</NAlert>
			<NAlert v-if="live && state.unknown > 0" type="warning" :bordered="false">
				有 {{ state.unknown }} 笔下单结果未知,先按已花费占着额度,正在自动对账;一直对不上的,去 C5 官网核对后在购买流水里手工标记。
			</NAlert>
			<NAlert v-if="state.run !== 'stopped' && state.cycle.done && state.items.length" type="info" :bordered="false">
				所有目标已买满或预算用完。改价、加饰品或调预算后自动继续。
			</NAlert>
		</template>

		<NCard size="small" :bordered="false" title="监控列表">
			<template #header-extra>
				<NSpace v-if="dirty" align="center" :size="8">
					<span class="dirty-hint">有改动没保存{{ removed.length ? `(将删除 ${removed.join('、')})` : '' }}</span>
					<NButton size="small" :disabled="c5.savingList" @click="discardDrafts">放弃修改</NButton>
					<NButton size="small" type="primary" :loading="c5.savingList" @click="save">保存</NButton>
				</NSpace>
				<span v-else class="muted hint">直接改目标价、数量、花费上限,点保存后下一轮按新价扫</span>
			</template>
			<NDataTable
				size="small"
				:columns="columns"
				:data="c5.drafts"
				:row-key="(row: DraftRow) => row.uid"
				:loading="!state && c5.loading"
				:scroll-x="1300"
			>
				<template #empty>
					<span class="muted">还没有要监控的饰品,在下面添加</span>
				</template>
			</NDataTable>
			<div class="add-row">
				<NInput v-model:value="newItem.name" size="small" placeholder="饰品 Steam 英文名(marketHashName),如 Kilowatt Case" @keyup.enter="add" />
				<NInputNumber v-model:value="newItem.maxPrice" size="small" :min="0" :step="0.01" :show-button="false" placeholder="目标价" />
				<NInputNumber v-model:value="newItem.maxQty" size="small" :min="1" :precision="0" :show-button="false" placeholder="数量上限" />
				<NButton size="small" @click="add">添加</NButton>
			</div>
		</NCard>

		<div class="c5-bottom">
			<NCard size="small" :bordered="false" :title="`购买流水(${live ? '实盘' : '模拟'},最近 50 笔)`">
				<template #header-extra>
					<NButton v-if="live" size="small" :loading="syncing" title="立刻向平台查一遍全部未完结订单(平时每轮自动查几笔)" @click="sync">同步订单</NButton>
					<NButton v-else size="small" :disabled="!state?.purchases.length" @click="confirmClearDry">清空模拟记录</NButton>
				</template>
				<NDataTable size="small" :columns="purchaseColumns" :data="state?.purchases ?? []" :row-key="(row: C5Purchase) => row.outTradeNo" :max-height="360" :scroll-x="720">
					<template #empty>
						<span class="muted">{{ live ? '还没有实盘买入' : '还没有模拟买入。模拟模式到价只记账不花钱' }}</span>
					</template>
				</NDataTable>
			</NCard>
			<NCard size="small" :bordered="false" title="运行日志">
				<template #header-extra>
					<NButton size="small" quaternary :disabled="!logLines.length" @click="copyLogs">复制</NButton>
				</template>
				<div class="c5-logs mono">
					<div v-for="(line, index) in logLines" :key="index" :class="['log-line', 'log-' + line.level]">
						<span class="muted">{{ formatTime(line.time) }}</span> {{ line.message }}
					</div>
					<div v-if="!logLines.length" class="muted">暂无</div>
				</div>
			</NCard>
		</div>

		<SettingsModal :show="settingsOpen" @close="settingsOpen = false" />
		<ListingsModal :name="listingsName" @close="listingsName = ''" />
	</div>
</template>

<style scoped>
/* 内容比一屏长,交给外层滚动 */
.module-page {
	height: auto;
	min-height: 100%;
}

.hint {
	font-size: 12px;
}

.dirty-hint {
	color: var(--warn);
	font-size: 12px;
}

.add-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 110px 110px auto;
	gap: 6px;
	margin-top: 10px;
}

.c5-bottom {
	display: grid;
	grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
	gap: 12px;
	align-items: start;
}

.c5-logs {
	max-height: 360px;
	overflow: auto;
	font-size: 12px;
	line-height: 1.6;
	white-space: pre-wrap;
	word-break: break-all;
}

.log-debug {
	color: var(--muted);
}

.log-success {
	color: var(--ok);
}

.log-warn {
	color: var(--warn);
}

.log-error {
	color: var(--danger);
}

:deep(.pre) {
	white-space: pre-wrap;
}

:deep(.check-result) {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

:deep(.cell) {
	border-radius: 4px;
}

:deep(.cell-dirty) {
	box-shadow: 0 0 0 1px var(--warn);
	background: rgba(242, 193, 93, 0.12);
}

:deep(.item-name) {
	font-weight: 500;
}

:deep(.price-hit) {
	color: var(--ok);
	font-weight: 600;
}

@media (max-width: 1280px) {
	.c5-bottom {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
