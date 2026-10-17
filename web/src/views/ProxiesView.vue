<script setup lang="ts">
// 代理管理(照 SteamLabs 的代理模块):面包屑 + 大标题 + 右上角操作按钮,「代理」「代理组」「代理用量」三个标签页;
// 代理可进新建 / 编辑页,代理组可进编辑页。列表在 proxies/ProxiesTab.vue,编辑页 proxies/ProxyEditor.vue,
// 代理组 proxies/GroupsTab.vue,用量 proxies/UsageTab.vue;这里管导入、新建 / 删除代理组、删除代理、测试全部。
import {computed, onMounted, reactive, ref, watch} from 'vue';
import {NAlert, NButton, NCard, NInput, NModal, NSpace, NTab, NTabs, useDialog, useMessage} from 'naive-ui';
import {errorText} from '../api/http.ts';
import AppIcon from '../components/AppIcon.vue';
import {GROUP_COLOR_OPTIONS, GROUP_NAME_MAX} from '../lib/proxy.ts';
import {loadAccounts, accounts} from '../stores/accounts.ts';
import {createGroup, deleteGroup, deleteProxies, loadProxies, proxy, testProxies} from '../stores/proxy.ts';
import GroupsTab from './proxies/GroupsTab.vue';
import ImportModal from './proxies/ImportModal.vue';
import ProxiesTab from './proxies/ProxiesTab.vue';
import ProxyEditor from './proxies/ProxyEditor.vue';
import UsageTab from './proxies/UsageTab.vue';

type Tab = 'proxies' | 'groups' | 'usage';

const message = useMessage();
const dialog = useDialog();

onMounted(() => {
	void loadProxies();
	// 「账户」数、账户分组关联的代理组要用账户名单
	if (!accounts.loaded) {
		void loadAccounts();
	}
});

// ===== 标签页 / 编辑页 =====
const tab = ref<Tab>('proxies');
/** 正在编辑的代理:'new' 是新建 */
const editingProxyId = ref('');
const editingGroupId = ref('');
const editingProxy = computed(() => proxy.data.proxies.find(item => item.id === editingProxyId.value));
const editingGroup = computed(() => proxy.data.groups.find(group => group.id === editingGroupId.value));

// 正在编辑的被删掉了(别的浏览器删的也算)就回列表
watch([editingProxy, editingGroup], ([currentProxy, currentGroup]) => {
	if (editingProxyId.value && editingProxyId.value !== 'new' && !currentProxy && proxy.loaded) {
		editingProxyId.value = '';
	}
	if (editingGroupId.value && !currentGroup && proxy.loaded) {
		editingGroupId.value = '';
	}
});

function openTab(value: Tab): void {
	tab.value = value;
	editingProxyId.value = '';
	editingGroupId.value = '';
}

function editProxy(id: string): void {
	tab.value = 'proxies';
	editingGroupId.value = '';
	editingProxyId.value = id;
}

const header = computed(() => {
	if (editingProxyId.value === 'new') {
		return {crumbs: ['代理', '创建'], title: '创建代理'};
	}
	if (editingProxy.value) {
		return {crumbs: ['代理', editingProxy.value.host, '编辑'], title: `编辑 ${editingProxy.value.host}`};
	}
	if (editingGroup.value) {
		return {crumbs: ['代理', '代理组', editingGroup.value.name, '编辑'], title: `编辑 ${editingGroup.value.name}`};
	}
	if (tab.value === 'groups') {
		return {crumbs: ['代理', '代理组', '列表'], title: '代理组'};
	}
	if (tab.value === 'usage') {
		return {crumbs: ['代理', '代理用量'], title: '代理用量'};
	}
	return {crumbs: ['代理', '列表'], title: '代理'};
});

const inEditor = computed(() => !!editingProxyId.value || !!editingGroup.value);

function onCrumb(index: number): void {
	if (index === 0) {
		openTab('proxies');
	} else if (index === 1 && editingGroup.value) {
		openTab('groups');
	}
}

