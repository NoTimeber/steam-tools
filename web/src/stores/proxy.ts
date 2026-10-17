// 代理管理:代理池、代理组、账号 / 账户分组的绑定(GET /api/proxies,改动后服务端回整份最新状态,也经 proxies:update 推送)。
// 服务端不下发代理密码。检测在服务端后台跑,状态先是「检查中」,测完一个推一次。

import {reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import type {AccountBinding, ProxyCheck, ProxyGroup, ProxyKind, ProxyProtocol, ProxyUsageReport, PublicProxy, PublicProxyState} from '../api/types.ts';
import {addLog} from './logs.ts';

const state = reactive({
	data: {proxies: [], groups: [], accounts: {}, accountGroups: {}, assigned: {}} as PublicProxyState,
	loaded: false,
	error: ''
});

export const proxy = state;

type StateResponse = {proxies: PublicProxyState};

function apply(next: PublicProxyState): PublicProxyState {
	state.data = next;
	state.loaded = true;
	state.error = '';
	return next;
}

const post = async (url: string, body: unknown) => apply((await api.post<StateResponse>(url, body)).proxies);

/** 读代理;读不到时页面照样能用(当作没有) */
export async function loadProxies(): Promise<void> {
	try {
		apply((await api.get<StateResponse>('/api/proxies')).proxies);
	} catch (err) {
		state.error = errorText(err);
	}
}

let started = false;

export function startProxies(): void {
	if (started) {
		return;
	}
	started = true;
	socket.on('proxies:update', (next: PublicProxyState | null) => {
		if (next && Array.isArray(next.proxies)) {
			apply(next);
		}
	});
	// 断线期间可能错过推送
	socket.on('connect', () => {
		if (state.loaded) {
			void loadProxies();
		}
	});
}

/** 新建 / 编辑代理页提交的各项;password 留空保留原来的,数字留空为 null(没填;登录速率限制为不限) */
export interface ProxyForm {
	protocol: ProxyProtocol;
	host: string;
	port: number | null;
	type: ProxyKind;
	username: string;
	password: string;
	poolSize: number | null;
	loginsPerMinute: number | null;
	enabled: boolean;
	notes: string;
	groupIds: string[];
}

export function emptyProxyForm(): ProxyForm {
	return {protocol: 'http', host: '', port: null, type: 'static', username: '', password: '', poolSize: null, loginsPerMinute: null, enabled: true, notes: '', groupIds: []};
}

/** 表单各项转成接口参数(空的数字传 '') */
function formBody(form: ProxyForm) {
	return {...form, port: form.port ?? '', poolSize: form.type === 'rotating' ? form.poolSize ?? '' : '', loginsPerMinute: form.loginsPerMinute ?? ''};
}

export async function createProxy(form: ProxyForm): Promise<PublicProxy> {
	const result = await api.post<StateResponse & {proxy: PublicProxy}>('/api/proxies/create', formBody(form));
	apply(result.proxies);
	addLog('success', `已添加代理 ${result.proxy.endpoint}`);
	return result.proxy;
}

export async function updateProxy(id: string, form: ProxyForm): Promise<PublicProxy> {
	const result = await api.post<StateResponse & {proxy: PublicProxy}>('/api/proxies/update', {id, ...formBody(form)});
	apply(result.proxies);
	addLog('success', `已保存代理 ${result.proxy.endpoint}(已登录的账号重新登录后登录连接才换)`);
	return result.proxy;
}

export async function deleteProxies(ids: readonly string[]): Promise<void> {
	await post('/api/proxies/delete', {ids});
	addLog('success', `已删除 ${ids.length} 个代理`);
}

export type BulkAction = 'enable' | 'disable' | 'loginLimit' | 'addGroups' | 'removeGroups';

export async function bulkProxies(ids: readonly string[], action: BulkAction, value?: unknown): Promise<void> {
	await post('/api/proxies/bulk', {ids, action, value});
}

/** 「已有的跳过」和拆不开的行,导入弹窗里显示 */
export interface ImportOutcome {
	added: number;
	duplicates: number;
	errors: Array<{line: number; error: string}>;
}

export async function importProxies(body: {text: string; protocol: ProxyProtocol; type: ProxyKind; enabled: boolean; groupIds: string[]}): Promise<ImportOutcome> {
	const result = await api.post<StateResponse & ImportOutcome>('/api/proxies/import', body);
	apply(result.proxies);
	if (result.added) {
		addLog('success', `已导入 ${result.added} 个代理` + (result.duplicates ? `,${result.duplicates} 个已有的跳过` : ''));
	}
	return {added: result.added, duplicates: result.duplicates, errors: result.errors};
}

/** 检测(不传 ids 测全部):马上返回,状态是「检查中」,测完经推送更新 */
export async function testProxies(ids?: readonly string[]): Promise<void> {
	await post('/api/proxies/test', ids ? {ids} : {});
}

/** 测编辑页上还没保存的各项(带 id 时密码留空用存着的) */
export async function testDraft(id: string, form: ProxyForm): Promise<{check: ProxyCheck; proxy: string}> {
	return api.post<{check: ProxyCheck; proxy: string}>('/api/proxies/test-draft', {...(id ? {id} : {}), ...formBody(form)});
}

// ===== 代理组 =====

export async function createGroup(name: string, color: string, proxyIds: readonly string[] = []): Promise<ProxyGroup> {
	const result = await api.post<StateResponse & {group: ProxyGroup}>('/api/proxies/groups/create', {name, color, proxyIds});
	apply(result.proxies);
	return result.group;
}

export async function updateGroup(id: string, fields: {name?: string; color?: string}): Promise<void> {
	await post('/api/proxies/groups/update', {id, ...fields});
}

export async function deleteGroup(id: string): Promise<void> {
	await post('/api/proxies/groups/delete', {id});
}

export function groupById(id: string): ProxyGroup | undefined {
	return state.data.groups.find(group => group.id === id);
}

// ===== 账号 =====

export type AccountProxyMode = 'pool' | 'direct' | 'bind';

/** 设账号的代理:pool 用代理池、direct 不走代理、bind 只用选的代理和代理组 */
export async function bindAccounts(accountNames: readonly string[], mode: AccountProxyMode, proxyIds: readonly string[] = [], groupIds: readonly string[] = []): Promise<void> {
	await post('/api/proxies/accounts/bind', {accountNames, mode, proxyIds, groupIds});
	const who = accountNames.length === 1 ? accountNames[0] : `${accountNames.length} 个账号`;
	const label = mode === 'pool' ? '用代理池' : mode === 'direct' ? '不走代理' : `绑定 ${proxyIds.length ? `${proxyIds.length} 个代理` : ''}${proxyIds.length && groupIds.length ? '、' : ''}${groupIds.length ? `${groupIds.length} 个代理组` : ''}`;
	addLog('success', `${who}:Steam 代理改为${label}(已登录的要重新登录,登录连接才换)`);
}

/** 从选的代理里给每个账号绑一个 */
export async function distributeProxies(accountNames: readonly string[], proxyIds: readonly string[]): Promise<void> {
	const result = await api.post<StateResponse & {pairs: Record<string, string>}>('/api/proxies/accounts/distribute', {accountNames, proxyIds});
	apply(result.proxies);
	const used = new Set(Object.values(result.pairs)).size;
	addLog('success', `已给 ${accountNames.length} 个账号各绑定一个代理(用了 ${used} 个代理)`);
}

/** 账户分组关联的代理组 */
export async function linkAccountGroup(accountGroupId: string, groupIds: readonly string[]): Promise<void> {
	await post('/api/proxies/account-groups/link', {accountGroupId, groupIds});
}

export function bindingOf(accountName: string): AccountBinding | undefined {
	return state.data.accounts[accountName.trim().toLowerCase()];
}

// ===== 用量 =====

export async function fetchUsage(days: number, proxyId = ''): Promise<ProxyUsageReport | null> {
	const query = new URLSearchParams({days: String(days), ...(proxyId ? {proxyId} : {})});
	return (await api.get<{usage: ProxyUsageReport | null}>(`/api/proxies/usage?${query}`)).usage;
}
