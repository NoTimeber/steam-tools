// Steam 代理:全局一个代理,账号可以单独覆盖(用自己的代理,或者不走代理)。只给 Steam 的请求用,
// C5(在售查询要服务器 IP 白名单)、悠悠、汇率、GitHub 版本检查照旧直连。
// 用在三个地方:
//   - steam-user 的登录连接:建客户端时按账号名取(proxyFor);改了设置要重新登录这个账号才换;
//   - 走 fetch 的 Steam 请求(商店、市场、库存、交易链接、消费记录、账户国家):注入下面的 fetch,
//     按请求 Cookie 里 steamLoginSecure 的 SteamID 找到账号再取;没带 cookie 的(查价格、nameid)用全局代理;
//   - steamcommunity(手机确认、交易报价)和充值码的 steamstore:建实例时按 cookie / 账号名取。
// 设置马上对新请求生效;已经建好的 Steam 登录连接不变。
//
// 固定 IP(粘性)模式:全局代理地址里写 {n}(如 webshare 的 http://用户名-{n}:密码@p.webshare.io:80,一个编号对应一个固定 IP),
// 每个账号分到一个编号并记住(尽量不和别的账号重复),之后一直用它;只有新账号第一次用、手动重新登录(renew)时才换编号。
// 认不出账号的请求(查价格、nameid)也固定用一个。断线自动重连、重启后自动恢复登录都不换。

import {createProxyFetch, fillProxyTemplate, isProxyTemplate, maskProxyUrl, normalizeProxyUrl} from '../core/proxy.ts';
import {STEAM_WEB_USER_AGENT} from '../steam/community.ts';
import type {ProxyConfig, ProxyStore} from '../store/proxies.ts';

const STEAM_HOST = /(^|\.)(steampowered\.com|steamcommunity\.com|steamstatic\.com|steamcontent\.com|steamserver\.net|steam-chat\.com)$/i;
/** 测试代理时请求的地址:回出口 IP */
const DEFAULT_TEST_URL = 'https://api.ipify.org?format=json';
/**
 * 测试代理时顺带请求的 Steam 社区页面:市场页回 429 时,工具台经这个代理的市场、库存请求也会被拒。
 * 实测(2026-10)Steam 对机房代理 IP 上的非浏览器请求(Node 的 TLS 指纹)市场、库存接口一律 429,
 * 同一个 IP 用 Windows 的 curl(系统 TLS)却是 200;登录连接、商店、社区首页、手机确认不受影响
 */
const DEFAULT_STEAM_TEST_URL = 'https://steamcommunity.com/market/';
const TEST_TIMEOUT_MS = 15000;
/** 编号范围的上限(webshare 之类按代理数量编号,够用了) */
const MAX_INDEX = 100000;

export function isSteamHost(hostname: string): boolean {
	return STEAM_HOST.test(hostname);
}

/** cookie 里 steamLoginSecure 的 SteamID(值是「SteamID||令牌」URL 编码后的样子);没有为 '' */
export function steamIdFromCookies(cookies: string | readonly string[]): string {
	const header = typeof cookies === 'string' ? cookies : cookies.join('; ');
	const match = /(?:^|;\s*)steamLoginSecure=([^;]+)/.exec(header);
	if (!match) {
		return '';
	}
	try {
		return /^(\d{17})/.exec(decodeURIComponent(match[1]!))?.[1] ?? '';
	} catch {
		return '';
	}
}

export interface PublicProxyConfig {
	/** 全局代理(密码打码),'' 为没设 */
	global: string;
	/** 全局代理带 {n}:固定 IP 模式 */
	sticky: boolean;
	/** 固定 IP 模式的编号范围 */
	range: {from: number; to: number};
	/** 固定 IP 模式下各账号分到的编号(账号名小写) */
	assigned: Record<string, number>;
	/** 单独设置过的账号(账号名小写):direct 不走代理,custom 用自己的代理(密码打码) */
	accounts: Record<string, {mode: 'direct' | 'custom'; url: string}>;
}

