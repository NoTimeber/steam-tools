<script setup lang="ts">
// 市场 → 出售:选一个在线账号 → 读库存(CS2 / TF2),同名物品叠成一行 → 勾选放进「待上架」,每种填数量和单件的买家付或到手
// (按 Steam 手续费互相换算,参考最低在售 / 最高求购)→ 上架:按数量展开成资产,每批最多 50 件依次提交(服务器逐件、间隔 1.5 秒,
// 有 maFile 的自动手机确认)。失败的件数留在待上架里,改价再试。
// 参考价 / 盘口每次都是实时查 Steam:每行显示查到多久了(超过 2 分钟标「可能过时」),可以单行或全部刷新;
// 点「上架」先把要上架的每种重查一遍,和定价时看到的比,有实质变化就先警告(可一键改价),没变化才走正常确认。
import {computed, h, onBeforeUnmount, onMounted, reactive, ref} from 'vue';
import type {VNodeChild} from 'vue';
import {
	NAlert, NButton, NCard, NCheckbox, NCollapse, NCollapseItem, NDataTable, NInput, NInputNumber, NSelect, NSpace, NSpin, NSwitch, NTag, useDialog, useMessage
} from 'naive-ui';
import type {DataTableColumns, DataTableRowKey, SelectOption} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {formatBalance} from '../../lib/accounts.ts';
import {currencyPrefix} from '../../lib/market.ts';
import {
	actualBuyer, centsOf, cooldownText, expandPending, fillFromLowest, filterGroups, groupResultText, money, pendingError, pendingTotals, SELL_BATCH_MAX,
	SELL_GAMES, SELL_GAP_SEC, SELL_STATUS_LABELS, sellConfirmText, sellItemLabel, sellSummary, sentMessage, sentStatus, unitsOf, withBuyer, withQuantity,
	withReceive
} from '../../lib/market-sell.ts';
import type {PendingRow, SellGroup, SentItem} from '../../lib/market-sell.ts';
import {compareRow, freshness, moveText, rankText, recheckSummary, snapshotOf, STALE_MS} from '../../lib/sell-recheck.ts';
import type {RowCheck} from '../../lib/sell-recheck.ts';
import {market} from '../../stores/market.ts';
import {
	ensurePrice, loadInventory, priceKey, refreshPrices, replacePending, sell, sellGroups, setSellAccount, setSellGame, submitSell, togglePending
} from '../../stores/market-sell.ts';
import type {CancelToken} from '../../stores/market-sell.ts';
import OrderBook from './OrderBook.vue';
import PriceChart from './PriceChart.vue';

const message = useMessage();
const dialog = useDialog();

const currency = computed(() => sell.inventory?.currency ?? null);
const prefix = computed(() => (currency.value ? currencyPrefix(currency.value.id, currency.value.iso) : ''));

// ===== 账号 / 游戏 =====
const accountOptions = computed<SelectOption[]>(() => market.accounts.map(account => ({
	value: account.account,
	label: `${account.account} · ${account.currencyISO || '币种未知'} · ${formatBalance(account)}`
})));

const accountPlaceholder = computed(() => {
	if (market.accounts.length) return '选一个在线账户';
	if (market.loadingAccounts) return '正在加载在线账户...';
	return market.accountError || '暂无在线账户,先在账户页登录';
});

function pickAccount(value: string | null): void {
	if (value !== sell.account && sell.pending.length) {
		message.info('换了账号,待上架列表已清空');
	}
	setSellAccount(value);
}

function setFilterText(value: string | null): void {
	sell.filterText = value ?? '';
}

function setOnlyMarketable(value: boolean): void {
	sell.onlyMarketable = value;
}

function clearResult(): void {
	sell.lastResult = null;
}

// ===== 库存(一组一行) =====
const visibleGroups = computed(() => filterGroups(sellGroups.value, {text: sell.filterText, onlyMarketable: sell.onlyMarketable}));
const pendingKeys = computed(() => new Set(sell.pending.map(row => row.key)));

