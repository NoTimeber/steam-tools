// C5 扫货服务(原独立的 c5 项目,Python):填好目标价,持续轮询 C5GAME 在售最低价,跌到目标价以内自动买,
// 买满数量或用完预算为止。app-key、设置、监控列表、购买流水都在加密库(src/store/c5.ts),在网页上改,不用重启。
//
// 运行状态三档:停止 / 只看行情(照常轮询,不下单)/ 自动扫货;记在数据库里,服务重启后恢复。
// 每轮、手动对账、手工标记都排进同一个串行队列,互相不会交叉。路由在 ./routes.ts。

import type {C5Mode, C5Purchase, C5PurchaseStatus, C5Store, C5WatchItem} from '../store/c5.ts';
import {purchaseCost} from '../store/c5.ts';
import {C5Error, createC5Client} from './client.ts';
import type {C5Api, C5SteamAccount} from './client.ts';
import {buildItems, c5Error, describeChange, loadSettingsOrDefault, normalizeSettings, RUN_STATES} from './config.ts';
import type {C5RunState, C5Settings} from './config.ts';
import {createSweeper, EPS, lowestPrice, parseListing, toNumber} from './sweeper.ts';
import type {C5LogLevel, Listing} from './sweeper.ts';

export {c5Error};
export type {C5RunState, C5Settings};

const LOG_LIMIT = 200;
const RECENT_PURCHASES = 50;
const BALANCE_REFRESH_MS = 60_000;
const ACCOUNT_STATUS: Record<number, string> = {1: '正常', 2: '暂挂', 3: '不可交易'};

export interface C5LogLine {
	time: number;
	level: C5LogLevel;
	message: string;
}

/** 监控列表里一项的状态:已买满 / 被拒后冷却中 / 查不到行情 / 已到价 / 监控中 */
export type C5ItemStatus = 'done' | 'cooldown' | 'noquote' | 'hit' | 'watch';

export interface C5ItemView extends C5WatchItem {
	status: C5ItemStatus;
	pauseUntil: number | null;
	lowest: number | null;
	sellCount: number | null;
	purchaseMax: number | null;
	bought: number;
	spent: number;
}

export interface C5PurchaseView extends C5Purchase {
	cost: number;
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
	items: C5ItemView[];
	purchases: C5PurchaseView[];
	/** 结果未知、按已花费占着额度的单 */
	unknown: number;
	logs: C5LogLine[];
}

export interface C5CheckResult {
	balance: {money: number | null; settle: number | null; deposit: number | null};
	steamAccounts: Array<{steamId: string; nickname: string; status: string}>;
}

export interface C5ServiceOptions {
	store: C5Store;
	/** socket.io 推送:c5:log(写右侧运行日志;行情变化这类 debug 日志不推) */
	emit(event: 'c5:log', payload: C5LogLine): void;
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

	let appKey = store.getAppKey();
	const loaded = loadSettingsOrDefault(store.loadSettings());
	let settings = loaded.settings;
	const settingsError = loaded.error;
	let items: C5WatchItem[] = store.listItems();
	const savedRun = store.loadRunState();
	let run: C5RunState = RUN_STATES.includes(savedRun as C5RunState) ? savedRun as C5RunState : 'stopped';
	let cycle: C5State['cycle'] = {n: 0, at: null, error: null, errors: 0, done: false};
	let balance: C5State['balance'] = null;
	const logs: C5LogLine[] = [];
	let client: C5Api | null = null;

	// ===== 日志 =====

