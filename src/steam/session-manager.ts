// Steam 登录会话管理(从 app/server.js 移过来,登录/看门狗/重连逻辑保持原样)。
// 新增:
//   - 同一账号只保留一个会话:新建会话时先拆掉旧的(登出旧客户端、移出会话表),
//     不再出现两个客户端同时登录同一账号互相顶号;
//   - 登录意图持久化 + 重启自动恢复:登录成功记为"应在线",手动登出/删除/致命错误时清除;
//     服务启动后按意图逐个恢复(优先 refreshToken,失败再用密码)。
// Steam 客户端(steam-user)、GC 模块、推送等都由调用方注入,单元测试里用假客户端。

import type {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import type {SteamSessionStore} from '../store/steam-sessions.ts';
import type {LoginIntentStore} from '../store/login-intents.ts';
import {normalizeGame} from './games.ts';
import {normalizeCountryCode} from './currencies.ts';

export interface SteamClient extends EventEmitter {
	steamID: {getSteamID64(): string} | null;
	publicIP?: string;
	cellID?: number | string;
	logOn(details: Record<string, unknown>): void;
	logOff(): void;
	webLogOn(): void;
	_apiRequest?: (...args: unknown[]) => Promise<unknown>;
}

export interface Fingerprint {
	machineName: string;
	machineIdFormat: unknown;
	userAgent: string;
}

export interface LogonDetails {
	accountName?: string;
	password?: string;
	twoFactorCode?: string;
	refreshToken?: string;
	machineName?: string;
}

export interface LogEntry {
	level: string;
	time: string;
	message: string;
}

export interface GuardRequest {
	type: 'email' | 'mobile';
	domain: string;
	lastCodeWrong: boolean;
}

// 字段与旧版 attempt 对象一致:server.js 里内购/库存/UU 等大量代码直接读写这些字段。
export interface Attempt {
	id: string;
	createdAt: number;
	accountName: string;
	status: string;
	steamID: string;
	personaName: string;
	country: string;
	loginGeoCountry: string;
	hasWallet: boolean;
	currency: number | null;
	currencyISO: string;
	balance: number | null;
	publicIP: string;
	cellID: string | number;
	cookieCount: number;
	hasCookies: boolean;
	hasRefreshToken: boolean;
	refreshToken: string;
	cookies: string[];
	guard: GuardRequest | null;
	guardCallback: ((code: string) => void) | null;
	remember: boolean;
	sharedSecret: string;
	identitySecret: string;
	hasMaFile: boolean;
	gcConnected: boolean;
	cs2GcConnected: boolean;
	tf2GcConnected: boolean;
	activeGame: string;
	inventoryCount: number;
	inventoryCache: unknown;
	inventorySource: string;
	communityInvTriedAt: number;
	inventoryInflight: unknown;
	logs: LogEntry[];
	client: SteamClient | null;
	csgo: unknown;
	tf2: unknown;
	cmFallbackApplied: boolean;
	// 登录/重连过程状态
	loginDetails?: LogonDetails;
	loginRetries?: number;
	loginWatchdog?: ReturnType<typeof setTimeout> | null;
	userAgent?: string;
	webSessionID?: string;
	hadSession?: boolean;
	disconnectedSince?: number;
	reconnectBlocked?: boolean;
	reconnectAttempts?: number;
	nextReconnectAt?: number;
	reconnectGaveUp?: boolean;
	/** 用 refreshToken 自动恢复失败时改用的密码登录参数 */
	restoreFallback?: LogonDetails | null;
	/** 已被新会话替换或随账号删除:不再推送、不再重连 */
	disposed?: boolean;
	[extra: string]: unknown;
}

export interface AttemptProfile {
	accountName: string;
	remember?: boolean;
	sharedSecret?: string;
	identitySecret?: string;
	hasMaFile?: boolean;
	country?: string;
	hasWallet?: boolean;
	currency?: number | null;
	currencyISO?: string;
	balance?: number | null;
}

export interface RestoreCredentials {
	profile: AttemptProfile;
	refreshToken: string;
	password: string;
}

export interface SessionManagerTiming {
	loginTimeoutMs: number;
	loginRetryMax: number;
	retryDelayMs: number;
	reconnectIntervalMs: number;
	reconnectGraceMs: number;
	reconnectMaxAttempts: number;
	reconnectBackoffBaseMs: number;
	reconnectBackoffCapMs: number;
	restoreIntervalMs: number;
}

export interface SessionManagerOptions {
	createClient(fingerprint: Fingerprint): SteamClient;
	getFingerprint(accountName: string): Fingerprint;
	generateAuthCode(sharedSecret: string): string;
	/** 视为"不要自动重连"的 EResult(被顶号、封禁、密码错误等) */
	fatalEResults: ReadonlySet<number>;
	/** Steam 目录服务不可达时改用的 CM 列表 */
	cmFallbackServers: unknown[];
	sessions: SteamSessionStore;
	intents: LoginIntentStore;
	onChange(attempt: Attempt): void;
	/** 客户端建好、logOn 之前调用:挂 CS2/TF2 GC 模块等 */
	onClientCreated?(attempt: Attempt, client: SteamClient): void;
	/** 拿到 WebSession 之后调用 */
	onWebSession?(attempt: Attempt): void;
	currencyIdToIso(currency: unknown): string;
	/** 钱包事件后推断账号国家;返回空串表示不改 */
	resolveWalletCountry(attempt: Attempt): string;
	timing?: Partial<SessionManagerTiming>;
	logger?: Pick<Console, 'log' | 'warn'>;
}

const DEFAULT_TIMING: SessionManagerTiming = {
	loginTimeoutMs: 45000,
	loginRetryMax: 2,
	retryDelayMs: 1500,
	reconnectIntervalMs: 30000,
	reconnectGraceMs: 90000,
	reconnectMaxAttempts: 6,
	reconnectBackoffBaseMs: 60000,
	reconnectBackoffCapMs: 10 * 60000,
	restoreIntervalMs: 3000
};

// 仍在登录中或在线的状态:同一账号处于这些状态时,再次登录直接复用,不新建客户端
const ACTIVE_STATUSES = new Set(['created', 'connecting', 'guard_required', 'logged_on', 'web_session_pending', 'web_session']);
const LOG_LIMIT = 300;
const PUBLIC_LOG_LIMIT = 30;

export function safeName(value: unknown): string {
	return String(value || 'session')
		.replace(/[^a-z0-9_.-]+/gi, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 80) || 'session';
}

function sameAccount(left: string, right: string): boolean {
	return !!left && !!right && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function errorMessage(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err ?? '');
}

export function createSessionManager(options: SessionManagerOptions) {
	const timing: SessionManagerTiming = {...DEFAULT_TIMING, ...options.timing};
	const logger = options.logger ?? console;
	const attempts = new Map<string, Attempt>();
	const restoreTimers = new Set<ReturnType<typeof setTimeout>>();
	let reconnectTimer: ReturnType<typeof setInterval> | null = null;

	// ===== 日志与推送 =====

	function addLog(attempt: Attempt, level: string, message: string): void {
		attempt.logs.push({level, time: new Date().toLocaleTimeString('zh-CN', {hour12: false}), message});
		if (attempt.logs.length > LOG_LIMIT) {
			attempt.logs.shift();
		}
	}

	function emit(attempt: Attempt): void {
		if (!attempt.disposed) {
			options.onChange(attempt);
		}
	}

	function publicAttempt(attempt: Attempt) {
		return {
			id: attempt.id,
			accountName: attempt.accountName,
			status: attempt.status,
			hasMaFile: !!attempt.hasMaFile,
			hasIdentitySecret: !!attempt.identitySecret,
			steamID: attempt.steamID,
			personaName: attempt.personaName,
			country: attempt.country,
			loginGeoCountry: attempt.loginGeoCountry,
			hasWallet: attempt.hasWallet,
			currency: attempt.currency,
			currencyISO: attempt.currencyISO,
			balance: attempt.balance,
			publicIP: attempt.publicIP,
			cellID: attempt.cellID,
			cookieCount: attempt.cookieCount,
			hasCookies: attempt.hasCookies,
			hasRefreshToken: attempt.hasRefreshToken,
			gcConnected: !!attempt.gcConnected,
			cs2GcConnected: !!attempt.cs2GcConnected,
			tf2GcConnected: !!attempt.tf2GcConnected,
			activeGame: normalizeGame(attempt.activeGame),
			inventoryCount: Number(attempt.inventoryCount || 0),
			inventorySource: attempt.inventorySource || '',
			guard: attempt.guard,
			// 前端只用日志找最近一条错误;debug 行(steam-user 很啰嗦)不推送,只带最近几十条
			logs: attempt.logs.filter(entry => entry.level !== 'debug').slice(-PUBLIC_LOG_LIMIT)
		};
	}

	function shouldIgnoreDebugMessage(message: string): boolean {
		return /^Error reading file machineAuthToken\..+ENOENT:/i.test(message);
	}

	function formatSteamError(attempt: Attempt, err: unknown): string {
		const message = errorMessage(err) || '未知错误';
		if (attempt.cmFallbackApplied && /timed out|ECONNREFUSED|socket hang up|connect/i.test(message)) {
			return '连接 Steam CM 失败，请检查当前网络是否允许访问 cm0.steampowered.com:443';
		}
		if (/GetCMListForConnect|Request timed out/i.test(message)) {
			return '无法连接 Steam 目录服务，请检查当前网络或代理设置';
		}
		return message;
	}

	// ===== 会话表 =====

	function get(id: string): Attempt | undefined {
		return attempts.get(id);
	}

	function list(): Attempt[] {
		return Array.from(attempts.values()).sort((left, right) => left.createdAt - right.createdAt);
	}

	/** 该账号正在登录或在线的会话(没有返回 null) */
	function activeAttemptFor(accountName: string): Attempt | null {
		for (const attempt of attempts.values()) {
			if (sameAccount(attempt.accountName, accountName) && ACTIVE_STATUSES.has(attempt.status)) {
				return attempt;
			}
		}
		return null;
	}

	// 拆掉一个会话:停看门狗、登出客户端、移出会话表。之后它的事件不再推送。
	function dispose(attempt: Attempt, reason: string): void {
		clearLoginWatchdog(attempt);
		attempt.disposed = true;
		attempt.guardCallback = null;
		addLog(attempt, 'info', reason);
		if (attempt.client) {
			try {
				attempt.client.logOff();
			} catch {
				// 已断开的客户端 logOff 可能抛错,忽略
			}
		}
		attempts.delete(attempt.id);
	}

	function createAttempt(profile: AttemptProfile): Attempt {
		const accountName = profile.accountName || '';
		// 同一账号只保留一个会话
		for (const old of Array.from(attempts.values())) {
			if (sameAccount(old.accountName, accountName)) {
				dispose(old, '已被同账号的新登录替换');
			}
		}
		const attempt: Attempt = {
			id: Date.now().toString(36) + '-' + randomBytes(3).toString('hex'),
			createdAt: Date.now(),
			accountName,
			status: 'created',
			steamID: '',
			personaName: '',
			country: profile.country || '',
			loginGeoCountry: '',
			hasWallet: !!profile.hasWallet,
			currency: profile.currency == null ? null : Number(profile.currency),
			currencyISO: String(profile.currencyISO || '').trim().toUpperCase(),
			balance: profile.balance == null ? null : Number(profile.balance),
			publicIP: '',
			cellID: '',
			cookieCount: 0,
			hasCookies: false,
			hasRefreshToken: false,
			refreshToken: '',
			cookies: [],
			guard: null,
			guardCallback: null,
			remember: !!profile.remember,
			sharedSecret: profile.sharedSecret || '',
			identitySecret: profile.identitySecret || '',
			hasMaFile: !!profile.hasMaFile,
			gcConnected: false,
			cs2GcConnected: false,
			tf2GcConnected: false,
			activeGame: 'cs2',
			inventoryCount: 0,
			inventoryCache: null,
			inventorySource: '',
			communityInvTriedAt: 0,   // 上次社区库存拉取【失败】时间戳(0=无失败);用于失败后短暂冷却
			inventoryInflight: null,  // 进行中的社区库存拉取 Promise,用于并发去重
			logs: [],
			client: null,
			csgo: null,
			tf2: null,
			cmFallbackApplied: false
		};
		attempts.set(attempt.id, attempt);
		addLog(attempt, 'info', '已创建登录任务');
		return attempt;
	}

	// ===== 登录 =====

	function getFingerprintSafe(accountName: string): Fingerprint {
		try {
			return options.getFingerprint(accountName);
		} catch {
			return {machineName: '', machineIdFormat: null, userAgent: ''};
		}
	}

	// 把伪装机器名拼进 logOn 详情(machineName 会显示在 Steam 社区游戏列表里)。
	function buildLogOnDetails(details: LogonDetails, fingerprint: Fingerprint): Record<string, unknown> {
		const merged: Record<string, unknown> = {...details};
		if (fingerprint && fingerprint.machineName) {
			merged.machineName = fingerprint.machineName;
		}
		return merged;
	}

	/** 密码登录参数;有 shared_secret 时预先生成移动令牌验证码 */
	function passwordLogonDetails(accountName: string, password: string, sharedSecret: string): LogonDetails {
		const details: LogonDetails = {accountName, password};
		if (sharedSecret) {
			try {
				details.twoFactorCode = options.generateAuthCode(sharedSecret);
			} catch {
				// 生成失败就交给 steamGuard 事件处理
			}
		}
		return details;
	}

	function withCmFallback(attempt: Attempt, client: SteamClient): void {
		if (typeof client._apiRequest !== 'function') {
			return;
		}
		const originalApiRequest = client._apiRequest.bind(client);
		client._apiRequest = async function patchedApiRequest(...args: unknown[]) {
			try {
				return await originalApiRequest(...args);
			} catch (err) {
				const [, iface, method] = args;
				if (iface === 'ISteamDirectory' && method === 'GetCMListForConnect') {
					if (!attempt.cmFallbackApplied) {
						attempt.cmFallbackApplied = true;
						addLog(attempt, 'warn', 'Steam 目录服务不可达，改用本地 WebSocket CM');
						emit(attempt);
					}
					return {response: {serverlist: options.cmFallbackServers}};
				}
				throw err;
			}
		};
	}

	function startLogon(attempt: Attempt, details: LogonDetails): void {
		attempt.loginDetails = details;            // 记下凭据,供超时重试复用
		if (attempt.loginRetries == null) {
			attempt.loginRetries = 0;
		}
		const fingerprint = getFingerprintSafe(attempt.accountName);
		attempt.userAgent = fingerprint.userAgent || '';    // 供自有 web 请求(取库存等)复用同一 UA

		const client = options.createClient(fingerprint);
		withCmFallback(attempt, client);
		attempt.client = client;
		attempt.status = 'connecting';
		attachSteamEvents(attempt, client);
		options.onClientCreated?.(attempt, client);
		addLog(attempt, 'info', '正在连接 Steam');
		emit(attempt);

		armLoginWatchdog(attempt);
		try {
			client.logOn(buildLogOnDetails(details, fingerprint));
		} catch (err) {
			clearLoginWatchdog(attempt);
			attempt.status = 'failed';
			addLog(attempt, 'error', '登录启动失败: ' + errorMessage(err));
			emit(attempt);
		}
	}

	// 登录看门狗:启动后若在超时内没拿到 WebSession(也没在等验证码),判定卡住并重试。
	function armLoginWatchdog(attempt: Attempt): void {
		clearLoginWatchdog(attempt);
		attempt.loginWatchdog = setTimeout(() => {
			attempt.loginWatchdog = null;
			// 已完成 / 已登出 / 正在等验证码 —— 都不算"卡住",不重试。
			if (attempt.disposed || attempt.status === 'web_session' || attempt.status === 'logged_out' || attempt.guardCallback) {
				return;
			}
			if ((attempt.loginRetries ?? 0) < timing.loginRetryMax) {
				attempt.loginRetries = (attempt.loginRetries ?? 0) + 1;
				addLog(attempt, 'warn', `登录超时(${Math.round(timing.loginTimeoutMs / 1000)}s),正在第 ${attempt.loginRetries}/${timing.loginRetryMax} 次重试`);
				emit(attempt);
				retryLogon(attempt);
			} else {
				attempt.status = 'failed';
				addLog(attempt, 'error', `登录重试 ${timing.loginRetryMax} 次仍未成功,已停止`);
				emit(attempt);
			}
		}, timing.loginTimeoutMs);
	}

	function clearLoginWatchdog(attempt: Attempt): void {
		if (attempt && attempt.loginWatchdog) {
			clearTimeout(attempt.loginWatchdog);
			attempt.loginWatchdog = null;
		}
	}

	// 复用同一个 client 重新 logOn(避免重建客户端/重复挂事件)。一次性验证码会过期,重试时去掉,
	// 由 sharedSecret 自动重生成;若无 sharedSecret 则会再次进入"需要验证码"等待用户输入。
	function retryLogon(attempt: Attempt): void {
		const details = attempt.loginDetails;
		if (!details || !attempt.client) {
			attempt.status = 'failed';
			emit(attempt);
			return;
		}
		try {
			attempt.client.logOff();
		} catch {
			// 忽略
		}
		attempt.status = 'connecting';
		emit(attempt);
		setTimeout(() => {
			if (!attempt.client || attempt.disposed || attempt.status === 'logged_out') {
				return;   // 期间被手动登出/删除/替换
			}
			const fingerprint = getFingerprintSafe(attempt.accountName);
			const retryDetails: LogonDetails = {...details};
			delete retryDetails.twoFactorCode;   // 一次性验证码已过期,丢弃
			armLoginWatchdog(attempt);
			try {
				attempt.client.logOn(buildLogOnDetails(retryDetails, fingerprint));
			} catch (err) {
				clearLoginWatchdog(attempt);
				attempt.status = 'failed';
				addLog(attempt, 'error', '重试登录启动失败: ' + errorMessage(err));
				emit(attempt);
			}
		}, timing.retryDelayMs);
	}

	function submitGuardCode(attempt: Attempt, code: string): void {
		const callback = attempt.guardCallback;
		if (!callback) {
			return;
		}
		attempt.guardCallback = null;
		attempt.guard = null;
		attempt.status = 'connecting';
		addLog(attempt, 'info', '已提交 Steam Guard 验证码');
		emit(attempt);
		armLoginWatchdog(attempt);   // 提交验证码后重新计时,防止之后又卡住
		callback(code);
	}

	function logout(attempt: Attempt): void {
		clearLoginWatchdog(attempt);   // 手动登出:取消待执行的登录重试
		if (attempt.client) {
			try {
				attempt.client.logOff();
			} catch (err) {
				addLog(attempt, 'warn', '退出 Steam 时出错: ' + errorMessage(err));
			}
		}
		attempt.status = 'logged_out';
		attempt.gcConnected = false;
		attempt.cs2GcConnected = false;
		attempt.tf2GcConnected = false;
		attempt.inventoryCount = 0;
		attempt.inventorySource = '';
		attempt.inventoryCache = null;
		attempt.communityInvTriedAt = 0;
		attempt.inventoryInflight = null;
		addLog(attempt, 'info', '已请求退出 Steam');
		options.intents.setOnline(attempt.accountName, false);
		emit(attempt);
	}

	/**
	 * 删除账号时清理会话:登出并移出会话表,清掉登录意图。
	 * 返回要一并删除的已存 session key(按 accountName / steamID / id 任一保存过)。
	 */
	function removeAccounts(accountNames: readonly string[], attemptIds: readonly string[]): {removedAttempts: number; sessionKeys: string[]} {
		const names = new Set(accountNames.map(name => String(name || '').trim().toLowerCase()).filter(Boolean));
		const ids = new Set(attemptIds.map(id => String(id || '').trim()).filter(Boolean));
		const sessionKeys = new Set<string>();
		for (const name of accountNames) {
			if (String(name || '').trim()) {
				sessionKeys.add(safeName(String(name).trim()));
			}
		}
		for (const id of ids) {
			sessionKeys.add(safeName(id));
		}
		let removedAttempts = 0;
		for (const attempt of Array.from(attempts.values())) {
			const matchById = ids.has(attempt.id);
			const matchByName = !!attempt.accountName && names.has(attempt.accountName.trim().toLowerCase());
			if (!matchById && !matchByName) {
				continue;
			}
			sessionKeys.add(safeName(attempt.accountName || attempt.steamID || attempt.id));
			dispose(attempt, '账号已删除');
			removedAttempts++;
		}
		options.intents.remove(Array.from(accountNames));
		return {removedAttempts, sessionKeys: Array.from(sessionKeys)};
	}

	function saveSession(attempt: Attempt): void {
		if (!attempt.remember) {
			return;
		}
		const key = safeName(attempt.accountName || attempt.steamID || attempt.id);
		options.sessions.put(key, {
			accountName: attempt.accountName,
			steamID: attempt.steamID,
			personaName: attempt.personaName,
			country: attempt.country,
			hasWallet: attempt.hasWallet,
			currency: attempt.currency,
			balance: attempt.balance,
			refreshToken: attempt.refreshToken,
			cookies: attempt.cookies,
			cookieHeader: attempt.cookies.join('; '),
			updatedAt: new Date().toISOString()
		});
		addLog(attempt, 'info', '已保存 session(加密): ' + key);
	}

	// ===== 掉线重连看门狗(steam-user autoRelogin 的兜底)=====
	// 定时扫描「曾经在线、现在卡在 disconnected/failed、非主动登出、非致命错误」的账号,
	// 用存好的凭据复用同一 client 重登(retryLogon)。

	function isFatalEResult(eresult: unknown): boolean {
		return typeof eresult === 'number' && options.fatalEResults.has(eresult);
	}

	function markAttemptDisconnected(attempt: Attempt, fatal: boolean): void {
		if (!attempt.disconnectedSince) {
			attempt.disconnectedSince = Date.now();
		}
		if (fatal) {
			attempt.reconnectBlocked = true;
			// 被顶号/封禁/密码错:重启后也不要再自动登录,免得和你在别处的登录抢号
			options.intents.setOnline(attempt.accountName, false);
		}
	}

	function reconnectTick(): void {
		const now = Date.now();
		for (const attempt of attempts.values()) {
			if (!attempt || !attempt.client || attempt.disposed) {
				continue;
			}
			// 只救「曾经在线」的账号;从没建立过会话的失败(密码/验证码错)交给初始登录流程,不在这里硬重试。
			if (!attempt.hadSession) {
				continue;
			}
			if (attempt.status !== 'disconnected' && attempt.status !== 'failed') {
				continue;   // 在线/连接中/等验证码/主动登出:跳过
			}
			if (attempt.guardCallback || attempt.reconnectBlocked || !attempt.loginDetails) {
				continue;
			}
			// 掉线不足 grace:先让 autoRelogin 自己恢复,不插手。
			if (!attempt.disconnectedSince || (now - attempt.disconnectedSince) < timing.reconnectGraceMs) {
				continue;
			}
			if (attempt.nextReconnectAt && now < attempt.nextReconnectAt) {
				continue;   // 退避中
			}
			const tries = Number(attempt.reconnectAttempts || 0);
			if (tries >= timing.reconnectMaxAttempts) {
				if (!attempt.reconnectGaveUp) {
					attempt.reconnectGaveUp = true;
					attempt.reconnectBlocked = true;
					addLog(attempt, 'error', `掉线重连 ${timing.reconnectMaxAttempts} 次仍未恢复,已停止自动重连(请手动重新登录)`);
					emit(attempt);
				}
				continue;
			}
			attempt.reconnectAttempts = tries + 1;
			attempt.nextReconnectAt = now + Math.min(timing.reconnectBackoffCapMs, timing.reconnectBackoffBaseMs * Math.pow(2, tries));
			attempt.loginRetries = 0;   // 每个重连周期给内层登录看门狗一份新的快速重试额度
			addLog(attempt, 'warn', `检测到掉线,正在第 ${attempt.reconnectAttempts}/${timing.reconnectMaxAttempts} 次自动重连`);
			emit(attempt);
			retryLogon(attempt);
		}
	}

	// ===== steam-user 事件 =====

	function attachSteamEvents(attempt: Attempt, client: SteamClient): void {
		client.on('debug', (message: unknown) => {
			const text = String(message);
			if (shouldIgnoreDebugMessage(text)) {
				return;
			}
			// debug 只记日志不推送:steam-user 每条消息都会打 debug,逐条广播整份会话太浪费
			addLog(attempt, 'debug', text);
		});

		client.on('microTxnAuthRequest', (request: Record<string, unknown> | null) => {
			const summary = [
				'Steam MicroTxnAuthRequest',
				`appid=${request && request.appId ? request.appId : 0}`,
				`orderid=${request && request.orderId ? request.orderId : '-'}`,
				`transid=${request && request.transId ? request.transId : '-'}`,
				request && request.parseError ? `parseError=${request.parseError}` : ''
			].filter(Boolean).join(' ');
			addLog(attempt, 'info', summary);
			emit(attempt);
		});

		client.on('steamGuard', (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
			if (!domain && attempt.sharedSecret) {
				try {
					const code = options.generateAuthCode(attempt.sharedSecret);
					addLog(attempt, 'info', '已自动提交移动令牌验证码');
					emit(attempt);
					callback(code);
					return;
				} catch (err) {
					addLog(attempt, 'warn', '自动生成移动令牌验证码失败: ' + errorMessage(err));
				}
			}

			clearLoginWatchdog(attempt);   // 等待用户输入验证码期间暂停看门狗(提交后会重新计时)
			attempt.status = 'guard_required';
			attempt.guard = {
				type: domain ? 'email' : 'mobile',
				domain: domain || '',
				lastCodeWrong: !!lastCodeWrong
			};
			attempt.guardCallback = callback;
			addLog(attempt, 'warn', domain ? '需要邮箱 Steam Guard 验证码' : '需要移动令牌验证码');
			emit(attempt);
		});

		client.on('loggedOn', (body: Record<string, unknown> | null) => {
			attempt.status = 'logged_on';
			attempt.steamID = client.steamID ? client.steamID.getSteamID64() : '';
			attempt.publicIP = client.publicIP || '';
			attempt.cellID = client.cellID || (body && (body.cell_id as number)) || '';
			addLog(attempt, 'success', 'Steam 登录成功');
			try {
				client.webLogOn();
			} catch (err) {
				addLog(attempt, 'warn', '获取 WebSession 失败: ' + errorMessage(err));
			}
			emit(attempt);
		});

		client.on('accountInfo', (name: string, country: string) => {
			attempt.personaName = name || attempt.personaName || '';
			attempt.loginGeoCountry = normalizeCountryCode(country);
			addLog(attempt, 'info', '已读取账号资料'
				+ (attempt.personaName ? ': ' + attempt.personaName : '')
				+ (attempt.loginGeoCountry ? ' / 登录地区 ' + attempt.loginGeoCountry : ''));
			emit(attempt);
		});

		client.on('wallet', (hasWallet: boolean, currency: number, balance: number) => {
			attempt.hasWallet = !!hasWallet;
			attempt.currency = currency;
			attempt.currencyISO = options.currencyIdToIso(currency);
			attempt.balance = balance;
			if (attempt.hasWallet) {
				const resolvedCountry = options.resolveWalletCountry(attempt);
				if (resolvedCountry) {
					attempt.country = resolvedCountry;
				}
			}
			addLog(attempt, 'info', hasWallet ? '钱包余额: ' + balance + ' / currency ' + currency : '账号没有钱包');
			saveSession(attempt);
			emit(attempt);
		});

		client.on('refreshToken', (token: string) => {
			attempt.refreshToken = token || '';
			attempt.hasRefreshToken = !!attempt.refreshToken;
			addLog(attempt, 'success', '已获取 refreshToken');
			saveSession(attempt);
			emit(attempt);
		});

		client.on('webSession', (sessionID: string, cookies: string[]) => {
			clearLoginWatchdog(attempt);   // 拿到 WebSession = 登录完成
			attempt.loginRetries = 0;
			// (重)连成功:标记曾经在线,并清空掉线重连计数/退避/阻断,供重连看门狗判定。
			attempt.hadSession = true;
			attempt.disconnectedSince = 0;
			attempt.reconnectAttempts = 0;
			attempt.nextReconnectAt = 0;
			attempt.reconnectBlocked = false;
			attempt.reconnectGaveUp = false;
			attempt.restoreFallback = null;
			attempt.status = 'web_session';
			attempt.webSessionID = sessionID || '';   // 商店结算需要的 sessionid(CSRF)
			attempt.cookies = Array.isArray(cookies) ? cookies : [];
			attempt.cookieCount = attempt.cookies.length;
			attempt.hasCookies = attempt.cookieCount > 0;
			attempt.inventoryCache = null;
			attempt.communityInvTriedAt = 0;
			attempt.inventoryInflight = null;
			addLog(attempt, 'success', '已获取 WebSession cookies: ' + attempt.cookieCount);
			saveSession(attempt);
			if (!attempt.disposed) {
				options.intents.setOnline(attempt.accountName, true);   // 重启后要恢复它
			}
			emit(attempt);
			options.onWebSession?.(attempt);
		});

		client.on('machineAuthToken', () => {
			addLog(attempt, 'info', '已更新 machineAuthToken');
			emit(attempt);
		});

		client.on('disconnected', (eresult: unknown, msg: string) => {
			attempt.gcConnected = false;
			attempt.cs2GcConnected = false;
			attempt.tf2GcConnected = false;
			if (attempt.status !== 'logged_out' && !attempt.disposed) {
				attempt.status = 'disconnected';
				markAttemptDisconnected(attempt, isFatalEResult(eresult));
				addLog(attempt, 'warn', 'Steam 连接已断开' + (msg ? ': ' + msg : ''));
				emit(attempt);
			}
		});

		client.on('error', (err: {eresult?: number; message?: string}) => {
			clearLoginWatchdog(attempt);   // 明确错误(如密码错误/限频):不再走超时重试
			if (attempt.disposed) {
				return;
			}
			// 自动恢复时 refreshToken 失效:改用密码登录一次
			if (!attempt.hadSession && attempt.restoreFallback && attempt.loginDetails && attempt.loginDetails.refreshToken) {
				const fallback = attempt.restoreFallback;
				attempt.restoreFallback = null;
				addLog(attempt, 'warn', `refreshToken 登录失败(${formatSteamError(attempt, err)}),改用密码登录`);
				attempt.loginDetails = fallback;
				attempt.loginRetries = 0;
				retryLogon(attempt);
				return;
			}
			attempt.gcConnected = false;
			attempt.cs2GcConnected = false;
			attempt.tf2GcConnected = false;
			attempt.status = 'failed';
			// LoggedInElsewhere/被顶号/封禁/密码错等致命错误标记为不自动重连(避免与你的其它登录抢号/无效硬冲)。
			markAttemptDisconnected(attempt, isFatalEResult(err && err.eresult));
			addLog(attempt, 'error', formatSteamError(attempt, err));
			emit(attempt);
		});
	}

	// ===== 重启后自动恢复 =====

	/**
	 * 按登录意图逐个恢复会话(间隔 restoreIntervalMs,避免同时登录触发 Steam 限频)。
	 * resolve 返回该账号的资料和凭据;返回 null 表示账号已不存在,清掉意图。
	 */
	function restoreAll(resolve: (accountName: string) => RestoreCredentials | null): string[] {
		const names = options.intents.listOnline();
		names.forEach((accountName, index) => {
			const timer = setTimeout(() => {
				restoreTimers.delete(timer);
				try {
					restoreOne(accountName, resolve);
				} catch (err) {
					logger.warn(`[session] ${accountName} 自动恢复失败: ${errorMessage(err)}`);
				}
			}, index * timing.restoreIntervalMs);
			restoreTimers.add(timer);
		});
		if (names.length) {
			logger.log(`[session] 将自动恢复 ${names.length} 个账号的登录(每 ${timing.restoreIntervalMs / 1000}s 一个)`);
		}
		return names;
	}

	function restoreOne(accountName: string, resolve: (accountName: string) => RestoreCredentials | null): Attempt | null {
		if (activeAttemptFor(accountName)) {
			return null;   // 已经有人手动登录了
		}
		const credentials = resolve(accountName);
		if (!credentials) {
			options.intents.remove([accountName]);
			return null;
		}
		const sharedSecret = credentials.profile.sharedSecret || '';
		const passwordDetails = credentials.password
			? passwordLogonDetails(accountName, credentials.password, sharedSecret)
			: null;
		if (!credentials.refreshToken && !passwordDetails) {
			logger.warn(`[session] ${accountName} 没有 refreshToken 也没有密码,无法自动恢复登录`);
			options.intents.setOnline(accountName, false);
			return null;
		}
		const attempt = createAttempt({...credentials.profile, accountName});
		addLog(attempt, 'info', `服务重启后自动恢复登录(${credentials.refreshToken ? 'refreshToken' : '密码'})`);
		attempt.restoreFallback = credentials.refreshToken ? passwordDetails : null;
		startLogon(attempt, credentials.refreshToken ? {refreshToken: credentials.refreshToken} : (passwordDetails as LogonDetails));
		return attempt;
	}

	// ===== 生命周期 =====

	function start(): void {
		if (!reconnectTimer) {
			reconnectTimer = setInterval(reconnectTick, timing.reconnectIntervalMs);
			reconnectTimer.unref?.();
		}
	}

	/** 停服:停所有定时器并登出全部会话(不改登录意图,下次启动照常恢复)。返回登出的会话数。 */
	function shutdown(): number {
		if (reconnectTimer) {
			clearInterval(reconnectTimer);
			reconnectTimer = null;
		}
		for (const timer of restoreTimers) {
			clearTimeout(timer);
		}
		restoreTimers.clear();
		let count = 0;
		for (const attempt of attempts.values()) {
			clearLoginWatchdog(attempt);
			if (attempt.client) {
				try {
					attempt.client.logOff();
				} catch {
					// 忽略
				}
				count++;
			}
		}
		return count;
	}

	return {
		attempts,
		get,
		list,
		activeAttemptFor,
		createAttempt,
		startLogon,
		passwordLogonDetails,
		submitGuardCode,
		logout,
		removeAccounts,
		saveSession,
		addLog,
		emit,
		publicAttempt,
		formatSteamError,
		reconnectTick,
		restoreAll,
		start,
		shutdown
	};
}

export type SessionManager = ReturnType<typeof createSessionManager>;
