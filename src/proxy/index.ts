// Steam 代理:全局一个代理,账号可以单独覆盖(用自己的代理,或者不走代理)。只给 Steam 的请求用,
// C5(在售查询要服务器 IP 白名单)、悠悠、汇率、GitHub 版本检查照旧直连。
// 用在三个地方:
//   - steam-user 的登录连接:建客户端时按账号名取(proxyFor);改了设置要重新登录这个账号才换;
//   - 走 fetch 的 Steam 请求(商店、市场、库存、交易链接、消费记录、账户国家):注入下面的 fetch,
//     按请求 Cookie 里 steamLoginSecure 的 SteamID 找到账号再取;没带 cookie 的(查价格、nameid)用全局代理;
//   - steamcommunity(手机确认、交易报价)和充值码的 steamstore:建实例时按 cookie / 账号名取。
// 设置马上对新请求生效;已经建好的 Steam 登录连接不变。
// 全局代理按各项存(协议、主机、端口、类型、账号密码、登录速率限制、启用),用的时候拼成地址;关了就直连,填的留着。
// 登录速率限制:走全局代理开始的 Steam 登录每分钟最多几次,超出的排队(./login-limit.ts);手动登录、超时重试、掉线重连、
// 重启恢复、充值码兑换的登录都算,steam-user 自己断线后的自动重登不经过这里,不受限。
//
// 类型:静态是一个固定出口 IP,所有账号共用;轮换是提供商换出口 IP 的入口,工具台把每个账号固定在其中一个 IP 上:
// 编号 1 到「IP 数量」对应池里的一个个 IP(webshare 的「用户名-rotate」换成「用户名-编号」就是代理列表里第几个;
// 别家在用户名里用 {n} 标出编号的位置),每个账号第一次用 Steam 时分一个(尽量不和别的账号重复),这次运行里一直用它,
// 重新登录、掉线重连都不换;编号只记在内存里,服务重启后重新分。认不出账号的请求(查价格、nameid)也固定用一个。

import {
	buildProxyUrl, createProxyFetch, fillProxyTemplate, isProxyTemplate, maskProxyUrl, normalizeProxyUrl, parseProxyUrl, PROXY_INDEX_PLACEHOLDER
} from '../core/proxy.ts';
import {STEAM_WEB_USER_AGENT} from '../steam/community.ts';
import {PROXY_KINDS} from '../store/proxies.ts';
import type {GlobalProxySettings, ProxyConfig, ProxyKind, ProxyStore} from '../store/proxies.ts';
import {createLoginLimiter} from './login-limit.ts';
import type {LoginLimiterOptions, LoginSlot} from './login-limit.ts';

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
/** IP 数量的上限(webshare 之类按代理数量编号,够用了) */
const MAX_POOL_SIZE = 100000;
/** webshare 轮换入口的用户名后缀:换成「-编号」就是代理列表里的第几个(一个固定 IP) */
const WEBSHARE_ROTATE = /-rotate$/i;
/** 登录速率限制的上限(每分钟) */
const MAX_LOGINS_PER_MINUTE = 10000;

export function isSteamHost(hostname: string): boolean {
	return STEAM_HOST.test(hostname);
}

/**
 * 全局代理各项拼成的地址(不管开没开)。轮换代理按账号固定 IP 时是带 {n} 的模板:用户名(或密码、主机)里写了 {n} 的照用,
 * 填了 IP 数量的 webshare「用户名-rotate」换成「用户名-{n}」;都没有(固定不了,如旧版迁移来还没填 IP 数量)、静态代理就是普通地址
 */