	function log(level: C5LogLevel, message: string): void {
		const line: C5LogLine = {time: now(), level, message};
		logs.push(line);
		if (logs.length > LOG_LIMIT) {
			logs.splice(0, logs.length - LOG_LIMIT);
		}
		if (level === 'debug') {
			return;
		}
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
		now
	});

	// ===== 串行队列:每轮、手动对账、手工标记、清空模拟记录不交叉 =====

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
		// 实盘:每分钟查一次余额;这一轮下过单就马上查
		if (settings.mode === 'live' && (now() - (balance?.at ?? 0) >= BALANCE_REFRESH_MS || lastPurchase() !== lastBefore)) {
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

	// ===== 状态 =====

	function state(): C5State {
		const view = sweeper.view();
		const totals = store.totals(settings.mode);
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
				...item, status, pauseUntil, lowest,
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
			items: itemViews,
			purchases: store.recentPurchases(settings.mode, RECENT_PURCHASES).map(purchase => ({...purchase, cost: purchaseCost(purchase)})),
			unknown: store.selectPurchases(settings.mode, ['unknown']).length,
			logs: logs.slice()
		};
	}

	// ===== 操作 =====

	function requireAppKey(): void {
		if (!appKey) {
			throw c5Error(409, '还没填 C5 app-key,先在「设置」里填');
		}
	}

	/**
	 * 保存设置。appKey 非空时替换;clearAppKey 删除(同时停止)。
	 * 模拟切到实盘时,正在自动扫货的先降为「只看行情」,确认无误后再手动开扫。
	 */
	function saveSettings(body: unknown): C5State {
		const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
		const {appKey: newKey, clearAppKey, ...rest} = input;
		const next = normalizeSettings(rest, settings);
		const keyText = typeof newKey === 'string' ? newKey.trim() : '';
		if (keyText && /\s/.test(keyText)) {
			throw c5Error(400, 'app-key 里不能有空白字符');
		}
		const switchedToLive = settings.mode !== 'live' && next.mode === 'live';
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
		if (next.mode !== settings.mode) {
			changes.push(next.mode === 'live' ? '切到实盘' : '切到模拟');
		}
		settings = next;
		client = null;   // app-key / 超时可能变了
		log('info', `设置已保存:${next.mode === 'live' ? '实盘' : '模拟'},${next.strategy === 'quick' ? '快速购买' : '按在售列表'},`
			+ `总预算 ${next.maxTotalSpend || '不限'},轮询 ${next.pollIntervalSec} 秒${changes.length ? ';' + changes.join(',') : ''}`);
		if (!appKey && run !== 'stopped') {
			setRunState('stopped', '没有 app-key');
		} else if (switchedToLive && run === 'sweeping') {
			setRunState('watching', '刚切到实盘,先只看行情;确认无误后点「自动扫货」');
		}
		kick();
		return state();
	}

	function setRunState(next: C5RunState, reason = ''): void {
		run = next;
		store.saveRunState(next);
		const label = next === 'stopped' ? '停止' : next === 'watching' ? '只看行情(不下单)' : `自动扫货(${settings.mode === 'live' ? '实盘' : '模拟'})`;
		log(next === 'sweeping' && settings.mode === 'live' ? 'warn' : 'info', `运行状态:${label}${reason ? ',' + reason : ''}`);
		if (next === 'stopped') {
			cancelTimer();
		}
	}

	function setRun(value: unknown): C5State {
		const next = String(value ?? '') as C5RunState;
		if (!RUN_STATES.includes(next)) {
			throw c5Error(400, `运行状态只能是 ${RUN_STATES.join(' / ')}`);
		}
		if (next !== 'stopped') {
			requireAppKey();
		}
		if (next === 'sweeping' && settings.mode === 'live') {
			// 设置保存时已校验过;数据库被改坏退回默认值时这里兜底
			normalizeSettings({}, settings);
		}
		if (next !== run) {
			setRunState(next);
		}
		kick();
		return state();
	}

	/** 网页提交整张表:校验、存库、下一轮按新列表扫。不合法报 400,原来的不动 */
	function saveWatchlist(raws: unknown): C5State {
		const next = buildItems(raws);
		const before = items;
		store.replaceItems(next);
		items = next;
		log('info', `监控列表已保存,${next.length} 个饰品${describeChange(before, next)}`);
		kick();
		return state();
	}

	/** 连通性:app-key、余额、C5 上绑定的 Steam 收货账号 */
	async function check(): Promise<C5CheckResult> {
		requireAppKey();
		const api = currentClient();
		try {
			const money = await api.balance();
			const info = await api.steamInfo();
			const result: C5CheckResult = {
				balance: {money: toNumber(money.moneyAmount), settle: toNumber(money.tradeSettleAmount), deposit: toNumber(money.depositAmount)},
				steamAccounts: (Array.isArray(info.steamList) ? info.steamList : []).map((account: C5SteamAccount) => ({
					steamId: String(account.steamId ?? ''),
					nickname: String(account.nickname ?? ''),
					status: ACCOUNT_STATUS[Number(account.accountStatus)] ?? String(account.accountStatus ?? '')
				}))
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

	/** 实盘:立刻向平台对一遍全部未完结订单 */
	async function refreshOrders(): Promise<{checked: number; state: C5State}> {
		requireAppKey();
		if (settings.mode !== 'live') {
			throw c5Error(400, '模拟模式没有平台订单');
		}
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
			log('info', `手工标记:${purchase.name} 单号 ${no} ${purchase.status} → ${status}`);
		});
		return state();
	}

	/** 清空模拟流水(模拟的数量和预算从零算) */
	async function clearPurchases(mode: unknown): Promise<C5State> {
		if (mode !== 'dry') {
			throw c5Error(400, '只能清空模拟记录');
		}
		const removed = await serial(() => store.clearPurchases(mode as C5Mode));
		log('info', `已清空 ${removed} 笔模拟记录`);
		kick();
		return state();
	}

	return {
		state,
		saveSettings,
		setRun,
		saveWatchlist,
		check,
		listings,
		refreshOrders,
		resolvePurchase,
		clearPurchases,
		/** 服务启动:上次在跑就接着跑 */
		start(): void {
			shutDown = false;
			if (settingsError) {
				log('warn', `数据库里的设置无效,已退回默认值: ${settingsError}`);
			}
			if (run !== 'stopped') {
				if (appKey) {
					log(run === 'sweeping' && settings.mode === 'live' ? 'warn' : 'info',
						`恢复上次的运行状态:${run === 'sweeping' ? `自动扫货(${settings.mode === 'live' ? '实盘' : '模拟'})` : '只看行情'},监控 ${items.length} 个饰品`);
					kick();
				} else {
					setRunState('stopped', '没有 app-key');
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
