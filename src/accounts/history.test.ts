import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyHistoryRow, createPurchaseHistory, parseHistoryCursor, parseHistoryDate, parseHistoryRows, parseMoney} from './history.ts';
import type {PurchaseHistoryOptions} from './history.ts';

// 照 Steam 购买记录页的结构写的样本(列 class、.wth_payment、g_historyCursor 和开源实现里用的一致)
const ROW_MARKET = `
<tr class="wallet_table_row wallet_table_row_amt_change " onclick="HandleTransactionClick( event, 'https://help.steampowered.com/zh-cn/wizard/HelpWithPurchase?transid=111&amp;line=1' )">
	<td class="wht_date">2026 年 10 月 14 日</td>
	<td class="wht_items">
		<div>Counter-Strike 2</div>
		<div class="wth_payment">Steam 社区市场</div>
	</td>
	<td class="wht_type ">
		<div>3 笔市场交易</div>
		<div class="wth_payment">
		</div>
	</td>
	<td class="wht_total ">
		¥ 12.50
	</td>
	<td class="wht_wallet_change wallet_column">+¥ 12.50</td>
	<td class="wht_wallet_balance wallet_column">¥ 112.50</td>
</tr>`;

const ROW_SPLIT_PURCHASE = `
<tr class="wallet_table_row">
	<td class="wht_date">2026 年 10 月 1 日</td>
	<td class="wht_items"><div>Half-Life: Alyx</div><div>Portal 2 &amp; DLC</div></td>
	<td class="wht_type "><div>购买</div><div class="wth_payment"><div>¥ 10.00 Steam 钱包</div><div>¥ 58.00 支付宝</div></div></td>
	<td class="wht_total ">¥ 68.00</td>
	<td class="wht_wallet_change wallet_column">-¥ 10.00</td>
	<td class="wht_wallet_balance wallet_column">¥ 100.00</td>
</tr>`;

const ROW_TOP_UP = `
<tr class="wallet_table_row">
	<td class="wht_date">2026 年 9 月 30 日</td>
	<td class="wht_items"><div>¥ 110.00 钱包资金</div></td>
	<td class="wht_type "><div>购买</div><div class="wth_payment">微信支付</div></td>
	<td class="wht_total ">¥ 110.00</td>
	<td class="wht_wallet_change wallet_column">+¥ 110.00</td>
	<td class="wht_wallet_balance wallet_column">¥ 110.00</td>
</tr>`;

const PAGE = (rows: string, cursor: string) => `<!DOCTYPE html><html><body>
<div id="account_pulldown">alpha</div>
<table class="wallet_history_table">
	<thead><tr><th class="wht_date">日期</th><th class="wht_items">物品</th><th class="wht_type">类型</th><th class="wht_total">总计</th></tr></thead>
	<tbody>${rows}
	<tr id="more_history"><td colspan="6"><a id="load_more_button" href="javascript:WalletHistory_LoadMore();">加载更多交易</a></td></tr>
	</tbody>
</table>
<script>
	var g_sessionID = "page-sid";
	var g_historyCursor = ${cursor};
</script></body></html>`;

const CURSOR_1 = '{"wallet_txnid":"9001","timestamp_newest":1759200000,"balance":"11000","currency":23}';

const AJAX_2 = `
<tr class="wallet_table_row">
	<td class="wht_date">2026 年 9 月 2 日</td>
	<td class="wht_items"><div>Dota 2</div></td>
	<td class="wht_type wht_refunded"><div>退款</div><div class="wth_payment">Steam 钱包</div></td>
	<td class="wht_total wht_refunded">¥ 20.00</td>
	<td class="wht_wallet_change wallet_column">+¥ 20.00</td>
	<td class="wht_wallet_balance wallet_column">¥ 0.00</td>
</tr>
<tr class="wallet_table_row">
	<td class="wht_date">2026 年 9 月 1 日</td>
	<td class="wht_items"><div>Counter-Strike 2</div><div>武器箱钥匙</div></td>
	<td class="wht_type "><div>游戏内购买</div><div class="wth_payment">Steam 钱包</div></td>
	<td class="wht_total ">¥ 17.00</td>
	<td class="wht_wallet_change wallet_column">-¥ 17.00</td>
	<td class="wht_wallet_balance wallet_column">¥ -20.00</td>
</tr>`;

const AJAX_3 = `
<tr class="wallet_table_row">
	<td class="wht_date">2025 年 12 月 24 日</td>
	<td class="wht_items"><div>Stardew Valley</div></td>
	<td class="wht_type "><div>礼物购买</div><div class="wth_payment">Visa</div></td>
	<td class="wht_total ">¥ 48.00</td>
	<td class="wht_wallet_change wallet_column"></td>
	<td class="wht_wallet_balance wallet_column"></td>
</tr>`;

