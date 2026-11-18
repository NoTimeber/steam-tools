<script setup lang="ts">
// ECO 扫货:顶栏是运行状态(停止 / 自动扫货,真实下单)和汇总;中间是监控列表(直接改目标价、数量、花费上限、游戏,
// 改过没保存的格子标黄,点「保存」后下一轮按新价扫);下面是购买流水。运行日志写在右下角的「实时运行日志」里。设置、查在售在弹窗里。
// 添加饰品输中文或英文搜(ECO 接口只认 Steam 英文名,后端词库把中文换成英文名),表格里显示中文名。
import {computed, h, onMounted, onUnmounted, reactive, ref} from 'vue';
import {
	NAlert, NButton, NCard, NDataTable, NInputNumber, NRadioButton, NRadioGroup, NSelect, NSpace, NTag, NTooltip, useDialog, useMessage
} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import {withTip} from '../components/tip.ts';
import type {VNode, VNodeChild} from 'vue';
import {errorText} from '../api/http.ts';
import {
	budgetText, currentLinkStatus, DEFAULT_GAME_ID, dirtyFields, formatTime, GAME_OPTIONS, itemLabel, itemStatus, linkStatus, money, priceText, purchaseStatus,
	receiverEcoNote, receiverMatches, receiverOptionLabel, receiverText, receiverUsable, removedNames, RUN_LABELS, sortReceiverAccounts, sweepBlocker,
	sweepConfirmText, updateLinkBlocker
} from '../lib/eco.ts';
import type {DraftField, DraftRow, EcoNameOption, EcoPurchase, EcoReceiverAccount, EcoRunState, LinkStatus} from '../lib/eco.ts';
import {
	addDraft, checkConnection, dirty, discardDrafts, eco, enterEco, fetchReceivers, leaveEco, refreshOrders, removeDraft, resolvePurchase,
	saveReceiverTradeUrl, saveWatchlist, searchNames, serverItems, setRun, updateReceiverLink, verifyReceiverLinks
} from '../stores/eco.ts';
import BindModal from './eco/BindModal.vue';
import ListingsModal from './eco/ListingsModal.vue';
import SettingsModal from './eco/SettingsModal.vue';

const message = useMessage();
const dialog = useDialog();

function warnUnsaved(event: BeforeUnloadEvent): void {
	if (dirty.value) {
		event.preventDefault();
		event.returnValue = '';
	}
}

onMounted(() => {
	enterEco();
	loadReceivers();
	window.addEventListener('beforeunload', warnUnsaved);
});
onUnmounted(() => {
	leaveEco();
	window.removeEventListener('beforeunload', warnUnsaved);
});

const state = computed(() => eco.state);
const viewByName = computed(() => new Map((state.value?.items ?? []).map(item => [item.name, item])));
const labelOf = (name: string) => itemLabel(viewByName.value.get(name) ?? {name});
const removed = computed(() => removedNames(eco.drafts, serverItems.value).map(labelOf));

const settingsOpen = ref(false);
const listingsName = ref('');
const bindOpen = ref(false);

// ===== 收货账号:顶栏下拉,从 ECO 上绑定的 Steam 账号里选,选中就用 ECO 上登记的交易链接并马上保存 =====
// 只有没有交易链接的不能选(ECO 列表里的失效标记不可靠,链接好坏点「验证」查);别的链接在「设置」里直接贴
const receiverAccounts = ref<EcoReceiverAccount[]>([]);
const receiversError = ref<string | null>(null);
const receiversLoading = ref(false);
const switchingReceiver = ref(false);
const receiverNote = computed(() => receiverEcoNote(state.value?.receiver ?? null, state.value?.settings.tradeUrl ?? ''));

async function loadReceivers(refresh = false): Promise<void> {
	receiversLoading.value = true;
	try {
		const result = await fetchReceivers(refresh);
		receiverAccounts.value = result.accounts;
		receiversError.value = result.boundError;
	} catch (err) {
		receiversError.value = errorText(err);
	} finally {
		receiversLoading.value = false;
	}
}

