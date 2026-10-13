import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {decodeJwt, generateHeaders, UuAccount} from './client.ts';
import {UuApiCrypt} from './crypt.ts';

const JWT = 'h.' + Buffer.from(JSON.stringify({Id: 12345, Name: '卖家', exp: 2000000000})).toString('base64url') + '.s';

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
}

/** 按路径返回固定响应(函数则按第几次调用返回),记录每次请求 */
function mockFetch(t: TestContext, routes: Record<string, unknown | ((n: number) => unknown)>): Call[] {
	const calls: Call[] = [];
	const counts = new Map<string, number>();
	t.mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit = {}) => {
		const url = String(input);
		const path = new URL(url).pathname;
		counts.set(path, (counts.get(path) ?? 0) + 1);
		calls.push({url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null});
		const route = routes[path];
		const value = typeof route === 'function' ? (route as (n: number) => unknown)(counts.get(path) as number) : route;
		if (typeof value === 'string') {
			return new Response(value, {status: 502});
		}
		return new Response(JSON.stringify(value ?? {code: -1, msg: 'no route'}), {status: 200});
	});
	return calls;
}

const quiet = {logger() {}};
const WAIT = '/api/youpin/bff/trade/sell/page/v1/waitDeliver/waitDeliverList';
const DETAIL = '/api/youpin/bff/trade/v1/order/query/detail';

test('JWT 里解出身份;构造时按游戏选网关', () => {
	assert.deepEqual(decodeJwt(JWT), {Id: 12345, Name: '卖家', exp: 2000000000});
	assert.equal(decodeJwt('garbage'), null);
	const tf2 = new UuAccount(JWT, quiet);
	assert.deepEqual([tf2.userId, tf2.nickname, tf2.jwtExp, tf2.gameId, tf2.host], [12345, '卖家', 2000000000, '440', 'g3-api.youpin898.com']);
	assert.equal(new UuAccount(JWT, {gameId: 730, ...quiet}).host, 'api.youpin898.com');
	assert.equal(new UuAccount(' ' + JWT + ' ', quiet).token, JWT);
});

test('待发货列表:Bearer token + 游戏头 + 设备会话;字段展开', async (t: TestContext) => {
	const calls = mockFetch(t, {[WAIT]: {code: 0, data: {waitDeliverList: [{
		orderInfoVO: {orderNo: 'O1', orderSubStatus: 1103, orderSubStatusName: '待您确认报价', sellAmount: '9.90'},
		commodityInfoVO: {commodityName: 'AK-47 | 红线', commodityHashName: 'AK-47 | Redline', commodityTemplateId: 7}
	}]}}});
	const uu = new UuAccount(JWT, {gameId: 730, deviceToken: 'DEV', ...quiet});
	const [order] = await uu.getWaitDeliverList();
	assert.deepEqual({...order, raw: undefined}, {
		orderNo: 'O1', orderId: undefined, orderStatus: undefined, orderSubStatus: 1103, subStatusName: '待您确认报价', statusName: undefined,
		itemName: 'AK-47 | 红线', hashName: 'AK-47 | Redline', templateId: 7, sellAmount: '9.90', raw: undefined
	});
	const [call] = calls;
	assert.equal(call?.url, 'https://api.youpin898.com' + WAIT);
	assert.equal(call?.method, 'POST');
	assert.equal(call?.headers.authorization, 'Bearer ' + JWT);
	assert.equal(call?.headers.gameid, '730');
	assert.equal(call?.headers.deviceid, 'DEV');
	assert.equal(call?.headers.uk?.length, 65, '随机 uk');
	assert.equal(JSON.parse(call?.headers['device-info'] ?? '{}').requestTag, call?.headers.requesttag);
	assert.deepEqual(call?.body, {gameId: 730, pageIndex: 1, pageSize: 100, Sessionid: 'DEV'});
});

