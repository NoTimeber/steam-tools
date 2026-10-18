import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {ProxyFetchOptions} from '../core/proxy.ts';
import {emptyProxyConfig, newStoredProxy} from '../store/proxies.ts';
import type {ProxyConfig, StoredProxy} from '../store/proxies.ts';
import {createProxyService, isSteamHost, steamIdFromCookies} from './index.ts';
import type {ProxyService, ProxyServiceOptions} from './index.ts';
import type {UsageEntry} from './usage.ts';

const ALPHA_ID = '76561190100005555';
const BRAVO_ID = '76561190100006666';

/** 测试用的代理:主机是「id.example.io」,端口 8080,静态、启用 */
const P = (id: string, fields: Partial<StoredProxy> = {}) => newStoredProxy({id, host: `${id}.example.io`, port: 8080, createdAt: 1, ...fields});
const url = (id: string) => `http://${id}.example.io:8080`;

function memoryStore(initial: Partial<ProxyConfig> = {}) {
	let saved: ProxyConfig = structuredClone({...emptyProxyConfig(), ...initial});
	return {load: () => structuredClone(saved), save: (config: ProxyConfig) => void (saved = structuredClone(config)), saved: () => saved};
}

/** 记下每个请求走了哪个代理('' 为直连) */
function harness(initial?: Partial<ProxyConfig>, overrides: Partial<ProxyServiceOptions> = {}) {
	const store = memoryStore(initial);
	const used: string[] = [];
	const lookups: string[] = [];
	/** 建过的走代理 fetch(每个账号一个) */
	const created: string[] = [];
	const usage: UsageEntry[] = [];
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
		createProxyFetch: (proxyUrl: string, options?: ProxyFetchOptions) => {
			created.push(proxyUrl);
			return (async (input: string) => {
				used.push(proxyUrl);
				options?.onTraffic?.({url: String(input), sent: 10, received: 20});
				return new Response(JSON.stringify({ip: '203.0.113.7'}));
			}) as unknown as typeof fetch;
		},
		usage: {record: entry => void usage.push(entry), report: () => null as never},
		random: () => 0,
		...overrides
	});
	return {service, store, used, lookups, created, usage};
}

const cookie = (steamId: string) => ({Cookie: `steamLoginSecure=${steamId}%7C%7CeyJ0eXAi; sessionid=abc`});
const status = (code: number, pattern: RegExp) => (err: Error & {statusCode?: number}) => err.statusCode === code && pattern.test(err.message);

/** 等后台的检测都跑完 */
async function settle(service: ProxyService): Promise<void> {
	for (let round = 0; round < 500 && service.state().proxies.some(proxy => proxy.status === 'checking'); round++) {
		await new Promise(resolve => setImmediate(resolve));
	}
}

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

test('账号用哪些代理:没绑定的用代理池(启用的、没被账号单独绑定的),池空了直连;不走代理的直连;绑定的只用绑定的', () => {
	const {service} = harness({
		proxies: [P('a'), P('b', {enabled: false}), P('c')],
		accounts: {echo: {mode: 'direct'}, fox: {mode: 'bind', proxyIds: ['c'], groupIds: []}}
	});
	assert.equal(service.proxyFor('alpha'), url('a'), 'b 停用了,c 是 fox 专用的');
	assert.equal(service.proxyFor('CHARLIE'), url('a'));
	assert.equal(service.proxyFor(), url('a'), '认不出账号的请求也从池里分');
	assert.equal(service.proxyFor('Fox'), url('c'), '账号名不分大小写');
	assert.equal(service.proxyFor('echo'), '');

	service.bulk({ids: ['a'], action: 'disable'});
	assert.equal(service.proxyFor('alpha'), '', '池里没有启用的代理就直连');
	service.bulk({ids: ['b'], action: 'enable'});
	assert.equal(service.proxyFor('alpha'), url('b'), '用着的停用了重新挑');

	// 绑定的全停用了:拒绝(不退回用池里的,也不直连)
	service.bulk({ids: ['c'], action: 'disable'});
	assert.throws(() => service.proxyFor('fox'), status(409, /绑定的 1 个代理都已停用/));
	assert.match(service.loginRefusal('fox'), /都已停用/);
	assert.equal(service.loginRefusal('alpha'), '');
	assert.equal(service.queueLogin('fox'), null, '被拒绝的不排队(登录那边会拒)');

	// 绑定的代理删光了:算没绑定,用代理池
	const after = service.deleteProxies({ids: ['c']});
	assert.deepEqual(after.accounts, {echo: {mode: 'direct'}});
	assert.equal(service.proxyFor('fox'), url('b'));
});

