'use strict';

// 轻量口令登录鉴权(无额外依赖)。
// 口令来源优先级:
//   1) data/config/auth.json(网页里设置/修改,scrypt 哈希存储)—— 最高
//   2) APP_PASSWORD 环境变量(明文,仅作引导/兼容)
//   3) 都没有 = "未配置":除首次设置接口与登录页外一律锁定,网页引导设初始口令。
// 会话 token 存内存(进程重启=全部失效)。同时守护 Express 路由/静态与 Socket.io 握手。

const crypto = require('crypto');
const fs = require('fs');

const COOKIE_NAME = 'sid';

function parseCookies(header) {
	const out = Object.create(null);
	String(header || '').split(';').forEach(part => {
		const idx = part.indexOf('=');
		if (idx === -1) return;
		const key = part.slice(0, idx).trim();
		if (!key) return;
		out[key] = decodeURIComponent(part.slice(idx + 1).trim());
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

function createAuth(options = {}) {
	const envPassword = String(options.envPassword || '');
	const authFile = options.authFile || '';
	const ttlMs = Math.max(60 * 1000, Number(options.ttlMs || 7 * 24 * 60 * 60 * 1000));
	const cookieSecure = !!options.cookieSecure;
	const minLength = Math.max(1, Number(options.minLength || 4));
	const sessions = new Map(); // token -> expiresAt(ms)

	let fileCred = null; // {salt, hash}

	function loadFileCred() {
		fileCred = null;
		if (!authFile) return;
		try {
			const raw = JSON.parse(fs.readFileSync(authFile, 'utf8'));
			if (raw && raw.salt && raw.hash) {
				fileCred = {salt: String(raw.salt), hash: String(raw.hash)};
			}
		} catch (err) {
			fileCred = null;
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
			const a = Buffer.from(pwd);
			const b = Buffer.from(envPassword);
			if (a.length !== b.length) {
				crypto.timingSafeEqual(b, b);
				return false;
			}
			return crypto.timingSafeEqual(a, b);
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
		fs.writeFileSync(authFile, JSON.stringify({salt: cred.salt, hash: cred.hash, updatedAt: Date.now()}, null, 2), 'utf8');
		fileCred = cred;
	}

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

	function issueToken(res) {
		const token = crypto.randomBytes(32).toString('hex');
		sessions.set(token, Date.now() + ttlMs);
		setSessionCookie(res, token, Math.floor(ttlMs / 1000));
		return token;
	}

	function setSessionCookie(res, token, maxAgeSec) {
		const parts = [
			`${COOKIE_NAME}=${token}`,
			'HttpOnly',
			'Path=/',
			`Max-Age=${maxAgeSec}`
		];
		if (cookieSecure) parts.push('Secure');
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
		pruneSessions();
		if (!passwordMatches((req.body || {}).password)) {
			return res.status(401).json({success: false, error: '口令错误'});
		}
		issueToken(res);
		res.json({success: true});
	}

	// 首次设置口令:仅当从未配置过时允许,设置后自动登录。
	function setup(req, res) {
		if (configured()) {
			return res.status(409).json({success: false, error: '口令已设置,请使用修改口令'});
		}
		try {
			persistPassword((req.body || {}).password);
		} catch (err) {
			return res.status(400).json({success: false, error: err.message});
		}
		issueToken(res);
		res.json({success: true});
	}

	// 修改口令:需已登录;若已配置则必须验证当前口令。
	function changePassword(req, res) {
		if (!isAuthed(req)) {
			return res.status(401).json({success: false, error: 'unauthorized'});
		}
		const body = req.body || {};
		if (configured() && !passwordMatches(body.currentPassword)) {
			return res.status(401).json({success: false, error: '当前口令错误'});
		}
		try {
			persistPassword(body.newPassword);
		} catch (err) {
			return res.status(400).json({success: false, error: err.message});
		}
		// 重置其它会话,保留当前会话(重新签发)
		sessions.clear();
		issueToken(res);
		res.json({success: true});
	}

	function logout(req, res) {
		const token = tokenFromReq(req);
		if (token) sessions.delete(token);
		setSessionCookie(res, '', 0);
		res.json({success: true});
	}

	function status(req, res) {
		res.json({success: true, configured: configured(), authed: isAuthed(req)});
	}

	// Express 网关:放行健康检查/鉴权端点/登录页/Socket.IO。
	// Socket.IO 请求不在 Express 层做鉴权——交给 io.use(socketAuth) 处理。
	function middleware(req, res, next) {
		const reqPath = req.path || '';
		if (reqPath === '/api/health' || reqPath.startsWith('/api/auth/') || reqPath === '/login' || reqPath === '/login.html') {
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
