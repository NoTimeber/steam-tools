// Express 应用的外壳:安全头、同源校验、登录页和鉴权端点、登录网关、前端静态资源,
// 网关之后挂各模块的路由(src/<模块>/routes.ts),最后是兜底的 JSON 错误处理。

import {createRequire} from 'node:module';
import type {Auth} from '../core/auth.ts';
import {jsonErrorHandler} from './http.ts';
import type {ErrorHandler, Handler, Response, Router} from './http.ts';

const require = createRequire(import.meta.url);

interface StaticOptions {
	etag: boolean;
	lastModified: boolean;
	maxAge: number;
	setHeaders(res: Response, filePath: string): void;
}

export interface ExpressApp extends Router {
	(req: unknown, res: unknown): void;
	disable(setting: string): unknown;
	set(setting: string, value: unknown): unknown;
	use(handler: Handler | ErrorHandler): unknown;
	use(path: string, handler: Handler): unknown;
}

interface Express {
	(): ExpressApp;
	json(options: {limit: string}): Handler;
	static(root: string, options: StaticOptions): Handler;
}

export interface WebAppOptions {
	auth: Pick<Auth, 'login' | 'logout' | 'status' | 'setup' | 'changePassword' | 'middleware'>;
	/** 浏览器带的 Origin 必须和请求的 Host 同域,或在 ALLOWED_ORIGINS 里(见 ../core/http.ts) */
	isAllowedOrigin(headers: Record<string, unknown>): boolean;
	/** 反代信任设置(Express 的 trust proxy) */
	trustProxy: string | number | boolean;
	/** 旧版前端静态资源目录(app/public),挂在 / */
	publicDir: string;
	/** 新版前端构建产物(web/dist),挂在 /next/;没构建时目录不存在,访问 404 */
	webDir?: string;
	/** 登录之后才能访问的路由,按顺序注册 */
	routes: ReadonlyArray<(router: Router) => void>;
	logger?: Pick<Console, 'error'>;
}

function noStore(res: Response): void {
	res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
	res.setHeader('Pragma', 'no-cache');
	res.setHeader('Expires', '0');
	res.setHeader('Surrogate-Control', 'no-store');
}

export function createWebApp(options: WebAppOptions): ExpressApp {
	const express = require('express') as Express;
	const {auth, isAllowedOrigin} = options;
	const app = express();

	// 反代后面要信任 X-Forwarded-*,才能拿到真实客户端 IP(登录限速)和是否 HTTPS(Secure cookie)。
	app.set('trust proxy', options.trustProxy);
	app.disable('x-powered-by');
	const securityHeaders: Handler = (req, res, next) => {
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('X-Frame-Options', 'DENY');
		res.setHeader('Referrer-Policy', 'same-origin');
		next();
	};
	// 非幂等请求一律做同源校验(含 /api/auth/*,防登录 CSRF)
	const sameOrigin: Handler = (req, res, next) => {
		if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
		if (isAllowedOrigin(req.headers)) return next();
		res.status(403).json({success: false, error: '来源校验失败,跨站请求已拒绝'});
	};
	app.use(securityHeaders);
	app.use(sameOrigin);
	app.use(express.json({limit: '1mb'}));

	// 容器/反代健康检查:无需登录,不暴露任何运行状态
	app.get('/healthz', (req, res) => {
		res.json({ok: true});
	});

	// ===== 鉴权(公开端点,先于网关注册) =====
	app.get('/login', (req, res) => {
		// 用 root 传目录:否则 send 会检查整条绝对路径,安装目录里有点开头的目录(如 ~/.local)时直接 404
		res.sendFile('login.html', {root: options.publicDir});
	});
	app.post('/api/auth/login', (req, res) => auth.login(req, res));
	app.post('/api/auth/logout', (req, res) => auth.logout(req, res));
	app.get('/api/auth/status', (req, res) => auth.status(req, res));
	app.post('/api/auth/setup', (req, res) => auth.setup(req, res));
	app.post('/api/auth/password', (req, res) => auth.changePassword(req, res));

	// 网关:其余所有请求(含静态资源、API、socket.io)未登录一律拦截
	const gateway: Handler = (req, res, next) => auth.middleware(req, res, next);
	app.use(gateway);

	if (options.webDir) {
		// Vite 产物:assets/ 下文件名带内容哈希,可以长缓存;入口 index.html 每次都要新的
		app.use('/next', express.static(options.webDir, {
			etag: false,
			lastModified: false,
			maxAge: 0,
			setHeaders(res, filePath) {
				if (/[\\/]assets[\\/]/u.test(String(filePath || ''))) {
					res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
				} else {
					noStore(res);
				}
			}
		}));
	}
	app.use(express.static(options.publicDir, {
		etag: false,
		lastModified: false,
		maxAge: 0,
		setHeaders(res, filePath) {
			if (/\.(?:html|js|css)$/iu.test(String(filePath || ''))) {
				noStore(res);
			}
		}
	}));

	for (const register of options.routes) {
		register(app);
	}

	app.use(jsonErrorHandler(options.logger));
	return app;
}
