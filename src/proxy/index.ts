// Steam 代理池(照 SteamLabs 的代理模块做):代理可以有很多个,能分组、检测、导入;账号可以绑定代理和代理组,
// 账户分组也能关联代理组。只给 Steam 的请求用,C5(在售查询要服务器 IP 白名单)、悠悠、汇率、GitHub 版本检查照旧直连。
//
// 账号用哪些代理:
//   - 单独设了「不走代理」的直连;
//   - 绑定了代理 / 代理组(账号自己的,加上所在账户分组关联的代理组,合在一起)的只用这些里启用着的;
//     绑定的代理全停用了就拒绝(登录、请求都不发,不会退回用别的代理或直连);绑定的都删光了算没绑定;
//   - 没绑定的用代理池:所有启用着、没被账号单独绑定的代理(绑给账号的代理是那个账号专用的,别的账号用不到);
//     池里没有代理就直连。
// 从可用的里给每个账号挑一个(检测健康或还没测过的优先,尽量分散到不同代理 / 不同 IP),这次运行里一直用它,
// 重新登录、掉线重连都不换;它被停用、删掉、不在账号能用的范围里了才重新挑。分配只记在内存里,重启后重新分。
// 认不出账号的请求(查价格、nameid)当作一个账号('')一样分。
//
// 类型:静态是一个固定出口 IP;轮换是提供商换出口 IP 的入口。轮换代理填了「IP 数量」就按账号固定 IP:
// 编号 1 到 IP 数量对应池里的一个个 IP(webshare 的「用户名-rotate」换成「用户名-编号」就是代理列表里第几个;
// 别家在用户名里用 {n} 标出编号的位置),每个账号分一个编号;没填的每个新连接由提供商换 IP(每个账号各用各的连接)。
//
// 用在三个地方:steam-user 的登录连接(建客户端时按账号名取,改了要重新登录才换);走 fetch 的 Steam 请求
// (按 Cookie 里 steamLoginSecure 的 SteamID 找到账号);steamcommunity(手机确认、交易报价)和充值码的 steamstore。
// 登录速率限制按代理算:经同一个代理开始的 Steam 登录每分钟最多几次,超出的排队(./login-limit.ts)。

import {randomUUID} from 'node:crypto';
import {buildProxyUrl, createProxyFetch, fillProxyTemplate, isProxyTemplate, maskProxyUrl, parseProxyUrl, PROXY_INDEX_PLACEHOLDER} from '../core/proxy.ts';
import type {ProxyFetchOptions, ProxyProtocol} from '../core/proxy.ts';
import {GROUP_COLORS, newStoredProxy, PROXY_KINDS} from '../store/proxies.ts';
import type {AccountBinding, ProxyCheck, ProxyConfig, ProxyGroup, ProxyKind, ProxyStore, StoredProxy} from '../store/proxies.ts';
import {checkProxy, DEFAULT_IP_URLS, DEFAULT_STEAM_HOME_URL, DEFAULT_STEAM_MARKET_URL} from './check.ts';
import {parseProxyList} from './import.ts';
import type {ProxyLineError} from './import.ts';
import {createLoginLimiter} from './login-limit.ts';
import type {LoginLimiter, LoginLimiterOptions, LoginSlot} from './login-limit.ts';
import type {ProxyUsageReport, UsageMeter} from './usage.ts';

export type {AccountBinding, ProxyCheck, ProxyGroup, ProxyKind} from '../store/proxies.ts';

const STEAM_HOST = /(^|\.)(steampowered\.com|steamcommunity\.com|steamstatic\.com|steamcontent\.com|steamserver\.net|steam-chat\.com)$/i;
/** IP 数量的上限(webshare 之类按代理数量编号,够用了) */
const MAX_POOL_SIZE = 100000;
/** webshare 轮换入口的用户名后缀:换成「-编号」就是代理列表里的第几个(一个固定 IP) */
const WEBSHARE_ROTATE = /-rotate$/i;
/** 登录速率限制的上限(每分钟) */
const MAX_LOGINS_PER_MINUTE = 10000;
const MAX_PROXIES = 5000;
const NOTES_MAX = 500;
export const GROUP_NAME_MAX = 20;
/** 轮换代理检测时采样几次出口 IP */
const ROTATING_SAMPLES = 3;
/** 同时检测几个代理 */
const CHECK_CONCURRENCY = 4;
/** 检测结果晚多久存盘(连着测完的合成一次写) */
const CHECK_SAVE_DELAY_MS = 2000;

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

/** 代理的地址;按账号固定 IP 的轮换代理是带 {n} 的模板(webshare 的「用户名-rotate」换成「用户名-{n}」) */
export function proxyTemplate(proxy: Pick<StoredProxy, 'protocol' | 'host' | 'port' | 'type' | 'username' | 'password' | 'poolSize'>): string {
	const plain = buildProxyUrl(proxy);
	if (proxy.type !== 'rotating' || proxy.poolSize < 1 || isProxyTemplate(plain) || !WEBSHARE_ROTATE.test(proxy.username)) {
		return plain;
	}
	return buildProxyUrl({...proxy, username: proxy.username.replace(WEBSHARE_ROTATE, `-${PROXY_INDEX_PLACEHOLDER}`)});
}

/** 按账号固定 IP:轮换、填了 IP 数量、知道编号写在哪 */
export function isSticky(proxy: Parameters<typeof proxyTemplate>[0]): boolean {
	return proxy.type === 'rotating' && proxy.poolSize > 0 && isProxyTemplate(proxyTemplate(proxy));
}

