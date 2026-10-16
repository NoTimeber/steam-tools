/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountProxy, proxyHost, steamCheckView} from './proxy.ts';

test('账号的代理:单独设置优先,没有跟全局,全局也没设是直连', () => {
	const config = {
		global: 'http://user-rotate:****@p.example.io:80',
		sticky: false,
		range: {from: 1, to: 1},
		assigned: {},
		accounts: {alpha: {mode: 'custom' as const, url: 'http://u:****@10.0.0.1:8080'}, bravo: {mode: 'direct' as const, url: ''}}
	};
	assert.deepEqual(accountProxy(config, 'Alpha'), {mode: 'custom', label: '10.0.0.1:8080', title: '单独代理:http://u:****@10.0.0.1:8080'});
	assert.deepEqual(accountProxy(config, 'bravo'), {mode: 'direct', label: '不走代理', title: '这个账号单独设置了不走代理'});
	assert.deepEqual(accountProxy(config, 'charlie'), {mode: 'global', label: '全局', title: '用全局代理:http://user-rotate:****@p.example.io:80'});
	assert.equal(accountProxy({...config, global: '', accounts: {}}, 'charlie').label, '直连');
});

test('只留主机和端口', () => {
	assert.equal(proxyHost('http://u:****@10.0.0.1:8080'), '10.0.0.1:8080');
	assert.equal(proxyHost('https://proxy.example.io:443'), 'proxy.example.io:443');
});

test('固定 IP 模式:显示分到的编号,没分到的写待分配', () => {
	const config = {global: 'http://user-{n}:****@p.example.io:80', sticky: true, range: {from: 1, to: 100}, accounts: {}, assigned: {alpha: 23}};
	assert.deepEqual(accountProxy(config, 'Alpha'), {mode: 'global', label: '全局 #23', title: '固定 IP:编号 23(http://user-23:****@p.example.io:80),重新登录时换一个'});
	assert.equal(accountProxy(config, 'bravo').label, '全局 · 待分配');
});

test('测试结果里的 Steam 社区市场:429 说明市场、库存请求会被拒(固定 IP 提示可以重新登录换),2xx/3xx 正常,打不开写原因', () => {
	assert.deepEqual(steamCheckView({status: 429, ms: 300, error: ''}, true), {
		type: 'warning',
		text: 'Steam 社区市场回 429:经这个代理,工具台的市场、库存请求会被 Steam 拒绝'
			+ '(这个 IP 被限流,或者 Steam 不放行机房代理 IP 上的非浏览器请求;登录、商店、手机确认不受影响)。'
			+ '可以重新登录这个账号换一个编号(IP)再试。'
	});
	assert.ok(!steamCheckView({status: 429, ms: 300, error: ''}, false).text.includes('重新登录'));
	assert.deepEqual(steamCheckView({status: 200, ms: 512, error: ''}, false), {type: 'success', text: 'Steam 社区市场正常(HTTP 200,512 ms)'});
	assert.equal(steamCheckView({status: 302, ms: 1, error: ''}, false).type, 'success');
	assert.deepEqual(steamCheckView({status: 503, ms: 1, error: ''}, false), {type: 'warning', text: 'Steam 社区市场回 HTTP 503'});
	assert.deepEqual(steamCheckView({status: 0, ms: 15000, error: '超时(15 秒)'}, false), {type: 'error', text: 'Steam 社区市场打不开:超时(15 秒)'});
});
