import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMarketClient, describeBuyOrderError, listingUrl, parseListingUrl, parseSearchResults} from './client.ts';

interface Sent {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

/** 假 fetch:按 URL 前缀回包,记下发出的请求;回包是 'throw' 时模拟断网 */
function fakeFetch(replies: Record<string, string | 'throw'>) {
	const sent: Sent[] = [];
	const http = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		sent.push({url, method: init?.method ?? 'GET', headers: {...init?.headers as Record<string, string>}, body: init?.body ? String(init.body) : null});
		const key = Object.keys(replies).find(prefix => url.startsWith(prefix));
		const reply = key === undefined ? 'throw' : replies[key];
		if (reply === 'throw' || reply === undefined) {
			throw new TypeError('network down');
		}
		return new Response(reply);
	}) as typeof fetch;
	return {http, sent};
}

const C = 'https://steamcommunity.com';
const json = (value: unknown) => JSON.stringify(value);

test('商品链接:完整 URL 或路径都行,物品名解码一次;格式不对报错', () => {
	assert.deepEqual(parseListingUrl('https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20(Field-Tested)?l=schinese'),
		{appid: 730, marketHashName: 'AK-47 | Redline (Field-Tested)'});
	assert.deepEqual(parseListingUrl('/market/listings/440/Mann%20Co.%20Supply%20Crate%20Key#x'), {appid: 440, marketHashName: 'Mann Co. Supply Crate Key'});
	assert.deepEqual(parseListingUrl('https://steamcommunity.com/market/listings/730/100%'), {appid: 730, marketHashName: '100%'}, '解不开就保留原样');
	assert.throws(() => parseListingUrl('  '), /请填写市场商品链接/);
	assert.throws(() => parseListingUrl('https://steamcommunity.com/market/'), /链接格式不对/);
	assert.throws(() => parseListingUrl('https://steamcommunity.com/market/listings/0/x'), /缺少有效的 appid/);
	assert.throws(() => parseListingUrl('https://steamcommunity.com/market/listings/730/G1807209A023004'), /新版市场的分组链接/);
	assert.equal(listingUrl(730, 'A | B/?'), 'https://steamcommunity.com/market/listings/730/A%20%7C%20B%2F%3F');
});

test('挂求购:表单字段、Referer、sessionid 同时进 cookie 和表单', async () => {
	const {http, sent} = fakeFetch({[C + '/market/createbuyorder/']: json({success: 1, buy_orderid: 777})});
	const client = createMarketClient({fetch: http});
	const result = await client.createBuyOrder({
		cookies: ['steamLoginSecure=x'], sessionid: 'sid-1', userAgent: 'UA', appid: 730, marketHashName: 'AK | 红线',
		currency: 23, priceTotalCents: 300, quantity: 3
	});
	assert.deepEqual(result, {success: true, buyOrderId: '777', confirmationId: '', needsConfirmation: false});
	const [request] = sent;
	assert.equal(request?.method, 'POST');
	assert.equal(request?.headers.Cookie, 'steamLoginSecure=x; sessionid=sid-1');
	assert.equal(request?.headers.Referer, listingUrl(730, 'AK | 红线'));
	assert.equal(request?.headers['User-Agent'], 'UA');
	assert.deepEqual(Object.fromEntries(new URLSearchParams(request?.body ?? '')), {
		sessionid: 'sid-1', currency: '23', appid: '730', market_hash_name: 'AK | 红线', price_total: '300', quantity: '3',
		billing_state: '', save_my_address: '0'
	});
});

test('挂求购:cookie 里已有 sessionid 就用它;手机确认后重发带 confirmation(只留数字)', async () => {
	const {http, sent} = fakeFetch({[C + '/market/createbuyorder/']: json({success: 1, buy_orderid: '8'})});
	const client = createMarketClient({fetch: http});
	await client.createBuyOrder({cookies: ['sessionid=abc%3D', 'a=1'], sessionid: 'ignored', appid: 440, marketHashName: 'Key', currency: 1, priceTotalCents: 5, quantity: 1, confirmation: '12ab34'});
	assert.equal(sent[0]?.headers.Cookie, 'sessionid=abc%3D; a=1');
	const form = new URLSearchParams(sent[0]?.body ?? '');
	assert.equal(form.get('sessionid'), 'abc=');
	assert.equal(form.get('confirmation'), '1234');
});

