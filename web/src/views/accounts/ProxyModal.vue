<script setup lang="ts">
// 单个账号的 Steam 代理:跟随全局、单独代理、不走代理。单独代理没填地址时沿用原来的(切换方式不用再输一遍密码)。
import {computed, reactive, watch} from 'vue';
import {NAlert, NButton, NCard, NInput, NModal, NRadio, NRadioGroup, NSpace, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {AccountProxyMode, ProxyTestResult} from '../../api/types.ts';
import {accountProxy, steamCheckView} from '../../lib/proxy.ts';
import {loadProxy, proxy, saveAccountProxy, testProxy} from '../../stores/proxy.ts';

const props = defineProps<{accountName: string}>();
const emit = defineEmits<{close: []}>();
const message = useMessage();

const form = reactive({mode: 'global' as AccountProxyMode, input: '', busy: '' as '' | 'save' | 'test', error: '', result: null as ProxyTestResult | null});

const current = computed(() => accountProxy(proxy.config, props.accountName));
/** 这个账号原来就有单独代理(切到「单独代理」时可以不填) */
const ownProxy = computed(() => proxy.config.accounts[props.accountName.toLowerCase()]?.mode === 'custom' ? proxy.config.accounts[props.accountName.toLowerCase()]!.url : '');

watch(() => props.accountName, name => {
	if (name) {
		Object.assign(form, {mode: current.value.mode, input: '', busy: '', error: '', result: null});
	}
}, {immediate: true});

async function run(kind: 'save' | 'test', action: () => Promise<void>): Promise<void> {
	form.busy = kind;
	form.error = '';
	try {
		await action();
	} catch (err) {
		form.error = errorText(err);
	} finally {
		form.busy = '';
	}
}

function save(): Promise<void> {
	return run('save', async () => {
		await saveAccountProxy(props.accountName, form.mode, form.mode === 'custom' ? form.input.trim() : '');
		message.success('已保存,重新登录后生效');
		emit('close');
	});
}

/**
 * 单独代理填了地址测填的;方式没改就测这个账号现在用的(固定 IP 模式下就是它分到的那个编号);
 * 刚切到「跟随全局」还没保存的测全局代理
 */
function check(): Promise<void> {
	return run('test', async () => {
		form.result = null;
		const input = form.mode === 'custom' ? form.input.trim() : '';
		form.result = await testProxy(input ? {proxy: input} : form.mode === current.value.mode ? {accountName: props.accountName} : {});
		// 固定 IP 模式下第一次测会给账号分编号,刷新一下好在表格里显示
		loadProxy();
	});
}

/** 测试结果里的 Steam 社区检查 */
const steamView = computed(() => (form.result ? steamCheckView(form.result.steam) : null));

const canSave = computed(() => form.mode !== 'custom' || !!form.input.trim() || !!ownProxy.value);
const canTest = computed(() => (form.mode === 'custom' ? !!form.input.trim() || !!ownProxy.value : form.mode === 'global' && !!proxy.config.global));
</script>

<template>
	<NModal :show="!!accountName" @update:show="(show: boolean) => !show && emit('close')">
		<NCard :title="`${accountName} 代理`" style="width: 440px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
			<div class="muted row" :title="current.title">当前:{{ current.label }}</div>
			<NRadioGroup v-model:value="form.mode" class="row" @update:value="form.result = null">
				<NSpace :size="16">
					<NRadio value="global">跟随全局</NRadio>
					<NRadio value="custom">单独代理</NRadio>
					<NRadio value="direct">不走代理</NRadio>
				</NSpace>
			</NRadioGroup>
			<NInput
				v-if="form.mode === 'custom'"
				v-model:value="form.input"
				:placeholder="ownProxy ? `不填沿用 ${ownProxy}` : 'http://用户名:密码@主机:端口'"
				clearable
				class="row"
				:input-props="{autocomplete: 'off', spellcheck: false}"
			/>
			<NAlert v-if="form.error" type="error" :bordered="false" class="row">{{ form.error }}</NAlert>
			<NAlert v-else-if="form.result && steamView" :type="steamView.type" :bordered="false" class="row">
				<span :title="steamView.detail"><span class="mono">{{ form.result.ip }}</span> · {{ form.result.ms }} ms · {{ steamView.text }}</span>
			</NAlert>
			<template #footer>
				<NSpace justify="end">
					<NButton :loading="form.busy === 'test'" :disabled="!canTest" @click="check">测试</NButton>
					<NButton :disabled="!!form.busy" @click="emit('close')">取消</NButton>
					<NButton type="primary" :loading="form.busy === 'save'" :disabled="!canSave" @click="save">保存</NButton>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.row {
	margin-bottom: 10px;
}
</style>
