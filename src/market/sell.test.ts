import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {InventoryItem} from '../inventory/community.ts';
import type {Confirmation, RespondConfirmationsParams} from '../steam/confirmations.ts';
import type {Attempt} from '../steam/session-manager.ts';
import type {MarketContext} from './client.ts';
import {createSellClient, parseMyHistory, parseMyListings} from './sell-client.ts';
import type {MyListing, SellClient, SellItemParams, SellItemResult} from './sell-client.ts';
import {createSellService} from './sell.ts';
import type {SellConfirmer} from './sell.ts';

// mylistings?norender=1 的样子(字段取自真实返回,删掉了无关的)
const MY_LISTINGS = {
	success: true, pagesize: 100, total_count: 1, start: 0, num_active_listings: 1,
	assets: {730: {2: {'9001': {appid: 730, contextid: '2', id: '9001', market_hash_name: 'AK-47 | Redline (Field-Tested)', name: 'AK-47 | 红线 (久经沙场)', icon_url: 'abc', amount: '1'}}}},
	listings: [{
		listingid: '5001', time_created: 1763000000, steamid_lister: '76561190000000001', price: 870, original_price: 870, fee: 130, currencyid: '2001',
		active: 1, status: 1, asset: {currency: 0, appid: 730, contextid: '2', id: '9001', amount: '1', unowned_id: '101', unowned_contextid: '2'}
	}],
	listings_on_hold: [],
	listings_to_confirm: [{
		listingid: '5002', time_created: 1763000100, price: 100, fee: 15, currencyid: 2001,
		asset: {appid: 730, contextid: '2', id: '9002', unowned_id: '103', amount: '1', market_hash_name: 'Kilowatt Case', name: '千瓦武器箱', icon_url: 'https://x/y.png'}
	}],
	buy_orders: [{buy_orderid: '1', price: '10'}]
};

test('解析我的在售:在售 / 待确认分开,价格拆成买家价和到手,assetid 带上架前的 unowned_id', () => {
	const page = parseMyListings(MY_LISTINGS);
	assert.equal(page.totalCount, 1);
	assert.deepEqual(page.listings.map(l => [l.listingId, l.status, l.assetid, l.originalAssetid, l.buyerPriceCents, l.receiveCents, l.feeCents, l.currencyId]), [
		['5002', 'to_confirm', '9002', '103', 115, 100, 15, 1],
		['5001', 'active', '9001', '101', 1000, 870, 130, 1]
	]);
	const active = page.listings[1] as MyListing;
	// 描述在顶层 assets 里也能找到
	assert.deepEqual([active.marketHashName, active.name, active.icon, active.createdAt], [
		'AK-47 | Redline (Field-Tested)', 'AK-47 | 红线 (久经沙场)', 'https://community.cloudflare.steamstatic.com/economy/image/abc/96fx96f', new Date(1763000000 * 1000).toISOString()
	]);
	assert.equal(page.listings[0]?.icon, 'https://x/y.png');
	assert.deepEqual(parseMyListings({success: true}), {totalCount: 0, listings: []});
});