// 能选的在前;昵称、备注、SteamID、账户管理里的账号名都能搜
const receiverOptions = computed(() => sortReceiverAccounts(receiverAccounts.value).map(account => ({
	value: account.steamId,
	label: receiverOptionLabel(account),
	disabled: !receiverUsable(account),
	item: account
})));
const filterReceiver = (pattern: string, option: SelectOption) => receiverMatches(option.item as EcoReceiverAccount, pattern);
/** 当前收货账号是下拉里的哪一个;不是 ECO 绑定的链接不在下拉里,显示成占位文字 */
const receiverValue = computed(() => {
	const steamId = state.value?.receiver?.steamId;
	return steamId && receiverAccounts.value.some(entry => entry.steamId === steamId) ? steamId : null;
});
const receiverPlaceholder = computed(() => (state.value?.receiver ? receiverText(state.value.receiver) : '选收货账号'));
const hasUnusableReceiver = computed(() => receiverAccounts.value.some(account => !receiverUsable(account)));

function linkTag(link: LinkStatus): VNodeChild {
	return h(NTag, {size: 'small', bordered: false, type: link.tone, title: link.title, class: link.muted ? 'link-muted' : ''}, () => link.text);
}

/** 下拉菜单每一行:原来的选项 + 右边交易链接状态(只加在菜单里,选中后的框里不加) */
function renderReceiverOption({node, option}: {node: VNode; option: SelectOption}): VNodeChild {
	const account = option.item as EcoReceiverAccount;
	return account.tradeUrl ? h('div', {class: 'receiver-option'}, [node, linkTag(linkStatus(account))]) : node;
}

/** 当前收货账号在下拉里的那一项(不是 ECO 绑定的为 null) */
const currentAccount = computed(() => {
	const steamId = state.value?.receiver?.steamId;
	return steamId ? receiverAccounts.value.find(entry => entry.steamId === steamId) ?? null : null;
});
/** 当前交易链接的状态:设置里的链接就是 ECO 登记的那条时才有 */
const currentLink = computed(() => currentLinkStatus(currentAccount.value, state.value?.settings.tradeUrl ?? ''));
const updateBlocker = computed(() => updateLinkBlocker(currentAccount.value));

// ===== 验证 / 更新交易链接 =====
const verifying = ref(false);
const updatingLink = ref(false);

async function verifyLinks(): Promise<void> {
	verifying.value = true;
	try {
		const result = await verifyReceiverLinks();
		receiverAccounts.value = result.accounts;
		receiversError.value = result.boundError;
		const checks = result.accounts.filter(account => account.tradeUrl).map(account => account.linkCheck?.valid);
		const parts = [`有效 ${checks.filter(valid => valid === true).length} 个`];
		const bad = checks.filter(valid => valid === false).length;
		const failed = checks.filter(valid => valid == null).length;
		if (bad) parts.push(`无效 ${bad} 个`);
		if (failed) parts.push(`验证失败 ${failed} 个`);
		const text = `交易链接验证完成:${parts.join(',')}`;
		if (bad || failed) {
			message.warning(text, {duration: 6000});
		} else {
			message.success(text);
		}
	} catch (err) {
		message.error('验证交易链接失败:' + errorText(err));
	} finally {
		verifying.value = false;
	}
}

async function updateLink(): Promise<void> {
	const account = currentAccount.value;
	if (!account || updateBlocker.value) {
		return;
	}
	updatingLink.value = true;
	try {
		const result = await updateReceiverLink(account.steamId);
		receiverAccounts.value = result.accounts;
		const name = account.nickname || account.steamId;
		if (!result.tradeUrl) {
			message.warning(`已让 ECO 更新 ${name} 的交易链接,但平台没返回链接`, {duration: 6000});
		} else if (result.valid === false) {
			message.warning(`已更新 ${name} 的交易链接,但验证仍然无效;检查 Steam 库存是否公开、账号能否交易`, {duration: 8000});
		} else {
			message.success(`已更新 ${name} 的交易链接${result.valid ? ',验证有效' : ''}`);
		}
		// 服务端用的是刚重查的绑定列表;下拉的缓存也强制刷新一遍
		void loadReceivers(true);
	} catch (err) {
		message.error('更新交易链接失败:' + errorText(err), {duration: 8000});
	} finally {
		updatingLink.value = false;
	}
}

