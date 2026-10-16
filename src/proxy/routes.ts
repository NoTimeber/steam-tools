// Steam 代理设置的 HTTP 路由:读设置(密码打码)、设全局代理、设账号的代理、测代理。

import {keyedRoute, spreadRoute} from '../web/http.ts';
import type {Router} from '../web/http.ts';
import type {ProxyService} from './index.ts';

export interface ProxyRouteDeps {
	proxy: ProxyService;
}

export function proxyRoutes(router: Router, {proxy}: ProxyRouteDeps): void {
	router.get('/api/proxy', keyedRoute('proxy', () => proxy.publicConfig(), '读取代理设置失败'));
	router.post('/api/proxy/global', keyedRoute('proxy', req => proxy.setGlobal(req.body || {}), '保存代理设置失败'));
	router.post('/api/proxy/account', keyedRoute('proxy', req => proxy.setAccount(req.body || {}), '保存代理设置失败'));
	router.post('/api/proxy/test', spreadRoute(req => proxy.test(req.body || {}), '测试代理失败'));
}