test('解析成交记录:上架 / 下架 / 卖出 / 买入,卖出带买家、成交价和到手', () => {
	const json = {
		success: true, pagesize: 10, total_count: 42, start: 0,
		assets: {730: {2: {
			'9001': {appid: 730, contextid: '2', id: '9001', market_hash_name: 'AK-47 | Redline (Field-Tested)', name: 'AK 红线', icon_url: 'ak'},
			'9100': {appid: 730, contextid: '2', id: '9100', market_hash_name: 'Kilowatt Case', name: '千瓦武器箱'}
		}}},
		events: [
			{listingid: '5001', purchaseid: '8001', event_type: 3, time_event: 1763001000, steamid_actor: '76561190000000009'},
			{listingid: '5009', purchaseid: '8009', event_type: 4, time_event: 1763000900, steamid_actor: '76561190000000007'},
			{listingid: '5003', event_type: 2, time_event: 1763000500},
			{listingid: '5001', event_type: 1, time_event: 1763000000},
			{listingid: '5004', event_type: 9, time_event: 1}
		],
		listings: {
			5001: {listingid: '5001', price: 870, fee: 130, currencyid: '2001', asset: {appid: 730, contextid: '2', id: '9001', amount: '1'}},
			5003: {listingid: '5003', price: 100, fee: 15, currencyid: '2023', asset: {appid: 730, contextid: '2', id: '9100', amount: '1'}}
		},
		purchases: {
			'5001_8001': {listingid: '5001', purchaseid: '8001', steamid_purchaser: '76561190000000009', paid_amount: 870, paid_fee: 130, currencyid: '2001',
				received_amount: 870, received_currencyid: '2001', persona_actor: 'Buyer', avatar_actor: 'https://a/b.jpg', asset: {appid: 730, contextid: '2', id: '9001', amount: '1'}},
			'5009_8009': {listingid: '5009', purchaseid: '8009', paid_amount: 200, paid_fee: 30, currencyid: '2001', persona_actor: 'Seller',
				asset: {appid: 730, contextid: '2', id: '9100', amount: '1'}}
		}
	};
	const page = parseMyHistory(json);
	assert.equal(page.totalCount, 42);
	assert.deepEqual(page.events.map(e => [e.type, e.listingId, e.marketHashName, e.buyerPriceCents, e.receiveCents, e.currencyId, e.counterpart?.persona ?? null]), [
		['sold', '5001', 'AK-47 | Redline (Field-Tested)', 1000, 870, 1, 'Buyer'],
		['bought', '5009', 'Kilowatt Case', 230, null, 1, 'Seller'],
		['cancelled', '5003', 'Kilowatt Case', 115, 100, 23, null],
		['listed', '5001', 'AK-47 | Redline (Field-Tested)', 1000, 870, 1, null],
		['unknown', '5004', '', null, null, 0, null]
	]);
	const sold = page.events[0]!;
	assert.deepEqual(sold.counterpart, {steamId: '76561190000000009', persona: 'Buyer', avatar: 'https://a/b.jpg'});
	assert.equal(sold.date, new Date(1763001000 * 1000).toISOString());
	assert.equal(new Set(page.events.map(e => e.key)).size, page.events.length);
});

test('sellitem:表单、Referer;Steam 拒绝时带原话;下架回 [] 算成功', async () => {
	const calls: Array<{url: string; init: RequestInit}> = [];
	const replies: Response[] = [
		new Response(JSON.stringify({success: true, requires_confirmation: 1, needs_mobile_confirmation: true, needs_email_confirmation: false})),
		new Response(JSON.stringify({success: false, message: 'You already have a listing for this item pending confirmation.'}), {status: 502}),
		new Response('[]')
	];
	const client = createSellClient({fetch: async (input, init) => {
		calls.push({url: String(input), init: init ?? {}});
		return replies.shift()!;
	}});
	const params = {cookies: ['steamLoginSecure=x', 'sessionid=SID'], steamID: '765', appid: 730, contextid: '2', assetid: '101', amount: 1, receiveCents: 870};
	assert.deepEqual(await client.sellItem(params), {ok: true, needsMobileConfirmation: true, needsEmailConfirmation: false, message: ''});
	assert.equal(calls[0]?.url, 'https://steamcommunity.com/market/sellitem/');
	assert.equal(String(calls[0]?.init.body), 'sessionid=SID&appid=730&contextid=2&assetid=101&amount=1&price=870');
	assert.equal((calls[0]?.init.headers as Record<string, string>).Referer, 'https://steamcommunity.com/profiles/765/inventory/');
	const refused = await client.sellItem(params);
	assert.equal(refused.ok, false);
	assert.match(refused.message, /pending confirmation/);
	await client.removeListing({cookies: params.cookies, listingId: '5001'});
	assert.equal(calls[2]?.url, 'https://steamcommunity.com/market/removelisting/5001');
	assert.equal(String(calls[2]?.init.body), 'sessionid=SID');
});

// ===== 上架流程(假 HTTP 客户端 + 假手机确认) =====

