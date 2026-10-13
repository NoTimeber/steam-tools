// 买游戏(协议购买整款 Steam 游戏)的 HTTP 路由。

import type {CookieFlowAccount} from '../steam/attempts.ts';
import {keyedRoute} from '../web/http.ts';
import type {Handler, Router} from '../web/http.ts';
import type {BuyGameService} from './index.ts';

export interface BuyGameRouteDeps {
	buyGame: BuyGameService;
	/** 可购买账户:已登录且有 WebSession cookie 的账号(买游戏只需 cookie,不需要 GC) */
	listAccounts(): CookieFlowAccount[];
	/** 调试端点开关(单次真实购买) */
	debug: Handler;
}

export function buyGameRoutes(router: Router, {buyGame, listAccounts, debug}: BuyGameRouteDeps): void {
	// 钱包给自己买一个包。默认 dryRun:只验证到最终价、不扣款。
	// body: { id: <账号attempt id>, packageIds: [subid...], dryRun?: true|false }
	router.post('/api/steam-purchase/test', debug, keyedRoute('result', req => buyGame.testPurchase(req.body || {}), '购买失败'));

	router.get('/api/buygame/online-accounts', (req, res) => {
		res.json({success: true, accounts: listAccounts()});
	});

	// 解析一个 subid(packageid):返回游戏名/价格,供前端确认购买内容。query: { packageId|subid, accountId? }
	router.get('/api/buygame/resolve', keyedRoute('package', req => buyGame.resolvePackage(req.query), '解析失败'));

	router.get('/api/buygame/tasks', (req, res) => {
		res.json({success: true, tasks: buyGame.listTasks()});
	});

	// 创建并执行买游戏任务。body: { items:[{accountId, packageIds:[subid...]}], dryRun, concurrency }
	router.post('/api/buygame/tasks', keyedRoute('task', req => buyGame.createTask(req.body || {}), '创建任务失败'));
}
