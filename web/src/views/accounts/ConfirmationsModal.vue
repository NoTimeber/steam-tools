<script setup lang="ts">
// 令牌确认:这个账号 Steam 手机令牌里的待确认项(交易报价、市场上架、求购……),逐条或勾选后批量确认 / 拒绝。
// 打开时从 Steam 读一次,「刷新」再读;服务端只认最近读到的列表(nonce 不下发),处理过的从列表去掉。
// 换手机号、账户恢复、创建 API Key 这类动账号安全的不跟着全选,单独确认时再弹窗问一次。
// mobileconf 请求在服务端按出口排队(两次至少隔 5 秒),所以读取、提交可能要等几秒。
import {computed, reactive, watch} from 'vue';
import {NAlert, NButton, NCard, NCheckbox, NModal, NSpace, NSpin, NTag, NTooltip, useDialog, useMessage} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import type {ConfirmationList, PendingConfirmation} from '../../api/types.ts';
import AppIcon from '../../components/AppIcon.vue';
import {formatDateTime, fromNow} from '../../lib/accounts.ts';
import {confirmationType, isSensitive, selectableIds, tradeOfferUrl, typeCounts} from '../../lib/confirmations.ts';
import {fetchConfirmations, respondConfirmations} from '../../stores/accounts.ts';

const props = defineProps<{accountName: string}>();
const emit = defineEmits<{close: []}>();
const message = useMessage();
const dialog = useDialog();

const view = reactive({
	list: null as ConfirmationList | null,
	loading: false,
	error: '',
	/** 正在提交的确认项和动作 */
	busyIds: new Set<string>(),
	busyAccept: null as boolean | null,
	selected: new Set<string>(),
	/** 图片加载失败的确认项 */
	brokenIcons: new Set<string>()
});

/** 换账号、关掉弹窗后加一,之前发出的请求回来就丢掉 */
let generation = 0;

async function load(): Promise<void> {
	const name = props.accountName;
	const gen = generation;
	view.loading = true;
	view.error = '';
	try {
		const list = await fetchConfirmations(name);
		if (gen === generation) {
			view.list = list;
			// 勾选里去掉已经不在列表里的
			const ids = new Set(list.confirmations.map(conf => conf.id));
			view.selected = new Set([...view.selected].filter(id => ids.has(id)));
		}
	} catch (err) {
		if (gen === generation) {
			view.error = errorText(err);
		}
	} finally {
		if (gen === generation) {
			view.loading = false;
		}
	}
}

watch(() => props.accountName, name => {
	generation++;
	Object.assign(view, {list: null, loading: false, error: '', busyIds: new Set(), busyAccept: null, selected: new Set(), brokenIcons: new Set()});
	if (name) {
		void load();
	}
}, {immediate: true});

const items = computed(() => view.list?.confirmations ?? []);
const busy = computed(() => view.busyIds.size > 0);
const counts = computed(() => typeCounts(items.value));
const selectable = computed(() => selectableIds(items.value));
const selectedCount = computed(() => view.selected.size);
const allChecked = computed(() => selectable.value.length > 0 && selectable.value.every(id => view.selected.has(id)));
const someChecked = computed(() => view.selected.size > 0 && !allChecked.value);

function toggleAll(checked: boolean): void {
	view.selected = new Set(checked ? selectable.value : []);
}

function toggle(id: string, checked: boolean): void {
	const next = new Set(view.selected);
	if (checked) {
		next.add(id);
	} else {
		next.delete(id);
	}
	view.selected = next;
}

async function submit(ids: string[], accept: boolean): Promise<void> {
	const gen = generation;
	const what = accept ? '确认' : '拒绝';
	view.busyIds = new Set(ids);
	view.busyAccept = accept;
	view.error = '';
	try {
		const result = await respondConfirmations(props.accountName, ids, accept);
		if (gen !== generation) {
			return;
		}
		view.list = result;
		const done = new Set(result.done);
		view.selected = new Set([...view.selected].filter(id => !done.has(id)));
		message.success(`已${what} ${result.done.length} 项`);
	} catch (err) {
		if (gen === generation) {
			view.error = `${what}失败:${errorText(err)}`;
		}
	} finally {
		if (gen === generation) {
			view.busyIds = new Set();
			view.busyAccept = null;
		}
	}
}

