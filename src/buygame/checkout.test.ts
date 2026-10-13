import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStoreCheckout, describePurchaseResultDetail} from './checkout.ts';

const S = 'https://store.steampowered.com';
const W = 'https://api.steampowered.com';
const K = 'https://checkout.steampowered.com';
const json = (value: unknown) => JSON.stringify(value);

interface Sent {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

/** 假 Steam:按 URL 前缀回包;回包是数组时依次返回(用完停在最后一个) */
function fakeSteam(overrides: Record<string, string | string[]> = {}) {
	const replies: Record<string, string | string[]> = {
		[S + '/pointssummary/ajaxgetasyncconfig']: json({data: {webapi_token: 'TOKEN'}}),
		[S + '/api/packagedetails']: json({10: {success: true, data: {price: {final: 1999}}}}),
		[W + '/IShoppingCartService/CreateNewShoppingCart']: json({response: {gidshoppingcart: '555'}}),
		[W + '/IShoppingCartService/AddPackages']: json({response: {contents: {lineitems: [{}]}}}),
		[W + '/ICheckoutService/ValidateCart']: json({response: {estimated_totals: {subtotal: {amount_in_cents: 1999, formatted_amount: '$19.99'}, wallet_balance: {amount_in_cents: 5000}}}}),
		[K + '/checkout/inittransaction/']: json({success: 1, transid: '9001'}),
		[K + '/checkout/getfinalprice/']: json({success: 1, base: 1999, discount: 500, tax: 0, currencycode: 1}),
		[K + '/checkout/finalizetransaction/']: json({success: 1}),
		[K + '/checkout/transactionstatus/']: json({success: 1, purchaseresultdetail: 0}),
		...overrides
	};
	const sent: Sent[] = [];
	const counts = new Map<string, number>();
	const http = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		sent.push({url, method: init?.method ?? 'GET', headers: {...init?.headers as Record<string, string>}, body: String(init?.body ?? '')});
		const key = Object.keys(replies).find(prefix => url.startsWith(prefix));
		if (!key) {
			throw new TypeError('offline: ' + url);
		}
		let reply = replies[key] as string | string[];
		if (Array.isArray(reply)) {
			const n = counts.get(key) ?? 0;
			counts.set(key, n + 1);
			reply = reply[Math.min(n, reply.length - 1)] as string;
		}
		return new Response(reply);
	}) as typeof fetch;
	const sleeps: number[] = [];
	const checkout = createStoreCheckout({fetch: http, sleep: async ms => void sleeps.push(ms)});
	const path = (request: Sent) => new URL(request.url).host + new URL(request.url).pathname;
	return {checkout, sent, sleeps, paths: () => sent.map(path)};
}

const BASE = {cookies: ['steamLoginSecure=x'], sessionid: 'sid-1', userAgent: 'UA', packageIds: [10], country: 'us', currency: 1};

test('试运行:验证到最终价就停,不发 finalizetransaction', async () => {
	const steam = fakeSteam();
	const result = await steam.checkout.purchasePackages(BASE);
	assert.equal(result.dryRun, true);
	assert.equal(result.transId, '9001');
	assert.deepEqual(result.price, {finalCents: 1499, currencyCode: 1, base: 1999, discount: 500, tax: 0});
	assert.deepEqual(steam.paths(), [
		'store.steampowered.com/pointssummary/ajaxgetasyncconfig', 'store.steampowered.com/api/packagedetails',
		'api.steampowered.com/IShoppingCartService/CreateNewShoppingCart/v1/', 'api.steampowered.com/IShoppingCartService/AddPackages/v1/',
		'api.steampowered.com/ICheckoutService/ValidateCart/v1/', 'checkout.steampowered.com/checkout/inittransaction/',
		'checkout.steampowered.com/checkout/getfinalprice/'
	]);
	assert.deepEqual(result.trace.steps.map(step => step.step), ['webapi_token', 'packagedetails', 'create_cart', 'add_packages', 'funds_check', 'inittransaction', 'getfinalprice', 'dry_run_stop']);
});

test('加包带 costwhenadded(区域价 + 钱包币种);inittransaction 带 sessionid、走 checkout 子域', async () => {
	const steam = fakeSteam();
	await steam.checkout.purchasePackages({...BASE, packageIds: [10, '20', 0, 'x'], country: 'uy', currency: 41});
	const add = steam.sent.find(r => r.url.includes('/AddPackages/'));
	assert.ok(add?.url.endsWith('access_token=TOKEN'));
	assert.deepEqual(JSON.parse(decodeURIComponent(add?.body.replace(/^input_json=/, '') ?? '')), {
		gidshoppingcart: '555',
		cart_items: [
			{packageid: 10, quantity: 1, is_gift: false, costwhenadded: {amount: 1999, currencycode: 41}},
			{packageid: 20, quantity: 1, is_gift: false, costwhenadded: {amount: 0, currencycode: 41}}
		],
		store_country_code: 'UY'
	});
	const init = steam.sent.find(r => r.url.includes('/inittransaction/'));
	const form = new URLSearchParams(init?.body);
	assert.deepEqual([form.get('sessionid'), form.get('gidShoppingCart'), form.get('Country'), form.get('PaymentMethod')], ['sid-1', '555', 'UY', 'steamaccount']);
	assert.equal(init?.headers.Referer, K + '/checkout/?cart=555');
	assert.equal(init?.headers.Cookie, 'steamLoginSecure=x; sessionid=sid-1');
});

