import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {round2, UuPriceEngine} from './pricing.ts';
import type {MarketQuery} from './pricing.ts';
import type {UuMarketSale} from './client.ts';

const sales = (...prices: Array<number | string>): UuMarketSale[] => prices.map(price => ({price, commodityName: 'AK-47 | 红线'}));

test('定价:高价(> 10 元)最低两价差不到 5% 取最低,否则取第二低', () => {
	const engine = new UuPriceEngine();
	assert.equal(engine.computePrice(sales(100, 104.9, 200)), 100);
	assert.equal(engine.computePrice(sales(100, 105, 200)), 105);
	assert.equal(engine.computePrice(sales('120.456', '50.1', '51')), 50.1, '乱序也先排序');
});

test('定价:低价(≤ 10 元)从第 3 低取价,避开恶意超低挂单;不够 3 个取最高', () => {
	const engine = new UuPriceEngine();
	assert.equal(engine.computePrice(sales(0.5, 9, 9.5, 9.8)), 9.5);
	assert.equal(engine.computePrice(sales(0.5, 9)), 9);
	assert.equal(engine.computePrice(sales(3.333)), 3.33, '只有一个直接取');
	assert.equal(engine.computePrice(sales('abc', 0, -1)), 0, '没有有效价');
	assert.equal(engine.computePrice([]), 0);
	assert.equal(new UuPriceEngine({params: {lowPriceStartIndex: 0, priceThreshold: 100}}).computePrice(sales(50, 1, 70)), 1, '参数可调');
	assert.equal(round2(1.005), 1.01);
});

function market(listsByRange: Record<string, UuMarketSale[]>): MarketQuery & {queries: string[]} {
	const queries: string[] = [];
	return {
		queries,
		async getMarketSaleListWithAbrade(_templateId, opts) {
			const key = `${opts.minAbrade}-${opts.maxAbrade}`;
			queries.push(key);
			return listsByRange[key] ?? [];
		}
	};
}

test('按磨损定价:先查所在区间,没货就逐步放宽磨损上限', async () => {
	const engine = new UuPriceEngine();
	const found = market({'0.15-0.18': sales(30)});
	assert.equal(await engine.getAbradeRelatedPrice(found, 1, 'AK', 0.16), 30);
	assert.deepEqual(found.queries, ['0.15-0.18']);

	const widened = market({'0.15-0.24': sales(31)});
	assert.equal(await new UuPriceEngine().getAbradeRelatedPrice(widened, 1, 'AK', '0.16'), 31);
	assert.deepEqual(widened.queries, ['0.15-0.18', '0.15-0.21', '0.15-0.24']);
});

test('按磨损定价:放宽到 1 还没货就放弃;磨损无效或不在任何区间也放弃', async () => {
	const logs: string[] = [];
	const engine = new UuPriceEngine({logger: (level, message) => logs.push(`${level} ${message}`)});
	const empty = market({});
	assert.equal(await engine.getAbradeRelatedPrice(empty, 1, 'AK', 0.95), 0);
	assert.deepEqual(empty.queries, ['0.9-1', '0.9-1'], '最后一段:先查本段,再放宽到 1 查一次就放弃');
	assert.ok(logs.some(line => line.includes('未找到 AK 的磨损段价格')));

	const many = market({});
	assert.equal(await engine.getAbradeRelatedPrice(many, 1, 'AK', 0.0015), 0);
	assert.equal(many.queries.length, 26, '从第一段放宽到底(25 段 + 封顶 1 那次)');
	assert.equal(many.queries.at(-1), '0.001-1');

	assert.equal(await engine.getAbradeRelatedPrice(empty, 1, 'AK', 'x'), 0);
	assert.equal(await engine.getAbradeRelatedPrice(empty, 1, 'AK', 0.0001), 0);
	assert.equal(await engine.getAbradeRelatedPrice(empty, 1, 'AK', 1), 0);
	assert.ok(logs.some(line => line.includes('磨损值无效')));
	assert.ok(logs.some(line => line.includes('未匹配到 AK (磨损 0.0001) 的磨损区间')));
});

test('查价结果缓存 5 分钟(按模板 + 磨损区间)', async (t: TestContext) => {
	t.mock.timers.enable({apis: ['Date'], now: 1_000_000});
	const engine = new UuPriceEngine();
	const query = market({'0.15-0.18': sales(30)});
	await engine.getMarketSalePrice(query, 1, {abradeMin: 0.15, abradeMax: 0.18});
	await engine.getMarketSalePrice(query, 1, {abradeMin: 0.15, abradeMax: 0.18});
	await engine.getMarketSalePrice(query, 2, {abradeMin: 0.15, abradeMax: 0.18});
	assert.equal(query.queries.length, 2, '同一模板同一区间第二次走缓存');
	t.mock.timers.tick(5 * 60 * 1000 + 1);
	await engine.getMarketSalePrice(query, 1, {abradeMin: 0.15, abradeMax: 0.18});
	assert.equal(query.queries.length, 3, '过期后重新查');
	await engine.getMarketSalePrice(market({}), 9, {abradeMin: 0.1, abradeMax: 0.2});
	await engine.getMarketSalePrice(query, 9, {abradeMin: 0.1, abradeMax: 0.2});
	assert.equal(query.queries.length, 4, '没价的不缓存');
});

test('查价限频:缓存未命中时先随机等待 min~max 毫秒', async (t: TestContext) => {
	t.mock.timers.enable({apis: ['setTimeout']});
	t.mock.method(Math, 'random', () => 0.5);
	const engine = new UuPriceEngine({params: {requestGap: {min: 4000, max: 9000}}});
	const query = market({'0.15-0.18': sales(30)});
	const pending = engine.getMarketSalePrice(query, 1, {abradeMin: 0.15, abradeMax: 0.18});
	await Promise.resolve();
	assert.equal(query.queries.length, 0, '还在等');
	t.mock.timers.tick(6500);
	assert.equal(await pending, 30);
	assert.equal(new UuPriceEngine({params: {requestGapMs: 100}}).requestGapMax, 100);
	assert.equal(new UuPriceEngine().requestGapMax, 0, '默认不等');
});
