<script setup lang="ts">
// C5 扫货设置:app-key(只显示后 4 位,留空不改)、交易链接、模拟 / 实盘、策略、风控和轮询。切实盘要确认。
import {computed, h, reactive, watch} from 'vue';
import {NAlert, NButton, NCard, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NModal, NRadioButton, NRadioGroup, NSpace, useDialog, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {C5Settings} from '../../lib/c5.ts';
import {c5, saveSettings} from '../../stores/c5.ts';

const props = defineProps<{show: boolean}>();
const emit = defineEmits<{close: []}>();

const message = useMessage();
const dialog = useDialog();

const form = reactive({
	appKey: '',
	clearAppKey: false,
	mode: 'dry' as C5Settings['mode'],
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
});

function close(): void {
	if (!form.saving) {
		emit('close');
	}
}

async function doSave(): Promise<void> {
	form.saving = true;
	form.error = '';
	try {
		const before = c5.state?.run;
		const state = await saveSettings({
			// 勾了删除就不带输入框里的 key(输入框只是禁用,原来填的值还在)
			appKey: form.clearAppKey ? undefined : form.appKey.trim() || undefined,
			clearAppKey: form.clearAppKey || undefined,
			mode: form.mode,
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
		if (before === 'sweeping' && state.run === 'watching') {
			message.warning('刚切到实盘,自动扫货已降为只看行情;确认无误后再点「自动扫货」');
		}
		emit('close');
	} catch (err) {
		form.error = errorText(err) || '保存失败';
	} finally {
		form.saving = false;
	}
}

function save(): void {
	if (form.mode === 'live' && c5.state?.settings.mode !== 'live') {
		dialog.warning({
			title: '切到实盘',
			content: () => h('div', {style: 'white-space: pre-wrap'}, '切到实盘后,「自动扫货」会真实下单,花 C5 账户余额。\n'
				+ '正在自动扫货的会先降为「只看行情」,确认设置无误后再手动开始。\n'
				+ '第一次实盘建议把总预算设成一两个饰品的钱,先跑通一笔。'),
			positiveText: '切到实盘并保存',
			negativeText: '取消',
			onPositiveClick: () => {
				doSave();
			}
		});
		return;
	}
	doSave();
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
				<NFormItem label="收货 Steam 账号的交易链接(实盘必填)">
					<NInput v-model:value="form.tradeUrl" placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..." :input-props="{spellcheck: false}" />
				</NFormItem>
				<div class="grid">
					<NFormItem label="模式">
						<NRadioGroup v-model:value="form.mode">
							<NRadioButton value="dry">模拟(只记账)</NRadioButton>
							<NRadioButton value="live">实盘</NRadioButton>
						</NRadioGroup>
					</NFormItem>
					<NFormItem label="策略">
						<NRadioGroup v-model:value="form.strategy">
							<NRadioButton value="listing" title="到价后查在售列表,按在售 id 批量买。在售接口是内测接口,要在官网把服务器公网 IP 加进白名单">按在售列表</NRadioButton>
							<NRadioButton value="quick" title="到价后调快速购买,平台挑最低价,一次一件。不需要在售接口">快速购买</NRadioButton>
						</NRadioGroup>
					</NFormItem>
					<NFormItem label="总预算(实盘必填,模拟下 0 = 不限)">
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
</style>
