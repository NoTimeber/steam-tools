// 账户真实国家/地区(从 app/server.js 移来):用账号自己的 cookie 请求 Steam 商店账户页,读 #application_config 里的 COUNTRY。
// 这是账号在 Steam 上设置的商店国家(网页「国家/地区」显示的值),不随登录 IP 变;美元等钱包从币种推断不出国家时靠它。
// 刚登录的账号第一次访问会 302 回自己并补发 cookie,由 ./store-session.ts 处理。

import {normalizeCountryCode} from '../steam/currencies.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {createStoreSession} from './store-session.ts';

const ACCOUNT_URL = 'https://store.steampowered.com/account/';
const REQUEST_TIMEOUT_MS = 9000;
/** 查过(不论成败)的账号 5 分钟内不再查,免得每次刷新账户列表都打 Steam */
const COOLDOWN_MS = 5 * 60 * 1000;
/** 补全账户列表国家的总时间预算和并发 */
const FILL_BUDGET_MS = 6000;
const FILL_CONCURRENCY = 5;

type CountryAttempt = Pick<Attempt, 'accountName'> & Partial<Pick<Attempt, 'userAgent' | 'steamID' | 'cookies' | 'id'>>;

export interface CountryEvents {
	addLog(attempt: Attempt, level: string, message: string): void;
	saveSession(attempt: Attempt): void;
	emit(attempt: Attempt): void;
}

export interface CountryLookupOptions {
	cookiesFor(attempt: CountryAttempt): readonly string[];
	events: CountryEvents;
	fetch?: typeof fetch;
	now?: () => number;
}

function errorText(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : String(err);
}

export function createCountryLookup(options: CountryLookupOptions) {
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const now = options.now ?? Date.now;
	const cache = new Map<string, string>();       // 账号名小写 → 国家
	const fetchedAt = new Map<string, number>();   // 账号名小写 → 上次查询时间

	/** 查一个账号的商店国家;没 cookie 返回 '',cookie 失效等抛错 */
	async function lookup(attempt: CountryAttempt): Promise<string> {
		const cookies = options.cookiesFor(attempt);
		if (!cookies.length) {
			return '';
		}
		const session = createStoreSession({cookies, userAgent: attempt.userAgent, fetch: http, timeoutMs: REQUEST_TIMEOUT_MS});
		const html = await session.getHtml(ACCOUNT_URL, '账户页');
		// 必须是已登录的账户页,否则 COUNTRY 可能是按 IP 给访客的值
		const loggedIn = /account_pulldown/.test(html) || (!!attempt.steamID && html.includes(String(attempt.steamID)));
		if (!loggedIn) {
			throw new Error('账户页未登录(cookie 可能已失效)');
		}
		const match = html.match(/&quot;COUNTRY&quot;:&quot;([A-Za-z]{2})&quot;/)
			|| html.match(/"COUNTRY"\s*:\s*"([A-Za-z]{2})"/)
			|| html.match(/"countrycode"\s*:\s*"([A-Za-z]{2})"/);
		return match ? normalizeCountryCode(match[1]) : '';
	}

	/** 登录拿到 WebSession 后在后台刷新真实国家,变了就更新会话并推送(不阻塞登录) */
	function refresh(attempt: Attempt): void {
		if (!attempt) {
			return;
		}
		const key = String(attempt.accountName || '').toLowerCase();
		lookup(attempt).then(country => {
			if (key) {
				fetchedAt.set(key, now());
			}
			if (!country) {
				return;
			}
			if (key) {
				cache.set(key, country);
			}
			if (country !== attempt.country) {
				attempt.country = country;
				options.events.addLog(attempt, 'info', '账户国家/地区: ' + country);
				options.events.saveSession(attempt);
				options.events.emit(attempt);
			}
		}).catch(err => {
			if (key) {
				fetchedAt.set(key, now());
			}
			options.events.addLog(attempt, 'warn', '获取账户国家失败: ' + errorText(err));
		});
	}

	/** 给账户列表补全缺的国家:有总时间预算、并发上限、失败冷却,接口不会被网络请求拖住 */
	async function fillMissing(accounts: Record<string, {country: string}>): Promise<void> {
		const pending = Object.keys(accounts).filter(name => !accounts[name]?.country);
		if (!pending.length) {
			return;
		}
		const deadline = now() + FILL_BUDGET_MS;
		const queue = pending.slice();
		const worker = async () => {
			while (queue.length && now() < deadline) {
				const name = queue.shift() as string;
				const key = name.toLowerCase();
				const account = accounts[name] as {country: string};
				const cached = cache.get(key);
				if (cached) {
					account.country = cached;
					continue;
				}
				if (now() - (fetchedAt.get(key) || 0) < COOLDOWN_MS) {
					continue;
				}
				fetchedAt.set(key, now());
				try {
					const country = await lookup({accountName: name});
					if (country) {
						cache.set(key, country);
						account.country = country;
					}
				} catch {
					// 查不到就留空
				}
			}
		};
		await Promise.all(Array.from({length: Math.min(FILL_CONCURRENCY, pending.length)}, worker));
	}

	return {lookup, refresh, fillMissing};
}

export type CountryLookup = ReturnType<typeof createCountryLookup>;
