<script setup lang="ts">
// 全局 Steam 代理的设置页(运行设置 → Steam 代理):连接(协议、主机、端口、类型、登录速率限制、启用)和身份验证(用户名、密码)分开填。
// 密码不回显,留空保留原来的;往主机栏粘贴一整串 http://用户名:密码@主机:端口 会自动拆开。单个账号的代理在账户管理里改。
import {computed, reactive, watch} from 'vue';
import {
	NAlert, NButton, NCard, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NSpace, NSwitch, NTooltip, useMessage
} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {ProxyTestResult} from '../../api/types.ts';
import {PROXY_KIND_OPTIONS, splitProxyUrl, steamCheckView} from '../../lib/proxy.ts';
import {proxy, saveGlobalProxy, testProxy} from '../../stores/proxy.ts';
import type {GlobalProxyForm} from '../../stores/proxy.ts';

const props = defineProps<{show: boolean}>();
const emit = defineEmits<{close: []}>();
const message = useMessage();

const protocolOptions = [{label: 'HTTP', value: 'http'}, {label: 'HTTPS', value: 'https'}];
const kindOptions = PROXY_KIND_OPTIONS.map(({value, label}) => ({value, label}));

const form = reactive<GlobalProxyForm>({
	enabled: false, protocol: 'http', host: '', port: null, type: 'rotating', username: '', password: '', loginsPerMinute: null, from: 1, to: 1
});
const ui = reactive({authOpen: true, busy: '' as '' | 'save' | 'test', error: '', result: null as ProxyTestResult | null});

/** 每次打开都按服务端现在的设置重填(密码不回显) */
watch(() => props.show, show => {
	if (!show) {
		return;
	}
	const {settings, range} = proxy.config;
	Object.assign(form, {
		enabled: settings.enabled,
		protocol: settings.protocol,
		host: settings.host,
		port: settings.port || null,
		type: settings.type,
		username: settings.username,
		password: '',
		loginsPerMinute: settings.loginsPerMinute || null,
		from: range.from,
		to: range.to
	});
	Object.assign(ui, {authOpen: true, busy: '', error: '', result: null});
}, {immediate: true});

const kindHelp = computed(() => PROXY_KIND_OPTIONS.find(option => option.value === form.type)?.help ?? '');
const sticky = computed(() => form.type === 'sticky');
const steamView = computed(() => (ui.result ? steamCheckView(ui.result.steam, false) : null));

/** 主机栏粘贴了一整串地址:拆成各项填好 */
function onHostPaste(event: ClipboardEvent): void {
	const parts = splitProxyUrl(event.clipboardData?.getData('text') ?? '');
	if (!parts) {
		return;
	}
	event.preventDefault();
	Object.assign(form, {protocol: parts.protocol, host: parts.host, port: parts.port, username: parts.username, password: parts.password});
	if ([parts.host, parts.username, parts.password].some(text => text.includes('{n}'))) {
		form.type = 'sticky';
	} else if (form.type === 'sticky') {
		form.type = 'rotating';
	}
	ui.authOpen = true;
	message.info('已按地址拆开填好');
}

async function run(kind: 'save' | 'test', action: () => Promise<void>): Promise<void> {
	ui.busy = kind;
	ui.error = '';
	try {
		await action();
	} catch (err) {
		ui.error = errorText(err);
	} finally {
		ui.busy = '';
	}
}

function save(): Promise<void> {
	return run('save', async () => {
		await saveGlobalProxy(form);
		message.success(form.enabled ? '已保存,已登录的账号重新登录后生效' : '已保存,全局代理已关闭');
		emit('close');
	});
}

/** 测表单上现在填的(还没保存也能测;密码留空用存着的) */
function check(): Promise<void> {
	return run('test', async () => {
		ui.result = null;
		ui.result = await testProxy({form});
	});
}
</script>

