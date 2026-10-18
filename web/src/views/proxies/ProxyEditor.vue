<script setup lang="ts">
// 新建 / 编辑一个代理:左边是表单(连接、身份验证、组织),右边(编辑时)是上次检测、用量和在用的账号。
// 输入框里不放灰字示例;密码不回显,留空保留原来的;往主机栏粘贴一整串 http://用户名:密码@主机:端口 会自动拆开。
// 「测试」测表单上现在填的(还没保存也能测),不保存。
import {computed, reactive, ref, watch} from 'vue';
import {NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NSelect, NSpace, NSwitch, NTag, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {ProxyCheck, ProxyUsageReport} from '../../api/types.ts';
import AppIcon from '../../components/AppIcon.vue';
import GroupChip from '../../components/GroupChip.vue';
import {
	PROTOCOL_OPTIONS, PROXY_KIND_OPTIONS, STATUS_META, USAGE_KIND_LABEL, accountsAssignedTo, accountsPinnedTo, formatBytes, percent, splitProxyUrl,
	timeAgo, totalBytes, uniqueIpText
} from '../../lib/proxy.ts';
import {createProxy, emptyProxyForm, fetchUsage, proxy, testDraft, testProxies, updateProxy} from '../../stores/proxy.ts';
import type {ProxyForm} from '../../stores/proxy.ts';

const props = defineProps<{proxyId: string}>();
const emit = defineEmits<{saved: [id: string]; back: []}>();
const message = useMessage();

const current = computed(() => proxy.data.proxies.find(item => item.id === props.proxyId));
const form = reactive<ProxyForm>(emptyProxyForm());
const ui = reactive({authOpen: true, busy: '' as '' | 'save' | 'test' | 'check', error: '', result: null as null | {check: ProxyCheck; proxy: string}});

/** 换了要编辑的代理(或新建)就按服务端现在的重填(密码不回显) */
watch(() => props.proxyId, () => {
	const item = current.value;
	Object.assign(form, item
		? {
			protocol: item.protocol, host: item.host, port: item.port || null, type: item.type, username: item.username, password: '',
			poolSize: item.poolSize || null, loginsPerMinute: item.loginsPerMinute || null, enabled: item.enabled, notes: item.notes, groupIds: [...item.groupIds]
		}
		: emptyProxyForm());
	Object.assign(ui, {authOpen: !item || !!item.username, busy: '', error: '', result: null});
	void loadUsage();
}, {immediate: true});

const kindOptions = PROXY_KIND_OPTIONS.map(({value, label}) => ({value, label}));
const kindHelp = computed(() => PROXY_KIND_OPTIONS.find(option => option.value === form.type)?.help ?? '');
const groupOptions = computed(() => proxy.data.groups.map(group => ({label: group.name, value: group.id})));

/** 主机栏粘贴了一整串地址:拆成各项填好 */
function onHostPaste(event: ClipboardEvent): void {
	const parts = splitProxyUrl(event.clipboardData?.getData('text') ?? '');
	if (!parts) {
		return;
	}
	event.preventDefault();
	Object.assign(form, {protocol: parts.protocol, host: parts.host, port: parts.port, username: parts.username, password: parts.password});
	// 带 {n} 或 webshare 的 -rotate:是轮换入口
	if ([parts.host, parts.username, parts.password].some(text => text.includes('{n}')) || /-rotate$/i.test(parts.username)) {
		form.type = 'rotating';
	}
	ui.authOpen = true;
	message.info('已按地址拆开填好');
}

async function run(kind: 'save' | 'test' | 'check', action: () => Promise<void>): Promise<void> {
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
		if (current.value) {
			await updateProxy(current.value.id, form);
			form.password = '';
			message.success('已保存,已登录的账号重新登录后登录连接才换');
		} else {
			const created = await createProxy(form);
			message.success('已添加');
			emit('saved', created.id);
		}
	});
}

/** 测表单上现在填的(编辑时密码留空用存着的) */
function check(): Promise<void> {
	return run('test', async () => {
		ui.result = null;
		ui.result = await testDraft(current.value?.id ?? '', form);
	});
}

const resultView = computed(() => {
	const result = ui.result;
	if (!result) {
		return null;
	}
	const {check: c} = result;
	const meta = STATUS_META[c.status];
	if (c.status === 'unreachable') {
		return {type: 'error' as const, text: `${meta.label}:${c.error}`};
	}
	const parts = [`${meta.label}`, `${c.ip}${c.country ? ` ${c.country}` : ''}`, `${c.latencyMs} ms`, c.samples > 1 ? `不同 IP ${uniqueIpText(c)}` : ''];
	return {type: 'success' as const, text: parts.filter(Boolean).join(' · ')};
});

