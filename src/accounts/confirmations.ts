// 账户管理「令牌确认」:读某个账号 Steam 手机令牌里的待确认项(交易报价、市场上架、求购……),逐条或批量确认 / 拒绝。
//
// mobileconf 请求走 ../steam/confirmations.ts(和求购、UU 发货同一套:签名、设备 ID 回退、按出口排队、429 等一会再试)。
// 在线的账号用会话里的 cookie,不在线的用上次登录存下的(失效了 Steam 会要求重新登录);identity_secret 只从 maFile 取。
// 确认项的 nonce 留在服务端:确认 / 拒绝只认最近一次读到的列表里的 id,对不上(已处理过、列表过期)就要先刷新,
// 免得照着浏览器里的旧列表误操作。同一个账号的读取和提交排成一队,连点两下不会把同一条提交两次。

import type {Attempt} from '../steam/session-manager.ts';
import type {Confirmation, Confirmer, ConfirmLog} from '../steam/confirmations.ts';

/** 下发给浏览器的待确认项(不含 nonce) */
export interface PublicConfirmation {
	id: string;
	/** 交易报价 id、上架 / 求购单 id 等 */
	creator: string;
	type: number;
	typeName: string;
	headline: string;
	summary: string[];
	icon: string;
	/** 创建时间(毫秒);不知道为 0 */
	createdAt: number;
	acceptText: string;
	cancelText: string;
	warn: string;
}

export interface ConfirmationList {
	accountName: string;
	confirmations: PublicConfirmation[];
	/** 这份列表是什么时候从 Steam 读的(毫秒) */
	fetchedAt: number;
}

export interface RespondResult extends ConfirmationList {
	/** 这次处理掉的确认项 id */
	done: string[];
	accept: boolean;
}

type Level = 'info' | 'warn' | 'error';

export interface AccountConfirmationsOptions {
	/** 名单里的账号名(按名单的大小写);不在名单里给 null */
	accountNameOf: (raw: string) => string | null;
	findAttempt: (accountName: string) => Attempt | undefined;
	cookiesFor: (attempt: Partial<Pick<Attempt, 'cookies' | 'accountName' | 'steamID' | 'id'>>) => string[];
	/** maFile 里的东西(identity_secret、device_id、SteamID) */
	profileOf: (accountName: string) => {identitySecret: string; deviceId: string; steamID?: string};
	confirmer: Pick<Confirmer, 'listConfirmations' | 'respondToConfirmations'>;
	/** 写进账号的会话日志(在线时) */
	addLog: (attempt: Attempt, level: Level, message: string) => void;
	now?: () => number;
}

