// CS2「终端机」相关的 GC 协议细节(从 app/lib/cs2-terminal.js 移来):消息号、本地补的 protobuf 定义、SO 缓存解析、
// 终端机物品属性。node-globaloffensive(v3.3.0)协议过时、不支持这些,所以直接收发原始 GC 消息。
//
// 协议对照 GameTracking-CS2:
//   - 解封 / 推进报价:OpenCrate(2534) + CMsgOpenCrate;1007 已废弃,只剩 ItemCustomizationNotification 的 request 标记;
//   - 只读加载报价:CasketItemLoadContents(1094) / VolatileItemLoadContents(2536) + CMsgCasketItem;
//   - 报价对象 CSOVolatileItemOffer 走 SO 缓存(type_id 实测 20);报价皮肤作为 CSOEconItem(type 1)放在终端机这个「容器」里。

import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs') as {parse(source: string, options: {keepCase: boolean}): {root: {lookupType(name: string): ProtoType}}};
const GcLanguage = require('globaloffensive/language') as Record<string, number | undefined>;

export interface ProtoType {
	encode(message: Record<string, unknown>): {finish(): Uint8Array};
	decode(data: Uint8Array): any;
}

/** globaloffensive 自带的 protobuf(按名字取) */
export const GcProtos = require('globaloffensive/protobufs/generated/_load') as Record<string, ProtoType>;
export const GcBaseMessages = require('globaloffensive/protobufs/generated/base_gcmessages') as Record<string, ProtoType>;

export const CS2_APP_ID = 730;

export const MSG = {
	/** k_EMsgGCOpenCrate:现代开箱/开容器(推进报价也用它) */
	OpenCrate: 2534,
	/** k_EMsgGCVolatileItemLoadContents:volatile 容器专用加载 */
	VolatileItemLoadContents: 2536,
	/** k_EMsgGCUnlockCrate_DEPRECATED:已废弃,现在只作 ItemCustomizationNotification 的 request 标记 */
	UnlockCrateDeprecated: 1007,
	UnlockCrateResponse: 1008,
	UseItemRequest: Number(GcLanguage.UseItemRequest) || 1025,
	UseItemResponse: 1026,
	ClientRequestOffers: Number(GcLanguage.ClientRequestOffers) || 9195,
	VolatileShopSubscribe: 9228,
	ItemCustomizationNotification: Number(GcLanguage.ItemCustomizationNotification) || 1090,
	ClientWelcome: Number(GcLanguage.ClientWelcome) || 4004,
	InspectRequest: Number(GcLanguage.Client2GCEconPreviewDataBlockRequest) || 9156,
	InspectResponse: Number(GcLanguage.Client2GCEconPreviewDataBlockResponse) || 9157,
	CasketItemLoadContents: Number(GcLanguage.CasketItemLoadContents) || 1094
} as const;

/** SharedObject 缓存消息(k_ESOMsg_*)。开箱成功的真实信号在这里(Destroy 旧箱 + Create 新物/报价),不在 1008 回包 */
export const SO_MSG = {Create: 21, Update: 22, Destroy: 23, CacheSubscribed: 24, UpdateMultiple: 26} as const;
export const SO_MSG_NAME: Readonly<Record<number, string>> = {21: 'Create', 22: 'Update', 23: 'Destroy', 24: 'CacheSubscribed', 26: 'UpdateMultiple'};
/** 普通饰品 CSOEconItem 的 SO type_id */
export const ECON_ITEM_SO_TYPE = 1;
/** CSOVolatileItemOffer 的 SO type_id(2026-07-01 实机抓到:账号解封后 welcome 缓存多出 20) */
export const KNOWN_OFFER_SO_TYPE = 20;
/** EGCMsgResponse(GC SDK 标准返回码) */
export const EGC_RESPONSE: Readonly<Record<number, string>> = {0: 'OK', 1: 'Denied', 2: 'ServerError', 3: 'Timeout', 4: 'Invalid', 5: 'NoMatch', 6: 'UnknownError', 7: 'NotLoggedOn', 8: 'FailedToCreate'};

