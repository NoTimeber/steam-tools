<script setup lang="ts">
// 账户列表:顶上一排统计卡片,下面是表格卡片(搜索、筛选、列设置、按序号勾选、勾选后批量操作;
// 行内显示令牌验证码,行尾是图标操作)。排序、筛选后序号按显示顺序重排。
import {computed, h, onMounted, onUnmounted, reactive, ref} from 'vue';
import {NBadge, NButton, NCheckbox, NDataTable, NDropdown, NInput, NInputNumber, NPopover, NSelect, NTag, NTooltip, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey, DataTableSortState, DropdownOption} from 'naive-ui';
import type {GameId} from '../../api/types.ts';
import AppIcon from '../../components/AppIcon.vue';
import type {IconName} from '../../components/AppIcon.vue';
import {dropdownWithTip, withTip} from '../../components/tip.ts';
import {ALL_ACCOUNTS, NO_GROUP, SESSION_LABEL, STATUS_TAG, activeFilterCount, currencySymbol, formatBalance, padSeq, resolveSeqRange, walletTotals} from '../../lib/accounts.ts';
import type {AccountFilters, LoginStatus, SortKey} from '../../lib/accounts.ts';
import {accountProxyView} from '../../lib/proxy.ts';
import {
	accounts, canUseGc, connectGc, connectedGame, deleteSelected, disconnectGc, forSelected, gameLabel, groupName, loginAccount, logoutAccount,
	moveToGroup, onlineCount, resetFilters, selectedRows, setFilters, setSearch, setSort, visibleRows
} from '../../stores/accounts.ts';
import type {AccountRow} from '../../stores/accounts.ts';
import {authCodeSecondsLeft, authCodes, watchAuthCodes} from '../../stores/authcodes.ts';
import {loadProxies, proxy} from '../../stores/proxy.ts';
import HistoryModal from './HistoryModal.vue';
import ProxyModal from './ProxyModal.vue';

const emit = defineEmits<{'new-group': [rows: AccountRow[]]}>();
const message = useMessage();
const dialog = useDialog();

const historyAccount = ref('');
/** 正在设代理的账号(一个或勾选的几个) */
const proxyAccounts = ref<string[]>([]);

let stopCodes = () => {};
onMounted(() => {
	void loadProxies();
	stopCodes = watchAuthCodes();
});
onUnmounted(() => stopCodes());

// ===== 统计卡片 =====
const stats = computed(() => {
	const rows = accounts.rows;
	return {
		total: rows.length,
		ungrouped: rows.filter(row => !row.groupId).length,
		gc: rows.filter(row => row.cs2GcConnected || row.tf2GcConnected).length,
		guard: rows.filter(row => row.hasMaFile || row.hasSharedSecret).length,
		mafile: rows.filter(row => row.hasMaFile).length,
		wallets: walletTotals(rows)
	};
});

const money = (entry: {currency: number | null; total: number}) => `${currencySymbol(entry.currency)}${entry.total.toFixed(2)}`;

// ===== 列设置(隐藏哪些列存在浏览器里) =====
type ColumnKey = 'seq' | 'group' | 'guard' | 'status' | 'gc' | 'code' | 'balance' | 'country' | 'proxy' | 'steamID';

const COLUMN_OPTIONS: ReadonlyArray<{key: ColumnKey; label: string}> = [
	{key: 'seq', label: '序号'},
	{key: 'group', label: '分组'},
	{key: 'guard', label: 'Steam Guard'},
	{key: 'status', label: '会话'},
	{key: 'gc', label: 'GC'},
	{key: 'code', label: '令牌验证码'},
	{key: 'balance', label: '钱包'},
	{key: 'country', label: '国家'},
	{key: 'proxy', label: '代理'},
	{key: 'steamID', label: 'SteamID'}
];

const HIDDEN_KEY = 'accounts.hiddenColumns';
const DEFAULT_HIDDEN: ColumnKey[] = ['country', 'steamID'];

