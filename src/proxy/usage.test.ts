import {test} from 'node:test';
import assert from 'node:assert/strict';
import {migrate, openDatabase} from '../core/db.ts';
import {MIGRATIONS} from '../store/schema.ts';
import {parseProxyList} from './import.ts';
import {createUsageMeter, usageKind, utcDay} from './usage.ts';

test('导入列表:host:port、host:port:user:pass、host:port@user:pass、user:pass@host:port,可带协议前缀', () => {
	const {proxies, errors} = parseProxyList([
		'p.webshare.io:80',
		'1.2.3.4:6001:kxk:pa:ss',
		'1.2.3.4:6002@kxk:pw',
		'kxk:pw@1.2.3.4:6003',
		'HTTPS://u:p@h.example.io:443/',
		'socks5://1.2.3.4:1080',
		'ftp://1.2.3.4:21',
		'just-a-host',
		'  # 注释',
		'1.2.3.4:6004:only-user'
	].join('\r\n'), 'http');
	assert.deepEqual(proxies.map(({line, protocol, host, port, username, password}) => [line, protocol, host, port, username, password]), [
		[1, 'http', 'p.webshare.io', '80', '', ''],
		[2, 'http', '1.2.3.4', '6001', 'kxk', 'pa:ss'],
		[3, 'http', '1.2.3.4', '6002', 'kxk', 'pw'],
		[4, 'http', '1.2.3.4', '6003', 'kxk', 'pw'],
		[5, 'https', 'h.example.io', '443', 'u', 'p']
	]);
	assert.deepEqual(errors, [
		{line: 6, error: '暂不支持 SOCKS5 代理'},
		{line: 7, error: '不支持 ftp 协议'},
		{line: 8, error: '格式不对,应该像 host:port 或 host:port:user:pass'},
		{line: 10, error: '格式不对,应该像 host:port 或 host:port:user:pass'}
	]);
	assert.equal(parseProxyList('localhost:3128', 'https').proxies[0]!.protocol, 'https', '没写协议用默认的');
});

test('用量按地址归类', () => {
	assert.equal(usageKind('https://steamcommunity.com/market/priceoverview/?x=1'), 'market');
	assert.equal(usageKind('https://steamcommunity.com/inventory/765/730/2'), 'inventory');
	assert.equal(usageKind('https://steamcommunity.com/profiles/765/inventory/json/730/2'), 'inventory');
	assert.equal(usageKind('https://steamcommunity.com/tradeoffer/new/send'), 'trade');
	assert.equal(usageKind('https://steamcommunity.com/mobileconf/getlist'), 'confirm');
	assert.equal(usageKind('https://steamcommunity.com/'), 'community');
	assert.equal(usageKind('https://store.steampowered.com/account/history/'), 'store');
	assert.equal(usageKind('https://api.steampowered.com/IEconService/x'), 'webapi');
	assert.equal(usageKind('https://login.steampowered.com/jwt/refresh'), 'login');
	assert.equal(usageKind('not a url'), 'other');
});

test('用量:先记在内存,查询前写库;按天(UTC)、代理、账号、类型汇总,没流量的天补 0;只留 90 天', () => {
	const db = openDatabase(':memory:');
	migrate(db, MIGRATIONS);
	let clock = Date.UTC(2026, 9, 10, 23, 59);
	const meter = createUsageMeter({db, now: () => clock, flushMs: 0});
	meter.record({proxyId: 'a', account: 'alpha', url: 'https://steamcommunity.com/market/', sent: 100, received: 1000});
	meter.record({proxyId: 'a', account: 'alpha', url: 'https://steamcommunity.com/market/x', sent: 50, received: 500});
	clock += 2 * 60000;   // 过了 UTC 零点
	meter.record({proxyId: 'b', account: '', url: 'https://store.steampowered.com/', sent: 10, received: 20});
	meter.record({proxyId: 'a', account: 'bravo', url: 'http://ip.test/', sent: 1, received: 2, kind: 'check'});

	const report = meter.report({days: 3});
	assert.deepEqual([report.since, report.until, report.days], ['2026-10-09', '2026-10-11', 3]);
	assert.deepEqual(report.byDay, [
		{day: '2026-10-09', requests: 0, sent: 0, received: 0},
		{day: '2026-10-10', requests: 2, sent: 150, received: 1500},
		{day: '2026-10-11', requests: 2, sent: 11, received: 22}
	]);
	assert.deepEqual(report.total, {requests: 4, sent: 161, received: 1522});
	assert.deepEqual(report.byProxy, [{proxyId: 'a', requests: 3, sent: 151, received: 1502}, {proxyId: 'b', requests: 1, sent: 10, received: 20}]);
	assert.deepEqual(report.byAccount.map(item => item.account), ['alpha', '', 'bravo']);
	assert.deepEqual(report.byKind.map(item => [item.kind, item.requests]), [['market', 2], ['store', 1], ['check', 1]]);
	assert.equal(report.latestDay, '2026-10-11');
	assert.deepEqual(meter.report({days: 1, proxyId: 'b'}).total, {requests: 1, sent: 10, received: 20}, '只看一个代理');

	meter.record({proxyId: 'a', account: 'alpha', url: 'https://steamcommunity.com/market/', sent: 1, received: 1});
	meter.flush();
	meter.flush();
	assert.equal(meter.report({days: 1}).total.requests, 3, '写过的不重复写');

	clock += 90 * 86400000;
	meter.flush();
	assert.equal(meter.report({days: 90}).total.requests, 0, '90 天前的删掉');
	assert.equal(utcDay(Date.UTC(2026, 0, 1, 0, 0)), '2026-01-01');
	meter.stop();
	db.close();
});
