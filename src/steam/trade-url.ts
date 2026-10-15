// Steam 交易链接(https://steamcommunity.com/tradeoffer/new/?partner=<32 位账号 id>&token=<令牌>):
// partner 是账号 id,也就是 SteamID64 的低 32 位,拿它对账号就知道链接是谁的;
// 账号自己的链接在登录后的「交易报价隐私设置」页里。
// C5 扫货选收货账号时用:从本工具里已登录的账号取链接,不用手动去 Steam 复制。

const STEAMID64_BASE = 76561197960265728n;
const COMMUNITY = 'https://steamcommunity.com';

/** 交易链接里的 partner(账号 id);不是交易链接返回 null */
export function partnerOf(tradeUrl: string): string | null {
	try {
		const url = new URL(tradeUrl);
		const partner = url.searchParams.get('partner') ?? '';
		return url.hostname === 'steamcommunity.com' && /^\d{1,10}$/.test(partner) ? String(BigInt(partner)) : null;
	} catch {
		return null;
	}
}

/** SteamID64 的账号 id(低 32 位);不是 SteamID64 返回 null */
export function accountIdOf(steamId: string): string | null {
	return /^\d{17}$/.test(steamId) ? String(BigInt(steamId) & 0xFFFFFFFFn) : null;
}

/** 交易链接是不是这个 SteamID64 的 */
export function isTradeUrlOf(tradeUrl: string, steamId: string): boolean {
	const partner = partnerOf(tradeUrl);
	return partner != null && partner === accountIdOf(steamId);
}

/** 交易链接里的 partner → 个人账号的 SteamID64;不是交易链接返回 null */
export function steamIdFromTradeUrl(tradeUrl: string): string | null {
	const partner = partnerOf(tradeUrl);
	return partner == null ? null : String(STEAMID64_BASE + BigInt(partner));
}

/** 隐私设置页 HTML 里的交易链接(输入框 #trade_offer_access_url);没有返回 null */
export function parseTradeUrlPage(html: string): string | null {
	const input = /<input[^>]*id="trade_offer_access_url"[^>]*>/.exec(html)?.[0];
	const value = input && /value="([^"]+)"/.exec(input)?.[1];
	if (!value) {
		return null;
	}
	const url = value.replace(/&amp;/g, '&');
	return /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]+$/.test(url) ? url : null;
}

export interface FetchTradeUrlOptions {
	steamId: string;
	/** 这个账号的网页会话 cookie(name=value) */
	cookies: readonly string[];
	userAgent: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

/** 用账号的网页会话取它自己的交易链接。会话没了 Steam 会跳去登录页 */
export async function fetchTradeUrl(options: FetchTradeUrlOptions): Promise<string> {
	if (!/^\d{17}$/.test(options.steamId)) {
		throw new Error('不知道这个账号的 SteamID,先登录一次');
	}
	if (!options.cookies.length) {
		throw new Error('这个账号没有网页会话,先在账户管理里登录');
	}
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const res = await http(`${COMMUNITY}/profiles/${options.steamId}/tradeoffers/privacy`, {
		headers: {Cookie: options.cookies.join('; '), 'User-Agent': options.userAgent, Accept: 'text/html'},
		redirect: 'manual',
		signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
	});
	if (res.status >= 300 && res.status < 400) {
		throw new Error('网页会话失效了,在账户管理里重新登录这个账号');
	}
	if (!res.ok) {
		throw new Error(`Steam 返回 HTTP ${res.status}`);
	}
	const tradeUrl = parseTradeUrlPage(await res.text());
	if (!tradeUrl) {
		throw new Error('页面里没找到交易链接(会话可能失效了,重新登录这个账号再试)');
	}
	if (!isTradeUrlOf(tradeUrl, options.steamId)) {
		throw new Error('取到的交易链接不是这个账号的');
	}
	return tradeUrl;
}
