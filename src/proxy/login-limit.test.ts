import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLoginLimiter} from './login-limit.ts';

/** 假时钟:定时器到点才跑 */
function clock() {
	let time = 0;
	let timers: Array<{at: number; callback: () => void}> = [];
	return {
		now: () => time,
		setTimer: (callback: () => void, ms: number) => {
			const timer = {at: time + ms, callback};
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer: unknown) => {
			timers = timers.filter(item => item !== timer);
		},
		async advance(ms: number) {
			const end = time + ms;
			for (;;) {
				const due = timers.filter(item => item.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!due) {
					break;
				}
				timers = timers.filter(item => item !== due);
				time = due.at;
				due.callback();
				await Promise.resolve();
			}
			time = end;
			await Promise.resolve();
		}
	};
}

function limiter(limit: () => number) {
	const time = clock();
	return {time, limiter: createLoginLimiter({limit, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer})};
}

test('没超每分钟次数马上放行;超了排队,按先来后到,等最早那次出了 60 秒窗口', async () => {
	const {time, limiter: logins} = limiter(() => 2);
	assert.equal(logins.acquire(), null);
	await time.advance(10000);
	assert.equal(logins.acquire(), null, '第二次也马上放行');
	const started: string[] = [];
	const third = logins.acquire()!;
	const fourth = logins.acquire()!;
	assert.deepEqual([third.waitMs, fourth.waitMs], [50000, 60000], '第一次在 0 秒、第二次在 10 秒,分别到 60、70 秒出窗口');
	void third.ready.then(ok => started.push(`third ${ok}`));
	void fourth.ready.then(ok => started.push(`fourth ${ok}`));
	assert.equal(logins.pending(), 2);

	await time.advance(49999);
	assert.deepEqual(started, [], '没到点不放');
	await time.advance(1);
	assert.deepEqual(started, ['third true']);
	await time.advance(10000);
	assert.deepEqual(started, ['third true', 'fourth true']);
	assert.equal(logins.pending(), 0);

	const fifth = logins.acquire()!;
	assert.equal(fifth.waitMs, 50000, '刚放行的两次(60、70 秒)也算在窗口里,要等到 120 秒');
});

test('排队时有人前面先来了也排后面;轮到时已经取消的跳过,不占次数', async () => {
	const {time, limiter: logins} = limiter(() => 1);
	assert.equal(logins.acquire(), null);
	let gone = false;
	const results: string[] = [];
	void logins.acquire(() => gone)!.ready.then(ok => results.push(`a ${ok}`));
	void logins.acquire()!.ready.then(ok => results.push(`b ${ok}`));
	gone = true;
	await time.advance(60000);
	assert.deepEqual(results, ['a false', 'b true'], 'a 被删了,它的名额给了 b');
	assert.notEqual(logins.acquire(), null, 'b 占了这一分钟的名额');
});

test('不限(0 或留空)时都马上放行,也不记次数;改了限制调 update 马上按新的放行', async () => {
	let limit = 0;
	const {time, limiter: logins} = limiter(() => limit);
	for (let index = 0; index < 20; index++) {
		assert.equal(logins.acquire(), null);
	}
	limit = 1;
	assert.equal(logins.acquire(), null, '之前不限时的不算');
	const results: boolean[] = [];
	void logins.acquire()!.ready.then(ok => results.push(ok));
	void logins.acquire()!.ready.then(ok => results.push(ok));
	limit = 5;
	logins.update();
	await time.advance(0);
	assert.deepEqual(results, [true, true], '放宽后排队的马上走');

	const queued = logins.acquire();
	assert.equal(queued, null, '5 次里才用了 3 次');
	assert.equal(logins.acquire(), null);
	const waiting = logins.acquire()!;
	let done = false;
	void waiting.ready.then(() => (done = true));
	limit = 0;
	logins.update();
	await time.advance(0);
	assert.ok(done, '改成不限(或关了代理)后排队的全放');
});