test('分配:尽量分散到不同代理,健康或没测过的优先;每个账号一直用分到的,停用了才重新挑;重启后重新分', () => {
	const unhealthy = {status: 'unreachable' as const, latencyMs: 0, ip: '', country: '', ips: [], samples: 0, error: 'x', checkedAt: 1};
	const {service, store} = harness({proxies: [P('a'), P('b'), P('dead', {check: unhealthy})]});
	assert.equal(service.proxyFor('alpha'), url('a'));
	assert.equal(service.proxyFor('bravo'), url('b'), '挑账号最少的');
	assert.equal(service.proxyFor('charlie'), url('a'));
	assert.equal(service.proxyFor('alpha'), url('a'), '记住了,一直是它');
	assert.deepEqual(service.state().assigned, {alpha: {proxyId: 'a', index: 0}, bravo: {proxyId: 'b', index: 0}, charlie: {proxyId: 'a', index: 0}});

	service.bulk({ids: ['a', 'b'], action: 'disable'});
	assert.equal(service.proxyFor('alpha'), url('dead'), '只剩不健康的也照用');
	const restarted = createProxyService({store, accountForSteamId: () => '', random: () => 0.99, createProxyFetch: () => fetch});
	assert.deepEqual(restarted.state().assigned, {}, '分配不存盘');
});

test('轮换代理填了 IP 数量:每个账号固定一个编号(先挑没人用的),webshare 的 -rotate 换成 -编号,别家用 {n};没填的照普通地址用', () => {
	const webshare = P('w', {host: 'p.webshare.io', port: 80, type: 'rotating', username: 'user-rotate', password: 'secret', poolSize: 3});
	const {service} = harness({proxies: [webshare]});
	const at = (index: number) => `http://user-${index}:secret@p.webshare.io:80`;
	assert.equal(service.proxyFor('alpha'), at(1));
	assert.equal(service.proxyFor('bravo'), at(2), '换个账号挑没人用的');
	assert.equal(service.proxyFor('charlie'), at(3));
	assert.equal(service.proxyFor('delta'), at(1), '都占满了只好重复');
	assert.equal(service.proxyFor('ALPHA'), at(1));
	assert.equal(service.state().proxies[0]!.sticky, true);

	service.updateProxy({id: 'w', poolSize: 2});
	assert.equal(service.proxyFor('alpha'), at(1), '还在范围里的照旧');
	assert.match(service.proxyFor('charlie'), /user-[12]:/, '超出的重新分');

	service.updateProxy({id: 'w', username: 'sess-{n}-x'});
	assert.equal(service.proxyFor('alpha'), 'http://sess-1-x:secret@p.webshare.io:80');
	service.updateProxy({id: 'w', username: 'user-rotate', poolSize: ''});
	assert.equal(service.proxyFor('alpha'), 'http://user-rotate:secret@p.webshare.io:80', '没填 IP 数量:每个新连接由提供商换 IP');
	assert.equal(service.state().proxies[0]!.sticky, false);
});

