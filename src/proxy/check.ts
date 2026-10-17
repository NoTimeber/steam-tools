// 检测代理:经代理查出口 IP(和国家)、打开 Steam 社区首页看 Steam 让不让进、再打开市场页看工具台的市场 / 库存请求会不会被 429。
// 轮换代理采样几次(每次新开连接;按账号固定 IP 的挑几个不同编号),看出口 IP 是不是真的在换。
// 结论:查不到出口 IP 是「无法访问」;查得到但 Steam 首页打不开或回 403 / 429 是「Steam 已封禁」;都正常是「健康」。
// 市场页 429 不算不健康:实测(2026-10)Steam 对机房代理 IP 上的非浏览器请求(Node 的 TLS 指纹)市场、库存接口一律 429,
// 同一个 IP 用浏览器开却正常;登录、商店、手机确认不受影响。只在页面上单独标出来。

import {STEAM_WEB_USER_AGENT} from '../steam/community.ts';
import type {ProxyCheck} from '../store/proxies.ts';
import type {ProxyFetchOptions} from '../core/proxy.ts';

/** 查出口 IP 的地址:先 ipinfo(带国家),它不回 2xx 时退到 ipify(只有 IP) */
export const DEFAULT_IP_URLS = ['https://ipinfo.io/json', 'https://api.ipify.org?format=json'];
export const DEFAULT_STEAM_HOME_URL = 'https://steamcommunity.com/';
export const DEFAULT_STEAM_MARKET_URL = 'https://steamcommunity.com/market/';
export const CHECK_TIMEOUT_MS = 15000;

export interface CheckOptions {
	makeFetch(proxyUrl: string, options?: ProxyFetchOptions): typeof fetch;
	/** 按顺序试,前一个回非 2xx 时用下一个;连不上代理不再试 */
	ipUrls: readonly string[];
	steamHomeUrl: string;
	steamMarketUrl: string;
	now(): number;
	timeoutMs?: number;
	onTraffic?: ProxyFetchOptions['onTraffic'];
}

function errorText(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : String(err);
}

/** 带超时的一次请求(每次新开连接,轮换代理每次能换 IP) */
async function once(options: CheckOptions, proxyUrl: string, url: string, init: RequestInit): Promise<{res: Response; body: string; ms: number}> {
	const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const started = options.now();
	try {
		const res = await options.makeFetch(proxyUrl, {keepAlive: false, onTraffic: options.onTraffic})(url, {...init, signal: controller.signal});
		const body = await res.text();
		return {res, body, ms: options.now() - started};
	} catch (err) {
		throw new Error(controller.signal.aborted ? `超时(${timeoutMs / 1000} 秒)` : errorText(err));
	} finally {
		clearTimeout(timer);
	}
}

/** 经代理查一次出口 IP;代理不通、认证不对抛错(错误信息给人看) */
async function exitIp(options: CheckOptions, proxyUrl: string): Promise<{ip: string; country: string; ms: number}> {
	let lastError = '';
	for (const url of options.ipUrls) {
		let result;
		try {
			result = await once(options, proxyUrl, url, {headers: {Accept: 'application/json'}});
		} catch (err) {
			const message = errorText(err);
			throw new Error(/\b407\b/.test(message) ? '代理账号或密码不对(HTTP 407)' : `代理不通: ${message}`);
		}
		const {res, body, ms} = result;
		if (res.status === 407) {
			throw new Error('代理账号或密码不对(HTTP 407)');
		}
		if (!res.ok) {
			lastError = `查出口 IP 的地址回 HTTP ${res.status}`;
			continue;
		}
		const text = body.trim();
		try {
			const json = JSON.parse(text) as {ip?: unknown; country?: unknown};
			return {ip: String(json.ip || '').slice(0, 64), country: String(json.country || '').slice(0, 8).toUpperCase(), ms};
		} catch {
			return {ip: text.slice(0, 64), country: '', ms};
		}
	}
	throw new Error(lastError || '没有查出口 IP 的地址');
}

/** 经代理打开一个 Steam 页面:回 HTTP 状态,打不开为 0 和原因 */
async function steamStatus(options: CheckOptions, proxyUrl: string, url: string): Promise<{status: number; error: string}> {
	try {
		const {res} = await once(options, proxyUrl, url, {redirect: 'manual', headers: {'User-Agent': STEAM_WEB_USER_AGENT, Accept: 'text/html'}});
		return {status: res.status, error: ''};
	} catch (err) {
		return {status: 0, error: errorText(err)};
	}
}

/**
 * 检测一个代理。urls 是要采样的具体地址(第一个是主的,Steam 两项用它);静态代理一个,轮换代理几个
 * (按连接换 IP 的是同一个地址几遍,按账号固定 IP 的是几个不同编号)。不抛错,结论写在 status / error 里
 */
export async function checkProxy(urls: readonly string[], options: CheckOptions): Promise<ProxyCheck> {
	const base: ProxyCheck = {status: 'unreachable', latencyMs: 0, ip: '', country: '', ips: [], samples: 0, market: 0, error: '', checkedAt: 0};
	let first;
	try {
		first = await exitIp(options, urls[0]!);
	} catch (err) {
		return {...base, error: errorText(err), checkedAt: options.now()};
	}
	const ips = [first.ip];
	for (const url of urls.slice(1)) {
		try {
			ips.push((await exitIp(options, url)).ip);
		} catch {
			// 只算采样成功的
		}
	}
	const home = await steamStatus(options, urls[0]!, options.steamHomeUrl);
	const market = await steamStatus(options, urls[0]!, options.steamMarketUrl);
	const blocked = !home.status || home.status === 403 || home.status === 429;
	return {
		status: blocked ? 'blocked' : 'healthy',
		latencyMs: first.ms,
		ip: first.ip,
		country: first.country,
		ips: [...new Set(ips.filter(Boolean))],
		samples: ips.length,
		market: market.status,
		error: blocked ? (home.status ? `Steam 社区回 HTTP ${home.status}` : `Steam 社区打不开: ${home.error}`) : '',
		checkedAt: options.now()
	};
}