test('挂求购:success=22 要手机确认,带出 confirmation_id', async () => {
	const {http} = fakeFetch({[C + '/market/createbuyorder/']: json({success: 22, need_confirmation: true, confirmation: {confirmation_id: '555'}})});
	const result = await createMarketClient({fetch: http}).createBuyOrder({cookies: ['sessionid=s'], appid: 730, marketHashName: 'X', currency: 1, priceTotalCents: 1, quantity: 1});
	assert.deepEqual(result, {success: true, buyOrderId: '', confirmationId: '555', needsConfirmation: true});
});

test('挂求购:参数不对不发请求;Steam 拒绝时给出能看懂的原因', async () => {
	const {http, sent} = fakeFetch({[C + '/market/createbuyorder/']: json({success: 25})});
	const client = createMarketClient({fetch: http});
	const base = {cookies: ['sessionid=s'], appid: 730, marketHashName: 'X', currency: 1, priceTotalCents: 100, quantity: 1};
	await assert.rejects(client.createBuyOrder({...base, cookies: []}), /缺少 WebSession cookies/);
	await assert.rejects(client.createBuyOrder({...base, currency: null}), /钱包币种未知/);
	await assert.rejects(client.createBuyOrder({...base, quantity: 0}), /求购数量必须为正整数/);
	await assert.rejects(client.createBuyOrder({...base, priceTotalCents: 0}), /求购价格无效/);
	await assert.rejects(client.createBuyOrder({...base, cookies: ['a=1']}), /找不到 sessionid/);
	assert.equal(sent.length, 0);
	await assert.rejects(client.createBuyOrder(base), /已达求购单数量上限/);

	const html = fakeFetch({[C + '/market/createbuyorder/']: '<html>login</html>'});
	await assert.rejects(createMarketClient({fetch: html.http}).createBuyOrder(base), /cookie 可能已失效/);
});

test('错误文案:Steam 给了 message 就用它,未知码带上原始返回', () => {
	assert.equal(describeBuyOrderError(16, '你已有求购'), '你已有求购(success=16)');
	assert.equal(describeBuyOrderError(8), '参数无效(物品名或价格不正确)');
	assert.equal(describeBuyOrderError(99, '', '{"success":99}'), '挂求购单失败(success=99):{"success":99}');
	assert.equal(describeBuyOrderError(99, '', '', '撤销求购单失败'), '撤销求购单失败(success=99)');
});

test('撤单:只有 success=1 算成功;失败文案说的是撤单', async () => {
	const ok = fakeFetch({[C + '/market/cancelbuyorder/']: json({success: 1})});
	assert.deepEqual(await createMarketClient({fetch: ok.http}).cancelBuyOrder({cookies: ['a=1'], sessionid: 'sid', buyOrderId: ' 42 '}), {success: true});
	assert.equal(ok.sent[0]?.body, 'sessionid=sid&buy_orderid=42');
	assert.equal(ok.sent[0]?.headers.Referer, C + '/market/');

	const bad = fakeFetch({[C + '/market/cancelbuyorder/']: json({success: 99})});
	await assert.rejects(createMarketClient({fetch: bad.http}).cancelBuyOrder({cookies: ['sessionid=s'], buyOrderId: '42'}), /^Error: 撤销求购单失败\(success=99\)/);
	const html = fakeFetch({[C + '/market/cancelbuyorder/']: 'login page'});
	await assert.rejects(createMarketClient({fetch: html.http}).cancelBuyOrder({cookies: ['sessionid=s'], buyOrderId: '42'}), /cookie 可能已失效/);
	await assert.rejects(createMarketClient({fetch: html.http}).cancelBuyOrder({cookies: ['sessionid=s'], buyOrderId: ''}), /缺少 buy_orderid/);
});

