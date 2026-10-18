// 代理管理的纯逻辑(不依赖 Vue,单元测试直接用 node 跑):状态和类型怎么显示、表格的筛选和统计、
// 账号现在走哪些代理(账户页的「代理」列)、字节数和时间怎么显示、用量按代理组汇总、粘贴整串地址拆成各项。

import type {
	AccountBinding, ProxyCheck, ProxyGroup, ProxyKind, ProxyProtocol, ProxyStatus, ProxyUsageReport, PublicProxy, PublicProxyState, UsageKind, UsageTotals
} from '../api/types.ts';

/** 代理类型的选项和说明 */
export const PROXY_KIND_OPTIONS: ReadonlyArray<{value: ProxyKind; label: string; help: string}> = [
	{value: 'static', label: '静态', help: '静态代理有一个固定的出口 IP。'},
	{value: 'rotating', label: '轮换', help: '轮换代理是一个入口,由提供商换出口 IP。填了「IP 数量」就给每个账号固定其中一个 IP。'}
];

export function proxyKindLabel(kind: ProxyKind): string {
	return PROXY_KIND_OPTIONS.find(option => option.value === kind)?.label ?? kind;
}

/** Naive 的下拉要可变数组 */
export const PROTOCOL_OPTIONS: Array<{value: ProxyProtocol; label: string}> = [{value: 'http', label: 'HTTP'}, {value: 'https', label: 'HTTPS'}];

export type TagType = 'default' | 'info' | 'success' | 'warning' | 'error';

/** 状态标签的文字、颜色和说明 */
export const STATUS_META: Record<ProxyStatus, {label: string; type: TagType; tip: string}> = {
	untested: {label: '未测试', type: 'default', tip: '还没检测过,登录时照样会用'},
	checking: {label: '检查中', type: 'info', tip: '正在检测'},
	healthy: {label: '健康', type: 'success', tip: '上次检测连得通'},
	unreachable: {label: '无法访问', type: 'error', tip: '连不上这个代理'}
};

export const STATUS_OPTIONS = (Object.keys(STATUS_META) as ProxyStatus[]).map(value => ({value, label: STATUS_META[value].label}));

/** 代理组能选的颜色(和后端 GROUP_COLORS 一致;styles.css 里有对应的 --g-颜色 变量) */
export const GROUP_COLOR_OPTIONS: ReadonlyArray<{value: string; label: string}> = [
	{value: 'amber', label: '琥珀'},
	{value: 'blue', label: '蓝'},
	{value: 'green', label: '绿'},
	{value: 'red', label: '红'},
	{value: 'violet', label: '紫'},
	{value: 'cyan', label: '青'},
	{value: 'pink', label: '粉'},
	{value: 'gray', label: '灰'}
];

export const GROUP_NAME_MAX = 20;

/** 用量的请求类型 */
export const USAGE_KIND_LABEL: Record<UsageKind, string> = {
	market: '市场',
	inventory: '库存',
	store: '商店',
	trade: '交易报价',
	confirm: '手机确认',
	webapi: 'Web API',
	login: '登录',
	community: '社区',
	check: '代理检测',
	other: '其它'
};

/** 字节数:B、kB、MB、GB(按 1000 进) */
export function formatBytes(bytes: number): string {
	const value = Math.max(0, bytes || 0);
	if (value < 1000) {
		return `${Math.round(value)} B`;
	}
	const units = ['kB', 'MB', 'GB', 'TB'];
	let size = value;
	let unit = -1;
	while (size >= 1000 && unit < units.length - 1) {
		size /= 1000;
		unit++;
	}
	return `${size >= 100 ? Math.round(size) : Number(size.toFixed(1))} ${units[unit]}`;
}

