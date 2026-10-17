// Steam 代理设置:全局代理 + 按账号覆盖。代理里有账号密码,整份配置用 vault 加密后存在 settings 表。
// 地址的校验和怎么用在 src/proxy/,这里只管存取和旧格式迁移:
//   - 1.6.8–1.6.10 的全局代理存的是一整串地址(带 {n} 的是固定 IP 模式,编号范围在 range),读的时候拆成各项;
//   - 1.6.11 有「按账号固定 IP」类型和编号范围,现在并进「轮换」,IP 数量取编号范围的结束值。
// 轮换代理给各账号分的编号只在内存里(重启后重新分),旧版存下的不再读。

import {isProxyTemplate, parseProxyUrl} from '../core/proxy.ts';
import type {ProxyProtocol} from '../core/proxy.ts';
import type {Vault} from '../core/vault.ts';
import type {SettingsStore} from './settings.ts';

const SETTING_KEY = 'proxy.config';
const PURPOSE = 'proxy.config';

/** 账号的代理:'global' 用全局的,'direct' 不走代理,其它是这个账号自己的代理地址 */
export type AccountProxy = 'global' | 'direct' | string;

/** 代理类型:静态(一个固定出口 IP,所有账号共用)、轮换(提供商换出口 IP,工具台把每个账号固定在其中一个上) */
export type ProxyKind = 'static' | 'rotating';

export const PROXY_KINDS: readonly ProxyKind[] = ['static', 'rotating'];

/** 全局代理的各项 */
export interface GlobalProxySettings {
	/** 关了就直连,填的内容留着 */
	enabled: boolean;
	protocol: ProxyProtocol;
	/** '' 为没填 */
	host: string;
	/** 0 为没填 */
	port: number;
	type: ProxyKind;
	/** 解码后的原文;轮换代理可以带 {n}(编号的位置) */
	username: string;
	password: string;
	/** 轮换代理池里有几个 IP(编号 1 到它);0 为没填 */
	poolSize: number;
	/** 经这个代理每分钟最多开始几次 Steam 登录,0 不限 */
	loginsPerMinute: number;
}

export interface ProxyConfig {
	global: GlobalProxySettings;
	/** 账号名小写 → 覆盖设置;没有的账号用全局 */
	accounts: Record<string, AccountProxy>;
}

export interface ProxyStore {
	load(): ProxyConfig;
	save(config: ProxyConfig): void;
}

export function emptyGlobalProxy(): GlobalProxySettings {
	return {enabled: false, protocol: 'http', host: '', port: 0, type: 'rotating', username: '', password: '', poolSize: 0, loginsPerMinute: 0};
}

/** 旧版的编号范围 → IP 数量(编号从 1 数到范围结束值) */
function poolSizeOf(range: unknown): number {
	return Math.max(0, Math.floor(Number((range as {to?: unknown} | undefined)?.to) || 0));
}

/**
 * 存着的全局代理:旧版的整串地址拆成各项(有地址就是开着的;带 {n} 的是轮换、IP 数量取编号范围,
 * 其它当轮换);1.6.11 的「按账号固定 IP」当轮换。解析不了当没设
 */
function globalSettings(raw: unknown, range: unknown): GlobalProxySettings {
	if (typeof raw === 'string') {
		if (!raw) {
			return emptyGlobalProxy();
		}
		try {
			return {...emptyGlobalProxy(), ...parseProxyUrl(raw), enabled: true, type: 'rotating', poolSize: isProxyTemplate(raw) ? poolSizeOf(range) : 0};
		} catch {
			return emptyGlobalProxy();
		}
	}
	const value = (raw && typeof raw === 'object' ? raw : {}) as Omit<Partial<GlobalProxySettings>, 'type'> & {type?: string};
	return {
		enabled: value.enabled === true,
		protocol: value.protocol === 'https' ? 'https' : 'http',
		host: String(value.host || ''),
		port: Number(value.port) || 0,
		type: value.type === 'static' ? 'static' : 'rotating',
		username: String(value.username || ''),
		password: String(value.password || ''),
		poolSize: value.poolSize !== undefined ? poolSizeOf({to: value.poolSize}) : value.type === 'sticky' ? poolSizeOf(range) : 0,
		loginsPerMinute: Math.max(0, Math.floor(Number(value.loginsPerMinute) || 0))
	};
}

export function createProxyStore(settings: SettingsStore, vault: Vault): ProxyStore {
	return {
		load() {
			const sealed = settings.get<string>(SETTING_KEY);
			const config = sealed ? vault.decryptJson<{global?: unknown; range?: unknown; accounts?: Record<string, AccountProxy>}>(sealed, PURPOSE) : {};
			return {global: globalSettings(config.global, config.range), accounts: {...config.accounts}};
		},
		save(config) {
			settings.set(SETTING_KEY, vault.encryptJson(config, PURPOSE));
		}
	};
}
