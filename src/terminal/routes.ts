// CS2「创世终端机」的 HTTP 路由。
// ⚠️ 解封、推进报价不可逆(解封启动 72h 倒计时);这组端点不含花钱兑换报价。

import {keyedRoute} from '../web/http.ts';
import type {Router} from '../web/http.ts';
import type {TerminalService} from './index.ts';

export function terminalRoutes(router: Router, {terminal}: {terminal: TerminalService}): void {
	router.post('/api/terminal/unseal', keyedRoute('result', req => terminal.unseal(req.body || {}), '解封失败'));
	// 协议探针:依次发多种候选解封消息,对齐回包 + SO 变动,命中即停。
	router.post('/api/terminal/probe', keyedRoute('result', req => terminal.probe(req.body || {}), '探针失败'));
	// 推进到下一个报价:不可逆、消耗 1 次挑选。仅在前端强确认后调用。
	router.post('/api/terminal/advance-offer', keyedRoute('result', req => terminal.advanceOffer(req.body || {}), '推进报价失败'));
	router.post('/api/terminal/request-offers', keyedRoute('result', req => terminal.requestOffers(req.body || {}), '请求报价失败'));
	// GC 通路自检:查自己 profile,验证本会话 GC 请求能否收到回包。
	router.post('/api/terminal/selftest', keyedRoute('result', req => terminal.selfTest(req.body || {}), '自检失败'));
	// 解析已捕获报价里的 faux_itemid → 真实皮肤(GC 检视)。
	router.post('/api/terminal/resolve-offers', keyedRoute('result', req => terminal.resolveOffers(req.body || {}), '解析报价失败'));
	router.get('/api/terminal/state', keyedRoute('state', req => terminal.state(req.query), '读取终端机状态失败'));
}