function loadHidden(): Set<ColumnKey> {
	try {
		const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || 'null');
		return new Set(Array.isArray(saved) ? saved : DEFAULT_HIDDEN);
	} catch {
		return new Set(DEFAULT_HIDDEN);
	}
}

const hidden = ref(loadHidden());

function toggleColumn(key: ColumnKey, show: boolean): void {
	const next = new Set(hidden.value);
	if (show) {
		next.delete(key);
	} else {
		next.add(key);
	}
	hidden.value = next;
	try {
		localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
	} catch {
		// 存不了就只在这次有效
	}
}

// ===== 筛选 =====
const ANY = '*';
const filterCount = computed(() => activeFilterCount(accounts.filters));

const groupOptions = computed(() => [
	{label: '全部', value: ANY},
	{label: '未分组', value: NO_GROUP},
	...accounts.groups.map(group => ({label: group.name, value: group.id}))
]);
const SESSION_OPTIONS = [
	{label: '全部', value: ANY},
	...(['登录成功', '未登录', '登录中', '登录失败'] as LoginStatus[]).map(status => ({label: SESSION_LABEL[status], value: status}))
];
const GC_OPTIONS = [{label: '全部', value: ANY}, {label: '已连接', value: 'connected'}, {label: '未连接', value: 'none'}];
const GUARD_OPTIONS = [{label: '全部', value: ANY}, {label: '有 maFile', value: 'mafile'}, {label: '只有 shared_secret', value: 'secret'}, {label: '没有令牌', value: 'none'}];

const pick = (value: string) => (value === ANY ? '' : value);

/** 生效的条件,显示在表格上方,点 × 去掉 */
const filterChips = computed(() => {
	const f = accounts.filters;
	const chips: Array<{key: string; label: string; clear: Partial<AccountFilters>}> = [];
	if (f.group !== ALL_ACCOUNTS) {
		chips.push({key: 'group', label: `分组:${f.group === NO_GROUP ? '未分组' : groupName(f.group)}`, clear: {group: ALL_ACCOUNTS}});
	}
	if (f.session) {
		chips.push({key: 'session', label: `会话:${SESSION_LABEL[f.session]}`, clear: {session: ''}});
	}
	if (f.gc) {
		chips.push({key: 'gc', label: `GC:${f.gc === 'connected' ? '已连接' : '未连接'}`, clear: {gc: ''}});
	}
	if (f.guard) {
		chips.push({key: 'guard', label: `Steam Guard:${GUARD_OPTIONS.find(option => option.value === f.guard)!.label}`, clear: {guard: ''}});
	}
	if (f.minBalance != null) {
		chips.push({key: 'min', label: `余额 ≥ ${f.minBalance}`, clear: {minBalance: null}});
	}
	if (f.maxBalance != null) {
		chips.push({key: 'max', label: `余额 ≤ ${f.maxBalance}`, clear: {maxBalance: null}});
	}
	return chips;
});

// ===== 分组 =====
const NEW_GROUP = 'new-group';

/** 「移到分组」的选项;current 是单个账号现在的分组(批量时不传) */
function moveOptions(current?: string): DropdownOption[] {
	const options: DropdownOption[] = accounts.groups.map(group => ({label: group.name, key: group.id, disabled: group.id === current}));
	if (options.length) {
		options.push({label: '移出分组', key: NO_GROUP, disabled: current === ''}, {type: 'divider', key: 'divider'});
	}
	options.push({label: '新建分组…', key: NEW_GROUP});
	return options;
}

function onMove(key: string, rows: AccountRow[]): void {
	if (key === NEW_GROUP) {
		emit('new-group', rows);
	} else {
		moveToGroup(rows, key === NO_GROUP ? '' : key);
	}
}

// ===== 令牌验证码 =====
async function copyCode(code: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(code);
	} catch {
		// 不是 HTTPS 时没有 clipboard,退回老办法
		const input = document.createElement('textarea');
		input.value = code;
		document.body.appendChild(input);
		input.select();
		document.execCommand('copy');
		input.remove();
	}
	message.success(`已复制验证码 ${code}`);
}

