// C5 扫货的 HTTP 路由。浏览器拿不到 app-key 原文,只有后 4 位。

import {keyedRoute, spreadRoute} from '../web/http.ts';
import type {Router} from '../web/http.ts';
import type {C5Service} from './index.ts';

export function c5Routes(router: Router, {c5}: {c5: C5Service}): void {
	router.get('/api/c5/state', (req, res) => {
		res.json({success: true, state: c5.state()});
	});

	// 设置:{appKey?, clearAppKey?, strategy, tradeUrl, maxTotalSpend, ...};appKey 留空表示不改
	router.post('/api/c5/settings', keyedRoute('state', req => c5.saveSettings(req.body || {}), '保存设置失败'));
	// 运行状态:stopped / sweeping(真实下单)
	router.post('/api/c5/run', keyedRoute('state', req => c5.setRun((req.body || {}).state), '操作失败'));
	// 监控列表整张表一起提交:{items: [{name, maxPrice, maxQty, maxSpend, delivery, assetType, appId}]}
	router.post('/api/c5/watchlist', keyedRoute('state', req => c5.saveWatchlist((req.body || {}).items), '保存监控列表失败'));

	// 添加饰品时按中文或英文搜名字,带 C5 在售最低价:?q=千瓦 → {options: [{name, zh, lowest, sellCount}], priced, priceError}
	router.get('/api/c5/names', spreadRoute(req => c5.searchNames(req.query.q), '搜索饰品失败'));
	// 收货账号:C5 上绑定的 Steam 账号;取某个 SteamID 的交易链接(只取不存;409 = 要人贴一次)
	router.get('/api/c5/receivers', spreadRoute(() => c5.receivers(), '读取账号失败'));
	router.post('/api/c5/trade-url', spreadRoute(req => c5.tradeUrlFor((req.body || {}).steamId), '取交易链接失败'));

	router.post('/api/c5/check', keyedRoute('result', () => c5.check(), '检查连接失败'));
	router.post('/api/c5/listings', spreadRoute(req => c5.listings((req.body || {}).name), '查在售失败'));
	router.post('/api/c5/orders/refresh', spreadRoute(() => c5.refreshOrders(), '同步订单失败'));
	router.post('/api/c5/purchases/resolve', keyedRoute('state', req => {
		const body = req.body || {};
		return c5.resolvePurchase(body.outTradeNo, body.status);
	}, '标记失败'));
}
