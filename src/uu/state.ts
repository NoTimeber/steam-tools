// UU 发货的账号状态与配置格式(从 app/server.js 移来)。
// 一个 Steam 账号绑定一个 UU token;CS2、TF2 各有独立的自动发货开关/轮询/统计;CS2 另有自动上架。
// 配置存加密库(src/store/uu.ts),形状与旧版 data/uu/delivery-config.json 一致。

import {CS2_APP_ID, TF2_APP_ID} from '../steam/games.ts';
import type {UuDeliveryConfig} from '../store/uu.ts';

export const CS2_GAME_ID = String(CS2_APP_ID);
export const TF2_GAME_ID = String(TF2_APP_ID);
/** 支持并行发货的游戏(token 通用,网关按游戏选) */
export const DELIVER_GAME_IDS: readonly string[] = Object.freeze([CS2_GAME_ID, TF2_GAME_ID]);

export const POLL_MIN_MS = 30 * 1000;
export const POLL_MAX_MS = 120 * 60 * 1000;
export const POLL_DEFAULT_MS = 5 * 60 * 1000;
const LOG_LIMIT = 200;
const PUBLIC_LOG_LIMIT = 60;
const RECORD_LIMIT = 30;
const PUBLIC_RECORD_LIMIT = 20;

export interface UuLogEntry {
	level: string;
	time: string;
	message: string;
}

export interface DeliveryStats {
	scans: number;
	delivered: number;
	failed: number;
	skipped: number;
}

export interface ListStats {
	scans: number;
	listed: number;
	failed: number;
	skipped: number;
	noAbrade: number;
	repriced: number;
}

/** CS2 自动上架配置(目前只能改配置文件/数据库,前端没有入口) */
export interface ListConfig {
	maxPrice?: number;
	whitelist?: string[];
	blacklist?: string[];
	dryRun?: boolean;
	reprice?: boolean;
}

export interface OrderRecord {
	orderNo: string;
	itemName: string;
	tradeOfferId: string | number | null;
	ok: boolean;
	reason: string;
	at: string;
}

/** 某账号某游戏的发货子状态 */
export interface GameDelivery {
	auto: boolean;
	pollTimer: ReturnType<typeof setInterval> | null;
	running: boolean;
	status: 'idle' | 'scanning' | 'error';
	lastScanAt: string;
	lastError: string;
	stats: DeliveryStats;
	/** 本次运行里已成功发货的 orderNo(避免重复接受) */
	delivered: Set<string>;
	/** orderNo → 冷却截止时间(ms) */
	orderCooldown: Map<string, number>;
	/** 上次播报的未就绪原因(原因不变时自动轮询不重复刷日志) */
	lastSkipReason: string;
}

export interface AccountState {
	accountName: string;
	token: string;
	/** 最近一次绑定时用的游戏(只用于展示) */
	gameId: string;
	nickname: string;
	userId: string | null;
	jwtExp: number | null;
	boundAt: string;
	recentOrders: OrderRecord[];
	logs: UuLogEntry[];
	byGame: Record<string, GameDelivery>;
	listAuto: boolean;
	listTimer: ReturnType<typeof setInterval> | null;
	listRunning: boolean;
	listStatus: 'idle' | 'listing' | 'error';
	lastListAt: string;
	listLastError: string;
	listStats: ListStats;
	listConfig: ListConfig | null;
}

export function uuError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

/** 发货开关用:'730' / 'cs2' / 'csgo' 是 CS2,其它一律 TF2 */
export function normalizeUuGameId(value: unknown): string {
	const text = String(value == null ? '' : value).trim().toLowerCase();
	return text === '730' || text === 'cs2' || text === 'csgo' ? CS2_GAME_ID : TF2_GAME_ID;
}

/**
 * 没指定游戏时用 CS2。token 获取/绑定与游戏无关,游戏只决定校验打哪个网关;登录、cookie-pull 都写死 730,
 * 缺省必须一致,否则不传 gameId 会被判成 TF2,拿 TF2 网关去校验一个通用 token。
 */
