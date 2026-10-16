import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {ProxyConfig} from '../store/proxies.ts';
import {createProxyService, isSteamHost, steamIdFromCookies} from './index.ts';
import type {ProxyServiceOptions} from './index.ts';

const GLOBAL = 'http://user-rotate:secret@p.example.io:80';
const ALPHA_ID = '76561190100005555';
const BRAVO_ID = '76561190100006666';

function memoryStore(initial: Partial<ProxyConfig> = {}) {
	let saved: ProxyConfig = structuredClone({global: '', range: {from: 1, to: 1}, accounts: {}, assigned: {}, ...initial});
	return {load: () => structuredClone(saved), save: (config: ProxyConfig) => void (saved = structuredClone(config)), saved: () => saved};
}

/** 记下每个请求走了哪个代理('' 为直连) */
function harness(initial?: Partial<ProxyConfig>, overrides: Partial<ProxyServiceOptions> = {}) {
	const store = memoryStore(initial);
	const used: string[] = [];
	const lookups: string[] = [];
	/** 建过的走代理 fetch(每个账号一个) */
	const created: string[] = [];
	const service = createProxyService({
		store,
		accountForSteamId: steamId => {
			lookups.push(steamId);
			return ({[ALPHA_ID]: 'Alpha', [BRAVO_ID]: 'bravo'} as Record<string, string>)[steamId] ?? '';
		},
		fetch: (async () => {
			used.push('');
			return new Response('direct');
		}) as typeof fetch,
		createProxyFetch: proxyUrl => {
			created.push(proxyUrl);
			return (async () => {
				used.push(proxyUrl);
				return new Response(JSON.stringify({ip: '203.0.113.7'}));
			}) as typeof fetch;
		},
		...overrides
	});
	return {service, store, used, lookups, created};
}

const cookie = (steamId: string) => ({Cookie: `steamLoginSecure=${steamId}%7C%7CeyJ0eXAi; sessionid=abc`});

test('SteamID 从 steamLoginSecure 取;Steam 的域名才算 Steam', () => {
	assert.equal(steamIdFromCookies(`sessionid=1; steamLoginSecure=${ALPHA_ID}%7C%7Ctoken`), ALPHA_ID);
	assert.equal(steamIdFromCookies([`steamLoginSecure=${ALPHA_ID}||token`, 'sessionid=1']), ALPHA_ID);
	assert.equal(steamIdFromCookies('sessionid=1'), '');
	assert.equal(steamIdFromCookies('steamLoginSecure=%E0%A4%A'), '', '解码失败当没有');
	assert.ok(isSteamHost('store.steampowered.com'));
	assert.ok(isSteamHost('steamcommunity.com'));
	assert.ok(isSteamHost('community.fastly.steamstatic.com'));
	assert.ok(!isSteamHost('openapi.c5game.com'));
	assert.ok(!isSteamHost('notsteamcommunity.com.evil.io'));
});

test('按账号取代理:单独设的优先,direct 直连,其它用全局', () => {
	const {service} = harness({global: GLOBAL, accounts: {alpha: 'http://a:b@10.0.0.1:8080', bravo: 'direct'}});
	assert.equal(service.proxyFor('ALPHA'), 'http://a:b@10.0.0.1:8080', '账号名不分大小写');
	assert.equal(service.proxyFor('bravo'), '');
	assert.equal(service.proxyFor('charlie'), GLOBAL);
	assert.equal(service.proxyFor(), GLOBAL);
	assert.equal(service.proxyForCookies([`steamLoginSecure=${BRAVO_ID}%7C%7Cx`]), '');
	assert.equal(service.proxyForCookies([]), GLOBAL, '没 cookie 用全局');
});

test('Steam 的 fetch:按 Cookie 认账号选代理,没 cookie 用全局,别的域名直连;SteamID 查过就记住', async () => {
	const {service, used, lookups} = harness({global: GLOBAL, accounts: {alpha: 'http://a:b@10.0.0.1:8080', bravo: 'direct'}});
	await service.fetch('https://store.steampowered.com/account/history/', {headers: cookie(ALPHA_ID)});
	await service.fetch('https://steamcommunity.com/market/', {headers: new Headers(cookie(ALPHA_ID))});
	await service.fetch('https://store.steampowered.com/account/', {headers: cookie(BRAVO_ID)});
	await service.fetch('https://store.steampowered.com/api/packagedetails?packageids=1');
	await service.fetch('https://store.steampowered.com/', {headers: cookie('76561190100009999')});
	await service.fetch('https://openapi.c5game.com/merchant/account/v1/balance', {headers: cookie(ALPHA_ID)});
	await service.fetch('https://steamcommunity.com/', {headers: cookie('76561190100009999')});
	assert.deepEqual(used, ['http://a:b@10.0.0.1:8080', 'http://a:b@10.0.0.1:8080', '', GLOBAL, GLOBAL, '', GLOBAL]);
	assert.deepEqual(lookups, [ALPHA_ID, BRAVO_ID, '76561190100009999', '76561190100009999'], '认出来的记住,认不出的下次再查');

	const none = harness();
	await none.service.fetch('https://store.steampowered.com/account/', {headers: cookie(ALPHA_ID)});
	assert.deepEqual(none.used, [''], '没设代理就直连');
});