// globaloffensive 自带的 protobuf 里没有的,自己定义(proto2,keepCase 与自带的一致用 snake_case)
const localRoot = protobuf.parse(`
syntax = "proto2";
message CSOVolatileItemOffer {
	optional uint32 defidx = 1;
	repeated uint64 faux_itemid = 2;
	repeated uint32 generation_time = 3;
}
message CMsgVolatileShopSubscribe {
	optional uint32 defidx = 1;
	optional uint64 psid = 2;
	optional uint32 upnext = 3;
	optional uint32 gctime = 4;
	optional bytes payload = 5;
}
message CMsgOpenCrate {
	optional uint64 tool_item_id = 1;
	optional uint64 subject_item_id = 2;
	optional bool for_rental = 3;
	optional uint32 points_remaining = 4;
	optional uint32 volatile_limit = 5;
}
`, {keepCase: true}).root;
export const CSOVolatileItemOffer = localRoot.lookupType('CSOVolatileItemOffer');
export const CMsgVolatileShopSubscribe = localRoot.lookupType('CMsgVolatileShopSubscribe');
export const CMsgOpenCrate = localRoot.lookupType('CMsgOpenCrate');

/**
 * 终端机 = items_game 里带 volatile 容器机制的箱子(prefab 含 volatile_pricing)。
 * 5176 = 创世终端机(crate_community_36)、5181 = 毁灭之手终端机(crate_community_37);Valve 再加只需往这里补。
 */
export const TERMINAL_DEF_INDICES: ReadonlySet<number> = new Set([5176, 5181]);
export const TERMINAL_DEF_INDEX = 5176;
/** 每个终端机能挑选(换报价)的次数上限:attr169 实测是「已开次数」(0→5 递增),上限是游戏固定逻辑 */
export const TERMINAL_MAX_PICKS = 5;

export const isTerminalDef = (defIndex: unknown): boolean => TERMINAL_DEF_INDICES.has(Number(defIndex));

/** globaloffensive 解析好的 GC 库存物品(用到的字段) */
export interface GcItem {
	id?: unknown;
	original_id?: unknown;
	def_index?: unknown;
	inventory?: unknown;
	flags?: unknown;
	origin?: unknown;
	quantity?: unknown;
	casket_id?: unknown;
	paint_index?: number | null;
	paint_seed?: number | null;
	paint_wear?: number | null;
	rarity?: unknown;
	quality?: unknown;
	attribute?: Array<{def_index?: unknown; value_bytes?: Uint8Array | number[] | null; value?: unknown}>;
}

function attributeBytes(item: GcItem | null | undefined, defIndex: number): Buffer | null {
	const attribute = (item && item.attribute || []).find(a => Number(a.def_index) === defIndex);
	return attribute && attribute.value_bytes && attribute.value_bytes.length ? Buffer.from(attribute.value_bytes) : null;
}

/** 日志用:一个终端机物品的关键字段 */
export function describeTerminalItem(item: GcItem | null | undefined): string {
	if (!item) {
		return '(未在 lib GC 库存里找到;可能 lib 未缓存该物品)';
	}
	let attrs = '';
	if (Array.isArray(item.attribute)) {
		attrs = item.attribute.map(a => {
			const bytes = a && a.value_bytes && a.value_bytes.length ? Buffer.from(a.value_bytes).toString('hex') : '';
			const value = a && a.value != null ? a.value : '';
			return `${a && a.def_index}=${bytes || value}`;
		}).join(' ');
	}
	return `id=${item.id} original_id=${item.original_id || 0} def_index=${item.def_index} pos=${item.inventory || 0} flags=${item.flags || 0} origin=${item.origin || 0} qty=${item.quantity || 0} attrs[${attrs}]`;
}

/** 已开次数(attr169,uint32 LE);旧名 readPointsRemaining,其实是递增的已开次数 */
export function readPicksUsed(item: GcItem | null | undefined): number | null {
	try {
		const bytes = attributeBytes(item, 169);
		if (bytes && bytes.length >= 4) {
			return bytes.readUInt32LE(0);
		}
		const attribute = (item && item.attribute || []).find(a => Number(a.def_index) === 169);
		if (attribute && attribute.value != null) {
			return Number(attribute.value);
		}
	} catch {
		// 读不出来当没有
	}
	return null;
}

/** 解封后 72h 倒计时的到期时间(attr183 = expiration_date,uint32 unix 秒 → 毫秒) */
export function readExpiration(item: GcItem | null | undefined): number | null {
	try {
		const bytes = attributeBytes(item, 183);
		if (bytes && bytes.length >= 4) {
			return bytes.readUInt32LE(0) * 1000;
		}
	} catch {
		// 读不出来当没有
	}
	return null;
}