function respondOne(conf: PendingConfirmation, accept: boolean): void {
	if (accept && isSensitive(conf)) {
		const {label} = confirmationType(conf);
		dialog.warning({
			title: `确认「${label}」`,
			content: `这一项会改动账号安全设置(${label}),骗子常借它盗号。确定是你本人发起的再确认。`,
			positiveText: '确认',
			negativeText: '取消',
			onPositiveClick: () => void submit([conf.id], true)
		});
		return;
	}
	void submit([conf.id], accept);
}

function respondSelected(accept: boolean): void {
	const ids = items.value.filter(conf => view.selected.has(conf.id)).map(conf => conf.id);
	if (!ids.length) {
		return;
	}
	const what = accept ? '确认' : '拒绝';
	dialog.warning({
		title: `${what}选中的 ${ids.length} 项`,
		content: accept ? '确认后交易报价会发出、上架和求购会生效,不能撤回。' : '拒绝后这些交易报价、上架、求购会被取消。',
		positiveText: what,
		negativeText: '取消',
		onPositiveClick: () => void submit(ids, accept)
	});
}

function itemBusy(conf: PendingConfirmation, accept: boolean): boolean {
	return view.busyIds.has(conf.id) && view.busyAccept === accept;
}

function onIconError(id: string): void {
	view.brokenIcons = new Set(view.brokenIcons).add(id);
}
</script>

<template>
	<NModal :show="!!accountName" @update:show="(show: boolean) => !show && emit('close')">
		<NCard :title="`${accountName} 令牌确认`" class="confirm-card" :bordered="false" role="dialog" aria-modal="true">
			<div class="status">
				<div class="status-text">
					<template v-if="view.loading">
						<NSpin :size="14" />
						<span>正在从 Steam 读取待确认项…</span>
					</template>
					<template v-else-if="view.list">
						<span v-if="items.length">{{ items.length }} 项待确认</span>
						<span v-for="entry in counts" :key="entry.label" class="muted">{{ entry.label }} {{ entry.count }}</span>
						<span class="muted" :title="formatDateTime(view.list.fetchedAt)">{{ items.length ? '· ' : '' }}读取于 {{ formatDateTime(view.list.fetchedAt).slice(11) }}</span>
					</template>
				</div>
				<NButton size="small" :loading="view.loading" :disabled="busy" @click="load">
					<template #icon><AppIcon name="refresh" :size="15" /></template>刷新
				</NButton>
			</div>

			<NAlert v-if="view.error" type="error" :bordered="false" class="block">{{ view.error }}</NAlert>

			<template v-if="items.length">
				<div class="toolbar">
					<NCheckbox :checked="allChecked" :indeterminate="someChecked" :disabled="busy || !selectable.length" @update:checked="toggleAll">
						全选
					</NCheckbox>
					<span class="muted">{{ selectedCount ? `已选 ${selectedCount} 项` : '' }}</span>
					<NSpace :size="8" class="toolbar-actions">
						<NButton size="small" :disabled="!selectedCount || busy" :loading="busy && view.busyAccept === false && view.busyIds.size > 1" @click="respondSelected(false)">
							拒绝选中
						</NButton>
						<NButton size="small" type="primary" :disabled="!selectedCount || busy" :loading="busy && view.busyAccept === true && view.busyIds.size > 1" @click="respondSelected(true)">
							确认选中
						</NButton>
					</NSpace>
				</div>

				<ul class="conf-list">
					<li v-for="conf in items" :key="conf.id" class="conf-item" :class="{'is-sensitive': isSensitive(conf), 'is-busy': view.busyIds.has(conf.id)}">
						<NCheckbox :checked="view.selected.has(conf.id)" :disabled="busy" class="conf-check" @update:checked="(checked: boolean) => toggle(conf.id, checked)" />
						<div class="conf-icon">
							<img v-if="conf.icon && !view.brokenIcons.has(conf.id)" :src="conf.icon" alt="" loading="lazy" referrerpolicy="no-referrer" @error="onIconError(conf.id)">
							<AppIcon v-else :name="conf.type === 2 ? 'users' : conf.type === 3 || conf.type === 12 ? 'tag' : 'shield'" :size="20" />
						</div>
						<div class="conf-body">
							<div class="conf-head">
								<NTag size="small" :bordered="false" :type="confirmationType(conf).tag">{{ confirmationType(conf).label }}</NTag>
								<span class="conf-headline">{{ conf.headline || '—' }}</span>
								<NTooltip v-if="tradeOfferUrl(conf)" placement="top">
									<template #trigger>
										<a class="conf-link" :href="tradeOfferUrl(conf)" target="_blank" rel="noopener noreferrer" aria-label="在 Steam 网页打开这个报价">
											<AppIcon name="external" :size="14" />
										</a>
									</template>
									在 Steam 网页打开这个报价(要在浏览器里登录这个账号)
								</NTooltip>
								<span v-if="conf.createdAt" class="muted conf-time" :title="formatDateTime(conf.createdAt)">{{ fromNow(conf.createdAt) }}</span>
							</div>
							<div v-for="(line, index) in conf.summary" :key="index" class="conf-summary">{{ line }}</div>
							<div v-if="conf.warn" class="conf-warn"><AppIcon name="alert" :size="14" />{{ conf.warn }}</div>
							<div v-if="isSensitive(conf)" class="conf-warn"><AppIcon name="alert" :size="14" />动账号安全的操作,不是你本人发起的请拒绝</div>
						</div>
						<div class="conf-actions">
							<NButton size="small" :disabled="busy" :loading="itemBusy(conf, false)" @click="respondOne(conf, false)">拒绝</NButton>
							<NButton size="small" :type="isSensitive(conf) ? 'error' : 'primary'" :disabled="busy" :loading="itemBusy(conf, true)" @click="respondOne(conf, true)">确认</NButton>
						</div>
					</li>
				</ul>
			</template>
			<div v-else-if="view.list && !view.loading" class="empty">
				<AppIcon name="check" :size="28" />
				<span>没有待确认项</span>
			</div>

			<template #footer>
				<NSpace justify="end">
					<NButton @click="emit('close')">关闭</NButton>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.confirm-card {
	width: 760px;
	max-width: calc(100vw - 32px);
}

