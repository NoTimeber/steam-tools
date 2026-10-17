<script setup lang="ts">
// 往分组里添加账户:按分组和关键词筛、勾选(表头勾选框选上筛出来的全部),或者粘贴账号名列表一次选上。
// 已经在别的分组的账号加进来就是从原分组移过来(一个账号只在一个分组)。
import {computed, h, reactive, ref, watch} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NInput, NModal, NRadioButton, NRadioGroup, NSpace, NTag} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey} from 'naive-ui';
import {ALL_ACCOUNTS, NO_GROUP, STATUS_TAG, matchNameList, matchesGroupFilter, matchesSearch} from '../../lib/accounts.ts';
import {accounts, groupName, moveToGroup} from '../../stores/accounts.ts';
import type {AccountRow} from '../../stores/accounts.ts';

/** 要往哪个分组加;'' 为关着 */
const props = defineProps<{groupId: string}>();
const emit = defineEmits<{close: []}>();

const filter = ref(NO_GROUP);
const search = ref('');
const checked = ref(new Set<string>());
const paste = reactive({open: false, text: '', result: '', warn: false});
const saving = ref(false);

watch(() => props.groupId, id => {
	if (id) {
		filter.value = NO_GROUP;
		search.value = '';
		checked.value = new Set();
		Object.assign(paste, {open: false, text: '', result: '', warn: false});
	}
});

/** 能加的账号:不在这个分组里的 */
const candidates = computed(() => accounts.rows.filter(row => row.groupId !== props.groupId));

/** 筛选项:全部、未分组、其它分组(带人数) */
const filterOptions = computed(() => {
	const count = (filterValue: string) => candidates.value.filter(row => matchesGroupFilter(row, filterValue)).length;
	return [
		{value: ALL_ACCOUNTS, label: '全部', count: candidates.value.length},
		{value: NO_GROUP, label: '未分组', count: count(NO_GROUP)},
		...accounts.groups.filter(group => group.id !== props.groupId).map(group => ({value: group.id, label: group.name, count: count(group.id)}))
	];
});

const visible = computed(() => candidates.value.filter(row => matchesGroupFilter(row, filter.value) && matchesSearch(row, search.value)));

/** 只算还能加的(勾选后账号可能被别处移进了这个分组) */
const picked = computed(() => candidates.value.filter(row => checked.value.has(row.key)));
const fromOtherGroups = computed(() => picked.value.filter(row => row.groupId).length);

/** 表格只管看得到的行;筛掉的行原来勾着的保留 */
function onChecked(keys: DataTableRowKey[]): void {
	const shown = new Set(visible.value.map(row => row.key));
	checked.value = new Set([...[...checked.value].filter(key => !shown.has(key)), ...keys.map(String)]);
}

const checkedKeys = computed(() => visible.value.filter(row => checked.value.has(row.key)).map(row => row.key));

const columns: DataTableColumns<AccountRow> = [
	{type: 'selection'},
	{title: '账号', key: 'accountName', ellipsis: {tooltip: true}},
	{
		title: '当前分组',
		key: 'group',
		width: 120,
		ellipsis: {tooltip: true},
		render: row => (row.groupId ? groupName(row.groupId) : h('span', {class: 'muted'}, '未分组'))
	},
	{title: '状态', key: 'status', width: 90, render: row => h(NTag, {size: 'small', bordered: false, type: STATUS_TAG[row.status]}, () => row.status)},
	{title: 'SteamID', key: 'steamID', width: 160, ellipsis: {tooltip: true}, render: row => h('span', {class: 'mono'}, row.steamID || '-')}
];