export class ConfirmationError extends Error {
	statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

const TYPE_LABELS: Record<number, string> = {
	1: '测试',
	2: '交易报价',
	3: '市场上架',
	4: '功能变更',
	5: '更换手机号',
	6: '账户恢复',
	9: '创建 API Key',
	11: '加入家庭组',
	12: '市场求购'
};

/** 日志里说这一条是什么:类型 + 标题 */
function describe(conf: Confirmation): string {
	const type = TYPE_LABELS[Number(conf.type)] || conf.typeName || `类型 ${String(conf.type)}`;
	return conf.headline ? `${type}「${conf.headline}」` : type;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createAccountConfirmations(options: AccountConfirmationsOptions) {
	const now = options.now ?? Date.now;
	/** 各账号最近一次读到的列表(含 nonce),key 是小写账号名 */
	const lists = new Map<string, {confirmations: Confirmation[]; fetchedAt: number}>();
	/** 各账号排队中的操作 */
	const queues = new Map<string, Promise<unknown>>();

	function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
		const previous = queues.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(run);
		queues.set(key, next);
		void next.catch(() => {}).finally(() => {
			if (queues.get(key) === next) {
				queues.delete(key);
			}
		});
		return next;
	}

	function account(raw: unknown) {
		const wanted = String(raw ?? '').trim();
		if (!wanted) {
			throw new ConfirmationError(400, '缺少账号名');
		}
		const accountName = options.accountNameOf(wanted);
		if (!accountName) {
			throw new ConfirmationError(404, '账号不在账户名单里');
		}
		const profile = options.profileOf(accountName);
		if (!String(profile.identitySecret || '').trim()) {
			throw new ConfirmationError(409, '这个账号没有导入 maFile(identity_secret),用不了令牌确认');
		}
		const attempt = options.findAttempt(accountName);
		// 不在线时用上次登录存下的网页 cookie
		const cookies = options.cookiesFor(attempt ?? {accountName});
		if (!cookies.length) {
			throw new ConfirmationError(409, '没有网页会话 cookie,请先登录这个账号');
		}
		const log: ConfirmLog = (level, message) => {
			if (attempt) {
				options.addLog(attempt, level, `令牌确认:${message}`);
			}
		};
		return {
			key: accountName.toLowerCase(),
			accountName,
			attempt,
			params: {
				cookies,
				identitySecret: profile.identitySecret,
				steamID: attempt?.steamID || profile.steamID || '',
				deviceId: profile.deviceId || '',
				userAgent: attempt?.userAgent || '',
				log
			}
		};
	}

	function publicList(accountName: string, entry: {confirmations: Confirmation[]; fetchedAt: number}): ConfirmationList {
		return {
			accountName,
			fetchedAt: entry.fetchedAt,
			confirmations: entry.confirmations.map(conf => ({
				id: conf.id,
				creator: conf.creator,
				type: Number(conf.type) || 0,
				typeName: conf.typeName,
				headline: conf.headline,
				summary: [...conf.summary],
				icon: conf.icon,
				createdAt: conf.createdAt * 1000,
				acceptText: conf.acceptText,
				cancelText: conf.cancelText,
				warn: conf.warn
			}))
		};
	}

	/** 从 Steam 重新读这个账号的待确认项 */
	function list(rawAccountName: unknown): Promise<ConfirmationList> {
		const target = account(rawAccountName);
		return serial(target.key, async () => {
			let confirmations: Confirmation[];
			try {
				confirmations = await options.confirmer.listConfirmations(target.params);
			} catch (err) {
				throw new ConfirmationError(502, errorText(err) || '读取令牌确认失败');
			}
			const entry = {confirmations: confirmations.filter(conf => conf.id && conf.nonce), fetchedAt: now()};
			lists.set(target.key, entry);
			return publicList(target.accountName, entry);
		});
	}

	/** 确认(accept=true)或拒绝几条;只认最近一次读到的列表里的 id */
	function respond(body: {accountName?: unknown; ids?: unknown; accept?: unknown}): Promise<RespondResult> {
		const target = account(body.accountName);
		const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(id => String(id ?? '').trim()).filter(Boolean))];
		const accept = body.accept === true;
		if (body.accept !== true && body.accept !== false) {
			throw new ConfirmationError(400, '缺少 accept(确认还是拒绝)');
		}
		const what = accept ? '确认' : '拒绝';
		if (!ids.length) {
			throw new ConfirmationError(400, `没有选要${what}的确认项`);
		}
		return serial(target.key, async () => {
			const entry = lists.get(target.key);
			const chosen = ids.map(id => entry?.confirmations.find(conf => conf.id === id));
			if (!entry || chosen.some(conf => !conf)) {
				throw new ConfirmationError(409, '有确认项不在最近读到的列表里(可能已经处理过),请刷新列表再试');
			}
			const confirmations = chosen as Confirmation[];
			try {
				await options.confirmer.respondToConfirmations({...target.params, confirmations, accept});
			} catch (err) {
				const message = errorText(err) || `${what}失败`;
				if (target.attempt) {
					options.addLog(target.attempt, 'error', `令牌确认:${what} ${confirmations.length} 项失败:${message}`);
				}
				throw new ConfirmationError(502, message);
			}
			const done = new Set(ids);
			entry.confirmations = entry.confirmations.filter(conf => !done.has(conf.id));
			if (target.attempt) {
				options.addLog(target.attempt, 'info', `令牌确认:已${what} ${confirmations.length} 项:${confirmations.map(describe).join(';')}`);
			}
			return {...publicList(target.accountName, entry), done: ids, accept};
		});
	}

	return {list, respond};
}

export type AccountConfirmations = ReturnType<typeof createAccountConfirmations>;
