<script setup lang="ts">
// 代理组:列表(名称、代理数、用到它的账户数、创建时间、编辑 / 删除),点名称或编辑进编辑页
// (改名、换颜色;组里的代理可添加、移出;列出用到这个组的账号)。新建和删除由外层(ProxiesView)管,这里点删除只是通知它。
// 一个代理可以在多个组里;删组不删代理。
import {computed, h, reactive, ref, watch} from 'vue';
import {NButton, NCard, NDataTable, NInput, NModal, NSpace, NTag, useMessage} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {ProxyGroup, PublicProxy} from '../../api/types.ts';
import AppIcon from '../../components/AppIcon.vue';
import GroupChip from '../../components/GroupChip.vue';
import {withTip} from '../../components/tip.ts';
import {GROUP_COLOR_OPTIONS, GROUP_NAME_MAX, STATUS_META, accountsUsingGroup, proxyLabel, timeAgo} from '../../lib/proxy.ts';
import {accounts} from '../../stores/accounts.ts';
import {bulkProxies, proxy, updateGroup} from '../../stores/proxy.ts';

const props = defineProps<{editingId: string}>();
const emit = defineEmits<{edit: [id: string]; delete: [id: string]; back: []}>();
const message = useMessage();

const memberCount = (groupId: string) => proxy.data.proxies.filter(item => item.groupIds.includes(groupId)).length;
const accountCount = (groupId: string) => accountsUsingGroup(proxy.data, groupId, accounts.rows);

function iconButton(icon: 'pencil' | 'trash' | 'x', tip: string, onClick: () => void, extra: Record<string, unknown> = {}) {
	return withTip(h(NButton, {size: 'small', text: true, type: 'primary', 'aria-label': tip, onClick, ...extra}, {icon: () => h(AppIcon, {name: icon, size: 17})}), tip);
}

// ===== 列表 =====
const listSearch = ref('');
const listRows = computed(() => {
	const q = listSearch.value.trim().toLowerCase();
	return proxy.data.groups.filter(group => !q || group.name.toLowerCase().includes(q));
});

const listColumns = computed<DataTableColumns<ProxyGroup>>(() => [
	{
		title: '名称',
		key: 'name',
		render: group => h('a', {class: 'group-link', onClick: () => emit('edit', group.id)}, [h(GroupChip, {name: group.name, color: group.color})])
	},
	{title: '代理', key: 'proxies', width: 100, render: group => String(memberCount(group.id))},
	{
		title: '账户',
		key: 'accounts',
		width: 100,
		render: group => withTip(h('span', String(accountCount(group.id))), '绑定了这个代理组的账号,加上所在账户分组关联了它的')
	},
	{title: '创建时间', key: 'createdAt', width: 120, render: group => timeAgo(group.createdAt)},
	{
		title: '',
		key: 'actions',
		width: 80,
		render: group => h('div', {class: 'actions actions-end'}, [
			iconButton('pencil', '编辑:改名、换颜色、添加和移出代理', () => emit('edit', group.id)),
			iconButton('trash', '删除代理组(组里的代理不删)', () => emit('delete', group.id), {type: 'error'})
		])
	}
]);

// ===== 编辑页 =====
const group = computed(() => proxy.data.groups.find(item => item.id === props.editingId));
const details = reactive({name: '', color: 'amber', saving: false});
const memberSearch = ref('');
const memberChecked = ref(new Set<string>());
const busy = ref(false);

watch(() => props.editingId, () => {
	Object.assign(details, {name: group.value?.name ?? '', color: group.value?.color ?? 'amber', saving: false});
	memberSearch.value = '';
	memberChecked.value = new Set();
}, {immediate: true});

const dirty = computed(() => !!group.value && (details.name.trim() !== group.value.name || details.color !== group.value.color));

async function saveDetails(): Promise<void> {
	if (!group.value || !details.name.trim()) {
		message.warning('请输入代理组名');
		return;
	}
	details.saving = true;
	try {
		await updateGroup(group.value.id, {name: details.name.trim(), color: details.color});
		message.success('已保存');
	} catch (err) {
		message.error(errorText(err));
	} finally {
		details.saving = false;
	}
}

const matches = (item: PublicProxy, q: string) => !q || [item.endpoint, item.username, item.notes, item.check?.ip ?? ''].join(' ').toLowerCase().includes(q.trim().toLowerCase());
const members = computed(() => proxy.data.proxies.filter(item => item.groupIds.includes(props.editingId) && matches(item, memberSearch.value)));
const checkedMembers = computed(() => members.value.filter(item => memberChecked.value.has(item.id)));

async function removeMembers(ids: string[]): Promise<void> {
	busy.value = true;
	try {
		await bulkProxies(ids, 'removeGroups', [props.editingId]);
		memberChecked.value = new Set();
	} catch (err) {
		message.error(errorText(err));
	} finally {
		busy.value = false;
	}
}

