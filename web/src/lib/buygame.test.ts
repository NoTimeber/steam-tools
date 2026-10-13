/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountDetail, clampConcurrency, completionNotice, formatGamePrice, formatMoney, parseSubids, taskProgress} from './buygame.ts';
import type {BuyGameTask, GameEntry} from './buygame.ts';

test('subid:中英文逗号和空白分隔,非正整数丢掉', () => {
	assert.deepEqual(parseSubids(' 10, 20，30\n40 abc -5 0 1.5'), [10, 20, 30, 40]);
	assert.deepEqual(parseSubids(''), []);
});

test('金额与价格显示', () => {
	assert.equal(formatMoney(499, 1, 'USD'), '$4.99');
	assert.equal(formatMoney(499, null, 'USD'), '4.99 USD');
	const game: GameEntry = {packageId: 10, name: 'x', appid: 1, priceCents: 499, currencyISO: 'USD', discountPercent: 20, resolving: false, error: ''};
	assert.equal(formatGamePrice(game, 1), '$4.99 (-20%)');
	assert.equal(formatGamePrice({...game, discountPercent: 0}, null), '4.99 USD');
	assert.equal(formatGamePrice({...game, priceCents: 0}, 1), '免费 / 无价格');
	assert.equal(formatGamePrice({...game, resolving: true}, 1), '解析中…');
	assert.equal(formatGamePrice({...game, error: '没有这个包'}, 1), '没有这个包');
});

test('线程数:1-10,填错用 3', () => {
	assert.equal(clampConcurrency('5'), 5);
	assert.equal(clampConcurrency(99), 10);
	assert.equal(clampConcurrency(0), 3);
	assert.equal(clampConcurrency('x'), 3);
	assert.equal(clampConcurrency(2.6), 3);
});

const task = (fields: Partial<BuyGameTask>): BuyGameTask => ({
	id: 't', status: 'running', dryRun: false, concurrency: 3, createdAt: '', totalAccounts: 2, processedAccounts: 1, successCount: 1, failCount: 0, accounts: [], ...fields
});

test('任务进度、逐账号说明、结束提示', () => {
	assert.equal(taskProgress(task({})), '真实购买 · 进行中 · 3 线程 · 1/2 · 成功 1 失败 0');
	assert.equal(taskProgress(task({dryRun: true, status: 'completed', concurrency: 0})), '试运行 · 已完成 · 1/2 · 成功 1 失败 0');
	const account = {account: 'a', status: 'success', currency: 1, currencyISO: 'USD', spentCents: 499, transId: 'T1', error: ''};
	assert.equal(accountDetail(account, false), '交易号 T1');
	assert.equal(accountDetail({...account, status: 'verified'}, true), '已验证 · 交易号 T1');
	assert.equal(accountDetail({...account, status: 'failed', error: '余额不足'}, false), '余额不足');
	assert.equal(accountDetail({...account, transId: ''}, false), '');
	assert.equal(completionNotice(task({})), null);
	assert.deepEqual(completionNotice(task({status: 'completed', successCount: 2})), {level: 'success', message: '购买完成:成功 2,失败 0'});
	assert.deepEqual(completionNotice(task({status: 'completed', dryRun: true, failCount: 1, accounts: [{...account, status: 'verified'}]})), {
		level: 'warn', message: '试运行完成:1 个账号验证通过,1 个失败'
	});
});
