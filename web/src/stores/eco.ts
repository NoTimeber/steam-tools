// ECO 扫货:后端状态(在这个页面时每 2.5 秒拉一次)、监控列表草稿(改了没保存的留在内存里,切走页面不丢)、
// 运行状态、设置、密钥对、检查连接、查在售、对账、手工标记;推送 eco:log 写进「实时运行日志」。

import {computed, reactive} from 'vue';
import {api} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import {draftPayload, draftsDirty, newDraft, toDrafts} from '../lib/eco.ts';
import type {DraftRow, EcoBindGroupMode, EcoBindList, EcoBindResult, EcoCheckResult, EcoListing, EcoNameSearch, EcoReceiverAccount, EcoReceivers, EcoRunState, EcoSettings, EcoState} from '../lib/eco.ts';
import {addLog} from './logs.ts';

const POLL_MS = 2500;

export const eco = reactive({
	state: null as EcoState | null,
	loading: false,
	error: '',
	drafts: [] as DraftRow[],
	savingList: false
});

let uidSeq = 0;
const newUid = () => `row-${++uidSeq}`;

export const serverItems = computed(() => eco.state?.items ?? []);
export const dirty = computed(() => draftsDirty(eco.drafts, serverItems.value));

function applyState(state: EcoState): void {
	// 草稿没改过就跟着服务端走(别的页签保存了也能看到);改过的留着,等保存或放弃
	const wasDirty = dirty.value;
	eco.state = state;
	if (!wasDirty) {
		eco.drafts = toDrafts(state.items, newUid, eco.drafts);
	}
}

// ===== 读取 =====

export async function refresh(): Promise<void> {
	if (eco.loading) {
		return;
	}
	eco.loading = true;
	try {
		const data = await api.get<{state: EcoState}>('/api/eco/state');
		applyState(data.state);
		eco.error = '';
	} catch (err) {
		eco.error = err instanceof Error ? err.message : String(err);
	} finally {
		eco.loading = false;
	}
}

let timer: number | null = null;

export function enterEco(): void {
	void refresh();
	if (timer == null) {
		timer = window.setInterval(() => {
			if (!document.hidden) {
				void refresh();
			}
		}, POLL_MS);
	}
}

export function leaveEco(): void {
	if (timer != null) {
		window.clearInterval(timer);
		timer = null;
	}
}

// ===== 监控列表 =====

export function addDraft(init: {name: string; zh: string | null; maxPrice: number | null; maxQty: number | null; gameId: number}): void {
	eco.drafts.push(newDraft(newUid, init));
}

export function removeDraft(uid: string): void {
	eco.drafts = eco.drafts.filter(row => row.uid !== uid);
}

export function discardDrafts(): void {
	eco.drafts = toDrafts(serverItems.value, newUid, eco.drafts);
}

/** 整张表提交;浏览器先查一遍,不对直接报错不提交 */
export async function saveWatchlist(): Promise<void> {
	const {items, error} = draftPayload(eco.drafts);
	if (error) {
		throw new Error(error);
	}
	eco.savingList = true;
	try {
		const data = await api.post<{state: EcoState}>('/api/eco/watchlist', {items});
		eco.state = data.state;
		eco.drafts = toDrafts(data.state.items, newUid, eco.drafts);
	} finally {
		eco.savingList = false;
	}
}

// ===== 运行状态 / 设置 =====

export async function setRun(state: EcoRunState): Promise<void> {
	const data = await api.post<{state: EcoState}>('/api/eco/run', {state});
	applyState(data.state);
}

/** partnerId / privateKey 留空(undefined)表示不改;clearCredentials 删除两者 */
export async function saveSettings(settings: Partial<EcoSettings> & {partnerId?: string; privateKey?: string; clearCredentials?: true}): Promise<EcoState> {
	const data = await api.post<{state: EcoState}>('/api/eco/settings', settings);
	applyState(data.state);
	return data.state;
}

/** 服务端生成新的 RSA 密钥对(替换原来的私钥);state.publicKey 是要填到 ECO 开放平台的公钥 */
export async function generateKeyPair(): Promise<EcoState> {
	const data = await api.post<{state: EcoState}>('/api/eco/keypair');
	applyState(data.state);
	return data.state;
}

