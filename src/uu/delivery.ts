// UU 自动发货的一轮扫描(从 app/server.js 移来,日志文案不变)。
// 每轮:取待发货列表 →「待发送报价」的先发报价(下一轮再确认)→「待您确认报价」(1103)的逐笔发货:
//   1) UU confirmOffer;2) 隔 1.5 秒,在 Steam 上 fail-closed 校验报价后接受 + 手机令牌确认。
// 订单之间隔 5 秒;进入发货流程的订单冷却 5 分钟(避开 UU 状态延迟导致的重复接受);本次运行发过的不再发。

import type {AcceptOfferOptions, AcceptOfferResult} from '../steam/trade-offer.ts';
import type {UuDeliverableOrder, UuOrder, UuOrderDetail} from './client.ts';
import {DELIVER_GAME_IDS, gameDelivery, normalizeUuGameId, pushRecord, uuGameLabel} from './state.ts';
import type {AccountState, GameDelivery, OrderRecord, Readiness} from './state.ts';

/** 发货用到的 UU 客户端能力 */
export interface DeliveryClient {
	getWaitDeliverList(opts?: {gameId?: string | number}): Promise<UuOrder[]>;
	getOrderDetail(orderNo: string): Promise<UuOrderDetail>;
	sendOffer(orderNo: string): Promise<true | string | undefined>;
	getOfferStatus(orderNo: string): Promise<{status?: number | string; [key: string]: unknown} | string | undefined>;
	confirmOffer(orderNo: string, tradeOfferId: string | number): Promise<boolean | string | undefined>;
	getDeliverableOrders(opts?: {gameId?: string | number}): Promise<UuDeliverableOrder[]>;
}

/** 发货用到的 Steam 会话字段 */
export interface DeliveryAttempt {
	cookies: string[];
	identitySecret: string;
	steamID: string;
	/** maFile 的 device_id(手机确认用);没有为空 */
	deviceId: string;
	userAgent: string;
}

export interface DeliveryTiming {
	/** 同一轮里逐笔处理之间的间隔 */
	deliverGapMs: number;
	/** confirmOffer 和接受报价之间的间隔 */
	confirmAcceptGapMs: number;
	/** 进入发货流程后的冷却 */
	orderCooldownMs: number;
	/** 发出报价后查发送状态的间隔(查 5 次) */
	offerStatusPollMs: number;
}

export const DEFAULT_DELIVERY_TIMING: DeliveryTiming = {
	deliverGapMs: 5 * 1000,
	confirmAcceptGapMs: 1.5 * 1000,
	orderCooldownMs: 5 * 60 * 1000,
	offerStatusPollMs: 1500
};

export interface DeliveryContext {
	/** 建 UU 客户端;非 debug 日志加上 prefix 写进账号日志 */
	client(state: AccountState, gameId: string, prefix?: string): DeliveryClient;
	log(state: AccountState, level: string, message: string): void;
	/** 推送账号状态 */
	emit(state: AccountState): void;
	readiness(accountName: string): Readiness & {attempt: DeliveryAttempt | null};
	acceptOffer(opts: AcceptOfferOptions): Promise<AcceptOfferResult>;
	/** 接受报价后手机确认这一笔(自己发 mobileconf,见 ../steam/confirmations.ts) */
	confirmTradeOffer(attempt: DeliveryAttempt, tradeOfferId: string, log: (level: 'info' | 'warn', message: string) => void): Promise<void>;
	sleep(ms: number): Promise<void>;
	timing: DeliveryTiming;
	/** 「待您确认报价」的子状态码(1103) */
	waitConfirmSubStatus: number;
}

export function errorText(err: unknown): string {
	const message = err && typeof err === 'object' ? (err as {message?: unknown}).message : undefined;
	return message ? String(message) : String(err);
}

