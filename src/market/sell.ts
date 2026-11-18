// 市场出售:选一个账号 → 列可上架的库存 → 每件填价(买家价或到手价,手续费见 ./fees.ts)→ 逐件上架 →
// 有 maFile 的只确认「这一批」上架的手机确认项;我的在售(多账号)、下架、成交记录。
// 由 ./index.ts 的 createMarketService 组装(会话、cookies、行情参考从那里来),路由在 ./routes.ts。
//
// 只确认本批的做法:sellitem 不返回 listingid,上架完读一次 mylistings,listings_to_confirm 里按 assetid
// (上架前的 unowned_id 或 id)对上本批的物品,拿到 listingid;再读手机确认列表,只接受 creator_id 等于这些 listingid 的
// (市场上架确认 type=3)。别的待确认项(其它上架、交易报价、求购)一概不碰;对不上的留给用户在手机上确认。

import {fetchCommunityInventory} from '../inventory/community.ts';
import type {InventoryItem} from '../inventory/community.ts';
import {isAttemptUsableForCookieFlow} from '../steam/attempts.ts';
import type {Confirmer} from '../steam/confirmations.ts';
import {currencyIdToIso} from '../steam/currencies.ts';
import type {Attempt} from '../steam/session-manager.ts';
import type {MarketContext, MarketLog} from './client.ts';
import {clampConcurrency, runWithConcurrency} from './concurrency.ts';
import {DEFAULT_FEES, buyerPriceForReceive, receiveForBuyerPrice} from './fees.ts';
import type {FeeBreakdown, FeeConfig} from './fees.ts';
import {createSellClient} from './sell-client.ts';
import type {HistoryEvent, MyListing, SellClient} from './sell-client.ts';

/** 一次最多上架几件 */
const MAX_BATCH = 50;
/** 两次 sellitem 之间隔多久(Steam 对连续上架限流) */
const SELL_GAP_MS = 1500;
/** 找本批确认项:最多查几轮、间隔多久(上架后确认项 / listings_to_confirm 可能稍晚才出现) */
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_GAP_MS = 3000;
/** 库存缓存多久(上架时总是重新拉) */
const INVENTORY_TTL_MS = 30 * 1000;
/** 市场上架确认在 mobileconf 里的 type */
const CONF_TYPE_MARKET_LISTING = 3;
/** 买家价上限(分)。Steam 的上限按币种不同,这里只知道美元的(2000.00);其它币种只拦 int32 溢出,超了由 Steam 拒绝 */
const MAX_BUYER_PRICE_CENTS: Readonly<Record<number, number>> = {1: 200000};
const INT32_MAX = 2147483647;
const HISTORY_MAX_COUNT = 100;

/** 手机确认:读列表 + 确认几条 */
export type SellConfirmer = Pick<Confirmer, 'listConfirmations' | 'respondToConfirmations'>;

export interface SellInventoryFetchParams {
	steamID: string;
	cookies: readonly string[];
	userAgent?: string;
	appid: number;
	contextid: string;
}

export interface SellServiceOptions {
	findAttempt(key: unknown): Attempt | null;
	cookiesFor(attempt: Attempt): string[];
	deviceIdFor?: (accountName: string) => string;
	/** 行情参考(./index.ts 的 context:按账号币种查最低在售 / 最高求购) */
	context(query: {account: unknown; appid: unknown; marketHashName: unknown}): Promise<MarketContext>;
	/** CS2 英文名 → 中文名(词库);没有为 null */
	zhOf?: (appid: number, marketHashName: string) => string | null;
	/** 发行商费率,默认 0.10 */
	publisherFeePercent?: (appid: number) => number;
	client?: SellClient;
	confirmer: SellConfirmer;
	/** 拉社区库存(测试注入);默认 ../inventory/community.ts */
	fetchInventory?: (params: SellInventoryFetchParams) => Promise<InventoryItem[]>;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	log?: MarketLog;
	sellGapMs?: number;
	confirmGapMs?: number;
	confirmAttempts?: number;
}

export interface SellableItem {
	appid: number;
	contextid: string;
	assetid: string;
	amount: number;
	marketHashName: string;
	/** Steam 给的名字(库存按简体中文拉) */
	name: string;
	/** 词库里的中文名;没有为 null */
	zh: string | null;
	icon: string;
	type: string;
	rarity: string;
	rarityColor: string;
	exterior: string;
	marketable: boolean;
	tradable: boolean;
	/** 交易 / 上架冷却到什么时候(ISO);没有为 null */
	cooldownUntil: string | null;
}