/** 账号用着的代理:index 是按账号固定 IP 的编号,别的为 0 */
export interface ProxySlot {
	proxyId: string;
	index: number;
}

export type ProxyStatus = 'untested' | 'checking' | ProxyCheck['status'];

/** 下发给页面的代理:不带密码 */
export interface PublicProxy extends Omit<StoredProxy, 'password'> {
	hasPassword: boolean;
	/** 主机:端口 */
	endpoint: string;
	/** 按账号固定 IP */
	sticky: boolean;
	status: ProxyStatus;
}

export interface PublicProxyState {
	proxies: PublicProxy[];
	groups: ProxyGroup[];
	/** 账号名小写 → 绑定;没有的用代理池 */
	accounts: Record<string, AccountBinding>;
	/** 账户分组 id → 关联的代理组 */
	accountGroups: Record<string, string[]>;
	/** 这次运行里各账号用着哪个代理(账号名小写;'' 是认不出账号的请求) */
	assigned: Record<string, ProxySlot>;
}

export interface ProxyServiceOptions {
	store: ProxyStore;
	/** SteamID → 账号名;找不到为 '' */
	accountForSteamId(steamId: string): string;
	/** 账户分组:账号在哪个组('' 未分组)、组还在不在 */
	accountGroups?: {groupOf(accountName: string): string; exists(id: string): boolean};
	/** 直连用的 fetch(测试注入) */
	fetch?: typeof fetch;
	createProxyFetch?: (proxyUrl: string, options?: ProxyFetchOptions) => typeof fetch;
	/** 检测时查出口 IP 的地址(只用它);不传按 ipinfo → ipify */
	testUrl?: string;
	/** 检测时打开的 Steam 社区市场页 */
	steamTestUrl?: string;
	/** 检测时打开的 Steam 社区首页 */
	steamHomeUrl?: string;
	now?: () => number;
	/** 挑代理、编号用的随机数(测试注入) */
	random?: () => number;
	/** 登录速率限制用的时钟和定时器(测试注入) */
	loginClock?: Pick<LoginLimiterOptions, 'now' | 'setTimer' | 'clearTimer'>;
	/** 记代理用量 */
	usage?: Pick<UsageMeter, 'record' | 'report'>;
	/** 代理、绑定、检测状态、分配变了(推给页面);连着变的合成一次 */
	onChange?: () => void;
	checkConcurrency?: number;
	/** 检测结果晚多久存盘;0 马上存(测试用) */
	checkSaveDelayMs?: number;
}

/** 新建 / 修改代理时页面传的各项;改的时候不传的照旧,password 不传或 '' 保留原来的 */
export interface ProxyBody {
	id?: unknown;
	enabled?: unknown;
	protocol?: unknown;
	host?: unknown;
	port?: unknown;
	type?: unknown;
	username?: unknown;
	password?: unknown;
	poolSize?: unknown;
	loginsPerMinute?: unknown;
	notes?: unknown;
	groupIds?: unknown;
}

export interface ImportResult {
	state: PublicProxyState;
	added: number;
	/** 已经有了(或这次粘贴里重复)跳过的 */
	duplicates: number;
	errors: ProxyLineError[];
}

type Candidates = {kind: 'direct'} | {kind: 'refused'; reason: string} | {kind: 'proxies'; proxies: StoredProxy[]};

function proxyError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function errorText(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : String(err);
}

const blank = (raw: unknown) => raw === undefined || raw === null || raw === '' || raw === 0;
const idList = (raw: unknown) => (Array.isArray(raw) ? [...new Set(raw.map(item => String(item ?? '')).filter(Boolean))] : []);

/** 主机:域名或 IP(IPv6 带方括号),可以带 {n};协议、端口、账号密码不能混进来 */
function checkedHost(raw: unknown): string {
	const text = String(raw ?? '').trim();
	if (!text) {
		throw proxyError(400, '请填写主机');
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

function checkedPort(raw: unknown): number {
	if (blank(raw)) {
		throw proxyError(400, '请填写端口');
	}
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw proxyError(400, '端口要是 1 到 65535 的整数');
	}
	return port;
}

/** 登录速率限制:每分钟次数,留空(或 0)不限 */
function checkedLoginLimit(raw: unknown): number {
	if (blank(raw)) {
		return 0;
	}
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOGINS_PER_MINUTE) {
		throw proxyError(400, '登录速率限制填每分钟次数(正整数),留空不限');
	}
	return limit;
}

/** IP 数量:轮换代理选填(1 到上限的整数),静态代理不用 */
function checkedPoolSize(raw: unknown): number {
	if (blank(raw)) {
		return 0;
	}
	const size = Number(raw);
	if (!Number.isInteger(size) || size < 1 || size > MAX_POOL_SIZE) {
		throw proxyError(400, `IP 数量要是 1 到 ${MAX_POOL_SIZE} 的整数`);
	}
	return size;
}

function checkedProtocol(raw: unknown): ProxyProtocol {
	const protocol = String(raw ?? '').trim().toLowerCase();
	if (/^socks/.test(protocol)) {
		throw proxyError(400, '暂不支持 SOCKS5 代理,协议选 HTTP');
	}
	if (protocol !== 'http' && protocol !== 'https') {
		throw proxyError(400, '协议只能是 HTTP 或 HTTPS');
	}
	return protocol;
}

