/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	ALL_ACCOUNTS, NO_GROUP, accountsCsv, activeFilterCount, collapseAttemptStatus, emptyFilters, formatBalance, lastErrorMessage, matchNameList,
	matchesFilters, matchesGroupFilter, matchesSearch, moveGroupId, padSeq, parseAccountText, parseNameList, resolveSeqRange, sortAccounts,
	walletTotals
} from './accounts.ts';
import type {FilterableAccount} from './accounts.ts';

function account(name: string, extra: Partial<FilterableAccount & {steamID: string; country: string; currency: number | null}> = {}) {
	return {
		accountName: name, steamID: '', country: '', currency: null, groupId: '', status: '未登录' as const,
		cs2GcConnected: false, tf2GcConnected: false, hasMaFile: false, hasSharedSecret: false, hasWallet: false, balance: null, ...extra
	};
}

test('登录状态归并:登录成功后的重连过程仍显示登录成功', () => {
	assert.equal(collapseAttemptStatus('web_session', '未登录'), '登录成功');
	assert.equal(collapseAttemptStatus('connecting', '未登录'), '登录中');
	assert.equal(collapseAttemptStatus('guard_required', '登录中'), '登录中');
	assert.equal(collapseAttemptStatus('connecting', '登录成功'), '登录成功');
	assert.equal(collapseAttemptStatus('failed', '登录中'), '登录失败');
	assert.equal(collapseAttemptStatus('disconnected', '登录成功'), '登录成功');
	assert.equal(collapseAttemptStatus('logged_out', '登录成功'), '未登录');
	assert.equal(collapseAttemptStatus('weird', '登录成功'), '未登录');
});

test('分组筛选:全部、按分组、未分组', () => {
	const rows = [{groupId: 'g1'}, {groupId: ''}, {groupId: 'g1'}, {groupId: 'gone'}];
	assert.equal(rows.filter(row => matchesGroupFilter(row, ALL_ACCOUNTS)).length, 4);
	assert.equal(rows.filter(row => matchesGroupFilter(row, 'g1')).length, 2);
	assert.equal(rows.filter(row => matchesGroupFilter(row, NO_GROUP)).length, 1);
});

test('账户表筛选:分组、会话、GC、令牌来源、余额上下限;角标数生效的条件', () => {
	const rows = [
		account('a', {groupId: 'g1', status: '登录成功', cs2GcConnected: true, hasMaFile: true, hasWallet: true, balance: 5}),
		account('b', {status: '登录成功', hasSharedSecret: true, hasWallet: true, balance: 20}),
		account('c', {status: '未登录'}),
		account('d', {status: '登录失败', hasWallet: true, balance: null})
	];
	const names = (patch: Partial<ReturnType<typeof emptyFilters>>) => rows.filter(row => matchesFilters(row, {...emptyFilters(), ...patch})).map(row => row.accountName);
	assert.deepEqual(names({}), ['a', 'b', 'c', 'd']);
	assert.deepEqual(names({group: 'g1'}), ['a']);
	assert.deepEqual(names({group: NO_GROUP, session: '登录成功'}), ['b']);
	assert.deepEqual(names({gc: 'connected'}), ['a']);
	assert.deepEqual(names({gc: 'none'}), ['b', 'c', 'd']);
	assert.deepEqual(names({guard: 'mafile'}), ['a']);
	assert.deepEqual(names({guard: 'secret'}), ['b']);
	assert.deepEqual(names({guard: 'none'}), ['c', 'd']);
	assert.deepEqual(names({minBalance: 10}), ['b'], '没钱包、没余额的账号设了余额条件就筛掉');
	assert.deepEqual(names({minBalance: 0, maxBalance: 10}), ['a']);
	assert.equal(activeFilterCount(emptyFilters()), 0);
	assert.equal(activeFilterCount({...emptyFilters(), group: NO_GROUP, gc: 'none', minBalance: 0}), 3, '余额下限填 0 也算');
});

test('账户表排序:用户名(数字按大小)、会话(GC → 在线 → 登录中 → 失败 → 离线)、余额(没余额的总在最后);相同的保持原顺序', () => {
	const rows = [
		account('acc10', {status: '未登录'}),
		account('acc2', {status: '登录成功', hasWallet: true, balance: 3}),
		account('Acc1', {status: '登录成功', tf2GcConnected: true, hasWallet: true, balance: 9}),
		account('acc3', {status: '登录中'}),
		account('acc4', {status: '登录成功', hasWallet: true, balance: 3})
	];
	const names = (list: typeof rows) => list.map(row => row.accountName);
	assert.deepEqual(names(sortAccounts(rows, 'accountName', 'ascend')), ['Acc1', 'acc2', 'acc3', 'acc4', 'acc10']);
	assert.deepEqual(names(sortAccounts(rows, 'accountName', 'descend')), ['acc10', 'acc4', 'acc3', 'acc2', 'Acc1']);
	assert.deepEqual(names(sortAccounts(rows, 'status', 'ascend')), ['Acc1', 'acc2', 'acc4', 'acc3', 'acc10']);
	assert.deepEqual(names(sortAccounts(rows, 'balance', 'descend')), ['Acc1', 'acc2', 'acc4', 'acc10', 'acc3']);
	assert.deepEqual(names(sortAccounts(rows, 'balance', 'ascend')), ['acc2', 'acc4', 'Acc1', 'acc10', 'acc3']);
	assert.deepEqual(names(sortAccounts(rows, '', 'ascend')), names(rows));
});

