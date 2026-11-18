<script setup lang="ts">
// 市场盘口:左「出售」(从低到高)、右「求购」(从高到低),每档价格 / 数量 / 累计,背景条按数量画深度;默认前 5 档,可展开。
// 给了 myPriceCents(买家价)时在 mySide 那一边标出这个价排在哪(同价那一档高亮,不同价插一行),下面一行文字说明前面有多少。
// 给了 fees 时出售一边多一列「到手」(按 Steam 手续费,和上架算法一样)。点价格发 pick 事件(pickable 那一边)。
import {computed, reactive} from 'vue';
import {receiveForBuyerPrice} from '../../lib/market-fees.ts';
import type {FeeConfig} from '../../lib/market-fees.ts';
import {formatCentsIn} from '../../lib/market.ts';
import {barPercent, BOOK_DEFAULT_LEVELS, bookPosition, bookRows, maxQuantity, positionText} from '../../lib/orderbook.ts';
import type {BookRow, BookSide, OrderLevel} from '../../lib/orderbook.ts';

const props = withDefaults(defineProps<{
	sellOrders?: OrderLevel[] | null;
	buyOrders?: OrderLevel[] | null;
	sellTotal?: number | null;
	buyTotal?: number | null;
	currencyId?: number | null;
	currencyIso?: string;
	/** 我的价(买家价,分) */
	myPriceCents?: number | null;
	/** 我的价排在哪一边 */
	mySide?: BookSide;
	/** 给了就在出售一边显示每档的到手价 */
	fees?: FeeConfig | null;
	/** 哪一边的价格能点 */
	pickable?: BookSide | 'both' | 'none';
}>(), {
	sellOrders: () => [],
	buyOrders: () => [],
	sellTotal: null,
	buyTotal: null,
	currencyId: null,
	currencyIso: '',
	myPriceCents: null,
	mySide: 'sell',
	fees: null,
	pickable: 'none'
});

const emit = defineEmits<{pick: [side: BookSide, priceCents: number]}>();

const expanded = reactive({sell: false, buy: false});

const format = (cents: number | null | undefined) => formatCentsIn(cents, props.currencyId, props.currencyIso);

interface SideView {
	side: BookSide;
	title: string;
	unit: string;
	total: number | null;
	levels: OrderLevel[];
	rows: BookRow[];
	max: number;
	note: string;
	canPick: boolean;
	showReceive: boolean;
}

function sideView(side: BookSide): SideView {
	const levels = (side === 'sell' ? props.sellOrders : props.buyOrders) ?? [];
	const mine = props.mySide === side ? props.myPriceCents : null;
	const rows = bookRows(levels, side, mine, expanded[side]);
	const shown = rows.flatMap(row => (row.kind === 'level' ? [row.level] : []));
	const position = mine != null ? bookPosition(levels, side, mine) : null;
	return {
		side,
		title: side === 'sell' ? '出售' : '求购',
		unit: side === 'sell' ? '件' : '个',
		total: side === 'sell' ? props.sellTotal : props.buyTotal,
		levels,
		rows,
		max: maxQuantity(shown),
		note: position && mine != null && levels.length ? positionText(side, mine, position, cents => format(cents)) : '',
		canPick: props.pickable === 'both' || props.pickable === side,
		showReceive: side === 'sell' && !!props.fees
	};
}

const sides = computed(() => [sideView('sell'), sideView('buy')]);

function receiveOf(priceCents: number): string {
	return props.fees ? format(receiveForBuyerPrice(priceCents, props.fees).receive) : '';
}
</script>

<template>
	<div class="order-book">
		<div v-for="view in sides" :key="view.side" class="book-side" :class="`book-${view.side}`">
			<div class="book-head">
				<strong>{{ view.title }}</strong>
				<span class="muted">{{ view.side === 'sell' ? '在售' : '求购' }} {{ view.total ?? '-' }} {{ view.unit }}</span>
			</div>
			<template v-if="view.levels.length">
				<div class="book-row book-cols" :class="{'with-receive': view.showReceive}">
					<span>价格</span>
					<span v-if="view.showReceive">到手</span>
					<span class="num">数量</span>
					<span class="num">累计</span>
				</div>
				<template v-for="row in view.rows" :key="row.kind === 'level' ? `l${row.level.priceCents}` : 'mine'">
					<div v-if="row.kind === 'mine'" class="book-row book-mine" :class="{'with-receive': view.showReceive}">
						<span>{{ format(row.priceCents) }}</span>
						<span v-if="view.showReceive">{{ receiveOf(row.priceCents) }}</span>
						<span class="num mine-label">← 我的价</span>
						<span />
					</div>
					<div v-else class="book-row" :class="{'with-receive': view.showReceive, 'book-hit': row.mine}">
						<div class="bar" :style="{width: `${barPercent(row.level.quantity, view.max)}%`}" />
						<span>
							<a v-if="view.canPick" class="price-link" :title="`按 ${format(row.level.priceCents)} 填价`" @click="emit('pick', view.side, row.level.priceCents)">{{ format(row.level.priceCents) }}</a>
							<template v-else>{{ format(row.level.priceCents) }}</template>
							<span v-if="row.mine" class="mine-label"> ← 我的价</span>
						</span>
						<span v-if="view.showReceive" class="muted">{{ receiveOf(row.level.priceCents) }}</span>
						<span class="num">{{ row.level.quantity }}</span>
						<span class="num muted">{{ row.level.cumulative }}</span>
					</div>
				</template>
				<a v-if="view.levels.length > BOOK_DEFAULT_LEVELS" class="toggle" @click="expanded[view.side] = !expanded[view.side]">
					{{ expanded[view.side] ? '收起' : `展开全部(${view.levels.length} 档)` }}
				</a>
			</template>
			<div v-else class="muted empty">暂无{{ view.title }}盘口</div>
			<div v-if="view.note" class="book-note">{{ view.note }}</div>
		</div>
	</div>
</template>

<style scoped>
.order-book {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
	gap: 8px 16px;
	font-size: 12px;
}

.book-side {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
}

.book-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	margin-bottom: 2px;
}

.book-row {
	position: relative;
	display: grid;
	grid-template-columns: minmax(0, 1fr) 56px 56px;
	gap: 6px;
	padding: 1px 4px;
	border-radius: 3px;
	align-items: center;
}

.book-row.with-receive {
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 50px 50px;
}

.book-row > span {
	position: relative;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.book-cols {
	color: var(--muted);
}

.num {
	text-align: right;
}

.bar {
	position: absolute;
	top: 1px;
	right: 0;
	bottom: 1px;
	border-radius: 3px;
	opacity: 0.14;
	pointer-events: none;
}

.book-sell .bar {
	background: var(--warn);
}

.book-buy .bar {
	background: var(--ok);
}

.book-hit {
	box-shadow: inset 0 0 0 1px var(--info);
}

.book-mine {
	border: 1px dashed var(--info);
}

.mine-label {
	color: var(--info);
	font-weight: 600;
}

.price-link {
	cursor: pointer;
	text-decoration: underline dotted;
}

.toggle {
	margin-top: 2px;
	cursor: pointer;
	color: var(--muted);
}

.book-note {
	margin-top: 4px;
	color: var(--info);
}

.empty {
	padding: 4px 0;
}
</style>
