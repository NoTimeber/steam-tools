// 账号资料汇总(从 app/server.js 移来):登录、发货、兑换等要的 shared_secret / identity_secret / refreshToken / 钱包信息,
// 以及走 cookie 流程(买游戏、求购、库存……)时用哪份 WebSession cookie。
//
// 来源:
//   - maFile(加密库):shared_secret、identity_secret、SteamID、Session.RefreshToken;
//   - 会话库(加密库):登录后保存的 cookies;
//   - 旧版遗留文件(只读):data/config/cookies/<账号>.json(refreshToken / cookies / cookieHeader)、
//     data/config/account_cache.json(钱包币种、余额、国家)。
// 账户名单(加密库)里存的密码/shared_secret 只在服务端用,下发给浏览器前要去掉(publicStoredAccount)。

import {join} from 'node:path';
import {CURRENCY_ISO_TO_COUNTRY, currencyIdToIso, normalizeCountryCode} from '../steam/currencies.ts';
import {safeName} from '../steam/session-manager.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {normalizeStoredAccount} from '../store/accounts.ts';
import type {AccountStore, StoredAccount} from '../store/accounts.ts';
import type {MaFileStore} from '../store/mafiles.ts';
import type {SteamSessionStore} from '../store/steam-sessions.ts';

export interface LocalProfile {
	accountName: string;
	hasMaFile: boolean;
	sharedSecret: string;
	identitySecret: string;
	refreshToken: string;
	country: string;
	hasWallet: boolean;
	currency: number | null;
	currencyISO: string;
	balance: number | null;
	steamID?: string;
}

/** 下发给浏览器的账号资料:不含任何密钥,只给「有没有」 */
export interface PublicProfile {
	accountName: string;
	steamId: string;
	hasMaFile: boolean;
	hasIdentitySecret: boolean;
	country: string;
	hasWallet: boolean;
	currency: number | null;
	currencyISO: string;
	balance: number | null;
}

export type PublicStoredAccount = Omit<StoredAccount, 'password' | 'sharedSecret' | 'twoFactorCode'> & {hasPassword: boolean; hasSharedSecret: boolean};

/** 钱包币种能对应到国家就用它;没有币种时才用缓存里的国家 */
export function resolveAccountCountry(details: {country?: unknown; currency?: unknown; currencyISO?: unknown} | null | undefined): string {
	const currencyISO = String((details && details.currencyISO) || currencyIdToIso(details && details.currency) || '').trim().toUpperCase();
	if (currencyISO && CURRENCY_ISO_TO_COUNTRY[currencyISO]) {
		return CURRENCY_ISO_TO_COUNTRY[currencyISO];
	}
	if (!currencyISO && details) {
		return normalizeCountryCode(details.country);
	}
	return '';
}

export function publicAccountProfile(profile: LocalProfile & {steamId?: string}): PublicProfile {
	return {
		accountName: profile.accountName,
		steamId: profile.steamID || profile.steamId || '',
		hasMaFile: !!profile.hasMaFile,
		hasIdentitySecret: !!profile.identitySecret,
		country: profile.country || '',
		hasWallet: !!profile.hasWallet,
		currency: profile.currency == null ? null : Number(profile.currency),
		currencyISO: profile.currencyISO || '',
		balance: profile.balance == null ? null : Number(profile.balance)
	};
}

export function publicStoredAccount(account: StoredAccount): PublicStoredAccount {
	const {password, sharedSecret, twoFactorCode, ...rest} = account;
	return {...rest, hasPassword: !!password, hasSharedSecret: !!sharedSecret};
}

/** 名单里按账号名(不区分大小写)找 */
export function findStoredAccount(accounts: Pick<AccountStore, 'list'>, accountName: unknown): StoredAccount | null {
	const key = String(accountName || '').trim().toLowerCase();
	if (!key) {
		return null;
	}
	return accounts.list().find(account => account.accountName.toLowerCase() === key) ?? null;
}

/** 浏览器推回来的名单里密码/shared_secret/验证码通常是空的(服务端从不下发):空值沿用已存的,非空才覆盖 */
export function mergeClientAccountSecrets(accounts: Pick<AccountStore, 'list'>, list: unknown): StoredAccount[] {
	const stored = new Map(accounts.list().map(account => [account.accountName.toLowerCase(), account]));
	const merged: StoredAccount[] = [];
	for (const item of Array.isArray(list) ? list : []) {
		const account = normalizeStoredAccount(item);
		if (!account) {
			continue;
		}
		const previous = stored.get(account.accountName.toLowerCase());
		if (previous) {
			account.password ||= previous.password;
			account.sharedSecret ||= previous.sharedSecret;
			account.twoFactorCode ||= previous.twoFactorCode;
		}
		merged.push(account);
	}
	return merged;
}

