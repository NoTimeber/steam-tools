<script setup lang="ts">
// ECO 扫货设置:PartnerId、RSA 私钥(浏览器拿不到原文,留空不改;也可以让服务器生成一对,把公钥填到 ECO 开放平台)、
// 交易链接、策略、风控和轮询。自动扫货都是真实下单,没有模拟。
// 收货账号一般在主页面顶部从 ECO 绑定的账号里选;这里可以直接贴交易链接,下面一行显示链接是谁的。
import {computed, reactive, ref, watch} from 'vue';
import {
	NAlert, NButton, NCard, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NModal, NRadioButton, NRadioGroup, NSpace, NTag, useDialog, useMessage
} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {copyText} from '../../components/clipboard.ts';
import {describeTradeUrl, receiverEcoNote, receiverText} from '../../lib/eco.ts';
import type {EcoReceivers, EcoSettings} from '../../lib/eco.ts';
import {eco, fetchReceivers, generateKeyPair, saveSettings} from '../../stores/eco.ts';

const props = defineProps<{show: boolean}>();
const emit = defineEmits<{close: []}>();

const message = useMessage();
const dialog = useDialog();

/** 两种下单方式的说明,显示在选项下面 */
const STRATEGY_HINT: Record<EcoSettings['strategy'], string> = {
	listing: '到价后查在售列表,按商品编号从低价往上逐件买',
	quick: '到价后让平台挑一件不高于目标价的,一次一件;不用查在售'
};

const form = reactive({
	partnerId: '',
	privateKey: '',
	clearCredentials: false,
	strategy: 'listing' as EcoSettings['strategy'],
	tradeUrl: '',
	maxTotalSpend: 0 as number | null,
	maxBuyPerCycle: 10 as number | null,
	minBalanceReserve: 0 as number | null,
	errorCooldownSec: 10 as number | null,
	pollIntervalSec: 5 as number | null,
	timeoutSec: 10 as number | null,
	saving: false,
	generating: false,
	error: ''
});

const state = computed(() => eco.state);
/** 存过 PartnerId 或私钥(能删) */
const hasCredentials = computed(() => !!state.value && (!!state.value.partnerId || !!state.value.publicKey || !!state.value.keyError));
const sweeping = computed(() => state.value?.run === 'sweeping');

watch(() => props.show, open => {
	const settings = state.value?.settings;
	if (open && settings) {
		Object.assign(form, {
			...settings, partnerId: state.value?.partnerId ?? '', privateKey: '', clearCredentials: false, saving: false, generating: false, error: ''
		});
	}
	if (open) {
		loadReceivers();
	}
});

// ===== 交易链接是谁的(认账号、看 ECO 绑定要用账号列表) =====
const receivers = ref<EcoReceivers | null>(null);

async function loadReceivers(): Promise<void> {
	try {
		receivers.value = await fetchReceivers();
	} catch {
		// 认不出账号就只显示 SteamID
	}
}

/** 当前填的链接是谁的(随输入即时变) */
const current = computed(() => describeTradeUrl(form.tradeUrl.trim(), receivers.value));
const currentNote = computed(() => receiverEcoNote(current.value, form.tradeUrl));

// ===== 密钥对 =====

async function copyPublicKey(): Promise<void> {
	const key = state.value?.publicKey;
	if (!key) {
		return;
	}
	try {
		await copyText(key);
		message.success('公钥已复制');
	} catch (err) {
		message.error('复制失败:' + errorText(err));
	}
}

function confirmGenerate(): void {
	const replacing = !!state.value?.publicKey || !!state.value?.keyError;
	dialog.warning({
		title: '生成新的 RSA 密钥对',
		content: replacing
			? '会替换现在保存的私钥,旧公钥立即失效:要把新公钥重新填到 ECO 开放平台,填好之前调不了 ECO 接口。确定生成?'
			: '服务器生成一对 RSA 密钥,私钥加密存在服务器上,公钥显示在这里,要填到 ECO 开放平台。确定生成?',
		positiveText: '生成',
		negativeText: '取消',
		onPositiveClick: async () => {
			form.generating = true;
			form.error = '';
			try {
				await generateKeyPair();
				// 输入框里贴过的私钥作废,免得保存时又把新生成的换掉
				form.privateKey = '';
				form.clearCredentials = false;
				message.success('已生成新密钥对,把公钥填到 ECO 开放平台');
			} catch (err) {
				form.error = errorText(err) || '生成密钥失败';
			} finally {
				form.generating = false;
			}
		}
	});
}

function close(): void {
	if (!form.saving) {
		emit('close');
	}
}

