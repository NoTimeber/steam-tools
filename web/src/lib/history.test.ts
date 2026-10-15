/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {HistoryKind, HistoryRow} from '../api/types.ts';
import {filterHistory, formatAmount, kindLabel, summarizeHistory} from './history.ts';

const money = (amount: number, currency = 'CNY') => ({text: String(amount), amount, currency});

function row(kind: HistoryKind, fields: Partial<HistoryRow> = {}): HistoryRow {
	return {
		date: '2026-10-01', dateText: '2026 年 10 月 1 日', items: ['Game'], typeText: '购买', kind, marketCount: 0, payment: [], refunded: false,
		total: null, walletChange: null, walletBalance: null, transid: '', ...fields
	};
}

test('汇总:按类型顺序、只列有记录的;市场交易按合并的笔数;金额按币种分开取绝对值', () => {
	const rows = [
		row('market_sell', {marketCount: 3, total: money(12.5), walletChange: money(12.5)}),
		row('purchase', {total: money(68)}),
		row('market_sell', {marketCount: 1, total: money(0.11)}),
		row('purchase', {total: money(4.99, 'USD')}),
		row('ingame', {walletChange: money(-17)}),
		row('purchase', {total: money(100)}),
		row('other')
	];
	assert.deepEqual(summarizeHistory(rows), [
		{kind: 'purchase', label: '商店购买', count: 3, trades: 3, totals: [{currency: 'CNY', amount: 168}, {currency: 'USD', amount: 4.99}]},
		{kind: 'ingame', label: '游戏内购买', count: 1, trades: 1, totals: [{currency: 'CNY', amount: 17}]},
		{kind: 'market_sell', label: '市场卖出', count: 2, trades: 4, totals: [{currency: 'CNY', amount: 12.61}]},
		{kind: 'other', label: '其它', count: 1, trades: 1, totals: []}
	]);
	assert.deepEqual(summarizeHistory([]), []);
});

test('筛选:按类型,再按关键字(商品、类型、付款方式、日期,不分大小写)', () => {
	const rows = [
		row('purchase', {items: ['Half-Life: Alyx'], payment: ['支付宝']}),
		row('gift', {items: ['Stardew Valley'], date: '2025-12-24'}),
		row('purchase', {items: ['Portal 2']})
	];
	assert.equal(filterHistory(rows, '', '').length, 3);
	assert.deepEqual(filterHistory(rows, 'purchase', '').map(r => r.items[0]), ['Half-Life: Alyx', 'Portal 2']);
	assert.deepEqual(filterHistory(rows, '', 'alyx').map(r => r.items[0]), ['Half-Life: Alyx']);
	assert.deepEqual(filterHistory(rows, '', '支付宝').map(r => r.items[0]), ['Half-Life: Alyx']);
	assert.deepEqual(filterHistory(rows, '', '2025-12').map(r => r.items[0]), ['Stardew Valley']);
	assert.deepEqual(filterHistory(rows, 'gift', 'portal'), []);
});

test('显示:类型名、金额', () => {
	assert.equal(kindLabel('market_buy'), '市场买入');
	assert.equal(formatAmount(168, 'CNY'), '¥168.00');
	assert.equal(formatAmount(-0.03, 'USD'), '-$0.03');
	assert.equal(formatAmount(12, 'BRL'), 'BRL 12.00');
	assert.equal(formatAmount(5, ''), '5.00');
});