/** 不整体解码,只读 CSOEconItem 的 id(字段 1 varint):对海量 type1 快速筛 faux 命中 */
export function peekEconItemId(data: unknown): string | null {
	try {
		const bytes = Buffer.isBuffer(data) ? data : Buffer.from((data || []) as Uint8Array);
		if (!bytes.length || bytes[0] !== 0x08) {
			return null;
		}
		let offset = 1;
		let shift = 0n;
		let value = 0n;
		let byte: number;
		do {
			byte = bytes[offset++] as number;
			value |= BigInt(byte & 0x7f) << shift;
			shift += 7n;
		} while ((byte & 0x80) && offset < bytes.length);
		return value.toString();
	} catch {
		return null;
	}
}

export interface DecodedEconItem {
	id: string | null;
	def_index: number;
	origin: number;
	rarity: number;
	quality: number;
	casketId: string | null;
	paint: {paintindex?: number; seed?: number; wear?: number};
	priceCents: number | null;
	attrStr: string;
}

/**
 * 解 CSOEconItem。皮肤外观/价格都在 attribute[].value_bytes(小端)里,不是 .value:
 * 6=paintindex(float)、7=seed(float 取整)、8=wear(float)、272/273=casket_id 低/高 32 位、316=报价价格(钱包分)。
 */
export function decodeEconItem(data: unknown): DecodedEconItem | null {
	try {
		const item = GcProtos.CSOEconItem!.decode(Buffer.isBuffer(data) ? data : Buffer.from((data || []) as Uint8Array));
		const attrs: any[] = item.attribute || [];
		const bytesOf = (defIndex: number): Buffer | null => {
			const attribute = attrs.find(x => Number(x.def_index) === defIndex);
			return attribute && attribute.value_bytes && attribute.value_bytes.length ? Buffer.from(attribute.value_bytes) : null;
		};
		const paint: DecodedEconItem['paint'] = {};
		let bytes: Buffer | null;
		if ((bytes = bytesOf(6)) && bytes.length >= 4) {
			paint.paintindex = Math.round(bytes.readFloatLE(0));
		}
		if ((bytes = bytesOf(7)) && bytes.length >= 4) {
			paint.seed = Math.floor(bytes.readFloatLE(0));
		}
		if ((bytes = bytesOf(8)) && bytes.length >= 4) {
			paint.wear = bytes.readFloatLE(0);
		}
		let casketId: string | null = null;
		const low = bytesOf(272);
		const high = bytesOf(273);
		if (low && high && low.length >= 4 && high.length >= 4) {
			casketId = ((BigInt(high.readUInt32LE(0)) << 32n) | BigInt(low.readUInt32LE(0))).toString();
		}
		let priceCents: number | null = null;
		if ((bytes = bytesOf(316)) && bytes.length >= 4) {
			priceCents = bytes.readUInt32LE(0);
		}
		// 全属性转储:4 字节的同时给 uint32LE 和 floatLE,便于人工找字段
		const attrStr = attrs.map(a => {
			const defIndex = Number(a.def_index);
			const raw = a.value_bytes && a.value_bytes.length ? Buffer.from(a.value_bytes) : null;
			if (raw && raw.length === 4) {
				const uint = raw.readUInt32LE(0);
				const float = raw.readFloatLE(0);
				const floatShow = Number.isFinite(float) && Math.abs(float) >= 1e-4 && Math.abs(float) < 1e9 ? '/f' + float.toPrecision(6) : '';
				return `${defIndex}=${uint}${floatShow}`;
			}
			return `${defIndex}=${raw ? raw.toString('hex') : (a.value != null ? 'v' + a.value : '')}`;
		}).join(' ');
		return {
			id: item.id != null ? item.id.toString() : null,
			def_index: Number(item.def_index || 0),
			origin: Number(item.origin || 0),
			rarity: Number(item.rarity || 0),
			quality: Number(item.quality || 0),
			casketId,
			paint,
			priceCents,
			attrStr
		};
	} catch {
		return null;
	}
}

