/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {HistoryKind, HistoryRow} from '../api/types.ts';
import {countKinds, csvFileName, filterHistory, historyCsv, inDateRange, kindLabel, spendingRows} from './history.ts';

const money = (amount: number, currency = 'CNY') => ({text: String(amount), amount, currency});

function row(kind: HistoryKind, fields: Partial<HistoryRow> = {}): HistoryRow {
	return {
		date: '2026-10-01', dateText: '2026 年 10 月 1 日', items: ['Game'], typeText: '购买', kind, marketCount: 0, payment: [], refunded: false,
		total: null, walletChange: null, walletBalance: null, transid: '', ...fields
	};
}

test('按类型计数:按类型顺序、只列有记录的', () => {
	const rows = [row('market_sell', {marketCount: 3}), row('purchase'), row('market_sell'), row('ingame'), row('purchase'), row('other')];
	assert.deepEqual(countKinds(rows), [
		{kind: 'purchase', label: '商店购买', count: 2},
		{kind: 'ingame', label: '游戏内购买', count: 1},
		{kind: 'market_sell', label: '市场卖出', count: 2},
		{kind: 'other', label: '其它', count: 1}
	]);
	assert.deepEqual(countKinds([]), []);
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

test('显示:类型名', () => {
	assert.equal(kindLabel('market_buy'), '市场买入');
});

test('按日期范围:含两端,起止颠倒也行;设了范围时没日期的排除', () => {
	const rows = [row('purchase', {date: '2026-10-01'}), row('gift', {date: '2026-09-15'}), row('other', {date: ''}), row('wallet', {date: '2026-08-31'})];
	assert.equal(inDateRange(rows, null).length, 4);
	assert.deepEqual(inDateRange(rows, ['2026-09-01', '2026-10-01']).map(r => r.kind), ['purchase', 'gift']);
	assert.deepEqual(inDateRange(rows, ['2026-09-30', '2026-08-31']).map(r => r.kind), ['gift', 'wallet']);
	assert.deepEqual(inDateRange(rows, ['2026-10-02', '2026-12-31']), []);
});

test('花钱的记录:商店、礼物、游戏内购买、市场买入', () => {
	const kinds = ['purchase', 'gift', 'ingame', 'market_buy', 'market_sell', 'wallet', 'refund', 'conversion', 'other'] as const;
	assert.deepEqual(spendingRows(kinds.map(kind => row(kind))).map(r => r.kind), ['purchase', 'gift', 'ingame', 'market_buy']);
});

test('导出 CSV:只导花钱的,日期、商品、金额 + 合计;BOM,文字带逗号引号的加引号,公式开头的加单引号', () => {
	const csv = historyCsv([
		row('market_sell', {date: '2026-10-14', items: ['Counter-Strike 2', 'Steam 社区市场'], marketCount: 3, total: money(1.26)}),
		row('purchase', {date: '2026-10-11', items: ['Half-Life: Alyx, "Deluxe"', '=HYPERLINK("x")'], total: money(4.99), walletChange: money(-1)}),
		row('ingame', {date: '2026-10-08', items: ['Counter-Strike 2', '武器箱钥匙'], walletChange: money(-2.49)}),
		row('wallet', {total: money(10)}),
		row('refund', {total: money(4.99)}),
		row('market_buy', {date: '', dateText: '昨天', items: ['Steam 社区市场'], total: {text: '待定', amount: null, currency: ''}})
	]);
	assert.equal(csv.charCodeAt(0), 0xfeff, 'Excel 认 UTF-8 要 BOM');
	assert.deepEqual(csv.slice(1).split('\r\n'), [
		'日期,商品,金额(CNY)',
		'2026-10-11,"Half-Life: Alyx, ""Deluxe"" / =HYPERLINK(""x"")",4.99',
		'2026-10-08,Counter-Strike 2 / 武器箱钥匙,2.49',
		'昨天,Steam 社区市场,待定',
		'合计,,7.48',
		''
	]);
	assert.equal(historyCsv([row('purchase', {items: ['=1+1'], total: money(1)})]).split('\r\n')[1], "2026-10-01,'=1+1,1.00");
	assert.equal(historyCsv([row('wallet', {total: money(10)})]).slice(1), '日期,商品,金额\r\n合计,,0.00\r\n');
});

test('导出 CSV:混了几种币种时加币种列,合计按币种各一行', () => {
	const csv = historyCsv([
		row('purchase', {items: ['A'], total: money(68)}),
		row('purchase', {items: ['B'], total: money(4.99, 'USD')}),
		row('gift', {items: ['C'], total: money(100)})
	]);
	assert.deepEqual(csv.slice(1).split('\r\n'), [
		'日期,商品,金额,币种',
		'2026-10-01,A,68.00,CNY',
		'2026-10-01,B,4.99,USD',
		'2026-10-01,C,100.00,CNY',
		'合计,,168.00,CNY',
		'合计,,4.99,USD',
		''
	]);
});

test('导出文件名:账号 + 起止日期,不限时间写「全部」,文件名里不能有的字符换掉', () => {
	assert.equal(csvFileName('alpha', null), 'alpha-消费记录-全部.csv');
	assert.equal(csvFileName('alpha', ['2026-01-01', '2026-10-15']), 'alpha-消费记录-2026-01-01至2026-10-15.csv');
	assert.equal(csvFileName('a/b:c', ['2026-10-15', '2026-01-01']), 'a_b_c-消费记录-2026-01-01至2026-10-15.csv');
});
