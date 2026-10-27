// UU(悠悠有品)发货:发货状态、已获取的 token(浏览器拿不到原文,只有 id)、自动绑定、短信登录拿 token、
// 发货/上架开关、轮询间隔;推送 uu:update(账号状态)、uu:log(写运行日志)。

import {computed, reactive, watch} from 'vue';
import {api, errorText} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import {autoBindCandidates, uuRows} from '../lib/uu.ts';
import type {LocalAccount, UuAccount, UuToken} from '../lib/uu.ts';
import {accounts as accountList} from './accounts.ts';
import {addLog} from './logs.ts';

export interface LoginFlow {
	phone: string;
	loginSessionId: string;
	/** sms:下行验证码;sms-up:要用本机发上行短信 */
	mode: 'sms' | 'sms-up' | '';
	smsUpContent: string;
	smsUpNumber: string;
	message: string;
	error: string;
}

export const uu = reactive({
	accounts: [] as UuAccount[],
	pollIntervalMs: 0,
	loading: false,
	loaded: false,
	error: '',
	tokens: [] as UuToken[],
	tokensLoaded: false,
	/** 自动绑定失败时服务端返回的原因,按 token id;绑上了就删 */
	bindErrors: {} as Record<string, string>,
	/** 获取 Token 弹窗 */
	modal: {
		open: false,
		/** 从某个账号行点「绑定 Token」时预选的账号;空 = 获取后按 SteamID 自动匹配 */
		accountName: '',
		login: null as LoginFlow | null,
		busy: false
	}
});

/** 账户管理里的账号(按 SteamID 匹配 token) */
const locals = computed<LocalAccount[]>(() => accountList.rows.map(row => ({accountName: row.accountName, steamID: row.steamID})));

export const rows = computed(() => uuRows(uu.accounts, uu.tokens, locals.value));

// ===== 读取 =====

let pending: Promise<void> | null = null;

/** 刷新发货状态;刷新撞车时排队再刷一次(别把后一次吞掉,不然拿到 token 后的刷新会丢) */
export async function refreshState(): Promise<void> {
	if (uu.loading) {
		pending ??= (async () => {
			while (uu.loading) {
				await new Promise(resolve => window.setTimeout(resolve, 120));
			}
			pending = null;
			await refreshState();
		})();
		return pending;
	}
	uu.loading = true;
	uu.error = '';
	try {
		const data = await api.get<{accounts?: UuAccount[]; pollIntervalMs?: number}>('/api/uu/state');
		uu.accounts = data.accounts || [];
		uu.pollIntervalMs = Number(data.pollIntervalMs || 0);
		uu.loaded = true;
	} catch (err) {
		uu.error = errorText(err) || '加载失败';
	} finally {
		uu.loading = false;
	}
}

/** 读 token 列表,然后把能对上账号的自动绑上 */
export async function refreshTokens(): Promise<void> {
	try {
		const data = await api.get<{tokens?: UuToken[]}>('/api/uu/tokens');
		uu.tokens = data.tokens || [];
	} catch {
		// 拿不到就按空的处理
	} finally {
		uu.tokensLoaded = true;
	}
	await autoBind();
}

let binding: Promise<void> = Promise.resolve();

/** 自动绑定;正在绑时排在它后面再跑一遍(别同一个 token 并发绑两次) */
function autoBind(): Promise<void> {
	binding = binding.catch(() => {}).then(bindCandidates);
	return binding;
}

