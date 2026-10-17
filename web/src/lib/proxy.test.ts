/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {GlobalProxySettings, PublicProxyConfig} from '../api/types.ts';
import {accountProxy, proxyHost, proxySummary, splitProxyUrl, steamCheckView} from './proxy.ts';

const settings = (extra: Partial<GlobalProxySettings> = {}): GlobalProxySettings => ({
	enabled: true, protocol: 'http', host: 'p.example.io', port: 80, type: 'static', username: 'user-rotate', hasPassword: true, poolSize: 0, loginsPerMinute: 0, ...extra
});

test('账号的代理:单独设置优先,没有跟全局,全局也没设(或关了)是直连', () => {
	const config: PublicProxyConfig = {
		global: 'http://user-rotate:****@p.example.io:80',
		settings: settings(),
		sticky: false,
		assigned: {},
		accounts: {alpha: {mode: 'custom', url: 'http://u:****@10.0.0.1:8080'}, bravo: {mode: 'direct', url: ''}}
	};
	assert.deepEqual(accountProxy(config, 'Alpha'), {mode: 'custom', label: '10.0.0.1:8080', title: '单独代理:http://u:****@10.0.0.1:8080'});
	assert.deepEqual(accountProxy(config, 'bravo'), {mode: 'direct', label: '不走代理', title: '这个账号单独设置了不走代理'});
	assert.deepEqual(accountProxy(config, 'charlie'), {mode: 'global', label: '全局', title: '用全局代理:http://user-rotate:****@p.example.io:80'});
	const off = accountProxy({...config, global: '', settings: settings({enabled: false}), accounts: {}}, 'charlie');
	assert.deepEqual([off.label, off.title], ['直连', '全局代理已关闭,Steam 请求直连']);
	assert.equal(accountProxy({...config, global: '', settings: settings({enabled: false, host: ''}), accounts: {}}, 'charlie').title, '没有设置全局代理,Steam 请求直连');
});

test('只留主机和端口', () => {
	assert.equal(proxyHost('http://u:****@10.0.0.1:8080'), '10.0.0.1:8080');
	assert.equal(proxyHost('https://proxy.example.io:443'), 'proxy.example.io:443');
});

test('轮换代理:显示这次运行分到的编号,没分到的写待分配', () => {
	const config: PublicProxyConfig = {
		global: 'http://user-{n}:****@p.example.io:80', settings: settings({type: 'rotating', poolSize: 100}), sticky: true, accounts: {}, assigned: {alpha: 23}
	};
	assert.deepEqual(accountProxy(config, 'Alpha'), {mode: 'global', label: '全局 #23', title: '轮换代理:固定用第 23 个 IP(http://user-23:****@p.example.io:80),重启后重新分'});
	assert.equal(accountProxy(config, 'bravo').label, '全局 · 待分配');
});

test('运行设置页的代理状态:没设、关了、开着(轮换带 IP 数量和分配了几个账号,设了登录限制带上)', () => {
	const base: PublicProxyConfig = {global: '', settings: settings({enabled: false, host: ''}), sticky: false, accounts: {}, assigned: {}};
	assert.equal(proxySummary(base), '未设置');
	assert.equal(proxySummary({...base, settings: settings({enabled: false})}), '已关闭(p.example.io:80 · 静态)');
	assert.equal(proxySummary({...base, settings: settings({loginsPerMinute: 3})}), 'p.example.io:80 · 静态 · 登录每分钟 3 次');
	assert.equal(
		proxySummary({...base, settings: settings({type: 'rotating', poolSize: 100}), sticky: true, assigned: {alpha: 3, bravo: 9, '': 1}}),
		'p.example.io:80 · 轮换 · 100 个 IP,已分配 2 个账号'
	);
	assert.equal(proxySummary({...base, settings: settings({type: 'rotating'})}), 'p.example.io:80 · 轮换 · 没填 IP 数量,没按账号固定', '旧版迁移来还没填');
});

test('粘贴的整串代理地址拆成各项:账号密码解码,{n} 原样,没写端口按协议默认;不像地址的不拆', () => {
	assert.deepEqual(splitProxyUrl(' http://kxk-rotate:p%40ss@p.webshare.io:80 '), {protocol: 'http', host: 'p.webshare.io', port: 80, username: 'kxk-rotate', password: 'p@ss'});
	assert.deepEqual(splitProxyUrl('https://kxk-{n}:pw@P.Example.io'), {protocol: 'https', host: 'p.example.io', port: 443, username: 'kxk-{n}', password: 'pw'});
	assert.deepEqual(splitProxyUrl('u:pw@10.0.0.1:3128'), {protocol: 'http', host: '10.0.0.1', port: 3128, username: 'u', password: 'pw'});
	assert.equal(splitProxyUrl('p.webshare.io'), null, '只是主机就不拆');
	assert.equal(splitProxyUrl('socks5://h:1080'), null, 'SOCKS 不拆,保存时服务端报不支持');
	assert.equal(splitProxyUrl('http://'), null);
});

test('测试结果里的 Steam 社区市场:429 说明市场、库存请求会被拒,2xx/3xx 正常,打不开写原因', () => {
	const limited = steamCheckView({status: 429, ms: 300, error: ''});
	assert.deepEqual([limited.type, limited.text], ['warning', '市场 429,市场和库存用不了']);
	assert.match(limited.detail, /登录、商店、手机确认不受影响/);
	assert.deepEqual(steamCheckView({status: 200, ms: 512, error: ''}), {type: 'success', text: '市场正常', detail: 'Steam 社区市场 HTTP 200,512 ms'});
	assert.equal(steamCheckView({status: 302, ms: 1, error: ''}).type, 'success');
	assert.deepEqual(steamCheckView({status: 503, ms: 1, error: ''}), {type: 'warning', text: '市场 HTTP 503', detail: 'Steam 社区市场回 HTTP 503'});
	assert.deepEqual(steamCheckView({status: 0, ms: 15000, error: '超时(15 秒)'}), {type: 'error', text: '市场打不开', detail: 'Steam 社区市场打不开:超时(15 秒)'});
});
