// 内购商品目录的状态(从 app/server.js 移来):每款游戏一份,内存 + 磁盘缓存(data/purchase-catalogs/<game>.json)。
// CS2 目录用在线账号向 GC 拉价目表生成;TF2 只卖钥匙,用静态目录(价目表留样里的 249 价位覆盖兜底价)。
// 汇率(折算美元比价用)缓存 6 小时,刷新后同步写进各游戏目录。

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {ensureGameSession, waitForGcConnection} from '../steam/gc-client.ts';
import {gameConfig, GAME_CONFIGS, normalizeGame} from '../steam/games.ts';
import type {GameId} from '../steam/games.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {pickGcReadyAttempt, pickOnlineAttemptWithGc} from '../steam/attempts.ts';
import {normalizePriceMap} from '../steam/price-sheet.ts';
import type {PriceMap} from '../steam/price-sheet.ts';
import {compareCatalogItems, findCatalogItem, TF2_KEY_DEF_INDEX, TF2_KEY_FALLBACK_PRICES, TF2_KEY_PRICE_TIER} from './catalog-items.ts';
import type {CatalogItem, CatalogItemBuilder} from './catalog-items.ts';
import {fetchUsdExchangeRates, isFreshRateState} from './rates.ts';
import type {RateMap, RateState} from './rates.ts';
import {PURCHASE_GC_TIMEOUT_MS, UY_WALLET_CURRENCY} from './store-gc.ts';
import type {StoreData, StoreGc} from './store-gc.ts';

const require = createRequire(import.meta.url);
const BinaryKvParser = require('binarykvparser') as {parse(input: Buffer): unknown};

export interface CatalogState {
	game: GameId;
	gameLabel: string;
	fetchedAt: string;
	account: string;
	attemptId: string;
	currency: number | null;
	currencyISO: string;
	country: string;
	priceSheetVersion: number;
	source: string;
	storeData: StoreData | null;
	rates: RateMap;
	ratesFetchedAt: string;
	ratesSource: string;
	list: CatalogItem[];
	/** 这次刷新相对上次新出现的商品 */
	newIds: number[];
	changed?: boolean;
	cachedAt?: string;
	/** 没有缓存也没拉过:前端提示手动刷新 */
	needsRefresh?: boolean;
}

export interface CatalogOptions {
	/** 当前全部 Steam 会话 */
	attempts(): Iterable<Attempt>;
	items: CatalogItemBuilder;
	gc: Pick<StoreGc, 'queryUserData'>;
	/** 目录缓存目录 */
	cacheDir: string;
	/** 价目表留样目录(TF2 钥匙价从这里读) */
	priceSheetDir: string;
	readJson(file: string): unknown;
	writeJson(file: string, value: unknown): void;
	fetchRates?: () => Promise<RateState>;
	gcTimeoutMs?: number;
	logger?: Pick<Console, 'warn'>;
}

const GAMES = Object.keys(GAME_CONFIGS) as GameId[];

function catalogError(message: string, statusCode: number): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function sortedList(storeData: StoreData | null | undefined): CatalogItem[] {
	return Array.isArray(storeData?.list) ? storeData.list.slice().sort(compareCatalogItems) : [];
}

// 原始价目表和解析树只在内存里用;写进缓存会让 cs2.json 膨胀到几 MB
function persistableStoreData(storeData: StoreData | null): Omit<StoreData, 'rawPriceSheet' | 'parsedPriceSheet'> | null {
	if (!storeData) {
		return null;
	}
	const {rawPriceSheet: _raw, parsedPriceSheet: _parsed, ...rest} = storeData;
	return rest;
}