async function bindCandidates(): Promise<void> {
	// 发货状态没读到时分不清哪些账号已绑,别把别人的 token 顶掉
	if (!uu.loaded) {
		return;
	}
	let bound = 0;
	for (const candidate of autoBindCandidates(uu.tokens, uu.accounts, locals.value)) {
		try {
			// 浏览器没有 token 原文,按 id 绑定,服务端自己取
			await api.post('/api/uu/bind', {accountName: candidate.accountName, tokenId: candidate.tokenId});
			delete uu.bindErrors[candidate.tokenId];
			addLog('info', `UU Token:已自动绑定到 ${candidate.accountName}`);
			bound++;
		} catch (err) {
			// 绑不上的留在列表里,行内显示服务端给的原因;同一个原因只记一次日志,刷新重试不刷屏
			const reason = errorText(err) || '未知错误';
			if (uu.bindErrors[candidate.tokenId] !== reason) {
				addLog('error', `UU Token:自动绑定到 ${candidate.accountName} 失败 ${reason}`);
			}
			uu.bindErrors[candidate.tokenId] = reason;
		}
	}
	if (bound) {
		await refreshState();
	}
}

export async function enterUu(): Promise<void> {
	if (!uu.loaded) {
		await refreshState();
	}
	if (!uu.tokensLoaded) {
		await refreshTokens();
	}
}

function mergeAccount(account: UuAccount | null | undefined): void {
	if (!account || !account.accountName) {
		return;
	}
	const index = uu.accounts.findIndex(item => item.accountName === account.accountName);
	if (index >= 0) {
		uu.accounts[index] = account;
	} else {
		uu.accounts.push(account);
	}
}

// ===== 开关 / 上架 / 轮询 =====

export async function setAuto(accountName: string, gameId: string, enabled: boolean): Promise<void> {
	const data = await api.post<{account?: UuAccount}>('/api/uu/auto', {accountName, gameId, enabled});
	mergeAccount(data.account);
}

export async function setListAuto(accountName: string, enabled: boolean): Promise<void> {
	const data = await api.post<{account?: UuAccount}>('/api/uu/list/auto', {accountName, enabled});
	mergeAccount(data.account);
	addLog('info', `CS2上架:${accountName} ${enabled ? '已开启' : '已关闭'}自动上架`);
}

export async function listScan(accountName: string): Promise<void> {
	try {
		const data = await api.post<{account?: UuAccount}>('/api/uu/list/scan', {accountName});
		mergeAccount(data.account);
		addLog('info', `CS2上架:${accountName} 上架扫描完成`);
	} catch (err) {
		addLog('error', `CS2上架:上架失败 ${errorText(err)}`);
	}
}

export async function savePollInterval(minutes: number): Promise<void> {
	const data = await api.post<{pollIntervalMs?: number}>('/api/uu/poll-interval', {minutes});
	uu.pollIntervalMs = Number(data.pollIntervalMs || 0);
}

// ===== 删除 token =====

export async function deleteAccountToken(accountName: string): Promise<void> {
	const data = await api.delete<{account?: UuAccount}>('/api/uu/token', {accountName});
	addLog('info', `UU Token:已删除 ${accountName}`);
	mergeAccount(data.account);
	await refreshTokens();
	await refreshState();
}

export async function deleteTokenById(tokenId: string): Promise<void> {
	await api.delete('/api/uu/token', {tokenId});
	addLog('info', 'UU Token:已删除未匹配的 Token');
	await refreshTokens();
	await refreshState();
}

// ===== 获取 Token(短信登录 / 手动粘贴) =====

export function openTokenModal(accountName = ''): void {
	uu.modal.open = true;
	uu.modal.accountName = accountName;
	uu.modal.login = null;
	uu.modal.busy = false;
}

export function closeTokenModal(): void {
	const sessionId = uu.modal.login?.loginSessionId;
	if (sessionId) {
		api.post('/api/uu/login/cancel', {loginSessionId: sessionId}).catch(() => {});
	}
	uu.modal.open = false;
	uu.modal.login = null;
	uu.modal.accountName = '';
}

