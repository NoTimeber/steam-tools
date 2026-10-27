// UU(悠悠有品)发货服务(从 app/server.js 移来):token 管理、短信登录、每账号每游戏的自动发货轮询、CS2 自动上架。
// 路由在 ./routes.ts;UU 接口、Steam 报价接受、存储、推送都由这里注入,单元测试用假的。

import {randomBytes} from 'node:crypto';
import type {Attempt} from '../steam/session-manager.ts';
import {findOnlineAttempt} from '../steam/attempts.ts';
import {createConfirmer} from '../steam/confirmations.ts';
import type {Confirmer} from '../steam/confirmations.ts';
import {acceptVerifiedTradeOffer} from '../steam/trade-offer.ts';
import type {AcceptOfferOptions, AcceptOfferResult} from '../steam/trade-offer.ts';
import {uuTokenId} from '../store/uu.ts';
import type {UuStore, UuTokenEntry} from '../store/uu.ts';
import {decodeJwt, generateHeaders, generateRandomString, SUBSTATUS_WAIT_CONFIRM, UuAccount} from './client.ts';
import type {UuLogger} from './client.ts';
import {UuPriceEngine} from './pricing.ts';
import {DEFAULT_DELIVERY_TIMING, errorText, listWaitDeliverOrders, runDeliveryPass} from './delivery.ts';
import type {DeliveryClient, DeliveryContext, DeliveryTiming} from './delivery.ts';
import {runListingPass} from './listing.ts';
import type {ListingClient, ListingContext} from './listing.ts';
import {
	appendLog, applyConfig, buildConfig, clampPollMs, createAccountState, CS2_GAME_ID, DELIVER_GAME_IDS, gameDelivery, maskUuToken,
	normalizeUuGameId, POLL_DEFAULT_MS, publicAccount, uuDefaultGameId, uuError, uuGameLabel
} from './state.ts';
import type {AccountState, PublicUuAccount, Readiness} from './state.ts';

export {uuError};
export type {PublicUuAccount};

const LIST_INTERVAL_MS = 30 * 60 * 1000;
// 上架查价缓存未命中时,每次查价之间随机等待(UU 查价限流较严,对齐 Steamauto operate_sleep)
const LIST_QUERY_GAP = {min: 4000, max: 9000};
const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;

/** UU 客户端:发货、上架、查绑定的 Steam 账号 */
export interface UuClient extends DeliveryClient, ListingClient {
	getSteamCookiePull(): Promise<{steamId: string}>;
}

/** UU 接口入口(默认是 ./client.ts 的 UuAccount) */
export interface UuApi {
	client(token: string, opts: {gameId: string; logger?: UuLogger}): UuClient;
	/** 建客户端并打一次待发货列表验证 token,失败抛错 */
	connect(token: string, opts: {gameId: string; logger?: UuLogger}): Promise<{getUserNickname(): string; userId: string | number | null; jwtExp: number | null}>;
	getUk(): Promise<string>;
	sendLoginSmsCode(phone: string, session: string, opts: {headers: Record<string, string>; uk: string}): Promise<{Msg?: string; [key: string]: unknown}>;
	getSmsUpSignInConfig(headers: Record<string, string>): Promise<{Code?: number; Data?: {SmsUpContent?: string; SmsUpNumber?: string}} | null>;
	smsSignIn(phone: string, code: string, session: string, opts: {headers: Record<string, string>}): Promise<{Msg?: string; Data?: {Token?: string}} | null>;
}

export const defaultUuApi: UuApi = {
	client: (token, opts) => new UuAccount(token, opts),
	connect: (token, opts) => UuAccount.create(token, opts),
	getUk: () => UuAccount.getUuUk(),
	sendLoginSmsCode: (phone, session, opts) => UuAccount.sendLoginSmsCode(phone, session, opts),
	getSmsUpSignInConfig: headers => UuAccount.getSmsUpSignInConfig(headers),
	smsSignIn: (phone, code, session, opts) => UuAccount.smsSignIn(phone, code, session, opts)
};

