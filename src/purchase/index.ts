// CS2 / TF2 游戏内购(GC 商店):商品目录 + 真实下单任务。路由在 ./routes.ts,依赖由 src/main.ts 注入。

import {gameConfig} from '../steam/games.ts';
import {currencyIdToIso} from '../steam/currencies.ts';
import {isAttemptOnline} from '../steam/attempts.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {createCatalogItemBuilder} from './catalog-items.ts';
import type {CatalogItemBuilderOptions} from './catalog-items.ts';
import {createPurchaseCatalog} from './catalog.ts';
import type {CatalogOptions} from './catalog.ts';
import {createStoreGc} from './store-gc.ts';
import type {AttemptEvents} from './store-gc.ts';
import {createPurchaseTasks, normalizeCartData, publicTask} from './tasks.ts';
import type {PurchaseTaskOptions} from './tasks.ts';

export {normalizeCartData, publicTask};

export interface PurchaseServiceOptions {
	/** 会话表(会话管理的 attempts) */
	attempts: Map<string, Attempt>;
	/** 会话管理:写账号日志、推送账号状态、保存会话 */
	events: AttemptEvents & {saveSession(attempt: Attempt): void};
	emitTask: PurchaseTaskOptions['emitTask'];
	/** 物品 schema(CS2/TF2)和 describeGcItem,见 ../items/schema.ts */
	schemas: CatalogItemBuilderOptions['schemas'];
	describeGcItem: CatalogItemBuilderOptions['describeGcItem'];
	cacheDir: string;
	priceSheetDir: string;
	readJson: CatalogOptions['readJson'];
	writeJson: CatalogOptions['writeJson'];
	fetchRates?: CatalogOptions['fetchRates'];
	gcTimeoutMs?: number;
	logger?: Pick<Console, 'log' | 'warn'>;
}

export function createPurchaseService(options: PurchaseServiceOptions) {
	const logger = options.logger ?? console;
	const attempts = () => options.attempts.values();
	const items = createCatalogItemBuilder({schemas: options.schemas, describeGcItem: options.describeGcItem, logger});
	const gc = createStoreGc({items, events: options.events, priceSheetDir: options.priceSheetDir, timeoutMs: options.gcTimeoutMs, logger});
	const catalog = createPurchaseCatalog({
		attempts,
		items,
		gc,
		cacheDir: options.cacheDir,
		priceSheetDir: options.priceSheetDir,
		readJson: options.readJson,
		writeJson: options.writeJson,
		fetchRates: options.fetchRates,
		gcTimeoutMs: options.gcTimeoutMs,
		logger
	});
	const tasks = createPurchaseTasks({attempts, catalog, gc, events: options.events, emitTask: options.emitTask, gcTimeoutMs: options.gcTimeoutMs});

	/** 内购页的账号列表:在线、挂了该游戏 GC 模块的账号,按账号名排序 */
	function listOnlineAccounts(game: unknown) {
		const config = gameConfig(game);
		return Array.from(attempts())
			.filter(attempt => isAttemptOnline(attempt) && !!attempt[config.moduleKey])
			.sort((left, right) => String(left.accountName || '').localeCompare(String(right.accountName || ''), 'zh-CN'))
			.map(attempt => ({
				account: attempt.accountName,
				attemptId: attempt.id,
				status: 'online',
				game: config.id,
				country: attempt.country || attempt.loginGeoCountry || '',
				hasWallet: !!attempt.hasWallet,
				currency: attempt.currency == null ? null : Number(attempt.currency),
				currencyISO: String(attempt.currencyISO || currencyIdToIso(attempt.currency) || 'USD').trim().toUpperCase(),
				balance: attempt.balance == null ? null : Number(attempt.balance),
				gcConnected: !!attempt[config.gcStateKey],
				cs2GcConnected: !!attempt.cs2GcConnected,
				tf2GcConnected: !!attempt.tf2GcConnected,
				inventoryCount: Number(attempt.inventoryCount || 0)
			}));
	}

	return {catalog, tasks, listOnlineAccounts};
}

export type PurchaseService = ReturnType<typeof createPurchaseService>;
