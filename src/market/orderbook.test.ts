import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMarketClient, parseOrderGraph} from './client.ts';

test('盘口分档:累计数量转成每档数量,价格转成分;坏行跳过;最多 max 档', () => {
	// 在售从低到高:2.68 有 3 件,2.70 有 2 件(累计 5),2.75 有 10 件(累计 15)
	assert.deepEqual(parseOrderGraph([[2.68, 3, '3 件'], [2.7, 5, ''], ['bad', 6, ''], [2.75, 15, '']]), [
		{priceCents: 268, quantity: 3, cumulative: 3},
		{priceCents: 270, quantity: 2, cumulative: 5},
		{priceCents: 275, quantity: 10, cumulative: 15}
	]);
	// 浮点价格四舍五入到分(0.29 * 100 = 28.999…)
	assert.deepEqual(parseOrderGraph([[0.29, 1, '']]), [{priceCents: 29, quantity: 1, cumulative: 1}]);
	assert.equal(parseOrderGraph(Array.from({length: 50}, (_, i) => [1 + i / 100, i + 1, '']), 30).length, 30);
	assert.deepEqual(parseOrderGraph(null), []);
});

test('行情:盘口带出两边分档和总数(总数优先用 *_order_count,没有就读 summary 里的数字)', async () => {
	const C = 'https://steamcommunity.com';
	const json = (body: unknown) => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
	const http = (async (input: string | URL) => {
		const url = String(input);
		if (url.startsWith(C + '/market/itemordershistogram')) {
			return json({
				success: 1, highest_buy_order: '261', lowest_sell_order: '268',
				sell_order_graph: [[2.68, 3, ''], [2.7, 5, '']],
				buy_order_graph: [[2.61, 10, ''], [2.5, 40, '']],
				sell_order_count: '1,234',
				buy_order_summary: '<span class="market_commodity_orders_header_promote">5,678</span> 个求购'
			});
		}
		if (url.startsWith(C + '/market/priceoverview')) {
			return json({success: true, lowest_price: '¥ 2.68', median_price: '¥ 2.70', volume: '100'});
		}
		return new Response('not found', {status: 404});
	}) as typeof fetch;
	const client = createMarketClient({fetch: http, log: () => {}});
	const context = await client.fetchMarketContext({appid: 730, marketHashName: 'Kilowatt Case', itemNameId: '176460428', currency: 23});
	assert.deepEqual(context.sellOrders.map(level => [level.priceCents, level.quantity]), [[268, 3], [270, 2]]);
	assert.deepEqual(context.buyOrders.map(level => [level.priceCents, level.quantity]), [[261, 10], [250, 30]]);
	assert.deepEqual([context.sellTotal, context.buyTotal], [1234, 5678]);
	assert.deepEqual(context.issues, []);
});

test('价格走势:时间按 UTC 小时解析,价格转分,数量去千分位;坏行跳过;按时间排序', async () => {
	const {parsePriceHistory} = await import('./client.ts');
	assert.deepEqual(parsePriceHistory([
		['Nov 18 2026 01: +0', 2.345, '1,234'],
		['Nov 17 2026 13: +0', 0.29, '5'],
		['bad date', 1, '1'],
		['Nov 16 2026 01: +0', 0, '3']
	]), [
		{time: Date.UTC(2026, 10, 17, 13), priceCents: 29, volume: 5},
		{time: Date.UTC(2026, 10, 18, 1), priceCents: 235, volume: 1234}
	]);
	assert.deepEqual(parsePriceHistory(undefined), []);
});
