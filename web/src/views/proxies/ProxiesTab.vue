<script setup lang="ts">
// 代理列表:顶上一排统计卡片,下面是表格卡片(搜索、筛选、列设置、勾选后批量操作:测试、启用 / 停用、登录速率限制、
// 加入 / 移出代理组、删除;行尾是测试、编辑、删除)。检测在服务端后台跑,状态列先显示「检查中」,测完自动更新。
import {computed, h, onMounted, onUnmounted, ref} from 'vue';
import {NAlert, NBadge, NButton, NCheckbox, NDataTable, NDropdown, NInput, NInputNumber, NPopover, NSelect, NSwitch, NTag, NTooltip, useMessage} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey, DataTableSortState, DropdownOption} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {PublicProxy} from '../../api/types.ts';
import AppIcon from '../../components/AppIcon.vue';
import type {IconName} from '../../components/AppIcon.vue';
import GroupChip from '../../components/GroupChip.vue';
import {withTip} from '../../components/tip.ts';
import {
	NO_GROUP, PROTOCOL_OPTIONS, PROXY_KIND_OPTIONS, STATUS_META, STATUS_OPTIONS, accountsAssignedTo, accountsPinnedTo, activeProxyFilterCount, emptyProxyFilters,
	isSingleIpRotating, matchesProxy, proxyKindLabel, proxyStats, sortProxies, timeAgo, uniqueIpText
} from '../../lib/proxy.ts';
import type {ProxyFilters, ProxySortKey} from '../../lib/proxy.ts';
import {bulkProxies, proxy, testProxies} from '../../stores/proxy.ts';
import type {BulkAction} from '../../stores/proxy.ts';

const emit = defineEmits<{edit: [id: string]; delete: [ids: string[], done?: () => void]; 'new-group': [proxyIds: string[]]; import: []}>();
const message = useMessage();

/** 「上次检查」每半分钟刷新一次 */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	ticker = setInterval(() => (now.value = Date.now()), 30000);
});
onUnmounted(() => clearInterval(ticker));

const stats = computed(() => proxyStats(proxy.data.proxies));
const groupNames = computed(() => new Map(proxy.data.groups.map(group => [group.id, group.name])));

// ===== 列设置(隐藏哪些列存在浏览器里) =====
type ColumnKey = 'protocol' | 'type' | 'loginLimit' | 'groups' | 'status' | 'latency' | 'ip' | 'uniqueIps' | 'accounts' | 'checkedAt' | 'enabled';

const COLUMN_OPTIONS: ReadonlyArray<{key: ColumnKey; label: string}> = [
	{key: 'protocol', label: '协议'},
	{key: 'type', label: '类型'},
	{key: 'loginLimit', label: '登录速率限制'},
	{key: 'groups', label: '代理组'},
	{key: 'status', label: '状态'},
	{key: 'latency', label: '延迟'},
	{key: 'ip', label: '出口 IP'},
	{key: 'uniqueIps', label: '不同 IP'},
	{key: 'accounts', label: '账户'},
	{key: 'checkedAt', label: '上次检查'},
	{key: 'enabled', label: '启用'}
];

const HIDDEN_KEY = 'proxies.hiddenColumns';

