// C5 扫货的运行设置和监控列表:默认值、校验(原 c5 项目的 .env 和 watchlist.toml,现在都在网页上改、存数据库)。

import type {C5WatchItem} from '../store/c5.ts';

export type C5Strategy = 'listing' | 'quick';

/** stopped 停止;sweeping 到价自动买(真实下单,没有模拟) */
export type C5RunState = 'stopped' | 'sweeping';
export const RUN_STATES: readonly C5RunState[] = ['stopped', 'sweeping'];

export interface C5Settings {
	/** listing:查在售列表后按在售 id 批量买(内测接口,要 IP 白名单);quick:快速购买接口,平台挑最低价,一次一件 */
	strategy: C5Strategy;
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
	/** 轮询间隔(秒)。平台默认限流 50 qps,每轮只发 1 个行情请求,到价才会多发 */
	pollIntervalSec: number;
	/** 单个请求超时(秒) */
	timeoutSec: number;
}

export const DEFAULT_SETTINGS: Readonly<C5Settings> = {
	strategy: 'listing',
	tradeUrl: '',
	maxTotalSpend: 0,
	maxBuyPerCycle: 10,
	minBalanceReserve: 0,
	errorCooldownSec: 10,
	pollIntervalSec: 3,
	timeoutSec: 10
};

export const ITEM_DEFAULTS = {appId: 730, delivery: 0, assetType: 1} as const;

const TRADE_URL_PREFIX = 'https://steamcommunity.com/tradeoffer/new/';

export function c5Error(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function invalid(message: string): Error & {statusCode: number} {
	return c5Error(400, message);
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
 * 交易链接和总预算可以先空着(先填 app-key 检查连接),开始扫货时再由 sweepBlocker 拦。
 * 旧版本存的 mode(模拟 / 实盘)已经没有了,忽略。
 */
export function normalizeSettings(raw: unknown, current: Readonly<C5Settings> = DEFAULT_SETTINGS): C5Settings {
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
export function sweepBlocker(settings: Readonly<C5Settings>): string | null {
	if (!settings.tradeUrl) {
		return '没填收货账号的交易链接';
	}
	if (settings.maxTotalSpend <= 0) {
		return '没设总预算(要大于 0)';
	}
	return null;
}

/** 数据库里存的设置坏了(手改过、旧版本)时退回默认值,不让服务起不来 */
export function loadSettingsOrDefault(raw: unknown): {settings: C5Settings; error: string | null} {
	if (raw == null) {
		return {settings: {...DEFAULT_SETTINGS}, error: null};
	}
	try {
		return {settings: normalizeSettings(raw), error: null};
	} catch (err) {
		return {settings: {...DEFAULT_SETTINGS}, error: (err as Error).message};
	}
}

/** 一项监控配置 → C5WatchItem,顺带校验。where 是报错前缀(如「第 2 项: 」) */
export function makeItem(raw: unknown, where = ''): C5WatchItem {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw invalid(`${where}格式不对`);
	}
	const input = raw as Record<string, unknown>;
	const name = String(input.name ?? '').trim();
	if (!name) {
		throw invalid(`${where}饰品名不能为空`);
	}
	const label = (field: string) => `${where}${name} 的${field}`;
	const item: C5WatchItem = {
		name,
		maxPrice: numberField(input, 'maxPrice', 0, label('目标价')),
		maxQty: integerField(input, 'maxQty', 0, label('数量上限')),
		maxSpend: numberField(input, 'maxSpend', 0, label('花费上限')),
		appId: integerField(input, 'appId', ITEM_DEFAULTS.appId, label('appId')),
		delivery: integerField(input, 'delivery', ITEM_DEFAULTS.delivery, label('发货方式')),
		assetType: integerField(input, 'assetType', ITEM_DEFAULTS.assetType, label('在售类型'))
	};
	if (!(item.maxPrice > 0)) {
		throw invalid(`${label('目标价')}必须大于 0`);
	}
	if (item.maxQty <= 0) {
		throw invalid(`${label('数量上限')}至少 1`);
	}
	if (item.maxSpend < 0) {
		throw invalid(`${label('花费上限')}不能是负数`);
	}
	if (item.appId <= 0) {
		throw invalid(`${label('appId')}不对`);
	}
	if (![0, 1, 2].includes(item.delivery)) {
		throw invalid(`${label('发货方式')}只能是 0 不限 / 1 人工 / 2 自动`);
	}
	if (![1, 2].includes(item.assetType)) {
		throw invalid(`${label('在售类型')}只能是 1 普通 / 2 冷却期`);
	}
	return item;
}

/** 整张监控列表:逐项校验,名字不能重复。空列表也行(没有要监控的) */
export function buildItems(raws: unknown): C5WatchItem[] {
	if (!Array.isArray(raws)) {
		throw invalid('要提交 items 列表');
	}
	const items: C5WatchItem[] = [];
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
export function describeChange(before: readonly C5WatchItem[], after: readonly C5WatchItem[], label: (name: string) => string = name => name): string {
	const old = new Map(before.map(item => [item.name, item]));
	const next = new Map(after.map(item => [item.name, item]));
	const parts: string[] = [];
	for (const [name, b] of next) {
		const a = old.get(name);
		if (!a) {
			parts.push(`新增 ${label(name)} ≤ ${b.maxPrice.toFixed(2)} × ${b.maxQty}`);
		} else if (a.maxPrice !== b.maxPrice || a.maxQty !== b.maxQty || a.maxSpend !== b.maxSpend
			|| a.delivery !== b.delivery || a.assetType !== b.assetType || a.appId !== b.appId) {
			parts.push(`${label(name)} ≤ ${a.maxPrice.toFixed(2)} × ${a.maxQty} → ≤ ${b.maxPrice.toFixed(2)} × ${b.maxQty}`
				+ (a.maxSpend !== b.maxSpend ? `,花费上限 ${b.maxSpend.toFixed(2)}` : ''));
		}
	}
	for (const name of old.keys()) {
		if (!next.has(name)) {
			parts.push(`删除 ${label(name)}`);
		}
	}
	return parts.length ? ':' + parts.join(';') : '(没有变化)';
}
