// 买游戏服务(从 app/server.js 移来):解析 subid、多账号购买任务(并发执行,socket.io 推进度)、调试用的单次购买。
// app/server.js 只负责路由;会话查找、cookies、推送由它注入,单元测试用假的。

import {randomBytes} from 'node:crypto';
import {currencyIdToIso} from '../steam/currencies.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {createStoreCheckout} from './checkout.ts';
import type {PackageInfo, PurchaseResult, StoreCheckout} from './checkout.ts';

export {createStoreCheckout, describePurchaseResultDetail} from './checkout.ts';

const TASK_LIMIT = 50;
const DEFAULT_CONCURRENCY = 3;
/** 并发上限,防止被 Steam 限频 */
const MAX_CONCURRENCY = 10;

export function buyGameError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : '';
}

type AccountStatus = 'queued' | 'running' | 'verified' | 'success' | 'failed';

interface TaskAccount {
	attemptId: string;
	account: string;
	status: AccountStatus;
	country: string;
	currency: number | null;
	currencyISO: string;
	packageIds: number[];
	balanceBefore: number | null;
	spentCents: number | null;
	transId: string;
	error: string;
	updatedAt: string;
}

interface BuyGameTask {
	id: string;
	status: 'queued' | 'running' | 'completed' | 'failed';
	dryRun: boolean;
	concurrency: number;
	createdAt: string;
	startedAt: string;
	finishedAt: string;
	totalAccounts: number;
	processedAccounts: number;
	successCount: number;
	failCount: number;
	accounts: TaskAccount[];
	attempts: Attempt[];
}

export type PublicBuyGameTask = Omit<BuyGameTask, 'attempts'>;

export type BuyGameEvent = 'buygame:task-created' | 'buygame:task-updated' | 'buygame:task-completed';

export interface BuyGameServiceOptions {
	/** 按 attemptId 或账号名(不区分大小写)找会话 */
	findAttempt(key: string): Attempt | null;
	cookiesFor(attempt: Attempt): readonly string[];
	emit(event: BuyGameEvent, task: PublicBuyGameTask): void;
	checkout?: StoreCheckout;
	fetch?: typeof fetch;
	now?: () => Date;
	randomId?: () => string;
	logger?: Pick<Console, 'log' | 'error'>;
}

export interface CreateTaskRequest {
	/** [{accountId|account, packageIds:[subid...]}] */
	items?: unknown;
	/** 买游戏默认真扣款,前端可勾选试运行 */
	dryRun?: unknown;
	concurrency?: unknown;
}

export interface ResolveQuery {
	packageId?: unknown;
	subid?: unknown;
	accountId?: unknown;
	account?: unknown;
}

export interface TestPurchaseRequest {
	id?: unknown;
	accountId?: unknown;
	accountName?: unknown;
	packageIds?: unknown;
	packageId?: unknown;
	dryRun?: unknown;
}

function publicTask(task: BuyGameTask): PublicBuyGameTask {
	return {
		id: task.id,
		status: task.status,
		dryRun: !!task.dryRun,
		concurrency: Number(task.concurrency || DEFAULT_CONCURRENCY),
		createdAt: task.createdAt,
		startedAt: task.startedAt,
		finishedAt: task.finishedAt,
		totalAccounts: Number(task.totalAccounts || 0),
		processedAccounts: Number(task.processedAccounts || 0),
		successCount: Number(task.successCount || 0),
		failCount: Number(task.failCount || 0),
		accounts: task.accounts.map(account => ({
			account: account.account,
			attemptId: account.attemptId,
			status: account.status,
			country: account.country,
			currency: account.currency == null ? null : Number(account.currency),
			currencyISO: account.currencyISO,
			packageIds: account.packageIds.slice(),
			balanceBefore: account.balanceBefore,
			spentCents: account.spentCents == null ? null : Number(account.spentCents),
			transId: account.transId || '',
			error: account.error || '',
			updatedAt: account.updatedAt || ''
		}))
	};
}

function clampConcurrency(value: unknown): number {
	return Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(Number(value)) || DEFAULT_CONCURRENCY));
}

