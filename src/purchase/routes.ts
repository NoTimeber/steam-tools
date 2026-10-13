// 游戏内购(CS2/TF2 GC 商店)的 HTTP 路由。
// 前端用 /api/purchase/*(?game=cs2|tf2);/api/cs2/*、/api/tf2/*、/api/task/*-purchase 是旧别名,保留兼容。

import {gameConfig} from '../steam/games.ts';
import type {GameId} from '../steam/games.ts';
import {requestGame, sendError} from '../web/http.ts';
import type {Handler, Request, Router} from '../web/http.ts';
import {normalizeCartData, publicTask} from './index.ts';
import type {PurchaseService} from './index.ts';

export function purchaseRoutes(router: Router, {purchase}: {purchase: PurchaseService}): void {
	// 别名路径写死了游戏;新路径看 ?game= / body.game
	const target = (game: GameId | null, req: Request): GameId => game || requestGame(req);

	function catalogRoute(game: GameId | null, load: (target: GameId) => Promise<unknown>, failure: string): Handler {
		return async (req, res) => {
			const which = target(game, req);
			try {
				await load(which);
				res.json(purchase.catalog.response(which));
			} catch (err) {
				sendError(res, err, failure);
			}
		};
	}

	function taskRoute(game: GameId | null): Handler {
		return (req, res) => {
			let cartData;
			try {
				cartData = normalizeCartData(req.body && req.body.cartData);
			} catch (err) {
				return res.status(400).json({success: false, error: err && (err as Error).message ? (err as Error).message : '购物车数据无效'});
			}
			const task = purchase.tasks.create(target(game, req), cartData);
			purchase.tasks.start(task);
			res.json({success: true, task: publicTask(task)});
		};
	}

	for (const [prefix, game] of [['purchase', null], ['cs2', 'cs2'], ['tf2', 'tf2']] as const) {
		router.get(`/api/${prefix}/online-accounts`, (req, res) => {
			const which = target(game, req);
			res.json({success: true, game: which, gameLabel: gameConfig(which).label, accounts: purchase.listOnlineAccounts(which)});
		});
		router.get(`/api/${prefix}/items`, catalogRoute(game, which => purchase.catalog.ensureLoaded(which), '商品目录读取失败'));
		router.post(`/api/${prefix}/refresh-items`, catalogRoute(game, which => purchase.catalog.refresh(which, {forceRefresh: true}), '商品目录刷新失败'));
		// 刷新汇率:新接口是 POST,旧别名是 GET
		const refreshRates = catalogRoute(game, () => purchase.catalog.refreshRates({forceRefresh: true}), '汇率刷新失败');
		if (prefix === 'purchase') {
			router.post(`/api/${prefix}/refresh-rates`, refreshRates);
		} else {
			router.get(`/api/${prefix}/refresh-rates`, refreshRates);
		}
	}

	router.get('/api/purchase/tasks', (req, res) => {
		res.json({success: true, tasks: purchase.tasks.list()});
	});
	router.post('/api/purchase/tasks', taskRoute(null));
	router.post('/api/task/cs2-purchase', taskRoute('cs2'));
	router.post('/api/task/tf2-purchase', taskRoute('tf2'));
}
