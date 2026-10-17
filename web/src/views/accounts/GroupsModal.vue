<script setup lang="ts">
// 管理分组:新建、改名、上移下移、删除(组里的账号变成未分组);点分组名看组内账户,可以移出、添加(添加在 AddAccountsModal)。
import {computed, h, nextTick, reactive, ref} from 'vue';
import {NButton, NCard, NDataTable, NEmpty, NInput, NModal, NSpace, NTag, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {STATUS_TAG, matchesSearch, moveGroupId} from '../../lib/accounts.ts';
import {accounts, createGroup, deleteGroup, moveToGroup, renameGroup, reorderGroups} from '../../stores/accounts.ts';
import type {AccountRow} from '../../stores/accounts.ts';
import AddAccountsModal from './AddAccountsModal.vue';

defineProps<{show: boolean}>();
const emit = defineEmits<{close: []}>();
const message = useMessage();
const dialog = useDialog();

const NAME_MAX = 20;

const counts = computed(() => {
	const map = new Map<string, number>();
	for (const row of accounts.rows) {
		map.set(row.groupId, (map.get(row.groupId) ?? 0) + 1);
	}
	return map;
});

const busy = ref(false);

async function run(action: () => Promise<unknown>): Promise<boolean> {
	busy.value = true;
	try {
		await action();
		return true;
	} catch (err) {
		message.error(errorText(err));
		return false;
	} finally {
		busy.value = false;
	}
}

// ===== 新建 =====
const newName = ref('');

async function add(): Promise<void> {
	const name = newName.value.trim();
	if (!name) {
		message.warning('请输入分组名');
		return;
	}
	if (await run(() => createGroup(name))) {
		newName.value = '';
	}
}

// ===== 改名(一次改一个) =====
const editing = reactive({id: '', name: ''});
/** 改名输入框(v-for 里的 ref 是数组;同时只有一个) */
const editInputs = ref<Array<InstanceType<typeof NInput>>>([]);

async function startEdit(id: string, name: string): Promise<void> {
	Object.assign(editing, {id, name});
	await nextTick();
	editInputs.value[0]?.select();
}

/** 回车和失焦都会调;正在保存时不重复发 */
async function saveEdit(): Promise<void> {
	const {id, name} = editing;
	if (!id || busy.value) {
		return;
	}
	const current = accounts.groups.find(group => group.id === id)?.name;
	if (!name.trim() || name.trim() === current) {
		editing.id = '';
		return;
	}
	if (await run(() => renameGroup(id, name.trim()))) {
		editing.id = '';
	}
}

// ===== 排序 / 删除 =====
function move(id: string, delta: -1 | 1): void {
	const ids = accounts.groups.map(group => group.id);
	const order = moveGroupId(ids, id, delta);
	if (order.join() !== ids.join()) {
		run(() => reorderGroups(order));
	}
}

// ===== 组内账户 =====
/** 正在看哪个分组的账户;'' 为分组列表 */
const openId = ref('');
const openGroup = computed(() => accounts.groups.find(group => group.id === openId.value));
const memberSearch = ref('');
const memberChecked = ref(new Set<string>());
const addTo = ref('');

function openMembers(id: string): void {
	editing.id = '';
	openId.value = id;
	memberSearch.value = '';
	memberChecked.value = new Set();
}

const members = computed(() => accounts.rows.filter(row => row.groupId === openId.value && matchesSearch(row, memberSearch.value)));
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

const memberColumns: DataTableColumns<AccountRow> = [
	{type: 'selection'},
	{title: '账号', key: 'accountName', ellipsis: {tooltip: true}},
	{title: '状态', key: 'status', width: 90, render: row => h(NTag, {size: 'small', bordered: false, type: STATUS_TAG[row.status]}, () => row.status)},
	{title: 'SteamID', key: 'steamID', width: 160, ellipsis: {tooltip: true}, render: row => h('span', {class: 'mono'}, row.steamID || '-')},
	{
		title: '',
		key: 'remove',
		width: 60,
		render: row => h(NButton, {size: 'tiny', quaternary: true, type: 'error', disabled: busy.value, onClick: () => removeMembers([row])}, () => '移出')
	}
];

function confirmDelete(id: string, name: string): void {
	const count = counts.value.get(id) ?? 0;
	dialog.warning({
		title: '删除分组',
		content: count ? `删除分组「${name}」?组里的 ${count} 个账户会变成未分组,账户本身不删。` : `删除分组「${name}」?`,
		positiveText: '删除',
		negativeText: '取消',
		onPositiveClick: () => run(() => deleteGroup(id))
	});
}
</script>

<template>
	<NModal :show="show" @update:show="(value: boolean) => !value && emit('close')" @after-leave="editing.id = ''; openId = ''">
		<NCard
			:title="openGroup ? `分组「${openGroup.name}」` : '管理分组'"
			:style="{width: openGroup ? '620px' : '460px', maxWidth: 'calc(100vw - 32px)'}"
			:bordered="false"
			role="dialog"
			aria-modal="true"
		>
			<template v-if="openGroup">
				<NSpace :size="6" :wrap="false" class="members-bar">
					<NButton size="small" @click="openId = ''">← 返回</NButton>
					<NInput v-model:value="memberSearch" size="small" placeholder="搜索账号名或 SteamID" clearable />
					<NButton size="small" type="primary" @click="addTo = openGroup.id">添加账户</NButton>
				</NSpace>
				<NDataTable
					size="small"
					:columns="memberColumns"
					:data="members"
					:row-key="(row: AccountRow) => row.key"
					:checked-row-keys="checkedMembers.map(row => row.key)"
					:max-height="320"
					virtual-scroll
					@update:checked-row-keys="onMemberChecked"
				>
					<template #empty>
						<span class="muted">{{ memberSearch ? '没有匹配的账户' : '这个分组还没有账户,点「添加账户」' }}</span>
					</template>
				</NDataTable>
			</template>
			<template v-else>
				<div class="group-list">
					<NEmpty v-if="!accounts.groups.length" size="small" description="还没有分组" class="empty" />
					<div v-for="(group, index) in accounts.groups" :key="group.id" class="group-item">
						<NInput
							v-if="editing.id === group.id"
							ref="editInputs"
							v-model:value="editing.name"
							size="small"
							:maxlength="NAME_MAX"
							class="group-name"
							@keyup.enter="saveEdit"
							@keyup.esc="editing.id = ''"
							@blur="saveEdit"
						/>
						<span v-else class="group-name group-link" title="查看组内账户" @click="openMembers(group.id)">
							{{ group.name }}<span class="muted group-count">{{ counts.get(group.id) ?? 0 }} 个</span>
						</span>
						<NSpace :size="2" :wrap="false">
							<NButton size="tiny" quaternary :disabled="busy || index === 0" title="上移" @click="move(group.id, -1)">↑</NButton>
							<NButton size="tiny" quaternary :disabled="busy || index === accounts.groups.length - 1" title="下移" @click="move(group.id, 1)">↓</NButton>
							<NButton size="tiny" quaternary :disabled="busy" @click="startEdit(group.id, group.name)">改名</NButton>
							<NButton size="tiny" quaternary type="error" :disabled="busy" @click="confirmDelete(group.id, group.name)">删除</NButton>
						</NSpace>
					</div>
				</div>
				<NSpace :size="6" :wrap="false" class="add-row">
					<NInput v-model:value="newName" size="small" placeholder="新分组名" :maxlength="NAME_MAX" clearable @keyup.enter="add" />
					<NButton size="small" type="primary" :loading="busy" @click="add">新建</NButton>
				</NSpace>
			</template>
			<template #footer>
				<div class="footer">
					<NSpace v-if="openGroup" :size="8" align="center">
						<span class="muted">共 {{ counts.get(openGroup.id) ?? 0 }} 个账户</span>
						<NButton size="small" :disabled="busy || !checkedMembers.length" @click="removeMembers(checkedMembers)">
							移出选中{{ checkedMembers.length ? ` ${checkedMembers.length} 个` : '' }}
						</NButton>
					</NSpace>
					<span v-else />
					<NButton @click="emit('close')">关闭</NButton>
				</div>
			</template>
		</NCard>
	</NModal>
	<AddAccountsModal :group-id="addTo" @close="addTo = ''" />
</template>

<style scoped>
.group-list {
	display: flex;
	flex-direction: column;
	max-height: 360px;
	overflow-y: auto;
	margin-bottom: 12px;
}

.empty {
	padding: 16px 0;
}

.group-item {
	display: flex;
	align-items: center;
	gap: 10px;
	min-height: 36px;
	padding: 2px 4px;
	border-bottom: 1px solid var(--line-soft);
}

.group-name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.group-link {
	cursor: pointer;
}

.group-link:hover {
	color: var(--accent);
}

.group-count {
	margin-left: 10px;
	font-size: 12px;
}

.members-bar {
	margin-bottom: 10px;
}

.members-bar > :nth-child(2) {
	flex: 1;
}

.footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.add-row > :first-child {
	flex: 1;
}
</style>
