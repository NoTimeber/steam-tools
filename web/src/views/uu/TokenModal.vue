<script setup lang="ts">
// 获取 UU Token:短信登录(下行验证码或上行短信)或手动粘贴。token 按 UU 账号发放,CS2/TF2 通用。
import {ref, watch} from 'vue';
import {NAlert, NButton, NCard, NDivider, NInput, NModal, NSpace, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {closeTokenModal, loginStart, loginVerify, pasteToken, uu} from '../../stores/uu.ts';

const message = useMessage();
const phone = ref('');
const code = ref('');
const pasted = ref('');

watch(() => uu.modal.open, open => {
	if (open) {
		phone.value = '';
		code.value = '';
		pasted.value = '';
	}
});

function start(): void {
	const value = phone.value.trim();
	if (!/^\d{6,15}$/.test(value)) {
		message.warning('请输入正确的手机号');
		return;
	}
	loginStart(value);
}

function verify(): void {
	if (uu.modal.login?.mode === 'sms' && !code.value.trim()) {
		message.warning('请输入短信验证码');
		return;
	}
	loginVerify(code.value.trim());
}

async function paste(): Promise<void> {
	const token = pasted.value.trim();
	if (!token) {
		message.warning('请粘贴 Token');
		return;
	}
	try {
		await pasteToken(token);
	} catch (err) {
		message.error((uu.modal.accountName ? '绑定失败:' : '保存 Token 失败:') + errorText(err));
	}
}
</script>

<template>
	<NModal :show="uu.modal.open" :mask-closable="!uu.modal.busy" @update:show="(show: boolean) => !show && closeTokenModal()">
		<NCard :title="uu.modal.accountName ? `绑定 UU Token:${uu.modal.accountName}` : '获取 UU Token'" style="width: 480px" :bordered="false" closable role="dialog" aria-modal="true" @close="closeTokenModal">
			<p class="muted note">
				{{ uu.modal.accountName ? '拿到的 Token 直接绑到这个账号。' : '拿到 Token 后按它在 UU 绑定的 SteamID 自动匹配「账户管理」里的账号。' }}
				发哪个游戏由账号行里的「CS2发货 / TF2发货」开关分别控制。
			</p>

			<h3>短信登录获取 Token</h3>
			<template v-if="uu.modal.login?.loginSessionId && uu.modal.login.mode === 'sms'">
				<p class="muted">{{ uu.modal.login.message || `验证码已发送至 ${uu.modal.login.phone}` }}</p>
				<NInput v-model:value="code" placeholder="短信验证码" :maxlength="8" :input-props="{inputmode: 'numeric', autocomplete: 'one-time-code'}" @keyup.enter="verify" />
			</template>
			<NAlert v-else-if="uu.modal.login?.loginSessionId && uu.modal.login.mode === 'sms-up'" type="warning" :bordered="false">
				该手机号需要<strong>上行短信</strong>验证:请用本机编辑短信,内容 <strong>{{ uu.modal.login.smsUpContent }}</strong>,
				发送到 <strong>{{ uu.modal.login.smsUpNumber }}</strong>,发送成功后点下方按钮。
			</NAlert>
			<NInput v-else v-model:value="phone" placeholder="手机号(+86,11 位)" :maxlength="15" :input-props="{inputmode: 'numeric'}" @keyup.enter="start" />
			<NAlert v-if="uu.modal.login?.error" type="error" :bordered="false" class="error">{{ uu.modal.login.error }}</NAlert>
			<NSpace justify="end" class="row-actions">
				<NButton v-if="uu.modal.login?.loginSessionId" type="primary" :loading="uu.modal.busy" @click="verify">
					{{ uu.modal.login.mode === 'sms-up' ? '我已发送,登录并绑定' : '登录并绑定' }}
				</NButton>
				<NButton v-else type="primary" :loading="uu.modal.busy" @click="start">发送验证码</NButton>
			</NSpace>

			<NDivider />

			<h3>手动粘贴 Token</h3>
			<NInput v-model:value="pasted" type="textarea" :rows="3" placeholder="eyJ..." :input-props="{spellcheck: false}" />
			<NSpace justify="end" class="row-actions">
				<NButton type="primary" secondary :loading="uu.modal.busy" @click="paste">校验并{{ uu.modal.accountName ? '绑定' : '保存' }}</NButton>
			</NSpace>
		</NCard>
	</NModal>
</template>

<style scoped>
h3 {
	margin: 0 0 8px;
	font-size: 14px;
}

.note {
	margin: 0 0 12px;
	font-size: 12px;
}

.error {
	margin-top: 8px;
}

.row-actions {
	margin-top: 8px;
}
</style>
