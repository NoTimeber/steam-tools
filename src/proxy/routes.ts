// 代理管理的 HTTP 路由:代理池(增删改、批量、导入、检测)、代理组、账号 / 账户分组的绑定、代理用量。
// 改动都回最新的整份状态(proxies 字段,密码不下发),页面直接替换。

import {keyedRoute, spreadRoute} from '../web/http.ts';
import type {Request, Router} from '../web/http.ts';
import type {ProxyService} from './index.ts';

export interface ProxyRouteDeps {
	proxy: ProxyService;
}

export function proxyRoutes(router: Router, {proxy}: ProxyRouteDeps): void {
	const body = (req: Request) => (req.body || {}) as Record<string, unknown>;
	const changed = (run: (req: Request) => unknown, fallback: string) => keyedRoute('proxies', run, fallback);

	router.get('/api/proxies', changed(() => proxy.state(), '读取代理失败'));
	router.post('/api/proxies/create', spreadRoute(req => {
		const result = proxy.createProxy(body(req));
		return {proxies: result.state, proxy: result.proxy};
	}, '添加代理失败'));
	router.post('/api/proxies/update', spreadRoute(req => {
		const result = proxy.updateProxy(body(req));
		return {proxies: result.state, proxy: result.proxy};
	}, '保存代理失败'));
	router.post('/api/proxies/delete', changed(req => proxy.deleteProxies(body(req)), '删除代理失败'));
	router.post('/api/proxies/bulk', changed(req => proxy.bulk(body(req)), '批量操作失败'));
	router.post('/api/proxies/import', spreadRoute(req => {
		const {state, ...rest} = proxy.importProxies(body(req));
		return {proxies: state, ...rest};
	}, '导入代理失败'));
	router.post('/api/proxies/test', changed(req => proxy.test(body(req)), '检测代理失败'));
	router.post('/api/proxies/test-draft', spreadRoute(req => proxy.testDraft(body(req)), '检测代理失败'));

	router.post('/api/proxies/groups/create', spreadRoute(req => {
		const result = proxy.createGroup(body(req));
		return {proxies: result.state, group: result.group};
	}, '新建代理组失败'));
	router.post('/api/proxies/groups/update', changed(req => proxy.updateGroup(body(req)), '保存代理组失败'));
	router.post('/api/proxies/groups/delete', changed(req => proxy.deleteGroup(body(req)), '删除代理组失败'));

	router.post('/api/proxies/accounts/bind', changed(req => proxy.bindAccounts(body(req)), '保存账号代理失败'));
	router.post('/api/proxies/accounts/distribute', spreadRoute(req => {
		const {pairs, ...state} = proxy.distributeProxies(body(req));
		return {proxies: state, pairs};
	}, '分配代理失败'));
	router.post('/api/proxies/account-groups/link', changed(req => proxy.linkAccountGroup(body(req)), '保存账户分组的代理组失败'));

	router.get('/api/proxies/usage', keyedRoute('usage', req => proxy.usageReport({days: req.query.days, proxyId: req.query.proxyId}), '读取代理用量失败'));
}
