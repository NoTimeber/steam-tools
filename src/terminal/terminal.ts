// CS2「终端机」(封装的创世终端机等)开启(从 app/lib/cs2-terminal.js 移来)。
//
// 机制:库存里「解封」(不可逆,启动 72h 倒计时)→ 军火商给固定价皮肤报价 → 花钱包余额买其中一个。
// 这里只做到解封、读报价、换下一个报价和抓包,不含花钱兑换。
//
// 抓包:在 steam-user 客户端上并行监听原始 GC 消息(和 globaloffensive 互不干扰),
// 从 SO 缓存里认出报价对象(type 20)和终端机里的报价皮肤(type 1、casket_id 指向终端机),记在 attempt._terminal。
// 动作之后开 25 秒「详细日志窗口」,把 GC 回包全打出来便于对协议。

import type {Attempt} from '../steam/session-manager.ts';
import {
	CMsgOpenCrate, CMsgVolatileShopSubscribe, CS2_APP_ID, decodeEconItem, describeTerminalItem, ECON_ITEM_SO_TYPE, EGC_RESPONSE,
	extractSoObjects, extractWelcomeObjects, GcBaseMessages, GcProtos, isTerminalDef, KNOWN_OFFER_SO_TYPE, MSG, peekEconItemId,
	readExpiration, readPicksUsed, SO_MSG, SO_MSG_NAME, structInts, TERMINAL_DEF_INDEX, TERMINAL_DEF_INDICES, TERMINAL_MAX_PICKS,
	tryDecodeOffer, walkProto
} from './protocol.ts';
import type {DecodedEconItem, GcItem, SoObject, VolatileOffer} from './protocol.ts';

const VERBOSE_WINDOW_MS = 25000;
const GC_LOG_LIMIT = 300;
const RECENT_GC_LIMIT = 200;
const NOTIFICATION_LIMIT = 50;
/** faux id 作为 type1 注入时带的 0xF 掩码大 id */
const MASKED_ID = /^(1[0-8]\d{18}|9[2-9]\d{18})$/;

export type TerminalLog = (level: 'info' | 'warn', message: string) => void;

interface StoredOffer extends VolatileOffer {
	typeId: number;
	seenAt: string;
}

interface InjectedSkin extends DecodedEconItem {
	seenAt: string;
	faux: boolean;
}

export interface OfferSkin {
	itemid: string | null;
	defindex: number;
	paintindex: number | null | undefined;
	paintwear: number | null | undefined;
	paintseed: number | null | undefined;
	rarity: number;
	priceCents: number | null;
	attrStr: string;
}

interface TerminalState {
	attached: boolean;
	offers: Map<string, StoredOffer>;
	soTypes: Map<number, number>;
	notifications: Array<{t: string; request: number; itemIds: string[]}>;
	gcLog: Array<Record<string, unknown>>;
	recentGc: Array<{t: number; mt: number; len: number; hex: string}>;
	injectedSkins: InjectedSkin[];
	fauxIds: Set<string>;
	verboseUntil: number;
	resolvedOffers?: unknown[];
}

interface TerminalClient {
	on(event: string, listener: (...args: any[]) => void): unknown;
	sendToGC(appid: number, msgType: number, header: Record<string, unknown> | null, payload: Uint8Array): void;
	steamID?: {getSteamID64(): string} | null;
}

interface Cs2Module {
	inventory?: GcItem[];
	haveGCSession?: boolean;
	_isInCSGO?: boolean;
	requestPlayersProfile?(steamID: unknown, callback: () => void): void;
	on(event: string, listener: (...args: any[]) => void): unknown;
	removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface TerminalOptions {
	log?: TerminalLog;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** selfTest 等回包用的定时器 */
	setTimer?: (callback: () => void, ms: number) => void;
}

function client(attempt: Attempt): TerminalClient {
	return attempt.client as unknown as TerminalClient;
}

function cs2(attempt: Attempt): Cs2Module | null {
	return attempt.csgo as Cs2Module | null;
}

function digits(value: unknown): string {
	return String(value || '').replace(/\D/g, '');
}

function errorText(err: unknown): string | undefined {
	return err && typeof err === 'object' && 'message' in err ? String(err.message) : undefined;
}

export function listTerminalGcItems(attempt: Attempt): GcItem[] {
	const inventory = cs2(attempt)?.inventory;
	return Array.isArray(inventory) ? inventory.filter(item => item && isTerminalDef(item.def_index)) : [];
}

/**
 * 按 id 或 original_id 精确找终端机(社区 assetid 常等于 GC 的 original_id,而开箱必须用 GC 当前 id)。
 * 没精确命中时只有一个终端机才返回它;多个返回 null,让调用方报错,免得开错。
 */
export function findTerminalGcItem(attempt: Attempt, assetid: string): GcItem | null {
	const terminals = listTerminalGcItems(attempt);
	if (assetid) {
		const exact = terminals.find(item => String(item.id) === assetid || String(item.original_id) === assetid);
		if (exact) {
			return exact;
		}
	}
	return terminals.length === 1 ? terminals[0] as GcItem : null;
}

export function createCs2Terminal(options: TerminalOptions = {}) {
	const log: TerminalLog = options.log ?? (() => {});
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => void setTimeout(callback, ms));
	const iso = () => new Date(now()).toISOString();

	function ensureState(attempt: Attempt): TerminalState {
		if (!attempt._terminal) {
			attempt._terminal = {
				attached: false, offers: new Map(), soTypes: new Map(), notifications: [], gcLog: [], recentGc: [], injectedSkins: [], fauxIds: new Set(), verboseUntil: 0
			} satisfies TerminalState;
		}
		return attempt._terminal as TerminalState;
	}

