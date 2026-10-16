<script setup lang="ts">
// 运行设置:当前版本和检查新版本、修改访问口令、退出登录、Steam 代理。
import {computed, onMounted, reactive, ref} from 'vue';
import {NAlert, NButton, NCard, NForm, NFormItem, NInput, NInputNumber, NModal, NSpace, useMessage} from 'naive-ui';
import {api, errorText} from '../api/http.ts';
import type {ProxyTestResult} from '../api/types.ts';
import {steamCheckView} from '../lib/proxy.ts';
import {addLog} from '../stores/logs.ts';
import {loadProxy, proxy, saveGlobalProxy, testProxy} from '../stores/proxy.ts';
import {checkForUpdate, update} from '../stores/update.ts';

const message = useMessage();
const checking = ref(false);

const latestText = computed(() => {
	if (update.disabled) {
		return '版本检查已关闭';
	}
	if (update.latest) {
		return `最新版本:v${update.latest}` + (update.hasUpdate ? '' : '(已是最新)');
	}
	return update.error ? '最新版本:检查失败' : '';
});

async function check(): Promise<void> {
	checking.value = true;
	try {
		const outcome = await checkForUpdate();
		message[outcome.kind === 'failed' ? 'error' : outcome.kind === 'available' ? 'info' : 'success'](outcome.message);
	} catch (err) {
		message.error('检查更新失败:' + errorText(err));
	} finally {
		checking.value = false;
	}
}

const password = reactive({open: false, saving: false, current: '', next: '', confirm: '', error: ''});

function openPassword(): void {
	Object.assign(password, {open: true, saving: false, current: '', next: '', confirm: '', error: ''});
}

async function savePassword(): Promise<void> {
	if (!password.next) {
		password.error = '请输入新口令';
		return;
	}
	if (password.next !== password.confirm) {
		password.error = '两次输入的新口令不一致';
		return;
	}
	password.saving = true;
	try {
		await api.post('/api/auth/password', {currentPassword: password.current, newPassword: password.next});
		password.open = false;
		addLog('success', '访问口令已修改,其它设备需重新登录');
		message.success('访问口令已修改');
	} catch (err) {
		password.error = errorText(err) || '修改失败';
	} finally {
		password.saving = false;
	}
}

// ===== Steam 代理(全局;账号的单独设置在账户管理页) =====
const proxyForm = reactive({
	input: '',
	/** 固定 IP 模式({n})的编号范围 */
	from: 1 as number | null,
	to: 1 as number | null,
	busy: '' as '' | 'save' | 'clear' | 'test',
	error: '',
	result: null as ProxyTestResult | null
});

onMounted(async () => {
	await loadProxy();
	proxyForm.from = proxy.config.range.from;
	proxyForm.to = proxy.config.range.to;
});

/** 输入框里写了 {n},或者没输入、现在就是固定 IP 模式:要填编号范围 */
const templateMode = computed(() => proxyForm.input.includes('{n}') || (!proxyForm.input.trim() && proxy.config.sticky));
const rangeBody = () => ({from: Number(proxyForm.from), to: Number(proxyForm.to)});
/** 测试结果里的 Steam 社区检查(这里测的是全局代理,不针对哪个账号,不提示重新登录) */
const steamView = computed(() => (proxyForm.result ? steamCheckView(proxyForm.result.steam, false) : null));
const rangeChanged = computed(() => proxy.config.sticky && (proxyForm.from !== proxy.config.range.from || proxyForm.to !== proxy.config.range.to));

async function runProxy(kind: 'save' | 'clear' | 'test', action: () => Promise<void>): Promise<void> {
	proxyForm.busy = kind;
	proxyForm.error = '';
	try {
		await action();
	} catch (err) {
		proxyForm.error = errorText(err);
	} finally {
		proxyForm.busy = '';
	}
}

/** 输入了地址就换地址;没输入只改编号范围(不用再输一遍密码) */
function saveProxy(): Promise<void> {
	return runProxy('save', async () => {
		const input = proxyForm.input.trim();
		await saveGlobalProxy(input || undefined, templateMode.value ? rangeBody() : undefined);
		proxyForm.input = '';
		proxyForm.result = null;
		message.success('全局代理已保存');
	});
}

function clearProxy(): Promise<void> {
	return runProxy('clear', async () => {
		await saveGlobalProxy('');
		proxyForm.result = null;
		message.success('已清除全局代理,Steam 请求改为直连');
	});
}

/** 输入框里有地址测输入的(保存前先试),没有测现在的全局代理 */
function checkProxy(): Promise<void> {
	return runProxy('test', async () => {
		proxyForm.result = null;
		proxyForm.result = await testProxy({proxy: proxyForm.input.trim(), ...(templateMode.value ? rangeBody() : {})});
	});
}

