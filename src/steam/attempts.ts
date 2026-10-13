// 在线会话查询(从 app/server.js 移来):内购、UU 发货等按账号名找在线会话。

import type {Attempt} from './session-manager.ts';
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
