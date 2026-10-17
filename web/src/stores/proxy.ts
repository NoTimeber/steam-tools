// Steam 代理设置:全局代理(运行设置 → Steam 代理)和账号的单独设置(账户管理页)。服务端不下发密码,地址里的密码打码。

import {reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import type {AccountProxyMode, GlobalProxySettings, ProxyKind, ProxyProtocol, ProxyTestResult, PublicProxyConfig} from '../api/types.ts';
import {addLog} from './logs.ts';

const emptySettings = (): GlobalProxySettings => ({
	enabled: false, protocol: 'http', host: '', port: 0, type: 'rotating', username: '', hasPassword: false, poolSize: 0, loginsPerMinute: 0
});

const state = reactive({
	config: {global: '', settings: emptySettings(), sticky: false, accounts: {}, assigned: {}} as PublicProxyConfig,
	loaded: false,
	error: ''
});

export const proxy = state;

/** 代理设置页提交的各项;password 留空保留原来的,数字留空为 null(没填;登录速率限制为不限) */
export interface GlobalProxyForm {
	enabled: boolean;
	protocol: ProxyProtocol;
	host: string;
	port: number | null;
	type: ProxyKind;
	username: string;
	password: string;
	/** 轮换池里有几个 IP */
	poolSize: number | null;
	loginsPerMinute: number | null;
}

/** 表单各项转成接口参数(空的数字传 '') */
function formBody(form: GlobalProxyForm) {
	return {...form, port: form.port ?? '', poolSize: form.poolSize ?? '', loginsPerMinute: form.loginsPerMinute ?? ''};
}

/** 读代理设置;读不到时页面上照样能用(当作没设) */
export async function loadProxy(): Promise<void> {
	try {
		state.config = (await api.get<{proxy: PublicProxyConfig}>('/api/proxy')).proxy;
		state.loaded = true;
		state.error = '';
	} catch (err) {
		state.error = errorText(err);
	}
}

/** 保存全局代理;不对的服务端回 400,错误抛给页面显示 */
export async function saveGlobalProxy(form: GlobalProxyForm): Promise<void> {
	state.config = (await api.post<{proxy: PublicProxyConfig}>('/api/proxy/global', formBody(form))).proxy;
	const {settings, sticky} = state.config;
	addLog('success', settings.enabled
		? `全局 Steam 代理已设为 ${state.config.global}` + (sticky ? `(轮换,${settings.poolSize} 个 IP,每个账号固定一个)` : '')
			+ (settings.loginsPerMinute ? `,登录每分钟最多 ${settings.loginsPerMinute} 次` : '')
		: '全局 Steam 代理已关闭,Steam 请求直连');
}

/** 设账号的代理:global 跟全局、direct 不走代理、custom 用填的(没填沿用原来的单独代理) */
export async function saveAccountProxy(accountName: string, mode: AccountProxyMode, proxyUrl: string): Promise<void> {
	state.config = (await api.post<{proxy: PublicProxyConfig}>('/api/proxy/account', {accountName, mode, proxy: proxyUrl})).proxy;
	const label = mode === 'global' ? '跟随全局' : mode === 'direct' ? '不走代理' : state.config.accounts[accountName.toLowerCase()]?.url || '单独代理';
	addLog('success', `${accountName}: Steam 代理改为 ${label}(登录连接要重新登录才换)`);
}

/** 测代理:传 form 测设置页上还没保存的各项;传 proxy 测填的地址;都没有测这个账号(或全局)现在用的 */
export function testProxy(body: {form?: GlobalProxyForm; proxy?: string; accountName?: string}): Promise<ProxyTestResult> {
	return api.post<ProxyTestResult>('/api/proxy/test', body.form ? formBody(body.form) : {proxy: body.proxy, accountName: body.accountName});
}