test('Steam 的 fetch:按 Cookie 认账号选代理,每个账号各用各的连接;别的域名直连;SteamID 查过就记住;记用量', async () => {
	const {service, used, lookups, created, usage} = harness({proxies: [P('a'), P('c')], accounts: {alpha: {mode: 'bind', proxyIds: ['c'], groupIds: []}}});
	await service.fetch('https://store.steampowered.com/account/history/', {headers: cookie(ALPHA_ID)});
	await service.fetch('https://steamcommunity.com/market/', {headers: new Headers(cookie(ALPHA_ID))});
	await service.fetch('https://store.steampowered.com/account/', {headers: cookie(BRAVO_ID)});
	await service.fetch('https://store.steampowered.com/api/packagedetails?packageids=1');
	await service.fetch('https://openapi.c5game.com/merchant/account/v1/balance', {headers: cookie(ALPHA_ID)});
	await service.fetch('https://steamcommunity.com/', {headers: cookie('76561190100009999')});
	assert.deepEqual(used, [url('c'), url('c'), url('a'), url('a'), '', url('a')]);
	assert.deepEqual(created, [url('c'), url('a'), url('a')], 'alpha、bravo、认不出账号的各一套连接');
	assert.deepEqual(lookups, [ALPHA_ID, BRAVO_ID, '76561190100009999'], '认出来的记住,认不出的下次再查');
	assert.deepEqual(usage.map(entry => [entry.proxyId, entry.account, entry.url]), [
		['c', 'alpha', 'https://store.steampowered.com/account/history/'],
		['c', 'alpha', 'https://steamcommunity.com/market/'],
		['a', 'bravo', 'https://store.steampowered.com/account/'],
		['a', '', 'https://store.steampowered.com/api/packagedetails?packageids=1'],
		['a', '', 'https://steamcommunity.com/']
	]);

	service.bulk({ids: ['c'], action: 'disable'});
	await assert.rejects(service.fetch('https://steamcommunity.com/market/', {headers: cookie(ALPHA_ID)}), /都已停用/, '绑定的代理都停用了不发');
	const none = harness();
	await none.service.fetch('https://store.steampowered.com/account/', {headers: cookie(ALPHA_ID)});
	assert.deepEqual(none.used, [''], '没有代理就直连');
});

test('新建 / 修改代理:按各项校验,下发不带密码;密码留空保留原来的,清掉用户名一起清;改了连接方式检测结果作废;重复的不让加', () => {
	const {service, store} = harness();
	const form = {protocol: 'http', host: ' P.Example.io ', port: 80, type: 'static', username: 'user', password: 'secret', loginsPerMinute: ''};
	assert.throws(() => service.createProxy({...form, protocol: 'socks5'}), status(400, /SOCKS5/));
	assert.throws(() => service.createProxy({...form, host: 'http://user:pw@p.example.io:80'}), status(400, /主机只填域名或 IP/));
	assert.throws(() => service.createProxy({...form, host: 'p.example.io:80'}), status(400, /分开填/));
	assert.throws(() => service.createProxy({...form, host: ''}), status(400, /请填写主机/));
	assert.throws(() => service.createProxy({...form, port: ''}), status(400, /请填写端口/));
	assert.throws(() => service.createProxy({...form, port: 70000}), status(400, /1 到 65535/));
	assert.throws(() => service.createProxy({...form, type: 'weird'}), status(400, /类型只能是/));
	assert.throws(() => service.createProxy({...form, loginsPerMinute: 1.5}), status(400, /登录速率限制/));
	assert.throws(() => service.createProxy({...form, username: 'user-{n}'}), status(400, /静态代理只有一个 IP/));
	assert.throws(() => service.createProxy({...form, type: 'rotating', poolSize: 2.5}), status(400, /IP 数量要是/));
	assert.throws(() => service.createProxy({...form, type: 'rotating', poolSize: 5}), status(400, /填了 IP 数量要能把编号写进地址/));
	assert.throws(() => service.createProxy({...form, type: 'rotating', username: 'u-{n}'}), status(400, /要填 IP 数量/));
	assert.throws(() => service.createProxy({...form, groupIds: ['nope']}), status(404, /代理组不存在/));
	assert.deepEqual(store.saved().proxies, [], '校验不过不存');

	const {proxy, state} = service.createProxy({...form, notes: '  备注  ', loginsPerMinute: '3'});
	assert.deepEqual(
		[proxy.host, proxy.port, proxy.endpoint, proxy.username, proxy.hasPassword, proxy.notes, proxy.loginsPerMinute, proxy.status, proxy.enabled],
		['p.example.io', 80, 'p.example.io:80', 'user', true, '备注', 3, 'untested', true]
	);
	assert.ok(!('password' in proxy) && !JSON.stringify(state).includes('secret'), '密码不下发');
	assert.equal(store.saved().proxies[0]!.password, 'secret', '存的有密码');
	assert.throws(() => service.createProxy({...form, host: 'p.EXAMPLE.io'}), status(409, /已经有 p\.example\.io:80/));
	const other = service.createProxy({...form, username: 'other'});
	assert.equal(other.proxy.username, 'other', '用户名不同算另一个');

	const id = proxy.id;
	service.bindAccounts({accountNames: ['x'], mode: 'bind', proxyIds: [id]});
	store.save({...store.saved(), proxies: store.saved().proxies.map(item => ({...item, check: {status: 'healthy', latencyMs: 1, ip: 'x', country: '', ips: ['x'], samples: 1, error: '', checkedAt: 1}}))});
	const reloaded = createProxyService({store, accountForSteamId: () => '', createProxyFetch: () => fetch});
	reloaded.updateProxy({id, password: '', notes: '改了备注'});
	assert.deepEqual([store.saved().proxies[0]!.password, store.saved().proxies[0]!.check?.status], ['secret', 'healthy'], '密码留空保留;只改备注检测结果还在');
	assert.equal(reloaded.proxyFor('x'), 'http://user:secret@p.example.io:80');
	reloaded.updateProxy({id, password: 'p@ss word'});
	assert.equal(store.saved().proxies[0]!.check, null, '改了密码要重新测');
	assert.equal(reloaded.proxyFor('x'), 'http://user:p%40ss%20word@p.example.io:80', '密码里的特殊字符拼地址时编码');
	assert.throws(() => reloaded.updateProxy({id, username: 'other'}), status(409, /已经有/));
	reloaded.updateProxy({id, username: ''});
	assert.deepEqual([store.saved().proxies[0]!.username, store.saved().proxies[0]!.password], ['', ''], '没用户名就不带认证');
	assert.throws(() => reloaded.updateProxy({id: 'nope', host: 'h'}), status(404, /代理不存在/));
});

