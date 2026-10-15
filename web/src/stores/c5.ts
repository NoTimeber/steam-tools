// C5 扫货:后端状态(在这个页面时每 2.5 秒拉一次)、监控列表草稿(改了没保存的留在内存里,切走页面不丢)、
// 运行状态、设置、检查连接、查在售、对账、手工标记;推送 c5:log 写右侧运行日志。

import {computed, reactive} from 'vue';
import {api} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import {draftPayload, draftsDirty, newDraft, toDrafts} from '../lib/c5.ts';
import type {C5CheckResult, C5Listing, C5NameSearch, C5Receiver, C5Receivers, C5RunState, C5Settings, C5State, DraftRow} from '../lib/c5.ts';
import {addLog} from './logs.ts';

const POLL_MS = 2500;

export const c5 = reactive({
	state: null as C5State | null,
	loading: false,
	error: '',
	drafts: [] as DraftRow[],
	savingList: false
});

let uidSeq = 0;
const newUid = () => `row-${++uidSeq}`;

export const serverItems = computed(() => c5.state?.items ?? []);
export const dirty = computed(() => draftsDirty(c5.drafts, serverItems.value));

function applyState(state: C5State): void {
	// 草稿没改过就跟着服务端走(别的页签保存了也能看到);改过的留着,等保存或放弃
	const wasDirty = dirty.value;
	c5.state = state;
	if (!wasDirty) {
		c5.drafts = toDrafts(state.items, newUid, c5.drafts);
	}
}

// ===== 读取 =====

export async function refresh(): Promise<void> {
	if (c5.loading) {
		return;
	}
	c5.loading = true;
	try {
		const data = await api.get<{state: C5State}>('/api/c5/state');
		applyState(data.state);
		c5.error = '';
	} catch (err) {
		c5.error = err instanceof Error ? err.message : String(err);
	} finally {
		c5.loading = false;
	}
}

let timer: number | null = null;

export function enterC5(): void {
	void refresh();
	if (timer == null) {
		timer = window.setInterval(() => {
			if (!document.hidden) {
				void refresh();
			}
		}, POLL_MS);
	}
}

export function leaveC5(): void {
	if (timer != null) {
		window.clearInterval(timer);
		timer = null;
	}
}

// ===== 监控列表 =====

export function addDraft(init: {name: string; zh: string | null; maxPrice: number | null; maxQty: number | null}): void {
	c5.drafts.push(newDraft(newUid, init));
}

export function removeDraft(uid: string): void {
	c5.drafts = c5.drafts.filter(row => row.uid !== uid);
}

export function discardDrafts(): void {
	c5.drafts = toDrafts(serverItems.value, newUid, c5.drafts);
}

/** 整张表提交;浏览器先查一遍,不对直接报错不提交 */
export async function saveWatchlist(): Promise<void> {
	const {items, error} = draftPayload(c5.drafts);
	if (error) {
		throw new Error(error);
	}
	c5.savingList = true;
	try {
		const data = await api.post<{state: C5State}>('/api/c5/watchlist', {items});
		c5.state = data.state;
		c5.drafts = toDrafts(data.state.items, newUid, c5.drafts);
	} finally {
		c5.savingList = false;
	}
}

// ===== 运行状态 / 设置 =====

export async function setRun(state: C5RunState): Promise<void> {
	const data = await api.post<{state: C5State}>('/api/c5/run', {state});
	applyState(data.state);
}

export async function saveSettings(settings: C5Settings & {appKey?: string; clearAppKey?: boolean}): Promise<C5State> {
	const data = await api.post<{state: C5State}>('/api/c5/settings', settings);
	applyState(data.state);
	return data.state;
}

// ===== 其它操作 =====

export async function checkConnection(): Promise<C5CheckResult> {
	const data = await api.post<{result: C5CheckResult}>('/api/c5/check');
	void refresh();
	return data.result;
}

/** 添加饰品时按中文或英文搜名字 */
/** 添加饰品时按中文或英文搜名字,带 C5 在售最低价 */
export async function searchNames(q: string): Promise<C5NameSearch> {
	return api.get<C5NameSearch>('/api/c5/names?q=' + encodeURIComponent(q));
}

/** 收货账号下拉:C5 上绑定的 Steam 账号,标上选它时交易链接从哪来 */
export async function fetchReceivers(): Promise<C5Receivers> {
	return api.get<C5Receivers>('/api/c5/receivers');
}

/** 取某个 SteamID 的交易链接(只取,不改设置)。409 = 拿不到,要人贴一次;warning 是改用记下的链接的原因 */
export async function fetchTradeUrl(steamId: string): Promise<{tradeUrl: string; receiver: C5Receiver | null; warning: string | null}> {
	return api.post('/api/c5/trade-url', {steamId});
}

/** 收货账号换成这个交易链接(其它设置不动);后端会记下链接,下次选同一个账号不用再贴 */
export async function saveReceiverTradeUrl(tradeUrl: string): Promise<C5State> {
	const data = await api.post<{state: C5State}>('/api/c5/settings', {tradeUrl});
	applyState(data.state);
	return data.state;
}

/** 主页面换收货账号:取这个 SteamID 的交易链接并马上保存 */
export async function switchReceiver(steamId: string): Promise<{state: C5State; warning: string | null}> {
	const {tradeUrl, warning} = await fetchTradeUrl(steamId);
	return {state: await saveReceiverTradeUrl(tradeUrl), warning};
}

export async function fetchListings(name: string): Promise<{name: string; maxPrice: number; listings: C5Listing[]}> {
	return api.post('/api/c5/listings', {name});
}

export async function refreshOrders(): Promise<number> {
	const data = await api.post<{checked: number; state: C5State}>('/api/c5/orders/refresh');
	applyState(data.state);
	return data.checked;
}

export async function resolvePurchase(outTradeNo: string, status: 'ok' | 'failed'): Promise<void> {
	const data = await api.post<{state: C5State}>('/api/c5/purchases/resolve', {outTradeNo, status});
	applyState(data.state);
}

// ===== 推送 =====

let started = false;

export function startC5(): void {
	if (started) {
		return;
	}
	started = true;
	socket.on('c5:log', (line: {level?: string; message?: string} | null) => {
		if (line && line.message) {
			addLog(line.level || 'info', `[C5] ${line.message}`);
		}
	});
}
