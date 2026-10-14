// UU 发货的纯逻辑(不依赖 Vue):发货列表的组成、在线提示、统计、轮询间隔显示、自动绑定。规则照搬旧版前端。

/** 发货状态(src/uu/state.ts 的 publicAccount,只列用到的) */
export interface UuAccount {
	accountName: string;
	bound: boolean;
	nickname: string;
	userId: string;
	tokenExpired: boolean;
	tokenExpiresAt: string;
	delivery: Record<string, {
		gameId: string;
		gameLabel: string;
		auto: boolean;
		status: 'idle' | 'scanning' | 'error' | string;
		lastScanAt: string;
		lastError: string;
		stats: {delivered?: number; failed?: number; [key: string]: number | undefined};
	}>;
	recentOrders: Array<{orderNo: string; itemName: string; ok: boolean; reason: string; at: string}>;
	logs: Array<{time: string; level: string; message: string}>;
	/** 后端发货就绪判断:Steam 在线(这才是能不能发货的门槛) */
	online: boolean;
	hasCookies: boolean;
	hasIdentitySecret: boolean;
	listAuto: boolean;
	listStatus: 'idle' | 'listing' | 'error' | string;
	listLastError: string;
	listStats: {listed?: number; repriced?: number; failed?: number; noAbrade?: number};
}

/** 已获取的 token(不含原文) */
export interface UuToken {
	id: string;
	userId: string;
	nickname: string;
	linkedSteamId: string;
	tokenMask?: string;
}

/** 账户管理里的账号(按 SteamID 匹配 token) */
export interface LocalAccount {
	accountName: string;
	steamID: string;
}

export const CS2 = '730';
export const TF2 = '440';

export type UuRow =
	| {kind: 'account'; key: string; account: UuAccount; local: LocalAccount | null}
	| {kind: 'token'; key: string; token: UuToken; local: LocalAccount | null};

function findBySteamId(locals: readonly LocalAccount[], steamId: string): LocalAccount | null {
	const id = String(steamId || '').trim();
	return id ? locals.find(local => String(local.steamID || '').trim() === id) ?? null : null;
}

/**
 * 发货列表 = 已绑定 token 的账号(已绑定在前、按账号名)+ 还没匹配到账号的 token(获取完 token 总得看到点反馈)。
 * 账号在不在线只影响行内提示,不影响显示
 */
export function uuRows(accounts: readonly UuAccount[], tokens: readonly UuToken[], locals: readonly LocalAccount[]): UuRow[] {
	const sorted = accounts.slice().sort((left, right) => (left.bound === right.bound ? left.accountName.localeCompare(right.accountName) : left.bound ? -1 : 1));
	const claimed = new Set(sorted.map(account => account.userId).filter(Boolean));
	const localByName = new Map(locals.map(local => [local.accountName.toLowerCase(), local]));
	return [
		...sorted.map(account => ({kind: 'account' as const, key: 'account:' + account.accountName, account, local: localByName.get(account.accountName.toLowerCase()) ?? null})),
		...tokens
			.filter(token => token && token.id && !(token.userId && claimed.has(token.userId)))
			.map(token => ({kind: 'token' as const, key: 'token:' + token.id, token, local: findBySteamId(locals, token.linkedSteamId)}))
	];
}

export interface Hint {
	text: string;
	tone: 'success' | 'warning' | 'error' | 'default';
	title?: string;
}

/** 已绑定账号的在线提示:在线但缺 cookies / identity_secret 也发不了货,一起提示 */
export function onlineHint(account: UuAccount, local: LocalAccount | null): Hint {
	if (!local) {
		return {text: '账户管理无此账号', tone: 'default', title: 'UU 绑定的 Steam 账号不在「账户管理」列表里'};
	}
	if (!account.online) {
		return {text: '离线', tone: 'error', title: 'Steam 账号未在线,无法发货'};
	}
	if (!account.hasCookies) {
		return {text: '在线·缺 cookies', tone: 'warning', title: '缺少 WebSession cookies,无法发货'};
	}
	if (!account.hasIdentitySecret) {
		return {text: '在线·缺 maFile', tone: 'warning', title: '缺少 identity_secret(需导入 maFile),无法确认发货'};
	}
	return {text: '在线', tone: 'success'};
}

