<script setup lang="ts">
// 导入令牌绑定 Steam 账号:把账户管理里账号的 maFile 和密码交给 ECOSteam,让 ECO 绑定这些账号(可当收货账号)。
// 列表是账户管理里的全部账号:有没有 maFile / 密码、SteamID、ECO 上绑了没有;勾选后服务端逐个导入,进度写进「实时运行日志」。
import {computed, h, reactive, watch} from 'vue';
import {
	NAlert, NButton, NCard, NCheckbox, NDataTable, NInput, NModal, NRadio, NRadioGroup, NSelect, NSpace, NSwitch, NTag, useDialog, useMessage
} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {
	BIND_GROUP_MAX, bindPayloadError, bindResultStatus, bindSummary, filterBindCandidates, pruneSelection, toggleAllVisible, visibleCheckState
} from '../../lib/eco.ts';
import type {EcoBindCandidate, EcoBindGroupMode, EcoBindResult} from '../../lib/eco.ts';
import {fetchBindCandidates, importGuardAccounts} from '../../stores/eco.ts';

const props = defineProps<{show: boolean}>();
const emit = defineEmits<{close: []; bound: []}>();

const message = useMessage();
const dialog = useDialog();

/** 筛选里「全部分组」用这个值(null 在下拉里不好用);'' 是未分组 */
const ALL = '\u0000all';

const view = reactive({
	loading: false,
	error: '',
	accounts: [] as EcoBindCandidate[],
	groups: [] as string[],
	boundError: null as string | null,
	group: ALL,
	unboundOnly: true,
	selected: [] as string[],
	groupMode: 'none' as EcoBindGroupMode,
	groupName: '',
	importing: false,
	results: null as EcoBindResult[] | null
});

function applyList(data: {accounts: EcoBindCandidate[]; groups: string[]; boundError: string | null}): void {
	view.accounts = data.accounts;
	view.groups = data.groups;
	view.boundError = data.boundError;
	view.selected = pruneSelection(view.selected, data.accounts);
	if (view.group !== ALL && view.group !== '' && !data.groups.includes(view.group)) {
		view.group = ALL;
	}
}

async function load(refresh = false): Promise<void> {
	view.loading = true;
	view.error = '';
	try {
		applyList(await fetchBindCandidates(refresh));
	} catch (err) {
		view.error = errorText(err);
	} finally {
		view.loading = false;
	}
}

watch(() => props.show, open => {
	if (open) {
		view.results = null;
		view.selected = [];
		load();
	}
});

const groupOptions = computed<SelectOption[]>(() => [
	{value: ALL, label: '全部分组'},
	...view.groups.map(group => ({value: group, label: group})),
	...(view.accounts.some(entry => !entry.group) ? [{value: '', label: '未分组'}] : [])
]);

const visible = computed(() => filterBindCandidates(view.accounts, {group: view.group === ALL ? null : view.group, unboundOnly: view.unboundOnly}));
const headState = computed(() => visibleCheckState(view.selected, visible.value));
const neverLoggedIn = computed(() => view.selected.filter(name => !view.accounts.find(entry => entry.account === name)?.steamId).length);

function toggle(account: string, checked: boolean): void {
	view.selected = checked ? [...view.selected.filter(name => name !== account), account] : view.selected.filter(name => name !== account);
}

