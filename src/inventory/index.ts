// 库存(从 app/server.js 移来):库存页和终端机开箱页用。以社区库存为准(网页登录拿到的 cookie 拉),
// CS2 GC 补上准确的交易冷却和磨损/模板,社区拉失败时用 GC 库存兜底。
// 库存页(connectGc)会先让账号进 CS2、等 GC 连上再拉,连不上就报错,不拿缺 GC 数据的库存凑数。
//
// 缓存规则:
//   - 社区来源的快照 15 秒内直接返回;
//   - 连 GC 时会先建一份 GC 来源的快照(本地 schema,较新饰品的名字/映射不准),它不短路,照样去拉社区库存;
//   - 社区刚拉失败的 30 秒冷却期内才用 GC 快照,免得每次开库存都重试;
//   - 同一账号同时只发一次社区请求,其余调用方等同一个 Promise(库存页和终端机同时打开时不会一个拿到旧快照)。

import type {Attempt} from '../steam/session-manager.ts';
import {ensureGameSession, waitForGcConnection} from '../steam/gc-client.ts';
import {fetchCommunityInventory, inventoryError} from './community.ts';
import type {InventoryItem, InventorySnapshot} from './community.ts';
import {buildGcInventoryItemMap, buildGcInventorySnapshot, getGcInventoryItems} from './gc.ts';
import type {DescribeGcItem} from './gc.ts';

export {serializeForJson} from '../core/serialize.ts';
export type {DescribeGcItem, InventoryItem, InventorySnapshot};

const CACHE_TTL_MS = 15 * 1000;
const COMMUNITY_RETRY_COOLDOWN_MS = 30 * 1000;
const GC_CONNECT_TIMEOUT_MS = 20 * 1000;

export interface PublicInventory {
	source: InventorySnapshot['source'];
	fetchedAt: string;
	itemCount: number;
	items: InventoryItem[];
	raw: unknown;
}

export function publicInventorySnapshot(snapshot: InventorySnapshot): PublicInventory {
	return {
		source: snapshot.source,
		fetchedAt: snapshot.fetchedAt,
		itemCount: Number(snapshot.itemCount || 0),
		items: Array.isArray(snapshot.items) ? snapshot.items : [],
		raw: snapshot.raw || null
	};
}

export interface InventoryServiceOptions {
	/** 本地物品 schema 描述 GC 物品(../items/schema.ts 的 describeGcItem,已绑定 CS2 schema) */
	describeGcItem: DescribeGcItem;
	cookiesFor(attempt: Attempt): readonly string[];
	/** 会话变了(库存数量/来源、GC 连接)推给前端 */
	emit(attempt: Attempt): void;
	/** 写会话日志(库存页替账号连 GC 时记一笔) */
	addLog?(attempt: Attempt, level: string, message: string): void;
	/** 等 CS2 GC 连上的超时,默认 20 秒 */
	gcTimeoutMs?: number;
	fetch?: typeof fetch;
	now?: () => number;
}

interface InventoryState {
	inventoryCache?: InventorySnapshot | null;
	inventoryInflight?: Promise<PublicInventory> | null;
	communityInvTriedAt?: number;
	inventoryGcConnecting?: Promise<void> | null;
}

