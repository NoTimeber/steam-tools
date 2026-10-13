'use strict';

// 轻量口令登录鉴权(无额外依赖)。
// 口令来源优先级:
//   1) data/config/auth.json(网页里设置/修改,scrypt 哈希存储)—— 最高
//   2) APP_PASSWORD 环境变量(明文,仅作引导/兼容)
//   3) 都没有 = "未配置":除首次设置接口与登录页外一律锁定,网页引导设初始口令。
//      首次设置必须提供启动日志里打印的「初始化令牌」,防止部署到公网后被别人抢先设置。
// 会话 token 存内存(进程重启=全部失效)。同时守护 Express 路由/静态与 Socket.io 握手。

const crypto = require('crypto');
const {writeJsonAtomic, readJsonFileSafe} = require('./atomic-file');

const COOKIE_NAME = 'sid';

// 登录失败限速:同一 IP 窗口内失败 MAX_FAILS_PER_IP 次锁定 LOCK_MS;
// 全局窗口内失败 MAX_FAILS_GLOBAL 次(防多 IP 分布式爆破)也锁定。
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 50;

function parseCookies(header) {
	const out = Object.create(null);
	String(header || '').split(';').forEach(part => {
		const idx = part.indexOf('=');
		if (idx === -1) return;
		const key = part.slice(0, idx).trim();
		if (!key) return;
		const raw = part.slice(idx + 1).trim();
		try {
			out[key] = decodeURIComponent(raw);
		} catch (_) {
			out[key] = raw; // 畸形编码不抛异常(否则 socket 握手里会变成未捕获异常)
		}
	});
	return out;
}

function hashPassword(password, saltHex) {
	const salt = saltHex || crypto.randomBytes(16).toString('hex');
	const hash = crypto.scryptSync(String(password == null ? '' : password), salt, 64).toString('hex');
	return {salt, hash};
}

