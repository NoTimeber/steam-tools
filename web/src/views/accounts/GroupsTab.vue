<script setup lang="ts">
// 账户分组:列表(名称、账户数、排序、编辑 / 删除),点名称或编辑进分组的编辑页(改名;组内账户可添加、移出)。
// 新建和删除由外层(AccountsView)管,这里点删除只是通知它。
import {computed, h, ref, watch} from 'vue';
import {NButton, NDataTable, NInput, NTag, useMessage} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey} from 'naive-ui';
import type {AccountGroup} from '../../api/types.ts';
import AppIcon from '../../components/AppIcon.vue';
import {withTip} from '../../components/tip.ts';
import {SESSION_LABEL, STATUS_TAG, matchesSearch, moveGroupId} from '../../lib/accounts.ts';
import {errorText} from '../../api/http.ts';
import {accounts, moveToGroup, renameGroup, reorderGroups} from '../../stores/accounts.ts';
import type {AccountRow} from '../../stores/accounts.ts';
import AddAccountsModal from './AddAccountsModal.vue';

const props = defineProps<{editingId: string}>();
const emit = defineEmits<{edit: [id: string]; delete: [id: string]; back: []}>();
const message = useMessage();

const NAME_MAX = 20;

const counts = computed(() => {
	const map = new Map<string, number>();
	for (const row of accounts.rows) {
		map.set(row.groupId, (map.get(row.groupId) ?? 0) + 1);
	}
	return map;
});

// ===== 列表 =====
const listSearch = ref('');
const busy = ref(false);

const listRows = computed(() => {
	const q = listSearch.value.trim().toLowerCase();
	return accounts.groups.filter(group => !q || group.name.toLowerCase().includes(q));
});

async function move(id: string, delta: -1 | 1): Promise<void> {
	const ids = accounts.groups.map(group => group.id);
	const order = moveGroupId(ids, id, delta);
	if (order.join() === ids.join()) {
		return;
	}
	busy.value = true;
	try {
		await reorderGroups(order);
	} catch (err) {
		message.error(errorText(err));
	} finally {
		busy.value = false;
	}
}

/** 图标按钮,鼠标放上去有说明 */
function iconButton(icon: 'pencil' | 'trash' | 'arrowUp' | 'arrowDown' | 'x', tip: string, onClick: () => void, extra: Record<string, unknown> = {}) {
	return withTip(h(NButton, {size: 'small', text: true, type: 'primary', 'aria-label': tip, onClick, ...extra}, {icon: () => h(AppIcon, {name: icon, size: 17})}), tip);
}

const listColumns = computed<DataTableColumns<AccountGroup>>(() => [
	{
		title: '名称',
		key: 'name',
		ellipsis: {tooltip: true},
		render: group => h('a', {class: 'group-link', onClick: () => emit('edit', group.id)}, group.name)
	},
	{title: '账户', key: 'count', width: 100, render: group => String(counts.value.get(group.id) ?? 0)},
	{
		title: '顺序',
		key: 'order',
		width: 90,
		render: group => {
			const index = accounts.groups.findIndex(item => item.id === group.id);
			return h('div', {class: 'actions'}, [
				iconButton('arrowUp', '上移一位', () => move(group.id, -1), {disabled: busy.value || index <= 0 || !!listSearch.value}),
				iconButton('arrowDown', '下移一位', () => move(group.id, 1), {disabled: busy.value || index === accounts.groups.length - 1 || !!listSearch.value})
			]);
		}
	},
	{
		title: '',
		key: 'actions',
		width: 80,
		render: group => h('div', {class: 'actions actions-end'}, [
			iconButton('pencil', '编辑:改名、添加和移出账户', () => emit('edit', group.id)),
			iconButton('trash', '删除分组(组里的账户不删,变成未分组)', () => emit('delete', group.id), {type: 'error'})
		])
	}
]);

// ===== 编辑页 =====
const group = computed(() => accounts.groups.find(item => item.id === props.editingId));
const name = ref('');
const saving = ref(false);
const memberSearch = ref('');
const memberChecked = ref(new Set<string>());
const addTo = ref('');

watch(() => props.editingId, () => {
	name.value = group.value?.name ?? '';
	memberSearch.value = '';
	memberChecked.value = new Set();
}, {immediate: true});

async function saveName(): Promise<void> {
	const value = name.value.trim();
	if (!group.value || !value) {
		message.warning('请输入分组名');
		return;
	}
	if (value === group.value.name) {
		return;
	}
	saving.value = true;
	try {
		await renameGroup(group.value.id, value);
		message.success('已保存');
	} catch (err) {
		message.error(errorText(err));
	} finally {
		saving.value = false;
	}
}

const members = computed(() => accounts.rows.filter(row => row.groupId === props.editingId && matchesSearch(row, memberSearch.value)));
/** 勾选只算看得到的(移出了的、搜索筛掉的不算) */
const checkedMembers = computed(() => members.value.filter(row => memberChecked.value.has(row.key)));

