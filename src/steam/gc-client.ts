// 游戏协调器(GC)操作:发请求等回包、切换/断开当前游戏、等 GC 连上(从 app/server.js 原样移来)。
// 依赖 steam-user 的 sendToGC / receivedFromGC,以及 attempt 上挂的 GC 模块(globaloffensive / tf2)。

import type {EventEmitter} from 'node:events';
import type {Attempt} from './session-manager.ts';
import {gameConfig, normalizeGame} from './games.ts';

export const DEFAULT_GC_TIMEOUT_MS = 15000;

/** protobufjs 生成的消息类型里用到的几个方法 */
export interface ProtoType<T = Record<string, unknown>> {
	encode(message: unknown): {finish(): Uint8Array};
	decode(payload: Uint8Array): unknown;
	toObject(message: unknown, options: Record<string, unknown>): T;
}

type GcCallback = (appid: number, msgType: number, payload: Uint8Array) => void;

interface GcCapableClient extends EventEmitter {
	sendToGC(appid: number, msgType: number, protoHeader: Record<string, unknown>, payload: Uint8Array, callback?: GcCallback): void;
	gamesPlayed(apps: number[]): void;
	webLogOn(): void;
}

function gcError(message: string, statusCode: number): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function gcClient(attempt: Attempt | null | undefined): GcCapableClient | null {
	const client = attempt && (attempt.client as unknown as GcCapableClient | null);
	return client && typeof client.sendToGC === 'function' ? client : null;
}

/**
 * 发一条 GC 请求并等对应的回包(按 appid + 回包消息号匹配)。
 * 回包既可能走 sendToGC 的回调,也可能走 receivedFromGC 事件,两路都听,先到先用。
 */
export function sendGcRequest<T = Record<string, unknown>>(
	attempt: Attempt,
	game: unknown,
	requestMsgType: number,
	requestProto: ProtoType,
	body: unknown,
	responseMsgType: number,
	responseProto: ProtoType<T>,
	options: {timeoutMs?: number} = {}
): Promise<T> {
	const config = gameConfig(game);
	const client = gcClient(attempt);
	if (!client) {
		return Promise.reject(gcError('当前账号没有可用的 Steam GC 客户端', 409));
	}
	if (!attempt[config.gcStateKey]) {
		return Promise.reject(gcError(`当前账号尚未连接 ${config.label} GC`, 409));
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			clearTimeout(timeout);
			client.removeListener('receivedFromGC', onReceivedFromGc);
		};
		const finish = (handler: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			handler();
		};
		const handleResponsePayload: GcCallback = (appid, msgType, payload) => {
			if (appid !== config.appId || msgType !== responseMsgType) {
				return;
			}
			finish(() => {
				try {
					const decoded = responseProto.decode(payload);
					resolve(responseProto.toObject(decoded, {longs: String, bytes: Buffer}));
				} catch (err) {
					reject(new Error(`GC 响应解码失败: ${(err as Error).message}`));
				}
			});
		};
		const onReceivedFromGc: GcCallback = (appid, msgType, payload) => {
			handleResponsePayload(appid, msgType, payload);
		};
		timeout = setTimeout(() => {
			finish(() => reject(new Error(`GC 请求超时 msg=${requestMsgType}`)));
		}, Math.max(1000, Number(options.timeoutMs || DEFAULT_GC_TIMEOUT_MS)));

		try {
			client.on('receivedFromGC', onReceivedFromGc);
			client.sendToGC(config.appId, requestMsgType, {}, requestProto.encode(body || {}).finish(), handleResponsePayload);
		} catch (err) {
			finish(() => reject(err));
		}
	});
}

/** gcConnected(旧字段,前端用)只跟 CS2 */
export function updateDefaultGcState(attempt: Attempt | null | undefined): void {
	if (!attempt) {
		return;
	}
	attempt.gcConnected = !!attempt.cs2GcConnected;
	if (!attempt.activeGame) {
		attempt.activeGame = 'cs2';
	}
}

/**
 * 让账号"进入"指定游戏(gamesPlayed),GC 连上后由 GC 模块的 connectedToGC 事件置连接标记。
 * 同一时间只能在一款游戏里:切到 TF2 会断开 CS2 的 GC,反之亦然。已在该游戏且已连接时什么都不做。
 */
export function ensureGameSession(attempt: Attempt | null | undefined, game: unknown): boolean {
	const client = attempt && (attempt.client as unknown as GcCapableClient | null);
	if (!attempt || !client) {
		return false;
	}
	const config = gameConfig(game);
	const nextGame = normalizeGame(config.id);
	const currentGame = normalizeGame(attempt.activeGame);
	if (currentGame === nextGame && attempt[config.gcStateKey]) {
		return true;
	}
	if (nextGame === 'tf2') {
		attempt.cs2GcConnected = false;
		attempt.gcConnected = false;
	} else {
		attempt.tf2GcConnected = false;
	}
	attempt[config.gcStateKey] = false;
	attempt.activeGame = config.id;
	client.gamesPlayed([config.appId]);
	try {
		client.webLogOn();
	} catch {
		// 刷新 web 会话失败不影响进游戏
	}
	updateDefaultGcState(attempt);
	return true;
}

/** 退出游戏(gamesPlayed([])),清掉 GC 连接标记和库存缓存 */
export function disconnectGameSession(attempt: Attempt | null | undefined, game?: unknown): boolean {
	const client = attempt && (attempt.client as unknown as GcCapableClient | null);
	if (!attempt || !client) {
		return false;
	}
	try {
		client.gamesPlayed([]);
	} catch {
		// 忽略
	}
	attempt.gcConnected = false;
	attempt.cs2GcConnected = false;
	attempt.tf2GcConnected = false;
	attempt.inventoryCount = 0;
	attempt.inventorySource = '';
	attempt.inventoryCache = null;
	attempt.communityInvTriedAt = 0;
	attempt.inventoryInflight = null;
	if (game) {
		attempt.activeGame = normalizeGame(game);
	}
	return true;
}

/** 等指定游戏的 GC 连上(已连上立即返回);GC 模块报错或超时则失败 */
export function waitForGcConnection(attempt: Attempt | null | undefined, game: unknown, timeoutMs = DEFAULT_GC_TIMEOUT_MS): Promise<void> {
	const config = gameConfig(game);
	if (attempt && attempt[config.gcStateKey]) {
		return Promise.resolve();
	}
	const module = attempt ? (attempt[config.moduleKey] as EventEmitter | null | undefined) : null;
	if (!module || typeof module.once !== 'function') {
		return Promise.reject(new Error(`当前账号缺少 ${config.label} GC 模块`));
	}
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (handler: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			module.removeListener('connectedToGC', onConnected);
			module.removeListener('error', onError);
			handler();
		};
		const onConnected = () => finish(resolve);
		const onError = (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err || 'GC error'))));
		timer = setTimeout(() => {
			finish(() => reject(new Error(`等待 ${config.label} GC 连接超时`)));
		}, Math.max(1000, Number(timeoutMs || 0)));
		module.once('connectedToGC', onConnected);
		module.once('error', onError);
	});
}