function groupCell(group: Pick<SellGroup, 'icon' | 'zh' | 'name' | 'marketHashName'>): VNodeChild {
	return h('div', {class: 'item-cell'}, [
		group.icon ? h('img', {class: 'item-thumb', src: group.icon, alt: '', loading: 'lazy'}) : h('div', {class: 'item-thumb'}),
		h('div', {class: 'item-text'}, [
			h('div', {class: 'item-main', title: group.marketHashName}, sellItemLabel(group)),
			group.zh || group.name !== group.marketHashName ? h('div', {class: 'item-sub muted'}, group.marketHashName) : null
		])
	]);
}

const inventoryColumns = computed<DataTableColumns<SellGroup>>(() => [
	{
		key: 'check',
		width: 44,
		render: group => h(NCheckbox, {
			checked: pendingKeys.value.has(group.key),
			disabled: group.sellable <= 0 || sell.selling,
			'onUpdate:checked': (checked: boolean) => togglePending(group, checked)
		})
	},
	{title: '物品', key: 'name', minWidth: 260, render: group => groupCell(group)},
	{title: '外观', key: 'exterior', width: 110, ellipsis: {tooltip: true}, render: group => group.exterior || '-'},
	{
		title: '稀有度',
		key: 'rarity',
		width: 130,
		ellipsis: {tooltip: true},
		render: group => (group.rarity ? h('span', {style: group.rarityColor ? `color: ${group.rarityColor}` : ''}, group.rarity) : '-')
	},
	{title: '总数', key: 'total', width: 70},
	{
		title: '可出售',
		key: 'sellable',
		width: 80,
		render: group => h('span', {class: group.sellable > 0 ? 'ok-text' : 'muted'}, String(group.sellable))
	},
	{
		title: '说明',
		key: 'note',
		minWidth: 200,
		render: group => {
			const parts = [cooldownText(group)];
			const blocked = group.total - group.sellable - group.cooldown;
			if (blocked > 0) {
				parts.push(`不可出售 ${blocked} 件`);
			}
			return h('span', {class: 'muted small'}, parts.filter(Boolean).join(';') || '-');
		}
	}
]);

const inventoryEmpty = computed(() => {
	if (!sell.account) return '先选一个在线账户';
	if (sell.inventoryLoading) return '正在读取库存…';
	if (sell.inventory && sell.inventory.items.length) return '没有符合筛选的物品';
	return '库存里没有物品';
});

// ===== 待上架 =====
/** 「x 秒前」每 15 秒走一次 */
const nowTick = ref(Date.now());
let tickTimer: number | undefined;
onMounted(() => {
	tickTimer = window.setInterval(() => (nowTick.value = Date.now()), 15_000);
});
onBeforeUnmount(() => window.clearInterval(tickTimer));

/** 上架前核对出变化的行:标出来,改过这一行或 2 分钟后取消 */
const flagged = ref<Record<string, number>>({});

function updateRow(key: string, next: (row: PendingRow) => PendingRow): void {
	replacePending(sell.pending.map(row => (row.key === key ? next(row) : row)));
	if (flagged.value[key]) {
		const {[key]: _done, ...rest} = flagged.value;
		flagged.value = rest;
	}
}

function rowClass(row: PendingRow): string {
	const until = flagged.value[row.key];
	return until && until > nowTick.value ? 'row-flagged' : '';
}

/** 我的单价:按到手价上架后买家实际付的 */
function myPrice(row: PendingRow): number | null {
	return actualBuyer(row) ?? row.buyerCents;
}

function refreshRow(row: PendingRow): void {
	if (sell.account) {
		void ensurePrice(sell.account, row.group.appid, row.group.marketHashName, true);
	}
}

const refreshingAll = computed(() => sell.refreshing?.mode === 'refresh');
const rechecking = computed(() => sell.refreshing?.mode === 'recheck');