// ===== 表格 =====
const seqOf = computed(() => new Map(visibleRows.value.map((row, index) => [row.key, index + 1])));

/** 行尾的图标按钮,鼠标放上去显示 label */
function iconAction(icon: IconName, label: string, onClick?: () => void) {
	return withTip(h(NButton, {size: 'small', text: true, type: 'primary', 'aria-label': label, onClick, class: 'row-action'}, {icon: () => h(AppIcon, {name: icon, size: 17})}), label);
}

function guardCell(row: AccountRow) {
	const [color, tip] = row.hasMaFile
		? ['var(--ok)', '有 maFile(手机令牌),能自动生成验证码、确认交易']
		: row.hasSharedSecret ? ['var(--warn)', '名单里有 shared_secret,能生成验证码;没有 maFile,确认交易用不了'] : ['var(--muted)', '没有令牌,登录要手动输验证码'];
	return withTip(h('span', {class: 'guard-cell', style: {color}}, [h(AppIcon, {name: 'phone', size: 18})]), tip);
}

function gcCell(row: AccountRow) {
	const game = canUseGc(row) ? connectedGame(row) : '';
	if (game) {
		return dropdownWithTip(
			{options: [{label: `断开 ${gameLabel(game)} GC`, key: game}], onSelect: () => disconnectGc(row, game)},
			h(NTag, {size: 'small', type: 'success', bordered: false, class: 'clickable'}, () => gameLabel(game)),
			`已连接 ${gameLabel(game)} 游戏服务器(GC),点击可断开`
		);
	}
	if (!canUseGc(row)) {
		return withTip(h('span', {class: 'muted'}, '—'), '登录成功后才能连接 GC');
	}
	return dropdownWithTip(
		{options: [{label: '连接 CS2', key: 'cs2'}, {label: '连接 TF2', key: 'tf2'}], onSelect: (key: GameId) => connectGc(row, key)},
		h(NButton, {size: 'tiny', secondary: true}, () => '连接'),
		'连接 CS2 / TF2 游戏服务器(GC),内购、库存、终端机要用'
	);
}

function codeCell(row: AccountRow) {
	const code = authCodes.codes[row.accountName];
	if (!code) {
		return withTip(h('span', {class: 'muted'}, '—'), '没有 maFile 或 shared_secret,生成不了验证码');
	}
	const left = authCodeSecondsLeft();
	return withTip(h('button', {type: 'button', class: 'code-cell', onClick: () => copyCode(code)}, [
		h('span', {class: 'mono code-text'}, code),
		h('span', {class: 'code-bar'}, [h('span', {class: ['code-bar-fill', left <= 5 ? 'is-ending' : ''], style: {width: `${(left / 30) * 100}%`}})])
	]), () => `Steam 令牌验证码,点击复制(${authCodeSecondsLeft()} 秒后换新的)`);
}

function sortable(key: SortKey) {
	return {sorter: true as const, sortOrder: accounts.sortKey === key ? accounts.sortOrder : (false as const)};
}

