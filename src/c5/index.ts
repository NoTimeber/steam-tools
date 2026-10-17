// C5 扫货服务(原独立的 c5 项目,Python):填好目标价,持续轮询 C5GAME 在售最低价,跌到目标价以内自动买,
// 买满数量或用完预算为止。app-key、设置、监控列表、购买流水都在加密库(src/store/c5.ts),在网页上改,不用重启。
//
// 运行状态两档:停止 / 自动扫货(真实下单,没有模拟);记在数据库里,服务重启后恢复。
// 每轮、手动对账、手工标记都排进同一个串行队列,互相不会交叉。路由在 ./routes.ts。
// 流水表的 mode 列是旧版本留下的(当时有模拟模式),现在只写、只读 live。
//
// C5 接口只认 Steam 英文名,监控列表、流水按英文名存;页面和日志上的中文名查 src/items/names.ts 的词库。

import type {NameDb} from '../items/names.ts';
import {accountIdOf, isTradeUrlOf, partnerOf, steamIdFromTradeUrl} from '../steam/trade-url.ts';
import type {C5Purchase, C5PurchaseStatus, C5Store, C5WatchItem} from '../store/c5.ts';
import {purchaseCost} from '../store/c5.ts';
import {C5Error, createC5Client} from './client.ts';
import type {C5Api, C5ItemStat, C5SteamAccount} from './client.ts';
import {buildItems, c5Error, describeChange, loadSettingsOrDefault, normalizeSettings, RUN_STATES, sweepBlocker} from './config.ts';
import type {C5RunState, C5Settings} from './config.ts';
import {createSweeper, EPS, lowestPrice, parseListing, toNumber} from './sweeper.ts';
import type {C5LogLevel, Listing} from './sweeper.ts';

export {c5Error};
export type {C5RunState, C5Settings};

const RECENT_PURCHASES = 50;
const BALANCE_REFRESH_MS = 60_000;
/** 搜索饰品时查的 C5 价格多久内不重查 */
const PRICE_TTL_MS = 30_000;
/** C5 上绑定的 Steam 账号多久重查一次(选收货账号时) */
const BOUND_REFRESH_MS = 5 * 60_000;
const ACCOUNT_STATUS: Record<number, string> = {1: '正常', 2: '暂挂', 3: '不可交易'};

export interface C5LogLine {
	time: number;
	level: C5LogLevel;
	message: string;
}

/** 监控列表里一项的状态:已买满 / 被拒后冷却中 / 查不到行情 / 已到价 / 监控中 */
export type C5ItemStatus = 'done' | 'cooldown' | 'noquote' | 'hit' | 'watch';

export interface C5ItemView extends C5WatchItem {
	/** 中文名;词库里没有为 null */
	zh: string | null;
	status: C5ItemStatus;
	pauseUntil: number | null;
	lowest: number | null;
	sellCount: number | null;
	purchaseMax: number | null;
	bought: number;
	spent: number;
}

export interface C5PurchaseView extends C5Purchase {
	zh: string | null;
	cost: number;
}

/** 添加饰品的搜索结果;zh 为 null 是词库里没有、按输入的英文名原样用。lowest / sellCount 是 C5 在售最低价和在售数 */
export interface C5NameOption {
	name: string;
	zh: string | null;
	lowest: number | null;
	sellCount: number | null;
}

export interface C5NameSearch {
	options: C5NameOption[];
	/** 查到了 C5 价格(没填 app-key 或查价失败时为 false) */
	priced: boolean;
	priceError: string | null;
}

/** C5 账户上绑定的 Steam 账号 */
export interface C5BoundAccount {
	steamId: string;
	nickname: string;
	/** Steam 登录名;C5 没给为 '' */
	username: string;
	status: string;
	/** C5 的「交易助手」账号 */
	assistant: boolean;
}

/** 账户管理里的一个账号(src/steam/attempts.ts 的 AccountRef) */
export interface C5LocalAccount {
	account: string;
	/** 不知道时为 '' */
	steamId: string;
	personaName: string;
	/** 登录着、有网页会话 */
	online: boolean;
	/** 有网页会话 cookie(在线的,或上次登录存下的),能试着去 Steam 取交易链接 */
	hasSession: boolean;
}