function checkedKind(raw: unknown): ProxyKind {
	const type = String(raw ?? '') as ProxyKind;
	if (!PROXY_KINDS.includes(type)) {
		throw proxyError(400, '类型只能是 静态 或 轮换');
	}
	return type;
}

/** 连接方式(协议、主机、端口、类型、账号密码、IP 数量)变了:检测结果作废 */
function connectionKey(proxy: Pick<StoredProxy, 'protocol' | 'host' | 'port' | 'type' | 'username' | 'password' | 'poolSize'>): string {
	return [proxy.protocol, proxy.host.toLowerCase(), proxy.port, proxy.type, proxy.username, proxy.password, proxy.poolSize].join('\n');
}

/** 同一个代理(协议、主机、端口、用户名都一样) */
function sameEndpoint(a: Pick<StoredProxy, 'protocol' | 'host' | 'port' | 'username'>, b: Pick<StoredProxy, 'protocol' | 'host' | 'port' | 'username'>): boolean {
	return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.username === b.username;
}

export function createProxyService(options: ProxyServiceOptions) {
	const direct: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const makeFetch = options.createProxyFetch ?? createProxyFetch;
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	let config: ProxyConfig = options.store.load();
	/** 这次运行里各账号用着哪个代理(账号名小写);不存盘,重启后重新分 */
	const assigned = new Map<string, ProxySlot>();
	/** 正在检测的代理 */
	const checking = new Set<string>();
	/** 每个代理一个登录速率限制 */
	const limiters = new Map<string, LoginLimiter>();
	/**
	 * 「账号 + 代理地址」→ 走它的 fetch。每个账号各用各的长连接,账号之间的连接不混
	 * (按连接换 IP 的轮换代理下,同一账号一段时间内 IP 也稳定)
	 */
	const fetchers = new Map<string, typeof fetch>();
	/** SteamID → 账号名,只记找到的 */
	const steamIds = new Map<string, string>();

	// ===== 变化通知(连着变的合成一次) =====
	let notifyTimer: ReturnType<typeof setTimeout> | null = null;
	function changed(): void {
		if (!options.onChange || notifyTimer) {
			return;
		}
		notifyTimer = setTimeout(() => {
			notifyTimer = null;
			options.onChange?.();
		}, 50);
		notifyTimer.unref?.();
	}

	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	function persist(next: ProxyConfig): void {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		options.store.save(next);
		config = next;
		changed();
	}

	/**
	 * 检测结果:马上用(页面马上看到),晚一点再存盘,连着测完的合成一次写(整份配置加密后写一遍,测全部时不用每个都写)。
	 * 期间有别的改动会顺带存上
	 */
	function persistSoon(next: ProxyConfig): void {
		config = next;
		changed();
		const delay = options.checkSaveDelayMs ?? CHECK_SAVE_DELAY_MS;
		if (delay <= 0) {
			options.store.save(config);
		} else if (!saveTimer) {
			saveTimer = setTimeout(() => {
				saveTimer = null;
				options.store.save(config);
			}, delay);
			saveTimer.unref?.();
		}
	}

	const keyOf = (accountName: unknown) => String(accountName || '').trim().toLowerCase();
	const proxyById = (id: string) => config.proxies.find(proxy => proxy.id === id);

	function findProxy(id: unknown): StoredProxy {
		const proxy = proxyById(String(id ?? ''));
		if (!proxy) {
			throw proxyError(404, '代理不存在');
		}
		return proxy;
	}

	function findGroup(id: unknown): ProxyGroup {
		const group = config.groups.find(item => item.id === String(id ?? ''));
		if (!group) {
			throw proxyError(404, '代理组不存在');
		}
		return group;
	}

	/** 这些 id 都得是存在的代理组 */
	function checkedGroupIds(raw: unknown): string[] {
		const ids = idList(raw);
		for (const id of ids) {
			findGroup(id);
		}
		return ids;
	}

	const slotsOf = (proxy: StoredProxy) => (isSticky(proxy) ? proxy.poolSize : 1);

	function urlOf(proxy: StoredProxy, index: number): string {
		const template = proxyTemplate(proxy);
		return isSticky(proxy) ? fillProxyTemplate(template, Math.max(1, index)) : template;
	}

	/** 被账号单独绑定的代理(不进公共池) */
	function pinnedIds(): Set<string> {
		const ids = new Set<string>();
		for (const binding of Object.values(config.accounts)) {
			if (binding.mode === 'bind') {
				binding.proxyIds.forEach(id => ids.add(id));
			}
		}
		return ids;
	}

	/** 账号能用的代理 */
	function candidatesFor(key: string): Candidates {
		const binding = key ? config.accounts[key] : undefined;
		if (binding?.mode === 'direct') {
			return {kind: 'direct'};
		}
		const groupIds = new Set(binding?.mode === 'bind' ? binding.groupIds : []);
		const accountGroup = key ? options.accountGroups?.groupOf(key) ?? '' : '';
		for (const id of accountGroup ? config.accountGroups[accountGroup] ?? [] : []) {
			groupIds.add(id);
		}
		const proxyIds = new Set(binding?.mode === 'bind' ? binding.proxyIds : []);
		const bound = config.proxies.filter(proxy => proxyIds.has(proxy.id) || proxy.groupIds.some(id => groupIds.has(id)));
		if (bound.length) {
			const enabled = bound.filter(proxy => proxy.enabled);
			return enabled.length
				? {kind: 'proxies', proxies: enabled}
				: {kind: 'refused', reason: `绑定的 ${bound.length} 个代理都已停用,不登录、不发 Steam 请求(到「代理管理」启用,或改账号的代理设置)`};
		}
		const pinned = pinnedIds();
		const pool = config.proxies.filter(proxy => proxy.enabled && !pinned.has(proxy.id));
		return pool.length ? {kind: 'proxies', proxies: pool} : {kind: 'direct'};
	}

	function slotValid(slot: ProxySlot, proxies: readonly StoredProxy[]): boolean {
		const proxy = proxies.find(item => item.id === slot.proxyId);
		if (!proxy) {
			return false;
		}
		return isSticky(proxy) ? slot.index >= 1 && slot.index <= proxy.poolSize : slot.index === 0;
	}

	/** 挑一个:健康或没测过的优先;按「账号数 / IP 数」挑最空的代理,按账号固定 IP 的再挑没人用的编号 */
	function pickSlot(key: string, proxies: readonly StoredProxy[]): ProxySlot {
		const good = proxies.filter(proxy => !proxy.check || proxy.check.status === 'healthy' || checking.has(proxy.id));
		const pool = good.length ? good : proxies;
		const used = new Map<string, Map<number, number>>();
		for (const [other, slot] of assigned) {
			if (other === key) {
				continue;
			}
			const indexes = used.get(slot.proxyId) ?? new Map<number, number>();
			indexes.set(slot.index, (indexes.get(slot.index) ?? 0) + 1);
			used.set(slot.proxyId, indexes);
		}
		const loadOf = (proxy: StoredProxy) => [...(used.get(proxy.id)?.values() ?? [])].reduce((sum, value) => sum + value, 0) / slotsOf(proxy);
		const least = Math.min(...pool.map(loadOf));
		const lightest = pool.filter(proxy => loadOf(proxy) === least);
		const proxy = lightest[Math.min(lightest.length - 1, Math.floor(random() * lightest.length))]!;
		if (!isSticky(proxy)) {
			return {proxyId: proxy.id, index: 0};
		}
		const taken = used.get(proxy.id) ?? new Map<number, number>();
		const size = proxy.poolSize;
		const randomIndex = () => 1 + Math.min(size - 1, Math.floor(random() * size));
		if (taken.size < size) {
			for (let tries = 0; tries < 32; tries++) {
				const index = randomIndex();
				if (!taken.has(index)) {
					return {proxyId: proxy.id, index};
				}
			}
			const start = randomIndex();
			for (let offset = 0; offset < size; offset++) {
				const index = ((start - 1 + offset) % size) + 1;
				if (!taken.has(index)) {
					return {proxyId: proxy.id, index};
				}
			}
		}
		// 编号都有人用了:挑用的人最少的
		let best = randomIndex();
		for (let index = 1; index <= size; index++) {
			if ((taken.get(index) ?? 0) < (taken.get(best) ?? 0)) {
				best = index;
			}
		}
		return {proxyId: proxy.id, index: best};
	}

	/** 账号这次用哪个代理:null 为直连;绑定的代理都停用了抛 409 */
	function resolve(key: string): {proxy: StoredProxy; slot: ProxySlot} | null {
		const candidates = candidatesFor(key);
		if (candidates.kind === 'direct') {
			return null;
		}
		if (candidates.kind === 'refused') {
			throw proxyError(409, candidates.reason);
		}
		let slot = assigned.get(key);
		if (!slot || !slotValid(slot, candidates.proxies)) {
			slot = pickSlot(key, candidates.proxies);
			assigned.set(key, slot);
			changed();
		}
		return {proxy: proxyById(slot.proxyId)!, slot};
	}

	/** 这个账号的 Steam 请求用哪个代理;'' 为直连。不传账号名是认不出账号的请求。绑定的代理都停用了抛错(statusCode 409) */
	function proxyFor(accountName?: unknown): string {
		const resolved = resolve(keyOf(accountName));
		return resolved ? urlOf(resolved.proxy, resolved.slot.index) : '';
	}

	/** 这个账号现在能不能登录:能为 '',不能是原因(绑定的代理都停用了) */
	function loginRefusal(accountName: unknown): string {
		const candidates = candidatesFor(keyOf(accountName));
		return candidates.kind === 'refused' ? candidates.reason : '';
	}

	function limiterFor(proxyId: string): LoginLimiter {
		let limiter = limiters.get(proxyId);
		if (!limiter) {
			limiter = createLoginLimiter({limit: () => proxyById(proxyId)?.loginsPerMinute ?? 0, ...options.loginClock});
			limiters.set(proxyId, limiter);
		}
		return limiter;
	}

	/**
	 * 开始一次 Steam 登录前调(登录速率限制):账号要用的代理设了每分钟次数的,超出就排队。
	 * 返回 null 直接登录;否则等 ready,false 表示轮到时 cancelled() 已经为真(不用登录了)。直连、被拒绝的不排队
	 */
	function queueLogin(accountName: unknown, cancelled?: () => boolean): LoginSlot | null {
		let resolved;
		try {
			resolved = resolve(keyOf(accountName));
		} catch {
			return null;
		}
		return resolved ? limiterFor(resolved.proxy.id).acquire(cancelled) : null;
	}

	function fetcherFor(proxy: StoredProxy, proxyUrl: string, accountKey: string): typeof fetch {
		const key = `${accountKey}\n${proxyUrl}`;
		let fetcher = fetchers.get(key);
		if (!fetcher) {
			// 这个账号换了代理(改设置、换了编号):旧的那套连接不再用
			for (const old of fetchers.keys()) {
				if (old.startsWith(`${accountKey}\n`)) {
					fetchers.delete(old);
				}
			}
			const proxyId = proxy.id;
			fetcher = makeFetch(proxyUrl, {
				onTraffic: traffic => options.usage?.record({proxyId, account: accountKey, url: traffic.url, sent: traffic.sent, received: traffic.received})
			});
			fetchers.set(key, fetcher);
		}
		return fetcher;
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

	/** 按 cookie 里的账号取代理;没 cookie、认不出账号的当作认不出账号的请求 */
	function proxyForCookies(cookies: string | readonly string[]): string {
		return proxyFor(accountOfCookies(cookies));
	}

	/** 给 Steam 模块用的 fetch:Steam 的地址按 Cookie 选代理(每个账号各自的连接),别的地址直连 */
	const steamFetch: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (!isSteamHost(url.hostname)) {
			return direct(input, init);
		}
		const cookie = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('cookie') ?? '';
		const key = accountOfCookies(cookie).toLowerCase();
		const resolved = resolve(key);
		if (!resolved) {
			return direct(input, init);
		}
		return fetcherFor(resolved.proxy, urlOf(resolved.proxy, resolved.slot.index), key)(input, init);
	};

	// ===== 下发给页面 =====
	function publicProxy(proxy: StoredProxy): PublicProxy {
		const {password, ...rest} = proxy;
		return {
			...rest,
			groupIds: [...proxy.groupIds],
			hasPassword: !!password,
			endpoint: `${proxy.host}:${proxy.port}`,
			sticky: isSticky(proxy),
			status: checking.has(proxy.id) ? 'checking' : proxy.check?.status ?? 'untested'
		};
	}

	function state(): PublicProxyState {
		return {
			proxies: config.proxies.map(publicProxy),
			groups: config.groups.map(group => ({...group})),
			accounts: structuredClone(config.accounts),
			accountGroups: structuredClone(config.accountGroups),
			assigned: Object.fromEntries([...assigned].map(([key, slot]) => [key, {...slot}]))
		};
	}

	function save(next: ProxyConfig): PublicProxyState {
		persist(next);
		// 用着的代理被停用、删掉、不在账号能用的范围里了:去掉,下次用时重新挑(页面上不显示过时的分配)
		for (const [key, slot] of assigned) {
			const candidates = candidatesFor(key);
			if (candidates.kind !== 'proxies' || !slotValid(slot, candidates.proxies)) {
				assigned.delete(key);
			}
		}
		// 改了登录速率限制、停用了代理:排队的按新的放行
		for (const limiter of limiters.values()) {
			limiter.update();
		}
		return state();
	}

	// ===== 代理 =====
	/**
	 * 页面传的各项和现在的合起来校验(新建时 current 为 null)。密码不传或 '' 保留原来的,用户名清空时密码一起清。
	 * 轮换代理填了 IP 数量要能把编号写进地址;静态代理不能带 {n}
	 */
	function checkedProxy(body: ProxyBody, current: StoredProxy | null): StoredProxy {
		const base = current ?? newStoredProxy({createdAt: now()});
		const pick = (key: keyof ProxyBody & keyof StoredProxy): unknown => (body[key] === undefined ? base[key] : body[key]);
		const username = String(pick('username') ?? '').trim();
		const typed = body.password === undefined || body.password === null ? '' : String(body.password).trim();
		const next: StoredProxy = {
			...base,
			protocol: checkedProtocol(pick('protocol')),
			host: checkedHost(pick('host')),
			port: checkedPort(pick('port')),
			type: checkedKind(pick('type')),
			username,
			password: username ? typed || base.password : '',
			poolSize: checkedPoolSize(pick('poolSize')),
			loginsPerMinute: checkedLoginLimit(pick('loginsPerMinute')),
			enabled: body.enabled === undefined ? base.enabled : body.enabled === true,
			notes: String(pick('notes') ?? '').trim().slice(0, NOTES_MAX),
			groupIds: body.groupIds === undefined ? [...base.groupIds] : checkedGroupIds(body.groupIds)
		};
		const plain = buildProxyUrl(next);
		if (next.type === 'static') {
			next.poolSize = 0;
			if (isProxyTemplate(plain)) {
				throw proxyError(400, '静态代理只有一个 IP,用户名里不要写 {n}');
			}
		} else if (next.poolSize && !isSticky(next)) {
			throw proxyError(400, '填了 IP 数量要能把编号写进地址:webshare 的用户名以 -rotate 结尾,别家在用户名里用 {n} 标出编号的位置;不用每个账号固定 IP 就把 IP 数量留空');
		} else if (!next.poolSize && isProxyTemplate(plain)) {
			throw proxyError(400, '用户名里写了 {n},要填 IP 数量(编号从 1 到几)');
		}
		if (current && connectionKey(current) !== connectionKey(next)) {
			next.check = null;
		}
		return next;
	}

	function assertUnique(proxy: StoredProxy): void {
		if (config.proxies.some(other => other.id !== proxy.id && sameEndpoint(other, proxy))) {
			throw proxyError(409, `已经有 ${proxy.host}:${proxy.port}${proxy.username ? `(用户名 ${proxy.username})` : ''} 这个代理了`);
		}
	}

	function createProxy(body: ProxyBody): {state: PublicProxyState; proxy: PublicProxy} {
		if (config.proxies.length >= MAX_PROXIES) {
			throw proxyError(400, `最多 ${MAX_PROXIES} 个代理`);
		}
		const proxy = checkedProxy(body, null);
		assertUnique(proxy);
		const result = save({...config, proxies: [...config.proxies, proxy]});
		return {state: result, proxy: publicProxy(proxy)};
	}

	function updateProxy(body: ProxyBody): {state: PublicProxyState; proxy: PublicProxy} {
		const current = findProxy(body.id);
		const proxy = checkedProxy(body, current);
		assertUnique(proxy);
		const result = save({...config, proxies: config.proxies.map(item => (item.id === proxy.id ? proxy : item))});
		return {state: result, proxy: publicProxy(proxy)};
	}

	/** 删掉代理:账号绑定里去掉它(绑定空了算没绑定,用代理池),用着它的账号下次重新分 */
	function deleteProxies(body: {ids?: unknown}): PublicProxyState {
		const ids = new Set(idList(body.ids));
		if (!ids.size) {
			throw proxyError(400, '没选代理');
		}
		const accounts: Record<string, AccountBinding> = {};
		for (const [key, binding] of Object.entries(config.accounts)) {
			if (binding.mode === 'bind') {
				const proxyIds = binding.proxyIds.filter(id => !ids.has(id));
				if (proxyIds.length || binding.groupIds.length) {
					accounts[key] = {...binding, proxyIds};
				}
			} else {
				accounts[key] = binding;
			}
		}
		for (const [key, slot] of assigned) {
			if (ids.has(slot.proxyId)) {
				assigned.delete(key);
			}
		}
		for (const id of ids) {
			limiters.delete(id);
		}
		return save({...config, proxies: config.proxies.filter(proxy => !ids.has(proxy.id)), accounts});
	}

	/** 批量:启用、停用、设登录速率限制、加入 / 移出代理组 */
	function bulk(body: {ids?: unknown; action?: unknown; value?: unknown}): PublicProxyState {
		const ids = new Set(idList(body.ids));
		if (!ids.size) {
			throw proxyError(400, '没选代理');
		}
		let change: (proxy: StoredProxy) => StoredProxy;
		switch (String(body.action || '')) {
			case 'enable':
				change = proxy => ({...proxy, enabled: true});
				break;
			case 'disable':
				change = proxy => ({...proxy, enabled: false});
				break;
			case 'loginLimit': {
				const limit = checkedLoginLimit(body.value);
				change = proxy => ({...proxy, loginsPerMinute: limit});
				break;
			}
			case 'addGroups': {
				const groupIds = checkedGroupIds(body.value);
				change = proxy => ({...proxy, groupIds: [...new Set([...proxy.groupIds, ...groupIds])]});
				break;
			}
			case 'removeGroups': {
				const groupIds = new Set(checkedGroupIds(body.value));
				change = proxy => ({...proxy, groupIds: proxy.groupIds.filter(id => !groupIds.has(id))});
				break;
			}
			default:
				throw proxyError(400, '不认识的批量操作');
		}
		return save({...config, proxies: config.proxies.map(proxy => (ids.has(proxy.id) ? change(proxy) : proxy))});
	}

	/** 导入:每行一个,已经有的(协议、主机、端口、用户名一样)跳过;拆不开、不合法的按行号回原因 */
	function importProxies(body: {text?: unknown; protocol?: unknown; type?: unknown; enabled?: unknown; groupIds?: unknown}): ImportResult {
		const protocol = checkedProtocol(body.protocol ?? 'http');
		const type = checkedKind(body.type);
		const groupIds = checkedGroupIds(body.groupIds);
		const parsed = parseProxyList(String(body.text ?? ''), protocol);
		const errors = [...parsed.errors];
		const added: StoredProxy[] = [];
		let duplicates = 0;
		for (const line of parsed.proxies) {
			let proxy: StoredProxy;
			try {
				proxy = checkedProxy({...line, type, enabled: body.enabled !== false, groupIds}, null);
			} catch (err) {
				errors.push({line: line.line, error: errorText(err)});
				continue;
			}
			if ([...config.proxies, ...added].some(other => sameEndpoint(other, proxy))) {
				duplicates++;
				continue;
			}
			added.push(proxy);
		}
		if (!added.length && !duplicates && !errors.length) {
			throw proxyError(400, '请粘贴代理列表,每行一个');
		}
		if (config.proxies.length + added.length > MAX_PROXIES) {
			throw proxyError(400, `最多 ${MAX_PROXIES} 个代理`);
		}
		errors.sort((a, b) => a.line - b.line);
		const result = added.length ? save({...config, proxies: [...config.proxies, ...added]}) : state();
		return {state: result, added: added.length, duplicates, errors};
	}

	// ===== 代理组 =====
	/** 去掉首尾和多余空白;不能空、不能太长、不能和别的代理组重名(不分大小写) */
	function groupName(raw: unknown, selfId = ''): string {
		const name = String(raw ?? '').trim().replace(/\s+/gu, ' ');
		if (!name) {
			throw proxyError(400, '代理组名不能为空');
		}
		if ([...name].length > GROUP_NAME_MAX) {
			throw proxyError(400, `代理组名最多 ${GROUP_NAME_MAX} 个字`);
		}
		if (config.groups.some(group => group.id !== selfId && group.name.toLowerCase() === name.toLowerCase())) {
			throw proxyError(409, `已经有叫「${name}」的代理组`);
		}
		return name;
	}

	function groupColor(raw: unknown, fallback: string = GROUP_COLORS[0]): string {
		const color = raw === undefined ? fallback : String(raw);
		if (!(GROUP_COLORS as readonly string[]).includes(color)) {
			throw proxyError(400, '颜色不对');
		}
		return color;
	}

	/** 新建代理组;带 proxyIds 时顺便把这些代理加进去 */
	function createGroup(body: {name?: unknown; color?: unknown; proxyIds?: unknown}): {state: PublicProxyState; group: ProxyGroup} {
		const group: ProxyGroup = {id: randomUUID(), name: groupName(body.name), color: groupColor(body.color), createdAt: now()};
		const ids = new Set(idList(body.proxyIds));
		const proxies = config.proxies.map(proxy => (ids.has(proxy.id) ? {...proxy, groupIds: [...proxy.groupIds, group.id]} : proxy));
		return {state: save({...config, groups: [...config.groups, group], proxies}), group};
	}

	function updateGroup(body: {id?: unknown; name?: unknown; color?: unknown}): PublicProxyState {
		const current = findGroup(body.id);
		const group = {
			...current,
			name: body.name === undefined ? current.name : groupName(body.name, current.id),
			color: groupColor(body.color, current.color)
		};
		return save({...config, groups: config.groups.map(item => (item.id === group.id ? group : item))});
	}

	/** 删代理组:代理不删;账号、账户分组上的这个组去掉(只绑了这个组的账号退回用代理池) */
	function deleteGroup(body: {id?: unknown}): PublicProxyState {
		const {id} = findGroup(body.id);
		const accounts: Record<string, AccountBinding> = {};
		for (const [key, binding] of Object.entries(config.accounts)) {
			if (binding.mode === 'bind') {
				const groupIds = binding.groupIds.filter(item => item !== id);
				if (binding.proxyIds.length || groupIds.length) {
					accounts[key] = {...binding, groupIds};
				}
			} else {
				accounts[key] = binding;
			}
		}
		const accountGroups: Record<string, string[]> = {};
		for (const [key, ids] of Object.entries(config.accountGroups)) {
			const rest = ids.filter(item => item !== id);
			if (rest.length) {
				accountGroups[key] = rest;
			}
		}
		return save({
			proxies: config.proxies.map(proxy => ({...proxy, groupIds: proxy.groupIds.filter(item => item !== id)})),
			groups: config.groups.filter(group => group.id !== id),
			accounts,
			accountGroups
		});
	}

	// ===== 账号 =====
	function accountKeys(raw: unknown): string[] {
		const keys = [...new Set((Array.isArray(raw) ? raw : []).map(keyOf).filter(Boolean))];
		if (!keys.length) {
			throw proxyError(400, '没选账号');
		}
		return keys;
	}

	/**
	 * 设账号的代理:pool 用代理池(去掉绑定)、direct 不走代理、bind 只用选的代理和代理组(替换原来的绑定)。
	 * 已登录的账号要重新登录,登录连接才换
	 */
	function bindAccounts(body: {accountNames?: unknown; mode?: unknown; proxyIds?: unknown; groupIds?: unknown}): PublicProxyState {
		const keys = accountKeys(body.accountNames);
		const accounts = {...config.accounts};
		const mode = String(body.mode || '');
		if (mode === 'pool') {
			keys.forEach(key => delete accounts[key]);
		} else if (mode === 'direct') {
			keys.forEach(key => (accounts[key] = {mode: 'direct'}));
		} else if (mode === 'bind') {
			const proxyIds = idList(body.proxyIds);
			proxyIds.forEach(id => findProxy(id));
			const groupIds = checkedGroupIds(body.groupIds);
			if (!proxyIds.length && !groupIds.length) {
				throw proxyError(400, '选至少一个代理或代理组');
			}
			keys.forEach(key => (accounts[key] = {mode: 'bind', proxyIds: [...proxyIds], groupIds: [...groupIds]}));
		} else {
			throw proxyError(400, '代理方式只能是 pool / direct / bind');
		}
		return save({...config, accounts});
	}

	/** 从选的代理里给每个账号绑一个(先给没被别的账号绑定的,尽量一个账号一个;代理不够就有人共用) */
	function distributeProxies(body: {accountNames?: unknown; proxyIds?: unknown}): PublicProxyState & {pairs: Record<string, string>} {
		const keys = accountKeys(body.accountNames);
		const proxies = idList(body.proxyIds).map(id => findProxy(id));
		if (!proxies.length) {
			throw proxyError(400, '选至少一个代理');
		}
		const batch = new Set(keys);
		const load = new Map(proxies.map(proxy => [proxy.id, 0]));
		for (const [key, binding] of Object.entries(config.accounts)) {
			if (!batch.has(key) && binding.mode === 'bind') {
				binding.proxyIds.forEach(id => load.has(id) && load.set(id, load.get(id)! + 1));
			}
		}
		const accounts = {...config.accounts};
		const pairs: Record<string, string> = {};
		for (const key of keys) {
			const proxy = proxies.reduce((best, item) => (load.get(item.id)! < load.get(best.id)! ? item : best));
			load.set(proxy.id, load.get(proxy.id)! + 1);
			accounts[key] = {mode: 'bind', proxyIds: [proxy.id], groupIds: []};
			pairs[key] = proxy.id;
		}
		return {...save({...config, accounts}), pairs};
	}

	/** 账户分组关联代理组(组里每个账号都用这些代理组,和账号自己的绑定合在一起);空的去掉关联 */
	function linkAccountGroup(body: {accountGroupId?: unknown; groupIds?: unknown}): PublicProxyState {
		const id = String(body.accountGroupId ?? '');
		if (!id || (options.accountGroups && !options.accountGroups.exists(id))) {
			throw proxyError(404, '账户分组不存在');
		}
		const groupIds = checkedGroupIds(body.groupIds);
		const accountGroups = {...config.accountGroups};
		if (groupIds.length) {
			accountGroups[id] = groupIds;
		} else {
			delete accountGroups[id];
		}
		return save({...config, accountGroups});
	}

	// ===== 检测 =====
	const checkOptions = {
		makeFetch,
		ipUrls: options.testUrl ? [options.testUrl] : DEFAULT_IP_URLS,
		steamHomeUrl: options.steamHomeUrl ?? DEFAULT_STEAM_HOME_URL,
		steamMarketUrl: options.steamTestUrl ?? DEFAULT_STEAM_MARKET_URL,
		now
	};

	/** 要采样的地址:静态一个;按连接换 IP 的同一个地址几遍;按账号固定 IP 的随机几个不同编号 */
	function sampleUrls(proxy: StoredProxy): string[] {
		if (proxy.type === 'static') {
			return [urlOf(proxy, 0)];
		}
		if (!isSticky(proxy)) {
			return Array.from({length: ROTATING_SAMPLES}, () => urlOf(proxy, 0));
		}
		const indexes = new Set<number>();
		const want = Math.min(ROTATING_SAMPLES, proxy.poolSize);
		while (indexes.size < want) {
			indexes.add(1 + Math.min(proxy.poolSize - 1, Math.floor(random() * proxy.poolSize)));
		}
		return [...indexes].map(index => urlOf(proxy, index));
	}

	/** 检测一个代理;record 为假时不记用量(还没保存的新代理,id 是临时的) */
	function runCheck(proxy: StoredProxy, record = true): Promise<ProxyCheck> {
		const proxyId = proxy.id;
		return checkProxy(sampleUrls(proxy), {
			...checkOptions,
			onTraffic: record
				? traffic => options.usage?.record({proxyId, account: '', url: traffic.url, sent: traffic.sent, received: traffic.received, kind: 'check'})
				: undefined
		});
	}

	/** 检测几个代理(不传 ids 测全部):马上返回(状态是「检查中」),测完一个存一个、推一次;已经在测的不重复测 */
	function test(body: {ids?: unknown} = {}): PublicProxyState {
		const wanted = body.ids === undefined ? config.proxies.map(proxy => proxy.id) : idList(body.ids);
		const queue = wanted.map(id => proxyById(id)).filter((proxy): proxy is StoredProxy => !!proxy && !checking.has(proxy.id));
		if (!queue.length && !wanted.some(id => checking.has(id))) {
			throw proxyError(wanted.length ? 404 : 400, wanted.length ? '代理不存在' : '还没有代理');
		}
		queue.forEach(proxy => checking.add(proxy.id));
		changed();
		const worker = async () => {
			for (let proxy = queue.shift(); proxy; proxy = queue.shift()) {
				const key = connectionKey(proxy);
				let check: ProxyCheck;
				try {
					check = await runCheck(proxy);
				} catch (err) {
					check = {status: 'unreachable', latencyMs: 0, ip: '', country: '', ips: [], samples: 0, market: 0, error: errorText(err), checkedAt: now()};
				}
				checking.delete(proxy.id);
				const latest = proxyById(proxy.id);
				// 测的时候被删了、改了连接方式:这次结果不算
				if (latest && connectionKey(latest) === key) {
					persistSoon({...config, proxies: config.proxies.map(item => (item.id === latest.id ? {...item, check} : item))});
				} else {
					changed();
				}
			}
		};
		void Promise.all(Array.from({length: Math.max(1, Math.min(options.checkConcurrency ?? CHECK_CONCURRENCY, queue.length))}, worker));
		return state();
	}

	/** 测编辑页上还没保存的各项(带 id 时密码留空用存着的),回检测结果,不保存 */
	async function testDraft(body: ProxyBody): Promise<{check: ProxyCheck; proxy: string}> {
		const current = body.id ? findProxy(body.id) : null;
		const draft = checkedProxy(body, current);
		const check = await runCheck(draft, !!current);
		return {check, proxy: maskProxyUrl(sampleUrls(draft)[0]!)};
	}

	function usageReport(query: {days?: unknown; proxyId?: unknown}): ProxyUsageReport | null {
		return options.usage ? options.usage.report(query) : null;
	}

	return {
		proxyFor, proxyForCookies, loginRefusal, queueLogin, fetch: steamFetch, state,
		createProxy, updateProxy, deleteProxies, bulk, importProxies,
		createGroup, updateGroup, deleteGroup,
		bindAccounts, distributeProxies, linkAccountGroup,
		test, testDraft, usageReport
	};
}

export type ProxyService = ReturnType<typeof createProxyService>;
