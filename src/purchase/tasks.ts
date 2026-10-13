// 内购任务(从 app/server.js 移来):前端提交「账号 → 购物车」,逐个账号进游戏、连 GC、按最新价目表重算价格、
// 按余额裁剪数量后真实下单。任务只在内存里(最近 60 个),进度通过 purchase:task-* 事件推给前端。

import {randomBytes} from 'node:crypto';
import {ensureGameSession, waitForGcConnection} from '../steam/gc-client.ts';
import {gameConfig, normalizeGame} from '../steam/games.ts';
import type {GameId} from '../steam/games.ts';
import {currencyIdToIso} from '../steam/currencies.ts';
import {findOnlineAttempt, isAttemptReadyForGc} from '../steam/attempts.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {findCatalogItem, itemPrice} from './catalog-items.ts';
import type {PurchaseCatalog} from './catalog.ts';
import {PURCHASE_GC_TIMEOUT_MS} from './store-gc.ts';
import type {AttemptEvents, StoreData, StoreGc} from './store-gc.ts';

// 单个商品的数量上限:真正的约束是余额,这里只防异常值
export const PURCHASE_MAX_ITEM_QUANTITY = 9999;
const TASK_LIMIT = 60;
const TASK_LOG_LIMIT = 400;
const ACCOUNT_LOG_LIMIT = 120;

export interface CartItem {
	itemDefId: number;
	costInLocalCurrency: number;
	quantity: number;
}

/** 账号名 → 购物车 */
export type CartData = Record<string, CartItem[]>;

export type TaskStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';
export type AccountStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TaskLog {
	level: string;
	time: string;
	account: string;
	message: string;
}

export interface TaskItem {
	itemDefId: number;
	name: string;
	type: string;
	quantity: number;
	unitPriceCents: number;
	totalPriceCents: number;
}

export interface TaskAccount {
	account: string;
	game: GameId;
	attemptId: string;
	status: AccountStatus;
	country: string;
	currencyISO: string;
	balanceBefore: number | null;
	balanceAfter: number | null;
	totalCostCents: number;
	totalUnits: number;
	items: TaskItem[];
	error: string;
	logs: TaskLog[];
	updatedAt: string;
}

export interface PurchaseTask {
	id: string;
	type: string;
	game: GameId;
	gameLabel: string;
	status: TaskStatus;
	createdAt: string;
	startedAt: string;
	finishedAt: string;
	totalAccounts: number;
	processedAccounts: number;
	successCount: number;
	failCount: number;
	totalLineItems: number;
	totalUnits: number;
	accounts: TaskAccount[];
	cartData: CartData;
	logs: TaskLog[];
	summary: {
		totalAccounts: number;
		processedAccounts: number;
		successCount: number;
		failCount: number;
		totalLineItems: number;
		totalUnits: number;
	} | null;
}

export type TaskEvent = 'purchase:task-created' | 'purchase:task-updated' | 'purchase:task-completed';

/** 校验前端提交的购物车;空账号、空购物车跳过,商品编号非法直接报错 */
export function normalizeCartData(cartData: unknown): CartData {
	if (!cartData || typeof cartData !== 'object') {
		throw new Error('cartData 不能为空');
	}
	const normalized: CartData = {};
	for (const [rawAccount, rawItems] of Object.entries(cartData)) {
		const account = String(rawAccount || '').trim();
		if (!account || !Array.isArray(rawItems) || !rawItems.length) {
			continue;
		}
		const items: CartItem[] = [];
		for (const rawItem of rawItems as Array<Record<string, unknown> | null>) {
			const itemDefId = Number(rawItem?.itemDefId);
			const quantity = Math.max(1, Math.min(PURCHASE_MAX_ITEM_QUANTITY, Number(rawItem?.quantity || 1)));
			const costInLocalCurrency = Math.max(0, Math.round(Number(rawItem?.costInLocalCurrency || 0)));
			if (!Number.isFinite(itemDefId) || itemDefId <= 0) {
				throw new Error(`账号 ${account} 存在无效商品编号`);
			}
			if (!Number.isFinite(quantity) || quantity <= 0) {
				throw new Error(`账号 ${account} 的购买数量无效`);
			}
			items.push({itemDefId, costInLocalCurrency, quantity});
		}
		if (items.length) {
			normalized[account] = items;
		}
	}
	if (!Object.keys(normalized).length) {
		throw new Error('购物车为空');
	}
	return normalized;
}