test('解析记录行:日期、商品、类型、付款方式、金额、交易号;表头和「加载更多」行跳过', () => {
	const rows = parseHistoryRows(PAGE(ROW_MARKET + ROW_SPLIT_PURCHASE + ROW_TOP_UP, CURSOR_1));
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[0], {
		date: '2026-10-14',
		dateText: '2026 年 10 月 14 日',
		items: ['Counter-Strike 2', 'Steam 社区市场'],
		typeText: '3 笔市场交易',
		kind: 'market_sell',
		marketCount: 3,
		payment: [],
		refunded: false,
		total: {text: '¥ 12.50', amount: 12.5, currency: 'CNY'},
		walletChange: {text: '+¥ 12.50', amount: 12.5, currency: 'CNY'},
		walletBalance: {text: '¥ 112.50', amount: 112.5, currency: 'CNY'},
		transid: '111'
	});
	assert.deepEqual(
		[rows[1]!.kind, rows[1]!.items, rows[1]!.payment, rows[1]!.walletChange?.amount, rows[1]!.marketCount, rows[1]!.transid],
		['purchase', ['Half-Life: Alyx', 'Portal 2 & DLC'], ['¥ 10.00 Steam 钱包', '¥ 58.00 支付宝'], -10, 0, '']
	);
	assert.deepEqual([rows[2]!.kind, rows[2]!.payment], ['wallet', ['微信支付']], '购买钱包资金算充值');

	const more = parseHistoryRows(AJAX_2 + AJAX_3);
	assert.deepEqual(more.map(row => [row.kind, row.refunded, row.date]), [
		['refund', true, '2026-09-02'],
		['ingame', false, '2026-09-01'],
		['gift', false, '2025-12-24']
	]);
	assert.equal(more[1]!.walletBalance?.amount, -20);
	assert.deepEqual([more[2]!.walletChange, more[2]!.walletBalance], [null, null], '没动钱包的列是空的');
});

test('有退款 class 的购买行标成含退款;单笔市场交易笔数为 1,买入看钱包变动为负', () => {
	const row = parseHistoryRows(`<tr><td class="wht_date">1 Oct, 2026</td><td class="wht_items"><div class="wth_item_refunded">Game</div></td>
		<td class="wht_type"><div>Purchase</div></td><td class="wht_total">$4.99</td></tr>
		<tr><td class="wht_date">Oct 2, 2026</td><td class="wht_items">Steam Community Market</td><td class="wht_type"><div>Market Transaction</div></td>
		<td class="wht_total">$0.03</td><td class="wht_wallet_change">-$0.03</td></tr>`);
	assert.deepEqual(row.map(r => [r.kind, r.refunded, r.marketCount, r.date, r.total?.currency]), [
		['purchase', true, 0, '2026-10-01', 'USD'],
		['market_buy', false, 1, '2026-10-02', 'USD']
	]);
});

test('分类:中英文类型名', () => {
	const minus = parseMoney('-$1.00');
	const plus = parseMoney('+$1.00');
	assert.deepEqual([
		classifyHistoryRow('Purchase', ['Game'], minus),
		classifyHistoryRow('Gift Purchase', ['Game'], minus),
		classifyHistoryRow('In-Game Purchase', ['Game'], minus),
		classifyHistoryRow('2 Market Transactions', [], minus),
		classifyHistoryRow('Market Transaction', [], plus),
		classifyHistoryRow('Refund', [], plus),
		classifyHistoryRow('Conversion', [], null),
		classifyHistoryRow('Purchase', ['$5.00 Wallet Credit'], plus),
		classifyHistoryRow('货币转换', [], null),
		classifyHistoryRow('???', [], null)
	], ['purchase', 'gift', 'ingame', 'market_buy', 'market_sell', 'refund', 'conversion', 'wallet', 'conversion', 'other']);
});

test('金额:各地区格式和货币符号', () => {
	const cases: Array<[string, string, number | null, string]> = [
		['4,99€', '', 4.99, 'EUR'],
		['4,--€', '', 4, 'EUR'],
		['1.234,56 pуб.', '', 1234.56, 'RUB'],
		['$1,234.56', '', 1234.56, 'USD'],
		['-$0.03', '', -0.03, 'USD'],
		['₩ 1,000', '', 1000, 'KRW'],
		['¥ 300', '', 300, 'JPY'],
		['¥ 3.00', 'JPY', 3, 'JPY'],
		['¥ 30.00', '', 30, 'CNY'],
		['CDN$ 5.00', '', 5, 'CAD'],
		['ARS$ 1.234,50', '', 1234.5, 'ARS'],
		['R$ 10,00', '', 10, 'BRL'],
		['$U16,00', '', 16, 'UYU'],
		['Mex$ 1,234.00', '', 1234, 'MXN'],
		['1 234,56 zł', '', 1234.56, 'PLN'],
		['KD 1.234', '', 1.234, 'KWD'],
		['12.50', 'CNY', 12.5, 'CNY']
	];
	for (const [text, hint, amount, currency] of cases) {
		assert.deepEqual(parseMoney(text, hint), {text, amount, currency}, text);
	}
	assert.equal(parseMoney(''), null);
	assert.equal(parseMoney(' -- '), null);
	assert.deepEqual(parseMoney('待定'), {text: '待定', amount: null, currency: ''});
});

