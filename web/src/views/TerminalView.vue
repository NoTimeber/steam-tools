<script setup lang="ts">
// CS2 终端机开箱:选已连 CS2 GC 的账号,列出它库存里的终端机;每个终端机独立操作:解封 → 拒绝报价 · 换下一个。
// 两个操作都不可逆,先确认。买需在 Steam 客户端完成,这里不代购。
import {computed, h, onMounted, watch} from 'vue';
import {NButton, NCard, NCollapse, NCollapseItem, NEmpty, NSelect, NSpace, NTag, useDialog, useMessage} from 'naive-ui';
import type {SelectOption} from 'naive-ui';
import {errorText} from '../api/http.ts';
import {formatBalance} from '../lib/accounts.ts';
import {TERMINAL_TYPES, advanceConfirmText, filterTerminals, formatExpire, offerLines, picks, unsealConfirmText} from '../lib/terminal.ts';
import type {StateFilter, TerminalItem} from '../lib/terminal.ts';
import {advance, ensureSelection, gcAccounts, load, selectAccount, selectedAccount, terminal, unseal} from '../stores/terminal.ts';

const message = useMessage();
const dialog = useDialog();

onMounted(() => {
	ensureSelection();
	if (selectedAccount.value) {
		load();
	}
});
watch(() => gcAccounts.value.map(row => row.key).join(','), ensureSelection);

const accountOptions = computed<SelectOption[]>(() => gcAccounts.value.map(row => ({
	value: row.key,
	label: `${row.accountName}(${row.country || '-'} · ${formatBalance(row)})`
})));

const typeOptions: SelectOption[] = [{value: 'all', label: '全部'}, ...TERMINAL_TYPES];
const stateOptions: SelectOption[] = [{value: 'all', label: '全部'}, {value: 'sealed', label: '未解封'}, {value: 'open', label: '已解封'}];

const visible = computed(() => filterTerminals(terminal.terminals, terminal.typeFilter, terminal.stateFilter));
const sealedCount = computed(() => terminal.terminals.filter(item => item.sealed).length);

function setType(value: string): void {
	terminal.typeFilter = value;
}

function setState(value: StateFilter): void {
	terminal.stateFilter = value;
}

const emptyText = computed(() => {
	if (!gcAccounts.value.length) return '暂无已连接 CS2 GC 的账户,先在「账户管理」里连接 CS2 GC';
	if (!selectedAccount.value) return '请在上方选择账户';
	if (terminal.loading) return '加载中…';
	if (terminal.error) return '加载失败:' + terminal.error;
	if (!terminal.terminals.length) return '该账户库存里没有终端机(创世/毁灭之手,或未连接 CS2 GC)';
	return '当前筛选条件下没有终端机(可把上方筛选改回「全部」)';
});

function confirmUnseal(item: TerminalItem): void {
	dialog.warning({
		title: '解封终端机(不可逆)',
		content: () => h('div', {style: 'white-space: pre-wrap'}, unsealConfirmText(item.id)),
		positiveText: '确认解封',
		negativeText: '取消',
		onPositiveClick: async () => {
			message.info('正在解封…约 5 秒');
			try {
				await unseal(item.id);
				message.success('已解封');
			} catch (err) {
				message.error('解封失败:' + errorText(err));
			}
		}
	});
}

