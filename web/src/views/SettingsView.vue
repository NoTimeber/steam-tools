<script setup lang="ts">
// 运行设置:当前版本和检查新版本、修改访问口令、退出登录。
import {computed, reactive, ref} from 'vue';
import {NAlert, NButton, NCard, NForm, NFormItem, NInput, NModal, NSpace, useMessage} from 'naive-ui';
import {api, errorText} from '../api/http.ts';
import {addLog} from '../stores/logs.ts';
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
