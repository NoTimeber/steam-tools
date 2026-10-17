<script setup lang="ts">
// 账号的 Steam 代理(一个或勾选的几个):用代理池、绑定代理 / 代理组(只用这些)、每个账号分一个(从选的代理里各绑一个)、不走代理。
// 账号所在账户分组关联的代理组和这里的绑定合在一起。代理本身在「代理管理」里加。
import {computed, reactive, watch} from 'vue';
import {NAlert, NButton, NCard, NModal, NRadio, NRadioGroup, NSelect, NSpace, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {STATUS_META, accountProxyView, pinnedProxyIds} from '../../lib/proxy.ts';
import {accounts} from '../../stores/accounts.ts';
import {bindAccounts, distributeProxies, proxy} from '../../stores/proxy.ts';

type Mode = 'pool' | 'bind' | 'distribute' | 'direct';

const props = defineProps<{accountNames: string[]}>();
const emit = defineEmits<{close: []}>();
const message = useMessage();

const form = reactive({mode: 'pool' as Mode, proxyIds: [] as string[], groupIds: [] as string[], saving: false, error: ''});
const single = computed(() => (props.accountNames.length === 1 ? props.accountNames[0]! : ''));
const accountGroupOf = (name: string) => accounts.rows.find(row => row.key === name.toLowerCase())?.groupId ?? '';

/** 每次打开:一个账号按它现在的设置填,几个账号从「绑定代理」开始 */
watch(() => props.accountNames, names => {
	if (!names.length) {
		return;
	}
	const binding = names.length === 1 ? proxy.data.accounts[names[0]!.toLowerCase()] : undefined;
	Object.assign(form, {
		mode: names.length > 1 ? 'bind' : binding?.mode === 'direct' ? 'direct' : binding?.mode === 'bind' ? 'bind' : 'pool',
		proxyIds: binding?.mode === 'bind' ? [...binding.proxyIds] : [],
		groupIds: binding?.mode === 'bind' ? [...binding.groupIds] : [],
		saving: false,
		error: ''
	});
}, {immediate: true});

const current = computed(() => (single.value ? accountProxyView(proxy.data, single.value, accountGroupOf(single.value)) : null));
/** 账户分组关联的代理组(一个账号时显示) */
const linkedGroups = computed(() => {
	const groupId = single.value ? accountGroupOf(single.value) : '';
	return (groupId ? proxy.data.accountGroups[groupId] ?? [] : []).map(id => proxy.data.groups.find(group => group.id === id)?.name).filter(Boolean);
});

const proxyOptions = computed(() => proxy.data.proxies.map(item => ({
	value: item.id,
	label: `${item.endpoint}${item.username ? ` · ${item.username}` : ''} · ${item.enabled ? STATUS_META[item.status].label : '已停用'}`
})));
const groupOptions = computed(() => proxy.data.groups.map(group => ({
	value: group.id,
	label: `${group.name}(${proxy.data.proxies.filter(item => item.groupIds.includes(group.id)).length} 个代理)`
})));

/** 「每个账号分一个」一键选:启用着、没被别的账号单独绑定、上次检测没失败的代理 */
function pickFree(): void {
	const pinned = pinnedProxyIds({...proxy.data, accounts: Object.fromEntries(Object.entries(proxy.data.accounts).filter(([key]) => !props.accountNames.some(name => name.toLowerCase() === key)))});
	form.proxyIds = proxy.data.proxies.filter(item => item.enabled && !pinned.has(item.id) && item.status !== 'unreachable' && item.status !== 'blocked').map(item => item.id);
}

const modeHelp = computed(() => {
	switch (form.mode) {
		case 'pool':
			return '从代理池(启用着、没被账号单独绑定的代理)里分一个,这次运行一直用它。';
		case 'bind':
			return '只用选的代理和代理组里的代理(绑给账号的代理是它专用的,不进代理池)。绑定的全停用了就不登录,不会改用别的代理或直连。';
		case 'distribute':
			return `从选的代理里给这 ${props.accountNames.length} 个账号各绑一个(先给没被别的账号绑定的);代理比账号少时有账号共用。`;
		default:
			return 'Steam 请求直连,不经过任何代理。';
	}
});

const canSave = computed(() => (form.mode === 'bind' ? form.proxyIds.length + form.groupIds.length > 0 : form.mode === 'distribute' ? form.proxyIds.length > 0 : true));

async function save(): Promise<void> {
	form.saving = true;
	form.error = '';
	try {
		if (form.mode === 'distribute') {
			await distributeProxies(props.accountNames, form.proxyIds);
		} else {
			await bindAccounts(props.accountNames, form.mode, form.mode === 'bind' ? form.proxyIds : [], form.mode === 'bind' ? form.groupIds : []);
		}
		message.success('已保存,已登录的账号重新登录后登录连接才换');
		emit('close');
	} catch (err) {
		form.error = errorText(err);
	} finally {
		form.saving = false;
	}
}
</script>

<template>
	<NModal :show="accountNames.length > 0" :mask-closable="!form.saving" @update:show="(show: boolean) => !show && emit('close')">
		<NCard :title="single ? `${single} 的代理` : `${accountNames.length} 个账号的代理`" style="width: 520px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
			<div v-if="current" class="muted row">现在:{{ current.label }} — {{ current.tip }}</div>
			<div v-if="linkedGroups.length" class="muted row">所在账户分组关联了代理组 {{ linkedGroups.join('、') }}(和这里的绑定合在一起)</div>
			<NRadioGroup v-model:value="form.mode" class="row">
				<NSpace :size="16">
					<NRadio value="pool">用代理池</NRadio>
					<NRadio value="bind">绑定代理</NRadio>
					<NRadio v-if="accountNames.length > 1" value="distribute">每个账号分一个</NRadio>
					<NRadio value="direct">不走代理</NRadio>
				</NSpace>
			</NRadioGroup>
			<p class="muted help">{{ modeHelp }}</p>

			<template v-if="form.mode === 'bind' || form.mode === 'distribute'">
				<label class="field-label">
					代理
					<NButton v-if="form.mode === 'distribute'" size="tiny" text type="primary" class="pick-free" @click="pickFree">选全部空闲的</NButton>
				</label>
				<NSelect v-model:value="form.proxyIds" multiple filterable clearable max-tag-count="responsive" :options="proxyOptions" placeholder="" class="row" />
			</template>
			<template v-if="form.mode === 'bind'">
				<label class="field-label">代理组</label>
				<NSelect v-model:value="form.groupIds" multiple filterable clearable :options="groupOptions" placeholder="" class="row" />
			</template>
			<p v-if="!proxy.data.proxies.length && form.mode !== 'direct'" class="muted help">还没有代理,先到左边「代理管理」里添加。</p>

			<NAlert v-if="form.error" type="error" :bordered="false" class="row">{{ form.error }}</NAlert>
			<template #footer>
				<NSpace justify="end">
					<NButton :disabled="form.saving" @click="emit('close')">取消</NButton>
					<NButton type="primary" :loading="form.saving" :disabled="!canSave" @click="save">保存</NButton>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.row {
	margin-bottom: 10px;
}

.help {
	margin: 0 0 12px;
	font-size: 12px;
	line-height: 1.6;
}

.field-label {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 6px;
	font-size: 13px;
	font-weight: 500;
}

.pick-free {
	font-weight: 400;
}
</style>