export interface ProxyTestResult {
	/** 代理出口 IP(测试地址回的内容) */
	ip: string;
	ms: number;
	/** 测的是哪个代理(密码打码) */
	proxy: string;
	/** 经这个代理打开 Steam 社区:status 429 是这个 IP 被 Steam 限流了;请求没成功时 status 为 0、error 写原因 */
	steam: {status: number; ms: number; error: string};
}

export interface ProxyServiceOptions {
	store: ProxyStore;
	/** SteamID → 账号名;找不到为 '' */
	accountForSteamId(steamId: string): string;
	/** 直连用的 fetch(测试注入) */
	fetch?: typeof fetch;
	createProxyFetch?: (proxyUrl: string, options?: {keepAlive?: boolean}) => typeof fetch;
	testUrl?: string;
	/** 测试时顺带请求的 Steam 社区地址 */
	steamTestUrl?: string;
	now?: () => number;
	/** 挑编号用的随机数(测试注入) */
	random?: () => number;
}

function proxyError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function errorText(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : String(err);
}

/** 校验代理地址,不对的回 400 */
function checkedProxyUrl(raw: unknown): string {
	try {
		return normalizeProxyUrl(raw);
	} catch (err) {
		throw proxyError(400, errorText(err));
	}
}

/** 校验编号范围;没给的用现在的 */
function checkedRange(body: {from?: unknown; to?: unknown}, current: {from: number; to: number}): {from: number; to: number} {
	const from = body.from === undefined || body.from === '' ? current.from : Number(body.from);
	const to = body.to === undefined || body.to === '' ? current.to : Number(body.to);
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > MAX_INDEX || from > to) {
		throw proxyError(400, `编号范围要是 1 到 ${MAX_INDEX} 之间的整数,起始不大于结束`);
	}
	return {from, to};
}

