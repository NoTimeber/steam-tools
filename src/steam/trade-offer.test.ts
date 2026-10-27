import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {acceptVerifiedTradeOffer, checkOffer, toCookieArray} from './trade-offer.ts';
import type {OfferExpectations, OfferSummary} from './trade-offer.ts';

const ACTIVE = 2;
const PARTNER = '76561198000000001';   // 超过 2^53,必须按字符串比

const summary = (overrides: Partial<OfferSummary> = {}): OfferSummary => ({
	id: '5551', partner: PARTNER, state: ACTIVE, isOurOffer: false,
	give: [{appid: '730', assetid: '42', name: 'AK'}], receive: [], ...overrides
});
const expect = (overrides: Partial<OfferExpectations> = {}): OfferExpectations => ({
	tradeOfferId: '5551', expectedPartnerSteamId: PARTNER, expectGiveAppId: '730', activeState: ACTIVE, ...overrides
});

test('报价校验:全部符合才放行', () => {
	assert.equal(checkOffer(summary(), expect()), null);
	assert.equal(checkOffer(summary(), expect({expectGiveAssetIds: ['42']})), null);
});

test('报价校验:每一条不符都拒绝,并给出原因', () => {
	assert.equal(checkOffer(summary({id: '5552'}), expect()), 'offer-id-mismatch(5552!=5551)');
	assert.equal(checkOffer(summary({partner: '76561198000000002'}), expect()), `partner-mismatch(76561198000000002!=${PARTNER})`);
	assert.equal(checkOffer(summary({partner: null}), expect()), `partner-mismatch(null!=${PARTNER})`);
	assert.equal(checkOffer(summary({state: 3}), expect()), 'not-active(state=3)');
	assert.equal(checkOffer(summary({receive: [{appid: '730', assetid: '1', name: 'x'}]}), expect()), 'unexpected-items-to-receive(1)');
	assert.equal(checkOffer(summary({receive: [{appid: '730', assetid: '1', name: 'x'}]}), expect({allowReceiveItems: true})), null);
	assert.equal(checkOffer(summary({give: []}), expect()), 'nothing-to-give');
	assert.equal(checkOffer(summary({give: [{appid: '730', assetid: '42', name: 'a'}, {appid: '440', assetid: '7', name: 'b'}]}), expect()), 'give-appid-mismatch(440!=730)');
	assert.equal(checkOffer(summary(), expect({expectGiveAssetIds: ['43']})), 'give-assetids-mismatch');
	assert.equal(checkOffer(summary({give: [{appid: '730', assetid: '42', name: 'a'}, {appid: '730', assetid: '43', name: 'b'}]}), expect({expectGiveAssetIds: ['42']})), 'give-assetids-mismatch', '多给了也不行');
	// 只差最后几位的 SteamID64:数字比较会因为精度相等,字符串比较不会
	assert.equal(Number('76561198000000001') === Number('76561198000000000'), true);
	assert.match(checkOffer(summary(), expect({expectedPartnerSteamId: '76561198000000000'})) ?? '', /partner-mismatch/);
});

test('cookies 支持数组和分号分隔的字符串', () => {
	assert.deepEqual(toCookieArray(['a=1']), ['a=1']);
	assert.deepEqual(toCookieArray('a=1; b=2;'), ['a=1', 'b=2']);
	assert.deepEqual(toCookieArray(null), []);
});

// ===== 接受流程:用替身替换 steam-tradeoffer-manager / steamcommunity =====

interface FakeOffer {
	id: string;
	partner: {getSteamID64(): string} | null;
	state: number;
	isOurOffer: boolean;
	itemsToGive: Array<{appid: number; assetid: string; market_hash_name: string}>;
	itemsToReceive: unknown[];
	accept(callback: (err: Error | null, status?: string) => void): void;
}

const calls: string[] = [];
let nextOffer: FakeOffer | null = null;
let acceptStatus = 'pending';
const require = createRequire(import.meta.url);
const stubbed: string[] = [];

function stub(name: string, exports: unknown) {
	const path = require.resolve(name);
	stubbed.push(path);
	require.cache[path] = {id: path, filename: path, loaded: true, exports} as NodeJS.Module;
}

before(() => {
	class FakeManager {
		static ETradeOfferState = {Active: ACTIVE};
		constructor(options: Record<string, unknown>) {
			calls.push(`manager(pollInterval=${options.pollInterval})`);
		}
		setCookies(cookies: string[], callback: (err: Error | null) => void) {
			calls.push('manager.setCookies ' + cookies.join(','));
			callback(null);
		}
		getOffer(id: string, callback: (err: Error | null, offer?: FakeOffer) => void) {
			calls.push('getOffer ' + id);
			callback(null, nextOffer ?? undefined);
		}
	}
	class FakeCommunity {
		constructor(options: {userAgent: string}) {
			calls.push('community ' + (/Chrome\/150/.test(options.userAgent) ? 'ua-ok' : 'ua-old'));
		}
		setCookies() {
			calls.push('community.setCookies');
		}
		acceptConfirmationForObject(secret: string, id: string, callback: (err: Error | null) => void) {
			calls.push(`confirm ${secret} ${id}`);
			callback(null);
		}
	}
	stub('steam-tradeoffer-manager', FakeManager);
	stub('steamcommunity', FakeCommunity);
});