test('导入:各种写法拆开;已有的、这次重复的跳过;拆不开、不合法的按行号报;新代理按选的类型、启用、代理组', () => {
	const {service} = harness();
	service.createProxy({protocol: 'http', host: '1.2.3.4', port: 8080, type: 'static'});
	const {group} = service.createGroup({name: '开箱'});
	const text = [
		'# 注释',
		'1.2.3.4:8080',
		'5.6.7.8:3128:user:pa:ss',
		'user2:pw2@9.9.9.9:80',
		'9.9.9.10:81@user3:pw3',
		'https://h.example.io:443',
		'socks5://s.example.io:1080',
		'bad line',
		'1.2.3.4:99999',
		'5.6.7.8:3128:user:other',
		'',
		'5.6.7.8:3128:user:pa:ss'
	].join('\n');
	const result = service.importProxies({text, protocol: 'http', type: 'rotating', enabled: false, groupIds: [group.id]});
	assert.deepEqual([result.added, result.duplicates], [4, 3], '已有的 1.2.3.4:8080、同一用户名的 5.6.7.8:3128 两行跳过');
	assert.deepEqual(result.errors, [
		{line: 7, error: '暂不支持 SOCKS5 代理'},
		{line: 8, error: '格式不对,应该像 host:port 或 host:port:user:pass'},
		{line: 9, error: '端口要是 1 到 65535 的整数'}
	]);
	const added = result.state.proxies.slice(1).map(proxy => [proxy.protocol, proxy.endpoint, proxy.username, proxy.hasPassword, proxy.type, proxy.enabled, proxy.groupIds]);
	assert.deepEqual(added, [
		['http', '5.6.7.8:3128', 'user', true, 'rotating', false, [group.id]],
		['http', '9.9.9.9:80', 'user2', true, 'rotating', false, [group.id]],
		['http', '9.9.9.10:81', 'user3', true, 'rotating', false, [group.id]],
		['https', 'h.example.io:443', '', false, 'rotating', false, [group.id]]
	]);
	assert.throws(() => service.importProxies({text: '\n# 只有注释\n', type: 'static'}), status(400, /请粘贴代理列表/));
	assert.throws(() => service.importProxies({text: '1.1.1.1:80', type: 'static', protocol: 'socks5'}), status(400, /SOCKS5/));
});