test('同一个代理,每个账号各用各的连接(轮换代理下账号之间不共用出口 IP);同一账号复用', async () => {
	const {service, created} = harness({global: GLOBAL, accounts: {}});
	await service.fetch('https://store.steampowered.com/', {headers: cookie(ALPHA_ID)});
	await service.fetch('https://steamcommunity.com/', {headers: cookie(ALPHA_ID)});
	await service.fetch('https://store.steampowered.com/', {headers: cookie(BRAVO_ID)});
	await service.fetch('https://store.steampowered.com/api/packagedetails?packageids=1');
	await service.fetch('https://store.steampowered.com/api/packagedetails?packageids=2');
	assert.deepEqual(created, [GLOBAL, GLOBAL, GLOBAL], 'alpha、bravo、认不出账号的各一套');
	await service.test({});
	await service.test({});
	assert.equal(created.length, 7, '测试每次新开连接(查出口 IP、查 Steam 社区各一个)');
});

test('改设置:全局代理校验并保存(下发时密码打码);账号可切回全局、直连、单独代理', () => {
	const {service, store} = harness();
	assert.throws(() => service.setGlobal({proxy: 'socks5://h:1080'}), (err: Error & {statusCode?: number}) => err.statusCode === 400 && /SOCKS/.test(err.message));
	assert.deepEqual(service.setGlobal({proxy: ' http://user-rotate:secret@p.example.io:80/ '}), {global: 'http://user-rotate:****@p.example.io:80', sticky: false, range: {from: 1, to: 1}, accounts: {}, assigned: {}});
	assert.equal(store.saved().global, GLOBAL, '存的是完整地址');

	assert.deepEqual(service.setAccount({accountName: 'Alpha', mode: 'custom', proxy: 'u:pw@10.0.0.1:8080'}).accounts, {alpha: {mode: 'custom', url: 'http://u:****@10.0.0.1:8080'}});
	assert.equal(service.proxyFor('alpha'), 'http://u:pw@10.0.0.1:8080');
	service.setAccount({accountName: 'alpha', mode: 'direct'});
	assert.equal(service.proxyFor('alpha'), '');
	assert.throws(() => service.setAccount({accountName: 'alpha', mode: 'custom'}), /请填写这个账号的代理地址/, '原来不是单独代理时必须填');
	service.setAccount({accountName: 'alpha', mode: 'custom', proxy: 'u:pw@10.0.0.1:8080'});
	service.setAccount({accountName: 'alpha', mode: 'custom', proxy: ''});
	assert.equal(service.proxyFor('alpha'), 'http://u:pw@10.0.0.1:8080', '没填地址就沿用原来的');
	assert.deepEqual(service.setAccount({accountName: 'alpha', mode: 'global'}).accounts, {});
	assert.equal(service.proxyFor('alpha'), GLOBAL);
	assert.throws(() => service.setAccount({accountName: '', mode: 'global'}), /缺少账号名/);
	assert.throws(() => service.setAccount({accountName: 'alpha', mode: 'weird'}), /global \/ direct \/ custom/);

	assert.deepEqual(service.setGlobal({proxy: ''}).global, '', '空串清除');
});

test('测代理:测填的或现在用的,回出口 IP;不通、407、没代理都报错', async () => {
	let clock = 1000;
	const {service, used} = harness({global: GLOBAL, accounts: {bravo: 'direct'}}, {now: () => (clock += 120)});
	assert.deepEqual(await service.test({}), {
		ip: '203.0.113.7', ms: 120, proxy: 'http://user-rotate:****@p.example.io:80', steam: {status: 200, ms: 120, error: ''}
	});
	assert.deepEqual((await service.test({proxy: '10.0.0.2:3128'})).proxy, 'http://10.0.0.2:3128');
	assert.deepEqual(used, [GLOBAL, GLOBAL, 'http://10.0.0.2:3128', 'http://10.0.0.2:3128'], '查 IP、查 Steam 社区都走测的那个代理');
	await assert.rejects(service.test({accountName: 'bravo'}), /这个账号现在不走代理/);
	await assert.rejects(harness().service.test({}), /还没有设置代理/);
	await assert.rejects(service.test({proxy: 'socks5://h:1'}), /SOCKS/);

	const denied = harness({global: GLOBAL, accounts: {}}, {createProxyFetch: () => (async () => new Response('', {status: 407})) as typeof fetch}).service;
	await assert.rejects(denied.test({}), (err: Error & {statusCode?: number}) => err.statusCode === 502 && /407\(代理账号或密码不对\)/.test(err.message));
	const broken = harness({global: GLOBAL, accounts: {}}, {createProxyFetch: () => (async () => {
		throw new TypeError('通过代理请求失败: connect ECONNREFUSED');
	}) as typeof fetch}).service;
	await assert.rejects(broken.test({}), /代理不通: 通过代理请求失败: connect ECONNREFUSED/);
});