/**
 * 收货账号下拉的一项:C5 上绑定的 Steam 账号。C5 开放平台不给交易链接,下单又必须带,
 * link 说明选它时链接从哪来:local 用账户管理里同一个账号的网页会话去 Steam 取;saved 用记下的;none 要贴一次
 */
export interface C5ReceiverAccount extends C5BoundAccount {
	/** 账户管理里对应的账号名;不在账户管理里为 null */
	account: string | null;
	link: 'local' | 'saved' | 'none';
}

/** 收货账号:从交易链接里的 partner 算出 SteamID,再对上本工具的账号和 C5 上绑定的账号 */
export interface C5Receiver {
	steamId: string;
	/** 本工具里对应的账号名 / 昵称;不是本工具管理的账号为 null */
	account: string | null;
	personaName: string | null;
	/** C5 上绑定的同一个账号;c5Checked 为 false 时是还没查过 C5 */
	c5: C5BoundAccount | null;
	c5Checked: boolean;
}

export interface C5State {
	/** 填过 app-key */
	configured: boolean;
	/** app-key 只给后 4 位 */
	appKeyMasked: string;
	settings: C5Settings;
	/** 数据库里的设置坏了、已退回默认值时的原因 */
	settingsError: string | null;
	run: C5RunState;
	cycle: {n: number; at: number | null; error: string | null; errors: number; done: boolean};
	budget: {total: number; spent: number; qty: number};
	balance: {value: number; at: number} | null;
	/** 收货账号;没填交易链接为 null */
	receiver: C5Receiver | null;
	items: C5ItemView[];
	purchases: C5PurchaseView[];
	/** 结果未知、按已花费占着额度的单 */
	unknown: number;
}

export interface C5CheckResult {
	balance: {money: number | null; settle: number | null; deposit: number | null};
	steamAccounts: C5BoundAccount[];
}

export interface C5ServiceOptions {
	store: C5Store;
	/** socket.io 推送:c5:log(写进页面右下角的「实时运行日志」) */
	emit(event: 'c5:log', payload: C5LogLine): void;
	/** 饰品中英文名词库;不给就只显示英文名 */
	names?: NameDb;
	/** 账户管理里的全部账号(收货账号下拉;按 SteamID 认交易链接是谁的) */
	localAccounts?: () => C5LocalAccount[];
	/** 用账号的网页会话(在线的或上次登录存下的)取它自己的交易链接 */
	fetchTradeUrl?: (account: string) => Promise<string>;
	/** 默认是 ./client.ts 的真实客户端;单元测试用假的 */
	createClient?: (options: {appKey: string; timeoutMs: number}) => C5Api;
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

export function maskAppKey(appKey: string): string {
	if (!appKey) {
		return '';
	}
	return appKey.length > 8 ? '****' + appKey.slice(-4) : '****';
}

/** 平台报的错(包括连不上)回 502,文字照实给;其它错误原样抛 */
function upstream(err: unknown): never {
	if (err instanceof C5Error) {
		throw c5Error(502, err.message);
	}
	throw err;
}

export function createC5Service(options: C5ServiceOptions) {
	const {store} = options;
	const now = options.now ?? Date.now;
	const logger = options.logger ?? console;
	const timers = options.timers ?? realTimers;
	const makeClient = options.createClient ?? (({appKey, timeoutMs}) => createC5Client({appKey, timeoutMs}));
	const zhOf = (name: string) => options.names?.zh(name) ?? null;
	/** 日志里的饰品名:有中文用中文 */
	const label = (name: string) => zhOf(name) ?? name;

	let appKey = store.getAppKey();
	const savedSettings = store.loadSettings();
	const loaded = loadSettingsOrDefault(savedSettings);
	let settings = loaded.settings;
	const settingsError = loaded.error;
	let items: C5WatchItem[] = store.listItems();
	const savedRun = store.loadRunState();
	// 旧版本的「只看行情」和模拟模式下的自动扫货都不花钱,升级后不能自己变成真实下单:一律停下,等人确认后手动开始。
	// 旧版本的设置里都有 mode(没存过设置就是默认的模拟);新版本存的没有 mode
	const savedMode = savedSettings && typeof savedSettings === 'object' ? (savedSettings as {mode?: unknown}).mode : 'dry';
	const legacyRun = savedRun === 'watching' || (savedRun === 'sweeping' && savedMode !== undefined && savedMode !== 'live');
	let run: C5RunState = !legacyRun && RUN_STATES.includes(savedRun as C5RunState) ? savedRun as C5RunState : 'stopped';
	let cycle: C5State['cycle'] = {n: 0, at: null, error: null, errors: 0, done: false};
	let balance: C5State['balance'] = null;
	let client: C5Api | null = null;
	/** C5 上绑定的 Steam 账号(检查连接、选收货账号时查;换 app-key 时清掉) */
	let boundAccounts: {list: C5BoundAccount[]; at: number} | null = null;
	const priceCache = new Map<string, {stat: C5ItemStat; at: number}>();

	// ===== 日志 =====

	/** 写服务端日志并推到页面右下角的「实时运行日志」;debug(每个饰品的行情变化)不记,监控列表里有实时价格 */
	function log(level: C5LogLevel, message: string): void {
		if (level === 'debug') {
			return;
		}
		const line: C5LogLine = {time: now(), level, message};
		const text = `[c5] ${message}`;
		if (level === 'error') {
			logger.error(text);
		} else if (level === 'warn') {
			logger.warn(text);
		} else {
			logger.log(text);
		}
		options.emit('c5:log', line);
	}

	function currentClient(): C5Api {
		client ??= makeClient({appKey, timeoutMs: settings.timeoutSec * 1000});
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

	const active = () => !shutDown && run !== 'stopped' && !!appKey;

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
		const lastPurchase = () => store.recentPurchases('live', 1)[0]?.outTradeNo;
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
			if (err instanceof C5Error) {
				log('warn', `本轮失败(连续第 ${cycle.errors} 次): ${message}`);
			} else {
				logger.error('[c5] 本轮出错:', err);
				log('error', `本轮出错(连续第 ${cycle.errors} 次): ${message}`);
			}
		}
		// 每分钟查一次余额;这一轮下过单就马上查
		if (now() - (balance?.at ?? 0) >= BALANCE_REFRESH_MS || lastPurchase() !== lastBefore) {
			await refreshBalance().catch(err => log('warn', `查余额失败: ${(err as Error).message}`));
		}
	}

