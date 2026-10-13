// CS2 终端机服务(从 app/server.js 移来):/api/terminal/* 的逻辑——解封、协议探针、读/推进报价、自检、检视解析、状态页。
// 解封和推进报价不可逆;这里不含花钱兑换报价。

import type {Attempt} from '../steam/session-manager.ts';
import {createOfferHistory} from './history.ts';
import {createSkinDb, enrichTerminalOffer} from './skins.ts';
import type {DescribeItem, RawOffer} from './skins.ts';
import {createCs2Terminal} from './terminal.ts';
import type {Cs2Terminal, TerminalLog} from './terminal.ts';

export {createCs2Terminal} from './terminal.ts';

export function terminalError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function errorText(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : '';
}

/** 终端机自己的中文名兜底(本地 schema 只有英文 "Crate Community 36";社区库存拿不到时用) */
const TERMINAL_NAMES: Readonly<Record<number, {sealed: string; open: string}>> = {
	5176: {sealed: '封装的创世终端机', open: '创世终端机'},
	5181: {sealed: '封装的毁灭之手终端机', open: '毁灭之手终端机'}
};

function defaultTerminalName(terminal: {defIndex: number; sealed: boolean}): string {
	const names = TERMINAL_NAMES[Number(terminal.defIndex)];
	if (names) {
		return terminal.sealed ? names.sealed : names.open;
	}
	return terminal.sealed ? '封装的终端机' : '终端机';
}

interface CommunityItem {
	assetid?: string;
	name?: string;
	iconUrl?: string;
	raw?: {gcItem?: {def_index?: unknown} | null} | unknown;
}

export interface TerminalServiceOptions {
	findAttempt(key: string): Attempt | null;
	addLog(attempt: Attempt, level: string, message: string): void;
	/** 库存(给终端机配社区中文名和图标) */
	inventory: {get(attempt: Attempt, opts: {forceRefresh?: boolean}): Promise<{source: string; items: CommunityItem[]}>};
	/** 本地 schema 描述物品(外观档、兜底名称) */
	describeGcItem: DescribeItem;
	/** data/terminal-offers.json */
	historyFile: string;
	/** data/cs2-skin-db.json(运行时缓存)和 app/data/cs2-skin-db.json(随包副本) */
	skinCacheFile: string;
	skinBundledFile: string;
	readJson(file: string): unknown;
	writeJson(file: string, value: unknown): void;
	/** 皮肤库缓存写成紧凑 JSON(2.5MB 左右) */
	writeCompactJson(file: string, value: unknown): void;
	terminal?: Cs2Terminal;
	fetch?: typeof fetch;
	now?: () => number;
	logger?: Pick<Console, 'log' | 'warn'>;
}

