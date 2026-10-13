'use strict';

// Steam 报价接受 + 手机令牌确认（发货 P2）。
// 用 steam-tradeoffer-manager + steamcommunity，cookies 由调用方提供
// （steam-login-replica 登录后的 attempt.cookies）。
//
// 核心安全：fail-closed 严格校验，防止接受错误/恶意报价。接受前必须全部通过：
//   1. 报价存在且处于 Active 状态
//   2. offer.id === UU 给的 tradeOfferId
//   3. offer.partner === UU 订单里的对方 steamId（中转方/买家），全程字符串比较
//   4. 不接收任何物品（itemsToReceive 必须为空；发货只给不收）
//   5. 给出的物品 appid 命中预期游戏（默认 TF2=440）；可选校验具体 assetId
// 任一不符 → 拒绝并返回原因，绝不接受。
//
// 注意：SteamID64 是 17 位数，超过 JS 安全整数，必须全程当字符串处理。
// 本模块用 offer.partner.getSteamID64()（返回字符串）+ 字符串比较，天然安全。

const TradeOfferManager = require('steam-tradeoffer-manager');
// 必须走工厂建 community:库默认的 Chrome/118 UA 会被 Steam 以 429 挡掉,手机令牌确认全线失败。
// 详见 lib/steam-community-ua.js。manager 的 HTTP 也全部转发到这个 community 实例上。
const {createSteamCommunity} = require('./steam-community-ua');

function toCookieArray(cookies) {
	if (Array.isArray(cookies)) return cookies;
	if (typeof cookies === 'string') return cookies.split(/;\s*/).filter(Boolean);
	return [];
}

function noopLogger() {}

/**
 * 校验并接受一笔 Steam 报价（含手机确认）。
 * @param {object} opts
 * @param {string[]|string} opts.cookies        webSession cookies
 * @param {string} opts.identitySecret          maFile 的 identity_secret（手机确认用）
 * @param {string|number} opts.tradeOfferId      期望的报价号（来自 UU 订单）
 * @param {string} opts.expectedPartnerSteamId   期望的对方 steamId 字符串（来自 UU 订单）
 * @param {number} [opts.expectGiveAppId=440]    我们给出的物品应属的 appid
 * @param {string[]} [opts.expectGiveAssetIds]   可选：期望给出的具体 assetId 集合
 * @param {boolean} [opts.allowReceiveItems=false] 是否允许我们收到物品（发货应为 false）
 * @param {boolean} [opts.dryRun=false]          true 时只校验、不真正接受
 * @param {number} [opts.timeoutMs=30000]
 * @param {function} [opts.logger] (level, msg) => void
 * @returns {Promise<{ok:boolean, reason:string, accepted:boolean, confirmed:boolean, offer:object}>}
 */
