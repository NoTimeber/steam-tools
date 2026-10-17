// 账号与登录(从 app/server.js 移来):账户名单同步、账号资料、maFile 导入、令牌验证码、
// 登录(密码 / refreshToken)、Steam Guard、WebSession、登出、删除账号、连接/断开 GC,以及重启后自动恢复登录要的凭据。
// 路由在 ./routes.ts;会话管理、加密库、推送由 src/main.ts 注入,单元测试用假的。

import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {findAttemptByKey} from '../steam/attempts.ts';
import {gameConfig, normalizeGame} from '../steam/games.ts';
import {disconnectGameSession, ensureGameSession} from '../steam/gc-client.ts';
import {safeName} from '../steam/session-manager.ts';
import type {Attempt, AttemptProfile, RestoreCredentials, SessionManager} from '../steam/session-manager.ts';
import {normalizeStoredAccount} from '../store/accounts.ts';
import type {AccountStore, StoredAccount} from '../store/accounts.ts';
import type {MaFileStore} from '../store/mafiles.ts';
import type {SteamSessionStore} from '../store/steam-sessions.ts';
import {createCountryLookup} from './country.ts';
import {createPurchaseHistory} from './history.ts';
import type {PublicHistory} from './history.ts';
import {findStoredAccount, mergeClientAccountSecrets, publicAccountProfile, publicStoredAccount} from './profiles.ts';
import type {Profiles, PublicProfile, PublicStoredAccount} from './profiles.ts';

export {createProfiles, publicAccountProfile, resolveAccountCountry} from './profiles.ts';
export type {LocalProfile, Profiles} from './profiles.ts';

const require = createRequire(import.meta.url);

export function accountError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function errorText(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : '';
}

interface Totp {
	generateAuthCode(sharedSecret: string): string;
	time(offset?: number): number;
}

type Sessions = Pick<SessionManager, 'attempts' | 'list' | 'activeAttemptFor' | 'createAttempt' | 'startLogon' | 'submitGuardCode'
	| 'logout' | 'removeAccounts' | 'saveSession' | 'addLog' | 'emit' | 'publicAttempt'>;

export interface AccountServiceOptions {
	store: {accounts: AccountStore; mafiles: Pick<MaFileStore, 'put'>; sessions: Pick<SteamSessionStore, 'get' | 'remove'>};
	sessions: Sessions;
	profiles: Profiles;
	totp?: Totp;
	fetch?: typeof fetch;
	now?: () => number;
	/** 消费记录翻页之间的等待(测试里给立即返回的) */
	sleep?: (ms: number) => Promise<void>;
	logger?: Pick<Console, 'warn'>;
}

type PublicAttempt = ReturnType<Sessions['publicAttempt']>;

