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
// steamcommunity 一定要走 ../steam/community.ts 的工厂:库默认的 Chrome/118 UA 会被 Steam 以 429 挡掉。

import {createRequire} from 'node:module';
import {createSteamCommunity} from '../steam/community.ts';
import type {MarketLog} from './client.ts';

const require = createRequire(import.meta.url);

const TIME_OFFSET_TTL_MS = 60 * 60 * 1000;

interface ConfirmationKey {
	tag: string;
	key: string;
}

/** steamcommunity 的 CConfirmation(用到的字段) */
export interface Confirmation {
	id: string;
	creator: string;
	type: unknown;
	respond(time: number, key: ConfirmationKey, accept: boolean, callback: (err: Error | null) => void): void;
}

export interface ConfirmationCommunity {
	setCookies(cookies: string[]): void;
	getConfirmations(time: number, key: ConfirmationKey, callback: (err: Error | null, confirmations?: Confirmation[]) => void): void;
}

/** steam-totp(用到的部分) */
export interface Totp {
	time(offset?: number): number;
	getConfirmationKey(identitySecret: string, time: number, tag: string): string;
	getTimeOffset(callback: (err: Error | null, offset?: number) => void): void;
}

export interface ConfirmerOptions {
	createCommunity?: () => ConfirmationCommunity;
	totp?: Totp;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	log?: MarketLog;
}

export interface ListConfirmationsParams {
	cookies: readonly string[];
	identitySecret: string;
}

export interface ConfirmBuyOrderParams extends ListConfirmationsParams {
	confirmationId?: string;
	buyOrderId?: string;
	/** 挂单前的确认项 id 快照;读取失败时为 null */
	priorConfIds?: ReadonlySet<string> | null;
	timeoutMs?: number;
	/** 确认项可能在挂单后稍晚才出现:最多查几次、间隔多久 */
	attempts?: number;
	gapMs?: number;
}

function describe(confirmations: readonly Confirmation[]): string {
	return confirmations.map(conf => `{id:${conf.id},creator:${conf.creator},type:${conf.type}}`).join(',');
}

