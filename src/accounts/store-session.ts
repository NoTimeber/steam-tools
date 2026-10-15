// 带账号自己的 cookie 访问 Steam 商店页面(查账户国家、读消费记录共用)。
//
// 刚登录的账号只有 steamLoginSecure / sessionid 等,第一次访问商店页会 302 回自己并下发
// browserid / Steam_Language / steamCountry,带上这些再请求一次才返回 200。fetch 跨重定向不带 Set-Cookie,
// 所以这里手动跟随重定向并累积 cookie;同一个会话之后的请求(翻页的 POST)也带上累积的 cookie。

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 9000;

/** 商店请求失败;status 是 HTTP 状态码(超时、断网等没有响应时为 0),retryable 表示稍后重试可能会好(超时、断网、429、5xx) */
export class StoreRequestError extends Error {
	readonly status: number;
	readonly retryable: boolean;

	constructor(message: string, status = 0, retryable = false) {
		super(message);
		this.status = status;
		this.retryable = retryable;
	}
}

export interface StoreSessionOptions {
	cookies: readonly string[];
	userAgent?: string;
	fetch?: typeof fetch;
	/** 单个请求(含它的重定向)的超时 */
	timeoutMs?: number;
}

export function createStoreSession(options: StoreSessionOptions) {
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const jar = new Map<string, string>();
	const putCookie = (raw: string) => {
		const pair = String(raw).split(';')[0] ?? '';
		const index = pair.indexOf('=');
		if (index > 0) {
			jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
		}
	};
	options.cookies.forEach(putCookie);
	const cookieHeader = () => Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
	const userAgent = options.userAgent || 'Mozilla/5.0';

	/** 发请求;跟随重定向(跳到登录页报错),非 2xx 报错。label 是报错里对这个页面的称呼 */
	async function send(url: string, init: {method: 'GET' | 'POST'; headers: Record<string, string>; body?: string}, label: string): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let current = url;
		try {
			for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
				let res: Response;
				try {
					res = await http(current, {...init, headers: {...init.headers, 'User-Agent': userAgent, Cookie: cookieHeader()}, redirect: 'manual', signal: controller.signal});
				} catch (err) {
					throw new StoreRequestError(`${label}请求失败: ${controller.signal.aborted ? '超时' : (err as Error)?.message || String(err)}`, 0, true);
				}
				const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
				setCookies.forEach(putCookie);
				if (res.status >= 300 && res.status < 400) {
					const location = res.headers.get('location');
					if (!location) {
						throw new StoreRequestError(`${label}重定向缺少 location`, res.status);
					}
					current = new URL(location, current).href;
					if (/\/login\b/i.test(current)) {
						throw new StoreRequestError(`${label}跳转到登录页(cookie 已失效,需重新登录)`, res.status);
					}
					if (init.method !== 'GET') {
						throw new StoreRequestError(`${label}被重定向到 ${current}`, res.status);
					}
					continue;
				}
				if (!res.ok) {
					throw new StoreRequestError(`${label} HTTP ${res.status}` + (res.status === 429 ? '(请求太频繁)' : '(cookie 可能已失效)'), res.status, res.status === 429 || res.status >= 500);
				}
				return res;
			}
			throw new StoreRequestError(`${label}重定向次数过多(cookie 可能已失效)`);
		} finally {
			clearTimeout(timer);
		}
	}

	/** GET 一个页面,返回 HTML */
	async function getHtml(url: string, label: string): Promise<string> {
		const res = await send(url, {
			method: 'GET',
			headers: {Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9'}
		}, label);
		return res.text();
	}

	/** 像网页里的 AJAX 一样 POST 表单,返回解析后的 JSON(不是 JSON 报错) */
	async function postForm(url: string, form: Record<string, string>, referer: string, label: string): Promise<unknown> {
		const res = await send(url, {
			method: 'POST',
			headers: {
				Accept: 'application/json, text/javascript, */*; q=0.01',
				'Accept-Language': 'en-US,en;q=0.9',
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
				'X-Requested-With': 'XMLHttpRequest',
				Origin: new URL(url).origin,
				Referer: referer
			},
			body: new URLSearchParams(form).toString()
		}, label);
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			throw new StoreRequestError(`${label}返回的不是 JSON: ${text.slice(0, 200)}`, res.status);
		}
	}

	/** 当前 cookie 里某一项的值(没有为 '') */
	function cookie(name: string): string {
		return jar.get(name) ?? '';
	}

	return {getHtml, postForm, cookie};
}
