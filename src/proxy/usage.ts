// 代理用量:经代理发出的 Steam 网页请求(fetch 那条路:商店、市场、库存、消费记录……)和代理检测,
// 按天(UTC)、代理、账号、请求类型累计次数和收发字节(估算,见 src/core/proxy.ts)。先记在内存里,定时(和查询前)写进 proxy_usage 表,
// 只留最近 90 天。登录长连接(steam-user 的 CM)、手机确认和交易报价(steamcommunity 库)走的是别的 HTTP 库,不在统计里。

import type {Db} from '../core/db.ts';
import {num, str, transaction} from '../core/db.ts';

/** 请求类型(页面按它显示中文名) */
export type UsageKind = 'market' | 'inventory' | 'store' | 'trade' | 'confirm' | 'webapi' | 'login' | 'community' | 'check' | 'other';

export const USAGE_KINDS: readonly UsageKind[] = ['market', 'inventory', 'store', 'trade', 'confirm', 'webapi', 'login', 'community', 'check', 'other'];

const KEEP_DAYS = 90;
const DAY_MS = 86400000;
const FLUSH_MS = 30000;

/** 按地址归类 */
export function usageKind(url: string): UsageKind {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'other';
	}
	const host = parsed.hostname.toLowerCase();
	const path = parsed.pathname;
	if (host === 'login.steampowered.com') {
		return 'login';
	}
	if (host === 'api.steampowered.com') {
		return 'webapi';
	}
	if (host.endsWith('steampowered.com')) {
		return 'store';
	}
	if (host === 'steamcommunity.com') {
		if (path.startsWith('/market')) {
			return 'market';
		}
		if (/^\/inventory\/|\/inventory(\/|$)/.test(path)) {
			return 'inventory';
		}
		if (path.startsWith('/tradeoffer') || /\/tradeoffers?(\/|$)/.test(path)) {
			return 'trade';
		}
		if (path.startsWith('/mobileconf')) {
			return 'confirm';
		}
		return 'community';
	}
	return 'other';
}

