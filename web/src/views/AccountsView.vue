<script setup lang="ts">
// 账户管理:面包屑 + 大标题 + 右上角操作按钮,下面「账户」「账户分组」两个标签页(账户分组可进单个分组的编辑页,
// 点账户名进账户详情页)。账户列表在 accounts/AccountsTab.vue,分组在 accounts/GroupsTab.vue,详情在 accounts/AccountDetail.vue;
// 这里管导入、导出、新建 / 删除分组、Steam Guard 验证码,以及详情页右上角的登录 / 登出、消费记录、代理。
import {computed, reactive, ref, watch} from 'vue';
import {NAlert, NButton, NCard, NInput, NModal, NSpace, NTab, NTabs, useDialog, useMessage} from 'naive-ui';
import {errorText} from '../api/http.ts';
import AppIcon from '../components/AppIcon.vue';
import {accountsCsv} from '../lib/accounts.ts';
import {downloadCsv} from '../lib/csv.ts';
import {
	accounts, createGroup, deleteGroup, groupName, importAccountText, importMaFiles, loginAccount, logoutAccount, submitGuardCode, visibleRows
} from '../stores/accounts.ts';
import type {AccountRow} from '../stores/accounts.ts';
import {refreshAuthCodes} from '../stores/authcodes.ts';
import AccountDetail from './accounts/AccountDetail.vue';
import AccountsTab from './accounts/AccountsTab.vue';
import GroupsTab from './accounts/GroupsTab.vue';
import HistoryModal from './accounts/HistoryModal.vue';
import ProxyModal from './accounts/ProxyModal.vue';

const message = useMessage();
const dialog = useDialog();

// ===== 标签页 / 分组编辑页 =====
const tab = ref<'accounts' | 'groups'>('accounts');
const editingId = ref('');
const editingGroup = computed(() => accounts.groups.find(group => group.id === editingId.value));

// 正在编辑的分组被删掉(别的浏览器删的也算)就回列表
watch(editingGroup, group => {
	if (editingId.value && !group) {
		editingId.value = '';
	}
});

function openTab(value: 'accounts' | 'groups'): void {
	tab.value = value;
	editingId.value = '';
	detailName.value = '';
}

// ===== 账户详情 =====
/** 正在看详情的账号;空是列表 */
const detailName = ref('');
const detailRow = computed(() => accounts.rows.find(row => row.accountName.toLowerCase() === detailName.value.toLowerCase()));
const historyAccount = ref('');
const proxyAccounts = ref<string[]>([]);
const detailOnline = computed(() => detailRow.value?.status === '登录成功' || detailRow.value?.status === '登录中');

// 看着的账号被删掉了就回列表
watch(detailRow, row => {
	if (detailName.value && !row && accounts.loaded) {
		detailName.value = '';
	}
});

function openDetail(accountName: string): void {
	tab.value = 'accounts';
	detailName.value = accountName;
}

function toggleDetailLogin(): void {
	const row = detailRow.value;
	if (row) {
		void (detailOnline.value ? logoutAccount(row) : loginAccount(row));
	}
}

const header = computed(() => {
	if (detailName.value) {
		return {crumbs: ['账户', detailRow.value?.accountName ?? detailName.value], title: detailRow.value?.accountName ?? detailName.value};
	}
	if (editingGroup.value) {
		return {crumbs: ['账户', '账户分组', editingGroup.value.name, '编辑'], title: `编辑 ${editingGroup.value.name}`};
	}
	return tab.value === 'groups' ? {crumbs: ['账户', '账户分组', '列表'], title: '账户分组'} : {crumbs: ['账户', '列表'], title: '账户'};
});

function onCrumb(index: number): void {
	if (index === 0) {
		openTab('accounts');
	} else if (index === 1 && header.value.crumbs.length > 2) {
		openTab('groups');
	}
}

// ===== 新建 / 删除分组 =====
/** 新建分组;rows 不空时建好把它们移进去(账户页的「新建分组…」),空的建好进编辑页 */
const newGroup = reactive({open: false, name: '', saving: false, error: '', rows: [] as AccountRow[]});

function openNewGroup(rows: AccountRow[] = []): void {
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
		const group = await createGroup(name, newGroup.rows);
		newGroup.open = false;
		if (!newGroup.rows.length) {
			tab.value = 'groups';
			editingId.value = group.id;
		}
	} catch (err) {
		newGroup.error = errorText(err);
	} finally {
		newGroup.saving = false;
	}
}

function confirmDeleteGroup(id: string): void {
	const name = groupName(id);
	const count = accounts.rows.filter(row => row.groupId === id).length;
	dialog.warning({
		title: '删除分组',
		content: count ? `删除分组「${name}」?组里的 ${count} 个账户会变成未分组,账户本身不删。` : `删除分组「${name}」?`,
		positiveText: '删除',
		negativeText: '取消',
		onPositiveClick: async () => {
			try {
				await deleteGroup(id);
				if (editingId.value === id) {
					editingId.value = '';
				}
			} catch (err) {
				message.error(errorText(err));
			}
		}
	});
}

// ===== 导入 / 导出 =====
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
		// 新导入的令牌马上显示验证码
		refreshAuthCodes();
	}
}