export function createBuyGameService(options: BuyGameServiceOptions) {
	const logger = options.logger ?? console;
	const checkout = options.checkout ?? createStoreCheckout({fetch: options.fetch, log: (level, message) => logger.log(`[steam-purchase:${level}] ${message}`)});
	const now = options.now ?? (() => new Date());
	const randomId = options.randomId ?? (() => Date.now().toString(36) + '-' + randomBytes(3).toString('hex'));
	const tasks: BuyGameTask[] = [];
	const stamp = () => now().toISOString();

	function findAttempt(key: unknown): Attempt | null {
		const text = String(key || '').trim();
		return text ? options.findAttempt(text) : null;
	}

	function emit(task: BuyGameTask, event: BuyGameEvent = 'buygame:task-updated'): void {
		options.emit(event, publicTask(task));
	}

	/** 解析一个 subid:游戏名、价格,给前端确认购买内容。按账号的国家取区域价,没指定账号用 US */
	async function resolvePackage(query: ResolveQuery): Promise<PackageInfo> {
		const packageId = Number(query.packageId || query.subid);
		if (!Number.isInteger(packageId) || packageId <= 0) {
			throw buyGameError(400, 'packageId 无效');
		}
		const attempt = findAttempt(query.accountId || query.account);
		const country = (attempt && (attempt.country || attempt.loginGeoCountry)) || 'US';
		try {
			return await checkout.resolvePackage(packageId, country, attempt ? {cookies: options.cookiesFor(attempt), userAgent: attempt.userAgent} : {});
		} catch (err) {
			throw buyGameError(502, errorText(err) || '解析失败');
		}
	}

	function listTasks(): PublicBuyGameTask[] {
		return tasks.map(publicTask);
	}

	/** 建任务并在后台执行;没有有效购买项(账号找不到或 subid 都无效)报 400 */
	function createTask(body: CreateTaskRequest): PublicBuyGameTask {
		const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
		const items: Array<{attempt: Attempt; packageIds: number[]}> = [];
		for (const raw of rawItems) {
			const attempt = findAttempt(raw && (raw.accountId || raw.account));
			if (!attempt) {
				continue;
			}
			const packageIds = (Array.isArray(raw.packageIds) ? raw.packageIds : [])
				.map((id: unknown) => Number(id))
				.filter((id: number) => Number.isInteger(id) && id > 0);
			if (packageIds.length) {
				items.push({attempt, packageIds: Array.from(new Set<number>(packageIds))});
			}
		}
		if (!items.length) {
			throw buyGameError(400, '没有有效的购买项(账号未在线或 subid 无效)');
		}

		const createdAt = stamp();
		const task: BuyGameTask = {
			id: randomId(),
			status: 'queued',
			dryRun: body.dryRun === true,
			concurrency: clampConcurrency(body.concurrency),
			createdAt,
			startedAt: '',
			finishedAt: '',
			totalAccounts: items.length,
			processedAccounts: 0,
			successCount: 0,
			failCount: 0,
			accounts: items.map(({attempt, packageIds}) => ({
				attemptId: attempt.id,
				account: attempt.accountName,
				status: 'queued',
				country: attempt.country || attempt.loginGeoCountry || '',
				currency: attempt.currency == null ? null : Number(attempt.currency),
				currencyISO: String(attempt.currencyISO || currencyIdToIso(attempt.currency) || 'USD').toUpperCase(),
				packageIds: packageIds.slice(),
				balanceBefore: attempt.balance == null ? null : Number(attempt.balance),
				spentCents: null,
				transId: '',
				error: '',
				updatedAt: createdAt
			})),
			attempts: items.map(item => item.attempt)
		};
		tasks.unshift(task);
		if (tasks.length > TASK_LIMIT) {
			tasks.pop();
		}
		emit(task, 'buygame:task-created');
		setTimeout(() => {
			run(task).catch(err => {
				task.status = 'failed';
				task.finishedAt = stamp();
				emit(task, 'buygame:task-completed');
				logger.error('[buygame] task failed:', errorText(err));
			});
		}, 0);
		return publicTask(task);
	}

	async function run(task: BuyGameTask): Promise<void> {
		if (task.status !== 'queued') {
			return;
		}
		task.status = 'running';
		task.startedAt = stamp();
		emit(task);

		const processAccount = async (index: number): Promise<void> => {
			const account = task.accounts[index] as TaskAccount;
			const attempt = task.attempts[index] as Attempt;
			account.status = 'running';
			account.updatedAt = stamp();
			emit(task);
			try {
				const cookies = options.cookiesFor(attempt);
				if (!cookies.length) {
					throw new Error('账号缺少 WebSession cookies,请重新登录');
				}
				const result = await checkout.purchasePackages({
					cookies,
					sessionid: attempt.webSessionID,
					userAgent: attempt.userAgent,
					country: attempt.country || attempt.loginGeoCountry || 'US',
					currency: attempt.currency,
					packageIds: account.packageIds,
					dryRun: task.dryRun
				});
				account.transId = result.transId || '';
				account.spentCents = result.price ? Number(result.price.finalCents) : null;
				account.status = task.dryRun ? 'verified' : 'success';
				if (!task.dryRun) {
					task.successCount++;
				}
			} catch (err) {
				account.status = 'failed';
				account.error = errorText(err) || '购买失败';
				task.failCount++;
			}
			account.updatedAt = stamp();
			task.processedAccounts++;
			emit(task);
		};

		// 开 N 个 worker 从共享游标取账号;cursor++ 和计数都在 await 之间同步完成,没有竞态
		let cursor = 0;
		const worker = async () => {
			while (cursor < task.accounts.length) {
				await processAccount(cursor++);
			}
		};
		await Promise.all(Array.from({length: Math.min(clampConcurrency(task.concurrency), task.accounts.length)}, worker));

		task.status = 'completed';
		task.finishedAt = stamp();
		emit(task, 'buygame:task-completed');
	}

	/** 调试端点:单账号直接购买,默认 dryRun(只验证到最终价、不扣款) */
	async function testPurchase(body: TestPurchaseRequest): Promise<PurchaseResult> {
		const attempt = findAttempt(body.id || body.accountId || body.accountName);
		if (!attempt) {
			throw buyGameError(404, '账号不存在或未登录(用 id 或账号名指定)');
		}
		const cookies = options.cookiesFor(attempt);
		if (!cookies.length) {
			throw buyGameError(409, '当前账号没有可用的 WebSession cookies,请重新登录');
		}
		const packageIds = Array.isArray(body.packageIds) ? body.packageIds : (body.packageId != null ? [body.packageId] : []);
		try {
			return await checkout.purchasePackages({
				cookies,
				sessionid: attempt.webSessionID,
				userAgent: attempt.userAgent,
				country: attempt.country || attempt.loginGeoCountry || 'CN',
				currency: attempt.currency,
				packageIds,
				dryRun: body.dryRun !== false
			});
		} catch (err) {
			throw buyGameError(500, errorText(err) || '购买失败');
		}
	}

	return {resolvePackage, listTasks, createTask, testPurchase};
}

export type BuyGameService = ReturnType<typeof createBuyGameService>;
