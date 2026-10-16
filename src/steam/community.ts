// steamcommunity 实例工厂:统一注入够新的浏览器 User-Agent(从 app/lib/steam-community-ua.js 移来)。
//
// steamcommunity@3.50.0 构造时写死默认 UA(Chrome/118)。Steam 现在对「非浏览器 HTTP 栈 + 老版本 Chrome UA」
// 直接回 429,/mobileconf/* 全线失败,也就是所有手机令牌确认:发货接受报价后的确认、求购单确认。
// 实测同一份 cookies:Chrome/118.0.0.0、118.0.0.1 → 429;Chrome/150.0.0.0 → 200。按大版本号卡,UA 够新就行。
// Steamauto(Python)也是这么做的:STEAM_USER_AGENT = "...Chrome/150.0.0.0 Safari/537.36"。
//
// 不要用账号指纹里的 attempt.userAgent:那批 UA 最高才 Chrome/99,比库默认的还旧;它只适合走 fetch 的自有请求。
// UA 以后还会过期,到时改 STEAM_WEB_USER_AGENT 环境变量或下面的默认值。
//
// 代理:按要设的 cookie 里的账号选 Steam 代理(src/proxy/),由 src/main.ts 启动时 useCommunityProxy 注册;没注册时直连。

import {createRequire} from 'node:module';
import {createProxyRequest} from '../core/proxy.ts';

const require = createRequire(import.meta.url);

let proxyForCookies: (cookies: readonly string[]) => string = () => '';

/** 注册「按 cookie 选代理」;返回 '' 表示直连 */
export function useCommunityProxy(resolver: (cookies: readonly string[]) => string): void {
	proxyForCookies = resolver;
}

export const DEFAULT_STEAM_WEB_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export const STEAM_WEB_USER_AGENT = String(process.env.STEAM_WEB_USER_AGENT || '').trim() || DEFAULT_STEAM_WEB_USER_AGENT;

/** steamcommunity 里用到的几个方法 */
export interface SteamCommunity {
	setCookies(cookies: string[]): void;
	acceptConfirmationForObject(identitySecret: string, objectId: string | number, callback: (err: Error | null) => void): void;
	[key: string]: unknown;
}

/**
 * 建一个带够新 UA 的 SteamCommunity;需要 steamcommunity 的地方都走这里,不要直接 new。
 * steam-tradeoffer-manager 的 HTTP 也都转发到传进去的 community 实例上,接受/发送报价一并覆盖。
 * cookies 是之后要 setCookies 的那份,按它选代理
 */
export function createSteamCommunity(cookies: readonly string[] = [], options?: Record<string, unknown>): SteamCommunity {
	const SteamCommunityClass = require('steamcommunity') as new (options: Record<string, unknown>) => SteamCommunity;
	const proxy = proxyForCookies(cookies);
	return new SteamCommunityClass({userAgent: STEAM_WEB_USER_AGENT, ...(proxy ? {request: createProxyRequest(proxy)} : {}), ...options});
}
