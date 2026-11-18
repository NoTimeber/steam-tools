// ECO 扫货服务:填好目标价,持续轮询 ECOSteam 在售最低价,跌到目标价以内自动买,买满数量或用完预算为止。
// PartnerId、RSA 私钥、设置、监控列表、购买流水都在数据库(src/store/eco.ts,私钥加密),在网页上改,不用重启。
//
// 运行状态两档:停止 / 自动扫货(真实下单,没有模拟);记在数据库里,服务重启后恢复。
// 每轮、手动对账、手工标记都排进同一个串行队列,互相不会交叉。路由在 ./routes.ts。
//
// ECO 接口按 Steam 英文名(HashName)查,监控列表、流水按英文名存;页面和日志上的中文名先查 src/items/names.ts 的词库,
// 词库里没有的用 ECO 行情里的 GoodsName。

import type {NameDb} from '../items/names.ts';
import {accountIdOf, isTradeUrlOf, steamIdFromTradeUrl} from '../steam/trade-url.ts';
import type {EcoPurchase, EcoPurchaseStatus, EcoStore, EcoWatchItem} from '../store/eco.ts';
import {purchaseCost} from '../store/eco.ts';
import {createEcoClient, EcoError, EcoNetworkError, generateEcoKeyPair, GUARD_CONTENT_MAX, parsePrivateKey, publicKeyOf} from './client.ts';
import type {EcoApi, EcoItemStat, EcoSteamAccount} from './client.ts';
import {buildItems, describeChange, ecoError, loadSettingsOrDefault, normalizeSettings, RUN_STATES, sweepBlocker} from './config.ts';
import type {EcoRunState, EcoSettings} from './config.ts';
import {createSweeper, EPS, lowestPrice, parseListing, toNumber} from './sweeper.ts';
import type {EcoLogLevel, Listing} from './sweeper.ts';

export {ecoError};
export type {EcoRunState, EcoSettings};

const RECENT_PURCHASES = 50;
const BALANCE_REFRESH_MS = 60_000;
/** 搜索饰品时查的 ECO 价格多久内不重查 */
const PRICE_TTL_MS = 30_000;
/** ECO 上绑定的 Steam 账号多久重查一次(选收货账号时) */
const BOUND_REFRESH_MS = 5 * 60_000;
const ACCOUNT_STATUS: Record<number, string> = {1: '正常', 2: '异常', 3: '暂挂'};

export interface EcoLogLine {
	time: number;
	level: EcoLogLevel;
	message: string;
}

/** 监控列表里一项的状态:已买满 / 被拒后冷却中 / 查不到行情 / 已到价 / 监控中 */
export type EcoItemStatus = 'done' | 'cooldown' | 'noquote' | 'hit' | 'watch';

export interface EcoItemView extends EcoWatchItem {
	/** 中文名;词库和 ECO 行情里都没有为 null */
	zh: string | null;
	status: EcoItemStatus;
	pauseUntil: number | null;
	lowest: number | null;
	sellCount: number | null;
	purchaseMax: number | null;
	bought: number;
	spent: number;
}

export interface EcoPurchaseView extends EcoPurchase {
	zh: string | null;
	cost: number;
}

/** 添加饰品的搜索结果;zh 为 null 是词库里没有、按输入的英文名原样用。lowest / sellCount 是 ECO 在售最低价和在售数 */
export interface EcoNameOption {
	name: string;
	zh: string | null;
	lowest: number | null;
	sellCount: number | null;
}

export interface EcoNameSearch {
	options: EcoNameOption[];
	/** 查到了 ECO 价格(没配好密钥或查价失败时为 false) */
	priced: boolean;
	priceError: string | null;
}

/** ECO 账户上绑定的 Steam 账号 */
export interface EcoBoundAccount {
	steamId: string;
	nickname: string;
	/** ECO 上登记的交易链接;没有为 '' */
	tradeUrl: string;
	/** ECO 说交易链接有效 */
	tradeUrlOk: boolean;
	status: string;
	/** ECO 上的默认账号 */
	isDefault: boolean;
	remark: string;
}

/** 用验证交易链接接口查的结果 */
export interface EcoLinkCheck {
	/** 平台说有效 / 无效;查失败为 null */
	valid: boolean | null;
	error: string | null;
	at: number;
}

/** 收货账号下拉的一项:ECO 上绑定的 Steam 账号,标上账户管理里对应的账号名 */
export interface EcoReceiverAccount extends EcoBoundAccount {
	/** 账户管理里对应的账号名;不在账户管理里为 null */
	account: string | null;
	/** 上次验证交易链接的结果(这个链接验过才有);没验过为 null */
	linkCheck: EcoLinkCheck | null;
	/** 工具里有这个账号的登录会话(refreshToken),能让 ECO 重新取交易链接 */
	canUpdate: boolean;
}

/** 账户管理里的一个账号(src/steam/attempts.ts 的 AccountRef) */
export interface EcoLocalAccount {
	account: string;
	/** 不知道时为 '' */
	steamId: string;
	personaName: string;
}

/** 收货账号:从交易链接里的 partner 算出 SteamID,再对上本工具的账号和 ECO 上绑定的账号 */
export interface EcoReceiver {
	steamId: string;
	/** 本工具里对应的账号名 / 昵称;不是本工具管理的账号为 null */
	account: string | null;
	personaName: string | null;
	/** ECO 上绑定的同一个账号;ecoChecked 为 false 时是还没查过 ECO */
	eco: EcoBoundAccount | null;
	ecoChecked: boolean;
}

