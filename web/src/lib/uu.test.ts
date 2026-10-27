/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {autoBindCandidates, formatInterval, intervalMinutes, onlineHint, statsText, tokenHint, uuCounts, uuRows} from './uu.ts';
import type {UuAccount, UuToken} from './uu.ts';

function account(name: string, fields: Partial<UuAccount> = {}): UuAccount {
	return {
		accountName: name, bound: true, nickname: 'n-' + name, userId: 'u-' + name, tokenExpired: false, tokenExpiresAt: '',
		delivery: {
			730: {gameId: '730', gameLabel: 'CS2', auto: false, status: 'idle', lastScanAt: '', lastError: '', stats: {delivered: 2, failed: 1}},
			440: {gameId: '440', gameLabel: 'TF2', auto: false, status: 'idle', lastScanAt: '', lastError: '', stats: {delivered: 1}}
		},
		recentOrders: [], logs: [], online: true, hasCookies: true, hasIdentitySecret: true,
		listAuto: false, listStatus: 'idle', listLastError: '', listStats: {listed: 3, repriced: 1}, ...fields
	};
}

const token = (id: string, fields: Partial<UuToken> = {}): UuToken => ({id, userId: 'u-' + id, nickname: 'tok-' + id, linkedSteamId: '', ...fields});
const locals = [{accountName: 'alpha', steamID: '7656001'}, {accountName: 'bravo', steamID: '7656002'}];

test('发货列表:已绑定在前按名字,再接还没匹配到账号的 token(已有账号认领的 token 不重复)', () => {
	const rows = uuRows(
		[account('zulu', {bound: false}), account('bravo'), account('alpha')],
		[token('alpha'), token('x', {linkedSteamId: '7656002'}), token('y')],
		locals
	);
	assert.deepEqual(rows.map(row => row.key), ['account:alpha', 'account:bravo', 'account:zulu', 'token:x', 'token:y']);
	assert.equal(rows[0]!.local?.accountName, 'alpha');
	assert.equal(rows[3]!.local?.accountName, 'bravo');
	assert.equal(rows[4]!.local, null);
	// bravo 已绑着别的 token:x 这一行带上 bravo 那一行
	const x = rows[3]!;
	assert.equal(x.kind === 'token' ? x.holder?.accountName : '', 'bravo');
	const unbound = uuRows([account('Bravo', {bound: false})], [token('x', {linkedSteamId: '7656002'})], locals)[1]!;
	assert.equal(unbound.kind === 'token' ? unbound.holder : 'n/a', null);
});

test('在线提示:缺 cookies / maFile 也发不了货', () => {
	assert.equal(onlineHint(account('a'), null).text, '账户管理无此账号');
	assert.equal(onlineHint(account('a', {online: false}), locals[0]!).text, '离线');
	assert.equal(onlineHint(account('a', {hasCookies: false}), locals[0]!).text, '在线·缺 cookies');
	assert.equal(onlineHint(account('a', {hasIdentitySecret: false}), locals[0]!).text, '在线·缺 maFile');
	assert.deepEqual(onlineHint(account('a'), locals[0]!), {text: '在线', tone: 'success'});
});

test('未匹配 token 的说明:写清是账号已绑了别的、绑定报错还是还没绑', () => {
	const matched = token('t', {linkedSteamId: '7656001'});
	assert.match(tokenHint(token('t'), null).hint, /未绑定 Steam 账号/);
	assert.match(tokenHint(token('t', {linkedSteamId: '999'}), null).hint, /SteamID 999 未匹配/);
	assert.deepEqual(tokenHint(matched, locals[0]!, null, 'token 校验失败: 登录已过期'), {tag: '绑定失败', hint: '已匹配到账号 alpha,自动绑定失败:token 校验失败: 登录已过期'});
	assert.deepEqual(tokenHint(matched, locals[0]!, account('alpha'), '旧的报错'), {
		tag: '账号已绑定', hint: '已匹配到账号 alpha,但该账号已绑定另一个 UU Token(n-alpha),这个 Token 没用上;要换用它,先删除该账号的 Token'
	});
	assert.match(tokenHint(matched, locals[0]!, account('alpha', {userId: ''})).hint, /看不出是不是这一个/);
	assert.deepEqual(tokenHint(matched, locals[0]!).tag, '待绑定');
	assert.doesNotMatch(Object.values(tokenHint(matched, locals[0]!)).join(), /过期/);
});

test('自动绑定:SteamID 对上账户管理里的账号且该账号没绑过;同一账号只绑一个', () => {
	const tokens = [token('a', {linkedSteamId: '7656001'}), token('b', {linkedSteamId: '7656002'}), token('c', {linkedSteamId: '7656002'}), token('d'), token('e', {linkedSteamId: '999'})];
	assert.deepEqual(autoBindCandidates(tokens, [account('alpha')], locals), [{tokenId: 'b', accountName: 'bravo'}]);
	assert.deepEqual(autoBindCandidates(tokens, [account('alpha', {bound: false})], locals).map(c => c.accountName), ['alpha', 'bravo']);
	assert.deepEqual(autoBindCandidates(tokens, [account('ALPHA')], locals).map(c => c.accountName), ['bravo'], '账号名大小写不同也算已绑');
});

test('统计与轮询间隔', () => {
	assert.deepEqual(uuCounts([account('a'), account('b', {bound: false, online: false})]), {total: 2, bound: 1, online: 1, delivered: 6});
	assert.equal(statsText(account('a')), 'CS2发货 2 · TF2发货 1 · 失败 1 · 上架 3 / 改价 1');
	assert.equal(formatInterval(300000), '5 分钟');
	assert.equal(formatInterval(90000), '1.5 分钟');
	assert.equal(formatInterval(30000), '30 秒');
	assert.equal(formatInterval(0), '-');
	assert.equal(intervalMinutes(90000), 1.5);
	assert.equal(intervalMinutes(0), null);
});
