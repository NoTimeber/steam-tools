/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	aggregate, bucketStart, DAY_MS, filterRange, formatPointTime, HOUR_MS, nearestIndex, niceTicks, rangeDays, rangeOption, summarize
} from './pricehistory.ts';
import type {PricePoint} from './pricehistory.ts';

const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const p = (hours: number, priceCents: number, volume: number): PricePoint => ({time: T0 + hours * HOUR_MS, priceCents, volume});

test('范围:按 now 往前取;全部不筛', () => {
	const points = [p(0, 100, 1), p(24 * 5, 110, 1), p(24 * 9 - 1, 120, 1), p(24 * 10 - 1, 130, 1)];
	const now = T0 + 10 * DAY_MS;
	assert.deepEqual(filterRange(points, rangeOption('1d'), now).map(point => point.priceCents), [130]);
	assert.deepEqual(filterRange(points, rangeOption('7d'), now).map(point => point.priceCents), [110, 120, 130]);
	assert.equal(filterRange(points, rangeOption('all'), now).length, 4);
	assert.equal(rangeDays(rangeOption('7d'), points, now), 7);
	assert.equal(rangeDays(rangeOption('all'), points, now), 10);
});

test('合并成桶:按 UTC 对齐,价格按成交量加权,数量相加;都没成交量时取平均', () => {
	assert.equal(bucketStart(T0 + 7 * HOUR_MS + 5, '6h'), T0 + 6 * HOUR_MS);
	assert.equal(bucketStart(T0 + 23 * HOUR_MS, 'day'), T0);
	const hourly = [p(1, 100, 1), p(2, 200, 3), p(7, 300, 2), p(25, 400, 0), p(26, 500, 0)];
	assert.deepEqual(aggregate(hourly, '6h'), [
		{time: T0, priceCents: 175, volume: 4},
		{time: T0 + 6 * HOUR_MS, priceCents: 300, volume: 2},
		{time: T0 + 24 * HOUR_MS, priceCents: 450, volume: 0}
	]);
	assert.deepEqual(aggregate(hourly, 'day').map(point => [point.priceCents, point.volume]), [[217, 6], [450, 0]]);
	assert.deepEqual(aggregate([p(3, 100, 1)], 'hour'), [{time: T0 + 3 * HOUR_MS, priceCents: 100, volume: 1}]);
	assert.deepEqual(aggregate([], 'day'), []);
});

test('区间统计:最新、涨跌和百分比、最高最低、总售出、日均', () => {
	const summary = summarize([p(0, 200, 10), p(24, 250, 5), p(48, 150, 15)], 3)!;
	assert.deepEqual(summary, {latest: 150, change: -50, changePercent: -25, high: 250, low: 150, totalVolume: 30, dailyVolume: 10});
	assert.equal(summarize([]), null);
	assert.equal(summarize([p(0, 0, 1), p(1, 5, 1)])!.changePercent, null, '起点价为 0 不算百分比');
});

test('刻度:1/2/5 步长,覆盖最小最大;相等时上下留空', () => {
	assert.deepEqual(niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
	assert.deepEqual(niceTicks(213, 287, 4), [200, 220, 240, 260, 280, 300]);
	assert.deepEqual(niceTicks(250, 250, 4), [220, 240, 260, 280]);
	assert.deepEqual(niceTicks(0, 3, 4), [0, 1, 2, 3]);
	assert.deepEqual(niceTicks(Number.NaN, 1), []);
});

test('时间文字、最近的点', () => {
	const local = new Date(2026, 9, 14, 9, 0, 0).getTime();
	assert.equal(formatPointTime(local, 'hour'), '10-14 09:00');
	assert.equal(formatPointTime(local, 'day'), '2026-10-14');
	const points = [p(0, 1, 1), p(5, 1, 1), p(10, 1, 1)];
	assert.equal(nearestIndex(points, T0 + 6 * HOUR_MS), 1);
	assert.equal(nearestIndex(points, T0 + 100 * HOUR_MS), 2);
	assert.equal(nearestIndex([], T0), -1);
});