	function openVerbose(state: TerminalState): void {
		state.verboseUntil = now() + VERBOSE_WINDOW_MS;
	}

	function requireGc(attempt: Attempt): void {
		if (!attempt.cs2GcConnected) {
			throw new Error('该账号未连接 CS2 GC');
		}
		if (!attempt.client || typeof client(attempt).sendToGC !== 'function') {
			throw new Error('账号未连接(无 sendToGC)');
		}
	}

	function send(attempt: Attempt, msgType: number, header: Record<string, unknown> | null, payload: Uint8Array): void {
		client(attempt).sendToGC(CS2_APP_ID, msgType, header, payload);
	}

	// ===== 抓包 =====

	/** 挂原始 GC 抓包监听(幂等)。客户端建好时、GC 连上时都会调 */
	function attach(attempt: Attempt): void {
		const state = ensureState(attempt);
		if (state.attached) {
			return;
		}
		if (!attempt.client || typeof client(attempt).on !== 'function') {
			return;
		}
		state.attached = true;
		client(attempt).on('receivedFromGC', (appid: unknown, msgType: unknown, payload: unknown) => {
			if (Number(appid) !== CS2_APP_ID || !Buffer.isBuffer(payload)) {
				return;
			}
			const mt = Number(msgType);
			try {
				const verbose = now() < state.verboseUntil;
				// 详细窗口内记下最近的回包(协议探针按步骤对齐响应用)
				if (verbose) {
					state.recentGc.push({t: now(), mt, len: payload.length, hex: payload.length <= 64 ? payload.toString('hex') : payload.slice(0, 64).toString('hex') + '…'});
					if (state.recentGc.length > RECENT_GC_LIMIT) {
						state.recentGc.shift();
					}
				}
				const notable = mt === MSG.UnlockCrateResponse || mt === MSG.UseItemResponse;
				if (verbose || notable) {
					log('info', `[terminal] ← GC 消息 msg=${mt} (${payload.length}B)${notable ? ' ★解封响应' : ''}`);
				}
				if (notable) {
					logUnlockResponse(payload);
				}
				// 解封/兑换结果通知自己解:lib 的 handler 会过滤掉 item_id / request 缺失的,可能漏掉终端机的
				if (mt === MSG.ItemCustomizationNotification) {
					captureCustomization(state, payload, verbose);
				}
				onGc(state, mt, payload, verbose);
			} catch (err) {
				log('warn', '[terminal] GC 解析出错: ' + errorText(err));
			}
		});
	}

	function logUnlockResponse(payload: Buffer): void {
		const hex = payload.toString('hex');
		const fields = walkProto(payload);
		if (fields.length > 0 && fields.every(f => f.field >= 1)) {
			const f1 = fields.find(f => f.field === 1);
			const result = f1 ? Number(f1.v) : null;
			log('info', `[terminal] ★解封响应(protobuf) result=${result != null ? result : '?'}(${result != null ? (EGC_RESPONSE[result] || 'code' + result) : '?'}) 字段=[${fields.map(f => '#' + f.field + '=' + f.v).join(' ')}] hex=${hex}`);
			return;
		}
		// 结构体回包(如 1008 的 6B):首个 u16 疑似 result,其余多为回显(如 volatile_limit)
		const ints = structInts(payload);
		const result = ints.u16.length ? ints.u16[0] as number : null;
		log('info', `[terminal] ★解封响应(结构体 ${payload.length}B) 疑似result=${result != null ? `${result}(${EGC_RESPONSE[result] || 'code' + result})` : '?'} u16le=[${ints.u16.join(',')}] u32le=[${ints.u32.join(',')}] hex=${hex}`);
		log('info', '[terminal]   ↑ 判定法:换个 volatile_limit 再发,若上面某个值跟着变=它是回显(则 result=0=OK,去看是否冒报价/origin翻转);若都不变=固定返回码');
	}

	function captureCustomization(state: TerminalState, payload: Buffer, verbose: boolean): void {
		try {
			const message = GcProtos.CMsgGCItemCustomizationNotification!.decode(payload);
			const record = {t: iso(), request: Number(message.request || 0), itemIds: (message.item_id || []).map((x: {toString(): string}) => x.toString())};
			state.notifications.push(record);
			if (state.notifications.length > NOTIFICATION_LIMIT) {
				state.notifications.shift();
			}
			log('info', `[terminal] ★ ItemCustomizationNotification request=${record.request} items=[${record.itemIds.join(',')}]`);
		} catch (err) {
			if (verbose) {
				log('warn', '[terminal] 解 ItemCustomizationNotification 失败: ' + errorText(err));
			}
		}
	}

