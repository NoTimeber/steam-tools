import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AcceptOfferOptions, AcceptOfferResult} from '../steam/trade-offer.ts';
import type {UuDeliverableOrder, UuOrder, UuOrderDetail} from './client.ts';
import {isWaitSendOfferOrder, listWaitDeliverOrders, runDeliveryPass} from './delivery.ts';
import type {DeliveryAttempt, DeliveryClient, DeliveryContext} from './delivery.ts';
import {createAccountState, gameDelivery} from './state.ts';
import type {AccountState, Readiness} from './state.ts';

const BUYER = '76561198000000001';

const order = (orderNo: string, subStatus: number, subStatusName: string): UuOrder => ({orderNo, orderSubStatus: subStatus, subStatusName, itemName: `物品${orderNo}`});
const WAIT_CONFIRM = (orderNo: string) => order(orderNo, 1103, '待您确认报价');
const WAIT_SEND = (orderNo: string) => order(orderNo, 1101, '待发送报价');

class FakeUu implements DeliveryClient {
	orders: UuOrder[] = [];
	details: Record<string, UuOrderDetail> = {};
	offerStatuses: Array<{status: number} | string> = [{status: 3}];
	sendResult: true | string = true;
	confirmResult: boolean | string = true;
	listError: Error | null = null;
	calls: string[] = [];
	async getWaitDeliverList(opts?: {gameId?: string | number}) {
		this.calls.push(`list ${opts?.gameId}`);
		if (this.listError) {
			throw this.listError;
		}
		return this.orders;
	}
	async getOrderDetail(orderNo: string) {
		this.calls.push(`detail ${orderNo}`);
		const detail = this.details[orderNo];
		if (!detail) {
			throw new Error('订单不存在');
		}
		return detail;
	}
	async sendOffer(orderNo: string) {
		this.calls.push(`send ${orderNo}`);
		return this.sendResult;
	}
	async getOfferStatus(orderNo: string) {
		this.calls.push(`status ${orderNo}`);
		return this.offerStatuses.shift() ?? 'pending';
	}
	async confirmOffer(orderNo: string, tradeOfferId: string | number) {
		this.calls.push(`confirm ${orderNo} ${tradeOfferId}`);
		return this.confirmResult;
	}
	async getDeliverableOrders(opts?: {gameId?: string | number}): Promise<UuDeliverableOrder[]> {
		this.calls.push(`deliverable ${opts?.gameId}`);
		if (this.listError) {
			throw this.listError;
		}
		return this.orders.map(item => ({...item, tradeOfferId: this.details[item.orderNo]?.tradeOfferId ?? null, offerSendResult: null}));
	}
}

interface Harness {
	ctx: DeliveryContext;
	uu: FakeUu;
	state: AccountState;
	logs: string[];
	accepted: AcceptOfferOptions[];
	sleeps: number[];
	emits: number;
	ready: Readiness & {attempt: DeliveryAttempt | null};
	acceptResult: AcceptOfferResult | Error;
	/** ctx.confirmTradeOffer 收到的报价 id 和账号 */
	confirms: string[];
}

