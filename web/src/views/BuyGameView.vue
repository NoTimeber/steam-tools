<script setup lang="ts">
// 买游戏:多选账号 + 按 subid 加游戏,用钱包余额协议购买(可先试运行只验证到最终价、不扣款);右边是最近一个任务的逐账号结果。
import {computed, h, onMounted, onUnmounted, ref} from 'vue';
import {NAlert, NButton, NCard, NCheckbox, NDataTable, NInput, NInputNumber, NSelect, NSpace, NTag, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns, SelectOption} from 'naive-ui';
import {formatBalance} from '../lib/accounts.ts';
import {accountDetail, accountStatus, formatGamePrice, formatMoney, taskProgress} from '../lib/buygame.ts';
import type {BuyGameTask, GameEntry} from '../lib/buygame.ts';
import {
	addSubids, buygame, enterBuyGame, latestTask, leaveBuyGame, pricingCurrency, readyGames, refreshAccounts, removeGame,
	selectedAccounts, setSelected, submitPurchase
} from '../stores/buygame.ts';

const message = useMessage();
const dialog = useDialog();

onMounted(enterBuyGame);
onUnmounted(leaveBuyGame);

const accountOptions = computed<SelectOption[]>(() => buygame.accounts.map(account => ({
	value: account.account,
	label: `${account.account} · 余额 ${formatBalance(account)}`
})));

const placeholder = computed(() => {
	if (buygame.accounts.length) return '请选择在线账户';
	if (buygame.loadingAccounts) return '正在加载在线账户...';
	if (buygame.accountError) return buygame.accountError;
	return '暂无在线账户,先在账户页登录';
});

// ===== 加游戏 =====
const subidText = ref('');
const adding = ref(false);

async function add(): Promise<void> {
	const text = subidText.value;
	if (!text.trim()) {
		return;
	}
	subidText.value = '';
	adding.value = true;
	try {
		const added = await addSubids(text);
		if (!added) {
			message.warning('请输入有效的 subid(已添加的会跳过)');
		}
	} finally {
		adding.value = false;
	}
}

const gameColumns: DataTableColumns<GameEntry> = [
	{
		title: '游戏',
		key: 'name',
		ellipsis: {tooltip: true},
		render: game => h('div', {class: 'game-name'}, [
			h('strong', game.name || `subid ${game.packageId}`),
			h('span', {class: 'muted'}, `subid ${game.packageId}${game.appid ? ' · app ' + game.appid : ''}`)
		])
	},
	{
		title: '价格',
		key: 'price',
		width: 150,
		render: game => h('span', {class: game.error ? 'error-text' : ''}, formatGamePrice(game, pricingCurrency.value))
	},
	{
		title: '',
		key: 'remove',
		width: 60,
		render: game => h(NButton, {size: 'tiny', quaternary: true, onClick: () => removeGame(game.packageId)}, () => '移除')
	}
];

// ===== 购买 =====
const canBuy = computed(() => !buygame.submitting && selectedAccounts.value.length > 0 && readyGames.value.length > 0);

function buy(): void {
	if (!selectedAccounts.value.length) {
		message.warning('请先选择购买账户');
		return;
	}
	if (!readyGames.value.length) {
		message.warning('请先添加要购买的游戏');
		return;
	}
	if (buygame.dryRun) {
		submitPurchase();
		return;
	}
	const perAccount = readyGames.value.reduce((sum, game) => sum + Number(game.priceCents || 0), 0);
	dialog.warning({
		title: '确认真实购买',
		content: `将用 ${selectedAccounts.value.length} 个账号、每个账号购买 ${readyGames.value.length} 款游戏。每账号约 ${formatMoney(perAccount, pricingCurrency.value, readyGames.value[0]?.currencyISO || '')}(最终以各自区域价为准),用钱包余额真实扣款且不可逆。确认购买?`,
		positiveText: '确认购买',
		negativeText: '取消',
		onPositiveClick: () => {
			submitPurchase();
		}
	});
}

// ===== 结果 =====
type ResultRow = BuyGameTask['accounts'][number] & {index: number};

const resultRows = computed<ResultRow[]>(() => (latestTask.value?.accounts || []).map((account, index) => ({...account, index: index + 1})));