async function logout(): Promise<void> {
	try {
		await fetch('/api/auth/logout', {method: 'POST'});
	} catch {
		// 反正都要回登录页
	}
	window.location.href = '/login';
}
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>运行设置</h1>
				<div class="module-counts">
					<span>当前版本:{{ update.current ? 'v' + update.current : '读取中' }}</span>
					<span v-if="latestText">{{ latestText }}</span>
				</div>
			</div>
		</header>
		<NSpace>
			<NButton :loading="checking" :disabled="update.disabled" @click="check">检查更新</NButton>
			<NButton @click="openPassword">修改口令</NButton>
			<NButton @click="logout">退出登录</NButton>
		</NSpace>

		<NCard title="Steam 代理" size="small" class="proxy-card">
			<p class="muted proxy-hint">
				Steam 的登录连接和网页请求(商店、社区、市场、库存、交易报价、充值码)走这个代理;C5、悠悠等国内平台照旧直连。
				单个账号要用别的代理或者不走代理,在「账户管理」的「代理」列里改。改了代理,已登录的账号要重新登录,登录连接才会换。
			</p>
			<p class="muted proxy-hint">
				固定 IP:地址里用 <span class="mono">{n}</span> 代表代理编号(webshare 就是把用户名里的 -rotate 换成 -{n},编号 1 到你的代理数量),
				每个账号分到一个编号一直用,尽量不和别的账号重复;只有新加的账号第一次用、或者手动重新登录时才换一个。
			</p>
			<div class="proxy-current">
				当前:<span v-if="proxy.config.global" class="mono">{{ proxy.config.global }}</span><span v-else class="muted">没有设置,Steam 请求直连</span>
				<span v-if="proxy.config.sticky" class="muted">(固定 IP,编号 {{ proxy.config.range.from }}-{{ proxy.config.range.to }},已分配 {{ Object.keys(proxy.config.assigned).filter(key => key).length }} 个账号)</span>
			</div>
			<NInput
				v-model:value="proxyForm.input"
				placeholder="http://用户名:密码@主机:端口"
				clearable
				:input-props="{autocomplete: 'off', spellcheck: false}"
				@keyup.enter="proxyForm.input.trim() && saveProxy()"
			/>
			<NSpace v-if="templateMode" align="center" :size="6" class="proxy-row">
				<span>编号范围</span>
				<NInputNumber v-model:value="proxyForm.from" :min="1" :max="100000" :precision="0" size="small" class="index-input" />
				<span class="muted">到</span>
				<NInputNumber v-model:value="proxyForm.to" :min="1" :max="100000" :precision="0" size="small" class="index-input" />
			</NSpace>
			<NAlert v-if="proxyForm.error" type="error" :bordered="false" class="proxy-row">{{ proxyForm.error }}</NAlert>
			<template v-else-if="proxyForm.result && steamView">
				<NAlert type="success" :bordered="false" class="proxy-row">
					代理可用:出口 IP <span class="mono">{{ proxyForm.result.ip }}</span>,用时 {{ proxyForm.result.ms }} ms({{ proxyForm.result.proxy }})
				</NAlert>
				<NAlert :type="steamView.type" :bordered="false" class="proxy-row">{{ steamView.text }}</NAlert>
			</template>
			<NSpace class="proxy-row">
				<NButton :loading="proxyForm.busy === 'test'" :disabled="!proxyForm.input.trim() && !proxy.config.global" @click="checkProxy">测试</NButton>
				<NButton type="primary" :loading="proxyForm.busy === 'save'" :disabled="!proxyForm.input.trim() && !rangeChanged" @click="saveProxy">保存</NButton>
				<NButton :loading="proxyForm.busy === 'clear'" :disabled="!proxy.config.global" @click="clearProxy">清除</NButton>
			</NSpace>
		</NCard>

		<NModal v-model:show="password.open" :mask-closable="!password.saving">
			<NCard title="修改访问口令" style="width: 420px" :bordered="false" role="dialog" aria-modal="true">
				<NForm label-placement="top" @submit.prevent="savePassword">
					<NFormItem label="当前口令">
						<NInput v-model:value="password.current" type="password" show-password-on="click" :input-props="{autocomplete: 'current-password'}" />
					</NFormItem>
					<NFormItem label="新口令">
						<NInput v-model:value="password.next" type="password" show-password-on="click" :input-props="{autocomplete: 'new-password'}" />
					</NFormItem>
					<NFormItem label="确认新口令">
						<NInput v-model:value="password.confirm" type="password" show-password-on="click" :input-props="{autocomplete: 'new-password'}" @keyup.enter="savePassword" />
					</NFormItem>
				</NForm>
				<NAlert v-if="password.error" type="error" :bordered="false">{{ password.error }}</NAlert>
				<template #footer>
					<NSpace justify="end">
						<NButton :disabled="password.saving" @click="password.open = false">取消</NButton>
						<NButton type="primary" :loading="password.saving" @click="savePassword">保存</NButton>
					</NSpace>
				</template>
			</NCard>
		</NModal>
	</div>
</template>

<style scoped>
.proxy-card {
	max-width: 680px;
}

.proxy-hint {
	margin: 0 0 10px;
	line-height: 1.6;
}

.proxy-current {
	margin-bottom: 8px;
}

.proxy-row {
	margin-top: 10px;
}

.index-input {
	width: 110px;
}
</style>