	function onGc(state: TerminalState, msgType: number, payload: Buffer, verbose: boolean): void {
		let objects: SoObject[] | null = null;
		if (msgType === MSG.ClientWelcome) {
			objects = extractWelcomeObjects(payload);
		} else if (([SO_MSG.CacheSubscribed, SO_MSG.Create, SO_MSG.Update, SO_MSG.Destroy, SO_MSG.UpdateMultiple] as number[]).includes(msgType)) {
			objects = extractSoObjects(msgType, payload);
			// 有非普通饰品类型时总记一条(抓报价类型);Destroy(旧箱销毁)也是成功信号,总记
			const isDestroy = msgType === SO_MSG.Destroy;
			if (objects.length && (verbose || isDestroy || objects.some(o => Number(o.type_id) !== ECON_ITEM_SO_TYPE))) {
				const types = [...new Set(objects.map(o => Number(o.type_id)))].join(',');
				log('info', `[terminal] SO 消息 ${SO_MSG_NAME[msgType] || msgType}(${msgType}) type_ids=[${types}]${isDestroy ? ' ← 有物品被销毁(可能开箱成功)' : ''}`);
			}
		}
		if (!objects) {
			return;
		}
		const isDelta = ([SO_MSG.Create, SO_MSG.Update, SO_MSG.UpdateMultiple] as number[]).includes(msgType);
		// 先把本批报价里的 faux id 收起来(下面 type1 匹配要用;同一个欢迎消息里 type1 可能排在 type20 前面)
		for (const object of objects) {
			if (Number(object.type_id) === KNOWN_OFFER_SO_TYPE) {
				const offer = tryDecodeOffer(object.data);
				if (offer) {
					offer.fauxItemIds.forEach(id => state.fauxIds.add(String(id)));
				}
			}
		}
		let maskedType1 = 0;
		for (const object of objects) {
			const typeId = Number(object.type_id);
			state.soTypes.set(typeId, (state.soTypes.get(typeId) || 0) + 1);
			if (typeId === ECON_ITEM_SO_TYPE) {
				// casket_id 指向某个终端机的非终端机物品 = 终端机生成的报价皮肤,外观和价格都在它的 attribute 里。
				// 只在增量或 faux 命中时整体解码,免得把整个库存都解一遍
				const peeked = peekEconItemId(object.data);
				if (peeked && MASKED_ID.test(peeked)) {
					maskedType1++;
				}
				const fauxHit = !!peeked && state.fauxIds.has(peeked);
				if (isDelta || fauxHit) {
					const item = decodeEconItem(object.data);
					if (item) {
						const terminal = isTerminalDef(item.def_index);
						if ((!!item.casketId && !terminal) || fauxHit) {
							if (!state.injectedSkins.find(s => s.id === item.id)) {
								state.injectedSkins.push({seenAt: iso(), faux: fauxHit, ...item});
							}
							const price = item.priceCents != null ? `$${(item.priceCents / 100).toFixed(2)}` : '?';
							log('info', `[terminal] ★★ 报价皮肤 def=${item.def_index} paintindex=${item.paint.paintindex} seed=${item.paint.seed} wear=${item.paint.wear} 价格=${price} rarity=${item.rarity} casket=${item.casketId || '-'} id=${item.id}`);
							log('info', `[terminal]   ↳ 全属性:[${item.attrStr}]`);
						} else if (verbose) {
							log('info', `[terminal] type1 增量 def=${item.def_index}${terminal ? '(终端机)' : ''} origin=${item.origin} casket=${item.casketId || '-'} attrs[${item.attrStr}]`);
						}
					}
				}
				continue;
			}
			if (typeId !== KNOWN_OFFER_SO_TYPE) {
				continue;
			}
			const offer = tryDecodeOffer(object.data);
			if (offer) {
				state.offers.set(String(offer.defidx), {typeId, seenAt: iso(), ...offer});
				state.gcLog.push({t: iso(), kind: 'offer', typeId, defidx: offer.defidx});
				if (state.gcLog.length > GC_LOG_LIMIT) {
					state.gcLog.shift();
				}
				log('info', `[terminal] ★ 捕获报价 defidx=${offer.defidx} fauxItemIds=${offer.fauxItemIds.join(',')} (SO type_id=${typeId})`);
				// 全字段转储:皮肤外观可能藏在报价对象里没解的字段
				log('info', `[terminal]   ↳ type20 全字段=[${walkProto(object.data).map(f => '#' + f.field + '=' + f.v).join(' ')}]`);
				log('info', `[terminal]   ↳ type20 原始hex=${object.data.toString('hex')}`);
			}
		}
		if (maskedType1 > 0 && verbose) {
			log('info', `[terminal] ⓘ 本批含 ${maskedType1} 个大id(≥0x8000…)的 type1 物品(疑似 faux 注入),已知 faux 数=${state.fauxIds.size}`);
		}
	}

	// ===== 报价皮肤 =====

	/** globaloffensive 已解析的库存里,casket_id 是这个终端机的报价皮肤(价格 attr316 它不解,自己取) */
	function scanCasketSkins(attempt: Attempt, terminalId: string) {
		const out = [];
		for (const item of cs2(attempt)?.inventory || []) {
			if (!item || String(item.casket_id || '') !== terminalId || isTerminalDef(item.def_index)) {
				continue;
			}
			let priceCents: number | null = null;
			const price = (item.attribute || []).find(a => Number(a.def_index) === 316);
			if (price && price.value_bytes && price.value_bytes.length >= 4) {
				priceCents = Buffer.from(price.value_bytes).readUInt32LE(0);
			}
			out.push({
				id: item.id != null ? String(item.id.toString()) : null,
				def_index: Number(item.def_index || 0),
				paintindex: item.paint_index != null ? Math.round(item.paint_index) : null,
				seed: item.paint_seed != null ? item.paint_seed : null,
				wear: item.paint_wear != null ? item.paint_wear : null,
				rarity: Number(item.rarity || 0),
				priceCents
			});
		}
		return out;
	}

	/**
	 * 某终端机当前的报价皮肤:以库存为准(当前 casket 内容,旧报价已被 SO Destroy),用自己抓到的(带价格、全属性)按 id 补全;
	 * 库存里没有才退回自己抓的
	 */
	function collectSkins(state: TerminalState, attempt: Attempt, terminalId: string): OfferSkin[] {
		const fromInventory = scanCasketSkins(attempt, terminalId);
		const mine = new Map(state.injectedSkins.filter(s => String(s.casketId) === terminalId).map(s => [s.id, s]));
		if (fromInventory.length) {
			return fromInventory.map(s => {
				const captured = mine.get(s.id);
				return {
					itemid: s.id, defindex: s.def_index, paintindex: s.paintindex, paintwear: s.wear, paintseed: s.seed, rarity: s.rarity,
					priceCents: s.priceCents != null ? s.priceCents : (captured ? captured.priceCents : null), attrStr: captured ? captured.attrStr : ''
				};
			});
		}
		return [...mine.values()].map(s => ({
			itemid: s.id, defindex: s.def_index, paintindex: s.paint.paintindex, paintwear: s.paint.wear, paintseed: s.paint.seed, rarity: s.rarity,
			priceCents: s.priceCents != null ? s.priceCents : null, attrStr: s.attrStr || ''
		}));
	}

