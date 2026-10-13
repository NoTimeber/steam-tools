// 买游戏(协议购买整款 Steam 游戏):在线账号、按 subid 加游戏(按第一个已选账号的区域解析价格)、提交购买任务、任务推送。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import {notify} from '../api/notify.ts';
import {socket} from '../api/socket.ts';
import {clampConcurrency, completionNotice, parseSubids} from '../lib/buygame.ts';
import type {BuyGameTask, CookieAccount, GameEntry} from '../lib/buygame.ts';
import {addLog} from './logs.ts';

export const buygame = reactive({
	active: false,
	accounts: [] as CookieAccount[],
	accountError: '',
	loadingAccounts: false,
	/** 已选账号名,按勾选先后;价格按第一个解析 */
	selected: [] as string[],
	games: [] as GameEntry[],
	/** 当前游戏价格是按哪个会话(attemptId)的区域解析的;第一个已选账号变了就重新解析 */
	pricedFor: '',
	concurrency: 3,
	dryRun: false,
	submitting: false,
	tasks: [] as BuyGameTask[]
});

export const selectedAccounts = computed(() => buygame.selected
	.map(name => buygame.accounts.find(account => account.account === name))
	.filter((account): account is CookieAccount => !!account));

/** 价格显示用第一个已选账号的钱包币种 */
export const pricingCurrency = computed(() => {
	const first = selectedAccounts.value[0];
	return first && first.currency != null ? Number(first.currency) : null;
});

export const readyGames = computed(() => buygame.games.filter(game => !game.error && !game.resolving));

/** 最近一个任务(结果表显示它) */
export const latestTask = computed(() => buygame.tasks[0] ?? null);

const firstAttemptId = () => selectedAccounts.value[0]?.attemptId ?? '';

export async function refreshAccounts(options: {silent?: boolean} = {}): Promise<void> {
	buygame.loadingAccounts = true;
	buygame.accountError = '';
	try {
		const data = await api.get<{accounts?: CookieAccount[]}>('/api/buygame/online-accounts');
		buygame.accounts = data.accounts || [];
		// 已经离线的账号从已选里去掉
		const online = new Set(buygame.accounts.map(account => account.account));
		buygame.selected = buygame.selected.filter(name => online.has(name));
		repriceIfNeeded();
	} catch (err) {
		buygame.accountError = errorText(err) || '加载账户失败';
		if (!options.silent) {
			addLog('error', `买游戏在线账户刷新失败: ${buygame.accountError}`);
		}
	} finally {
		buygame.loadingAccounts = false;
	}
}

export async function loadTasks(): Promise<void> {
	try {
		const data = await api.get<{tasks?: BuyGameTask[]}>('/api/buygame/tasks');
		buygame.tasks = data.tasks || [];
	} catch {
		// 拿不到就等推送
	}
}

// ===== 游戏 =====

async function resolveGame(game: GameEntry): Promise<void> {
	const attemptId = firstAttemptId();
	try {
		const data = await api.get<{package?: Partial<GameEntry>}>(`/api/buygame/resolve?packageId=${game.packageId}${attemptId ? `&accountId=${encodeURIComponent(attemptId)}` : ''}`);
		const pkg = data.package || {};
		Object.assign(game, {
			name: pkg.name || `subid ${game.packageId}`,
			priceCents: Number(pkg.priceCents || 0),
			currencyISO: pkg.currencyISO || '',
			appid: Number(pkg.appid || 0),
			discountPercent: Number(pkg.discountPercent || 0),
			error: ''
		});
	} catch (err) {
		game.error = errorText(err) || '解析失败';
	} finally {
		game.resolving = false;
	}
}