test('登录失效(84101)、非 JSON、业务失败都抛错', async (t: TestContext) => {
	mockFetch(t, {[WAIT]: (n: number) => [{Code: 84101}, '<html>bad gateway', {code: 7, msg: '风控'}][n - 1]});
	const uu = new UuAccount(JWT, quiet);
	await assert.rejects(uu.getWaitDeliverList(), /登录状态失效/);
	await assert.rejects(uu.getWaitDeliverList(), /UU 返回非 JSON \(HTTP 502\): <html>bad gateway/);
	await assert.rejects(uu.getWaitDeliverList(), /获取待发货列表失败: 风控/);
});

test('create 先验证 token:解不出用户 id 或待发货列表报错都失败', async (t: TestContext) => {
	mockFetch(t, {[WAIT]: (n: number) => (n === 1 ? {code: 0, data: {}} : {code: 1, msg: 'token 无效'})});
	assert.equal((await UuAccount.create(JWT, quiet)).getUserNickname(), '卖家');
	await assert.rejects(UuAccount.create(JWT, quiet), /token 无效/);
	await assert.rejects(UuAccount.create('not-a-jwt', quiet), /无法从 token 解析出用户ID/);
});

test('可发货订单:逐单补报价号(间隔 3 秒),单个详情失败不影响其它', async (t: TestContext) => {
	t.mock.timers.enable({apis: ['setTimeout']});
	mockFetch(t, {
		[WAIT]: {code: 0, data: {waitDeliverList: ['A', 'B'].map(orderNo => ({orderInfoVO: {orderNo}, commodityInfoVO: {}}))}},
		[DETAIL]: (n: number) => (n === 1 ? {code: 1, msg: '详情失败'} : {code: 0, data: {tradeOfferId: '777', offerSendResult: 3}})
	});
	const warnings: string[] = [];
	const pending = new UuAccount(JWT, {logger: (level, message) => level === 'warn' && warnings.push(message)}).getDeliverableOrders();
	for (let i = 0; i < 10; i++) {
		await new Promise(resolve => setImmediate(resolve));
	}
	t.mock.timers.tick(3000);
	const orders = await pending;
	assert.deepEqual(orders.map(order => [order.orderNo, order.tradeOfferId, order.offerSendResult]), [['A', null, null], ['B', '777', 3]]);
	assert.deepEqual(warnings, ['订单 A 取详情失败: 获取订单详情失败: 详情失败']);
});

test('发报价 / 查发送状态 / 确认报价的返回约定', async (t: TestContext) => {
	const calls = mockFetch(t, {
		'/api/youpin/bff/trade/v1/order/sell/delivery/send-offer': (n: number) => (n === 1 ? {code: 0} : {code: 2, msg: '已发送'}),
		'/api/youpin/bff/trade/v1/order/sell/delivery/get-offer-status': (n: number) => (n === 1 ? {code: 0, data: {status: 3}} : {code: 1, msg: '查询失败'}),
		'/api/youpin/bff/trade/v1/order/sell/delivery/confirmOffer': (n: number) => [{code: 0, data: {success: true}}, {code: 0, data: {success: false}}, {code: 9, msg: '订单状态已变'}][n - 1]
	});
	const uu = new UuAccount(JWT, {deviceToken: 'DEV', ...quiet});
	assert.equal(await uu.sendOffer('O1'), true);
	assert.equal(await uu.sendOffer('O1'), '已发送');
	assert.equal(calls[0]?.method, 'PUT');
	assert.deepEqual(await uu.getOfferStatus('O1'), {status: 3});
	assert.equal(await uu.getOfferStatus('O1'), '查询失败');
	assert.equal(await uu.confirmOffer('O1', '555'), true);
	assert.equal(await uu.confirmOffer('O1', '555'), false);
	assert.equal(await uu.confirmOffer('O1', '555'), '订单状态已变');
	assert.deepEqual(calls.at(-1)?.body, {confirmOrder: {orderNo: 'O1', tradeOfferId: 555}, Sessionid: 'DEV'});
});