	function logSkins(skins: OfferSkin[]): void {
		skins.forEach(s => log('info', `[terminal]   报价: def=${s.defindex} paint=${s.paintindex} 磨损=${s.paintwear != null ? Number(s.paintwear).toFixed(5) : '?'} 价格=${s.priceCents != null ? '$' + (s.priceCents / 100).toFixed(2) : '?'} id=${s.itemid}`));
	}

	function logTerminals(attempt: Attempt, header: string): GcItem[] {
		const terminals = listTerminalGcItems(attempt);
		log('info', header.replace('{n}', String(terminals.length)));
		terminals.forEach((t, i) => log('info', `[terminal]   #${i}: ${describeTerminalItem(t)}`));
		return terminals;
	}

	// ===== 动作 =====

	/**
	 * 解封(不可逆,启动 72h 倒计时)。终端机是武器箱类容器,走开箱:CMsgOpenCrate 发到 2534,免费解封不带钥匙。
	 * 实测:带 for_rental=true 回 NoMatch 不解封;不带才当场解封,所以默认不带。
	 * variant:opencrate(默认)/ opencrate_plain / volatileload(2536)/ opencrate_1007、opencrate_struct、useitem(旧法,对照用)
	 */
	function unseal(attempt: Attempt, itemId: unknown, opts: {variant?: string; volatileLimit?: unknown; pointsRemaining?: unknown; gcItemId?: unknown; forRental?: unknown} = {}) {
		const id = digits(itemId);
		if (!id) {
			throw new Error('无效的物品 id');
		}
		requireGc(attempt);
		attach(attempt);
		openVerbose(ensureState(attempt));
		// 社区 assetid 不等于 GC 当前 id(前者常是 original_id),开箱必须用 GC 当前 id
		const terminals = logTerminals(attempt, '[terminal] GC 库存 def=5176 终端机 {n} 个:');
		let subjectId: string;
		const forced = digits(opts.gcItemId);
		if (forced) {
			subjectId = forced;
			log('info', `[terminal] 使用指定 GC id=${subjectId}`);
		} else {
			const item = findTerminalGcItem(attempt, id);
			if (!item || !item.id) {
				throw new Error(`GC 库存里没有 id/original_id=${id} 的终端机(共 ${terminals.length} 个 def5176,已打到日志)。请用其中正确的 GC id(gcItemId)重试,避免开错终端机。`);
			}
			subjectId = String(item.id);
			if (subjectId !== id) {
				log('info', `[terminal] ⚠ 传入 assetid(${id})≠ GC id(${subjectId})(多半 community=original_id),已改用 GC 当前 id`);
			}
		}
		const variant = String(opts.variant || 'opencrate');
		// volatile_limit = 客户端「报价上限」价格档(50/250/1000 美元,0 = 无上限)
		const volatileLimit = opts.volatileLimit != null && opts.volatileLimit !== '' ? Number(opts.volatileLimit) : 0;
		const pointsRemaining = opts.pointsRemaining != null && opts.pointsRemaining !== '' ? Number(opts.pointsRemaining) : null;
		const forRental = opts.forRental === true || opts.forRental === 'true';
		let msgNum: number;
		let header: Record<string, unknown> | null;
		let payload: Uint8Array;
		let desc: string;
		if (variant === 'useitem') {
			msgNum = MSG.UseItemRequest;
			header = {};
			desc = 'UseItem(1025·对照)';
			payload = GcBaseMessages.CMsgUseItem!.encode({item_id: subjectId}).finish();
		} else if (variant === 'opencrate_struct') {
			msgNum = MSG.UnlockCrateDeprecated;
			header = null;
			desc = 'UnlockCrate/struct(1007·废弃)';
			const buf = Buffer.alloc(16);
			buf.writeBigUInt64LE(0n, 0);
			buf.writeBigUInt64LE(BigInt(subjectId), 8);
			payload = buf;
		} else if (variant === 'opencrate_1007') {
			msgNum = MSG.UnlockCrateDeprecated;
			header = {};
			desc = 'OpenCrate/pb(1007·废弃)';
			payload = CMsgOpenCrate.encode({subject_item_id: subjectId, volatile_limit: volatileLimit}).finish();
		} else {
			msgNum = variant === 'volatileload' ? MSG.VolatileItemLoadContents : MSG.OpenCrate;
			header = {};
			const body: Record<string, unknown> = {subject_item_id: subjectId};
			if (variant === 'opencrate_plain') {
				desc = `OpenCrate/pb(${msgNum},仅 subject)`;
			} else {
				if (forRental) {
					body.for_rental = true;
				}
				body.volatile_limit = volatileLimit;
				if (pointsRemaining != null) {
					body.points_remaining = pointsRemaining;
				}
				desc = `OpenCrate/pb(${msgNum}${forRental ? ',rental' : ''},limit=${volatileLimit}${pointsRemaining != null ? `,points=${pointsRemaining}` : ''})`;
			}
			payload = CMsgOpenCrate.encode(body).finish();
		}
		send(attempt, msgNum, header, payload);
		log('info', `[terminal] 已发送解封 ${desc} item_id=${subjectId} 账号=${attempt.accountName}`);
		log('info', '[terminal] （成功信号在 SO 缓存,不在 1008 回包!盯:SO Destroy(23)/Create(21) / ★捕获报价(SO type 20) / ★ItemCustomizationNotification / 终端机 origin 24→8。1008 回固定 05=NoMatch=limit 档位无效）');
		return {sent: true, itemId: subjectId, variant, msg: desc, msgNum};
	}

