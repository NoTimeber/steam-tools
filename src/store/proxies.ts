// Steam 代理设置:全局代理 + 按账号覆盖。代理地址里有账号密码,整份配置用 vault 加密后存在 settings 表。
// 地址的校验和怎么用在 src/proxy/,这里只管存取。

import type {Vault} from '../core/vault.ts';
import type {SettingsStore} from './settings.ts';

const SETTING_KEY = 'proxy.config';
const PURPOSE = 'proxy.config';

/** 账号的代理:'global' 用全局的,'direct' 不走代理,其它是这个账号自己的代理地址 */
export type AccountProxy = 'global' | 'direct' | string;

export interface ProxyConfig {
	/** 全局代理地址,'' 为不用;带 {n} 时是固定 IP 模式,{n} 换成每个账号分到的编号 */
	global: string;
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

export function createProxyStore(settings: SettingsStore, vault: Vault): ProxyStore {
	return {
		load() {
			const sealed = settings.get<string>(SETTING_KEY);
			const config = sealed ? vault.decryptJson<Partial<ProxyConfig>>(sealed, PURPOSE) : {};
			return {
				global: String(config.global || ''),
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