export function globalProxyUrl(settings: GlobalProxySettings): string {
	const plain = buildProxyUrl(settings);
	if (settings.type !== 'rotating' || isProxyTemplate(plain) || settings.poolSize < 1 || !WEBSHARE_ROTATE.test(settings.username)) {
		return plain;
	}
	return buildProxyUrl({...settings, username: settings.username.replace(WEBSHARE_ROTATE, `-${PROXY_INDEX_PLACEHOLDER}`)});
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

/** 下发给页面的全局代理各项:不带密码,只说有没有 */
export interface PublicGlobalProxy extends Omit<GlobalProxySettings, 'password'> {
	hasPassword: boolean;
}

export interface PublicProxyConfig {
	/** 全局代理现在用的地址(密码打码),'' 为没设或没启用 */
	global: string;
	/** 全局代理各项(设置页的表单) */
	settings: PublicGlobalProxy;
	/** 全局代理是轮换、按账号固定 IP */
	sticky: boolean;
	/** 这次运行里各账号分到的编号(账号名小写;'' 是认不出账号的请求共用的) */
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
	/** 登录速率限制用的时钟和定时器(测试注入) */
	loginClock?: Pick<LoginLimiterOptions, 'now' | 'setTimer' | 'clearTimer'>;
}

/** 设全局代理(或测还没保存的设置)时页面传的各项;不传的照旧,password 不传或 '' 保留原来的 */
export interface GlobalProxyBody {
	enabled?: unknown;
	protocol?: unknown;
	host?: unknown;
	port?: unknown;
	type?: unknown;
	username?: unknown;
	password?: unknown;
	poolSize?: unknown;
	loginsPerMinute?: unknown;
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

/** 主机:域名或 IP(IPv6 带方括号),可以带 {n};协议、端口、账号密码不能混进来 */
function checkedHost(raw: unknown): string {
	const text = String(raw ?? '').trim();
	if (!text) {
		return '';
	}
	if (!/^\[[0-9a-f:.]+\]$/i.test(text) && /[:/@\s]/.test(text)) {
		throw proxyError(400, '主机只填域名或 IP(如 p.webshare.io),协议、端口、账号密码分开填');
	}
	try {
		return parseProxyUrl(`http://${text}:80`).host;
	} catch {
		throw proxyError(400, `主机「${text}」格式不对`);
	}
}

/** 端口:1–65535;填了主机就必须填 */
function checkedPort(raw: unknown, host: string): number {
	if (raw === undefined || raw === null || raw === '' || raw === 0) {
		if (host) {
			throw proxyError(400, '请填写端口');
		}
		return 0;
	}
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw proxyError(400, '端口要是 1 到 65535 的整数');
	}
	return port;
}

/** 登录速率限制:每分钟次数,留空(或 0)不限 */
function checkedLoginLimit(raw: unknown): number {
	if (raw === undefined || raw === null || raw === '' || raw === 0) {
		return 0;
	}
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOGINS_PER_MINUTE) {
		throw proxyError(400, '登录速率限制填每分钟次数(正整数),留空不限');
	}
	return limit;
}

/** IP 数量:轮换代理必填(1 到上限的整数),静态代理不用 */
function checkedPoolSize(raw: unknown, required: boolean): number {
	if (raw === undefined || raw === null || raw === '' || raw === 0) {
		if (required) {
			throw proxyError(400, '请填写 IP 数量(轮换池里有几个 IP,webshare 是代理列表的个数)');
		}
		return 0;
	}
	const size = Number(raw);
	if (!Number.isInteger(size) || size < 1 || size > MAX_POOL_SIZE) {
		throw proxyError(400, `IP 数量要是 1 到 ${MAX_POOL_SIZE} 的整数`);
	}
	return size;
}