export interface EcoState {
	/** PartnerId 和私钥都填了、私钥能用 */
	configured: boolean;
	partnerId: string;
	/** 私钥对应的公钥(去掉头尾和换行),要填到 ECO 开放平台;没填私钥为 '' */
	publicKey: string;
	/** 存的私钥解析不了时的原因 */
	keyError: string | null;
	settings: EcoSettings;
	/** 数据库里的设置坏了、已退回默认值时的原因 */
	settingsError: string | null;
	run: EcoRunState;
	cycle: {n: number; at: number | null; error: string | null; errors: number; done: boolean};
	budget: {total: number; spent: number; qty: number};
	balance: {value: number; at: number} | null;
	/** 收货账号;没填交易链接为 null */
	receiver: EcoReceiver | null;
	items: EcoItemView[];
	purchases: EcoPurchaseView[];
	/** 结果未知、按已花费占着额度的单 */
	unknown: number;
}

export interface EcoCheckResult {
	balance: {money: number | null; locked: number | null; waitSettlement: number | null};
	steamAccounts: EcoBoundAccount[];
}

/** 账户管理里的一个账号,导入令牌绑定 ECO 用(不含密码和 maFile 原文) */
export interface EcoGuardSource {
	account: string;
	/** 登录后记下的 SteamID64(精确);不知道为 '' */
	steamId: string;
	/** 工具里的账户分组名;未分组为 '' */
	group: string;
	hasMaFile: boolean;
	hasPassword: boolean;
}

/** 绑定窗口里的一行 */
export interface EcoBindCandidate extends EcoGuardSource {
	/** 有 maFile、有密码、maFile 里有 shared_secret,能导入 */
	ready: boolean;
	/** 不能导入的原因 */
	reason: string | null;
	/** ECO 上已绑定的同一个账号;没绑为 null */
	bound: EcoBoundAccount | null;
}

/** ECO 分组怎么填:不填 / 统一填 groupName / 用工具里的账户分组名 */
export type EcoBindGroupMode = 'none' | 'fixed' | 'tool';

export interface EcoBindResult {
	account: string;
	/** ok 成功;failed 平台拒绝或本地检查没过;unknown 超时等结果未知(刷新绑定列表看) */
	status: 'ok' | 'failed' | 'unknown';
	message: string;
}

