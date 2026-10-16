// 登录速率限制:经同一个代理开始的 Steam 登录,任意 60 秒内最多 limit 次(滑动窗口),超出的按先来后到排队。
// 同一个出口 IP 登录太多次 Steam 会开始拒绝;轮换代理按间隔换 IP、或者是静态代理时用得上。
// limit 每次都现取(改了设置马上按新的来,改完调 update() 让排队的重新看一遍);0 为不限。

const WINDOW_MS = 60000;

export interface LoginSlot {
	/** 预计还要等多少毫秒(给日志看;前面有人取消时会提前) */
	waitMs: number;
	/** 轮到时 resolve(true);轮到时 cancelled() 已经为真就跳过它(不占次数),resolve(false) */
	ready: Promise<boolean>;
}

export interface LoginLimiterOptions {
	/** 每分钟最多开始几次登录,0 不限 */
	limit(): number;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	windowMs?: number;
}

interface Waiter {
	cancelled?: () => boolean;
	resolve(granted: boolean): void;
}

export function createLoginLimiter(options: LoginLimiterOptions) {
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
	const windowMs = options.windowMs ?? WINDOW_MS;
	/** 窗口内开始过的登录时间(从早到晚) */
	let starts: number[] = [];
	const queue: Waiter[] = [];
	let timer: unknown = null;

	const limit = () => Math.max(0, Math.floor(Number(options.limit()) || 0));

	function prune(at: number): void {
		starts = starts.filter(time => time + windowMs > at);
	}

	const hasRoom = () => !limit() || starts.length < limit();

	/** 能放的都放出去;还有人在等就定时到最早那次登录出窗口时再看 */
	function pump(): void {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		const at = now();
		prune(at);
		while (queue.length && hasRoom()) {
			const waiter = queue.shift()!;
			if (waiter.cancelled?.()) {
				waiter.resolve(false);
				continue;
			}
			starts.push(at);
			waiter.resolve(true);
		}
		if (queue.length) {
			const next = starts[starts.length - limit()]! + windowMs;
			timer = setTimer(pump, Math.max(0, next - at));
		}
	}

	/** 排第 position 个(从 0 起)的人大概什么时候轮到:按现在的次数和限制推算 */
	function estimate(position: number): number {
		const at = now();
		const max = limit();
		let times = starts.slice();
		let t = at;
		for (let index = 0; index <= position; index++) {
			times = times.filter(time => time + windowMs > t);
			if (max && times.length >= max) {
				t = times[times.length - max]! + windowMs;
				times = times.filter(time => time + windowMs > t);
			}
			times.push(t);
		}
		return t - at;
	}

	/**
	 * 要开始一次登录:没超限马上记一次、返回 null(调用方直接登录);超了排队,返回预计等待和轮到时 resolve 的 promise。
	 * cancelled:轮到时检查,已经不用登录了(任务被删、登出)就跳过,不占次数
	 */
	function acquire(cancelled?: () => boolean): LoginSlot | null {
		const at = now();
		prune(at);
		if (!queue.length && hasRoom()) {
			if (limit()) {
				starts.push(at);
			}
			return null;
		}
		const waitMs = estimate(queue.length);
		const ready = new Promise<boolean>(resolve => queue.push({cancelled, resolve}));
		pump();
		return {waitMs, ready};
	}

	return {
		acquire,
		/** 改了限制(或关了代理)后调:按新的限制放行排队的 */
		update: pump,
		/** 在排队的个数 */
		pending: () => queue.length
	};
}

export type LoginLimiter = ReturnType<typeof createLoginLimiter>;
