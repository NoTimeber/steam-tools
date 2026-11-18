// ECO 扫货的运行设置和监控列表:默认值、校验(都在网页上改、存数据库)。

import type {EcoWatchItem} from '../store/eco.ts';

export type EcoStrategy = 'listing' | 'quick';

/** stopped 停止;sweeping 到价自动买(真实下单,没有模拟) */
export type EcoRunState = 'stopped' | 'sweeping';
export const RUN_STATES: readonly EcoRunState[] = ['stopped', 'sweeping'];

/** ECO 支持的游戏 */
export const GAME_IDS: readonly number[] = [730, 570, 440, 252490];

export interface EcoSettings {
	/** listing:查在售列表,按商品编号从低价往上逐件买;quick:指定类别购买,平台挑不高于目标价的一件,一次一件 */
	strategy: EcoStrategy;
	/** 收货 Steam 账号的交易链接;开始扫货前必填 */
	tradeUrl: string;
	/** 所有饰品累计花费上限;开始扫货前必须大于 0 */
	maxTotalSpend: number;
	/** 每轮最多下几单,防止瞬间打光预算 */
	maxBuyPerCycle: number;
	/** 账户余额至少留这么多不动 */
	minBalanceReserve: number;
	/** 某个饰品下单被拒、查在售失败后暂停多少秒 */
	errorCooldownSec: number;
	/** 轮询间隔(秒)。每轮发 1 个批量查价请求(每个游戏一个),到价才会多发;平台嫌太快会回 6001,自动退避 */
	pollIntervalSec: number;
	/** 单个请求超时(秒) */
	timeoutSec: number;
}

export const DEFAULT_SETTINGS: Readonly<EcoSettings> = {
	strategy: 'listing',
	tradeUrl: '',
	maxTotalSpend: 0,
	maxBuyPerCycle: 10,
	minBalanceReserve: 0,
	errorCooldownSec: 10,
	pollIntervalSec: 5,
	timeoutSec: 10
};

export const ITEM_DEFAULTS = {gameId: 730} as const;

const TRADE_URL_PREFIX = 'https://steamcommunity.com/tradeoffer/new/';

export function ecoError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function invalid(message: string): Error & {statusCode: number} {
	return ecoError(400, message);
}

/** 数字字段:空值用缺省;不是有限数字报错 */
function numberField(raw: Record<string, unknown>, key: string, fallback: number, label: string): number {
	const value = raw[key];
	if (value == null || value === '') {
		return fallback;
	}
	const n = typeof value === 'number' ? value : Number(String(value).trim());
	if (!Number.isFinite(n)) {
		throw invalid(`${label}不是数字: ${String(value)}`);
	}
	return n;
}

function integerField(raw: Record<string, unknown>, key: string, fallback: number, label: string): number {
	const n = numberField(raw, key, fallback, label);
	if (!Number.isInteger(n)) {
		throw invalid(`${label}要是整数: ${n}`);
	}
	return n;
}

function inRange(n: number, min: number, max: number, label: string): number {
	if (n < min || n > max) {
		throw invalid(`${label}要在 ${min} 到 ${max} 之间`);
	}
	return n;
}

export function isTradeUrl(value: string): boolean {
	if (!value.startsWith(TRADE_URL_PREFIX)) {
		return false;
	}
	try {
		const url = new URL(value);
		return !!url.searchParams.get('partner') && !!url.searchParams.get('token');
	} catch {
		return false;
	}
}

/**
 * 网页提交的设置 → 校验后的完整设置。没提交的字段沿用 current(数据库里存的,或默认值)。
 * 交易链接和总预算可以先空着(先填密钥检查连接),开始扫货时再由 sweepBlocker 拦。
 */
export function normalizeSettings(raw: unknown, current: Readonly<EcoSettings> = DEFAULT_SETTINGS): EcoSettings {
	const input = {...current, ...(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {})} as Record<string, unknown>;
	const strategy = String(input.strategy ?? '').trim().toLowerCase();
	if (strategy !== 'listing' && strategy !== 'quick') {
		throw invalid(`策略只能是 listing / quick,收到: ${strategy}`);
	}
	const tradeUrl = String(input.tradeUrl ?? '').trim();
	if (tradeUrl && !isTradeUrl(tradeUrl)) {
		throw invalid(`交易链接不对,应形如 ${TRADE_URL_PREFIX}?partner=...&token=...`);
	}
	return {
		strategy,
		tradeUrl,
		maxTotalSpend: inRange(numberField(input, 'maxTotalSpend', 0, '总预算'), 0, 10_000_000, '总预算'),
		maxBuyPerCycle: inRange(integerField(input, 'maxBuyPerCycle', DEFAULT_SETTINGS.maxBuyPerCycle, '每轮最多下单数'), 1, 200, '每轮最多下单数'),
		minBalanceReserve: inRange(numberField(input, 'minBalanceReserve', 0, '余额保留'), 0, 10_000_000, '余额保留'),
		errorCooldownSec: inRange(numberField(input, 'errorCooldownSec', DEFAULT_SETTINGS.errorCooldownSec, '被拒后暂停秒数'), 0, 3600, '被拒后暂停秒数'),
		pollIntervalSec: inRange(numberField(input, 'pollIntervalSec', DEFAULT_SETTINGS.pollIntervalSec, '轮询间隔'), 1, 600, '轮询间隔(秒)'),
		timeoutSec: inRange(numberField(input, 'timeoutSec', DEFAULT_SETTINGS.timeoutSec, '请求超时'), 3, 60, '请求超时(秒)')
	};
}