// ===== 右边:检测、用量、账号 =====
const usage = ref<ProxyUsageReport | null>(null);

async function loadUsage(): Promise<void> {
	usage.value = null;
	if (!props.proxyId) {
		return;
	}
	try {
		usage.value = await fetchUsage(30, props.proxyId);
	} catch {
		// 用量读不到不影响编辑
	}
}

/** 最近 N 天(含今天)的合计 */
function lastDays(days: number) {
	const list = usage.value?.byDay.slice(-days) ?? [];
	return list.reduce((sum, day) => ({sent: sum.sent + day.sent, received: sum.received + day.received}), {sent: 0, received: 0});
}

const periods = computed(() => [{label: '最近 24 小时(今天)', days: 1}, {label: '最近 7 天', days: 7}, {label: '最近 30 天', days: 30}].map(period => ({...period, ...lastDays(period.days)})));
const usageTotal = computed(() => (usage.value ? totalBytes(usage.value.total) : 0));
const assigned = computed(() => (current.value ? accountsAssignedTo(proxy.data, current.value.id) : []));
const memberOf = computed(() => proxy.data.groups.filter(group => current.value?.groupIds.includes(group.id)));
// 检测完(上次检查时间变了)用量里多了检测的流量,刷新一下
watch(() => current.value?.check?.checkedAt, (time, before) => {
	if (time && time !== before) {
		void loadUsage();
	}
});
const pinned = computed(() => (current.value ? accountsPinnedTo(proxy.data, current.value.id) : []));

function recheck(): Promise<void> {
	return run('check', async () => {
		if (current.value) {
			await testProxies([current.value.id]);
		}
	});
}
</script>