/** 还没匹配到账号的 token 为什么用不了 */
export function tokenHint(token: UuToken, local: LocalAccount | null): {tag: string; hint: string} {
	const steamId = String(token.linkedSteamId || '').trim();
	if (!steamId) {
		return {tag: '未匹配', hint: '该 Token 在 UU 侧未绑定 Steam 账号,无法用于发货'};
	}
	if (local) {
		return {tag: '绑定失败', hint: `已匹配到账号 ${local.accountName},但绑定未成功,请检查 Token 是否已过期`};
	}
	return {tag: '未匹配', hint: `该 Token 绑定的 SteamID ${steamId} 未匹配到「账户管理」中的账号,请先在账户管理添加并登录一次该账号`};
}

/**
 * 自动绑定:token 在 UU 侧绑的 SteamID 对上了「账户管理」里的账号(不要求在线,登录过一次存了 SteamID 就行),
 * 且那个账号还没绑 token
 */
export function autoBindCandidates(tokens: readonly UuToken[], accounts: readonly UuAccount[], locals: readonly LocalAccount[]): Array<{tokenId: string; accountName: string}> {
	const bound = new Set(accounts.filter(account => account.bound).map(account => account.accountName));
	const out: Array<{tokenId: string; accountName: string}> = [];
	for (const token of tokens) {
		if (!token.id || !token.linkedSteamId) {
			continue;
		}
		const local = findBySteamId(locals, token.linkedSteamId);
		if (local && !bound.has(local.accountName)) {
			out.push({tokenId: token.id, accountName: local.accountName});
			bound.add(local.accountName);
		}
	}
	return out;
}

export function formatInterval(ms: number): string {
	const n = Number(ms || 0);
	if (n <= 0) return '-';
	if (n % 60000 === 0) return `${n / 60000} 分钟`;
	if (n >= 60000) return `${Math.round(n / 6000) / 10} 分钟`;
	return `${Math.round(n / 1000)} 秒`;
}

export function uuCounts(accounts: readonly UuAccount[]): {total: number; bound: number; online: number; delivered: number} {
	let delivered = 0;
	for (const account of accounts) {
		for (const game of Object.values(account.delivery || {})) {
			delivered += Number(game?.stats?.delivered || 0);
		}
	}
	return {
		total: accounts.length,
		bound: accounts.filter(account => account.bound).length,
		online: accounts.filter(account => account.online).length,
		delivered
	};
}

export function deliveryStatus(status: string): {label: string; tone: 'default' | 'warning' | 'error'} {
	if (status === 'scanning') return {label: '发货中', tone: 'warning'};
	if (status === 'error') return {label: '错误', tone: 'error'};
	return {label: '空闲', tone: 'default'};
}

/** 统计一行:发货数、失败数、上架情况 */
export function statsText(account: UuAccount): string {
	const cs2 = account.delivery?.[CS2]?.stats ?? {};
	const tf2 = account.delivery?.[TF2]?.stats ?? {};
	const list = account.listStats || {};
	const parts = [
		`CS2发货 ${cs2.delivered || 0}`,
		`TF2发货 ${tf2.delivered || 0}`,
		`失败 ${(cs2.failed || 0) + (tf2.failed || 0)}`,
		`上架 ${list.listed || 0}` + (list.repriced ? ` / 改价 ${list.repriced}` : '') + (list.failed ? ` / 失败 ${list.failed}` : '') + (list.noAbrade ? ` / 无磨损 ${list.noAbrade}` : '')
	];
	return parts.join(' · ');
}

/** 轮询间隔输入框里显示的分钟数(保留一位小数) */
export function intervalMinutes(ms: number): number | null {
	return ms > 0 ? Math.round(ms / 60000 * 10) / 10 : null;
}
