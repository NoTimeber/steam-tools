<script setup lang="ts">
// 当前游戏的内购任务(服务端内存里最近的任务 + 推送):状态、成功/失败数,展开看每个账号的结果。
import {h} from 'vue';
import {NDataTable, NTag} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import {formatCents, taskStatus} from '../../lib/purchase.ts';
import type {PurchaseTask} from '../../lib/purchase.ts';

defineProps<{tasks: PurchaseTask[]}>();

type TaskAccount = PurchaseTask['accounts'][number];

function time(value: string | undefined): string {
	const date = new Date(value || '');
	return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', {hour12: false});
}

const accountColumns: DataTableColumns<TaskAccount> = [
	{title: '账号', key: 'account', ellipsis: {tooltip: true}},
	{
		title: '状态',
		key: 'status',
		width: 80,
		render: row => h(NTag, {size: 'small', bordered: false, type: taskStatus(row.status).tone}, () => taskStatus(row.status).label)
	},
	{title: '花费', key: 'cost', width: 100, render: row => (row.totalCostCents ? formatCents(row.totalCostCents, row.currencyISO) : '-')},
	{title: '件数', key: 'totalUnits', width: 60},
	{title: '说明', key: 'error', ellipsis: {tooltip: true}, render: row => row.error || (row.items || []).map(item => `${item.name || item.itemDefId} ×${item.quantity}`).join('、') || '-'}
];

const columns: DataTableColumns<PurchaseTask> = [
	{
		type: 'expand',
		renderExpand: task => h(NDataTable, {size: 'small', columns: accountColumns, data: task.accounts || [], rowKey: (row: TaskAccount) => row.account})
	},
	{title: '创建时间', key: 'createdAt', width: 170, render: task => time(task.createdAt)},
	{
		title: '状态',
		key: 'status',
		width: 90,
		render: task => h(NTag, {size: 'small', bordered: false, type: taskStatus(task.status).tone}, () => taskStatus(task.status).label)
	},
	{title: '账号', key: 'totalAccounts', width: 60},
	{title: '件数', key: 'totalUnits', width: 60},
	{title: '成功/失败', key: 'result', render: task => `${task.successCount || 0} / ${task.failCount || 0}`}
];
</script>

<template>
	<NDataTable size="small" :columns="columns" :data="tasks" :row-key="(task: PurchaseTask) => task.id" :max-height="320">
		<template #empty>
			<span class="muted">还没有任务</span>
		</template>
	</NDataTable>
</template>
