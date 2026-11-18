// 价格走势(GET /api/market/pricehistory):按 账号|appid|英文名 缓存在内存里,图表打开时才查;刷新时带 refresh=1。
// Steam 这个接口限流很紧,服务端也缓存 5 分钟;报错(比如 429)原样显示。

import {reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import type {PriceHistory} from '../lib/pricehistory.ts';

export interface HistoryEntry {
	loading: boolean;
	data: PriceHistory | null;
	error: string;
}

export const priceHistories = reactive({} as Record<string, HistoryEntry>);

export function historyKey(account: string, appid: number, marketHashName: string): string {
	return `${account}|${appid}|${marketHashName}`;
}

/** 查一件物品的走势;已有(或正在查)就不重复查,refresh 强制重查 */
export async function loadPriceHistory(account: string, appid: number, marketHashName: string, refresh = false): Promise<void> {
	const key = historyKey(account, appid, marketHashName);
	const cached = priceHistories[key];
	if (cached?.loading || (cached && !refresh && !cached.error)) {
		return;
	}
	priceHistories[key] = {loading: true, data: cached?.data ?? null, error: ''};
	try {
		const query = new URLSearchParams({account, appid: String(appid), marketHashName});
		if (refresh) {
			query.set('refresh', '1');
		}
		const data = await api.get<PriceHistory>('/api/market/pricehistory?' + query);
		priceHistories[key] = {loading: false, data, error: ''};
	} catch (err) {
		priceHistories[key] = {loading: false, data: cached?.data ?? null, error: errorText(err) || '价格走势获取失败'};
	}
}