/** 毫秒时间戳所在的 UTC 日期 YYYY-MM-DD */
export function utcDay(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

export interface UsageTotals {
	requests: number;
	sent: number;
	received: number;
}

export interface ProxyUsageReport {
	/** 统计了几天(含今天) */
	days: number;
	/** 第一天、最后一天(UTC 日期) */
	since: string;
	until: string;
	total: UsageTotals;
	/** 每天一条,没流量的天也有(全 0) */
	byDay: Array<UsageTotals & {day: string}>;
	byProxy: Array<UsageTotals & {proxyId: string}>;
	/** 用量最高的账号(最多 limit 个;account 为 '' 是认不出账号的请求) */
	byAccount: Array<UsageTotals & {account: string}>;
	byKind: Array<UsageTotals & {kind: UsageKind}>;
	/** 最近一次有流量的时间(毫秒),没有为 0 */
	lastAt: number;
	/** 数据库里最近一条数据是哪天(范围外的也算),没有为 '' */
	latestDay: string;
}

export interface UsageEntry {
	proxyId: string;
	/** 账号名小写;'' 为认不出账号 */
	account: string;
	url: string;
	sent: number;
	received: number;
	/** 不传按地址归类 */
	kind?: UsageKind;
}

export interface UsageMeterOptions {
	db: Db;
	now?: () => number;
	/** 定时写库的间隔;0 不定时(测试里手动 flush) */
	flushMs?: number;
}

const totals = (row: Record<string, unknown>): UsageTotals => ({
	requests: num(row, 'requests') ?? 0,
	sent: num(row, 'sent') ?? 0,
	received: num(row, 'received') ?? 0
});

const bytes = (item: UsageTotals) => item.sent + item.received;

export function createUsageMeter(options: UsageMeterOptions) {
	const {db} = options;
	const now = options.now ?? Date.now;
	const upsert = db.prepare(`
		INSERT INTO proxy_usage (day, proxy_id, account, kind, requests, sent, received) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(day, proxy_id, account, kind) DO UPDATE SET
			requests = requests + excluded.requests, sent = sent + excluded.sent, received = received + excluded.received
	`);
	const prune = db.prepare('DELETE FROM proxy_usage WHERE day < ?');
	/** 还没写库的:「天 \n 代理 \n 账号 \n 类型」→ 累计 */
	const pending = new Map<string, UsageTotals>();
	let lastAt = 0;
	let prunedDay = '';

	function record(entry: UsageEntry): void {
		const at = now();
		lastAt = at;
		const key = [utcDay(at), entry.proxyId, entry.account, entry.kind ?? usageKind(entry.url)].join('\n');
		const sum = pending.get(key) ?? {requests: 0, sent: 0, received: 0};
		sum.requests += 1;
		sum.sent += Math.max(0, Math.round(entry.sent));
		sum.received += Math.max(0, Math.round(entry.received));
		pending.set(key, sum);
	}

	function flush(): void {
		const today = utcDay(now());
		if (!pending.size && prunedDay === today) {
			return;
		}
		const rows = [...pending];
		pending.clear();
		transaction(db, () => {
			for (const [key, sum] of rows) {
				const [day, proxyId, account, kind] = key.split('\n') as [string, string, string, string];
				upsert.run(day, proxyId, account, kind, sum.requests, sum.sent, sum.received);
			}
			if (prunedDay !== today) {
				prune.run(utcDay(now() - (KEEP_DAYS - 1) * DAY_MS));
				prunedDay = today;
			}
		});
	}

	/** 最近 days 天(含今天,UTC);传 proxyId 只看这个代理 */
	function report(query: {days?: unknown; proxyId?: unknown; limit?: number} = {}): ProxyUsageReport {
		flush();
		const days = Math.min(KEEP_DAYS, Math.max(1, Math.floor(Number(query.days) || 7)));
		const proxyId = String(query.proxyId ?? '');
		const until = utcDay(now());
		const since = utcDay(now() - (days - 1) * DAY_MS);
		const where = proxyId ? 'day >= ? AND proxy_id = ?' : 'day >= ?';
		const params = proxyId ? [since, proxyId] : [since];
		const sums = 'SUM(requests) AS requests, SUM(sent) AS sent, SUM(received) AS received';
		const grouped = (column: string) => db.prepare(`SELECT ${column} AS item, ${sums} FROM proxy_usage WHERE ${where} GROUP BY ${column}`).all(...params);
		const sorted = <T extends UsageTotals>(items: T[]) => items.sort((a, b) => bytes(b) - bytes(a));

		const daily = new Map(grouped('day').map(row => [str(row, 'item'), totals(row)]));
		const byDay = Array.from({length: days}, (_, offset) => {
			const day = utcDay(now() - (days - 1 - offset) * DAY_MS);
			return {day, ...(daily.get(day) ?? {requests: 0, sent: 0, received: 0})};
		});
		const total = byDay.reduce((sum, item) => ({requests: sum.requests + item.requests, sent: sum.sent + item.sent, received: sum.received + item.received}),
			{requests: 0, sent: 0, received: 0});
		const latest = db.prepare(`SELECT MAX(day) AS day FROM proxy_usage${proxyId ? ' WHERE proxy_id = ?' : ''}`).get(...(proxyId ? [proxyId] : []));
		return {
			days,
			since,
			until,
			total,
			byDay,
			byProxy: sorted(grouped('proxy_id').map(row => ({proxyId: str(row, 'item'), ...totals(row)}))),
			byAccount: sorted(grouped('account').map(row => ({account: str(row, 'item'), ...totals(row)}))).slice(0, query.limit ?? 25),
			byKind: sorted(grouped('kind').map(row => ({kind: str(row, 'item') as UsageKind, ...totals(row)}))),
			lastAt,
			latestDay: latest ? str(latest, 'day') : ''
		};
	}

	const timer = options.flushMs === 0 ? null : setInterval(() => {
		try {
			flush();
		} catch (err) {
			console.warn('[proxy] 写代理用量失败:', err instanceof Error ? err.message : err);
		}
	}, options.flushMs ?? FLUSH_MS);
	timer?.unref?.();

	return {
		record,
		flush,
		report,
		stop(): void {
			if (timer) {
				clearInterval(timer);
			}
			flush();
		}
	};
}

export type UsageMeter = ReturnType<typeof createUsageMeter>;