test('钱包合计:按币种分开加,账号多的币种在前;没钱包的不算', () => {
	assert.deepEqual(walletTotals([
		account('a', {hasWallet: true, balance: 1.1, currency: 1}),
		account('b', {hasWallet: true, balance: 2.2, currency: 23}),
		account('c', {hasWallet: true, balance: 3.3, currency: 23}),
		account('d', {hasWallet: false, balance: 100, currency: 1}),
		account('e', {hasWallet: true, balance: null, currency: 1})
	]), [{currency: 23, total: 5.5, count: 2}, {currency: 1, total: 1.1, count: 1}]);
	assert.deepEqual(walletTotals([]), []);
});

test('导出账户列表:序号按导出顺序,分组写名字,会话写在线/离线,余额两位小数;= 开头的防公式', () => {
	const csv = accountsCsv([
		account('alpha', {groupId: 'g1', status: '登录成功', steamID: '7656', country: 'US', hasWallet: true, balance: 1.5, currency: 1}),
		account('=bad', {status: '未登录'})
	], id => (id === 'g1' ? '市场号' : ''));
	assert.equal(csv, '﻿序号,账号,分组,会话,SteamID,国家,余额,币种\r\n1,alpha,市场号,在线,7656,US,1.50,$\r\n2,\'=bad,,离线,,,,\r\n');
});

test('搜索:账号名不分大小写包含,或 SteamID 包含;空关键词都算', () => {
	const row = {accountName: 'Alpha_01', steamID: '76561190000000011'};
	assert.equal(matchesSearch(row, ' alpha '), true);
	assert.equal(matchesSearch(row, '0000011'), true);
	assert.equal(matchesSearch(row, 'bravo'), false);
	assert.equal(matchesSearch(row, '  '), true);
});

test('粘贴账号列表:空格、逗号、分号、换行(含中文标点)分隔,不分大小写去重;按账号名或 SteamID 对上,对不上的列出来', () => {
	assert.deepEqual(parseNameList(' a, b，c;d；e、f\n\tg  A\r\n'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
	assert.deepEqual(parseNameList(' \n , '), []);
	const rows = [
		{accountName: 'Alpha', steamID: '7656001'},
		{accountName: 'bravo', steamID: ''},
		{accountName: 'charlie', steamID: '7656003'}
	];
	const result = matchNameList('ALPHA 7656001 bravo zulu, 7656003\n7656999', rows);
	assert.deepEqual(result.matched.map(row => row.accountName), ['Alpha', 'bravo', 'charlie'], '同一个账号按名字和 SteamID 都对上只算一次');
	assert.deepEqual(result.missing, ['zulu', '7656999']);
});

test('分组排序:上移下移一位,到头不动', () => {
	assert.deepEqual(moveGroupId(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
	assert.deepEqual(moveGroupId(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
	assert.deepEqual(moveGroupId(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
	assert.deepEqual(moveGroupId(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
	assert.deepEqual(moveGroupId(['a'], 'x', 1), ['a']);
});

test('导入文本:账号----密码,跳过空行和 # 注释;格式错的行号一起报', () => {
	assert.deepEqual(parseAccountText(' a----p1 \n\n# note\nb ---- p----2\r\n'), [
		{accountName: 'a', password: 'p1'},
		{accountName: 'b', password: 'p----2'}
	]);
	assert.throws(() => parseAccountText('a----p\nbad\n----x\nc----'), /第 2, 3, 4 行格式错误/);
	assert.throws(() => parseAccountText('  \n# only comment'), /请输入/);
});

test('余额:没钱包或没余额显示 -,有币种带符号', () => {
	assert.equal(formatBalance({hasWallet: true, balance: 12.5, currency: 1}), '$12.50');
	assert.equal(formatBalance({hasWallet: true, balance: 3, currency: 23}), '3.00');
	assert.equal(formatBalance({hasWallet: false, balance: 3, currency: 1}), '-');
	assert.equal(formatBalance({hasWallet: true, balance: null, currency: 1}), '-');
});

test('按序号勾选:单侧、颠倒、越界', () => {
	assert.deepEqual(resolveSeqRange('3', '', 10), {start: 3, end: 3});
	assert.deepEqual(resolveSeqRange('', '4', 10), {start: 4, end: 4});
	assert.deepEqual(resolveSeqRange('8', '2', 10), {start: 2, end: 8});
	assert.deepEqual(resolveSeqRange('0', '99', 10), {start: 1, end: 10});
	assert.deepEqual(resolveSeqRange('11', '20', 10), {error: '序号超出范围(共 10 个账户)'});
	assert.deepEqual(resolveSeqRange('', '', 10), {error: '请输入要勾选的序号'});
	assert.deepEqual(resolveSeqRange('1', '2', 0), {error: '暂无账户'});
	assert.equal(padSeq(7), '07');
	assert.equal(padSeq(123), '123');
});

test('登录失败原因:取最近一条 error 日志', () => {
	assert.equal(lastErrorMessage([{level: 'error', message: 'old'}, {level: 'info', message: 'x'}, {level: 'error', message: 'InvalidPassword'}, {level: 'info', message: 'y'}]), 'InvalidPassword');
	assert.equal(lastErrorMessage(undefined), '');
});