function harness(): Harness {
	const uu = new FakeUu();
	const h = {
		uu,
		state: Object.assign(createAccountState('alpha'), {token: 'TOKEN'}),
		logs: [],
		accepted: [],
		sleeps: [],
		emits: 0,
		ready: {online: true, hasCookies: true, hasIdentitySecret: true, steamID: '765', attempt: {cookies: ['steamLoginSecure=x'], identitySecret: 'ID', steamID: '765', deviceId: 'android:dev', userAgent: 'UA'}},
		acceptResult: {ok: true, reason: 'accepted', accepted: true, confirmed: true, offer: null},
		confirms: []
	} as unknown as Harness;
	h.ctx = {
		client: (_state, _gameId, prefix = '') => {
			uu.calls.push(`client ${_gameId} "${prefix}"`);
			return uu;
		},
		log: (_state, level, message) => void h.logs.push(`${level} ${message}`),
		emit: () => void h.emits++,
		readiness: () => h.ready,
		acceptOffer: async opts => {
			h.accepted.push(opts);
			if (h.acceptResult instanceof Error) {
				throw h.acceptResult;
			}
			return h.acceptResult;
		},
		confirmTradeOffer: async (attempt, tradeOfferId, log) => {
			h.confirms.push(`${tradeOfferId} ${attempt.steamID} ${attempt.deviceId}`);
			log('info', '手机确认:设备 ID 先用maFile 的');
		},
		sleep: async ms => void h.sleeps.push(ms),
		timing: {deliverGapMs: 5000, confirmAcceptGapMs: 1500, orderCooldownMs: 300000, offerStatusPollMs: 1500},
		waitConfirmSubStatus: 1103
	};
	return h;
}

function detail(tradeOfferId: string | null, partner = BUYER, assetId: string | null = '42'): UuOrderDetail {
	return {tradeOfferId, buyer: {steamId: partner}, commodity: assetId ? {assetId} : {}};
}

test('待发送报价按子状态名识别', () => {
	assert.equal(isWaitSendOfferOrder(WAIT_SEND('1')), true);
	assert.equal(isWaitSendOfferOrder(order('1', 1, '待确认发送报价')), false);
	assert.equal(isWaitSendOfferOrder(WAIT_CONFIRM('1')), false);
	assert.equal(isWaitSendOfferOrder(null), false);
});

test('发货:UU 确认 → 隔 1.5 秒 → 按订单信息严格校验后接受;发过的不再发', async () => {
	const h = harness();
	h.uu.orders = [WAIT_CONFIRM('A'), WAIT_CONFIRM('B')];
	h.uu.details = {A: detail('5551'), B: detail('5552', BUYER, null)};
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'manual');

	const game = gameDelivery(h.state, '730');
	assert.equal(game.status, 'idle');
	assert.deepEqual(game.stats, {scans: 1, delivered: 2, failed: 0, skipped: 0});
	assert.deepEqual(h.uu.calls, ['client 730 "[CS2] "', 'list 730', 'detail A', 'confirm A 5551', 'detail B', 'confirm B 5552']);
	assert.deepEqual(h.accepted.map(opts => ({...opts, logger: undefined, confirm: undefined})), [
		{cookies: ['steamLoginSecure=x'], identitySecret: 'ID', tradeOfferId: '5551', expectedPartnerSteamId: BUYER, expectGiveAppId: 730, expectGiveAssetIds: ['42'], logger: undefined, confirm: undefined, dryRun: false},
		{cookies: ['steamLoginSecure=x'], identitySecret: 'ID', tradeOfferId: '5552', expectedPartnerSteamId: BUYER, expectGiveAppId: 730, expectGiveAssetIds: undefined, logger: undefined, confirm: undefined, dryRun: false}
	]);
	assert.deepEqual(h.sleeps, [1500, 5000, 1500], '确认和接受之间 1.5 秒,订单之间 5 秒');
	assert.deepEqual(h.state.recentOrders.map(record => [record.orderNo, record.ok, record.tradeOfferId]), [['B', true, '5552'], ['A', true, '5551']]);
	assert.ok(h.logs.includes('success [CS2] 本轮结果: 发货 2 笔成功, 0 笔失败'));

	// 冷却期内不再处理;冷却过了也不会重复接受已发过的订单
	h.uu.calls.length = 0;
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'auto');
	assert.deepEqual(h.uu.calls, ['client 730 "[CS2] "', 'list 730']);
	assert.ok(h.logs.includes('info [CS2] 轮询: 待确认报价订单均处于发货冷却期（2 笔），稍后再试'));
	game.orderCooldown.clear();
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'auto');
	assert.equal(h.accepted.length, 2, '已发货的订单不会再接受');
});