export interface EcoServiceOptions {
	store: EcoStore;
	/** socket.io 推送:eco:log(写进页面右下角的「实时运行日志」) */
	emit(event: 'eco:log', payload: EcoLogLine): void;
	/** 饰品中英文名词库;不给就只显示英文名 */
	names?: NameDb;
	/** 账户管理里的全部账号(按 SteamID 认交易链接是谁的) */
	localAccounts?: () => EcoLocalAccount[];
	/** 能导入令牌绑定 ECO 的账号(账户管理里的全部账号) */
	guardSources?: () => EcoGuardSource[];
	/** 某个账号的登录凭据(更新交易链接用);没登录过返回 null */
	steamTokens?: (account: string) => {refreshToken: string; accessToken?: string} | null;
	/** 某个账号的 maFile 和密码(只在导入时取,用完不留) */
	guardCredentials?: (account: string) => {maFile: Record<string, unknown> | null; password: string} | null;
	/** 默认是 ./client.ts 的真实客户端;单元测试用假的 */
	createClient?: (options: {partnerId: string; privateKey: string; timeoutMs: number}) => EcoApi;
	now?: () => number;
	/** 轮询定时器;单元测试换成手动触发的。回调返回这一轮的 Promise */
	timers?: {set(fn: () => Promise<void>, ms: number): unknown; clear(handle: unknown): void};
	logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

const realTimers = {
	set(fn: () => Promise<void>, ms: number): unknown {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle;
	},
	clear(handle: unknown): void {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	}
};

/** 平台报的错(包括连不上)回 502,文字照实给;其它错误原样抛 */
function upstream(err: unknown): never {
	if (err instanceof EcoError) {
		throw ecoError(502, err.message);
	}
	throw err;
}

/** 私钥 → {公钥, 错误};没填返回空 */
function inspectKey(privateKey: string): {publicKey: string; error: string | null} {
	if (!privateKey) {
		return {publicKey: '', error: null};
	}
	try {
		return {publicKey: publicKeyOf(parsePrivateKey(privateKey)), error: null};
	} catch (err) {
		return {publicKey: '', error: (err as Error).message};
	}
}

export function createEcoService(options: EcoServiceOptions) {
	const {store} = options;
	const now = options.now ?? Date.now;
	const logger = options.logger ?? console;
	const timers = options.timers ?? realTimers;
	const makeClient = options.createClient ?? (({partnerId, privateKey, timeoutMs}) => createEcoClient({partnerId, privateKey, timeoutMs}));

	let partnerId = store.getPartnerId();
	let privateKey = store.getPrivateKey();
	let key = inspectKey(privateKey);
	const loaded = loadSettingsOrDefault(store.loadSettings());
	let settings = loaded.settings;
	const settingsError = loaded.error;
	let items: EcoWatchItem[] = store.listItems();
	const savedRun = store.loadRunState();
	let run: EcoRunState = RUN_STATES.includes(savedRun as EcoRunState) ? savedRun as EcoRunState : 'stopped';
	let cycle: EcoState['cycle'] = {n: 0, at: null, error: null, errors: 0, done: false};
	let balance: EcoState['balance'] = null;
	let client: EcoApi | null = null;
	/** ECO 上绑定的 Steam 账号(检查连接、选收货账号时查;换 PartnerId / 私钥时清掉) */
	let boundAccounts: {list: EcoBoundAccount[]; at: number} | null = null;
	const priceCache = new Map<string, {stat: EcoItemStat; at: number}>();

	const configured = () => !!partnerId && !!privateKey && !key.error;

	/** 中文名:词库优先,其次 ECO 行情里的商品名 */
	function zhOf(name: string): string | null {
		const fromDb = options.names?.zh(name);
		if (fromDb) {
			return fromDb;
		}
		const goodsName = sweeper.view().stats[name]?.GoodsName ?? priceCache.get(name)?.stat.GoodsName;
		return goodsName && goodsName !== name ? String(goodsName) : null;
	}
	/** 日志里的饰品名:有中文用中文 */
	const label = (name: string) => zhOf(name) ?? name;

	// ===== 日志 =====

	/** 写服务端日志并推到页面右下角的「实时运行日志」;debug(每个饰品的行情变化)不记,监控列表里有实时价格 */
	function log(level: EcoLogLevel, message: string): void {
		if (level === 'debug') {
			return;
		}
		const line: EcoLogLine = {time: now(), level, message};
		const text = `[eco] ${message}`;
		if (level === 'error') {
			logger.error(text);
		} else if (level === 'warn') {
			logger.warn(text);
		} else {
			logger.log(text);
		}
		options.emit('eco:log', line);
	}

	function currentClient(): EcoApi {
		client ??= makeClient({partnerId, privateKey, timeoutMs: settings.timeoutSec * 1000});
		return client;
	}

	const sweeper = createSweeper({
		store,
		client: currentClient,
		settings: () => settings,
		items: () => items,
		canBuy: () => run === 'sweeping',
		log,
		label,
		now
	});

	// ===== 串行队列:每轮、手动对账、手工标记不交叉 =====

	let tail: Promise<unknown> = Promise.resolve();
	function serial<T>(fn: () => Promise<T> | T): Promise<T> {
		const next = tail.then(() => fn());
		tail = next.catch(() => {});
		return next;
	}

	// ===== 轮询 =====

	let timer: unknown = null;
	let cycling = false;
	let shutDown = false;
	let doneLogged = false;

	const active = () => !shutDown && run !== 'stopped' && configured();

	function cancelTimer(): void {
		if (timer != null) {
			timers.clear(timer);
			timer = null;
		}
	}

	function schedule(delayMs: number): void {
		cancelTimer();
		timer = timers.set(() => {
			timer = null;
			return tick();
		}, Math.max(0, delayMs));
	}

	/** 马上跑一轮(正在跑的话,跑完按新状态排下一轮) */
	function kick(): void {
		if (active() && !cycling) {
			schedule(0);
		}
	}

	async function tick(): Promise<void> {
		if (!active() || cycling) {
			return;
		}
		cycling = true;
		const started = now();
		try {
			await serial(cycleOnce);
		} finally {
			cycling = false;
		}
		if (active()) {
			// 连续失败时退避,最多 20 倍间隔
			schedule(settings.pollIntervalSec * 1000 * Math.min(2 ** cycle.errors, 20) - (now() - started));
		}
	}

	async function cycleOnce(): Promise<void> {
		const lastPurchase = () => store.recentPurchases(1)[0]?.merchantNo;
		const lastBefore = lastPurchase();
		try {
			const more = await sweeper.runCycle();
			cycle = {n: cycle.n + 1, at: now(), error: null, errors: 0, done: !more || sweeper.view().done};
			if (more) {
				doneLogged = false;
			} else if (!doneLogged) {
				log('info', items.length ? '所有目标已买满或预算用完;改价、加饰品或调预算后自动继续' : '没有要监控的饰品,在监控列表里添加');
				doneLogged = true;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			cycle = {...cycle, n: cycle.n + 1, at: now(), error: message, errors: cycle.errors + 1};
			if (err instanceof EcoError) {
				log('warn', `本轮失败(连续第 ${cycle.errors} 次): ${message}`);
			} else {
				logger.error('[eco] 本轮出错:', err);
				log('error', `本轮出错(连续第 ${cycle.errors} 次): ${message}`);
			}
		}
		// 每分钟查一次余额;这一轮下过单就马上查
		if (now() - (balance?.at ?? 0) >= BALANCE_REFRESH_MS || lastPurchase() !== lastBefore) {
			await refreshBalance().catch(err => log('warn', `查余额失败: ${(err as Error).message}`));
		}
	}

	async function refreshBalance(): Promise<number | null> {
		const value = toNumber((await currentClient().balance()).Money);
		if (value != null) {
			balance = {value, at: now()};
		}
		return value;
	}

	// ===== 收货账号 =====

	function toBound(account: EcoSteamAccount): EcoBoundAccount {
		return {
			steamId: String(account.SteamId ?? ''),
			nickname: String(account.NickName ?? ''),
			tradeUrl: String(account.TradeLink ?? ''),
			tradeUrlOk: account.TradeLinkIsEnable !== false,
			status: ACCOUNT_STATUS[Number(account.AccountStatus)] ?? String(account.AccountStatus ?? ''),
			isDefault: account.IsDefaultSteam === true,
			remark: String(account.Remark ?? '')
		};
	}

	/** 账户管理里和这个 SteamID 是同一个账号的 */
	function localOf(steamId: string): EcoLocalAccount | null {
		const id = accountIdOf(steamId);
		return options.localAccounts?.().find(account => id != null && accountIdOf(account.steamId) === id) ?? null;
	}

	async function loadBoundAccounts(): Promise<EcoBoundAccount[]> {
		const list = (await currentClient().steamAccounts()).map(toBound);
		boundAccounts = {list, at: now()};
		return list;
	}

	function receiverOf(tradeUrl: string): EcoReceiver | null {
		const steamId = steamIdFromTradeUrl(tradeUrl);
		if (!steamId) {
			return null;
		}
		const local = options.localAccounts?.().find(account => isTradeUrlOf(tradeUrl, account.steamId)) ?? null;
		const eco = boundAccounts?.list.find(account => isTradeUrlOf(tradeUrl, account.steamId)) ?? null;
		return {
			steamId: local?.steamId || eco?.steamId || steamId,
			account: local?.account ?? null,
			personaName: local?.personaName || null,
			eco,
			ecoChecked: !!boundAccounts
		};
	}

	/** 日志里的收货账号:昵称 SteamID */
	function receiverText(receiver: EcoReceiver | null): string {
		if (!receiver) {
			return '未设置';
		}
		const name = receiver.eco?.nickname
			|| (receiver.account ? `${receiver.account}${receiver.personaName ? `(${receiver.personaName})` : ''}` : '');
		return `${name ? name + ' ' : ''}SteamID ${receiver.steamId}`;
	}

	// ===== 状态 =====

	function state(): EcoState {
		const view = sweeper.view();
		const totals = store.totals();
		const at = now();
		const itemViews = items.map((item): EcoItemView => {
			const stat = view.stats[item.name] ?? {};
			const lowest = lowestPrice(stat);
			const total = totals.get(item.name) ?? {qty: 0, spent: 0};
			const pauseUntil = view.pauseUntil[item.name] ?? null;
			let status: EcoItemStatus;
			if (total.qty >= item.maxQty || (item.maxSpend > 0 && total.spent >= item.maxSpend - EPS)) {
				status = 'done';
			} else if (pauseUntil != null && pauseUntil > at) {
				status = 'cooldown';
			} else if (lowest == null) {
				status = 'noquote';
			} else if (lowest <= item.maxPrice + EPS) {
				status = 'hit';
			} else {
				status = 'watch';
			}
			return {
				...item, zh: zhOf(item.name), status, pauseUntil, lowest,
				sellCount: toNumber(stat.SellCount), purchaseMax: toNumber(stat.QGMaxPrice),
				bought: total.qty, spent: total.spent
			};
		});
		return {
			configured: configured(),
			partnerId,
			publicKey: key.publicKey,
			keyError: key.error,
			settings: {...settings},
			settingsError,
			run,
			cycle: {...cycle},
			budget: {
				total: settings.maxTotalSpend,
				spent: [...totals.values()].reduce((sum, total) => sum + total.spent, 0),
				qty: [...totals.values()].reduce((sum, total) => sum + total.qty, 0)
			},
			balance: balance ? {...balance} : null,
			receiver: receiverOf(settings.tradeUrl),
			items: itemViews,
			purchases: store.recentPurchases(RECENT_PURCHASES)
				.map(purchase => ({...purchase, zh: zhOf(purchase.name), cost: purchaseCost(purchase)})),
			unknown: store.selectPurchases(['unknown']).length
		};
	}

	// ===== 操作 =====

	function requireConfigured(): void {
		if (!partnerId || !privateKey) {
			throw ecoError(409, '还没填 ECO 的 PartnerId 和私钥,先在「设置」里填');
		}
		if (key.error) {
			throw ecoError(409, `存的私钥用不了:${key.error}`);
		}
	}

	/** 换了 PartnerId / 私钥:客户端、绑定账号、价格都要重来 */
	function credentialsChanged(): void {
		client = null;
		boundAccounts = null;
		priceCache.clear();
	}

	/**
	 * 保存设置。partnerId / privateKey 非空时替换;clearCredentials 删除两者(同时停止)。
	 * 正在扫货时交易链接和总预算不能清空、私钥不能换
	 */
	function saveSettings(body: unknown): EcoState {
		const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
		const {partnerId: newPartnerId, privateKey: newKey, clearCredentials, ...rest} = input;
		const next = normalizeSettings(rest, settings);
		const partnerText = typeof newPartnerId === 'string' ? newPartnerId.trim() : '';
		const keyText = typeof newKey === 'string' ? newKey.trim() : '';
		if (partnerText && /\s/.test(partnerText)) {
			throw ecoError(400, 'PartnerId 里不能有空白字符');
		}
		if ((partnerText || keyText) && clearCredentials === true) {
			throw ecoError(400, '不能同时填新密钥又删除密钥,二选一');
		}
		if (keyText) {
			try {
				parsePrivateKey(keyText);
			} catch (err) {
				throw ecoError(400, (err as Error).message);
			}
		}
		if (run === 'sweeping' && keyText && keyText !== privateKey) {
			throw ecoError(409, '正在自动扫货,不能换私钥;先停止');
		}
		const blocker = run === 'sweeping' && clearCredentials !== true ? sweepBlocker(next) : null;
		if (blocker) {
			throw ecoError(400, `正在自动扫货,${blocker};要清空先停止`);
		}
		store.saveSettings(next);
		const changes: string[] = [];
		if (partnerText && partnerText !== partnerId) {
			store.setPartnerId(partnerText);
			partnerId = partnerText;
			changes.push('PartnerId 已更新');
		}
		if (keyText && keyText !== privateKey) {
			store.setPrivateKey(keyText);
			privateKey = keyText;
			key = inspectKey(privateKey);
			changes.push('私钥已更新(公钥要同步填到 ECO 开放平台)');
		}
		if (clearCredentials === true && (partnerId || privateKey)) {
			store.setPartnerId('');
			store.setPrivateKey('');
			partnerId = '';
			privateKey = '';
			key = inspectKey('');
			changes.push('PartnerId 和私钥已删除');
		}
		if (changes.length) {
			credentialsChanged();
		}
		if (next.tradeUrl !== settings.tradeUrl) {
			changes.push(`收货账号改为 ${receiverText(receiverOf(next.tradeUrl))}`);
		}
		if (next.timeoutSec !== settings.timeoutSec) {
			client = null;
		}
		settings = next;
		log('info', `设置已保存:${next.strategy === 'quick' ? '快速购买' : '按在售列表'},`
			+ `总预算 ${next.maxTotalSpend || '未设'},轮询 ${next.pollIntervalSec} 秒${changes.length ? ';' + changes.join(',') : ''}`);
		if (!configured() && run !== 'stopped') {
			setRunState('stopped', '没有可用的 PartnerId / 私钥');
		}
		kick();
		return state();
	}

	/** 生成一对新的 RSA 密钥:私钥存库(加密),返回公钥给人填到 ECO 开放平台 */
	function generateKeyPair(): EcoState {
		if (run === 'sweeping') {
			throw ecoError(409, '正在自动扫货,不能换私钥;先停止');
		}
		const pair = generateEcoKeyPair();
		store.setPrivateKey(pair.privateKey);
		privateKey = pair.privateKey;
		key = inspectKey(privateKey);
		credentialsChanged();
		log('warn', '已生成新的 RSA 密钥对;把公钥填到 ECO 开放平台后才能调用接口(旧公钥会失效)');
		return state();
	}

	function setRunState(next: EcoRunState, reason = ''): void {
		run = next;
		store.saveRunState(next);
		log(next === 'sweeping' ? 'warn' : 'info', `运行状态:${next === 'sweeping' ? '自动扫货(真实下单)' : '停止'}${reason ? ',' + reason : ''}`);
		if (next === 'stopped') {
			cancelTimer();
		}
	}

	function setRun(value: unknown): EcoState {
		const next = String(value ?? '') as EcoRunState;
		if (!RUN_STATES.includes(next)) {
			throw ecoError(400, `运行状态只能是 ${RUN_STATES.join(' / ')}`);
		}
		if (next === 'sweeping') {
			requireConfigured();
			const blocker = sweepBlocker(settings);
			if (blocker) {
				throw ecoError(400, `不能开始自动扫货:${blocker}`);
			}
		}
		if (next !== run) {
			setRunState(next, next === 'sweeping' ? `收货账号 ${receiverText(receiverOf(settings.tradeUrl))}` : '');
		}
		kick();
		return state();
	}

	/** 网页提交整张表:校验、存库、下一轮按新列表扫。不合法报 400,原来的不动 */
	function saveWatchlist(raws: unknown): EcoState {
		const next = buildItems(raws);
		for (const item of next) {
			// 填了中文名:ECO 按英文 HashName 查,提前拦下(有的英文名里本身带汉字,所以按词库判断)
			const name = options.names?.zh(item.name) == null ? options.names?.nameOf(item.name) : null;
			if (name) {
				throw ecoError(400, `「${item.name}」是中文名,ECO 接口按英文名查,应填 ${name}`);
			}
		}
		const before = items;
		store.replaceItems(next);
		items = next;
		log('info', `监控列表已保存,${next.length} 个饰品${describeChange(before, next, label)}`);
		kick();
		return state();
	}

	/**
	 * 添加饰品时搜名字(中文或英文)。输的像英文全名又不在词库里(新出的饰品),附一个按原文用的选项。
	 * 配好密钥时顺带查这批饰品的 ECO 在售最低价(一个请求,30 秒内查过的不重查);查价失败不影响搜索结果
	 */
	async function searchNames(query: unknown, gameIdRaw?: unknown): Promise<EcoNameSearch> {
		const text = String(query ?? '').trim().slice(0, 100);
		const gameId = Number(gameIdRaw) || 730;
		const found: EcoNameOption[] = text ? (options.names?.search(text, 30) ?? []).map(match => ({...match, lowest: null, sellCount: null})) : [];
		if (text && !/[㐀-鿿]/.test(text) && text.length >= 3 && !found.some(option => option.name === text)) {
			found.push({name: text, zh: null, lowest: null, sellCount: null});
		}
		if (!found.length || !configured()) {
			return {options: found, priced: false, priceError: null};
		}
		const at = now();
		const fresh = (name: string) => at - (priceCache.get(name)?.at ?? -Infinity) < PRICE_TTL_MS;
		const stale = found.map(option => option.name).filter(name => !fresh(name));
		let priceError: string | null = null;
		if (stale.length) {
			try {
				const stats = await currentClient().itemStats(gameId, stale);
				for (const name of priceCache.keys()) {
					if (!fresh(name)) {
						priceCache.delete(name);
					}
				}
				for (const name of stale) {
					priceCache.set(name, {stat: stats[name] ?? {}, at});
				}
			} catch (err) {
				if (!(err instanceof EcoError)) {
					throw err;
				}
				priceError = err.message;
			}
		}
		for (const option of found) {
			const stat = priceCache.get(option.name)?.stat;
			if (stat) {
				option.lowest = lowestPrice(stat);
				option.sellCount = toNumber(stat.SellCount);
				option.zh ??= stat.GoodsName && stat.GoodsName !== option.name ? String(stat.GoodsName) : null;
			}
		}
		return {options: found, priced: !priceError, priceError};
	}

	/** 收货账号下拉:ECO 上绑定的 Steam 账号(带交易链接;5 分钟内不重查,refresh 强制重查) */
	async function receivers(refresh = false): Promise<{accounts: EcoReceiverAccount[]; checked: boolean; boundError: string | null}> {
		let boundError: string | null = configured() ? null : '还没配好 ECO 的 PartnerId 和私钥';
		if (configured() && (refresh || !boundAccounts || now() - boundAccounts.at >= BOUND_REFRESH_MS)) {
			try {
				await loadBoundAccounts();
			} catch (err) {
				if (!(err instanceof EcoError)) {
					throw err;
				}
				boundError = err.message;
			}
		}
		return {
			accounts: (boundAccounts?.list ?? []).map(receiverAccount),
			checked: !!boundAccounts,
			boundError
		};
	}

	/** 连通性:密钥、余额、ECO 上绑定的 Steam 收货账号 */
	async function check(): Promise<EcoCheckResult> {
		requireConfigured();
		const api = currentClient();
		try {
			const wallet = await api.balance();
			const result: EcoCheckResult = {
				balance: {money: toNumber(wallet.Money), locked: toNumber(wallet.LockMoney), waitSettlement: toNumber(wallet.WaitSettlementMoney)},
				steamAccounts: await loadBoundAccounts()
			};
			if (result.balance.money != null) {
				balance = {value: result.balance.money, at: now()};
			}
			log('info', `检查连接:密钥有效,可用余额 ${result.balance.money ?? '-'},绑定 Steam 账号 ${result.steamAccounts.length} 个`);
			return result;
		} catch (err) {
			if (err instanceof EcoError) {
				log('warn', `检查连接失败: ${err.message}`);
			}
			return upstream(err);
		}
	}

	/** 某个饰品目标价以内的在售 */
	async function listings(name: unknown): Promise<{name: string; maxPrice: number; listings: Listing[]}> {
		requireConfigured();
		const item = items.find(entry => entry.name === String(name ?? '').trim());
		if (!item) {
			throw ecoError(404, '监控列表里没有这个饰品(新加的要先保存)');
		}
		try {
			const raw = await currentClient().sellGoods({gameId: item.gameId, name: item.name});
			const found = raw.map(parseListing)
				.filter((listing): listing is Listing => !!listing && listing.price <= item.maxPrice + EPS)
				.sort((a, b) => a.price - b.price);
			return {name: item.name, maxPrice: item.maxPrice, listings: found};
		} catch (err) {
			return upstream(err);
		}
	}

	/** 立刻向平台对一遍全部未完结订单 */
	async function refreshOrders(): Promise<{checked: number; state: EcoState}> {
		requireConfigured();
		const checked = await serial(() => sweeper.refreshOrders(null, {force: true}));
		log('info', `已向平台同步 ${checked} 笔未完结订单`);
		return {checked, state: state()};
	}

	/** 手工标记一笔单(去官网核对过结果未知的单后用) */
	async function resolvePurchase(merchantNo: unknown, status: unknown): Promise<EcoState> {
		const no = String(merchantNo ?? '').trim();
		if (status !== 'ok' && status !== 'failed') {
			throw ecoError(400, '只能标记为 ok(已成交)或 failed(未成交)');
		}
		await serial(() => {
			const purchase = store.getPurchase(no);
			if (!purchase) {
				throw ecoError(404, `没有单号 ${no}`);
			}
			store.updatePurchase(no, {status: status as EcoPurchaseStatus, error: '手工标记'});
			log('info', `手工标记:${label(purchase.name)} 单号 ${no} ${purchase.status} → ${status}`);
		});
		return state();
	}

	// ===== 验证 / 更新交易链接 =====

	/** 交易链接 → 上次验证结果 */
	const linkChecks = new Map<string, EcoLinkCheck>();

	function receiverAccount(account: EcoBoundAccount): EcoReceiverAccount {
		const local = localOf(account.steamId)?.account ?? null;
		return {
			...account,
			account: local,
			linkCheck: account.tradeUrl ? linkChecks.get(account.tradeUrl) ?? null : null,
			canUpdate: !!local && !!options.steamTokens?.(local)?.refreshToken
		};
	}

	/** 逐个验证 ECO 上绑定账号的交易链接;steamIds 为空时验全部。返回刷新后的收货账号列表 */
	async function verifyTradeLinks(steamIdsRaw: unknown): Promise<{accounts: EcoReceiverAccount[]; checked: boolean; boundError: string | null}> {
		requireConfigured();
		const wanted = Array.isArray(steamIdsRaw) ? new Set(steamIdsRaw.map(id => String(id))) : null;
		let list: EcoBoundAccount[];
		try {
			list = await loadBoundAccounts();
		} catch (err) {
			return upstream(err);
		}
		for (const account of list.filter(entry => entry.tradeUrl && (!wanted?.size || wanted.has(entry.steamId)))) {
			try {
				const valid = await currentClient().checkTradeLink(account.tradeUrl);
				linkChecks.set(account.tradeUrl, {valid, error: null, at: now()});
				log(valid ? 'info' : 'warn', `验证交易链接:${account.nickname || account.steamId} ${valid ? '有效' : '无效'}(ECO 列表里标的是${account.tradeUrlOk ? '有效' : '无效'})`);
			} catch (err) {
				if (!(err instanceof EcoError)) {
					throw err;
				}
				linkChecks.set(account.tradeUrl, {valid: null, error: err.message, at: now()});
				log('warn', `验证交易链接失败:${account.nickname || account.steamId}: ${err.message}`);
			}
		}
		return {accounts: list.map(receiverAccount), checked: true, boundError: null};
	}

	/**
	 * 让 ECO 用这个账号的 refreshToken 重新取交易链接(用户Steam绑定或更新)。只能更新工具里登录过的账号。
	 * 如果它就是当前收货账号、链接变了,设置里的交易链接跟着换成新的
	 */
	async function updateTradeLink(steamIdRaw: unknown): Promise<{tradeUrl: string; valid: boolean | null; accounts: EcoReceiverAccount[]; state: EcoState}> {
		requireConfigured();
		const steamId = String(steamIdRaw ?? '').trim();
		if (accountIdOf(steamId) == null) {
			throw ecoError(400, 'SteamID 不对');
		}
		const local = localOf(steamId);
		if (!local) {
			throw ecoError(409, '账户管理里没有这个账号,工具没有它的登录凭据;去 ECO 官网更新,或先把账号加进账户管理并登录');
		}
		const tokens = options.steamTokens?.(local.account) ?? null;
		if (!tokens?.refreshToken) {
			throw ecoError(409, `${local.account} 在工具里没有有效的 refreshToken(没登录过,或存的已过期);在账户管理里用账密重新登录一次再更新`);
		}
		let result: Awaited<ReturnType<EcoApi['updateSteam']>>;
		try {
			result = await currentClient().updateSteam({steamId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken});
		} catch (err) {
			if (err instanceof EcoError) {
				log('warn', `更新交易链接失败:${local.account}: ${err.message}`);
			}
			return upstream(err);
		}
		const tradeUrl = String(result.TradeLink ?? '');
		let valid: boolean | null = null;
		if (tradeUrl) {
			try {
				valid = await currentClient().checkTradeLink(tradeUrl);
				linkChecks.set(tradeUrl, {valid, error: null, at: now()});
			} catch (err) {
				if (!(err instanceof EcoError)) {
					throw err;
				}
				linkChecks.set(tradeUrl, {valid: null, error: err.message, at: now()});
			}
		}
		log(valid === false ? 'warn' : 'success', `已让 ECO 更新 ${local.account} 的交易链接${tradeUrl ? '' : '(平台没返回链接)'}${valid == null ? '' : valid ? ',验证有效' : ',但验证仍然无效'}${result.InventoryPublic === false ? ';库存没公开' : ''}`);
		if (tradeUrl && isTradeUrlOf(settings.tradeUrl, steamId) && tradeUrl !== settings.tradeUrl) {
			settings = {...settings, tradeUrl};
			store.saveSettings(settings);
			log('info', `收货账号的交易链接已换成新的(${local.account})`);
		}
		const list = await loadBoundAccounts().catch(() => boundAccounts?.list ?? []);
		return {tradeUrl, valid, accounts: list.map(receiverAccount), state: state()};
	}

	// ===== 导入令牌绑定 Steam 账号 =====

	let binding = false;

	/** 只按 SteamID 认(没登录过、不知道 SteamID 的认不出) */
	function boundOf(steamId: string): EcoBoundAccount | null {
		const id = accountIdOf(steamId);
		return id == null ? null : boundAccounts?.list.find(entry => accountIdOf(entry.steamId) === id) ?? null;
	}

	/** 能不能导入;能返回 null。给了 maFile 时还要它有 shared_secret */
	function bindBlocker(source: EcoGuardSource, maFile?: Record<string, unknown> | null): string | null {
		if (!source.hasMaFile) {
			return '没有 maFile';
		}
		if (!source.hasPassword) {
			return '没存密码';
		}
		if (maFile !== undefined && !String(maFile?.shared_secret ?? '').trim()) {
			return 'maFile 里没有 shared_secret';
		}
		return null;
	}

	/**
	 * 令牌 JSON:maFile 原样序列化,只把 Session.SteamID 换成精确的数字。
	 * maFile 导入时经过 JSON 解析,17 位的 SteamID 会被舍入成近似值;用登录后记下的 SteamID 写回原文。
	 */
	function guardContentOf(maFile: Record<string, unknown>, steamId: string): string {
		const session = maFile.Session && typeof maFile.Session === 'object' ? maFile.Session as Record<string, unknown> : null;
		const raw = session?.SteamID;
		if (raw == null || raw === '' || typeof raw === 'string' || (typeof raw === 'number' && Number.isSafeInteger(raw))) {
			return JSON.stringify(maFile);
		}
		if (!/^\d{17}$/.test(steamId) || Number(steamId) !== Number(raw)) {
			throw new Error('maFile 里的 SteamID 精度丢了,工具里也没有这个账号的 SteamID;先在账户管理里登录一次再绑定');
		}
		const rawJson = (JSON as unknown as {rawJSON(text: string): unknown}).rawJSON;
		return JSON.stringify({...maFile, Session: {...session, SteamID: rawJson(steamId)}});
	}

	/** 绑定窗口:账户管理里的账号 + 能不能导入 + ECO 上是不是已经绑了 */
	async function bindCandidates(refresh = false): Promise<{accounts: EcoBindCandidate[]; groups: string[]; boundError: string | null}> {
		requireConfigured();
		let boundError: string | null = null;
		if (refresh || !boundAccounts || now() - boundAccounts.at >= BOUND_REFRESH_MS) {
			try {
				await loadBoundAccounts();
			} catch (err) {
				if (!(err instanceof EcoError)) {
					throw err;
				}
				boundError = err.message;
			}
		}
		const sources = options.guardSources?.() ?? [];
		return {
			accounts: sources.map(source => {
				const reason = bindBlocker(source);
				return {...source, ready: !reason, reason, bound: boundOf(source.steamId)};
			}),
			groups: [...new Set(sources.map(source => source.group).filter(Boolean))],
			boundError
		};
	}

	/** 勾选的账号逐个导入令牌绑定 ECO;一个失败不影响其它。做完重查一次 ECO 上的绑定列表 */
	async function importGuard(body: unknown): Promise<{results: EcoBindResult[]; accounts: EcoBindCandidate[]; groups: string[]; boundError: string | null}> {
		requireConfigured();
		const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
		const names = Array.isArray(input.accounts) ? [...new Set(input.accounts.map(name => String(name ?? '').trim()).filter(Boolean))] : [];
		if (!names.length) {
			throw ecoError(400, '没有勾选账号');
		}
		// 整批在一个 HTTP 请求里逐个做,别太长(服务端请求超时 5 分钟)
		if (names.length > 50) {
			throw ecoError(400, '一次最多绑定 50 个账号,多的分批');
		}
		const mode = String(input.groupMode ?? 'none') as EcoBindGroupMode;
		if (!['none', 'fixed', 'tool'].includes(mode)) {
			throw ecoError(400, 'groupMode 只能是 none / fixed / tool');
		}
		const fixedGroup = String(input.groupName ?? '').trim();
		if (mode === 'fixed' && !fixedGroup) {
			throw ecoError(400, '要填 ECO 分组名');
		}
		if (fixedGroup.length > 50) {
			throw ecoError(400, 'ECO 分组名最长 50 个字');
		}
		if (binding) {
			throw ecoError(409, '上一批还在绑定,等它做完');
		}
		binding = true;
		const results: EcoBindResult[] = [];
		try {
			const sources = new Map((options.guardSources?.() ?? []).map(source => [source.account.toLowerCase(), source]));
			log('info', `开始导入令牌绑定 ${names.length} 个账号`);
			for (const name of names) {
				const source = sources.get(name.toLowerCase());
				const fail = (message: string) => {
					results.push({account: source?.account ?? name, status: 'failed', message});
					log('warn', `绑定 ${source?.account ?? name} 失败: ${message}`);
				};
				if (!source) {
					fail('账户管理里没有这个账号');
					continue;
				}
				const credentials = options.guardCredentials?.(source.account) ?? null;
				const blocker = bindBlocker(source, credentials?.maFile ?? null) ?? (credentials?.password ? null : '没存密码');
				if (blocker) {
					fail(blocker);
					continue;
				}
				let guardContent: string;
				try {
					guardContent = guardContentOf(credentials!.maFile!, source.steamId);
				} catch (err) {
					fail((err as Error).message);
					continue;
				}
				if (guardContent.length > GUARD_CONTENT_MAX) {
					fail(`maFile 太长(${guardContent.length} 字,ECO 最多 ${GUARD_CONTENT_MAX})`);
					continue;
				}
				const groupName = mode === 'fixed' ? fixedGroup : mode === 'tool' ? source.group.slice(0, 50) : '';
				try {
					const ok = await currentClient().importGuardAccount({guardContent, account: source.account, password: credentials!.password, groupName});
					if (!ok) {
						fail('平台返回失败');
						continue;
					}
					results.push({account: source.account, status: 'ok', message: groupName ? `已绑定,ECO 分组「${groupName}」` : '已绑定'});
					log('success', `已导入令牌绑定 ${source.account}${groupName ? `(ECO 分组 ${groupName})` : ''}`);
				} catch (err) {
					if (err instanceof EcoNetworkError) {
						results.push({account: source.account, status: 'unknown', message: `结果未知: ${err.message}`});
						log('warn', `绑定 ${source.account} 结果未知: ${err.message}`);
					} else if (err instanceof EcoError) {
						fail(err.message);
					} else {
						throw err;
					}
				}
			}
		} finally {
			binding = false;
		}
		const okCount = results.filter(result => result.status === 'ok').length;
		log(okCount === results.length ? 'success' : 'warn', `导入令牌绑定完成:成功 ${okCount} 个,共 ${results.length} 个`);
		return {results, ...await bindCandidates(true)};
	}

	return {
		state,
		saveSettings,
		generateKeyPair,
		bindCandidates,
		importGuard,
		verifyTradeLinks,
		updateTradeLink,
		setRun,
		saveWatchlist,
		searchNames,
		receivers,
		check,
		listings,
		refreshOrders,
		resolvePurchase,
		/** 服务启动:上次在扫货就接着扫 */
		start(): void {
			shutDown = false;
			if (settingsError) {
				log('warn', `数据库里的设置无效,已退回默认值: ${settingsError}`);
			}
			if (run === 'sweeping') {
				const blocker = configured() ? sweepBlocker(settings) : '没有可用的 PartnerId / 私钥';
				if (blocker) {
					setRunState('stopped', blocker);
				} else {
					log('warn', `恢复上次的运行状态:自动扫货(真实下单),监控 ${items.length} 个饰品`);
					kick();
				}
			}
		},
		stop(): void {
			shutDown = true;
			cancelTimer();
		},
		/** 测试用:等当前排队的操作都跑完 */
		idle(): Promise<void> {
			return serial(() => undefined);
		}
	};
}

export type EcoService = ReturnType<typeof createEcoService>;
