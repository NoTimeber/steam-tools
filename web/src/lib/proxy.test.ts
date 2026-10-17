/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {ProxyCheck, ProxyUsageReport, PublicProxy, PublicProxyState} from '../api/types.ts';
import {
	accountProxyView, accountsUsingGroup, activeProxyFilterCount, busiestDay, emptyProxyFilters, formatBytes, isSingleIpRotating, marketNote, matchesProxy,
	poolProxies, proxyStats, sortProxies, splitProxyUrl, timeAgo, uniqueIpText, usageByGroup
} from './proxy.ts';

const check = (fields: Partial<ProxyCheck> = {}): ProxyCheck => ({
	status: 'healthy', latencyMs: 300, ip: '203.0.113.1', country: 'US', ips: ['203.0.113.1'], samples: 1, market: 200, error: '', checkedAt: 1, ...fields
});

const proxy = (id: string, fields: Partial<PublicProxy> = {}): PublicProxy => ({
	id, protocol: 'http', host: `${id}.example.io`, port: 8080, type: 'static', username: '', hasPassword: false, poolSize: 0, loginsPerMinute: 0,
	enabled: true, notes: '', groupIds: [], createdAt: 1, check: null, endpoint: `${id}.example.io:8080`, sticky: false, status: 'untested', ...fields
});

const state = (fields: Partial<PublicProxyState> = {}): PublicProxyState => ({proxies: [], groups: [], accounts: {}, accountGroups: {}, assigned: {}, ...fields});

test('字节数按 1000 进,时间显示多久以前', () => {
	assert.deepEqual([0, 999, 1000, 10900000, 36200000, 275e6, 1.5e9].map(formatBytes), ['0 B', '999 B', '1 kB', '10.9 MB', '36.2 MB', '275 MB', '1.5 GB']);
	const now = 10 * 86400000;
	assert.deepEqual([now - 5000, now - 120000, now - 21 * 3600000, now - 86400000, now - 8 * 86400000, 0].map(time => timeAgo(time, now)),
		['刚刚', '2 分钟前', '21 小时前', '1 天前', '1 周前', '—']);
});

test('检测结果:不同 IP、轮换但只有一个 IP、市场页有问题才标', () => {
	assert.equal(uniqueIpText(check({samples: 3, ips: ['a', 'b', 'c']})), '3 次中有 3 个');
	assert.equal(uniqueIpText(null), '—');
	assert.ok(isSingleIpRotating(proxy('r', {type: 'rotating', check: check({samples: 3, ips: ['a']})})));
	assert.ok(!isSingleIpRotating(proxy('r', {type: 'rotating', check: check({samples: 3, ips: ['a', 'b']})})));
	assert.ok(!isSingleIpRotating(proxy('s', {check: check({samples: 3, ips: ['a']})})), '静态的本来就一个 IP');
	assert.equal(marketNote(check({market: 429}))?.text, '市场 429');
	assert.equal(marketNote(check({market: 0}))?.text, '市场打不开');
	assert.equal(marketNote(check({market: 200})), null);
	assert.equal(marketNote(check({status: 'unreachable', market: 0})), null, '连不上的不用再说市场');
});

test('统计、筛选、搜索、排序', () => {
	const list = [
		proxy('a', {status: 'healthy', check: check({latencyMs: 700}), groupIds: ['g1']}),
		proxy('b', {status: 'blocked', type: 'rotating', check: check({status: 'blocked', samples: 3, ips: ['x'], latencyMs: 200}), enabled: false}),
		proxy('c', {status: 'unreachable', protocol: 'https', check: check({status: 'unreachable'}), notes: '备用'}),
		proxy('d')
	];
	assert.deepEqual(proxyStats(list), {total: 4, healthy: 1, failing: 2, untested: 1, enabled: 3});
	const groups = new Map([['g1', '开箱']]);
	const pick = (filters: Partial<ReturnType<typeof emptyProxyFilters>>, search = '') => list.filter(item => matchesProxy(item, {...emptyProxyFilters(), ...filters}, search, groups)).map(item => item.id);
	assert.deepEqual(pick({status: 'blocked'}), ['b']);
	assert.deepEqual(pick({protocol: 'https'}), ['c']);
	assert.deepEqual(pick({group: 'g1'}), ['a']);
	assert.deepEqual(pick({group: '-'}), ['b', 'c', 'd']);
	assert.deepEqual(pick({enabled: 'no'}), ['b']);
	assert.deepEqual(pick({singleIp: true}), ['b']);
	assert.deepEqual(pick({}, '开箱'), ['a'], '搜代理组名');
	assert.deepEqual(pick({}, '备用'), ['c'], '搜备注');
	assert.equal(activeProxyFilterCount({...emptyProxyFilters(), status: 'healthy', singleIp: true}), 2);
	assert.deepEqual(sortProxies(list, 'latency', 'ascend').map(item => item.id), ['b', 'a', 'c', 'd'], '没测过、连不上的排最后');
	assert.deepEqual(sortProxies(list, 'endpoint', 'descend').map(item => item.id), ['d', 'c', 'b', 'a']);
});