test('批量:启用、停用、登录速率限制、加入 / 移出代理组;没选、不认识的报错', () => {
	const {service} = harness({proxies: [P('a'), P('b')]});
	const {group} = service.createGroup({name: '组', color: 'green'});
	service.bulk({ids: ['a', 'b'], action: 'loginLimit', value: 5});
	service.bulk({ids: ['a'], action: 'addGroups', value: [group.id]});
	service.bulk({ids: ['a', 'b'], action: 'addGroups', value: [group.id]});
	const state = service.bulk({ids: ['b'], action: 'disable'});
	assert.deepEqual(state.proxies.map(proxy => [proxy.id, proxy.loginsPerMinute, proxy.groupIds, proxy.enabled]), [['a', 5, [group.id], true], ['b', 5, [group.id], false]]);
	const removed = service.bulk({ids: ['a'], action: 'removeGroups', value: [group.id]});
	assert.deepEqual(removed.proxies.map(proxy => proxy.groupIds), [[], [group.id]]);
	assert.equal(service.bulk({ids: ['a'], action: 'loginLimit', value: ''}).proxies[0]!.loginsPerMinute, 0, '留空不限');
	assert.throws(() => service.bulk({ids: [], action: 'enable'}), status(400, /没选代理/));
	assert.throws(() => service.bulk({ids: ['a'], action: 'explode'}), status(400, /不认识的批量操作/));
	assert.throws(() => service.bulk({ids: ['a'], action: 'addGroups', value: ['nope']}), status(404, /代理组不存在/));
});

test('代理组和绑定:账号绑定代理组、账户分组关联代理组(和账号自己的合在一起);删组退回代理池;分配代理每个账号一个', () => {
	const groupOf: Record<string, string> = {charlie: 'ag1'};
	const {service} = harness({proxies: [P('a'), P('b'), P('c')]}, {accountGroups: {groupOf: name => groupOf[name] ?? '', exists: id => id === 'ag1'}});
	assert.throws(() => service.createGroup({name: '  '}), status(400, /不能为空/));
	assert.throws(() => service.createGroup({name: 'x'.repeat(21)}), status(400, /最多 20 个字/));
	assert.throws(() => service.createGroup({name: 'box', color: 'rainbow'}), status(400, /颜色不对/));
	const {group, state} = service.createGroup({name: 'Box', color: 'blue', proxyIds: ['b']});
	assert.deepEqual([group.name, group.color, state.proxies.find(proxy => proxy.id === 'b')!.groupIds], ['Box', 'blue', [group.id]]);
	assert.throws(() => service.createGroup({name: 'BOX'}), status(409, /已经有叫「BOX」/));
	assert.equal(service.updateGroup({id: group.id, name: '开箱', color: 'red'}).groups[0]!.name, '开箱');

	service.bindAccounts({accountNames: ['Alpha'], mode: 'bind', groupIds: [group.id]});
	assert.equal(service.proxyFor('alpha'), url('b'), '只用组里的');
	assert.equal(service.proxyFor('bravo'), url('a'), '代理组里的代理不是专用的,池里照样有');
	service.linkAccountGroup({accountGroupId: 'ag1', groupIds: [group.id]});
	assert.equal(service.proxyFor('charlie'), url('b'), '账户分组关联的代理组');
	service.bindAccounts({accountNames: ['charlie'], mode: 'bind', proxyIds: ['c']});
	service.bulk({ids: ['b'], action: 'disable'});
	assert.equal(service.proxyFor('charlie'), url('c'), '自己绑的和分组关联的合在一起');
	assert.throws(() => service.linkAccountGroup({accountGroupId: 'nope', groupIds: []}), status(404, /账户分组不存在/));

	const deleted = service.deleteGroup({id: group.id});
	assert.deepEqual(deleted.accounts, {charlie: {mode: 'bind', proxyIds: ['c'], groupIds: []}}, '只绑了这个组的 alpha 退回代理池');
	assert.deepEqual([deleted.accountGroups, deleted.groups, deleted.proxies.map(proxy => proxy.groupIds)], [{}, [], [[], [], []]]);

	assert.throws(() => service.bindAccounts({accountNames: ['alpha'], mode: 'bind'}), status(400, /至少一个代理或代理组/));
	assert.throws(() => service.bindAccounts({accountNames: ['alpha'], mode: 'bind', proxyIds: ['nope']}), status(404, /代理不存在/));
	assert.throws(() => service.bindAccounts({accountNames: [], mode: 'pool'}), status(400, /没选账号/));
	assert.throws(() => service.bindAccounts({accountNames: ['alpha'], mode: 'weird'}), status(400, /pool \/ direct \/ bind/));
	assert.deepEqual(service.bindAccounts({accountNames: ['charlie', 'echo'], mode: 'direct'}).accounts, {charlie: {mode: 'direct'}, echo: {mode: 'direct'}});
	assert.deepEqual(service.bindAccounts({accountNames: ['charlie'], mode: 'pool'}).accounts, {echo: {mode: 'direct'}});

	service.bindAccounts({accountNames: ['golf'], mode: 'bind', proxyIds: ['a']});
	const {pairs, accounts} = service.distributeProxies({accountNames: ['alpha', 'bravo', 'charlie'], proxyIds: ['a', 'b', 'c']});
	assert.deepEqual(pairs, {alpha: 'b', bravo: 'c', charlie: 'a'}, '先给没被别的账号(golf)绑定的');
	assert.deepEqual(accounts.alpha, {mode: 'bind', proxyIds: ['b'], groupIds: []});
	assert.throws(() => service.distributeProxies({accountNames: ['alpha'], proxyIds: []}), status(400, /至少一个代理/));
});