/** 多久以前:刚刚、N 分钟前、N 小时前、N 天前、N 周前、N 个月前 */
export function timeAgo(time: number, now: number = Date.now()): string {
	if (!time) {
		return '—';
	}
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 60) {
		return '刚刚';
	}
	const steps: Array<[number, string]> = [[60, '分钟'], [3600, '小时'], [86400, '天'], [604800, '周'], [2592000, '个月']];
	let label = '';
	for (const [size, unit] of steps) {
		if (seconds >= size) {
			label = `${Math.floor(seconds / size)} ${unit}前`;
		}
	}
	return label;
}

/** 占比(整数百分比) */
export function percent(part: number, total: number): number {
	return total > 0 ? Math.round((part / total) * 100) : 0;
}

export const totalBytes = (item: UsageTotals) => item.sent + item.received;

/** 代理的名字:主机:端口,带用户名(同一个入口不同用户名是不同的代理,如 webshare 的 用户名-1、用户名-2) */
export function proxyLabel(proxy: Pick<PublicProxy, 'endpoint' | 'username'>): string {
	return proxy.username ? `${proxy.endpoint} · ${proxy.username}` : proxy.endpoint;
}

// ===== 检测结果 =====

/** 轮换代理但几次采样都是同一个 IP(可能没在换;这时建议设登录速率限制) */
export function isSingleIpRotating(proxy: Pick<PublicProxy, 'type' | 'check'>): boolean {
	return proxy.type === 'rotating' && !!proxy.check && proxy.check.samples >= 2 && proxy.check.ips.length === 1;
}

/** 「不同 IP」列:几次采样里有几个不同的 */
export function uniqueIpText(check: ProxyCheck | null): string {
	return check && check.samples ? `${check.samples} 次中有 ${check.ips.length} 个` : '—';
}

// ===== 表格:统计、筛选 =====

export function proxyStats(proxies: readonly PublicProxy[]) {
	return {
		total: proxies.length,
		healthy: proxies.filter(proxy => proxy.status === 'healthy').length,
		failing: proxies.filter(proxy => proxy.status === 'unreachable').length,
		untested: proxies.filter(proxy => proxy.status === 'untested').length,
		enabled: proxies.filter(proxy => proxy.enabled).length
	};
}

/** 代理组筛选里的「未分组」 */
export const NO_GROUP = '-';

export interface ProxyFilters {
	status: ProxyStatus | '';
	protocol: ProxyProtocol | '';
	type: ProxyKind | '';
	/** 代理组 id,NO_GROUP 为未分组,'' 不限 */
	group: string;
	enabled: '' | 'yes' | 'no';
	/** 只看标为轮换但只有一个 IP 的 */
	singleIp: boolean;
}

export function emptyProxyFilters(): ProxyFilters {
	return {status: '', protocol: '', type: '', group: '', enabled: '', singleIp: false};
}

export function activeProxyFilterCount(filters: ProxyFilters): number {
	return [filters.status, filters.protocol, filters.type, filters.group, filters.enabled].filter(Boolean).length + (filters.singleIp ? 1 : 0);
}

export function matchesProxy(proxy: PublicProxy, filters: ProxyFilters, search: string, groupNames: ReadonlyMap<string, string>): boolean {
	if (filters.status && proxy.status !== filters.status) {
		return false;
	}
	if (filters.protocol && proxy.protocol !== filters.protocol) {
		return false;
	}
	if (filters.type && proxy.type !== filters.type) {
		return false;
	}
	if (filters.group && (filters.group === NO_GROUP ? proxy.groupIds.length > 0 : !proxy.groupIds.includes(filters.group))) {
		return false;
	}
	if (filters.enabled && proxy.enabled !== (filters.enabled === 'yes')) {
		return false;
	}
	if (filters.singleIp && !isSingleIpRotating(proxy)) {
		return false;
	}
	const q = search.trim().toLowerCase();
	if (!q) {
		return true;
	}
	const text = [proxy.endpoint, proxy.username, proxy.notes, proxy.check?.ip ?? '', proxy.check?.country ?? '', ...proxy.groupIds.map(id => groupNames.get(id) ?? '')]
		.join(' ')
		.toLowerCase();
	return text.includes(q);
}

export type ProxySortKey = 'endpoint' | 'loginsPerMinute' | 'latency' | 'checkedAt';

