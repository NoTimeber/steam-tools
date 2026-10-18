/// <reference types="node" />
// 解锁时间的短写法按本地时间显示,测试固定成北京时间
process.env.TZ = 'Asia/Shanghai';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	categoryCounts, filterItems, formatInventorySource, formatTradableAt, formatUnlockShort, formatWait, formatWear, inventoryCategoryOf, inventoryStats, inventoryUrlOf,
	itemSubtitle, marketUrlOf, pageOf, rarityColorOf, rarityCounts, sortItems, stackItems, tradeBadge, tradeStateOf, wearNameOf
} from './inventory.ts';
import type {InventoryItem} from './inventory.ts';

function item(fields: Partial<InventoryItem>): InventoryItem {
	return {
		assetid: '1', name: '', marketHashName: '', type: '', category: '', rarity: '', exterior: '', iconUrl: '',
		tradable: true, tradableAfter: '', source: 'community', ...fields
	};
}

const community = (internal: string, name = '') => item({name, raw: {description: {tags: [{category: 'Rarity', internal_name: 'Rarity_Rare'}, {category: 'Type', internal_name: internal}]}}});

test('分类:GC 来源看 kind', () => {
	assert.equal(inventoryCategoryOf(item({source: 'gc', kind: 'weapon_case', type: '普通级 武器箱'})), '武器箱');
	assert.equal(inventoryCategoryOf(item({source: 'gc', kind: 'sticker'})), '印花');
	assert.equal(inventoryCategoryOf(item({source: 'gc', kind: 'base_weapon', type: '步枪'})), '');
});

test('分类:社区来源看 Type 标签的 internal_name;武器有涂装才算武器皮肤', () => {
	assert.equal(inventoryCategoryOf(community('CSGO_Type_WeaponCase', '命悬一线武器箱')), '武器箱');
	assert.equal(inventoryCategoryOf(community('CSGO_Type_Rifle', 'AK-47 | 红线 (久经沙场)')), '武器皮肤');
	assert.equal(inventoryCategoryOf(community('CSGO_Type_Rifle', 'AK-47')), '');
	assert.equal(inventoryCategoryOf(community('Type_CustomPlayer', '探员')), '');
	// 旧接口的 category_name 写法也认
	assert.equal(inventoryCategoryOf(item({raw: {description: {tags: [{category_name: 'Type', internal_name: 'CSGO_Type_Spray'}]}}})), '涂鸦');
});

test('分类:没有 kind 和标签时,type 正好是分类名才算', () => {
	assert.equal(inventoryCategoryOf(item({type: '印花胶囊'})), '印花胶囊');
	assert.equal(inventoryCategoryOf(item({type: '普通级 武器箱'})), '');
});

test('分类计数:只列有的,按固定顺序', () => {
	const items = [community('CSGO_Type_Sticker'), community('CSGO_Type_WeaponCase'), community('CSGO_Type_Sticker'), community('CSGO_Type_Rifle', 'AK-47')];
	assert.deepEqual(categoryCounts(items), [{category: '武器箱', count: 1}, {category: '印花', count: 2}]);
});

test('副标题:跳过和名称/类型重复的、「系列 N」;社区来源不用英文市场名', () => {
	assert.equal(itemSubtitle(item({source: 'gc', name: 'AK-47 | 红线', marketHashName: 'AK-47 | Redline (Field-Tested)', category: '武器'})), 'AK-47 | Redline (Field-Tested)');
	assert.equal(itemSubtitle(item({source: 'gc', name: 'X', marketHashName: 'X', category: '系列 3'})), '');
	assert.equal(itemSubtitle(item({source: 'gc', name: 'X', marketHashName: '', type: '印花', category: '印花'})), '');
	assert.equal(itemSubtitle(item({source: 'community', name: 'X', marketHashName: 'Y', category: '裂网大行动收藏品'})), '裂网大行动收藏品');
	assert.equal(itemSubtitle(item({source: 'community', name: 'X', marketHashName: 'Y', category: ''})), '');
});

test('来源和可交易时间的显示', () => {
	assert.equal(formatInventorySource('community'), '社区库存');
	assert.equal(formatInventorySource('gc'), 'GC缓存');
	assert.equal(formatInventorySource(''), '-');
	assert.equal(formatTradableAt('2099-02-03T07:00:00.000Z'), '2099-02-03 07:00:00 GMT');
	assert.equal(formatTradableAt(''), '-');
	assert.equal(formatTradableAt('not a date'), '-');
});

// ===== 分块库存页 =====

const NOW = Date.parse('2026-10-18T04:00:00Z');   // 北京时间 10-18 12:00

test('稀有度颜色:标签带的优先,没有按名字补', () => {
	assert.equal(rarityColorOf({rarity: '保密', rarityColor: '#123456'}), '#123456');
	assert.equal(rarityColorOf({rarity: '保密'}), '#d32ce6');
	assert.equal(rarityColorOf({rarity: '高级'}), '#4b69ff');
	assert.equal(rarityColorOf({rarity: '奇怪的'}), '');
});

