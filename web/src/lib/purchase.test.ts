/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_ITEM_QUANTITY, balanceCents, cartTotals, convertCents, dominantCurrency, filterItems, formatCents, groupItems, itemPrice,
	maxQuantityFor, normalizeCart, priceEntries, ratesSummary, setCartQuantity, taskLogLine
} from './purchase.ts';
import type {CatalogItem, PurchaseAccount, PurchaseTask} from './purchase.ts';

const account = (fields: Partial<PurchaseAccount> = {}): PurchaseAccount => ({
	account: 'alpha', attemptId: 'a1', country: 'US', hasWallet: true, currency: 1, currencyISO: 'USD', balance: 10, gcConnected: true, ...fields
});

const ITEMS: CatalogItem[] = [
	{def_index: 1, name: '钥匙', type: '钥匙', category: '钥匙', prices: {USD: 249, EUR: 230}},
	{def_index: 2, name: '通行证', type: '票券', category: '票券', prices: {USD: 1499}},
	{def_index: 3, name: '免费贴纸', type: '印花', category: '印花', prices: {USD: 0}}
];
const find = (defIndex: number) => ITEMS.find(item => item.def_index === defIndex);

test('币种:取已选账号里最多的;没选时 USD', () => {
	assert.equal(dominantCurrency([]), 'USD');
	assert.equal(dominantCurrency([account({currencyISO: 'eur'}), account({currencyISO: 'USD'}), account({currencyISO: 'EUR'})]), 'EUR');
	assert.equal(dominantCurrency([account({currencyISO: ''})]), 'USD');
});

test('单价:有账号币种用它,没有用美元价', () => {
	assert.equal(itemPrice(ITEMS[0], 'eur'), 230);
	assert.equal(itemPrice(ITEMS[0], 'JPY'), 249);
	assert.equal(itemPrice({...ITEMS[0]!, prices: {}}, 'USD'), 0);
});

test('余额:没钱包或余额未知不封顶', () => {
	assert.equal(balanceCents(account({balance: 10.005})), 1001);
	assert.equal(balanceCents(account({hasWallet: false})), null);
	assert.equal(balanceCents(account({balance: null})), null);
});

test('购物车按余额封顶:前面的先占余额,买不起的整项去掉;补名称和单价', () => {
	const entries = [
		{itemDefId: 1, name: '', quantity: 3, costInLocalCurrency: 0, currencyISO: 'USD'},
		{itemDefId: 2, name: '', quantity: 1, costInLocalCurrency: 0, currencyISO: 'USD'},
		{itemDefId: 3, name: '', quantity: 5, costInLocalCurrency: 0, currencyISO: 'USD'}
	];
	// 10.00 美元:钥匙 3 × 2.49 = 7.47,剩 2.53 买不起 14.99 的通行证;免费贴纸不受余额限制
	assert.deepEqual(normalizeCart(entries, account(), find).map(entry => [entry.itemDefId, entry.name, entry.quantity, entry.costInLocalCurrency]), [
		[1, '钥匙', 3, 249],
		[3, '免费贴纸', 5, 0]
	]);
	// 钥匙要 10 把也只能买 4 把
	assert.equal(normalizeCart([{...entries[0]!, quantity: 10}], account(), find)[0]!.quantity, 4);
	// 没有钱包信息就不封顶;数量夹到上限
	assert.equal(normalizeCart([{...entries[0]!, quantity: 123456}], account({hasWallet: false}), find)[0]!.quantity, MAX_ITEM_QUANTITY);
	// 账号不在线了:购物车清空
	assert.deepEqual(normalizeCart(entries, null, find), []);
	// 欧元账号按欧元价
	assert.equal(normalizeCart([entries[0]!], account({currencyISO: 'EUR'}), find)[0]!.costInLocalCurrency, 230);
});