export function createAccountService(options: AccountServiceOptions) {
	const {store, sessions, profiles} = options;
	const totp = (): Totp => options.totp ?? require('steam-totp') as Totp;
	const now = options.now ?? Date.now;
	const logger = options.logger ?? console;
	const country = createCountryLookup({
		cookiesFor: attempt => profiles.cookiesFor(attempt),
		events: sessions,
		fetch: options.fetch,
		now
	});
	// 消费记录:在线的用内存里的会话,不在线的用上次登录存下的 cookie
	const history = createPurchaseHistory({
		findAttempt: accountName => findAttemptByKey(sessions.attempts, accountName),
		cookiesFor: attempt => profiles.cookiesFor(attempt),
		currencyOf: accountName => profiles.local(accountName).currencyISO,
		fetch: options.fetch,
		sleep: options.sleep,
		now
	});

	function attemptById(id: unknown): Attempt {
		const attempt = sessions.attempts.get(String(id));
		if (!attempt) {
			throw accountError(404, '任务不存在');
		}
		return attempt;
	}

	/** 建会话时带上的本地资料(maFile 的令牌密钥、缓存的钱包信息) */
	function attemptProfile(accountName: string, remember: boolean, sharedSecret: string, identitySecret: string): AttemptProfile {
		const local = profiles.local(accountName);
		return {
			accountName,
			remember,
			sharedSecret,
			identitySecret,
			hasMaFile: local.hasMaFile,
			country: local.country,
			hasWallet: local.hasWallet,
			currency: local.currency,
			currencyISO: local.currencyISO,
			balance: local.balance
		};
	}

	// ===== 账户名单(多浏览器同步)=====

	/** initialized:服务端写没写过名单。前端据此决定是否把本地旧名单迁上来,免得已删的账号被旧浏览器推回来 */
	function listAccounts(): {initialized: boolean; accounts: PublicStoredAccount[]} {
		try {
			return {initialized: store.accounts.isInitialized(), accounts: store.accounts.list().map(publicStoredAccount)};
		} catch (err) {
			throw accountError(500, errorText(err) || '读取账户名单失败');
		}
	}

	/** 整表替换(前端推的是完整名单);空的密钥字段沿用服务端已存的 */
	function saveAccounts(body: {accounts?: unknown}): {accounts: PublicStoredAccount[]} {
		try {
			const list = Array.isArray(body.accounts) ? body.accounts : [];
			return {accounts: store.accounts.replaceAll(mergeClientAccountSecrets(store.accounts, list)).map(publicStoredAccount)};
		} catch (err) {
			throw accountError(500, errorText(err) || '保存账户名单失败');
		}
	}

	/**
	 * 导入(新版前端用):按账号名合并进名单,不动名单里的其它账号。已有的账号只覆盖非空的密码/shared_secret,
	 * hasMaFile 只会被置上;新账号追加到末尾。旧前端整表替换(saveAccounts),两个界面同时开着时会互相覆盖。
	 */
	function upsertAccounts(body: {accounts?: unknown}): {added: number; updated: number; accounts: PublicStoredAccount[]} {
		const incoming = (Array.isArray(body.accounts) ? body.accounts : [])
			.map(item => normalizeStoredAccount(item))
			.filter((account): account is StoredAccount => !!account);
		if (!incoming.length) {
			throw accountError(400, '没有可导入的账号');
		}
		try {
			const list = store.accounts.list();
			const byKey = new Map(list.map(account => [account.accountName.toLowerCase(), account]));
			let added = 0;
			let updated = 0;
			for (const input of incoming) {
				const existing = byKey.get(input.accountName.toLowerCase());
				if (existing) {
					existing.password = input.password || existing.password;
					existing.sharedSecret = input.sharedSecret || existing.sharedSecret;
					existing.twoFactorCode = input.twoFactorCode || existing.twoFactorCode;
					existing.hasMaFile = existing.hasMaFile || input.hasMaFile;
					existing.source = input.source || existing.source;
					updated++;
				} else {
					const account = {...input, id: input.id || randomUUID()};
					list.push(account);
					byKey.set(account.accountName.toLowerCase(), account);
					added++;
				}
			}
			return {added, updated, accounts: store.accounts.replaceAll(list).map(publicStoredAccount)};
		} catch (err) {
			throw accountError(500, errorText(err) || '导入账户失败');
		}
	}

	/** 账户列表要的资料;从缓存/币种推断不出国家的(如美元钱包)查商店账户页补全 */
	async function meta(body: {accountNames?: unknown}): Promise<{accounts: Record<string, PublicProfile>}> {
		const accounts: Record<string, PublicProfile> = {};
		for (const raw of Array.isArray(body.accountNames) ? body.accountNames : []) {
			const accountName = String(raw || '').trim();
			if (accountName) {
				accounts[accountName] = publicAccountProfile(profiles.local(accountName));
			}
		}
		try {
			await country.fillMissing(accounts);
		} catch {
			// 补不全就留空
		}
		return {accounts};
	}

	// ===== maFile / 令牌 =====

	/** maFile 整份(含 identity_secret)加密存进数据库;发货、求购确认时从这里取 identity_secret */
	function importMaFiles(body: {mafiles?: unknown; mafile?: unknown}) {
		const list: unknown[] = Array.isArray(body.mafiles) ? body.mafiles : (body.mafile ? [body.mafile] : []);
		if (!list.length) {
			throw accountError(400, '没有可导入的 maFile');
		}
		const results = [];
		let saved = 0;
		for (const entry of list) {
			const maFile = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
			const accountName = maFile ? String(maFile.account_name || maFile.accountName || '').trim() : '';
			if (!maFile || !accountName) {
				results.push({accountName: accountName || '', ok: false, error: '缺少 account_name'});
				continue;
			}
			if (!/^[A-Za-z0-9_.-]+$/u.test(accountName)) {
				results.push({accountName, ok: false, error: '账号名包含非法字符,无法保存'});
				continue;
			}
			try {
				store.mafiles.put(accountName, maFile);
				saved++;
				results.push({
					accountName,
					ok: true,
					hasSharedSecret: !!String(maFile.shared_secret || maFile.sharedSecret || '').trim(),
					hasIdentitySecret: !!String(maFile.identity_secret || maFile.identitySecret || '').trim(),
					profile: publicAccountProfile(profiles.local(accountName))
				});
			} catch (err) {
				results.push({accountName, ok: false, error: errorText(err) || '写入失败'});
			}
		}
		return {saved, results};
	}

	/** 当前的手机令牌验证码(maFile 或名单里的 shared_secret) */
	function authCode(body: {accountName?: unknown; sharedSecret?: unknown}) {
		const accountName = String(body.accountName || '').trim();
		const sharedSecret = String(body.sharedSecret || profiles.local(accountName).sharedSecret || findStoredAccount(store.accounts, accountName)?.sharedSecret || '').trim();
		if (!sharedSecret) {
			throw accountError(409, '当前账号没有可用的 shared_secret');
		}
		try {
			const code = totp().generateAuthCode(sharedSecret);
			const expiresIn = 30 - (totp().time() % 30) || 30;
			return {accountName, code, expiresIn, expiresAt: new Date(now() + expiresIn * 1000).toISOString()};
		} catch (err) {
			throw accountError(500, errorText(err) || '生成验证码失败');
		}
	}

	// ===== 登录 / 会话控制 =====

	/**
	 * 密码登录。浏览器不持有密码/shared_secret,没传就用名单里存的。
	 * 同一账号已在登录中或在线时直接返回现有会话(force=true 强制重登),不新建客户端互相顶号。
	 */
	function login(body: Record<string, unknown>): {attempt: PublicAttempt; reused?: true} {
		const accountName = String(body.accountName || '').trim();
		const stored = findStoredAccount(store.accounts, accountName);
		const password = String(body.password || stored?.password || '');
		const local = profiles.local(accountName);
		const sharedSecret = String(body.sharedSecret || local.sharedSecret || stored?.sharedSecret || '').trim();
		const identitySecret = String(body.identitySecret || local.identitySecret || '').trim();
		let twoFactorCode = String(body.twoFactorCode || '').trim();
		// 没传 remember 按名单里的设置(默认记住):记住才保存 refreshToken,重启后才能免密恢复
		const remember = body.remember !== undefined ? !!body.remember : !(stored && stored.remember === false);

		if (!accountName || !password) {
			throw accountError(400, '账号和密码不能为空');
		}
		const existing = body.force ? null : sessions.activeAttemptFor(accountName);
		if (existing) {
			return {attempt: sessions.publicAttempt(existing), reused: true};
		}

		// 新建会话时会先拆掉该账号的旧会话(已登出/掉线/失败的)
		const attempt = sessions.createAttempt(attemptProfile(accountName, remember, sharedSecret, identitySecret));
		if (!body.sharedSecret && local.sharedSecret) {
			sessions.addLog(attempt, 'info', '已从本地 maFile 载入 shared_secret');
		}
		if (!body.identitySecret && local.identitySecret) {
			sessions.addLog(attempt, 'info', '已从本地 maFile 载入 identity_secret（用于发货确认）');
		}
		if (!twoFactorCode && sharedSecret) {
			try {
				twoFactorCode = totp().generateAuthCode(sharedSecret);
				sessions.addLog(attempt, 'info', '已使用 shared_secret 生成移动令牌验证码');
			} catch (err) {
				sessions.addLog(attempt, 'warn', 'shared_secret 无法生成验证码: ' + errorText(err));
			}
		}
		sessions.startLogon(attempt, {accountName, password, twoFactorCode: twoFactorCode || undefined});
		return {attempt: sessions.publicAttempt(attempt)};
	}

	function loginWithRefreshToken(body: Record<string, unknown>): {attempt: PublicAttempt} {
		const refreshToken = String(body.refreshToken || '').trim();
		const accountName = String(body.accountName || '').trim();
		if (!refreshToken) {
			throw accountError(400, 'refreshToken 不能为空');
		}
		const local = profiles.local(accountName);
		const attempt = sessions.createAttempt(attemptProfile(accountName, !!body.remember, local.sharedSecret, local.identitySecret));
		sessions.startLogon(attempt, {refreshToken});
		return {attempt: sessions.publicAttempt(attempt)};
	}

	function submitGuard(id: unknown, body: {code?: unknown}): {attempt: PublicAttempt} {
		const attempt = attemptById(id);
		const code = String(body.code || '').trim();
		if (!code) {
			throw accountError(400, '验证码不能为空');
		}
		if (!attempt.guardCallback) {
			throw accountError(409, '当前任务不需要 Steam Guard 验证码');
		}
		sessions.submitGuardCode(attempt, code);
		return {attempt: sessions.publicAttempt(attempt)};
	}

	/** 手动重新获取 WebSession cookies */
	function requestWebSession(id: unknown): {attempt: PublicAttempt} {
		const attempt = attemptById(id);
		if (!attempt.client || !attempt.client.steamID) {
			throw accountError(409, 'Steam 尚未登录');
		}
		try {
			attempt.status = 'web_session_pending';
			sessions.addLog(attempt, 'info', '正在获取 WebSession cookies');
			attempt.client.webLogOn();
			sessions.emit(attempt);
			return {attempt: sessions.publicAttempt(attempt)};
		} catch (err) {
			sessions.addLog(attempt, 'error', '获取 WebSession 失败: ' + errorText(err));
			sessions.emit(attempt);
			throw accountError(500, errorText(err));
		}
	}

	/** 手动登出:取消待执行的登录重试,清掉「重启后自动恢复」的意图 */
	function logout(id: unknown): {attempt: PublicAttempt} {
		const attempt = attemptById(id);
		sessions.logout(attempt);
		return {attempt: sessions.publicAttempt(attempt)};
	}

	/**
	 * 前端删除账户时调用:登出并移出会话表、清掉登录意图,删除加密库里保存的 session,
	 * 再从名单里移除(前端防抖推送没来得及发出时名单也一致)。
	 */
	function cleanup(body: {accounts?: unknown}) {
		const names: string[] = [];
		const ids: string[] = [];
		for (const item of Array.isArray(body.accounts) ? body.accounts : []) {
			const accountName = item && item.accountName ? String(item.accountName).trim() : '';
			const attemptId = item && item.attemptId ? String(item.attemptId).trim() : '';
			if (accountName) {
				names.push(accountName);
			}
			if (attemptId) {
				ids.push(attemptId);
			}
		}
		// session 按 accountName / steamID / id 任一作 key 保存过,一并删掉
		const {removedAttempts, sessionKeys} = sessions.removeAccounts(names, ids);
		let removedFiles = 0;
		try {
			removedFiles = store.sessions.remove(sessionKeys);
		} catch (err) {
			logger.warn('[cleanup] 删除 session 失败', errorText(err));
		}
		let removedFromList = false;
		try {
			removedFromList = store.accounts.removeByNames(names);
		} catch (err) {
			logger.warn('[cleanup] 更新账户名单失败', errorText(err));
		}
		return {removedAttempts, removedFiles, removedFromList};
	}

	function connectGc(id: unknown, game: unknown): {attempt: PublicAttempt} {
		const attempt = attemptById(id);
		const config = gameConfig(normalizeGame(game));
		if (!attempt.client || !attempt.client.steamID || attempt.status === 'logged_out') {
			throw accountError(409, '当前账号尚未登录 Steam');
		}
		try {
			ensureGameSession(attempt, config.id);
			try {
				attempt.client.webLogOn();
			} catch {
				// 只是顺便刷新 cookie
			}
			sessions.addLog(attempt, 'info', `已请求连接 ${config.label} GC`);
			sessions.emit(attempt);
			return {attempt: sessions.publicAttempt(attempt)};
		} catch (err) {
			throw accountError(500, errorText(err) || '连接 GC 失败');
		}
	}

	function disconnectGc(id: unknown, game: unknown): {attempt: PublicAttempt} {
		const attempt = attemptById(id);
		const config = gameConfig(normalizeGame(game));
		if (!attempt.client || attempt.status === 'logged_out') {
			throw accountError(409, '当前账号尚未登录 Steam');
		}
		try {
			disconnectGameSession(attempt, config.id);
			sessions.addLog(attempt, 'info', `已请求断开 ${config.label} GC`);
			sessions.emit(attempt);
			return {attempt: sessions.publicAttempt(attempt)};
		} catch (err) {
			throw accountError(500, errorText(err) || '断开 GC 失败');
		}
	}

	/** 调试端点:会话的 cookies */
	function cookies(id: unknown): {cookies: string[]; cookieHeader: string} {
		const attempt = attemptById(id);
		if (!attempt.cookies || !attempt.cookies.length) {
			throw accountError(404, '当前任务没有 cookies');
		}
		return {cookies: attempt.cookies, cookieHeader: attempt.cookies.join('; ')};
	}

	function listAttempts(): PublicAttempt[] {
		return sessions.list().map(attempt => sessions.publicAttempt(attempt));
	}

	// ===== 消费记录 =====

	function historyAccount(raw: unknown): string {
		const name = String(raw || '').trim();
		if (!name) {
			throw accountError(400, '缺少账号名');
		}
		const stored = findStoredAccount(store.accounts, name);
		if (!stored) {
			throw accountError(404, '账号不在账户名单里');
		}
		return stored.accountName;
	}

	/** 开始读(后台翻页);读过的直接返回上次的结果,force 重读 */
	function loadHistory(body: {accountName?: unknown; force?: unknown}): PublicHistory {
		const accountName = historyAccount(body.accountName);
		try {
			return history.load(accountName, !!body.force);
		} catch (err) {
			throw accountError(409, errorText(err) || '读取消费记录失败');
		}
	}

	/** 读取进度或结果;没读过为 null */
	function getHistory(accountName: unknown): PublicHistory | null {
		return history.get(historyAccount(accountName));
	}

	/**
	 * 重启后自动恢复登录要的凭据:优先用保存的 refreshToken,失效再用名单里的密码 + maFile 令牌。
	 * 账号已从名单删除返回 null。
	 */
	function restoreCredentials(accountName: string): RestoreCredentials | null {
		const stored = findStoredAccount(store.accounts, accountName);
		if (!stored) {
			return null;
		}
		const local = profiles.local(stored.accountName);
		const saved = store.sessions.get(safeName(stored.accountName));
		return {
			profile: {
				accountName: stored.accountName,
				remember: stored.remember !== false,
				sharedSecret: local.sharedSecret || stored.sharedSecret || '',
				identitySecret: local.identitySecret || '',
				hasMaFile: local.hasMaFile,
				country: local.country || stored.country || '',
				hasWallet: local.hasWallet || stored.hasWallet,
				currency: local.currency != null ? local.currency : stored.currency,
				currencyISO: local.currencyISO || '',
				balance: local.balance != null ? local.balance : stored.balance
			},
			refreshToken: saved && saved.refreshToken ? String(saved.refreshToken) : '',
			password: stored.password || ''
		};
	}

	return {
		listAccounts, saveAccounts, upsertAccounts, meta, importMaFiles, authCode,
		login, loginWithRefreshToken, submitGuard, requestWebSession, logout, cleanup, connectGc, disconnectGc, cookies, listAttempts,
		loadHistory, getHistory, restoreCredentials,
		/** 拿到 WebSession 后后台刷新真实账户国家 */
		refreshCountry: country.refresh,
		findStoredAccount: (accountName: unknown) => findStoredAccount(store.accounts, accountName)
	};
}

export type AccountService = ReturnType<typeof createAccountService>;
