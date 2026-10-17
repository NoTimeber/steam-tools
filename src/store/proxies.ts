// Steam 代理池:代理(可以有很多个)、代理组、账号的绑定、账户分组关联的代理组,以及每个代理上次检测的结果。
// 代理里有账号密码,整份配置用 vault 加密后存在 settings 表。地址的校验和怎么用在 src/proxy/,这里只管存取和旧格式迁移:
//   - 1.6.8–1.6.15 只有一个全局代理(1.6.8–1.6.10 存整串地址、带 {n} 的编号范围在 range;1.6.11 起按各项存)
//     和账号的单独设置('direct' 或整串地址)。读的时候全局代理变成池里第一个代理(关着的照样关着);
//     账号的单独代理各变成一个静态代理并绑定到这个账号(绑定给账号的代理不进公共池,别的账号用不到),
//     direct 照旧不走代理。这样迁过来各账号用的代理和原来一样。迁移后马上按新格式存一次(代理 id 才固定下来)。
// 轮换代理给各账号分的编号只在内存里(重启后重新分),不存。

import {randomUUID} from 'node:crypto';
import {buildProxyUrl, isProxyTemplate, parseProxyUrl} from '../core/proxy.ts';
import type {ProxyProtocol} from '../core/proxy.ts';
import type {Vault} from '../core/vault.ts';
import type {SettingsStore} from './settings.ts';

const SETTING_KEY = 'proxy.config';
const PURPOSE = 'proxy.config';
const VERSION = 2;

/** 代理类型:静态(一个固定出口 IP)、轮换(一个入口,提供商换出口 IP) */
export type ProxyKind = 'static' | 'rotating';

export const PROXY_KINDS: readonly ProxyKind[] = ['static', 'rotating'];

/** 检测结论:健康(连得上、Steam 也打得开)、无法访问(连不上代理)、Steam 已封禁(连得上,Steam 拒绝) */
export type ProxyCheckStatus = 'healthy' | 'unreachable' | 'blocked';

/** 上次检测的结果 */
export interface ProxyCheck {
	status: ProxyCheckStatus;
	/** 第一次查出口 IP 的耗时 */
	latencyMs: number;
	/** 第一次查到的出口 IP;连不上为 '' */
	ip: string;
	/** 出口 IP 所在国家(两位代码),查不到为 '' */
	country: string;
	/** 采样到的不同出口 IP(轮换代理采样几次,看是不是真的在换) */
	ips: string[];
	/** 采样成功了几次 */
	samples: number;
	/** 经这个代理打开 Steam 社区市场页的 HTTP 状态,0 为打不开;429 是工具台的市场、库存请求会被拒 */
	market: number;
	/** 没通过时的原因 */
	error: string;
	/** 毫秒时间戳 */
	checkedAt: number;
}

export interface StoredProxy {
	id: string;
	protocol: ProxyProtocol;
	host: string;
	port: number;
	type: ProxyKind;
	/** 解码后的原文;轮换代理可以带 {n}(编号的位置) */
	username: string;
	password: string;
	/** 轮换代理池里有几个 IP(编号 1 到它,每个账号固定一个);0 为没填(每个新连接由提供商换 IP) */
	poolSize: number;
	/** 经这个代理每分钟最多开始几次 Steam 登录,0 不限 */
	loginsPerMinute: number;
	/** 停用的不给账号用,填的内容留着 */
	enabled: boolean;
	notes: string;
	/** 所在代理组 */
	groupIds: string[];
	/** 毫秒时间戳 */
	createdAt: number;
	/** null 为没测过(改了连接方式也清掉) */
	check: ProxyCheck | null;
}

export interface ProxyGroup {
	id: string;
	name: string;
	/** 页面上的颜色(GROUP_COLORS 里的一个) */
	color: string;
	createdAt: number;
}

/** 代理组能选的颜色(页面按名字配色) */
export const GROUP_COLORS = ['amber', 'blue', 'green', 'red', 'violet', 'cyan', 'pink', 'gray'] as const;

/** 账号的代理:direct 不走代理;bind 只用绑定的代理和代理组里的代理。没有绑定的账号用代理池 */
export type AccountBinding = {mode: 'direct'} | {mode: 'bind'; proxyIds: string[]; groupIds: string[]};

