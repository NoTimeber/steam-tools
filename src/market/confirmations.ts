// 求购单的 Steam 手机令牌确认(从 app/services/steamMarketBuyOrder.js 移来)。
//
// 2024 年起部分账号/地区挂求购要手机确认:createbuyorder 返回 success=22(Pending),
// 要用 maFile 的 identity_secret 在 mobileconf 里 allow 后再带 confirmation 重发一次才真正落单(见 ./client.ts)。
//
// 怎么找到本单的确认项:createbuyorder 返回的 confirmation_id 实测有时对不上列表里的 conf.id(可能是 creator),
// success=22 时也往往不给 buy_orderid。所以以「挂单前后快照差分」为主:挂单前记下已有确认项 id,
// 挂单后新冒出来的那条就是本单;再用 confirmation_id / buy_orderid 比 id 和 creator 兜底。
// 多条候选又分不清时宁可报错让用户手动确认,绝不盲目确认别的东西(比如一笔待确认的交易报价)。
//
// mobileconf 请求自己发,不经 steamcommunity 库(参照 aiosteampy 的 guard/confirmations.py、steamguard-cli 的 confirmation.rs):
//   GET /mobileconf/getlist?p=<设备 ID>&a=<SteamID>&k=<确认 key>&t=<Steam 时间>&m=react&tag=conf
//   GET /mobileconf/ajaxop?...&tag=allow&op=allow&cid=<确认项 id>&ck=<确认项 nonce>
// k = HMAC(identity_secret, t + tag)。getlist 的 tag 用 conf(steamcommunity 默认、steamguard-cli、SDA 都是它;aiosteampy 用 getlist)。
// 和 steamcommunity 库的差别:设备 ID 优先用 maFile 的 device_id(库只能按 SteamID 算一个),
// HTTP 和挂单走同一套(按账号选代理的 fetch),Steam 时间差也经它查;出错时把 Steam 的原话带进报错和日志。
// 2026-10 用户服务器上经 steamcommunity 库确认一直 429,而同一个出口挂单正常,所以换成这样。
// UA 对了发太密也会 429:请求按出口排队(../steam/community.ts 的 mobileconfQueue),碰到 429 等一会再试。
//
// Steam 拒绝时回 200 + {success:false, message:"Oh nooooooes!", detail:"<原因>"}:message 只是通用错误页的标题,原因在 detail。
// SDA 见过 device_id 坏了时是「There was a problem loading the confirmation page」;identity_secret / 时间不对是
// 「...providing incorrect Steam Guard codes」。所以读列表被拒时,换另一个设备 ID(maFile 的 ↔ 按 SteamID 算的)再试一次,
// 能用的那个这次运行里记住。

import {createRequire} from 'node:module';
import {steamIdFromCookies} from '../proxy/index.ts';
import {mobileconfQueue} from '../steam/community.ts';
import type {MobileconfQueue} from '../steam/community.ts';
import {STEAM_WEB_USER_AGENT} from '../steam/user-agent.ts';
import type {MarketLog} from './client.ts';

const require = createRequire(import.meta.url);

const MOBILECONF = 'https://steamcommunity.com/mobileconf';
const QUERY_TIME_URL = 'https://api.steampowered.com/ITwoFactorService/QueryTime/v1/';
const TIME_OFFSET_TTL_MS = 60 * 60 * 1000;
/** mobileconf 回 429 后依次等多久再试;都等完还是 429 就报限流 */
const RATE_LIMIT_WAITS_MS = [10000, 20000];
/** 设备 ID 的样子:android: 后面一串十六进制和横线(SDA 坏掉时会写成 ERROR 之类) */
const DEVICE_ID = /^android:[0-9a-z-]{8,}$/i;

/** 待确认项(getlist 返回的 conf[] 里用到的字段) */
export interface Confirmation {
	id: string;
	/** creator_id:交易报价 id、求购单 id 等 */
	creator: string;
	nonce: string;
	type: unknown;
	headline: string;
}

/** steam-totp(用到的部分) */
export interface Totp {
	getConfirmationKey(identitySecret: string, time: number, tag: string): string;
	getDeviceID(steamID: string): string;
}

export interface ConfirmerOptions {
	/** 发 mobileconf 和查 Steam 时间用的 fetch(按 Cookie 里的账号选代理) */
	fetch?: typeof fetch;
	totp?: Totp;
	queue?: MobileconfQueue;
	sleep?: (ms: number) => Promise<void>;
	/** 本机时间(毫秒):签名的时间和时间差缓存都按它 */
	now?: () => number;
	log?: MarketLog;
	/** 429 后依次等多久再试(测试注入) */
	rateLimitWaitsMs?: readonly number[];
}

