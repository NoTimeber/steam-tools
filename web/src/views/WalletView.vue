<script setup lang="ts">
// 充值码兑换:左边账户(账号----密码,可导入 maFile),右边充值码,按行 1:1 对应;下面是逐条结果。
import {h, ref} from 'vue';
import {NButton, NCard, NDataTable, NInput, NInputNumber, NSpace, NTag} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import {maskCode, statusTag} from '../lib/wallet.ts';
import type {ResultRow} from '../lib/wallet.ts';
import {clearAll, counts, importMaFiles, parsed, retryFailed, startRedeem, wallet} from '../stores/wallet.ts';

const fileInput = ref<HTMLInputElement | null>(null);

async function onFiles(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const files = Array.from(input.files || []);
	input.value = '';
	if (files.length) {
		await importMaFiles(files);
	}
}

type Row = ResultRow & {index: number};

const columns: DataTableColumns<Row> = [
	{title: '#', key: 'index', width: 50},
	{title: '账号', key: 'account', width: 160, ellipsis: {tooltip: true}},
	{title: '充值码', key: 'code', width: 160, render: row => h('span', {class: 'mono', title: row.code}, maskCode(row.code))},
	{
		title: '状态',
		key: 'status',
		width: 90,
		render: row => h(NTag, {size: 'small', bordered: false, type: statusTag(row.status).tone}, () => statusTag(row.status).label)
	},
	{title: '详情', key: 'message', ellipsis: {tooltip: true}, render: row => row.message}
];
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>充值码兑换</h1>
				<div class="module-counts">
					<span>账户:{{ parsed.accountTotal }}</span>
					<span>充值码:{{ parsed.codeTotal }}</span>
					<span>配对:{{ parsed.pairs.length }}{{ parsed.issues.length ? `(错位 ${parsed.issues.length})` : '' }}</span>
					<span>成功:{{ counts.success }}</span>
					<span>失败:{{ counts.failed }}</span>
				</div>
			</div>
			<NSpace align="center">
				<NSpace align="center" :size="6" :wrap="false">
					<span class="muted">线程</span>
					<NInputNumber v-model:value="wallet.concurrency" size="small" :min="1" :max="10" :precision="0" :disabled="wallet.running" class="threads" />
				</NSpace>
				<NButton :disabled="wallet.running" @click="clearAll">清空</NButton>
				<NButton :disabled="wallet.running || !counts.failed" @click="retryFailed">重试失败</NButton>
				<NButton type="primary" :loading="wallet.running" @click="startRedeem">开始兑换</NButton>
			</NSpace>
		</header>

		<input ref="fileInput" type="file" accept=".maFile,.json,application/json" multiple hidden @change="onFiles">

		<div class="inputs">
			<NCard size="small" :bordered="false" title="账户">
				<template #header-extra>
					<NButton size="small" :disabled="wallet.running" @click="fileInput?.click()">导入 maFile</NButton>
				</template>
				<p class="hint muted">每行一个,格式:<code>账号----密码</code>;不填密码时用本地 maFile / 会话登录</p>
				<NInput v-model:value="wallet.accountsText" type="textarea" :rows="10" :disabled="wallet.running" placeholder="account1----password1&#10;account2----password2" :input-props="{spellcheck: false}" />
			</NCard>
			<NCard size="small" :bordered="false" title="充值码">
				<template #header-extra>
					<span class="muted">与左侧账户按行 1:1 对应</span>
				</template>
				<p class="hint muted">每行一个充值码</p>
				<NInput v-model:value="wallet.codesText" type="textarea" :rows="10" :disabled="wallet.running" placeholder="XXXXX-XXXXX-XXXXX&#10;YYYYY-YYYYY-YYYYY" :input-props="{spellcheck: false}" />
			</NCard>
		</div>

		<NCard size="small" :bordered="false" title="兑换结果">
			<template #header-extra>
				<span class="muted">{{ wallet.progress }}</span>
			</template>
			<NDataTable size="small" :columns="columns" :data="wallet.results.map((row, index) => ({...row, index: index + 1}))" :row-key="(row: Row) => row.index" :max-height="420">
				<template #empty>
					<span class="muted">填写账户与充值码后点击「开始兑换」</span>
				</template>
			</NDataTable>
		</NCard>
	</div>
</template>

<style scoped>
.threads {
	width: 90px;
}

.inputs {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 16px;
}

.hint {
	margin: 0 0 8px;
	font-size: 12px;
}

@media (max-width: 1100px) {
	.inputs {
		grid-template-columns: 1fr;
	}
}
</style>
