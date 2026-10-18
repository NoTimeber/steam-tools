// Steam 网页 / 社区请求用的 User-Agent。
//
// Steam 对「非浏览器 HTTP 栈 + 老版本 Chrome UA」的请求直接回 429:mobileconf(手机确认)、市场(查行情、挂单)都见过,
// 和走不走代理无关。实测同样的请求 Chrome/99、118 → 429,Chrome/150 → 200。所以只用够新的 Chrome。
//
// Chrome 110 起 UA 精简了:系统版本冻结(Windows NT 10.0 / Mac OS X 10_15_7),版本号只留大版本(150.0.0.0),
// 真实用户之间本来就只差大版本和系统。账号池就是「最新的几个大版本 × Windows / Mac」(现在只有最新 1 个,见下),每个账号挑一条固定用
// (见 ./fingerprint.ts);用不了账号 UA 的地方(匿名请求、steamcommunity 库)用 STEAM_WEB_USER_AGENT。
//
// UA 以后还会过期:改环境变量 STEAM_WEB_USER_AGENT 或下面的默认值,账号池跟着它的大版本走,
// 账号原来那条不在新池里的,下次登录时重新挑。

export const DEFAULT_STEAM_WEB_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export const STEAM_WEB_USER_AGENT = String(process.env.STEAM_WEB_USER_AGENT || '').trim() || DEFAULT_STEAM_WEB_USER_AGENT;

/**
 * 账号池往回取几个大版本(含最新那个)。现在只取 1 个:实测过的只有 Chrome/150 → 200、99 和 118 → 429,
 * 中间哪个版本开始被拒还没测出来(测的时候本机 IP 被市场限流了)。确认更老几个版本也放行后再调大
 */
export const POOL_MAJOR_VERSIONS = 1;

const PLATFORMS = ['Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7'];

export function chromeUserAgent(platform: string, major: number): string {
	return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** UA 里的 Chrome 大版本;不是 Chrome 为 null */
export function chromeMajor(userAgent: string): number | null {
	const match = /Chrome\/(\d+)\./.exec(userAgent);
	return match ? Number(match[1]) : null;
}

/** 账号池:latest 的大版本往回 POOL_MAJOR_VERSIONS 个 × Windows / Mac;latest 不是 Chrome 时只有它一条 */
export function webUserAgentPool(latest = STEAM_WEB_USER_AGENT): string[] {
	const major = chromeMajor(latest);
	if (major == null) {
		return [latest];
	}
	const pool: string[] = [];
	for (let version = major; version > major - POOL_MAJOR_VERSIONS; version--) {
		for (const platform of PLATFORMS) {
			pool.push(chromeUserAgent(platform, version));
		}
	}
	return pool.includes(latest) ? pool : [latest, ...pool];
}

const POOL = webUserAgentPool();

/** 账号的 UA 能不能直接用:在当前池里才行(老指纹、空的都不行) */
export function isCurrentWebUserAgent(userAgent: unknown, pool: readonly string[] = POOL): userAgent is string {
	return typeof userAgent === 'string' && pool.includes(userAgent);
}

/** 给账号用的 UA:在当前池里就用它,否则用 STEAM_WEB_USER_AGENT */
export function webUserAgentFor(userAgent: unknown): string {
	return isCurrentWebUserAgent(userAgent) ? userAgent : STEAM_WEB_USER_AGENT;
}
