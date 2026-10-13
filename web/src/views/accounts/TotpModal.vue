<script setup lang="ts">
// 令牌验证码:每秒倒计时,到期自动取下一个。
import {onBeforeUnmount, reactive, watch} from 'vue';
import {NButton, NCard, NModal, NSpace} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {fetchAuthCode} from '../../stores/accounts.ts';

const props = defineProps<{accountName: string}>();
const emit = defineEmits<{close: []}>();

const totp = reactive({code: '', expiresIn: 0, loading: false, error: ''});
let timer: number | undefined;

async function refresh(): Promise<void> {
	if (!props.accountName) {
		return;
	}
	totp.loading = true;
	totp.error = '';
	try {
		const data = await fetchAuthCode(props.accountName);
		totp.code = data.code || '';
		totp.expiresIn = Number(data.expiresIn || 0);
	} catch (err) {
		totp.code = '';
		totp.expiresIn = 0;
		totp.error = errorText(err) || '读取验证码失败';
	} finally {
		totp.loading = false;
	}
}

function stop(): void {
	window.clearInterval(timer);
	timer = undefined;
}

watch(() => props.accountName, name => {
	stop();
	Object.assign(totp, {code: '', expiresIn: 0, error: ''});
	if (!name) {
		return;
	}
	refresh();
	timer = window.setInterval(() => {
		if (totp.loading || totp.error) {
			return;
		}
		if (totp.expiresIn > 1) {
			totp.expiresIn--;
		} else {
			refresh();
		}
	}, 1000);
}, {immediate: true});

onBeforeUnmount(stop);

async function copy(): Promise<void> {
	try {
		await navigator.clipboard.writeText(totp.code);
	} catch {
		// 非安全上下文(http 非本机)不能写剪贴板,用户手抄即可
	}
}
</script>

<template>
	<NModal :show="!!accountName" @update:show="(show: boolean) => !show && emit('close')">
		<NCard :title="`${accountName} 登录验证码`" style="width: 360px" :bordered="false" role="dialog" aria-modal="true">
			<div class="totp-code mono" @click="copy">{{ totp.loading && !totp.code ? '读取中...' : (totp.code || '-----') }}</div>
			<div class="totp-meta muted">{{ totp.error || `剩余 ${Math.max(0, totp.expiresIn)} 秒(点验证码复制)` }}</div>
			<template #footer>
				<NSpace justify="end">
					<NButton :loading="totp.loading" @click="refresh">刷新</NButton>
					<NButton @click="emit('close')">关闭</NButton>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.totp-code {
	font-size: 40px;
	font-weight: 600;
	letter-spacing: 8px;
	text-align: center;
	cursor: copy;
}

.totp-meta {
	margin-top: 6px;
	text-align: center;
}
</style>
