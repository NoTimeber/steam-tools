// ECO 扫货的 HTTP 路由。浏览器拿不到私钥原文,只有对应的公钥。

import {keyedRoute, spreadRoute} from '../web/http.ts';
import type {Router} from '../web/http.ts';
import type {EcoService} from './index.ts';

export function ecoRoutes(router: Router, {eco}: {eco: EcoService}): void {
	router.get('/api/eco/state', (req, res) => {
		res.json({success: true, state: eco.state()});
	});

	// 设置:{partnerId?, privateKey?, clearCredentials?, strategy, tradeUrl, maxTotalSpend, ...};partnerId / privateKey 留空表示不改
	router.post('/api/eco/settings', keyedRoute('state', req => eco.saveSettings(req.body || {}), '保存设置失败'));
	// 生成新的 RSA 密钥对:私钥存库,state.publicKey 是要填到 ECO 开放平台的公钥
	router.post('/api/eco/keypair', keyedRoute('state', () => eco.generateKeyPair(), '生成密钥失败'));
	// 运行状态:stopped / sweeping(真实下单)
	router.post('/api/eco/run', keyedRoute('state', req => eco.setRun((req.body || {}).state), '操作失败'));
	// 监控列表整张表一起提交:{items: [{name, maxPrice, maxQty, maxSpend, gameId}]}
	router.post('/api/eco/watchlist', keyedRoute('state', req => eco.saveWatchlist((req.body || {}).items), '保存监控列表失败'));

	// 添加饰品时按中文或英文搜名字,带 ECO 在售最低价:?q=千瓦&gameId=730 → {options: [{name, zh, lowest, sellCount}], priced, priceError}
	router.get('/api/eco/names', spreadRoute(req => eco.searchNames(req.query.q, req.query.gameId), '搜索饰品失败'));
	// 收货账号:ECO 上绑定的 Steam 账号(带交易链接);?refresh=1 强制重查
	router.get('/api/eco/receivers', spreadRoute(req => eco.receivers(req.query.refresh === '1'), '读取账号失败'));

	// 验证交易链接:{steamIds?: [..]}(不给验全部)→ {accounts(带 linkCheck), checked, boundError}
	router.post('/api/eco/receivers/verify', spreadRoute(req => eco.verifyTradeLinks((req.body || {}).steamIds), '验证交易链接失败'));
	// 更新交易链接:{steamId} → ECO 用工具里存的 refreshToken 重新取链接 → {tradeUrl, valid, accounts, state}
	router.post('/api/eco/receivers/update-link', spreadRoute(req => eco.updateTradeLink((req.body || {}).steamId), '更新交易链接失败'));

	// 导入令牌绑定:账户管理里的账号(能不能导入、ECO 上绑没绑);?refresh=1 重查 ECO
	router.get('/api/eco/bind/accounts', spreadRoute(req => eco.bindCandidates(req.query.refresh === '1'), '读取账号失败'));
	// {accounts: [账号名], groupMode: 'none' | 'fixed' | 'tool', groupName?} → {results: [{account, status, message}], accounts, groups, boundError}
	router.post('/api/eco/bind/import', spreadRoute(req => eco.importGuard(req.body || {}), '绑定失败'));

	router.post('/api/eco/check', keyedRoute('result', () => eco.check(), '检查连接失败'));
	router.post('/api/eco/listings', spreadRoute(req => eco.listings((req.body || {}).name), '查在售失败'));
	router.post('/api/eco/orders/refresh', spreadRoute(() => eco.refreshOrders(), '同步订单失败'));
	router.post('/api/eco/purchases/resolve', keyedRoute('state', req => {
		const body = req.body || {};
		return eco.resolvePurchase(body.merchantNo, body.status);
	}, '标记失败'));
}