<template>
	<div class="editor" :class="{single: !current}">
		<div class="form-col">
			<NForm label-placement="top" @submit.prevent>
				<section class="panel">
					<header class="panel-head"><AppIcon name="globe" :size="17" />连接</header>
					<div class="panel-body fields">
						<NFormItem label="协议" required>
							<NSelect v-model:value="form.protocol" :options="PROTOCOL_OPTIONS" />
						</NFormItem>
						<NFormItem label="主机" required>
							<NInput v-model:value="form.host" placeholder="" :input-props="{autocomplete: 'off', spellcheck: false, onPaste: onHostPaste}" />
						</NFormItem>
						<NFormItem label="端口" required>
							<NInputNumber v-model:value="form.port" :min="1" :max="65535" :precision="0" :show-button="false" placeholder="" class="full" />
						</NFormItem>
						<NFormItem label="类型" required :feedback="kindHelp">
							<NSelect v-model:value="form.type" :options="kindOptions" />
						</NFormItem>
						<NFormItem
							v-if="form.type === 'rotating'"
							label="IP 数量"
							feedback="选填。池里有几个 IP(webshare 是代理列表的个数),填了就给每个账号固定一个:webshare 的用户名以 -rotate 结尾会自动换成 -编号,别家在用户名里用 {n} 标出编号的位置。不填由提供商每个新连接换 IP。"
						>
							<NInputNumber v-model:value="form.poolSize" :min="1" :max="100000" :precision="0" :show-button="false" placeholder="" clearable class="full" />
						</NFormItem>
						<NFormItem
							label="登录速率限制"
							feedback="限制每分钟可经这个代理开始的 Steam 登录次数,所有任务都算。提供商按间隔换出口 IP(或代理是静态)时请设:同一 IP 登录过多时 Steam 会开始拒绝。超出的排队等待,留空不限。"
						>
							<NInputNumber v-model:value="form.loginsPerMinute" :min="1" :max="10000" :precision="0" :show-button="false" placeholder="" clearable class="full">
								<template #suffix>次/分钟</template>
							</NInputNumber>
						</NFormItem>
						<NFormItem label="启用" feedback="停用的不给账号用,填的内容留着。">
							<NSwitch v-model:value="form.enabled" />
						</NFormItem>
					</div>
				</section>

				<section class="panel">
					<button type="button" class="panel-head toggle" :aria-expanded="ui.authOpen" @click="ui.authOpen = !ui.authOpen">
						<span class="head-title"><AppIcon name="key" :size="17" />身份验证</span>
						<span class="muted head-desc">需要认证的代理填,不需要的留空。</span>
						<AppIcon name="chevronDown" :size="16" class="chevron" :class="{open: ui.authOpen}" />
					</button>
					<div v-show="ui.authOpen" class="panel-body fields">
						<NFormItem label="用户名">
							<NInput v-model:value="form.username" placeholder="" :input-props="{autocomplete: 'off', spellcheck: false}" />
						</NFormItem>
						<NFormItem label="密码" :feedback="current?.hasPassword ? '留空以保留当前密码。' : ''">
							<NInput v-model:value="form.password" type="password" show-password-on="click" placeholder="" :input-props="{autocomplete: 'new-password'}" />
						</NFormItem>
					</div>
				</section>

				<section class="panel">
					<header class="panel-head"><AppIcon name="tag" :size="17" />组织</header>
					<div class="panel-body fields">
						<NFormItem label="代理组" :feedback="groupOptions.length ? '' : '还没有代理组,在「代理组」标签页里建。'">
							<NSelect v-model:value="form.groupIds" multiple :options="groupOptions" placeholder="" clearable />
						</NFormItem>
						<NFormItem label="备注">
							<NInput v-model:value="form.notes" type="textarea" :autosize="{minRows: 1, maxRows: 4}" :maxlength="500" placeholder="" />
						</NFormItem>
					</div>
				</section>
			</NForm>

			<NAlert v-if="ui.error" type="error" :bordered="false">{{ ui.error }}</NAlert>
			<NAlert v-else-if="resultView" :type="resultView.type" :bordered="false" title="测试结果(没有保存)">
				<span>{{ resultView.text }}</span>
			</NAlert>

			<NSpace :size="8">
				<NButton type="primary" :loading="ui.busy === 'save'" :disabled="!!ui.busy" @click="save">{{ current ? '保存' : '创建' }}</NButton>
				<NButton :loading="ui.busy === 'test'" :disabled="!form.host.trim() || !!ui.busy" @click="check">
					<template #icon><AppIcon name="radio" :size="16" /></template>测试
				</NButton>
				<NButton :disabled="ui.busy === 'save'" @click="emit('back')">取消</NButton>
			</NSpace>
		</div>

		<aside v-if="current" class="side-col">
			<section class="panel">
				<header class="panel-head panel-head-row">
					<span class="head-title"><AppIcon name="radio" :size="17" />检测</span>
					<NButton size="small" :loading="ui.busy === 'check' || current.status === 'checking'" @click="recheck">重新检测</NButton>
				</header>
				<dl class="facts">
					<dt>状态</dt>
					<dd><NTag size="small" :bordered="false" round :type="STATUS_META[current.status].type">{{ STATUS_META[current.status].label }}</NTag></dd>
					<template v-if="current.check">
						<template v-if="current.check.error">
							<dt>原因</dt>
							<dd class="danger">{{ current.check.error }}</dd>
						</template>
						<dt>出口 IP</dt>
						<dd><span class="mono">{{ current.check.ip || '—' }}</span> <span class="muted">{{ current.check.country }}</span></dd>
						<dt>延迟</dt>
						<dd>{{ current.check.status === 'unreachable' ? '—' : `${current.check.latencyMs} ms` }}</dd>
						<dt>不同 IP</dt>
						<dd>{{ uniqueIpText(current.check) }}</dd>
						<dt>上次检查</dt>
						<dd>{{ timeAgo(current.check.checkedAt) }}</dd>
					</template>
				</dl>
			</section>

			<section class="panel">
				<header class="panel-head"><AppIcon name="chart" :size="17" />用量</header>
				<div class="periods">
					<div v-for="period in periods" :key="period.days" class="period">
						<div class="muted period-label">{{ period.label }}</div>
						<div class="period-value">{{ formatBytes(period.sent + period.received) }}</div>
						<div class="muted period-sub">已发送 {{ formatBytes(period.sent) }},已接收 {{ formatBytes(period.received) }}</div>
					</div>
				</div>
				<template v-if="usage && usageTotal">
					<div class="sub-head">用量最高的账户(最近 30 天)</div>
					<ul class="rank">
						<li v-for="item in usage.byAccount.slice(0, 10)" :key="item.account">
							<span class="rank-name">{{ item.account || '认不出账号的请求' }}</span>
							<span class="muted">{{ item.requests }} 次</span>
							<span>{{ formatBytes(totalBytes(item)) }}</span>
							<span class="muted share">{{ percent(totalBytes(item), usageTotal) }}%</span>
						</li>
					</ul>
					<div class="sub-head">按请求类型(最近 30 天)</div>
					<ul class="rank">
						<li v-for="item in usage.byKind" :key="item.kind">
							<span class="rank-name">{{ USAGE_KIND_LABEL[item.kind] ?? item.kind }}</span>
							<span class="muted">{{ item.requests }} 次</span>
							<span>{{ formatBytes(totalBytes(item)) }}</span>
							<span class="muted share">{{ percent(totalBytes(item), usageTotal) }}%</span>
						</li>
					</ul>
				</template>
				<p v-else class="muted empty-note">最近 30 天没有经这个代理的请求。</p>
			</section>

			<section class="panel">
				<header class="panel-head"><AppIcon name="users" :size="17" />账户</header>
				<div class="panel-body accounts">
					<div>
						<div class="muted small">这次运行在用(重启后重新分)</div>
						<div v-if="assigned.length" class="names">{{ assigned.map(key => key || '认不出账号的请求').join('、') }}</div>
						<div v-else class="muted">没有</div>
					</div>
					<div>
						<div class="muted small">单独绑定(专用,不进代理池)</div>
						<div v-if="pinned.length" class="names">{{ pinned.join('、') }}</div>
						<div v-else class="muted">没有</div>
					</div>
					<div v-if="memberOf.length">
						<div class="muted small">所在代理组</div>
						<div class="names chips">
							<GroupChip v-for="group in memberOf" :key="group.id" :name="group.name" :color="group.color" />
						</div>
					</div>
				</div>
			</section>
		</aside>
	</div>
