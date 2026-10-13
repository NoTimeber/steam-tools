// 口令登录鉴权(从 app/lib/auth.js 移来,无额外依赖)。守护 Express 路由、静态资源和 socket.io 握手。
//
// 口令来源优先级:
//   1) data/config/auth.json(网页里设置/修改,scrypt 哈希)—— 最高;
//   2) APP_PASSWORD 环境变量(明文,只作引导/兼容);
//   3) 都没有 = 未配置:除首次设置接口和登录页外一律锁定。首次设置必须带启动日志里打印的「初始化令牌」,
//      防止部署到公网后被别人抢先设置。
// 会话 token 存内存(进程重启 = 全部失效)。

import {createHash, randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {readJsonFileSafe, writeJsonAtomic} from './atomic-file.ts';

export const COOKIE_NAME = 'sid';

// 登录失败限速:同一 IP 窗口内失败 5 次锁 15 分钟;全局窗口内失败 50 次(防多 IP 分布式爆破)也锁
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 50;
const MAX_TRACKED_IPS = 10000;

/** 解析 Cookie 头;畸形编码不抛错(否则 socket 握手里会变成未捕获异常) */
export function parseCookies(header: unknown): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	String(header || '').split(';').forEach(part => {
		const index = part.indexOf('=');
		if (index === -1) {
			return;
		}
		const key = part.slice(0, index).trim();
		if (!key) {
			return;
		}
		const raw = part.slice(index + 1).trim();
		try {
			out[key] = decodeURIComponent(raw);
		} catch {
			out[key] = raw;
		}
	});
	return out;
}

interface Credential {
	salt: string;
	hash: string;
}

function hashPassword(password: unknown, salt: string): Credential {
	return {salt, hash: scryptSync(String(password == null ? '' : password), salt, 64).toString('hex')};
}

function timingEqualHex(aHex: string, bHex: string): boolean {
	const a = Buffer.from(aHex, 'hex');
	const b = Buffer.from(bHex, 'hex');
	return a.length === b.length && timingSafeEqual(a, b);
}

/** 长度无关的常量时间比较:两边先做 sha256 */
function timingEqualString(input: unknown, expected: unknown): boolean {
	const a = createHash('sha256').update(String(input == null ? '' : input)).digest();
	const b = createHash('sha256').update(String(expected == null ? '' : expected)).digest();
	return timingSafeEqual(a, b);
}

/** 用到的 Express 请求/响应字段 */
export interface AuthRequest {
	ip?: string;
	secure?: boolean;
	path?: string;
	body?: any;
	headers?: Record<string, string | string[] | undefined>;
	socket?: {remoteAddress?: string};
}

export interface AuthResponse {
	setHeader(name: string, value: string): unknown;
	status(code: number): AuthResponse;
	json(body: unknown): unknown;
	redirect(url: string): unknown;
}

export interface AuthOptions {
	envPassword?: string;
	/** data/config/auth.json */
	authFile?: string;
	ttlMs?: number;
	/** true 总加 Secure;false 从不加;'auto' 请求经 HTTPS(含反代的 X-Forwarded-Proto)时加 */
	cookieSecure?: boolean | 'auto';
	minLength?: number;
	/** 首次设置口令要的初始化令牌;不给就随机生成 */
	setupToken?: string;
	logger?: Pick<Console, 'warn' | 'error'>;
	now?: () => number;
	random?: (bytes: number) => Buffer;
}

interface FailEntry {
	count: number;
	firstAt: number;
	lockedUntil: number;
}

