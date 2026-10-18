// 市场求购服务(从 app/server.js 移来):行情参考、多账号挂求购(含手机确认)、撤单、和 Steam 对账。
// 路由在 ./routes.ts;会话查找、cookies、文件读写由 src/main.ts 注入,单元测试用假的。

import {randomUUID} from 'node:crypto';
import type {NameDb} from '../items/names.ts';
import {currencyIdToIso} from '../steam/currencies.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {createMarketClient, isGroupId, matchListingUrl, parseListingUrl} from './client.ts';
import type {CreateBuyOrderParams, LiveBuyOrder, MarketClient, MarketContext, MarketLog, MarketTarget} from './client.ts';
import {createBuyOrderConfirmer} from './confirmations.ts';
import type {BuyOrderConfirmer} from './confirmations.ts';
import {createBuyOrderLedger} from './ledger.ts';
import type {BuyOrderRecord, ReconcileResult} from './ledger.ts';
import {createNameIdResolver} from './nameids.ts';

export {parseListingUrl};
export type {BuyOrderRecord, MarketContext};

/** 求购单要手机确认时,带 confirmation 重发 createbuyorder 最多几次、间隔多久(确认生效可能稍有延迟) */
const RESEND_ATTEMPTS = 4;
const RESEND_GAP_MS = 1500;

export function marketError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : '';
}

/** 并发上限 1~8,默认 2(太高容易触发 Steam 风控) */
function clampConcurrency(value: unknown): number {
	return Math.max(1, Math.min(8, Math.round(Number(value)) || 2));
}

/** 最多 limit 个同时跑,结果与 items 同序 */
export async function runWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	const lanes = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
	let cursor = 0;
	async function lane(): Promise<void> {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await worker(items[index] as T, index);
		}
	}
	await Promise.all(Array.from({length: lanes}, lane));
	return results;
}

/** 前端传来的商品定位:优先 url,其次 appid + marketHashName */
export function resolveTarget(input: {url?: unknown; appid?: unknown; marketHashName?: unknown}): MarketTarget {
	if (input.url) {
		return parseListingUrl(input.url);
	}
	const appid = Number(input.appid);
	const marketHashName = String(input.marketHashName || '').trim();
	if (Number.isInteger(appid) && appid > 0 && marketHashName) {
		return {appid, marketHashName};
	}
	throw new Error('请提供商品链接(url)或 appid + marketHashName');
}

function currencyIso(attempt: Attempt): string {
	return String(attempt.currencyISO || currencyIdToIso(attempt.currency) || '').toUpperCase();
}

export interface ContextQuery {
	accountId?: unknown;
	account?: unknown;
	url?: unknown;
	appid?: unknown;
	marketHashName?: unknown;
	/** 用户手填的 item_nameid */
	itemNameId?: unknown;
	nameId?: unknown;
}

export interface SearchQuery {
	/** 中文或英文名;也可以是商品链接(老的英文名链接或新版分组链接) */
	q?: unknown;
}

/** 搜商品的一条:Steam 英文名 + 中文名 */
export interface MarketSearchItem extends MarketTarget {
	/** 词库里没有(新出的饰品按英文名用、其它游戏的链接)为 null */
	zh: string | null;
}

export interface MarketSearchResult {
	items: MarketSearchItem[];
}

export interface PlaceRequest {
	accountIds?: unknown;
	accounts?: unknown;
	url?: unknown;
	appid?: unknown;
	marketHashName?: unknown;
	/** 每件价格,钱包币种的主单位(可带小数) */
	pricePerItem?: unknown;
	quantity?: unknown;
	/** true:忽略 quantity,每个账号买 floor(余额 / 单价) 件 */
	perAccountMax?: unknown;
	itemName?: unknown;
	concurrency?: unknown;
}

export interface PlaceResult {
	account: string;
	attemptId: string;
	ok: boolean;
	buyOrderId?: string;
	/** 账本记录 id;前端用它把「我的求购单」面板限定为这一批 */
	recordId?: string;
	needsConfirmation?: boolean;
	error?: string;
}

export interface CancelRequest {
	/** 账本记录 id */
	id?: unknown;
	/** 不走账本、直接撤:账号 + buy_orderid */
	accountId?: unknown;
	account?: unknown;
	buyOrderId?: unknown;
}

