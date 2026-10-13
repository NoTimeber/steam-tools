// 会话查询(从 app/server.js 移来):内购、UU 发货按账号名找在线会话;买游戏、市场求购按 id/账号名找能走 cookie 流程的会话。

import type {Attempt} from './session-manager.ts';
import {currencyIdToIso} from './currencies.ts';
import {gameConfig} from './games.ts';

// 已登录 Steam(正在拿或已拿到 WebSession)
export const ONLINE_STATUSES: ReadonlySet<string> = new Set(['logged_on', 'web_session', 'web_session_pending']);

export function isAttemptOnline(attempt: Attempt | null | undefined): attempt is Attempt {
	return !!(attempt && attempt.accountName && ONLINE_STATUSES.has(String(attempt.status || '')));
}

/** 在线,且指定游戏的 GC 模块已挂上、GC 已连接 */
export function isAttemptReadyForGc(attempt: Attempt | null | undefined, game: unknown): attempt is Attempt {
	const config = gameConfig(game);
	return !!(
		isAttemptOnline(attempt)
		&& attempt.client
		&& attempt[config.moduleKey]
		&& attempt[config.gcStateKey]
		&& attempt.client.steamID
	);
}

function newestFirst(left: Attempt, right: Attempt): number {
	return Number(right.createdAt || 0) - Number(left.createdAt || 0);
}

/** 按账号名(不区分大小写)找在线会话;有多个取最新的 */
export function findOnlineAttempt(attempts: Iterable<Attempt>, accountName: unknown): Attempt | null {
	const target = String(accountName || '').trim().toLowerCase();
	if (!target) {
		return null;
	}
	return Array.from(attempts)
		.filter(attempt => isAttemptOnline(attempt) && String(attempt.accountName || '').trim().toLowerCase() === target)
		.sort(newestFirst)[0] || null;
}

/** 最新的一个已连上指定游戏 GC 的在线会话 */
export function pickGcReadyAttempt(attempts: Iterable<Attempt>, game: unknown): Attempt | null {
	return Array.from(attempts).filter(attempt => isAttemptReadyForGc(attempt, game)).sort(newestFirst)[0] || null;
}

/** 最新的一个挂了指定游戏 GC 模块的在线会话(GC 不一定已连上) */
export function pickOnlineAttemptWithGc(attempts: Iterable<Attempt>, game: unknown): Attempt | null {
	const config = gameConfig(game);
	return Array.from(attempts)
		.filter(attempt => isAttemptOnline(attempt) && !!attempt[config.moduleKey])
		.sort(newestFirst)[0] || null;
}

/** 按 attemptId 或账号名(不区分大小写)找会话,不看在线状态 */
export function findAttemptByKey(attempts: ReadonlyMap<string, Attempt>, key: unknown): Attempt | null {
	const text = String(key || '');
	if (!text) {
		return null;
	}
	const byId = attempts.get(text);
	if (byId) {
		return byId;
	}
	const lower = text.toLowerCase();
	for (const attempt of attempts.values()) {
		if (String(attempt.accountName || '').toLowerCase() === lower) {
			return attempt;
		}
	}
	return null;
}

/**
 * 「买游戏」「市场求购」这类纯 cookie 的 HTTP 重放能用的会话:没被手动登出就行。
 * 特意不用 isAttemptOnline:登录后 steam-user 断线(status=disconnected)的账号 cookie 仍然有效,
 * 前端账户页也把它归在「在线」组;用 isAttemptOnline 会让挂求购/买游戏页选不到这些账号。
 */
export function isAttemptUsableForCookieFlow(attempt: Attempt | null | undefined): attempt is Attempt {
	return !!(attempt && attempt.accountName && String(attempt.status || '') !== 'logged_out');
}

export interface CookieFlowAccount {
	account: string;
	attemptId: string;
	personaName: string;
	country: string;
	hasWallet: boolean;
	currency: number | null;
	currencyISO: string;
	balance: number | null;
}

/** 买游戏/市场求购的账号下拉:能走 cookie 流程、且确实有 cookie 的会话,按账号名排序 */
export function listCookieFlowAccounts(attempts: Iterable<Attempt>, cookiesFor: (attempt: Attempt) => readonly string[]): CookieFlowAccount[] {
	return Array.from(attempts)
		.filter(isAttemptUsableForCookieFlow)
		.filter(attempt => cookiesFor(attempt).length > 0)
		.sort((left, right) => String(left.accountName || '').localeCompare(String(right.accountName || ''), 'zh-CN'))
		.map(attempt => ({
			account: attempt.accountName,
			attemptId: attempt.id,
			personaName: attempt.personaName || '',
			country: attempt.country || attempt.loginGeoCountry || '',
			hasWallet: !!attempt.hasWallet,
			currency: attempt.currency == null ? null : Number(attempt.currency),
			currencyISO: String(attempt.currencyISO || currencyIdToIso(attempt.currency) || 'USD').trim().toUpperCase(),
			balance: attempt.balance == null ? null : Number(attempt.balance)
		}));
}