test('接受后的手机确认交给 ctx.confirmTradeOffer(带会话的 SteamID、maFile 设备 ID),日志写进账号日志', async () => {
	const h = harness();
	h.uu.orders = [WAIT_CONFIRM('A')];
	h.uu.details = {A: detail('5551')};
	h.ctx.acceptOffer = async opts => {
		h.accepted.push(opts);
		await opts.confirm?.('5551');
		return {ok: true, reason: 'accepted', accepted: true, confirmed: true, offer: null};
	};
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'manual');
	assert.deepEqual(h.confirms, ['5551 765 android:dev']);
	assert.ok(h.logs.includes('info 手机确认:设备 ID 先用maFile 的'));
	assert.equal(gameDelivery(h.state, '730').stats.delivered, 1);
});

test('发货失败:Steam 校验不过(fail-closed)、接受时异常;都计失败并留记录', async () => {
	const h = harness();
	h.uu.orders = [WAIT_CONFIRM('A')];
	h.uu.details = {A: detail('5551')};
	h.uu.confirmResult = '订单状态异常';
	h.acceptResult = {ok: false, reason: 'partner-mismatch(1!=2)', accepted: false, confirmed: false, offer: null};
	await runDeliveryPass(h.ctx, h.state, 'tf2', 'manual');
	const game = gameDelivery(h.state, '440');
	assert.deepEqual(game.stats, {scans: 1, delivered: 0, failed: 1, skipped: 0});
	assert.equal(h.accepted[0]?.expectGiveAppId, 440);
	assert.ok(h.logs.includes('warn [TF2] 订单 A 阶段1 confirmOffer 返回: 订单状态异常（继续尝试接受报价）'));
	assert.ok(h.logs.includes('error [TF2] ⛔ 订单 A 接受报价失败(fail-closed): partner-mismatch(1!=2)'));
	assert.equal(h.state.recentOrders[0]?.ok, false);
	assert.equal(game.delivered.size, 0);

	game.orderCooldown.clear();
	h.acceptResult = new Error('超时: accept');
	await runDeliveryPass(h.ctx, h.state, 'tf2', 'manual');
	assert.equal(game.stats.failed, 2);
	assert.ok(h.logs.includes('error [TF2] 订单 A 处理异常: 超时: accept'));
	assert.equal(h.state.recentOrders[0]?.reason, '超时: accept');
});

test('没有报价号的订单跳过,不进冷却', async () => {
	const h = harness();
	h.uu.orders = [WAIT_CONFIRM('A')];
	h.uu.details = {A: detail(null)};
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'manual');
	const game = gameDelivery(h.state, '730');
	assert.equal(game.stats.skipped, 1);
	assert.equal(game.orderCooldown.size, 0);
	assert.deepEqual(h.accepted, []);
	assert.equal(h.state.recentOrders[0]?.reason, '暂无 tradeOfferId（报价未发出/已取消）');
});

test('待发送报价:先发报价,再按 1.5 秒间隔查状态到 3;超时给出最后状态', async () => {
	const h = harness();
	h.uu.orders = [WAIT_SEND('S1')];
	h.uu.offerStatuses = ['发送中', {status: 1} as {status: number}, {status: 3}];
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'manual');
	assert.deepEqual(h.uu.calls.filter(call => /^(send|status)/.test(call)), ['send S1', 'status S1', 'status S1', 'status S1']);
	assert.deepEqual(h.sleeps, [1500, 1500, 1500]);
	assert.ok(h.logs.includes('success ✅ 订单 S1 报价已发送成功，将在下一轮自动确认接受'));
	assert.deepEqual(h.accepted, [], '这一轮不接受');

	const timeout = harness();
	timeout.uu.orders = [WAIT_SEND('S2')];
	timeout.uu.offerStatuses = [];
	await runDeliveryPass(timeout.ctx, timeout.state, 'cs2', 'manual');
	assert.ok(timeout.logs.includes('warn 订单 S2 报价发送等待超时（最后状态: pending）'));

	const refused = harness();
	refused.uu.orders = [WAIT_SEND('S3')];
	refused.uu.sendResult = '买家已取消';
	await runDeliveryPass(refused.ctx, refused.state, 'cs2', 'manual');
	assert.ok(refused.logs.includes('warn 订单 S3 发送报价失败: 买家已取消'));
});