function onMemberChecked(keys: DataTableRowKey[]): void {
	memberChecked.value = new Set(keys.map(String));
}

async function removeMembers(rows: AccountRow[]): Promise<void> {
	busy.value = true;
	try {
		await moveToGroup(rows, '');
	} finally {
		busy.value = false;
	}
}

const memberColumns = computed<DataTableColumns<AccountRow>>(() => [
	{type: 'selection'},
	{title: '用户名', key: 'accountName', ellipsis: {tooltip: true}, render: row => h('span', {class: 'account-name'}, row.accountName)},
	{title: '会话', key: 'status', width: 96, render: row => h(NTag, {size: 'small', bordered: false, type: STATUS_TAG[row.status]}, () => SESSION_LABEL[row.status])},
	{title: 'SteamID', key: 'steamID', width: 180, ellipsis: {tooltip: true}, render: row => h('span', {class: 'mono'}, row.steamID || '—')},
	{title: '', key: 'remove', width: 56, render: row => h('div', {class: 'actions actions-end'}, [iconButton('x', '移出这个分组', () => removeMembers([row]), {disabled: busy.value})])}
]);
</script>

<template>
	<template v-if="editingId && group">
		<section class="panel form-panel">
			<header class="panel-head">分组详情</header>
			<div class="panel-body">
				<label class="field-label" for="group-name">名称<span class="required">*</span></label>
				<NInput id="group-name" v-model:value="name" placeholder="" :maxlength="NAME_MAX" show-count @keyup.enter="saveName" />
			</div>
		</section>
		<div class="form-actions">
			<NButton type="primary" :loading="saving" :disabled="!name.trim() || name.trim() === group.name" @click="saveName">保存</NButton>
			<NButton @click="emit('back')">返回</NButton>
		</div>

		<section class="panel members-panel">
			<header class="panel-head panel-head-row">
				<span>账户 <span class="muted head-count">{{ counts.get(group.id) ?? 0 }}</span></span>
				<NButton type="primary" size="small" @click="addTo = group.id">
					<template #icon><AppIcon name="plus" :size="16" /></template>添加账户
				</NButton>
			</header>
			<div class="toolbar">
				<div class="toolbar-left">
					<template v-if="checkedMembers.length">
						<span class="selected-count">已选 {{ checkedMembers.length }} 个</span>
						<NButton size="small" type="error" secondary :disabled="busy" @click="removeMembers(checkedMembers)">移出分组</NButton>
					</template>
				</div>
				<NInput v-model:value="memberSearch" size="small" placeholder="请输入关键词" clearable class="search">
					<template #prefix><AppIcon name="search" :size="16" class="muted" /></template>
				</NInput>
			</div>
			<NDataTable
				size="small"
				:bordered="false"
				:single-line="true"
				:columns="memberColumns"
				:data="members"
				:row-key="(row: AccountRow) => row.key"
				:checked-row-keys="checkedMembers.map(row => row.key)"
				:max-height="420"
				virtual-scroll
				@update:checked-row-keys="onMemberChecked"
			>
				<template #empty>
					<span class="muted">{{ memberSearch ? '没有匹配的账户' : '这个分组还没有账户,点「添加账户」' }}</span>
				</template>
			</NDataTable>
		</section>
		<AddAccountsModal :group-id="addTo" @close="addTo = ''" />
	</template>

	<section v-else class="panel list-panel">
		<div class="toolbar">
			<span class="muted">共 {{ accounts.groups.length }} 个分组</span>
			<NInput v-model:value="listSearch" size="small" placeholder="请输入关键词" clearable class="search">
				<template #prefix><AppIcon name="search" :size="16" class="muted" /></template>
			</NInput>
		</div>
		<NDataTable size="small" :bordered="false" :single-line="true" :columns="listColumns" :data="listRows" :row-key="(row: AccountGroup) => row.id">
			<template #empty>
				<span class="muted">{{ listSearch ? '没有匹配的分组' : '还没有分组,点右上角「创建账户分组」' }}</span>
			</template>
		</NDataTable>
	</section>
</template>

<style scoped>
.list-panel,
.members-panel {
	overflow: hidden;
}

.form-panel {
	flex: none;
}

.panel-head {
	padding: 14px 20px;
	border-bottom: 1px solid var(--line);
	font-weight: 600;
}

.panel-head-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.head-count {
	margin-left: 4px;
	font-weight: 400;
}

.panel-body {
	padding: 16px 20px 20px;
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

.form-actions {
	display: flex;
	gap: 8px;
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

.toolbar-left {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 28px;
}

.selected-count {
	color: var(--accent-text);
	font-weight: 600;
	font-size: 13px;
}

.search {
	width: 240px;
}

:deep(.group-link) {
	color: var(--text);
	font-weight: 500;
	cursor: pointer;
}

:deep(.group-link:hover) {
	color: var(--accent-text);
}

:deep(.account-name) {
	font-weight: 500;
}

:deep(.actions) {
	display: flex;
	align-items: center;
	gap: 10px;
}

:deep(.actions-end) {
	justify-content: flex-end;
}
</style>