const columns = computed<DataTableColumns<AccountRow>>(() => {
	const show = (key: ColumnKey) => !hidden.value.has(key);
	const list: DataTableColumns<AccountRow> = [{type: 'selection', fixed: 'left'}];
	if (show('seq')) {
		list.push({title: '序号', key: 'seq', width: 56, render: row => h('span', {class: 'mono muted'}, padSeq(seqOf.value.get(row.key) ?? 0))});
	}
	list.push({
		title: '用户名',
		key: 'accountName',
		width: 150,
		ellipsis: {tooltip: true},
		...sortable('accountName'),
		render: row => h('span', {class: 'account-name'}, row.accountName)
	});
	if (show('group')) {
		list.push({
			title: '分组',
			key: 'group',
			width: 100,
			render: row => {
				const name = groupName(row.groupId);
				return name
					? withTip(h(NTag, {size: 'small', bordered: false, class: 'clickable group-badge', onClick: () => setFilters({group: row.groupId})}, () => name), `按「${name}」筛选账户`)
					: h('span', {class: 'muted'}, '—');
			}
		});
	}
	if (show('guard')) {
		list.push({title: 'Steam Guard', key: 'guard', width: 100, align: 'center', render: guardCell});
	}
	if (show('status')) {
		list.push({
			title: '会话',
			key: 'status',
			width: 84,
			...sortable('status'),
			render: row => {
				const tag = h(NTag, {size: 'small', bordered: false, type: STATUS_TAG[row.status]}, () => SESSION_LABEL[row.status]);
				return row.lastError ? withTip(tag, row.lastError) : tag;
			}
		});
	}
	if (show('gc')) {
		list.push({title: 'GC', key: 'gc', width: 68, render: gcCell});
	}
	if (show('code')) {
		list.push({title: '令牌验证码', key: 'code', width: 104, render: codeCell});
	}
	if (show('balance')) {
		list.push({title: '钱包', key: 'balance', width: 96, align: 'right', ...sortable('balance'), render: row => formatBalance(row)});
	}
	if (show('country')) {
		list.push({title: '国家', key: 'country', width: 64, render: row => row.country || h('span', {class: 'muted'}, '—')});
	}
	if (show('proxy')) {
		list.push({
			title: '代理',
			key: 'proxy',
			width: 104,
			render: row => {
				const view = accountProxyView(proxy.data, row.accountName, row.groupId);
				const type = view.mode === 'pool' ? 'default' : view.mode === 'bind' ? 'info' : view.mode === 'refused' ? 'error' : 'warning';
				const tag = h(NTag, {size: 'small', bordered: false, type, class: 'clickable', onClick: () => (proxyAccounts.value = [row.accountName])}, () => view.label);
				return withTip(tag, `${view.tip}(点击修改)`);
			}
		});
	}
	if (show('steamID')) {
		list.push({title: 'SteamID', key: 'steamID', width: 170, ellipsis: {tooltip: true}, render: row => h('span', {class: 'mono'}, row.steamID || '—')});
	}
	list.push({
		title: '',
		key: 'actions',
		width: 120,
		fixed: 'right',
		render: row => h('div', {class: 'row-actions'}, [
			row.status === '登录成功' || row.status === '登录中'
				? iconAction('logout', '登出这个账号', () => logoutAccount(row))
				: iconAction('login', '登录这个账号', () => loginAccount(row)),
			h(NDropdown, {trigger: 'click', options: moveOptions(row.groupId), onSelect: (key: string) => onMove(key, [row])},
				() => h('span', {class: 'tip-anchor'}, [iconAction('folder', '设置账户分组')])),
			iconAction('receipt', '查看 Steam 消费记录', () => (historyAccount.value = row.accountName)),
			iconAction('globe', '设置这个账号的 Steam 代理', () => (proxyAccounts.value = [row.accountName]))
		])
	});
	return list;
});

const scrollX = computed(() => columns.value.reduce((sum, column) => sum + (('width' in column && Number(column.width)) || 48), 0));

function onSorter(sorter: DataTableSortState | DataTableSortState[] | null): void {
	const state = Array.isArray(sorter) ? sorter[0] : sorter;
	if (!state || !state.order) {
		setSort('');
	} else {
		setSort(state.columnKey as SortKey, state.order);
	}
}

const checkedKeys = computed(() => [...accounts.selected]);

function onCheckedChange(keys: DataTableRowKey[]): void {
	accounts.selected.clear();
	for (const key of keys) {
		accounts.selected.add(String(key));
	}
}

// ===== 按序号勾选 =====
const range = reactive({start: '', end: ''});