after(() => {
	for (const path of stubbed) {
		delete require.cache[path];
	}
});

function fakeOffer(overrides: Partial<FakeOffer> = {}): FakeOffer {
	return {
		id: '5551',
		partner: {getSteamID64: () => PARTNER},
		state: ACTIVE,
		isOurOffer: false,
		itemsToGive: [{appid: 730, assetid: '42', market_hash_name: 'AK'}],
		itemsToReceive: [],
		accept(callback) {
			calls.push('accept');
			callback(null, acceptStatus);
		},
		...overrides
	};
}

const baseOptions = {cookies: 'steamLoginSecure=x; sessionid=y', identitySecret: 'ID-SECRET', tradeOfferId: 5551, expectedPartnerSteamId: PARTNER, expectGiveAppId: 730, expectGiveAssetIds: ['42']};

test('接受流程:校验通过 → 接受 → 需要确认时用 identity_secret 手机确认', async () => {
	calls.length = 0;
	nextOffer = fakeOffer();
	acceptStatus = 'pending';
	const logs: string[] = [];
	const result = await acceptVerifiedTradeOffer({...baseOptions, logger: (level, message) => logs.push(level + ' ' + message)});
	assert.deepEqual([result.ok, result.reason, result.accepted, result.confirmed], [true, 'accepted', true, true]);
	assert.deepEqual(calls, [
		'community ua-ok', 'manager(pollInterval=-1)', 'community.setCookies', 'manager.setCookies steamLoginSecure=x,sessionid=y',
		'getOffer 5551', 'accept', 'confirm ID-SECRET 5551'
	]);
	assert.ok(logs.some(line => line.startsWith('debug 报价概要')));

	calls.length = 0;
	nextOffer = fakeOffer();
	acceptStatus = 'accepted';
	const direct = await acceptVerifiedTradeOffer(baseOptions);
	assert.deepEqual([direct.accepted, direct.confirmed], [true, false]);
	assert.ok(!calls.some(call => call.startsWith('confirm')), '不需要确认时不确认');
});

test('接受流程:传了 confirm 就用它手机确认这笔报价,不走 steamcommunity 库', async () => {
	calls.length = 0;
	nextOffer = fakeOffer();
	acceptStatus = 'pending';
	const result = await acceptVerifiedTradeOffer({...baseOptions, confirm: async id => void calls.push('own-confirm ' + id)});
	assert.deepEqual([result.ok, result.accepted, result.confirmed], [true, true, true]);
	assert.deepEqual(calls.slice(-2), ['accept', 'own-confirm 5551']);
	assert.ok(!calls.some(call => call.startsWith('confirm ')));

	calls.length = 0;
	nextOffer = fakeOffer();
	await assert.rejects(acceptVerifiedTradeOffer({...baseOptions, confirm: async () => {
		throw new Error('Steam 手机确认接口限流(HTTP 429)');
	}}), /限流/, '确认失败照抛,由发货记为失败');
});

test('接受流程:校验不过绝不接受;dryRun 只校验', async () => {
	calls.length = 0;
	nextOffer = fakeOffer({partner: {getSteamID64: () => '76561198000000009'}});
	const rejected = await acceptVerifiedTradeOffer(baseOptions);
	assert.equal(rejected.ok, false);
	assert.match(rejected.reason, /^partner-mismatch/);
	assert.equal(rejected.offer?.partner, '76561198000000009');
	assert.ok(!calls.includes('accept'));

	calls.length = 0;
	nextOffer = fakeOffer();
	const dry = await acceptVerifiedTradeOffer({...baseOptions, identitySecret: '', dryRun: true});
	assert.deepEqual([dry.ok, dry.reason, dry.accepted], [true, 'verified-dry-run', false]);
	assert.ok(!calls.includes('accept'));

	nextOffer = null;
	assert.equal((await acceptVerifiedTradeOffer(baseOptions)).reason, 'offer-not-found');
});

test('接受流程:缺 cookies / identity_secret / 对方 steamId 时直接拒绝,不连 Steam', async () => {
	calls.length = 0;
	assert.equal((await acceptVerifiedTradeOffer({...baseOptions, cookies: []})).reason, 'no-cookies');
	assert.equal((await acceptVerifiedTradeOffer({...baseOptions, identitySecret: ''})).reason, 'no-identity-secret');
	assert.equal((await acceptVerifiedTradeOffer({...baseOptions, expectedPartnerSteamId: undefined})).reason, 'no-expected-partner');
	assert.equal((await acceptVerifiedTradeOffer({...baseOptions, expectedPartnerSteamId: null})).reason, 'no-expected-partner');
	assert.deepEqual(calls, []);
});
