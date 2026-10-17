/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	ALL_ACCOUNTS, NO_GROUP, collapseAttemptStatus, formatBalance, groupFilterOptions, lastErrorMessage, matchNameList, matchesGroupFilter, matchesSearch,
	moveGroupId, padSeq, parseAccountText, parseNameList, resolveSeqRange, statusGroup
} from './accounts.ts';

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

test('状态段:任一 GC 连着算 GC 段,其次看登录成功', () => {
	assert.equal(statusGroup({status: '登录成功', cs2GcConnected: false, tf2GcConnected: true}), 'gc');
	assert.equal(statusGroup({status: '登录成功', cs2GcConnected: false, tf2GcConnected: false}), 'online');
	assert.equal(statusGroup({status: '登录中', cs2GcConnected: false, tf2GcConnected: false}), 'offline');
});

test('分组筛选:全部、按分组、未分组;筛选项带人数,没有分组时只有「全部」', () => {
	const rows = [{groupId: 'g1'}, {groupId: ''}, {groupId: 'g1'}, {groupId: 'gone'}];
	assert.equal(rows.filter(row => matchesGroupFilter(row, ALL_ACCOUNTS)).length, 4);
	assert.equal(rows.filter(row => matchesGroupFilter(row, 'g1')).length, 2);
	assert.equal(rows.filter(row => matchesGroupFilter(row, NO_GROUP)).length, 1);
	assert.deepEqual(groupFilterOptions([], rows), [{value: ALL_ACCOUNTS, label: '全部', count: 4}]);
	assert.deepEqual(groupFilterOptions([{id: 'g2', name: '仓库'}, {id: 'g1', name: '主号'}], rows), [
		{value: ALL_ACCOUNTS, label: '全部', count: 4},
		{value: 'g2', label: '仓库', count: 0},
		{value: 'g1', label: '主号', count: 2},
		{value: NO_GROUP, label: '未分组', count: 1}
	]);
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