export interface ProxyConfig {
	proxies: StoredProxy[];
	groups: ProxyGroup[];
	/** 账号名小写 → 绑定 */
	accounts: Record<string, AccountBinding>;
	/** 账户分组 id → 关联的代理组(组里每个账号都用这些代理组,和账号自己的绑定合在一起) */
	accountGroups: Record<string, string[]>;
}

export interface ProxyStore {
	load(): ProxyConfig;
	save(config: ProxyConfig): void;
}

export function emptyProxyConfig(): ProxyConfig {
	return {proxies: [], groups: [], accounts: {}, accountGroups: {}};
}

/** 新代理的默认值(id、创建时间现取) */
export function newStoredProxy(fields: Partial<StoredProxy> = {}): StoredProxy {
	return {
		id: randomUUID(), protocol: 'http', host: '', port: 0, type: 'static', username: '', password: '', poolSize: 0, loginsPerMinute: 0,
		enabled: true, notes: '', groupIds: [], createdAt: Date.now(), check: null, ...fields
	};
}

const count = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0));
const strings = (value: unknown) => (Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : []);

function checkOf(raw: unknown): ProxyCheck | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const value = raw as Partial<ProxyCheck>;
	const status = value.status === 'healthy' || value.status === 'unreachable' || value.status === 'blocked' ? value.status : null;
	if (!status) {
		return null;
	}
	return {
		status,
		latencyMs: count(value.latencyMs),
		ip: String(value.ip || ''),
		country: String(value.country || ''),
		ips: strings(value.ips),
		samples: count(value.samples),
		market: count(value.market),
		error: String(value.error || ''),
		checkedAt: count(value.checkedAt)
	};
}

function proxyOf(raw: unknown): StoredProxy | null {
	const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredProxy>;
	if (!value.id || !value.host) {
		return null;
	}
	return {
		id: String(value.id),
		protocol: value.protocol === 'https' ? 'https' : 'http',
		host: String(value.host),
		port: count(value.port),
		type: value.type === 'rotating' ? 'rotating' : 'static',
		username: String(value.username || ''),
		password: String(value.password || ''),
		poolSize: count(value.poolSize),
		loginsPerMinute: count(value.loginsPerMinute),
		enabled: value.enabled !== false,
		notes: String(value.notes || ''),
		groupIds: strings(value.groupIds),
		createdAt: count(value.createdAt),
		check: checkOf(value.check)
	};
}

function bindingOf(raw: unknown): AccountBinding | null {
	const value = (raw && typeof raw === 'object' ? raw : {}) as {mode?: unknown; proxyIds?: unknown; groupIds?: unknown};
	if (value.mode === 'direct') {
		return {mode: 'direct'};
	}
	const binding = {mode: 'bind' as const, proxyIds: strings(value.proxyIds), groupIds: strings(value.groupIds)};
	return binding.proxyIds.length || binding.groupIds.length ? binding : null;
}

/** 新格式:去掉不认识的、指向不存在的代理 / 代理组的引用 */
function currentConfig(raw: Record<string, unknown>): ProxyConfig {
	const proxies = (Array.isArray(raw.proxies) ? raw.proxies : []).map(proxyOf).filter((proxy): proxy is StoredProxy => !!proxy);
	const groups = (Array.isArray(raw.groups) ? raw.groups : [])
		.map(item => item as Partial<ProxyGroup>)
		.filter(group => group && group.id && group.name)
		.map(group => ({id: String(group.id), name: String(group.name), color: String(group.color || GROUP_COLORS[0]), createdAt: count(group.createdAt)}));
	const groupIds = new Set(groups.map(group => group.id));
	const proxyIds = new Set(proxies.map(proxy => proxy.id));
	for (const proxy of proxies) {
		proxy.groupIds = proxy.groupIds.filter(id => groupIds.has(id));
	}
	const accounts: Record<string, AccountBinding> = {};
	for (const [key, value] of Object.entries((raw.accounts ?? {}) as Record<string, unknown>)) {
		const binding = bindingOf(value);
		if (binding?.mode === 'bind') {
			binding.proxyIds = binding.proxyIds.filter(id => proxyIds.has(id));
			binding.groupIds = binding.groupIds.filter(id => groupIds.has(id));
		}
		if (binding && (binding.mode === 'direct' || binding.proxyIds.length || binding.groupIds.length)) {
			accounts[key.toLowerCase()] = binding;
		}
	}
	const accountGroups: Record<string, string[]> = {};
	for (const [id, value] of Object.entries((raw.accountGroups ?? {}) as Record<string, unknown>)) {
		const linked = strings(value).filter(groupId => groupIds.has(groupId));
		if (linked.length) {
			accountGroups[id] = linked;
		}
	}
	return {proxies, groups, accounts, accountGroups};
}

