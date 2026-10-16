/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isoDate, monthDays, monthOf, orderedRange, shiftMonth} from './calendar.ts';

test('日历:周一开头 42 格,前后补齐的日子标成非本月', () => {
	// 2026-10-01 是周四,前面补 9-28、9-29、9-30
	const days = monthDays({year: 2026, month: 9});
	assert.equal(days.length, 42);
	assert.deepEqual(days.slice(0, 4), [
		{date: '2026-09-28', day: 28, inMonth: false},
		{date: '2026-09-29', day: 29, inMonth: false},
		{date: '2026-09-30', day: 30, inMonth: false},
		{date: '2026-10-01', day: 1, inMonth: true}
	]);
	assert.equal(days.filter(day => day.inMonth).length, 31);
	assert.deepEqual(days[41], {date: '2026-11-08', day: 8, inMonth: false});
	// 2026-06-01 是周一,第一格就是 1 号
	assert.equal(monthDays({year: 2026, month: 5})[0]?.date, '2026-06-01');
	// 闰年二月
	assert.equal(monthDays({year: 2028, month: 1}).filter(day => day.inMonth).length, 29);
});

test('翻月跨年、日期所在月份、起止排序', () => {
	assert.deepEqual(shiftMonth({year: 2026, month: 0}, -1), {year: 2025, month: 11});
	assert.deepEqual(shiftMonth({year: 2026, month: 11}, 1), {year: 2027, month: 0});
	assert.deepEqual(shiftMonth({year: 2026, month: 9}, -12), {year: 2025, month: 9});
	const fallback = {year: 2000, month: 0};
	assert.deepEqual(monthOf('2026-03-15', fallback), {year: 2026, month: 2});
	assert.deepEqual(monthOf(null, fallback), fallback);
	assert.deepEqual(monthOf('2026 年 3 月', fallback), fallback);
	assert.deepEqual(orderedRange('2026-10-16', '2026-10-01'), ['2026-10-01', '2026-10-16']);
	assert.deepEqual(orderedRange('2026-10-01', '2026-10-01'), ['2026-10-01', '2026-10-01']);
	assert.equal(isoDate(new Date(2026, 0, 5)), '2026-01-05');
});