test('固定 IP 模式:每个账号分一个编号并记住(先挑没人用的);手动重新登录换一个;单独设置的账号不受影响', async () => {
	const picks = [0, 0.99, 0.5, 0.5, 0.1];
	let call = 0;
	const {service, store, used} = harness({accounts: {echo: 'direct', fox: 'http://f:p@10.0.0.9:3128'}}, {random: () => picks[call++ % picks.length]!});
	assert.throws(() => service.setGlobal({proxy: 'http://user-{n}:secret@p.example.io:80', from: 0, to: 3}), /编号范围/);
	const saved = service.setGlobal({proxy: 'http://user-{n}:secret@p.example.io:80', from: 1, to: 3});
	assert.deepEqual([saved.global, saved.sticky, saved.range], ['http://user-{n}:****@p.example.io:80', true, {from: 1, to: 3}]);

	assert.equal(service.proxyFor('alpha'), 'http://user-1:secret@p.example.io:80');
	assert.equal(service.proxyFor('ALPHA'), 'http://user-1:secret@p.example.io:80', '记住了,不再挑');
	assert.equal(service.proxyFor('bravo'), 'http://user-3:secret@p.example.io:80', '先挑没人用的');
	assert.equal(service.proxyFor('charlie'), 'http://user-2:secret@p.example.io:80');
	assert.equal(service.proxyFor('delta'), 'http://user-2:secret@p.example.io:80', '都占满了只好重复');
	assert.equal(service.proxyFor('echo'), '');
	assert.equal(service.proxyFor('fox'), 'http://f:p@10.0.0.9:3128');
	assert.deepEqual(store.saved().assigned, {alpha: 1, bravo: 3, charlie: 2, delta: 2}, '编号存下来,重启后照旧');

	service.renew('Alpha');
	assert.equal(service.proxyFor('alpha'), 'http://user-2:secret@p.example.io:80', '重新登录换一个,不会还是原来那个');
	service.renew('echo');
	service.renew('fox');
	assert.deepEqual(Object.keys(store.saved().assigned).sort(), ['alpha', 'bravo', 'charlie', 'delta'], '单独设置的账号不分编号');

	await service.fetch('https://store.steampowered.com/', {headers: cookie(BRAVO_ID)});
	assert.equal(used.at(-1), 'http://user-3:secret@p.example.io:80', 'Steam 请求按账号用它的编号');

	// 只改范围(不传地址):范围外的编号作废,下次用时重分
	service.setGlobal({from: 3, to: 3});
	assert.deepEqual(store.saved().assigned, {bravo: 3});
	assert.equal(store.saved().global, 'http://user-{n}:secret@p.example.io:80', '不传地址就不动地址');
	assert.equal(service.proxyFor('alpha'), 'http://user-3:secret@p.example.io:80');

	assert.throws(() => service.setAccount({accountName: 'gold', mode: 'custom', proxy: 'http://g-{n}:p@h:80'}), /不要带 \{n\}/);
	await service.test({proxy: 'http://u-{n}:p@h.example.io:80', from: 5, to: 5});
	assert.equal(used.at(-1), 'http://u-5:p@h.example.io:80', '测试带 {n} 的地址时随机挑范围里的一个编号');
	await service.test({});
	assert.equal(used.at(-1), 'http://user-3:secret@p.example.io:80', '不填测现在用的(认不出账号的那一个)');
});

test('测代理顺带打开 Steam 社区:429 照实回(这个 IP 被限流);社区打不开不算测试失败,写原因', async () => {
	const requests: string[] = [];
	const limited = harness({global: GLOBAL}, {
		steamTestUrl: 'https://steamcommunity.com/market/',
		createProxyFetch: () => (async (input: string, init: RequestInit) => {
			requests.push(`${input} ${init.redirect ?? 'follow'} ${new Headers(init.headers).get('user-agent')?.includes('Chrome/') ?? false}`);
			return String(input).includes('steamcommunity') ? new Response('Too Many Requests', {status: 429}) : new Response('{"ip":"203.0.113.8"}');
		}) as unknown as typeof fetch
	}).service;
	const result = await limited.test({});
	assert.deepEqual([result.ip, result.steam.status, result.steam.error], ['203.0.113.8', 429, '']);
	assert.deepEqual(requests.slice(-1), ['https://steamcommunity.com/market/ manual true'], '不跟随跳转,带浏览器 UA');

	const unreachable = harness({global: GLOBAL}, {
		createProxyFetch: () => (async (input: string) => {
			if (String(input).includes('steamcommunity')) {
				throw new TypeError('通过代理请求失败: socket hang up');
			}
			return new Response('{"ip":"203.0.113.9"}');
		}) as unknown as typeof fetch
	}).service;
	const partial = await unreachable.test({});
	assert.deepEqual([partial.ip, partial.steam.status, partial.steam.error], ['203.0.113.9', 0, '通过代理请求失败: socket hang up']);
});