</template>

<style scoped>
.editor {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 340px;
	align-items: start;
	gap: 16px;
}

.editor.single {
	grid-template-columns: minmax(0, 860px);
}

.form-col,
.side-col {
	display: flex;
	flex-direction: column;
	gap: 16px;
	min-width: 0;
}

.form-col :deep(.n-form) {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.panel-head {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 14px 20px;
	border-bottom: 1px solid var(--line);
	font-weight: 600;
}

.panel-head-row {
	justify-content: space-between;
}

.head-title {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}

.head-desc {
	font-size: 12px;
	font-weight: 400;
}

.toggle {
	width: 100%;
	border: 0;
	border-bottom: 1px solid var(--line);
	background: none;
	color: inherit;
	font: inherit;
	font-weight: 600;
	text-align: left;
	cursor: pointer;
}

.chevron {
	margin-left: auto;
	color: var(--muted);
	transition: transform 0.15s;
}

.chevron.open {
	transform: rotate(180deg);
}

.panel-body {
	padding: 16px 20px 6px;
}

/* 两列表单,窄屏一列 */
.fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	align-items: start;
	column-gap: 20px;
}

.fields :deep(.n-form-item-feedback-wrapper) {
	padding-bottom: 6px;
	font-size: 12px;
	line-height: 1.5;
}

.full {
	width: 100%;
}

.facts {
	display: grid;
	grid-template-columns: 84px minmax(0, 1fr);
	gap: 10px 12px;
	margin: 0;
	padding: 16px 20px;
	font-size: 13px;
}

.facts dt {
	color: var(--muted);
}

.facts dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

.danger {
	color: var(--danger);
}

.warn {
	color: var(--warn);
}

.periods {
	display: flex;
	flex-direction: column;
}

.period {
	padding: 12px 20px;
	border-bottom: 1px solid var(--line-soft);
}

.period-label,
.period-sub,
.small {
	font-size: 12px;
}

.period-value {
	margin: 2px 0;
	font-size: 20px;
	font-weight: 700;
}

.sub-head {
	padding: 12px 20px 4px;
	font-size: 13px;
	font-weight: 600;
}

.rank {
	margin: 0;
	padding: 0 20px 12px;
	list-style: none;
	font-size: 13px;
}

.rank li {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto auto 40px;
	gap: 10px;
	padding: 5px 0;
	border-bottom: 1px solid var(--line-soft);
}

.rank-name {
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.share {
	text-align: right;
}

.empty-note {
	margin: 0;
	padding: 12px 20px 16px;
	font-size: 13px;
}

.accounts {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding-bottom: 16px;
	font-size: 13px;
}

.names {
	margin-top: 4px;
	overflow-wrap: anywhere;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

@media (max-width: 1100px) {
	.editor {
		grid-template-columns: minmax(0, 1fr);
	}
}

@media (max-width: 640px) {
	.fields {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
