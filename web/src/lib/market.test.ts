/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	clampMarketConcurrency, formatCentsIn, itemKey, itemLabel, itemSubText, lockedOut, perAccountMax, placeConfirmText, placeSummary,
	quantityText, selectAllSameCurrency, selectedCurrency, suggestedPrice, syncSummaryText
} from './market.ts';
import type {BuyOrder, MarketAccount, MarketItem} from './market.ts';

const account = (name: string, fields: Partial<MarketAccount> = {}): MarketAccount => ({
	account: name, attemptId: 'a-' + name, country: 'US', hasWallet: true, currency: 1, currencyISO: 'USD', balance: 10, ...fields
});

const item = (fields: Partial<MarketItem> = {}): MarketItem => ({appid: 730, marketHashName: 'Kilowatt Case', zh: '千瓦武器箱', ...fields});

test('搜商品:选项 key、显示名、名字后面的小字', () => {
	assert.equal(itemKey(item()), '730|Kilowatt Case');
	assert.equal(itemLabel(item()), '千瓦武器箱');
	assert.equal(itemSubText(item()), 'Kilowatt Case');
	assert.equal(itemLabel(item({marketHashName: 'Gallery Case', zh: null})), 'Gallery Case');
	assert.match(itemSubText(item({marketHashName: 'Gallery Case', zh: null})), /词库里没有,按英文名使用/);
	assert.equal(itemSubText(item({appid: 570, marketHashName: 'Inscribed Pauldron', zh: null})), '其它游戏(appid 570)');
});

test('币种:同币种才行;混了标出来;选了一种后别的币种锁住', () => {
	assert.deepEqual(selectedCurrency([]), {currency: null, currencyISO: '', mixed: false});
	assert.deepEqual(selectedCurrency([account('a'), account('b')]), {currency: 1, currencyISO: 'USD', mixed: false});
	assert.equal(selectedCurrency([account('a'), account('e', {currency: 3, currencyISO: 'EUR'})]).mixed, true);
	const usd = selectedCurrency([account('a')]);
	assert.equal(lockedOut(account('e', {currency: 3}), usd, false), true);
	assert.equal(lockedOut(account('e', {currency: 3}), usd, true), false);
	assert.equal(lockedOut(account('b'), usd, false), false);
	assert.equal(lockedOut(account('e', {currency: 3}), selectedCurrency([]), false), false);
});

test('全选:选满当前币种,还没选就按第一个账号的', () => {
	const list = [account('e', {currency: 3}), account('a'), account('b'), account('f', {currency: 3})];
	assert.deepEqual(selectAllSameCurrency(list, selectedCurrency([])), ['e', 'f']);
	assert.deepEqual(selectAllSameCurrency(list, selectedCurrency([account('a')])), ['a', 'b']);
	assert.deepEqual(selectAllSameCurrency([], selectedCurrency([])), []);
});

test('按余额挂满:每个账号 floor(余额 ÷ 单价),余额未知按 0 件', () => {
	const result = perAccountMax([account('a', {balance: 10}), account('b', {balance: 4.49}), account('c', {hasWallet: false})], 1.5);
	assert.deepEqual(result, {
		ok: true,
		total: 8,
		unknown: true,
		items: [
			{account: 'a', balance: 10, qty: 6, known: true},
			{account: 'b', balance: 4.49, qty: 2, known: true},
			{account: 'c', balance: null, qty: 0, known: false}
		]
	});
	// 浮点:0.3 元单价、0.9 元余额正好 3 件
	assert.equal(perAccountMax([account('a', {balance: 0.9})], 0.3).total, 3);
	assert.equal(perAccountMax([account('a')], 0).ok, false);
	assert.equal(perAccountMax([account('a'), account('e', {currency: 3})], 1).ok, false);
	assert.equal(perAccountMax([], 1).ok, false);
});

test('金额、建议价、数量、线程数', () => {
	assert.equal(formatCentsIn(120, 1), '$1.20');
	assert.equal(formatCentsIn(120, 999, 'XYZ'), 'XYZ1.20');
	assert.equal(formatCentsIn(null, 1), '—');
	assert.equal(suggestedPrice(120), 1.21);
	assert.equal(suggestedPrice(null), null);
	const order: BuyOrder = {id: '1', createdAt: '', account: 'a', marketHashName: 'x', itemName: 'x', currency: 1, currencyISO: 'USD', pricePerItemCents: 150, quantity: 5, status: 'active'};
	assert.equal(quantityText(order), '5');
	assert.equal(quantityText({...order, quantityRemaining: 5}), '5');
	assert.equal(quantityText({...order, quantityRemaining: 2}), '2/5');
	assert.equal(clampMarketConcurrency(''), 2);
	assert.equal(clampMarketConcurrency(20), 8);
	assert.equal(clampMarketConcurrency(3), 3);
});

test('挂单结果与对账提示', () => {
	assert.deepEqual(placeSummary(2, [{account: 'a', ok: true}, {account: 'b', ok: true}]).message, '已挂 2 张求购单');
	const partial = placeSummary(1, [{account: 'a', ok: true}, {account: 'b', ok: false, error: '余额不足'}]);
	assert.deepEqual([partial.level, partial.message, partial.failed.length], ['warning', '成功 1 张,失败 1 张', 1]);
	assert.deepEqual(placeSummary(0, [{account: 'b', ok: false, error: '余额不足'}]).message, '挂单失败:余额不足');
	assert.equal(syncSummaryText({removed: 1, updated: 2}), '已刷新:移除 1,更新 2');
	assert.equal(syncSummaryText({}), '已是最新');
});

test('确认框文字:固定数量 / 按余额挂满(超过 8 个账号只列前 8 个)', () => {
	assert.equal(placeConfirmText({accounts: 2, itemName: '红线', concurrency: 2, prefix: '$', pricePerItem: 1.5, quantity: 3, max: null}),
		'将用 2 个账号挂求购单(并发 2 线程):红线。\n每件 $1.50 × 3 件 = 单账号总出价 $4.50。\n求购单只在卖家成交时才从钱包扣款。确认挂单?');
	const accounts = Array.from({length: 9}, (_, index) => account('acc' + index));
	const text = placeConfirmText({accounts: 9, itemName: '', concurrency: 2, prefix: '$', pricePerItem: 5, quantity: 0, max: perAccountMax(accounts, 5)});
	assert.match(text, /合计约 18 件/);
	assert.match(text, /· acc7:2 件\n· …等 9 个账号/);
	assert.doesNotMatch(text, /acc8/);
});