/** 外部 CS2 检视服务(自建,见 inspect-service/):检视链接 → 磨损;没配置或失败为 null */
export async function resolveAbradeViaInspect(serviceUrl: string, key: string, actionLink: string | undefined): Promise<number | null> {
	if (!serviceUrl || !actionLink) {
		return null;
	}
	try {
		const url = new URL(serviceUrl + '/inspect');
		url.searchParams.set('url', actionLink);
		const headers: Record<string, string> = {};
		if (key) {
			headers['x-inspect-key'] = key;   // 走 header,避免密钥进访问日志
		}
		const resp = await fetch(url, {headers, signal: AbortSignal.timeout(15000)});
		const json = await resp.json() as {success?: boolean; iteminfo?: {floatvalue?: unknown}} | null;
		if (json && json.success && json.iteminfo && json.iteminfo.floatvalue != null) {
			const value = parseFloat(String(json.iteminfo.floatvalue));
			return Number.isFinite(value) ? value : null;
		}
	} catch {
		// 解析服务不可用不致命,按没有磨损处理
	}
	return null;
}

export interface UuServiceOptions {
	store: UuStore;
	attempts(): Iterable<Attempt>;
	/** socket.io 推送:uu:log(实时日志)、uu:update(账号状态) */
	emit(event: 'uu:log' | 'uu:update', payload: unknown): void;
	/** 没绑 token 的账号显示用:本地有没有 maFile */
	hasMaFile(accountName: string): boolean;
	api?: UuApi;
	acceptOffer?: (opts: AcceptOfferOptions) => Promise<AcceptOfferResult>;
	/** 手机确认发 mobileconf 用的 fetch(按 Cookie 里的账号选代理,和市场求购同一个) */
	fetch?: typeof fetch;
	/** 账号 maFile 的 device_id(手机确认用) */
	deviceIdFor?: (accountName: string) => string;
	confirmer?: Pick<Confirmer, 'confirmTradeOffer'>;
	/** 初始轮询间隔(UU_POLL_INTERVAL_MS);数据库里存的设置优先 */
	pollIntervalMs?: number;
	listIntervalMs?: number;
	listQueryGap?: {min: number; max: number};
	inspect?: {url: string; key: string};
	timing?: Partial<DeliveryTiming>;
	sleep?: (ms: number) => Promise<void>;
	logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface LoginSession {
	phone: string;
	headers: Record<string, string>;
	sessionId: string;
	mode: 'sms' | 'sms-up';
	createdAt: number;
}

export function createUuService(options: UuServiceOptions) {
	const api = options.api ?? defaultUuApi;
	const acceptOffer = options.acceptOffer ?? acceptVerifiedTradeOffer;
	const logger = options.logger ?? console;
	// 手机确认的日志每次调用时传,写进那个账号的发货日志,所以不要前缀
	const confirmer = options.confirmer ?? createConfirmer({fetch: options.fetch, label: ''});
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const listIntervalMs = options.listIntervalMs ?? LIST_INTERVAL_MS;
	const listQueryGap = options.listQueryGap ?? LIST_QUERY_GAP;
	const inspectUrl = String(options.inspect?.url || '').replace(/\/+$/, '');
	const inspectKey = options.inspect?.key || '';
	const states = new Map<string, AccountState>();
	const loginSessions = new Map<string, LoginSession>();
	let pollIntervalMs = clampPollMs(options.pollIntervalMs ?? POLL_DEFAULT_MS);

	// ===== 状态、日志、推送 =====

	function ensureState(accountName: string): AccountState {
		const name = String(accountName || '').trim();
		let state = states.get(name);
		if (!state) {
			state = createAccountState(name);
			states.set(name, state);
		}
		return state;
	}

	/** 已绑 token 的账号状态;没有就报 409 */
	function boundState(accountName: unknown): AccountState {
		const state = states.get(String(accountName || '').trim());
		if (!state || !state.token) {
			throw uuError(409, '该账号尚未绑定 token');
		}
		return state;
	}

	function log(state: AccountState, level: string, message: string): void {
		const entry = appendLog(state, level, message);
		const line = `[uu:${state.accountName}] ${message}`;
		if (level === 'error') {
			logger.error(line);
		} else if (level === 'warn') {
			logger.warn(line);
		}
		options.emit('uu:log', {accountName: state.accountName, level, message, time: entry.time});
	}

	function stateLogger(state: AccountState, prefix = ''): UuLogger {
		return (level, message) => {
			if (level !== 'debug') {
				log(state, level, prefix + message);
			}
		};
	}

	/** 发货要:Steam 在线 + WebSession cookies + identity_secret(手机确认) */
	function readiness(accountName: string): Readiness & {attempt: Attempt | null} {
		const attempt = findOnlineAttempt(options.attempts(), accountName);
		if (!attempt) {
			return {attempt: null, online: false, hasCookies: false, hasIdentitySecret: false, steamID: ''};
		}
		return {
			attempt,
			online: true,
			hasCookies: Array.isArray(attempt.cookies) && attempt.cookies.length > 0,
			hasIdentitySecret: !!attempt.identitySecret,
			steamID: attempt.steamID || ''
		};
	}

	function view(accountName: unknown): PublicUuAccount {
		const name = String(accountName || '').trim();
		const state = states.get(name) ?? null;
		return publicAccount(name, state, readiness(name), state ? false : options.hasMaFile(name));
	}

	/**
	 * 发货列表由已绑定的 token 驱动,不把在线的 Steam 账号塞进来;
	 * 账号在不在线只是行内提示(离线时前端给出「登录账户」按钮)。
	 */
	function listAccounts(): PublicUuAccount[] {
		return Array.from(states.entries())
			.filter(([name, state]) => name && state.token)
			.map(([name]) => name)
			.sort((left, right) => left.localeCompare(right, 'zh-CN'))
			.map(view);
	}

	function emitAccount(state: AccountState): void {
		options.emit('uu:update', view(state.accountName));
	}

	function saveConfig(): void {
		try {
			options.store.saveDeliveryConfig(buildConfig(states, pollIntervalMs));
		} catch (err) {
			logger.warn('[uu] 保存发货配置失败:', errorText(err));
		}
	}

	// ===== 轮询 =====

	const deliveryContext: DeliveryContext = {
		client: (state, gameId, prefix = '') => api.client(state.token, {gameId, logger: stateLogger(state, prefix)}),
		log,
		emit: emitAccount,
		readiness: name => {
			const ready = readiness(name);
			const attempt = ready.attempt;
			return {
				...ready,
				attempt: attempt ? {
					cookies: attempt.cookies,
					identitySecret: attempt.identitySecret,
					steamID: attempt.steamID || '',
					deviceId: options.deviceIdFor?.(name) || '',
					userAgent: attempt.userAgent || ''
				} : null
			};
		},
		acceptOffer,
		confirmTradeOffer: (attempt, tradeOfferId, log) => confirmer.confirmTradeOffer({...attempt, tradeOfferId, log}),
		sleep,
		timing: {...DEFAULT_DELIVERY_TIMING, ...options.timing},
		waitConfirmSubStatus: SUBSTATUS_WAIT_CONFIRM
	};

	const listingContext: ListingContext = {
		client: state => api.client(state.token, {gameId: CS2_GAME_ID, logger: stateLogger(state)}),
		priceEngine: state => new UuPriceEngine({params: {requestGap: listQueryGap}, logger: stateLogger(state)}),
		log,
		emit: emitAccount,
		resolveAbrade: actionLink => resolveAbradeViaInspect(inspectUrl, inspectKey, actionLink),
		inspectConfigured: !!inspectUrl
	};

	async function scan(accountName: unknown, gameId: unknown, source = 'manual'): Promise<PublicUuAccount> {
		const state = boundState(accountName);
		await runDeliveryPass(deliveryContext, state, gameId, source);
		return view(state.accountName);
	}

	async function listScan(accountName: unknown, source = 'manual'): Promise<PublicUuAccount> {
		const state = boundState(accountName);
		await runListingPass(listingContext, state, source);
		return view(state.accountName);
	}

	function startPolling(state: AccountState, gameId: string): void {
		const game = gameDelivery(state, gameId);
		if (!state.token || !game.auto || game.pollTimer) {
			return;
		}
		const tick = () => {
			scan(state.accountName, gameId, 'auto').catch(() => {});
		};
		game.pollTimer = setInterval(tick, pollIntervalMs);
		tick();
	}

	function stopPolling(state: AccountState, gameId: string): void {
		const game = state.byGame[gameId];
		if (game && game.pollTimer) {
			clearInterval(game.pollTimer);
			game.pollTimer = null;
		}
	}

	function startListPolling(state: AccountState): void {
		if (!state.token || !state.listAuto || state.listTimer) {
			return;
		}
		const tick = () => {
			listScan(state.accountName, 'auto').catch(() => {});
		};
		state.listTimer = setInterval(tick, listIntervalMs);
		tick();
	}

	function stopListPolling(state: AccountState): void {
		if (state.listTimer) {
			clearInterval(state.listTimer);
			state.listTimer = null;
		}
	}

	/** 启动:读配置,开着自动发货/上架的账号开始轮询 */
	function start(): void {
		try {
			const saved = applyConfig(options.store.loadDeliveryConfig(), ensureState);
			if (saved != null) {
				pollIntervalMs = saved;
			}
		} catch (err) {
			logger.warn('[uu] 载入发货配置失败:', errorText(err));
		}
		for (const state of states.values()) {
			if (!state.token) {
				continue;
			}
			for (const gid of DELIVER_GAME_IDS) {
				if (gameDelivery(state, gid).auto) {
					startPolling(state, gid);
				}
			}
			if (state.listAuto) {
				startListPolling(state);
			}
		}
	}

	/** 停掉所有轮询定时器(停服/测试用) */
	function stop(): void {
		for (const state of states.values()) {
			for (const gid of Object.keys(state.byGame)) {
				stopPolling(state, gid);
			}
			stopListPolling(state);
		}
	}

	function setAuto(accountName: unknown, gameId: unknown, enabled: boolean): PublicUuAccount {
		const state = boundState(accountName);
		const gid = normalizeUuGameId(gameId);
		const game = gameDelivery(state, gid);
		game.auto = !!enabled;
		if (game.auto) {
			startPolling(state, gid);
			log(state, 'info', `已开启 ${uuGameLabel(gid)} 自动发货轮询`);
		} else {
			stopPolling(state, gid);
			log(state, 'info', `已关闭 ${uuGameLabel(gid)} 自动发货轮询`);
		}
		saveConfig();
		emitAccount(state);
		return view(state.accountName);
	}

	function setListAuto(accountName: unknown, enabled: boolean): PublicUuAccount {
		const state = boundState(accountName);
		state.listAuto = !!enabled;
		if (state.listAuto) {
			startListPolling(state);
			log(state, 'info', '已开启 CS2 自动上架');
		} else {
			stopListPolling(state);
			log(state, 'info', '已关闭 CS2 自动上架');
		}
		saveConfig();
		emitAccount(state);
		return view(state.accountName);
	}

	/** 改全局轮询间隔,正在轮询的(账号 × 游戏)立即按新间隔重启 */
	function setPollInterval(ms: unknown): number {
		pollIntervalMs = clampPollMs(ms);
		for (const state of states.values()) {
			for (const gid of DELIVER_GAME_IDS) {
				if (state.byGame[gid]?.pollTimer) {
					stopPolling(state, gid);
					startPolling(state, gid);
				}
			}
		}
		saveConfig();
		return pollIntervalMs;
	}

	function setPollIntervalMinutes(minutes: unknown): number {
		const value = Number(minutes);
		if (!Number.isFinite(value) || value <= 0) {
			throw uuError(400, '请输入有效的轮询分钟数');
		}
		return setPollInterval(value * 60 * 1000);
	}

	// ===== token =====

	function loadTokens(): UuTokenEntry[] {
		return options.store.listTokens();
	}

	function saveTokens(tokens: UuTokenEntry[]): void {
		try {
			options.store.replaceTokens(Array.isArray(tokens) ? tokens : []);
		} catch (err) {
			logger.warn('[uu] 保存 token 列表失败:', errorText(err));
		}
	}

	/** 给浏览器的 token 条目:不带 token 原文,只给稳定 id 和掩码 */
	function publicToken(entry: UuTokenEntry) {
		const {token, ...rest} = entry;
		return {...rest, id: uuTokenId(entry), tokenMask: maskUuToken(token)};
	}

	/** 按 UU userId 去重写入(token 按 UU 账号发放、CS2/TF2 通用,不按游戏区分) */
	function upsertToken(entry: UuTokenEntry): void {
		const tokens = loadTokens();
		const index = tokens.findIndex(item => item.userId === entry.userId);
		if (index >= 0) {
			tokens[index] = entry;
		} else {
			tokens.push(entry);
		}
		saveTokens(tokens);
	}

	/** 解 JWT 拿身份,再查这个 UU 账号绑定的 Steam 账号(查不到不报错) */
	async function describeToken(token: string, gameId: string): Promise<UuTokenEntry & {userId: string; nickname: string; linkedSteamId: string; jwtExp: number | null}> {
		const jwt = decodeJwt(token);
		let linkedSteamId = '';
		try {
			linkedSteamId = (await api.client(token, {gameId}).getSteamCookiePull()).steamId || '';
		} catch {
			// 可能 token 没绑 Steam
		}
		return {
			token,
			userId: jwt && jwt.Id ? String(jwt.Id) : '',
			nickname: jwt && jwt.Name ? String(jwt.Name) : '',
			linkedSteamId,
			jwtExp: jwt && jwt.exp ? Number(jwt.exp) : null,
			acquiredAt: new Date().toISOString()
		};
	}

	async function bindToken(accountName: unknown, token: unknown, gameId: unknown): Promise<PublicUuAccount> {
		const name = String(accountName || '').trim();
		const tok = String(token || '').trim();
		if (!name) {
			throw uuError(400, '账号不能为空');
		}
		if (!tok) {
			throw uuError(400, 'token 不能为空');
		}
		// gid 只用来选校验网关(token 通用);不传走 CS2
		const gid = uuDefaultGameId(gameId);
		const state = ensureState(name);
		let account;
		try {
			account = await api.connect(tok, {gameId: gid, logger: stateLogger(state)});
		} catch (err) {
			throw uuError(400, 'token 校验失败: ' + errorText(err));
		}
		state.token = tok;
		state.gameId = gid;
		state.nickname = account.getUserNickname() || '';
		state.userId = account.userId ? String(account.userId) : null;
		state.jwtExp = account.jwtExp || null;
		state.boundAt = new Date().toISOString();
		log(state, 'info', `已绑定 token：${state.nickname || '(无昵称)'} | 到期 ${state.jwtExp ? new Date(state.jwtExp * 1000).toLocaleString('zh-CN') : '未知'}（在 CS2/TF2 开关里分别开启自动发货）`);
		saveConfig();
		emitAccount(state);
		return view(name);
	}

	/** 绑定:浏览器拿不到 token 原文,自动绑定传 tokenId 由服务端取;手动粘贴仍直接传 token */
	async function bind(body: {accountName?: unknown; token?: unknown; tokenId?: unknown; gameId?: unknown}): Promise<PublicUuAccount> {
		let token = String(body.token || '').trim();
		if (!token && body.tokenId) {
			const entry = options.store.findToken(String(body.tokenId));
			if (!entry) {
				throw uuError(404, '找不到该 token,请刷新后重试');
			}
			token = entry.token;
		}
		return bindToken(body.accountName, token, body.gameId);
	}

	/** 删账号的 token:停轮询、清绑定、从 token 列表移除 */
	function deleteAccountToken(accountName: unknown): PublicUuAccount {
		const name = String(accountName || '').trim();
		if (!name) {
			throw uuError(400, '账号不能为空');
		}
		const state = boundState(name);
		const removedToken = state.token;
		const removedUserId = state.userId == null ? '' : String(state.userId);
		for (const gid of DELIVER_GAME_IDS) {
			stopPolling(state, gid);
			if (state.byGame[gid]) {
				gameDelivery(state, gid).auto = false;
			}
		}
		stopListPolling(state);
		state.token = '';
		state.listAuto = false;
		state.nickname = '';
		state.userId = null;
		state.jwtExp = null;
		state.boundAt = '';
		log(state, 'info', '已删除该账号的 UU token，自动发货已停止');
		saveConfig();
		// 按 userId 删(也兼容按 token 字符串):历史上同一 UU 账号可能存了多条,只按 token 删会漏,残留的会被前端自动绑回来
		try {
			saveTokens(loadTokens().filter(item => item.token !== removedToken && !(removedUserId && String(item.userId) === removedUserId)));
		} catch (err) {
			logger.warn('[uu] 清理 token 列表失败:', errorText(err));
		}
		emitAccount(state);
		return view(name);
	}

	/** 手动粘贴的 token 存进列表(先不绑账号) */
	async function acquireToken(body: {token?: unknown; gameId?: unknown}) {
		const token = String(body.token || '').trim();
		if (!token) {
			throw uuError(400, 'token 不能为空');
		}
		const entry = await describeToken(token, uuDefaultGameId(body.gameId));
		upsertToken(entry);
		return publicToken(entry);
	}

	function listTokens() {
		return loadTokens().map(publicToken);
	}

	/** 按账号(解绑并移除)、按 tokenId、或按 token 原文删除 */
	function deleteToken(body: {accountName?: unknown; tokenId?: unknown; token?: unknown}): PublicUuAccount | null {
		const accountName = String(body.accountName || '').trim();
		if (accountName) {
			return deleteAccountToken(accountName);
		}
		const tokenId = String(body.tokenId || '').trim();
		if (tokenId) {
			saveTokens(loadTokens().filter(item => uuTokenId(item) !== tokenId));
			return null;
		}
		const token = String(body.token || '').trim();
		if (!token) {
			throw uuError(400, 'tokenId、token 或 accountName 不能为空');
		}
		saveTokens(loadTokens().filter(item => item.token !== token));
		return null;
	}

	// ===== 短信登录拿 token =====

	function pruneLoginSessions(): void {
		const now = Date.now();
		for (const [id, session] of loginSessions) {
			if (now - session.createdAt > LOGIN_SESSION_TTL_MS) {
				loginSessions.delete(id);
			}
		}
	}

	/** 第一步:生成设备会话、取 uk、发验证码;下行短信失败则改走上行短信 */
	async function loginStart(phone: unknown) {
		const tel = String(phone || '').trim();
		if (!/^\d{6,15}$/.test(tel)) {
			throw uuError(400, '手机号格式不正确');
		}
		pruneLoginSessions();
		// 设备身份在 start / verify 之间必须保持一致
		const deviceInfo = generateRandomString(10);
		const headers = generateHeaders(deviceInfo, deviceInfo, '', '730');
		let uk = '';
		try {
			uk = await api.getUk();
		} catch {
			uk = '';
		}
		// 把真 uk 写进共享 headers,后面的上行短信配置 / 登录(verify 复用这份 headers)都带同一个 uk
		if (uk) {
			headers.uk = uk;
		}
		const result = await api.sendLoginSmsCode(tel, deviceInfo, {headers, uk});
		const msg = String((result && result.Msg) || '');
		const loginSessionId = randomBytes(12).toString('hex');
		if (msg.includes('成功')) {
			loginSessions.set(loginSessionId, {phone: tel, headers, sessionId: deviceInfo, mode: 'sms', createdAt: Date.now()});
			return {loginSessionId, mode: 'sms', phone: tel, message: msg || '验证码已发送'};
		}
		const cfg = await api.getSmsUpSignInConfig(headers);
		if (cfg && cfg.Code === 0 && cfg.Data) {
			loginSessions.set(loginSessionId, {phone: tel, headers, sessionId: deviceInfo, mode: 'sms-up', createdAt: Date.now()});
			return {
				loginSessionId,
				mode: 'sms-up',
				phone: tel,
				smsUpContent: cfg.Data.SmsUpContent || '',
				smsUpNumber: cfg.Data.SmsUpNumber || '',
				message: msg || '该手机号需要上行短信验证'
			};
		}
		throw uuError(502, '发送验证码失败: ' + (msg || JSON.stringify(result)) + '；上行短信配置也获取失败');
	}

	/** 第二步:验证码(下行)或空码(上行)登录拿 token;存进列表,并绑到指定账号或按 SteamID 自动匹配的账号 */
	async function loginVerify(body: {loginSessionId?: unknown; code?: unknown; accountName?: unknown; gameId?: unknown}) {
		pruneLoginSessions();
		const sessionKey = String(body.loginSessionId || '');
		const session = loginSessions.get(sessionKey);
		if (!session) {
			throw uuError(400, '登录会话不存在或已过期，请重新发送验证码');
		}
		if (session.mode === 'sms' && !String(body.code || '').trim()) {
			throw uuError(400, '请输入短信验证码');
		}
		const verifyCode = session.mode === 'sms' ? String(body.code).trim() : '';
		let response;
		try {
			response = await api.smsSignIn(session.phone, verifyCode, session.sessionId, {headers: session.headers});
		} catch (err) {
			throw uuError(502, 'UU 登录请求失败: ' + errorText(err));
		}
		const token = response && response.Data && response.Data.Token;
		if (!token) {
			throw uuError(400, 'UU 登录失败: ' + ((response && response.Msg) || JSON.stringify(response)));
		}
		loginSessions.delete(sessionKey);

		// 游戏只决定校验/查绑定打哪个网关,不决定 token 归属;前端已不传 gameId,缺省 CS2
		const entry = await describeToken(String(token), uuDefaultGameId(body.gameId));
		try {
			upsertToken(entry);
		} catch {
			// 持久化失败不阻断
		}

		const out = {
			userId: entry.userId,
			nickname: entry.nickname,
			linkedSteamId: entry.linkedSteamId,
			jwtExp: entry.jwtExp,
			bound: false,
			account: null as PublicUuAccount | null,
			bindError: '',
			autoBoundAccount: undefined as string | undefined,
			tokenId: uuTokenId(entry)
		};
		const name = String(body.accountName || '').trim();
		let target = name;
		if (!target && entry.linkedSteamId) {
			// 没指定账号:按 UU 绑定的 SteamID 匹配已登录的账号
			const matched = Array.from(options.attempts()).find(attempt => attempt.steamID === entry.linkedSteamId && attempt.accountName);
			target = matched ? matched.accountName : '';
		}
		if (target) {
			try {
				out.account = await bindToken(target, entry.token, body.gameId);
				out.bound = true;
				if (!name) {
					out.autoBoundAccount = target;
					logger.log(`[uu] 自动绑定: token SteamID ${entry.linkedSteamId} -> 账号 ${target}`);
				}
			} catch (err) {
				out.bindError = errorText(err);
			}
		}
		return out;
	}

	function loginCancel(loginSessionId: unknown): void {
		const id = String(loginSessionId || '');
		if (id) {
			loginSessions.delete(id);
		}
	}

	async function waitDeliverOrders(accountName: unknown) {
		return listWaitDeliverOrders(deliveryContext, boundState(accountName));
	}

	return {
		start,
		stop,
		state: () => ({pollIntervalMs, accounts: listAccounts()}),
		pollIntervalMs: () => pollIntervalMs,
		view,
		bind,
		setAuto,
		scan,
		waitDeliverOrders,
		setListAuto,
		listScan,
		setPollIntervalMinutes,
		loginStart,
		loginVerify,
		loginCancel,
		acquireToken,
		listTokens,
		deleteToken
	};
}

export type UuService = ReturnType<typeof createUuService>;