/** 第一步:给手机号发验证码(或告诉你要发上行短信) */
export async function loginStart(phone: string): Promise<void> {
	uu.modal.busy = true;
	try {
		const data = await api.post<Partial<LoginFlow>>('/api/uu/login/start', {phone});
		uu.modal.login = {
			phone,
			loginSessionId: String(data.loginSessionId || ''),
			mode: data.mode === 'sms-up' ? 'sms-up' : 'sms',
			smsUpContent: data.smsUpContent || '',
			smsUpNumber: data.smsUpNumber || '',
			message: data.message || '',
			error: ''
		};
		addLog('info', `UU Token:已发送验证码至 ${phone}`);
	} catch (err) {
		uu.modal.login = {phone, loginSessionId: '', mode: '', smsUpContent: '', smsUpNumber: '', message: '', error: errorText(err) || '发送失败'};
		addLog('error', `UU Token:发送验证码失败 ${errorText(err)}`);
	} finally {
		uu.modal.busy = false;
	}
}

/** 第二步:登录拿 token;服务端会按 SteamID 自动绑到已登录的账号 */
export async function loginVerify(code: string): Promise<boolean> {
	const login = uu.modal.login;
	if (!login || !login.loginSessionId) {
		return false;
	}
	uu.modal.busy = true;
	try {
		const data = await api.post<{nickname?: string; userId?: string; linkedSteamId?: string; bindError?: string; tokenId?: string}>('/api/uu/login/verify', {
			loginSessionId: login.loginSessionId,
			code,
			accountName: uu.modal.accountName
		});
		addLog('info', `UU Token:获取成功 ${data.nickname || data.userId || ''}`);
		if (data.linkedSteamId) {
			addLog('info', `UU Token:已查到绑定 SteamID ${data.linkedSteamId}`);
		}
		if (data.bindError) {
			addLog('warn', `UU Token:已获取,但自动绑定失败 ${data.bindError}`);
			// 记下原因:行内提示用,随后前端重试同样失败时不重复记日志
			if (data.tokenId) {
				uu.bindErrors[data.tokenId] = data.bindError;
			}
		}
		uu.modal.login = null;
		closeTokenModal();
		await refreshTokens();
		await refreshState();
		return true;
	} catch (err) {
		login.error = errorText(err) || '登录失败';
		addLog('error', `UU Token:登录失败 ${login.error}`);
		return false;
	} finally {
		uu.modal.busy = false;
	}
}

/** 手动粘贴:预选了账号就直接绑;没选就先存下,按 SteamID 自动匹配账号 */
export async function pasteToken(token: string): Promise<void> {
	uu.modal.busy = true;
	try {
		const accountName = uu.modal.accountName;
		if (accountName) {
			const data = await api.post<{account?: UuAccount}>('/api/uu/bind', {accountName, token});
			mergeAccount(data.account);
			addLog('info', `UU Token:已绑定到 ${accountName}`);
		} else {
			const data = await api.post<{token?: UuToken}>('/api/uu/token/acquire', {token});
			const entry = data.token;
			addLog('info', `UU Token:已保存 ${entry?.nickname || entry?.userId || ''}`);
			addLog(entry?.linkedSteamId ? 'info' : 'warn', entry?.linkedSteamId
				? `UU Token:已查到绑定 SteamID ${entry.linkedSteamId}`
				: 'UU Token:该 Token 在 UU 侧未绑定 Steam 账号,无法用于发货');
		}
		closeTokenModal();
		await refreshTokens();
		await refreshState();
	} finally {
		uu.modal.busy = false;
	}
}

// ===== 推送 =====

let started = false;

export function startUu(): void {
	if (started) {
		return;
	}
	started = true;
	// 直接打开 UU 页时账户管理的 SteamID 可能比 token 列表晚到,那时一个也对不上;对上了再自动绑一次
	watch(() => autoBindCandidates(uu.tokens, uu.accounts, locals.value).map(candidate => candidate.tokenId + '>' + candidate.accountName).join(','), key => {
		if (key && uu.tokensLoaded) {
			void autoBind();
		}
	});
	socket.on('uu:update', (account: UuAccount) => mergeAccount(account));
	socket.on('uu:log', (payload: {accountName?: string; level?: string; message?: string} | null) => {
		if (payload) {
			addLog(payload.level || 'info', `[UU·${payload.accountName || ''}] ${payload.message || ''}`);
		}
	});
}