const resultColumns: DataTableColumns<ResultRow> = [
	{title: '#', key: 'index', width: 44},
	{title: '账号', key: 'account', ellipsis: {tooltip: true}},
	{
		title: '状态',
		key: 'status',
		width: 90,
		render: row => h(NTag, {size: 'small', bordered: false, type: accountStatus(row.status).tone}, () => accountStatus(row.status).label)
	},
	{title: '花费', key: 'spent', width: 100, render: row => (row.spentCents != null ? formatMoney(row.spentCents, row.currency, row.currencyISO) : '-')},
	{title: '详情', key: 'detail', ellipsis: {tooltip: true}, render: row => accountDetail(row, !!latestTask.value?.dryRun)}
];
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>买游戏</h1>
				<div class="module-counts">
					<span>在线账户:{{ buygame.accounts.length }}</span>
					<span>已选账户:{{ selectedAccounts.length }}</span>
					<span>游戏:{{ buygame.games.length }}</span>
					<span>任务数:{{ buygame.tasks.length }}</span>
				</div>
			</div>
			<NButton :loading="buygame.loadingAccounts" @click="refreshAccounts()">刷新账户</NButton>
		</header>

		<div class="buygame-layout">
			<NCard size="small" :bordered="false" title="购买配置">
				<div class="form">
					<label class="field-label">购买账户(可多选;价格按第一个选的账号所在区域解析)</label>
					<div class="picker">
						<NSelect
							multiple
							filterable
							max-tag-count="responsive"
							:value="buygame.selected"
							:options="accountOptions"
							:placeholder="placeholder"
							:disabled="!buygame.accounts.length"
							@update:value="setSelected"
						/>
						<NButton size="small" quaternary :disabled="!buygame.accounts.length" @click="setSelected(buygame.accounts.map(account => account.account))">全选</NButton>
						<NButton size="small" quaternary :disabled="!buygame.selected.length" @click="setSelected([])">清空选择</NButton>
					</div>

					<label class="field-label">游戏 subid(packageid)</label>
					<div class="add-row">
						<NInput v-model:value="subidText" placeholder="输入 subid 回车添加,可逗号分隔多个" @keyup.enter="add" />
						<NButton :loading="adding" @click="add">添加</NButton>
					</div>
					<p class="hint muted">subid(包 ID)可在 SteamDB / 商店页查到。</p>

					<NDataTable size="small" :columns="gameColumns" :data="buygame.games" :row-key="(game: GameEntry) => game.packageId" :max-height="320">
						<template #empty>
							<span class="muted">还没有添加游戏,输入 subid 添加</span>
						</template>
					</NDataTable>

					<div class="actions">
						<NSpace align="center" :size="6" title="同时购买的并发线程数(默认 3)">
							<span class="muted">线程</span>
							<NInputNumber v-model:value="buygame.concurrency" size="small" :min="1" :max="10" :precision="0" class="threads" />
						</NSpace>
						<NCheckbox v-model:checked="buygame.dryRun">试运行(只验证到最终价,不扣款)</NCheckbox>
						<NButton type="primary" :disabled="!canBuy" :loading="buygame.submitting" @click="buy">{{ buygame.dryRun ? '试运行' : '购买' }}</NButton>
					</div>
				</div>
			</NCard>

			<NCard size="small" :bordered="false" title="购买结果">
				<template #header-extra>
					<span class="muted">{{ latestTask ? taskProgress(latestTask) : '未开始' }}</span>
				</template>
				<NAlert v-if="latestTask?.dryRun" type="info" :bordered="false" class="dry-run-note">这是试运行结果:只验证到最终价,没有扣款。</NAlert>
				<NDataTable size="small" :columns="resultColumns" :data="resultRows" :row-key="(row: ResultRow) => row.account + row.index" :max-height="480">
					<template #empty>
						<span class="muted">选择账户与游戏后点击「购买」</span>
					</template>
				</NDataTable>
			</NCard>
		</div>
	</div>
</template>

<style scoped>
.buygame-layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	gap: 16px;
	align-items: start;
}

.form {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.field-label {
	color: var(--muted);
	font-size: 13px;
}

.picker {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto auto;
	gap: 6px;
	align-items: center;
}

.add-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: 6px;
}

.hint {
	margin: 0;
	font-size: 12px;
}

.actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: flex-end;
	gap: 12px;
	margin-top: 4px;
}

.threads {
	width: 90px;
}

.dry-run-note {
	margin-bottom: 8px;
}

.error-text {
	color: var(--danger);
}

:deep(.game-name) {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

:deep(.game-name span) {
	font-size: 12px;
}

@media (max-width: 1280px) {
	.buygame-layout {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
