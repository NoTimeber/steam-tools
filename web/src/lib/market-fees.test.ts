/// <reference types="node" />
// 和后端 src/market/fees.test.ts 用同一组数,保证前后端算出来一样
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buyerPriceForReceive, receiveForBuyerPrice} from './market-fees.ts';

test('手续费:Steam 网页上的已知例子', () => {
	assert.deepEqual(receiveForBuyerPrice(3), {buyerPrice: 3, receive: 1, steamFee: 1, publisherFee: 1, fees: 2});
	assert.deepEqual(buyerPriceForReceive(100), {buyerPrice: 115, receive: 100, steamFee: 5, publisherFee: 10, fees: 15});
	assert.equal(receiveForBuyerPrice(115).receive, 100);
	assert.deepEqual(receiveForBuyerPrice(100), {buyerPrice: 100, receive: 88, steamFee: 4, publisherFee: 8, fees: 12});
	assert.equal(receiveForBuyerPrice(1000).receive, 870);
	assert.equal(buyerPriceForReceive(20).buyerPrice, 23);
	assert.deepEqual(receiveForBuyerPrice(22), {buyerPrice: 22, receive: 19, steamFee: 2, publisherFee: 1, fees: 3});
});

test('手续费:没有发行商费时只收 Steam 的 5%(至少 1 分)', () => {
	assert.deepEqual(buyerPriceForReceive(100, {publisherFeePercent: 0}), {buyerPrice: 105, receive: 100, steamFee: 5, publisherFee: 0, fees: 5});
	assert.equal(receiveForBuyerPrice(2, {publisherFeePercent: 0}).receive, 1);
});

test('手续费:到手价正算再反算回来不变;买家价反算出的到手价不会让买家价变高', () => {
	for (let receive = 1; receive <= 20000; receive++) {
		const forward = buyerPriceForReceive(receive);
		const back = receiveForBuyerPrice(forward.buyerPrice);
		assert.equal(back.receive, receive, `到手 ${receive} → 买家 ${forward.buyerPrice} → 到手 ${back.receive}`);
		assert.equal(back.buyerPrice, forward.buyerPrice);
	}
	for (let buyer = 3; buyer <= 20000; buyer++) {
		const split = receiveForBuyerPrice(buyer);
		assert.equal(split.buyerPrice, buyer);
		assert.equal(split.receive + split.fees, buyer);
		assert.ok(split.receive >= 1, `买家 ${buyer}`);
		assert.ok(buyerPriceForReceive(split.receive).buyerPrice <= buyer, `买家 ${buyer}`);
	}
});