function selectRange(): void {
	const order = visibleRows.value;
	const result = resolveSeqRange(range.start, range.end, order.length);
	if ('error' in result) {
		message.warning(result.error);
		return;
	}
	for (let seq = result.start; seq <= result.end; seq++) {
		accounts.selected.add(order[seq - 1]!.key);
	}
	message.success(`已勾选序号 ${padSeq(result.start)}–${padSeq(result.end)},共 ${result.end - result.start + 1} 个账户`);
}

// ===== 批量操作 =====
const busy = ref<'' | 'login' | 'logout' | 'delete'>('');

async function run(kind: 'login' | 'logout', action: (row: AccountRow) => Promise<void>): Promise<void> {
	busy.value = kind;
	try {
		await forSelected(action);
	} finally {
		busy.value = '';
	}
}

function confirmDelete(): void {
	const count = accounts.selected.size;
	dialog.warning({
		title: '删除账户',
		content: `删除选中的 ${count} 个账户?会登出这些账号、删掉服务端保存的密码和登录会话,不能撤销。`,
		positiveText: '删除',
		negativeText: '取消',
		onPositiveClick: async () => {
			busy.value = 'delete';
			try {
				await deleteSelected();
			} finally {
				busy.value = '';
			}
		}
	});
}
</script>

<template>
	<section class="stats panel">
		<div class="stat">
			<div class="stat-label"><AppIcon name="users" :size="16" />账户</div>
			<div class="stat-value">{{ stats.total }}</div>
			<div class="stat-sub accent">{{ accounts.groups.length ? `未分组 ${stats.ungrouped} 个` : '你的账户池总计' }}</div>
		</div>
		<div class="stat">
			<div class="stat-label"><AppIcon name="signal" :size="16" />在线</div>
			<div class="stat-value">{{ onlineCount }}</div>
			<div class="stat-sub ok">GC 已连接 {{ stats.gc }} 个</div>
		</div>
		<div class="stat">
			<div class="stat-label"><AppIcon name="shield" :size="16" />Steam Guard</div>
			<div class="stat-value">{{ stats.guard }}</div>
			<div class="stat-sub" :class="stats.guard < stats.total ? 'warn' : 'muted'">
				{{ stats.guard < stats.total ? `${stats.total - stats.guard} 个没有令牌` : `有 maFile ${stats.mafile} 个` }}
			</div>
		</div>
		<div class="stat">
			<div class="stat-label"><AppIcon name="wallet" :size="16" />钱包余额</div>
			<div class="stat-value">{{ stats.wallets[0] ? `≈ ${money(stats.wallets[0])}` : '—' }}</div>
			<div class="stat-sub info" :title="stats.wallets.map(money).join(' · ')">
				所有账户合计<template v-if="stats.wallets.length > 1"> · 另有 {{ stats.wallets.slice(1).map(money).join(' · ') }}</template>
			</div>
		</div>
	</section>

	<section class="table-panel panel">
		<div class="toolbar">
			<div class="toolbar-left">
				<template v-if="accounts.selected.size">
					<span class="selected-count">已选 {{ accounts.selected.size }} 个</span>
					<NButton size="small" :loading="busy === 'login'" @click="run('login', loginAccount)">
						<template #icon><AppIcon name="login" :size="16" /></template>登录
					</NButton>
					<NButton size="small" :loading="busy === 'logout'" @click="run('logout', logoutAccount)">
						<template #icon><AppIcon name="logout" :size="16" /></template>登出
					</NButton>
					<NDropdown trigger="click" :options="moveOptions()" @select="(key: string) => onMove(key, selectedRows)">
						<NButton size="small"><template #icon><AppIcon name="folder" :size="16" /></template>移到分组</NButton>
					</NDropdown>
					<NButton size="small" @click="proxyAccounts = selectedRows.map(row => row.accountName)">
						<template #icon><AppIcon name="globe" :size="16" /></template>代理
					</NButton>
					<NButton size="small" type="error" secondary :loading="busy === 'delete'" @click="confirmDelete">
						<template #icon><AppIcon name="trash" :size="16" /></template>删除
					</NButton>
					<NButton size="small" quaternary @click="accounts.selected.clear()">取消选择</NButton>
				</template>
				<div v-else class="seq-pick">
					<NTooltip placement="top">
						<template #trigger><span class="muted">按序号勾选</span></template>
						输入序号区间,勾选对应账户(只填一边就是单个)
					</NTooltip>
					<NInput v-model:value="range.start" size="small" placeholder="00" class="seq-input" @keyup.enter="selectRange" />
					<span class="muted">–</span>
					<NInput v-model:value="range.end" size="small" placeholder="00" class="seq-input" @keyup.enter="selectRange" />
					<NButton size="small" secondary @click="selectRange">勾选</NButton>
				</div>
			</div>
			<div class="toolbar-right">
				<NInput :value="accounts.search" size="small" placeholder="请输入关键词" clearable class="search" @update:value="setSearch">
					<template #prefix><AppIcon name="search" :size="16" class="muted" /></template>
				</NInput>
				<NPopover trigger="click" placement="bottom-end" :show-arrow="false" style="width: 320px">
					<template #trigger>
						<span class="tip-anchor">
							<NTooltip placement="top">
								<template #trigger>
									<NBadge :value="filterCount" :show="filterCount > 0" type="warning">
										<NButton size="small" quaternary aria-label="筛选"><template #icon><AppIcon name="filter" /></template></NButton>
									</NBadge>
								</template>
								筛选(按分组、会话、GC、令牌、余额)
							</NTooltip>
						</span>
					</template>
					<div class="filter-form">
						<div class="filter-title">筛选条件</div>
						<label>分组</label>
						<NSelect size="small" :value="accounts.filters.group || ANY" :options="groupOptions" @update:value="(value: string) => setFilters({group: pick(value)})" />
						<label>会话</label>
						<NSelect size="small" :value="accounts.filters.session || ANY" :options="SESSION_OPTIONS" @update:value="(value: string) => setFilters({session: pick(value) as AccountFilters['session']})" />
						<label>GC</label>
						<NSelect size="small" :value="accounts.filters.gc || ANY" :options="GC_OPTIONS" @update:value="(value: string) => setFilters({gc: pick(value) as AccountFilters['gc']})" />
						<label>Steam Guard</label>
						<NSelect size="small" :value="accounts.filters.guard || ANY" :options="GUARD_OPTIONS" @update:value="(value: string) => setFilters({guard: pick(value) as AccountFilters['guard']})" />
						<label>钱包余额</label>
						<div class="balance-range">
							<NInputNumber size="small" :value="accounts.filters.minBalance" :min="0" placeholder="下限" clearable :show-button="false" @update:value="(value: number | null) => setFilters({minBalance: value})" />
							<span class="muted">–</span>
							<NInputNumber size="small" :value="accounts.filters.maxBalance" :min="0" placeholder="上限" clearable :show-button="false" @update:value="(value: number | null) => setFilters({maxBalance: value})" />
						</div>
						<NButton size="small" block secondary :disabled="!filterCount" class="filter-reset" @click="resetFilters">重置</NButton>
					</div>
				</NPopover>
				<NPopover trigger="click" placement="bottom-end" :show-arrow="false">
					<template #trigger>
						<span class="tip-anchor">
							<NTooltip placement="top">
								<template #trigger>
									<NButton size="small" quaternary aria-label="显示的列"><template #icon><AppIcon name="columns" /></template></NButton>
								</template>
								设置显示哪些列
							</NTooltip>
						</span>
					</template>
					<div class="column-form">
						<div class="filter-title">显示的列</div>
						<NCheckbox
							v-for="option in COLUMN_OPTIONS"
							:key="option.key"
							:checked="!hidden.has(option.key)"
							@update:checked="(checked: boolean) => toggleColumn(option.key, checked)"
						>
							{{ option.label }}
						</NCheckbox>
					</div>
				</NPopover>
			</div>
		</div>

		<div v-if="filterChips.length" class="chips">
			<span class="muted">当前筛选</span>
			<NTag v-for="chip in filterChips" :key="chip.key" size="small" closable :bordered="false" type="warning" @close="setFilters(chip.clear)">{{ chip.label }}</NTag>
			<NButton size="tiny" text type="primary" @click="resetFilters">清除全部</NButton>
		</div>

		<NDataTable
			class="account-table"
			flex-height
			size="small"
			:bordered="false"
			:single-line="true"
			:columns="columns"
			:data="visibleRows"
			:row-key="(row: AccountRow) => row.key"
			:checked-row-keys="checkedKeys"
			:scroll-x="scrollX"
			:loading="accounts.loading && !accounts.loaded"
			virtual-scroll
			@update:checked-row-keys="onCheckedChange"
			@update:sorter="onSorter"
		>
			<template #empty>
				<div class="empty">
					<template v-if="accounts.rows.length">
						<span class="muted">没有符合条件的账户</span>
						<NButton size="small" secondary @click="resetFilters(); setSearch('')">清除筛选和搜索</NButton>
					</template>
					<span v-else class="muted">暂无账户,点右上角「导入账户」或「导入 maFile」添加</span>
				</div>
			</template>
		</NDataTable>

		<div class="table-foot muted">
			显示 {{ visibleRows.length }} 个,共 {{ accounts.rows.length }} 个账户
		</div>
	</section>

	<HistoryModal :account-name="historyAccount" @close="historyAccount = ''" />
	<ProxyModal :account-names="proxyAccounts" @close="proxyAccounts = []" />