async function refreshAll(): Promise<void> {
	const results = await refreshPrices([...sell.pending], 'refresh');
	const failed = [...results.values()].filter(ok => !ok).length;
	if (failed) {
		message.warning(`${failed} 种没刷新成功,旧价格还留着`);
	} else if (results.size) {
		message.success('参考价和盘口已刷新');
	}
}

/** 参考价旁边的一行:多久前查的(超过 2 分钟标可能过时)、刷新中转圈、「刷新盘口」 */
function freshLine(row: PendingRow): VNodeChild {
	const entry = priceOf(row);
	const fresh = freshness(entry?.fetchedAt, nowTick.value);
	return h('div', {class: 'fresh-line'}, [
		entry?.loading ? h(NSpin, {size: 12}) : null,
		fresh ? h('span', {class: fresh.stale ? 'warn-text' : 'muted', title: entry?.fetchedAt ? new Date(entry.fetchedAt).toLocaleString() : ''}, fresh.stale ? `${fresh.text} · 可能过时` : fresh.text) : null,
		h(NButton, {size: 'tiny', quaternary: true, disabled: !!entry?.loading, onClick: () => refreshRow(row)}, () => '刷新盘口')
	]);
}

function removeRow(key: string): void {
	replacePending(sell.pending.filter(row => row.key !== key));
}

function priceOf(row: PendingRow) {
	return sell.account ? sell.prices[priceKey(sell.account, row.group.appid, row.group.marketHashName)] : undefined;
}

function referenceCell(row: PendingRow): VNodeChild {
	const entry = priceOf(row);
	if (!entry || (entry.loading && !entry.data)) {
		return h('span', {class: 'muted'}, '查询中…');
	}
	if (!entry.data) {
		return h('div', {class: 'ref'}, [
			h('span', {class: 'warn-text', title: entry.error}, '参考价获取失败'),
			h(NButton, {size: 'tiny', quaternary: true, onClick: () => refreshRow(row)}, () => '重试')
		]);
	}
	const data = entry.data;
	const line = (label: string, split: typeof data.lowestSell) => h('div', split
		? [`${label} ${money(split.buyerPrice, data.currency)}`, h('span', {class: 'muted'}, ` 到手 ${money(split.receive, data.currency)}`)]
		: [`${label} `, h('span', {class: 'muted'}, '无')]);
	return h('div', {class: 'ref'}, [
		line('最低在售', data.lowestSell),
		line('最高求购', data.highestBuyOrder),
		entry.error ? h('div', {class: 'warn-text', title: entry.error}, '刷新失败,显示的是旧价格') : null,
		freshLine(row)
	]);
}

function priceInput(row: PendingRow, field: 'buyer' | 'receive'): VNodeChild {
	return h(NInputNumber, {
		size: 'small',
		value: unitsOf(field === 'buyer' ? row.buyerCents : row.receiveCents),
		min: field === 'buyer' ? 0.03 : 0.01,
		step: 0.01,
		precision: 2,
		showButton: false,
		disabled: sell.selling,
		placeholder: field === 'buyer' ? '买家付' : '到手',
		'onUpdate:value': (value: number | null) => updateRow(row.key, current => (field === 'buyer' ? withBuyer(current, centsOf(value)) : withReceive(current, centsOf(value))))
	}, {prefix: () => prefix.value});
}

/** 展开了盘口的组 */
const bookKeys = ref<string[]>([]);

function setBookKeys(keys: DataTableRowKey[]): void {
	bookKeys.value = keys.map(String);
}

/** 打开了价格走势的组(打开才查) */
const chartKeys = ref<string[]>([]);

function toggleChart(key: string): void {
	chartKeys.value = chartKeys.value.includes(key) ? chartKeys.value.filter(entry => entry !== key) : [...chartKeys.value, key];
}

