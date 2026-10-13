'use strict';

// 悠悠有品 TF2 发货客户端 - 命令行联调脚本。
// 用法：
//   node test-uu-deliver.js <UU_TOKEN> [gameId]
//   gameId 默认 440(TF2)，CS2 传 730
// 也可用环境变量 UU_TOKEN / UU_GAMEID。
//
// 流程：解析 token 身份 → 拉取待发货列表 → 为每单补 tradeOfferId / offerSendResult 并打印。
// 全程只读，不会确认/改变任何订单。

const {UuAccount, decodeJwt} = require('./lib/uuyoupin');

async function main() {
	const token = (process.argv[2] || process.env.UU_TOKEN || '').trim();
	const gameId = (process.argv[3] || process.env.UU_GAMEID || '440').trim();
	if (!token) {
		console.error('用法: node test-uu-deliver.js <UU_TOKEN> [gameId]  (gameId 默认 440=TF2)');
		process.exit(1);
	}

	const jwt = decodeJwt(token);
	if (jwt && jwt.exp) {
		console.log(`[test] token 身份: Id=${jwt.Id} Name=${jwt.Name} 过期=${new Date(jwt.exp * 1000).toISOString()}`);
	}

	console.log(`[test] 以 gameId=${gameId} 连接 g3-api 并校验 token...`);
	const account = new UuAccount(token, {gameId, debug: true});

	console.log('[test] 拉取待发货列表(含 tradeOfferId)...');
	const orders = await account.getDeliverableOrders({gameId});
	console.log(`[test] 待发货订单数: ${orders.length}`);
	for (const o of orders) {
		console.log(
			`  - 订单 ${o.orderNo} | ${o.itemName} (${o.hashName}) | 子状态 ${o.orderSubStatus}/${o.subStatusName}` +
			` | tradeOfferId=${o.tradeOfferId} | offerSendResult=${o.offerSendResult} | ¥${o.sellAmount}`
		);
	}
	console.log('[test] 完成。');
}

main().catch(err => {
	console.error('[test] 失败: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