test('检测:后台跑(先是「检查中」),只看连不连得通:回出口 IP、国家、延迟,不打开 Steam 页面;轮换代理采样几次看换没换 IP;连不上、407 分别标出;测的时候改了连接方式结果不算', async () => {
	let clock = 1000;
	let rotation = 0;
	const seen: string[] = [];
	const {service, store, usage} = harness({
		proxies: [
			P('s'),
			P('r', {type: 'rotating'}),
			P('w', {host: 'p.webshare.io', type: 'rotating', username: 'u-rotate', password: 'pw', poolSize: 5}),
			P('dead'),
			P('auth')
		]
	}, {
		now: () => (clock += 50),
		checkConcurrency: 1,
		checkSaveDelayMs: 0,
		testUrl: 'http://ip.test/',
		random: (() => {
			const picks = [0, 0, 0.5, 0.99];
			let call = 0;
			return () => picks[call++ % picks.length]!;
		})(),
		createProxyFetch: (proxyUrl: string, options?: ProxyFetchOptions) => (async (input: string, init: RequestInit) => {
			const target = String(input);
			seen.push(`${proxyUrl} ${target} ${options?.keepAlive} ${init.redirect ?? 'follow'}`);
			options?.onTraffic?.({url: target, sent: 1, received: 2});
			if (proxyUrl.includes('dead')) {
				throw new TypeError('通过代理请求失败: connect ECONNREFUSED');
			}
			if (target === 'http://ip.test/') {
				if (proxyUrl.includes('auth')) {
					return new Response('', {status: 407});
				}
				const ip = proxyUrl.includes('r.example') ? `198.51.100.${++rotation}` : proxyUrl.includes('webshare') ? `192.0.2.${/u-(\d+)/.exec(proxyUrl)![1]}` : '203.0.113.5';
				return new Response(JSON.stringify({ip, country: 'us'}));
			}
			return new Response('Too Many Requests', {status: 429});
		}) as unknown as typeof fetch
	});
	const started = service.test({});
	assert.ok(started.proxies.every(proxy => proxy.status === 'checking'));
	await settle(service);
	const byId = Object.fromEntries(service.state().proxies.map(proxy => [proxy.id, proxy]));
	assert.deepEqual([byId.s!.status, byId.s!.check?.ip, byId.s!.check?.country, byId.s!.check?.samples, byId.s!.check?.ips, byId.s!.check?.latencyMs, byId.s!.check?.error],
		['healthy', '203.0.113.5', 'US', 1, ['203.0.113.5'], 50, '']);
	assert.deepEqual([byId.r!.check?.samples, byId.r!.check?.ips.length], [3, 3], '轮换:每次新开连接,3 次 3 个 IP');
	assert.deepEqual([byId.w!.check?.samples, byId.w!.check?.ips.length], [3, 3], '按账号固定 IP 的挑 3 个不同编号');
	assert.deepEqual([byId.dead!.status, byId.dead!.check?.error], ['unreachable', '代理不通: 通过代理请求失败: connect ECONNREFUSED']);
	assert.deepEqual([byId.auth!.status, byId.auth!.check?.error], ['unreachable', '代理账号或密码不对(HTTP 407)']);
	assert.equal(store.saved().proxies.find(proxy => proxy.id === 's')!.check?.status, 'healthy', '结果存盘');
	assert.ok(seen.every(line => line.includes(' false ')), '检测每次新开连接');
	assert.ok(seen.every(line => line.includes(' http://ip.test/ ')), '只查出口 IP,不打开 Steam 页面');
	assert.ok(usage.some(entry => entry.kind === 'check' && entry.account === ''), '检测的流量也记上');

	service.test({ids: ['s']});
	service.updateProxy({id: 's', port: 9090});
	await settle(service);
	assert.equal(store.saved().proxies.find(proxy => proxy.id === 's')!.check, null, '测的时候改了端口,这次结果不算');
	assert.throws(() => service.test({ids: ['nope']}), status(404, /代理不存在/));
	assert.throws(() => harness().service.test({}), status(400, /还没有代理/));

	// 编辑页上还没保存的:密码留空用存着的,不保存
	const draft = await service.testDraft({id: 'w', host: 'q.example.io', password: ''});
	assert.equal(draft.proxy.replace(/u-\d/, 'u-N'), 'http://u-N:****@q.example.io:8080');
	assert.ok(seen.at(-1)!.startsWith('http://u-') && seen.at(-1)!.includes(':pw@q.example.io:8080'));
	assert.equal(store.saved().proxies.find(proxy => proxy.id === 'w')!.host, 'p.webshare.io', '测试不保存');
});

