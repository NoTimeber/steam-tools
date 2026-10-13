'use strict';

/**
 * CS2「封装的创世终端机」(Sealed Genesis Terminal)开启支持 —— 阶段 P0/P1/P2。
 *
 * 机制:库存里「解封」(不可逆,启动 72h 倒计时)→ 军火商给最多 5 个固定价皮肤报价(volatile shop)
 *       → 花 Steam 钱包余额买其中一个。本模块只做到 P2(解封 + 读报价 + 抓包),【不含 P3 花钱兑换】。
 *
 * 协议(对照 GameTracking-CS2):
 *   - 解封:终端机=武器箱类容器,用开箱指令 UnlockCrate(1007) + CMsgOpenCrate{subject_item_id}(免费解封无钥匙,tool 省略)。
 *          旧代码误用 UseItem(1025) 实测零回包;成功信号=ItemCustomizationNotification(request=1007)/UnlockCrateResponse(1008)/SO 报价对象。
 *   - 拉报价:ClientRequestOffers(9195,空) / VolatileShopSubscribe(9228)。
 *   - 报价对象:CSOVolatileItemOffer{defidx, faux_itemid[], generation_time[]},走 SO 缓存
 *     (SO type_id 未知,靠抓包 getState().soTypeIds 定位后再把它填进 KNOWN_OFFER_SO_TYPE)。
 *   - 结果:itemCustomizationNotification(node-globaloffensive 已 emit)。
 *
 * node-globaloffensive(v3.3.0,2024-10)协议过时、不支持这些,故本模块直接用
 * client.sendToGC / client.on('receivedFromGC')(payload 恒为 Buffer),与 lib 并行、互不干扰。
 */

const protobuf = require('protobufjs');
const GcLanguage = require('globaloffensive/language');
const GcBaseMessages = require('globaloffensive/protobufs/generated/base_gcmessages');
const GcProtos = require('globaloffensive/protobufs/generated/_load');

const APPID = 730;
const MSG = {
	OpenCrate: 2534,               // k_EMsgGCOpenCrate —— 现代开箱/开容器请求 opcode(1007 已废弃、无 handler!)
	VolatileItemLoadContents: 2536,// k_EMsgGCVolatileItemLoadContents —— volatile 容器专用
	UnlockCrateDeprecated: 1007,   // k_EMsgGCUnlockCrate_DEPRECATED(已废弃;1007 现只作 ItemCustomizationNotification 的 request tag)
	UnlockCrateResponse: 1008,     // k_EMsgGCUnlockCrateResponse
	UseItemRequest: Number(GcLanguage.UseItemRequest) || 1025,
	UseItemResponse: 1026,
	ClientRequestOffers: Number(GcLanguage.ClientRequestOffers) || 9195,
	VolatileShopSubscribe: 9228,
	ItemCustomizationNotification: Number(GcLanguage.ItemCustomizationNotification) || 1090,
	ClientWelcome: Number(GcLanguage.ClientWelcome) || 4004,
	InspectRequest: Number(GcLanguage.Client2GCEconPreviewDataBlockRequest) || 9156,   // 检视/预览请求
	InspectResponse: Number(GcLanguage.Client2GCEconPreviewDataBlockResponse) || 9157,
	CasketItemLoadContents: Number(GcLanguage.CasketItemLoadContents) || 1094           // 存储单元加载内容(volatile 报价加载的 fallback)
};
// 触发动作后开一段「详细日志窗口」,把 GC 回包全打到控制台便于抓协议。
const VERBOSE_WINDOW_MS = 25000;
// 通用 SharedObject 缓存消息号(k_ESOMsg_*)。成功开箱的真实信号在这里(Destroy 旧箱 + Create 新物/报价),不在 1008 回包!
const SO_MSG = {Create: 21, Update: 22, Destroy: 23, CacheSubscribed: 24, UpdateMultiple: 26};
const SO_MSG_NAME = {21: 'Create', 22: 'Update', 23: 'Destroy', 24: 'CacheSubscribed', 26: 'UpdateMultiple'};
// 已知普通饰品 SO 类型(CSOEconItem=1),跳过不当报价解析,避免误判 & 噪音。
const ECON_ITEM_SO_TYPE = 1;
// 抓包确认报价的真实 SO type_id 后填这里(为 null 时对非 1 类型做启发式解析)。
const KNOWN_OFFER_SO_TYPE = 20; // CSOVolatileItemOffer 真实 SO type_id(2026-07-01 实机抓到=20:账号解封后 welcome 缓存多出 20)

// bundled protobufs 里没有的,自己定义(proto2,keepCase 与 bundled 一致用 snake_case)。
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
const CSOVolatileItemOffer = localRoot.lookupType('CSOVolatileItemOffer');
const CMsgVolatileShopSubscribe = localRoot.lookupType('CMsgVolatileShopSubscribe');
const CMsgOpenCrate = localRoot.lookupType('CMsgOpenCrate');

// 「终端机」= items_game 里带 volatile 容器机制的箱子(prefab 含 volatile_pricing)。目前 CS2 有两种:
//   5176 = 创世终端机(crate_community_36)、5181 = 毁灭之手终端机(crate_community_37)。
// 以后 Valve 再加只需往这个集合里补 def。TERMINAL_DEF_INDEX 保留给旧引用兜底(=创世)。
const TERMINAL_DEF_INDICES = new Set([5176, 5181]);
const TERMINAL_DEF_INDEX = 5176;
const isTerminalDef = (d) => TERMINAL_DEF_INDICES.has(Number(d));
// 每个终端机可挑选(换报价)的总次数上限。attr169 实测是「已开次数」(0→5 递增,到 5 就不能再开),
// 不是剩余次数;上限没写进 schema,是游戏固定逻辑,实测为 5。剩余 = MAX - 已开。
const TERMINAL_MAX_PICKS = 5;

function listTerminalGcItems(attempt) {
	const inv = attempt && attempt.csgo && Array.isArray(attempt.csgo.inventory) ? attempt.csgo.inventory : [];
	return inv.filter(it => it && isTerminalDef(it.def_index));
}

// 按 id 或 original_id 精确命中终端机(community assetid 常 = GC 的 original_id,而开箱必须用 GC 当前 id)。
// 没精确命中:仅当只有一个终端机才兜底返回它;多个则返回 null,交调用方报错,避免开错。
function findTerminalGcItem(attempt, assetid) {
	const terminals = listTerminalGcItems(attempt);
	if (assetid) {
		const s = String(assetid);
		const exact = terminals.find(it => String(it.id) === s || String(it.original_id) === s);
		if (exact) return exact;
	}
	return terminals.length === 1 ? terminals[0] : null;
}

function describeGcItem(it) {
	if (!it) return '(未在 lib GC 库存里找到;可能 lib 未缓存该物品)';
	let attrs = '';
	if (Array.isArray(it.attribute)) {
		attrs = it.attribute.map(a => {
			const vb = a && a.value_bytes && a.value_bytes.length ? Buffer.from(a.value_bytes).toString('hex') : '';
			const v = a && a.value != null ? a.value : '';
			return `${a && a.def_index}=${vb || v}`;
		}).join(' ');
	}
	return `id=${it.id} original_id=${it.original_id || 0} def_index=${it.def_index} pos=${it.inventory || 0} flags=${it.flags || 0} origin=${it.origin || 0} qty=${it.quantity || 0} attrs[${attrs}]`;
}

