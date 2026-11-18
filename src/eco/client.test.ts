import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateKey, generateKeyPairSync, verify} from 'node:crypto';
import {createEcoClient, EcoError, EcoNetworkError, generateEcoKeyPair, parsePrivateKey, publicKeyOf, signingString} from './client.ts';

const pair = generateEcoKeyPair();

test('待签名字符串:参数名不分大小写排序,数组 / 对象写成紧凑 JSON,空值和 Sign 不参与(文档里的拼接示例)', () => {
	const params = {
		Timestamp: '1718434793',
		PartnerId: '2487b5cadd774bf1b228c37e4a389bd1',
		idempotentId: '564789',
		purchasingInfoList: [{commodityId: 422270, commodityPrice: 50, tradeLinks: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678912&token=LBPW679'}],
		Empty: '',
		Missing: null,
		Sign: 'xxx'
	};
	assert.equal(signingString(params),
		'idempotentId=564789&PartnerId=2487b5cadd774bf1b228c37e4a389bd1&purchasingInfoList=[{"commodityId":422270,"commodityPrice":50,'
		+ '"tradeLinks":"https://steamcommunity.com/tradeoffer/new/?partner=12345678912&token=LBPW679"}]&Timestamp=1718434793');
	// 文档的排序示例:foo:1, bar:2, foo_bar:3, foobar:4 → bar, foo, foo_bar, foobar;中文不转义
	assert.equal(signingString({foo: 1, bar: 2, foo_bar: 3, foobar: 4}), 'bar=2&foo=1&foo_bar=3&foobar=4');
	assert.equal(signingString({b: ['千瓦'], a: 'x'}), 'a=x&b=["千瓦"]');
});

test('私钥:PKCS#8 / PKCS#1 的 base64、PEM 都认,公钥是去掉头尾的 SPKI;不是 RSA 私钥报错', () => {
	const key = parsePrivateKey(pair.privateKey);
	assert.equal(publicKeyOf(key), pair.publicKey);
	const pkcs1 = key.export({type: 'pkcs1', format: 'der'}).toString('base64');
	assert.equal(publicKeyOf(parsePrivateKey(pkcs1)), pair.publicKey);
	const pem = key.export({type: 'pkcs8', format: 'pem'}).toString();
	assert.equal(publicKeyOf(parsePrivateKey(pem)), pair.publicKey);
	// 中间带换行的 base64 也行
	assert.equal(publicKeyOf(parsePrivateKey(pair.privateKey.replace(/(.{64})/g, '$1\n'))), pair.publicKey);

	assert.throws(() => parsePrivateKey(''), /私钥是空的/);
	assert.throws(() => parsePrivateKey('not a key'), /私钥格式不对/);
	const ec = generateKeyPairSync('ec', {namedCurve: 'prime256v1'}).privateKey.export({type: 'pkcs8', format: 'der'}).toString('base64');
	assert.throws(() => parsePrivateKey(ec), /要是 RSA/);
});

type Call = {url: string; body: Record<string, unknown>};

function fakeFetch(respond: (call: Call) => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const call = {url: String(input), body: JSON.parse(String(init?.body))};
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
}

const reply = (code: string | number, data: unknown = null, status = 200) =>
	new Response(JSON.stringify({ResultCode: code, ResultMsg: code === '0' ? '成功' : '出错了', ResultData: data}), {status});

test('请求:POST JSON,带 PartnerId、秒级 Timestamp 和能用公钥验过的 Sign;金额保留两位小数', async () => {
	const calls: Call[] = [];
	const api = createEcoClient({
		partnerId: 'P-1', privateKey: pair.privateKey, now: () => 1_700_000_000,
		fetch: fakeFetch(() => reply('0', {OrderNo: 'DB1', MerchantNo: 'M1', PaymentPrice: 0.3}), calls)
	});
	const result = await api.buyByGoodsNum({goodsNum: 'G1', price: 0.1 + 0.2, tradeLink: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=t', merchantNo: 'M1', gameId: 730});
	assert.equal(result.OrderNo, 'DB1');
	const [call] = calls;
	assert.equal(call!.url, 'https://openapi.ecosteam.cn/Api/open/buy/BuyByGoodsNum');
	assert.deepEqual({...call!.body, Sign: undefined}, {
		GoodsNum: 'G1', Price: 0.3, TradeLink: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=t', MerchantNo: 'M1', GameId: '730',
		PartnerId: 'P-1', Timestamp: '1700000000', Sign: undefined
	});
	const publicPem = `-----BEGIN PUBLIC KEY-----\n${pair.publicKey}\n-----END PUBLIC KEY-----\n`;
	assert.ok(verify('sha256', Buffer.from(signingString(call!.body), 'utf8'), publicPem, Buffer.from(String(call!.body.Sign), 'base64')));
	// 换一个私钥签的验不过
	const other = createPrivateKey({key: Buffer.from(generateEcoKeyPair().privateKey, 'base64'), format: 'der', type: 'pkcs8'});
	assert.notEqual(publicKeyOf(other), pair.publicKey);
});

test('错误分类:平台拒绝 = EcoError(带码和 ResultData);系统异常、5xx、超时 = 结果未知;没连上 = EcoError', async () => {
	const make = (respond: () => Response | Promise<Response>) => createEcoClient({partnerId: 'P', privateKey: pair.privateKey, fetch: fakeFetch(respond)});

	const rejected = await make(() => reply('7009', {NewPrice: 1.23})).balance().catch(err => err);
	assert.ok(rejected instanceof EcoError && !(rejected instanceof EcoNetworkError));
	assert.equal(rejected.code, 7009);
	assert.deepEqual(rejected.data, {NewPrice: 1.23});
	assert.match(rejected.message, /Merchant\/GetTotalMoney 失败: \[7009\]/);

	assert.ok(await make(() => reply('-1')).balance().catch(err => err) instanceof EcoNetworkError, '系统异常');
	assert.ok(await make(() => new Response('bad gateway', {status: 502})).balance().catch(err => err) instanceof EcoNetworkError, '5xx 不是 JSON');
	assert.ok(await make(() => reply('1', null, 500)).balance().catch(err => err) instanceof EcoNetworkError, '5xx 带 JSON');
	const notFound = await make(() => new Response('nope', {status: 404})).balance().catch(err => err);
	assert.ok(notFound instanceof EcoError && !(notFound instanceof EcoNetworkError), '4xx');

	const timeout = await make(() => Promise.reject(Object.assign(new Error('t'), {name: 'TimeoutError'}))).balance().catch(err => err);
	assert.ok(timeout instanceof EcoNetworkError);
	assert.match(timeout.message, /超时/);
	const refused = await make(() => Promise.reject(Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}}))).balance().catch(err => err);
	assert.ok(refused instanceof EcoError && !(refused instanceof EcoNetworkError));
	assert.match(refused.message, /连不上服务器/);
});

test('批量接口:查价 / 订单状态按 100 个一批;绑定账号翻页', async () => {
	const calls: Call[] = [];
	const api = createEcoClient({partnerId: 'P', privateKey: pair.privateKey, fetch: fakeFetch(call => {
		if (call.url.endsWith('BatchSearchSellingPrice')) {
			return reply('0', (call.body.HashName as string[]).map(name => ({HashName: name, MinPrice: '1.5'})));
		}
		if (call.url.endsWith('OrderStatusQuery')) {
			return reply('0', (call.body.MerchantNos as string[]).map(no => ({MerchantNo: no, OrderStateCode: 1})));
		}
		const page = Number(call.body.PageIndex);
		return reply('0', {TotalRecord: 150, PageResult: Array.from({length: page === 1 ? 100 : 50}, (_, i) => ({SteamId: `${page}-${i}`}))});
	}, calls)});
	const names = Array.from({length: 150}, (_, i) => `Item ${i}`);
	const stats = await api.itemStats(570, names);
	assert.equal(Object.keys(stats).length, 150);
	assert.deepEqual(calls.map(call => [(call.body.HashName as string[]).length, call.body.GameID]), [[100, '570'], [50, '570']]);

	assert.equal((await api.orderStatus(names)).length, 150);
	assert.equal((await api.steamAccounts()).length, 150);
	assert.deepEqual(calls.slice(-2).map(call => call.body.PageIndex), [1, 2]);
});