/** account_cache.json 按账号名找(先精确,再不区分大小写) */
function findCachedAccount(cache: unknown, accountName: string): Record<string, unknown> | null {
	if (!cache || typeof cache !== 'object') {
		return null;
	}
	const map = cache as Record<string, unknown>;
	if (map[accountName]) {
		return map[accountName] as Record<string, unknown>;
	}
	const lowered = accountName.toLowerCase();
	for (const key of Object.keys(map)) {
		if (key.toLowerCase() === lowered) {
			return map[key] as Record<string, unknown>;
		}
	}
	return null;
}

export interface ProfileOptions {
	mafiles: Pick<MaFileStore, 'get'>;
	sessions: Pick<SteamSessionStore, 'get'>;
	/** 旧版 data/config/cookies/ */
	cookiesDir: string;
	/** 旧版 data/config/account_cache.json */
	accountCacheFile: string;
	readJson(file: string): unknown;
}

export function createProfiles(options: ProfileOptions) {
	const readObject = (file: string): Record<string, any> | null => {
		const value = options.readJson(file);
		return value && typeof value === 'object' ? value as Record<string, any> : null;
	};

	function local(accountName: unknown): LocalProfile {
		const name = String(accountName || '').trim();
		const profile: LocalProfile = {
			accountName: name,
			hasMaFile: false,
			sharedSecret: '',
			identitySecret: '',
			refreshToken: '',
			country: '',
			hasWallet: false,
			currency: null,
			currencyISO: '',
			balance: null
		};
		if (!name) {
			return profile;
		}

		const maFile = options.mafiles.get(name) as Record<string, any> | null;
		if (maFile && typeof maFile === 'object') {
			profile.hasMaFile = true;
			profile.sharedSecret = String(maFile.shared_secret || maFile.sharedSecret || '').trim();
			profile.identitySecret = String(maFile.identity_secret || maFile.identitySecret || '').trim();
			profile.steamID = String(maFile.SteamID || maFile.steamID || '').trim();
			const session = maFile.Session && typeof maFile.Session === 'object' ? maFile.Session : null;
			if (session && session.RefreshToken) {
				profile.refreshToken = String(session.RefreshToken).trim();
			}
		}

		const cookies = readObject(join(options.cookiesDir, name + '.json'));
		if (cookies && !profile.refreshToken && cookies.refreshToken) {
			profile.refreshToken = String(cookies.refreshToken).trim();
		}

		const cached = findCachedAccount(options.readJson(options.accountCacheFile), name);
		if (cached && typeof cached === 'object') {
			profile.currency = cached.currency == null ? null : Number(cached.currency);
			profile.currencyISO = String(cached.currencyISO || currencyIdToIso(profile.currency) || '').trim().toUpperCase();
			profile.balance = cached.balance == null ? null : Number(cached.balance);
			profile.hasWallet = profile.balance != null && Number.isFinite(profile.balance);
			profile.country = resolveAccountCountry({country: cached.country, currency: profile.currency, currencyISO: profile.currencyISO});
		}
		return profile;
	}

	/** 会话的 WebSession cookies:内存里的 → 会话库 → 旧版 cookies 文件 */
	function cookiesFor(attempt: Partial<Pick<Attempt, 'cookies' | 'accountName' | 'steamID' | 'id'>>): string[] {
		if (Array.isArray(attempt.cookies) && attempt.cookies.length) {
			return attempt.cookies;
		}
		const session = options.sessions.get(safeName(attempt.accountName || attempt.steamID || attempt.id));
		if (session && Array.isArray(session.cookies) && session.cookies.length) {
			return session.cookies as string[];
		}
		const safeFile = options.readJson(join(options.cookiesDir, safeName(attempt.accountName) + '.json'));
		const rawFile = options.readJson(join(options.cookiesDir, String(attempt.accountName || '').trim() + '.json'));
		const source = (safeFile || rawFile) as Record<string, any> | null;
		if (source) {
			if (Array.isArray(source.cookies) && source.cookies.length) {
				return source.cookies;
			}
			if (typeof source.cookieHeader === 'string' && source.cookieHeader.trim()) {
				return source.cookieHeader.split(/;\s*/).filter(Boolean);
			}
		}
		return [];
	}

	return {local, cookiesFor};
}

export type Profiles = ReturnType<typeof createProfiles>;
