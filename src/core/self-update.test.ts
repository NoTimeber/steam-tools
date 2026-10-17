import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSelfUpdate} from './self-update.ts';

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'self-update-'));
	const dataDir = join(root, 'data');
	const updaterDir = join(root, 'updater');
	mkdirSync(updaterDir, {recursive: true});
	let clock = 1_000_000;
	const logs: string[] = [];
	const updater = createSelfUpdate({dataDir, updaterDir, now: () => clock, log: message => void logs.push(message)});
	return {
		updater,
		logs,
		requestFile: join(dataDir, 'update', 'request.json'),
		tick: (ms: number) => void (clock += ms),
		now: () => clock,
		/** 装上更新器(宿主机 install-updater.sh 写的标记) */
		install: () => writeFileSync(join(updaterDir, 'installed.json'), '{"version":1}\n'),
		/** 宿主机 update.sh 写的进度 */
		report: (fields: Record<string, unknown>) => writeFileSync(join(updaterDir, 'status.json'), JSON.stringify(fields)),
		cleanup: () => rmSync(root, {recursive: true, force: true})
	};
}

const status = (error: unknown) => (err: Error & {statusCode?: number}) => err.statusCode === 409 && (error as RegExp).test(err.message);

test('没装更新器:状态 idle、installed 为假,请求被拒(提示怎么装)', t => {
	const env = setup();
	t.after(env.cleanup);
	assert.deepEqual(env.updater.status(), {
		installed: false, state: 'idle', step: '', message: '', log: '', requestedAt: 0, startedAt: 0, finishedAt: 0, updatedAt: 0, from: '', to: '', stale: false
	});
	assert.throws(() => env.updater.request(), status(/install-updater\.sh/));
});

test('请求:写进数据目录的 request.json;宿主机接手前是 pending(久了标 stale),接手后跟着进度走;更新中不能再请求', t => {
	const env = setup();
	t.after(env.cleanup);
	env.install();
	env.report({state: 'done', step: '', startedAt: 10, finishedAt: 20, updatedAt: 20, message: '已更新到 v1.6.16', log: '', from: '1.6.15', to: '1.6.16'});
	assert.equal(env.updater.status().state, 'done', '上一次的结果');

	const pending = env.updater.request();
	assert.deepEqual([pending.state, pending.requestedAt, pending.stale], ['pending', env.now(), false]);
	assert.deepEqual(JSON.parse(readFileSync(env.requestFile, 'utf8')), {requestedAt: env.now()});
	assert.deepEqual(env.logs, ['[update] 面板请求更新,等服务器上的更新器接手']);
	assert.throws(() => env.updater.request(), status(/已经在更新了/));
	env.tick(91_000);
	assert.equal(env.updater.status().stale, true, '一分半没人接手');
	assert.equal(env.updater.request().state, 'pending', '更新器没响应时可以重新请求');

	// 宿主机接手:删掉请求、写进度
	const requested = env.now();
	rmSync(env.requestFile);
	env.tick(2000);
	env.report({state: 'running', step: 'pull', startedAt: env.now(), finishedAt: 0, updatedAt: env.now(), message: '正在拉取新镜像', log: '', from: '1.6.16', to: ''});
	const running = env.updater.status();
	assert.deepEqual([running.state, running.step, running.message, running.requestedAt, running.stale], ['running', 'pull', '正在拉取新镜像', 0, false]);
	assert.ok(running.startedAt > requested);
	assert.throws(() => env.updater.request(), status(/已经在更新了/));
	env.tick(36 * 60 * 1000);
	assert.equal(env.updater.status().stale, true, '「更新中」半个多小时没动静');

	env.report({state: 'failed', step: 'up', startedAt: env.now(), finishedAt: env.now(), updatedAt: env.now(), message: '重启服务失败', log: 'unhealthy', from: '1.6.16', to: ''});
	assert.deepEqual([env.updater.status().state, env.updater.status().log], ['failed', 'unhealthy']);
	assert.equal(env.updater.request().state, 'pending', '失败后可以重试');
});

test('进度文件不对(坏 JSON、不认识的状态、怪字段)当没有;请求文件读不出时间用修改时间', t => {
	const env = setup();
	t.after(env.cleanup);
	env.install();
	writeFileSync(join(env.requestFile, '..', '..', '..', 'updater', 'status.json'), '{oops');
	assert.equal(env.updater.status().state, 'idle');
	env.report({state: 'exploded', step: 'git'});
	assert.equal(env.updater.status().state, 'idle');
	env.report({state: 'running', step: 'rm -rf', startedAt: 'x', message: 42});
	assert.deepEqual([env.updater.status().state, env.updater.status().step, env.updater.status().message, env.updater.status().startedAt], ['running', '', '42', 0]);

	mkdirSync(join(env.requestFile, '..'), {recursive: true});
	writeFileSync(env.requestFile, 'not json');
	const pending = env.updater.status();
	assert.equal(pending.state, 'pending');
	assert.ok(pending.requestedAt > 0, '用文件修改时间');
});