const columns = computed<DataTableColumns<EcoBindCandidate>>(() => [
	{
		key: 'check',
		width: 44,
		title: () => h(NCheckbox, {
			checked: headState.value.checked,
			indeterminate: headState.value.indeterminate,
			disabled: view.importing || !visible.value.some(entry => entry.ready),
			title: '全选 / 取消当前列表里能导入的账号',
			'onUpdate:checked': (checked: boolean) => {
				view.selected = toggleAllVisible(view.selected, visible.value, checked);
			}
		}),
		render: row => h(NCheckbox, {
			checked: view.selected.includes(row.account),
			disabled: !row.ready || view.importing,
			'onUpdate:checked': (checked: boolean) => toggle(row.account, checked)
		})
	},
	{title: '账号', key: 'account', minWidth: 130, ellipsis: {tooltip: true}},
	{title: '工具分组', key: 'group', width: 110, ellipsis: {tooltip: true}, render: row => row.group || h('span', {class: 'muted'}, '未分组')},
	{
		title: 'SteamID',
		key: 'steamId',
		width: 160,
		render: row => (row.steamId
			? row.steamId
			: h('span', {class: 'warn-text', title: 'maFile 里的 SteamID 可能精度丢了,导入会失败;先在账户管理里登录一次'}, '未登录过'))
	},
	{
		title: 'maFile / 密码',
		key: 'ready',
		width: 150,
		render: row => (row.ready
			? h(NTag, {size: 'small', bordered: false, type: 'success'}, () => '齐全')
			: h(NTag, {size: 'small', bordered: false, type: 'error'}, () => row.reason || '不能导入'))
	},
	{
		title: 'ECO',
		key: 'bound',
		minWidth: 140,
		ellipsis: {tooltip: true},
		render: row => (row.bound
			? h('span', [h(NTag, {size: 'small', bordered: false, type: 'info'}, () => '已绑定'), ` ${row.bound.nickname || row.bound.steamId}`])
			: h('span', {class: 'muted'}, '未绑定'))
	}
]);

const resultColumns: DataTableColumns<EcoBindResult> = [
	{title: '账号', key: 'account', width: 150, ellipsis: {tooltip: true}},
	{
		title: '结果',
		key: 'status',
		width: 90,
		render: result => {
			const status = bindResultStatus(result.status);
			return h(NTag, {size: 'small', bordered: false, type: status.tone}, () => status.label);
		}
	},
	{title: '说明', key: 'message', ellipsis: {tooltip: true}}
];

function close(): void {
	if (!view.importing) {
		emit('close');
	}
}

function submit(): void {
	const error = bindPayloadError(view.selected.length, view.groupMode, view.groupName);
	if (error) {
		message.warning(error);
		return;
	}
	const accounts = [...view.selected];
	const groupText = view.groupMode === 'fixed' ? `ECO 分组统一填「${view.groupName.trim()}」` : view.groupMode === 'tool' ? 'ECO 分组用工具里的账户分组名' : '不设 ECO 分组';
	dialog.warning({
		title: `导入令牌绑定 ${accounts.length} 个账号`,
		// 对话框挂在 body 下,scoped 样式管不到,换行用行内样式
		content: () => h('div', {style: 'white-space: pre-wrap'}, [
			`会把这 ${accounts.length} 个账号的 maFile(含 shared_secret / identity_secret)和 Steam 密码发给 ECOSteam。`,
			'ECO 拿到后能登录这些账号、生成令牌验证码、确认交易,等于把账号完全交给 ECO 控制。只对你信任 ECO 托管的账号这么做。',
			neverLoggedIn.value ? `其中 ${neverLoggedIn.value} 个账号没在工具里登录过(没有 SteamID),可能会失败。` : '',
			`${groupText}。服务器逐个导入,账号多时要等一阵,进度见右下角「实时运行日志」。`,
			'确定导入?'
		].filter(Boolean).join('\n')),
		positiveText: '确定导入',
		negativeText: '取消',
		onPositiveClick: () => {
			void runImport(accounts);
		}
	});
}

async function runImport(accounts: string[]): Promise<void> {
	view.importing = true;
	view.error = '';
	try {
		const data = await importGuardAccounts(accounts, view.groupMode, view.groupName.trim());
		view.results = data.results;
		applyList(data);
		// 成功的从勾选里去掉,失败 / 未知的留着方便重试
		const done = new Set(data.results.filter(result => result.status === 'ok').map(result => result.account.toLowerCase()));
		view.selected = view.selected.filter(name => !done.has(name.toLowerCase()));
		const summary = bindSummary(data.results);
		if (data.results.every(result => result.status === 'ok')) {
			message.success(`绑定完成:${summary}`);
		} else {
			message.warning(`绑定完成:${summary}`, {duration: 6000});
		}
		if (done.size) {
			emit('bound');
		}
	} catch (err) {
		view.error = '绑定失败:' + errorText(err);
	} finally {
		view.importing = false;
	}
}
</script>

