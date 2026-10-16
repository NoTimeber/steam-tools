// Steam 代理设置:全局代理(运行设置页)和账号的单独设置(账户管理页)。服务端只下发打码后的地址。

import {reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import type {AccountProxyMode, ProxyTestResult, PublicProxyConfig} from '../api/types.ts';
import {addLog} from './logs.ts';

const state = reactive({
	config: {global: '', sticky: false, range: {from: 1, to: 1}, accounts: {}, assigned: {}} as PublicProxyConfig,
	loaded: false,
	error: ''
});

export const proxy = state;

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

/**
 * 设全局代理;'' 清除,undefined 只改编号范围(带 {n} 的固定 IP 模式用)。
 * 地址不对服务端回 400,错误抛给页面显示
 */
export async function saveGlobalProxy(proxyUrl: string | undefined, range?: {from: number; to: number}): Promise<void> {
	state.config = (await api.post<{proxy: PublicProxyConfig}>('/api/proxy/global', {proxy: proxyUrl, ...range})).proxy;
	const sticky = state.config.sticky ? `(固定 IP,编号 ${state.config.range.from}-${state.config.range.to})` : '';
	addLog('success', proxyUrl === '' ? '已清除全局 Steam 代理' : `全局 Steam 代理已设为 ${state.config.global}${sticky}`);
}

/** 设账号的代理:global 跟全局、direct 不走代理、custom 用填的(没填沿用原来的单独代理) */
export async function saveAccountProxy(accountName: string, mode: AccountProxyMode, proxyUrl: string): Promise<void> {
	state.config = (await api.post<{proxy: PublicProxyConfig}>('/api/proxy/account', {accountName, mode, proxy: proxyUrl})).proxy;
	const label = mode === 'global' ? '跟随全局' : mode === 'direct' ? '不走代理' : state.config.accounts[accountName.toLowerCase()]?.url || '单独代理';
	addLog('success', `${accountName}: Steam 代理改为 ${label}(登录连接要重新登录才换)`);
}

/** 测代理:填了地址测填的,没填测这个账号(或全局)现在用的 */
export function testProxy(body: {proxy?: string; accountName?: string; from?: number; to?: number}): Promise<ProxyTestResult> {
	return api.post<ProxyTestResult>('/api/proxy/test', body);
}
