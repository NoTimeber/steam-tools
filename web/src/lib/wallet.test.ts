/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyRedeemEvent, maskCode, mergeAccountLines, parseRedeemLines} from './wallet.ts';
import type {ResultRow} from './wallet.ts';

test('按行配对:同为空行跳过,一侧缺内容记错位,结尾空行忽略,密码可不填', () => {
	const result = parseRedeemLines('a----p1\n\nb\nc----p3\n----x\n\n', 'CODE-1\n\nCODE-2\n\nCODE-5\nCODE-6\n');
	assert.deepEqual(result.pairs, [
		{account: 'a', password: 'p1', code: 'CODE-1', line: 1},
		{account: 'b', password: '', code: 'CODE-2', line: 3}
	]);
	assert.deepEqual(result.issues, [
		{line: 4, reason: '左侧有账户,右侧缺少对应充值码'},
		{line: 5, reason: '账户名为空'},
		{line: 6, reason: '右侧有充值码,左侧缺少对应账户'}
	]);
	assert.deepEqual([result.accountTotal, result.codeTotal], [4, 4]);
	assert.deepEqual(parseRedeemLines('', ''), {pairs: [], issues: [], accountTotal: 0, codeTotal: 0});
});

test('充值码打码', () => {
	assert.equal(maskCode('ABCDE-FGHIJ-KLMNO'), 'ABCDE…LMNO');
	assert.equal(maskCode('SHORT'), 'SHORT');
});

const row = (account: string): ResultRow => ({account, password: '', code: 'C', status: 'pending', message: '排队中…', balance: ''});

test('推送更新结果行:下标经 indexMap 映射(重试只提交失败项),过程日志进运行日志', () => {
	const rows = [row('a'), row('b'), row('c')];
	const map = [2, 0];   // 这次只提交了 c、a
	let outcome = applyRedeemEvent(rows, map, {index: 0, status: 'processing', logMessage: '正在登录', logLevel: 'info'});
	assert.deepEqual([rows[2]!.status, rows[2]!.message], ['processing', '正在登录']);
	assert.deepEqual(outcome.logs, [{level: 'info', message: '[兑换·c] 正在登录'}]);
	outcome = applyRedeemEvent(rows, map, {index: 0, logMessage: 'debug 噪声', logLevel: 'debug'});
	assert.deepEqual(outcome.logs, []);
	outcome = applyRedeemEvent(rows, map, {index: 1, account: 'a', status: 'error', message: '码已被使用'});
	assert.deepEqual([rows[0]!.status, rows[0]!.message], ['error', '码已被使用']);
	assert.deepEqual(outcome.logs, [{level: 'error', message: '[兑换·a] 码已被使用'}]);
	applyRedeemEvent(rows, map, {index: 0, status: 'success', message: '兑换成功', balance: '$15.00'});
	assert.deepEqual([rows[2]!.status, rows[2]!.balance], ['success', '$15.00']);
	// 已成功的行不会被迟到的过程日志改回「处理中」
	applyRedeemEvent(rows, map, {index: 0, status: 'processing', logMessage: '迟到的'});
	assert.equal(rows[2]!.status, 'success');
	assert.equal(applyRedeemEvent(rows, map, {index: 9, status: 'success'}).logs.length, 0);
	assert.deepEqual(applyRedeemEvent(rows, map, {status: 'done'}), {done: true, logs: [{level: 'success', message: '充值码兑换任务结束'}]});
	assert.equal(rows[1]!.status, 'pending');
});

test('导入 maFile 合并账户行:按账号去重(不区分大小写),去掉空行', () => {
	assert.equal(mergeAccountLines('Alpha----pw\n\nbravo', ['alpha----', 'charlie----', 'charlie----x']), 'Alpha----pw\nbravo\ncharlie----');
	assert.equal(mergeAccountLines('', ['a----']), 'a----');
});
