/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_FEES} from './market-fees.ts';
import {
	actualBuyer, batchItems, centsOf, cooldownText, expandPending, fillFromLowest, filterGroups, filterHistory, filterListings, flattenListings,
	groupInventory, groupResults, groupResultText, historyPrice, listingCounts, listingTotals, matchOutcomes, money, newPendingRow, pageInfo,
	pendingError, pendingTotals, rebindPending, remainingAfterSell, sellConfirmText, sellPayload, sellSummary, sentTotals, withBuyer, withQuantity,
	withReceive
} from './market-sell.ts';
import type {HistoryEvent, ListingsAccount, MyListing, SellableItem, SellItemOutcome, SellRequestItem} from './market-sell.ts';

const USD = {id: 1, iso: 'USD'};

function item(assetid: string, fields: Partial<SellableItem> = {}): SellableItem {
	return {
		appid: 730, contextid: '2', assetid, amount: 1, marketHashName: 'Kilowatt Case', name: 'Kilowatt Case', zh: '千瓦武器箱', icon: '',
		type: '', rarity: '', rarityColor: '', exterior: '', marketable: true, tradable: true, cooldownUntil: null, ...fields
	};
}

const KILOWATT = [
	item('30'),
	item('4', {marketable: false, cooldownUntil: '2026-10-22T08:00:00Z'}),
	item('12'),
	item('5', {marketable: false, cooldownUntil: '2026-10-20T08:00:00Z'}),
	item('100')
];

function outcome(assetid: string, status: SellItemOutcome['status']): SellItemOutcome {
	return {assetid, marketHashName: '', name: '', status, buyerPriceCents: 1, receivePriceCents: 1, message: status};
}

test('金额:分 ↔ 主单位,按账号币种显示', () => {
	assert.equal(centsOf(1.15), 115);
	assert.equal(centsOf(0.1 + 0.2), 30);
	assert.equal(centsOf(0), null);
	assert.equal(centsOf(null), null);
	assert.equal(money(115, USD), '$1.15');
	assert.equal(money(null, USD), '—');
});

test('库存叠组:同游戏同英文名一组,总数 / 可出售 / 冷却件数和最早解除;资产按 assetid 排', () => {
	const groups = groupInventory([
		...KILOWATT,
		item('7', {zh: null, name: 'Recoil Case', marketHashName: 'Recoil Case', marketable: false}),
		item('8', {appid: 440, marketHashName: 'Mann Co. Supply Crate Key', name: 'Mann Co. Supply Crate Key', zh: null, amount: 3}),
		item('9', {appid: 440, marketHashName: 'Mann Co. Supply Crate Key', name: 'Mann Co. Supply Crate Key', zh: null, amount: 2})
	]);
	assert.deepEqual(groups.map(group => [group.key, group.total, group.sellable, group.cooldown]), [
		['730|Kilowatt Case', 5, 3, 2], ['730|Recoil Case', 1, 0, 0], ['440|Mann Co. Supply Crate Key', 5, 5, 0]
	]);
	const kilowatt = groups[0]!;
	assert.deepEqual(kilowatt.items.map(entry => entry.assetid), ['4', '5', '12', '30', '100']);
	assert.equal(kilowatt.cooldownEarliest, '2026-10-20T08:00:00Z');
	assert.match(cooldownText(kilowatt), /^冷却 2 件,最早 2026-10-2\d \d\d:00 解除$/);
	assert.equal(cooldownText(groups[1]!), '');

	assert.deepEqual(filterGroups(groups, {text: '', onlyMarketable: true}).map(group => group.marketHashName), ['Kilowatt Case', 'Mann Co. Supply Crate Key']);
	assert.deepEqual(filterGroups(groups, {text: 'recoil', onlyMarketable: false}).map(group => group.marketHashName), ['Recoil Case']);
	assert.deepEqual(filterGroups(groups, {text: '千瓦', onlyMarketable: false}).length, 1);
});

test('待上架定价(单件):买家付和到手互相换算,和后端手续费一样;数量收在 1..可出售', () => {
	const group = groupInventory(KILOWATT)[0]!;
	const row = newPendingRow(group, DEFAULT_FEES);
	assert.equal(row.quantity, 1);
	assert.equal(withQuantity(row, 10).quantity, 3);
	assert.equal(withQuantity(row, 0).quantity, 1);
	assert.equal(withQuantity(row, null).quantity, 1);
	assert.deepEqual([withReceive(row, 100).buyerCents, withReceive(row, 100).receiveCents], [115, 100]);
	assert.deepEqual([withBuyer(row, 100).buyerCents, withBuyer(row, 100).receiveCents], [100, 88]);
	assert.equal(withBuyer(row, 2).receiveCents, null, '买家付低于 0.03 没有到手价');
	const odd = withBuyer(row, 22);
	assert.equal(odd.receiveCents, 19);
	assert.equal(actualBuyer(odd), 21, '凑不上的 0.22 实际买家付 0.21');
	assert.deepEqual([fillFromLowest(row, 115, true).buyerCents, fillFromLowest(row, 115, true).receiveCents], [114, 99]);
	assert.equal(fillFromLowest(row, 3, true), row, '减一分后低于 0.03 不填');
});

