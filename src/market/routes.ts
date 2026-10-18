// Steam 社区市场求购单的 HTTP 路由。

import type {CookieFlowAccount} from '../steam/attempts.ts';
import {keyedRoute, sendError, spreadRoute} from '../web/http.ts';
import type {Router} from '../web/http.ts';
import type {MarketService} from './index.ts';

export interface MarketRouteDeps {
	market: MarketService;
	/** 可挂求购的在线账户(同「买游戏」:已登录 + 有 WebSession cookie) */
	listAccounts(): CookieFlowAccount[];
}

export function marketRoutes(router: Router, {market, listAccounts}: MarketRouteDeps): void {
	router.get('/api/market/online-accounts', (req, res) => {
		res.json({success: true, accounts: listAccounts()});
	});

	// 按名字搜商品(中文或英文,也认商品链接)。query: { q, appid?, accountId? } → { items, source: 'steam'|'local', error? }
	router.get('/api/market/search', spreadRoute(req => market.search(req.query), '搜索商品失败'));

	// 行情参考。query: { accountId|account, url | (appid, marketHashName), itemNameId? }
	router.get('/api/market/context', keyedRoute('context', req => market.context(req.query), '行情获取失败'));

	// 挂求购单(可多账号,钱包币种须一致)。
	// body: { accountIds:[id|name...], url|(appid,marketHashName), pricePerItem(钱包币种主单位), quantity, itemName?, concurrency?, perAccountMax? }
	router.post('/api/market/buyorder', spreadRoute(req => market.place(req.body || {}), '挂求购失败'));

	// 我的求购单(仅本工具挂出的,存于 data/market-buyorders.json)。
	router.get('/api/market/buyorders', (req, res) => {
		res.json({success: true, orders: market.orders()});
	});

	// 撤求购单。body: { id }(账本记录 id)或 { accountId, buyOrderId }
	router.post('/api/market/buyorder/cancel', spreadRoute(async req => {
		await market.cancel(req.body || {});
		return {};
	}, '撤销失败'));

	// 刷新「我的求购单」:逐账号从 Steam 实拉,和账本对账。body: { accounts:[账号名|attemptId...], concurrency? }
	router.post('/api/market/buyorders/sync', async (req, res) => {
		try {
			const result = await market.sync(req.body || {});
			res.json({
				success: true,
				orders: result.orders,
				syncedAccounts: result.syncedAccounts,
				summary: {removed: result.removed, updated: result.updated, accounts: result.accounts}
			});
		} catch (err) {
			sendError(res, err, '刷新失败');
		}
	});
}
