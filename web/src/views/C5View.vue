<script setup lang="ts">
// C5 扫货:顶栏是运行状态(停止 / 自动扫货,真实下单)和汇总;中间是监控列表(直接改目标价、数量、花费上限,
// 改过没保存的格子标黄,点「保存」后下一轮按新价扫);下面是购买流水。运行日志写在右下角的「实时运行日志」里。设置、查在售在弹窗里。
// 添加饰品输中文或英文搜(C5 接口只认 Steam 英文名,后端词库把中文换成英文名),表格里显示中文名。
import {computed, h, onMounted, onUnmounted, reactive, ref} from 'vue';
import {
	NAlert, NButton, NCard, NDataTable, NInput, NInputNumber, NModal, NRadioButton, NRadioGroup, NSelect, NSpace, NTag, NTooltip, useDialog, useMessage
} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import {withTip} from '../components/tip.ts';
import type {VNodeChild} from 'vue';
import {ApiError, errorText} from '../api/http.ts';
import {
	ASSET_TYPE_OPTIONS, budgetText, DELIVERY_OPTIONS, dirtyFields, formatTime, isTradeUrlOf, itemLabel, itemStatus, money, partnerOf, priceText, purchaseStatus,
	receiverC5Note, receiverMatches, receiverOptionLabel, receiverText, removedNames, RUN_LABELS, sortReceiverAccounts, sweepBlocker, sweepConfirmText
} from '../lib/c5.ts';
import type {C5NameOption, C5Purchase, C5ReceiverAccount, C5RunState, DraftField, DraftRow} from '../lib/c5.ts';
import {
	addDraft, c5, checkConnection, dirty, discardDrafts, enterC5, fetchReceivers, leaveC5, refreshOrders, removeDraft, resolvePurchase,
	saveReceiverTradeUrl, saveWatchlist, searchNames, serverItems, setRun, switchReceiver
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
	loadReceivers();
	window.addEventListener('beforeunload', warnUnsaved);
});
onUnmounted(() => {
	leaveC5();
	window.removeEventListener('beforeunload', warnUnsaved);
});

const state = computed(() => c5.state);
const viewByName = computed(() => new Map((state.value?.items ?? []).map(item => [item.name, item])));
const labelOf = (name: string) => itemLabel(viewByName.value.get(name) ?? {name});
const removed = computed(() => removedNames(c5.drafts, serverItems.value).map(labelOf));

const settingsOpen = ref(false);
const listingsName = ref('');

// ===== 收货账号:顶栏下拉,从 C5 上绑定的 Steam 账号里选,选中马上取交易链接并保存 =====
// C5 开放平台不给交易链接,下单又必须带:账户管理里有同一个账号的自动去 Steam 取,取不到用记下的,都没有就弹框让人贴一次
const receiverAccounts = ref<C5ReceiverAccount[]>([]);
const receiversError = ref<string | null>(null);
const receiversLoading = ref(false);
const switchingReceiver = ref(false);
const receiverNote = computed(() => receiverC5Note(state.value?.receiver ?? null));

async function loadReceivers(): Promise<void> {
	receiversLoading.value = true;
	try {
		const result = await fetchReceivers();
		receiverAccounts.value = result.accounts;
		receiversError.value = result.boundError;
	} catch (err) {
		receiversError.value = errorText(err);
	} finally {
		receiversLoading.value = false;
	}
}

// 状态正常的在前;昵称、Steam 登录名、SteamID、账户管理里的账号名都能搜
const receiverOptions = computed(() => sortReceiverAccounts(receiverAccounts.value).map(account => ({
	value: account.steamId,
	label: receiverOptionLabel(account),
	item: account
})));
const filterReceiver = (pattern: string, option: SelectOption) => receiverMatches(option.item as C5ReceiverAccount, pattern);
/** 当前收货账号是下拉里的哪一个;不是 C5 绑定的链接不在下拉里,显示成占位文字 */
const receiverValue = computed(() => {
	const steamId = state.value?.receiver?.steamId;
	return steamId && receiverAccounts.value.some(entry => entry.steamId === steamId) ? steamId : null;
});
const receiverPlaceholder = computed(() => (state.value?.receiver ? receiverText(state.value.receiver) : '选收货账号'));
const nameOfReceiver = (steamId: string) => {
	const account = receiverAccounts.value.find(entry => entry.steamId === steamId);
	return account ? account.nickname || account.username || steamId : steamId;
};