export function uuDefaultGameId(gameId: unknown): string {
	const text = String(gameId == null ? '' : gameId).trim();
	return text ? normalizeUuGameId(text) : CS2_GAME_ID;
}

export function uuGameLabel(gameId: unknown): string {
	return String(gameId) === CS2_GAME_ID ? 'CS2' : 'TF2';
}

export function maskUuToken(token: unknown): string {
	const text = String(token || '');
	if (!text) {
		return '';
	}
	return text.length <= 12 ? '****' : text.slice(0, 4) + '…' + text.slice(-6);
}

export function clampPollMs(ms: unknown): number {
	const n = Number(ms);
	if (!Number.isFinite(n) || n <= 0) {
		return POLL_DEFAULT_MS;
	}
	return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(n)));
}

function emptyDeliveryStats(): DeliveryStats {
	return {scans: 0, delivered: 0, failed: 0, skipped: 0};
}

function emptyListStats(): ListStats {
	return {scans: 0, listed: 0, failed: 0, skipped: 0, noAbrade: 0, repriced: 0};
}

export function createAccountState(accountName: string): AccountState {
	return {
		accountName,
		token: '',
		gameId: TF2_GAME_ID,
		nickname: '',
		userId: null,
		jwtExp: null,
		boundAt: '',
		recentOrders: [],
		logs: [],
		byGame: {},
		listAuto: false,
		listTimer: null,
		listRunning: false,
		listStatus: 'idle',
		lastListAt: '',
		listLastError: '',
		listStats: emptyListStats(),
		listConfig: null
	};
}

/** 取/建某游戏的发货子状态 */
export function gameDelivery(state: AccountState, gameId: unknown): GameDelivery {
	const gid = String(gameId);
	let delivery = state.byGame[gid];
	if (!delivery) {
		delivery = {
			auto: false,
			pollTimer: null,
			running: false,
			status: 'idle',
			lastScanAt: '',
			lastError: '',
			stats: emptyDeliveryStats(),
			delivered: new Set(),
			orderCooldown: new Map(),
			lastSkipReason: ''
		};
		state.byGame[gid] = delivery;
	}
	return delivery;
}

export function appendLog(state: AccountState, level: string, message: string): UuLogEntry {
	const entry = {level, time: new Date().toLocaleTimeString('zh-CN', {hour12: false}), message};
	state.logs.push(entry);
	if (state.logs.length > LOG_LIMIT) {
		state.logs.shift();
	}
	return entry;
}

export function pushRecord(state: AccountState, record: OrderRecord): void {
	state.recentOrders.unshift(record);
	if (state.recentOrders.length > RECORD_LIMIT) {
		state.recentOrders.length = RECORD_LIMIT;
	}
}

/**
 * 把存储的配置套到状态表上;返回配置里的轮询间隔(没有为 null)。
 * 旧格式(单游戏 {auto, gameId})迁移成对应游戏的开关,auto 缺省为开。
 */
export function applyConfig(config: UuDeliveryConfig | null, ensure: (name: string) => AccountState): number | null {
	if (!config || typeof config !== 'object') {
		return null;
	}
	const settings = config.__settings__;
	const pollIntervalMs = settings && settings.pollIntervalMs != null ? clampPollMs(settings.pollIntervalMs) : null;
	for (const [accountName, cfg] of Object.entries(config)) {
		const name = String(accountName || '').trim();
		if (!name || name.startsWith('__') || !cfg || typeof cfg !== 'object') {
			continue;
		}
		const token = String(cfg.token || '').trim();
		if (!token) {
			continue;
		}
		const state = ensure(name);
		state.token = token;
		state.gameId = normalizeUuGameId(cfg.gameId);
		state.nickname = String(cfg.nickname || '');
		state.userId = cfg.userId == null ? null : String(cfg.userId);
		state.jwtExp = cfg.jwtExp == null ? null : Number(cfg.jwtExp);
		state.boundAt = String(cfg.boundAt || '');
		state.listAuto = !!cfg.listAuto;
		state.listConfig = cfg.listConfig && typeof cfg.listConfig === 'object' ? cfg.listConfig as ListConfig : null;
		const delivery = cfg.delivery as Record<string, {auto?: unknown} | undefined> | undefined;
		if (delivery && typeof delivery === 'object') {
			for (const gid of DELIVER_GAME_IDS) {
				gameDelivery(state, gid).auto = !!(delivery[gid] && delivery[gid].auto);
			}
		} else {
			gameDelivery(state, normalizeUuGameId(cfg.gameId)).auto = cfg.auto !== false;
		}
	}
	return pollIntervalMs;
}