<template>
	<NModal :show="show" :mask-closable="!ui.busy" @update:show="(value: boolean) => !value && emit('close')">
		<NCard title="Steam 代理" class="proxy-settings" :bordered="false" role="dialog" aria-modal="true">
			<template #header-extra>
				<NTooltip placement="bottom-end" :style="{maxWidth: '360px'}">
					<template #trigger>
						<span class="muted help">说明</span>
					</template>
					只有 Steam 的请求走代理,C5、悠悠直连。<br>
					单个账号在「账户管理 → 代理」里改(单独代理、不走代理)。<br>
					改了以后,已登录的账号要重新登录才生效。
				</NTooltip>
			</template>

			<NForm label-placement="top" @submit.prevent>
				<section class="group">
					<div class="group-head">
						<div class="group-title">连接</div>
					</div>
					<div class="fields">
						<NFormItem label="协议" required>
							<NSelect v-model:value="form.protocol" :options="protocolOptions" />
						</NFormItem>
						<NFormItem label="主机" required>
							<NInput
								v-model:value="form.host"
								placeholder="p.webshare.io"
								:input-props="{autocomplete: 'off', spellcheck: false, onPaste: onHostPaste}"
							/>
						</NFormItem>
						<NFormItem label="端口" required>
							<NInputNumber v-model:value="form.port" :min="1" :max="65535" :precision="0" :show-button="false" placeholder="80" class="full" />
						</NFormItem>
						<NFormItem label="类型" required :feedback="kindHelp">
							<NSelect v-model:value="form.type" :options="kindOptions" />
						</NFormItem>
						<NFormItem v-if="sticky" class="wide" label="编号范围" required feedback="{n} 从这个范围里给每个账号分一个(webshare 按代理列表的序号)。">
							<NSpace align="center" :size="6" :wrap="false">
								<NInputNumber v-model:value="form.from" :min="1" :max="100000" :precision="0" class="index-input" />
								<span class="muted">-</span>
								<NInputNumber v-model:value="form.to" :min="1" :max="100000" :precision="0" class="index-input" />
							</NSpace>
						</NFormItem>
						<NFormItem
							label="登录速率限制"
							feedback="每分钟最多经这个代理开始几次 Steam 登录,所有任务都算。同一 IP 登录太多次 Steam 会拒绝,提供商按间隔换 IP 或静态代理时建议设。超出的排队等待,留空不限。"
						>
							<NInputNumber v-model:value="form.loginsPerMinute" :min="1" :max="10000" :precision="0" :show-button="false" placeholder="不限" clearable class="full">
								<template #suffix>次/分钟</template>
							</NInputNumber>
						</NFormItem>
						<NFormItem label="启用" feedback="关了 Steam 请求直连,填的内容留着。">
							<NSwitch v-model:value="form.enabled" />
						</NFormItem>
					</div>
				</section>

				<section class="group">
					<button type="button" class="group-head toggle" :aria-expanded="ui.authOpen" @click="ui.authOpen = !ui.authOpen">
						<div>
							<div class="group-title">身份验证</div>
							<div class="muted group-desc">需要认证的代理填,不需要的留空。</div>
						</div>
						<span class="chevron" :class="{open: ui.authOpen}" aria-hidden="true" />
					</button>
					<div v-show="ui.authOpen" class="fields">
						<NFormItem label="用户名">
							<NInput
								v-model:value="form.username"
								:placeholder="sticky ? 'kxkviurm-{n}' : 'kxkviurm-rotate'"
								:input-props="{autocomplete: 'off', spellcheck: false}"
							/>
						</NFormItem>
						<NFormItem label="密码" :feedback="proxy.config.settings.hasPassword ? '留空保留当前密码。' : ''">
							<NInput
								v-model:value="form.password"
								type="password"
								show-password-on="click"
								:placeholder="proxy.config.settings.hasPassword ? '已保存' : ''"
								:input-props="{autocomplete: 'new-password'}"
							/>
						</NFormItem>
					</div>
				</section>
			</NForm>

			<NAlert v-if="ui.error" type="error" :bordered="false" class="row">{{ ui.error }}</NAlert>
			<NAlert v-else-if="ui.result && steamView" :type="steamView.type" :bordered="false" class="row">
				<span :title="steamView.detail"><span class="mono">{{ ui.result.ip }}</span> · {{ ui.result.ms }} ms · {{ steamView.text }}</span>
			</NAlert>

			<template #footer>
				<NSpace justify="end">
					<NButton :loading="ui.busy === 'test'" :disabled="!form.host.trim() || !!ui.busy" @click="check">测试</NButton>
					<NButton :disabled="!!ui.busy" @click="emit('close')">取消</NButton>
					<NButton type="primary" :loading="ui.busy === 'save'" :disabled="!!ui.busy" @click="save">保存</NButton>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.proxy-settings {
	width: 760px;
	max-width: calc(100vw - 32px);
}

.help {
	cursor: help;
	font-size: 12px;
}

.group + .group {
	margin-top: 8px;
	border-top: 1px solid var(--line-soft);
	padding-top: 12px;
}

.group-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 12px;
}

.group-title {
	font-weight: 600;
	font-size: 15px;
}

.group-desc {
	font-size: 12px;
	margin-top: 2px;
}

.toggle {
	width: 100%;
	padding: 0;
	border: 0;
	background: none;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}

.chevron {
	width: 8px;
	height: 8px;
	border-right: 1.5px solid currentColor;
	border-bottom: 1.5px solid currentColor;
	transform: rotate(45deg);
	opacity: 0.6;
	margin-right: 6px;
	transition: transform 0.15s;
}

.chevron.open {
	transform: rotate(-135deg);
}

/* 两列表单,窄屏一列 */
.fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	align-items: start;
	column-gap: 20px;
}

.wide {
	grid-column: 1 / -1;
}

/* 说明文字和下一项的标签隔开 */
.fields :deep(.n-form-item-feedback-wrapper) {
	padding-bottom: 6px;
}

@media (max-width: 600px) {
	.fields {
		grid-template-columns: minmax(0, 1fr);
	}
}

.full {
	width: 100%;
}

.index-input {
	width: 120px;
}

.row {
	margin-top: 4px;
}
</style>
