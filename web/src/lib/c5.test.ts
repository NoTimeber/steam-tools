/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	budgetText, dirtyFields, draftPayload, draftsDirty, formatTime, itemLabel, itemStatus, money, newDraft, purchaseStatus, removedNames, sweepBlocker,
	sweepConfirmText, toDrafts
} from './c5.ts';
import type {C5Settings, C5WatchItem} from './c5.ts';

const ITEMS: C5WatchItem[] = [
	{name: 'Kilowatt Case', maxPrice: 0.66, maxQty: 100, maxSpend: 0, appId: 730, delivery: 0, assetType: 1},
	{name: 'Recoil Case', maxPrice: 1.48, maxQty: 100, maxSpend: 60, appId: 730, delivery: 2, assetType: 1}
];

function uids() {
	let n = 0;
	return () => `u${++n}`;
}

test('草稿:从服务端列表生成,同名行沿用 uid', () => {
	const drafts = toDrafts(ITEMS, uids());
	assert.deepEqual(drafts.map(row => [row.uid, row.origName, row.maxPrice]), [['u1', 'Kilowatt Case', 0.66], ['u2', 'Recoil Case', 1.48]]);
	const again = toDrafts([ITEMS[1]!], () => 'fresh', drafts);
	assert.equal(again[0]!.uid, 'u2');
	assert.equal(draftsDirty(drafts, ITEMS), false);
});

test('草稿:改了哪些格子、删了哪些、加了新行都算有改动', () => {
	const drafts = toDrafts(ITEMS, uids());
	drafts[0]!.maxPrice = 0.7;
	assert.deepEqual([...dirtyFields(drafts[0]!, ITEMS)], ['maxPrice']);
	assert.equal(draftsDirty(drafts, ITEMS), true);
	drafts[0]!.maxPrice = 0.66;
	drafts[0]!.maxSpend = null;   // 清空花费上限 = 0,不算改动
	assert.equal(draftsDirty(drafts, ITEMS), false);

	const removed = drafts.filter(row => row.origName !== 'Recoil Case');
	assert.deepEqual(removedNames(removed, ITEMS), ['Recoil Case']);
	assert.equal(draftsDirty(removed, ITEMS), true);

	const added = [...drafts, newDraft(uids(), {name: ' Revolution Case ', maxPrice: 1.02, maxQty: 10})];
	assert.equal(added[2]!.name, 'Revolution Case');
	assert.equal(dirtyFields(added[2]!, ITEMS).size, 6);
	assert.equal(draftsDirty(added, ITEMS), true);
});

test('提交前检查:名字、目标价、数量、重复', () => {
	const drafts = toDrafts(ITEMS, uids());
	assert.deepEqual(draftPayload(drafts), {items: ITEMS, error: ''});
	const make = (patch: object) => draftPayload([{...drafts[0]!, ...patch}]).error;
	assert.match(make({name: ' '}), /第 1 行:饰品名不能为空/);
	assert.match(make({maxPrice: 0}), /目标价要大于 0/);
	assert.match(make({maxPrice: null}), /目标价要大于 0/);
	assert.match(make({maxQty: 1.5}), /数量上限至少 1/);
	assert.match(make({maxSpend: -1}), /不能是负数/);
	assert.match(draftPayload([drafts[0]!, {...drafts[1]!, name: 'Kilowatt Case'}]).error, /Kilowatt Case 重复了/);
	assert.equal(draftPayload([{...drafts[0]!, maxSpend: null}]).items[0]!.maxSpend, 0);
});

test('文案', () => {
	assert.deepEqual(itemStatus('hit'), {label: '到价', tone: 'success'});
	assert.deepEqual(itemStatus('new'), {label: '未保存', tone: 'warning'});
	assert.deepEqual(purchaseStatus('unknown'), {label: '结果未知', tone: 'warning'});
	assert.equal(money(null), '-');
	assert.equal(money(1.005), '1.00');
	assert.equal(budgetText({total: 0, spent: 1.2, qty: 2}), '1.20 / 未设');
	assert.equal(budgetText({total: 500, spent: 0, qty: 0}), '0.00 / 500.00');
	const now = new Date(2026, 9, 14, 12, 0, 0).getTime();
	assert.equal(formatTime(new Date(2026, 9, 14, 9, 5, 7).getTime(), now), '09:05:07');
	assert.equal(formatTime(new Date(2026, 9, 13, 23, 0, 0).getTime(), now), '10-13 23:00:00');
	assert.equal(formatTime(null), '-');
});

test('中文名:草稿带上中文名只用来显示,不提交、不算改动;报错用中文名', () => {
	const drafts = toDrafts(ITEMS.map((item, index) => ({...item, zh: index === 0 ? '千瓦武器箱' : null})), uids());
	assert.deepEqual(drafts.map(row => [row.name, row.zh, itemLabel(row)]), [
		['Kilowatt Case', '千瓦武器箱', '千瓦武器箱'], ['Recoil Case', null, 'Recoil Case']
	]);
	assert.equal(draftsDirty(drafts, ITEMS), false);
	assert.deepEqual(draftPayload(drafts), {items: ITEMS, error: ''});

	const added = [...drafts, newDraft(uids(), {name: 'Gallery Case', zh: '画廊武器箱', maxPrice: 0, maxQty: 1})];
	assert.equal(added[2]!.zh, '画廊武器箱');
	assert.equal(draftPayload(added).error, '画廊武器箱:目标价要大于 0');
});

test('开始自动扫货:要交易链接和总预算;确认文字写明真实下单', () => {
	const settings: C5Settings = {
		strategy: 'quick', tradeUrl: '', maxTotalSpend: 0, maxBuyPerCycle: 10, minBalanceReserve: 5, errorCooldownSec: 10, pollIntervalSec: 3, timeoutSec: 10
	};
	assert.equal(sweepBlocker(settings), '没填收货账号的交易链接');
	assert.equal(sweepBlocker({...settings, tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=a'}), '没设总预算(要大于 0)');
	assert.equal(sweepBlocker({...settings, tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=a', maxTotalSpend: 20}), null);
	const text = sweepConfirmText({...settings, maxTotalSpend: 20}, 3);
	assert.match(text, /真实下单/);
	assert.match(text, /总预算 20\.00,每轮最多 10 单,余额保留 5\.00/);
	assert.match(text, /快速购买.*监控 3 个饰品/);
});
