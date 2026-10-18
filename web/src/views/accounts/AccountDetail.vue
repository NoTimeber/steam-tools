<script setup lang="ts">
// 账户详情:在账户列表点账户名进来(照 SteamLabs 的账户页)。
// 「概览」一列卡片:个人资料、钱包、会话、Steam Guard、游戏协调器;「日志」是这次会话的登录日志(按天分组,新的在前)。
// 页头(面包屑、标题、操作按钮)在 AccountsView。数据来自 GET /api/accounts/detail,这个账号有推送(attempt:update)就重新拉。
import {computed, onMounted, onUnmounted, ref, watch} from 'vue';
import {NAlert, NSpin, NTab, NTabs, NTag, NTooltip, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {socket} from '../../api/socket.ts';
import type {AccountDetail, PublicAttempt} from '../../api/types.ts';
import AppIcon from '../../components/AppIcon.vue';
import {copyText} from '../../components/clipboard.ts';
import {SESSION_LABEL, STATUS_TAG, formatBalance, formatDateTime, fromNow, groupLogsByDay, logLevel} from '../../lib/accounts.ts';
import {accountProxyView} from '../../lib/proxy.ts';
import {accounts, fetchAccountDetail, groupName} from '../../stores/accounts.ts';
import {authCodeSecondsLeft, authCodes, watchAuthCodes} from '../../stores/authcodes.ts';
import {loadProxies, proxy} from '../../stores/proxy.ts';

const props = defineProps<{accountName: string}>();
const message = useMessage();

const detail = ref<AccountDetail | null>(null);
const error = ref('');
const tab = ref<'overview' | 'logs'>('overview');
/** 相对时间(「3 小时前」)跟着它刷新 */
const now = ref(Date.now());

const row = computed(() => accounts.rows.find(item => item.accountName.toLowerCase() === props.accountName.toLowerCase()));
const status = computed(() => row.value?.status ?? '未登录');
const online = computed(() => detail.value?.session.status === 'web_session');

let seq = 0;
async function load(): Promise<void> {
	const current = ++seq;
	try {
		const data = await fetchAccountDetail(props.accountName);
		if (current === seq) {
			detail.value = data;
			error.value = '';
		}
	} catch (err) {
		if (current === seq) {
			error.value = errorText(err);
		}
	}
}

let reloadTimer: number | undefined;
function onAttempt(attempt: PublicAttempt): void {
	if (attempt.accountName?.toLowerCase() !== props.accountName.toLowerCase()) {
		return;
	}
	window.clearTimeout(reloadTimer);
	reloadTimer = window.setTimeout(load, 300);
}

let clock: number | undefined;
let stopCodes = () => {};
onMounted(() => {
	void load();
	void loadProxies();
	socket.on('attempt:update', onAttempt);
	clock = window.setInterval(() => (now.value = Date.now()), 30_000);
	stopCodes = watchAuthCodes();
});
onUnmounted(() => {
	socket.off('attempt:update', onAttempt);
	window.clearTimeout(reloadTimer);
	window.clearInterval(clock);
	stopCodes();
});
watch(() => props.accountName, () => {
	detail.value = null;
	tab.value = 'overview';
	void load();
});

// ===== 概览 =====
const proxyView = computed(() => accountProxyView(proxy.data, props.accountName, row.value?.groupId ?? ''));
const steamProfileUrl = computed(() => (detail.value?.steamID ? `https://steamcommunity.com/profiles/${detail.value.steamID}` : ''));
const savedAt = computed(() => (detail.value?.session.savedAt ? Date.parse(detail.value.session.savedAt) : 0));

const guardText = computed(() => {
	if (!detail.value) {
		return '';
	}
	if (detail.value.hasMaFile) {
		return '手机令牌(有 maFile)';
	}
	return detail.value.hasSharedSecret ? '手机令牌(只有 shared_secret)' : '没有';
});

const code = computed(() => authCodes.codes[props.accountName] ?? '');
const codeLeft = computed(() => (code.value ? authCodeSecondsLeft() : 0));

async function copyCode(): Promise<void> {
	if (code.value) {
		await copyText(code.value);
		message.success(`已复制验证码 ${code.value}`);
	}
}

// ===== 日志 =====
const logDays = computed(() => groupLogsByDay(detail.value?.logs ?? [], now.value));
const logCount = computed(() => detail.value?.logs.length ?? 0);
</script>

<template>
	<div class="account-detail">
		<NTabs type="line" :value="tab" class="page-tabs" @update:value="(value: 'overview' | 'logs') => (tab = value)">
			<NTab name="overview"><span class="tab-label"><AppIcon name="layers" :size="16" />概览</span></NTab>
			<NTab name="logs"><span class="tab-label"><AppIcon name="clock" :size="16" />日志<span v-if="logCount" class="tab-count">{{ logCount }}</span></span></NTab>
		</NTabs>

		<NAlert v-if="error" type="error" :bordered="false">读取账户详情失败:{{ error }}</NAlert>
		<div v-if="!detail && !error" class="loading"><NSpin size="small" /></div>

		<template v-if="detail">
			<div v-show="tab === 'overview'" class="cards">
				<section class="panel card">
					<header class="card-head"><span class="card-icon"><AppIcon name="users" :size="18" /></span><h3>个人资料</h3></header>
					<dl class="fields">
						<div class="field"><dt>昵称</dt><dd>{{ detail.personaName || '—' }}</dd></div>
						<div class="field">
							<dt>Steam64 ID</dt>
							<dd><a v-if="steamProfileUrl" class="mono link" :href="steamProfileUrl" target="_blank" rel="noopener noreferrer">{{ detail.steamID }}</a><span v-else>—</span></dd>
						</div>
						<div class="field"><dt>商店国家/地区</dt><dd>{{ detail.country || '—' }}</dd></div>
						<div class="field"><dt>登录国家/地区</dt><dd>{{ detail.loginGeoCountry || '—' }}</dd></div>
						<div class="field"><dt>分组</dt><dd>{{ groupName(row?.groupId ?? '') || '未分组' }}</dd></div>
						<div class="field"><dt>记住登录</dt><dd>{{ detail.remember ? '是' : '否' }}</dd></div>
						<div class="field"><dt>账号密码</dt><dd>{{ detail.hasPassword ? '已保存' : '没有' }}</dd></div>
					</dl>
				</section>

				<section class="panel card">
					<header class="card-head"><span class="card-icon"><AppIcon name="wallet" :size="18" /></span><h3>钱包</h3></header>
					<dl class="fields">
						<div class="field"><dt>余额</dt><dd class="strong">{{ detail.hasWallet ? formatBalance(detail) : '没有钱包' }}</dd></div>
						<div class="field"><dt>货币</dt><dd>{{ detail.currencyISO || '—' }}</dd></div>
					</dl>
				</section>

				<section class="panel card">
					<header class="card-head"><span class="card-icon"><AppIcon name="signal" :size="18" /></span><h3>会话</h3></header>
					<dl class="fields">
						<div class="field"><dt>实时状态</dt><dd><NTag size="small" :bordered="false" :type="STATUS_TAG[status]">{{ SESSION_LABEL[status] }}</NTag></dd></div>
						<div class="field">
							<dt>refreshToken</dt>
							<dd><NTag size="small" :bordered="false" :type="detail.session.hasRefreshToken ? 'success' : 'default'">{{ detail.session.hasRefreshToken ? '已保存' : '没有' }}</NTag></dd>
						</div>
						<div class="field">
							<dt>令牌过期时间</dt>
							<dd :title="formatDateTime(detail.session.refreshTokenExpiresAt)">{{ fromNow(detail.session.refreshTokenExpiresAt, now) }}</dd>
						</div>
						<div class="field"><dt>会话保存于</dt><dd :title="formatDateTime(savedAt)">{{ fromNow(savedAt, now) }}</dd></div>
						<div class="field">
							<dt>网页 cookie</dt>
							<dd :title="formatDateTime(detail.session.webSessionAt)">{{ online ? `${detail.session.cookieCount} 个,${fromNow(detail.session.webSessionAt, now)}获取` : '不在线' }}</dd>
						</div>
						<div class="field">
							<dt>下次自动刷新 cookie</dt>
							<dd :title="formatDateTime(detail.session.nextCookieRefreshAt)">{{ online ? fromNow(detail.session.nextCookieRefreshAt, now) : '—' }}</dd>
						</div>
						<div class="field"><dt>Steam 看到的 IP</dt><dd class="mono">{{ detail.session.publicIP || '—' }}</dd></div>
						<div class="field"><dt>机器名称</dt><dd class="mono">{{ detail.session.machineName || '—' }}</dd></div>
						<div class="field">
							<dt>代理</dt>
							<dd>
								<NTooltip placement="top">
									<template #trigger><span>{{ proxyView.label }}</span></template>
									{{ proxyView.tip }}
								</NTooltip>
							</dd>
						</div>
						<div class="field wide"><dt>User-Agent</dt><dd class="mono small">{{ detail.session.userAgent || '下次登录时分配' }}</dd></div>
					</dl>
				</section>

				<section class="panel card">
					<header class="card-head"><span class="card-icon"><AppIcon name="shield" :size="18" /></span><h3>Steam Guard</h3></header>
					<dl class="fields">
						<div class="field"><dt>令牌</dt><dd>{{ guardText }}</dd></div>
						<div class="field"><dt>自动确认交易</dt><dd>{{ detail.hasIdentitySecret ? '可以(有 identity_secret)' : '不行(没有 identity_secret)' }}</dd></div>
					</dl>
					<NTooltip v-if="code" placement="top">
						<template #trigger>
							<button type="button" class="code-box" @click="copyCode">
								<span class="code-chars"><span v-for="(char, index) in code.split('')" :key="index" class="code-char mono">{{ char }}</span></span>
								<span class="code-progress">
									<span class="code-bar"><span class="code-bar-fill" :class="{'is-ending': codeLeft <= 5}" :style="{width: `${(codeLeft / 30) * 100}%`}" /></span>
									<span class="muted mono">{{ codeLeft }}s</span>
								</span>
							</button>
						</template>
						点击复制
					</NTooltip>
				</section>

				<section class="panel card">
					<header class="card-head"><span class="card-icon"><AppIcon name="gamepad" :size="18" /></span><h3>游戏协调器</h3></header>
					<dl class="fields">
						<div class="field"><dt>CS2 GC</dt><dd><NTag size="small" :bordered="false" :type="detail.gc.cs2 ? 'success' : 'default'">{{ detail.gc.cs2 ? '已连接' : '未连接' }}</NTag></dd></div>
						<div class="field"><dt>TF2 GC</dt><dd><NTag size="small" :bordered="false" :type="detail.gc.tf2 ? 'success' : 'default'">{{ detail.gc.tf2 ? '已连接' : '未连接' }}</NTag></dd></div>
						<div class="field"><dt>库存</dt><dd>{{ detail.gc.inventoryCount ? `${detail.gc.inventoryCount} 件` : '—' }}</dd></div>
					</dl>
				</section>
			</div>

			<section v-show="tab === 'logs'" class="panel logs">
				<p v-if="!logDays.length" class="muted empty">还没有日志,账号登录后这里会显示。</p>
				<div v-for="day in logDays" :key="day.key" class="log-day">
					<header class="log-day-head"><span>{{ day.label }}</span><span class="log-day-count">{{ day.entries.length }}</span></header>
					<ol class="log-list">
						<li v-for="(entry, index) in day.entries" :key="index" class="log-line" :class="'log-' + entry.level">
							<span class="mono muted log-time">{{ entry.time }}</span>
							<NTag size="small" :bordered="false" :type="logLevel(entry.level).type" class="log-level">{{ logLevel(entry.level).label }}</NTag>
							<span class="log-message">{{ entry.message }}</span>
						</li>
					</ol>
				</div>
			</section>
		</template>
	</div>
</template>

<style scoped>
.account-detail {
	display: flex;
	flex-direction: column;
	gap: 16px;
	min-height: 0;
}

.page-tabs {
	flex: none;
}

.tab-label {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.tab-count {
	padding: 0 6px;
	border-radius: 999px;
	background: var(--surface-2);
	color: var(--muted);
	font-size: 12px;
	line-height: 18px;
}

.loading {
	display: flex;
	justify-content: center;
	padding: 40px 0;
}

.cards {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.card {
	padding: 16px 20px 18px;
}

.card-head {
	display: flex;
	align-items: center;
	gap: 10px;
	margin: 0 -20px 14px;
	padding: 0 20px 12px;
	border-bottom: 1px solid var(--line);
}

.card-head h3 {
	margin: 0;
	font-size: 15px;
	font-weight: 600;
}

.card-icon {
	display: inline-flex;
	color: var(--muted);
}

.fields {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
	gap: 14px 24px;
	margin: 0;
}

.field {
	min-width: 0;
}

.field.wide {
	grid-column: 1 / -1;
}

.field dt {
	margin-bottom: 4px;
	color: var(--muted);
	font-size: 12px;
}

.field dd {
	margin: 0;
	overflow-wrap: anywhere;
}

.strong {
	font-size: 18px;
	font-weight: 600;
}

.small {
	font-size: 12px;
}

.link {
	color: var(--accent-text);
	text-decoration: none;
}

.link:hover {
	text-decoration: underline;
}

.code-box {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
	width: 100%;
	margin-top: 16px;
	padding: 12px 0 4px;
	border: 0;
	border-top: 1px solid var(--line);
	background: none;
	color: inherit;
	cursor: pointer;
}

.code-chars {
	display: flex;
	gap: 6px;
}

.code-char {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 34px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--surface);
	font-size: 16px;
	font-weight: 600;
}

.code-box:hover .code-char {
	border-color: var(--accent);
}

.code-progress {
	display: flex;
	align-items: center;
	gap: 10px;
	width: min(100%, 360px);
	font-size: 12px;
}

.code-bar {
	flex: 1;
	height: 4px;
	border-radius: 2px;
	background: var(--line);
	overflow: hidden;
}

.code-bar-fill {
	display: block;
	height: 100%;
	background: var(--accent);
	transition: width 1s linear;
}

.code-bar-fill.is-ending {
	background: var(--danger);
}

.logs {
	padding: 4px 0;
}

.empty {
	margin: 0;
	padding: 28px 20px;
	text-align: center;
}

.log-day + .log-day {
	border-top: 1px solid var(--line);
}

.log-day-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 20px 6px;
	color: var(--muted);
	font-size: 12px;
	font-weight: 600;
	letter-spacing: 0.04em;
}

.log-day-count {
	padding: 0 7px;
	border-radius: 999px;
	background: var(--surface-2);
	line-height: 18px;
}

.log-list {
	margin: 0;
	padding: 0 0 8px;
	list-style: none;
}

.log-line {
	display: grid;
	grid-template-columns: 70px 52px minmax(0, 1fr);
	align-items: baseline;
	gap: 10px;
	padding: 6px 20px;
	font-size: 13px;
}

.log-line:hover {
	background: var(--surface-2);
}

.log-time {
	font-size: 12px;
}

.log-level {
	justify-self: start;
}

.log-message {
	overflow-wrap: anywhere;
}

.log-error .log-message {
	color: var(--danger);
}

.log-warn .log-message {
	color: var(--warn);
}

@media (max-width: 640px) {
	.log-line {
		grid-template-columns: 62px minmax(0, 1fr);
	}

	.log-level {
		display: none;
	}
}
</style>