export function createProxyService(options: ProxyServiceOptions) {
	const direct: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const makeFetch = options.createProxyFetch ?? createProxyFetch;
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	let config: ProxyConfig = options.store.load();
	/**
	 * 「账号 + 代理地址」→ 走它的 fetch。每个账号各用各的长连接:轮换代理每个新连接换一个出口 IP,
	 * 共用连接的话几个账号会从同一个 IP 出去;分开后同一账号一段时间内 IP 稳定,账号之间不混。
	 * 认不出账号的请求(查价格、nameid)共用一组
	 */
	const fetchers = new Map<string, typeof fetch>();
	/** SteamID → 账号名,只记找到的 */
	const steamIds = new Map<string, string>();

	function fetcherFor(proxyUrl: string, accountKey: string): typeof fetch {
		if (!proxyUrl) {
			return direct;
		}
		const key = `${accountKey}\n${proxyUrl}`;
		let fetcher = fetchers.get(key);
		if (!fetcher) {
			// 这个账号换了代理(改设置、换了编号):旧的那套连接不再用
			for (const old of fetchers.keys()) {
				if (old.startsWith(`${accountKey}\n`)) {
					fetchers.delete(old);
				}
			}
			fetcher = makeFetch(proxyUrl);
			fetchers.set(key, fetcher);
		}
		return fetcher;
	}

	function persist(next: ProxyConfig): void {
		options.store.save(next);
		config = next;
	}

	const isSticky = () => isProxyTemplate(config.global);
	const inRange = (index: unknown): index is number =>
		Number.isInteger(index) && (index as number) >= config.range.from && (index as number) <= config.range.to;

	/** 给账号挑编号:先挑没被别的账号占着的;都占满了就随便挑。尽量不挑 avoid(换编号时的旧编号) */
	function pickIndex(key: string, avoid?: number): number {
		const {from, to} = config.range;
		const taken = new Set(Object.entries(config.assigned).filter(([other]) => other !== key).map(([, index]) => index));
		const all: number[] = [];
		const free: number[] = [];
		for (let index = from; index <= to; index++) {
			if (index === avoid && to > from) {
				continue;
			}
			all.push(index);
			if (!taken.has(index)) {
				free.push(index);
			}
		}
		const pool = free.length ? free : all;
		return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
	}

	/** 账号的编号:分过(且还在范围内)就用分过的,没有就现分一个并记下 */
	function indexFor(key: string): number {
		const current = config.assigned[key];
		if (inRange(current)) {
			return current;
		}
		const index = pickIndex(key);
		persist({...config, assigned: {...config.assigned, [key]: index}});
		return index;
	}

	/** 这个账号的 Steam 请求用哪个代理;'' 为直连。不传账号名就是全局代理 */
	function proxyFor(accountName?: unknown): string {
		const key = String(accountName || '').trim().toLowerCase();
		const override = key ? config.accounts[key] : undefined;
		if (override === 'direct') {
			return '';
		}
		if (override && override !== 'global') {
			return override;
		}
		return isSticky() ? fillProxyTemplate(config.global, indexFor(key)) : config.global;
	}

	/** 手动登录(新建会话)前调:固定 IP 模式下给走全局代理的账号换一个编号(也就是换一个 IP) */
	function renew(accountName: unknown): void {
		const key = String(accountName || '').trim().toLowerCase();
		const override = key ? config.accounts[key] : undefined;
		if (!key || !isSticky() || (override && override !== 'global')) {
			return;
		}
		const previous = config.assigned[key];
		persist({...config, assigned: {...config.assigned, [key]: pickIndex(key, inRange(previous) ? previous : undefined)}});
	}

	function accountOf(steamId: string): string {
		const cached = steamIds.get(steamId);
		if (cached) {
			return cached;
		}
		const accountName = options.accountForSteamId(steamId);
		if (accountName) {
			steamIds.set(steamId, accountName);
		}
		return accountName;
	}

	/** cookie 是哪个账号的;认不出为 '' */
	function accountOfCookies(cookies: string | readonly string[]): string {
		const steamId = steamIdFromCookies(cookies);
		return steamId ? accountOf(steamId) : '';
	}

	/** 按 cookie 里的账号取代理;没 cookie、认不出账号的用全局代理 */
	function proxyForCookies(cookies: string | readonly string[]): string {
		return proxyFor(accountOfCookies(cookies));
	}

	/** 给 Steam 模块用的 fetch:Steam 的地址按 Cookie 选代理(每个账号各自的连接),别的地址直连 */
	const steamFetch: typeof fetch = (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (!isSteamHost(url.hostname)) {
			return direct(input, init);
		}
		const cookie = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('cookie') ?? '';
		const accountName = accountOfCookies(cookie);
		return fetcherFor(proxyFor(accountName), accountName.toLowerCase())(input, init);
	};

	function publicConfig(): PublicProxyConfig {
		const accounts: PublicProxyConfig['accounts'] = {};
		for (const [key, value] of Object.entries(config.accounts)) {
			if (value === 'direct') {
				accounts[key] = {mode: 'direct', url: ''};
			} else if (value && value !== 'global') {
				accounts[key] = {mode: 'custom', url: maskProxyUrl(value)};
			}
		}
		return {global: maskProxyUrl(config.global), sticky: isSticky(), range: {...config.range}, accounts, assigned: {...config.assigned}};
	}

	function save(next: ProxyConfig): PublicProxyConfig {
		persist(next);
		return publicConfig();
	}

	/**
	 * 设全局代理:proxy 为 '' 清除,不传只改编号范围(不用再输一遍密码);带 {n} 时要编号范围 from / to。
	 * 已分的编号在新范围里的照旧,范围外的下次用时重新分
	 */
	function setGlobal(body: {proxy?: unknown; from?: unknown; to?: unknown}): PublicProxyConfig {
		const global = body.proxy === undefined ? config.global : checkedProxyUrl(body.proxy);
		const range = isProxyTemplate(global) ? checkedRange(body, config.range) : config.range;
		const assigned = Object.fromEntries(Object.entries(config.assigned).filter(([, index]) => index >= range.from && index <= range.to));
		return save({...config, global, range, assigned});
	}

	/**
	 * 设账号的代理:global 用全局的(去掉单独设置)、direct 不走代理、custom 用填的地址。
	 * custom 没填地址时沿用这个账号原来的(只是切回来,不用再输一遍密码)
	 */
	function setAccount(body: {accountName?: unknown; mode?: unknown; proxy?: unknown}): PublicProxyConfig {
		const key = String(body.accountName || '').trim().toLowerCase();
		if (!key) {
			throw proxyError(400, '缺少账号名');
		}
		const accounts = {...config.accounts};
		const mode = String(body.mode || '');
		if (mode === 'global') {
			delete accounts[key];
		} else if (mode === 'direct') {
			accounts[key] = 'direct';
		} else if (mode === 'custom') {
			const previous = accounts[key];
			const proxyUrl = checkedProxyUrl(body.proxy) || (previous && previous !== 'direct' && previous !== 'global' ? previous : '');
			if (!proxyUrl) {
				throw proxyError(400, '请填写这个账号的代理地址');
			}
			if (isProxyTemplate(proxyUrl)) {
				throw proxyError(400, '单独代理填一个具体的地址,不要带 {n}(要固定编号直接把编号写进去,如 用户名-5)');
			}
			accounts[key] = proxyUrl;
		} else {
			throw proxyError(400, '代理方式只能是 global / direct / custom');
		}
		return save({...config, accounts});
	}

	/** 经代理打开一次 Steam 社区,看这个出口 IP 有没有被限流(429);出错不抛,写进 error */
	async function checkSteam(proxyUrl: string): Promise<ProxyTestResult['steam']> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
		const started = now();
		try {
			const res = await makeFetch(proxyUrl, {keepAlive: false})(options.steamTestUrl ?? DEFAULT_STEAM_TEST_URL, {
				redirect: 'manual',
				headers: {'User-Agent': STEAM_WEB_USER_AGENT, Accept: 'text/html'},
				signal: controller.signal
			});
			await res.arrayBuffer();
			return {status: res.status, ms: now() - started, error: ''};
		} catch (err) {
			return {status: 0, ms: now() - started, error: controller.signal.aborted ? `超时(${TEST_TIMEOUT_MS / 1000} 秒)` : errorText(err)};
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 测代理:填了地址测填的(保存前先试;带 {n} 的随机挑范围里一个编号),没填测这个账号(或全局)现在用的;
	 * 回出口 IP 和耗时,再顺带打开一次 Steam 社区看这个 IP 有没有被限流。
	 * 固定 IP 模式下两次请求是同一个 IP;轮换代理每个连接换 IP,两次不一定是同一个
	 */
	async function test(body: {proxy?: unknown; accountName?: unknown; from?: unknown; to?: unknown}): Promise<ProxyTestResult> {
		let proxyUrl = String(body.proxy ?? '').trim() ? checkedProxyUrl(body.proxy) : proxyFor(body.accountName);
		if (isProxyTemplate(proxyUrl)) {
			const {from, to} = checkedRange(body, config.range);
			proxyUrl = fillProxyTemplate(proxyUrl, from + Math.min(to - from, Math.floor(random() * (to - from + 1))));
		}
		if (!proxyUrl) {
			throw proxyError(400, body.accountName ? '这个账号现在不走代理' : '还没有设置代理');
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
		const started = now();
		let ip: string;
		let ms: number;
		try {
			// 每次测试新开连接(不留长连接),轮换代理每测一次能看到换了 IP
			const res = await makeFetch(proxyUrl, {keepAlive: false})(options.testUrl ?? DEFAULT_TEST_URL, {headers: {Accept: 'application/json'}, signal: controller.signal});
			if (!res.ok) {
				throw new Error(`测试地址回 HTTP ${res.status}` + (res.status === 407 ? '(代理账号或密码不对)' : ''));
			}
			const text = (await res.text()).trim();
			ip = text;
			try {
				ip = String((JSON.parse(text) as {ip?: unknown}).ip || text);
			} catch {
				// 纯文本就是 IP
			}
			ms = now() - started;
		} catch (err) {
			throw proxyError(502, controller.signal.aborted ? `代理测试超时(${TEST_TIMEOUT_MS / 1000} 秒)` : `代理不通: ${errorText(err)}`);
		} finally {
			clearTimeout(timer);
		}
		return {ip: ip.slice(0, 64), ms, proxy: maskProxyUrl(proxyUrl), steam: await checkSteam(proxyUrl)};
	}

	return {proxyFor, proxyForCookies, renew, fetch: steamFetch, publicConfig, setGlobal, setAccount, test};
}

export type ProxyService = ReturnType<typeof createProxyService>;
