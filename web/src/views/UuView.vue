<script setup lang="ts">
// UU 发货:已绑定 token 的账号(在线提示、CS2/TF2 发货开关、CS2 自动上架、统计)+ 还没匹配到账号的 token;
// 展开看最近发货记录和日志。顶部可改轮询间隔、获取 Token。
import {computed, h, onMounted, ref, watch} from 'vue';
import {NButton, NDataTable, NInputNumber, NSpace, NSwitch, NTag, useDialog, useMessage} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import {errorText} from '../api/http.ts';
import {CS2, TF2, deliveryStatus, formatInterval, intervalMinutes, onlineHint, statsText, tokenHint, uuCounts} from '../lib/uu.ts';
import type {UuAccount, UuRow} from '../lib/uu.ts';
import {accounts as accountList, loginAccount} from '../stores/accounts.ts';
import {
	deleteAccountToken, deleteTokenById, enterUu, listScan, openTokenModal, refreshState, rows, savePollInterval, setAuto, setListAuto, uu
} from '../stores/uu.ts';
import TokenModal from './uu/TokenModal.vue';

const message = useMessage();
const dialog = useDialog();

onMounted(enterUu);

const counts = computed(() => uuCounts(uu.accounts));

// ===== 轮询间隔 =====
const pollMinutes = ref<number | null>(null);
watch(() => uu.pollIntervalMs, ms => {
	pollMinutes.value = intervalMinutes(ms);
}, {immediate: true});

async function savePoll(): Promise<void> {
	const minutes = Number(pollMinutes.value);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		message.warning('请输入有效的轮询分钟数(最少 0.5 分钟)');
		return;
	}
	try {
		await savePollInterval(minutes);
		message.success(`轮询间隔已设为 ${formatInterval(uu.pollIntervalMs)}`);
	} catch (err) {
		message.error('设置失败:' + errorText(err));
	}
}

// ===== 行内操作 =====
const busy = ref('');

async function guard(key: string, action: () => Promise<void>, failure: string): Promise<void> {
	busy.value = key;
	try {
		await action();
	} catch (err) {
		message.error(failure + errorText(err));
	} finally {
		busy.value = '';
	}
}

async function loginRow(accountName: string): Promise<void> {
	const local = accountList.rows.find(row => row.key === accountName.toLowerCase());
	if (!local) {
		message.warning(`「账户管理」里没有账号 ${accountName},请先添加该账号`);
		return;
	}
	// force:这里的离线判断来自后端发货就绪状态,账户列表上的「登录成功」可能还没回退
	await guard('login:' + accountName, async () => {
		await loginAccount(local, {force: true});
		await refreshState();
	}, '登录失败:');
}

function confirmDeleteAccountToken(accountName: string): void {
	dialog.warning({
		title: '删除 Token',
		content: `确定删除账号「${accountName}」已获取的 Token?删除后将取消该账号自动发货。`,
		positiveText: '删除',
		negativeText: '取消',
		onPositiveClick: () => guard('delete:' + accountName, () => deleteAccountToken(accountName), '删除失败:')
	});
}

function confirmDeleteToken(tokenId: string): void {
	dialog.warning({
		title: '删除 Token',
		content: '确定删除这个尚未匹配到账号的 UU Token?',
		positiveText: '删除',
		negativeText: '取消',
		onPositiveClick: () => guard('token:' + tokenId, () => deleteTokenById(tokenId), '删除失败:')
	});
}

function toggle(account: UuAccount, kind: 'cs2' | 'tf2' | 'list', enabled: boolean): void {
	const action = kind === 'list' ? () => setListAuto(account.accountName, enabled) : () => setAuto(account.accountName, kind === 'cs2' ? CS2 : TF2, enabled);
	guard(`${kind}:${account.accountName}`, action, '操作失败:');
}

function time(value: string): string {
	const date = new Date(value || '');
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', {hour12: false});
}

// ===== 表格 =====
function switchCell(account: UuAccount, kind: 'cs2' | 'tf2' | 'list', label: string, value: boolean) {
	return h('label', {class: 'switch'}, [
		h(NSwitch, {size: 'small', value, loading: busy.value === `${kind}:${account.accountName}`, 'onUpdate:value': (next: boolean) => toggle(account, kind, next)}),
		h('span', label)
	]);
}