function timingEqualHex(aHex, bHex) {
	const a = Buffer.from(aHex, 'hex');
	const b = Buffer.from(bHex, 'hex');
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

function timingEqualString(input, expected) {
	const a = crypto.createHash('sha256').update(String(input == null ? '' : input)).digest();
	const b = crypto.createHash('sha256').update(String(expected == null ? '' : expected)).digest();
	return crypto.timingSafeEqual(a, b);
}

function createAuth(options = {}) {
	const envPassword = String(options.envPassword || '');
	const authFile = options.authFile || '';
	const ttlMs = Math.max(60 * 1000, Number(options.ttlMs || 7 * 24 * 60 * 60 * 1000));
	// cookieSecure: true=总是加 Secure;false=从不加;'auto'=请求经 HTTPS(含反代 X-Forwarded-Proto)时加。
	const cookieSecure = options.cookieSecure === undefined ? 'auto' : options.cookieSecure;
	const minLength = Math.max(1, Number(options.minLength || 8));
	const setupToken = String(options.setupToken || '') || crypto.randomBytes(12).toString('hex');
	const logger = options.logger || console;
	const sessions = new Map(); // token -> expiresAt(ms)
	const failsByIp = new Map(); // ip -> {count, firstAt, lockedUntil}
	const globalFails = {count: 0, firstAt: 0, lockedUntil: 0};

	let fileCred = null; // {salt, hash}

	function loadFileCred() {
		fileCred = null;
		if (!authFile) return;
		const raw = readJsonFileSafe(authFile, logger);
		if (raw && raw.salt && raw.hash) {
			fileCred = {salt: String(raw.salt), hash: String(raw.hash)};
		}
	}
	loadFileCred();

	function configured() {
		return !!fileCred || envPassword.length > 0;
	}

	function passwordMatches(input) {
		const pwd = String(input == null ? '' : input);
		if (fileCred) {
			const {hash} = hashPassword(pwd, fileCred.salt);
			return timingEqualHex(hash, fileCred.hash);
		}
		if (envPassword) {
			return timingEqualString(pwd, envPassword);
		}
		return false;
	}

	function persistPassword(newPassword) {
		const pwd = String(newPassword == null ? '' : newPassword);
		if (pwd.length < minLength) {
			throw new Error(`口令至少 ${minLength} 位`);
		}
		if (!authFile) {
			throw new Error('未配置口令存储路径');
		}
		const cred = hashPassword(pwd);
		writeJsonAtomic(authFile, {salt: cred.salt, hash: cred.hash, updatedAt: Date.now()});
		fileCred = cred;
	}

	// ===== 失败限速 =====
	function clientIp(req) {
		return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
	}

	function bumpWindow(entry, now) {
		if (!entry.firstAt || now - entry.firstAt > FAIL_WINDOW_MS) {
			entry.count = 0;
			entry.firstAt = now;
		}
	}

	// 返回剩余锁定秒数;0 = 未锁定
	function lockedSeconds(req) {
		const now = Date.now();
		const ipEntry = failsByIp.get(clientIp(req));
		const until = Math.max(ipEntry ? ipEntry.lockedUntil : 0, globalFails.lockedUntil);
		return until > now ? Math.ceil((until - now) / 1000) : 0;
	}

	function recordFailure(req) {
		const now = Date.now();
		const ip = clientIp(req);
		let entry = failsByIp.get(ip);
		if (!entry) {
			entry = {count: 0, firstAt: 0, lockedUntil: 0};
			failsByIp.set(ip, entry);
		}
		bumpWindow(entry, now);
		entry.count += 1;
		if (entry.count >= MAX_FAILS_PER_IP) {
			entry.lockedUntil = now + LOCK_MS;
			entry.count = 0;
			logger.warn(`[auth] ${ip} 连续口令错误,锁定 ${LOCK_MS / 60000} 分钟`);
		}
		bumpWindow(globalFails, now);
		globalFails.count += 1;
		if (globalFails.count >= MAX_FAILS_GLOBAL) {
			globalFails.lockedUntil = now + LOCK_MS;
			globalFails.count = 0;
			logger.warn(`[auth] 全局口令错误过多,所有来源锁定 ${LOCK_MS / 60000} 分钟`);
		}
		// 防止 Map 被大量伪造来源撑大
		if (failsByIp.size > 10000) {
			for (const [key, value] of failsByIp) {
				if (value.lockedUntil <= now && now - value.firstAt > FAIL_WINDOW_MS) failsByIp.delete(key);
			}
		}
	}

	function recordSuccess(req) {
		failsByIp.delete(clientIp(req));
	}

	function rejectIfLocked(req, res) {
		const wait = lockedSeconds(req);
		if (!wait) return false;
		res.setHeader('Retry-After', String(wait));
		res.status(429).json({success: false, error: `尝试次数过多,请 ${Math.ceil(wait / 60)} 分钟后再试`});
		return true;
	}

	// ===== 会话 =====
	function pruneSessions() {
		const now = Date.now();
		for (const [token, exp] of sessions) {
			if (exp <= now) sessions.delete(token);
		}
	}

	function isValidToken(token) {
		if (!token) return false;
		const exp = sessions.get(token);
		if (!exp) return false;
		if (exp <= Date.now()) {
			sessions.delete(token);
			return false;
		}
		return true;
	}

	function tokenFromReq(req) {
		return parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME] || '';
	}

	function issueToken(req, res) {
		const token = crypto.randomBytes(32).toString('hex');
		sessions.set(token, Date.now() + ttlMs);
		setSessionCookie(req, res, token, Math.floor(ttlMs / 1000));
		return token;
	}

	function shouldSetSecure(req) {
		if (cookieSecure === 'auto') return !!(req && req.secure);
		return !!cookieSecure;
	}

	function setSessionCookie(req, res, token, maxAgeSec) {
		const parts = [
			`${COOKIE_NAME}=${token}`,
			'HttpOnly',
			'Path=/',
			'SameSite=Lax', // 跨站 POST/WebSocket 不带 cookie,挡 CSRF
			`Max-Age=${maxAgeSec}`
		];
		if (shouldSetSecure(req)) parts.push('Secure');
		res.setHeader('Set-Cookie', parts.join('; '));
	}

	function isAuthed(req) {
		if (!configured()) return false;
		return isValidToken(tokenFromReq(req));
	}

	function login(req, res) {
		if (!configured()) {
			return res.status(409).json({success: false, error: '尚未设置口令', needsSetup: true});
		}
		if (rejectIfLocked(req, res)) return;
		pruneSessions();
		if (!passwordMatches((req.body || {}).password)) {
			recordFailure(req);
			return res.status(401).json({success: false, error: '口令错误'});
		}
		recordSuccess(req);
		issueToken(req, res);
		res.json({success: true});
	}

	// 首次设置口令:仅当从未配置过时允许,且必须提供启动日志里的初始化令牌。设置后自动登录。
	function setup(req, res) {
		if (configured()) {
			return res.status(409).json({success: false, error: '口令已设置,请使用修改口令'});
		}
		if (rejectIfLocked(req, res)) return;
		const body = req.body || {};
		if (!timingEqualString(String(body.setupToken || '').trim(), setupToken)) {
			recordFailure(req);
			return res.status(403).json({success: false, error: '初始化令牌错误(见服务端启动日志)'});
		}
		try {
			persistPassword(body.password);
		} catch (err) {
			return res.status(400).json({success: false, error: err.message});
		}
		recordSuccess(req);
		issueToken(req, res);
		res.json({success: true});
	}

	// 修改口令:需已登录;若已配置则必须验证当前口令。
	function changePassword(req, res) {
		if (!isAuthed(req)) {
			return res.status(401).json({success: false, error: 'unauthorized'});
		}
		if (rejectIfLocked(req, res)) return;
		const body = req.body || {};
		if (configured() && !passwordMatches(body.currentPassword)) {
			recordFailure(req);
			return res.status(401).json({success: false, error: '当前口令错误'});
		}
		try {
			persistPassword(body.newPassword);
		} catch (err) {
			return res.status(400).json({success: false, error: err.message});
		}
		// 重置其它会话,保留当前会话(重新签发)
		sessions.clear();
		issueToken(req, res);
		res.json({success: true});
	}

	function logout(req, res) {
		const token = tokenFromReq(req);
		if (token) sessions.delete(token);
		setSessionCookie(req, res, '', 0);
		res.json({success: true});
	}

	function status(req, res) {
		res.json({success: true, configured: configured(), authed: isAuthed(req), minLength});
	}

	// Express 网关:放行健康检查/鉴权端点/登录页/Socket.IO。
	// Socket.IO 请求不在 Express 层做鉴权——交给 io.use(socketAuth) 处理。
	function middleware(req, res, next) {
		const reqPath = req.path || '';
		if (reqPath === '/healthz' || reqPath.startsWith('/api/auth/') || reqPath === '/login' || reqPath === '/login.html') {
			return next();
		}
		if (reqPath.startsWith('/socket.io/')) {
			return next(); // 鉴权由 Socket.IO 中间件负责
		}
		if (isAuthed(req)) return next();
		if (reqPath.startsWith('/api/')) {
			return res.status(401).json({success: false, error: 'unauthorized'});
		}
		return res.redirect('/login');
	}

	function socketAuth(socket, next) {
		const token = parseCookies(socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie)[COOKIE_NAME];
		if (isValidToken(token)) return next();
		next(new Error('unauthorized'));
	}

	return {
		COOKIE_NAME,
		get configured() { return configured(); },
		get setupToken() { return setupToken; },
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

module.exports = {createAuth, parseCookies};