test('合计按单价 × 数量;提交前检查;库存刷新后重新绑定组', () => {
	const groups = groupInventory(KILOWATT);
	const priced = withQuantity(withReceive(newPendingRow(groups[0]!, DEFAULT_FEES), 100), 3);
	assert.deepEqual(pendingTotals([priced]), {buyer: 345, receive: 300, pieces: 3, priced: 1});
	assert.equal(pendingError([]), '先在库存里勾选要上架的物品');
	assert.equal(pendingError([newPendingRow(groups[0]!, DEFAULT_FEES)]), '千瓦武器箱 还没定价(买家付至少 0.03)');
	assert.equal(pendingError([priced]), '');
	assert.equal(pendingError([{...priced, quantity: 4}]), '千瓦武器箱 的数量要在 1 到 3 之间');

	// 刷新后只剩 1 件可出售:数量收紧;组没了就拿掉
	const fresh = groupInventory([item('100'), item('4', {marketable: false, cooldownUntil: '2026-10-22T08:00:00Z'})]);
	const rebound = rebindPending([priced], fresh);
	assert.equal(rebound[0]!.quantity, 1);
	assert.equal(rebound[0]!.group, fresh[0]);
	assert.equal(rebound[0]!.receiveCents, 100, '价格留着');
	assert.deepEqual(rebindPending([priced], []), []);
});

test('展开:只挑能上架的资产、assetid 小的先、件数对;堆叠资产按需要的数量卖;拆成每批 ≤ 50', () => {
	const groups = groupInventory([...KILOWATT, item('8', {appid: 440, marketHashName: 'Key', amount: 3}), item('9', {appid: 440, marketHashName: 'Key', amount: 2})]);
	const rows = [
		withQuantity(withReceive(newPendingRow(groups[0]!, DEFAULT_FEES), 100), 2),
		withQuantity(withReceive(newPendingRow(groups[1]!, DEFAULT_FEES), 200), 4)
	];
	const expanded = expandPending(rows);
	assert.deepEqual(expanded.map(entry => [entry.assetid, entry.amount, entry.receivePriceCents]), [['12', 1, 100], ['30', 1, 100], ['8', 3, 200], ['9', 1, 200]]);
	assert.deepEqual(sellPayload(expanded.slice(0, 1)), [{appid: 730, contextid: '2', assetid: '12', amount: 1, receivePriceCents: 100}]);

	const many = groupInventory(Array.from({length: 120}, (_, i) => item(String(1000 + i))));
	const all = expandPending([withQuantity(withReceive(newPendingRow(many[0]!, DEFAULT_FEES), 5), 120)]);
	assert.equal(all.length, 120);
	assert.deepEqual(batchItems(all).map(batch => batch.length), [50, 50, 20]);
	assert.deepEqual(batchItems([]), []);

	const text = sellConfirmText('alpha', [withQuantity(withReceive(newPendingRow(many[0]!, DEFAULT_FEES), 100), 120)], USD);
	assert.ok(text.includes('将用 alpha 上架 1 种物品,共 120 件:买家共付 $138.00,扣手续费后到手共 $120.00。'), text);
	assert.match(text, /分 3 批/);
});

