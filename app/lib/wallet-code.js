'use strict';

// Steam 充值码(钱包码)兑换 —— 自包含「登录 → 兑换 → 登出」。
// 思路与 lib/trade-offer.js 一致:用 steam-user 登录拿到 webSession cookies,
// 再交给 node-steamstore(npm 包名 steamstore)调用 ajaxredeemwalletcode 兑换。
//
// 与账户管理模块解耦:本模块自建临时 SteamUser,不写入 server.js 的 attempts 表、
// 不广播 attempt:update;兑换完成(或失败)后立即 logOff,避免污染账户列表。
//
// 自动令牌:若提供 shared_secret(来自 maFile),登录时自动用 steam-totp 生成
// 移动令牌验证码;若 Steam 仍要求 Guard 且没有 shared_secret,则判定失败并返回原因
// (这种全自动批量流程无法走人工输入验证码)。

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamStore = require('steamstore');

// 与 server.js 相同的本地 CM 兜底:Steam 目录服务不可达时直连 cm0。
const LOCAL_CM_FALLBACKS = [{
	endpoint: 'cm0.steampowered.com:443',
	type: 'websockets',
	realm: 'steamglobal',
	load: 0,
	wtd_load: 0
}];

// EPurchaseResultDetail 常见兑换失败码 → 中文说明
// (取自 node_modules/steamstore/resources/EPurchaseResult.js)。
const PURCHASE_DETAIL_MESSAGES = {
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

// 把 steamstore 抛出的兑换错误翻译成可读中文。
function describeRedeemError(err) {
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

function noopLogger() {}

function toCookieArray(cookies) {
	if (Array.isArray(cookies)) return cookies;
	if (typeof cookies === 'string') return cookies.split(/;\s*/).filter(Boolean);
	return [];
}

// 给 steam-user 打 CM 兜底补丁(目录服务 GetCMListForConnect 失败时直连 cm0)。
function applyCmFallback(client, logger) {
	const original = client._apiRequest.bind(client);
	let applied = false;
	client._apiRequest = async function patched(httpMethod, iface, method, version, data, cacheSeconds) {
		try {
			return await original(httpMethod, iface, method, version, data, cacheSeconds);
		} catch (err) {
			if (iface === 'ISteamDirectory' && method === 'GetCMListForConnect') {
				if (!applied) {
					applied = true;
					logger('warn', 'Steam 目录服务不可达,改用本地 WebSocket CM');
				}
				return {response: {serverlist: LOCAL_CM_FALLBACKS}};
			}
			throw err;
		}
	};
}

// 登录单个账号,resolve 出 {client, cookies}。登录失败 / 需要人工 Guard / 超时 → reject。
function loginForCookies(opts) {
	const logger = typeof opts.logger === 'function' ? opts.logger : noopLogger;
	const accountName = String(opts.accountName || '').trim();
	const password = opts.password != null ? String(opts.password) : '';
	const refreshToken = String(opts.refreshToken || '').trim();
	const sharedSecret = String(opts.sharedSecret || '').trim();
	const timeoutMs = opts.timeoutMs || 60000;

	return new Promise((resolve, reject) => {
		const client = new SteamUser({
			dataDirectory: opts.dataDirectory || null,
			autoRelogin: false,
			renewRefreshTokens: true,
			webCompatibilityMode: true,
			protocol: SteamUser.EConnectionProtocol.WebSocket
		});
		applyCmFallback(client, logger);

		let settled = false;
		const timer = setTimeout(() => finish(new Error('登录超时')), timeoutMs);

		// 注意:steam-user 的 'error' 事件若无监听会抛未捕获异常导致进程退出。
		// 结算后我们不移除 error 监听(改为吞掉后续断开/错误),只清掉定时器即可。
		function finish(err, value) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) {
				try { client.logOff(); } catch (_) {}
				reject(err);
			} else {
				resolve(value);
			}
		}

		client.on('steamGuard', (domain, callback, lastCodeWrong) => {
			if (!domain && sharedSecret) {
				try {
					const code = SteamTotp.generateAuthCode(sharedSecret);
					logger('info', '已自动提交移动令牌验证码');
					callback(code);
					return;
				} catch (err) {
					finish(new Error('生成移动令牌失败: ' + err.message));
					return;
				}
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
			logger('info', 'Steam 登录成功,正在获取 WebSession');
			try {
				client.webLogOn();
			} catch (err) {
				finish(new Error('获取 WebSession 失败: ' + err.message));
			}
		});

		client.on('webSession', (sessionID, cookies) => {
			finish(null, {client, cookies: Array.isArray(cookies) ? cookies : []});
		});

		client.on('error', err => {
			if (!settled) {
				finish(new Error(err && err.message ? err.message : 'Steam 登录失败'));
			} else {
				logger('debug', 'Steam 客户端事件: ' + (err && err.message ? err.message : String(err)));
			}
		});

		let details;
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
					details.twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
				} catch (_) {}
			}
		}

		logger('info', '正在连接 Steam…');
		try {
			client.logOn(details);
		} catch (err) {
			finish(new Error('登录启动失败: ' + err.message));
		}
	});
}

/**
 * 登录某账号并兑换一个充值码,完成后登出。
 * @param {object} opts
 * @param {string}   opts.accountName
 * @param {string}   [opts.password]        密码(与 refreshToken 二选一)
 * @param {string}   [opts.refreshToken]    刷新令牌(无密码时使用)
 * @param {string}   [opts.sharedSecret]    maFile 的 shared_secret(自动 2FA)
 * @param {string}   opts.code              充值码
 * @param {string}   [opts.dataDirectory]   steam-user 数据目录
 * @param {number}   [opts.timeoutMs=60000]
 * @param {function} [opts.logger] (level, msg) => void
 * @returns {Promise<{ok:boolean, eresult:number, detail:number, formattedNewWalletBalance:string, amount:number, message:string}>}
 */
async function redeemForAccount(opts) {
	const logger = typeof opts.logger === 'function' ? opts.logger : noopLogger;
	const code = String(opts.code || '').trim();
	if (!code) {
		throw new Error('充值码为空');
	}

	const {client, cookies} = await loginForCookies(opts);
	try {
		if (!cookies.length) {
			throw new Error('未获取到 WebSession cookies');
		}
		const store = new SteamStore();
		store.setCookies(toCookieArray(cookies));

		logger('info', '正在兑换充值码…');
		let result;
		try {
			result = await store.redeemWalletCode(code);
		} catch (err) {
			throw new Error(describeRedeemError(err));
		}

		const balance = result && result.formattedNewWalletBalance ? String(result.formattedNewWalletBalance) : '';
		logger('success', '兑换成功' + (balance ? ',当前余额 ' + balance : ''));
		return {
			ok: true,
			eresult: result.eresult,
			detail: result.detail,
			formattedNewWalletBalance: balance,
			amount: result.amount,
			message: balance ? '兑换成功,余额 ' + balance : '兑换成功'
		};
	} finally {
		try { client.logOff(); } catch (_) {}
	}
}

module.exports = {redeemForAccount, loginForCookies, describeRedeemError};
