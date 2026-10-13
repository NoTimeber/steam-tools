'use strict';

// 悠悠 TF2 发货 - confirmOffer 验证脚本。
// 默认【只读】：打印订单详情(tradeOfferId/offerSendResult/子状态)。
// 加 --confirm 才会真正调用 confirmOffer 并轮询 confirmOfferStatus。
//
// 用法：
//   node confirm-uu-order.js <UU_TOKEN> <orderNo> [gameId]            # 只看，不确认
//   node confirm-uu-order.js <UU_TOKEN> <orderNo> [gameId] --confirm  # 真正确认报价
//
// 也可不传 orderNo，脚本会自动从待发货列表里挑第一笔“待确认报价”订单。

const {UuAccount, SUBSTATUS_WAIT_CONFIRM} = require('./lib/uuyoupin');

async function main() {
	const args = process.argv.slice(2).filter(a => a !== '--confirm');
	const doConfirm = process.argv.includes('--confirm');
	const token = (args[0] || process.env.UU_TOKEN || '').trim();
	let orderNo = (args[1] || '').trim();
	const gameId = (args[2] || process.env.UU_GAMEID || '440').trim();

	if (!token) {
		console.error('用法: node confirm-uu-order.js <UU_TOKEN> [orderNo] [gameId] [--confirm]');
		process.exit(1);
	}

	const account = new UuAccount(token, {gameId, debug: true});

	// 没给 orderNo 就自动挑一笔待确认订单
	if (!orderNo) {
		console.log('[确认] 未指定 orderNo，从待发货列表自动查找...');
		const orders = await account.getWaitDeliverList({gameId});
		const pending = orders.find(o => o.orderSubStatus === SUBSTATUS_WAIT_CONFIRM) || orders[0];
		if (!pending) {
			console.log('[确认] 当前没有待发货订单，先去造一笔真实订单。');
			return;
		}
		orderNo = pending.orderNo;
		console.log(`[确认] 选中订单 ${orderNo} | ${pending.itemName} | 子状态 ${pending.orderSubStatus}/${pending.subStatusName}`);
	}

	console.log(`[确认] 拉取订单 ${orderNo} 详情...`);
	const detail = await account.getOrderDetail(orderNo);
	const tradeOfferId = detail.tradeOfferId;
	console.log('[确认] tradeOfferId =', tradeOfferId);
	console.log('[确认] offerSendResult =', detail.offerSendResult, '(3=报价已发出)');
	console.log('[确认] 状态 =', detail.status && `${detail.status.status}/${detail.status.subStatus} ${detail.status.subStatusName}`);

	if (!tradeOfferId) {
		console.log('[确认] 该订单暂无 tradeOfferId（报价可能还没发出/已取消），无法确认。');
		return;
	}

	if (!doConfirm) {
		console.log('\n[只读模式] 未确认。确认无误后，加 --confirm 真正确认报价：');
		console.log(`  node confirm-uu-order.js "${token.slice(0, 12)}..." ${orderNo} ${gameId} --confirm`);
		return;
	}

	console.log('\n[确认] 正在调用 confirmOffer ...');
	const result = await account.confirmOffer(orderNo, tradeOfferId);
	if (result === true) {
		console.log('[确认] confirmOffer 成功！');
	} else {
		console.log('[确认] confirmOffer 返回:', result);
	}

	console.log('[确认] 轮询 confirmOfferStatus ...');
	for (let i = 0; i < 6; i++) {
		await new Promise(r => setTimeout(r, 1500));
		const st = await account.confirmOfferStatus(orderNo);
		console.log(`  第${i + 1}次 status =`, typeof st === 'object' ? JSON.stringify(st) : st);
	}
	console.log('[确认] 完成。提醒：Steam 端报价仍需用 identity_secret 接受(你的第三方或后续阶段2)。');
}

main().catch(err => {
	console.error('[确认] 失败: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