function confirmAdvance(item: TerminalItem): void {
	dialog.warning({
		title: '拒绝报价 · 换下一个(不可逆·消耗 1 次)',
		content: () => h('div', {style: 'white-space: pre-wrap'}, advanceConfirmText(item.id, picks(item).left)),
		positiveText: '确认',
		negativeText: '取消',
		onPositiveClick: async () => {
			message.info('正在换下一个报价…约 6 秒');
			try {
				const offer = await advance(item.id);
				if (offer) {
					message.success(`已换:${offer.name || '新报价'}`);
				} else {
					message.warning('已推进(未读到新报价,可再试一次)');
				}
			} catch (err) {
				message.error('换报价失败:' + errorText(err));
			}
		}
	});
}
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>终端机开箱</h1>
				<div class="module-counts">
					<span>已连 GC 账户:{{ gcAccounts.length }}</span>
					<span>终端机:{{ terminal.terminals.length }}{{ terminal.terminals.length ? `(未解封 ${sealedCount})` : '' }}</span>
				</div>
			</div>
			<NSpace align="center">
				<NSelect
					class="account-select"
					:value="selectedAccount?.key ?? null"
					:options="accountOptions"
					:disabled="!gcAccounts.length"
					placeholder="— 请选择账户 —"
					@update:value="(key: string) => selectAccount(key)"
				/>
				<NButton :disabled="!selectedAccount" :loading="terminal.loading" @click="load">刷新</NButton>
			</NSpace>
		</header>

		<p class="note muted">
			在上方选一个账户,只显示其库存里的终端机(创世 / 毁灭之手)。每个终端机独立操作:解封 → 拒绝报价 · 换下一个(消耗 1 次、不可逆)。
			每次开出的报价会缓存,可在卡片「历史报价」里回看。买需在 Steam 客户端完成,此处不代购。
		</p>

		<NSpace align="center" :size="12">
			<NSpace align="center" :size="6">
				<span class="muted">类型</span>
				<NSelect class="filter" size="small" :value="terminal.typeFilter" :options="typeOptions" @update:value="setType" />
			</NSpace>
			<NSpace align="center" :size="6">
				<span class="muted">状态</span>
				<NSelect class="filter" size="small" :value="terminal.stateFilter" :options="stateOptions" @update:value="setState" />
			</NSpace>
			<span v-if="terminal.terminals.length" class="muted">显示 {{ visible.length }} / 共 {{ terminal.terminals.length }}</span>
		</NSpace>

		<div v-if="visible.length" class="grid">
			<NCard v-for="item in visible" :key="item.id" size="small" :class="['card', item.sealed ? 'sealed' : 'open']">
				<div class="head">
					<img v-if="item.image" class="term-img" :src="item.image" alt="" loading="lazy" referrerpolicy="no-referrer">
					<div v-else class="term-img empty">无图</div>
					<span class="title" :title="`GC id ${item.id}`">{{ item.name || (item.sealed ? '封装的终端机' : '终端机') }}</span>
					<NTag size="small" :bordered="false" :type="item.sealed ? 'default' : 'success'">{{ item.sealed ? '未解封' : '已解封' }}</NTag>
				</div>
				<div class="meta muted">
					<span v-if="!item.sealed">剩余 {{ picks(item).left ?? '-' }} / {{ picks(item).max }} 次{{ picks(item).used != null ? `(已开 ${picks(item).used})` : '' }}</span>
					<span v-if="item.expiresAt">到期 {{ formatExpire(item.expiresAt) }}</span>
				</div>

				<NButton v-if="item.sealed" type="error" secondary block :loading="terminal.busyId === item.id" @click="confirmUnseal(item)">解封(不可逆·72h)</NButton>
				<template v-else>
					<div v-if="item.offer" class="offer">
						<img v-if="item.offer.image" class="offer-img" :src="item.offer.image" alt="" loading="lazy" referrerpolicy="no-referrer">
						<div v-else class="offer-img empty">无图</div>
						<div class="offer-info">
							<div class="offer-name" :title="item.offer.name">{{ item.offer.name }}</div>
							<div v-if="offerLines(item.offer)[0]" class="offer-sub">{{ offerLines(item.offer)[0] }}</div>
							<div v-if="offerLines(item.offer)[1]" class="offer-sub muted">{{ offerLines(item.offer)[1] }}</div>
							<div class="offer-price">{{ item.offer.priceText || '—' }}</div>
						</div>
					</div>
					<div v-else class="offer empty-offer muted">暂无报价 · 点「拒绝报价 · 换下一个」生成</div>
					<NButton type="error" secondary block :loading="terminal.busyId === item.id" @click="confirmAdvance(item)">拒绝报价 · 换下一个(消耗)</NButton>
					<NCollapse v-if="item.history?.length" class="history">
						<NCollapseItem :title="`历史报价(${item.history.length})`" name="history">
							<div v-for="(old, index) in item.history" :key="index" class="history-row">
								<span class="muted">{{ index + 1 }}</span>
								<img v-if="old.image" class="history-img" :src="old.image" alt="" loading="lazy" referrerpolicy="no-referrer">
								<span class="history-name" :title="old.name">{{ old.name }}<span v-if="offerLines(old)[0]" class="muted"> · {{ offerLines(old)[0] }}</span></span>
								<span>{{ old.priceText || '—' }}</span>
							</div>
						</NCollapseItem>
					</NCollapse>
				</template>
			</NCard>
		</div>
		<NEmpty v-else :description="emptyText" class="no-terminals" />
	</div>
</template>

<style scoped>
.account-select {
	width: 320px;
}

.filter {
	width: 140px;
}

.note {
	margin: 0;
	font-size: 12px;
	line-height: 1.6;
}

.grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 12px;
	align-content: start;
}

.card.sealed {
	opacity: 0.9;
}

.head {
	display: flex;
	align-items: center;
	gap: 8px;
}

.term-img {
	width: 44px;
	height: 34px;
	object-fit: contain;
	border-radius: 4px;
	background: var(--surface-2);
}

.empty {
	display: grid;
	place-items: center;
	color: var(--muted);
	font-size: 11px;
}

.title {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	font-weight: 600;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.meta {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 12px;
	margin: 8px 0;
	font-size: 12px;
}

.offer {
	display: flex;
	gap: 10px;
	margin-bottom: 8px;
	padding: 8px;
	border-radius: 6px;
	background: var(--surface-2);
}

.empty-offer {
	font-size: 12px;
}

.offer-img {
	flex: none;
	width: 96px;
	height: 72px;
	object-fit: contain;
}

.offer-info {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
	font-size: 12px;
}

.offer-name {
	overflow: hidden;
	font-size: 13px;
	font-weight: 600;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.offer-price {
	margin-top: auto;
	color: var(--ok);
	font-weight: 600;
}

.history {
	margin-top: 8px;
}

.history-row {
	display: grid;
	grid-template-columns: 20px 40px minmax(0, 1fr) auto;
	gap: 6px;
	align-items: center;
	font-size: 12px;
}

.history-img {
	width: 40px;
	height: 30px;
	object-fit: contain;
}

.history-name {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.no-terminals {
	margin-top: 40px;
}
</style>