test('上架:50 个一批、不带 uk;撞上合规确认门报专门的错误', async (t: TestContext) => {
	const SELL = '/api/commodity/Inventory/SellInventoryWithLeaseV2';
	const calls = mockFetch(t, {[SELL]: (n: number) => (n <= 3 ? {Code: 0, Data: [{Status: 1}, {Status: 0}]} : {Code: 7000002, errorData: {sceneName: '交易撤回须知'}})});
	const uu = new UuAccount(JWT, {gameId: 730, ...quiet});
	const items = Array.from({length: 120}, (_, i) => ({AssetId: i, Price: 1.5}));
	assert.deepEqual({...(await uu.sellItems(items)), results: undefined}, {success: 3, fail: 3, results: undefined});
	assert.deepEqual(calls.map(call => (call.body?.ItemInfos as unknown[]).length), [50, 50, 20]);
	assert.equal(calls[0]?.headers.uk, undefined);
	assert.deepEqual((calls[0]?.body?.ItemInfos as unknown[])[0], {AssetId: 0, IsCanLease: false, IsCanSold: true, Price: 1.5, Remark: ''});
	await assert.rejects(uu.sellItems(items.slice(0, 1)), (err: Error & {uuSceneConfirm?: boolean}) =>
		!!err.uuSceneConfirm && err.message === '需先在悠悠有品 App 内手动上架一次并确认「交易撤回须知」（一次性合规确认），之后自动上架即可正常工作 (code 7000002)');
});

test('改价:明细计数、汇总优先、没有明细算全成功;失败报错', async (t: TestContext) => {
	const PRICE = '/api/commodity/Commodity/PriceChangeWithLeaseV2';
	mockFetch(t, {[PRICE]: (n: number) => [
		{Code: 0, Data: {Commoditys: [{IsSuccess: 1}, {IsSuccess: 0}]}},
		{Code: 0, Data: {Commoditys: [{IsSuccess: 1}], SuccessCount: 5, FailCount: 2}},
		{Code: 0},
		{Code: 5, errorData: {sceneCode: 'withdraw', sceneTitle: '须知'}},
		{Code: 4, Msg: '价格过低'}
	][n - 1]});
	const uu = new UuAccount(JWT, quiet);
	const one = [{CommodityId: 1, Price: 2}, {CommodityId: 2, Price: 3}];
	assert.deepEqual(await uu.changeSalePrice(one), {success: 1, fail: 1});
	assert.deepEqual(await uu.changeSalePrice(one), {success: 5, fail: 2});
	assert.deepEqual(await uu.changeSalePrice(one), {success: 2, fail: 0});
	await assert.rejects(uu.changeSalePrice(one), /确认「须知」（一次性合规确认）后再改价 \(code 5\)/);
	await assert.rejects(uu.changeSalePrice(one), /改价失败: code=4 价格过低/);
});

test('在售列表:分页拉全,只要带 steamAssetId 的;接口报错就停', async (t: TestContext) => {
	const LIST = '/api/youpin/bff/new/commodity/v1/commodity/list/sell';
	const calls = mockFetch(t, {[LIST]: (n: number) => (n <= 2
		? {code: 0, data: {commodityInfoList: [{id: n * 10, steamAssetId: 'a'}, {id: 'no-asset'}]}}
		: {code: 0, data: {commodityInfoList: [{id: 99, steamAssetId: 'b'}]}})});
	const list = await new UuAccount(JWT, quiet).getSellList({pageSize: 2});
	assert.deepEqual(list.map(item => item.id), [10, 20, 99]);
	assert.deepEqual(calls.map(call => call.body?.pageIndex), [1, 2, 3]);
	assert.equal(new URL(calls[0]?.url ?? '').host, 'api.youpin898.com', 'TF2 账号的在售列表也打 CS2 网关');
});