export function createTerminalService(options: TerminalServiceOptions) {
	const logger = options.logger ?? console;
	const log: TerminalLog = (level, message) => level === 'warn' ? logger.warn(message) : logger.log(message);
	const terminal = options.terminal ?? createCs2Terminal({log, now: options.now});
	const history = createOfferHistory({file: options.historyFile, readJson: options.readJson, writeJson: options.writeJson, now: options.now});
	const skins = createSkinDb({cacheFile: options.skinCacheFile, bundledFile: options.skinBundledFile, writeJson: options.writeCompactJson, fetch: options.fetch, now: options.now, logger});
	const enrich = <T extends RawOffer | null | undefined>(offer: T) => enrichTerminalOffer(offer, options.describeGcItem, skins);

	function attemptOf(source: {accountId?: unknown; account?: unknown}, notFound = '账号不存在或未登录'): Attempt {
		const key = String(source.accountId || source.account || '').trim();
		const attempt = key ? options.findAttempt(key) : null;
		if (!attempt) {
			throw terminalError(404, notFound);
		}
		return attempt;
	}

	/** 跑一个动作;动作本身抛的错一律 400 */
	async function act<T>(run: () => T | Promise<T>, fallback: string): Promise<T> {
		try {
			return await run();
		} catch (err) {
			throw terminalError(400, errorText(err) || fallback);
		}
	}

	/** 解封(不可逆,72h 倒计时) */
	async function unseal(body: Record<string, unknown>) {
		const attempt = attemptOf(body, '账号不存在或未登录(用 id 或账号名指定)');
		const assetid = String(body.assetid || body.itemId || '').trim();
		const variant = String(body.variant || '').trim();
		return act(() => {
			const result = terminal.unseal(attempt, assetid, {variant, volatileLimit: body.volatileLimit, pointsRemaining: body.pointsRemaining, gcItemId: body.gcItemId});
			options.addLog(attempt, 'warn', `[终端机] 已发送解封请求 item=${assetid} 方式=${result.msg}(不可逆,72h 倒计时开始)`);
			return result;
		}, '解封失败');
	}

	/** 协议探针:依次发多种候选解封消息,命中即停(命中 = 不可逆消耗该终端机) */
	async function probe(body: Record<string, unknown>) {
		const attempt = attemptOf(body);
		return act(async () => {
			options.addLog(attempt, 'warn', '[终端机] 协议探针启动(会依次试发多种开箱消息,命中即停;命中=不可逆消耗该终端机)');
			const result = await terminal.probe(attempt, {itemId: body.itemId || body.assetid, gcItemId: body.gcItemId});
			options.addLog(attempt, 'warn', `[终端机] 协议探针结束:${result.hit ? '★命中 ' + result.hit.label : '无变动(需抓官方客户端实包)'}`);
			return result;
		}, '探针失败');
	}

	/** 推进到下一个报价(不可逆,消耗 1 次挑选);新揭示的报价补好名字图片后记进历史 */
	async function advanceOffer(body: Record<string, unknown>) {
		const attempt = attemptOf(body);
		const terminalId = String(body.gcItemId || body.itemId || body.assetid || '').trim();
		return act(async () => {
			options.addLog(attempt, 'warn', `[终端机] 推进到下一个报价(不可逆·消耗1次)终端机 ${terminalId}`);
			const result: Record<string, any> = await terminal.advanceOffer(attempt, terminalId, {pointsRemaining: body.pointsRemaining});
			try {
				await skins.ensure();
			} catch {
				// 皮肤库加载不了就只用本地 schema
			}
			if (Array.isArray(result.skins)) {
				result.skins = result.skins.map(enrich);
			}
			const revealed = Array.isArray(result.skins) ? result.skins[0] : null;
			if (revealed) {
				result.history = history.append(terminalId, revealed.defindex, revealed);
			}
			options.addLog(attempt, 'warn', `[终端机] 已推进:当前 ${result.count || 0} 个报价(新 ${result.fresh ? result.fresh.length : 0})`);
			return result;
		}, '推进报价失败');
	}

	async function requestOffers(body: Record<string, unknown>) {
		const attempt = attemptOf(body);
		return act(() => {
			const result = terminal.requestOffers(attempt, {defidx: body.defidx, itemId: body.itemId || body.assetid});
			options.addLog(attempt, 'info', '[终端机] 已请求报价(volatile shop)');
			return result;
		}, '请求报价失败');
	}

	/** GC 通路自检:判断「开箱被拦」还是「整条 GC 不通」(结果看后台日志) */
	async function selfTest(body: Record<string, unknown>) {
		const attempt = attemptOf(body);
		return act(() => {
			const result = terminal.selfTest(attempt);
			options.addLog(attempt, 'info', '[终端机] GC 通路自检已发起(看后台日志 8s 内是否有回包)');
			return result;
		}, '自检失败');
	}

	/** 把已捕获报价里的 faux_itemid 检视成真实皮肤 */
	async function resolveOffers(body: Record<string, unknown>) {
		const attempt = attemptOf(body);
		return act(async () => {
			const result = await terminal.resolveOffers(attempt);
			options.addLog(attempt, 'info', `[终端机] 报价解析:${result.count || 0}/${(result as {total?: number}).total || 0} 成功`);
			return result;
		}, '解析报价失败');
	}

	/**
	 * 状态页:终端机列表配上名字和图片(社区库存按 assetid 精确匹配,再按 def 兜底,都没有用本地中文名)、
	 * 当前报价补全、之前开出过的报价历史
	 */
	async function state(query: {accountId?: unknown; account?: unknown}) {
		const attempt = attemptOf(query);
		try {
			await skins.ensure();
		} catch {
			// 同上
		}
		const result: Record<string, any> = terminal.getState(attempt);
		const byAsset = new Map<string, {name: string; image: string}>();
		const byDef = new Map<number, {name: string; image: string}>();
		try {
			const snapshot = await options.inventory.get(attempt, {});
			// 只信社区来源(带中文名和图标);GC 来源是英文名、没图,还不如本地兜底
			if (snapshot && snapshot.source === 'community') {
				for (const item of snapshot.items || []) {
					const meta = {name: item.name || '', image: item.iconUrl || ''};
					if (item.assetid) {
						byAsset.set(String(item.assetid), meta);
					}
					const raw = item.raw as {gcItem?: {def_index?: unknown} | null} | undefined;
					const def = raw && raw.gcItem ? Number(raw.gcItem.def_index) : null;
					if (def && meta.image && !byDef.has(def)) {
						byDef.set(def, meta);
					}
				}
			}
		} catch {
			// 库存拿不到就用本地名字
		}
		if (Array.isArray(result.terminals)) {
			const historyMap = history.all();
			result.terminals = result.terminals.map((t: any) => {
				if (!t) {
					return t;
				}
				const meta = byAsset.get(String(t.id)) || byDef.get(Number(t.defIndex)) || null;
				const record = historyMap[String(t.id)];
				return {
					...t,
					name: (meta && meta.name) || defaultTerminalName(t),
					image: (meta && meta.image) || '',
					offer: t.offer ? enrich(t.offer) : t.offer,
					history: record && Array.isArray(record.offers) ? record.offers : []
				};
			});
		}
		return result;
	}

	return {unseal, probe, advanceOffer, requestOffers, selfTest, resolveOffers, state, attach: terminal.attach};
}

export type TerminalService = ReturnType<typeof createTerminalService>;