/** 「待发送报价」:卖家要先发出 Steam 报价才会进入 1103。按子状态名匹配(含「发送报价」且不含「确认」),对齐 Steamauto */
export function isWaitSendOfferOrder(order: UuOrder | null | undefined): boolean {
	const name = String(order?.subStatusName || '');
	return name.includes('发送报价') && !name.includes('确认');
}

/** 发出报价并查发送状态,直到 status=3(成功后下一轮再确认接受) */
export async function sendOrderOffer(ctx: DeliveryContext, state: AccountState, uu: DeliveryClient, order: UuOrder, label = ''): Promise<boolean> {
	const orderNo = order.orderNo;
	const itemName = order.itemName || order.hashName || '';
	const tag = label ? `[${label}] ` : '';
	try {
		ctx.log(state, 'info', `${tag}订单 ${orderNo}「${itemName}」处于「${order.subStatusName || '待发送报价'}」，尝试发送报价...`);
		const result = await uu.sendOffer(orderNo);
		if (result !== true) {
			ctx.log(state, 'warn', `订单 ${orderNo} 发送报价失败: ${result}`);
			return false;
		}
		ctx.log(state, 'info', `订单 ${orderNo} 报价发送中，等待发送完成...`);
		for (let i = 0; i < 5; i++) {
			await ctx.sleep(ctx.timing.offerStatusPollMs);
			const status = await uu.getOfferStatus(orderNo);
			const code = status && typeof status === 'object' ? Number(status.status) : null;
			if (code === 3) {
				ctx.log(state, 'success', `✅ 订单 ${orderNo} 报价已发送成功，将在下一轮自动确认接受`);
				return true;
			}
			if (i === 4) {
				ctx.log(state, 'warn', `订单 ${orderNo} 报价发送等待超时（最后状态: ${typeof status === 'object' ? JSON.stringify(status) : status}）`);
			}
		}
		return false;
	} catch (err) {
		ctx.log(state, 'error', `订单 ${orderNo} 发送报价异常: ${errorText(err)}`);
		return false;
	}
}

/** 发一笔「待确认报价」订单:UU confirmOffer → Steam 校验并接受 + 手机确认 */
export async function deliverOrder(ctx: DeliveryContext, state: AccountState, game: GameDelivery, uu: DeliveryClient, order: UuOrder, attempt: DeliveryAttempt, gameId: string, label = ''): Promise<void> {
	const orderNo = order.orderNo;
	const itemName = order.itemName || order.hashName || '';
	const tag = label ? `[${label}] ` : '';
	if (game.delivered.has(orderNo)) {
		return;
	}
	const record: OrderRecord = {orderNo, itemName, tradeOfferId: null, ok: false, reason: '', at: new Date().toISOString()};
	try {
		ctx.log(state, 'info', `${tag}订单 ${orderNo}「${itemName}」开始处理`);
		const detail = await uu.getOrderDetail(orderNo);
		const tradeOfferId = detail && detail.tradeOfferId;
		const partnerSteamId = detail && detail.buyer && detail.buyer.steamId;   // UU 给的对方 steamId(字符串)
		const assetId = detail && detail.commodity && (detail.commodity.assetId || detail.commodity.assertId);
		record.tradeOfferId = tradeOfferId || null;

		if (!tradeOfferId) {
			record.reason = '暂无 tradeOfferId（报价未发出/已取消）';
			ctx.log(state, 'warn', `${tag}订单 ${orderNo} ${record.reason}，跳过`);
			game.stats.skipped += 1;
			pushRecord(state, record);
			return;
		}

		// 进入实际发货流程就登记冷却,避免 UU 服务端状态延迟期间重复接受报价(错误 11)
		game.orderCooldown.set(orderNo, Date.now() + ctx.timing.orderCooldownMs);

		const confirm = await uu.confirmOffer(orderNo, tradeOfferId);
		if (confirm === true) {
			ctx.log(state, 'info', `${tag}订单 ${orderNo} 阶段1 confirmOffer 成功`);
		} else {
			ctx.log(state, 'warn', `${tag}订单 ${orderNo} 阶段1 confirmOffer 返回: ${confirm}（继续尝试接受报价）`);
		}

		// 给 UU 服务端留处理时间,也降低接口访问频率
		await ctx.sleep(ctx.timing.confirmAcceptGapMs);

		const result = await ctx.acceptOffer({
			cookies: attempt.cookies,
			identitySecret: attempt.identitySecret,
			tradeOfferId,
			expectedPartnerSteamId: partnerSteamId,
			expectGiveAppId: Number(gameId),
			expectGiveAssetIds: assetId ? [String(assetId)] : undefined,
			logger: (level, message) => {
				if (level !== 'debug') {
					ctx.log(state, level, message);
				}
			},
			confirm: offerId => ctx.confirmTradeOffer(attempt, offerId, (level, message) => ctx.log(state, level, message)),
			dryRun: false
		});
		record.ok = !!result.ok && !!result.accepted;
		record.reason = result.reason;
		if (record.ok) {
			game.stats.delivered += 1;
			game.delivered.add(orderNo);
			ctx.log(state, 'success', `${tag}✅ 订单 ${orderNo}「${itemName}」发货成功（已接受+手机确认）`);
		} else {
			game.stats.failed += 1;
			ctx.log(state, 'error', `${tag}⛔ 订单 ${orderNo} 接受报价失败(fail-closed): ${result.reason}`);
		}
		pushRecord(state, record);
	} catch (err) {
		record.reason = errorText(err);
		game.stats.failed += 1;
		ctx.log(state, 'error', `${tag}订单 ${orderNo} 处理异常: ${record.reason}`);
		pushRecord(state, record);
	}
}

