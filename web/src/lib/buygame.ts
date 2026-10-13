// 买游戏的纯逻辑(不依赖 Vue):subid 解析、价格显示、线程数、任务进度和逐账号结果的文案。规则照搬旧版前端。

import {currencySymbol} from './accounts.ts';

/** /api/buygame/online-accounts 的账号:已登录且有 WebSession cookie */
export interface CookieAccount {
	account: string;
	attemptId: string;
	country: string;
	hasWallet: boolean;
	currency: number | null;
	currencyISO: string;
	balance: number | null;
}

/** 待购买的游戏(按 subid 解析出名称和价格) */
export interface GameEntry {
	packageId: number;
	name: string;
	appid: number;
	priceCents: number;
	currencyISO: string;
	discountPercent: number;
	resolving: boolean;
	error: string;
}

export type AccountStatus = 'queued' | 'running' | 'verified' | 'success' | 'failed';

export interface BuyGameTask {
	id: string;
	status: 'queued' | 'running' | 'completed' | 'failed' | string;
	dryRun: boolean;
	concurrency: number;
	createdAt: string;
	totalAccounts: number;
	processedAccounts: number;
	successCount: number;
	failCount: number;
	accounts: Array<{
		account: string;
		status: AccountStatus | string;
		currency: number | null;
		currencyISO: string;
		spentCents: number | null;
		transId: string;
		error: string;
	}>;
}

/** 「123, 456 789」→ [123, 456, 789];中英文逗号、空白都能分隔,非正整数丢掉 */
export function parseSubids(text: string): number[] {
	return String(text || '')
		.split(/[\s,，]+/)
		.map(part => Number(part.trim()))
		.filter(id => Number.isInteger(id) && id > 0);
}

/** 金额:有钱包币种 id 时用和余额一致的符号,否则写 ISO 代码 */
export function formatMoney(cents: number, currency: number | null | undefined, currencyISO: string): string {
	const major = (Number(cents) / 100).toFixed(2);
	return currency != null ? `${currencySymbol(currency)}${major}` : `${major} ${currencyISO || ''}`.trim();
}

/** 游戏列表里的价格(按第一个已选账号的区域解析的) */
export function formatGamePrice(game: GameEntry, pricingCurrency: number | null): string {
	if (game.resolving) return '解析中…';
	if (game.error) return game.error;
	if (!game.priceCents) return '免费 / 无价格';
	return formatMoney(game.priceCents, pricingCurrency, game.currencyISO) + (game.discountPercent ? ` (-${game.discountPercent}%)` : '');
}

/** 并发线程数:1-10,填错用 3 */
export function clampConcurrency(value: unknown): number {
	const n = Math.round(Number(value));
	return !Number.isFinite(n) || n < 1 ? 3 : Math.min(10, n);
}

const TASK_STATUS: Readonly<Record<string, string>> = {queued: '排队', running: '进行中', completed: '已完成', failed: '失败'};

export function taskProgress(task: BuyGameTask): string {
	const thread = task.concurrency ? ` · ${task.concurrency} 线程` : '';
	return `${task.dryRun ? '试运行' : '真实购买'} · ${TASK_STATUS[task.status] ?? task.status}${thread} · ${task.processedAccounts}/${task.totalAccounts} · 成功 ${task.successCount} 失败 ${task.failCount}`;
}

const ACCOUNT_STATUS: Readonly<Record<string, {label: string; tone: 'default' | 'success' | 'warning' | 'error'}>> = {
	queued: {label: '排队', tone: 'default'},
	running: {label: '购买中', tone: 'warning'},
	verified: {label: '验证通过', tone: 'success'},
	success: {label: '成功', tone: 'success'},
	failed: {label: '失败', tone: 'error'}
};

export function accountStatus(status: string): {label: string; tone: 'default' | 'success' | 'warning' | 'error'} {
	return ACCOUNT_STATUS[status] ?? {label: status, tone: 'default'};
}

export function accountDetail(account: BuyGameTask['accounts'][number], dryRun: boolean): string {
	if (account.status === 'failed') return account.error || '失败';
	if (account.transId) return (dryRun ? '已验证 · 交易号 ' : '交易号 ') + account.transId;
	return '';
}

/** 任务结束的提示;没结束返回 null */
export function completionNotice(task: BuyGameTask): {level: 'success' | 'warn'; message: string} | null {
	if (task.status !== 'completed' && task.status !== 'failed') {
		return null;
	}
	const fail = Number(task.failCount || 0);
	if (task.dryRun) {
		const ok = (task.accounts || []).filter(account => account.status === 'verified').length;
		return {level: fail ? 'warn' : 'success', message: `试运行完成:${ok} 个账号验证通过${fail ? `,${fail} 个失败` : ''}`};
	}
	return {level: fail ? 'warn' : 'success', message: `购买完成:成功 ${Number(task.successCount || 0)},失败 ${fail}`};
}
