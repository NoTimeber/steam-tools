import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ACCEPT_ENCODING, C5Error, C5NetworkError, createC5Client, parseJsonKeepingBigInts} from './client.ts';

const SECRET = 'SECRET-APP-KEY';

interface Sent {
	url: URL;
	method: string;
	headers: Record<string, string>;
	body: string | undefined;
}

/** 假 fetch:result 是 Response 就回它,是 Error 就抛 */
function make(result: Response | Error | (() => Response)) {
	const sent: Sent[] = [];
	const http = (async (input: string | URL | Request, init?: RequestInit) => {
		sent.push({url: new URL(String(input)), method: String(init?.method), headers: init?.headers as Record<string, string>, body: init?.body as string | undefined});
		if (result instanceof Error) {
			throw result;
		}
		return typeof result === 'function' ? result() : result.clone();
	}) as typeof fetch;
	return {client: createC5Client({appKey: SECRET, fetch: http}), sent};
}

const ok = (data: unknown) => new Response(JSON.stringify({success: true, data}), {status: 200});
const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), {cause: Object.assign(new Error(`connect ${code} 1.2.3.4:443`), {code})});

test('请求带 app-key 和官方要求的 Accept-Encoding', async () => {
	const {client, sent} = make(ok({moneyAmount: 1.5}));
	assert.deepEqual(await client.balance(), {moneyAmount: 1.5});
	assert.equal(sent[0]!.url.origin + sent[0]!.url.pathname, 'https://openapi.c5game.com/merchant/account/v2/balance');
	assert.equal(sent[0]!.url.searchParams.get('app-key'), SECRET);
	assert.equal(sent[0]!.method, 'GET');
	assert.equal(sent[0]!.headers['Accept-Encoding'], ACCEPT_ENCODING);
});

test('64 位在售 id:响应里按原文保留,下单时按原样的数字写回', async () => {
	const big = '1444544795338493955';
	assert.notEqual(String(Number(big)), big, '这个数 JS 数字放不下');
	const search = make(() => new Response(`{"success":true,"data":{"list":[{"productId":${big},"price":2.2,"assetInfo":{"amount":1}}]}}`));
	const list = await search.client.searchProducts({appId: 730, name: 'Kilowatt Case', priceMax: 3});
	assert.equal(list[0].productId, big);
	assert.equal(list[0].price, 2.2);
	assert.deepEqual(JSON.parse(search.sent[0]!.body!), {appId: 730, marketHashName: 'Kilowatt Case', priceMax: 3, assetType: 1, pageSize: 50});

	const buy = make(ok({successList: []}));
	await buy.client.batchBuy('https://t', [{productId: big, buyPrice: 2.2, outTradeNo: '1'}]);
	const body = buy.sent[0]!.body!;
	assert.ok(body.includes(`"productId":${big},`), body);
	assert.deepEqual(parseJsonKeepingBigInts(body), {tradeUrl: 'https://t', productList: [{productId: big, buyPrice: 2.2, outTradeNo: '1'}]});
});

test('平台明确拒绝:C5Error,带错误码', async () => {
	const {client} = make(new Response(JSON.stringify({success: false, errorCode: 400001, errorMsg: '请输入正确的 app-Key'})));
	await assert.rejects(client.balance(), (err: unknown) => {
		assert.ok(err instanceof C5Error);
		assert.ok(!(err instanceof C5NetworkError));
		assert.equal(err.code, 400001);
		return true;
	});
});

test('失败分类:没连上 / 4xx 肯定没生效,超时 / 断连 / 5xx 结果未知;报错里没有 app-key', async () => {
	const cases: Array<[Response | Error, boolean]> = [
		[fetchFailed('ECONNREFUSED'), false],
		[fetchFailed('UND_ERR_CONNECT_TIMEOUT'), false],
		[fetchFailed('ECONNRESET'), true],
		[fetchFailed('UND_ERR_SOCKET'), true],
		[Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'}), true],
		[new Response('<html>bad gateway</html>', {status: 502}), true],
		[new Response('forbidden', {status: 403}), false]
	];
	for (const [result, ambiguous] of cases) {
		const {client} = make(result);
		await assert.rejects(client.batchBuy('https://t', []), (err: unknown) => {
			assert.ok(err instanceof C5Error, String(err));
			assert.equal(err instanceof C5NetworkError, ambiguous, err.message);
			assert.ok(!err.message.includes(SECRET));
			assert.equal((err as {cause?: unknown}).cause, undefined);
			return true;
		});
	}
});

test('行情按 100 个一批查', async () => {
	const {client, sent} = make(() => ok({}));
	const names = Array.from({length: 230}, (_, i) => `item ${i}`);
	await client.itemStats(730, names);
	assert.deepEqual(sent.map(s => JSON.parse(s.body!).marketHashNames.length), [100, 100, 30]);
});

test('订单查不到返回 null,其它失败照抛', async () => {
	assert.equal(await make(new Response(JSON.stringify({success: false, errorCode: 1, errorMsg: '订单不存在'}))).client.orderDetail('1'), null);
	assert.equal(await make(ok(null)).client.orderDetail('1'), null);
	await assert.rejects(make(new Response(JSON.stringify({success: false, errorCode: 2, errorMsg: '请求过于频繁'}))).client.orderDetail('1'), C5Error);
	await assert.rejects(make(fetchFailed('ECONNRESET')).client.orderDetail('1'), C5NetworkError);
	const {client, sent} = make(ok({orderId: 1}));
	await client.orderDetail('17000000000000123456');
	assert.equal(sent[0]!.url.searchParams.get('outTradeNo'), '17000000000000123456');
});