export function createBuyOrderConfirmer(options: ConfirmerOptions = {}) {
	const createCommunity = options.createCommunity ?? (() => createSteamCommunity() as unknown as ConfirmationCommunity);
	// 用到时才加载,并且每次都经模块对象调用(e2e 的离线环境会替换 getTimeOffset)
	const totp = (): Totp => options.totp ?? require('steam-totp') as Totp;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	const log: MarketLog = options.log ?? (() => {});

	// 本机与 Steam 的时间差(确认 key 用),缓存 1 小时,不用每个账号都查一次。查失败用上次的值或 0,不缓存
	let cachedOffset: number | null = null;
	let cachedAt = 0;
	function timeOffset(): Promise<number> {
		if (cachedOffset !== null && now() - cachedAt < TIME_OFFSET_TTL_MS) {
			return Promise.resolve(cachedOffset);
		}
		return new Promise(resolve => {
			try {
				totp().getTimeOffset((err, offset) => {
					if (!err) {
						cachedOffset = offset || 0;
						cachedAt = now();
					}
					resolve(cachedOffset || 0);
				});
			} catch {
				resolve(cachedOffset || 0);
			}
		});
	}

	function signedKey(identitySecret: string, offset: number, tag: string): {time: number; key: ConfirmationKey} {
		const time = totp().time(offset);
		return {time, key: {tag, key: totp().getConfirmationKey(identitySecret, time, tag)}};
	}

	function fetchConfirmations(community: ConfirmationCommunity, identitySecret: string, offset: number): Promise<Confirmation[]> {
		const {time, key} = signedKey(identitySecret, offset, 'list');
		return new Promise((resolve, reject) => {
			community.getConfirmations(time, key, (err, confirmations) => err ? reject(err) : resolve(confirmations || []));
		});
	}

	function accept(conf: Confirmation, identitySecret: string, offset: number): Promise<void> {
		const {time, key} = signedKey(identitySecret, offset, 'accept');
		return new Promise((resolve, reject) => {
			conf.respond(time, key, true, err => err ? reject(err) : resolve());
		});
	}

	function signedInCommunity(cookies: readonly string[]): ConfirmationCommunity {
		const community = createCommunity();
		community.setCookies([...cookies]);   // 从 steamLoginSecure 解析 steamID,getConfirmations 要用
		return community;
	}

	/** 挂单前的快照:当前所有待确认项的 id。没有 cookies 或 identity_secret 时是空集 */
	async function listConfirmationIds(params: ListConfirmationsParams): Promise<Set<string>> {
		const cookies = params.cookies.filter(Boolean);
		const identitySecret = String(params.identitySecret || '').trim();
		if (!cookies.length || !identitySecret) {
			return new Set();
		}
		const confirmations = await fetchConfirmations(signedInCommunity(cookies), identitySecret, await timeOffset());
		return new Set(confirmations.map(conf => String(conf.id)));
	}

	/** 手机确认一张待确认的求购单;返回确认项的 creator(尽量当作真实 buy_orderid)。失败抛错 */
	async function confirmBuyOrder(params: ConfirmBuyOrderParams): Promise<{confirmed: true; buyOrderId: string}> {
		const cookies = params.cookies.filter(Boolean);
		const identitySecret = String(params.identitySecret || '').trim();
		const confirmationId = String(params.confirmationId || '').trim();
		const buyOrderId = String(params.buyOrderId || '').trim();
		const prior = params.priorConfIds ?? null;
		const timeoutMs = params.timeoutMs || 30000;
		const attempts = params.attempts || 6;
		const gapMs = params.gapMs || 2000;

		if (!cookies.length) {
			throw new Error('缺少 WebSession cookies,无法确认求购单');
		}
		if (!identitySecret) {
			throw new Error('该账号未导入 maFile(identity_secret),无法自动手机确认');
		}
		if (!confirmationId && !buyOrderId && !prior) {
			throw new Error('未取到 confirmation_id / buy_orderid 且无确认快照,无法定位待确认的求购单(请在 Steam 手机 App 手动确认)');
		}

		const community = signedInCommunity(cookies);
		// 完成后清掉超时定时器(旧代码不清,每次确认都留下几个 30 秒的定时器)
		const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('超时: ' + label)), timeoutMs);
			});
			return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
		};
		const offset = await timeOffset();

		for (let i = 0; i < attempts; i++) {
			const confirmations = await withTimeout(fetchConfirmations(community, identitySecret, offset), 'getConfirmations');
			// 有快照就只看新冒出来的(和字段含义无关,最稳);没有就看全部
			const candidates = prior ? confirmations.filter(conf => !prior.has(String(conf.id))) : confirmations;
			// confirmation_id 可能等于 conf.id 也可能等于 creator,两边都比;再用 buy_orderid 比 creator;候选只有一条就是它
			const conf = (confirmationId && candidates.find(c => String(c.id) === confirmationId || String(c.creator) === confirmationId))
				|| (buyOrderId && candidates.find(c => String(c.creator) === buyOrderId))
				|| (candidates.length === 1 ? candidates[0] : undefined);

			if (conf) {
				await withTimeout(accept(conf, identitySecret, offset), 'respondConfirmation');
				const recovered = String(conf.creator || '') || buyOrderId;
				log('info', `[market-buyorder] 求购单手机确认完成(confId=${conf.id}, creator/buyOrderId=${recovered || '?'})`);
				return {confirmed: true, buyOrderId: recovered};
			}
			if (candidates.length > 1) {
				log('warn', `[market-buyorder] ${candidates.length} 个候选确认项无法匹配本单(confId=${confirmationId || '-'} buyOrderId=${buyOrderId || '-'}): ${describe(candidates)}`);
				throw new Error(`检测到 ${candidates.length} 个待确认项,无法确定属于本求购单,请在 Steam 手机 App 手动确认`);
			}
			if (i < attempts - 1) {
				log('info', `[market-buyorder] 待确认项暂未出现,${gapMs}ms 后重试(${i + 1}/${attempts})`);
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