export type SellStatus = 'listed' | 'pending_confirmation' | 'failed';

export interface SellItemOutcome {
	appid: number;
	contextid: string;
	assetid: string;
	amount: number;
	marketHashName: string;
	name: string;
	status: SellStatus;
	/** 上架确认项 / 在售单的 listingid;对不上为 undefined */
	listingId?: string;
	buyerPriceCents: number;
	receivePriceCents: number;
	message: string;
}

export interface ListingsAccountResult {
	account: string;
	ok: boolean;
	error?: string;
	currency?: {id: number; iso: string};
	counts?: {active: number; toConfirm: number; onHold: number};
	listings?: MyListing[];
}

function sellError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : '';
}

function positiveInt(value: unknown): number | null {
	if (value === '' || value == null || typeof value === 'boolean') {
		return null;
	}
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function digits(value: unknown): string {
	const text = String(value ?? '').trim();
	return /^\d{1,20}$/.test(text) ? text : '';
}

interface Seller {
	attempt: Attempt;
	cookies: string[];
}

export function createSellService(options: SellServiceOptions) {
	const log: MarketLog = options.log ?? (() => {});
	const client = options.client ?? createSellClient({fetch: options.fetch, log});
	const confirmer = options.confirmer;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	const sellGapMs = options.sellGapMs ?? SELL_GAP_MS;
	const confirmGapMs = options.confirmGapMs ?? CONFIRM_GAP_MS;
	const confirmAttempts = options.confirmAttempts ?? CONFIRM_ATTEMPTS;
	const fetchInventory = options.fetchInventory ?? (async (params: SellInventoryFetchParams) =>
		(await fetchCommunityInventory({...params, gcItemsByAssetId: null}, options.fetch, now)).items);
	const inventoryCache = new Map<string, {at: number; items: SellableItem[]}>();

	function feesFor(appid: number): FeeConfig {
		const publisher = Number(options.publisherFeePercent?.(appid));
		return {...DEFAULT_FEES, publisherFeePercent: Number.isFinite(publisher) && publisher >= 0 ? publisher : DEFAULT_FEES.publisherFeePercent};
	}

	function currencyOf(attempt: Attempt): {id: number; iso: string} {
		const id = Number(attempt.currency) || 0;
		return {id, iso: String(attempt.currencyISO || currencyIdToIso(id) || '').toUpperCase()};
	}

	/** 按 id 或账号名找能走网页流程的会话;找不到 404,没 cookie / SteamID 409 */
	function seller(key: unknown): Seller {
		const attempt = options.findAttempt(String(key ?? '').trim());
		if (!attempt || !isAttemptUsableForCookieFlow(attempt)) {
			throw sellError(404, '账号不存在或未登录(用 id 或账号名指定)');
		}
		const cookies = options.cookiesFor(attempt);
		if (!cookies.length) {
			throw sellError(409, '账号没有可用的 WebSession cookies,请重新登录');
		}
		if (!attempt.steamID) {
			throw sellError(409, '账号缺少 SteamID,请重新登录');
		}
		return {attempt, cookies};
	}

	function webSession(s: Seller) {
		return {cookies: s.cookies, sessionid: s.attempt.webSessionID, userAgent: s.attempt.userAgent};
	}

	function toSellable(item: InventoryItem, appid: number, contextid: string): SellableItem {
		const marketHashName = String(item.marketHashName || '');
		return {
			appid,
			contextid,
			assetid: String(item.assetid),
			amount: Number(item.amount) || 1,
			marketHashName,
			name: String(item.name || marketHashName),
			zh: marketHashName ? options.zhOf?.(appid, marketHashName) ?? null : null,
			icon: String(item.iconUrl || ''),
			type: String(item.type || ''),
			rarity: String(item.rarity || ''),
			rarityColor: String(item.rarityColor || ''),
			exterior: String(item.exterior || ''),
			marketable: item.marketable !== false && !!marketHashName,
			tradable: !!item.tradable,
			cooldownUntil: item.tradableAfter && Date.parse(item.tradableAfter) > now() ? item.tradableAfter : null
		};
	}

	async function loadInventory(s: Seller, appid: number, contextid: string, refresh: boolean): Promise<SellableItem[]> {
		const key = `${s.attempt.id}|${appid}|${contextid}`;
		const cached = inventoryCache.get(key);
		if (!refresh && cached && now() - cached.at < INVENTORY_TTL_MS) {
			return cached.items;
		}
		let raw: InventoryItem[];
		try {
			raw = await fetchInventory({steamID: s.attempt.steamID, cookies: s.cookies, userAgent: s.attempt.userAgent, appid, contextid});
		} catch (err) {
			const status = Number((err as {statusCode?: number})?.statusCode) || 502;
			throw sellError(status, `库存读取失败:${errorText(err) || '未知错误'}`);
		}
		const items = raw.map(item => toSellable(item, appid, contextid));
		inventoryCache.set(key, {at: now(), items});
		return items;
	}

	function forgetInventory(attempt: Attempt): void {
		for (const key of inventoryCache.keys()) {
			if (key.startsWith(attempt.id + '|')) {
				inventoryCache.delete(key);
			}
		}
	}

	function gameOf(query: {appid?: unknown; contextid?: unknown}): {appid: number; contextid: string} {
		const appid = query.appid == null || query.appid === '' ? 730 : positiveInt(query.appid);
		const contextid = query.contextid == null || query.contextid === '' ? '2' : digits(query.contextid);
		if (!appid || !contextid) {
			throw sellError(400, 'appid / contextid 无效');
		}
		return {appid, contextid};
	}

	// ===== 可上架的库存 =====

	/** 某账号某游戏的库存(全部物品,marketable 标出能不能上架)和手续费参数 */
	async function inventory(query: {account?: unknown; accountId?: unknown; appid?: unknown; contextid?: unknown; refresh?: unknown}) {
		const s = seller(query.account || query.accountId);
		const {appid, contextid} = gameOf(query);
		const items = await loadInventory(s, appid, contextid, query.refresh === '1' || query.refresh === true || query.refresh === 'true');
		const fees = feesFor(appid);
		return {
			account: s.attempt.accountName,
			appid,
			contextid,
			currency: currencyOf(s.attempt),
			fees,
			publisherFeePercent: fees.publisherFeePercent,
			total: items.length,
			marketableCount: items.filter(item => item.marketable).length,
			items
		};
	}

	// ===== 参考价 / 手续费 =====

	function splitOrNull(buyerCents: number | null, fees: FeeConfig): FeeBreakdown | null {
		if (buyerCents == null || buyerCents < 3) {
			return null;
		}
		const split = receiveForBuyerPrice(buyerCents, fees);
		return split.receive >= 1 ? split : null;
	}

	/** 一件物品的参考价:最低在售 / 最高求购(账号币种),各自拆出到手价 */
	async function price(query: {account?: unknown; accountId?: unknown; appid?: unknown; marketHashName?: unknown}) {
		const s = seller(query.account || query.accountId);
		const {appid} = gameOf({appid: query.appid});
		const marketHashName = String(query.marketHashName ?? '').trim();
		if (!marketHashName) {
			throw sellError(400, '缺少 marketHashName');
		}
		const context = await options.context({account: s.attempt.id, appid, marketHashName});
		const fees = feesFor(appid);
		return {
			context,
			currency: currencyOf(s.attempt),
			fees,
			lowestSell: splitOrNull(context.lowestSellOrderCents, fees),
			highestBuyOrder: splitOrNull(context.highestBuyOrderCents, fees)
		};
	}

	/** 按买家价或到手价算另一边(和前端移植的 fees.ts 对账用) */
	function quote(input: {buyerPriceCents?: unknown; receivePriceCents?: unknown; appid?: unknown; publisherFeePercent?: unknown}): FeeBreakdown {
		const fees = input.publisherFeePercent != null && input.publisherFeePercent !== ''
			? {...DEFAULT_FEES, publisherFeePercent: Number(input.publisherFeePercent)}
			: feesFor(positiveInt(input.appid) ?? 730);
		if (!Number.isFinite(fees.publisherFeePercent) || fees.publisherFeePercent < 0 || fees.publisherFeePercent > 1) {
			throw sellError(400, 'publisherFeePercent 无效(0~1)');
		}
		return priceOf(input, fees, 0);
	}

	/** 校验一件的价格:买家价 / 到手价二选一,正整数分;到手至少 1 分;买家价不超上限 */
	function priceOf(input: {buyerPriceCents?: unknown; receivePriceCents?: unknown}, fees: FeeConfig, currency: number, label = ''): FeeBreakdown {
		const hasBuyer = input.buyerPriceCents != null && input.buyerPriceCents !== '';
		const hasReceive = input.receivePriceCents != null && input.receivePriceCents !== '';
		if (hasBuyer === hasReceive) {
			throw sellError(400, `${label}买家价(buyerPriceCents)和到手价(receivePriceCents)要填且只填一个`);
		}
		const cents = positiveInt(hasBuyer ? input.buyerPriceCents : input.receivePriceCents);
		if (!cents || cents > INT32_MAX) {
			throw sellError(400, `${label}价格必须是正整数(钱包币种的分)`);
		}
		const split = hasBuyer ? receiveForBuyerPrice(cents, fees) : buyerPriceForReceive(cents, fees);
		if (split.receive < 1) {
			throw sellError(400, `${label}价格过低:到手至少 1 分(买家价至少 3 分)`);
		}
		const max = MAX_BUYER_PRICE_CENTS[currency] ?? INT32_MAX;
		if (split.buyerPrice > max) {
			throw sellError(400, `${label}买家价超过 Steam 上限(${max} 分)`);
		}
		return split;
	}

	// ===== 上架 =====

	interface Job extends SellItemOutcome {
		/** 上架时要手机确认、还没确认 */
		awaitingMobile: boolean;
	}

	interface SellRequestItem {
		appid?: unknown;
		contextid?: unknown;
		assetid?: unknown;
		amount?: unknown;
		buyerPriceCents?: unknown;
		receivePriceCents?: unknown;
	}

	/**
	 * 一个账号上架一批:先校验价格(任何一件不对整批 400,不发请求)→ 重新拉库存核对每件能上架 →
	 * 逐件 sellitem(中间隔 sellGapMs,一件失败不影响别的)→ 要手机确认的:有 maFile 且 autoConfirm 时只确认本批的。
	 */
	async function sell(body: {account?: unknown; accountId?: unknown; items?: unknown; autoConfirm?: unknown}) {
		const s = seller(body.account || body.accountId);
		const currency = currencyOf(s.attempt);
		if (!currency.id) {
			throw sellError(409, '账号钱包币种未知,无法上架(账号要有 Steam 钱包)');
		}
		const rawItems: SellRequestItem[] = Array.isArray(body.items) ? body.items : [];
		if (!rawItems.length) {
			throw sellError(400, '请选择要上架的物品(items)');
		}
		if (rawItems.length > MAX_BATCH) {
			throw sellError(400, `一次最多上架 ${MAX_BATCH} 件`);
		}
		const autoConfirm = body.autoConfirm !== false;

		const jobs: Job[] = [];
		const seen = new Set<string>();
		rawItems.forEach((raw, index) => {
			const label = `第 ${index + 1} 件:`;
			const {appid, contextid} = (() => {
				try {
					return gameOf(raw ?? {});
				} catch {
					throw sellError(400, `${label}appid / contextid 无效`);
				}
			})();
			const assetid = digits(raw?.assetid);
			if (!assetid) {
				throw sellError(400, `${label}assetid 无效`);
			}
			const amount = raw?.amount == null || raw.amount === '' ? 1 : positiveInt(raw.amount);
			if (!amount) {
				throw sellError(400, `${label}数量(amount)必须是正整数`);
			}
			const key = `${appid}|${contextid}|${assetid}`;
			if (seen.has(key)) {
				throw sellError(400, `${label}物品 ${assetid} 重复`);
			}
			seen.add(key);
			const split = priceOf(raw ?? {}, feesFor(appid), currency.id, label);
			jobs.push({
				appid, contextid, assetid, amount, marketHashName: '', name: '', status: 'failed',
				buyerPriceCents: split.buyerPrice, receivePriceCents: split.receive, message: '', awaitingMobile: false
			});
		});

		// 用最新库存核对:是这个账号的、能上架、数量够
		const games = [...new Set(jobs.map(job => `${job.appid}|${job.contextid}`))];
		const owned = new Map<string, SellableItem>();
		for (const game of games) {
			const [appid, contextid] = game.split('|') as [string, string];
			for (const item of await loadInventory(s, Number(appid), contextid, true)) {
				owned.set(`${item.appid}|${item.contextid}|${item.assetid}`, item);
			}
		}

		let calledSteam = false;
		for (const job of jobs) {
			const item = owned.get(`${job.appid}|${job.contextid}|${job.assetid}`);
			if (!item) {
				job.message = '库存里没有这件物品(可能已上架、已交易或库存还没刷新)';
				continue;
			}
			job.marketHashName = item.marketHashName;
			job.name = item.name;
			if (!item.marketable) {
				job.message = item.cooldownUntil ? `这件物品暂时不能上架(冷却到 ${item.cooldownUntil})` : '这件物品不能在市场出售';
				continue;
			}
			if (job.amount > item.amount) {
				job.message = `数量超出库存(只有 ${item.amount} 个)`;
				continue;
			}
			if (calledSteam && sellGapMs > 0) {
				await sleep(sellGapMs);
			}
			calledSteam = true;
			try {
				const result = await client.sellItem({
					...webSession(s), steamID: s.attempt.steamID,
					appid: job.appid, contextid: job.contextid, assetid: job.assetid, amount: job.amount, receiveCents: job.receivePriceCents
				});
				if (!result.ok) {
					job.message = result.message;
				} else if (result.needsEmailConfirmation) {
					job.status = 'pending_confirmation';
					job.message = '需要在邮箱里确认上架(Steam 已发确认邮件)';
				} else if (result.needsMobileConfirmation) {
					job.status = 'pending_confirmation';
					job.awaitingMobile = true;
					job.message = '需要在手机上确认';
				} else {
					job.status = 'listed';
					job.message = '已上架';
				}
			} catch (err) {
				job.message = errorText(err) || '上架失败';
			}
		}
		if (calledSteam) {
			forgetInventory(s.attempt);
		}

		let confirmed = 0;
		const waiting = jobs.filter(job => job.awaitingMobile);
		if (waiting.length) {
			const canConfirm = autoConfirm && !!s.attempt.identitySecret;
			confirmed = await settleConfirmations(s, waiting, canConfirm);
			if (!s.attempt.identitySecret) {
				waiting.filter(job => job.status === 'pending_confirmation').forEach(job => {
					job.message = '需要在手机上确认(该账号未导入 maFile,不能自动确认)';
				});
			} else if (!autoConfirm) {
				waiting.filter(job => job.status === 'pending_confirmation').forEach(job => {
					job.message = '需要在手机上确认(本次未开自动确认)';
				});
			}
		}

		const results: SellItemOutcome[] = jobs.map(({awaitingMobile, ...outcome}) => outcome);
		const count = (status: SellStatus) => results.filter(result => result.status === status).length;
		return {
			account: s.attempt.accountName,
			currency,
			results,
			listed: count('listed'),
			pendingConfirmation: count('pending_confirmation'),
			failed: count('failed'),
			confirmed,
			needsMobile: results.some(result => result.status === 'pending_confirmation')
		};
	}

	/**
	 * 给等手机确认的几件找 listingid(listings_to_confirm 按 assetid 对),能确认就只确认 creator_id 是这些 listingid 的确认项。
	 * 返回确认了几件;出错不抛,写进各件的 message
	 */
	async function settleConfirmations(s: Seller, waiting: Job[], canConfirm: boolean): Promise<number> {
		const confirmAs = {
			cookies: s.cookies,
			identitySecret: s.attempt.identitySecret,
			steamID: s.attempt.steamID,
			deviceId: options.deviceIdFor?.(s.attempt.accountName) || '',
			userAgent: s.attempt.userAgent,
			log
		};
		const rounds = canConfirm ? Math.max(1, confirmAttempts) : 1;
		let confirmed = 0;
		let lastError = '';
		for (let round = 0; round < rounds; round++) {
			const open = waiting.filter(job => job.awaitingMobile);
			if (!open.length) {
				break;
			}
			if (round > 0) {
				await sleep(confirmGapMs);
			}
			try {
				if (open.some(job => !job.listingId)) {
					const pending = (await client.fetchMyListings(webSession(s))).filter(listing => listing.status === 'to_confirm');
					for (const job of open.filter(job => !job.listingId)) {
						const match = pending.find(listing => listing.appid === job.appid
							&& (listing.originalAssetid === job.assetid || listing.assetid === job.assetid));
						if (match) {
							job.listingId = match.listingId;
						}
					}
				}
				if (!canConfirm) {
					break;
				}
				const ids = new Set(open.map(job => job.listingId).filter((id): id is string => !!id));
				if (!ids.size) {
					continue;
				}
				const confirmations = await confirmer.listConfirmations(confirmAs);
				lastError = '';
				const mine = confirmations.filter(conf => ids.has(conf.creator)
					&& (conf.type == null || conf.type === '' || Number(conf.type) === CONF_TYPE_MARKET_LISTING));
				if (!mine.length) {
					continue;
				}
				await confirmer.respondToConfirmations({...confirmAs, confirmations: mine, accept: true});
				const done = new Set(mine.map(conf => conf.creator));
				for (const job of open) {
					if (job.listingId && done.has(job.listingId)) {
						job.awaitingMobile = false;
						job.status = 'listed';
						job.message = '已上架(已自动手机确认)';
						confirmed++;
					}
				}
				log('info', `[market-sell] ${s.attempt.accountName} 自动确认了本批 ${mine.length} 个上架(listingid ${[...done].join(',')})`);
			} catch (err) {
				lastError = errorText(err) || '未知错误';
				log('warn', `[market-sell] ${s.attempt.accountName} 上架确认出错:${lastError}`);
			}
		}
		if (canConfirm) {
			for (const job of waiting.filter(job => job.awaitingMobile)) {
				job.message = lastError
					? `已提交上架,但自动确认失败:${lastError}(请在手机上确认)`
					: job.listingId
						? '已提交上架,但没找到对应的手机确认项,请在手机上确认'
						: '已提交上架,但在待确认列表里没找到这件,请在手机上确认';
			}
		}
		return confirmed;
	}

	// ===== 我的在售 =====

	async function listings(body: {accounts?: unknown; concurrency?: unknown}): Promise<{accounts: ListingsAccountResult[]}> {
		const keys = Array.isArray(body.accounts) ? [...new Set(body.accounts.map(value => String(value ?? '').trim()).filter(Boolean))] : [];
		if (!keys.length) {
			throw sellError(400, '请选择账号(accounts)');
		}
		const accounts = await runWithConcurrency(keys, clampConcurrency(body.concurrency), async (key): Promise<ListingsAccountResult> => {
			let s: Seller;
			try {
				s = seller(key);
			} catch (err) {
				return {account: key, ok: false, error: errorText(err)};
			}
			try {
				const list = await client.fetchMyListings(webSession(s));
				const count = (status: MyListing['status']) => list.filter(listing => listing.status === status).length;
				return {
					account: s.attempt.accountName,
					ok: true,
					currency: currencyOf(s.attempt),
					counts: {active: count('active'), toConfirm: count('to_confirm'), onHold: count('on_hold')},
					listings: list
				};
			} catch (err) {
				return {account: s.attempt.accountName, ok: false, error: errorText(err) || '读取在售失败'};
			}
		});
		return {accounts};
	}

	async function cancelListing(body: {account?: unknown; accountId?: unknown; listingId?: unknown}): Promise<{account: string; listingId: string}> {
		const listingId = digits(body.listingId);
		if (!listingId) {
			throw sellError(400, 'listingId 无效');
		}
		const s = seller(body.account || body.accountId);
		try {
			await client.removeListing({...webSession(s), listingId});
		} catch (err) {
			throw sellError(502, errorText(err) || '下架失败');
		}
		forgetInventory(s.attempt);
		return {account: s.attempt.accountName, listingId};
	}

	// ===== 成交记录 =====

	async function history(body: {account?: unknown; accountId?: unknown; start?: unknown; count?: unknown}): Promise<{account: string; currency: {id: number; iso: string}; start: number; count: number; totalCount: number; events: HistoryEvent[]}> {
		const s = seller(body.account || body.accountId);
		const start = body.start == null || body.start === '' ? 0 : Number(body.start);
		const count = body.count == null || body.count === '' ? 50 : Number(body.count);
		if (!Number.isSafeInteger(start) || start < 0) {
			throw sellError(400, 'start 必须是非负整数');
		}
		if (!Number.isSafeInteger(count) || count < 1 || count > HISTORY_MAX_COUNT) {
			throw sellError(400, `count 必须是 1~${HISTORY_MAX_COUNT} 的整数`);
		}
		let page;
		try {
			page = await client.fetchMyHistory({...webSession(s), start, count});
		} catch (err) {
			throw sellError(502, errorText(err) || '读取成交记录失败');
		}
		return {account: s.attempt.accountName, currency: currencyOf(s.attempt), start, count, totalCount: page.totalCount, events: page.events};
	}

	return {inventory, price, quote, sell, listings, cancelListing, history};
}

export type SellService = ReturnType<typeof createSellService>;