const item = (assetid: string, extra: Partial<InventoryItem> = {}): InventoryItem => ({
	assetid, name: 'N' + assetid, marketHashName: 'Item ' + assetid, type: '', category: '', rarity: '', exterior: '', iconUrl: '',
	tradable: true, marketable: true, tradableAfter: '', amount: 1, position: 0, source: 'community', raw: null, ...extra
});

function attempt(name: string, overrides: Partial<Attempt> = {}): Attempt {
	return {
		id: name + '-id', accountName: name, status: 'web_session', currency: 1, currencyISO: 'USD', identitySecret: 'IS', webSessionID: 'sid',
		steamID: '7656' + name, userAgent: 'UA', ...overrides
	} as Attempt;
}

function harness(who: Attempt, inventory: InventoryItem[]) {
	const sold: SellItemParams[] = [];
	const responded: RespondConfirmationsParams[] = [];
	const sleeps: number[] = [];
	const toConfirm: MyListing[] = [];
	let seq = 0;
	// 别的待确认项:一个以前的上架(listing 4000)、一笔交易报价
	const confirmations: Confirmation[] = [
		{id: 'c-old', creator: '4000', nonce: 'n-old', type: 3} as Confirmation,
		{id: 'c-trade', creator: '777', nonce: 'n-trade', type: 2} as Confirmation
	];
	const sellResult: Record<string, SellItemResult | Error> = {};
	const client: SellClient = {
		async sellItem(params) {
			sold.push(params);
			const preset = sellResult[params.assetid];
			if (preset instanceof Error) {
				throw preset;
			}
			if (preset) {
				return preset;
			}
			const listingId = String(5000 + ++seq);
			toConfirm.push({listingId, status: 'to_confirm', appid: params.appid, contextid: params.contextid, assetid: 'new' + params.assetid, originalAssetid: params.assetid} as MyListing);
			confirmations.push({id: 'c' + listingId, creator: listingId, nonce: 'n' + listingId, type: 3} as Confirmation);
			return {ok: true, needsMobileConfirmation: true, needsEmailConfirmation: false, message: ''};
		},
		async fetchMyListings() {
			return [{listingId: '4000', status: 'to_confirm', appid: 730, contextid: '2', assetid: 'x', originalAssetid: '50'} as MyListing, ...toConfirm];
		},
		async removeListing() {},
		async fetchMyHistory() {
			return {start: 0, totalCount: 0, events: []};
		}
	};
	const confirmer: SellConfirmer = {
		async listConfirmations() {
			return confirmations;
		},
		async respondToConfirmations(params) {
			responded.push(params);
		}
	};
	const service = createSellService({
		findAttempt: key => (key === who.accountName || key === who.id ? who : null),
		cookiesFor: () => ['steamLoginSecure=' + who.accountName, 'sessionid=sid'],
		context: async () => ({lowestSellOrderCents: 150, highestBuyOrderCents: 2} as MarketContext),
		client,
		confirmer,
		fetchInventory: async () => inventory,
		sleep: async ms => void sleeps.push(ms),
		sellGapMs: 1500,
		confirmGapMs: 10
	});
	return {service, sold, responded, sleeps, sellResult};
}