test('我的求购单:按 buy_orderid 标准化,丢掉没有 id 的', async () => {
	const {http, sent} = fakeFetch({[C + '/market/mylistings/']: json({success: true, buy_orders: [
		{buy_orderid: '1', price: '300', quantity: '3', quantity_remaining: '2', description: {appid: 730, market_hash_name: 'AK'}},
		{buy_orderid: 2, price: 5, quantity: 1, description: {appid: '440', name: 'Key'}},
		{price: 1}
	]})});
	assert.deepEqual(await createMarketClient({fetch: http}).fetchMyBuyOrders({cookies: ['a=1'], sessionid: 'sid'}), [
		{buyOrderId: '1', priceCents: 300, quantity: 3, quantityRemaining: 2, appid: 730, marketHashName: 'AK'},
		{buyOrderId: '2', priceCents: 5, quantity: 1, quantityRemaining: null, appid: 440, marketHashName: 'Key'}
	]);
	assert.equal(sent[0]?.url, C + '/market/mylistings/?norender=1&start=0&count=100');
	assert.equal(sent[0]?.headers.Cookie, 'a=1; sessionid=sid');

	const failed = fakeFetch({[C + '/market/mylistings/']: json({success: false})});
	await assert.rejects(createMarketClient({fetch: failed.http}).fetchMyBuyOrders({cookies: ['a=1']}), /读取求购单失败/);
});

test('行情:有 nameid 就不抓商品页,直接查盘口;没有求购时最高求购是 0(前端据此建议出价 0.01)', async () => {
	const {http, sent} = fakeFetch({
		[C + '/market/listings/']: '<title>Steam Community Market :: Listings for AK-47 | Redline</title>',
		[C + '/market/itemordershistogram']: json({success: 1, highest_buy_order: null, lowest_sell_order: '150'}),
		[C + '/market/priceoverview/']: json({success: true, lowest_price: '$1.50', median_price: '$1.40', volume: '1,234'})
	});
	const context = await createMarketClient({fetch: http}).fetchMarketContext({
		appid: 730, marketHashName: 'AK-47 | Redline', itemNameId: 'id-42', cookies: ['a=1'], currency: 23, country: 'cn'
	});
	assert.deepEqual(context, {
		appid: 730, marketHashName: 'AK-47 | Redline', currency: 23, itemNameId: '42', itemName: '',
		highestBuyOrderCents: 0, lowestSellOrderCents: 150, lowestPrice: '$1.50', medianPrice: '$1.40', volume: '1,234'
	});
	assert.equal(sent.length, 2);
	const histogram = new URL(sent[0]?.url ?? '');
	assert.deepEqual(Object.fromEntries(histogram.searchParams), {country: 'CN', language: 'english', currency: '23', item_nameid: '42', two_factor: '0'});
	assert.equal(sent[0]?.headers.Referer, listingUrl(730, 'AK-47 | Redline'));
});

test('行情:尽力而为,哪一步断网都不抛;老页面还能抓到 nameid', async () => {
	const {http, sent} = fakeFetch({
		[C + '/market/listings/']: '<script>Market_LoadOrderSpread( 176096390 );</script><span id="largeiteminfo_item_name" class="x">红线 &amp; 蓝 </span>',
		[C + '/market/itemordershistogram']: 'throw'
	});
	const context = await createMarketClient({fetch: http}).fetchMarketContext({appid: 730, marketHashName: 'X'});
	assert.equal(context.itemNameId, '176096390');
	assert.equal(context.itemName, '红线 & 蓝');
	assert.equal(context.highestBuyOrderCents, null);
	assert.equal(context.lowestPrice, '');
	assert.equal(sent.length, 3);
	assert.equal(sent[0]?.headers.Cookie, undefined, '没有 cookie 就不带 Cookie 头');
});

const SEARCH_JSON = {success: true, results: [
	{name: '千瓦武器箱', hash_name: 'Kilowatt Case', sell_listings: 763174, sell_price: 13, sell_price_text: '$0.13', app_name: 'Counter-Strike 2',
		asset_description: {appid: 730, icon_url: 'ICON', market_hash_name: 'Kilowatt Case', market_bucket_group_id: 'G18A8263004'}},
	{name: 'Key', sell_listings: 0, asset_description: {appid: 440, market_hash_name: 'Mann Co. Supply Crate Key'}},
	{name: '没有 appid', hash_name: 'X', asset_description: {}},
	{name: '没有英文名', asset_description: {appid: 730}}
]};