export function createAuth(options: AuthOptions = {}) {
	const envPassword = String(options.envPassword || '');
	const authFile = options.authFile || '';
	const ttlMs = Math.max(60 * 1000, Number(options.ttlMs || 7 * 24 * 60 * 60 * 1000));
	const cookieSecure = options.cookieSecure === undefined ? 'auto' : options.cookieSecure;
	const minLength = Math.max(1, Number(options.minLength || 8));
	const now = options.now ?? Date.now;
	const random = options.random ?? randomBytes;
	const setupToken = String(options.setupToken || '') || random(12).toString('hex');
	const logger = options.logger ?? console;
	const sessions = new Map<string, number>();   // token → 过期时间
	const failsByIp = new Map<string, FailEntry>();
	const globalFails: FailEntry = {count: 0, firstAt: 0, lockedUntil: 0};

	let fileCred: Credential | null = null;
	if (authFile) {
		const raw = readJsonFileSafe(authFile, logger);
		if (raw && raw.salt && raw.hash) {
			fileCred = {salt: String(raw.salt), hash: String(raw.hash)};
		}
	}

	const configured = () => !!fileCred || envPassword.length > 0;

	function passwordMatches(input: unknown): boolean {
		const password = String(input == null ? '' : input);
		if (fileCred) {
			return timingEqualHex(hashPassword(password, fileCred.salt).hash, fileCred.hash);
		}
		return envPassword ? timingEqualString(password, envPassword) : false;
	}

	function persistPassword(newPassword: unknown): void {
		const password = String(newPassword == null ? '' : newPassword);
		if (password.length < minLength) {
			throw new Error(`口令至少 ${minLength} 位`);
		}
		if (!authFile) {
			throw new Error('未配置口令存储路径');
		}
		const cred = hashPassword(password, random(16).toString('hex'));
		writeJsonAtomic(authFile, {salt: cred.salt, hash: cred.hash, updatedAt: now()});
		fileCred = cred;
	}

	// ===== 失败限速 =====

	function clientIp(req: AuthRequest): string {
		return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
	}

	function bumpWindow(entry: FailEntry, at: number): void {
		if (!entry.firstAt || at - entry.firstAt > FAIL_WINDOW_MS) {
			entry.count = 0;
			entry.firstAt = at;
		}
	}

	/** 剩余锁定秒数;0 = 没锁 */
	function lockedSeconds(req: AuthRequest): number {
		const at = now();
		const until = Math.max(failsByIp.get(clientIp(req))?.lockedUntil ?? 0, globalFails.lockedUntil);
		return until > at ? Math.ceil((until - at) / 1000) : 0;
	}

	function recordFailure(req: AuthRequest): void {
		const at = now();
		const ip = clientIp(req);
		let entry = failsByIp.get(ip);
		if (!entry) {
			entry = {count: 0, firstAt: 0, lockedUntil: 0};
			failsByIp.set(ip, entry);
		}
		bumpWindow(entry, at);
		entry.count += 1;
		if (entry.count >= MAX_FAILS_PER_IP) {
			entry.lockedUntil = at + LOCK_MS;
			entry.count = 0;
			logger.warn(`[auth] ${ip} 连续口令错误,锁定 ${LOCK_MS / 60000} 分钟`);
		}
		bumpWindow(globalFails, at);
		globalFails.count += 1;
		if (globalFails.count >= MAX_FAILS_GLOBAL) {
			globalFails.lockedUntil = at + LOCK_MS;
			globalFails.count = 0;
			logger.warn(`[auth] 全局口令错误过多,所有来源锁定 ${LOCK_MS / 60000} 分钟`);
		}
		// 防止被大量伪造来源撑大
		if (failsByIp.size > MAX_TRACKED_IPS) {
			for (const [key, value] of failsByIp) {
				if (value.lockedUntil <= at && at - value.firstAt > FAIL_WINDOW_MS) {
					failsByIp.delete(key);
				}
			}
		}
	}

	function rejectIfLocked(req: AuthRequest, res: AuthResponse): boolean {
		const wait = lockedSeconds(req);
		if (!wait) {
			return false;
		}
		res.setHeader('Retry-After', String(wait));
		res.status(429).json({success: false, error: `尝试次数过多,请 ${Math.ceil(wait / 60)} 分钟后再试`});
		return true;
	}

	// ===== 会话 =====

	function pruneSessions(): void {
		const at = now();
		for (const [token, expiresAt] of sessions) {
			if (expiresAt <= at) {
				sessions.delete(token);
			}
		}
	}

	function isValidToken(token: string | undefined): boolean {
		if (!token) {
			return false;
		}
		const expiresAt = sessions.get(token);
		if (!expiresAt) {
			return false;
		}
		if (expiresAt <= now()) {
			sessions.delete(token);
			return false;
		}
		return true;
	}

	const tokenFromReq = (req: AuthRequest) => parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME] || '';

	function setSessionCookie(req: AuthRequest, res: AuthResponse, token: string, maxAgeSec: number): void {
		const parts = [
			`${COOKIE_NAME}=${token}`,
			'HttpOnly',
			'Path=/',
			'SameSite=Lax',   // 跨站 POST / WebSocket 不带 cookie,挡 CSRF
			`Max-Age=${maxAgeSec}`
		];
		if (cookieSecure === 'auto' ? !!(req && req.secure) : !!cookieSecure) {
			parts.push('Secure');
		}
		res.setHeader('Set-Cookie', parts.join('; '));
	}

	function issueToken(req: AuthRequest, res: AuthResponse): void {
		const token = random(32).toString('hex');
		sessions.set(token, now() + ttlMs);
		setSessionCookie(req, res, token, Math.floor(ttlMs / 1000));
	}

	const isAuthed = (req: AuthRequest) => configured() && isValidToken(tokenFromReq(req));

	// ===== 端点 =====

	function login(req: AuthRequest, res: AuthResponse): unknown {
		if (!configured()) {
			return res.status(409).json({success: false, error: '尚未设置口令', needsSetup: true});
		}
		if (rejectIfLocked(req, res)) {
			return undefined;
		}
		pruneSessions();
		if (!passwordMatches((req.body || {}).password)) {
			recordFailure(req);
			return res.status(401).json({success: false, error: '口令错误'});
		}
		failsByIp.delete(clientIp(req));
		issueToken(req, res);
		return res.json({success: true});
	}

	/** 首次设置口令:只在从没配置过时允许,且必须带初始化令牌;设置后自动登录 */
	function setup(req: AuthRequest, res: AuthResponse): unknown {
		if (configured()) {
			return res.status(409).json({success: false, error: '口令已设置,请使用修改口令'});
		}
		if (rejectIfLocked(req, res)) {
			return undefined;
		}
		const body = req.body || {};
		if (!timingEqualString(String(body.setupToken || '').trim(), setupToken)) {
			recordFailure(req);
			return res.status(403).json({success: false, error: '初始化令牌错误(见服务端启动日志)'});
		}
		try {
			persistPassword(body.password);
		} catch (err) {
			return res.status(400).json({success: false, error: (err as Error).message});
		}
		failsByIp.delete(clientIp(req));
		issueToken(req, res);
		return res.json({success: true});
	}

	/** 修改口令:要已登录,并验证当前口令;成功后其它会话全部失效,当前会话重新签发 */
	function changePassword(req: AuthRequest, res: AuthResponse): unknown {
		if (!isAuthed(req)) {
			return res.status(401).json({success: false, error: 'unauthorized'});
		}
		if (rejectIfLocked(req, res)) {
			return undefined;
		}
		const body = req.body || {};
		if (configured() && !passwordMatches(body.currentPassword)) {
			recordFailure(req);
			return res.status(401).json({success: false, error: '当前口令错误'});
		}
		try {
			persistPassword(body.newPassword);
		} catch (err) {
			return res.status(400).json({success: false, error: (err as Error).message});
		}
		sessions.clear();
		issueToken(req, res);
		return res.json({success: true});
	}

	function logout(req: AuthRequest, res: AuthResponse): unknown {
		const token = tokenFromReq(req);
		if (token) {
			sessions.delete(token);
		}
		setSessionCookie(req, res, '', 0);
		return res.json({success: true});
	}

	function status(req: AuthRequest, res: AuthResponse): unknown {
		return res.json({success: true, configured: configured(), authed: isAuthed(req), minLength});
	}

	/** Express 网关:放行健康检查、鉴权端点、登录页;socket.io 交给 socketAuth;其余未登录 API 401、页面跳登录 */
	function middleware(req: AuthRequest, res: AuthResponse, next: () => void): unknown {
		const path = req.path || '';
		if (path === '/healthz' || path.startsWith('/api/auth/') || path === '/login' || path === '/login.html' || path.startsWith('/socket.io/')) {
			return next();
		}
		if (isAuthed(req)) {
			return next();
		}
		if (path.startsWith('/api/')) {
			return res.status(401).json({success: false, error: 'unauthorized'});
		}
		// 新版前端(/next/)登录后回到新版;只认这一个固定地址,不接受任意跳转
		return res.redirect(path === '/next' || path.startsWith('/next/') ? '/login?next=%2Fnext%2F' : '/login');
	}

	function socketAuth(socket: {handshake?: {headers?: Record<string, unknown>}}, next: (err?: Error) => void): void {
		const token = parseCookies(socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie)[COOKIE_NAME];
		if (isValidToken(token)) {
			next();
			return;
		}
		next(new Error('unauthorized'));
	}

	return {
		COOKIE_NAME,
		get configured() {
			return configured();
		},
		get setupToken() {
			return setupToken;
		},
		isAuthed,
		login,
		logout,
		status,
		setup,
		changePassword,
		middleware,
		socketAuth
	};
}

export type Auth = ReturnType<typeof createAuth>;
