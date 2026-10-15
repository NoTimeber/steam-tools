import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountIdOf, fetchTradeUrl, isTradeUrlOf, parseTradeUrlPage, partnerOf, steamIdFromTradeUrl} from './trade-url.ts';

const STEAM_ID = '76561198152000001';
const PARTNER = String(76561198152000001n - 76561197960265728n);
const LINK = `https://steamcommunity.com/tradeoffer/new/?partner=${PARTNER}&token=Ab-c_9`;
const page = (link: string) => `<div><input class="trade_offer_access_url" id="trade_offer_access_url" type="text" value="${link}" readonly></div>`;

test('交易链接 ↔ SteamID:partner 就是 SteamID64 的低 32 位', () => {
	assert.equal(partnerOf(LINK), PARTNER);
	assert.equal(steamIdFromTradeUrl(LINK), STEAM_ID);
	assert.equal(accountIdOf(STEAM_ID), PARTNER);
	assert.equal(isTradeUrlOf(LINK, STEAM_ID), true);
	assert.equal(isTradeUrlOf(LINK, '76561198152000002'), false);
	assert.equal(partnerOf('https://example.com/tradeoffer/new/?partner=1&token=a'), null);
	assert.equal(partnerOf('https://steamcommunity.com/tradeoffer/new/?token=a'), null);
	assert.equal(partnerOf('not a url'), null);
	assert.equal(accountIdOf('123'), null);
});

test('隐私设置页里取交易链接:&amp; 还原,格式不对的不要', () => {
	assert.equal(parseTradeUrlPage(page(LINK.replace('&', '&amp;'))), LINK);
	assert.equal(parseTradeUrlPage(page('https://evil.example/tradeoffer/new/?partner=1&token=a')), null);
	assert.equal(parseTradeUrlPage('<html>请登录</html>'), null);
});

test('用账号的网页会话取交易链接:带 cookie,不跟跳转;会话失效、链接不是这个账号的都报错', async () => {
	const calls: Array<{url: string; init: RequestInit | undefined}> = [];
	const reply = (response: Response) => (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({url: String(input), init});
		return response;
	}) as typeof fetch;
	const options = {steamId: STEAM_ID, cookies: ['steamLoginSecure=abc', 'sessionid=1'], userAgent: 'UA'};

	assert.equal(await fetchTradeUrl({...options, fetch: reply(new Response(page(LINK.replace('&', '&amp;'))))}), LINK);
	assert.equal(calls[0]!.url, `https://steamcommunity.com/profiles/${STEAM_ID}/tradeoffers/privacy`);
	assert.deepEqual([(calls[0]!.init!.headers as Record<string, string>).Cookie, calls[0]!.init!.redirect], ['steamLoginSecure=abc; sessionid=1', 'manual']);

	await assert.rejects(fetchTradeUrl({...options, fetch: reply(new Response('', {status: 302}))}), /会话失效/);
	await assert.rejects(fetchTradeUrl({...options, fetch: reply(new Response('<html></html>'))}), /没找到交易链接/);
	const other = `https://steamcommunity.com/tradeoffer/new/?partner=42&token=x`;
	await assert.rejects(fetchTradeUrl({...options, fetch: reply(new Response(page(other)))}), /不是这个账号的/);
	await assert.rejects(fetchTradeUrl({...options, cookies: []}), /没有网页会话/);
	await assert.rejects(fetchTradeUrl({...options, steamId: ''}), /SteamID/);
});