function expand(row: UuRow) {
	if (row.kind !== 'account') return null;
	const account = row.account;
	const errors = [account.delivery?.[CS2], account.delivery?.[TF2]].filter(game => game?.lastError).map(game => `${game!.gameLabel}:${game!.lastError}`);
	if (account.listLastError) errors.push(`上架:${account.listLastError}`);
	return h('div', {class: 'detail'}, [
		errors.length ? h('div', {class: 'detail-errors'}, errors.map(text => h('div', text))) : null,
		h('div', {class: 'detail-columns'}, [
			h('div', [
				h('h4', '最近发货'),
				account.recentOrders.length
					? account.recentOrders.map(order => h('div', {class: 'detail-line'}, [
						h('span', {class: 'muted'}, time(order.at)),
						h(NTag, {size: 'tiny', bordered: false, type: order.ok ? 'success' : 'error'}, () => (order.ok ? '成功' : '失败')),
						h('span', `${order.itemName || order.orderNo}${order.ok ? '' : ' — ' + order.reason}`)
					]))
					: h('div', {class: 'muted'}, '暂无')
			]),
			h('div', [
				h('h4', '最近日志'),
				account.logs.length
					? account.logs.slice(-12).reverse().map(log => h('div', {class: 'detail-line log-' + log.level}, `${time(log.time)} ${log.message}`))
					: h('div', {class: 'muted'}, '暂无')
			])
		])
	]);
}

