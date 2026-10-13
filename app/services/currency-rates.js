'use strict';

// 货币/汇率叶子模块(从 server.js 抽出)。
// 纯逻辑,无任何共享可变状态、不依赖 attempts/io/app —— 可独立测试。
// 注意:有状态的编排(purchaseRateState 缓存、写 purchaseCatalogStates 的 refreshPurchaseRates)
// 仍留在 server.js,它调用本模块的 fetchUsdExchangeRates / isFreshPurchaseRateState。

const PURCHASE_RATE_API_URL = 'https://open.er-api.com/v6/latest/USD';
const PURCHASE_RATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Steam 货币 ID → ISO 代码
const CURRENCY_ID_TO_ISO = Object.freeze({
	1: 'USD',
	2: 'GBP',
	3: 'EUR',
	4: 'CHF',
	5: 'RUB',
	6: 'PLN',
	7: 'BRL',
	8: 'JPY',
	9: 'NOK',
	10: 'IDR',
	11: 'MYR',
	12: 'PHP',
	13: 'SGD',
	14: 'THB',
	15: 'VND',
	16: 'KRW',
	17: 'TRY',
	18: 'UAH',
	19: 'MXN',
	20: 'CAD',
	21: 'AUD',
	22: 'NZD',
	23: 'CNY',
	24: 'INR',
	25: 'CLP',
	26: 'PEN',
	27: 'COP',
	28: 'ZAR',
	29: 'HKD',
	30: 'TWD',
	31: 'SAR',
	32: 'AED',
	34: 'ARS',
	35: 'ILS',
	36: 'BYN',
	37: 'KZT',
	38: 'KWD',
	39: 'QAR',
	40: 'CRC',
	41: 'UYU',
	42: 'BGN',
	43: 'HRK',
	44: 'CZK',
	45: 'DKK',
	46: 'HUF'
});

function currencyIdToIso(currency) {
	if (currency == null || currency === '') {
		return '';
	}
	return String(CURRENCY_ID_TO_ISO[String(currency)] || '').trim().toUpperCase();
}

function isFreshPurchaseRateState(state) {
	return !!(
		state
		&& state.fetchedAtMs
		&& (Date.now() - Number(state.fetchedAtMs || 0)) < PURCHASE_RATE_CACHE_TTL_MS
		&& state.rates
		&& Object.keys(state.rates).length
	);
}

async function fetchUsdExchangeRates() {
	const response = await fetch(PURCHASE_RATE_API_URL, {
		headers: {
			Accept: 'application/json',
			'User-Agent': 'steam-login-replica/0.1'
		}
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		const err = new Error(body && body.length < 160 ? body : `汇率请求失败: HTTP ${response.status}`);
		err.statusCode = 502;
		throw err;
	}
	const payload = await response.json().catch(() => null);
	const rates = normalizeUsdExchangeRates(payload);
	if (!Object.keys(rates).length) {
		const err = new Error('汇率响应无有效 rates');
		err.statusCode = 502;
		throw err;
	}
	return {
		source: 'exchange-rate-api',
		fetchedAt: new Date().toISOString(),
		fetchedAtMs: Date.now(),
		base: 'USD',
		rates
	};
}

function normalizeUsdExchangeRates(payload) {
	const rawRates = payload && payload.rates && typeof payload.rates === 'object'
		? payload.rates
		: {};
	const rates = Object.create(null);
	rates.USD = 1;
	for (const iso of new Set(['USD', ...Object.values(CURRENCY_ID_TO_ISO)])) {
		const code = String(iso || '').trim().toUpperCase();
		if (!code) {
			continue;
		}
		if (code === 'USD') {
			rates.USD = 1;
			continue;
		}
		const value = Number(rawRates[code]);
		if (Number.isFinite(value) && value > 0) {
			rates[code] = Number(value.toFixed(6));
		}
	}
	return rates;
}

module.exports = {
	PURCHASE_RATE_API_URL,
	PURCHASE_RATE_CACHE_TTL_MS,
	CURRENCY_ID_TO_ISO,
	currencyIdToIso,
	isFreshPurchaseRateState,
	fetchUsdExchangeRates,
	normalizeUsdExchangeRates
};