/** 按余额(balanceBefore,元)从前往后裁剪数量:买不起的商品去掉,买得起几件就留几件 */
export function clampItemsToBalance(account: TaskAccount): void {
	const balance = account.balanceBefore;
	if (balance == null || !Number.isFinite(Number(balance))) {
		return;
	}
	let remainingCents = Math.max(0, Math.round(Number(balance) * 100));
	const kept: TaskItem[] = [];
	for (const item of account.items) {
		if (!item) {
			continue;
		}
		const unitPriceCents = Math.max(0, Number(item.unitPriceCents || 0));
		let quantity = Math.max(0, Math.min(PURCHASE_MAX_ITEM_QUANTITY, Number(item.quantity || 0)));
		if (quantity <= 0) {
			continue;
		}
		if (unitPriceCents > 0) {
			const affordable = Math.max(0, Math.min(PURCHASE_MAX_ITEM_QUANTITY, Math.floor(remainingCents / unitPriceCents)));
			if (affordable <= 0) {
				continue;
			}
			quantity = Math.min(quantity, affordable);
			remainingCents -= quantity * unitPriceCents;
		}
		kept.push({...item, quantity, totalPriceCents: unitPriceCents * quantity});
	}
	account.items = kept;
	account.totalUnits = kept.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
	account.totalCostCents = kept.reduce((sum, item) => sum + Number(item.totalPriceCents || 0), 0);
}

export function formatMoney(cents: number, currencyISO: string): string {
	return `${String(currencyISO || 'USD').trim().toUpperCase()} ${(Number(cents || 0) / 100).toFixed(2)}`;
}

/** 推给前端的任务(拷贝,不含购物车原始数据) */
export function publicTask(task: PurchaseTask) {
	return {
		id: task.id,
		type: task.type,
		game: normalizeGame(task.game),
		gameLabel: task.gameLabel || gameConfig(task.game).label,
		status: task.status,
		createdAt: task.createdAt,
		startedAt: task.startedAt,
		finishedAt: task.finishedAt,
		totalAccounts: Number(task.totalAccounts || 0),
		processedAccounts: Number(task.processedAccounts || 0),
		successCount: Number(task.successCount || 0),
		failCount: Number(task.failCount || 0),
		totalLineItems: Number(task.totalLineItems || 0),
		totalUnits: Number(task.totalUnits || 0),
		accounts: task.accounts.map(account => ({
			account: account.account,
			game: normalizeGame(account.game || task.game),
			attemptId: account.attemptId,
			status: account.status,
			country: account.country,
			currencyISO: account.currencyISO,
			balanceBefore: account.balanceBefore,
			balanceAfter: account.balanceAfter,
			totalCostCents: Number(account.totalCostCents || 0),
			totalUnits: Number(account.totalUnits || 0),
			items: account.items.map(item => ({
				itemDefId: Number(item.itemDefId || 0),
				name: item.name,
				type: item.type,
				quantity: Number(item.quantity || 0),
				unitPriceCents: Number(item.unitPriceCents || 0),
				totalPriceCents: Number(item.totalPriceCents || 0)
			})),
			error: account.error || '',
			logs: account.logs.slice(),
			updatedAt: account.updatedAt || ''
		})),
		logs: task.logs.slice(),
		summary: task.summary || null
	};
}

export type PublicTask = ReturnType<typeof publicTask>;

export interface PurchaseTaskOptions {
	attempts(): Iterable<Attempt>;
	catalog: Pick<PurchaseCatalog, 'findItem' | 'adoptStoreData'>;
	gc: Pick<StoreGc, 'queryUserData' | 'purchase'>;
	events: AttemptEvents & {saveSession(attempt: Attempt): void};
	/** 推送任务事件(socket.io) */
	emitTask(event: TaskEvent, task: PublicTask): void;
	gcTimeoutMs?: number;
}