/** 没有 schema 的 protobuf 顶层字段(如 UnlockCrateResponse 1008:field1 = result EGCMsgResponse) */
export function walkProto(buf: Buffer): Array<{field: number; v: string}> {
	const out: Array<{field: number; v: string}> = [];
	let offset = 0;
	const varint = (): bigint => {
		let shift = 0n;
		let value = 0n;
		let byte: number;
		do {
			byte = buf[offset++] as number;
			value |= BigInt(byte & 0x7f) << shift;
			shift += 7n;
		} while ((byte & 0x80) && offset < buf.length);
		return value;
	};
	try {
		while (offset < buf.length && out.length < 24) {
			const tag = varint();
			const field = Number(tag >> 3n);
			const wire = Number(tag & 7n);
			if (wire === 0) {
				out.push({field, v: varint().toString()});
			} else if (wire === 1) {
				out.push({field, v: 'f64'});
				offset += 8;
			} else if (wire === 2) {
				const length = Number(varint());
				out.push({field, v: `bytes[${length}]`});
				offset += length;
			} else if (wire === 5) {
				out.push({field, v: 'f32'});
				offset += 4;
			} else {
				break;
			}
		}
	} catch {
		// 截断的包:返回已读到的
	}
	return out;
}

/** 结构体(非 protobuf)回包按小端拆成 u16/u32,便于人工对齐 result / 回显字段 */
export function structInts(buf: Buffer): {u8: number[]; u16: number[]; u32: number[]} {
	const u16: number[] = [];
	for (let i = 0; i + 2 <= buf.length; i += 2) {
		u16.push(buf.readUInt16LE(i));
	}
	const u32: number[] = [];
	for (let i = 0; i + 4 <= buf.length; i += 4) {
		u32.push(buf.readUInt32LE(i));
	}
	return {u8: [...buf], u16, u32};
}

export interface SoObject {
	type_id: unknown;
	data: Buffer;
}

/** GC 欢迎消息内嵌的初始 SO 缓存(在官方客户端里解封后再连本工具,报价就在这里) */
export function extractWelcomeObjects(payload: Buffer): SoObject[] {
	const out: SoObject[] = [];
	try {
		const welcome = GcProtos.CMsgClientWelcome!.decode(payload);
		for (const cache of welcome.outofdate_subscribed_caches || []) {
			for (const group of cache.objects || []) {
				for (const data of group.object_data || []) {
					out.push({type_id: group.type_id, data});
				}
			}
		}
	} catch {
		// 不是合法的欢迎消息
	}
	return out;
}

export function extractSoObjects(msgType: number, payload: Buffer): SoObject[] {
	const out: SoObject[] = [];
	try {
		if (msgType === SO_MSG.CacheSubscribed) {
			const message = GcProtos.CMsgSOCacheSubscribed!.decode(payload);
			for (const group of message.objects || []) {
				for (const data of group.object_data || []) {
					out.push({type_id: group.type_id, data});
				}
			}
		} else if (msgType === SO_MSG.Create || msgType === SO_MSG.Update || msgType === SO_MSG.Destroy) {
			const message = GcProtos.CMsgSOSingleObject!.decode(payload);
			// Destroy 常只带 key(可能没有 object_data),type_id 也要记
			out.push({type_id: message.type_id, data: message.object_data || Buffer.alloc(0)});
		} else if (msgType === SO_MSG.UpdateMultiple) {
			const message = GcProtos.CMsgSOMultipleObjects!.decode(payload);
			for (const list of [message.objects_added, message.objects_modified]) {
				for (const group of list || []) {
					if (group.object_data) {
						out.push({type_id: group.type_id, data: group.object_data});
					}
				}
			}
		}
	} catch {
		// 解不出来就当没有
	}
	return out;
}

export interface VolatileOffer {
	defidx: number;
	fauxItemIds: string[];
	generationTime: number[];
}

export function tryDecodeOffer(data: unknown): VolatileOffer | null {
	if (!Buffer.isBuffer(data) || !data.length) {
		return null;
	}
	try {
		const offer = CSOVolatileItemOffer.decode(data);
		const faux: string[] = (offer.faux_itemid || []).map((x: {toString(): string}) => x.toString());
		if (offer.defidx && faux.length) {
			return {defidx: Number(offer.defidx), fauxItemIds: faux, generationTime: (offer.generation_time || []).map(Number)};
		}
	} catch {
		// 不是报价对象
	}
	return null;
}