test('没就绪不发货:离线(空闲)、缺 cookies、缺 identity_secret(报错);自动轮询原因不变不重复播报', async () => {
	const h = harness();
	h.ready = {online: false, hasCookies: false, hasIdentitySecret: false, steamID: '', attempt: null};
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'auto');
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'auto');
	const game = gameDelivery(h.state, '730');
	assert.equal(game.status, 'idle');
	assert.equal(game.lastError, '');
	assert.equal(h.logs.filter(line => line.includes('Steam 账号未在线')).length, 1, '自动轮询只播报一次');
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'manual');
	assert.equal(h.logs.filter(line => line.includes('Steam 账号未在线')).length, 2, '手动扫描照常播报');

	h.ready = {online: true, hasCookies: true, hasIdentitySecret: false, steamID: '1', attempt: {cookies: ['a'], identitySecret: '', steamID: '1', deviceId: '', userAgent: ''}};
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'auto');
	assert.equal(game.status, 'error');
	assert.match(game.lastError, /缺少 identity_secret/);
	h.ready = {online: true, hasCookies: false, hasIdentitySecret: true, steamID: '1', attempt: {cookies: [], identitySecret: 'x', steamID: '1', deviceId: '', userAgent: ''}};
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'auto');
	assert.match(game.lastError, /缺少 WebSession cookies/);
	assert.ok(!h.uu.calls.some(call => call.startsWith('list')), '没就绪不打 UU 接口');
	assert.equal(game.stats.scans, 5);
});

test('轮询出错记为错误状态;上一轮没结束就跳过', async () => {
	const h = harness();
	h.uu.listError = new Error('登录状态失效，请重新登录');
	await runDeliveryPass(h.ctx, h.state, 'tf2', 'auto');
	const game = gameDelivery(h.state, '440');
	assert.equal(game.status, 'error');
	assert.equal(game.lastError, '登录状态失效，请重新登录');
	assert.equal(game.running, false);
	assert.ok(h.logs.includes('error [TF2] 发货轮询失败: 登录状态失效，请重新登录'));

	game.running = true;
	await runDeliveryPass(h.ctx, h.state, 'tf2', 'auto');
	assert.equal(game.stats.scans, 1, '运行中不再开一轮');
});

test('无可处理订单:自动和手动的提示不同', async () => {
	const h = harness();
	h.uu.orders = [order('X', 1000, '等待买家付款')];
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'auto');
	await runDeliveryPass(h.ctx, h.state, 'cs2', 'manual');
	assert.deepEqual(h.logs, ['info [CS2] 轮询: 无待确认报价订单', 'info [CS2] 待发货列表无可处理的"待确认报价"订单（共 1 单）']);
});

test('待发货列表:两款游戏分别查、合并;一款失败只记日志', async () => {
	const h = harness();
	h.uu.orders = [WAIT_CONFIRM('A')];
	h.uu.details = {A: detail('5551')};
	const list = await listWaitDeliverOrders(h.ctx, h.state);
	assert.deepEqual(list.map(item => [item.gameId, item.gameLabel, item.orderNo, item.tradeOfferId]), [['730', 'CS2', 'A', '5551'], ['440', 'TF2', 'A', '5551']]);

	h.uu.listError = new Error('网关超时');
	assert.deepEqual(await listWaitDeliverOrders(h.ctx, h.state), []);
	assert.ok(h.logs.includes('warn [CS2] 读取待发货失败: 网关超时'));
	assert.ok(h.logs.includes('warn [TF2] 读取待发货失败: 网关超时'));
});
