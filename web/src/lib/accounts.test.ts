/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountGroup, collapseAttemptStatus, formatBalance, lastErrorMessage, padSeq, parseAccountText, resolveSeqRange} from './accounts.ts';

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

test('分组:任一 GC 连着算 GC 组,其次看登录成功', () => {
	assert.equal(accountGroup({status: '登录成功', cs2GcConnected: false, tf2GcConnected: true}), 'gc');
	assert.equal(accountGroup({status: '登录成功', cs2GcConnected: false, tf2GcConnected: false}), 'online');
	assert.equal(accountGroup({status: '登录中', cs2GcConnected: false, tf2GcConnected: false}), 'offline');
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
