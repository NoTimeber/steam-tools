/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {categoryCounts, formatInventorySource, formatTradableAt, inventoryCategoryOf, itemSubtitle} from './inventory.ts';
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
