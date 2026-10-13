import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {fetchUsdExchangeRates, isFreshRateState, normalizeUsdExchangeRates, RATE_API_URL, RATE_CACHE_TTL_MS} from './rates.ts';
import type {RateState} from './rates.ts';
import {currencyIdToIso} from '../steam/currencies.ts';

test('钱包币种 id → ISO', () => {
	assert.equal(currencyIdToIso(1), 'USD');
	assert.equal(currencyIdToIso('41'), 'UYU');
	assert.equal(currencyIdToIso(33), '', '33 没有对应币种');
	assert.equal(currencyIdToIso(null), '');
	assert.equal(currencyIdToIso(''), '');
});

test('汇率归一:只留 Steam 钱包支持的币种和正数,6 位小数,USD 恒为 1', () => {
	const rates = normalizeUsdExchangeRates({rates: {USD: 2, EUR: 0.912345678, CNY: '7.1', XYZ: 3, JPY: 0, RUB: -1, GBP: 'abc'}});
	assert.deepEqual({...rates}, {USD: 1, EUR: 0.912346, CNY: 7.1});
	assert.deepEqual({...normalizeUsdExchangeRates(null)}, {USD: 1});
});

test('汇率缓存 6 小时内有效,空的不算', () => {
	const state: RateState = {source: 's', fetchedAt: '', fetchedAtMs: 1_000_000, base: 'USD', rates: {USD: 1}};
	assert.equal(isFreshRateState(state, 1_000_000 + RATE_CACHE_TTL_MS - 1), true);
	assert.equal(isFreshRateState(state, 1_000_000 + RATE_CACHE_TTL_MS), false);
	assert.equal(isFreshRateState({...state, rates: {}}, 1_000_000), false);
	assert.equal(isFreshRateState(null), false);
});

test('拉汇率:成功返回带时间的状态;HTTP 失败报 502', async (t: TestContext) => {
	const calls: string[] = [];
	t.mock.method(globalThis, 'fetch', async (url: string) => {
		calls.push(url);
		return calls.length === 1
			? new Response(JSON.stringify({rates: {EUR: 0.9}}), {status: 200})
			: new Response('rate limited', {status: 429});
	});
	const state = await fetchUsdExchangeRates();
	assert.equal(calls[0], RATE_API_URL);
	assert.deepEqual({...state.rates}, {USD: 1, EUR: 0.9});
	assert.equal(state.source, 'exchange-rate-api');
	assert.ok(isFreshRateState(state));
	await assert.rejects(fetchUsdExchangeRates(), (err: Error & {statusCode?: number}) => err.statusCode === 502 && err.message === 'rate limited');
});