/** 能不能开始(或继续)自动扫货:真实下单前必须有交易链接和总预算。能返回 null,不能返回原因 */
export function sweepBlocker(settings: Readonly<EcoSettings>): string | null {
	if (!settings.tradeUrl) {
		return '没填收货账号的交易链接';
	}
	if (settings.maxTotalSpend <= 0) {
		return '没设总预算(要大于 0)';
	}
	return null;
}

/** 数据库里存的设置坏了(手改过、旧版本)时退回默认值,不让服务起不来 */
export function loadSettingsOrDefault(raw: unknown): {settings: EcoSettings; error: string | null} {
	if (raw == null) {
		return {settings: {...DEFAULT_SETTINGS}, error: null};
	}
	try {
		return {settings: normalizeSettings(raw), error: null};
	} catch (err) {
		return {settings: {...DEFAULT_SETTINGS}, error: (err as Error).message};
	}
}

/** 一项监控配置 → EcoWatchItem,顺带校验。where 是报错前缀(如「第 2 项: 」) */
export function makeItem(raw: unknown, where = ''): EcoWatchItem {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw invalid(`${where}格式不对`);
	}
	const input = raw as Record<string, unknown>;
	const name = String(input.name ?? '').trim();
	if (!name) {
		throw invalid(`${where}饰品名不能为空`);
	}
	const label = (field: string) => `${where}${name} 的${field}`;
	const item: EcoWatchItem = {
		name,
		maxPrice: numberField(input, 'maxPrice', 0, label('目标价')),
		maxQty: integerField(input, 'maxQty', 0, label('数量上限')),
		maxSpend: numberField(input, 'maxSpend', 0, label('花费上限')),
		gameId: integerField(input, 'gameId', ITEM_DEFAULTS.gameId, label('游戏'))
	};
	if (!(item.maxPrice >= 0.01)) {
		throw invalid(`${label('目标价')}至少 0.01`);
	}
	if (item.maxQty <= 0) {
		throw invalid(`${label('数量上限')}至少 1`);
	}
	if (item.maxSpend < 0) {
		throw invalid(`${label('花费上限')}不能是负数`);
	}
	if (!GAME_IDS.includes(item.gameId)) {
		throw invalid(`${label('游戏')}只能是 ${GAME_IDS.join(' / ')}(CS2 / Dota2 / TF2 / Rust)`);
	}
	return item;
}

/** 整张监控列表:逐项校验,名字不能重复。空列表也行(没有要监控的) */
export function buildItems(raws: unknown): EcoWatchItem[] {
	if (!Array.isArray(raws)) {
		throw invalid('要提交 items 列表');
	}
	const items: EcoWatchItem[] = [];
	raws.forEach((raw, index) => {
		const item = makeItem(raw, `第 ${index + 1} 项: `);
		if (items.some(other => other.name === item.name)) {
			throw invalid(`${item.name} 重复了`);
		}
		items.push(item);
	});
	return items;
}

/** 给日志用:这次保存改了什么。label 把英文名换成显示用的名字 */
export function describeChange(before: readonly EcoWatchItem[], after: readonly EcoWatchItem[], label: (name: string) => string = name => name): string {
	const old = new Map(before.map(item => [item.name, item]));
	const next = new Map(after.map(item => [item.name, item]));
	const parts: string[] = [];
	for (const [name, b] of next) {
		const a = old.get(name);
		if (!a) {
			parts.push(`新增 ${label(name)} ≤ ${b.maxPrice.toFixed(2)} × ${b.maxQty}`);
		} else if (a.maxPrice !== b.maxPrice || a.maxQty !== b.maxQty || a.maxSpend !== b.maxSpend || a.gameId !== b.gameId) {
			parts.push(`${label(name)} ≤ ${a.maxPrice.toFixed(2)} × ${a.maxQty} → ≤ ${b.maxPrice.toFixed(2)} × ${b.maxQty}`
				+ (a.maxSpend !== b.maxSpend ? `,花费上限 ${b.maxSpend.toFixed(2)}` : '')
				+ (a.gameId !== b.gameId ? `,游戏 ${a.gameId} → ${b.gameId}` : ''));
		}
	}
	for (const name of old.keys()) {
		if (!next.has(name)) {
			parts.push(`删除 ${label(name)}`);
		}
	}
	return parts.length ? ':' + parts.join(';') : '(没有变化)';
}