export interface ListConfirmationsParams {
	cookies: readonly string[];
	identitySecret: string;
	/** 没给就从 steamLoginSecure 里读 */
	steamID?: string;
	/** maFile 的 device_id;没有时按 SteamID 算(和 steamcommunity 库一样) */
	deviceId?: string;
	userAgent?: string;
	/** 每个 mobileconf 请求的超时(不含排队) */
	timeoutMs?: number;
}

export interface ConfirmBuyOrderParams extends ListConfirmationsParams {
	confirmationId?: string;
	buyOrderId?: string;
	/** 挂单前的确认项 id 快照;读取失败时为 null */
	priorConfIds?: ReadonlySet<string> | null;
	/** 确认项可能在挂单后稍晚才出现:最多查几次、间隔多久 */
	attempts?: number;
	gapMs?: number;
}

/** mobileconf 的错误:status 是 HTTP 状态码(Steam 回 JSON 说失败时没有);refused 是 Steam 回了 success=false(不是要重新登录) */
class MobileconfError extends Error {
	status: number;
	steamText: string;
	refused: boolean;
	constructor(message: string, status = 0, steamText = '', refused = false) {
		super(message);
		this.status = status;
		this.steamText = steamText;
		this.refused = refused;
	}
}

function isRateLimited(err: unknown): err is MobileconfError {
	return err instanceof MobileconfError && err.status === 429;
}