/** 粘贴的列表对上的账号勾上;对上的有看不到的就切到「全部」、清掉搜索 */
function applyPaste(): void {
	const {matched, missing} = matchNameList(paste.text, accounts.rows);
	if (!matched.length && !missing.length) {
		Object.assign(paste, {result: '请粘贴账号名或 SteamID', warn: true});
		return;
	}
	const already = matched.filter(row => row.groupId === props.groupId);
	const toPick = matched.filter(row => row.groupId !== props.groupId);
	checked.value = new Set([...checked.value, ...toPick.map(row => row.key)]);
	const shown = new Set(visible.value.map(row => row.key));
	if (toPick.some(row => !shown.has(row.key))) {
		filter.value = ALL_ACCOUNTS;
		search.value = '';
	}
	const parts = [`选上 ${toPick.length} 个`];
	if (already.length) {
		parts.push(`${already.length} 个已经在这个分组里`);
	}
	if (missing.length) {
		parts.push(`没找到 ${missing.length} 个:${missing.slice(0, 10).join('、')}${missing.length > 10 ? ' 等' : ''}`);
	}
	Object.assign(paste, {result: parts.join(','), warn: missing.length > 0, text: missing.length ? paste.text : ''});
}

async function submit(): Promise<void> {
	saving.value = true;
	try {
		if (await moveToGroup(picked.value, props.groupId)) {
			emit('close');
		}
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<NModal :show="!!groupId" :mask-closable="!saving" @update:show="(value: boolean) => !value && emit('close')">
		<NCard :title="`添加账户到「${groupName(groupId)}」`" style="width: 680px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
			<div class="toolbar">
				<NRadioGroup v-model:value="filter" size="small">
					<NRadioButton v-for="option in filterOptions" :key="option.value" :value="option.value" :title="option.label">
						<span class="option-label">{{ option.label }}</span><span class="option-count">{{ option.count }}</span>
					</NRadioButton>
				</NRadioGroup>
				<NSpace :size="6" :wrap="false" class="search-row">
					<NInput v-model:value="search" size="small" placeholder="搜索账号名或 SteamID" clearable />
					<NButton size="small" :type="paste.open ? 'primary' : 'default'" secondary @click="paste.open = !paste.open">粘贴列表</NButton>
				</NSpace>
			</div>

			<div v-if="paste.open" class="paste">
				<NInput
					v-model:value="paste.text"
					type="textarea"
					:rows="4"
					placeholder="粘贴账号名或 SteamID,用空格、逗号或换行分隔"
					:input-props="{spellcheck: false}"
				/>
				<NSpace :size="8" align="center" class="paste-actions">
					<NButton size="small" type="primary" @click="applyPaste">选上匹配的</NButton>
					<span v-if="paste.result" :class="paste.warn ? 'paste-warn' : 'muted'">{{ paste.result }}</span>
				</NSpace>
			</div>

			<NDataTable
				size="small"
				:columns="columns"
				:data="visible"
				:row-key="(row: AccountRow) => row.key"
				:checked-row-keys="checkedKeys"
				:max-height="300"
				virtual-scroll
				@update:checked-row-keys="onChecked"
			>
				<template #empty>
					<span class="muted">没有可以添加的账户</span>
				</template>
			</NDataTable>

			<NAlert v-if="fromOtherGroups" type="info" :bordered="false" class="move-note">
				选中的账户里有 {{ fromOtherGroups }} 个在别的分组,添加后会从原分组移过来。
			</NAlert>

			<template #footer>
				<div class="footer">
					<span class="muted">已选 {{ picked.length }} 个 · 共 {{ candidates.length }} 个可添加</span>
					<NSpace>
						<NButton :disabled="saving" @click="emit('close')">取消</NButton>
						<NButton type="primary" :loading="saving" :disabled="!picked.length" @click="submit">添加{{ picked.length ? ` ${picked.length} 个` : '' }}</NButton>
					</NSpace>
				</div>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.toolbar {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin-bottom: 10px;
}

.search-row > :first-child {
	flex: 1;
}

.option-label {
	display: inline-block;
	max-width: 8em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	vertical-align: bottom;
}

.option-count {
	margin-left: 6px;
	opacity: 0.6;
}

.paste {
	margin-bottom: 10px;
}

.paste-actions {
	margin-top: 6px;
}

.paste-warn {
	color: var(--warn);
}

.move-note {
	margin-top: 10px;
}

.footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
</style>
