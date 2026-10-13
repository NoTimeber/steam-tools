// 币种相关的静态表(从 app/server.js 和 app/services/currency-rates.js 移来)。

// Steam 钱包币种 ID → ISO 代码
export const CURRENCY_ID_TO_ISO: Readonly<Record<string, string>> = Object.freeze({
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

/** 钱包币种 ID → ISO;未知或空为 '' */
export function currencyIdToIso(currency: unknown): string {
	if (currency == null || currency === '') {
		return '';
	}
	return String(CURRENCY_ID_TO_ISO[String(currency)] || '').trim().toUpperCase();
}

/** 2~3 位字母的国家/地区代码转大写,其它一律 '' */
export function normalizeCountryCode(value: unknown): string {
	const country = String(value || '').trim().toUpperCase();
	return /^[A-Z]{2,3}$/.test(country) ? country : '';
}

// 币种 → 对应国家/地区代码,用于从钱包币种推断账号国家。
// 故意不含 USD:很多国家/地区的 Steam 钱包都是美元,推不出国家。
export const CURRENCY_ISO_TO_COUNTRY: Readonly<Record<string, string>> = Object.freeze({
	AED: 'AE',
	ARS: 'AR',
	AUD: 'AU',
	BGN: 'BG',
	BRL: 'BR',
	BYN: 'BY',
	CAD: 'CA',
	CHF: 'CH',
	CLP: 'CL',
	CNY: 'CN',
	COP: 'CO',
	CRC: 'CR',
	CZK: 'CZ',
	DKK: 'DK',
	EUR: 'EU',
	GBP: 'GB',
	HKD: 'HK',
	HRK: 'HR',
	HUF: 'HU',
	IDR: 'ID',
	ILS: 'IL',
	INR: 'IN',
	JPY: 'JP',
	KRW: 'KR',
	KWD: 'KW',
	KZT: 'KZ',
	MYR: 'MY',
	MXN: 'MX',
	NOK: 'NO',
	NZD: 'NZ',
	PEN: 'PE',
	PHP: 'PH',
	PLN: 'PL',
	QAR: 'QA',
	RUB: 'RU',
	SAR: 'SA',
	SGD: 'SG',
	THB: 'TH',
	TRY: 'TR',
	TWD: 'TW',
	UAH: 'UA',
	UYU: 'UY',
	VND: 'VN',
	ZAR: 'ZA'
});