/** 旧版的编号范围 → IP 数量(编号从 1 数到范围结束值) */
function poolSizeOf(range: unknown): number {
	return count((range as {to?: unknown} | undefined)?.to);
}

/**
 * 旧版的全局代理:整串地址拆成各项(有地址就是开着的;带 {n} 的 IP 数量取编号范围),1.6.11 的「按账号固定 IP」当轮换。
 * 带 {n} 却没有 IP 数量的(旧版这时都用编号 1)IP 数量记 1。没设、解析不了的为 null
 */
function legacyGlobal(raw: unknown, range: unknown): StoredProxy | null {
	const proxy = legacyGlobalFields(raw, range);
	if (proxy && proxy.type === 'rotating' && !proxy.poolSize && isProxyTemplate(buildProxyUrl(proxy))) {
		proxy.poolSize = 1;
	}
	return proxy;
}

function legacyGlobalFields(raw: unknown, range: unknown): StoredProxy | null {
	if (typeof raw === 'string') {
		if (!raw) {
			return null;
		}
		try {
			return newStoredProxy({...parseProxyUrl(raw), enabled: true, type: 'rotating', poolSize: isProxyTemplate(raw) ? poolSizeOf(range) : 0, notes: '原来的全局代理'});
		} catch {
			return null;
		}
	}
	const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	if (!value.host) {
		return null;
	}
	return newStoredProxy({
		enabled: value.enabled === true,
		protocol: value.protocol === 'https' ? 'https' : 'http',
		host: String(value.host),
		port: count(value.port),
		type: value.type === 'static' ? 'static' : 'rotating',
		username: String(value.username || ''),
		password: String(value.password || ''),
		poolSize: value.poolSize !== undefined ? count(value.poolSize) : value.type === 'sticky' ? poolSizeOf(range) : 0,
		loginsPerMinute: count(value.loginsPerMinute),
		notes: '原来的全局代理'
	});
}

/** 1.6.8–1.6.15 的格式(全局代理 + 账号覆盖)转成代理池 */
export function migrateLegacyConfig(raw: {global?: unknown; range?: unknown; accounts?: Record<string, unknown>}): ProxyConfig {
	const config = emptyProxyConfig();
	const global = legacyGlobal(raw.global, raw.range);
	if (global) {
		config.proxies.push(global);
	}
	for (const [name, value] of Object.entries(raw.accounts ?? {})) {
		const key = name.toLowerCase();
		if (value === 'direct') {
			config.accounts[key] = {mode: 'direct'};
			continue;
		}
		if (typeof value !== 'string' || !value || value === 'global') {
			continue;
		}
		let parts;
		try {
			parts = parseProxyUrl(value);
		} catch {
			continue;
		}
		// 几个账号原来填的是同一个地址:共用一个代理
		let proxy = config.proxies.find(item => item !== global && item.protocol === parts.protocol && item.host === parts.host
			&& item.port === parts.port && item.username === parts.username && item.password === parts.password);
		if (!proxy) {
			proxy = newStoredProxy({...parts, type: 'static', notes: `原来 ${name} 的单独代理`});
			config.proxies.push(proxy);
		}
		config.accounts[key] = {mode: 'bind', proxyIds: [proxy.id], groupIds: []};
	}
	return config;
}

export function createProxyStore(settings: SettingsStore, vault: Vault): ProxyStore {
	function save(config: ProxyConfig): void {
		settings.set(SETTING_KEY, vault.encryptJson({version: VERSION, ...config}, PURPOSE));
	}
	return {
		load() {
			const sealed = settings.get<string>(SETTING_KEY);
			if (!sealed) {
				return emptyProxyConfig();
			}
			const raw = vault.decryptJson<Record<string, unknown>>(sealed, PURPOSE);
			if (raw.version === VERSION) {
				return currentConfig(raw);
			}
			const migrated = migrateLegacyConfig(raw as Parameters<typeof migrateLegacyConfig>[0]);
			save(migrated);
			return migrated;
		},
		save
	};
}