test('市场查价:PC 平台 + 真 uk(握手失败退回随机 uk 并告警)', async (t: TestContext) => {
	const calls = mockFetch(t, {
		'/api/deviceW2': 'server error',
		'/api/homepage/pc/goods/market/queryOnSaleCommodityList': {Code: 0, Data: [{price: '12.5'}]}
	});
	const warnings: string[] = [];
	const uu = new UuAccount(JWT, {logger: (level, message) => level === 'warn' && warnings.push(message)});
	assert.deepEqual(await uu.getMarketSaleListWithAbrade(7, {minAbrade: 0.15, maxAbrade: 0.18}), [{price: '12.5'}]);
	const query = calls.find(call => call.url.includes('queryOnSaleCommodityList'));
	assert.equal(query?.headers.platform, 'pc');
	assert.equal(query?.headers.uk?.length, 65);
	assert.deepEqual(query?.body, {pageIndex: 1, pageSize: 20, templateId: '7', minAbrade: '0.15', maxAbrade: '0.18'});
	assert.deepEqual(warnings, ['获取悠悠校验参数(uk)失败，本次使用随机 uk']);
});

test('绑定的 Steam 账号:解析 steamCookie;解析失败不报错', async (t: TestContext) => {
	const PULL = '/api/youpin/bff/steam/cookie/pull';
	mockFetch(t, {[PULL]: (n: number) => [
		{code: 0, data: {steamCookie: JSON.stringify({steamId: '76561198000000001'})}},
		{code: 0, data: {steamCookie: 'not json'}},
		{code: 5, msg: '未绑定'}
	][n - 1]});
	const uu = new UuAccount(JWT, quiet);
	assert.equal((await uu.getSteamCookiePull()).steamId, '76561198000000001');
	assert.equal((await uu.getSteamCookiePull()).steamId, '');
	await assert.rejects(uu.getSteamCookiePull(), /获取绑定 Steam 信息失败: 未绑定/);
});

test('短信登录:下行用 SmsSignIn,验证码为空走上行 SmsUpSignIn;旧版请求头带设备指纹', async (t: TestContext) => {
	const calls = mockFetch(t, {
		'/api/user/Auth/SendSignInSmsCode': {Code: 0, Msg: '发送成功'},
		'/api/user/Auth/SmsSignIn': {Data: {Token: 'T1'}},
		'/api/user/Auth/SmsUpSignIn': {Data: {Token: 'T2'}}
	});
	const headers = generateHeaders('DEV', 'DEV', '', '730');
	assert.equal(headers.Gameid, '730');
	assert.equal(JSON.parse(headers['Device-Info'] ?? '{}').deviceId, 'DEV');
	assert.equal((await UuAccount.sendLoginSmsCode('13800000000', 'DEV', {headers, uk: 'REAL-UK'})).Msg, '发送成功');
	assert.equal(calls[0]?.headers.uk, 'REAL-UK');
	assert.deepEqual(calls[0]?.body, {Area: 86, Mobile: '13800000000', Sessionid: 'DEV', Code: ''});
	assert.equal((await UuAccount.smsSignIn('13800000000', '1234', 'DEV')).Data.Token, 'T1');
	assert.equal((await UuAccount.smsSignIn('13800000000', '', 'DEV')).Data.Token, 'T2');
	assert.deepEqual(calls.at(-1)?.body, {Area: 86, Code: '', DeviceName: 'DEV', Sessionid: 'DEV', Mobile: '13800000000'});
});

test('uk 握手加密:AES 往返、RSA 加密的密钥长度对', () => {
	const crypt = new UuApiCrypt('0123456789abcdef');
	assert.equal(crypt.decrypt(crypt.encrypt('{"iud":"x"}')), '{"iud":"x"}');
	assert.equal(Buffer.from(crypt.getEncryptedAesKey(), 'base64').length, 256, 'RSA-2048');
	assert.throws(() => new UuApiCrypt('short'), /必须为 16 字节/);
});
