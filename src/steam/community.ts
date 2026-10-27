// steamcommunity 实例工厂:统一注入够新的浏览器 User-Agent(从 app/lib/steam-community-ua.js 移来)。
//
// steamcommunity@3.50.0 构造时写死默认 UA(Chrome/118)。Steam 现在对「非浏览器 HTTP 栈 + 老版本 Chrome UA」
// 直接回 429,/mobileconf/* 全线失败,也就是所有手机令牌确认:发货接受报价后的确认、求购单确认。
// 实测同一份 cookies:Chrome/118.0.0.0、118.0.0.1 → 429;Chrome/150.0.0.0 → 200。按大版本号卡,UA 够新就行。
// Steamauto(Python)也是这么做的:STEAM_USER_AGENT = "...Chrome/150.0.0.0 Safari/537.36"。
// UA 的取值和账号池见 ./user-agent.ts。
//
// UA 对了 mobileconf 也会因为发得太密回 429(「Rate limit exceeded」,和老 UA 被拒的返回一模一样)。
// 2026-10 用户服务器上求购单确认回过 429,本机同一套请求直连、经代理都是 200,只能是限流:那时一次挂单十几秒里
// 连打 mobileconf 好几次,出口又是多人共用的机房代理 IP。ASF 默认两次确认请求至少隔 10 秒。
// 所以这里的实例发 mobileconf 请求都按出口(同一个代理地址;直连算一个)排队:两次开始至少隔 MOBILECONF_GAP_MS,
// 回了 429 这个出口再冷却 MOBILECONF_COOLDOWN_MS。求购确认和 UU 发货的报价确认都不经 steamcommunity、自己发 mobileconf
// (./confirmations.ts),用同一个队列 mobileconfQueue,和这里的实例互相也排队。
//
// 代理:按要设的 cookie 里的账号选 Steam 代理(src/proxy/),由 src/main.ts 启动时 useCommunityProxy 注册;没注册时直连。

import {createRequire} from 'node:module';
import {createProxyRequest} from '../core/proxy.ts';
import {STEAM_WEB_USER_AGENT} from './user-agent.ts';

const require = createRequire(import.meta.url);

/** 经同一个出口的两次 mobileconf 请求,开始时间至少隔多久 */
export const MOBILECONF_GAP_MS = 5000;
/** mobileconf 回 429 后,这个出口多久内不再发 */
export const MOBILECONF_COOLDOWN_MS = 10000;

const MOBILECONF_URL = /^https:\/\/steamcommunity\.com\/mobileconf\//i;

let proxyForCookies: (cookies: readonly string[]) => string = () => '';

/** 注册「按 cookie 选代理」;返回 '' 表示直连 */
export function useCommunityProxy(resolver: (cookies: readonly string[]) => string): void {
	proxyForCookies = resolver;
}

export {DEFAULT_STEAM_WEB_USER_AGENT, STEAM_WEB_USER_AGENT} from './user-agent.ts';

/** steamcommunity 的 httpRequest 选项(用到的部分) */
interface CommunityRequestOptions {
	url?: unknown;
	uri?: unknown;
}

type PostHttpRequestListener = (requestId: number, source: string, options: CommunityRequestOptions, err: Error | null, response?: {statusCode?: number}) => void;

/** steamcommunity 里用到的几个方法 */
export interface SteamCommunity {
	setCookies(cookies: string[]): void;
	acceptConfirmationForObject(identitySecret: string, objectId: string | number, callback: (err: Error | null) => void): void;
	/** 每个请求发出前调用;返回 true 表示先等着,调 continueRequest 才发 */
	onPreHttpRequest?: (requestId: number, source: string, options: CommunityRequestOptions, continueRequest: (err: Error | null) => void) => boolean;
	on?(event: 'postHttpRequest', listener: PostHttpRequestListener): unknown;
	[key: string]: unknown;
}

/** 按 key 排队放行:同一个 key 两次放行至少隔 gapMs;hold 可以让某个 key 多等一会 */
export interface RequestGate {
	wait(key: string): Promise<void>;
	hold(key: string, ms: number): void;
}

export function createRequestGate(gapMs: number, options: {now?: () => number; sleep?: (ms: number) => Promise<void>} = {}): RequestGate {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	// 每个 key 下一次最早什么时候放行
	const next = new Map<string, number>();
	return {
		async wait(key) {
			// 醒来再看一遍:等的时候可能被 hold 推后了,或者被同时在等的别的请求先占了
			for (;;) {
				const current = now();
				const at = next.get(key) ?? 0;
				if (at <= current) {
					next.set(key, current + gapMs);
					return;
				}
				await sleep(at - current);
			}
		},
		hold(key, ms) {
			next.set(key, Math.max(next.get(key) ?? 0, now() + ms));
		}
	};
}

const mobileconfGate = createRequestGate(MOBILECONF_GAP_MS);

/** 按 cookie 所属账号的出口排队的 mobileconf 队列;不经 steamcommunity、自己发 mobileconf 请求的(求购确认)用它 */
export interface MobileconfQueue {
	wait(cookies: readonly string[]): Promise<void>;
	/** 回了 429:这个出口冷却一会 */
	hold(cookies: readonly string[]): void;
}

export const mobileconfQueue: MobileconfQueue = {
	wait: cookies => mobileconfGate.wait(proxyForCookies(cookies)),
	hold: cookies => mobileconfGate.hold(proxyForCookies(cookies), MOBILECONF_COOLDOWN_MS)
};

function isMobileconf(options: CommunityRequestOptions | undefined): boolean {
	return MOBILECONF_URL.test(String(options?.url ?? options?.uri ?? ''));
}

/** 这个实例的 mobileconf 请求按出口排队,回 429 时这个出口冷却一会;别的请求不管 */
export function throttleMobileconf(community: SteamCommunity, exit: string, gate: RequestGate = mobileconfGate): void {
	community.onPreHttpRequest = (_requestId, _source, options, continueRequest) => {
		if (!isMobileconf(options)) {
			return false;
		}
		gate.wait(exit).then(() => continueRequest(null), err => continueRequest(err as Error));
		return true;
	};
	// 测试替身可能没有事件接口
	community.on?.('postHttpRequest', (_requestId, _source, options, _err, response) => {
		if (response?.statusCode === 429 && isMobileconf(options)) {
			gate.hold(exit, MOBILECONF_COOLDOWN_MS);
		}
	});
}

/**
 * 建一个带够新 UA 的 SteamCommunity;需要 steamcommunity 的地方都走这里,不要直接 new。
 * steam-tradeoffer-manager 的 HTTP 也都转发到传进去的 community 实例上,接受/发送报价一并覆盖。
 * cookies 是之后要 setCookies 的那份,按它选代理
 */
export function createSteamCommunity(cookies: readonly string[] = [], options?: Record<string, unknown>): SteamCommunity {
	const SteamCommunityClass = require('steamcommunity') as new (options: Record<string, unknown>) => SteamCommunity;
	const proxy = proxyForCookies(cookies);
	const community = new SteamCommunityClass({userAgent: STEAM_WEB_USER_AGENT, ...(proxy ? {request: createProxyRequest(proxy)} : {}), ...options});
	throttleMobileconf(community, proxy);
	return community;
}
