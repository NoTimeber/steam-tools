// Steam 代理设置:全局代理 + 按账号覆盖。代理里有账号密码,整份配置用 vault 加密后存在 settings 表。
// 地址的校验和怎么用在 src/proxy/,这里只管存取;1.6.8–1.6.10 的全局代理存的是一整串地址,读的时候拆成各项。

import {isProxyTemplate, parseProxyUrl} from '../core/proxy.ts';
import type {ProxyProtocol} from '../core/proxy.ts';
import type {Vault} from '../core/vault.ts';
import type {SettingsStore} from './settings.ts';

const SETTING_KEY = 'proxy.config';
const PURPOSE = 'proxy.config';

/** 账号的代理:'global' 用全局的,'direct' 不走代理,其它是这个账号自己的代理地址 */
export type AccountProxy = 'global' | 'direct' | string;

/** 代理类型:静态(一个固定出口 IP)、轮换(一个入口,提供商换出口 IP)、按账号固定 IP(地址里写 {n},每个账号一个编号) */
export type ProxyKind = 'static' | 'rotating' | 'sticky';

export const PROXY_KINDS: readonly ProxyKind[] = ['static', 'rotating', 'sticky'];

/** 全局代理的各项 */
export interface GlobalProxySettings {
	/** 关了就直连,填的内容留着 */
	enabled: boolean;
	protocol: ProxyProtocol;
	/** '' 为没填;可以带 {n} */
	host: string;
	/** 0 为没填 */
	port: number;
	type: ProxyKind;
	/** 解码后的原文,可以带 {n} */
	username: string;
	password: string;
	/** 经这个代理每分钟最多开始几次 Steam 登录,0 不限 */
	loginsPerMinute: number;
}

export interface ProxyConfig {
	global: GlobalProxySettings;
	/** 固定 IP 模式的编号范围(含两端) */
	range: {from: number; to: number};
	/** 账号名小写 → 覆盖设置;没有的账号用全局 */
	accounts: Record<string, AccountProxy>;
	/** 固定 IP 模式下各账号分到的编号(账号名小写;'' 是认不出账号的请求共用的) */
	assigned: Record<string, number>;
}

export interface ProxyStore {
	load(): ProxyConfig;
	save(config: ProxyConfig): void;
}

export function emptyGlobalProxy(): GlobalProxySettings {
	return {enabled: false, protocol: 'http', host: '', port: 0, type: 'rotating', username: '', password: '', loginsPerMinute: 0};
}

/** 存着的全局代理:旧版的整串地址拆成各项(有地址就是开着的;带 {n} 的是按账号固定 IP,其它当轮换);解析不了当没设 */
function globalSettings(raw: unknown): GlobalProxySettings {
	if (typeof raw === 'string') {
		if (!raw) {
			return emptyGlobalProxy();
		}
		try {
			return {...emptyGlobalProxy(), ...parseProxyUrl(raw), enabled: true, type: isProxyTemplate(raw) ? 'sticky' : 'rotating'};
		} catch {
			return emptyGlobalProxy();
		}
	}
	const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<GlobalProxySettings>;
	return {
		enabled: value.enabled === true,
		protocol: value.protocol === 'https' ? 'https' : 'http',
		host: String(value.host || ''),
		port: Number(value.port) || 0,
		type: PROXY_KINDS.includes(value.type as ProxyKind) ? value.type as ProxyKind : 'rotating',
		username: String(value.username || ''),
		password: String(value.password || ''),
		loginsPerMinute: Math.max(0, Math.floor(Number(value.loginsPerMinute) || 0))
	};
}

export function createProxyStore(settings: SettingsStore, vault: Vault): ProxyStore {
	return {
		load() {
			const sealed = settings.get<string>(SETTING_KEY);
			const config = sealed ? vault.decryptJson<Partial<Omit<ProxyConfig, 'global'>> & {global?: unknown}>(sealed, PURPOSE) : {};
			return {
				global: globalSettings(config.global),
				range: {from: Number(config.range?.from) || 1, to: Number(config.range?.to) || 1},
				accounts: {...config.accounts},
				assigned: {...config.assigned}
			};
		},
		save(config) {
			settings.set(SETTING_KEY, vault.encryptJson(config, PURPOSE));
		}
	};
}