async function save(): Promise<void> {
	form.saving = true;
	form.error = '';
	try {
		const partnerId = form.partnerId.trim();
		await saveSettings({
			// 勾了删除就不带输入框里的值(输入框只是禁用,原来填的值还在);没改的不带
			partnerId: form.clearCredentials || !partnerId || partnerId === state.value?.partnerId ? undefined : partnerId,
			privateKey: form.clearCredentials ? undefined : form.privateKey.trim() || undefined,
			clearCredentials: form.clearCredentials || undefined,
			strategy: form.strategy,
			tradeUrl: form.tradeUrl.trim(),
			maxTotalSpend: form.maxTotalSpend ?? 0,
			maxBuyPerCycle: form.maxBuyPerCycle ?? 10,
			minBalanceReserve: form.minBalanceReserve ?? 0,
			errorCooldownSec: form.errorCooldownSec ?? 10,
			pollIntervalSec: form.pollIntervalSec ?? 5,
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
		<NCard title="ECO 扫货设置" style="width: 640px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
			<NForm label-placement="top" size="small" @submit.prevent="save">
				<NFormItem label="PartnerId">
					<NInput
						v-model:value="form.partnerId"
						:disabled="form.clearCredentials"
						placeholder="ECO 开放平台填好公钥后给的 PartnerId"
						:input-props="{autocomplete: 'off', spellcheck: false}"
					/>
				</NFormItem>
				<NFormItem label="RSA 私钥">
					<div class="stack">
						<NInput
							v-model:value="form.privateKey"
							type="textarea"
							:autosize="{minRows: 2, maxRows: 6}"
							:disabled="form.clearCredentials"
							:placeholder="state?.publicKey ? '已保存,留空不改;要换就贴新的私钥(PEM 或 base64)' : '贴自己的 RSA 私钥(PEM 或 base64),或者点下面「生成新密钥对」'"
							:input-props="{autocomplete: 'off', spellcheck: false}"
						/>
						<NAlert v-if="state?.keyError" type="error" :bordered="false">存的私钥用不了:{{ state.keyError }}。重新贴一个私钥,或者生成新密钥对。</NAlert>
						<NSpace align="center" :size="8">
							<NButton size="small" :loading="form.generating" :disabled="sweeping || form.saving" @click="confirmGenerate">生成新密钥对</NButton>
							<span v-if="sweeping" class="muted hint-inline">正在自动扫货,先停止才能换密钥</span>
						</NSpace>
						<NCheckbox v-if="hasCredentials" v-model:checked="form.clearCredentials">删除已保存的 PartnerId 和私钥(同时停止扫货)</NCheckbox>
						<span class="muted hint-inline">私钥等同于账号凭证,泄露后别人能直接用你的余额下单。加密存在服务器数据库里,浏览器拿不到原文。</span>
					</div>
				</NFormItem>
				<NFormItem v-if="state?.publicKey" label="公钥">
					<div class="stack">
						<NInput :value="state.publicKey" type="textarea" readonly :autosize="{minRows: 2, maxRows: 4}" :input-props="{spellcheck: false}" class="mono" />
						<NSpace align="center" :size="8">
							<NButton size="small" @click="copyPublicKey">复制公钥</NButton>
							<span class="muted hint-inline">把公钥填到 ECO 开放平台的「RSA 公钥」里,拿到 PartnerId</span>
						</NSpace>
					</div>
				</NFormItem>
				<NFormItem label="收货账号的交易链接(一般在主页面顶部从 ECO 绑定的账号里选;这里可以直接贴链接)">
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
							<NRadioButton value="listing">按在售列表</NRadioButton>
							<NRadioButton value="quick">快速购买</NRadioButton>
						</NRadioGroup>
						<template #feedback>
							<span class="muted">{{ STRATEGY_HINT[form.strategy] }}</span>
						</template>
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
				下单要先在 ECO 开放平台开通「购买权限」。ECO 开放平台可能设了 IP 白名单:报 4004 不在IP白名单时,把这台服务器的公网出口 IP 加进去。
				每轮只发 1 个批量查价请求(每个游戏一个),到价才多发;平台嫌太快会回 6001,自动退避。
			</p>
			<NAlert v-if="form.error" type="error" :bordered="false">{{ form.error }}</NAlert>
			<template #footer>
				<NSpace justify="end">
					<NButton :disabled="form.saving" @click="close">取消</NButton>
					<NButton type="primary" :loading="form.saving" :disabled="form.generating" @click="save">保存</NButton>
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

.hint-inline {
	font-size: 12px;
}

.mono :deep(textarea) {
	font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
	font-size: 12px;
	word-break: break-all;
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
