<script setup lang="ts">
// C5 扫货设置:app-key(只显示后 4 位,留空不改)、交易链接、策略、风控和轮询。自动扫货都是真实下单,没有模拟。
// 收货账号一般在主页面顶部直接选;这里只给不是本工具里的账号贴交易链接,下面一行显示链接是谁的。
import {computed, reactive, ref, watch} from 'vue';
import {NAlert, NButton, NCard, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NModal, NRadioButton, NRadioGroup, NSpace, NTag, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {describeTradeUrl, receiverC5Note, receiverText} from '../../lib/c5.ts';
import type {C5Receivers, C5Settings} from '../../lib/c5.ts';
import {c5, fetchReceivers, saveSettings} from '../../stores/c5.ts';

const props = defineProps<{show: boolean}>();
const emit = defineEmits<{close: []}>();

const message = useMessage();

const form = reactive({
	appKey: '',
	clearAppKey: false,
	strategy: 'listing' as C5Settings['strategy'],
	tradeUrl: '',
	maxTotalSpend: 0 as number | null,
	maxBuyPerCycle: 10 as number | null,
	minBalanceReserve: 0 as number | null,
	errorCooldownSec: 10 as number | null,
	pollIntervalSec: 3 as number | null,
	timeoutSec: 10 as number | null,
	saving: false,
	error: ''
});

const configured = computed(() => !!c5.state?.configured);

watch(() => props.show, open => {
	const settings = c5.state?.settings;
	if (open && settings) {
		Object.assign(form, {...settings, appKey: '', clearAppKey: false, saving: false, error: ''});
	}
	if (open) {
		loadReceivers();
	}
});

// ===== 交易链接是谁的(认账号、看 C5 绑定要用账号列表) =====
const receivers = ref<C5Receivers | null>(null);

async function loadReceivers(): Promise<void> {
	try {
		receivers.value = await fetchReceivers();
	} catch {
		// 认不出账号就只显示 SteamID
	}
}

/** 当前填的链接是谁的(随输入即时变) */
const current = computed(() => describeTradeUrl(form.tradeUrl.trim(), receivers.value));
const currentNote = computed(() => receiverC5Note(current.value));

function close(): void {
	if (!form.saving) {
		emit('close');
	}
}

async function save(): Promise<void> {
	form.saving = true;
	form.error = '';
	try {
		await saveSettings({
			// 勾了删除就不带输入框里的 key(输入框只是禁用,原来填的值还在)
			appKey: form.clearAppKey ? undefined : form.appKey.trim() || undefined,
			clearAppKey: form.clearAppKey || undefined,
			strategy: form.strategy,
			tradeUrl: form.tradeUrl.trim(),
			maxTotalSpend: form.maxTotalSpend ?? 0,
			maxBuyPerCycle: form.maxBuyPerCycle ?? 10,
			minBalanceReserve: form.minBalanceReserve ?? 0,
			errorCooldownSec: form.errorCooldownSec ?? 10,
			pollIntervalSec: form.pollIntervalSec ?? 3,
			timeoutSec: form.timeoutSec ?? 10
		});
		message.success('设置已保存');
		emit('close');
	} catch (err) {
		form.error = errorText(err) || '保存失败';
	} finally {
		form.saving = false;
	}
}
</script>

<template>
	<NModal :show="show" :mask-closable="!form.saving" @update:show="(value: boolean) => !value && close()">
		<NCard title="C5 扫货设置" style="width: 600px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
			<NForm label-placement="top" size="small" @submit.prevent="save">
				<NFormItem label="C5 app-key">
					<div class="stack">
						<NInput
							v-model:value="form.appKey"
							type="password"
							show-password-on="click"
							:disabled="form.clearAppKey"
							:placeholder="configured ? `已保存(${c5.state?.appKeyMasked}),留空不改` : 'C5GAME 官网 → 个人中心 → API 管理 申请'"
							:input-props="{autocomplete: 'off', spellcheck: false}"
						/>
						<NCheckbox v-if="configured" v-model:checked="form.clearAppKey">删除已保存的 app-key(同时停止扫货)</NCheckbox>
						<span class="muted hint">等同于账号凭证,泄露后别人能直接用你的余额下单。加密存在服务器数据库里,浏览器拿不到原文。</span>
					</div>
				</NFormItem>
				<NFormItem label="收货账号的交易链接(一般直接在主页面顶部选账号;不是本工具里的账号才在这里贴)">
					<div class="stack">
						<NInput v-model:value="form.tradeUrl" placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..." :input-props="{spellcheck: false}" />
						<div v-if="form.tradeUrl.trim()" class="receiver-line">
							<template v-if="current">
								<span>发到:{{ receiverText(current) }}</span>
								<NTag v-if="currentNote && !currentNote.ok" size="small" :bordered="false" type="warning">{{ currentNote.text }}</NTag>
							</template>
							<span v-else class="warn-text">不是交易链接</span>
						</div>
					</div>
				</NFormItem>
				<div class="grid">
					<NFormItem label="策略">
						<NRadioGroup v-model:value="form.strategy">
							<NRadioButton value="listing" title="到价后查在售列表,按在售 id 批量买。在售接口是内测接口,要在官网把服务器公网 IP 加进白名单">按在售列表</NRadioButton>
							<NRadioButton value="quick" title="到价后调快速购买,平台挑最低价,一次一件。不需要在售接口">快速购买</NRadioButton>
						</NRadioGroup>
					</NFormItem>
					<NFormItem label="总预算(开始扫货前必填,第一次建议只放一两个饰品的钱)">
						<NInputNumber v-model:value="form.maxTotalSpend" :min="0" :step="10" />
					</NFormItem>
					<NFormItem label="每轮最多下几单">
						<NInputNumber v-model:value="form.maxBuyPerCycle" :min="1" :max="200" :precision="0" />
					</NFormItem>
					<NFormItem label="余额至少留(不动)">
						<NInputNumber v-model:value="form.minBalanceReserve" :min="0" :step="10" />
					</NFormItem>
					<NFormItem label="下单被拒 / 查在售失败后暂停(秒)">
						<NInputNumber v-model:value="form.errorCooldownSec" :min="0" :max="3600" />
					</NFormItem>
					<NFormItem label="轮询间隔(秒)">
						<NInputNumber v-model:value="form.pollIntervalSec" :min="1" :max="600" />
					</NFormItem>
					<NFormItem label="请求超时(秒)">
						<NInputNumber v-model:value="form.timeoutSec" :min="3" :max="60" />
					</NFormItem>
				</div>
			</NForm>
			<p class="muted hint">
				「按在售列表」用的在售查询是内测接口,要在 C5 官网 API 管理里把这台服务器的公网出口 IP 加进白名单;拿不到权限就用「快速购买」。
				平台默认限流 50 qps,每轮只发 1 个行情请求,到价才多发。
			</p>
			<NAlert v-if="form.error" type="error" :bordered="false">{{ form.error }}</NAlert>
			<template #footer>
				<NSpace justify="end">
					<NButton :disabled="form.saving" @click="close">取消</NButton>
					<NButton type="primary" :loading="form.saving" @click="save">保存</NButton>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.stack {
	display: flex;
	flex-direction: column;
	gap: 6px;
	width: 100%;
}

.grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 0 16px;
}

.grid :deep(.n-input-number) {
	width: 100%;
}

.hint {
	margin: 0 0 8px;
	font-size: 12px;
}

.receiver-line {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	font-size: 13px;
}

.warn-text {
	color: var(--warn);
}
</style>