<template>
	<NModal :show="show" :mask-closable="!view.importing" @update:show="(value: boolean) => !value && close()">
		<NCard title="导入令牌绑定 Steam 账号" style="width: 880px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
			<NAlert v-if="view.error" type="error" :bordered="false" class="block">{{ view.error }}</NAlert>
			<NAlert v-if="view.boundError" type="warning" :bordered="false" class="block">查 ECO 上已绑定的账号失败(「ECO」一列可能不准):{{ view.boundError }}</NAlert>

			<div v-if="view.results" class="block">
				<NSpace justify="space-between" align="center" class="results-head">
					<span>本次结果:{{ bindSummary(view.results) }}</span>
					<NButton size="tiny" quaternary @click="view.results = null">收起</NButton>
				</NSpace>
				<NDataTable size="small" :columns="resultColumns" :data="view.results" :max-height="180" :row-key="(row: EcoBindResult) => row.account" />
			</div>

			<NSpace align="center" class="toolbar" :size="12">
				<NSelect v-model:value="view.group" size="small" :options="groupOptions" :consistent-menu-width="false" class="group-select" />
				<span class="switch">
					<NSwitch v-model:value="view.unboundOnly" size="small" />
					只看未绑定
				</span>
				<NButton size="small" :loading="view.loading" :disabled="view.importing" @click="load(true)">刷新</NButton>
				<span class="muted hint">显示 {{ visible.length }} / {{ view.accounts.length }} 个,已勾 {{ view.selected.length }} 个</span>
			</NSpace>
			<NDataTable
				size="small"
				:columns="columns"
				:data="visible"
				:loading="view.loading"
				:max-height="360"
				:scroll-x="740"
				:row-key="(row: EcoBindCandidate) => row.account"
			>
				<template #empty>
					<span class="muted">{{ view.accounts.length ? '没有符合筛选的账号' : '账户管理里还没有账号' }}</span>
				</template>
			</NDataTable>

			<div class="group-mode">
				<span class="label">ECO 分组</span>
				<NRadioGroup v-model:value="view.groupMode" :disabled="view.importing" size="small">
					<NRadio value="none">不设置</NRadio>
					<NRadio value="fixed">统一填写</NRadio>
					<NRadio value="tool">按工具里的账户分组</NRadio>
				</NRadioGroup>
				<NInput
					v-if="view.groupMode === 'fixed'"
					v-model:value="view.groupName"
					size="small"
					:maxlength="BIND_GROUP_MAX"
					show-count
					:disabled="view.importing"
					placeholder="ECO 上的分组名(必填)"
					class="group-name"
				/>
			</div>

			<template #footer>
				<NSpace justify="space-between" align="center">
					<span class="muted hint">{{ view.importing ? '正在逐个导入,账号多时要等一阵;进度见右下角「实时运行日志」' : '一次最多 50 个(多的分批),服务器逐个导入' }}</span>
					<NSpace>
						<NButton :disabled="view.importing" @click="close">关闭</NButton>
						<NButton type="warning" :loading="view.importing" :disabled="!view.selected.length" @click="submit">
							导入并绑定{{ view.selected.length ? `(${view.selected.length})` : '' }}
						</NButton>
					</NSpace>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.block {
	margin-bottom: 10px;
}

.toolbar {
	margin-bottom: 8px;
}

.group-select {
	width: 160px;
}

.switch {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
}

.hint {
	font-size: 12px;
}

.results-head {
	margin-bottom: 4px;
	font-size: 13px;
}

.group-mode {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 12px;
	margin-top: 12px;
}

.group-mode .label {
	font-size: 13px;
}

.group-name {
	width: 260px;
}

.warn-text {
	color: var(--warn);
}
</style>