/** 一轮发货扫描;该游戏上一轮还没结束就跳过 */
export async function runDeliveryPass(ctx: DeliveryContext, state: AccountState, gameIdInput: unknown, source: string): Promise<void> {
	const gid = normalizeUuGameId(gameIdInput);
	const label = uuGameLabel(gid);
	const game = gameDelivery(state, gid);
	if (game.running) {
		return;
	}
	game.running = true;
	game.status = 'scanning';
	game.lastScanAt = new Date().toISOString();
	game.stats.scans += 1;
	ctx.emit(state);

	try {
		const ready = ctx.readiness(state.accountName);
		// 缺哪样都没法发货;原因变了才播报,免得自动轮询刷屏
		let notReady = '';
		if (!ready.online) {
			notReady = 'Steam 账号未在线，无法发货——请先在「账户管理」登录该账号';
		} else if (!ready.hasCookies) {
			notReady = 'Steam 账号缺少 WebSession cookies，请在账户页重新登录/获取';
		} else if (!ready.hasIdentitySecret) {
			notReady = '缺少 identity_secret（maFile，手机令牌确认用），无法接受报价——请为该账号导入 maFile';
		}
		if (notReady || !ready.attempt) {
			if (source !== 'auto' || game.lastSkipReason !== notReady) {
				ctx.log(state, 'warn', `[${label}] ${notReady}`);
			}
			game.lastSkipReason = notReady;
			game.status = ready.online ? 'error' : 'idle';
			game.lastError = ready.online ? notReady : '';
			return;
		}
		game.lastSkipReason = '';

		const attempt = ready.attempt;
		const uu = ctx.client(state, gid, `[${label}] `);
		const before = {...game.stats};
		const orders = await uu.getWaitDeliverList({gameId: gid});

		// 先处理「待发送报价」:发出报价后转为「待确认报价」,下一轮再接受
		const needSend = orders.filter(isWaitSendOfferOrder);
		if (needSend.length) {
			ctx.log(state, 'info', `[${label}] 轮询: 发现 ${needSend.length} 笔待发送报价订单，尝试发送报价`);
			for (let i = 0; i < needSend.length; i++) {
				await sendOrderOffer(ctx, state, uu, needSend[i] as UuOrder, label);
				ctx.emit(state);
				if (i < needSend.length - 1) {
					await ctx.sleep(ctx.timing.deliverGapMs);
				}
			}
		}

		const allPending = orders.filter(order => Number(order.orderSubStatus) === Number(ctx.waitConfirmSubStatus));
		const now = Date.now();
		for (const [orderNo, until] of game.orderCooldown) {
			if (until <= now) {
				game.orderCooldown.delete(orderNo);
			}
		}
		const pending = allPending.filter(order => {
			const until = game.orderCooldown.get(order.orderNo);
			return !(until && now < until);
		});
		const cooling = allPending.length - pending.length;
		if (!pending.length) {
			if (source === 'auto') {
				ctx.log(state, 'info', cooling > 0
					? `[${label}] 轮询: 待确认报价订单均处于发货冷却期（${cooling} 笔），稍后再试`
					: `[${label}] 轮询: 无待确认报价订单`);
			} else {
				ctx.log(state, 'info', `[${label}] 待发货列表无可处理的"待确认报价"订单（共 ${orders.length} 单${cooling > 0 ? `，${cooling} 笔冷却中` : ''}）`);
			}
			game.status = 'idle';
			game.lastError = '';
			return;
		}

		ctx.log(state, 'info', `[${label}] 轮询: 发现 ${pending.length} 笔待确认报价，开始发货${cooling > 0 ? `（另有 ${cooling} 笔冷却中）` : ''}`);
		for (let i = 0; i < pending.length; i++) {
			await deliverOrder(ctx, state, game, uu, pending[i] as UuOrder, attempt, gid, label);
			ctx.emit(state);
			if (i < pending.length - 1) {
				await ctx.sleep(ctx.timing.deliverGapMs);
			}
		}
		const delivered = game.stats.delivered - before.delivered;
		const failed = game.stats.failed - before.failed;
		if (delivered > 0 || failed > 0) {
			ctx.log(state, delivered > 0 ? 'success' : 'warn', `[${label}] 本轮结果: 发货 ${delivered} 笔成功, ${failed} 笔失败`);
		}
		game.status = 'idle';
		game.lastError = '';
	} catch (err) {
		game.status = 'error';
		game.lastError = errorText(err);
		ctx.log(state, 'error', `[${label}] 发货轮询失败: ` + game.lastError);
	} finally {
		game.running = false;
		ctx.emit(state);
	}
}