test('日期:中文、英文两种写法,没年份的用今年;解析不了为空', () => {
	assert.equal(parseHistoryDate('2026 年 10 月 15 日'), '2026-10-15');
	assert.equal(parseHistoryDate('2026年1月5日'), '2026-01-05');
	assert.equal(parseHistoryDate('10 月 3 日', 2025), '2025-10-03');
	assert.equal(parseHistoryDate('15 Oct, 2026'), '2026-10-15');
	assert.equal(parseHistoryDate('Sep 5, 2026'), '2026-09-05');
	assert.equal(parseHistoryDate('5 Sept', 2024), '2024-09-05');
	assert.equal(parseHistoryDate('2026-10-15'), '2026-10-15');
	assert.equal(parseHistoryDate('昨天'), '');
});

test('游标:页面脚本里的 g_historyCursor;是 null 或没有就只有一页', () => {
	assert.deepEqual(parseHistoryCursor(PAGE('', CURSOR_1)), {wallet_txnid: '9001', timestamp_newest: 1759200000, balance: '11000', currency: 23});
	assert.equal(parseHistoryCursor(PAGE('', 'null')), null);
	assert.equal(parseHistoryCursor('<html></html>'), null);
});

// ===== 读取 =====

interface Seen {
	method: string;
	url: string;
	cookie: string;
	body: string;
	referer: string;
}

/** 假商店:第一次 GET 302 回自己并下发 browserid;「加载更多」按顺序回 pages 里的响应 */
function fakeStore(firstPage: string, pages: Array<() => Response>) {
	const seen: Seen[] = [];
	let next = 0;
	const http = (async (url: string, init: RequestInit) => {
		const headers = init.headers as Record<string, string>;
		const cookie = String(headers.Cookie);
		seen.push({method: String(init.method), url, cookie, body: String(init.body ?? ''), referer: headers.Referer ?? ''});
		if (init.method === 'GET') {
			return cookie.includes('browserid=')
				? new Response(firstPage)
				: new Response('', {status: 302, headers: {location: url, 'set-cookie': 'browserid=42; Path=/'}});
		}
		const page = pages[Math.min(next++, pages.length - 1)];
		return page ? page() : new Response('{}');
	}) as unknown as typeof fetch;
	return {http, seen};
}

const json = (value: unknown) => () => new Response(JSON.stringify(value));

function history(store: ReturnType<typeof fakeStore>, overrides: Partial<PurchaseHistoryOptions> = {}) {
	const sleeps: number[] = [];
	const service = createPurchaseHistory({
		findAttempt: name => (name === 'alpha' ? {accountName: 'alpha', cookies: ['steamLoginSecure=x', 'sessionid=sid-cookie'], userAgent: 'UA', currencyISO: 'CNY'} : null),
		cookiesFor: attempt => attempt.cookies ?? [],
		fetch: store.http,
		sleep: async ms => void sleeps.push(ms),
		now: () => Date.parse('2026-10-15T08:00:00Z'),
		...overrides
	});
	return {service, sleeps};
}

async function settle(service: ReturnType<typeof createPurchaseHistory>, name: string) {
	for (let i = 0; i < 200; i++) {
		const state = service.get(name);
		if (state && state.status !== 'loading') {
			return state;
		}
		await new Promise(resolve => setImmediate(resolve));
	}
	throw new Error('读取一直没结束');
}