.status {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	min-height: 28px;
	margin-bottom: 10px;
}

.status-text {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

.block {
	margin-bottom: 10px;
}

.toolbar {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px 12px;
	border: 1px solid var(--line);
	border-bottom: 0;
	border-radius: 8px 8px 0 0;
	background: var(--surface-2);
}

.toolbar-actions {
	margin-left: auto;
}

.conf-list {
	max-height: 56vh;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	border: 1px solid var(--line);
	border-radius: 0 0 8px 8px;
	list-style: none;
}

.conf-item {
	display: grid;
	grid-template-columns: auto 40px minmax(0, 1fr) auto;
	align-items: start;
	gap: 12px;
	padding: 12px;
}

.conf-item + .conf-item {
	border-top: 1px solid var(--line);
}

.conf-item:hover {
	background: var(--hover);
}

.conf-item.is-sensitive {
	box-shadow: inset 3px 0 0 var(--danger);
}

.conf-item.is-busy {
	opacity: 0.6;
}

.conf-check {
	margin-top: 10px;
}

.conf-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 40px;
	height: 40px;
	overflow: hidden;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--surface-2);
	color: var(--muted);
}

.conf-icon img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.conf-body {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}

.conf-head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	min-height: 24px;
}

.conf-headline {
	min-width: 0;
	font-weight: 600;
	overflow-wrap: anywhere;
}

.conf-link {
	display: inline-flex;
	color: var(--muted);
}

.conf-link:hover {
	color: var(--accent-text);
}

.conf-time {
	margin-left: auto;
	font-size: 12px;
	white-space: nowrap;
}

.conf-summary {
	color: var(--muted);
	font-size: 13px;
	overflow-wrap: anywhere;
}

.conf-warn {
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--warn);
	font-size: 13px;
}

.is-sensitive .conf-warn {
	color: var(--danger);
}

.conf-actions {
	display: flex;
	gap: 6px;
	margin-top: 4px;
}

.empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
	padding: 36px 0;
	color: var(--muted);
}

@media (max-width: 600px) {
	.conf-item {
		grid-template-columns: auto 40px minmax(0, 1fr);
	}

	.conf-actions {
		grid-column: 3;
	}
}
</style>
