// Steam 报价接受 + 手机令牌确认(UU 发货第二步,从 app/lib/trade-offer.js 移来)。
// 用 steam-tradeoffer-manager + steamcommunity,cookies 由调用方给(登录拿到的 WebSession cookies);
// 手机确认由调用方传 confirm(UU 发货用 ./confirmations.ts 自己发 mobileconf)。
//
// fail-closed 严格校验,防止接受错误/恶意报价。接受前必须全部满足(见 checkOffer):
//   1. offer.id === UU 给的 tradeOfferId;
//   2. offer.partner === UU 订单里的对方 steamId;
//   3. 报价处于 Active 状态;
//   4. 不收任何物品(发货只给不收);
//   5. 给出的物品至少一件,appid 都是预期游戏;给了 assetId 时必须正好是这些。
// 任一不符就拒绝并返回原因,绝不接受。
// SteamID64 是 17 位数,超过 JS 安全整数,全程按字符串比较。

import {createRequire} from 'node:module';
import {createSteamCommunity} from './community.ts';
import type {SteamCommunity} from './community.ts';

const require = createRequire(import.meta.url);

export interface OfferItemSummary {
	appid: string;
	assetid: unknown;
	name: unknown;
}

export interface OfferSummary {
	id: unknown;
	partner: string | null;
	state: unknown;
	isOurOffer: unknown;
	give: OfferItemSummary[];
	receive: OfferItemSummary[];
}

export interface OfferExpectations {
	tradeOfferId: string;
	expectedPartnerSteamId: string;
	expectGiveAppId: string;
	expectGiveAssetIds?: readonly unknown[];
	allowReceiveItems?: boolean;
	/** TradeOfferManager.ETradeOfferState.Active */
	activeState: unknown;
}

/** 校验报价概要;通过返回 null,否则返回拒绝原因 */
export function checkOffer(offer: OfferSummary, expect: OfferExpectations): string | null {
	if (String(offer.id) !== expect.tradeOfferId) {
		return `offer-id-mismatch(${offer.id}!=${expect.tradeOfferId})`;
	}
	if (String(offer.partner) !== expect.expectedPartnerSteamId) {
		return `partner-mismatch(${offer.partner}!=${expect.expectedPartnerSteamId})`;
	}
	if (offer.state !== expect.activeState) {
		return `not-active(state=${offer.state})`;
	}
	if (!expect.allowReceiveItems && offer.receive.length > 0) {
		return `unexpected-items-to-receive(${offer.receive.length})`;
	}
	if (offer.give.length === 0) {
		return 'nothing-to-give';
	}
	const badAppid = offer.give.find(item => item.appid !== expect.expectGiveAppId);
	if (badAppid) {
		return `give-appid-mismatch(${badAppid.appid}!=${expect.expectGiveAppId})`;
	}
	if (Array.isArray(expect.expectGiveAssetIds) && expect.expectGiveAssetIds.length) {
		const expected = new Set(expect.expectGiveAssetIds.map(String));
		if (!offer.give.every(item => expected.has(String(item.assetid))) || offer.give.length !== expected.size) {
			return 'give-assetids-mismatch';
		}
	}
	return null;
}

export function toCookieArray(cookies: unknown): string[] {
	if (Array.isArray(cookies)) {
		return cookies as string[];
	}
	if (typeof cookies === 'string') {
		return cookies.split(/;\s*/).filter(Boolean);
	}
	return [];
}

interface TradeOfferItem {
	appid: string | number;
	assetid: unknown;
	market_hash_name?: unknown;
}

interface TradeOffer {
	id: string;
	partner: {getSteamID64(): string} | null;
	state: unknown;
	isOurOffer: unknown;
	itemsToGive?: TradeOfferItem[];
	itemsToReceive?: TradeOfferItem[];
	accept(callback: (err: Error | null, status?: string) => void): void;
}

interface TradeOfferManagerInstance {
	setCookies(cookies: string[], callback: (err: Error | null) => void): void;
	getOffer(id: string, callback: (err: Error | null, offer?: TradeOffer) => void): void;
}

interface TradeOfferManagerClass {
	new (options: Record<string, unknown>): TradeOfferManagerInstance;
	ETradeOfferState: {Active: unknown};
}

export interface AcceptOfferOptions {
	cookies: string[] | string;
	/** maFile 的 identity_secret(手机确认用) */
	identitySecret?: string;
	/**
	 * 手机确认这笔报价(UU 发货传 ./confirmations.ts 自己发 mobileconf 的那套)。
	 * 没给就用 steamcommunity 库的 acceptConfirmationForObject:它签名的 tag 用 list / accept,服务器上一直 429
	 */
	confirm?: (tradeOfferId: string) => Promise<void>;
	tradeOfferId: string | number;
	expectedPartnerSteamId: string | null | undefined;
	/** 给出的物品应属的 appid,默认 TF2 440 */
	expectGiveAppId?: number | string;
	expectGiveAssetIds?: readonly unknown[];
	allowReceiveItems?: boolean;
	/** 只校验不接受 */
	dryRun?: boolean;
	timeoutMs?: number;
	logger?: (level: string, message: string) => void;
}