test('读取:整页 + 逐页加载更多直到没有游标;带累积的 cookie、sessionid 和游标', async () => {
	const store = fakeStore(PAGE(ROW_MARKET + ROW_SPLIT_PURCHASE + ROW_TOP_UP, CURSOR_1), [
		json({html: AJAX_2, cursor: {wallet_txnid: '9002', timestamp_newest: 1756700000, balance: '0', currency: 23}}),
		json({html: AJAX_3})
	]);
	const {service, sleeps} = history(store, {pageGapMs: 1500});
	const started = service.load('alpha');
	assert.deepEqual([started.status, started.count, 'rows' in started], ['loading', 0, false], '读取中不带记录');

	const done = await settle(service, 'ALPHA');
	assert.deepEqual([done.status, done.pages, done.count, done.truncated, done.error], ['done', 3, 6, false, '']);
	assert.deepEqual(done.rows?.map(row => row.kind), ['market_sell', 'purchase', 'wallet', 'refund', 'ingame', 'gift']);
	assert.deepEqual(sleeps, [1500, 1500], '每页之间等一下');

	assert.deepEqual(store.seen.map(s => `${s.method} ${s.url}`), [
		'GET https://store.steampowered.com/account/history/?l=schinese',
		'GET https://store.steampowered.com/account/history/?l=schinese',
		'POST https://store.steampowered.com/account/AjaxLoadMoreHistory/?l=schinese',
		'POST https://store.steampowered.com/account/AjaxLoadMoreHistory/?l=schinese'
	]);
	const [firstMore, secondMore] = store.seen.slice(2);
	assert.equal(firstMore!.cookie, 'steamLoginSecure=x; sessionid=sid-cookie; browserid=42');
	assert.equal(firstMore!.referer, 'https://store.steampowered.com/account/history/?l=schinese');
	assert.deepEqual(Object.fromEntries(new URLSearchParams(firstMore!.body)), {
		'cursor[wallet_txnid]': '9001', 'cursor[timestamp_newest]': '1759200000', 'cursor[balance]': '11000', 'cursor[currency]': '23', sessionid: 'sid-cookie'
	});
	assert.equal(new URLSearchParams(secondMore!.body).get('cursor[wallet_txnid]'), '9002');

	// 读过的不重读;force 才重读
	const again = service.load('alpha');
	assert.deepEqual([again.status, again.count, store.seen.length], ['done', 6, 4]);
	assert.equal(service.load('alpha', true).status, 'loading');
	await settle(service, 'alpha');
	assert.equal(store.seen.filter(s => s.method === 'GET').length, 4, '重新从第一页读');
});

test('读取:cookie 里没有 sessionid 用页面里的;游标不动或到页数上限就停', async () => {
	const looping = fakeStore(PAGE(ROW_MARKET, CURSOR_1), [json({html: ROW_TOP_UP, cursor: JSON.parse(CURSOR_1)})]);
	const {service} = history(looping, {findAttempt: () => ({accountName: 'alpha', cookies: ['steamLoginSecure=x']})});
	service.load('alpha');
	const stuck = await settle(service, 'alpha');
	assert.deepEqual([stuck.status, stuck.pages, stuck.count, stuck.truncated], ['done', 2, 2, false]);
	assert.equal(new URLSearchParams(looping.seen[2]!.body).get('sessionid'), 'page-sid');

	let txn = 9001;
	const endless = fakeStore(PAGE(ROW_MARKET, CURSOR_1), [() => new Response(JSON.stringify({html: ROW_TOP_UP, cursor: {wallet_txnid: String(++txn), timestamp_newest: 1}}))]);
	const capped = history(endless, {maxPages: 3}).service;
	capped.load('alpha');
	const truncated = await settle(capped, 'alpha');
	assert.deepEqual([truncated.status, truncated.pages, truncated.truncated], ['done', 3, true]);
});

test('读取出错:429 重试后仍失败报错,保留已读到的;没 cookie 直接抛;没登录报错', async () => {
	const busy = fakeStore(PAGE(ROW_MARKET + ROW_TOP_UP, CURSOR_1), [() => new Response('', {status: 429})]);
	const {service, sleeps} = history(busy, {pageGapMs: 100, retryDelayMs: 1000});
	service.load('alpha');
	const failed = await settle(service, 'alpha');
	assert.equal(failed.status, 'error');
	assert.match(failed.error, /第 2 页消费记录 HTTP 429\(请求太频繁\)/);
	assert.deepEqual([failed.pages, failed.count, failed.rows?.length], [1, 2, 2], '已读到的第一页还在');
	assert.deepEqual(sleeps, [100, 1000, 2000], '重试两次,间隔递增');
	assert.equal(busy.seen.filter(s => s.method === 'POST').length, 3);

	assert.throws(() => service.load('nobody'), /没有网页会话/);
	assert.equal(service.get('nobody'), null);

	const guest = fakeStore('<html><body>请登录</body></html>', []);
	const anonymous = history(guest).service;
	anonymous.load('alpha');
	assert.match((await settle(anonymous, 'alpha')).error, /未登录/);

	const expired = history({http: (async () => new Response('', {status: 302, headers: {location: 'https://store.steampowered.com/login/?redir=account%2Fhistory'}})) as unknown as typeof fetch, seen: []}).service;
	expired.load('alpha');
	assert.match((await settle(expired, 'alpha')).error, /跳转到登录页/);

	const broken = fakeStore(PAGE(ROW_MARKET, CURSOR_1), [json({success: false})]);
	const odd = history(broken).service;
	odd.load('alpha');
	assert.match((await settle(odd, 'alpha')).error, /第 2 页消费记录读取失败: \{"success":false\}/);
});