// ===== 测试全部 / 删除代理 =====
const testing = ref(false);

async function testAll(): Promise<void> {
	testing.value = true;
	try {
		await testProxies();
		message.info(`开始检测 ${proxy.data.proxies.length} 个代理,测完自动更新`);
	} catch (err) {
		message.error(errorText(err));
	} finally {
		testing.value = false;
	}
}

/** 删代理前确认;绑定了它的账号去掉这个绑定 */
function confirmDeleteProxies(ids: string[], done?: () => void): void {
	const list = proxy.data.proxies.filter(item => ids.includes(item.id));
	if (!list.length) {
		return;
	}
	dialog.warning({
		title: '删除代理',
		content: list.length === 1
			? `删除代理 ${list[0]!.endpoint}?绑定了它的账号会去掉这个绑定(绑定空了就用代理池)。`
			: `删除选中的 ${list.length} 个代理?绑定了它们的账号会去掉这些绑定(绑定空了就用代理池)。`,
		positiveText: '删除',
		negativeText: '取消',
		onPositiveClick: async () => {
			try {
				await deleteProxies(list.map(item => item.id));
				if (ids.includes(editingProxyId.value)) {
					editingProxyId.value = '';
				}
				done?.();
			} catch (err) {
				message.error(errorText(err));
			}
		}
	});
}

// ===== 代理组 =====
/** 新建代理组;proxyIds 不空时建好把它们加进去(代理表的「加入代理组 → 新建」),空的建好进编辑页 */
const newGroup = reactive({open: false, name: '', color: 'amber', saving: false, error: '', proxyIds: [] as string[]});

function openNewGroup(proxyIds: string[] = []): void {
	const used = new Set(proxy.data.groups.map(group => group.color));
	const color = GROUP_COLOR_OPTIONS.find(option => !used.has(option.value))?.value ?? 'amber';
	Object.assign(newGroup, {open: true, name: '', color, saving: false, error: '', proxyIds: [...proxyIds]});
}

async function submitNewGroup(): Promise<void> {
	const name = newGroup.name.trim();
	if (!name) {
		newGroup.error = '请输入代理组名';
		return;
	}
	newGroup.saving = true;
	newGroup.error = '';
	try {
		const group = await createGroup(name, newGroup.color, newGroup.proxyIds);
		newGroup.open = false;
		if (!newGroup.proxyIds.length) {
			tab.value = 'groups';
			editingGroupId.value = group.id;
		}
	} catch (err) {
		newGroup.error = errorText(err);
	} finally {
		newGroup.saving = false;
	}
}

function confirmDeleteGroup(id: string): void {
	const group = proxy.data.groups.find(item => item.id === id);
	if (!group) {
		return;
	}
	const count = proxy.data.proxies.filter(item => item.groupIds.includes(id)).length;
	dialog.warning({
		title: '删除代理组',
		content: `删除代理组「${group.name}」?组里的 ${count} 个代理不删;只绑了这个组的账号会退回用代理池。`,
		positiveText: '删除',
		negativeText: '取消',
		onPositiveClick: async () => {
			try {
				await deleteGroup(id);
				if (editingGroupId.value === id) {
					editingGroupId.value = '';
				}
			} catch (err) {
				message.error(errorText(err));
			}
		}
	});
}

const importOpen = ref(false);
</script>