/** 盘口:数据就是参考价那次请求里的 context,不另外请求;我的价按实际买家付排;点出售一档按那个价填买家付 */
function renderOrderBook(row: PendingRow): VNodeChild {
	const data = priceOf(row)?.data;
	if (!data) {
		return h('span', {class: 'muted small'}, '参考价还没查到,查到后显示盘口');
	}
	return h(OrderBook, {
		sellOrders: data.context.sellOrders ?? [],
		buyOrders: data.context.buyOrders ?? [],
		sellTotal: data.context.sellTotal ?? null,
		buyTotal: data.context.buyTotal ?? null,
		currencyId: data.currency.id,
		currencyIso: data.currency.iso,
		myPriceCents: actualBuyer(row) ?? row.buyerCents,
		mySide: 'sell',
		fees: row.fees,
		pickable: sell.selling ? 'none' : 'sell',
		onPick: (_side: string, cents: number) => updateRow(row.key, current => withBuyer(current, cents))
	});
}

/** 展开区:盘口 + 「走势」开关(打开才查价格走势,按 账号|游戏|英文名 缓存) */
function renderBook(row: PendingRow): VNodeChild {
	const open = chartKeys.value.includes(row.key);
	const money = sell.inventory?.currency ?? null;
	return h('div', {class: 'expand-area'}, [
		priceOf(row)?.data ? freshLine(row) : null,
		renderOrderBook(row),
		h('div', [h(NButton, {size: 'tiny', secondary: true, onClick: () => toggleChart(row.key)}, () => (open ? '收起走势' : '走势'))]),
		open && sell.account
			? h(PriceChart, {
				account: sell.account,
				appid: row.group.appid,
				marketHashName: row.group.marketHashName,
				currencyId: money?.id ?? null,
				currencyIso: money?.iso ?? '',
				markPriceCents: actualBuyer(row) ?? row.buyerCents
			})
			: null
	]);
}

const pendingColumns = computed<DataTableColumns<PendingRow>>(() => [
	{type: 'expand', title: '盘口', width: 50, renderExpand: renderBook},
	{title: '物品', key: 'name', minWidth: 220, render: row => groupCell(row.group)},
	{
		title: '数量',
		key: 'quantity',
		width: 150,
		render: row => h('div', {class: 'qty-cell'}, [
			h(NInputNumber, {
				size: 'small',
				value: row.quantity,
				min: 1,
				max: row.group.sellable,
				precision: 0,
				disabled: sell.selling,
				class: 'qty-input',
				'onUpdate:value': (value: number | null) => updateRow(row.key, current => withQuantity(current, value))
			}),
			h(NButton, {
				size: 'tiny',
				quaternary: true,
				disabled: sell.selling || row.quantity === row.group.sellable,
				onClick: () => updateRow(row.key, current => withQuantity(current, current.group.sellable))
			}, () => `全部(${row.group.sellable})`)
		])
	},
	{title: '参考价', key: 'ref', width: 220, render: referenceCell},
	{
		title: '单件买家付',
		key: 'buyer',
		width: 130,
		render: row => {
			const actual = actualBuyer(row);
			return h('div', {class: 'price-cell'}, [
				priceInput(row, 'buyer'),
				actual != null && row.buyerCents != null && actual !== row.buyerCents
					? h('div', {class: 'muted small', title: '这个买家价按 Steam 的规则凑不出整数到手价,到手少 1 分,买家实际付的会少 1 分'}, `实际买家付 ${money(actual, currency.value)}`)
					: null
			]);
		}
	},
	{title: '单件到手', key: 'receive', width: 120, render: row => priceInput(row, 'receive')},
	{
		title: '小计到手',
		key: 'subtotal',
		width: 100,
		render: row => (row.receiveCents == null ? '-' : money(row.receiveCents * row.quantity, currency.value))
	},
	{
		title: '快捷',
		key: 'quick',
		width: 120,
		render: row => {
			const lowest = priceOf(row)?.data?.lowestSell?.buyerPrice ?? null;
			return h('div', {class: 'quick-cell'}, [
				h(NButton, {size: 'tiny', secondary: true, disabled: lowest == null || sell.selling, onClick: () => updateRow(row.key, current => fillFromLowest(current, lowest, false))}, () => '= 最低在售'),
				h(NButton, {size: 'tiny', secondary: true, disabled: lowest == null || sell.selling, onClick: () => updateRow(row.key, current => fillFromLowest(current, lowest, true))}, () => '最低在售 −0.01')
			]);
		}
	},
	{
		title: '',
		key: 'remove',
		width: 60,
		render: row => h(NButton, {size: 'tiny', quaternary: true, type: 'error', disabled: sell.selling, onClick: () => removeRow(row.key)}, () => '移除')
	}
]);

