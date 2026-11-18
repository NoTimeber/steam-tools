// 出售前核对价格的纯逻辑(不依赖 Vue):参考价新不新鲜、上架前重查后和用户定价时看到的比有没有实质变化、变化说明。
// 「实质变化」:最低在售变了;或者我的价原来 ≤ 最低在售、现在比最低在售高(不再最便宜);或者在出售一边的名次变差;
// 或者我的价新跌到了最高求购以下(可能卖亏)。只有最高求购变了不算。

import type {SellPrice} from './market-sell.ts';
import {bookPosition} from './orderbook.ts';
import type {BookPosition, OrderLevel} from './orderbook.ts';

/** 参考价多久算可能过时 */
export const STALE_MS = 2 * 60_000;

/** 「刚刚 / 35 秒前 / 3 分钟前」;stale 是超过 2 分钟 */
export function freshness(fetchedAt: number | null | undefined, now: number): {text: string; stale: boolean} | null {
	if (!fetchedAt) {
		return null;
	}
	const age = Math.max(0, now - fetchedAt);
	const text = age < 10_000 ? '刚刚' : age < 60_000 ? `${Math.floor(age / 1000)} 秒前` : age < 3_600_000 ? `${Math.floor(age / 60_000)} 分钟前` : `${Math.floor(age / 3_600_000)} 小时前`;
	return {text, stale: age > STALE_MS};
}

/** 比较用的一份参考价 */
export interface PriceSnapshot {
	/** 最低在售(买家价,分) */
	lowestSell: number | null;
	/** 最高求购(买家价,分) */
	highestBuy: number | null;
	sellOrders: OrderLevel[];
}

export function snapshotOf(price: Pick<SellPrice, 'context' | 'lowestSell' | 'highestBuyOrder'> | null | undefined): PriceSnapshot | null {
	if (!price) {
		return null;
	}
	return {
		lowestSell: price.lowestSell?.buyerPrice ?? price.context.lowestSellOrderCents ?? null,
		highestBuy: price.highestBuyOrder?.buyerPrice ?? price.context.highestBuyOrderCents ?? null,
		sellOrders: price.context.sellOrders ?? []
	};
}

export interface RowCheck {
	key: string;
	label: string;
	/** 我的单价(买家实际付,分) */
	myPrice: number | null;
	status: 'same' | 'changed' | 'failed';
	/** 重查失败的原因 */
	error: string;
	before: PriceSnapshot | null;
	after: PriceSnapshot | null;
	rankBefore: BookPosition | null;
	rankAfter: BookPosition | null;
	/** 为什么算变化(给人看的短句) */
	reasons: string[];
	/** 我的价低于新的最高求购 */
	belowBuyOrder: boolean;
	/** 「改为 新最低在售 −0.01」的价;低于 3 分或没有在售为 null */
	suggestion: number | null;
}

/** 名次变差:前面更便宜的变多了,或者档位往后了 */
function rankWorse(before: BookPosition | null, after: BookPosition | null): boolean {
	return !!before && !!after && (after.ahead > before.ahead || after.level > before.level);
}

/** 一行的核对结果。before 是用户定价时看到的,after 是刚重查的;error 是重查失败的原因 */
export function compareRow(input: {key: string; label: string; myPrice: number | null; before: PriceSnapshot | null; after: PriceSnapshot | null; error?: string}): RowCheck {
	const {key, label, myPrice, before} = input;
	const after = input.error ? null : input.after;
	const rankBefore = before && myPrice != null ? bookPosition(before.sellOrders, 'sell', myPrice) : null;
	const rankAfter = after && myPrice != null ? bookPosition(after.sellOrders, 'sell', myPrice) : null;
	const base = {key, label, myPrice, before, after, rankBefore, rankAfter};
	if (!after) {
		return {...base, status: 'failed', error: input.error || '没拿到最新价格', reasons: [], belowBuyOrder: false, suggestion: null};
	}
	const suggestion = after.lowestSell != null && after.lowestSell - 1 >= 3 ? after.lowestSell - 1 : null;
	const belowBuyOrder = myPrice != null && after.highestBuy != null && myPrice < after.highestBuy;
	const reasons: string[] = [];
	if (before) {
		if (before.lowestSell !== after.lowestSell) {
			reasons.push('最低在售变了');
		}
		if (myPrice != null && before.lowestSell != null && after.lowestSell != null && myPrice <= before.lowestSell && myPrice > after.lowestSell) {
			reasons.push('你的价不再是最低');
		}
		if (rankWorse(rankBefore, rankAfter)) {
			reasons.push('名次变差了');
		}
		const wasBelow = myPrice != null && before.highestBuy != null && myPrice < before.highestBuy;
		if (belowBuyOrder && !wasBelow) {
			reasons.push('你的价低于最高求购了');
		}
	}
	return {...base, status: reasons.length ? 'changed' : 'same', error: '', reasons, belowBuyOrder, suggestion};
}

/** 名次说明:「第 1 档(最低价)」/「前面有 3 件更便宜(第 2 档)」 */
export function rankText(position: BookPosition | null): string {
	if (!position) {
		return '—';
	}
	if (!position.ahead && !position.beyond) {
		return `第 ${position.level} 档(最低价)`;
	}
	return `前面${position.beyond ? '至少' : ''}有 ${position.ahead} 件更便宜(第 ${position.level} 档${position.beyond ? '之后' : ''})`;
}

/** 「¥2.70 → ¥2.65(↓0.05)」;没变给「¥2.70(没变)」 */
export function moveText(before: number | null, after: number | null, format: (cents: number | null) => string): string {
	if (before === after) {
		return `${format(after)}(没变)`;
	}
	if (before == null || after == null) {
		return `${format(before)} → ${format(after)}`;
	}
	const diff = after - before;
	return `${format(before)} → ${format(after)}(${diff > 0 ? '↑' : '↓'}${(Math.abs(diff) / 100).toFixed(2)})`;
}

export function recheckSummary(checks: readonly RowCheck[]): {changed: RowCheck[]; failed: RowCheck[]; clean: boolean} {
	const changed = checks.filter(check => check.status === 'changed');
	const failed = checks.filter(check => check.status === 'failed');
	return {changed, failed, clean: !changed.length && !failed.length};
}
