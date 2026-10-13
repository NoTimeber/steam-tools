// 充值码批量兑换的 HTTP 路由;进度经 socket.io 的 wallet:redeem 推送。

import {spreadRoute} from '../web/http.ts';
import type {Router} from '../web/http.ts';
import type {WalletService} from './index.ts';

export function walletRoutes(router: Router, {wallet}: {wallet: WalletService}): void {
	// body: { pairs:[{account, password, code}...], concurrency }
	router.post('/api/wallet/redeem', spreadRoute(req => wallet.start(req.body || {}), '提交兑换任务失败'));
}