// CS2 皮肤外观存在 CSOEconItem 的 attribute 里:6=paintindex(纹理), 7=paintseed, 8=paintwear(float 位模式)。
// 报价皮肤若被 GC 作为 type1 注入,就能从这里直接取外观,无需检视。
// 轻量读 CSOEconItem 的 id(字段1 varint),不整体解码 —— 用于对海量 type1 快速筛 faux 命中。
function peekEconItemId(data) {
	try {
		const b = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
		if (!b.length || b[0] !== 0x08) return null;   // 字段1(id), wire 0
		let o = 1, shift = 0n, v = 0n, byte;
		do { byte = b[o++]; v |= BigInt(byte & 0x7f) << shift; shift += 7n; } while ((byte & 0x80) && o < b.length);
		return v.toString();
	} catch (e) { return null; }
}
// ★ CS2 皮肤外观/价格全存在 CSOEconItem 的 attribute[].value_bytes 里(小端),不是 .value!
//   6=paintindex(float), 7=seed(float floor), 8=wear(float);casket_id=272低+273高(uint32LE);价格=某内嵌 uint32 属性。
//   (对齐 node-globaloffensive handlers.js:155-188 的解法)
function decodeEconItem(data) {
	try {
		const it = GcProtos.CSOEconItem.decode(Buffer.isBuffer(data) ? data : Buffer.from(data || []));
		const attrs = it.attribute || [];
		const vb = (di) => { const a = attrs.find(x => Number(x.def_index) === di); return a && a.value_bytes && a.value_bytes.length ? Buffer.from(a.value_bytes) : null; };
		const paint = {}; let b;
		if ((b = vb(6)) && b.length >= 4) paint.paintindex = Math.round(b.readFloatLE(0));
		if ((b = vb(7)) && b.length >= 4) paint.seed = Math.floor(b.readFloatLE(0));
		if ((b = vb(8)) && b.length >= 4) paint.wear = b.readFloatLE(0);
		let casketId = null;
		const lo = vb(272), hi = vb(273);
		if (lo && hi && lo.length >= 4 && hi.length >= 4) casketId = ((BigInt(hi.readUInt32LE(0)) << 32n) | BigInt(lo.readUInt32LE(0))).toString();
		// ★ attr 316 = 报价价格(钱包分,实测 P2000红翼 = 43 = $0.43)。
		let priceCents = null;
		if ((b = vb(316)) && b.length >= 4) priceCents = b.readUInt32LE(0);
		// 全属性转储:价格藏在某个内嵌 uint32 属性里,逐个列 hex + uint32LE + floatLE 便于人工找价。
		const attrStr = attrs.map(a => {
			const di = Number(a.def_index);
			const raw = a.value_bytes && a.value_bytes.length ? Buffer.from(a.value_bytes) : null;
			if (raw && raw.length === 4) {
				const u = raw.readUInt32LE(0), f = raw.readFloatLE(0);
				const fShow = (Number.isFinite(f) && Math.abs(f) >= 1e-4 && Math.abs(f) < 1e9) ? '/f' + f.toPrecision(6) : '';
				return `${di}=${u}${fShow}`;
			}
			return `${di}=${raw ? raw.toString('hex') : (a.value != null ? 'v' + a.value : '')}`;
		}).join(' ');
		return {id: it.id != null ? it.id.toString() : null, def_index: Number(it.def_index || 0), origin: Number(it.origin || 0), rarity: Number(it.rarity || 0), quality: Number(it.quality || 0), casketId, paint, priceCents, attrStr};
	} catch (e) { return null; }
}

// 通用 protobuf 顶层字段解析(读没有 schema 的响应,如 UnlockCrateResponse 1008 —— 其 field1=result EGCMsgResponse)。
function walkProto(buf) {
	const out = []; let o = 0;
	try {
		while (o < buf.length && out.length < 24) {
			let shift = 0n, tag = 0n, b;
			do { b = buf[o++]; tag |= BigInt(b & 0x7f) << shift; shift += 7n; } while ((b & 0x80) && o < buf.length);
			const field = Number(tag >> 3n), wire = Number(tag & 7n);
			if (wire === 0) { let s = 0n, v = 0n, bb; do { bb = buf[o++]; v |= BigInt(bb & 0x7f) << s; s += 7n; } while ((bb & 0x80) && o < buf.length); out.push({field, v: v.toString()}); }
			else if (wire === 1) { out.push({field, v: 'f64'}); o += 8; }
			else if (wire === 2) { let s = 0n, l = 0n, bb; do { bb = buf[o++]; l |= BigInt(bb & 0x7f) << s; s += 7n; } while ((bb & 0x80) && o < buf.length); const L = Number(l); out.push({field, v: `bytes[${L}]`}); o += L; }
			else if (wire === 5) { out.push({field, v: 'f32'}); o += 4; }
			else break;
		}
	} catch (e) {}
	return out;
}
// EGCMsgResponse(GC SDK 标准返回码)
const EGC_RESPONSE = {0:'OK', 1:'Denied', 2:'ServerError', 3:'Timeout', 4:'Invalid', 5:'NoMatch', 6:'UnknownError', 7:'NotLoggedOn', 8:'FailedToCreate'};
// 结构体(非 protobuf)响应:按小端拆成 u16/u32 各种读法,便于人工对齐 result/回显字段。
function structInts(buf) {
	const u8 = [...buf];
	const u16 = []; for (let i = 0; i + 2 <= buf.length; i += 2) u16.push(buf.readUInt16LE(i));
	const u32 = []; for (let i = 0; i + 4 <= buf.length; i += 4) u32.push(buf.readUInt32LE(i));
	return {u8, u16, u32};
}