test('账号的代理:不走代理、绑定的(自己的 + 账户分组关联的)、全停用、代理池、池空了直连', () => {
	const base = state({
		proxies: [proxy('a'), proxy('b', {groupIds: ['g1']}), proxy('c'), proxy('off', {enabled: false})],
		groups: [{id: 'g1', name: '开箱', color: 'blue', createdAt: 1}],
		accounts: {
			echo: {mode: 'direct'},
			fox: {mode: 'bind', proxyIds: ['c'], groupIds: []},
			golf: {mode: 'bind', proxyIds: [], groupIds: ['g1']},
			hotel: {mode: 'bind', proxyIds: ['off'], groupIds: []}
		},
		accountGroups: {ag1: ['g1']},
		assigned: {alpha: {proxyId: 'a', index: 0}, golf: {proxyId: 'b', index: 7}}
	});
	assert.deepEqual(accountProxyView(base, 'Echo'), {mode: 'direct', label: '不走代理', tip: '这个账号单独设置了不走代理,Steam 请求直连'});
	assert.deepEqual([accountProxyView(base, 'fox').mode, accountProxyView(base, 'fox').label], ['bind', '1 个代理']);
	const golf = accountProxyView(base, 'golf');
	assert.deepEqual([golf.label, golf.tip], ['开箱', '只用绑定的 1 个代理,1 个启用着;现在用 b.example.io:8080 的第 7 个 IP(重启后重新分)']);
	assert.equal(accountProxyView(base, 'india', 'ag1').label, '开箱', '账户分组关联的代理组');
	assert.match(accountProxyView(base, 'india', 'ag1').tip, /含账户分组关联的代理组 开箱/);
	assert.deepEqual([accountProxyView(base, 'hotel').mode, accountProxyView(base, 'hotel').label], ['refused', '代理全停用']);
	const alpha = accountProxyView(base, 'alpha');
	assert.deepEqual([alpha.mode, alpha.label, alpha.tip], ['pool', '代理池', '从代理池的 2 个代理里分一个;现在用 a.example.io:8080(重启后重新分)']);
	assert.deepEqual(poolProxies(base).map(item => item.id), ['a', 'b'], 'c 被 fox 单独绑定,off 停用了');
	assert.deepEqual(accountProxyView(state(), 'alpha'), {mode: 'direct', label: '直连', tip: '还没有代理,Steam 请求直连'});
	assert.equal(accountProxyView(state({proxies: [proxy('off', {enabled: false})]}), 'alpha').tip, '代理池里没有可用的代理(都停用了或被账号单独绑定了),Steam 请求直连');

	const rows = [{key: 'golf', groupId: ''}, {key: 'india', groupId: 'ag1'}, {key: 'echo', groupId: 'ag1'}, {key: 'alpha', groupId: ''}];
	assert.equal(accountsUsingGroup(base, 'g1', rows), 2, 'golf 自己绑的、india 分组关联的;echo 不走代理不算');
});

test('用量:按代理组汇总(没分组的单独一项),最忙的一天', () => {
	const report: ProxyUsageReport = {
		days: 2, since: '2026-10-16', until: '2026-10-17',
		total: {requests: 3, sent: 30, received: 300},
		byDay: [{day: '2026-10-16', requests: 1, sent: 10, received: 100}, {day: '2026-10-17', requests: 2, sent: 20, received: 200}],
		byProxy: [{proxyId: 'a', requests: 2, sent: 20, received: 200}, {proxyId: 'gone', requests: 1, sent: 10, received: 100}],
		byAccount: [], byKind: [], lastAt: 0, latestDay: '2026-10-17'
	};
	const groups = [{id: 'g1', name: '开箱', color: 'blue', createdAt: 1}, {id: 'g2', name: '备用', color: 'red', createdAt: 1}];
	assert.deepEqual(usageByGroup(report, [proxy('a', {groupIds: ['g1', 'g2']})], groups), [
		{groupId: 'g1', name: '开箱', color: 'blue', proxies: 1, bytes: 220},
		{groupId: 'g2', name: '备用', color: 'red', proxies: 1, bytes: 220},
		{groupId: '', name: '未分组', color: '', proxies: 1, bytes: 110}
	]);
	assert.equal(busiestDay(report)?.day, '2026-10-17');
	assert.equal(busiestDay({...report, byDay: [{day: 'x', requests: 0, sent: 0, received: 0}]}), null);
});

test('粘贴的整串代理地址拆成各项:账号密码解码,{n} 原样,没写端口按协议默认;不像地址的不拆', () => {
	assert.deepEqual(splitProxyUrl('http://kxk-rotate:p%40ss@p.webshare.io:80'), {protocol: 'http', host: 'p.webshare.io', port: 80, username: 'kxk-rotate', password: 'p@ss'});
	assert.deepEqual(splitProxyUrl('user-{n}:pw@h.example.io:8000'), {protocol: 'http', host: 'h.example.io', port: 8000, username: 'user-{n}', password: 'pw'});
	assert.deepEqual(splitProxyUrl('https://h.example.io'), {protocol: 'https', host: 'h.example.io', port: 443, username: '', password: ''});
	assert.equal(splitProxyUrl('p.webshare.io'), null);
	assert.equal(splitProxyUrl('socks5://h:1080'), null);
});