</template>

<style scoped>
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
	overflow: hidden;
	text-overflow: ellipsis;
}

.stat-sub {
	font-size: 13px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.accent {
	color: var(--accent-text);
}

.ok {
	color: var(--ok);
}

.warn {
	color: var(--warn);
}

.info {
	color: var(--info);
}

.table-panel {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 380px;
	overflow: hidden;
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
.toolbar-right,
.seq-pick {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
}

.selected-count {
	margin-right: 4px;
	color: var(--accent-text);
	font-weight: 600;
	font-size: 13px;
}

.seq-input {
	width: 56px;
}

.search {
	width: 240px;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	padding: 8px 12px;
	border-bottom: 1px solid var(--line);
	font-size: 13px;
}

.account-table {
	flex: 1;
	min-height: 0;
}

.table-foot {
	padding: 8px 14px;
	border-top: 1px solid var(--line);
	font-size: 12px;
}

.empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
	padding: 24px 0;
}

.filter-form,
.column-form {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.filter-form label {
	margin-top: 4px;
	font-size: 13px;
	font-weight: 500;
}

.filter-title {
	margin-bottom: 2px;
	font-weight: 600;
}

.balance-range {
	display: flex;
	align-items: center;
	gap: 6px;
}

.filter-reset {
	margin-top: 8px;
}

:deep(.account-name) {
	font-weight: 500;
}

:deep(.clickable) {
	cursor: pointer;
}

:deep(.group-badge) {
	max-width: 100%;
}

:deep(.guard-cell) {
	display: inline-flex;
}

:deep(.code-cell) {
	display: inline-flex;
	flex-direction: column;
	gap: 3px;
	padding: 2px 0;
	border: 0;
	background: none;
	color: inherit;
	font: inherit;
	cursor: pointer;
}

:deep(.code-text) {
	font-weight: 600;
	letter-spacing: 0.12em;
}

:deep(.code-cell:hover .code-text) {
	color: var(--accent-text);
}

:deep(.code-bar) {
	display: block;
	width: 52px;
	height: 3px;
	border-radius: 2px;
	background: var(--line);
	overflow: hidden;
}

:deep(.code-bar-fill) {
	display: block;
	height: 100%;
	background: var(--accent);
	transition: width 1s linear;
}

:deep(.code-bar-fill.is-ending) {
	background: var(--danger);
}

:deep(.row-actions) {
	display: flex;
	align-items: center;
	gap: 10px;
}

@media (max-width: 900px) {
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
</style>