	async function refreshBalance(): Promise<number | null> {
		const money = toNumber((await currentClient().balance()).moneyAmount);
		if (money != null) {
			balance = {value: money, at: now()};
		}
		return money;
	}

	// ===== 收货账号 =====

	function toBound(account: C5SteamAccount): C5BoundAccount {
		return {
			steamId: String(account.steamId ?? ''),
			nickname: String(account.nickname ?? ''),
			username: String(account.username ?? ''),
			status: ACCOUNT_STATUS[Number(account.accountStatus)] ?? String(account.accountStatus ?? ''),
			assistant: Number(account.autoType) === 2
		};
	}

	/** 记下的交易链接里属于这个 SteamID 的(按账号 id 认,和记的时候用什么当 key 无关) */
	function savedTradeUrl(steamId: string): string | null {
		return Object.values(store.loadTradeUrls()).find(url => isTradeUrlOf(url, steamId)) ?? null;
	}

	/** 账户管理里和这个 SteamID 是同一个账号的 */
	function localOf(steamId: string): C5LocalAccount | null {
		const id = accountIdOf(steamId);
		return options.localAccounts?.().find(account => id != null && accountIdOf(account.steamId) === id) ?? null;
	}

	async function loadBoundAccounts(): Promise<C5BoundAccount[]> {
		const info = await currentClient().steamInfo();
		const list = (Array.isArray(info.steamList) ? info.steamList : []).map(toBound);
		boundAccounts = {list, at: now()};
		return list;
	}

	function receiverOf(tradeUrl: string): C5Receiver | null {
		const steamId = steamIdFromTradeUrl(tradeUrl);
		if (!steamId) {
			return null;
		}
		const local = options.localAccounts?.().find(account => isTradeUrlOf(tradeUrl, account.steamId)) ?? null;
		const c5 = boundAccounts?.list.find(account => isTradeUrlOf(tradeUrl, account.steamId)) ?? null;
		return {
			steamId: local?.steamId ?? c5?.steamId ?? steamId,
			account: local?.account ?? null,
			personaName: local?.personaName || null,
			c5,
			c5Checked: !!boundAccounts
		};
	}

