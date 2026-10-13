// Steam 充值码(钱包码)兑换(从 app/lib/wallet-code.js 移来):自己建临时 steam-user 登录 → 拿 WebSession cookie →
// steamstore 调 ajaxredeemwalletcode 兑换 → 登出。不进会话表、不推 attempt:update,兑换完就走,不污染账户列表。
//
// 自动令牌:有 shared_secret(maFile)就自动生成移动令牌;Steam 仍要 Guard 又没有 shared_secret 时直接失败
// (批量全自动流程没法让人输验证码)。

import {createRequire} from 'node:module';
import {LOCAL_CM_FALLBACKS, patchCmFallback} from '../steam/cm-fallback.ts';

const require = createRequire(import.meta.url);

export type RedeemLog = (level: 'info' | 'warn' | 'success' | 'debug', message: string) => void;

/** EPurchaseResultDetail 常见兑换失败码(取自 steamstore/resources/EPurchaseResult.js) */
const PURCHASE_DETAIL_MESSAGES: Readonly<Record<number, string>> = {
	2: '余额不足 / 钱包错误(InsufficientFunds)',
	3: '请联系 Steam 客服(ContactSupport)',
	9: '该充值码已被使用(AlreadyPurchased)',
	13: '受限国家/地区,无法兑换(RestrictedCountry)',
	14: '充值码无效(BadActivationCode)',
	15: '充值码已被使用(DuplicateActivationCode)',
	19: '当前地区不支持(RegionNotSupported)',
	20: '账号被封禁(AcctIsBlocked)',
	21: '账号未验证(AcctNotVerified)',
	22: '无效账号(InvalidAccount)',
	23: '账单国家与商店国家不一致(StoreBillingCountryMismatch)',
	31: '钱包币种与充值码不一致(WalletCurrencyMismatch)',
	32: '邮箱未验证(EmailNotValidated)',
	35: '兑换后将超过钱包上限(WouldExceedMaxWallet)',
	44: '账号被锁定(AccountLocked)',
	46: '已超过 Steam 兑换次数限制(ExceededSteamLimit)',
	48: '账号没有钱包(NoWallet)',
	50: '该充值码不能在客户端兑换(CannotRedeemCodeFromClient)',
	53: '操作过于频繁,已被限流,请稍后再试(RateLimited)'
};

/** 兑换错误翻成中文:优先看 purchaseresultdetail */
export function describeRedeemError(err: {purchaseresultdetail?: unknown; message?: string} | null | undefined): string {
	if (!err) {
		return '未知错误';
	}
	const detail = err.purchaseresultdetail != null ? Number(err.purchaseresultdetail) : null;
	if (detail != null && PURCHASE_DETAIL_MESSAGES[detail]) {
		return PURCHASE_DETAIL_MESSAGES[detail];
	}
	if (detail != null && detail !== 0) {
		return `兑换失败(detail=${detail})`;
	}
	return err.message || '兑换失败';
}

interface SteamUserClient {
	on(event: string, listener: (...args: any[]) => void): unknown;
	logOn(details: Record<string, unknown>): void;
	logOff(): void;
	webLogOn(): void;
	_apiRequest?: (...args: unknown[]) => Promise<unknown>;
}

interface SteamUserClass {
	new (options: Record<string, unknown>): SteamUserClient;
	EConnectionProtocol: {WebSocket: unknown};
}

interface SteamStoreInstance {
	setCookies(cookies: string[]): void;
	redeemWalletCode(code: string): Promise<{eresult: number; detail: number; formattedNewWalletBalance?: string; amount?: number}>;
}

interface Totp {
	generateAuthCode(sharedSecret: string): string;
}

export interface RedeemDeps {
	SteamUser?: SteamUserClass;
	SteamStore?: new () => SteamStoreInstance;
	totp?: Totp;
}

export interface LoginOptions {
	accountName: string;
	/** 密码和 refreshToken 二选一;有 refreshToken 优先用它 */
	password?: string;
	refreshToken?: string;
	/** maFile 的 shared_secret(自动 2FA) */
	sharedSecret?: string;
	dataDirectory?: string | null;
	timeoutMs?: number;
	logger?: RedeemLog;
}

export interface RedeemOptions extends LoginOptions {
	code: string;
}

export interface RedeemResult {
	ok: true;
	eresult: number;
	detail: number;
	formattedNewWalletBalance: string;
	amount: number | undefined;
	message: string;
}

function errorText(err: unknown, fallback: string): string {
	return err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : fallback;
}

function toCookieArray(cookies: unknown): string[] {
	if (Array.isArray(cookies)) {
		return cookies;
	}
	if (typeof cookies === 'string') {
		return cookies.split(/;\s*/).filter(Boolean);
	}
	return [];
}

