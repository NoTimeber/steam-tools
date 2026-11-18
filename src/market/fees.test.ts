import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buyerPriceForReceive, receiveForBuyerPrice} from './fees.ts';

test('手续费:Steam 网页上的已知例子', () => {
	// 买家付 0.03 → 到手 0.01(两项各最低 1 分)
	assert.deepEqual(receiveForBuyerPrice(3), {buyerPrice: 3, receive: 1, steamFee: 1, publisherFee: 1, fees: 2});
	// 想到手 1.00 → 买家付 1.15(5% + 10%)
	assert.deepEqual(buyerPriceForReceive(100), {buyerPrice: 115, receive: 100, steamFee: 5, publisherFee: 10, fees: 15});
	assert.equal(receiveForBuyerPrice(115).receive, 100);
	// 买家付 1.00 → 到手 0.88(Steam floor(4.4)=4,发行商 floor(8.8)=8)
	assert.deepEqual(receiveForBuyerPrice(100), {buyerPrice: 100, receive: 88, steamFee: 4, publisherFee: 8, fees: 12});
	// 买家付 10.00 → 到手 8.70
	assert.equal(receiveForBuyerPrice(1000).receive, 870);
	// 到手 0.20 → 买家 0.23:Steam 费 floor(max(1,1))=1,发行商 floor(max(2,1))=2
	assert.equal(buyerPriceForReceive(20).buyerPrice, 23);
	// 凑不上的买家价:0.22 正算不出来(到手 19 → 0.21,到手 20 → 0.23),按 Steam 的规则用到手 19、差的 1 分算进 Steam 手续费
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
		// 凑不上的买家价:按到手价正算的买家价不会超过填的价
		assert.ok(buyerPriceForReceive(split.receive).buyerPrice <= buyer, `买家 ${buyer}`);
	}
});