function createCs2Terminal(deps = {}) {
	const log = (level, msg) => {
		try { if (deps.logger && typeof deps.logger[level] === 'function') deps.logger[level](msg); } catch (_) {}
	};

	function ensureState(attempt) {
		if (!attempt._terminal) {
			attempt._terminal = {attached: false, offers: new Map(), soTypes: new Map(), notifications: [], gcLog: [], recentGc: [], injectedSkins: [], fauxIds: new Set(), verboseUntil: 0};
		}
		return attempt._terminal;
	}

	function openVerbose(state) {
		state.verboseUntil = Date.now() + VERBOSE_WINDOW_MS;
	}

	function logGc(state, entry) {
		state.gcLog.push(Object.assign({t: new Date().toISOString()}, entry));
		if (state.gcLog.length > 300) state.gcLog.shift();
	}

	// 附加原始 GC 抓包监听(与 node-globaloffensive 并行)。幂等。
	function attach(attempt) {
		const state = ensureState(attempt);
		if (state.attached) return;
		if (!attempt.client || typeof attempt.client.on !== 'function') return;
		state.attached = true;
		attempt.client.on('receivedFromGC', (appid, msgType, payload) => {
			if (Number(appid) !== APPID || !Buffer.isBuffer(payload)) return;
			const mt = Number(msgType);
			try {
				const verbose = Date.now() < state.verboseUntil;
				// 记录最近 GC 回包(供协议探针按步骤对齐响应)。只在详细窗口内记,避免噪音。
				if (verbose) {
					state.recentGc.push({t: Date.now(), mt, len: payload.length, hex: payload.length <= 64 ? payload.toString('hex') : payload.slice(0, 64).toString('hex') + '…'});
					if (state.recentGc.length > 200) state.recentGc.shift();
				}
				const notable = (mt === MSG.UnlockCrateResponse || mt === MSG.UseItemResponse);
				if (verbose || notable) log('info', `[terminal] ← GC 消息 msg=${mt} (${payload.length}B)${notable ? ' ★解封响应' : ''}`);
				if (notable) {
					const hex = payload.toString('hex');
					const fields = walkProto(payload);
					const okPb = fields.length > 0 && fields.every(f => f.field >= 1); // 合法 protobuf(字段号≥1)
					if (okPb) {
						const f1 = fields.find(f => f.field === 1);
						const rv = f1 ? Number(f1.v) : null;
						log('info', `[terminal] ★解封响应(protobuf) result=${rv != null ? rv : '?'}(${rv != null ? (EGC_RESPONSE[rv] || 'code' + rv) : '?'}) 字段=[${fields.map(f => '#' + f.field + '=' + f.v).join(' ')}] hex=${hex}`);
					} else {
						// 结构体响应(如 1008 的 6B)。首个 u16 疑似 result(EGCMsgResponse);其余多为回显(如 volatile_limit)。
						const s = structInts(payload);
						const r = s.u16.length ? s.u16[0] : null;
						log('info', `[terminal] ★解封响应(结构体 ${payload.length}B) 疑似result=${r != null ? `${r}(${EGC_RESPONSE[r] || 'code' + r})` : '?'} u16le=[${s.u16.join(',')}] u32le=[${s.u32.join(',')}] hex=${hex}`);
						log('info', `[terminal]   ↑ 判定法:换个 volatile_limit 再发,若上面某个值跟着变=它是回显(则 result=0=OK,去看是否冒报价/origin翻转);若都不变=固定返回码`);
					}
				}
				// 解封/兑换结果通知:直接自己解(lib 的 handler 会过滤掉 item_id/request 缺失的,可能漏掉终端机的)。
				if (mt === MSG.ItemCustomizationNotification) captureCustomization(state, payload, verbose);
				onGc(state, mt, payload, verbose);
			} catch (e) {
				log('warn', '[terminal] GC 解析出错: ' + (e && e.message));
			}
		});
	}

	function captureCustomization(state, payload, verbose) {
		try {
			const m = GcProtos.CMsgGCItemCustomizationNotification.decode(payload);
			const rec = {t: new Date().toISOString(), request: Number(m.request || 0), itemIds: (m.item_id || []).map(x => x.toString())};
			state.notifications.push(rec);
			if (state.notifications.length > 50) state.notifications.shift();
			log('info', `[terminal] ★ ItemCustomizationNotification request=${rec.request} items=[${rec.itemIds.join(',')}]`);
		} catch (e) {
			if (verbose) log('warn', '[terminal] 解 ItemCustomizationNotification 失败: ' + (e && e.message));
		}
	}

	function uniqTypes(objs) {
		return [...new Set(objs.map(o => Number(o.type_id)))].join(',');
	}

	function onGc(state, msgType, payload, verbose) {
		let objs = null;
		if (msgType === MSG.ClientWelcome) {
			// GC 连接时的欢迎消息内嵌初始 SO 缓存(在官方客户端里解封后再连本工具,报价就在这里)。
			objs = extractWelcomeObjects(payload);
		} else if (msgType === SO_MSG.CacheSubscribed || msgType === SO_MSG.Create || msgType === SO_MSG.Update || msgType === SO_MSG.Destroy || msgType === SO_MSG.UpdateMultiple) {
			objs = extractSoObjects(msgType, payload);
			// 含非普通饰品类型时无条件打一条(即使不在详细窗口),便于抓报价类型。Destroy(旧箱销毁)也是成功信号,始终记。
			const isDestroy = msgType === SO_MSG.Destroy;
			if (objs.length && (verbose || isDestroy || objs.some(o => Number(o.type_id) !== ECON_ITEM_SO_TYPE))) {
				log('info', `[terminal] SO 消息 ${SO_MSG_NAME[msgType] || msgType}(${msgType}) type_ids=[${uniqTypes(objs)}]${isDestroy ? ' ← 有物品被销毁(可能开箱成功)' : ''}`);
			}
		}
		if (!objs) return;
		const isDelta = [SO_MSG.Create, SO_MSG.Update, SO_MSG.UpdateMultiple].includes(msgType); // 增量(非整库存快照)
		// 预扫:先把本批 type20 里的 faux id 收进 state.fauxIds(下面 type1 匹配要用;同一 welcome 里 type1 可能排在 type20 前)。
		for (const obj of objs) {
			if (Number(obj.type_id) === KNOWN_OFFER_SO_TYPE) {
				const off = tryDecodeOffer(obj.data);
				if (off) for (const f of off.fauxItemIds) state.fauxIds.add(String(f));
			}
		}
		let maskedType1 = 0; // 统计 0xF 掩码 id 的 type1(faux 若作为 type1 注入,会带这种 id)
		for (const obj of objs) {
			const tid = Number(obj.type_id);
			state.soTypes.set(tid, (state.soTypes.get(tid) || 0) + 1);
			if (tid === ECON_ITEM_SO_TYPE) {
				// ★ 核心:casket 内含(casket_id 指向某终端机)的非终端机 type1 物品 = 终端机生成的报价皮肤,外观+价格全在其 attribute。
				//   只在增量(Create/Update/UpdateMultiple)或 faux 命中时整体解码,避免把整库存都解一遍。
				const pid = peekEconItemId(obj.data);
				if (pid && /^(1[0-8]\d{18}|9[2-9]\d{18})$/.test(pid)) maskedType1++;
				const fauxHit = pid && state.fauxIds.has(pid);
				if (isDelta || fauxHit) {
					const ei = decodeEconItem(obj.data);
					if (ei) {
						const isTerminal = isTerminalDef(ei.def_index);
						const isCasketSkin = !!ei.casketId && !isTerminal;   // casket 内含皮肤 = 报价物品
						if (isCasketSkin || fauxHit) {
							state.injectedSkins = state.injectedSkins || [];
							if (!state.injectedSkins.find(s => s.id === ei.id)) state.injectedSkins.push(Object.assign({seenAt: new Date().toISOString(), faux: !!fauxHit}, ei));
							const priceStr = ei.priceCents != null ? `$${(ei.priceCents / 100).toFixed(2)}` : '?';
							log('info', `[terminal] ★★ 报价皮肤 def=${ei.def_index} paintindex=${ei.paint.paintindex} seed=${ei.paint.seed} wear=${ei.paint.wear} 价格=${priceStr} rarity=${ei.rarity} casket=${ei.casketId || '-'} id=${ei.id}`);
							log('info', `[terminal]   ↳ 全属性:[${ei.attrStr}]`);
						} else if (verbose) {
							log('info', `[terminal] type1 增量 def=${ei.def_index}${isTerminal ? '(终端机)' : ''} origin=${ei.origin} casket=${ei.casketId || '-'} attrs[${ei.attrStr}]`);
						}
					}
				}
				continue;
			}
			if (KNOWN_OFFER_SO_TYPE != null && tid !== KNOWN_OFFER_SO_TYPE) continue;
			const offer = tryDecodeOffer(obj.data);
			if (offer) {
				state.offers.set(String(offer.defidx), Object.assign({typeId: tid, seenAt: new Date().toISOString()}, offer));
				logGc(state, {kind: 'offer', typeId: tid, defidx: offer.defidx});
				log('info', `[terminal] ★ 捕获报价 defidx=${offer.defidx} fauxItemIds=${offer.fauxItemIds.join(',')} (SO type_id=${tid})`);
				// 全字段转储:faux 检视全失败 → 皮肤外观可能就藏在 type20 对象里(我只解了 3 个字段)。把所有顶层字段+原始 hex 打出来看。
				try {
					const raw = Buffer.isBuffer(obj.data) ? obj.data : Buffer.from(obj.data || []);
					log('info', `[terminal]   ↳ type20 全字段=[${walkProto(raw).map(f => '#' + f.field + '=' + f.v).join(' ')}]`);
					log('info', `[terminal]   ↳ type20 原始hex=${raw.toString('hex')}`);
				} catch (e) {}
			}
		}
		// 若本批 type1 里出现 0xF 掩码大 id(faux 作为 type1 注入的迹象),即使没匹配上也报一下,便于判断。
		if (maskedType1 > 0 && verbose) log('info', `[terminal] ⓘ 本批含 ${maskedType1} 个大id(≥0x8000…)的 type1 物品(疑似 faux 注入),已知 faux 数=${state.fauxIds.size}`);
	}

	function extractWelcomeObjects(payload) {
		const out = [];
		try {
			const w = GcProtos.CMsgClientWelcome.decode(payload);
			for (const cache of (w.outofdate_subscribed_caches || [])) {
				for (const grp of (cache.objects || [])) {
					for (const d of (grp.object_data || [])) out.push({type_id: grp.type_id, data: d});
				}
			}
		} catch (_) {}
		return out;
	}

	function extractSoObjects(msgType, payload) {
		const out = [];
		try {
			if (msgType === SO_MSG.CacheSubscribed) {
				const m = GcProtos.CMsgSOCacheSubscribed.decode(payload);
				for (const grp of (m.objects || [])) {
					for (const d of (grp.object_data || [])) out.push({type_id: grp.type_id, data: d});
				}
			} else if (msgType === SO_MSG.Create || msgType === SO_MSG.Update || msgType === SO_MSG.Destroy) {
				const m = GcProtos.CMsgSOSingleObject.decode(payload);
				// Destroy 常只带 key 字段(可能无 object_data),也要记录其 type_id。
				out.push({type_id: m.type_id, data: m.object_data || Buffer.alloc(0)});
			} else if (msgType === SO_MSG.UpdateMultiple) {
				const m = GcProtos.CMsgSOMultipleObjects.decode(payload);
				for (const list of [m.objects_added, m.objects_modified]) {
					for (const grp of (list || [])) if (grp.object_data) out.push({type_id: grp.type_id, data: grp.object_data});
				}
			}
		} catch (_) {}
		return out;
	}

	function tryDecodeOffer(data) {
		if (!Buffer.isBuffer(data) || !data.length) return null;
		try {
			const o = CSOVolatileItemOffer.decode(data);
			const faux = (o.faux_itemid || []).map(x => x.toString());
			if (o.defidx && faux.length) {
				return {defidx: Number(o.defidx), fauxItemIds: faux, generationTime: (o.generation_time || []).map(Number)};
			}
		} catch (_) {}
		return null;
	}

	// P2:解封(不可逆,72h)。终端机是「武器箱」类容器 → 走开箱指令 UnlockCrate(1007),不是 UseItem(1025)。
	// 现代 CS2:protobuf CMsgOpenCrate{subject_item_id=容器, tool_item_id=钥匙};终端机免费解封 = 无钥匙,tool 省略。
	// 成功信号:GC 回 ItemCustomizationNotification(request=1007) / UnlockCrateResponse(1008),或 SO 缓存冒出报价对象。
	// options.variant:'opencrate'(默认,1007 protobuf) | 'opencrate_tool'(tool 也设为自身) |
	//                 'opencrate_struct'(1007 旧结构体,16B 小端 key+crate) | 'useitem'(1025 旧法,对照用)。
	function unseal(attempt, itemId, options = {}) {
		const id = String(itemId || '').replace(/\D/g, '');
		if (!id) throw new Error('无效的物品 id');
		if (!attempt.cs2GcConnected) throw new Error('该账号未连接 CS2 GC');
		if (!attempt.client || typeof attempt.client.sendToGC !== 'function') throw new Error('账号未连接(无 sendToGC)');
		attach(attempt);
		openVerbose(ensureState(attempt));
		// 定位 GC 库存里的终端机。注意:community assetid ≠ GC 当前 id(前者常 = original_id),开箱必须用 GC 当前 id。
		const terminals = listTerminalGcItems(attempt);
		log('info', `[terminal] GC 库存 def=5176 终端机 ${terminals.length} 个:`);
		terminals.forEach((t, i) => log('info', `[terminal]   #${i}: ${describeGcItem(t)}`));
		let subjectId;
		const forced = String(options.gcItemId || '').replace(/\D/g, '');
		if (forced) {
			subjectId = forced;
			log('info', `[terminal] 使用指定 GC id=${subjectId}`);
		} else {
			const gcItem = findTerminalGcItem(attempt, id);
			if (gcItem && gcItem.id) {
				subjectId = String(gcItem.id);
				if (subjectId !== id) log('info', `[terminal] ⚠ 传入 assetid(${id})≠ GC id(${subjectId})(多半 community=original_id),已改用 GC 当前 id`);
			} else {
				throw new Error(`GC 库存里没有 id/original_id=${id} 的终端机(共 ${terminals.length} 个 def5176,已打到日志)。请用其中正确的 GC id(gcItemId)重试,避免开错终端机。`);
			}
		}
		const variant = String(options.variant || 'opencrate');
		// ★ volatile_limit = 客户端「报价上限」价格档(50/250/1000 USD / 无上限=0)。默认 0=无上限。
		const volatileLimit = (options.volatileLimit != null && options.volatileLimit !== '') ? Number(options.volatileLimit) : 0;
		const pointsRemaining = (options.pointsRemaining != null && options.pointsRemaining !== '') ? Number(options.pointsRemaining) : null;
		// ★★ 实测(协议探针命中):for_rental=true → GC 回 05=NoMatch、不解封;不带 for_rental → result=0、当场解封!
		//    所以默认【不带】for_rental,只有显式 forRental=true 才加(仅对照用)。
		const forRental = (options.forRental === true || options.forRental === 'true');
		let msgNum, header, buf, desc;
		if (variant === 'useitem') {
			msgNum = MSG.UseItemRequest; header = {}; desc = 'UseItem(1025·对照)';
			buf = GcBaseMessages.CMsgUseItem.encode({item_id: subjectId}).finish();
		} else if (variant === 'opencrate_struct') {
			// 旧结构体发去【已废弃的 1007】,仅对照。
			msgNum = MSG.UnlockCrateDeprecated; header = null; desc = 'UnlockCrate/struct(1007·废弃)';
			buf = Buffer.alloc(16);
			buf.writeBigUInt64LE(0n, 0);
			buf.writeBigUInt64LE(BigInt(subjectId), 8);
		} else if (variant === 'opencrate_1007') {
			// 旧 opcode(已废弃、之前零回包的元凶),仅对照。
			msgNum = MSG.UnlockCrateDeprecated; header = {}; desc = 'OpenCrate/pb(1007·废弃)';
			buf = CMsgOpenCrate.encode({subject_item_id: subjectId, volatile_limit: volatileLimit}).finish();
		} else {
			// ★ 正确路径:CMsgOpenCrate 发到 2534(k_EMsgGCOpenCrate,默认)或 2536(k_EMsgGCVolatileItemLoadContents)。
			msgNum = (variant === 'volatileload') ? MSG.VolatileItemLoadContents : MSG.OpenCrate;
			header = {};
			const body = {subject_item_id: subjectId};
			if (variant === 'opencrate_plain') {
				desc = `OpenCrate/pb(${msgNum},仅 subject)`;
			} else {
				// opencrate(默认) / volatileload:带 for_rental + volatile_limit(+可选 points)
				if (forRental) body.for_rental = true;
				body.volatile_limit = volatileLimit;
				if (pointsRemaining != null) body.points_remaining = pointsRemaining;
				desc = `OpenCrate/pb(${msgNum}${forRental ? ',rental' : ''},limit=${volatileLimit}${pointsRemaining != null ? `,points=${pointsRemaining}` : ''})`;
			}
			buf = CMsgOpenCrate.encode(body).finish();
		}
		attempt.client.sendToGC(APPID, msgNum, header, buf);
		log('info', `[terminal] 已发送解封 ${desc} item_id=${subjectId} 账号=${attempt.accountName}`);
		log('info', '[terminal] （成功信号在 SO 缓存,不在 1008 回包!盯:SO Destroy(23)/Create(21) / ★捕获报价(SO type 20) / ★ItemCustomizationNotification / 终端机 origin 24→8。1008 回固定 05=NoMatch=limit 档位无效）');
		return {sent: true, itemId: subjectId, variant, msg: desc, msgNum};
	}

	// 协议探针:对同一个 sealed 终端机,依次发多种候选开箱消息(2.5s 间隔),逐步对齐 GC 回包 + SO 变动,
	// 一旦检测到真实变动(报价/通知/SO Create·Destroy)立即停止(避免浪费 & 多发)。用于定位真正的解封消息。
	// 注意:某个候选若真的生效 = 不可逆消耗该终端机(默认用 limit=0 无上限,正是想要的)。
	async function probe(attempt, options = {}) {
		if (!attempt.cs2GcConnected) throw new Error('该账号未连接 CS2 GC');
		if (!attempt.client || typeof attempt.client.sendToGC !== 'function') throw new Error('账号未连接(无 sendToGC)');
		attach(attempt);
		const state = ensureState(attempt);
		// 定位 subject。
		let subjectId;
		const forced = String(options.gcItemId || '').replace(/\D/g, '');
		const id = String(options.itemId || options.assetid || '').replace(/\D/g, '');
		if (forced) subjectId = forced;
		else {
			const gcItem = findTerminalGcItem(attempt, id);
			if (gcItem && gcItem.id) subjectId = String(gcItem.id);
			else throw new Error('未定位到终端机 GC id,请用「填入未解封」或指定 gcItemId。');
		}
		const originOf = (sid) => {
			const it = listTerminalGcItems(attempt).find(t => String(t.id) === String(sid));
			return it ? Number(it.origin || 0) : null;
		};
		const startOrigin = originOf(subjectId);
		if (startOrigin !== 24) log('warn', `[terminal] ⚠ 探针目标 origin=${startOrigin}(≠24,可能已解封);建议选未解封的。`);
		const sub = BigInt(subjectId);
		// 候选消息(按「已知无害的 opencrate 变体 → 更可能的新候选」排序,命中即停)。
		const steps = [
			{label: 'opencrate/2534 rental+lim0', mt: MSG.OpenCrate, header: {}, buf: () => CMsgOpenCrate.encode({subject_item_id: subjectId, for_rental: true, volatile_limit: 0}).finish()},
			{label: 'opencrate/2534 norental+lim0', mt: MSG.OpenCrate, header: {}, buf: () => CMsgOpenCrate.encode({subject_item_id: subjectId, volatile_limit: 0}).finish()},
			{label: 'opencrate/2534 plain(仅subject)', mt: MSG.OpenCrate, header: {}, buf: () => CMsgOpenCrate.encode({subject_item_id: subjectId}).finish()},
			{label: 'opencrate/2534 self-tool', mt: MSG.OpenCrate, header: {}, buf: () => CMsgOpenCrate.encode({tool_item_id: subjectId, subject_item_id: subjectId, volatile_limit: 0}).finish()},
			{label: 'volatileload/2536 rental+lim0', mt: MSG.VolatileItemLoadContents, header: {}, buf: () => CMsgOpenCrate.encode({subject_item_id: subjectId, for_rental: true, volatile_limit: 0}).finish()},
			{label: 'volatileload/2536 plain', mt: MSG.VolatileItemLoadContents, header: {}, buf: () => CMsgOpenCrate.encode({subject_item_id: subjectId}).finish()},
			{label: 'volatileload/2536 subscribe-shape', mt: MSG.VolatileItemLoadContents, header: {}, buf: () => CMsgVolatileShopSubscribe.encode({psid: subjectId, defidx: TERMINAL_DEF_INDEX}).finish()},
			{label: 'useitem/1025', mt: MSG.UseItemRequest, header: {}, buf: () => GcBaseMessages.CMsgUseItem.encode({item_id: subjectId}).finish()},
			{label: 'unlock/1007 struct(key0+crate)', mt: MSG.UnlockCrateDeprecated, header: null, buf: () => { const b = Buffer.alloc(16); b.writeBigUInt64LE(0n, 0); b.writeBigUInt64LE(sub, 8); return b; }}
		];
		log('info', `[terminal] ▶ 协议探针启动:subject=${subjectId} origin=${startOrigin},共 ${steps.length} 个候选,命中即停。`);
		const sleep = (ms) => new Promise(r => setTimeout(r, ms));
		const results = [];
		let hit = null;
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			openVerbose(state);
			const offersBefore = state.offers.size, notifsBefore = state.notifications.length;
			const mark = state.recentGc.length;
			let buf;
			try { buf = step.buf(); } catch (e) { log('warn', `[terminal] 探针#${i} 构造失败: ${e.message}`); continue; }
			try { attempt.client.sendToGC(APPID, step.mt, step.header, buf); }
			catch (e) { log('warn', `[terminal] 探针#${i} 发送失败: ${e.message}`); continue; }
			await sleep(2500);
			const replies = state.recentGc.slice(mark);
			// SO 变动信号(除 1008/1026 这类纯 ACK 外)。
			const soMsgs = replies.filter(r => [SO_MSG.Create, SO_MSG.Update, SO_MSG.Destroy, SO_MSG.UpdateMultiple].includes(r.mt));
			const ackMsgs = replies.filter(r => r.mt === MSG.UnlockCrateResponse || r.mt === MSG.UseItemResponse);
			const offersNew = state.offers.size - offersBefore, notifsNew = state.notifications.length - notifsBefore;
			const nowOrigin = originOf(subjectId);
			const mutated = offersNew > 0 || notifsNew > 0 || soMsgs.length > 0 || (nowOrigin != null && nowOrigin !== startOrigin);
			const ackHex = ackMsgs.map(a => `${a.mt}:${a.hex}`).join(',') || '—';
			const soDesc = soMsgs.map(s => SO_MSG_NAME[s.mt] || s.mt).join(',') || '—';
			log('info', `[terminal] 探针#${i} ${step.label} → ACK[${ackHex}] SO[${soDesc}] 报价+${offersNew} 通知+${notifsNew} origin=${nowOrigin}${mutated ? '  ★★★ 有变动!' : ''}`);
			results.push({i, label: step.label, mt: step.mt, ackHex, soDesc, offersNew, notifsNew, origin: nowOrigin, mutated});
			if (mutated) { hit = results[results.length - 1]; log('info', `[terminal] ✅ 探针命中于 #${i} ${step.label} —— 立即停止,后续候选不再发送。`); break; }
		}
		if (!hit) log('info', `[terminal] 探针结束:${steps.length} 个候选均无 SO 变动(全是纯 ACK/无回包)。→ 真正的解封消息不在此列,需抓官方客户端实包。`);
		return {subjectId, startOrigin, hit, results};
	}

	// 读该终端机的「报价挑选剩余次数」(attr169 = quest points remaining, value_bytes uint32 LE)。
	function readPointsRemaining(term) {
		try {
			const a = term && (term.attribute || []).find(x => Number(x.def_index) === 169);
			if (a && a.value_bytes && a.value_bytes.length >= 4) return Buffer.from(a.value_bytes).readUInt32LE(0);
			if (a && a.value != null) return Number(a.value);
		} catch (e) {}
		return null;
	}
	// 读到期时间(attr183 = expiration_date, uint32 unix 秒 → 毫秒)。
	function readExpiration(term) {
		try {
			const a = term && (term.attribute || []).find(x => Number(x.def_index) === 183);
			if (a && a.value_bytes && a.value_bytes.length >= 4) return Buffer.from(a.value_bytes).readUInt32LE(0) * 1000;
		} catch (e) {}
		return null;
	}

	// 从 lib 已解析的库存里,捞出 casket_id==终端机id 的报价皮肤(lib 的 _processSOEconItem 已把 paint/casket_id 解好)。
	function scanCasketSkins(attempt, terminalId) {
		const inv = attempt.csgo && Array.isArray(attempt.csgo.inventory) ? attempt.csgo.inventory : [];
		const out = [];
		for (const it of inv) {
			if (!it || String(it.casket_id || '') !== String(terminalId)) continue;
			if (isTerminalDef(it.def_index)) continue;
			// lib 不解 attr316(价格),从原始 attribute 里自己取。
			let priceCents = null;
			const pa = (it.attribute || []).find(a => Number(a.def_index) === 316);
			if (pa && pa.value_bytes && pa.value_bytes.length >= 4) priceCents = Buffer.from(pa.value_bytes).readUInt32LE(0);
			out.push({
				id: it.id != null ? it.id.toString() : null,
				def_index: Number(it.def_index || 0),
				paintindex: it.paint_index != null ? Math.round(it.paint_index) : null,
				seed: it.paint_seed != null ? it.paint_seed : null,
				wear: it.paint_wear != null ? it.paint_wear : null,
				rarity: Number(it.rarity || 0),
				quality: Number(it.quality || 0),
				priceCents,
				casketId: String(it.casket_id)
			});
		}
		return out;
	}

	// 汇总某终端机「当前」报价皮肤:以 lib 库存(scanCasketSkins,当前 casket 内容、旧报价已被 SO Destroy)为准,
	// 用 state.injectedSkins(自己抓的,带 attrStr/价格)按 id 补全;lib 没有时才退回自己抓的。
	function collectSkins(state, attempt, tid) {
		const lib = scanCasketSkins(attempt, tid);
		const mineById = new Map((state.injectedSkins || []).filter(s => String(s.casketId) === tid).map(s => [s.id, s]));
		if (lib.length) {
			return lib.map(s => {
				const m = mineById.get(s.id);
				return {itemid: s.id, defindex: s.def_index, paintindex: s.paintindex, paintwear: s.wear, paintseed: s.seed, rarity: s.rarity, priceCents: s.priceCents != null ? s.priceCents : (m ? m.priceCents : null), attrStr: m ? m.attrStr : ''};
			});
		}
		return [...mineById.values()].map(s => ({itemid: s.id, defindex: s.def_index, paintindex: s.paint ? s.paint.paintindex : s.paintindex, paintwear: s.paint ? s.paint.wear : s.wear, paintseed: s.paint ? s.paint.seed : s.seed, rarity: s.rarity, priceCents: s.priceCents != null ? s.priceCents : null, attrStr: s.attrStr || ''}));
	}

	function logSkins(skins) {
		skins.forEach(s => log('info', `[terminal]   报价: def=${s.defindex} paint=${s.paintindex} 磨损=${s.paintwear != null ? Number(s.paintwear).toFixed(5) : '?'} 价格=${s.priceCents != null ? '$' + (s.priceCents / 100).toFixed(2) : '?'} id=${s.itemid}`));
	}

	// ★【安全读】读该终端机【当前】报价,不消耗次数。= 客户端 PerformItemCasketTransaction(0,容器,容器)=纯加载内容(只读)。
	//   只发加载内容(1094 CasketItemLoadContents;不行再 2536 VolatileItemLoadContents),【绝不发 2534】(2534=推进=消耗)。
	async function readOffers(attempt, terminalId, options = {}) {
		if (!attempt.cs2GcConnected) throw new Error('该账号未连接 CS2 GC');
		if (!attempt.client || typeof attempt.client.sendToGC !== 'function') throw new Error('账号未连接(无 sendToGC)');
		attach(attempt);
		const state = ensureState(attempt);
		openVerbose(state);
		const tid = String(terminalId || '').replace(/\D/g, '');
		if (!tid) throw new Error('未提供终端机 GC id');
		const term = listTerminalGcItems(attempt).find(t => String(t.id) === tid);
		if (term && Number(term.origin) !== 8) log('warn', `[terminal] ⚠ 终端机 origin=${term.origin}(≠8 未解封);当前无报价很正常,请先解封。`);
		const sleep = (ms) => new Promise(r => setTimeout(r, ms));
		const casketBody = () => GcProtos.CMsgCasketItem.encode({casket_item_id: tid, item_item_id: tid}).finish();
		log('info', `[terminal] ▶ 安全读报价(不消耗次数) 终端机=${tid}`);
		let skins = collectSkins(state, attempt, tid);
		// 只读加载:1094(CasketItemLoadContents)优先,再 2536(VolatileItemLoadContents);两者都是只读,不消耗。
		if (!skins.length) {
			attempt.client.sendToGC(APPID, MSG.CasketItemLoadContents, {}, casketBody());
			log('info', `[terminal] 已发 CasketItemLoadContents(1094) 加载当前报价(只读,不消耗)`);
			await sleep(2200);
			skins = collectSkins(state, attempt, tid);
		}
		if (!skins.length) {
			attempt.client.sendToGC(APPID, MSG.VolatileItemLoadContents, {}, casketBody());
			log('info', `[terminal] 已发 VolatileItemLoadContents(2536) 再试加载(只读,不消耗)`);
			await sleep(2200);
			skins = collectSkins(state, attempt, tid);
		}
		state.resolvedOffers = skins;
		logSkins(skins);
		if (!skins.length) log('info', `[terminal] 未读到当前报价 → 该终端机可能还没生成报价,请点「下一个报价」生成(会消耗 1 次挑选、不可逆)。`);
		log('info', `[terminal] 安全读结束:${skins.length} 个报价皮肤(casket_id=${tid},未消耗)`);
		return {ok: true, terminalId: tid, count: skins.length, skins, consumed: false};
	}

	// ★【推进·不可逆·消耗 1 次】生成/换到下一个报价 = 客户端 UseToolWithIntArg(容器,容器,当前counter)= 2534 CMsgOpenCrate{tool=subject=终端机, points_remaining}。
	//   一旦推进,当前报价被丢弃、换成新报价(回不去)。仅在用户显式确认后调用。
	async function advanceOffer(attempt, terminalId, options = {}) {
		if (!attempt.cs2GcConnected) throw new Error('该账号未连接 CS2 GC');
		if (!attempt.client || typeof attempt.client.sendToGC !== 'function') throw new Error('账号未连接(无 sendToGC)');
		attach(attempt);
		const state = ensureState(attempt);
		openVerbose(state);
		const tid = String(terminalId || '').replace(/\D/g, '');
		if (!tid) throw new Error('未提供终端机 GC id');
		const term = listTerminalGcItems(attempt).find(t => String(t.id) === tid);
		if (term && Number(term.origin) !== 8) throw new Error(`终端机 origin=${term.origin}(≠8),请先解封再推进报价`);
		let pts = (options.pointsRemaining != null && options.pointsRemaining !== '') ? Number(options.pointsRemaining) : readPointsRemaining(term);
		if (pts == null || !Number.isFinite(pts)) pts = 1;
		const sleep = (ms) => new Promise(r => setTimeout(r, ms));
		const prevIds = new Set(collectSkins(state, attempt, tid).map(s => String(s.itemid)));
		log('info', `[terminal] ▶ 推进到下一个报价(不可逆·消耗1次) 终端机=${tid} points_remaining=${pts}`);
		attempt.client.sendToGC(APPID, MSG.OpenCrate, {}, CMsgOpenCrate.encode({tool_item_id: tid, subject_item_id: tid, points_remaining: pts}).finish());
		log('info', `[terminal] 已发 OpenCrate(2534) {tool=${tid}, subject=${tid}, points_remaining=${pts}}(=UseToolWithIntArg 推进)→ 盼新报价 type1 + 1090`);
		await sleep(2800);
		// 加载新报价内容(只读)。
		attempt.client.sendToGC(APPID, MSG.CasketItemLoadContents, {}, GcProtos.CMsgCasketItem.encode({casket_item_id: tid, item_item_id: tid}).finish());
		await sleep(1600);
		const skins = collectSkins(state, attempt, tid);
		state.resolvedOffers = skins;
		const fresh = skins.filter(s => !prevIds.has(String(s.itemid)));
		logSkins(skins);
		log('info', `[terminal] 推进结束:当前 ${skins.length} 个报价(新出现 ${fresh.length} 个)。已消耗 1 次挑选(不可逆)。`);
		return {ok: true, terminalId: tid, pointsRemaining: pts, count: skins.length, skins, fresh, consumed: true};
	}

	// P1:拉取 volatile shop 报价。发 ClientRequestOffers(空);给了 defidx 再发 VolatileShopSubscribe。
	function requestOffers(attempt, options = {}) {
		if (!attempt.cs2GcConnected) throw new Error('该账号未连接 CS2 GC');
		if (!attempt.client || typeof attempt.client.sendToGC !== 'function') throw new Error('账号未连接(无 sendToGC)');
		attach(attempt);
		openVerbose(ensureState(attempt));
		attempt.client.sendToGC(APPID, MSG.ClientRequestOffers, {}, Buffer.alloc(0));
		log('info', `[terminal] 已发送 ClientRequestOffers 账号=${attempt.accountName}`);
		// VolatileShopSubscribe:据 CS2 UI 脚本 StoreAPI.VolatileShopSubscribe(itemid),订阅参数是物品/商店 id(uint64)
		// → 映射到 psid;defidx 一并带上兜底。(据锦标赛贴纸预览用法,订阅即可返回报价预览,可能无需先解封。)
		const defidx = Number(options.defidx) || 0;
		let itemId = String(options.itemId || '').replace(/\D/g, '');
		// 防呆:GC item id 是单个 uint64(≤20 位)。若拼接成超长串(前端把 defidx/faux 拼进来了)则判为无效。
		if (itemId.length > 19) {
			log('warn', `[terminal] ⚠ itemId 非法(${itemId.length} 位,像多个 id 拼接:${itemId.slice(0, 24)}…)→ 忽略。请在「GC id」框只填单个已解封终端机 id(如 52603299338)`);
			itemId = '';
		}
		const sub = {gctime: 0};
		if (defidx > 0) sub.defidx = defidx;
		if (itemId) sub.psid = itemId;
		attempt.client.sendToGC(APPID, MSG.VolatileShopSubscribe, {}, CMsgVolatileShopSubscribe.encode(sub).finish());
		log('info', `[terminal] 已发送 VolatileShopSubscribe defidx=${defidx || '-'} psid=${itemId || '-'}`);
		// ★ 关键补步:「查看终端机 / 加载报价」= VolatileItemLoadContents(2536),body = 【CMsgCasketItem{casket_item_id, item_item_id}】
		//   两个字段都填该已解封终端机的 GC id(据 sak0a/node-cs2 loadVolatileItemContents 实现)。不是 CMsgOpenCrate!
		//   无直接回包:GC 会更新 CSOVolatileItemOffer(type20)+ 可能把报价皮肤作为 CSOEconItem(type1)注入 + 发 1090 通知。
		if (itemId) {
			const buf = GcProtos.CMsgCasketItem.encode({casket_item_id: itemId, item_item_id: itemId}).finish();
			attempt.client.sendToGC(APPID, MSG.VolatileItemLoadContents, {}, buf);
			log('info', `[terminal] 已发送 VolatileItemLoadContents(2536) CMsgCasketItem{both=${itemId}} → 盼 type20 报价 / type1 皮肤注入`);
		} else {
			log('warn', '[terminal] 未提供 itemId,跳过 VolatileItemLoadContents(2536);请传入已解封终端机的 GC id');
		}
		return {sent: true, defidx: defidx || null, itemId: itemId || null};
	}

	// 诊断:GC 通路自检。用 lib 自带、确定会回包的 requestPlayersProfile(查自己)测「本会话 GC 请求通不通」。
	// 有回包 → 通路正常(那开箱就是被服务端拦);无回包 → 整条发送/会话有问题(不是开箱被拦)。
	function selfTest(attempt) {
		if (!attempt.cs2GcConnected) throw new Error('该账号未连接 CS2 GC');
		const csgo = attempt.csgo;
		if (!csgo) throw new Error('无 csgo 实例(attempt.csgo 缺失)');
		const state = ensureState(attempt);
		attach(attempt);
		openVerbose(state);
		const sid = attempt.client && attempt.client.steamID;
		const info = {haveGCSession: !!csgo.haveGCSession, isInCSGO: !!csgo._isInCSGO, steamID: sid ? sid.getSteamID64() : null};
		log('info', `[terminal] GC 自检:haveGCSession=${info.haveGCSession} isInCSGO=${info.isInCSGO} steamID=${info.steamID || '-'}`);
		// dump 所有终端机(读 id/original_id/属性:确认是哪一个、volatile_limit 填几)。
		const terms = listTerminalGcItems(attempt);
		log('info', `[terminal] GC 库存 def=5176 终端机 ${terms.length} 个(库存共 ${Array.isArray(csgo.inventory) ? csgo.inventory.length : 'N/A'} 件):`);
		terms.forEach((t, i) => log('info', `[terminal]   #${i}: ${describeGcItem(t)}`));
		if (!sid || typeof csgo.requestPlayersProfile !== 'function') {
			log('warn', '[terminal] 自检无法发起:缺 steamID 或 requestPlayersProfile 方法');
			return {sent: false, info};
		}
		let responded = false;
		try {
			csgo.requestPlayersProfile(sid, () => {
				responded = true;
				log('info', '[terminal] ★ GC 自检回包:requestPlayersProfile 有响应 → GC 请求通路正常(开箱无回包=被服务端拦,不是发不出去)');
			});
			log('info', '[terminal] 已发送 requestPlayersProfile(查自己),等回包(8s)…');
		} catch (e) {
			log('warn', '[terminal] 自检发送出错: ' + (e && e.message));
		}
		setTimeout(() => {
			if (!responded) log('warn', '[terminal] ⚠ GC 自检:8s 内无回包 → 本会话连 requestPlayersProfile 都不回,是整条 GC 发送/会话有问题(不是开箱被拦)。建议重连该账号 GC 再试。');
		}, 8000);
		return {sent: true, info};
	}

	// 裸检视:直接发 9156 Client2GCEconPreviewDataBlockRequest,自定 param_s/a/d/m(lib 的 inspectItem 只支持 owner 路线,
	// 对 faux 报价物品无效)。响应 9157 由 lib 的 handler 解码并 emit 'inspectItemInfo'(paintwear 已转 float),我们统一监听。
	function rawInspect(attempt, p) {
		const body = {param_s: p.param_s || 0, param_a: p.param_a || 0, param_d: p.param_d || 0, param_m: p.param_m || 0};
		const buf = GcProtos.CMsgGCCStrike15_v2_Client2GCEconPreviewDataBlockRequest.encode(body).finish();
		attempt.client.sendToGC(APPID, MSG.InspectRequest, {}, buf);
	}

	// 解析报价 faux_itemid → 真实皮肤。faux id 不在库存里,owner 路线(param_s=自己)查不到 → 逐个 faux 轮多种 param 组合,
	// 命中(收到 inspectItemInfo)即记下用的是哪种组合,后续 faux 直接用该组合。
	async function resolveOffers(attempt) {
		const state = ensureState(attempt);
		const csgo = attempt.csgo;
		const sid = attempt.client && attempt.client.steamID ? attempt.client.steamID.getSteamID64() : (attempt.steamID || null);
		if (!csgo || !attempt.client || typeof attempt.client.sendToGC !== 'function') return {ok: false, error: '无法检视(缺 sendToGC)', items: []};
		// (faux, generation_time) 配对去重。
		const pairs = [];
		for (const o of state.offers.values()) {
			const fx = o.fauxItemIds || [], gt = o.generationTime || [];
			fx.forEach((f, idx) => { if (!pairs.find(p => p.f === f)) pairs.push({f, gt: Number(gt[idx] || 0)}); });
		}
		if (!pairs.length) return {ok: true, count: 0, total: 0, items: []};
		openVerbose(state);
		const results = [], seen = new Set();
		const onInfo = (item) => {
			try {
				const idStr = item.itemid != null ? item.itemid.toString() : ('x' + results.length);
				if (seen.has(idStr)) return;
				seen.add(idStr);
				const rec = {itemid: idStr, defindex: Number(item.defindex || 0), paintindex: Number(item.paintindex || 0), paintwear: Number(item.paintwear || 0), paintseed: Number(item.paintseed || 0), rarity: Number(item.rarity || 0)};
				results.push(rec);
				state.resolvedOffers = results.slice();
				log('info', `[terminal] ★ 报价解析 → defindex=${rec.defindex} paint=${rec.paintindex} wear=${rec.paintwear} seed=${rec.paintseed} (itemid=${rec.itemid})`);
			} catch (e) {}
		};
		csgo.on('inspectItemInfo', onInfo);
		const sleep = (ms) => new Promise(r => setTimeout(r, ms));
		// 上下文 id:已解封终端机(origin=8)的 id + defidx —— 作为 param_d/param_m 的容器上下文候选。
		const ctxIds = [...new Set(listTerminalGcItems(attempt).filter(t => Number(t.origin) === 8).map(t => String(t.id)).concat([...TERMINAL_DEF_INDICES].map(String)))];
		// 候选检视组合(每个是 build(f,gt)→param)。前 5 个基础;后面把终端机 id/defidx 当上下文塞进 d/m。
		const comboDefs = [
			{label: 'a-only', build: (f) => ({param_a: f})},
			{label: 's=owner', build: (f) => ({param_s: sid, param_a: f})},
			{label: 'a+d=gt', build: (f, gt) => ({param_a: f, param_d: gt})},
			{label: 's+d=gt', build: (f, gt) => ({param_s: sid, param_a: f, param_d: gt})},
			{label: 'd=faux', build: (f) => ({param_a: f, param_d: f})}
		];
		for (const ctx of ctxIds) {
			comboDefs.push({label: `s+m=ctx${ctx}`, build: (f) => ({param_s: sid, param_a: f, param_m: ctx})});
			comboDefs.push({label: `s+d=ctx${ctx}`, build: (f) => ({param_s: sid, param_a: f, param_d: ctx})});
			comboDefs.push({label: `m=ctx${ctx}`, build: (f) => ({param_a: f, param_m: ctx})});
		}
		let locked = null, anyHit = false;
		try {
			for (let pi = 0; pi < pairs.length; pi++) {
				const {f, gt} = pairs[pi];
				const defs = locked ? [locked] : comboDefs;
				for (const def of defs) {
					const before = results.length;
					try { rawInspect(attempt, def.build(f, gt)); log('info', `[terminal] 检视 faux=${f} 组合[${def.label}] …`); }
					catch (e) { log('warn', '[terminal] 检视发送出错: ' + (e && e.message)); }
					await sleep(1200);
					if (results.length > before) {
						anyHit = true;
						if (!locked) { locked = def; log('info', `[terminal] ✅ 命中检视组合 [${def.label}] → 锁定给后续 faux`); }
						break;
					}
				}
				// 首个 faux 把所有组合都试过仍零回包 → faux 不可经 9156 检视,别再耗其余 faux。
				if (pi === 0 && !anyHit) { log('info', `[terminal] 首个 faux 遍历 ${comboDefs.length} 种组合均无回包 → faux 物品无法用检视(9156)解出,放弃。`); break; }
			}
		} finally {
			try { csgo.removeListener('inspectItemInfo', onInfo); } catch (e) {}
		}
		log('info', `[terminal] 报价解析结束:${results.length}/${pairs.length} 成功`);
		return {ok: true, count: results.length, total: pairs.length, items: results};
	}

	function getState(attempt) {
		const state = ensureState(attempt);
		return {
			attached: state.attached,
			offers: [...state.offers.values()],
			resolvedOffers: state.resolvedOffers || [],
			terminals: listTerminalGcItems(attempt).map(t => {
				const id = String(t.id);
				const picksUsed = readPointsRemaining(t);   // attr169:实测是「已开次数」(递增),不是剩余
				const expiresAt = readExpiration(t);
				// 「已解封」判定:解封后会启动 72h 倒计时(attr183 expiration)并带挑选次数(attr169)。
				// 旧判定只看 origin===8,但终端机来源(掉落/购买/交易)不同 → origin 各异,会把已解封的误判成未解封。
				// 现在以「有倒计时 / 有挑选次数 / origin=8」任一为准,避免漏显已解封终端机。
				const unsealed = Number(t.origin) === 8 || expiresAt != null || picksUsed != null;
				const sealed = !unsealed;
				const offer = sealed ? null : (collectSkins(state, attempt, id)[0] || null);
				return {
					id, defIndex: Number(t.def_index || 0), origin: Number(t.origin || 0), sealed,
					picksUsed,                                                                   // 已开次数(attr169)
					picksMax: TERMINAL_MAX_PICKS,                                                // 上限(=5)
					picksLeft: picksUsed != null ? Math.max(0, TERMINAL_MAX_PICKS - picksUsed) : null, // 剩余 = 上限 - 已开
					expiresAt,
					offer   // {itemid, defindex, paintindex, paintwear, paintseed, rarity, priceCents} | null(后端端点再补中文名/图)
				};
			}),
			soTypeIds: [...state.soTypes.entries()].map(([type_id, count]) => ({type_id, count})).sort((a, b) => b.count - a.count),
			injectedSkins: (state.injectedSkins || []).slice(-20),
			notifications: state.notifications.slice(-10),
			gcLog: state.gcLog.slice(-40)
		};
	}

	function clear(attempt) {
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

module.exports = {createCs2Terminal};
