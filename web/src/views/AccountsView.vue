<script setup lang="ts">
// 账户管理:按「GC 已连接 / 在线 / 未在线」分段的账号表,可按用户建的分组筛选;导入、登录/登出/删除、移到分组、按序号勾选、
// Steam Guard、令牌验证码、消费记录、Steam 代理、连接 GC。
import {computed, h, onMounted, reactive, ref} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NDropdown, NInput, NModal, NRadioButton, NRadioGroup, NSpace, NTag, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey, DropdownOption} from 'naive-ui';
import {errorText} from '../api/http.ts';
import type {GameId} from '../api/types.ts';
import {NO_GROUP, STATUS_TAG, formatBalance, groupFilterOptions, padSeq, resolveSeqRange} from '../lib/accounts.ts';
import {
	accounts, canUseGc, connectGc, connectedGame, createGroup, deleteSelected, disconnectGc, forSelected, gameLabel, groupName,
	importAccountText, importMaFiles, loginAccount, logoutAccount, moveToGroup, onlineCount, orderedAccounts, selectedRows, setGroupFilter,
	statusGroups, submitGuardCode
} from '../stores/accounts.ts';
import type {AccountRow, StatusGroupView} from '../stores/accounts.ts';
import {accountProxy} from '../lib/proxy.ts';
import {loadProxy, proxy} from '../stores/proxy.ts';
import GroupsModal from './accounts/GroupsModal.vue';
import HistoryModal from './accounts/HistoryModal.vue';
import ProxyModal from './accounts/ProxyModal.vue';
import TotpModal from './accounts/TotpModal.vue';

const message = useMessage();
const dialog = useDialog();

type TableRow =
	| {kind: 'status'; key: string; group: StatusGroupView; children: TableRow[]}
	| {kind: 'account'; key: string; row: AccountRow; seq: number};

const STATUS_PREFIX = 'status:';

// ===== 表格数据:状态段是父行,账号是子行;序号按显示顺序连续编号(收起的段也占号) =====
const tableData = computed<TableRow[]>(() => {
	let seq = 0;
	return statusGroups.value.filter(group => group.rows.length).map(group => ({
		kind: 'status' as const,
		key: STATUS_PREFIX + group.key,
		group,
		children: group.rows.map(row => ({kind: 'account' as const, key: row.key, row, seq: ++seq}))
	}));
});

const collapsed = reactive(new Set<string>());
const expandedKeys = computed(() => tableData.value.map(group => group.key).filter(key => !collapsed.has(key)));

function onExpandedChange(keys: DataTableRowKey[]): void {
	const open = new Set(keys.map(String));
	for (const group of tableData.value) {
		if (open.has(group.key)) {
			collapsed.delete(group.key);
		} else {
			collapsed.add(group.key);
		}
	}
}

const checkedKeys = computed(() => [...accounts.selected]);

function onCheckedChange(keys: DataTableRowKey[]): void {
	accounts.selected.clear();
	for (const key of keys.map(String)) {
		if (!key.startsWith(STATUS_PREFIX)) {
			accounts.selected.add(key);
		}
	}
}

// ===== 分组 =====
const filterOptions = computed(() => groupFilterOptions(accounts.groups, accounts.rows));
const groupsOpen = ref(false);
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
		openNewGroup(rows);
	} else {
		moveToGroup(rows, key === NO_GROUP ? '' : key);
	}
}

/** 新建分组并把这些账号移进去 */
const newGroup = reactive({open: false, name: '', saving: false, error: '', rows: [] as AccountRow[]});

function openNewGroup(rows: AccountRow[]): void {
	Object.assign(newGroup, {open: true, name: '', saving: false, error: '', rows: [...rows]});
}

async function submitNewGroup(): Promise<void> {
	const name = newGroup.name.trim();
	if (!name) {
		newGroup.error = '请输入分组名';
		return;
	}
	newGroup.saving = true;
	newGroup.error = '';
	try {
		await createGroup(name, newGroup.rows);
		newGroup.open = false;
	} catch (err) {
		newGroup.error = errorText(err);
	} finally {
		newGroup.saving = false;
	}
}

function groupCell(row: AccountRow) {
	const name = groupName(row.groupId);
	return h(NDropdown, {trigger: 'click', options: moveOptions(row.groupId), onSelect: (key: string) => onMove(key, [row])},
		() => h(NButton, {size: 'tiny', quaternary: !name, class: 'group-button', title: name || '点击移到分组'}, () => name || '未分组'));
}

