/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {HistoryKind, HistoryRow} from '../api/types.ts';
import {csvFileName, filterHistory, formatAmount, historyCsv, inDateRange, kindLabel, summarizeHistory} from './history.ts';

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

test('按日期范围:含两端,起止颠倒也行;设了范围时没日期的排除', () => {
	const rows = [row('purchase', {date: '2026-10-01'}), row('gift', {date: '2026-09-15'}), row('other', {date: ''}), row('wallet', {date: '2026-08-31'})];
	assert.equal(inDateRange(rows, null).length, 4);
	assert.deepEqual(inDateRange(rows, ['2026-09-01', '2026-10-01']).map(r => r.kind), ['purchase', 'gift']);
	assert.deepEqual(inDateRange(rows, ['2026-09-30', '2026-08-31']).map(r => r.kind), ['gift', 'wallet']);
	assert.deepEqual(inDateRange(rows, ['2026-10-02', '2026-12-31']), []);
});

test('导出 CSV:BOM + 表头,金额写带符号的数值,文字带逗号引号的加引号,公式开头的加单引号', () => {
	const csv = historyCsv([
		row('market_sell', {date: '2026-10-14', typeText: '3 笔市场交易', items: ['Counter-Strike 2', 'Steam 社区市场'], marketCount: 3,
			total: money(1.26, 'USD'), walletChange: money(1.26, 'USD'), walletBalance: money(20, 'USD'), transid: '700000'}),
		row('purchase', {items: ['Half-Life: Alyx, "Deluxe"', '=HYPERLINK("x")'], payment: ['$1.00 Steam 钱包', '$3.99 Visa'],
			total: money(4.99, 'USD'), walletChange: money(-1, 'USD'), refunded: true}),
		row('other', {date: '', dateText: '昨天', total: {text: '待定', amount: null, currency: ''}})
	]);
	assert.equal(csv.charCodeAt(0), 0xfeff, 'Excel 认 UTF-8 要 BOM');
	assert.deepEqual(csv.slice(1).split('\r\n'), [
		'日期,类型,Steam 类型,商品,付款方式,总额,钱包变动,钱包余额,币种,市场交易笔数,含退款,交易号',
		'2026-10-14,市场卖出,3 笔市场交易,Counter-Strike 2 / Steam 社区市场,,1.26,1.26,20,USD,3,,700000',
		'2026-10-01,商店购买,购买,"Half-Life: Alyx, ""Deluxe"" / =HYPERLINK(""x"")",$1.00 Steam 钱包 / $3.99 Visa,4.99,-1,,USD,,是,',
		'昨天,其它,购买,Game,,待定,,,,,,',
		''
	]);
	const formula = historyCsv([row('purchase', {items: ['=1+1'], payment: ['-cmd']})]).split('\r\n')[1];
	assert.equal(formula, "2026-10-01,商店购买,购买,'=1+1,'-cmd,,,,,,,");
	assert.equal(historyCsv([]).slice(1), '日期,类型,Steam 类型,商品,付款方式,总额,钱包变动,钱包余额,币种,市场交易笔数,含退款,交易号\r\n');
});

test('导出文件名:账号 + 起止日期,不限时间写「全部」,文件名里不能有的字符换掉', () => {
	assert.equal(csvFileName('alpha', null), 'alpha-消费记录-全部.csv');
	assert.equal(csvFileName('alpha', ['2026-01-01', '2026-10-15']), 'alpha-消费记录-2026-01-01至2026-10-15.csv');
	assert.equal(csvFileName('a/b:c', ['2026-10-15', '2026-01-01']), 'a_b_c-消费记录-2026-01-01至2026-10-15.csv');
});
