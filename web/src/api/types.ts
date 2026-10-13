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

/** 远程更新状态(旧版启动器写的 update-status.json) */
export interface UpdateStatus {
	pending?: boolean;
	current?: string;
	available?: string;
	notes?: string;
}