test('交易状态按现在的时间算:冷却过了就可交易;没时间看 Steam 标记', () => {
	assert.equal(tradeStateOf({tradable: false, tradableAfter: '2026-10-25T07:00:00Z'}, NOW), 'cooling');
	assert.equal(tradeStateOf({tradable: false, tradableAfter: '2026-10-18T03:59:00Z'}, NOW), 'tradable', '拉库存后冷却到期了');
	assert.equal(tradeStateOf({tradable: false, tradableAfter: ''}, NOW), 'locked');
	assert.equal(tradeStateOf({tradable: true, tradableAfter: ''}, NOW), 'tradable');

	assert.deepEqual(tradeBadge({tradable: false, tradableAfter: '2026-10-25T07:00:00Z'}, NOW), {
		state: 'cooling', label: '10-25 15:00 可交易', tip: '交易冷却到 2026-10-25 07:00:00 GMT,还有 7 天 3 小时'
	});
	assert.equal(tradeBadge({tradable: false, tradableAfter: ''}, NOW).label, '已锁定');
	assert.equal(tradeBadge({tradable: true, tradableAfter: ''}, NOW).label, '可交易');
	assert.equal(formatUnlockShort('2027-01-02T00:00:00Z', NOW), '2027-01-02 08:00', '跨年带年份');
	assert.deepEqual([formatWait(3 * 3600e3 + 20 * 60e3), formatWait(90e3), formatWait(2 * 86400e3)], ['3 小时 20 分', '2 分钟', '2 天']);
});

test('磨损:区间名、显示', () => {
	assert.deepEqual([0.01, 0.07, 0.2, 0.4472224414, 0.45, 0.99, 1].map(wearNameOf), ['崭新出厂', '略有磨损', '久经沙场', '破损不堪', '战痕累累', '战痕累累', '战痕累累']);
	assert.equal(formatWear(0.4472224414352), '0.4472224414');
	assert.equal(formatWear(0.25), '0.25');
});

const rifle = (assetid: string, fields: Partial<InventoryItem> = {}) => item({
	assetid, name: 'AK-47 | 红线 (久经沙场)', marketHashName: 'AK-47 | Redline (Field-Tested)', type: '步枪', rarity: '保密',
	raw: {description: {tags: [{category: 'Type', internal_name: 'CSGO_Type_Rifle'}]}}, ...fields
});
const kase = (assetid: string, fields: Partial<InventoryItem> = {}) => item({
	assetid, name: '梦魇武器箱', marketHashName: 'Dreams & Nightmares Case', type: '武器箱', rarity: '普通级',
	raw: {description: {tags: [{category: 'Type', internal_name: 'CSGO_Type_WeaponCase'}]}}, ...fields
});
const list = [
	kase('1'),
	rifle('2', {tradable: false, tradableAfter: '2026-10-25T07:00:00Z', paintWear: 0.3}),
	kase('3', {tradable: false, tradableAfter: '2026-10-20T07:00:00Z'}),
	rifle('4', {paintWear: 0.16}),
	item({assetid: '5', name: '纪念品', rarity: '', tradable: false})
];

test('筛选:搜索多个词都要命中(中英文名、类型、Asset ID),分类、交易状态、稀有度', () => {
	const pick = (filters: Partial<Parameters<typeof filterItems>[1]>) => filterItems(list, {search: '', category: 'all', trade: 'all', rarity: '', ...filters}, NOW).map(entry => entry.assetid);
	assert.deepEqual(pick({search: 'redline'}), ['2', '4']);
	assert.deepEqual(pick({search: '武器箱 梦魇'}), ['1', '3']);
	assert.deepEqual(pick({search: '3'}), ['3']);
	assert.deepEqual(pick({category: '武器箱'}), ['1', '3']);
	assert.deepEqual(pick({trade: 'cooling'}), ['2', '3']);
	assert.deepEqual(pick({trade: 'locked'}), ['5']);
	assert.deepEqual(pick({rarity: '保密', trade: 'tradable'}), ['4']);
});

test('排序:默认不动;稀有度从高到低;可交易时间可交易的在前、冷却按早晚、锁定最后;磨损从低到高、没有的最后', () => {
	const ids = (sort: Parameters<typeof sortItems>[1]) => sortItems(list, sort, NOW).map(entry => entry.assetid);
	assert.deepEqual(ids('default'), ['1', '2', '3', '4', '5']);
	assert.deepEqual(ids('rarity'), ['2', '4', '1', '3', '5']);
	assert.deepEqual(ids('unlock'), ['1', '4', '3', '2', '5']);
	assert.deepEqual(ids('wear'), ['4', '2', '5', '1', '3']);
	assert.deepEqual(ids('name'), ['5', '1', '3', '2', '4'], '按中文排序规则,汉字在英文前');
});

test('堆叠:按英文市场名分组,保持顺序,数可交易的;统计', () => {
	const stacks = stackItems(list, NOW);
	assert.deepEqual(stacks.map(stack => [stack.key, stack.item.assetid, stack.items.length, stack.tradableCount]), [
		['Dreams & Nightmares Case', '1', 2, 1],
		['AK-47 | Redline (Field-Tested)', '2', 2, 1],
		['纪念品', '5', 1, 0]
	]);
	assert.deepEqual(inventoryStats(list, NOW), {total: 5, distinct: 3, tradable: 2, cooling: 2, locked: 1, nextUnlock: '2026-10-20T07:00:00Z'});
	assert.deepEqual(rarityCounts(list), [{rarity: '保密', color: '#d32ce6', count: 2}, {rarity: '普通级', color: '#b0c3d9', count: 2}]);
});

test('翻页、市场和库存地址', () => {
	const numbers = Array.from({length: 7}, (_, index) => index + 1);
	assert.deepEqual(pageOf(numbers, 2, 3), {rows: [4, 5, 6], page: 2, pageCount: 3});
	assert.deepEqual(pageOf(numbers, 9, 3), {rows: [7], page: 3, pageCount: 3}, '超出范围拉回最后一页');
	assert.deepEqual(pageOf([], 1, 3), {rows: [], page: 1, pageCount: 1});
	assert.equal(marketUrlOf({marketHashName: 'AK-47 | Redline (Field-Tested)', marketable: true}), 'https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20(Field-Tested)');
	assert.equal(marketUrlOf({marketHashName: 'X', marketable: false}), '');
	assert.equal(inventoryUrlOf('7656', '42'), 'https://steamcommunity.com/profiles/7656/inventory/#730_2_42');
});