const totpAccount = ref('');
const historyAccount = ref('');
const proxyAccount = ref('');

onMounted(loadProxy);

function gcCell(row: AccountRow) {
	const game = canUseGc(row) ? connectedGame(row) : '';
	if (game) {
		return h(NButton, {size: 'tiny', onClick: () => disconnectGc(row, game)}, () => `断开${gameLabel(game)}`);
	}
	if (!canUseGc(row)) {
		return h(NButton, {size: 'tiny', disabled: true}, () => '连接GC');
	}
	return h(NDropdown, {
		trigger: 'click',
		options: [{label: '连接CS2', key: 'cs2'}, {label: '连接TF2', key: 'tf2'}],
		onSelect: (key: GameId) => connectGc(row, key)
	}, () => h(NButton, {size: 'tiny'}, () => '连接GC'));
}

const DATA_COLUMNS = 11;

const columns: DataTableColumns<TableRow> = [
	{type: 'selection'},
	{
		title: '序号',
		key: 'seq',
		width: 90,
		// 状态段行占满整行:标题 + 人数
		colSpan: item => (item.kind === 'status' ? DATA_COLUMNS : 1),
		render: item => item.kind === 'status'
			? h('span', {class: 'status-title'}, [
				item.group.title,
				h(NTag, {size: 'small', round: true, bordered: false, type: item.group.key === 'offline' ? 'default' : 'success', class: 'status-count'}, () => String(item.group.rows.length))
			])
			: h('span', {class: 'mono'}, padSeq(item.seq))
	},
	{title: '账号', key: 'accountName', width: 170, ellipsis: {tooltip: true}, render: item => (item.kind === 'account' ? item.row.accountName : null)},
	{title: '分组', key: 'group', width: 120, render: item => (item.kind === 'account' ? groupCell(item.row) : null)},
	{
		title: 'maFile',
		key: 'maFile',
		width: 130,
		render: item => {
			if (item.kind !== 'account') return null;
			const row = item.row;
			return h(NSpace, {size: 6, align: 'center', wrap: false}, () => [
				h(NTag, {size: 'small', bordered: false, type: row.hasMaFile ? 'success' : 'default'}, () => (row.hasMaFile ? '有' : '无')),
				h(NButton, {size: 'tiny', disabled: !(row.hasMaFile || row.hasSharedSecret), onClick: () => (totpAccount.value = row.accountName)}, () => '验证码')
			]);
		}
	},
	{
		title: '状态',
		key: 'status',
		width: 100,
		render: item => (item.kind === 'account'
			? h(NTag, {size: 'small', bordered: false, type: STATUS_TAG[item.row.status], title: item.row.lastError || undefined}, () => item.row.status)
			: null)
	},
	{title: '国家', key: 'country', width: 70, render: item => (item.kind === 'account' ? item.row.country || '-' : null)},
	{title: '余额', key: 'balance', width: 110, render: item => (item.kind === 'account' ? formatBalance(item.row) : null)},
	{
		title: '消费记录',
		key: 'history',
		width: 90,
		// 不在线也能点:服务端会用上次登录存下的网页会话去读
		render: item => (item.kind === 'account'
			? h(NButton, {size: 'tiny', onClick: () => (historyAccount.value = item.row.accountName)}, () => '查看')
			: null)
	},
	{
		title: '代理',
		key: 'proxy',
		width: 130,
		render: item => {
			if (item.kind !== 'account') return null;
			const view = accountProxy(proxy.config, item.row.accountName);
			return h(NButton, {size: 'tiny', quaternary: view.mode === 'global', title: view.title, onClick: () => (proxyAccount.value = item.row.accountName)}, () => view.label);
		}
	},
	{title: 'SteamID', key: 'steamID', width: 170, ellipsis: {tooltip: true}, render: item => (item.kind === 'account' ? h('span', {class: 'mono'}, item.row.steamID || '-') : null)},
	{title: 'GC操作', key: 'gc', width: 100, render: item => (item.kind === 'account' ? gcCell(item.row) : null)}
];

function rowProps(item: TableRow) {
	if (item.kind !== 'status') {
		return {};
	}
	return {
		style: 'cursor: pointer',
		// 点状态段行(复选框、展开箭头除外)收起/展开
		onClick: (event: MouseEvent) => {
			if ((event.target as HTMLElement).closest('.n-checkbox, .n-data-table-expand-trigger')) {
				return;
			}
			if (collapsed.has(item.key)) {
				collapsed.delete(item.key);
			} else {
				collapsed.add(item.key);
			}
		}
	};
}