async function pickReceiver(steamId: string | null): Promise<void> {
	if (!steamId || steamId === receiverValue.value) {
		return;
	}
	switchingReceiver.value = true;
	try {
		const {warning} = await switchReceiver(steamId);
		if (warning) {
			message.warning(`收货账号已改为 ${nameOfReceiver(steamId)}。${warning}`, {duration: 6000});
		} else {
			message.success(`收货账号已改为 ${nameOfReceiver(steamId)}`);
		}
		void loadReceivers();
	} catch (err) {
		if (err instanceof ApiError && err.status === 409) {
			Object.assign(paste, {show: true, steamId, tradeUrl: '', error: ''});
		} else {
			message.error('换收货账号失败:' + errorText(err));
		}
	} finally {
		switchingReceiver.value = false;
	}
}

// 贴交易链接:只收这个账号自己的链接(partner 对得上 SteamID)
const paste = reactive({show: false, steamId: '', tradeUrl: '', error: '', saving: false});

async function savePastedTradeUrl(): Promise<void> {
	const tradeUrl = paste.tradeUrl.trim();
	if (!isTradeUrlOf(tradeUrl, paste.steamId)) {
		paste.error = partnerOf(tradeUrl) == null ? '不是交易链接' : `这不是 ${nameOfReceiver(paste.steamId)} 的交易链接(SteamID 对不上)`;
		return;
	}
	paste.saving = true;
	try {
		await saveReceiverTradeUrl(tradeUrl);
		message.success(`收货账号已改为 ${nameOfReceiver(paste.steamId)},交易链接已记下`);
		paste.show = false;
		void loadReceivers();
	} catch (err) {
		paste.error = errorText(err);
	} finally {
		paste.saving = false;
	}
}

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
	} catch (err) {
		message.error('操作失败:' + errorText(err));
	} finally {
		runBusy.value = false;
	}
}

