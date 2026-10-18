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
	logs?: AttemptLog[];
}

/** 会话日志的一条;at 是记下的时间(毫秒) */
export interface AttemptLog {
	level: string;
	time: string;
	message: string;
	at?: number;
}

/** 账户详情(src/accounts/index.ts 的 AccountDetail;不含任何密钥、cookie、refreshToken 本身) */
export interface AccountDetail {
	accountName: string;
	remember: boolean;
	hasPassword: boolean;
	hasSharedSecret: boolean;
	hasMaFile: boolean;
	hasIdentitySecret: boolean;
	steamID: string;
	personaName: string;
	country: string;
	loginGeoCountry: string;
	hasWallet: boolean;
	currency: number | null;
	currencyISO: string;
	balance: number | null;
	session: {
		attemptId: string;
		status: string;
		hasRefreshToken: boolean;
		refreshTokenExpiresAt: number | null;
		savedAt: string;
		cookieCount: number;
		webSessionAt: number | null;
		nextCookieRefreshAt: number | null;
		publicIP: string;
		machineName: string;
		userAgent: string;
	};
	gc: {cs2: boolean; tf2: boolean; inventoryCount: number};
	logs: AttemptLog[];
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

/** 代理类型:静态(一个固定出口 IP)、轮换(一个入口,提供商换出口 IP) */
export type ProxyKind = 'static' | 'rotating';

/** 代理状态:未测试、检查中、健康、无法访问、Steam 已封禁 */
export type ProxyStatus = 'untested' | 'checking' | 'healthy' | 'unreachable' | 'blocked';

/** 上次检测的结果(src/proxy/check.ts) */
export interface ProxyCheck {
	status: 'healthy' | 'unreachable' | 'blocked';
	latencyMs: number;
	ip: string;
	/** 两位国家代码,查不到为 '' */
	country: string;
	/** 采样到的不同出口 IP */
	ips: string[];
	samples: number;
	/** Steam 社区市场页的 HTTP 状态,0 为打不开;429 是市场、库存请求会被拒 */
	market: number;
	error: string;
	/** 毫秒时间戳 */
	checkedAt: number;
}

/** 代理池里的一个代理(src/proxy/index.ts;密码不下发,只说有没有) */
export interface PublicProxy {
	id: string;
	protocol: ProxyProtocol;
	host: string;
	port: number;
	type: ProxyKind;
	username: string;
	hasPassword: boolean;
	/** 轮换代理池里有几个 IP(按账号固定 IP),0 为没填 */
	poolSize: number;
	/** 每分钟最多经这个代理开始几次 Steam 登录,0 不限 */
	loginsPerMinute: number;
	enabled: boolean;
	notes: string;
	groupIds: string[];
	createdAt: number;
	check: ProxyCheck | null;
	/** 主机:端口 */
	endpoint: string;
	/** 按账号固定 IP */
	sticky: boolean;
	status: ProxyStatus;
}

export interface ProxyGroup {
	id: string;
	name: string;
	color: string;
	createdAt: number;
}

/** 账号的代理:direct 不走代理;bind 只用绑定的代理和代理组;没有的账号用代理池 */
export type AccountBinding = {mode: 'direct'} | {mode: 'bind'; proxyIds: string[]; groupIds: string[]};

export interface ProxySlot {
	proxyId: string;
	/** 按账号固定 IP 的编号,别的为 0 */
	index: number;
}

export interface PublicProxyState {
	proxies: PublicProxy[];
	groups: ProxyGroup[];
	/** 账号名小写 → 绑定 */
	accounts: Record<string, AccountBinding>;
	/** 账户分组 id → 关联的代理组 */
	accountGroups: Record<string, string[]>;
	/** 这次运行里各账号用着哪个代理(账号名小写;'' 是认不出账号的请求;重启后重新分) */
	assigned: Record<string, ProxySlot>;
}

export type UsageKind = 'market' | 'inventory' | 'store' | 'trade' | 'confirm' | 'webapi' | 'login' | 'community' | 'check' | 'other';

export interface UsageTotals {
	requests: number;
	sent: number;
	received: number;
}

/** 代理用量(src/proxy/usage.ts) */
export interface ProxyUsageReport {
	days: number;
	since: string;
	until: string;
	total: UsageTotals;
	byDay: Array<UsageTotals & {day: string}>;
	byProxy: Array<UsageTotals & {proxyId: string}>;
	byAccount: Array<UsageTotals & {account: string}>;
	byKind: Array<UsageTotals & {kind: UsageKind}>;
	lastAt: number;
	latestDay: string;
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

/** 面板「立即更新」的进度(src/core/self-update.ts;更新在宿主机上做) */
export interface SelfUpdateStatus {
	/** 服务器上装了更新器(deploy/install-updater.sh) */
	installed: boolean;
	/** idle 没有更新;pending 请求放了、更新器还没接手;running 更新中;done / failed 上次的结果 */
	state: 'idle' | 'pending' | 'running' | 'done' | 'failed';
	/** git 拉代码、pull 拉镜像、up 重启服务 */
	step: '' | 'git' | 'pull' | 'up';
	message: string;
	/** 失败那一步最后几十行输出 */
	log: string;
	requestedAt: number;
	startedAt: number;
	finishedAt: number;
	updatedAt: number;
	from: string;
	to: string;
	/** 请求很久没人接手,或者「更新中」很久没动静 */
	stale: boolean;
}