function statusTag(item: PublicProxy) {
	const meta = STATUS_META[item.status];
	return h(NTag, {size: 'small', bordered: false, round: true, type: meta.type}, () => meta.label);
}

const memberColumns = computed<DataTableColumns<PublicProxy>>(() => [
	{type: 'selection'},
	{title: '端点', key: 'endpoint', ellipsis: {tooltip: true}, render: item => h('span', {class: 'endpoint'}, proxyLabel(item))},
	{title: '类型', key: 'type', width: 80, render: item => (item.type === 'rotating' ? '轮换' : '静态')},
	{title: '状态', key: 'status', width: 120, render: statusTag},
	{title: '启用', key: 'enabled', width: 70, render: item => (item.enabled ? '是' : h('span', {class: 'muted'}, '否'))},
	{title: '', key: 'remove', width: 56, render: item => h('div', {class: 'actions actions-end'}, [iconButton('x', '移出这个代理组', () => removeMembers([item.id]), {disabled: busy.value})])}
]);

/** 用到这个组的账号:自己绑定的、所在账户分组关联的 */
const usedBy = computed(() => {
	const id = props.editingId;
	const direct: string[] = [];
	const viaGroup: string[] = [];
	for (const row of accounts.rows) {
		const binding = proxy.data.accounts[row.key];
		if (binding?.mode === 'direct') {
			continue;
		}
		if (binding?.mode === 'bind' && binding.groupIds.includes(id)) {
			direct.push(row.accountName);
		} else if (row.groupId && (proxy.data.accountGroups[row.groupId] ?? []).includes(id)) {
			viaGroup.push(row.accountName);
		}
	}
	const linkedGroups = accounts.groups.filter(item => (proxy.data.accountGroups[item.id] ?? []).includes(id)).map(item => item.name);
	return {direct, viaGroup, linkedGroups};
});

// ===== 添加代理 =====
const adding = reactive({open: false, search: '', checked: new Set<string>(), saving: false});
const candidates = computed(() => proxy.data.proxies.filter(item => !item.groupIds.includes(props.editingId) && matches(item, adding.search)));

function openAdd(): void {
	Object.assign(adding, {open: true, search: '', checked: new Set<string>(), saving: false});
}

async function submitAdd(): Promise<void> {
	const ids = candidates.value.filter(item => adding.checked.has(item.id)).map(item => item.id);
	if (!ids.length) {
		message.warning('先勾选要加进来的代理');
		return;
	}
	adding.saving = true;
	try {
		await bulkProxies(ids, 'addGroups', [props.editingId]);
		adding.open = false;
		message.success(`已添加 ${ids.length} 个代理`);
	} catch (err) {
		message.error(errorText(err));
	} finally {
		adding.saving = false;
	}
}

const candidateColumns: DataTableColumns<PublicProxy> = [
	{type: 'selection'},
	{title: '端点', key: 'endpoint', ellipsis: {tooltip: true}, render: item => h('span', {class: 'endpoint'}, proxyLabel(item))},
	{title: '状态', key: 'status', width: 120, render: statusTag},
	{
		title: '代理组',
		key: 'groups',
		width: 160,
		render: item => h('div', {class: 'chips-cell'}, item.groupIds.map(id => proxy.data.groups.find(other => other.id === id)).filter(other => !!other).map(other => h(GroupChip, {name: other.name, color: other.color})))
	}
];
</script>

