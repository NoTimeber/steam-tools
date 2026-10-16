<script setup lang="ts">
// 账户管理:按「GC 已连接 / 在线 / 未在线」分组的账号表,导入、登录/登出/删除、按序号勾选、Steam Guard、令牌验证码、消费记录、Steam 代理、连接 GC。
import {computed, h, onMounted, reactive, ref} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NDropdown, NInput, NModal, NSpace, NTag, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey} from 'naive-ui';
import {errorText} from '../api/http.ts';
import type {GameId} from '../api/types.ts';
import {formatBalance, padSeq, resolveSeqRange} from '../lib/accounts.ts';
import type {LoginStatus} from '../lib/accounts.ts';
import {
	accounts, canUseGc, connectGc, connectedGame, deleteSelected, disconnectGc, forSelected, gameLabel, groupedAccounts,
	importAccountText, importMaFiles, loginAccount, logoutAccount, onlineCount, orderedAccounts, submitGuardCode
} from '../stores/accounts.ts';
import type {AccountGroupView, AccountRow} from '../stores/accounts.ts';
import {accountProxy} from '../lib/proxy.ts';
import {loadProxy, proxy} from '../stores/proxy.ts';
import HistoryModal from './accounts/HistoryModal.vue';
import ProxyModal from './accounts/ProxyModal.vue';
import TotpModal from './accounts/TotpModal.vue';

const message = useMessage();
const dialog = useDialog();

type TableRow =
	| {kind: 'group'; key: string; group: AccountGroupView; children: TableRow[]}
	| {kind: 'account'; key: string; row: AccountRow; seq: number};

const GROUP_PREFIX = 'group:';

// ===== 表格数据:分组是父行,账号是子行;序号按显示顺序连续编号(收起的分组也占号) =====
const tableData = computed<TableRow[]>(() => {
	let seq = 0;
	return groupedAccounts.value.filter(group => group.rows.length).map(group => ({
		kind: 'group' as const,
		key: GROUP_PREFIX + group.key,
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
		if (!key.startsWith(GROUP_PREFIX)) {
			accounts.selected.add(key);
		}
	}
}

const STATUS_TAG: Record<LoginStatus, 'success' | 'warning' | 'error' | 'default'> = {
	登录成功: 'success',
	登录中: 'warning',
	登录失败: 'error',
	未登录: 'default'
};

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

const DATA_COLUMNS = 10;

const columns: DataTableColumns<TableRow> = [
	{type: 'selection'},
	{
		title: '序号',
		key: 'seq',
		width: 90,
		// 分组行占满整行:标题 + 人数
		colSpan: item => (item.kind === 'group' ? DATA_COLUMNS : 1),
		render: item => item.kind === 'group'
			? h('span', {class: 'group-title'}, [
				item.group.title,
				h(NTag, {size: 'small', round: true, bordered: false, type: item.group.key === 'offline' ? 'default' : 'success', class: 'group-count'}, () => String(item.group.rows.length))
			])
			: h('span', {class: 'mono'}, padSeq(item.seq))
	},
	{title: '账号', key: 'accountName', width: 170, ellipsis: {tooltip: true}, render: item => (item.kind === 'account' ? item.row.accountName : null)},
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
	if (item.kind !== 'group') {
		return {};
	}
	return {
		style: 'cursor: pointer',
		// 点分组行(复选框、展开箭头除外)收起/展开
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
				<NButton :disabled="!accounts.selected.size" :loading="busy === 'delete'" @click="confirmDelete">删除选中</NButton>
			</NSpace>
		</header>

		<input ref="fileInput" type="file" accept=".maFile,.json,application/json" multiple hidden @change="onMaFiles">

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
				:row-class-name="(item: TableRow) => (item.kind === 'group' ? 'group-row' : '')"
				:row-props="rowProps"
				:indent="0"
				:scroll-x="1200"
				:loading="accounts.loading && !accounts.loaded"
				virtual-scroll
				@update:checked-row-keys="onCheckedChange"
				@update:expanded-row-keys="onExpandedChange"
			>
				<template #empty>
					<span class="muted">暂无账户,点「导入账户」或「导入 maFile」添加</span>
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

:deep(.group-row td) {
	background: #12161c;
	font-weight: 600;
}

:deep(.group-title) {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}
</style>
