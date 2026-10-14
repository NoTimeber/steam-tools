/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceConfirmText, filterTerminals, formatExpire, offerLines, picks} from './terminal.ts';
import type {TerminalItem} from './terminal.ts';

const item = (id: string, fields: Partial<TerminalItem> = {}): TerminalItem => ({id, defIndex: 5176, sealed: false, ...fields});

test('筛选:类型和解封状态', () => {
	const list = [item('1', {sealed: true}), item('2'), item('3', {defIndex: 5181}), item('4', {defIndex: 5181, sealed: true})];
	assert.deepEqual(filterTerminals(list, 'all', 'all').map(t => t.id), ['1', '2', '3', '4']);
	assert.deepEqual(filterTerminals(list, '5181', 'all').map(t => t.id), ['3', '4']);
	assert.deepEqual(filterTerminals(list, 'all', 'sealed').map(t => t.id), ['1', '4']);
	assert.deepEqual(filterTerminals(list, '5176', 'open').map(t => t.id), ['2']);
});

test('挑选次数:优先后端给的,老字段兜底,上限缺省 5', () => {
	assert.deepEqual(picks(item('1', {picksUsed: 2, picksMax: 5, picksLeft: 3})), {used: 2, max: 5, left: 3});
	assert.deepEqual(picks(item('1', {pointsRemaining: 4})), {used: 4, max: 5, left: 1});
	assert.deepEqual(picks(item('1', {picksUsed: 7})), {used: 7, max: 5, left: 0});
	assert.deepEqual(picks(item('1')), {used: null, max: 5, left: null});
});

test('报价文字与时间', () => {
	assert.deepEqual(offerLines({exterior: '久经沙场', wear: 0.123456, rarity: '保密', paintseed: 661}), ['久经沙场 · 磨损 0.1235', '保密 · 图案 661']);
	assert.deepEqual(offerLines({}), ['', '']);
	assert.equal(formatExpire(null), '-');
	assert.notEqual(formatExpire(Date.UTC(2026, 9, 14)), '-');
});

test('换下一个的确认框:次数用完时多一句警告', () => {
	assert.doesNotMatch(advanceConfirmText('99', 2), /已达上限/);
	assert.match(advanceConfirmText('99', 0), /已达上限/);
	assert.match(advanceConfirmText('99', null), /GC id: 99/);
});