export function createInventoryService(options: InventoryServiceOptions) {
	const now = options.now ?? Date.now;
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const gcTimeoutMs = options.gcTimeoutMs ?? GC_CONNECT_TIMEOUT_MS;
	const state = (attempt: Attempt) => attempt as Attempt & InventoryState;

	function gcSnapshot(attempt: Attempt): InventorySnapshot {
		return buildGcInventorySnapshot(attempt.csgo as {inventory?: unknown}, options.describeGcItem, now());
	}

	function countGcItems(attempt: Attempt): number {
		return getGcInventoryItems(attempt.csgo as {inventory?: unknown}).length;
	}

	/** GC 库存变了(连上、获得/改动/移除物品):更新数量,缓存还是 GC 来源的就重建 */
	function refreshFromGc(attempt: Attempt): void {
		const s = state(attempt);
		attempt.inventoryCount = countGcItems(attempt);
		if (!s.inventoryCache || s.inventoryCache.source === 'gc') {
			s.inventoryCache = gcSnapshot(attempt);
			attempt.inventorySource = 'gc';
		}
	}

	function isFresh(cache: InventorySnapshot | null | undefined): cache is InventorySnapshot {
		return !!(cache && cache.fetchedAtMs && now() - cache.fetchedAtMs < CACHE_TTL_MS);
	}

	async function startCs2Gc(attempt: Attempt): Promise<void> {
		if (!attempt.client || !ensureGameSession(attempt, 'cs2')) {
			throw inventoryError(409, '当前账号尚未登录 Steam');
		}
		options.addLog?.(attempt, 'info', '库存:正在连接 CS2 GC');
		options.emit(attempt);
		try {
			await waitForGcConnection(attempt, 'cs2', gcTimeoutMs);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw inventoryError(409, `CS2 GC 没连上(${reason}),交易冷却和磨损要靠 GC,请稍后再刷新库存`);
		}
	}

	/** 让账号进 CS2 并等 GC 连上,同一账号同时只连一次。返回这次是不是新连上的 */
	async function connectCs2Gc(attempt: Attempt): Promise<boolean> {
		if (attempt.cs2GcConnected) {
			return false;
		}
		const s = state(attempt);
		if (!s.inventoryGcConnecting) {
			s.inventoryGcConnecting = startCs2Gc(attempt).finally(() => {
				s.inventoryGcConnecting = null;
			});
		}
		await s.inventoryGcConnecting;
		return true;
	}

	/** connectGc:库存页用,先连上 CS2 GC 再拉;刚连上时,之前没带 GC 数据的缓存不算数 */
	async function get(attempt: Attempt, opts: {forceRefresh?: boolean; connectGc?: boolean} = {}): Promise<PublicInventory> {
		const s = state(attempt);
		const justConnected = opts.connectGc ? await connectCs2Gc(attempt) : false;
		const forceRefresh = opts.forceRefresh || justConnected;
		const cache = s.inventoryCache;
		const cooling = !!s.communityInvTriedAt && now() - s.communityInvTriedAt < COMMUNITY_RETRY_COOLDOWN_MS;
		if (!forceRefresh && isFresh(cache) && (cache.source === 'community' || cooling)) {
			return publicInventorySnapshot(cache);
		}
		if (s.inventoryInflight) {
			return s.inventoryInflight;
		}

		const run = (async () => {
			try {
				const snapshot = await fetchCommunityInventory({
					steamID: attempt.steamID,
					cookies: options.cookiesFor(attempt),
					userAgent: attempt.userAgent,
					gcItemsByAssetId: buildGcInventoryItemMap(attempt.csgo as {inventory?: unknown})
				}, http, now);
				s.inventoryCache = snapshot;
				attempt.inventoryCount = snapshot.itemCount;
				attempt.inventorySource = snapshot.source;
				s.communityInvTriedAt = 0;   // 成功:清掉失败冷却
				options.emit(attempt);
				return publicInventorySnapshot(snapshot);
			} catch (communityError) {
				// 失败才开始冷却;GC 里有东西就先用它兜底
				s.communityInvTriedAt = now();
				const fallback = gcSnapshot(attempt);
				if (fallback.itemCount > 0) {
					s.inventoryCache = fallback;
					attempt.inventoryCount = fallback.itemCount;
					attempt.inventorySource = fallback.source;
					options.emit(attempt);
					return publicInventorySnapshot(fallback);
				}
				throw communityError;
			}
		})();
		s.inventoryInflight = run;
		try {
			return await run;
		} finally {
			if (s.inventoryInflight === run) {
				s.inventoryInflight = null;
			}
		}
	}

	return {get, gcSnapshot, countGcItems, refreshFromGc};
}

export type InventoryService = ReturnType<typeof createInventoryService>;