export function createWalletRedeemer(deps: RedeemDeps = {}) {
	// 用到时才加载(e2e 的离线环境会替换这几个库)
	const SteamUser = () => deps.SteamUser ?? require('steam-user') as SteamUserClass;
	const SteamStore = () => deps.SteamStore ?? require('steamstore') as new () => SteamStoreInstance;
	const totp = () => deps.totp ?? require('steam-totp') as Totp;

	/** 登录一个账号拿 cookies;登录失败、要人工 Guard、超时都 reject(并登出) */
	function loginForCookies(opts: LoginOptions): Promise<{client: SteamUserClient; cookies: string[]}> {
		const log: RedeemLog = opts.logger ?? (() => {});
		const accountName = String(opts.accountName || '').trim();
		const password = opts.password != null ? String(opts.password) : '';
		const refreshToken = String(opts.refreshToken || '').trim();
		const sharedSecret = String(opts.sharedSecret || '').trim();
		const timeoutMs = opts.timeoutMs || 60000;

		return new Promise((resolve, reject) => {
			const UserClass = SteamUser();
			const client = new UserClass({
				dataDirectory: opts.dataDirectory || null,
				autoRelogin: false,
				renewRefreshTokens: true,
				webCompatibilityMode: true,
				protocol: UserClass.EConnectionProtocol.WebSocket
			});
			let warned = false;
			patchCmFallback(client, LOCAL_CM_FALLBACKS, () => {
				if (!warned) {
					warned = true;
					log('warn', 'Steam 目录服务不可达,改用本地 WebSocket CM');
				}
			});

			let settled = false;
			const timer = setTimeout(() => finish(new Error('登录超时')), timeoutMs);
			// steam-user 的 'error' 事件没人听会抛未捕获异常;结束后不摘监听,只清定时器,后续错误吞掉
			function finish(err: Error | null, value?: {client: SteamUserClient; cookies: string[]}): void {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (err) {
					try {
						client.logOff();
					} catch {
						// 已断开
					}
					reject(err);
				} else {
					resolve(value as {client: SteamUserClient; cookies: string[]});
				}
			}

			client.on('steamGuard', (domain: unknown, callback: (code: string) => void, lastCodeWrong: boolean) => {
				if (!domain && sharedSecret) {
					try {
						const code = totp().generateAuthCode(sharedSecret);
						log('info', '已自动提交移动令牌验证码');
						callback(code);
					} catch (err) {
						finish(new Error('生成移动令牌失败: ' + errorText(err, String(err))));
					}
					return;
				}
				if (lastCodeWrong) {
					finish(new Error('移动令牌验证码错误(shared_secret 不匹配或服务器时间偏差)'));
					return;
				}
				finish(new Error(domain
					? '需要邮箱 Steam Guard 验证码,无法自动兑换'
					: '需要移动令牌但缺少 shared_secret(请先导入该账号的 maFile)'));
			});

			client.on('loggedOn', () => {
				log('info', 'Steam 登录成功,正在获取 WebSession');
				try {
					client.webLogOn();
				} catch (err) {
					finish(new Error('获取 WebSession 失败: ' + errorText(err, String(err))));
				}
			});

			client.on('webSession', (sessionID: unknown, cookies: unknown) => {
				finish(null, {client, cookies: Array.isArray(cookies) ? cookies : []});
			});

			client.on('error', (err: unknown) => {
				if (!settled) {
					finish(new Error(errorText(err, 'Steam 登录失败')));
				} else {
					log('debug', 'Steam 客户端事件: ' + errorText(err, String(err)));
				}
			});

			let details: Record<string, unknown>;
			if (refreshToken) {
				details = {refreshToken};
			} else {
				if (!accountName || !password) {
					finish(new Error('缺少账号或密码'));
					return;
				}
				details = {accountName, password};
				if (sharedSecret) {
					try {
						details.twoFactorCode = totp().generateAuthCode(sharedSecret);
					} catch {
						// 生成失败就等 steamGuard 事件
					}
				}
			}

			log('info', '正在连接 Steam…');
			try {
				client.logOn(details);
			} catch (err) {
				finish(new Error('登录启动失败: ' + errorText(err, String(err))));
			}
		});
	}

	/**
	 * 登录某账号兑换一个充值码,完成后登出。
	 * steamstore 只把「码无效/码已用」当错误抛出,其它失败(限流、币种不符、没钱包……)是 resolve 一个 eresult≠1 的结果;
	 * 旧代码没检查 eresult,这些失败都被报成了「兑换成功」。
	 */
	async function redeemForAccount(opts: RedeemOptions): Promise<RedeemResult> {
		const log: RedeemLog = opts.logger ?? (() => {});
		const code = String(opts.code || '').trim();
		if (!code) {
			throw new Error('充值码为空');
		}

		const {client, cookies} = await loginForCookies(opts);
		try {
			if (!cookies.length) {
				throw new Error('未获取到 WebSession cookies');
			}
			const StoreClass = SteamStore();
			const store = new StoreClass();
			store.setCookies(toCookieArray(cookies));

			log('info', '正在兑换充值码…');
			let result;
			try {
				result = await store.redeemWalletCode(code);
			} catch (err) {
				throw new Error(describeRedeemError(err as {purchaseresultdetail?: unknown; message?: string}));
			}
			if (Number(result && result.eresult) !== 1) {
				throw new Error(describeRedeemError({purchaseresultdetail: result && result.detail, message: `兑换失败(eresult=${result && result.eresult})`}));
			}

			const balance = result.formattedNewWalletBalance ? String(result.formattedNewWalletBalance) : '';
			log('success', '兑换成功' + (balance ? ',当前余额 ' + balance : ''));
			return {
				ok: true,
				eresult: result.eresult,
				detail: result.detail,
				formattedNewWalletBalance: balance,
				amount: result.amount,
				message: balance ? '兑换成功,余额 ' + balance : '兑换成功'
			};
		} finally {
			try {
				client.logOff();
			} catch {
				// 已断开
			}
		}
	}

	return {loginForCookies, redeemForAccount};
}

export type WalletRedeemer = ReturnType<typeof createWalletRedeemer>;