const totals = computed(() => pendingTotals(sell.pending));
const submitError = computed(() => pendingError(sell.pending));
const requestCount = computed(() => expandPending(sell.pending).length);
const batchCount = computed(() => Math.ceil(requestCount.value / SELL_BATCH_MAX));
const etaSeconds = computed(() => Math.ceil(requestCount.value * SELL_GAP_SEC));

/** 正常的上架确认框;verified 时带一行「价格已核对」 */
function openConfirm(verified: boolean): void {
	const rows = [...sell.pending];
	dialog.warning({
		title: `上架 ${rows.length} 种物品,共 ${pendingTotals(rows).pieces} 件`,
		content: () => h('div', {style: 'white-space: pre-wrap'}, [
			sellConfirmText(sell.account || '', rows, currency.value),
			verified ? h('div', {style: 'margin-top: 6px; font-size: 12px; color: var(--ok)'}, '✓ 价格已核对(刚刚)') : null
		]),
		positiveText: '确认上架',
		negativeText: '取消',
		onPositiveClick: () => {
			void doSubmit();
		}
	});
}

let recheckToken: CancelToken | null = null;

function cancelRecheck(): void {
	if (recheckToken) {
		recheckToken.cancelled = true;
	}
}

/** 点「上架」:先把要上架的每种重查一遍(可取消),和定价时看到的比;没变化走正常确认,有变化先警告 */
async function submit(): Promise<void> {
	if (submitError.value) {
		message.warning(submitError.value);
		return;
	}
	if (sell.refreshing) {
		return;
	}
	const rows = [...sell.pending];
	const before = new Map(rows.map(row => [row.key, snapshotOf(priceOf(row)?.data)]));
	const token: CancelToken = {cancelled: false};
	recheckToken = token;
	const results = await refreshPrices(rows, 'recheck', token);
	recheckToken = null;
	if (token.cancelled) {
		message.info('已取消上架');
		return;
	}
	const checks = rows.map(row => {
		const entry = priceOf(row);
		const ok = results.get(row.key) === true;
		return compareRow({
			key: row.key, label: sellItemLabel(row.group), myPrice: myPrice(row),
			before: before.get(row.key) ?? null, after: ok ? snapshotOf(entry?.data) : null, error: ok ? '' : entry?.error || '没拿到最新价格'
		});
	});
	if (recheckSummary(checks).clean) {
		openConfirm(true);
	} else {
		openRecheckWarning(checks);
	}
}

/** 核对出变化 / 失败时的警告框;框里能一键改价,改完重新判断,全都没问题了就换成正常确认框 */
const recheck = reactive({checks: [] as RowCheck[]});

function applySuggestion(check: RowCheck, close: () => void): void {
	if (check.suggestion == null) {
		return;
	}
	updateRow(check.key, row => withBuyer(row, check.suggestion));
	const row = sell.pending.find(entry => entry.key === check.key);
	// 改过价就是按最新价格定的了:以新价为基准重新判断
	recheck.checks = recheck.checks.map(entry => (entry.key === check.key && row
		? compareRow({key: entry.key, label: entry.label, myPrice: myPrice(row), before: entry.after, after: entry.after})
		: entry));
	if (recheckSummary(recheck.checks).clean) {
		close();
		openConfirm(true);
	}
}