/** 加 subid(可一次多个);已有的跳过。返回实际新加的个数 */
export async function addSubids(text: string): Promise<number> {
	const ids = parseSubids(text);
	if (!ids.length) {
		return 0;
	}
	buygame.pricedFor = firstAttemptId();
	const existing = new Set(buygame.games.map(game => game.packageId));
	const fresh: GameEntry[] = [];
	for (const id of ids) {
		if (existing.has(id)) {
			continue;
		}
		existing.add(id);
		buygame.games.push({packageId: id, name: '', appid: 0, priceCents: 0, currencyISO: '', discountPercent: 0, resolving: true, error: ''});
		// 拿响应式代理,解析结果改它界面才会更新
		fresh.push(buygame.games[buygame.games.length - 1]!);
	}
	await Promise.all(fresh.map(resolveGame));
	return fresh.length;
}

export function removeGame(packageId: number): void {
	buygame.games = buygame.games.filter(game => game.packageId !== packageId);
}

/** 第一个已选账号变了(区域可能不同):全部游戏按新账号重新解析价格 */
export function repriceIfNeeded(): void {
	const attemptId = firstAttemptId();
	if (attemptId === buygame.pricedFor) {
		return;
	}
	buygame.pricedFor = attemptId;
	for (const game of buygame.games) {
		game.resolving = true;
		game.error = '';
		resolveGame(game);
	}
}

export function setSelected(names: string[]): void {
	buygame.selected = names;
	repriceIfNeeded();
}

// ===== 购买 =====

/** 提交购买任务(真实购买前界面要先确认) */
export async function submitPurchase(): Promise<boolean> {
	const packageIds = readyGames.value.map(game => game.packageId);
	const items = selectedAccounts.value.map(account => ({accountId: account.attemptId, packageIds}));
	if (!items.length || !packageIds.length) {
		return false;
	}
	const concurrency = clampConcurrency(buygame.concurrency);
	buygame.submitting = true;
	try {
		const data = await api.post<{task?: BuyGameTask}>('/api/buygame/tasks', {items, dryRun: buygame.dryRun, concurrency});
		// 推送常常比这个响应先到;响应是提交那一刻的快照,已经有更新的就不用它
		if (data.task && !buygame.tasks.some(task => task.id === data.task!.id)) {
			mergeTask(data.task);
		}
		addLog('success', `已提交买游戏${buygame.dryRun ? '试运行' : ''}任务: ${items.length} 个账号 × ${packageIds.length} 款游戏(${concurrency} 线程)`);
		return true;
	} catch (err) {
		addLog('error', `买游戏任务提交失败: ${errorText(err)}`);
		notify.error('提交失败:' + errorText(err));
		return false;
	} finally {
		buygame.submitting = false;
	}
}

// ===== 推送 =====

function mergeTask(task: BuyGameTask): void {
	if (!task || !task.id) {
		return;
	}
	const index = buygame.tasks.findIndex(item => item.id === task.id);
	if (index >= 0) {
		buygame.tasks[index] = task;
	} else {
		buygame.tasks.unshift(task);
	}
}

let started = false;
let accountRefreshTimer: number | undefined;

export function startBuyGame(): void {
	if (started) {
		return;
	}
	started = true;
	socket.on('buygame:task-created', (task: BuyGameTask) => mergeTask(task));
	socket.on('buygame:task-updated', (task: BuyGameTask) => mergeTask(task));
	socket.on('buygame:task-completed', (task: BuyGameTask) => {
		mergeTask(task);
		const notice = completionNotice(task);
		if (notice) {
			addLog(notice.level, `买游戏${notice.message}`);
			notify[notice.level === 'warn' ? 'warning' : 'success'](notice.message);
		}
		// 扣了款,余额变了
		if (buygame.active) {
			refreshAccounts({silent: true});
		}
	});
	socket.on('attempt:update', () => {
		if (!buygame.active) {
			return;
		}
		window.clearTimeout(accountRefreshTimer);
		accountRefreshTimer = window.setTimeout(() => {
			if (buygame.active && !buygame.loadingAccounts) {
				refreshAccounts({silent: true});
			}
		}, 800);
	});
}

export function enterBuyGame(): void {
	buygame.active = true;
	if (!buygame.loadingAccounts) {
		refreshAccounts({silent: true});
	}
	loadTasks();
}

export function leaveBuyGame(): void {
	buygame.active = false;
}
