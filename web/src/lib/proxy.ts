// Steam 代理的纯逻辑(不依赖 Vue,单元测试直接用 node 跑):账号现在走哪个代理、怎么显示,测试结果里的 Steam 社区检查怎么显示,
// 代理设置页的类型说明、粘贴整串地址拆成各项。

import type {AccountProxyMode, ProxyKind, ProxyProtocol, ProxyTestResult, PublicProxyConfig} from '../api/types.ts';

/** 代理类型的选项和说明 */
export const PROXY_KIND_OPTIONS: ReadonlyArray<{value: ProxyKind; label: string; help: string}> = [
	{value: 'static', label: '静态', help: '静态代理有一个固定的出口 IP。'},
	{value: 'rotating', label: '轮换', help: '轮换代理是单个入口,由提供商轮换出口 IP。'},
	{value: 'sticky', label: '按账号固定 IP', help: '用户名里写 {n}(如 kxkviurm-{n}),每个账号分到一个编号、一直用同一个 IP,新账号或重新登录才换。'}
];

export function proxyKindLabel(kind: ProxyKind): string {
	return PROXY_KIND_OPTIONS.find(option => option.value === kind)?.label ?? kind;
}

/** 运行设置页上全局代理的一句话状态 */
export function proxySummary(config: PublicProxyConfig): string {
	const settings = config.settings;
	if (!settings.host) {
		return '未设置';
	}
	const text = `${settings.host}:${settings.port} · ${proxyKindLabel(settings.type)}`;
	if (!settings.enabled) {
		return `已关闭(${text})`;
	}
	const assigned = Object.keys(config.assigned).filter(key => key).length;
	return text + (config.sticky ? ` · 编号 ${config.range.from}-${config.range.to},已分配 ${assigned}` : '')
		+ (settings.loginsPerMinute ? ` · 登录每分钟 ${settings.loginsPerMinute} 次` : '');
}

export interface ProxyUrlParts {
	protocol: ProxyProtocol;
	host: string;
	port: number;
	username: string;
	password: string;
}

/** 解析时暂时代替 {n} 的记号({ } 会被 URL 编码掉) */
const INDEX_MARK = 'zzproxyindexzz';

/**
 * 粘贴进主机栏的一整串代理地址(http://用户名:密码@主机:端口,可以带 {n})拆成各项;
 * 不像代理地址(没有 :// 也没有 @)或解析不了的返回 null
 */
export function splitProxyUrl(text: string): ProxyUrlParts | null {
	const raw = text.trim();
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
	if (!hasScheme && !raw.includes('@')) {
		return null;
	}
	try {
		const url = new URL((hasScheme ? raw : `http://${raw}`).split('{n}').join(INDEX_MARK));
		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
			return null;
		}
		const restore = (value: string) => decodeURIComponent(value).split(INDEX_MARK).join('{n}');
		const https = url.protocol === 'https:';
		return {
			protocol: https ? 'https' : 'http',
			host: restore(url.hostname),
			port: Number(url.port) || (https ? 443 : 80),
			username: restore(url.username),
			password: restore(url.password)
		};
	} catch {
		return null;
	}
}

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
		return {mode: 'global', label: '直连', title: config.settings.host ? '全局代理已关闭,Steam 请求直连' : '没有设置全局代理,Steam 请求直连'};
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