/** 状态表 → 存储的配置;没绑 token 的账号不存 */
export function buildConfig(states: Map<string, AccountState>, pollIntervalMs: number): UuDeliveryConfig {
	const out: UuDeliveryConfig = {__settings__: {pollIntervalMs}};
	for (const [name, state] of states) {
		if (!state.token) {
			continue;
		}
		const delivery: Record<string, {auto: boolean}> = {};
		for (const gid of DELIVER_GAME_IDS) {
			const game = state.byGame[gid];
			if (game) {
				delivery[gid] = {auto: !!game.auto};
			}
		}
		out[name] = {
			token: state.token,
			gameId: state.gameId,
			nickname: state.nickname || '',
			userId: state.userId == null ? null : String(state.userId),
			jwtExp: state.jwtExp == null ? null : Number(state.jwtExp),
			boundAt: state.boundAt || '',
			delivery,
			listAuto: !!state.listAuto,
			listConfig: state.listConfig || null
		};
	}
	return out;
}

/** 账号的发货就绪情况(Steam 在线、有 cookies、有 identity_secret) */
export interface Readiness {
	online: boolean;
	hasCookies: boolean;
	hasIdentitySecret: boolean;
	steamID: string;
}

/** 推给前端的账号视图 */
export function publicAccount(name: string, state: AccountState | null, ready: Readiness, hasMaFile: boolean) {
	const delivery: Record<string, {gameId: string; gameLabel: string; auto: boolean; status: string; lastScanAt: string; lastError: string; stats: DeliveryStats}> = {};
	for (const gid of DELIVER_GAME_IDS) {
		const game = state?.byGame[gid] ?? null;
		delivery[gid] = {
			gameId: gid,
			gameLabel: uuGameLabel(gid),
			auto: !!game?.auto,
			status: game ? game.status : 'idle',
			lastScanAt: game ? game.lastScanAt : '',
			lastError: game ? game.lastError : '',
			stats: game ? {...game.stats} : emptyDeliveryStats()
		};
	}
	return {
		accountName: name,
		bound: !!state?.token,
		gameId: state ? state.gameId : TF2_GAME_ID,
		nickname: state ? state.nickname : '',
		// 前端用 UU userId 把已获取的 token 和这一行对上,判断哪些 token 还没匹配到账号
		userId: state && state.userId ? String(state.userId) : '',
		tokenMask: state ? maskUuToken(state.token) : '',
		tokenExpiresAt: state && state.jwtExp ? new Date(state.jwtExp * 1000).toISOString() : '',
		tokenExpired: !!(state && state.jwtExp && state.jwtExp * 1000 < Date.now()),
		delivery,
		recentOrders: state ? state.recentOrders.slice(0, PUBLIC_RECORD_LIMIT) : [],
		logs: state ? state.logs.slice(-PUBLIC_LOG_LIMIT) : [],
		online: ready.online,
		hasCookies: ready.hasCookies,
		hasIdentitySecret: ready.hasIdentitySecret,
		hasMaFile: state ? ready.hasIdentitySecret : hasMaFile,
		steamID: ready.steamID,
		listAuto: state ? !!state.listAuto : false,
		listStatus: state ? state.listStatus : 'idle',
		lastListAt: state ? state.lastListAt : '',
		listLastError: state ? state.listLastError : '',
		listStats: state ? {...state.listStats} : emptyListStats()
	};
}

export type PublicUuAccount = ReturnType<typeof publicAccount>;