/** 导出表格里现在显示的账户(按当前筛选和排序) */
function exportCsv(): void {
	const rows = visibleRows.value;
	if (!rows.length) {
		message.warning('没有可导出的账户');
		return;
	}
	const date = new Date().toLocaleDateString('sv-SE');
	downloadCsv(`账户-${date}.csv`, accountsCsv(rows, groupName));
	message.success(`已导出 ${rows.length} 个账户`);
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
	<div class="module-page accounts-page">
		<header class="page-header">
			<div>
				<nav class="breadcrumb">
					<template v-for="(crumb, index) in header.crumbs" :key="index">
						<AppIcon v-if="index" name="chevronRight" :size="14" />
						<a v-if="index < 2 && index < header.crumbs.length - 1" @click="onCrumb(index)">{{ crumb }}</a>
						<span v-else>{{ crumb }}</span>
					</template>
				</nav>
				<h1 class="page-title">{{ header.title }}</h1>
			</div>
			<NSpace :size="8">
				<template v-if="detailName">
					<NButton :type="detailOnline ? 'default' : 'primary'" :disabled="!detailRow" @click="toggleDetailLogin">
						<template #icon><AppIcon :name="detailOnline ? 'logout' : 'login'" :size="16" /></template>{{ detailOnline ? '登出' : '登录' }}
					</NButton>
					<NButton @click="historyAccount = detailName"><template #icon><AppIcon name="receipt" :size="16" /></template>消费记录</NButton>
					<NButton @click="proxyAccounts = [detailName]"><template #icon><AppIcon name="globe" :size="16" /></template>代理</NButton>
				</template>
				<template v-else-if="editingGroup">
					<NButton type="error" secondary @click="confirmDeleteGroup(editingGroup.id)">
						<template #icon><AppIcon name="trash" :size="16" /></template>删除
					</NButton>
				</template>
				<template v-else-if="tab === 'groups'">
					<NButton type="primary" @click="openNewGroup()">
						<template #icon><AppIcon name="plus" :size="16" /></template>创建账户分组
					</NButton>
				</template>
				<template v-else>
					<NButton @click="exportCsv"><template #icon><AppIcon name="download" :size="16" /></template>导出 CSV</NButton>
					<NButton @click="fileInput?.click()"><template #icon><AppIcon name="key" :size="16" /></template>导入 maFile</NButton>
					<NButton type="primary" @click="importModal.open = true"><template #icon><AppIcon name="upload" :size="16" /></template>导入账户</NButton>
				</template>
			</NSpace>
		</header>

		<NTabs v-if="!editingGroup && !detailName" type="line" :value="tab" class="page-tabs" @update:value="openTab">
			<NTab name="accounts"><span class="tab-label"><AppIcon name="users" :size="16" />账户</span></NTab>
			<NTab name="groups"><span class="tab-label"><AppIcon name="folder" :size="16" />账户分组</span></NTab>
		</NTabs>

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

		<AccountDetail v-if="detailName" :account-name="detailName" />
		<AccountsTab v-else-if="tab === 'accounts' && !editingGroup" @new-group="openNewGroup" @open="openDetail" />
		<GroupsTab v-else :editing-id="editingId" @edit="(id: string) => (editingId = id)" @delete="confirmDeleteGroup" @back="editingId = ''" />

		<NModal v-model:show="importModal.open" :mask-closable="!importModal.saving">
			<NCard title="导入账户" style="width: 520px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
				<p class="muted modal-hint">账号----密码,一行一个。已有的账号会更新密码,其它账号不受影响。</p>
				<NInput v-model:value="importModal.text" type="textarea" :rows="12" placeholder="account1----password1&#10;account2----password2" :input-props="{spellcheck: false}" />
				<NAlert v-if="importModal.error" type="error" :bordered="false" class="modal-error">{{ importModal.error }}</NAlert>
				<template #footer>
					<NSpace justify="end">
						<NButton :disabled="importModal.saving" @click="importModal.open = false">取消</NButton>
						<NButton type="primary" :loading="importModal.saving" @click="submitImport">导入</NButton>
					</NSpace>
				</template>
			</NCard>
		</NModal>

		<NModal v-model:show="newGroup.open" :mask-closable="!newGroup.saving">
			<NCard title="创建账户分组" style="width: 420px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
				<p v-if="newGroup.rows.length" class="muted modal-hint">
					{{ newGroup.rows.length === 1 ? `建好后把 ${newGroup.rows[0]!.accountName} 移进去` : `建好后把选中的 ${newGroup.rows.length} 个账户移进去` }}
				</p>
				<label class="field-label">名称<span class="required">*</span></label>
				<NInput v-model:value="newGroup.name" placeholder="" :maxlength="20" show-count autofocus @keyup.enter="submitNewGroup" />
				<NAlert v-if="newGroup.error" type="error" :bordered="false" class="modal-error">{{ newGroup.error }}</NAlert>
				<template #footer>
					<NSpace justify="end">
						<NButton :disabled="newGroup.saving" @click="newGroup.open = false">取消</NButton>
						<NButton type="primary" :loading="newGroup.saving" @click="submitNewGroup">{{ newGroup.rows.length ? '创建并移入' : '创建' }}</NButton>
					</NSpace>
				</template>
			</NCard>
		</NModal>
		<HistoryModal :account-name="historyAccount" @close="historyAccount = ''" />
		<ProxyModal :account-names="proxyAccounts" @close="proxyAccounts = []" />
	</div>
</template>

<style scoped>
.accounts-page {
	gap: 16px;
	padding: 20px 28px 24px;
}

.page-tabs {
	flex: none;
}

.tab-label {
	display: inline-flex;
	align-items: center;
	gap: 6px;
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

.modal-hint {
	margin: 0 0 10px;
}

.modal-error {
	margin-top: 8px;
}

.field-label {
	display: block;
	margin-bottom: 6px;
	font-size: 13px;
	font-weight: 500;
}

.required {
	margin-left: 2px;
	color: var(--danger);
}
</style>