export interface SyncRequest {
	/** 要对账的账号名或 attemptId;不传则对账本里出现过的所有账号 */
	accounts?: unknown;
	concurrency?: unknown;
}

export interface SyncAccountResult {
	account: string;
	ok: boolean;
	count?: number;
	error?: string;
}

export interface MarketServiceOptions {
	/** 按 attemptId 或账号名(不区分大小写)找会话 */
	findAttempt(key: string): Attempt | null;
	/** 会话的 WebSession cookies(内存 → 会话库 → 旧 cookies 文件) */
	cookiesFor(attempt: Attempt): string[];
	/** data/market-buyorders.json */
	ledgerFile: string;
	/** data/market-nameids.json */
	nameIdCacheFile: string;
	/** 社区 nameid 库目录 */
	nameIdDbDir: string;
	readJson(file: string): unknown;
	writeJson(file: string, value: unknown): void;
	writeText(file: string, text: string): void;
	/** CS2 中英文名词库:搜商品就搜它 */
	names?: Pick<NameDb, 'search' | 'zh'>;
	client?: MarketClient;
	confirmer?: BuyOrderConfirmer;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	randomId?: () => string;
	logger?: Pick<Console, 'log' | 'warn'>;
}

export function createMarketService(options: MarketServiceOptions) {
	const logger = options.logger ?? console;
	const log: MarketLog = (level, message) => level === 'warn' ? logger.warn(message) : logger.log(message);
	const client = options.client ?? createMarketClient({fetch: options.fetch, log});
	const confirmer = options.confirmer ?? createBuyOrderConfirmer({log});
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	const randomId = options.randomId ?? randomUUID;
	const ledger = createBuyOrderLedger({file: options.ledgerFile, readJson: options.readJson, writeJson: options.writeJson, log});
	const nameIds = createNameIdResolver({
		cacheFile: options.nameIdCacheFile,
		dbDir: options.nameIdDbDir,
		readJson: options.readJson,
		writeJson: options.writeJson,
		writeText: options.writeText,
		fetch: options.fetch,
		log
	});

	function findAttempt(key: unknown): Attempt | null {
		const text = String(key || '').trim();
		return text ? options.findAttempt(text) : null;
	}

	// ===== 搜商品 =====

	/** 词库里搜(中文或英文,空格分开的几个词都要出现);rawName:输的像英文全名又不在词库里(新出的饰品),附一个按原文用的选项 */
	function searchNames(text: string, rawName: boolean): MarketSearchItem[] {
		const found: MarketSearchItem[] = (options.names?.search(text, 30) ?? []).map(match => ({appid: 730, marketHashName: match.name, zh: match.zh}));
		if (rawName && !/[㐀-鿿]/.test(text) && text.length >= 3 && !found.some(item => item.marketHashName === text)) {
			found.push({appid: 730, marketHashName: text, zh: null});
		}
		return found;
	}

	/**
	 * 按名字搜商品:只搜随包的 CS2 中英文名词库,选中后再去 Steam 查行情(盘口按 item_nameid 查,不受影响)。
	 * 不用 Steam 的 market/search/render:它对机房 / 代理 IP 上的请求一律 429。
	 * 也认粘贴的链接:老的英文名链接就是那一件(其它游戏也行);新版分组链接读分组页标题拿分组名,再在词库里搜。
	 */
	async function search(query: SearchQuery): Promise<MarketSearchResult> {
		const text = String(query.q ?? '').trim().slice(0, 300);
		if (!text) {
			return {items: []};
		}
		const link = matchListingUrl(text);
		if (!link) {
			return {items: searchNames(text, true)};
		}
		if (!Number.isInteger(link.appid) || link.appid <= 0 || !link.segment) {
			throw marketError(400, '链接中缺少有效的 appid 或物品名');
		}
		if (!isGroupId(link.segment)) {
			const zh = link.appid === 730 ? options.names?.zh(link.segment) ?? null : null;
			return {items: [{appid: link.appid, marketHashName: link.segment, zh}]};
		}
		if (link.appid !== 730) {
			throw marketError(400, '词库里只有 CS2 的物品,其它游戏的新版分组链接认不出是哪一件,请粘贴带英文名的商品链接');
		}
		let groupName: string;
		try {
			groupName = await client.fetchGroupName({appid: link.appid, groupId: link.segment});
		} catch (err) {
			throw marketError(502, `这是新版市场的分组链接,读取分组名失败(${errorText(err) || '网络错误'}),请直接输名字搜`);
		}
		return {items: searchNames(groupName, false)};
	}

	// ===== 行情参考 =====

	/** 用某账号的 cookie / 币种 / 地区查盘口(最高求购/最低在售)和概览价(成交均价/销量) */
	async function context(query: ContextQuery): Promise<MarketContext> {
		const attempt = findAttempt(query.accountId || query.account);
		if (!attempt) {
			throw marketError(404, '账号不存在或未登录(用 id 或账号名指定)');
		}
		let target: MarketTarget;
		try {
			target = resolveTarget(query);
		} catch (err) {
			throw marketError(400, errorText(err));
		}
		const itemNameId = await nameIds.resolve(target.appid, target.marketHashName, query.itemNameId || query.nameId);
		let result: MarketContext;
		try {
			result = await client.fetchMarketContext({
				...target,
				itemNameId,
				cookies: options.cookiesFor(attempt),
				userAgent: attempt.userAgent,
				currency: attempt.currency,
				country: attempt.country || attempt.loginGeoCountry || 'US'
			});
		} catch (err) {
			throw marketError(502, errorText(err) || '行情获取失败');
		}
		result.currencyISO = currencyIso(attempt);
		nameIds.remember(target.appid, target.marketHashName, result.itemNameId);
		return result;
	}

	// ===== 挂求购 =====

	/**
	 * 多账号挂同一件物品的求购。所选账号钱包币种必须一致(求购价只按一种币种填)。
	 * 每个账号:挂单前快照确认项 → createbuyorder → 要手机确认的 allow 后带 confirmation 重发 → 记账本。
	 */
	async function place(body: PlaceRequest): Promise<{placed: number; failed: number; results: PlaceResult[]}> {
		let target: MarketTarget;
		try {
			target = resolveTarget(body);
		} catch (err) {
			throw marketError(400, errorText(err));
		}

		const keys: unknown[] = Array.isArray(body.accountIds) ? body.accountIds : (Array.isArray(body.accounts) ? body.accounts : []);
		const selected: Attempt[] = [];
		for (const key of keys) {
			const attempt = findAttempt(key);
			if (attempt && !selected.some(item => item.id === attempt.id)) {
				selected.push(attempt);
			}
		}
		if (!selected.length) {
			throw marketError(400, '没有有效的在线账号(用 id 或账号名指定)');
		}

		const perAccountMax = !!body.perAccountMax;
		const pricePerItem = Number(body.pricePerItem);
		if (!Number.isFinite(pricePerItem) || pricePerItem <= 0) {
			throw marketError(400, '每件求购价无效');
		}
		const pricePerItemCents = Math.round(pricePerItem * 100);
		if (pricePerItemCents <= 0) {
			throw marketError(400, '每件求购价过低');
		}
		let quantity = 0;
		if (!perAccountMax) {
			quantity = Math.round(Number(body.quantity));
			if (!Number.isInteger(quantity) || quantity <= 0) {
				throw marketError(400, '求购数量必须为正整数');
			}
		}

		const currencies = selected.map(attempt => Number(attempt.currency));
		if (currencies.some(currency => !Number.isInteger(currency) || currency <= 0)) {
			throw marketError(409, '有账号钱包币种未知,无法挂求购(请确认账号有钱包)');
		}
		if (new Set(currencies).size > 1) {
			throw marketError(409, '所选账号钱包币种不一致,请只选择同一币种的账号下单');
		}

		const itemName = String(body.itemName || '').trim() || target.marketHashName;
		const results = await runWithConcurrency(selected, clampConcurrency(body.concurrency), attempt =>
			placeForAccount(attempt, {target, itemName, pricePerItemCents, quantity, perAccountMax}));
		const placed = results.filter(result => result.ok).length;
		return {placed, failed: results.length - placed, results};
	}

	interface PlaceJob {
		target: MarketTarget;
		itemName: string;
		pricePerItemCents: number;
		quantity: number;
		perAccountMax: boolean;
	}

	async function placeForAccount(attempt: Attempt, job: PlaceJob): Promise<PlaceResult> {
		const base = {account: attempt.accountName, attemptId: attempt.id};
		const cookies = options.cookiesFor(attempt);
		if (!cookies.length) {
			return {...base, ok: false, error: '没有可用的 WebSession cookies,请重新登录'};
		}
		// 挂满模式:数量 = floor(该账号钱包余额 / 单价),各账号互不影响
		let quantity = job.quantity;
		if (job.perAccountMax) {
			const balance = Number(attempt.balance);
			if (!attempt.hasWallet || attempt.balance == null || !Number.isFinite(balance)) {
				return {...base, ok: false, error: '钱包余额未知,无法按余额挂满(请刷新账户/确认账号有钱包)'};
			}
			quantity = Math.floor(Math.round(balance * 100) / job.pricePerItemCents);
			if (quantity <= 0) {
				return {...base, ok: false, error: `钱包余额 ${balance.toFixed(2)} 不足以按当前单价求购 1 件`};
			}
		}
		const priceTotalCents = job.pricePerItemCents * quantity;

		try {
			// 挂单前快照已有的确认项,挂单后新冒出来的那条就是本单(见 ./confirmations.ts)。只对有 maFile 的账号做
			let priorConfIds: Set<string> | null = null;
			if (attempt.identitySecret) {
				try {
					priorConfIds = await confirmer.listConfirmationIds({cookies, identitySecret: attempt.identitySecret});
				} catch {
					priorConfIds = null;
				}
			}

			const createParams: CreateBuyOrderParams = {
				cookies,
				sessionid: attempt.webSessionID,
				userAgent: attempt.userAgent,
				appid: job.target.appid,
				marketHashName: job.target.marketHashName,
				currency: attempt.currency,
				priceTotalCents,
				quantity
			};
			const first = await client.createBuyOrder(createParams);

			let buyOrderId = first.buyOrderId;
			let confirmed = !first.needsConfirmation;
			let confirmError = '';
			if (first.needsConfirmation) {
				if (!attempt.identitySecret) {
					confirmError = '已提交求购但需手机确认,该账号未导入 maFile(identity_secret)。请导入 maFile 后重试,或在 Steam 手机 App 手动确认';
				} else if (!first.confirmationId && !first.buyOrderId && priorConfIds === null) {
					confirmError = '已提交求购但需手机确认,且无法定位确认项(无 confirmation_id/buy_orderid 且确认列表读取失败),请在 Steam 手机 App 手动确认';
				} else {
					try {
						await confirmer.confirmBuyOrder({
							cookies,
							identitySecret: attempt.identitySecret,
							confirmationId: first.confirmationId,
							buyOrderId: first.buyOrderId,
							priorConfIds
						});
						// 带 confirmation 重发,Steam 这时才真正落单、返回 buy_orderid。只 allow 不重发,订单会被丢弃
						for (let i = 0; i < RESEND_ATTEMPTS; i++) {
							const again = await client.createBuyOrder({...createParams, confirmation: first.confirmationId});
							if (again.buyOrderId) {
								buyOrderId = again.buyOrderId;
								confirmed = true;
								break;
							}
							if (!again.needsConfirmation) {
								break;   // 既没给 buy_orderid 也不再要确认:状态不对,别再重发
							}
							await sleep(RESEND_GAP_MS);
						}
						if (!confirmed) {
							confirmError = '已手机确认,但带 confirmation 重发仍未拿到 buy_orderid(确认可能尚未生效),请稍后在网页端「我的求购单」核对';
						}
					} catch (err) {
						confirmError = '已提交求购但自动确认/最终下单失败:' + (errorText(err) || '未知错误') + '(可在 Steam 手机 App 手动确认)';
					}
				}
			}

			let recordId = '';
			if (buyOrderId) {
				const record: BuyOrderRecord = {
					id: randomId(),
					createdAt: new Date(now()).toISOString(),
					account: attempt.accountName,
					attemptId: attempt.id,
					steamID: attempt.steamID || '',
					appid: job.target.appid,
					marketHashName: job.target.marketHashName,
					itemName: job.itemName,
					currency: Number(attempt.currency),
					currencyISO: currencyIso(attempt),
					pricePerItemCents: job.pricePerItemCents,
					quantity,
					priceTotalCents,
					buyOrderId,
					status: confirmed ? 'active' : 'pending_confirm'
				};
				ledger.add(record);
				recordId = record.id;
			}

			if (confirmed) {
				return {...base, ok: true, buyOrderId, recordId};
			}
			return {...base, ok: false, buyOrderId, recordId, needsConfirmation: true, error: confirmError || '求购单待手机确认'};
		} catch (err) {
			return {...base, ok: false, error: errorText(err) || '挂求购失败'};
		}
	}

	// ===== 撤单 =====

	/** 撤求购:按账本记录 id,或直接给账号 + buy_orderid。成功后从账本删掉 */
	async function cancel(body: CancelRequest): Promise<void> {
		let attempt: Attempt | null;
		let buyOrderId: string;
		if (body.id) {
			const record = ledger.find(String(body.id));
			if (!record) {
				throw marketError(404, '账本中找不到该求购记录');
			}
			buyOrderId = record.buyOrderId;
			attempt = findAttempt(record.account) || findAttempt(record.attemptId);
		} else {
			buyOrderId = String(body.buyOrderId || '').trim();
			attempt = findAttempt(body.accountId || body.account);
		}

		if (!buyOrderId) {
			throw marketError(400, '该记录没有 buy_orderid,无法撤单');
		}
		if (!attempt) {
			throw marketError(409, '对应账号未在线,无法撤单(请登录该账号后重试)');
		}
		const cookies = options.cookiesFor(attempt);
		if (!cookies.length) {
			throw marketError(409, '账号没有可用的 WebSession cookies,请重新登录');
		}
		try {
			await client.cancelBuyOrder({cookies, sessionid: attempt.webSessionID, userAgent: attempt.userAgent, buyOrderId});
		} catch (err) {
			throw marketError(502, errorText(err) || '撤销失败');
		}
		ledger.removeBuyOrder(buyOrderId);
	}

	// ===== 对账 =====

	/**
	 * 逐账号从 Steam 实拉真实求购单,和账本对账(见 ledger.reconcile)。
	 * 前端总是传 accounts(左侧选中的在线账号):不传就会把账本里早已登出的历史账号也捞一遍,报一堆「未在线」。
	 */
	async function sync(body: SyncRequest): Promise<ReconcileResult & {syncedAccounts: string[]; accounts: SyncAccountResult[]}> {
		const since = now();
		const requested = Array.isArray(body.accounts) ? body.accounts.map(value => String(value || '').trim()).filter(Boolean) : [];
		// 传进来的可能是 attemptId,统一换成账号名,好和账本里的 account 对上
		const names = requested.length
			? [...new Set(requested.map(key => findAttempt(key)?.accountName || key))]
			: [...new Set(ledger.list().map(record => record.account).filter(Boolean))];

		const pulled = await runWithConcurrency(names, clampConcurrency(body.concurrency), async (name): Promise<SyncAccountResult & {orders?: LiveBuyOrder[]}> => {
			const attempt = findAttempt(name);
			if (!attempt) {
				return {account: name, ok: false, error: '未在线'};
			}
			const cookies = options.cookiesFor(attempt);
			if (!cookies.length) {
				return {account: name, ok: false, error: '无可用 cookie(请重新登录)'};
			}
			try {
				const orders = await client.fetchMyBuyOrders({cookies, sessionid: attempt.webSessionID, userAgent: attempt.userAgent});
				return {account: name, ok: true, count: orders.length, orders};
			} catch (err) {
				return {account: name, ok: false, error: errorText(err) || '读取失败'};
			}
		});

		const live = new Map<string, Map<string, LiveBuyOrder>>();
		for (const result of pulled) {
			if (result.orders) {
				live.set(result.account, new Map(result.orders.map(order => [String(order.buyOrderId), order])));
			}
		}
		const accounts = pulled.map(({orders, ...result}) => result);
		return {
			...ledger.reconcile(live, since),
			// 前端把面板限定为这些刚对过账的账号的求购单;其它历史记录仍留在账本里(撤单/下次对账要用)
			syncedAccounts: accounts.filter(result => result.ok).map(result => result.account),
			accounts
		};
	}

	return {search, context, place, orders: ledger.list, cancel, sync};
}

export type MarketService = ReturnType<typeof createMarketService>;
