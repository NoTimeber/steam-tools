// 账号与登录的 HTTP 路由:账户名单、分组、账号资料、maFile、令牌验证码、登录/Guard/WebSession/登出、删除账号、消费记录、连接/断开 GC。

import {keyedRoute, requestGame, spreadRoute} from '../web/http.ts';
import type {Handler, Router} from '../web/http.ts';
import type {AccountService} from './index.ts';

export interface AccountRouteDeps {
	accounts: AccountService;
	/** 调试端点开关(读 cookies) */
	debug: Handler;
}

export function accountRoutes(router: Router, {accounts, debug}: AccountRouteDeps): void {
	router.get('/api/attempts', (req, res) => {
		res.json({success: true, attempts: accounts.listAttempts()});
	});

	// 账户名单:多浏览器/多设备共享(加密库)。
	// initialized 表示服务端是否写过名单——前端据此决定首次升级时是否把本地名单迁移上来,
	// 避免"已删除账号"被某个仍有旧 localStorage 的浏览器重新推回。
	router.get('/api/accounts/list', spreadRoute(() => accounts.listAccounts(), '读取账户名单失败'));
	// 全量替换账户名单(前端 saveAccounts 推送的就是完整 state.accounts)。
	router.post('/api/accounts/list', spreadRoute(req => accounts.saveAccounts(req.body || {}), '保存账户名单失败'));
	// 导入:按账号名合并,不动其它账号(新版前端用)
	router.post('/api/accounts/upsert', spreadRoute(req => accounts.upsertAccounts(req.body || {}), '导入账户失败'));
	// 分组:新建(可顺便移入账号)、改名、删除(组里的账号变成未分组)、排序、把账号移进/移出分组;都返回最新的分组和名单
	router.post('/api/accounts/groups', spreadRoute(req => accounts.createGroup(req.body || {}), '新建分组失败'));
	router.post('/api/accounts/groups/:id', spreadRoute(req => accounts.renameGroup(req.params.id!, req.body || {}), '修改分组失败'));
	router.delete('/api/accounts/groups/:id', spreadRoute(req => accounts.deleteGroup(req.params.id!), '删除分组失败'));
	router.post('/api/accounts/group-order', spreadRoute(req => accounts.reorderGroups(req.body || {}), '调整分组顺序失败'));
	router.post('/api/accounts/group-members', spreadRoute(req => accounts.moveToGroup(req.body || {}), '移动账号失败'));
	router.post('/api/accounts/meta', spreadRoute(req => accounts.meta(req.body || {}), '读取账号资料失败'));
	// 服务端持久化 maFile:完整 maFile(含 identity_secret)加密存入数据库,发货/求购确认时取 identity_secret。
	router.post('/api/mafile/import', spreadRoute(req => accounts.importMaFiles(req.body || {}), '导入 maFile 失败'));
	router.post('/api/auth-code', spreadRoute(req => accounts.authCode(req.body || {}), '生成验证码失败'));
	router.post('/api/login', spreadRoute(req => accounts.login(req.body || {}), '登录失败'));
	router.post('/api/login-refresh', spreadRoute(req => accounts.loginWithRefreshToken(req.body || {}), '登录失败'));
	router.post('/api/guard/:id', spreadRoute(req => accounts.submitGuard(req.params.id!, req.body || {}), '提交验证码失败'));
	router.post('/api/web-session/:id', spreadRoute(req => accounts.requestWebSession(req.params.id!), '获取 WebSession 失败'));
	router.post('/api/logout/:id', spreadRoute(req => accounts.logout(req.params.id!), '登出失败'));
	// 前端删除账户时调用:登出、移出会话表,删掉保存的 session,并从名单移除。
	router.post('/api/accounts/cleanup', spreadRoute(req => accounts.cleanup(req.body || {}), '清理失败'));
	// 消费记录:POST 开始读(后台翻页,force 重读),GET 查进度/结果
	router.post('/api/accounts/history', keyedRoute('history', req => accounts.loadHistory(req.body || {}), '读取消费记录失败'));
	router.get('/api/accounts/history', keyedRoute('history', req => accounts.getHistory(req.query.accountName), '读取消费记录失败'));
	router.post('/api/gc/connect/:id', spreadRoute(req => accounts.connectGc(req.params.id!, requestGame(req)), '连接 GC 失败'));
	router.post('/api/gc/disconnect/:id', spreadRoute(req => accounts.disconnectGc(req.params.id!, requestGame(req)), '断开 GC 失败'));
	router.get('/api/cookies/:id', debug, spreadRoute(req => accounts.cookies(req.params.id!), '读取 cookies 失败'));
}