/** 排序:延迟没测过的排最后 */
export function sortProxies(list: readonly PublicProxy[], key: ProxySortKey | '', order: 'ascend' | 'descend'): PublicProxy[] {
	if (!key) {
		return [...list];
	}
	const value = (proxy: PublicProxy): number | string => {
		switch (key) {
			case 'endpoint':
				return proxy.endpoint.toLowerCase();
			case 'loginsPerMinute':
				return proxy.loginsPerMinute || Number.MAX_SAFE_INTEGER;
			case 'latency':
				return proxy.check && proxy.check.status !== 'unreachable' ? proxy.check.latencyMs : Number.MAX_SAFE_INTEGER;
			default:
				return proxy.check?.checkedAt ?? 0;
		}
	};
	const sign = order === 'ascend' ? 1 : -1;
	return [...list].sort((a, b) => {
		const left = value(a);
		const right = value(b);
		return (left < right ? -1 : left > right ? 1 : 0) * sign;
	});
}

// ===== 账号 =====

/** 被账号单独绑定的代理(不进公共池) */
export function pinnedProxyIds(state: PublicProxyState): Set<string> {
	const ids = new Set<string>();
	for (const binding of Object.values(state.accounts)) {
		if (binding.mode === 'bind') {
			binding.proxyIds.forEach(id => ids.add(id));
		}
	}
	return ids;
}

/** 代理池:启用着、没被账号单独绑定的代理 */
export function poolProxies(state: PublicProxyState): PublicProxy[] {
	const pinned = pinnedProxyIds(state);
	return state.proxies.filter(proxy => proxy.enabled && !pinned.has(proxy.id));
}

export interface AccountProxyView {
	/** pool 用代理池;direct 直连(不走代理,或池里没代理);bind 用绑定的;refused 绑定的全停用了 */
	mode: 'pool' | 'direct' | 'bind' | 'refused';
	/** 表格里显示的短文字 */
	label: string;
	/** 鼠标悬停的完整说明 */
	tip: string;
}

/** 账号绑定的代理(自己的 + 账户分组关联的代理组) */
export function boundProxies(state: PublicProxyState, binding: AccountBinding | undefined, accountGroupId: string): {proxies: PublicProxy[]; groupIds: string[]; viaAccountGroup: string[]} {
	const own = binding?.mode === 'bind' ? binding : {proxyIds: [], groupIds: []};
	const viaAccountGroup = accountGroupId ? state.accountGroups[accountGroupId] ?? [] : [];
	const groupIds = [...new Set([...own.groupIds, ...viaAccountGroup])];
	const proxyIds = new Set(own.proxyIds);
	return {proxies: state.proxies.filter(proxy => proxyIds.has(proxy.id) || proxy.groupIds.some(id => groupIds.includes(id))), groupIds, viaAccountGroup};
}

function slotText(state: PublicProxyState, accountName: string): string {
	const slot = state.assigned[accountName.trim().toLowerCase()];
	const proxy = slot ? state.proxies.find(item => item.id === slot.proxyId) : undefined;
	return proxy ? `现在用 ${proxy.endpoint}${slot!.index ? ` 的第 ${slot!.index} 个 IP` : ''}(重启后重新分)` : '第一次用 Steam 时分配';
}