test('登录速率限制按代理算:经同一个代理的登录超了排队;不同代理、不走代理的不排;改限制马上生效', async () => {
	let time = 0;
	const timers: Array<{at: number; callback: () => void}> = [];
	const {service} = harness({
		proxies: [P('a', {loginsPerMinute: 1}), P('c')],
		accounts: {echo: {mode: 'direct'}, fox: {mode: 'bind', proxyIds: ['c'], groupIds: []}}
	}, {loginClock: {now: () => time, setTimer: (callback, ms) => timers.push({at: time + ms, callback}), clearTimer: () => {}}});
	assert.equal(service.queueLogin('alpha'), null, '这分钟第一次');
	const bravo = service.queueLogin('bravo');
	assert.equal(bravo?.waitMs, 60000, '第二次排队,等第一次出 60 秒窗口');
	assert.equal(service.queueLogin('echo'), null, '不走代理的不排');
	assert.equal(service.queueLogin('fox'), null, '别的代理(没限制)不排');

	let started = false;
	void bravo!.ready.then(() => (started = true));
	service.bulk({ids: ['a'], action: 'loginLimit', value: 2});
	await Promise.resolve();
	assert.ok(started, '放宽了马上放行');
	service.bulk({ids: ['a'], action: 'loginLimit', value: ''});
	for (let index = 0; index < 5; index++) {
		assert.equal(service.queueLogin('charlie'), null, '留空不限');
	}
});