function loadHidden(): Set<ColumnKey> {
	try {
		const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
		return new Set(Array.isArray(saved) ? saved : []);
	} catch {
		return new Set();
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

// ===== 搜索、筛选、排序 =====
const ANY = '*';
const search = ref('');
const filters = ref<ProxyFilters>(emptyProxyFilters());
const filterCount = computed(() => activeProxyFilterCount(filters.value));
const sortKey = ref<ProxySortKey | ''>('');
const sortOrder = ref<'ascend' | 'descend'>('ascend');

const pick = (value: string) => (value === ANY ? '' : value);
const withAny = <T extends {value: string; label: string}>(options: readonly T[]) => [{label: '全部', value: ANY}, ...options.map(({value, label}) => ({value, label}))];
const groupOptions = computed(() => [{label: '全部', value: ANY}, {label: '未分组', value: NO_GROUP}, ...proxy.data.groups.map(group => ({label: group.name, value: group.id}))]);
const ENABLED_OPTIONS = [{label: '全部', value: ANY}, {label: '是', value: 'yes'}, {label: '否', value: 'no'}];

function setFilters(patch: Partial<ProxyFilters>): void {
	filters.value = {...filters.value, ...patch};
}

const rows = computed(() => sortProxies(
	proxy.data.proxies.filter(item => matchesProxy(item, filters.value, search.value, groupNames.value)),
	sortKey.value,
	sortOrder.value
));

function onSorter(sorter: DataTableSortState | DataTableSortState[] | null): void {
	const state = Array.isArray(sorter) ? sorter[0] : sorter;
	sortKey.value = state && state.order ? (state.columnKey as ProxySortKey) : '';
	sortOrder.value = state && state.order ? state.order : 'ascend';
}

function sortable(key: ProxySortKey) {
	return {sorter: true as const, sortOrder: sortKey.value === key ? sortOrder.value : (false as const)};
}

// ===== 勾选、批量 =====
const selected = ref(new Set<string>());
/** 只算还在的(别处删掉的不算) */
const selectedIds = computed(() => proxy.data.proxies.filter(item => selected.value.has(item.id)).map(item => item.id));

function onChecked(keys: DataTableRowKey[]): void {
	selected.value = new Set(keys.map(String));
}

const busy = ref('');

async function run(kind: string, action: () => Promise<void>): Promise<void> {
	busy.value = kind;
	try {
		await action();
	} catch (err) {
		message.error(errorText(err));
	} finally {
		busy.value = '';
	}
}

function bulk(action: BulkAction, value?: unknown, ids: string[] = selectedIds.value): Promise<void> {
	return run(action, () => bulkProxies(ids, action, value));
}

function test(ids: string[]): Promise<void> {
	return run('test', async () => {
		await testProxies(ids);
		if (ids.length > 1) {
			message.info(`开始检测 ${ids.length} 个代理,测完自动更新`);
		}
	});
}

const loginLimit = ref<number | null>(null);
const loginLimitOpen = ref(false);

async function applyLoginLimit(): Promise<void> {
	await bulk('loginLimit', loginLimit.value ?? '');
	loginLimitOpen.value = false;
}

const NEW_GROUP = 'new-group';
const addGroupOptions = computed<DropdownOption[]>(() => [
	...proxy.data.groups.map(group => ({label: group.name, key: group.id})),
	...(proxy.data.groups.length ? [{type: 'divider', key: 'divider'}] : []),
	{label: '新建代理组…', key: NEW_GROUP}
]);
const removeGroupOptions = computed<DropdownOption[]>(() => {
	const ids = new Set(proxy.data.proxies.filter(item => selected.value.has(item.id)).flatMap(item => item.groupIds));
	return proxy.data.groups.filter(group => ids.has(group.id)).map(group => ({label: group.name, key: group.id}));
});

function onAddGroup(key: string): void {
	if (key === NEW_GROUP) {
		emit('new-group', selectedIds.value);
	} else {
		void bulk('addGroups', [key]);
	}
}

// ===== 表格 =====
/** 行尾的图标按钮,鼠标放上去显示 label */
function iconAction(icon: IconName, label: string, onClick: () => void, extra: Record<string, unknown> = {}) {
	return withTip(h(NButton, {size: 'small', text: true, type: 'primary', 'aria-label': label, onClick, class: 'row-action', ...extra}, {icon: () => h(AppIcon, {name: icon, size: 17})}), label);
}

function groupsCell(row: PublicProxy) {
	const groups = row.groupIds.map(id => proxy.data.groups.find(group => group.id === id)).filter(group => !!group);
	if (!groups.length) {
		return h('span', {class: 'muted'}, '—');
	}
	const shown = groups.slice(0, 2).map(group => h(GroupChip, {name: group.name, color: group.color}));
	const rest = groups.length - shown.length;
	return h('div', {class: 'chips-cell'}, rest > 0
		? [...shown, withTip(h('span', {class: 'muted more'}, `+${rest}`), groups.slice(2).map(group => group.name).join('、'))]
		: shown);
}

function statusCell(row: PublicProxy) {
	const meta = STATUS_META[row.status];
	const tip = row.check?.error ? `${meta.tip}:${row.check.error}` : meta.tip;
	const parts = [withTip(h(NTag, {size: 'small', bordered: false, type: meta.type, round: true}, {
		default: () => meta.label,
		icon: () => h(AppIcon, {name: row.status === 'healthy' ? 'check' : row.status === 'checking' ? 'radio' : row.status === 'untested' ? 'clock' : 'alert', size: 13})
	}), tip)];
	if (isSingleIpRotating(row)) {
		parts.push(withTip(h('span', {class: 'warn-icon'}, [h(AppIcon, {name: 'alert', size: 15})]),
			`标为轮换,但 ${row.check!.samples} 次检测都是同一个 IP:提供商可能是按时间间隔换 IP,建议设登录速率限制`));
	}
	return h('div', {class: 'status-cell'}, parts);
}

function accountsCell(row: PublicProxy) {
	const assigned = accountsAssignedTo(proxy.data, row.id).filter(Boolean);
	const pinned = accountsPinnedTo(proxy.data, row.id);
	if (!assigned.length && !pinned.length) {
		return h('span', {class: 'muted'}, '—');
	}
	const lines = [
		assigned.length ? `这次运行有 ${assigned.length} 个账号在用:${assigned.slice(0, 8).join('、')}${assigned.length > 8 ? ' 等' : ''}` : '这次运行还没有账号在用',
		pinned.length ? `单独绑定给 ${pinned.length} 个账号(专用,不进代理池):${pinned.slice(0, 8).join('、')}${pinned.length > 8 ? ' 等' : ''}` : ''
	].filter(Boolean);
	return withTip(h('span', {class: 'accounts-cell'}, [
		String(assigned.length),
		pinned.length ? h('span', {class: 'muted'}, ` · 专用 ${pinned.length}`) : null
	]), () => h('div', lines.map(line => h('div', line))));
}

const columns = computed<DataTableColumns<PublicProxy>>(() => {
	const show = (key: ColumnKey) => !hidden.value.has(key);
	const list: DataTableColumns<PublicProxy> = [
		{type: 'selection', fixed: 'left'},
		{
			title: '端点',
			key: 'endpoint',
			width: 210,
			fixed: 'left',
			...sortable('endpoint'),
			render: row => h('div', {class: 'endpoint-cell'}, [
				h('a', {class: 'endpoint', onClick: () => emit('edit', row.id)}, row.endpoint),
				row.username || row.notes ? h('div', {class: 'muted notes'}, [row.username, row.notes].filter(Boolean).join(' · ')) : null
			])
		}
	];
	if (show('protocol')) {
		list.push({title: '协议', key: 'protocol', width: 72, render: row => h(NTag, {size: 'small', bordered: false, type: 'warning'}, () => row.protocol.toUpperCase())});
	}
	if (show('type')) {
		list.push({
			title: '类型',
			key: 'type',
			width: 104,
			render: row => {
				const tag = h(NTag, {size: 'small', bordered: false, type: row.type === 'rotating' ? 'info' : 'default'}, () => proxyKindLabel(row.type) + (row.sticky ? ` · ${row.poolSize} IP` : ''));
				return row.sticky ? withTip(tag, `轮换池里有 ${row.poolSize} 个 IP,每个账号固定其中一个`) : tag;
			}
		});
	}
	if (show('loginLimit')) {
		list.push({
			title: '登录速率限制',
			key: 'loginsPerMinute',
			width: 120,
			align: 'right',
			...sortable('loginsPerMinute'),
			render: row => (row.loginsPerMinute ? `${row.loginsPerMinute}/分钟` : h('span', {class: 'muted'}, '无限制'))
		});
	}
	if (show('groups')) {
		list.push({title: '代理组', key: 'groups', width: 150, render: groupsCell});
	}
	if (show('status')) {
		list.push({title: '状态', key: 'status', width: 170, render: statusCell});
	}
	if (show('latency')) {
		list.push({
			title: '延迟',
			key: 'latency',
			width: 90,
			align: 'right',
			...sortable('latency'),
			render: row => (row.check && row.check.status !== 'unreachable' ? `${row.check.latencyMs} ms` : h('span', {class: 'muted'}, '—'))
		});
	}
	if (show('ip')) {
		list.push({
			title: '出口 IP',
			key: 'ip',
			width: 150,
			render: row => (row.check?.ip
				? h('span', {class: 'ip-cell'}, [h('span', {class: 'mono'}, row.check.ip), row.check.country ? h('span', {class: 'muted country'}, row.check.country) : null])
				: h('span', {class: 'muted'}, '—'))
		});
	}
	if (show('uniqueIps')) {
		list.push({
			title: '不同 IP',
			key: 'uniqueIps',
			width: 110,
			render: row => {
				const text = uniqueIpText(row.check);
				return row.check && row.check.ips.length > 1 ? withTip(h('span', text), row.check.ips.join('\n')) : h('span', {class: text === '—' ? 'muted' : ''}, text);
			}
		});
	}
	if (show('accounts')) {
		list.push({title: '账户', key: 'accounts', width: 90, render: accountsCell});
	}
	if (show('checkedAt')) {
		list.push({
			title: '上次检查',
			key: 'checkedAt',
			width: 100,
			...sortable('checkedAt'),
			render: row => (row.check ? withTip(h('span', timeAgo(row.check.checkedAt, now.value)), new Date(row.check.checkedAt).toLocaleString()) : h('span', {class: 'muted'}, '—'))
		});
	}
	if (show('enabled')) {
		list.push({
			title: '启用',
			key: 'enabled',
			width: 64,
			render: row => withTip(h(NSwitch, {
				size: 'small',
				value: row.enabled,
				disabled: !!busy.value,
				'onUpdate:value': (value: boolean) => bulk(value ? 'enable' : 'disable', undefined, [row.id])
			}), row.enabled ? '启用着:关掉后不给账号用(填的留着)' : '停用了:不给账号用')
		});
	}
	list.push({
		title: '',
		key: 'actions',
		width: 100,
		fixed: 'right',
		render: row => h('div', {class: 'row-actions'}, [
			iconAction('radio', '测试这个代理', () => test([row.id]), {disabled: row.status === 'checking'}),
			iconAction('pencil', '编辑', () => emit('edit', row.id)),
			iconAction('trash', '删除', () => emit('delete', [row.id]), {type: 'error'})
		])
	});
	return list;
});

const scrollX = computed(() => columns.value.reduce((sum, column) => sum + (('width' in column && Number(column.width)) || 48), 0));
</script>

<template>
	<section class="stats panel">
		<div class="stat">
			<div class="stat-label"><AppIcon name="globe" :size="16" />代理</div>
			<div class="stat-value">{{ stats.total }}</div>
			<div class="stat-sub accent">{{ stats.total ? `启用 ${stats.enabled} 个` : '你的代理池总数' }}</div>
		</div>
		<div class="stat">
			<div class="stat-label"><AppIcon name="check" :size="16" />健康</div>
			<div class="stat-value">{{ stats.healthy }}</div>
			<div class="stat-sub ok">已通过上次检查</div>
		</div>
		<div class="stat">
			<div class="stat-label"><AppIcon name="alert" :size="16" />异常</div>
			<div class="stat-value">{{ stats.failing }}</div>
			<div class="stat-sub" :class="stats.failing ? 'danger' : 'muted'">连不上代理</div>
		</div>
		<div class="stat">
			<div class="stat-label"><AppIcon name="clock" :size="16" />未测试</div>
			<div class="stat-value">{{ stats.untested }}</div>
			<div class="stat-sub muted">尚未检查过</div>
		</div>
	</section>

	<NAlert v-if="proxy.loaded && !stats.enabled" type="info" :bordered="false" class="pool-hint">
		代理池里没有启用的代理,Steam 请求直连。添加代理后,没绑定的账号从代理池里分一个用;要给账号固定代理,在「账户管理」里绑定。
	</NAlert>

	<section class="table-panel panel">
		<div class="toolbar">
			<div class="toolbar-left">
				<template v-if="selectedIds.length">
					<span class="selected-count">已选 {{ selectedIds.length }} 个</span>
					<NButton size="small" :loading="busy === 'test'" @click="test(selectedIds)"><template #icon><AppIcon name="radio" :size="16" /></template>测试所选</NButton>
					<NButton size="small" :loading="busy === 'enable'" @click="bulk('enable')"><template #icon><AppIcon name="power" :size="16" /></template>启用</NButton>
					<NButton size="small" :loading="busy === 'disable'" @click="bulk('disable')">停用</NButton>
					<NPopover v-model:show="loginLimitOpen" trigger="click" placement="bottom-start" :show-arrow="false">
						<template #trigger>
							<NButton size="small" :loading="busy === 'loginLimit'"><template #icon><AppIcon name="clock" :size="16" /></template>登录速率限制</NButton>
						</template>
						<div class="limit-form">
							<div class="filter-title">每分钟最多几次 Steam 登录</div>
							<NInputNumber v-model:value="loginLimit" size="small" :min="1" :max="10000" :precision="0" :show-button="false" placeholder="留空不限" clearable>
								<template #suffix>次/分钟</template>
							</NInputNumber>
							<NButton size="small" type="primary" block @click="applyLoginLimit">应用到 {{ selectedIds.length }} 个代理</NButton>
						</div>
					</NPopover>
					<NDropdown trigger="click" :options="addGroupOptions" @select="onAddGroup">
						<NButton size="small"><template #icon><AppIcon name="tag" :size="16" /></template>加入代理组</NButton>
					</NDropdown>
					<NDropdown v-if="removeGroupOptions.length" trigger="click" :options="removeGroupOptions" @select="(key: string) => bulk('removeGroups', [key])">
						<NButton size="small">移出代理组</NButton>
					</NDropdown>
					<NButton size="small" type="error" secondary @click="emit('delete', selectedIds, () => (selected = new Set()))">
						<template #icon><AppIcon name="trash" :size="16" /></template>删除
					</NButton>
					<NButton size="small" quaternary @click="selected = new Set()">取消选择</NButton>
				</template>
				<span v-else class="muted">共 {{ stats.total }} 个代理</span>
			</div>
			<div class="toolbar-right">
				<NInput v-model:value="search" size="small" placeholder="请输入关键词" clearable class="search">
					<template #prefix><AppIcon name="search" :size="16" class="muted" /></template>
				</NInput>
				<NPopover trigger="click" placement="bottom-end" :show-arrow="false" style="width: 300px">
					<template #trigger>
						<span class="tip-anchor">
							<NTooltip placement="top">
								<template #trigger>
									<NBadge :value="filterCount" :show="filterCount > 0" type="warning">
										<NButton size="small" quaternary aria-label="筛选"><template #icon><AppIcon name="filter" /></template></NButton>
									</NBadge>
								</template>
								筛选(按状态、协议、类型、代理组、启用)
							</NTooltip>
						</span>
					</template>
					<div class="filter-form">
						<div class="filter-title">筛选条件</div>
						<label>状态</label>
						<NSelect size="small" :value="filters.status || ANY" :options="withAny(STATUS_OPTIONS)" @update:value="(value: string) => setFilters({status: pick(value) as ProxyFilters['status']})" />
						<label>协议</label>
						<NSelect size="small" :value="filters.protocol || ANY" :options="withAny(PROTOCOL_OPTIONS)" @update:value="(value: string) => setFilters({protocol: pick(value) as ProxyFilters['protocol']})" />
						<label>类型</label>
						<NSelect size="small" :value="filters.type || ANY" :options="withAny(PROXY_KIND_OPTIONS)" @update:value="(value: string) => setFilters({type: pick(value) as ProxyFilters['type']})" />
						<label>代理组</label>
						<NSelect size="small" :value="filters.group || ANY" :options="groupOptions" @update:value="(value: string) => setFilters({group: pick(value)})" />
						<label>启用</label>
						<NSelect size="small" :value="filters.enabled || ANY" :options="ENABLED_OPTIONS" @update:value="(value: string) => setFilters({enabled: pick(value) as ProxyFilters['enabled']})" />
						<NCheckbox class="single-ip" :checked="filters.singleIp" @update:checked="(checked: boolean) => setFilters({singleIp: checked})">标为轮换但只有一个 IP</NCheckbox>
						<NButton size="small" block secondary :disabled="!filterCount" class="filter-reset" @click="filters = emptyProxyFilters()">重置</NButton>
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
						<NCheckbox v-for="option in COLUMN_OPTIONS" :key="option.key" :checked="!hidden.has(option.key)" @update:checked="(checked: boolean) => toggleColumn(option.key, checked)">
							{{ option.label }}
						</NCheckbox>
					</div>
				</NPopover>
			</div>
		</div>

		<NDataTable
			class="proxy-table"
			flex-height
			size="small"
			:bordered="false"
			:single-line="true"
			:columns="columns"
			:data="rows"
			:row-key="(row: PublicProxy) => row.id"
			:checked-row-keys="selectedIds"
			:scroll-x="scrollX"
			:loading="!proxy.loaded && !proxy.error"
			@update:checked-row-keys="onChecked"
			@update:sorter="onSorter"
		>
			<template #empty>
				<div class="empty">
					<template v-if="proxy.data.proxies.length">
						<span class="muted">没有符合条件的代理</span>
						<NButton size="small" secondary @click="filters = emptyProxyFilters(); search = ''">清除筛选和搜索</NButton>
					</template>
					<template v-else>
						<span class="muted">还没有代理</span>
						<NButton size="small" secondary @click="emit('import')">粘贴代理列表导入</NButton>
					</template>
				</div>
			</template>
		</NDataTable>

		<div class="table-foot muted">显示 {{ rows.length }} 个,共 {{ stats.total }} 个代理</div>
	</section>
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

.danger {
	color: var(--danger);
}

.pool-hint {
	flex: none;
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
.toolbar-right {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	min-height: 28px;
}

.selected-count {
	margin-right: 4px;
	color: var(--accent-text);
	font-weight: 600;
	font-size: 13px;
}

.search {
	width: 240px;
}

.proxy-table {
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
.column-form,
.limit-form {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.limit-form {
	width: 220px;
	gap: 8px;
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

.single-ip {
	margin-top: 8px;
}

.filter-reset {
	margin-top: 8px;
}

:deep(.endpoint-cell) {
	min-width: 0;
}

:deep(.endpoint) {
	color: var(--text);
	font-weight: 500;
	cursor: pointer;
}

:deep(.endpoint:hover) {
	color: var(--accent-text);
}

:deep(.notes) {
	overflow: hidden;
	font-size: 12px;
	white-space: nowrap;
	text-overflow: ellipsis;
}

:deep(.chips-cell),
:deep(.status-cell) {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px;
}

:deep(.more) {
	font-size: 12px;
	cursor: default;
}

:deep(.warn-icon) {
	display: inline-flex;
	color: var(--warn);
}

:deep(.ip-cell) {
	display: inline-flex;
	align-items: baseline;
	gap: 6px;
}

:deep(.country) {
	font-size: 12px;
}

:deep(.accounts-cell) {
	cursor: default;
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