function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error && err.message ? err.message : fallback;
}

export function createPurchaseTasks(options: PurchaseTaskOptions) {
	const gcTimeoutMs = options.gcTimeoutMs ?? PURCHASE_GC_TIMEOUT_MS;
	const tasks: PurchaseTask[] = [];

	function emit(task: PurchaseTask, event: TaskEvent = 'purchase:task-updated'): void {
		options.emitTask(event, publicTask(task));
	}

	function log(task: PurchaseTask, level: string, message: string, accountName = ''): void {
		const entry: TaskLog = {level, time: new Date().toLocaleTimeString('zh-CN', {hour12: false}), account: accountName, message};
		task.logs.push(entry);
		if (task.logs.length > TASK_LOG_LIMIT) {
			task.logs.shift();
		}
		const account = accountName ? task.accounts.find(item => item.account === accountName) : null;
		if (!account) {
			return;
		}
		account.logs.push(entry);
		if (account.logs.length > ACCOUNT_LOG_LIMIT) {
			account.logs.shift();
		}
		account.updatedAt = new Date().toISOString();
	}

	function updateSummary(task: PurchaseTask): void {
		task.successCount = task.accounts.filter(account => account.status === 'completed').length;
		task.failCount = task.accounts.filter(account => account.status === 'failed').length;
		task.processedAccounts = task.successCount + task.failCount;
		task.summary = {
			totalAccounts: task.totalAccounts,
			processedAccounts: task.processedAccounts,
			successCount: task.successCount,
			failCount: task.failCount,
			totalLineItems: task.totalLineItems,
			totalUnits: task.totalUnits
		};
	}

	/** 建任务时先按当前目录价和账号币种估一遍价格(真正下单前会按最新价目表重算) */
	function buildAccount(game: GameId, accountName: string, items: CartItem[], createdAt: string): TaskAccount {
		const attempt = findOnlineAttempt(options.attempts(), accountName);
		const currencyISO = String(attempt?.currencyISO || currencyIdToIso(attempt?.currency) || 'USD').trim().toUpperCase();
		const accountItems = items.map(item => {
			const catalogItem = options.catalog.findItem(item.itemDefId, game);
			const resolved = itemPrice(catalogItem, currencyISO);
			const unitPriceCents = resolved > 0 ? resolved : Number(item.costInLocalCurrency || 0);
			return {
				itemDefId: Number(item.itemDefId),
				name: catalogItem ? catalogItem.name : `DefIndex ${item.itemDefId}`,
				type: catalogItem ? catalogItem.type : '工具',
				quantity: Number(item.quantity || 0),
				unitPriceCents: Number(unitPriceCents || 0),
				totalPriceCents: Number(unitPriceCents || 0) * Number(item.quantity || 0)
			};
		});
		return {
			account: accountName,
			game,
			attemptId: attempt ? attempt.id : '',
			status: 'queued',
			country: attempt ? (attempt.country || attempt.loginGeoCountry || '') : '',
			currencyISO,
			balanceBefore: attempt && attempt.balance != null ? Number(attempt.balance) : null,
			balanceAfter: null,
			totalCostCents: accountItems.reduce((sum, item) => sum + item.totalPriceCents, 0),
			totalUnits: accountItems.reduce((sum, item) => sum + item.quantity, 0),
			items: accountItems,
			error: '',
			logs: [],
			updatedAt: createdAt
		};
	}

	function create(gameInput: unknown, cartData: CartData): PurchaseTask {
		const game = normalizeGame(gameInput);
		const config = gameConfig(game);
		const createdAt = new Date().toISOString();
		const accounts = Object.keys(cartData).map(accountName => buildAccount(game, accountName, cartData[accountName] ?? [], createdAt));
		const task: PurchaseTask = {
			id: Date.now().toString(36) + '-' + randomBytes(3).toString('hex'),
			type: config.taskType,
			game,
			gameLabel: config.label,
			status: 'queued',
			createdAt,
			startedAt: '',
			finishedAt: '',
			totalAccounts: accounts.length,
			processedAccounts: 0,
			successCount: 0,
			failCount: 0,
			totalLineItems: accounts.reduce((sum, account) => sum + account.items.length, 0),
			totalUnits: accounts.reduce((sum, account) => sum + account.totalUnits, 0),
			accounts,
			cartData,
			logs: [],
			summary: null
		};
		log(task, 'info', `已创建 ${config.label} 内购任务，共 ${task.totalAccounts} 个账号`);
		tasks.unshift(task);
		if (tasks.length > TASK_LIMIT) {
			tasks.pop();
		}
		emit(task, 'purchase:task-created');
		return task;
	}

	function fail(task: PurchaseTask, account: TaskAccount, error: string): void {
		account.status = 'failed';
		account.error = error;
		log(task, 'error', error, account.account);
	}

	async function runAccount(task: PurchaseTask, account: TaskAccount): Promise<void> {
		const game = normalizeGame(account.game || task.game);
		const config = gameConfig(game);
		account.status = 'running';
		account.error = '';
		account.updatedAt = new Date().toISOString();
		log(task, 'info', '开始处理账号购物车', account.account);

		const attempt = findOnlineAttempt(options.attempts(), account.account);
		if (!attempt) {
			return fail(task, account, '账号当前不在线，无法执行内购');
		}
		account.attemptId = attempt.id;
		account.game = game;
		account.country = attempt.country || attempt.loginGeoCountry || account.country || '';
		account.currencyISO = String(attempt.currencyISO || currencyIdToIso(attempt.currency) || account.currencyISO || 'USD').trim().toUpperCase();
		account.balanceBefore = attempt.balance == null ? null : Number(attempt.balance);

		try {
			ensureGameSession(attempt, game);
		} catch (err) {
			return fail(task, account, `切换到 ${config.label} 失败: ${errorMessage(err, '未知错误')}`);
		}
		if (!attempt[config.gcStateKey]) {
			try {
				await waitForGcConnection(attempt, game, gcTimeoutMs);
			} catch (err) {
				return fail(task, account, errorMessage(err, `等待 ${config.label} GC 连接失败`));
			}
		}
		if (!isAttemptReadyForGc(attempt, game)) {
			return fail(task, account, `当前账号未建立可用的 ${config.label} GC 会话`);
		}
		if (!attempt.hasWallet || attempt.balance == null || !Number.isFinite(Number(attempt.balance))) {
			return fail(task, account, '当前账号没有可用钱包余额');
		}

		let storeData: StoreData;
		try {
			storeData = await options.gc.queryUserData(attempt, game);
		} catch (err) {
			return fail(task, account, '查询 GC 商品目录失败: ' + errorMessage(err, '未知错误'));
		}
		options.catalog.adoptStoreData(game, attempt, storeData);

		account.currencyISO = String(storeData.currencyISO || account.currencyISO || 'USD').trim().toUpperCase();
		account.country = String(storeData.country || account.country || '').trim().toUpperCase();
		if (storeData.balance != null && Number.isFinite(Number(storeData.balance))) {
			account.balanceBefore = Number(storeData.balance);
		}

		// 按账号自己查到的价目表重算单价
		for (const item of account.items) {
			const catalogItem = findCatalogItem(storeData.list, item.itemDefId);
			if (!catalogItem) {
				return fail(task, account, `商品 ${item.itemDefId} 不存在于当前目录`);
			}
			const unitPrice = itemPrice(catalogItem, account.currencyISO);
			if (unitPrice <= 0) {
				return fail(task, account, `商品 ${catalogItem.name} 缺少 ${account.currencyISO} 价格`);
			}
			if (item.unitPriceCents > 0 && item.unitPriceCents !== unitPrice) {
				log(task, 'warn', `检测到价格变化，已按最新 ${account.currencyISO} 价格重算 ${catalogItem.name}`, account.account);
			}
			item.name = catalogItem.name;
			item.type = catalogItem.type;
			item.unitPriceCents = unitPrice;
			item.totalPriceCents = unitPrice * Number(item.quantity || 0);
		}
		account.totalCostCents = account.items.reduce((sum, item) => sum + item.totalPriceCents, 0);

		clampItemsToBalance(account);
		const totalCostCents = Number(account.totalCostCents || 0);
		if (!account.items.length || Number(account.totalUnits || 0) <= 0) {
			return fail(task, account, '当前购物车在余额约束下没有可购买数量');
		}
		const balance = account.balanceBefore == null ? attempt.balance : account.balanceBefore;
		if (Math.round(Number(balance) * 100) < totalCostCents) {
			return fail(task, account, `余额不足，当前 ${Number(balance).toFixed(2)} ${account.currencyISO}`);
		}

		let result;
		try {
			result = await options.gc.purchase(attempt, game, account, storeData);
		} catch (err) {
			fail(task, account, errorMessage(err, 'GC 下单失败'));
			options.events.addLog(attempt, 'error', `${config.label} 内购失败: ${account.error}`);
			options.events.emit(attempt);
			return;
		}

		if (result.balanceAfter != null && Number.isFinite(Number(result.balanceAfter))) {
			attempt.balance = Number(result.balanceAfter);
			account.balanceAfter = Number(result.balanceAfter);
		} else if (attempt.balance != null && Number.isFinite(Number(attempt.balance))) {
			account.balanceAfter = Number(attempt.balance);
		}
		account.status = 'completed';
		account.updatedAt = new Date().toISOString();
		options.events.addLog(attempt, 'success', `${config.label} GC 内购成功 ${formatMoney(totalCostCents, account.currencyISO)}，共 ${account.totalUnits} 件商品`);
		options.events.saveSession(attempt);
		options.events.emit(attempt);
		log(task, 'success', `GC 下单成功，交易 ${result.txnId}，新增 ${result.itemIds.length} 个 item_id`, account.account);
	}

	async function run(task: PurchaseTask): Promise<void> {
		if (task.status !== 'queued') {
			return;
		}
		task.status = 'running';
		task.startedAt = new Date().toISOString();
		log(task, 'info', `开始执行 ${task.gameLabel || gameConfig(task.game).label} 内购任务`);
		emit(task);

		// 逐个账号串行执行
		for (const account of task.accounts) {
			await runAccount(task, account);
			updateSummary(task);
			emit(task);
		}

		task.finishedAt = new Date().toISOString();
		if (task.successCount === task.totalAccounts) {
			task.status = 'completed';
			log(task, 'success', `任务完成，${task.successCount}/${task.totalAccounts} 个账号执行成功`);
		} else if (task.successCount > 0) {
			task.status = 'partial';
			log(task, 'warn', `任务部分完成，成功 ${task.successCount}，失败 ${task.failCount}`);
		} else {
			task.status = 'failed';
			log(task, 'error', `任务失败，${task.failCount}/${task.totalAccounts} 个账号执行失败`);
		}
		updateSummary(task);
		emit(task);
		emit(task, 'purchase:task-completed');
	}

	/** 异步开始执行(下一个事件循环),执行出错整个任务记为失败 */
	function start(task: PurchaseTask): Promise<void> {
		return new Promise(resolve => {
			setTimeout(() => {
				run(task).catch(err => {
					task.status = 'failed';
					task.finishedAt = new Date().toISOString();
					log(task, 'error', errorMessage(err, '内购任务执行失败'));
					updateSummary(task);
					emit(task);
					emit(task, 'purchase:task-completed');
				}).finally(resolve);
			}, 0);
		});
	}

	/** 按创建时间倒序 */
	function list(): PublicTask[] {
		return tasks.slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).map(publicTask);
	}

	function get(id: string): PurchaseTask | null {
		return tasks.find(task => task.id === id) ?? null;
	}

	return {create, start, list, get};
}

export type PurchaseTasks = ReturnType<typeof createPurchaseTasks>;
