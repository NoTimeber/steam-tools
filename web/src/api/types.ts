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

/** 名单里的账号(src/accounts/profiles.ts 的 publicStoredAccount;不含密码) */
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