async function acceptVerifiedTradeOffer(opts) {
	const log = typeof opts.logger === 'function' ? opts.logger : noopLogger;
	const tradeOfferId = String(opts.tradeOfferId);
	const expectedPartner = String(opts.expectedPartnerSteamId);
	const expectGiveAppId = String(opts.expectGiveAppId != null ? opts.expectGiveAppId : 440);
	const allowReceiveItems = !!opts.allowReceiveItems;
	const dryRun = !!opts.dryRun;
	const timeoutMs = opts.timeoutMs || 30000;
	const cookies = toCookieArray(opts.cookies);

	const fail = reason => ({ok: false, reason, accepted: false, confirmed: false, offer: null});

	if (!cookies.length) return fail('no-cookies');
	if (!opts.identitySecret && !dryRun) return fail('no-identity-secret');
	if (!expectedPartner || expectedPartner === 'undefined' || expectedPartner === 'null') return fail('no-expected-partner');

	const community = createSteamCommunity();
	const manager = new TradeOfferManager({community, language: 'en', pollInterval: -1, savePollData: false});

	const withTimeout = (p, label) => Promise.race([
		p,
		new Promise((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), timeoutMs))
	]);

	// 1) 设置 cookies
	await withTimeout(new Promise((resolve, reject) => {
		community.setCookies(cookies);
		manager.setCookies(cookies, err => err ? reject(err) : resolve());
	}), 'setCookies');

	// 2) 拉取报价
	const offer = await withTimeout(new Promise((resolve, reject) => {
		manager.getOffer(tradeOfferId, (err, o) => err ? reject(err) : resolve(o));
	}), 'getOffer');

	if (!offer) return {ok: false, reason: 'offer-not-found', accepted: false, confirmed: false, offer: null};

	const summary = {
		id: offer.id,
		partner: offer.partner ? offer.partner.getSteamID64() : null,
		state: offer.state,
		isOurOffer: offer.isOurOffer,
		give: (offer.itemsToGive || []).map(i => ({appid: String(i.appid), assetid: i.assetid, name: i.market_hash_name})),
		receive: (offer.itemsToReceive || []).map(i => ({appid: String(i.appid), assetid: i.assetid, name: i.market_hash_name}))
	};
	// 报价概要仅用于调试，debug 级不推送到前端发货日志（避免刷屏 JSON）
	log('debug', '报价概要: ' + JSON.stringify(summary));

	// ===== fail-closed 校验（全部字符串比较）=====
	if (String(offer.id) !== tradeOfferId) {
		return {ok: false, reason: `offer-id-mismatch(${offer.id}!=${tradeOfferId})`, accepted: false, confirmed: false, offer: summary};
	}
	if (String(summary.partner) !== expectedPartner) {
		return {ok: false, reason: `partner-mismatch(${summary.partner}!=${expectedPartner})`, accepted: false, confirmed: false, offer: summary};
	}
	if (offer.state !== TradeOfferManager.ETradeOfferState.Active) {
		return {ok: false, reason: `not-active(state=${offer.state})`, accepted: false, confirmed: false, offer: summary};
	}
	if (!allowReceiveItems && summary.receive.length > 0) {
		return {ok: false, reason: `unexpected-items-to-receive(${summary.receive.length})`, accepted: false, confirmed: false, offer: summary};
	}
	if (summary.give.length === 0) {
		return {ok: false, reason: 'nothing-to-give', accepted: false, confirmed: false, offer: summary};
	}
	const badAppid = summary.give.find(i => i.appid !== expectGiveAppId);
	if (badAppid) {
		return {ok: false, reason: `give-appid-mismatch(${badAppid.appid}!=${expectGiveAppId})`, accepted: false, confirmed: false, offer: summary};
	}
	if (Array.isArray(opts.expectGiveAssetIds) && opts.expectGiveAssetIds.length) {
		const expected = new Set(opts.expectGiveAssetIds.map(String));
		const allMatch = summary.give.every(i => expected.has(String(i.assetid)));
		if (!allMatch || summary.give.length !== expected.size) {
			return {ok: false, reason: 'give-assetids-mismatch', accepted: false, confirmed: false, offer: summary};
		}
	}

	if (dryRun) {
		log('info', '[dryRun] 校验全部通过，未真正接受。');
		return {ok: true, reason: 'verified-dry-run', accepted: false, confirmed: false, offer: summary};
	}

	// ===== 校验通过，接受 =====
	log('info', '校验通过，正在接受报价...');
	const status = await withTimeout(new Promise((resolve, reject) => {
		offer.accept((err, st) => err ? reject(err) : resolve(st));
	}), 'accept');
	log('info', '接受返回状态: ' + status);

	let confirmed = false;
	if (status === 'pending') {
		log('info', '需要手机令牌确认，正在确认...');
		await withTimeout(new Promise((resolve, reject) => {
			community.acceptConfirmationForObject(opts.identitySecret, offer.id, err => err ? reject(err) : resolve());
		}), 'acceptConfirmation');
		confirmed = true;
		log('info', '手机令牌确认完成。');
	}

	return {ok: true, reason: 'accepted', accepted: true, confirmed, offer: summary};
}

module.exports = {acceptVerifiedTradeOffer, toCookieArray};