export interface WaitDeliverOrderView {
	gameId: string;
	gameLabel: string;
	orderNo: string;
	itemName?: string;
	hashName?: string;
	subStatus?: number | string;
	subStatusName?: string;
	tradeOfferId: string | number | null;
	offerSendResult: unknown;
	sellAmount: unknown;
}

/** 两款游戏的待发货订单(各打各的网关),合并返回;某个游戏读失败只记日志 */
export async function listWaitDeliverOrders(ctx: DeliveryContext, state: AccountState): Promise<WaitDeliverOrderView[]> {
	const out: WaitDeliverOrderView[] = [];
	for (const gid of DELIVER_GAME_IDS) {
		try {
			const orders = await ctx.client(state, gid).getDeliverableOrders({gameId: gid});
			for (const order of orders) {
				out.push({
					gameId: gid,
					gameLabel: uuGameLabel(gid),
					orderNo: order.orderNo,
					itemName: order.itemName,
					hashName: order.hashName,
					subStatus: order.orderSubStatus,
					subStatusName: order.subStatusName,
					tradeOfferId: order.tradeOfferId,
					offerSendResult: order.offerSendResult,
					sellAmount: order.sellAmount
				});
			}
		} catch (err) {
			ctx.log(state, 'warn', `[${uuGameLabel(gid)}] 读取待发货失败: ${errorText(err)}`);
		}
	}
	return out;
}