function changeRun(next: C5RunState): void {
	const value = state.value;
	if (!value || next === value.run) return;
	if (next === 'stopped') {
		doRun(next);
		return;
	}
	if (value.configured && !value.settings.tradeUrl) {
		message.warning('不能开始自动扫货:还没选收货账号,先在页面顶部选');
		return;
	}
	const blocker = value.configured ? sweepBlocker(value.settings) : '没填 C5 app-key';
	if (blocker) {
		message.warning(`不能开始自动扫货:${blocker},先在「设置」里填`);
		settingsOpen.value = true;
		return;
	}
	// 扫货按已保存的列表下单:页面上改了价没保存就开扫,会按旧价买
	if (dirty.value) {
		message.warning('监控列表有改动还没保存,先「保存」或「放弃修改」再开始自动扫货');
		return;
	}
	dialog.warning({
		title: '开始自动扫货(真实下单)',
		content: () => h('div', {class: 'pre'}, sweepConfirmText(value.settings, serverItems.value.length, value.receiver)),
		positiveText: '开始',
		negativeText: '取消',
		onPositiveClick: () => {
			doRun(next);
		}
	});
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

/** 中文名一行,英文名(C5 接口用的)小字一行;词库里没有的只有英文名 */
function nameCell(row: DraftRow): VNodeChild {
	return h('div', {class: 'item-name', title: row.name}, [
		h('div', {class: 'item-zh'}, itemLabel(row)),
		row.zh ? h('div', {class: 'item-en muted'}, row.name) : null
	]);
}

const columns: DataTableColumns<DraftRow> = [
	{
		title: '饰品',
		key: 'name',
		width: 260,
		render: row => (row.origName == null ? cell(row, 'name', nameCell(row)) : nameCell(row))
	},
	{
		title: '状态',
		key: 'status',
		width: 84,
		render: row => {
			const view = row.origName == null ? null : viewByName.value.get(row.origName);
			const status = itemStatus(view ? view.status : 'new');
			const tip = view?.status === 'cooldown' && view.pauseUntil ? `下单被拒或查在售失败,${formatTime(view.pauseUntil)} 前不再下单` : '';
			const tag = h(NTag, {size: 'small', bordered: false, type: status.tone}, () => status.label);
			return tip ? withTip(tag, tip) : tag;
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

// ===== 添加饰品:输中文或英文,停 300 毫秒后向后端搜(带 C5 在售最低价),从下拉里选 =====
const newItem = reactive({maxPrice: null as number | null, maxQty: null as number | null});
const nameSearch = reactive({
	query: '', loading: false, options: [] as C5NameOption[], picked: null as C5NameOption | null, priced: false, priceError: null as string | null
});
let searchSeq = 0;
let searchTimer: number | undefined;

const nameOptions = computed<SelectOption[]>(() => {
	const {picked, options} = nameSearch;
	const list = picked && !options.some(option => option.name === picked.name) ? [picked, ...options] : options;
	return list.map(option => ({value: option.name, label: option.zh ?? option.name, item: option}));
});

function onSearch(query: string): void {
	window.clearTimeout(searchTimer);
	const q = query.trim();
	nameSearch.query = q;
	const seq = ++searchSeq;
	if (!q) {
		nameSearch.options = [];
		nameSearch.loading = false;
		return;
	}
	nameSearch.loading = true;
	searchTimer = window.setTimeout(async () => {
		try {
			const result = await searchNames(q);
			if (seq === searchSeq) {
				Object.assign(nameSearch, {options: result.options, priced: result.priced, priceError: result.priceError});
			}
		} catch (err) {
			if (seq === searchSeq) {
				nameSearch.options = [];
				message.error('搜索饰品失败:' + errorText(err));
			}
		} finally {
			if (seq === searchSeq) {
				nameSearch.loading = false;
			}
		}
	}, 300);
}

function pickName(value: string | null, option: SelectOption | null): void {
	nameSearch.picked = value && option ? option.item as C5NameOption : null;
}

/** 下拉每一行:左边中文名 + 英文名,右边 C5 在售最低价和在售数 */
function renderNameOption(option: SelectOption): VNodeChild {
	const item = option.item as C5NameOption;
	const small = {class: 'muted', style: 'font-size: 12px; margin-left: 8px'};
	const price = priceText(item, nameSearch.priced);
	return h('div', {style: 'display: flex; justify-content: space-between; gap: 16px; width: 100%'}, [
		item.zh
			? h('span', [item.zh, h('span', small, item.name)])
			: h('span', [`按英文名添加:${item.name}`, h('span', small, '词库里没有,要和 Steam 英文名完全一致')]),
		price ? h('span', {style: `white-space: nowrap; ${item.lowest != null ? 'color: var(--ok)' : ''}`, class: item.lowest == null ? 'muted' : ''}, price) : null
	]);
}

/** 下拉底部:价格从哪来,或者为什么没价格 */
const priceNote = computed(() => {
	if (!nameSearch.query || nameSearch.loading || !nameSearch.options.length) {
		return '';
	}
	if (nameSearch.priceError) {
		return `C5 价格没查到:${nameSearch.priceError}`;
	}
	return nameSearch.priced ? '价格是 C5 在售最低价(元)' : '填了 C5 app-key 才显示价格';
});

const targetPlaceholder = computed(() => {
	const lowest = nameSearch.picked?.lowest;
	return lowest != null ? `目标价(现最低 ${money(lowest)})` : '目标价';
});

function add(): void {
	const picked = nameSearch.picked;
	if (!picked) {
		message.warning('先在饰品框里输中文或英文名(如 千瓦、红线 久经),从下拉里选一个');
		return;
	}
	if (c5.drafts.some(row => row.name.trim() === picked.name)) {
		message.warning(`${itemLabel(picked)} 已经在列表里了`);
		return;
	}
	addDraft({name: picked.name, zh: picked.zh, maxPrice: newItem.maxPrice, maxQty: newItem.maxQty});
	nameSearch.picked = null;
	nameSearch.options = [];
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
		content: `${itemLabel(purchase)} 单号 ${purchase.outTradeNo}:先去 C5 官网核对这笔单的真实结果。`
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

const purchaseColumns: DataTableColumns<C5Purchase> = [
	{title: '时间', key: 'ts', width: 130, render: purchase => formatTime(purchase.ts)},
	{title: '饰品', key: 'name', minWidth: 150, ellipsis: {tooltip: true}, render: purchase => itemLabel(purchase)},
	{title: '价格', key: 'cost', width: 70, render: purchase => money(purchase.cost)},
	{
		title: '状态',
		key: 'status',
		width: 88,
		render: purchase => {
			const status = purchaseStatus(purchase.status);
			const tag = h(NTag, {size: 'small', bordered: false, type: status.tone}, () => status.label);
			return purchase.error ? withTip(tag, purchase.error) : tag;
		}
	},
	{
		title: '平台订单',
		key: 'order',
		minWidth: 150,
		ellipsis: {tooltip: true},
		render: purchase => {
			const parts = [purchase.orderId || '-', purchase.orderStatusName || (purchase.orderStatus != null ? `状态 ${purchase.orderStatus}` : '')].filter(Boolean);
			return h('span', {title: `商户单号 ${purchase.outTradeNo}${purchase.error ? '\n' + purchase.error : ''}`}, parts.join(' · '));
		}
	},
	{
		title: '',
		key: 'actions',
		width: 140,
		render: purchase => (purchase.status === 'unknown'
			? h(NSpace, {size: 4, wrap: false}, () => [
				h(NButton, {size: 'tiny', secondary: true, onClick: () => confirmResolve(purchase, 'ok')}, () => '标记成交'),
				h(NButton, {size: 'tiny', secondary: true, onClick: () => confirmResolve(purchase, 'failed')}, () => '标记失败')
			])
			: null)
	}
];
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>C5 扫货</h1>
				<div class="module-counts">
					<span>策略:{{ state?.settings.strategy === 'quick' ? '快速购买' : '按在售列表' }}</span>
					<span>已花 / 预算:{{ state ? budgetText(state.budget) : '-' }}</span>
					<span>已买:{{ state?.budget.qty ?? 0 }} 件</span>
					<span>C5 余额:{{ money(state?.balance?.value) }}</span>
					<span class="receiver">
						收货账号:
						<NSelect
							class="receiver-select"
							size="tiny"
							filterable
							:value="receiverValue"
							:options="receiverOptions"
							:placeholder="receiverPlaceholder"
							:loading="receiversLoading || switchingReceiver"
							:disabled="switchingReceiver"
							:consistent-menu-width="false"
							:filter="filterReceiver"
							:title="state?.receiver ? receiverText(state.receiver) : ''"
							@update:show="(open: boolean) => open && loadReceivers()"
							@update:value="pickReceiver"
						>
							<template #empty>
								<span class="muted">{{ receiversError || (receiverAccounts.length ? '没搜到这个账号' : 'C5 上还没绑定 Steam 账号') }}</span>
							</template>
							<template v-if="receiverAccounts.some(account => account.link === 'none')" #action>
								<span class="muted price-note">标「要贴链接」的:C5 开放平台不给交易链接,选它时贴一次,之后会记住</span>
							</template>
						</NSelect>
						<NTag v-if="receiverNote && !receiverNote.ok" size="small" :bordered="false" type="warning">{{ receiverNote.text }}</NTag>
					</span>
					<span>{{ cycleText }}</span>
				</div>
			</div>
			<NSpace align="center">
				<NRadioGroup :value="state?.run ?? 'stopped'" :disabled="!state || runBusy" size="small" @update:value="changeRun">
					<NRadioButton value="stopped">{{ RUN_LABELS.stopped }}</NRadioButton>
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
			<NAlert v-if="state.unknown > 0" type="warning" :bordered="false">
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
				<NSelect
					size="small"
					filterable
					remote
					clearable
					:value="nameSearch.picked?.name ?? null"
					:options="nameOptions"
					:loading="nameSearch.loading"
					:render-label="renderNameOption"
					:consistent-menu-width="false"
					placeholder="搜饰品:输中文或英文,如 千瓦、红线 久经、Kilowatt"
					@search="onSearch"
					@update:value="pickName"
				>
					<template #empty>
						<span class="muted">{{ nameSearch.query ? (nameSearch.loading ? '搜索中…' : '没搜到;新出的饰品可以直接输完整英文名') : '输中文或英文名搜索' }}</span>
					</template>
					<template v-if="priceNote" #action>
						<span :class="nameSearch.priceError ? 'warn-text' : 'muted'" class="price-note">{{ priceNote }}</span>
					</template>
				</NSelect>
				<NInputNumber v-model:value="newItem.maxPrice" size="small" :min="0" :step="0.01" :show-button="false" :placeholder="targetPlaceholder" />
				<NInputNumber v-model:value="newItem.maxQty" size="small" :min="1" :precision="0" :show-button="false" placeholder="数量上限" />
				<NButton size="small" @click="add">添加</NButton>
			</div>
		</NCard>

		<NCard size="small" :bordered="false" title="购买流水(最近 50 笔)">
			<template #header-extra>
				<NTooltip placement="top">
					<template #trigger>
						<NButton size="small" :loading="syncing" :disabled="!state?.configured" @click="sync">同步订单</NButton>
					</template>
					立刻向平台查一遍全部未完结订单(平时每轮自动查几笔)
				</NTooltip>
			</template>
			<NDataTable size="small" :columns="purchaseColumns" :data="state?.purchases ?? []" :row-key="(row: C5Purchase) => row.outTradeNo" :max-height="360" :scroll-x="720">
				<template #empty>
					<span class="muted">还没有买入</span>
				</template>
			</NDataTable>
		</NCard>

		<SettingsModal :show="settingsOpen" @close="settingsOpen = false" />
		<NModal :show="paste.show" :mask-closable="!paste.saving" @update:show="(value: boolean) => !value && !paste.saving && (paste.show = false)">
			<NCard :title="`贴 ${nameOfReceiver(paste.steamId)} 的交易链接`" style="width: 560px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
				<p class="muted paste-hint">
					C5 开放平台不给已绑定账号的交易链接,下单又必须带,所以要贴一次,之后会记住。
					在这个 Steam 账号的「库存 → 交易报价 → 谁可以向我发送交易报价」页面复制(SteamID {{ paste.steamId }})。
				</p>
				<NInput
					v-model:value="paste.tradeUrl"
					placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
					:input-props="{spellcheck: false}"
					@keyup.enter="savePastedTradeUrl"
				/>
				<NAlert v-if="paste.error" type="error" :bordered="false" class="paste-error">{{ paste.error }}</NAlert>
				<template #footer>
					<NSpace justify="end">
						<NButton :disabled="paste.saving" @click="paste.show = false">取消</NButton>
						<NButton type="primary" :loading="paste.saving" @click="savePastedTradeUrl">保存并设为收货账号</NButton>
					</NSpace>
				</template>
			</NCard>
		</NModal>
		<ListingsModal :name="listingsName" :label="labelOf(listingsName)" @close="listingsName = ''" />
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

.receiver {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

.receiver-select {
	width: 220px;
}

.price-note {
	font-size: 12px;
}

.paste-hint {
	margin: 0 0 10px;
	font-size: 13px;
}

.paste-error {
	margin-top: 8px;
}

.warn-text {
	color: var(--warn);
}

.add-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 110px 110px auto;
	gap: 6px;
	margin-top: 10px;
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
	line-height: 1.3;
	min-width: 0;
}

:deep(.item-zh),
:deep(.item-en) {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

:deep(.item-zh) {
	font-weight: 500;
}

:deep(.item-en) {
	font-size: 11px;
}

:deep(.price-hit) {
	color: var(--ok);
	font-weight: 600;
}
</style>