	/**
	 * 协议探针:对同一个未解封终端机依次发多种候选开箱消息(间隔 2.5 秒),对齐回包和 SO 变动,
	 * 一有真实变动(报价 / 通知 / SO 变动 / origin 变化)就停。命中的那一下会不可逆地消耗该终端机。
	 */
	async function probe(attempt: Attempt, opts: {itemId?: unknown; assetid?: unknown; gcItemId?: unknown} = {}) {
		requireGc(attempt);
		attach(attempt);
		const state = ensureState(attempt);
		let subjectId: string;
		const forced = digits(opts.gcItemId);
		if (forced) {
			subjectId = forced;
		} else {
			const item = findTerminalGcItem(attempt, digits(opts.itemId || opts.assetid));
			if (!item || !item.id) {
				throw new Error('未定位到终端机 GC id,请用「填入未解封」或指定 gcItemId。');
			}
			subjectId = String(item.id);
		}
		const originOf = (id: string): number | null => {
			const item = listTerminalGcItems(attempt).find(t => String(t.id) === id);
			return item ? Number(item.origin || 0) : null;
		};
		const startOrigin = originOf(subjectId);
		if (startOrigin !== 24) {
			log('warn', `[terminal] ⚠ 探针目标 origin=${startOrigin}(≠24,可能已解封);建议选未解封的。`);
		}
		const subject = BigInt(subjectId);
		const openCrate = (body: Record<string, unknown>) => () => CMsgOpenCrate.encode(body).finish();
		const steps: Array<{label: string; mt: number; header: Record<string, unknown> | null; buf: () => Uint8Array}> = [
			{label: 'opencrate/2534 rental+lim0', mt: MSG.OpenCrate, header: {}, buf: openCrate({subject_item_id: subjectId, for_rental: true, volatile_limit: 0})},
			{label: 'opencrate/2534 norental+lim0', mt: MSG.OpenCrate, header: {}, buf: openCrate({subject_item_id: subjectId, volatile_limit: 0})},
			{label: 'opencrate/2534 plain(仅subject)', mt: MSG.OpenCrate, header: {}, buf: openCrate({subject_item_id: subjectId})},
			{label: 'opencrate/2534 self-tool', mt: MSG.OpenCrate, header: {}, buf: openCrate({tool_item_id: subjectId, subject_item_id: subjectId, volatile_limit: 0})},
			{label: 'volatileload/2536 rental+lim0', mt: MSG.VolatileItemLoadContents, header: {}, buf: openCrate({subject_item_id: subjectId, for_rental: true, volatile_limit: 0})},
			{label: 'volatileload/2536 plain', mt: MSG.VolatileItemLoadContents, header: {}, buf: openCrate({subject_item_id: subjectId})},
			{label: 'volatileload/2536 subscribe-shape', mt: MSG.VolatileItemLoadContents, header: {}, buf: () => CMsgVolatileShopSubscribe.encode({psid: subjectId, defidx: TERMINAL_DEF_INDEX}).finish()},
			{label: 'useitem/1025', mt: MSG.UseItemRequest, header: {}, buf: () => GcBaseMessages.CMsgUseItem!.encode({item_id: subjectId}).finish()},
			{label: 'unlock/1007 struct(key0+crate)', mt: MSG.UnlockCrateDeprecated, header: null, buf: () => {
				const buf = Buffer.alloc(16);
				buf.writeBigUInt64LE(0n, 0);
				buf.writeBigUInt64LE(subject, 8);
				return buf;
			}}
		];
		log('info', `[terminal] ▶ 协议探针启动:subject=${subjectId} origin=${startOrigin},共 ${steps.length} 个候选,命中即停。`);
		const results = [];
		let hit = null;
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i] as (typeof steps)[number];
			openVerbose(state);
			const offersBefore = state.offers.size;
			const notificationsBefore = state.notifications.length;
			const mark = state.recentGc.length;
			let payload: Uint8Array;
			try {
				payload = step.buf();
			} catch (err) {
				log('warn', `[terminal] 探针#${i} 构造失败: ${errorText(err)}`);
				continue;
			}
			try {
				send(attempt, step.mt, step.header, payload);
			} catch (err) {
				log('warn', `[terminal] 探针#${i} 发送失败: ${errorText(err)}`);
				continue;
			}
			await sleep(2500);
			const replies = state.recentGc.slice(mark);
			const soMessages = replies.filter(r => ([SO_MSG.Create, SO_MSG.Update, SO_MSG.Destroy, SO_MSG.UpdateMultiple] as number[]).includes(r.mt));
			const acks = replies.filter(r => r.mt === MSG.UnlockCrateResponse || r.mt === MSG.UseItemResponse);
			const offersNew = state.offers.size - offersBefore;
			const notifsNew = state.notifications.length - notificationsBefore;
			const origin = originOf(subjectId);
			const mutated = offersNew > 0 || notifsNew > 0 || soMessages.length > 0 || (origin != null && origin !== startOrigin);
			const ackHex = acks.map(a => `${a.mt}:${a.hex}`).join(',') || '—';
			const soDesc = soMessages.map(s => SO_MSG_NAME[s.mt] || s.mt).join(',') || '—';
			log('info', `[terminal] 探针#${i} ${step.label} → ACK[${ackHex}] SO[${soDesc}] 报价+${offersNew} 通知+${notifsNew} origin=${origin}${mutated ? '  ★★★ 有变动!' : ''}`);
			const result = {i, label: step.label, mt: step.mt, ackHex, soDesc, offersNew, notifsNew, origin, mutated};
			results.push(result);
			if (mutated) {
				hit = result;
				log('info', `[terminal] ✅ 探针命中于 #${i} ${step.label} —— 立即停止,后续候选不再发送。`);
				break;
			}
		}
		if (!hit) {
			log('info', `[terminal] 探针结束:${steps.length} 个候选均无 SO 变动(全是纯 ACK/无回包)。→ 真正的解封消息不在此列,需抓官方客户端实包。`);
		}
		return {subjectId, startOrigin, hit, results};
	}

	/**
	 * 安全读当前报价,不消耗次数:只发只读的加载内容(1094 CasketItemLoadContents,不行再 2536),绝不发 2534(2534 = 推进 = 消耗)
	 */
	async function readOffers(attempt: Attempt, terminalId: unknown) {
		requireGc(attempt);
		attach(attempt);
		const state = ensureState(attempt);
		openVerbose(state);
		const tid = digits(terminalId);
		if (!tid) {
			throw new Error('未提供终端机 GC id');
		}
		const term = listTerminalGcItems(attempt).find(t => String(t.id) === tid);
		if (term && Number(term.origin) !== 8) {
			log('warn', `[terminal] ⚠ 终端机 origin=${term.origin}(≠8 未解封);当前无报价很正常,请先解封。`);
		}
		const casketBody = () => GcProtos.CMsgCasketItem!.encode({casket_item_id: tid, item_item_id: tid}).finish();
		log('info', `[terminal] ▶ 安全读报价(不消耗次数) 终端机=${tid}`);
		let skins = collectSkins(state, attempt, tid);
		if (!skins.length) {
			send(attempt, MSG.CasketItemLoadContents, {}, casketBody());
			log('info', '[terminal] 已发 CasketItemLoadContents(1094) 加载当前报价(只读,不消耗)');
			await sleep(2200);
			skins = collectSkins(state, attempt, tid);
		}
		if (!skins.length) {
			send(attempt, MSG.VolatileItemLoadContents, {}, casketBody());
			log('info', '[terminal] 已发 VolatileItemLoadContents(2536) 再试加载(只读,不消耗)');
			await sleep(2200);
			skins = collectSkins(state, attempt, tid);
		}
		state.resolvedOffers = skins;
		logSkins(skins);
		if (!skins.length) {
			log('info', '[terminal] 未读到当前报价 → 该终端机可能还没生成报价,请点「下一个报价」生成(会消耗 1 次挑选、不可逆)。');
		}
		log('info', `[terminal] 安全读结束:${skins.length} 个报价皮肤(casket_id=${tid},未消耗)`);
		return {ok: true, terminalId: tid, count: skins.length, skins, consumed: false};
	}

	/**
	 * 推进到下一个报价(不可逆,消耗 1 次挑选):= 客户端 UseToolWithIntArg(容器, 容器, 当前计数)
	 * = 2534 CMsgOpenCrate{tool = subject = 终端机, points_remaining}。当前报价被丢弃,回不去。
	 */
	async function advanceOffer(attempt: Attempt, terminalId: unknown, opts: {pointsRemaining?: unknown} = {}) {
		requireGc(attempt);
		attach(attempt);
		const state = ensureState(attempt);
		openVerbose(state);
		const tid = digits(terminalId);
		if (!tid) {
			throw new Error('未提供终端机 GC id');
		}
		const term = listTerminalGcItems(attempt).find(t => String(t.id) === tid);
		if (term && Number(term.origin) !== 8) {
			throw new Error(`终端机 origin=${term.origin}(≠8),请先解封再推进报价`);
		}
		let points = opts.pointsRemaining != null && opts.pointsRemaining !== '' ? Number(opts.pointsRemaining) : readPicksUsed(term);
		if (points == null || !Number.isFinite(points)) {
			points = 1;
		}
		const previous = new Set(collectSkins(state, attempt, tid).map(s => String(s.itemid)));
		log('info', `[terminal] ▶ 推进到下一个报价(不可逆·消耗1次) 终端机=${tid} points_remaining=${points}`);
		send(attempt, MSG.OpenCrate, {}, CMsgOpenCrate.encode({tool_item_id: tid, subject_item_id: tid, points_remaining: points}).finish());
		log('info', `[terminal] 已发 OpenCrate(2534) {tool=${tid}, subject=${tid}, points_remaining=${points}}(=UseToolWithIntArg 推进)→ 盼新报价 type1 + 1090`);
		await sleep(2800);
		send(attempt, MSG.CasketItemLoadContents, {}, GcProtos.CMsgCasketItem!.encode({casket_item_id: tid, item_item_id: tid}).finish());
		await sleep(1600);
		const skins = collectSkins(state, attempt, tid);
		state.resolvedOffers = skins;
		const fresh = skins.filter(s => !previous.has(String(s.itemid)));
		logSkins(skins);
		log('info', `[terminal] 推进结束:当前 ${skins.length} 个报价(新出现 ${fresh.length} 个)。已消耗 1 次挑选(不可逆)。`);
		return {ok: true, terminalId: tid, pointsRemaining: points, count: skins.length, skins, fresh, consumed: true};
	}

	/**
	 * 拉 volatile shop 报价:ClientRequestOffers(空)+ VolatileShopSubscribe;给了已解封终端机的 GC id 再发
	 * VolatileItemLoadContents(2536)+ CMsgCasketItem{两个字段都填终端机 id}
	 */
	function requestOffers(attempt: Attempt, opts: {defidx?: unknown; itemId?: unknown} = {}) {
		requireGc(attempt);
		attach(attempt);
		openVerbose(ensureState(attempt));
		send(attempt, MSG.ClientRequestOffers, {}, Buffer.alloc(0));
		log('info', `[terminal] 已发送 ClientRequestOffers 账号=${attempt.accountName}`);
		const defidx = Number(opts.defidx) || 0;
		let itemId = digits(opts.itemId);
		// GC item id 是单个 uint64(不超过 20 位);超长多半是前端把多个 id 拼在一起了
		if (itemId.length > 19) {
			log('warn', `[terminal] ⚠ itemId 非法(${itemId.length} 位,像多个 id 拼接:${itemId.slice(0, 24)}…)→ 忽略。请在「GC id」框只填单个已解封终端机 id(如 52603299338)`);
			itemId = '';
		}
		const subscribe: Record<string, unknown> = {gctime: 0};
		if (defidx > 0) {
			subscribe.defidx = defidx;
		}
		if (itemId) {
			subscribe.psid = itemId;
		}
		send(attempt, MSG.VolatileShopSubscribe, {}, CMsgVolatileShopSubscribe.encode(subscribe).finish());
		log('info', `[terminal] 已发送 VolatileShopSubscribe defidx=${defidx || '-'} psid=${itemId || '-'}`);
		if (itemId) {
			send(attempt, MSG.VolatileItemLoadContents, {}, GcProtos.CMsgCasketItem!.encode({casket_item_id: itemId, item_item_id: itemId}).finish());
			log('info', `[terminal] 已发送 VolatileItemLoadContents(2536) CMsgCasketItem{both=${itemId}} → 盼 type20 报价 / type1 皮肤注入`);
		} else {
			log('warn', '[terminal] 未提供 itemId,跳过 VolatileItemLoadContents(2536);请传入已解封终端机的 GC id');
		}
		return {sent: true, defidx: defidx || null, itemId: itemId || null};
	}

	/** GC 通路自检:用肯定会回包的 requestPlayersProfile(查自己)判断「开箱被拦」还是「整条 GC 不通」 */
	function selfTest(attempt: Attempt) {
		if (!attempt.cs2GcConnected) {
			throw new Error('该账号未连接 CS2 GC');
		}
		const csgo = cs2(attempt);
		if (!csgo) {
			throw new Error('无 csgo 实例(attempt.csgo 缺失)');
		}
		const state = ensureState(attempt);
		attach(attempt);
		openVerbose(state);
		const steamID = attempt.client && client(attempt).steamID;
		const info = {haveGCSession: !!csgo.haveGCSession, isInCSGO: !!csgo._isInCSGO, steamID: steamID ? steamID.getSteamID64() : null};
		log('info', `[terminal] GC 自检:haveGCSession=${info.haveGCSession} isInCSGO=${info.isInCSGO} steamID=${info.steamID || '-'}`);
		const terminals = listTerminalGcItems(attempt);
		log('info', `[terminal] GC 库存 def=5176 终端机 ${terminals.length} 个(库存共 ${Array.isArray(csgo.inventory) ? csgo.inventory.length : 'N/A'} 件):`);
		terminals.forEach((t, i) => log('info', `[terminal]   #${i}: ${describeTerminalItem(t)}`));
		if (!steamID || typeof csgo.requestPlayersProfile !== 'function') {
			log('warn', '[terminal] 自检无法发起:缺 steamID 或 requestPlayersProfile 方法');
			return {sent: false, info};
		}
		let responded = false;
		try {
			csgo.requestPlayersProfile(steamID, () => {
				responded = true;
				log('info', '[terminal] ★ GC 自检回包:requestPlayersProfile 有响应 → GC 请求通路正常(开箱无回包=被服务端拦,不是发不出去)');
			});
			log('info', '[terminal] 已发送 requestPlayersProfile(查自己),等回包(8s)…');
		} catch (err) {
			log('warn', '[terminal] 自检发送出错: ' + errorText(err));
		}
		setTimer(() => {
			if (!responded) {
				log('warn', '[terminal] ⚠ GC 自检:8s 内无回包 → 本会话连 requestPlayersProfile 都不回,是整条 GC 发送/会话有问题(不是开箱被拦)。建议重连该账号 GC 再试。');
			}
		}, 8000);
		return {sent: true, info};
	}

	/** 裸检视:直接发 9156,自定 param_s/a/d/m(lib 的 inspectItem 只支持 owner 路线,对 faux 报价物品无效) */
	function rawInspect(attempt: Attempt, params: Record<string, unknown>): void {
		const body = {param_s: params.param_s || 0, param_a: params.param_a || 0, param_d: params.param_d || 0, param_m: params.param_m || 0};
		send(attempt, MSG.InspectRequest, {}, GcProtos.CMsgGCCStrike15_v2_Client2GCEconPreviewDataBlockRequest!.encode(body).finish());
	}

	/**
	 * 把报价的 faux_itemid 解成真实皮肤:faux 不在库存里,owner 路线查不到,逐个 faux 轮多种检视参数组合,
	 * 命中(收到 inspectItemInfo)就锁定那种组合给后面的 faux;第一个 faux 所有组合都没回包就放弃
	 */
	async function resolveOffers(attempt: Attempt) {
		const state = ensureState(attempt);
		const csgo = cs2(attempt);
		const steamID = attempt.client && client(attempt).steamID ? (client(attempt).steamID as {getSteamID64(): string}).getSteamID64() : (attempt.steamID || null);
		if (!csgo || !attempt.client || typeof client(attempt).sendToGC !== 'function') {
			return {ok: false, error: '无法检视(缺 sendToGC)', items: []};
		}
		const pairs: Array<{f: string; gt: number}> = [];
		for (const offer of state.offers.values()) {
			const faux = offer.fauxItemIds || [];
			const generation = offer.generationTime || [];
			faux.forEach((f, index) => {
				if (!pairs.find(p => p.f === f)) {
					pairs.push({f, gt: Number(generation[index] || 0)});
				}
			});
		}
		if (!pairs.length) {
			return {ok: true, count: 0, total: 0, items: []};
		}
		openVerbose(state);
		const results: Array<{itemid: string; defindex: number; paintindex: number; paintwear: number; paintseed: number; rarity: number}> = [];
		const seen = new Set<string>();
		const onInfo = (item: any) => {
			try {
				const id = item.itemid != null ? item.itemid.toString() : 'x' + results.length;
				if (seen.has(id)) {
					return;
				}
				seen.add(id);
				const record = {itemid: id, defindex: Number(item.defindex || 0), paintindex: Number(item.paintindex || 0), paintwear: Number(item.paintwear || 0), paintseed: Number(item.paintseed || 0), rarity: Number(item.rarity || 0)};
				results.push(record);
				state.resolvedOffers = results.slice();
				log('info', `[terminal] ★ 报价解析 → defindex=${record.defindex} paint=${record.paintindex} wear=${record.paintwear} seed=${record.paintseed} (itemid=${record.itemid})`);
			} catch {
				// 忽略坏包
			}
		};
		csgo.on('inspectItemInfo', onInfo);
		// 已解封终端机(origin=8)的 id 和终端机 defidx,当作 param_d / param_m 的容器上下文候选
		const contexts = [...new Set(listTerminalGcItems(attempt).filter(t => Number(t.origin) === 8).map(t => String(t.id)).concat([...TERMINAL_DEF_INDICES].map(String)))];
		type Combo = {label: string; build(f: string, gt: number): Record<string, unknown>};
		const combos: Combo[] = [
			{label: 'a-only', build: f => ({param_a: f})},
			{label: 's=owner', build: f => ({param_s: steamID, param_a: f})},
			{label: 'a+d=gt', build: (f, gt) => ({param_a: f, param_d: gt})},
			{label: 's+d=gt', build: (f, gt) => ({param_s: steamID, param_a: f, param_d: gt})},
			{label: 'd=faux', build: f => ({param_a: f, param_d: f})}
		];
		for (const context of contexts) {
			combos.push({label: `s+m=ctx${context}`, build: f => ({param_s: steamID, param_a: f, param_m: context})});
			combos.push({label: `s+d=ctx${context}`, build: f => ({param_s: steamID, param_a: f, param_d: context})});
			combos.push({label: `m=ctx${context}`, build: f => ({param_a: f, param_m: context})});
		}
		let locked: Combo | null = null;
		let anyHit = false;
		try {
			for (let pi = 0; pi < pairs.length; pi++) {
				const {f, gt} = pairs[pi] as {f: string; gt: number};
				const candidates: Combo[] = locked ? [locked] : combos;
				for (const combo of candidates) {
					const before = results.length;
					try {
						rawInspect(attempt, combo.build(f, gt));
						log('info', `[terminal] 检视 faux=${f} 组合[${combo.label}] …`);
					} catch (err) {
						log('warn', '[terminal] 检视发送出错: ' + errorText(err));
					}
					await sleep(1200);
					if (results.length > before) {
						anyHit = true;
						if (!locked) {
							locked = combo;
							log('info', `[terminal] ✅ 命中检视组合 [${combo.label}] → 锁定给后续 faux`);
						}
						break;
					}
				}
				if (pi === 0 && !anyHit) {
					log('info', `[terminal] 首个 faux 遍历 ${combos.length} 种组合均无回包 → faux 物品无法用检视(9156)解出,放弃。`);
					break;
				}
			}
		} finally {
			try {
				csgo.removeListener('inspectItemInfo', onInfo);
			} catch {
				// 忽略
			}
		}
		log('info', `[terminal] 报价解析结束:${results.length}/${pairs.length} 成功`);
		return {ok: true, count: results.length, total: pairs.length, items: results};
	}

	/** 前端用的状态:终端机列表(是否已解封、已开次数、到期时间、当前报价)、抓到的报价、SO 类型统计、最近的通知和日志 */
	function getState(attempt: Attempt) {
		const state = ensureState(attempt);
		return {
			attached: state.attached,
			offers: [...state.offers.values()],
			resolvedOffers: state.resolvedOffers || [],
			terminals: listTerminalGcItems(attempt).map(t => {
				const id = String(t.id);
				const picksUsed = readPicksUsed(t);
				const expiresAt = readExpiration(t);
				// 已解封:有倒计时、有已开次数、或 origin=8 任一成立。只看 origin 会把别的来源(交易/购买)解封的漏掉
				const sealed = !(Number(t.origin) === 8 || expiresAt != null || picksUsed != null);
				return {
					id, defIndex: Number(t.def_index || 0), origin: Number(t.origin || 0), sealed,
					picksUsed,
					picksMax: TERMINAL_MAX_PICKS,
					picksLeft: picksUsed != null ? Math.max(0, TERMINAL_MAX_PICKS - picksUsed) : null,
					expiresAt,
					offer: sealed ? null : (collectSkins(state, attempt, id)[0] || null)
				};
			}),
			soTypeIds: [...state.soTypes.entries()].map(([type_id, count]) => ({type_id, count})).sort((a, b) => b.count - a.count),
			injectedSkins: state.injectedSkins.slice(-20),
			notifications: state.notifications.slice(-10),
			gcLog: state.gcLog.slice(-40)
		};
	}

	function clear(attempt: Attempt): void {
		const state = ensureState(attempt);
		state.offers.clear();
		state.soTypes.clear();
		state.resolvedOffers = [];
		state.injectedSkins = [];
		state.notifications.length = 0;
		state.gcLog.length = 0;
	}

	return {attach, unseal, probe, readOffers, advanceOffer, requestOffers, selfTest, resolveOffers, getState, clear};
}

export type Cs2Terminal = ReturnType<typeof createCs2Terminal>;
