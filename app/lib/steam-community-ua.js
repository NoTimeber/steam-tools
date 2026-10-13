'use strict';

// steamcommunity 实例工厂 —— 统一注入「够新的」浏览器 User-Agent。
//
// 为什么需要这个模块:
//   steamcommunity@3.50.0 在构造函数里写死了默认 UA(@doctormckay/user-agents 的 chrome(),
//   固定返回 Chrome/118.0.0.0)。Steam 现在对「非浏览器 HTTP 栈 + 老版本 Chrome UA」的组合
//   直接返回 HTTP 429,导致 /mobileconf/* 全线失败 —— 也就是所有手机令牌确认功能:
//     · 发货接受报价后的确认 (lib/trade-offer.js -> acceptConfirmationForObject)
//     · 求购单确认           (services/steamMarketBuyOrder.js -> getConfirmations / respond)
//
//   实测(同一份 cookies,交替多轮验证):
//     Chrome/118.0.0.0(库默认) -> 429      Chrome/118.0.0.1(只差一个字符) -> 429
//     Chrome/150.0.0.0          -> 200 OK   ← 换新版本号即恢复
//   说明这不是「精确字符串黑名单」,而是按 Chrome 大版本号卡的;所以只要 UA 足够新即可。
//
//   上级目录的 Steamauto(Python 版,同样跑 /mobileconf,工作正常)就是这么做的:
//   steampy/client.py 里 STEAM_USER_AGENT = "...Chrome/150.0.0.0 Safari/537.36",
//   并在建 session 时 self._session.headers["User-Agent"] = STEAM_USER_AGENT。
//
// 注意:不要用 services/fingerprint.js 里的 attempt.userAgent —— data/ua_cache.json 里的 UA
// 最高才 Chrome/99(多数是 Chrome/40~90 时代),比库默认的 118 还旧,套进来只会更糟。
// 那份 UA 池只适合走 fetch 的自有请求(实测 fetch + 老 UA 不触发 429)。
//
// UA 以后还会过期。到时只需改 STEAM_WEB_USER_AGENT 环境变量,或更新下面的默认值。

const SteamCommunity = require('steamcommunity');

// 默认 UA:与 Steamauto 保持一致(已实测可用)。可用环境变量覆盖,便于以后不改代码就能续命。
const DEFAULT_STEAM_WEB_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const STEAM_WEB_USER_AGENT = String(process.env.STEAM_WEB_USER_AGENT || '').trim() || DEFAULT_STEAM_WEB_USER_AGENT;

/**
 * 建一个带「够新 UA」的 SteamCommunity。
 * 所有需要 steamcommunity 的地方都应该走这里,不要再直接 new SteamCommunity()。
 * steam-tradeoffer-manager 的全部 HTTP 也是转发到传进去的 community 实例上的
 * (lib/classes/TradeOffer.js 里统一用 manager._community.httpRequest*),所以接受报价/发送报价
 * 也一并被这个 UA 覆盖。
 *
 * @param {object} [options] 透传给 SteamCommunity 的其它选项(如 localAddress / timeout / request)
 * @returns {SteamCommunity}
 */
function createSteamCommunity(options) {
	return new SteamCommunity(Object.assign({userAgent: STEAM_WEB_USER_AGENT}, options || {}));
}

module.exports = {createSteamCommunity, STEAM_WEB_USER_AGENT, DEFAULT_STEAM_WEB_USER_AGENT};