function renderCheck(check: RowCheck, close: () => void): VNodeChild {
	const format = (cents: number | null) => money(cents, currency.value);
	return h('div', {class: 'recheck-row'}, [
		h('div', {class: 'recheck-name'}, [h('strong', check.label), h('span', {class: 'muted'}, ` · ${check.reasons.join(',')}`)]),
		h('div', `最低在售:${moveText(check.before?.lowestSell ?? null, check.after?.lowestSell ?? null, format)}`),
		h('div', `你的单价:${format(check.myPrice)}`),
		h('div', `名次:${rankText(check.rankBefore)} → ${rankText(check.rankAfter)}`),
		check.belowBuyOrder ? h('div', {style: 'color: var(--danger)'}, `你的价低于最高求购 ${format(check.after?.highestBuy ?? null)}(可能卖亏了)`) : null,
		check.suggestion != null
			? h(NButton, {size: 'tiny', type: 'primary', secondary: true, style: 'margin-top: 4px', onClick: () => applySuggestion(check, close)}, () => `改为 新最低在售 −0.01(${format(check.suggestion)})`)
			: null
	]);
}

function openRecheckWarning(checks: RowCheck[]): void {
	recheck.checks = checks;
	const instance = dialog.warning({
		title: '价格变了,先看一下再上架',
		style: 'width: 560px; max-width: calc(100vw - 32px)',
		content: () => {
			const close = () => instance.destroy();
			const summary = recheckSummary(recheck.checks);
			const failedPieces = summary.failed.reduce((sum, check) => sum + (sell.pending.find(row => row.key === check.key)?.quantity ?? 0), 0);
			return h('div', {class: 'recheck'}, [
				summary.changed.length ? h('div', {class: 'muted'}, `刚重查了 Steam 的最新价格,${summary.changed.length} 种和你定价时看到的不一样:`) : null,
				...summary.changed.map(check => renderCheck(check, close)),
				summary.failed.length
					? h('div', {class: 'recheck-failed'}, [
						h('div', {style: 'color: var(--warn)'}, `${summary.failed.length} 种(共 ${failedPieces} 件)没能核对最新价格:`),
						...summary.failed.map(check => h('div', {class: 'muted'}, `${check.label}:${check.error}`))
					])
					: null
			]);
		},
		positiveText: '返回修改',
		negativeText: '按原价继续上架',
		onPositiveClick: () => {
			const until = Date.now() + STALE_MS;
			const marks = {...flagged.value};
			for (const check of recheckSummary(recheck.checks).changed) {
				marks[check.key] = until;
			}
			flagged.value = marks;
			nowTick.value = Date.now();
		},
		onNegativeClick: () => {
			void doSubmit();
		}
	});
}

async function doSubmit(): Promise<void> {
	try {
		const run = await submitSell();
		const summary = sellSummary(run);
		message[summary.level](summary.text + (run.error ? `;中途出错:${run.error}` : ''), {duration: 8000});
	} catch (err) {
		message.error('上架失败:' + errorText(err), {duration: 8000});
	}
}

// ===== 上架结果 =====
const detailColumns: DataTableColumns<SentItem> = [
	{title: 'assetid', key: 'assetid', width: 150, render: sent => sent.request.assetid + (sent.request.amount > 1 ? ` ×${sent.request.amount}` : '')},
	{
		title: '结果',
		key: 'status',
		width: 90,
		render: sent => {
			const status = SELL_STATUS_LABELS[sentStatus(sent)];
			return h(NTag, {size: 'small', bordered: false, type: status.tone}, () => status.label);
		}
	},
	{title: '买家付', key: 'buyer', width: 90, render: sent => (sent.outcome ? money(sent.outcome.buyerPriceCents, sell.lastResult?.currency ?? currency.value) : '-')},
	{title: '说明', key: 'message', minWidth: 200, ellipsis: {tooltip: true}, render: sent => sentMessage(sent)}
];
</script>