test('设置数量:超出余额按能买的生效,并告诉最多能买几件;0 = 移除', () => {
	let result = setCartQuantity([], account(), 1, 1, find);
	assert.deepEqual([result.appliedQuantity, result.maxQuantity], [1, 4]);
	result = setCartQuantity(result.entries, account(), 2, 1, find);
	// 钥匙 2.49 + 通行证 14.99 > 10.00:通行证进不去
	assert.deepEqual([result.appliedQuantity, result.maxQuantity, result.entries.length], [0, 0, 1]);
	result = setCartQuantity(result.entries, account(), 1, 9, find);
	assert.deepEqual([result.appliedQuantity, result.maxQuantity], [4, 4]);
	assert.deepEqual(cartTotals(result.entries), {units: 4, costCents: 996});
	result = setCartQuantity(result.entries, account(), 1, 0, find);
	assert.deepEqual(result.entries, []);
	assert.equal(maxQuantityFor([], account(), 1), MAX_ITEM_QUANTITY);
});

test('目录搜索与分组', () => {
	assert.deepEqual(filterItems(ITEMS, ' 票券 ').map(item => item.def_index), [2]);
	assert.deepEqual(filterItems(ITEMS, '3').map(item => item.def_index), [3]);
	assert.equal(filterItems(ITEMS, '').length, 3);
	assert.deepEqual(groupItems([ITEMS[0]!, ITEMS[0]!, ITEMS[1]!, {...ITEMS[2]!, category: '', type: ''}]).map(group => [group.category, group.items.length]), [
		['钥匙', 2], ['票券', 1], ['未分类', 1]
	]);
});

test('汇率折算与金额显示', () => {
	const rates = {USD: 1, EUR: 0.9, CNY: 7.1};
	assert.equal(convertCents(900, 'EUR', 'USD', rates), 1000);
	assert.equal(convertCents(100, 'USD', 'USD', null), 100);
	assert.ok(Number.isNaN(convertCents(100, 'JPY', 'USD', rates)));
	assert.equal(formatCents(1234, 'usd'), '$12.34');
	assert.equal(formatCents(1234, 'CHF'), 'CHF 12.34');
	assert.equal(formatCents(1234, 'UYU'), 'UYU 12.34');
	assert.equal(formatCents(Number.NaN, 'USD'), '-');
	assert.deepEqual(ratesSummary({}, 'USD', ''), {text: '汇率:未提供', title: '当前响应里没有可用 rates 对象'});
	assert.equal(ratesSummary(rates, 'eur', 'open.er-api.com').text, '汇率参考:EUR= 0.9000');
	assert.equal(ratesSummary(rates, 'JPY', '').text, '汇率参考:3 个币种');
});

test('价格表:按折人民币从低到高,折不了的排最后,标出当前币种', () => {
	const item: CatalogItem = {def_index: 9, name: 'x', type: '', category: '', prices: {USD: 100, EUR: 100, JPY: 100, GBP: null as unknown as number}};
	const entries = priceEntries(item, 'eur', {USD: 1, EUR: 0.5, CNY: 7});
	assert.deepEqual(entries.map(entry => [entry.iso, entry.current, entry.usd, entry.cny]), [
		['USD', false, '$1.00', '¥7.00'],
		['EUR', true, '$2.00', '¥14.00'],
		['JPY', false, '无法折算', '无法折算']
	]);
});

test('任务日志:创建、开始执行、结束时带上失败原因;状态没变不写', () => {
	const task = (fields: Partial<PurchaseTask>): PurchaseTask => ({
		id: 't1', game: 'cs2', gameLabel: 'CS2', status: 'queued', createdAt: '', totalAccounts: 2, totalUnits: 3, successCount: 0, failCount: 0, accounts: [], ...fields
	});
	assert.deepEqual(taskLogLine(task({}), null, true), {level: 'success', message: 'CS2 内购任务已创建: 2 个账号,3 件商品'});
	assert.equal(taskLogLine(task({}), null, false), null);
	assert.equal(taskLogLine(task({status: 'running'}), task({status: 'running'}), false), null);
	assert.equal(taskLogLine(task({status: 'running'}), task({}), false)?.level, 'warn');
	const failedAccount = {account: 'bravo', status: 'failed', error: '余额不足', currencyISO: 'USD', balanceBefore: 1, balanceAfter: 1, totalCostCents: 0, totalUnits: 0, items: []};
	assert.deepEqual(taskLogLine(task({status: 'partial', successCount: 1, failCount: 1, accounts: [failedAccount]}), task({status: 'running'}), false), {
		level: 'warn', message: 'CS2 内购任务部分成功: 成功 1,失败 1 — bravo: 余额不足'
	});
});