test('上架:逐件隔开发;只确认本批两件的确认项,以前的上架和交易报价不碰', async () => {
	const h = harness(attempt('alpha'), [item('101'), item('102'), item('103', {marketable: false, tradableAfter: '2099-01-01T00:00:00.000Z'})]);
	const result = await h.service.sell({account: 'alpha', items: [
		{appid: 730, contextid: '2', assetid: '101', buyerPriceCents: 115},
		{appid: 730, contextid: '2', assetid: '102', receivePriceCents: 200},
		{appid: 730, contextid: '2', assetid: '103', receivePriceCents: 200},
		{appid: 730, contextid: '2', assetid: '999', receivePriceCents: 200}
	]});
	assert.deepEqual(h.sold.map(s => [s.assetid, s.receiveCents]), [['101', 100], ['102', 200]]);
	assert.deepEqual(h.sleeps.filter(ms => ms === 1500), [1500], '两次 sellitem 之间隔一次');
	assert.equal(h.responded.length, 1);
	assert.deepEqual(h.responded[0]?.confirmations.map(c => c.id), ['c5001', 'c5002']);
	assert.equal(h.responded[0]?.accept, true);
	assert.deepEqual(result.results.map(r => [r.assetid, r.status, r.listingId ?? null, r.buyerPriceCents, r.receivePriceCents]), [
		['101', 'listed', '5001', 115, 100],
		['102', 'listed', '5002', 230, 200],
		['103', 'failed', null, 230, 200],
		['999', 'failed', null, 230, 200]
	]);
	assert.match(result.results[2]!.message, /冷却/);
	assert.match(result.results[3]!.message, /库存里没有/);
	assert.deepEqual([result.listed, result.pendingConfirmation, result.failed, result.confirmed, result.needsMobile], [2, 0, 2, 2, false]);
});

test('上架:没 maFile 的留待手机确认,不碰确认列表;一件被 Steam 拒绝不影响其它', async () => {
	const h = harness(attempt('charlie', {identitySecret: ''}), [item('101'), item('102')]);
	h.sellResult['101'] = {ok: false, needsMobileConfirmation: false, needsEmailConfirmation: false, message: 'too many listings'};
	const result = await h.service.sell({account: 'charlie', items: [{appid: 730, assetid: '101', receivePriceCents: 10}, {appid: 730, assetid: '102', receivePriceCents: 10}]});
	assert.deepEqual(result.results.map(r => [r.status, r.listingId ?? null, r.message]), [
		['failed', null, 'too many listings'],
		['pending_confirmation', '5001', '需要在手机上确认(该账号未导入 maFile,不能自动确认)']
	]);
	assert.equal(h.responded.length, 0);
	assert.equal(result.needsMobile, true);
});

test('上架:参数不对整批 400,不发请求;账号不在 404', async () => {
	const h = harness(attempt('alpha'), [item('101')]);
	const bad = async (body: Record<string, unknown>, status: number, pattern: RegExp) => {
		await assert.rejects(h.service.sell(body), (err: Error & {statusCode?: number}) => {
			assert.equal(err.statusCode, status);
			assert.match(err.message, pattern);
			return true;
		});
	};
	await bad({account: 'alpha', items: []}, 400, /请选择/);
	await bad({account: 'alpha', items: [{appid: 730, assetid: '101'}]}, 400, /要填且只填一个/);
	await bad({account: 'alpha', items: [{appid: 730, assetid: '101', buyerPriceCents: 2}]}, 400, /价格过低/);
	await bad({account: 'alpha', items: [{appid: 730, assetid: '101', receivePriceCents: 1.5}]}, 400, /正整数/);
	await bad({account: 'alpha', items: [{appid: 730, assetid: '101', buyerPriceCents: 200001}]}, 400, /上限/);
	await bad({account: 'alpha', items: [{appid: 730, assetid: '101', receivePriceCents: 5}, {appid: 730, assetid: '101', receivePriceCents: 5}]}, 400, /重复/);
	await bad({account: 'alpha', items: [{appid: 730, assetid: 'abc', receivePriceCents: 5}]}, 400, /assetid/);
	await bad({account: 'ghost', items: [{appid: 730, assetid: '101', receivePriceCents: 5}]}, 404, /不存在/);
	assert.equal(h.sold.length, 0);
});

test('参考价:最低在售 / 最高求购各自拆出到手价;太低的给 null', async () => {
	const h = harness(attempt('alpha'), []);
	const price = await h.service.price({account: 'alpha', appid: 730, marketHashName: 'X'});
	assert.deepEqual(price.lowestSell, {buyerPrice: 150, receive: 131, steamFee: 6, publisherFee: 13, fees: 19});
	assert.equal(price.highestBuyOrder, null);
	assert.deepEqual(h.service.quote({receivePriceCents: '100'}), {buyerPrice: 115, receive: 100, steamFee: 5, publisherFee: 10, fees: 15});
});