<template>
	<div class="sell-tab">
		<NCard size="small" :bordered="false" title="库存">
			<template #header-extra>
				<span v-if="sell.inventory" class="muted small">
					{{ sellGroups.length }} 种 · 共 {{ sell.inventory.total }} 件,可出售 {{ sell.inventory.marketableCount }} 件 · 币种 {{ sell.inventory.currency.iso || '未知' }}
				</span>
			</template>
			<div class="toolbar">
				<NSelect
					class="account-select"
					filterable
					:value="sell.account"
					:options="accountOptions"
					:placeholder="accountPlaceholder"
					:disabled="!market.accounts.length || sell.selling"
					@update:value="pickAccount"
				/>
				<NSelect class="game-select" :value="sell.appid" :options="(SELL_GAMES as SelectOption[])" :disabled="sell.selling" @update:value="setSellGame" />
				<NButton :loading="sell.inventoryLoading" :disabled="!sell.account || sell.selling" @click="loadInventory(true)">刷新库存</NButton>
				<NInput :value="sell.filterText" class="filter-input" clearable placeholder="搜物品:中文或英文名" @update:value="setFilterText" />
				<span class="switch">
					<NSwitch :value="sell.onlyMarketable" size="small" @update:value="setOnlyMarketable" />
					只看可出售
				</span>
			</div>
			<NAlert v-if="sell.inventoryError" type="error" :bordered="false" class="block">{{ sell.inventoryError }}</NAlert>
			<NDataTable
				size="small"
				:columns="inventoryColumns"
				:data="visibleGroups"
				:loading="sell.inventoryLoading"
				:row-key="(group: SellGroup) => group.key"
				:pagination="{pageSize: 30}"
				:scroll-x="900"
			>
				<template #empty>
					<span class="muted">{{ inventoryEmpty }}</span>
				</template>
			</NDataTable>
		</NCard>

		<NCard size="small" :bordered="false" :title="`待上架(${sell.pending.length} 种,${totals.pieces} 件)`">
			<template #header-extra>
				<NSpace align="center" :size="6">
					<span v-if="refreshingAll" class="muted small">刷新中 {{ sell.refreshing?.done }}/{{ sell.refreshing?.total }}</span>
					<NButton size="small" quaternary :loading="refreshingAll" :disabled="!sell.pending.length || sell.selling || !!sell.refreshing" @click="refreshAll">全部刷新</NButton>
					<NButton size="small" quaternary :disabled="!sell.pending.length || sell.selling || !!sell.refreshing" @click="replacePending([])">清空</NButton>
				</NSpace>
			</template>
			<NDataTable size="small" :columns="pendingColumns" :data="sell.pending" :row-key="(row: PendingRow) => row.key" :max-height="560" :scroll-x="1150"
				:expanded-row-keys="bookKeys" :row-class-name="rowClass" @update:expanded-row-keys="setBookKeys">
				<template #empty>
					<span class="muted">在上面的库存里勾选要卖的物品;同名的是一行,填数量和单件价(买家付和到手填一个,另一个按 Steam 手续费自动算)</span>
				</template>
			</NDataTable>
			<div class="sell-footer">
				<div class="totals">
					<span>已定价 {{ totals.priced }} / {{ sell.pending.length }} 种</span>
					<span>共 {{ totals.pieces }} 件</span>
					<span>买家共付 <strong>{{ money(totals.buyer, currency) }}</strong></span>
					<span>到手共 <strong>{{ money(totals.receive, currency) }}</strong></span>
				</div>
				<NSpace align="center" :size="8">
					<template v-if="rechecking">
						<span class="muted small">上架前核对最新价格 {{ sell.refreshing?.done }}/{{ sell.refreshing?.total }}…</span>
						<NButton size="small" @click="cancelRecheck">取消</NButton>
					</template>
					<span v-else-if="sell.selling" class="muted small">
						正在上架{{ sell.progress.batches > 1 ? ` 第 ${sell.progress.batch}/${sell.progress.batches} 批` : '' }},全部大约 {{ etaSeconds }} 秒,自动确认还要再等一会…
					</span>
					<span v-else-if="sell.pending.length && submitError" class="warn-text small">{{ submitError }}</span>
					<span v-else-if="batchCount > 1" class="muted small">超过 {{ SELL_BATCH_MAX }} 件,会分 {{ batchCount }} 批依次提交</span>
					<NButton type="primary" :loading="sell.selling || rechecking" :disabled="!sell.pending.length || !!submitError || refreshingAll" @click="submit">
						上架{{ totals.pieces ? `(${totals.pieces} 件)` : '' }}
					</NButton>
				</NSpace>
			</div>
		</NCard>

		<NCard v-if="sell.lastResult" size="small" :bordered="false" title="上架结果">
			<template #header-extra>
				<NSpace align="center" :size="8">
					<span class="small">{{ sellSummary(sell.lastResult).text }}</span>
					<NButton size="tiny" quaternary @click="clearResult">收起</NButton>
				</NSpace>
			</template>
			<NAlert v-if="sell.lastResult.error" type="error" :bordered="false" class="block">
				中途出错,后面的批次没有提交:{{ sell.lastResult.error }}。没上架的件数留在待上架里,可以再试。
			</NAlert>
			<NAlert v-if="sell.lastResult.needsMobile" type="warning" :bordered="false" class="block">
				有物品还要在 Steam 手机 App 里确认上架,确认前不会出现在市场上;可以在「我的在售」里看「待确认」的。
			</NAlert>
			<NCollapse>
				<NCollapseItem v-for="group in sell.lastResult.groups" :key="group.key" :name="group.key">
					<template #header>
						<span :class="group.failed ? 'warn-text' : ''">{{ groupResultText(group) }}</span>
					</template>
					<NDataTable size="small" :columns="detailColumns" :data="group.details" :row-key="(row: SentItem) => row.request.assetid" :max-height="260" />
				</NCollapseItem>
			</NCollapse>
		</NCard>
	</div>