<template>
	<div class="module-page proxies-page">
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
				<template v-if="editingProxy">
					<NButton type="error" secondary @click="confirmDeleteProxies([editingProxy.id])">
						<template #icon><AppIcon name="trash" :size="16" /></template>删除
					</NButton>
				</template>
				<template v-else-if="editingGroup">
					<NButton type="error" secondary @click="confirmDeleteGroup(editingGroup.id)">
						<template #icon><AppIcon name="trash" :size="16" /></template>删除
					</NButton>
				</template>
				<template v-else-if="editingProxyId === 'new'" />
				<template v-else-if="tab === 'proxies'">
					<NButton :loading="testing" :disabled="!proxy.data.proxies.length" @click="testAll">
						<template #icon><AppIcon name="radio" :size="16" /></template>测试全部
					</NButton>
					<NButton @click="importOpen = true"><template #icon><AppIcon name="download" :size="16" /></template>导入</NButton>
					<NButton type="primary" @click="editProxy('new')"><template #icon><AppIcon name="plus" :size="16" /></template>创建代理</NButton>
				</template>
				<template v-else-if="tab === 'groups'">
					<NButton type="primary" @click="openNewGroup()"><template #icon><AppIcon name="plus" :size="16" /></template>创建代理组</NButton>
				</template>
			</NSpace>
		</header>

		<NTabs v-if="!inEditor" type="line" :value="tab" class="page-tabs" @update:value="openTab">
			<NTab name="proxies"><span class="tab-label"><AppIcon name="globe" :size="16" />代理</span></NTab>
			<NTab name="groups"><span class="tab-label"><AppIcon name="tag" :size="16" />代理组</span></NTab>
			<NTab name="usage"><span class="tab-label"><AppIcon name="chart" :size="16" />代理用量</span></NTab>
		</NTabs>

		<NAlert v-if="proxy.error" type="error" :bordered="false">读取代理失败:{{ proxy.error }}</NAlert>

		<ProxyEditor v-if="editingProxyId" :proxy-id="editingProxyId === 'new' ? '' : editingProxyId" @saved="(id: string) => (editingProxyId = id)" @back="editingProxyId = ''" />
		<GroupsTab v-else-if="tab === 'groups'" :editing-id="editingGroupId" @edit="(id: string) => (editingGroupId = id)" @delete="confirmDeleteGroup" @back="editingGroupId = ''" />
		<UsageTab v-else-if="tab === 'usage'" @edit-proxy="editProxy" />
		<ProxiesTab v-else @edit="editProxy" @delete="confirmDeleteProxies" @new-group="openNewGroup" @import="importOpen = true" />

		<ImportModal :show="importOpen" @close="importOpen = false" />

		<NModal v-model:show="newGroup.open" :mask-closable="!newGroup.saving">
			<NCard title="创建代理组" style="width: 420px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
				<p v-if="newGroup.proxyIds.length" class="muted modal-hint">建好后把选中的 {{ newGroup.proxyIds.length }} 个代理加进去</p>
				<label class="field-label">名称<span class="required">*</span></label>
				<NInput v-model:value="newGroup.name" placeholder="" :maxlength="GROUP_NAME_MAX" show-count autofocus @keyup.enter="submitNewGroup" />
				<label class="field-label color-label">颜色<span class="required">*</span></label>
				<div class="swatches" role="radiogroup" aria-label="颜色">
					<button
						v-for="option in GROUP_COLOR_OPTIONS"
						:key="option.value"
						type="button"
						role="radio"
						class="swatch"
						:class="{active: newGroup.color === option.value}"
						:aria-checked="newGroup.color === option.value"
						:aria-label="option.label"
						:style="{background: `var(--g-${option.value})`}"
						@click="newGroup.color = option.value"
					/>
				</div>
				<NAlert v-if="newGroup.error" type="error" :bordered="false" class="modal-error">{{ newGroup.error }}</NAlert>
				<template #footer>
					<NSpace justify="end">
						<NButton :disabled="newGroup.saving" @click="newGroup.open = false">取消</NButton>
						<NButton type="primary" :loading="newGroup.saving" @click="submitNewGroup">{{ newGroup.proxyIds.length ? '创建并加入' : '创建' }}</NButton>
					</NSpace>
				</template>
			</NCard>
		</NModal>
	</div>
</template>

<style scoped>
.proxies-page {
	gap: 16px;
	padding: 20px 28px 24px;
	overflow: auto;
}

.page-tabs {
	flex: none;
}

.tab-label {
	display: inline-flex;
	align-items: center;
	gap: 6px;
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
</style>
