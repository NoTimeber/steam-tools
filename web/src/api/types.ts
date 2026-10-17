// 后端接口返回的数据形状(和 src/ 下的服务端代码对应,只列前端用到的字段)。

export type GameId = 'cs2' | 'tf2';

/** 登录会话(src/steam/session-manager.ts 的 publicAttempt) */
export interface PublicAttempt {
	id: string;
	accountName: string;
	status: 'created' | 'connecting' | 'guard_required' | 'logged_on' | 'web_session_pending' | 'web_session' | 'failed' | 'disconnected' | 'logged_out' | string;
	hasMaFile?: boolean;
	steamID?: string;
	country?: string;
	hasWallet?: boolean;
	currency?: number | null;
	currencyISO?: string;
	balance?: number | null;
	hasRefreshToken?: boolean;
	gcConnected?: boolean;
	cs2GcConnected?: boolean;
	tf2GcConnected?: boolean;
	activeGame?: GameId;
	inventoryCount?: number;
	inventorySource?: string;
	guard?: {type: 'email' | 'mobile' | string; domain?: string | null; lastCodeWrong?: boolean} | null;
	logs?: Array<{level: string; time: string; message: string}>;
}

/** 名单里的账号(src/accounts/groups.ts 的 publicAccounts;不含密码) */
export interface StoredAccount {
	id: string;
	accountName: string;
	hasPassword: boolean;
	hasSharedSecret: boolean;
	remember: boolean;
	hasMaFile: boolean;
	steamID: string;
	country: string;
	balance: number | null;
	currency: number | null;
	hasWallet: boolean;
	activeGame: string;
	source: string;
	/** 所在分组的 id,未分组为 '' */
	groupId: string;
}

/** 用户建的账户分组(src/store/account-groups.ts) */
export interface AccountGroup {
	id: string;
	name: string;
}

/** 分组改动后返回的最新分组和名单 */
export interface AccountGroupState {
	groups: AccountGroup[];
	accounts: StoredAccount[];
}

/** 账号资料(maFile、会话缓存;src/accounts/profiles.ts 的 publicAccountProfile) */
export interface AccountProfile {
	accountName: string;
	steamId: string;
	hasMaFile: boolean;
	hasIdentitySecret: boolean;
	country: string;
	hasWallet: boolean;
	currency: number | null;
	currencyISO: string;
	balance: number | null;
}

/** 消费记录(src/accounts/history.ts) */
export type HistoryKind = 'purchase' | 'gift' | 'ingame' | 'market_buy' | 'market_sell' | 'wallet' | 'refund' | 'conversion' | 'other';

export interface HistoryMoney {
	text: string;
	amount: number | null;
	currency: string;
}

export interface HistoryRow {
	date: string;
	dateText: string;
	items: string[];
	typeText: string;
	kind: HistoryKind;
	marketCount: number;
	payment: string[];
	refunded: boolean;
	total: HistoryMoney | null;
	walletChange: HistoryMoney | null;
	walletBalance: HistoryMoney | null;
	transid: string;
}

export interface PublicHistory {
	accountName: string;
	status: 'loading' | 'done' | 'error';
	pages: number;
	count: number;
	truncated: boolean;
	error: string;
	startedAt: string;
	finishedAt: string;
	/** 读取中不带 */
	rows?: HistoryRow[];
}

export type ProxyProtocol = 'http' | 'https';

/** 代理类型:静态(一个固定 IP,账号共用)、轮换(工具台把每个账号固定在池里的一个 IP 上) */
export type ProxyKind = 'static' | 'rotating';

/** 全局代理各项(src/store/proxies.ts);密码不下发,只说有没有 */
export interface GlobalProxySettings {
	enabled: boolean;
	protocol: ProxyProtocol;
	host: string;
	/** 0 为没填 */
	port: number;
	type: ProxyKind;
	username: string;
	hasPassword: boolean;
	/** 轮换池里有几个 IP,0 为没填 */
	poolSize: number;
	/** 每分钟最多经这个代理开始几次 Steam 登录,0 不限 */
	loginsPerMinute: number;
}

/** Steam 代理设置(src/proxy/index.ts;代理密码打码成 ****) */
export interface PublicProxyConfig {
	/** 全局代理现在用的地址,'' 为没设或没启用;轮换代理是带 {n} 的模板 */
	global: string;
	/** 全局代理各项(代理设置页的表单) */
	settings: GlobalProxySettings;
	/** 全局代理是轮换、按账号固定 IP */
	sticky: boolean;
	/** 单独设置过的账号(账号名小写) */
	accounts: Record<string, {mode: 'direct' | 'custom'; url: string}>;
	/** 这次运行里各账号分到的编号(账号名小写;重启后重新分) */
	assigned: Record<string, number>;
}

export type AccountProxyMode = 'global' | 'direct' | 'custom';

export interface ProxyTestResult {
	ip: string;
	ms: number;
	proxy: string;
	/** 经代理打开 Steam 社区:429 是这个 IP 被限流;没打开时 status 为 0 */
	steam: {status: number; ms: number; error: string};
}

/** 当前版本和 GitHub 上的最新 Release(后端 src/core/version-check.ts) */
export interface UpdateStatus {
	current: string;
	/** 服务端关了检查(UPDATE_CHECK=0) */
	disabled: boolean;
	latest?: string;
	hasUpdate: boolean;
	notes?: string;
	url?: string;
	checkedAt?: string;
	/** 最近一次检查失败的原因 */
	error?: string;
}