function snippet(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** Steam 回的话:JSON 的 message + detail(message 常常只是「Oh nooooooes!」,原因在 detail),HTML 取标题,别的取开头一段 */
function steamWords(text: string, json: any): string {
	if (json && typeof json === 'object') {
		const words = [json.message, json.detail].map(value => String(value ?? '').trim()).filter(Boolean);
		return words.join(' ') || snippet(text);
	}
	const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
	return title || snippet(text);
}

function describe(confirmations: readonly Confirmation[]): string {
	return confirmations.map(conf => `{id:${conf.id},creator:${conf.creator},type:${conf.type}}`).join(',');
}

function toConfirmation(raw: any): Confirmation {
	return {
		id: String(raw?.id ?? ''),
		creator: String(raw?.creator_id ?? ''),
		nonce: String(raw?.nonce ?? ''),
		type: raw?.type,
		headline: String(raw?.headline ?? '')
	};
}

export function createBuyOrderConfirmer(options: ConfirmerOptions = {}) {
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const totp = options.totp ?? require('steam-totp') as Totp;
	const queue = options.queue ?? mobileconfQueue;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	const log: MarketLog = options.log ?? (() => {});
	const rateLimitWaits = options.rateLimitWaitsMs ?? RATE_LIMIT_WAITS_MS;

	// 本机与 Steam 的时间差(秒,确认 key 用),缓存 1 小时。查失败用上次的值或 0,不缓存
	let cachedOffset: number | null = null;
	let cachedAt = 0;
	async function timeOffset(): Promise<number> {
		if (cachedOffset !== null && now() - cachedAt < TIME_OFFSET_TTL_MS) {
			return cachedOffset;
		}
		try {
			const sentAt = now();
			// 和 steam-totp 的 getTimeOffset 一样:空 POST
			const res = await http(QUERY_TIME_URL, {method: 'POST', headers: {'User-Agent': STEAM_WEB_USER_AGENT}, body: '', signal: AbortSignal.timeout(15000)});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const serverTime = Number((await res.json() as any)?.response?.server_time);
			if (!Number.isFinite(serverTime) || serverTime <= 0) {
				throw new Error('返回里没有 server_time');
			}
			cachedOffset = serverTime - Math.round((sentAt + now()) / 2000);
			cachedAt = now();
			if (Math.abs(cachedOffset) >= 10) {
				log('warn', `[market-buyorder] 本机时间和 Steam 差了 ${cachedOffset} 秒(签确认 key 时已按 Steam 时间算)`);
			}
		} catch (err) {
			log('warn', `[market-buyorder] 查 Steam 时间失败,按本机时间签确认 key:${err instanceof Error ? err.message : String(err)}`);
		}
		return cachedOffset ?? 0;
	}

	// 这次运行里各账号(SteamID)读列表成功过的设备 ID,下次先用它
	const workingDeviceIds = new Map<string, string>();

	interface Session {
		cookies: string[];
		identitySecret: string;
		steamID: string;
		/** 依次可试的设备 ID;deviceId 是现在用的那个 */
		deviceIds: string[];
		deviceId: string;
		/** maFile 的 device_id(能用的才算);'' 没有 */
		maFileDeviceId: string;
		userAgent: string;
		timeoutMs: number;
		offset: number;
	}

	function deviceSource(session: Session, deviceId: string): string {
		return deviceId === session.maFileDeviceId ? 'maFile 的' : '按 SteamID 算的';
	}

	async function openSession(params: ListConfirmationsParams): Promise<Session> {
		const cookies = params.cookies.filter(Boolean);
		const steamID = String(params.steamID || '').trim() || steamIdFromCookies(cookies);
		if (!steamID) {
			throw new Error('cookies 里没有 steamLoginSecure,读不出 SteamID,无法手机确认');
		}
		const fromMaFile = String(params.deviceId || '').trim();
		const maFileDeviceId = DEVICE_ID.test(fromMaFile) ? fromMaFile : '';
		if (fromMaFile && !maFileDeviceId) {
			log('warn', `[market-buyorder] maFile 的 device_id 不像设备 ID(${snippet(fromMaFile, 40)}),改用按 SteamID 算的`);
		}
		const deviceIds = [...new Set([workingDeviceIds.get(steamID), maFileDeviceId, totp.getDeviceID(steamID)].filter((id): id is string => !!id))];
		return {
			cookies,
			identitySecret: String(params.identitySecret || '').trim(),
			steamID,
			deviceIds,
			deviceId: deviceIds[0]!,
			maFileDeviceId,
			userAgent: params.userAgent || STEAM_WEB_USER_AGENT,
			timeoutMs: params.timeoutMs || 30000,
			offset: await timeOffset()
		};
	}

	/** 发一个 mobileconf 请求,返回 Steam 回的 JSON(success 为真);别的情况抛 MobileconfError */
	async function mobileconf(session: Session, path: 'getlist' | 'ajaxop', tag: string, extra: Record<string, string> = {}): Promise<any> {
		await queue.wait(session.cookies);
		// 签名时间取发出前那一刻(排队可能等了几秒)
		const time = Math.floor(now() / 1000) + session.offset;
		const query = new URLSearchParams({
			p: session.deviceId,
			a: session.steamID,
			k: totp.getConfirmationKey(session.identitySecret, time, tag),
			t: String(time),
			m: 'react',
			tag,
			...extra
		});
		let res: Response;
		let text: string;
		try {
			res = await http(`${MOBILECONF}/${path}?${query}`, {
				headers: {
					'User-Agent': session.userAgent,
					Accept: 'application/json, text/plain, */*',
					'Accept-Language': 'en-US,en;q=0.9',
					Cookie: session.cookies.join('; ')
				},
				signal: AbortSignal.timeout(session.timeoutMs)
			});
			text = await res.text();
		} catch (err) {
			const timedOut = err instanceof Error && err.name === 'TimeoutError';
			throw new MobileconfError(timedOut ? `超时: mobileconf/${path}` : `mobileconf/${path} 请求失败:${err instanceof Error ? err.message : String(err)}`);
		}
		let json: any = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		const words = steamWords(text, json);
		if (res.status === 429) {
			queue.hold(session.cookies);
		}
		if (!res.ok) {
			throw new MobileconfError(`mobileconf/${path} 返回 HTTP ${res.status}${words ? `:${words}` : ''}`, res.status, words);
		}
		if (/\/login\b/i.test(res.url) || json?.needauth) {
			throw new MobileconfError('Steam 网页登录已失效(手机确认接口要求重新登录),请重新登录这个账号');
		}
		if (!json) {
			throw new MobileconfError(`mobileconf/${path} 返回的不是 JSON:${words || '空'}`, res.status, words);
		}
		if (!json.success) {
			log('warn', `[market-buyorder] mobileconf/${path} 被拒(设备 ID 用${deviceSource(session, session.deviceId)}),Steam 原文:${snippet(text, 400)}`);
			throw new MobileconfError(`Steam 拒绝了手机确认请求(mobileconf/${path}):${words || '没说原因'}`, 0, words, true);
		}
		return json;
	}

	/** 读确认列表;被拒(success=false)时换下一个设备 ID 再试,成功的那个记住 */
	async function fetchConfirmations(session: Session): Promise<Confirmation[]> {
		for (;;) {
			try {
				const json = await mobileconf(session, 'getlist', 'conf');
				workingDeviceIds.set(session.steamID, session.deviceId);
				return (Array.isArray(json.conf) ? json.conf : []).map(toConfirmation);
			} catch (err) {
				const next = session.deviceIds[session.deviceIds.indexOf(session.deviceId) + 1];
				if (!(err instanceof MobileconfError && err.refused) || !next) {
					throw err;
				}
				log('warn', `[market-buyorder] 读取确认列表被拒,设备 ID 换成${deviceSource(session, next)}再试一次`);
				session.deviceId = next;
			}
		}
	}

	async function accept(session: Session, conf: Confirmation): Promise<void> {
		await mobileconf(session, 'ajaxop', 'allow', {op: 'allow', cid: conf.id, ck: conf.nonce});
	}

	/** 回 429 时按 rateLimitWaits 等一会再试;等完还是 429 就报限流,别的错误照抛 */
	async function retryRateLimited<T>(label: string, run: () => Promise<T>): Promise<T> {
		for (let retry = 0; ; retry++) {
			try {
				return await run();
			} catch (err) {
				if (!isRateLimited(err)) {
					throw err;
				}
				const said = err.steamText ? `,Steam 回:${err.steamText}` : '';
				const wait = rateLimitWaits[retry];
				if (wait == null) {
					throw new Error(`Steam 手机确认接口限流(HTTP 429${said}),重试 ${rateLimitWaits.length} 次仍不行。过几分钟再试,或给这个账号换个代理`);
				}
				log('warn', `[market-buyorder] ${label}被 Steam 拒绝(HTTP 429${said}),${wait / 1000} 秒后重试(${retry + 1}/${rateLimitWaits.length})`);
				await sleep(wait);
			}
		}
	}

	/** 挂单前的快照:当前所有待确认项的 id。没有 cookies 或 identity_secret 时是空集 */
	async function listConfirmationIds(params: ListConfirmationsParams): Promise<Set<string>> {
		if (!params.cookies.some(Boolean) || !String(params.identitySecret || '').trim()) {
			return new Set();
		}
		const confirmations = await fetchConfirmations(await openSession(params));
		return new Set(confirmations.map(conf => conf.id));
	}

	/** 手机确认一张待确认的求购单;返回确认项的 creator(尽量当作真实 buy_orderid)。失败抛错 */
	async function confirmBuyOrder(params: ConfirmBuyOrderParams): Promise<{confirmed: true; buyOrderId: string}> {
		const confirmationId = String(params.confirmationId || '').trim();
		const buyOrderId = String(params.buyOrderId || '').trim();
		const prior = params.priorConfIds ?? null;
		const attempts = params.attempts || 4;
		const gapMs = params.gapMs || 5000;

		if (!params.cookies.some(Boolean)) {
			throw new Error('缺少 WebSession cookies,无法确认求购单');
		}
		if (!String(params.identitySecret || '').trim()) {
			throw new Error('该账号未导入 maFile(identity_secret),无法自动手机确认');
		}
		if (!confirmationId && !buyOrderId && !prior) {
			throw new Error('未取到 confirmation_id / buy_orderid 且无确认快照,无法定位待确认的求购单(请在 Steam 手机 App 手动确认)');
		}

		const session = await openSession(params);
		log('info', `[market-buyorder] 手机确认:设备 ID 先用${deviceSource(session, session.deviceId)},Steam 时间差 ${session.offset} 秒`);

		for (let i = 0; i < attempts; i++) {
			const confirmations = await retryRateLimited('读取确认列表', () => fetchConfirmations(session));
			// 有快照就只看新冒出来的(和字段含义无关,最稳);没有就看全部
			const candidates = prior ? confirmations.filter(conf => !prior.has(conf.id)) : confirmations;
			// confirmation_id 可能等于 conf.id 也可能等于 creator,两边都比;再用 buy_orderid 比 creator;候选只有一条就是它
			const conf = (confirmationId && candidates.find(c => c.id === confirmationId || c.creator === confirmationId))
				|| (buyOrderId && candidates.find(c => c.creator === buyOrderId))
				|| (candidates.length === 1 ? candidates[0] : undefined);

			if (conf) {
				await retryRateLimited('提交确认', () => accept(session, conf));
				const recovered = conf.creator || buyOrderId;
				log('info', `[market-buyorder] 求购单手机确认完成(confId=${conf.id}, creator/buyOrderId=${recovered || '?'})`);
				return {confirmed: true, buyOrderId: recovered};
			}
			if (candidates.length > 1) {
				log('warn', `[market-buyorder] ${candidates.length} 个候选确认项无法匹配本单(confId=${confirmationId || '-'} buyOrderId=${buyOrderId || '-'}): ${describe(candidates)}`);
				throw new Error(`检测到 ${candidates.length} 个待确认项,无法确定属于本求购单,请在 Steam 手机 App 手动确认`);
			}
			if (i < attempts - 1) {
				log('info', `[market-buyorder] 待确认项暂未出现,${gapMs / 1000} 秒后重试(${i + 1}/${attempts})`);
				await sleep(gapMs);
				continue;
			}
			// 重试用尽:打出整张列表帮排查(可能是新版购买确认走了别的体系)
			log('warn', `[market-buyorder] 重试结束仍未找到确认项。confId=${confirmationId || '-'} buyOrderId=${buyOrderId || '-'} 列表共 ${confirmations.length} 条: ${describe(confirmations)}`);
		}
		throw new Error(`重试 ${attempts} 次仍没找到本求购单的待确认项`);
	}

	return {listConfirmationIds, confirmBuyOrder};
}

export type BuyOrderConfirmer = ReturnType<typeof createBuyOrderConfirmer>;