// ===== 按序号勾选 =====
const range = reactive({start: '', end: ''});

function selectRange(): void {
	const order = orderedAccounts.value;
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
	if (kind === 'login') {
		// 固定 IP 代理:登录时服务端会给账号分 / 换编号,刷新一下「代理」列
		loadProxy();
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

// ===== 导入 =====
const importModal = reactive({open: false, text: '', saving: false, error: ''});

async function submitImport(): Promise<void> {
	importModal.saving = true;
	importModal.error = '';
	try {
		await importAccountText(importModal.text);
		importModal.open = false;
		importModal.text = '';
	} catch (err) {
		importModal.error = errorText(err);
	} finally {
		importModal.saving = false;
	}
}

const fileInput = ref<HTMLInputElement | null>(null);

async function onMaFiles(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const files = Array.from(input.files || []);
	input.value = '';
	if (files.length) {
		await importMaFiles(files);
	}
}

// ===== Steam Guard =====
const guardCode = ref('');
const guardSubmitting = ref(false);

async function submitGuard(): Promise<void> {
	const code = guardCode.value.trim();
	if (!code) {
		message.warning('请输入 Steam Guard 验证码');
		return;
	}
	guardSubmitting.value = true;
	try {
		await submitGuardCode(code);
		guardCode.value = '';
	} catch (err) {
		message.error(errorText(err));
	} finally {
		guardSubmitting.value = false;
	}
}
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>账户管理</h1>
				<div class="module-counts">
					<span>{{ accounts.rows.length }} 个账户</span>
					<span>在线数:{{ onlineCount }}</span>
					<span>离线数:{{ accounts.rows.length - onlineCount }}</span>
					<span>{{ accounts.selected.size }} 已选</span>
				</div>
			</div>
			<NSpace align="center">
				<NSpace :size="4" align="center" :wrap="false" title="输入序号区间,勾选对应账户(留空一侧表示单个)">
					<span class="muted">按序号勾选</span>
					<NInput v-model:value="range.start" size="small" placeholder="00" class="seq-input" @keyup.enter="selectRange" />
					<span class="muted">-</span>
					<NInput v-model:value="range.end" size="small" placeholder="00" class="seq-input" @keyup.enter="selectRange" />
					<NButton size="small" @click="selectRange">勾选</NButton>
				</NSpace>
				<NButton @click="importModal.open = true">导入账户</NButton>
				<NButton @click="fileInput?.click()">导入 maFile</NButton>
				<NButton type="primary" :disabled="!accounts.selected.size" :loading="busy === 'login'" @click="run('login', loginAccount)">登录选中</NButton>
				<NButton :disabled="!accounts.selected.size" :loading="busy === 'logout'" @click="run('logout', logoutAccount)">登出选中</NButton>
				<NDropdown trigger="click" :options="moveOptions()" :disabled="!accounts.selected.size" @select="(key: string) => onMove(key, selectedRows)">
					<NButton :disabled="!accounts.selected.size">移到分组</NButton>
				</NDropdown>
				<NButton :disabled="!accounts.selected.size" :loading="busy === 'delete'" @click="confirmDelete">删除选中</NButton>
			</NSpace>
		</header>

		<input ref="fileInput" type="file" accept=".maFile,.json,application/json" multiple hidden @change="onMaFiles">

		<div class="group-bar">
			<NRadioGroup :value="accounts.groupFilter" size="small" @update:value="setGroupFilter">
				<NRadioButton v-for="option in filterOptions" :key="option.value" :value="option.value" :title="option.label">
					<span class="group-option">{{ option.label }}</span><span class="group-option-count">{{ option.count }}</span>
				</NRadioButton>
			</NRadioGroup>
			<NButton size="small" quaternary @click="groupsOpen = true">管理分组</NButton>
		</div>

		<NAlert v-if="accounts.guard" type="warning" :bordered="false"
			:title="`${accounts.guard.accountName}:需要${accounts.guard.type === 'email' ? '邮箱' : '移动令牌'} Steam Guard`">
			<div class="guard-body">
				<span>{{ accounts.guard.lastCodeWrong ? '上一个验证码错误,请重新输入。' : (accounts.guard.domain ? '邮箱域名: ' + accounts.guard.domain : '请输入 Steam 手机令牌验证码。') }}</span>
				<NSpace :size="6" :wrap="false">
					<NInput v-model:value="guardCode" size="small" placeholder="验证码" :maxlength="8" class="guard-input" autofocus @keyup.enter="submitGuard" />
					<NButton size="small" type="primary" :loading="guardSubmitting" @click="submitGuard">提交</NButton>
				</NSpace>
			</div>
		</NAlert>

		<NAlert v-if="accounts.error" type="error" :bordered="false">读取账户名单失败:{{ accounts.error }}</NAlert>

		<div class="module-body">
			<NDataTable
				class="account-table"
				flex-height
				size="small"
				:columns="columns"
				:data="tableData"
				:row-key="(item: TableRow) => item.key"
				:checked-row-keys="checkedKeys"
				:expanded-row-keys="expandedKeys"
				:row-class-name="(item: TableRow) => (item.kind === 'status' ? 'status-row' : '')"
				:row-props="rowProps"
				:indent="0"
				:scroll-x="1320"
				:loading="accounts.loading && !accounts.loaded"
				virtual-scroll
				@update:checked-row-keys="onCheckedChange"
				@update:expanded-row-keys="onExpandedChange"
			>
				<template #empty>
					<span v-if="accounts.rows.length" class="muted">这个分组里没有账户,可以在「分组」列或「移到分组」里把账户移进来</span>
					<span v-else class="muted">暂无账户,点「导入账户」或「导入 maFile」添加</span>
				</template>
			</NDataTable>
		</div>

		<NModal v-model:show="importModal.open" :mask-closable="!importModal.saving">
			<NCard title="导入账户" style="width: 520px" :bordered="false" role="dialog" aria-modal="true">
				<p class="muted import-hint">账号----密码,一行一个。已有的账号会更新密码,其它账号不受影响。</p>
				<NInput v-model:value="importModal.text" type="textarea" :rows="12" placeholder="account1----password1&#10;account2----password2" :input-props="{spellcheck: false}" />
				<NAlert v-if="importModal.error" type="error" :bordered="false" class="import-error">{{ importModal.error }}</NAlert>
				<template #footer>
					<NSpace justify="end">
						<NButton :disabled="importModal.saving" @click="importModal.open = false">取消</NButton>
						<NButton type="primary" :loading="importModal.saving" @click="submitImport">导入</NButton>
					</NSpace>
				</template>
			</NCard>
		</NModal>

		<NModal v-model:show="newGroup.open" :mask-closable="!newGroup.saving">
			<NCard title="新建分组" style="width: 400px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
				<p class="muted import-hint">
					{{ newGroup.rows.length === 1 ? `建好后把 ${newGroup.rows[0]!.accountName} 移进去` : `建好后把选中的 ${newGroup.rows.length} 个账户移进去` }}
				</p>
				<NInput v-model:value="newGroup.name" placeholder="分组名" :maxlength="20" autofocus @keyup.enter="submitNewGroup" />
				<NAlert v-if="newGroup.error" type="error" :bordered="false" class="import-error">{{ newGroup.error }}</NAlert>
				<template #footer>
					<NSpace justify="end">
						<NButton :disabled="newGroup.saving" @click="newGroup.open = false">取消</NButton>
						<NButton type="primary" :loading="newGroup.saving" @click="submitNewGroup">新建并移入</NButton>
					</NSpace>
				</template>
			</NCard>
		</NModal>

		<GroupsModal :show="groupsOpen" @close="groupsOpen = false" />
		<TotpModal :account-name="totpAccount" @close="totpAccount = ''" />
		<HistoryModal :account-name="historyAccount" @close="historyAccount = ''" />
		<ProxyModal :account-name="proxyAccount" @close="proxyAccount = ''" />
	</div>
</template>

<style scoped>
.module-body {
	display: flex;
	flex-direction: column;
}

.account-table {
	flex: 1;
	min-height: 240px;
}

.seq-input {
	width: 56px;
}

.guard-body {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.guard-input {
	width: 120px;
}

.import-hint {
	margin: 0 0 8px;
}

.import-error {
	margin-top: 8px;
}

.group-bar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.group-option {
	display: inline-block;
	max-width: 10em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	vertical-align: bottom;
}

.group-option-count {
	margin-left: 6px;
	opacity: 0.6;
}

:deep(.group-button) {
	max-width: 100%;
}

:deep(.group-button .n-button__content) {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

:deep(.status-row td) {
	background: #12161c;
	font-weight: 600;
}

:deep(.status-title) {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}
</style>