</template>

<style scoped>
.sell-tab {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	margin-bottom: 10px;
}

.account-select {
	width: 300px;
}

.game-select {
	width: 100px;
}

.filter-input {
	width: 240px;
}

.switch {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
}

.block {
	margin-bottom: 10px;
}

.small {
	font-size: 12px;
}

.warn-text {
	color: var(--warn);
}

.sell-footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-top: 10px;
}

.totals {
	display: flex;
	flex-wrap: wrap;
	gap: 16px;
	font-size: 13px;
}

:deep(.item-cell) {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

:deep(.item-thumb) {
	width: 40px;
	height: 30px;
	flex: none;
	object-fit: contain;
}

:deep(.item-text) {
	min-width: 0;
	line-height: 1.3;
}

:deep(.item-main),
:deep(.item-sub) {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

:deep(.item-sub) {
	font-size: 11px;
}

:deep(.ref) {
	display: flex;
	flex-direction: column;
	gap: 2px;
	font-size: 12px;
}

:deep(.price-cell),
:deep(.quick-cell) {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 2px;
}

:deep(.fresh-line) {
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
}

:deep(.row-flagged td) {
	background: var(--accent-soft) !important;
}

:deep(.expand-area) {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

:deep(.qty-cell) {
	display: flex;
	align-items: center;
	gap: 2px;
}

:deep(.qty-input) {
	width: 70px;
}

:deep(.small) {
	font-size: 11px;
}

:deep(.warn-text) {
	color: var(--warn);
}

:deep(.ok-text) {
	color: var(--ok);
	font-weight: 600;
}
</style>

<style>
/* 核对警告框(挂在 body 下,scoped 样式管不到) */
.recheck {
	display: flex;
	flex-direction: column;
	gap: 10px;
	max-height: 60vh;
	overflow: auto;
	font-size: 13px;
}

.recheck-row {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 2px;
	padding: 8px 10px;
	border-radius: 6px;
	background: var(--accent-soft);
}

.recheck-failed {
	display: flex;
	flex-direction: column;
	gap: 2px;
}
</style>