// ===== 其它操作 =====

export async function checkConnection(): Promise<EcoCheckResult> {
	const data = await api.post<{result: EcoCheckResult}>('/api/eco/check');
	void refresh();
	return data.result;
}

/** 添加饰品时按中文或英文搜名字,带 ECO 在售最低价(按 gameId 查价) */
export async function searchNames(q: string, gameId: number): Promise<EcoNameSearch> {
	return api.get<EcoNameSearch>(`/api/eco/names?q=${encodeURIComponent(q)}&gameId=${gameId}`);
}

/** 收货账号下拉:ECO 上绑定的 Steam 账号(带 ECO 登记的交易链接);refresh 强制重查 */
export async function fetchReceivers(refresh = false): Promise<EcoReceivers> {
	return api.get<EcoReceivers>('/api/eco/receivers' + (refresh ? '?refresh=1' : ''));
}

/** 用 ECO 的验证接口逐个验证绑定账号的交易链接(每个约 0.5 秒);steamIds 不给验全部。返回带 linkCheck 的新列表 */
export async function verifyReceiverLinks(steamIds?: string[]): Promise<EcoReceivers> {
	return api.post<EcoReceivers>('/api/eco/receivers/verify', steamIds?.length ? {steamIds} : {});
}

/**
 * 让 ECO 用工具里存的 refreshToken 重新从 Steam 取这个账号的交易链接。
 * 是当前收货账号且链接变了时,服务端已经改了设置里的交易链接,用返回的 state。
 * 账号不在账户管理里 / 没有有效 refreshToken 回 409(带说明),ECO 报错回 502
 */
export async function updateReceiverLink(steamId: string): Promise<{tradeUrl: string; valid: boolean | null; accounts: EcoReceiverAccount[]}> {
	const data = await api.post<{tradeUrl: string; valid: boolean | null; accounts: EcoReceiverAccount[]; state: EcoState}>('/api/eco/receivers/update-link', {steamId});
	applyState(data.state);
	return data;
}

/** 收货账号换成这个交易链接(其它设置不动) */
export async function saveReceiverTradeUrl(tradeUrl: string): Promise<EcoState> {
	return saveSettings({tradeUrl});
}

/** 绑定窗口:账户管理里的账号(能不能导入令牌、ECO 上绑了没有);refresh 强制重查 ECO 上的绑定。没配好密钥回 409 */
export async function fetchBindCandidates(refresh = false): Promise<EcoBindList> {
	return api.get<EcoBindList>('/api/eco/bind/accounts' + (refresh ? '?refresh=1' : ''));
}

/**
 * 勾选的账号逐个导入令牌(maFile + 密码)绑定到 ECO;服务端串行做,账号多时要等一阵。
 * 返回每个账号的结果和刷新后的列表;上一批没做完回 409
 */
export async function importGuardAccounts(accounts: string[], groupMode: EcoBindGroupMode, groupName?: string): Promise<EcoBindList & {results: EcoBindResult[]}> {
	return api.post('/api/eco/bind/import', {accounts, groupMode, ...(groupMode === 'fixed' ? {groupName} : {})});
}

export async function fetchListings(name: string): Promise<{name: string; maxPrice: number; listings: EcoListing[]}> {
	return api.post('/api/eco/listings', {name});
}

export async function refreshOrders(): Promise<number> {
	const data = await api.post<{checked: number; state: EcoState}>('/api/eco/orders/refresh');
	applyState(data.state);
	return data.checked;
}

export async function resolvePurchase(merchantNo: string, status: 'ok' | 'failed'): Promise<void> {
	const data = await api.post<{state: EcoState}>('/api/eco/purchases/resolve', {merchantNo, status});
	applyState(data.state);
}

// ===== 推送 =====

let started = false;

export function startEco(): void {
	if (started) {
		return;
	}
	started = true;
	socket.on('eco:log', (line: {level?: string; message?: string} | null) => {
		if (line && line.message) {
			addLog(line.level || 'info', `[ECO] ${line.message}`);
		}
	});
}
