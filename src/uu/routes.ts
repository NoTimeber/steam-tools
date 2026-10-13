// UU(悠悠有品)发货、自动上架、token 管理的 HTTP 路由。浏览器只拿得到 tokenId,拿不到 token 原文。

import {keyedRoute, spreadRoute} from '../web/http.ts';
import type {Router} from '../web/http.ts';
import type {UuService} from './index.ts';

export function uuRoutes(router: Router, {uu}: {uu: UuService}): void {
	router.get('/api/uu/state', (req, res) => {
		res.json({success: true, ...uu.state()});
	});

	// 绑定:手动粘贴传 token;自动绑定传 tokenId(浏览器拿不到 token 原文)
	router.post('/api/uu/bind', keyedRoute('account', req => uu.bind(req.body || {}), 'token 绑定失败'));
	router.post('/api/uu/auto', keyedRoute('account', req => {
		const body = req.body || {};
		return uu.setAuto(body.accountName, body.gameId, !!body.enabled);
	}, '操作失败'));
	router.post('/api/uu/scan', keyedRoute('account', req => {
		const body = req.body || {};
		return uu.scan(body.accountName, body.gameId);
	}, '扫描发货失败'));
	router.get('/api/uu/orders/:account', keyedRoute('orders', req => uu.waitDeliverOrders(req.params.account), '读取待发货列表失败'));

	// CS2 自动上架:开关 + 手动触发一次
	router.post('/api/uu/list/auto', keyedRoute('account', req => uu.setListAuto((req.body || {}).accountName, !!(req.body || {}).enabled), '操作失败'));
	router.post('/api/uu/list/scan', keyedRoute('account', req => uu.listScan((req.body || {}).accountName), '上架扫描失败'));
	router.post('/api/uu/poll-interval', keyedRoute('pollIntervalMs', req => uu.setPollIntervalMinutes((req.body || {}).minutes), '设置轮询间隔失败'));

	// 悠悠短信登录拿 token(两步:start 发码 → verify 登录);返回给浏览器的只有 tokenId,没有 token 原文
	router.post('/api/uu/login/start', spreadRoute(req => uu.loginStart((req.body || {}).phone), '发送验证码失败'));
	router.post('/api/uu/login/verify', spreadRoute(req => uu.loginVerify(req.body || {}), '登录失败'));
	router.post('/api/uu/login/cancel', (req, res) => {
		uu.loginCancel((req.body || {}).loginSessionId);
		res.json({success: true});
	});

	// ===== 独立 token 管理(先存进加密库,再绑到具体 Steam 账号)=====
	router.post('/api/uu/token/acquire', keyedRoute('token', req => uu.acquireToken(req.body || {}), '保存 token 失败'));
	router.get('/api/uu/tokens', keyedRoute('tokens', () => uu.listTokens(), '读取 token 列表失败'));
	// 按账号(解绑并移除)、按 tokenId(未匹配到账号的)、或按 token 原文(兼容)删除
	router.delete('/api/uu/token', spreadRoute(req => {
		const account = uu.deleteToken(req.body || {});
		return account ? {account} : {};
	}, '删除 token 失败'));
}