test('真扣款:finalize 后轮询交易状态,成功才返回;失败码翻译成中文', async () => {
	const ok = fakeSteam({[K + '/checkout/transactionstatus/']: [json({success: 22}), json({success: 1, purchaseresultdetail: 0})]});
	const result = await ok.checkout.purchasePackages({...BASE, dryRun: false});
	assert.equal(result.purchaseResultDetail, 0);
	assert.deepEqual(ok.sleeps, [1500]);
	assert.equal(new URLSearchParams(ok.sent.find(r => r.url.includes('/finalizetransaction/'))?.body).get('transid'), '9001');

	const owned = fakeSteam({[K + '/checkout/transactionstatus/']: json({success: 2, purchaseresultdetail: 9})});
	await assert.rejects(owned.checkout.purchasePackages({...BASE, dryRun: false}), /已拥有该商品\(purchaseresultdetail=9\)/);

	const pending = fakeSteam({[K + '/checkout/transactionstatus/']: json({success: 22})});
	await assert.rejects(pending.checkout.purchasePackages({...BASE, dryRun: false}), /交易状态轮询超时/);
	assert.equal(pending.sleeps.length, 8);
});

test('余额预检不够就不发起交易;预检失败不阻断', async () => {
	const poor = fakeSteam({[W + '/ICheckoutService/ValidateCart']: json({response: {estimated_totals: {subtotal: {amount_in_cents: 1999, formatted_amount: '$19.99'}, wallet_balance: {amount_in_cents: 100}}}})});
	await assert.rejects(poor.checkout.purchasePackages(BASE), /余额不足:本单需 \$19\.99,钱包余额 1\.00/);
	assert.ok(!poor.sent.some(r => r.url.includes('/inittransaction/')));

	const down = fakeSteam({[W + '/ICheckoutService/ValidateCart']: 'not json'});
	assert.equal((await down.checkout.purchasePackages(BASE)).transId, '9001');
});

test('前置条件和每一步失败都有能看懂的原因', async () => {
	const steam = fakeSteam();
	await assert.rejects(steam.checkout.purchasePackages({...BASE, cookies: []}), /缺少 WebSession cookies/);
	await assert.rejects(steam.checkout.purchasePackages({...BASE, packageIds: ['x']}), /未提供有效的 packageid/);
	await assert.rejects(steam.checkout.purchasePackages({...BASE, cookies: ['a=1'], sessionid: ''}), /找不到 sessionid/);
	assert.equal(steam.sent.length, 0);

	await assert.rejects(fakeSteam({[S + '/pointssummary/ajaxgetasyncconfig']: '<html>'}).checkout.purchasePackages(BASE), /webapi_token 失败/);
	await assert.rejects(fakeSteam({[W + '/IShoppingCartService/CreateNewShoppingCart']: json({response: {}})}).checkout.purchasePackages(BASE), /新建购物车失败/);
	await assert.rejects(fakeSteam({[W + '/IShoppingCartService/AddPackages']: json({response: {contents: {lineitems: []}}})}).checkout.purchasePackages(BASE), /加入购物车失败/);
	await assert.rejects(fakeSteam({[K + '/checkout/inittransaction/']: json({success: 2})}).checkout.purchasePackages(BASE), /inittransaction 失败/);
	await assert.rejects(fakeSteam({[K + '/checkout/getfinalprice/']: json({success: 8})}).checkout.purchasePackages(BASE), /getfinalprice 失败/);
});

test('解析 subid:游戏名、区域价、是否可买', async () => {
	const steam = fakeSteam({[S + '/api/packagedetails']: json({730: {success: true, data: {name: '', apps: [{id: 730, name: 'Counter-Strike 2'}], price: {final: 1499, currency: 'usd', discount_percent: 10}}}})});
	assert.deepEqual(await steam.checkout.resolvePackage(730, 'cn', {cookies: ['a=1'], userAgent: 'UA'}), {
		packageId: 730, name: 'Counter-Strike 2', appid: 730, priceCents: 1499, currencyISO: 'USD', discountPercent: 10, available: true
	});
	assert.equal(steam.sent[0]?.url, S + '/api/packagedetails?packageids=730&cc=CN&l=schinese');
	assert.equal(steam.sent[0]?.headers.Cookie, 'a=1');

	const free = fakeSteam({[S + '/api/packagedetails']: json({1: {success: true, data: {is_free_license: true}}})});
	assert.deepEqual(await free.checkout.resolvePackage(1, ''), {packageId: 1, name: 'Package 1', appid: 0, priceCents: 0, currencyISO: '', discountPercent: 0, available: true});
	await assert.rejects(fakeSteam({[S + '/api/packagedetails']: json({1: {success: false}})}).checkout.resolvePackage(1, 'US'), /未找到该 subid/);
});

test('失败码:已知的翻成中文,未知的给码表提示', () => {
	assert.equal(describePurchaseResultDetail(2), '余额不足(purchaseresultdetail=2)');
	assert.match(describePurchaseResultDetail(77), /购买失败 purchaseresultdetail=77/);
});