export function createProxyService(options: ProxyServiceOptions) {
	const direct: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const makeFetch = options.createProxyFetch ?? createProxyFetch;
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	let config: ProxyConfig = options.store.load();
	/** 全局代理现在用的地址:没启用、没填主机为 ''(直连);轮换代理是带 {n} 的模板 */
	const globalUrl = () => (config.global.enabled && config.global.host ? globalProxyUrl(config.global) : '');
	/** 这次运行里各账号分到的编号(账号名小写;'' 是认不出账号的请求共用的);不存盘,重启后重新分 */
	const assigned = new Map<string, number>();
	/** 走全局代理开始的 Steam 登录:每分钟次数限制;全局代理没启用时不限 */
	const logins = createLoginLimiter({limit: () => (globalUrl() ? config.global.loginsPerMinute : 0), ...options.loginClock});
	/**
	 * 「账号 + 代理地址」→ 走它的 fetch。每个账号各用各的长连接,账号之间的连接不混
	 * (单独代理是一个按连接换 IP 的入口时,同一账号一段时间内 IP 也稳定)。认不出账号的请求(查价格、nameid)共用一组
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

	const isSticky = () => isProxyTemplate(globalUrl());
	/** 轮换池的编号是 1 到 IP 数量 */
	const poolSize = () => Math.max(1, config.global.poolSize);

	/** 给账号挑编号:先挑没被别的账号占着的;都占满了就随便挑 */
	function pickIndex(key: string): number {
		const taken = new Set([...assigned].filter(([other]) => other !== key).map(([, index]) => index));
		const all = Array.from({length: poolSize()}, (_, offset) => offset + 1);
		const free = all.filter(index => !taken.has(index));
		const pool = free.length ? free : all;
		return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
	}

	/** 账号的编号:这次运行分过(且还在池里)就用分过的,没有就现分一个 */
	function indexFor(key: string): number {
		const current = assigned.get(key);
		if (current !== undefined && current <= poolSize()) {
			return current;
		}
		const index = pickIndex(key);
		assigned.set(key, index);
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
		const global = globalUrl();
		return isProxyTemplate(global) ? fillProxyTemplate(global, indexFor(key)) : global;
	}

	/** 这个账号的 Steam 请求走全局代理(没单独设置,全局代理也开着) */
	function usesGlobal(accountName: unknown): boolean {
		const key = String(accountName || '').trim().toLowerCase();
		const override = key ? config.accounts[key] : undefined;
		return !!globalUrl() && (!override || override === 'global');
	}

	/**
	 * 开始一次 Steam 登录前调(登录速率限制):走全局代理、设了每分钟次数的,超出就排队。
	 * 返回 null 直接登录;否则等 ready,false 表示轮到时 cancelled() 已经为真(不用登录了)
	 */
	function queueLogin(accountName: unknown, cancelled?: () => boolean): LoginSlot | null {
		return usesGlobal(accountName) ? logins.acquire(cancelled) : null;
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
		const {password, ...settings} = config.global;
		return {
			global: maskProxyUrl(globalUrl()),
			settings: {...settings, hasPassword: !!password},
			sticky: isSticky(),
			accounts,
			assigned: Object.fromEntries(assigned)
		};
	}

	function save(next: ProxyConfig): PublicProxyConfig {
		persist(next);
		return publicConfig();
	}

	/**
	 * 页面传的各项和现在的合起来校验;requireHost:测试时必须有主机(保存时关着可以不填)。
	 * 密码不传或 '' 保留原来的,用户名清空时密码一起清
	 */
	function checkedGlobal(body: GlobalProxyBody, requireHost: boolean): GlobalProxySettings {
		const current = config.global;
		const pick = (key: keyof GlobalProxySettings): unknown => (body[key] === undefined ? current[key] : body[key]);
		const protocol = String(pick('protocol') ?? '').trim().toLowerCase();
		if (/^socks/.test(protocol)) {
			throw proxyError(400, '暂不支持 SOCKS 代理,协议选 HTTP');
		}
		if (protocol !== 'http' && protocol !== 'https') {
			throw proxyError(400, '协议只能是 HTTP 或 HTTPS');
		}
		const host = checkedHost(pick('host'));
		const port = checkedPort(pick('port'), host);
		const type = String(pick('type') ?? '') as ProxyKind;
		if (!PROXY_KINDS.includes(type)) {
			throw proxyError(400, '类型只能是 静态 或 轮换');
		}
		const username = String(pick('username') ?? '').trim();
		const typed = body.password === undefined || body.password === null ? '' : String(body.password).trim();
		const enabled = body.enabled === undefined ? current.enabled : body.enabled === true;
		if (!host && (enabled || requireHost)) {
			throw proxyError(400, '请填写主机');
		}
		const settings: GlobalProxySettings = {
			enabled,
			protocol,
			host,
			port,
			type,
			username,
			password: username ? typed || current.password : '',
			poolSize: checkedPoolSize(pick('poolSize'), type === 'rotating' && !!host),
			loginsPerMinute: checkedLoginLimit(pick('loginsPerMinute'))
		};
		if (type === 'static') {
			settings.poolSize = 0;
			if (isProxyTemplate(buildProxyUrl(settings))) {
				throw proxyError(400, '静态代理只有一个 IP,用户名里不要写 {n}');
			}
		} else if (host && !isProxyTemplate(globalProxyUrl(settings))) {
			throw proxyError(400, '轮换代理要能给每个账号固定一个 IP:webshare 的用户名以 -rotate 结尾,别家在用户名里用 {n} 标出编号的位置;做不到的类型选「静态」');
		}
		return settings;
	}

	/**
	 * 设全局代理:各项不传的照旧(密码留空保留原来的),enabled 关了就直连。
	 * 已分的编号还在新的 IP 数量以内的照旧,超出的下次用时重新分。登录速率限制改了马上按新的放行排队的登录
	 */
	function setGlobal(body: GlobalProxyBody): PublicProxyConfig {
		const global = checkedGlobal(body, false);
		for (const [key, index] of assigned) {
			if (index > Math.max(1, global.poolSize)) {
				assigned.delete(key);
			}
		}
		const result = save({...config, global});
		logins.update();
		return result;
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
	 * 测代理:传了 host 测页面上还没保存的全局代理各项,传了 proxy 测填的地址(账号的单独代理),
	 * 都没有测这个账号(或全局)现在用的;轮换代理测还没保存的(或认不出账号的)随机挑池里一个编号。
	 * 回出口 IP 和耗时,再顺带打开一次 Steam 社区看这个 IP 有没有被限流;两次请求是同一个编号(同一个 IP)
	 */
	async function test(body: GlobalProxyBody & {proxy?: unknown; accountName?: unknown}): Promise<ProxyTestResult> {
		const form = body.host !== undefined ? checkedGlobal(body, true) : null;
		let proxyUrl = form ? globalProxyUrl(form) : String(body.proxy ?? '').trim() ? checkedProxyUrl(body.proxy) : proxyFor(body.accountName);
		if (isProxyTemplate(proxyUrl)) {
			const size = Math.max(1, form ? form.poolSize : config.global.poolSize);
			proxyUrl = fillProxyTemplate(proxyUrl, 1 + Math.min(size - 1, Math.floor(random() * size)));
		}
		if (!proxyUrl) {
			throw proxyError(400, body.accountName ? '这个账号现在不走代理' : config.global.host ? '全局代理没启用' : '还没有设置代理');
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

	return {proxyFor, proxyForCookies, queueLogin, fetch: steamFetch, publicConfig, setGlobal, setAccount, test};
}

export type ProxyService = ReturnType<typeof createProxyService>;
