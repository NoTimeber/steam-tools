/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareRow, freshness, moveText, rankText, recheckSummary, snapshotOf} from './sell-recheck.ts';
import type {PriceSnapshot} from './sell-recheck.ts';

const snap = (lowestSell: number | null, highestBuy: number | null, levels: Array<[number, number]>): PriceSnapshot => {
	let cumulative = 0;
	return {lowestSell, highestBuy, sellOrders: levels.map(([priceCents, quantity]) => ({priceCents, quantity, cumulative: (cumulative += quantity)}))};
};
const yuan = (cents: number | null) => (cents == null ? '—' : `¥${(cents / 100).toFixed(2)}`);

test('新鲜度:刚刚 / 秒 / 分钟 / 小时,超过 2 分钟算可能过时', () => {
	const now = 1_000_000_000;
	assert.equal(freshness(null, now), null);
	assert.deepEqual(freshness(now - 3_000, now), {text: '刚刚', stale: false});
	assert.deepEqual(freshness(now - 45_000, now), {text: '45 秒前', stale: false});
	assert.deepEqual(freshness(now - 120_000, now), {text: '2 分钟前', stale: false});
	assert.deepEqual(freshness(now - 121_000, now), {text: '2 分钟前', stale: true});
	assert.deepEqual(freshness(now - 2 * 3_600_000, now), {text: '2 小时前', stale: true});
});

test('参考价快照:最低在售 / 最高求购取买家价,盘口取在售分档', () => {
	const price = {
		context: {lowestSellOrderCents: 270, highestBuyOrderCents: 250, sellOrders: [{priceCents: 270, quantity: 1, cumulative: 1}]},
		lowestSell: {buyerPrice: 270, receive: 235, steamFee: 13, publisherFee: 22, fees: 35},
		highestBuyOrder: null
	} as never;
	assert.deepEqual(snapshotOf(price), {lowestSell: 270, highestBuy: 250, sellOrders: [{priceCents: 270, quantity: 1, cumulative: 1}]});
	assert.equal(snapshotOf(null), null);
});

test('核对:没变化 → same;最低在售降了、我的价不再最低、名次变差 → changed,并给出建议价', () => {
	const before = snap(270, 250, [[270, 3], [275, 5]]);
	const same = compareRow({key: 'a', label: '千瓦', myPrice: 269, before, after: snap(270, 255, [[270, 4], [275, 5]])});
	assert.equal(same.status, 'same', '只有最高求购变了、同档数量变了不算');
	assert.equal(rankText(same.rankAfter), '第 1 档(最低价)');

	const cheaper = compareRow({key: 'a', label: '千瓦', myPrice: 269, before, after: snap(265, 250, [[265, 2], [270, 3]])});
	assert.equal(cheaper.status, 'changed');
	assert.deepEqual(cheaper.reasons, ['最低在售变了', '你的价不再是最低', '名次变差了']);
	assert.equal(cheaper.suggestion, 264);
	assert.equal(rankText(cheaper.rankBefore), '第 1 档(最低价)');
	assert.equal(rankText(cheaper.rankAfter), '前面有 2 件更便宜(第 2 档)');
	assert.equal(moveText(270, 265, yuan), '¥2.70 → ¥2.65(↓0.05)');
	assert.equal(moveText(270, 270, yuan), '¥2.70(没变)');
	assert.equal(moveText(null, 265, yuan), '— → ¥2.65');

	// 最低在售没变,但我前面多了同价以下的件:名次变差
	const crowded = compareRow({key: 'a', label: '千瓦', myPrice: 280, before, after: snap(270, 250, [[270, 6], [275, 5]])});
	assert.deepEqual(crowded.reasons, ['名次变差了']);
});

test('核对:新跌到最高求购以下要提示;重查失败记 failed;没看过旧价只做新价检查', () => {
	const before = snap(270, 250, [[270, 3]]);
	const below = compareRow({key: 'a', label: '千瓦', myPrice: 255, before, after: snap(270, 260, [[270, 3]])});
	assert.equal(below.belowBuyOrder, true);
	assert.deepEqual(below.reasons, ['你的价低于最高求购了']);
	const alreadyBelow = compareRow({key: 'a', label: '千瓦', myPrice: 240, before, after: snap(270, 250, [[270, 3]])});
	assert.equal(alreadyBelow.status, 'same', '原来就低于最高求购不算新变化');
	assert.equal(alreadyBelow.belowBuyOrder, true);

	const failed = compareRow({key: 'b', label: '反冲', myPrice: 100, before, after: null, error: '429 Too Many Requests'});
	assert.equal(failed.status, 'failed');
	assert.equal(failed.error, '429 Too Many Requests');

	const fresh = compareRow({key: 'c', label: '画廊', myPrice: 100, before: null, after: snap(3, null, [[3, 1]])});
	assert.equal(fresh.status, 'same');
	assert.equal(fresh.suggestion, null, '新最低 0.03 减一分低于 0.03,不给建议');

	const summary = recheckSummary([below, failed, fresh]);
	assert.deepEqual([summary.changed.map(c => c.key), summary.failed.map(c => c.key), summary.clean], [['a'], ['b'], false]);
	assert.equal(recheckSummary([fresh]).clean, true);
});