test('结果:按 assetid 对上、一批出错整批记失败;按组汇总;失败的件数留在待上架里重试', () => {
	const groups = groupInventory([...KILOWATT, item('7', {marketHashName: 'Recoil Case', zh: '反冲武器箱'})]);
	const rows = [
		withQuantity(withReceive(newPendingRow(groups[0]!, DEFAULT_FEES), 100), 3),
		withReceive(newPendingRow(groups[1]!, DEFAULT_FEES), 50)
	];
	const expanded: SellRequestItem[] = expandPending(rows);
	const [first, second] = batchItems(expanded, 2) as [SellRequestItem[], SellRequestItem[]];
	const sent = [
		...matchOutcomes(first, {results: [outcome('12', 'listed'), outcome('30', 'failed')]}),
		...matchOutcomes(second, null, '网络错误')
	];
	assert.deepEqual(sent.map(entry => [entry.request.assetid, entry.outcome?.status ?? null, entry.error]), [
		['12', 'listed', ''], ['30', 'failed', ''], ['100', null, '网络错误'], ['7', null, '网络错误']
	]);
	assert.deepEqual(sentTotals(sent), {listed: 1, pendingConfirmation: 0, failed: 3});
	const results = groupResults(rows, sent);
	assert.deepEqual(results.map(groupResultText), ['千瓦武器箱 ×3:已上架 1,待确认 0,失败 2', '反冲武器箱 ×1:已上架 0,待确认 0,失败 1']);
	assert.equal(results[0]!.details.length, 3);

	const left = remainingAfterSell(rows, sent);
	assert.deepEqual(left.map(row => [row.key, row.quantity, row.receiveCents]), [['730|Kilowatt Case', 2, 100], ['730|Recoil Case', 1, 50]]);
	const allOk = matchOutcomes(expanded.slice(0, 3), {results: [outcome('12', 'listed'), outcome('30', 'pending_confirmation'), outcome('100', 'listed')]});
	assert.deepEqual(remainingAfterSell(rows, allOk).map(row => row.key), ['730|Recoil Case'], '全部上架 / 待确认的组拿掉,没提交的组留着');

	assert.deepEqual(sellSummary({listed: 2, pendingConfirmation: 0, failed: 0, confirmed: 1}), {text: '已上架 2 件(自动确认 1 件)', level: 'success'});
	assert.deepEqual(sellSummary({listed: 1, pendingConfirmation: 1, failed: 1}), {text: '已上架 1 件,待手机确认 1 件,失败 1 件', level: 'warning'});
	assert.equal(sellSummary({listed: 0, pendingConfirmation: 0, failed: 2}).level, 'error');
});

test('我的在售:展开多账号、按账号和状态筛、计数、按币种合计', () => {
	const listing = (listingId: string, status: MyListing['status'], buyer: number): MyListing => ({
		listingId, status, appid: 730, assetid: listingId, amount: 1, marketHashName: 'Kilowatt Case', name: 'Kilowatt Case', icon: '',
		buyerPriceCents: buyer, receiveCents: buyer - 15, feeCents: 15, timeCreated: 0, createdAt: ''
	});
	const accounts: ListingsAccount[] = [
		{account: 'alpha', ok: true, currency: USD, listings: [listing('1', 'active', 115), listing('2', 'to_confirm', 115)]},
		{account: 'bravo', ok: true, currency: {id: 23, iso: 'CNY'}, listings: [listing('3', 'active', 1000)]},
		{account: 'ghost', ok: false, error: '账号不存在或未登录'}
	];
	const rows = flattenListings(accounts);
	assert.deepEqual(rows.map(row => row.rowKey), ['alpha|1', 'alpha|2', 'bravo|3']);
	assert.deepEqual(filterListings(rows, {account: 'alpha', status: null}).map(row => row.listingId), ['1', '2']);
	assert.deepEqual(filterListings(rows, {account: null, status: 'active'}).map(row => row.listingId), ['1', '3']);
	assert.deepEqual(listingCounts(rows), {active: 2, to_confirm: 1, on_hold: 0, total: 3});
	assert.deepEqual(listingTotals(rows).map(group => [group.currency?.iso, group.buyer, group.receive]), [['USD', 230, 200], ['CNY', 1000, 985]]);
});

test('成交记录:价格取哪个、按类型筛、分页', () => {
	const event = (type: HistoryEvent['type'], buyer: number | null, receive: number | null): HistoryEvent => ({
		key: type, type, time: 0, date: '', listingId: '', marketHashName: '', name: '', icon: '', buyerPriceCents: buyer, receiveCents: receive, counterpart: null
	});
	assert.equal(historyPrice(event('sold', 115, 100)), 100);
	assert.equal(historyPrice(event('bought', 115, null)), 115);
	assert.equal(historyPrice(event('listed', 115, 100)), 115);
	const events = [event('sold', 1, 1), event('bought', 1, null), event('sold', 2, 2)];
	assert.equal(filterHistory(events, 'sold').length, 2);
	assert.equal(filterHistory(events, null).length, 3);
	assert.deepEqual(pageInfo(0, 50, 120), {page: 1, pages: 3, hasPrev: false, hasNext: true});
	assert.deepEqual(pageInfo(100, 50, 120), {page: 3, pages: 3, hasPrev: true, hasNext: false});
	assert.deepEqual(pageInfo(0, 50, 0), {page: 1, pages: 1, hasPrev: false, hasNext: false});
});
