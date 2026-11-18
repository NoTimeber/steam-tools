/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {barPercent, bookPosition, bookRows, maxQuantity, positionText} from './orderbook.ts';
import type {OrderLevel} from './orderbook.ts';

// 和后端 src/market/orderbook.test.ts 同一组:在售 2.68×3、2.70×2、2.75×10;求购 2.61×10、2.50×30
const SELL: OrderLevel[] = [{priceCents: 268, quantity: 3, cumulative: 3}, {priceCents: 270, quantity: 2, cumulative: 5}, {priceCents: 275, quantity: 10, cumulative: 15}];
const BUY: OrderLevel[] = [{priceCents: 261, quantity: 10, cumulative: 10}, {priceCents: 250, quantity: 30, cumulative: 40}];
const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

test('在售一边的位置:更便宜的在前,同价并进那一档,超出已知档位标 beyond', () => {
	assert.deepEqual(bookPosition(SELL, 'sell', 260), {level: 1, joins: false, ahead: 0, samePrice: 0, beyond: false});
	assert.deepEqual(bookPosition(SELL, 'sell', 270), {level: 2, joins: true, ahead: 3, samePrice: 2, beyond: false});
	assert.deepEqual(bookPosition(SELL, 'sell', 272), {level: 3, joins: false, ahead: 5, samePrice: 0, beyond: false});
	assert.deepEqual(bookPosition(SELL, 'sell', 300), {level: 4, joins: false, ahead: 15, samePrice: 0, beyond: true});
	assert.deepEqual(bookPosition([], 'sell', 300), {level: 1, joins: false, ahead: 0, samePrice: 0, beyond: false});
	assert.equal(bookPosition(SELL, 'sell', null), null);
	assert.equal(bookPosition(SELL, 'sell', 0), null);

	assert.equal(positionText('sell', 272, bookPosition(SELL, 'sell', 272)!, yuan), '按 ¥2.72 上架:前面有 5 件更便宜(排第 3 档)');
	assert.equal(positionText('sell', 270, bookPosition(SELL, 'sell', 270)!, yuan), '按 ¥2.70 上架:前面有 3 件更便宜(排第 2 档),同价已有 2 件排在前面');
	assert.equal(positionText('sell', 260, bookPosition(SELL, 'sell', 260)!, yuan), '按 ¥2.60 上架:是最低价(排第 1 档)');
	assert.equal(positionText('sell', 300, bookPosition(SELL, 'sell', 300)!, yuan), '按 ¥3.00 上架:前面至少有 15 件更便宜(排第 4 档之后)');
});

test('求购一边的位置:出价更高的在前', () => {
	assert.deepEqual(bookPosition(BUY, 'buy', 262), {level: 1, joins: false, ahead: 0, samePrice: 0, beyond: false});
	assert.deepEqual(bookPosition(BUY, 'buy', 260), {level: 2, joins: false, ahead: 10, samePrice: 0, beyond: false});
	assert.deepEqual(bookPosition(BUY, 'buy', 250), {level: 2, joins: true, ahead: 10, samePrice: 30, beyond: false});
	assert.equal(positionText('buy', 260, bookPosition(BUY, 'buy', 260)!, yuan), '按 ¥2.60 求购:前面有 10 个更高的求购(排第 2 档)');
	assert.equal(positionText('buy', 262, bookPosition(BUY, 'buy', 262)!, yuan), '按 ¥2.62 求购:是最高的求购(排第 1 档)');
});

test('显示的行:默认前几档,同价档标出来,不同价插标记行;位置在显示范围外不插', () => {
	const kinds = (rows: ReturnType<typeof bookRows>) => rows.map(row => (row.kind === 'mine' ? `mine:${row.priceCents}` : `${row.level.priceCents}${row.mine ? '*' : ''}`));
	assert.deepEqual(kinds(bookRows(SELL, 'sell', null, false)), ['268', '270', '275']);
	assert.deepEqual(kinds(bookRows(SELL, 'sell', 270, false)), ['268', '270*', '275']);
	assert.deepEqual(kinds(bookRows(SELL, 'sell', 272, false)), ['268', '270', 'mine:272', '275']);
	assert.deepEqual(kinds(bookRows(SELL, 'sell', 260, false)), ['mine:260', '268', '270', '275']);
	assert.deepEqual(kinds(bookRows(SELL, 'sell', 300, false)), ['268', '270', '275', 'mine:300'], '全部档都显示了才在末尾插');
	assert.deepEqual(kinds(bookRows(SELL, 'sell', 300, false, 2)), ['268', '270'], '只显示前 2 档时,第 4 档的位置不插');
	assert.deepEqual(kinds(bookRows(SELL, 'sell', 272, false, 2)), ['268', '270'], '第 3 档的位置在显示范围外');
	assert.deepEqual(kinds(bookRows(SELL, 'sell', 272, true, 2)), ['268', '270', 'mine:272', '275'], '展开全部');
	assert.deepEqual(kinds(bookRows(BUY, 'buy', 255, false)), ['261', 'mine:255', '250']);
});

test('深度条:按显示档里最大的数量算比例', () => {
	assert.equal(maxQuantity(SELL), 10);
	assert.equal(maxQuantity([]), 1);
	assert.equal(barPercent(10, 10), 100);
	assert.equal(barPercent(3, 10), 30);
	assert.equal(barPercent(1, 1000), 2, '至少 2%');
	assert.equal(barPercent(0, 10), 0);
});