<template>
	<template v-if="editingId && group">
		<section class="panel form-panel">
			<header class="panel-head">详情</header>
			<div class="panel-body">
				<label class="field-label" for="proxy-group-name">名称<span class="required">*</span></label>
				<NInput id="proxy-group-name" v-model:value="details.name" placeholder="" :maxlength="GROUP_NAME_MAX" show-count @keyup.enter="saveDetails" />
				<label class="field-label color-label">颜色<span class="required">*</span></label>
				<div class="swatches" role="radiogroup" aria-label="颜色">
					<button
						v-for="option in GROUP_COLOR_OPTIONS"
						:key="option.value"
						type="button"
						role="radio"
						class="swatch"
						:class="{active: details.color === option.value}"
						:aria-checked="details.color === option.value"
						:aria-label="option.label"
						:style="{background: `var(--g-${option.value})`}"
						@click="details.color = option.value"
					/>
				</div>
			</div>
		</section>
		<div class="form-actions">
			<NButton type="primary" :loading="details.saving" :disabled="!details.name.trim() || !dirty" @click="saveDetails">保存</NButton>
			<NButton @click="emit('back')">返回</NButton>
		</div>

		<section class="panel members-panel">
			<header class="panel-head panel-head-row">
				<span>代理 <span class="muted head-count">{{ memberCount(group.id) }}</span></span>
				<NButton type="primary" size="small" @click="openAdd"><template #icon><AppIcon name="plus" :size="16" /></template>添加代理</NButton>
			</header>
			<div class="toolbar">
				<div class="toolbar-left">
					<template v-if="checkedMembers.length">
						<span class="selected-count">已选 {{ checkedMembers.length }} 个</span>
						<NButton size="small" type="error" secondary :disabled="busy" @click="removeMembers(checkedMembers.map(item => item.id))">移出代理组</NButton>
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
				:row-key="(item: PublicProxy) => item.id"
				:checked-row-keys="checkedMembers.map(item => item.id)"
				:max-height="420"
				virtual-scroll
				@update:checked-row-keys="(keys: DataTableRowKey[]) => (memberChecked = new Set(keys.map(String)))"
			>
				<template #empty>
					<span class="muted">{{ memberSearch ? '没有匹配的代理' : '这个代理组还没有代理,点「添加代理」' }}</span>
				</template>
			</NDataTable>
		</section>

		<section class="panel">
			<header class="panel-head">用到这个组的账户</header>
			<div class="panel-body used-by">
				<p class="muted hint">在「账户管理」里给账号绑定代理组,或者在账户分组的编辑页关联代理组(组里每个账号都用,和账号自己的绑定合在一起)。</p>
				<div><span class="muted">账号自己绑定的:</span>{{ usedBy.direct.length ? usedBy.direct.join('、') : '没有' }}</div>
				<div>
					<span class="muted">经账户分组{{ usedBy.linkedGroups.length ? `(${usedBy.linkedGroups.join('、')})` : '' }}:</span>
					{{ usedBy.viaGroup.length ? usedBy.viaGroup.join('、') : '没有' }}
				</div>
			</div>
		</section>

		<NModal v-model:show="adding.open" :mask-closable="!adding.saving">
			<NCard :title="`添加代理到「${group.name}」`" style="width: 640px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
				<NInput v-model:value="adding.search" size="small" placeholder="请输入关键词" clearable class="add-search">
					<template #prefix><AppIcon name="search" :size="16" class="muted" /></template>
				</NInput>
				<NDataTable
					size="small"
					:bordered="false"
					:single-line="true"
					:columns="candidateColumns"
					:data="candidates"
					:row-key="(item: PublicProxy) => item.id"
					:checked-row-keys="[...adding.checked]"
					:max-height="360"
					virtual-scroll
					@update:checked-row-keys="(keys: DataTableRowKey[]) => (adding.checked = new Set(keys.map(String)))"
				>
					<template #empty><span class="muted">{{ adding.search ? '没有匹配的代理' : '代理都已经在这个组里了' }}</span></template>
				</NDataTable>
				<template #footer>
					<NSpace justify="end">
						<NButton :disabled="adding.saving" @click="adding.open = false">取消</NButton>
						<NButton type="primary" :loading="adding.saving" :disabled="!adding.checked.size" @click="submitAdd">添加 {{ adding.checked.size || '' }} 个</NButton>
					</NSpace>
				</template>
			</NCard>
		</NModal>
	</template>

	<section v-else class="panel list-panel">
		<div class="toolbar">
			<span class="muted">共 {{ proxy.data.groups.length }} 个代理组</span>
			<NInput v-model:value="listSearch" size="small" placeholder="请输入关键词" clearable class="search">
				<template #prefix><AppIcon name="search" :size="16" class="muted" /></template>
			</NInput>
		</div>
		<NDataTable size="small" :bordered="false" :single-line="true" :columns="listColumns" :data="listRows" :row-key="(row: ProxyGroup) => row.id">
			<template #empty>
				<span class="muted">{{ listSearch ? '没有匹配的代理组' : '还没有代理组,点右上角「创建代理组」' }}</span>
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

.color-label {
	margin-top: 14px;
}

.required {
	margin-left: 2px;
	color: var(--danger);
}

.swatches {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.swatch {
	width: 26px;
	height: 26px;
	padding: 0;
	border: 2px solid var(--surface);
	border-radius: 50%;
	box-shadow: 0 0 0 1px var(--line);
	cursor: pointer;
}

.swatch.active {
	box-shadow: 0 0 0 2px var(--text);
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

.used-by {
	display: flex;
	flex-direction: column;
	gap: 8px;
	font-size: 13px;
	overflow-wrap: anywhere;
}

.hint {
	margin: 0 0 4px;
}

.add-search {
	margin-bottom: 10px;
}

:deep(.group-link) {
	cursor: pointer;
}

:deep(.group-link:hover .group-chip) {
	color: var(--accent-text);
}

:deep(.endpoint) {
	font-weight: 500;
}

:deep(.chips-cell) {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
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