/** 账户页「代理」列:账号现在走哪些代理 */
export function accountProxyView(state: PublicProxyState, accountName: string, accountGroupId = ''): AccountProxyView {
	const binding = state.accounts[accountName.trim().toLowerCase()];
	if (binding?.mode === 'direct') {
		return {mode: 'direct', label: '不走代理', tip: '这个账号单独设置了不走代理,Steam 请求直连'};
	}
	const groupName = (id: string) => state.groups.find(group => group.id === id)?.name ?? '';
	const {proxies, groupIds, viaAccountGroup} = boundProxies(state, binding, accountGroupId);
	if (proxies.length) {
		const enabled = proxies.filter(proxy => proxy.enabled);
		const ownProxies = binding?.mode === 'bind' ? binding.proxyIds.length : 0;
		const label = !ownProxies && groupIds.length ? groupIds.map(groupName).filter(Boolean).join('、') : `${proxies.length} 个代理`;
		const source = viaAccountGroup.length ? `(含账户分组关联的代理组 ${viaAccountGroup.map(groupName).join('、')})` : '';
		if (!enabled.length) {
			return {mode: 'refused', label: '代理全停用', tip: `绑定的 ${proxies.length} 个代理${source}都停用了,这个账号不登录、不发 Steam 请求`};
		}
		return {mode: 'bind', label, tip: `只用绑定的 ${proxies.length} 个代理${source},${enabled.length} 个启用着;${slotText(state, accountName)}`};
	}
	const pool = poolProxies(state);
	if (!pool.length) {
		return {mode: 'direct', label: '直连', tip: state.proxies.length ? '代理池里没有可用的代理(都停用了或被账号单独绑定了),Steam 请求直连' : '还没有代理,Steam 请求直连'};
	}
	return {mode: 'pool', label: '代理池', tip: `从代理池的 ${pool.length} 个代理里分一个;${slotText(state, accountName)}`};
}

/** 用到这个代理组的账号数:自己绑定了它的,加上所在账户分组关联了它的 */
export function accountsUsingGroup(state: PublicProxyState, groupId: string, rows: ReadonlyArray<{key: string; groupId: string}>): number {
	return rows.filter(row => {
		const binding = state.accounts[row.key];
		if (binding?.mode === 'direct') {
			return false;
		}
		return (binding?.mode === 'bind' && binding.groupIds.includes(groupId)) || (!!row.groupId && (state.accountGroups[row.groupId] ?? []).includes(groupId));
	}).length;
}

/** 单独绑定了这个代理的账号(账号名小写) */
export function accountsPinnedTo(state: PublicProxyState, proxyId: string): string[] {
	return Object.entries(state.accounts).filter(([, binding]) => binding.mode === 'bind' && binding.proxyIds.includes(proxyId)).map(([key]) => key);
}

/** 这次运行里用着这个代理的账号(账号名小写,'' 是认不出账号的请求) */
export function accountsAssignedTo(state: PublicProxyState, proxyId: string): string[] {
	return Object.entries(state.assigned).filter(([, slot]) => slot.proxyId === proxyId).map(([key]) => key);
}

// ===== 用量 =====

/** 按代理组汇总(同时在两个组的代理两边都算;没分组的单独一项,id 为 '') */
export function usageByGroup(report: ProxyUsageReport, proxies: readonly PublicProxy[], groups: readonly ProxyGroup[]) {
	const byId = new Map(proxies.map(proxy => [proxy.id, proxy]));
	const rows = new Map<string, {groupId: string; name: string; color: string; proxies: number; bytes: number}>();
	const add = (groupId: string, name: string, color: string, bytes: number) => {
		const row = rows.get(groupId) ?? {groupId, name, color, proxies: 0, bytes: 0};
		row.proxies++;
		row.bytes += bytes;
		rows.set(groupId, row);
	};
	for (const item of report.byProxy) {
		const proxy = byId.get(item.proxyId);
		const memberOf = groups.filter(group => proxy?.groupIds.includes(group.id));
		if (!memberOf.length) {
			add('', '未分组', '', totalBytes(item));
		}
		memberOf.forEach(group => add(group.id, group.name, group.color, totalBytes(item)));
	}
	return [...rows.values()].sort((a, b) => b.bytes - a.bytes);
}

/** 流量最多的一天;都没流量为 null */
export function busiestDay(report: ProxyUsageReport): (UsageTotals & {day: string}) | null {
	const top = report.byDay.reduce<(UsageTotals & {day: string}) | null>((best, day) => (!best || totalBytes(day) > totalBytes(best) ? day : best), null);
	return top && totalBytes(top) > 0 ? top : null;
}

// ===== 粘贴整串地址 =====

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