test('搜商品:请求参数(中文、热门排序、不渲染);结果标准化,丢掉缺 appid / 英文名的', async () => {
	const {http, sent} = fakeFetch({[C + '/market/search/render/']: json(SEARCH_JSON)});
	const items = await createMarketClient({fetch: http}).searchItems({query: 'AK | 红线', appid: 730, cookies: ['a=1', ''], userAgent: 'UA', count: 30});
	assert.deepEqual(items, [
		{appid: 730, marketHashName: 'Kilowatt Case', name: '千瓦武器箱', appName: 'Counter-Strike 2',
			iconUrl: 'https://community.cloudflare.steamstatic.com/economy/image/ICON/62fx62f', sellListings: 763174, sellPriceText: '$0.13', groupId: 'G18A8263004'},
		{appid: 440, marketHashName: 'Mann Co. Supply Crate Key', name: 'Key', appName: '', iconUrl: '', sellListings: 0, sellPriceText: '', groupId: ''}
	]);
	const url = new URL(sent[0]?.url ?? '');
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		query: 'AK | 红线', start: '0', count: '30', search_descriptions: '0', sort_column: 'popular', sort_dir: 'desc', appid: '730', norender: '1', l: 'schinese'
	});
	assert.equal(sent[0]?.headers.Cookie, 'a=1');
	assert.equal(sent[0]?.headers['User-Agent'], 'UA');

	const anonymous = fakeFetch({[C + '/market/search/render/']: json(SEARCH_JSON)});
	await createMarketClient({fetch: anonymous.http}).searchItems({query: 'x'});
	const anonymousUrl = new URL(anonymous.sent[0]?.url ?? '');
	assert.equal(anonymousUrl.searchParams.has('appid'), false, '不传 appid 搜全部游戏');
	assert.equal(anonymousUrl.searchParams.get('count'), '20');
	assert.equal(anonymous.sent[0]?.headers.Cookie, undefined);
	assert.deepEqual(parseSearchResults(null), []);
});

test('搜商品:限流、非 JSON、success=false 都报错', async () => {
	const limited = (async () => new Response('Too Many Requests', {status: 429})) as typeof fetch;
	await assert.rejects(createMarketClient({fetch: limited}).searchItems({query: 'x'}), /限流了\(429\)/);
	const html = fakeFetch({[C + '/market/search/render/']: '<html>error</html>'});
	await assert.rejects(createMarketClient({fetch: html.http}).searchItems({query: 'x'}), /没返回搜索结果\(HTTP 200\)/);
	const failed = fakeFetch({[C + '/market/search/render/']: json({success: false})});
	await assert.rejects(createMarketClient({fetch: failed.http}).searchItems({query: 'x'}), /没返回搜索结果/);
});

test('分组链接:读页面标题里的分组名(解实体、去掉站名后缀);只读到 </title>;打不开报错', async () => {
	let pulled = 0;
	const sentBig: Array<{url: string; headers: Record<string, string>}> = [];
	const chunks = ['<html><head><title>Dreams &amp; Nightmares Case', ' - Steam Community Market</title></head>', ...Array.from({length: 50}, () => 'x'.repeat(100_000))];
	const big = (async (input: string | URL, init?: RequestInit) => {
		sentBig.push({url: String(input), headers: {...init?.headers as Record<string, string>}});
		return new Response(new ReadableStream({
			pull(controller) {
				const chunk = chunks[pulled++];
				if (chunk === undefined) {
					controller.close();
				} else {
					controller.enqueue(new TextEncoder().encode(chunk));
				}
			}
		}));
	}) as typeof fetch;
	assert.equal(await createMarketClient({fetch: big}).fetchGroupName({appid: 730, groupId: 'G18A8263004', cookies: ['a=1']}), 'Dreams & Nightmares Case');
	assert.equal(sentBig[0]?.url, C + '/market/listings/730/G18A8263004');
	assert.equal(sentBig[0]?.headers.Cookie, 'a=1');
	assert.ok(pulled < 5, `读到标题就停,实际读了 ${pulled} 块`);

	const zh = fakeFetch({[C + '/market/listings/']: '<title>AK-47 | 红线 - Steam 社区市场</title>'});
	assert.equal(await createMarketClient({fetch: zh.http}).fetchGroupName({appid: 730, groupId: 'G1807209A023004'}), 'AK-47 | 红线');

	const missing = (async () => new Response('Not Found', {status: 404})) as typeof fetch;
	await assert.rejects(createMarketClient({fetch: missing}).fetchGroupName({appid: 730, groupId: 'G1'}), /HTTP 404/);
	const blank = fakeFetch({[C + '/market/listings/']: '<html></html>'});
	await assert.rejects(createMarketClient({fetch: blank.http}).fetchGroupName({appid: 730, groupId: 'G1'}), /没有分组名/);
});
