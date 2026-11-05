/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PendingConfirmation} from '../api/types.ts';
import {confirmationType, isSensitive, selectableIds, tradeOfferUrl, typeCounts} from './confirmations.ts';

const conf = (id: string, type: number, fields: Partial<PendingConfirmation> = {}): PendingConfirmation => ({
	id, creator: '123', type, typeName: '', headline: '', summary: [], icon: '', createdAt: 0, acceptText: '', cancelText: '', warn: '', ...fields
});

test('类型:认得的给中文名和标签颜色,认不出的用 Steam 的类型名,再没有写类型号', () => {
	assert.deepEqual(confirmationType(conf('a', 2)), {label: '交易报价', tag: 'info'});
	assert.deepEqual(confirmationType(conf('a', 3)), {label: '市场上架', tag: 'success'});
	assert.deepEqual(confirmationType(conf('a', 9)), {label: '创建 API Key', tag: 'error'});
	assert.deepEqual(confirmationType(conf('a', 42, {typeName: 'Something New'})), {label: 'Something New', tag: 'default'});
	assert.deepEqual(confirmationType(conf('a', 42)), {label: '类型 42', tag: 'default'});
});

test('涉及账号安全的(换手机号、账户恢复、API Key)不跟着全选', () => {
	const list = [conf('t', 2), conf('k', 9), conf('m', 3), conf('p', 5), conf('r', 6), conf('b', 12)];
	assert.deepEqual(list.filter(isSensitive).map(item => item.id), ['k', 'p', 'r']);
	assert.deepEqual(selectableIds(list), ['t', 'm', 'b']);
	assert.deepEqual(selectableIds([]), []);
});

test('交易报价链接:只有交易报价、creator 是数字时才有', () => {
	assert.equal(tradeOfferUrl(conf('a', 2, {creator: '5551'})), 'https://steamcommunity.com/tradeoffer/5551/');
	assert.equal(tradeOfferUrl(conf('a', 3, {creator: '5551'})), '');
	assert.equal(tradeOfferUrl(conf('a', 2, {creator: '../x'})), '');
});

test('按类型计数:按第一次出现的顺序', () => {
	assert.deepEqual(typeCounts([conf('1', 3), conf('2', 2), conf('3', 3), conf('4', 99, {typeName: 'X'})]), [
		{label: '市场上架', count: 2}, {label: '交易报价', count: 1}, {label: 'X', count: 1}
	]);
	assert.deepEqual(typeCounts([]), []);
});