async function pickReceiver(steamId: string | null): Promise<void> {
	const account = receiverAccounts.value.find(entry => entry.steamId === steamId);
	if (!account || (steamId === receiverValue.value && account.tradeUrl === state.value?.settings.tradeUrl)) {
		return;
	}
	if (!receiverUsable(account)) {
		message.warning('这个账号在 ECO 上没有交易链接,先去 ECO 官网更新,或者在「设置」里直接贴交易链接');
		return;
	}
	switchingReceiver.value = true;
	try {
		await saveReceiverTradeUrl(account.tradeUrl);
		message.success(`收货账号已改为 ${account.nickname || account.steamId}`);
	} catch (err) {
		message.error('换收货账号失败:' + errorText(err));
	} finally {
		switchingReceiver.value = false;
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

async function doRun(next: EcoRunState): Promise<void> {
	runBusy.value = true;
	try {
		await setRun(next);
	} catch (err) {
		message.error('操作失败:' + errorText(err));
	} finally {
		runBusy.value = false;
	}
}

function changeRun(next: EcoRunState): void {
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
	const blocker = value.configured ? sweepBlocker(value.settings) : '没配好 ECO 的 PartnerId 和私钥';
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
		content: () => h('div', {style: 'white-space: pre-wrap'}, sweepConfirmText(value.settings, serverItems.value.length, value.receiver, currentLink.value)),
		positiveText: '开始',
		negativeText: '取消',
		onPositiveClick: () => {
			doRun(next);
		}
	});
}

// ===== 检查连接 =====
const checking = ref(false);

/** 检查连接结果里每个账号的备注;ECO 列表的失效标记不可靠,只提一句「未验证」 */
function boundNote(account: {tradeUrl: string; tradeUrlOk: boolean; isDefault: boolean}): string {
	return [account.isDefault ? ' · 默认' : '', !account.tradeUrl ? ' · 没有交易链接' : !account.tradeUrlOk ? ' · ECO 列表标记链接失效(未验证)' : ''].join('');
}

async function check(): Promise<void> {
	if (!state.value?.configured) {
		message.warning('先在「设置」里填 ECO 的 PartnerId 和私钥');
		settingsOpen.value = true;
		return;
	}
	checking.value = true;
	try {
		const result = await checkConnection();
		dialog.success({
			title: '连接正常,密钥有效',
			content: () => h('div', {class: 'check-result'}, [
				h('div', `可用余额 ${money(result.balance.money)}(冻结 ${money(result.balance.locked)},待结算 ${money(result.balance.waitSettlement)})`),
				...(result.steamAccounts.length
					? result.steamAccounts.map(account => h('div', `Steam 账号 ${account.steamId} ${account.nickname} · ${account.status}${boundNote(account)}`))
					: [h('div', {class: 'muted'}, 'ECO 上没有绑定 Steam 账号,先去官网绑定收货账号')]),
				h('div', {class: 'muted'}, '下单还要在 ECO 开放平台开通「购买权限」')
			]),
			positiveText: '知道了'
		});
		void loadReceivers();
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

function gameInput(row: DraftRow) {
	return cell(row, 'gameId', h(NSelect, {
		size: 'small',
		value: row.gameId,
		options: GAME_OPTIONS as SelectOption[],
		consistentMenuWidth: false,
		'onUpdate:value': (value: number) => {
			row.gameId = value;
		}
	}));
}

/** 中文名一行,英文名(ECO 接口用的)小字一行;没有中文名的只有英文名 */
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
	{title: '游戏', key: 'gameId', width: 100, render: row => gameInput(row)},
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
		title: 'ECO 最低',
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
				title: row.origName == null ? '先保存' : '看目标价以内的在售(也能验证密钥和 IP 白名单)',
				onClick: () => {
					listingsName.value = row.origName || '';
				}
			}, () => '查在售'),
			h(NButton, {size: 'tiny', type: 'error', secondary: true, onClick: () => removeDraft(row.uid)}, () => '删除')
		])
	}
];

