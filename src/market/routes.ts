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

	// 按名字搜商品(本地词库:CS2 中英文名、TF2 英文名;也认商品链接)。query: { q } → { items: [{appid, marketHashName, zh}] }
	router.get('/api/market/search', spreadRoute(req => market.search(req.query), '搜索商品失败'));

	// 行情参考。query: { accountId|account, url | (appid, marketHashName), itemNameId? }
	// 价格走势(成交中位价 + 售出数量,按账号钱包币种;最近一个月按小时、更早按天)。query: { accountId|account, url | (appid, marketHashName), refresh? }
	// → { appid, marketHashName, currency(钱包币种 id), currencyISO, points: [{time(ms), priceCents, volume}], cachedAt }
	router.get('/api/market/pricehistory', spreadRoute(req => market.priceHistory(req.query), '价格走势获取失败'));

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

	// ===== 出售(./sell.ts)。价格一律是钱包币种的最小单位(分),整数 =====

	// 可上架的库存。query: { account|accountId, appid?=730, contextid?=2, refresh?=1 }
	// → { account, appid, contextid, currency:{id, iso}, fees, publisherFeePercent, total, marketableCount, items:[...] }
	router.get('/api/market/sell/inventory', spreadRoute(req => market.sell.inventory(req.query), '库存读取失败'));

	// 一件的参考价。query: { account|accountId, appid, marketHashName } → { context, currency, fees, lowestSell, highestBuyOrder }
	router.get('/api/market/sell/price', spreadRoute(req => market.sell.price(req.query), '参考价获取失败'));

	// 手续费换算(和前端移植的 fees.ts 对账)。query: { buyerPriceCents | receivePriceCents, appid?, publisherFeePercent? } → { quote }
	router.get('/api/market/sell/quote', keyedRoute('quote', async req => market.sell.quote(req.query), '换算失败'));

	// 上架一批。body: { account|accountId, items:[{appid, contextid, assetid, amount?, buyerPriceCents | receivePriceCents}], autoConfirm?=true }
	router.post('/api/market/sell', spreadRoute(req => market.sell.sell(req.body || {}), '上架失败'));

	// 我的在售(多账号,含待确认)。body: { accounts:[账号名|attemptId...], concurrency? } → { accounts:[...] }
	router.post('/api/market/listings', spreadRoute(req => market.sell.listings(req.body || {}), '读取在售失败'));

	// 下架。body: { account|accountId, listingId }
	router.post('/api/market/listing/cancel', spreadRoute(req => market.sell.cancelListing(req.body || {}), '下架失败'));

	// 成交记录(一个账号,分页)。body: { account|accountId, start?=0, count?=50(1~100) }
	router.post('/api/market/history', spreadRoute(req => market.sell.history(req.body || {}), '读取成交记录失败'));

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
