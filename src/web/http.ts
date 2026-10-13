// HTTP 路由用到的 Express 类型(只声明用到的字段,仓库不装 @types/express)和几个通用包装。
// 各模块的路由在 src/<模块>/routes.ts,由 src/web/app.ts 挂到网关之后。

import {normalizeGame} from '../steam/games.ts';
import type {GameId} from '../steam/games.ts';

export interface Request {
	params: Record<string, string>;
	query: Record<string, any>;
	body: any;
	headers: Record<string, string | string[] | undefined>;
	method: string;
	path: string;
	ip?: string;
	secure?: boolean;
	socket?: {remoteAddress?: string};
}

export interface Response {
	headersSent: boolean;
	status(code: number): Response;
	json(body: unknown): unknown;
	setHeader(name: string, value: string): unknown;
	redirect(url: string): unknown;
	sendFile(file: string, options: {root: string}): unknown;
}

export type Next = (err?: unknown) => void;
export type Handler = (req: Request, res: Response, next: Next) => unknown;
export type ErrorHandler = (err: unknown, req: Request, res: Response, next: Next) => unknown;

/** 各模块注册路由用的那部分 Express 应用 */
export interface Router {
	get(path: string, ...handlers: Handler[]): unknown;
	post(path: string, ...handlers: Handler[]): unknown;
	delete(path: string, ...handlers: Handler[]): unknown;
}

/** 服务层抛的错误:带 statusCode 的按它返回,其余 500 */
export function sendError(res: Response, err: unknown, fallback: string): void {
	const error = err as {statusCode?: number; message?: string} | null | undefined;
	res.status(error && error.statusCode || 500).json({success: false, error: error && error.message || fallback});
}

/** 成功时把返回对象并进 {success: true},失败按 statusCode 返回 */
export function spreadRoute(run: (req: Request) => unknown, fallback: string): Handler {
	return async (req, res) => {
		try {
			res.json({success: true, ...await run(req) as object});
		} catch (err) {
			sendError(res, err, fallback);
		}
	};
}

/** 成功时返回 {success: true, [key]: 结果} */
export function keyedRoute(key: string, run: (req: Request) => unknown, fallback: string): Handler {
	return async (req, res) => {
		try {
			res.json({success: true, [key]: await run(req)});
		} catch (err) {
			sendError(res, err, fallback);
		}
	};
}

/** 调试端点(会返回 Steam cookies / 可触发真实下单)默认关闭,ENABLE_DEBUG_ENDPOINTS=1 才开 */
export function debugOnly(enabled: boolean): Handler {
	return (req, res, next) => {
		if (enabled) {
			return next();
		}
		res.status(404).json({success: false, error: 'not found'});
	};
}

/** ?game=cs2|tf2 或 body.game,缺省 cs2 */
export function requestGame(req: Request): GameId {
	return normalizeGame(req && req.query && req.query.game || req && req.body && req.body.game);
}

/**
 * 兜底错误处理(挂在最后):路由里没接住的异常、请求体不是合法 JSON 等,也回 JSON。
 * 4xx 照实说原因;5xx 不把内部错误信息和堆栈发给浏览器,只记日志。
 */
export function jsonErrorHandler(logger: Pick<Console, 'error'> = console) {
	const handler: ErrorHandler = (err, req, res, next) => {
		if (res.headersSent) {
			return next(err);
		}
		const error = err as {status?: number; statusCode?: number; message?: string; expose?: boolean} | null | undefined;
		const status = Number(error && (error.status || error.statusCode)) || 500;
		if (status >= 500) {
			logger.error(`[http] ${req.method} ${req.path} 出错:`, err);
			return res.status(status).json({success: false, error: '服务器内部错误'});
		}
		return res.status(status).json({success: false, error: error && error.expose !== false && error.message || '请求无效'});
	};
	return handler;
}