// ===== 添加饰品:先选游戏,输中文或英文,停 300 毫秒后向后端搜(带 ECO 在售最低价),从下拉里选 =====
const newItem = reactive({maxPrice: null as number | null, maxQty: null as number | null, gameId: DEFAULT_GAME_ID});
const nameSearch = reactive({
	query: '', loading: false, options: [] as EcoNameOption[], picked: null as EcoNameOption | null, priced: false, priceError: null as string | null
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
	const gameId = newItem.gameId;
	searchTimer = window.setTimeout(async () => {
		try {
			const result = await searchNames(q, gameId);
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

/** 换了游戏:价格要按新游戏重查,原来的搜索结果作废 */
function changeNewGame(gameId: number): void {
	newItem.gameId = gameId;
	searchSeq++;
	window.clearTimeout(searchTimer);
	Object.assign(nameSearch, {query: '', loading: false, options: [], picked: null, priced: false, priceError: null});
}

function pickName(value: string | null, option: SelectOption | null): void {
	nameSearch.picked = value && option ? option.item as EcoNameOption : null;
}

/** 下拉每一行:左边中文名 + 英文名,右边 ECO 在售最低价和在售数 */
function renderNameOption(option: SelectOption): VNodeChild {
	const item = option.item as EcoNameOption;
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
		return `ECO 价格没查到:${nameSearch.priceError}`;
	}
	return nameSearch.priced ? 'ECO 在售最低价(元)' : '配好 ECO 的 PartnerId 和私钥才显示价格';
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
	if (eco.drafts.some(row => row.name.trim() === picked.name)) {
		message.warning(`${itemLabel(picked)} 已经在列表里了`);
		return;
	}
	addDraft({name: picked.name, zh: picked.zh, maxPrice: newItem.maxPrice, maxQty: newItem.maxQty, gameId: newItem.gameId});
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

function confirmResolve(purchase: EcoPurchase, status: 'ok' | 'failed'): void {
	dialog.warning({
		title: status === 'ok' ? '标记为已成交' : '标记为未成交',
		content: `${itemLabel(purchase)} 商户单号 ${purchase.merchantNo}:先去 ECO 官网核对这笔单的真实结果。`
			+ (status === 'ok' ? '标记已成交后会继续占用数量和预算。' : '标记未成交后会释放数量和预算,可能再买一件。'),
		positiveText: '标记',
		negativeText: '取消',
		onPositiveClick: async () => {
			try {
				await resolvePurchase(purchase.merchantNo, status);
				message.success('已标记');
			} catch (err) {
				message.error('标记失败:' + errorText(err));
			}
		}
	});
}

const purchaseColumns: DataTableColumns<EcoPurchase> = [
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
			const parts = [purchase.orderNo || '-', purchase.orderStateName || (purchase.orderState != null ? `状态 ${purchase.orderState}` : '')].filter(Boolean);
			const title = [`商户单号 ${purchase.merchantNo}`, purchase.goodsNum ? `商品编号 ${purchase.goodsNum}` : '', purchase.error ?? ''].filter(Boolean).join('\n');
			return h('span', {title}, parts.join(' · '));
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
				<h1>ECO 扫货</h1>
				<div class="module-counts">
					<span>策略:{{ state?.settings.strategy === 'quick' ? '快速购买' : '按在售列表' }}</span>
					<span>已花 / 预算:{{ state ? budgetText(state.budget) : '-' }}</span>
					<span>已买:{{ state?.budget.qty ?? 0 }} 件</span>
					<span>ECO 余额:{{ money(state?.balance?.value) }}</span>
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
							:render-option="renderReceiverOption"
							:title="state?.receiver ? receiverText(state.receiver) : ''"
							@update:show="(open: boolean) => open && loadReceivers()"
							@update:value="pickReceiver"
						>
							<template #empty>
								<span class="muted">{{ receiversError || (receiverAccounts.length ? '没搜到这个账号' : 'ECO 上还没绑定 Steam 账号') }}</span>
							</template>
							<template #action>
								<div class="receiver-action">
									<span class="muted price-note">
										{{ hasUnusableReceiver ? '没有交易链接的不能选,去 ECO 官网更新;' : '' }}链接状态点「验证」查;别的交易链接在「设置」里直接贴
									</span>
									<NButton size="tiny" quaternary :loading="receiversLoading" @click="loadReceivers(true)">刷新</NButton>
								</div>
							</template>
						</NSelect>
						<NTooltip placement="bottom">
							<template #trigger>
								<NButton size="tiny" secondary :loading="verifying" :disabled="!state?.configured" @click="verifyLinks">验证</NButton>
							</template>
							用 ECO 的验证接口逐个验证绑定账号的交易链接(每个约 0.5 秒)
						</NTooltip>
						<NTag v-if="receiverNote && !receiverNote.ok" size="small" :bordered="false" type="warning">{{ receiverNote.text }}</NTag>
						<NTag
							v-if="currentLink"
							size="small"
							:bordered="false"
							:type="currentLink.tone"
							:title="currentLink.title"
							:class="currentLink.muted ? 'link-muted' : ''"
						>
							{{ currentLink.text }}
						</NTag>
						<NTooltip v-if="state?.receiver" placement="bottom">
							<template #trigger>
								<!-- 禁用的按钮收不到鼠标事件,包一层让提示能出来 -->
								<span>
									<NButton size="tiny" secondary :loading="updatingLink" :disabled="!state?.configured || !!updateBlocker" @click="updateLink">
										更新交易链接
									</NButton>
								</span>
							</template>
							{{ updateBlocker || '让 ECO 用工具里存的登录会话重新从 Steam 取这个账号的交易链接(链接换过 token 时用)' }}
						</NTooltip>
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
				<NTooltip placement="bottom" :disabled="!!state?.configured">
					<template #trigger>
						<!-- 禁用的按钮收不到鼠标事件,包一层让提示能出来 -->
						<span>
							<NButton :disabled="!state?.configured" @click="bindOpen = true">绑定 Steam 账号</NButton>
						</span>
					</template>
					先在「设置」里配好 ECO 的 PartnerId 和私钥
				</NTooltip>
				<NButton type="primary" @click="settingsOpen = true">设置</NButton>
			</NSpace>
		</header>

		<NAlert v-if="eco.error && !state" type="error" :bordered="false">加载失败:{{ eco.error }}</NAlert>
		<template v-if="state">
			<NAlert v-if="state.keyError" type="error" :bordered="false">
				存的 ECO 私钥用不了:{{ state.keyError }}。到「设置」里重新贴私钥,或者生成新密钥对。
			</NAlert>
			<NAlert v-else-if="!state.configured" type="warning" :bordered="false">
				还没配好 ECO 的 PartnerId 和私钥。点右上角「设置」生成密钥对,把公钥填到 ECO 开放平台的「RSA 公钥」里,拿到 PartnerId 填回来;
				下单还要在开放平台开通「购买权限」。
			</NAlert>
			<NAlert v-if="state.settingsError" type="warning" :bordered="false">数据库里的设置无效,已退回默认值:{{ state.settingsError }}</NAlert>
			<NAlert v-if="state.run !== 'stopped' && state.cycle.error" type="error" :bordered="false">
				本轮失败(连续 {{ state.cycle.errors }} 次,自动退避重试):{{ state.cycle.error }}
			</NAlert>
			<NAlert v-if="state.unknown > 0" type="warning" :bordered="false">
				有 {{ state.unknown }} 笔下单结果未知,先按已花费占着额度,正在自动对账;一直对不上的,去 ECO 官网核对后在购买流水里手工标记。
			</NAlert>
			<NAlert v-if="state.run !== 'stopped' && state.cycle.done && state.items.length" type="info" :bordered="false">
				所有目标已买满或预算用完。改价、加饰品或调预算后自动继续。
			</NAlert>
		</template>

		<NCard size="small" :bordered="false" title="监控列表">
			<template #header-extra>
				<NSpace v-if="dirty" align="center" :size="8">
					<span class="dirty-hint">有改动没保存{{ removed.length ? `(将删除 ${removed.join('、')})` : '' }}</span>
					<NButton size="small" :disabled="eco.savingList" @click="discardDrafts">放弃修改</NButton>
					<NButton size="small" type="primary" :loading="eco.savingList" @click="save">保存</NButton>
				</NSpace>
				<span v-else class="muted hint">直接改目标价、数量、花费上限,点保存后下一轮按新价扫</span>
			</template>
			<NDataTable
				size="small"
				:columns="columns"
				:data="eco.drafts"
				:row-key="(row: DraftRow) => row.uid"
				:loading="!state && eco.loading"
				:scroll-x="1180"
			>
				<template #empty>
					<span class="muted">还没有要监控的饰品,在下面添加</span>
				</template>
			</NDataTable>
			<div class="add-row">
				<NSelect size="small" :value="newItem.gameId" :options="(GAME_OPTIONS as SelectOption[])" @update:value="changeNewGame" />
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
			<NDataTable size="small" :columns="purchaseColumns" :data="state?.purchases ?? []" :row-key="(row: EcoPurchase) => row.merchantNo" :max-height="360" :scroll-x="720">
				<template #empty>
					<span class="muted">还没有买入</span>
				</template>
			</NDataTable>
		</NCard>

		<SettingsModal :show="settingsOpen" @close="settingsOpen = false; loadReceivers()" />
		<BindModal :show="bindOpen" @close="bindOpen = false" @bound="loadReceivers(true)" />
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

.link-muted {
	opacity: 0.65;
}

/* 下拉菜单挂在 body 下,scoped 样式要 :deep 也够不到,用全局类名前缀避免冲突 */
:global(.receiver-option) {
	display: flex;
	align-items: center;
	gap: 8px;
	padding-right: 8px;
}

:global(.receiver-option > .n-base-select-option) {
	flex: 1;
	min-width: 0;
}

:global(.receiver-option .link-muted) {
	opacity: 0.65;
}

.receiver-action {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.price-note {
	font-size: 12px;
}

.warn-text {
	color: var(--warn);
}

.add-row {
	display: grid;
	grid-template-columns: 90px minmax(0, 1fr) 110px 110px auto;
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