	/** 日志里的收货账号:账号名(昵称) SteamID */
	function receiverText(receiver: C5Receiver | null): string {
		if (!receiver) {
			return '未设置';
		}
		// C5 上的昵称优先;不是 C5 绑定的账号再用账户管理里的账号名(昵称)
		const name = receiver.c5?.nickname
			|| (receiver.account ? `${receiver.account}${receiver.personaName ? `(${receiver.personaName})` : ''}` : '');
		return `${name ? name + ' ' : ''}SteamID ${receiver.steamId}`;
	}

	// ===== 状态 =====

	function state(): C5State {
		const view = sweeper.view();
		const totals = store.totals('live');
		const at = now();
		const itemViews = items.map((item): C5ItemView => {
			const stat = view.stats[item.name] ?? {};
			const lowest = lowestPrice(stat);
			const total = totals.get(item.name) ?? {qty: 0, spent: 0};
			const pauseUntil = view.pauseUntil[item.name] ?? null;
			let status: C5ItemStatus;
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
				sellCount: toNumber(stat.sellCount), purchaseMax: toNumber(stat.purchaseMaxPrice),
				bought: total.qty, spent: total.spent
			};
		});
		return {
			configured: !!appKey,
			appKeyMasked: maskAppKey(appKey),
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
			purchases: store.recentPurchases('live', RECENT_PURCHASES)
				.map(purchase => ({...purchase, zh: zhOf(purchase.name), cost: purchaseCost(purchase)})),
			unknown: store.selectPurchases('live', ['unknown']).length
		};
	}

	// ===== 操作 =====

	function requireAppKey(): void {
		if (!appKey) {
			throw c5Error(409, '还没填 C5 app-key,先在「设置」里填');
		}
	}

	/** 保存设置。appKey 非空时替换;clearAppKey 删除(同时停止)。正在扫货时交易链接和总预算不能清空 */
	function saveSettings(body: unknown): C5State {
		const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
		const {appKey: newKey, clearAppKey, ...rest} = input;
		const next = normalizeSettings(rest, settings);
		const keyText = typeof newKey === 'string' ? newKey.trim() : '';
		if (keyText && /\s/.test(keyText)) {
			throw c5Error(400, 'app-key 里不能有空白字符');
		}
		if (keyText && clearAppKey === true) {
			throw c5Error(400, '不能同时填新 app-key 又删除 app-key,二选一');
		}
		const blocker = run === 'sweeping' && clearAppKey !== true ? sweepBlocker(next) : null;
		if (blocker) {
			throw c5Error(400, `正在自动扫货,${blocker};要清空先停止`);
		}
		store.saveSettings(next);
		const changes: string[] = [];
		if (keyText) {
			store.setAppKey(keyText);
			appKey = keyText;
			changes.push('app-key 已更新');
		} else if (clearAppKey === true && appKey) {
			store.setAppKey('');
			appKey = '';
			changes.push('app-key 已删除');
		}
		if (changes.length) {
			// 换了 C5 账户:绑定的 Steam 账号、价格都要重查
			boundAccounts = null;
			priceCache.clear();
		}
		if (next.tradeUrl !== settings.tradeUrl) {
			changes.push(`收货账号改为 ${receiverText(receiverOf(next.tradeUrl))}`);
			// 贴过的链接记下来,下次在下拉里选这个账号就不用再贴
			const partner = partnerOf(next.tradeUrl);
			if (partner) {
				store.saveTradeUrl(partner, next.tradeUrl);
			}
		}
		settings = next;
		client = null;   // app-key / 超时可能变了
		log('info', `设置已保存:${next.strategy === 'quick' ? '快速购买' : '按在售列表'},`
			+ `总预算 ${next.maxTotalSpend || '未设'},轮询 ${next.pollIntervalSec} 秒${changes.length ? ';' + changes.join(',') : ''}`);
		if (!appKey && run !== 'stopped') {
			setRunState('stopped', '没有 app-key');
		}
		kick();
		return state();
	}

	function setRunState(next: C5RunState, reason = ''): void {
		run = next;
		store.saveRunState(next);
		log(next === 'sweeping' ? 'warn' : 'info', `运行状态:${next === 'sweeping' ? '自动扫货(真实下单)' : '停止'}${reason ? ',' + reason : ''}`);
		if (next === 'stopped') {
			cancelTimer();
		}
	}

	function setRun(value: unknown): C5State {
		const next = String(value ?? '') as C5RunState;
		if (!RUN_STATES.includes(next)) {
			throw c5Error(400, `运行状态只能是 ${RUN_STATES.join(' / ')}`);
		}
		if (next === 'sweeping') {
			requireAppKey();
			const blocker = sweepBlocker(settings);
			if (blocker) {
				throw c5Error(400, `不能开始自动扫货:${blocker}`);
			}
		}
		if (next !== run) {
			setRunState(next, next === 'sweeping' ? `收货账号 ${receiverText(receiverOf(settings.tradeUrl))}` : '');
		}
		kick();
		return state();
	}

	/** 网页提交整张表:校验、存库、下一轮按新列表扫。不合法报 400,原来的不动 */
	function saveWatchlist(raws: unknown): C5State {
		const next = buildItems(raws);
		for (const item of next) {
			// 填了中文名:C5 查不到行情,提前拦下(有的英文名里本身带汉字,所以按词库判断)
			const name = zhOf(item.name) == null ? options.names?.nameOf(item.name) : null;
			if (name) {
				throw c5Error(400, `「${item.name}」是中文名,C5 接口只认英文名,应填 ${name}`);
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
	 * 填了 app-key 时顺带查这批饰品的 C5 在售最低价(一个请求,30 秒内查过的不重查);查价失败不影响搜索结果
	 */
	async function searchNames(query: unknown): Promise<C5NameSearch> {
		const text = String(query ?? '').trim().slice(0, 100);
		const found: C5NameOption[] = text ? (options.names?.search(text, 30) ?? []).map(match => ({...match, lowest: null, sellCount: null})) : [];
		if (text && !/[㐀-鿿]/.test(text) && text.length >= 3 && !found.some(option => option.name === text)) {
			found.push({name: text, zh: null, lowest: null, sellCount: null});
		}
		if (!found.length || !appKey) {
			return {options: found, priced: false, priceError: null};
		}
		const at = now();
		const fresh = (name: string) => at - (priceCache.get(name)?.at ?? -Infinity) < PRICE_TTL_MS;
		const stale = found.map(option => option.name).filter(name => !fresh(name));
		let priceError: string | null = null;
		if (stale.length) {
			try {
				const stats = await currentClient().itemStats(730, stale);
				for (const name of priceCache.keys()) {
					if (!fresh(name)) {
						priceCache.delete(name);
					}
				}
				for (const name of stale) {
					priceCache.set(name, {stat: stats[name] ?? {}, at});
				}
			} catch (err) {
				if (!(err instanceof C5Error)) {
					throw err;
				}
				priceError = err.message;
			}
		}
		for (const option of found) {
			const stat = priceCache.get(option.name)?.stat;
			if (stat) {
				option.lowest = lowestPrice(stat);
				option.sellCount = toNumber(stat.sellCount);
			}
		}
		return {options: found, priced: !priceError, priceError};
	}

	/** 收货账号下拉:C5 上绑定的 Steam 账号(要 app-key;5 分钟内不重查),标上选它时交易链接从哪来 */
	async function receivers(): Promise<{accounts: C5ReceiverAccount[]; checked: boolean; boundError: string | null}> {
		let boundError: string | null = appKey ? null : '还没填 C5 app-key';
		if (appKey && (!boundAccounts || now() - boundAccounts.at >= BOUND_REFRESH_MS)) {
			try {
				await loadBoundAccounts();
			} catch (err) {
				if (!(err instanceof C5Error)) {
					throw err;
				}
				boundError = err.message;
			}
		}
		return {
			accounts: (boundAccounts?.list ?? []).map(account => {
				const local = localOf(account.steamId);
				const link = local?.hasSession && options.fetchTradeUrl ? 'local' : savedTradeUrl(account.steamId) ? 'saved' : 'none';
				return {...account, account: local?.account ?? null, link};
			}),
			checked: !!boundAccounts,
			boundError
		};
	}

	/**
	 * 取某个 SteamID 的交易链接(只取,不改设置)。账户管理里有同一个账号、有网页会话的,去 Steam 取一次并记下来;
	 * 取不到时用记下的(warning 写原因);都没有回 409,页面让人贴一次
	 */
	async function tradeUrlFor(steamId: unknown): Promise<{tradeUrl: string; receiver: C5Receiver | null; warning: string | null}> {
		const id = String(steamId ?? '').trim();
		if (accountIdOf(id) == null) {
			throw c5Error(400, 'SteamID 不对');
		}
		const saved = savedTradeUrl(id);
		const local = localOf(id);
		let warning: string | null = null;
		if (local?.hasSession && options.fetchTradeUrl) {
			try {
				const tradeUrl = await options.fetchTradeUrl(local.account);
				store.saveTradeUrl(partnerOf(tradeUrl) ?? id, tradeUrl);
				return {tradeUrl, receiver: receiverOf(tradeUrl), warning: null};
			} catch (err) {
				warning = `用账户管理里的 ${local.account} 没取到交易链接(${err instanceof Error ? err.message : String(err)})`;
			}
		}
		if (saved) {
			return {tradeUrl: saved, receiver: receiverOf(saved), warning: warning && `${warning},用的是上次记下的`};
		}
		throw c5Error(409, `${warning ? warning + ';' : ''}C5 开放平台不给交易链接,这个账号的交易链接要贴一次(之后会记住)`);
	}

	/** 连通性:app-key、余额、C5 上绑定的 Steam 收货账号 */
	async function check(): Promise<C5CheckResult> {
		requireAppKey();
		const api = currentClient();
		try {
			const money = await api.balance();
			const result: C5CheckResult = {
				balance: {money: toNumber(money.moneyAmount), settle: toNumber(money.tradeSettleAmount), deposit: toNumber(money.depositAmount)},
				steamAccounts: await loadBoundAccounts()
			};
			if (result.balance.money != null) {
				balance = {value: result.balance.money, at: now()};
			}
			log('info', `检查连接:app-key 有效,可用余额 ${result.balance.money ?? '-'},绑定 Steam 账号 ${result.steamAccounts.length} 个`);
			return result;
		} catch (err) {
			if (err instanceof C5Error) {
				log('warn', `检查连接失败: ${err.message}`);
			}
			return upstream(err);
		}
	}

	/** 某个饰品目标价以内的在售(验证内测接口权限和 IP 白名单) */
	async function listings(name: unknown): Promise<{name: string; maxPrice: number; listings: Listing[]}> {
		requireAppKey();
		const item = items.find(entry => entry.name === String(name ?? '').trim());
		if (!item) {
			throw c5Error(404, '监控列表里没有这个饰品(新加的要先保存)');
		}
		try {
			const raw = await currentClient().searchProducts({
				appId: item.appId, name: item.name, priceMax: item.maxPrice, delivery: item.delivery, assetType: item.assetType
			});
			const found = raw.map(parseListing).filter((listing): listing is Listing => !!listing).sort((a, b) => a.price - b.price);
			return {name: item.name, maxPrice: item.maxPrice, listings: found};
		} catch (err) {
			return upstream(err);
		}
	}

	/** 立刻向平台对一遍全部未完结订单 */
	async function refreshOrders(): Promise<{checked: number; state: C5State}> {
		requireAppKey();
		const checked = await serial(() => sweeper.refreshOrders(null, {force: true}));
		log('info', `已向平台同步 ${checked} 笔未完结订单`);
		return {checked, state: state()};
	}

	/** 手工标记一笔单(去官网核对过结果未知的单后用) */
	async function resolvePurchase(outTradeNo: unknown, status: unknown): Promise<C5State> {
		const no = String(outTradeNo ?? '').trim();
		if (status !== 'ok' && status !== 'failed') {
			throw c5Error(400, '只能标记为 ok(已成交)或 failed(未成交)');
		}
		await serial(() => {
			const purchase = store.getPurchase(no);
			if (!purchase) {
				throw c5Error(404, `没有单号 ${no}`);
			}
			store.updatePurchase(no, {status: status as C5PurchaseStatus, error: '手工标记'});
			log('info', `手工标记:${label(purchase.name)} 单号 ${no} ${purchase.status} → ${status}`);
		});
		return state();
	}

	return {
		state,
		saveSettings,
		setRun,
		saveWatchlist,
		searchNames,
		receivers,
		tradeUrlFor,
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
			if (legacyRun) {
				setRunState('stopped', `已去掉「只看行情」和模拟模式,上次的${savedRun === 'watching' ? '只看行情' : '模拟扫货'}不再自动恢复;`
					+ '确认设置后点「自动扫货」开始真实下单');
			} else if (run === 'sweeping') {
				const blocker = appKey ? sweepBlocker(settings) : '没有 app-key';
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

export type C5Service = ReturnType<typeof createC5Service>;
