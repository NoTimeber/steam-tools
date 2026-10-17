<script setup lang="ts">
// 导入代理:每行一个(host:port、host:port:user:pass、host:port@user:pass、user:pass@host:port,可带 http:// 前缀),
// 选默认协议、类型、启用、加入哪些代理组。已有的跳过;拆不开的按行号列出来,弹窗不关,改了再导。
import {computed, reactive, watch} from 'vue';
import {NAlert, NButton, NCard, NForm, NFormItem, NInput, NModal, NSelect, NSpace, NSwitch, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {ProxyKind, ProxyProtocol} from '../../api/types.ts';
import {PROTOCOL_OPTIONS, PROXY_KIND_OPTIONS} from '../../lib/proxy.ts';
import {importProxies, proxy} from '../../stores/proxy.ts';
import type {ImportOutcome} from '../../stores/proxy.ts';

const props = defineProps<{show: boolean}>();
const emit = defineEmits<{close: []}>();
const message = useMessage();

const form = reactive({text: '', protocol: 'http' as ProxyProtocol, type: 'static' as ProxyKind, enabled: true, groupIds: [] as string[]});
const ui = reactive({saving: false, error: '', outcome: null as ImportOutcome | null});

watch(() => props.show, show => {
	if (show) {
		Object.assign(ui, {saving: false, error: '', outcome: null});
	}
});

const kindOptions = PROXY_KIND_OPTIONS.map(({value, label}) => ({value, label}));
const kindHelp = computed(() => PROXY_KIND_OPTIONS.find(option => option.value === form.type)?.help ?? '');
const groupOptions = computed(() => proxy.data.groups.map(group => ({label: group.name, value: group.id})));
const lineCount = computed(() => form.text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).length);

async function submit(): Promise<void> {
	if (!lineCount.value) {
		ui.error = '请粘贴代理列表,每行一个';
		return;
	}
	ui.saving = true;
	ui.error = '';
	ui.outcome = null;
	try {
		const outcome = await importProxies({...form});
		if (!outcome.errors.length) {
			message.success(`已导入 ${outcome.added} 个代理` + (outcome.duplicates ? `,${outcome.duplicates} 个已有的跳过` : ''));
			form.text = '';
			emit('close');
			return;
		}
		ui.outcome = outcome;
	} catch (err) {
		ui.error = errorText(err);
	} finally {
		ui.saving = false;
	}
}
</script>

<template>
	<NModal :show="show" :mask-closable="!ui.saving" @update:show="(value: boolean) => !value && emit('close')">
		<NCard title="导入" class="import-modal" :bordered="false" role="dialog" aria-modal="true">
			<NForm label-placement="top" @submit.prevent>
				<NFormItem label="代理列表" required>
					<template #feedback>
						每行一个代理。支持的格式:host:port、host:port:user:pass、host:port@user:pass、user:pass@host:port,每项都可以加上 http:// 或 https:// 前缀。
						暂不支持 SOCKS5。
					</template>
					<NInput v-model:value="form.text" type="textarea" :rows="9" placeholder="" class="mono" :input-props="{spellcheck: false, autocomplete: 'off'}" />
				</NFormItem>
				<div class="fields">
					<NFormItem label="默认协议" required feedback="没写前缀的行用这个。">
						<NSelect v-model:value="form.protocol" :options="PROTOCOL_OPTIONS" />
					</NFormItem>
					<NFormItem label="类型" required :feedback="kindHelp">
						<NSelect v-model:value="form.type" :options="kindOptions" />
					</NFormItem>
					<NFormItem label="启用">
						<NSwitch v-model:value="form.enabled" />
					</NFormItem>
					<NFormItem label="添加到组" feedback="新导入的代理会加入这些组。被跳过的重复项不会。">
						<NSelect v-model:value="form.groupIds" multiple :options="groupOptions" placeholder="" clearable />
					</NFormItem>
				</div>
			</NForm>

			<NAlert v-if="ui.error" type="error" :bordered="false">{{ ui.error }}</NAlert>
			<NAlert v-else-if="ui.outcome" type="warning" :bordered="false" :title="`导入了 ${ui.outcome.added} 个` + (ui.outcome.duplicates ? `,${ui.outcome.duplicates} 个已有的跳过` : '') + `;${ui.outcome.errors.length} 行没导入`">
				<ul class="errors">
					<li v-for="item in ui.outcome.errors.slice(0, 20)" :key="item.line">第 {{ item.line }} 行:{{ item.error }}</li>
					<li v-if="ui.outcome.errors.length > 20" class="muted">还有 {{ ui.outcome.errors.length - 20 }} 行…</li>
				</ul>
			</NAlert>

			<template #footer>
				<NSpace justify="space-between" align="center">
					<span class="muted">{{ lineCount ? `${lineCount} 行` : '' }}</span>
					<NSpace>
						<NButton :disabled="ui.saving" @click="emit('close')">{{ ui.outcome ? '关闭' : '取消' }}</NButton>
						<NButton type="primary" :loading="ui.saving" @click="submit">提交</NButton>
					</NSpace>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.import-modal {
	width: 680px;
	max-width: calc(100vw - 32px);
}

.fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	column-gap: 20px;
}

.import-modal :deep(.n-form-item-feedback-wrapper) {
	padding-bottom: 6px;
	font-size: 12px;
	line-height: 1.5;
}

.errors {
	margin: 4px 0 0;
	padding-left: 18px;
	font-size: 13px;
}

@media (max-width: 600px) {
	.fields {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