export function createPurchaseCatalog(options: CatalogOptions) {
	const fetchRates = options.fetchRates ?? fetchUsdExchangeRates;
	const gcTimeoutMs = options.gcTimeoutMs ?? PURCHASE_GC_TIMEOUT_MS;
	const logger = options.logger ?? console;
	const states: Record<GameId, CatalogState | null> = {cs2: null, tf2: null};
	let rateState: RateState | null = null;

	function cacheFile(game: GameId): string {
		return join(options.cacheDir, `${game}.json`);
	}

	function loadCache(game: GameId): CatalogState | null {
		const payload = options.readJson(cacheFile(game)) as Record<string, unknown> | null;
		if (!payload || typeof payload !== 'object') {
			return null;
		}
		const list = Array.isArray(payload.list) ? payload.list as CatalogItem[] : [];
		if (!list.length) {
			return null;
		}
		const label = gameConfig(game).label;
		const text = (value: unknown) => String(value || '').trim();
		return {
			game,
			gameLabel: text(payload.gameLabel || label) || label,
			fetchedAt: text(payload.fetchedAt) || new Date().toISOString(),
			account: text(payload.account),
			attemptId: text(payload.attemptId),
			currency: payload.currency == null ? null : Number(payload.currency),
			currencyISO: text(payload.currencyISO).toUpperCase(),
			country: text(payload.country).toUpperCase(),
			priceSheetVersion: Number(payload.priceSheetVersion || 0),
			source: text(payload.source || 'cache') || 'cache',
			storeData: payload.storeData && typeof payload.storeData === 'object' ? payload.storeData as StoreData : null,
			rates: payload.rates && typeof payload.rates === 'object' ? payload.rates as RateMap : {},
			ratesFetchedAt: text(payload.ratesFetchedAt),
			ratesSource: text(payload.ratesSource),
			list,
			newIds: Array.isArray(payload.newIds) ? payload.newIds.map(Number).filter(Number.isFinite) : [],
			changed: false,
			cachedAt: text(payload.cachedAt)
		};
	}

	function saveCache(game: GameId, state: CatalogState | null): void {
		if (!state || !Array.isArray(state.list) || !state.list.length) {
			return;
		}
		try {
			options.writeJson(cacheFile(game), {
				game,
				gameLabel: state.gameLabel || gameConfig(game).label,
				fetchedAt: state.fetchedAt || new Date().toISOString(),
				account: state.account || '',
				attemptId: state.attemptId || '',
				currency: state.currency == null ? null : Number(state.currency),
				currencyISO: state.currencyISO || '',
				country: state.country || '',
				priceSheetVersion: Number(state.priceSheetVersion || 0),
				source: state.source || 'cache',
				storeData: persistableStoreData(state.storeData),
				rates: state.rates && typeof state.rates === 'object' ? state.rates : {},
				ratesFetchedAt: state.ratesFetchedAt || '',
				ratesSource: state.ratesSource || '',
				list: state.list,
				newIds: Array.isArray(state.newIds) ? state.newIds : [],
				cachedAt: new Date().toISOString()
			});
		} catch (err) {
			logger.warn('[purchase] failed to save catalog cache:', err instanceof Error ? err.message : err);
		}
	}

	function rateFields(previous?: CatalogState | null): Pick<CatalogState, 'rates' | 'ratesFetchedAt' | 'ratesSource'> {
		if (previous) {
			return {
				rates: previous.rates && typeof previous.rates === 'object' ? previous.rates : (rateState?.rates ?? {}),
				ratesFetchedAt: previous.ratesFetchedAt || rateState?.fetchedAt || '',
				ratesSource: previous.ratesSource || rateState?.source || ''
			};
		}
		return {rates: rateState?.rates ?? {}, ratesFetchedAt: rateState?.fetchedAt ?? '', ratesSource: rateState?.source ?? ''};
	}

	/** 启动时把磁盘缓存读进内存 */
	function preload(): void {
		for (const game of GAMES) {
			const cached = loadCache(game);
			if (cached) {
				states[game] = cached;
			}
		}
	}

	function emptyState(game: GameId): CatalogState {
		const previous = states[game];
		return {
			game,
			gameLabel: gameConfig(game).label,
			fetchedAt: previous?.fetchedAt || '',
			account: previous?.account || '',
			attemptId: previous?.attemptId || '',
			currency: previous && previous.currency != null ? Number(previous.currency) : null,
			currencyISO: previous?.currencyISO || '',
			country: previous?.country || '',
			priceSheetVersion: previous?.priceSheetVersion ? Number(previous.priceSheetVersion) : 0,
			source: previous?.source || 'cache-miss',
			storeData: previous?.storeData || null,
			...rateFields(previous),
			list: [],
			newIds: [],
			changed: false,
			needsRefresh: true
		};
	}

	async function ensureRatesLoaded(): Promise<RateState> {
		return isFreshRateState(rateState) ? rateState : refreshRates({forceRefresh: false});
	}

	async function refreshRates(refresh: {forceRefresh?: boolean} = {}): Promise<RateState> {
		if (!refresh.forceRefresh && isFreshRateState(rateState)) {
			return rateState;
		}
		const latest = await fetchRates();
		rateState = latest;
		for (const game of GAMES) {
			const state = states[game];
			if (state) {
				states[game] = {...state, rates: latest.rates, ratesFetchedAt: latest.fetchedAt, ratesSource: latest.source};
				saveCache(game, states[game]);
			}
		}
		return latest;
	}

	/** 最新一份 TF2 价目表留样(未压缩的)里 249 价位的全币种价格 */
	function tf2KeyPricesFromLatestSheet(): PriceMap | null {
		try {
			const files = readdirSync(options.priceSheetDir)
				.filter(name => /^tf2-price-sheet-.*\.bkv$/iu.test(name))
				.map(name => {
					const full = join(options.priceSheetDir, name);
					let mtimeMs = 0;
					try {
						mtimeMs = statSync(full).mtimeMs;
					} catch {
						// 忽略
					}
					return {full, mtimeMs};
				})
				.sort((left, right) => right.mtimeMs - left.mtimeMs);
			for (const {full} of files) {
				const buffer = readFileSync(full);
				// 只同步解析未压缩的 BinaryKV(首字节 0);LZMA 留样跳过,交给兜底表
				if (!buffer.length || buffer[0] !== 0) {
					continue;
				}
				const parsed = BinaryKvParser.parse(buffer) as Record<string, any> | null;
				const store = parsed && parsed.store ? parsed.store : parsed;
				const tier = store?.inventoryvalvegcpricesheet?.[String(TF2_KEY_PRICE_TIER)];
				if (tier && typeof tier === 'object') {
					const map = normalizePriceMap(tier);
					map.USD = TF2_KEY_PRICE_TIER;
					if (Object.keys(map).length > 1) {
						return map;
					}
				}
			}
		} catch (err) {
			logger.warn('[purchase] failed to read tf2 key prices from sheet:', err instanceof Error ? err.message : err);
		}
		return null;
	}

	/** 兜底全区价打底,再用留样里的真实价覆盖 */
	function tf2KeyPrices(): PriceMap {
		return normalizePriceMap({...TF2_KEY_FALLBACK_PRICES, ...tf2KeyPricesFromLatestSheet()});
	}

	async function buildStaticTf2State(): Promise<CatalogState> {
		const rates = await ensureRatesLoaded();
		const list = [options.items.buildItem(TF2_KEY_DEF_INDEX, tf2KeyPrices(), null, 'Mann Co. Supply Crate Key', 'tf2')];
		const fetchedAt = new Date().toISOString();
		const state: CatalogState = {
			game: 'tf2',
			gameLabel: gameConfig('tf2').label,
			fetchedAt,
			account: '',
			attemptId: '',
			currency: UY_WALLET_CURRENCY,
			currencyISO: 'UYU',
			country: 'UY',
			priceSheetVersion: 0,
			source: 'static',
			storeData: {
				source: 'static',
				fetchedAt,
				account: '',
				attemptId: '',
				game: 'tf2',
				country: 'UY',
				currency: UY_WALLET_CURRENCY,
				currencyISO: 'UYU',
				balance: null,
				priceSheetVersion: 0,
				list
			},
			rates: rates?.rates ?? {},
			ratesFetchedAt: rates?.fetchedAt ?? '',
			ratesSource: rates?.source ?? '',
			list,
			newIds: []
		};
		states.tf2 = state;
		saveCache('tf2', state);
		return state;
	}

	/** 内存里有就用;否则读磁盘缓存;都没有时 TF2 生成静态目录,CS2 返回空目录(needsRefresh) */
	async function ensureLoaded(gameInput: unknown): Promise<CatalogState> {
		const game = normalizeGame(gameInput);
		const current = states[game];
		if (current && current.list.length) {
			return current;
		}
		const cached = loadCache(game);
		if (cached) {
			states[game] = cached;
			return cached;
		}
		if (game === 'tf2') {
			return buildStaticTf2State();
		}
		const empty = emptyState(game);
		states[game] = empty;
		return empty;
	}

	/** 从 GC 重新拉目录:优先用已连上 GC 的账号,没有就让一个在线账号进游戏连 GC */
	async function refresh(gameInput: unknown, refreshOptions: {forceRefresh?: boolean} = {}): Promise<CatalogState> {
		const game = normalizeGame(gameInput);
		if (game === 'tf2') {
			return buildStaticTf2State();
		}
		const previous = states[game];
		const previousIds = new Set((previous?.list ?? []).map(item => String(item.def_index)));
		const previousFetchedAt = previous?.fetchedAt || '';

		let source = pickGcReadyAttempt(options.attempts(), game);
		if (!source) {
			source = pickOnlineAttemptWithGc(options.attempts(), game);
			if (source) {
				ensureGameSession(source, game);
				await waitForGcConnection(source, game, gcTimeoutMs);
			}
		}
		if (!source) {
			throw catalogError(`当前没有在线且已连接 GC 的账号，无法查询 ${gameConfig(game).label} 商品目录`, 409);
		}

		const rates = await ensureRatesLoaded();
		const storeData = await options.gc.queryUserData(source, game);
		const list = sortedList(storeData);
		const next: CatalogState = {
			game,
			gameLabel: gameConfig(game).label,
			fetchedAt: new Date().toISOString(),
			account: source.accountName,
			attemptId: source.id,
			currency: Number(storeData.currency || source.currency || 0),
			currencyISO: String(storeData.currencyISO || source.currencyISO || '').trim().toUpperCase(),
			country: String(storeData.country || source.country || source.loginGeoCountry || '').trim().toUpperCase(),
			priceSheetVersion: Number(storeData.priceSheetVersion || 0),
			source: storeData.source || 'gc',
			storeData,
			rates: rates?.rates ?? {},
			ratesFetchedAt: rates?.fetchedAt ?? '',
			ratesSource: rates?.source ?? '',
			list,
			newIds: list.map(item => item.def_index).filter(defIndex => !previousIds.has(String(defIndex))),
			changed: !!refreshOptions.forceRefresh || previousFetchedAt !== (storeData.fetchedAt || '')
		};
		states[game] = next;
		saveCache(game, next);
		return next;
	}

	/** 下单前用账号自己查到的价目表更新内存里的目录(不写盘) */
	function adoptStoreData(gameInput: unknown, attempt: Attempt, storeData: StoreData): void {
		const game = normalizeGame(gameInput);
		const previous = states[game];
		states[game] = {
			...(previous ?? emptyState(game)),
			needsRefresh: false,
			game,
			gameLabel: gameConfig(game).label,
			fetchedAt: storeData.fetchedAt,
			account: attempt.accountName,
			attemptId: attempt.id,
			country: storeData.country,
			currency: storeData.currency,
			currencyISO: storeData.currencyISO,
			priceSheetVersion: storeData.priceSheetVersion,
			source: storeData.source,
			storeData,
			rates: rateState?.rates ?? {},
			ratesFetchedAt: rateState?.fetchedAt ?? '',
			ratesSource: rateState?.source ?? '',
			list: sortedList(storeData),
			newIds: []
		};
	}

	function findItem(defIndex: unknown, gameInput: unknown): CatalogItem | null {
		return findCatalogItem(states[normalizeGame(gameInput)]?.list, defIndex);
	}

	/** 目录里出现的币种都列上(没有汇率的为 null),已知汇率覆盖 */
	function ratesFromCatalog(list: CatalogItem[]): Record<string, number | null> {
		const merged: Record<string, number | null> = {USD: 1, ...(rateState?.rates ?? {})};
		for (const item of list) {
			for (const iso of Object.keys(item?.prices ?? {})) {
				const code = iso.trim().toUpperCase();
				if (code && merged[code] == null) {
					merged[code] = code === 'USD' ? 1 : null;
				}
			}
		}
		return merged;
	}

	/** /api/purchase/items 的返回 */
	function response(gameInput: unknown) {
		const game = normalizeGame(gameInput);
		const state = states[game];
		const items = state && Array.isArray(state.list) ? state.list : [];
		return {
			success: true,
			game,
			gameLabel: gameConfig(game).label,
			fetchedAt: state?.fetchedAt || new Date().toISOString(),
			count: items.length,
			chineseCount: items.filter(item => /[㐀-鿿]/u.test(String(item.name || ''))).length,
			rates: state && state.rates ? state.rates : ratesFromCatalog(items),
			ratesFetchedAt: state?.ratesFetchedAt || '',
			ratesSource: state?.ratesSource || '',
			newIds: state && Array.isArray(state.newIds) ? state.newIds : [],
			source: state?.source || 'gc',
			account: state?.account || '',
			currencyISO: state?.currencyISO || '',
			priceSheetVersion: state?.priceSheetVersion || 0,
			needsRefresh: !!state?.needsRefresh,
			list: items
		};
	}

	return {preload, ensureLoaded, refresh, refreshRates, ensureRatesLoaded, adoptStoreData, findItem, response, state: (game: unknown) => states[normalizeGame(game)]};
}

export type PurchaseCatalog = ReturnType<typeof createPurchaseCatalog>;
