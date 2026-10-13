// 美元汇率(从 app/services/currency-rates.js 移来):内购页按汇率把各币种价格折成美元比较。

import {CURRENCY_ID_TO_ISO} from '../steam/currencies.ts';

export const RATE_API_URL = 'https://open.er-api.com/v6/latest/USD';
export const RATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 币种 ISO → 1 美元可换多少该币种 */
export type RateMap = Record<string, number>;

export interface RateState {
	source: string;
	fetchedAt: string;
	fetchedAtMs: number;
	base: 'USD';
	rates: RateMap;
}

export function isFreshRateState(state: RateState | null | undefined, now = Date.now()): state is RateState {
	return !!(
		state
		&& state.fetchedAtMs
		&& (now - Number(state.fetchedAtMs || 0)) < RATE_CACHE_TTL_MS
		&& state.rates
		&& Object.keys(state.rates).length
	);
}

function rateError(message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode: 502});
}

/** 只保留 Steam 钱包支持的币种、正数汇率(保留 6 位小数);USD 恒为 1 */
export function normalizeUsdExchangeRates(payload: unknown): RateMap {
	const raw = payload && typeof payload === 'object' ? (payload as {rates?: unknown}).rates : null;
	const rawRates = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
	const rates: RateMap = Object.create(null);
	rates.USD = 1;
	for (const iso of new Set(['USD', ...Object.values(CURRENCY_ID_TO_ISO)])) {
		const code = String(iso || '').trim().toUpperCase();
		if (!code || code === 'USD') {
			continue;
		}
		const value = Number(rawRates[code]);
		if (Number.isFinite(value) && value > 0) {
			rates[code] = Number(value.toFixed(6));
		}
	}
	return rates;
}

export async function fetchUsdExchangeRates(): Promise<RateState> {
	const response = await fetch(RATE_API_URL, {
		headers: {
			Accept: 'application/json',
			'User-Agent': 'steam-login-replica/0.1'
		}
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw rateError(body && body.length < 160 ? body : `汇率请求失败: HTTP ${response.status}`);
	}
	const payload = await response.json().catch(() => null);
	const rates = normalizeUsdExchangeRates(payload);
	if (!Object.keys(rates).length) {
		throw rateError('汇率响应无有效 rates');
	}
	return {
		source: 'exchange-rate-api',
		fetchedAt: new Date().toISOString(),
		fetchedAtMs: Date.now(),
		base: 'USD',
		rates
	};
}
