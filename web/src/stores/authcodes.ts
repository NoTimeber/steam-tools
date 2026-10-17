// 账户表里一起显示的令牌验证码:POST /api/auth-codes 一次拿全部能生成的账号,这一批过期(服务端说还剩几秒)就再拿。
// 只在账户页开着时走:页面 onMounted 调 watchAuthCodes(),onUnmounted 调它返回的函数。

import {reactive} from 'vue';
import {api} from '../api/http.ts';

const state = reactive({
	/** 账号名(和名单里的写法一样)→ 验证码 */
	codes: {} as Record<string, string>,
	/** 这一批到期的时刻(毫秒);用服务端给的剩余秒数算,不依赖浏览器时钟和服务端对得上 */
	expiresAt: 0,
	/** 每秒更新,倒计时用 */
	now: Date.now()
});

export const authCodes = state;

let watchers = 0;
let timer: number | undefined;
let loading = false;

export async function refreshAuthCodes(): Promise<void> {
	if (loading) {
		return;
	}
	loading = true;
	try {
		const data = await api.post<{codes: Record<string, string>; expiresIn: number}>('/api/auth-codes', {});
		state.codes = data.codes || {};
		state.expiresAt = Date.now() + Math.max(1, Number(data.expiresIn) || 30) * 1000;
	} catch {
		// 拿不到就 10 秒后再试,验证码先空着
		state.codes = {};
		state.expiresAt = Date.now() + 10000;
	} finally {
		loading = false;
	}
}

function tick(): void {
	state.now = Date.now();
	if (state.now >= state.expiresAt) {
		refreshAuthCodes();
	}
}

/** 开始跟着刷新;返回停止的函数(几个地方同时看时都停了才真停) */
export function watchAuthCodes(): () => void {
	watchers++;
	if (watchers === 1) {
		state.expiresAt = 0;
		tick();
		timer = window.setInterval(tick, 1000);
	}
	let stopped = false;
	return () => {
		if (stopped) {
			return;
		}
		stopped = true;
		watchers--;
		if (!watchers) {
			window.clearInterval(timer);
		}
	};
}

/** 这一批验证码还剩几秒(0 表示正在换) */
export function authCodeSecondsLeft(): number {
	return Math.max(0, Math.ceil((state.expiresAt - state.now) / 1000));
}