export interface AcceptOfferResult {
	ok: boolean;
	reason: string;
	accepted: boolean;
	confirmed: boolean;
	offer: OfferSummary | null;
}

export async function acceptVerifiedTradeOffer(opts: AcceptOfferOptions): Promise<AcceptOfferResult> {
	const log = typeof opts.logger === 'function' ? opts.logger : () => {};
	const tradeOfferId = String(opts.tradeOfferId);
	const expectedPartner = String(opts.expectedPartnerSteamId);
	const expectGiveAppId = String(opts.expectGiveAppId != null ? opts.expectGiveAppId : 440);
	const dryRun = !!opts.dryRun;
	const timeoutMs = opts.timeoutMs || 30000;
	const cookies = toCookieArray(opts.cookies);
	const fail = (reason: string, offer: OfferSummary | null = null): AcceptOfferResult => ({ok: false, reason, accepted: false, confirmed: false, offer});

	if (!cookies.length) {
		return fail('no-cookies');
	}
	if (!opts.identitySecret && !dryRun) {
		return fail('no-identity-secret');
	}
	if (!expectedPartner || expectedPartner === 'undefined' || expectedPartner === 'null') {
		return fail('no-expected-partner');
	}

	const TradeOfferManager = require('steam-tradeoffer-manager') as TradeOfferManagerClass;
	const community: SteamCommunity = createSteamCommunity(cookies);
	const manager = new TradeOfferManager({community, language: 'en', pollInterval: -1, savePollData: false});
	// 完成后清掉超时定时器(旧代码不清,每次接受都留下几个 30 秒的定时器)
	const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('超时: ' + label)), timeoutMs);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	};

	await withTimeout(new Promise<void>((resolve, reject) => {
		community.setCookies(cookies);
		manager.setCookies(cookies, err => err ? reject(err) : resolve());
	}), 'setCookies');

	const offer = await withTimeout(new Promise<TradeOffer | undefined>((resolve, reject) => {
		manager.getOffer(tradeOfferId, (err, found) => err ? reject(err) : resolve(found));
	}), 'getOffer');
	if (!offer) {
		return fail('offer-not-found');
	}

	const describe = (item: TradeOfferItem): OfferItemSummary => ({appid: String(item.appid), assetid: item.assetid, name: item.market_hash_name});
	const summary: OfferSummary = {
		id: offer.id,
		partner: offer.partner ? offer.partner.getSteamID64() : null,
		state: offer.state,
		isOurOffer: offer.isOurOffer,
		give: (offer.itemsToGive || []).map(describe),
		receive: (offer.itemsToReceive || []).map(describe)
	};
	// 概要只用于调试,debug 级不推到前端发货日志
	log('debug', '报价概要: ' + JSON.stringify(summary));

	const rejected = checkOffer(summary, {
		tradeOfferId,
		expectedPartnerSteamId: expectedPartner,
		expectGiveAppId,
		expectGiveAssetIds: opts.expectGiveAssetIds,
		allowReceiveItems: !!opts.allowReceiveItems,
		activeState: TradeOfferManager.ETradeOfferState.Active
	});
	if (rejected) {
		return fail(rejected, summary);
	}
	if (dryRun) {
		log('info', '[dryRun] 校验全部通过，未真正接受。');
		return {ok: true, reason: 'verified-dry-run', accepted: false, confirmed: false, offer: summary};
	}

	log('info', '校验通过，正在接受报价...');
	const status = await withTimeout(new Promise<string | undefined>((resolve, reject) => {
		offer.accept((err, result) => err ? reject(err) : resolve(result));
	}), 'accept');
	log('info', '接受返回状态: ' + status);

	let confirmed = false;
	if (status === 'pending') {
		log('info', '需要手机令牌确认，正在确认...');
		if (opts.confirm) {
			// 每个请求自带超时,还有排队和 429 等待重试,总耗时可能超过 timeoutMs,不再套一层
			await opts.confirm(String(offer.id));
		} else {
			await withTimeout(new Promise<void>((resolve, reject) => {
				community.acceptConfirmationForObject(opts.identitySecret as string, offer.id, err => err ? reject(err) : resolve());
			}), 'acceptConfirmation');
		}
		confirmed = true;
		log('info', '手机令牌确认完成。');
	}
	return {ok: true, reason: 'accepted', accepted: true, confirmed, offer: summary};
}
