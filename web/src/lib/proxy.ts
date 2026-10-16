// Steam 代理的纯逻辑(不依赖 Vue,单元测试直接用 node 跑):账号现在走哪个代理、怎么显示,测试结果里的 Steam 社区检查怎么显示。

import type {AccountProxyMode, ProxyTestResult, PublicProxyConfig} from '../api/types.ts';

export interface AccountProxyView {
	mode: AccountProxyMode;
	/** 表格里显示的短文字 */
	label: string;
	/** 鼠标悬停显示的完整说明(密码已打码) */
	title: string;
}

/** 去掉协议和账号密码,只留「主机:端口」 */
export function proxyHost(url: string): string {
	return url.replace(/^[a-z]+:\/\//i, '').replace(/^.*@/, '');
}

/** 账号的代理:单独设置的优先,没有就跟全局(全局也没设就是直连) */
export function accountProxy(config: PublicProxyConfig, accountName: string): AccountProxyView {
	const own = config.accounts[accountName.trim().toLowerCase()];
	if (own?.mode === 'direct') {
		return {mode: 'direct', label: '不走代理', title: '这个账号单独设置了不走代理'};
	}
	if (own?.mode === 'custom') {
		return {mode: 'custom', label: proxyHost(own.url), title: `单独代理:${own.url}`};
	}
	if (!config.global) {
		return {mode: 'global', label: '直连', title: '没有设置全局代理,Steam 请求直连'};
	}
	if (config.sticky) {
		const index = config.assigned[accountName.trim().toLowerCase()];
		return index == null
			? {mode: 'global', label: '全局 · 待分配', title: '固定 IP:第一次用 Steam 时分配编号'}
			: {mode: 'global', label: `全局 #${index}`, title: `固定 IP:编号 ${index}(${config.global.split('{n}').join(String(index))}),重新登录时换一个`};
	}
	return {mode: 'global', label: '全局', title: `用全局代理:${config.global}`};
}

export interface SteamCheckView {
	type: 'success' | 'warning' | 'error';
	/** 跟在出口 IP 后面的短句 */
	text: string;
	/** 鼠标悬停的完整说明 */
	detail: string;
}

/**
 * 测试结果里「Steam 社区市场」那一项。429 不一定是这个 IP 被限流:实测 Steam 对机房代理 IP 上的非浏览器请求
 * (工具台的请求就是)市场、库存接口一律回 429,同一个 IP 用浏览器开却正常。relogin:固定 IP 模式,提示可以重新登录换一个
 */
export function steamCheckView(steam: ProxyTestResult['steam'], relogin: boolean): SteamCheckView {
	if (steam.status === 429) {
		return {
			type: 'warning',
			text: '市场 429,市场和库存用不了' + (relogin ? ',可重新登录换 IP' : ''),
			detail: 'Steam 社区市场回 429:经这个代理,工具台的市场、库存请求会被拒(IP 被限流,或 Steam 不放行机房代理上的非浏览器请求);登录、商店、手机确认不受影响'
		};
	}
	if (steam.status >= 200 && steam.status < 400) {
		return {type: 'success', text: '市场正常', detail: `Steam 社区市场 HTTP ${steam.status},${steam.ms} ms`};
	}
	if (steam.status) {
		return {type: 'warning', text: `市场 HTTP ${steam.status}`, detail: `Steam 社区市场回 HTTP ${steam.status}`};
	}
	return {type: 'error', text: '市场打不开', detail: `Steam 社区市场打不开:${steam.error || '原因未知'}`};
}