const columns: DataTableColumns<UuRow> = [
	{type: 'expand', expandable: row => row.kind === 'account', renderExpand: expand},
	{
		title: '账号',
		key: 'name',
		width: 140,
		ellipsis: {tooltip: true},
		render: row => (row.kind === 'account' ? row.account.accountName : row.token.nickname || row.token.userId || '(无昵称)')
	},
	{
		title: 'UU',
		key: 'uu',
		width: 130,
		ellipsis: {tooltip: true},
		render: row => {
			if (row.kind === 'token') return h('span', {class: 'muted'}, 'UU Token');
			if (!row.account.bound) return h('span', {class: 'muted'}, '未绑定');
			return h('span', {title: row.account.tokenExpiresAt ? `Token 有效期至 ${new Date(row.account.tokenExpiresAt).toLocaleString('zh-CN', {hour12: false})}` : undefined}, [
				row.account.nickname || '(无昵称)',
				row.account.tokenExpired ? h(NTag, {size: 'tiny', type: 'error', bordered: false, class: 'inline-tag'}, () => '已过期') : null
			]);
		}
	},
	{
		title: '在线',
		key: 'online',
		width: 120,
		render: row => {
			if (row.kind === 'token') return h(NTag, {size: 'small', bordered: false}, () => tokenHint(row.token, row.local, row.holder, uu.bindErrors[row.token.id]).tag);
			const hint = onlineHint(row.account, row.local);
			return h(NTag, {size: 'small', bordered: false, type: hint.tone, title: hint.title}, () => hint.text);
		}
	},
	{
		title: '发货状态',
		key: 'status',
		width: 150,
		render: row => {
			if (row.kind !== 'account' || !row.account.bound) return null;
			const tags = [CS2, TF2].map(gid => {
				const game = row.account.delivery?.[gid];
				const status = deliveryStatus(game?.status || 'idle');
				return h(NTag, {size: 'small', bordered: false, type: status.tone, title: game?.lastError || undefined}, () => `${gid === CS2 ? 'CS2' : 'TF2'} ${status.label}`);
			});
			if (row.account.listStatus === 'listing') tags.push(h(NTag, {size: 'small', bordered: false, type: 'warning'}, () => '上架中'));
			if (row.account.listStatus === 'error') tags.push(h(NTag, {size: 'small', bordered: false, type: 'error', title: row.account.listLastError}, () => '上架错误'));
			return h(NSpace, {size: 4}, () => tags);
		}
	},
	{
		title: '开关',
		key: 'switches',
		width: 260,
		render: row => {
			if (row.kind !== 'account') return null;
			const account = row.account;
			if (!account.bound) {
				return h(NButton, {size: 'small', type: 'primary', onClick: () => openTokenModal(account.accountName)}, () => '绑定 Token');
			}
			return h('div', {class: 'switches'}, [
				switchCell(account, 'cs2', 'CS2发货', !!account.delivery?.[CS2]?.auto),
				switchCell(account, 'tf2', 'TF2发货', !!account.delivery?.[TF2]?.auto),
				switchCell(account, 'list', '自动上架(CS2)', account.listAuto)
			]);
		}
	},
	{
		title: '统计',
		key: 'stats',
		minWidth: 220,
		ellipsis: {tooltip: true},
		render: row => {
			if (row.kind === 'token') return h('span', {class: 'muted'}, tokenHint(row.token, row.local, row.holder, uu.bindErrors[row.token.id]).hint);
			if (!row.account.bound) return h('span', {class: 'muted'}, '点右侧按钮获取并绑定 UU Token');
			const lastScan = row.account.delivery?.[CS2]?.lastScanAt || row.account.delivery?.[TF2]?.lastScanAt || '';
			return `${statsText(row.account)}${lastScan ? ' · ' + time(lastScan) : ''}`;
		}
	},
	{
		title: '操作',
		key: 'actions',
		width: 230,
		render: row => {
			if (row.kind === 'token') {
				return h(NButton, {size: 'small', type: 'error', secondary: true, loading: busy.value === 'token:' + row.token.id, onClick: () => confirmDeleteToken(row.token.id)}, () => '删除 Token');
			}
			const account = row.account;
			return h(NSpace, {size: 6, wrap: false}, () => [
				!account.online && row.local
					? h(NButton, {size: 'small', type: 'primary', loading: busy.value === 'login:' + account.accountName, onClick: () => loginRow(account.accountName)}, () => '登录账户')
					: null,
				account.bound
					? h(NButton, {size: 'small', loading: busy.value === 'scan:' + account.accountName, onClick: () => guard('scan:' + account.accountName, () => listScan(account.accountName), '上架失败:')}, () => '立即上架')
					: null,
				account.bound
					? h(NButton, {size: 'small', type: 'error', secondary: true, loading: busy.value === 'delete:' + account.accountName, onClick: () => confirmDeleteAccountToken(account.accountName)}, () => '删除 Token')
					: null
			]);
		}
	}
];
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>UU发货</h1>
				<div class="module-counts">
					<span>账号:{{ counts.total }}</span>
					<span>已绑定:{{ counts.bound }}</span>
					<span>在线:{{ counts.online }} / {{ counts.total }}</span>
					<span>累计发货:{{ counts.delivered }}</span>
					<span>轮询:{{ formatInterval(uu.pollIntervalMs) }}</span>
				</div>
			</div>
			<NSpace align="center">
				<NSpace align="center" :size="6" :wrap="false">
					<span class="muted">轮询间隔</span>
					<NInputNumber v-model:value="pollMinutes" size="small" :min="0.5" :max="120" :step="1" class="poll-input" />
					<span class="muted">分钟</span>
					<NButton size="small" @click="savePoll">保存</NButton>
				</NSpace>
				<NButton :loading="uu.loading" @click="refreshState">刷新</NButton>
				<NButton type="primary" @click="openTokenModal()">获取 Token</NButton>
			</NSpace>
		</header>

		<div class="module-body">
			<NDataTable
				class="uu-table"
				flex-height
				size="small"
				:columns="columns"
				:data="rows"
				:row-key="(row: UuRow) => row.key"
				:loading="uu.loading && !uu.loaded"
				:scroll-x="1180"
			>
				<template #empty>
					<span :class="uu.error ? 'error-text' : 'muted'">{{ uu.error || '暂无 UU Token,点右上角「获取 Token」;获取后会按 UU 绑定的 SteamID 自动匹配「账户管理」里的账号' }}</span>
				</template>
			</NDataTable>
		</div>

		<TokenModal />
	</div>
</template>

<style scoped>
.module-body {
	display: flex;
	flex-direction: column;
}

.uu-table {
	flex: 1;
	min-height: 260px;
}

.poll-input {
	width: 90px;
}

.error-text {
	color: var(--danger);
}

:deep(.switches) {
	display: flex;
	flex-wrap: wrap;
	gap: 6px 12px;
}

:deep(.switch) {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 12px;
	white-space: nowrap;
}

:deep(.inline-tag) {
	margin-left: 6px;
}

:deep(.detail) {
	display: flex;
	flex-direction: column;
	gap: 8px;
	font-size: 12px;
}

:deep(.detail-errors) {
	color: var(--danger);
}

:deep(.detail-columns) {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 16px;
}

:deep(.detail h4) {
	margin: 0 0 4px;
	font-size: 12px;
}

:deep(.detail-line) {
	display: flex;
	gap: 6px;
	align-items: center;
	line-height: 1.7;
}

:deep(.log-error) {
	color: var(--danger);
}

:deep(.log-warn) {
	color: var(--warn);
}

:deep(.log-success) {
	color: var(--ok);
}
</style>
