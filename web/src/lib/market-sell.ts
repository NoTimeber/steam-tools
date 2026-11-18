// 市场出售 / 我的在售 / 成交记录的纯逻辑(不依赖 Vue):后端类型、库存筛选、待上架列表的定价(买家付 ↔ 到手,手续费见 ./market-fees.ts)、
// 合计和提交前检查、在售列表的展开筛选、成交记录的价格和分页。价格一律是钱包币种的分(整数)。

import {buyerPriceForReceive, receiveForBuyerPrice} from './market-fees.ts';
import type {FeeBreakdown, FeeConfig} from './market-fees.ts';
import {formatCentsIn} from './market.ts';
import type {MarketContext} from './market.ts';

export interface WalletCurrency {
	id: number;
	iso: string;
}

/** 后端 src/market/sell.ts 的 SellableItem */
export interface SellableItem {
	appid: number;
	contextid: string;
	assetid: string;
	amount: number;
	marketHashName: string;
	name: string;
	zh: string | null;
	icon: string;
	type: string;
	rarity: string;
	/** #rrggbb 或 '' */
	rarityColor: string;
	exterior: string;
	marketable: boolean;
	tradable: boolean;
	cooldownUntil: string | null;
}

export interface SellInventory {
	account: string;
	appid: number;
	contextid: string;
	currency: WalletCurrency;
	fees: FeeConfig;
	publisherFeePercent: number;
	total: number;
	marketableCount: number;
	items: SellableItem[];
}

export interface SellPrice {
	context: MarketContext;
	currency: WalletCurrency;
	fees: FeeConfig;
	lowestSell: FeeBreakdown | null;
	highestBuyOrder: FeeBreakdown | null;
}

export type SellStatus = 'listed' | 'pending_confirmation' | 'failed';

export interface SellItemOutcome {
	appid?: number;
	contextid?: string;
	assetid: string;
	amount?: number;
	marketHashName: string;
	name: string;
	status: SellStatus;
	listingId?: string;
	buyerPriceCents: number;
	receivePriceCents: number;
	message: string;
}

export interface SellResponse {
	account?: string;
	currency?: WalletCurrency;
	results: SellItemOutcome[];
	listed: number;
	pendingConfirmation: number;
	failed: number;
	confirmed: number;
	needsMobile: boolean;
}

export type ListingStatus = 'active' | 'to_confirm' | 'on_hold';

/** 后端 src/market/sell-client.ts 的 MyListing */
export interface MyListing {
	listingId: string;
	status: ListingStatus;
	appid: number;
	contextid?: string;
	assetid: string;
	amount: number;
	marketHashName: string;
	name: string;
	icon: string;
	buyerPriceCents: number;
	receiveCents: number;
	feeCents: number;
	/** 秒;没有为 0 */
	timeCreated: number;
	createdAt: string;
}

export interface ListingsAccount {
	account: string;
	ok: boolean;
	error?: string;
	currency?: WalletCurrency;
	counts?: {active: number; toConfirm: number; onHold: number};
	listings?: MyListing[];
}

export type HistoryType = 'sold' | 'bought' | 'listed' | 'cancelled' | 'unknown';

export interface HistoryEvent {
	key: string;
	type: HistoryType;
	/** 秒 */
	time: number;
	date: string;
	listingId: string;
	marketHashName: string;
	name: string;
	icon: string;
	buyerPriceCents: number | null;
	receiveCents: number | null;
	counterpart: {steamId: string; persona: string; avatar: string} | null;
}

export interface HistoryPage {
	account?: string;
	currency: WalletCurrency;
	start: number;
	count: number;
	totalCount: number;
	events: HistoryEvent[];
}

/** 一次最多上架几件(后端 MAX_BATCH) */
export const SELL_BATCH_MAX = 50;
/** 后端两次上架之间隔 1.5 秒 */
export const SELL_GAP_SEC = 1.5;

/** 出售页能选的游戏(contextid 都是 2) */
export const SELL_GAMES: ReadonlyArray<{value: number; label: string}> = [
	{value: 730, label: 'CS2'},
	{value: 440, label: 'TF2'}
];

export function money(cents: number | null | undefined, currency: WalletCurrency | null | undefined): string {
	return formatCentsIn(cents, currency?.id, currency?.iso ?? '');
}

/** 主单位的输入框值 → 分;空、非正数为 null */
export function centsOf(value: number | null | undefined): number | null {
	const n = Number(value);
	return value == null || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 100);
}

/** 分 → 主单位(输入框用) */
export function unitsOf(cents: number | null | undefined): number | null {
	return cents == null ? null : cents / 100;
}

/** 秒级时间戳 → 「2026-10-14 09:05」;0 / 空为 '-' */
export function formatUnixTime(seconds: number | null | undefined): string {
	if (!seconds) {
		return '-';
	}
	const d = new Date(seconds * 1000);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ===== 库存(同名物品叠成一组) =====

export function sellKey(item: Pick<SellableItem, 'appid' | 'contextid' | 'assetid'>): string {
	return `${item.appid}|${item.contextid}|${item.assetid}`;
}

export function sellItemLabel(item: Pick<SellableItem, 'zh' | 'name' | 'marketHashName'>): string {
	return item.zh || item.name || item.marketHashName;
}

/** 这一件现在能不能上架:Steam 说可出售,且不在冷却期 */
export function isSellable(item: Pick<SellableItem, 'marketable' | 'cooldownUntil'>): boolean {
	return item.marketable && !item.cooldownUntil;
}

/** 同一游戏、同一英文名的物品叠成一组 */
export interface SellGroup {
	/** appid|英文名 */
	key: string;
	appid: number;
	contextid: string;
	marketHashName: string;
	name: string;
	zh: string | null;
	icon: string;
	exterior: string;
	rarity: string;
	rarityColor: string;
	/** 组里全部资产(按 assetid 从小到大,小的一般是先入库的) */
	items: SellableItem[];
	/** 件数合计(堆叠物品按 amount 算) */
	total: number;
	/** 现在能上架的件数 */
	sellable: number;
	/** 冷却中的件数和最早解除时间 */
	cooldown: number;
	cooldownEarliest: string | null;
}

export function groupKey(item: Pick<SellableItem, 'appid' | 'marketHashName'>): string {
	return `${item.appid}|${item.marketHashName}`;
}

/** assetid 是十进制数字串:先比长度再比字典序,免得超出安全整数 */
function compareAssetId(a: string, b: string): number {
	return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** 库存 → 组,组的顺序按第一次出现的顺序 */
export function groupInventory(items: readonly SellableItem[]): SellGroup[] {
	const groups = new Map<string, SellGroup>();
	for (const item of items) {
		const key = groupKey(item);
		let group = groups.get(key);
		if (!group) {
			group = {
				key, appid: item.appid, contextid: item.contextid, marketHashName: item.marketHashName, name: item.name, zh: item.zh, icon: item.icon,
				exterior: item.exterior, rarity: item.rarity, rarityColor: item.rarityColor, items: [], total: 0, sellable: 0, cooldown: 0, cooldownEarliest: null
			};
			groups.set(key, group);
		}
		const amount = Math.max(1, Number(item.amount) || 1);
		group.items.push(item);
		group.total += amount;
		if (isSellable(item)) {
			group.sellable += amount;
		}
		if (item.cooldownUntil) {
			group.cooldown += amount;
			if (!group.cooldownEarliest || Date.parse(item.cooldownUntil) < Date.parse(group.cooldownEarliest)) {
				group.cooldownEarliest = item.cooldownUntil;
			}
		}
	}
	for (const group of groups.values()) {
		group.items.sort((a, b) => compareAssetId(a.assetid, b.assetid));
	}
	return [...groups.values()];
}

/** 组筛选:文字搜中文名、显示名、英文名(不分大小写);onlyMarketable 只看有能上架的组 */
export function filterGroups(groups: readonly SellGroup[], filter: {text: string; onlyMarketable: boolean}): SellGroup[] {
	const text = filter.text.trim().toLowerCase();
	return groups.filter(group => (!filter.onlyMarketable || group.sellable > 0)
		&& (!text || [group.zh ?? '', group.name, group.marketHashName].some(value => value.toLowerCase().includes(text))));
}

/** 组的冷却说明:「冷却 3 件,最早 2026-10-20 16:00 解除」;没有冷却为 '' */
export function cooldownText(group: Pick<SellGroup, 'cooldown' | 'cooldownEarliest'>): string {
	if (!group.cooldown) {
		return '';
	}
	const at = group.cooldownEarliest ? Date.parse(group.cooldownEarliest) : NaN;
	return `冷却 ${group.cooldown} 件${Number.isNaN(at) ? '' : `,最早 ${formatUnixTime(at / 1000)} 解除`}`;
}

// ===== 待上架列表(一组一行) =====

/** 待上架的一组。价格是单件的:receiveCents 是提交的价(sellitem 的 price),buyerCents 是输入框里的买家付 */
export interface PendingRow {
	/** 组的 key */
	key: string;
	group: SellGroup;
	fees: FeeConfig;
	/** 要卖几件(1..group.sellable) */
	quantity: number;
	buyerCents: number | null;
	receiveCents: number | null;
}

function clampQuantity(value: number | null | undefined, max: number): number {
	const n = Math.floor(Number(value));
	return Math.max(1, Math.min(Math.max(1, max), Number.isFinite(n) ? n : 1));
}

export function newPendingRow(group: SellGroup, fees: FeeConfig, quantity = 1): PendingRow {
	return {key: group.key, group, fees, quantity: clampQuantity(quantity, group.sellable), buyerCents: null, receiveCents: null};
}

/** 改数量:收在 1..可出售 */
export function withQuantity(row: PendingRow, quantity: number | null): PendingRow {
	return {...row, quantity: clampQuantity(quantity, row.group.sellable)};
}

/** 改买家付(单件):按 Steam 的规则反推到手(凑不上的买家价到手少 1 分);买家付低于 3 分没有到手价 */
export function withBuyer(row: PendingRow, buyerCents: number | null): PendingRow {
	if (buyerCents == null || buyerCents < 3) {
		return {...row, buyerCents, receiveCents: null};
	}
	const split = receiveForBuyerPrice(buyerCents, row.fees);
	return {...row, buyerCents, receiveCents: split.receive >= 1 ? split.receive : null};
}

/** 改到手(单件):正算买家付 */
export function withReceive(row: PendingRow, receiveCents: number | null): PendingRow {
	if (receiveCents == null || receiveCents < 1) {
		return {...row, receiveCents: null, buyerCents: null};
	}
	return {...row, receiveCents, buyerCents: buyerPriceForReceive(receiveCents, row.fees).buyerPrice};
}

/** 按到手价上架后买家实际付多少(单件;填的买家价凑不上时会比填的少 1 分) */
export function actualBuyer(row: Pick<PendingRow, 'receiveCents' | 'fees'>): number | null {
	return row.receiveCents == null ? null : buyerPriceForReceive(row.receiveCents, row.fees).buyerPrice;
}

/** 「= 最低在售」/「最低在售 −0.01」:按买家付填;减了之后低于 3 分不填(返回原行) */
export function fillFromLowest(row: PendingRow, lowestBuyerCents: number | null | undefined, minusOne: boolean): PendingRow {
	if (lowestBuyerCents == null) {
		return row;
	}
	const target = lowestBuyerCents - (minusOne ? 1 : 0);
	return target >= 3 ? withBuyer(row, target) : row;
}

/** 合计(单价 × 数量):买家付(按实际)、到手;pieces 是总件数,priced 是定好价的组数 */
export function pendingTotals(rows: readonly PendingRow[]): {buyer: number; receive: number; pieces: number; priced: number} {
	let buyer = 0;
	let receive = 0;
	let pieces = 0;
	let priced = 0;
	for (const row of rows) {
		pieces += row.quantity;
		if (row.receiveCents != null) {
			receive += row.receiveCents * row.quantity;
			buyer += (actualBuyer(row) ?? 0) * row.quantity;
			priced++;
		}
	}
	return {buyer, receive, pieces, priced};
}

/** 提交前检查:有东西、每组定了价、数量在 1..可出售 之间。没问题返回 '' */
export function pendingError(rows: readonly PendingRow[]): string {
	if (!rows.length) {
		return '先在库存里勾选要上架的物品';
	}
	const missing = rows.find(row => row.receiveCents == null || row.receiveCents < 1);
	if (missing) {
		return `${sellItemLabel(missing.group)} 还没定价(买家付至少 0.03)`;
	}
	const over = rows.find(row => row.quantity < 1 || row.quantity > row.group.sellable);
	if (over) {
		return `${sellItemLabel(over.group)} 的数量要在 1 到 ${over.group.sellable} 之间`;
	}
	return '';
}

/** 库存刷新后:待上架的组换成新的(数量按新的可出售件数收紧),组没了或没有可出售的就拿掉 */
export function rebindPending(rows: readonly PendingRow[], groups: readonly SellGroup[]): PendingRow[] {
	const byKey = new Map(groups.map(group => [group.key, group]));
	return rows.flatMap(row => {
		const group = byKey.get(row.key);
		return group && group.sellable > 0 ? [{...row, group, quantity: clampQuantity(row.quantity, group.sellable)}] : [];
	});
}

/** 提交给 POST /api/market/sell 的一件 */
export interface SellRequestItem {
	/** 属于哪一组(不提交,对结果用) */
	groupKey: string;
	appid: number;
	contextid: string;
	assetid: string;
	amount: number;
	receivePriceCents: number;
}

/**
 * 每组按数量展开成要上架的资产:只挑能上架的,assetid 小的先;堆叠资产(amount > 1)一次卖需要的那么多。
 * 同组每件同一个到手价
 */
export function expandPending(rows: readonly PendingRow[]): SellRequestItem[] {
	const out: SellRequestItem[] = [];
	for (const row of rows) {
		let left = row.quantity;
		for (const item of row.group.items) {
			if (left <= 0) {
				break;
			}
			if (!isSellable(item)) {
				continue;
			}
			const amount = Math.min(Math.max(1, Number(item.amount) || 1), left);
			out.push({groupKey: row.key, appid: item.appid, contextid: item.contextid, assetid: item.assetid, amount, receivePriceCents: row.receiveCents ?? 0});
			left -= amount;
		}
	}
	return out;
}

/** 拆成每批不超过 size 件(后端一次最多 50 件) */
export function batchItems<T>(items: readonly T[], size: number = SELL_BATCH_MAX): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		batches.push(items.slice(i, i + size));
	}
	return batches;
}

/** 请求体里的 items(去掉 groupKey) */
export function sellPayload(items: readonly SellRequestItem[]): Array<Omit<SellRequestItem, 'groupKey'>> {
	return items.map(({groupKey: _group, ...item}) => item);
}

/** 上架确认框的文字 */
export function sellConfirmText(account: string, rows: readonly PendingRow[], currency: WalletCurrency | null): string {
	const totals = pendingTotals(rows);
	const requests = expandPending(rows).length;
	const batches = Math.ceil(requests / SELL_BATCH_MAX);
	const seconds = Math.ceil(requests * SELL_GAP_SEC);
	return [
		`将用 ${account} 上架 ${rows.length} 种物品,共 ${totals.pieces} 件:买家共付 ${money(totals.buyer, currency)},扣手续费后到手共 ${money(totals.receive, currency)}。`,
		'导入了 maFile 的账号会自动做手机确认;没导入的账号上架后要在 Steam 手机 App 里逐个确认,否则不会出现在市场上。',
		`服务器每件间隔 ${SELL_GAP_SEC} 秒逐件上架${batches > 1 ? `,分 ${batches} 批(每批最多 ${SELL_BATCH_MAX} 件)` : ''},大约要 ${seconds} 秒,自动确认还要再等一会。`,
		'确定上架?'
	].join('\n');
}

export const SELL_STATUS_LABELS: Record<SellStatus, {label: string; tone: 'success' | 'warning' | 'error'}> = {
	listed: {label: '已上架', tone: 'success'},
	pending_confirmation: {label: '待确认', tone: 'warning'},
	failed: {label: '失败', tone: 'error'}
};

/** 一件提交的结果:outcome 为 null 时是这件没拿到结果(这一批出错,error 是原因) */
export interface SentItem {
	request: SellRequestItem;
	outcome: SellItemOutcome | null;
	error: string;
}

/** 把一批的请求和返回的结果对上(按 assetid);一批出错时这一批每件都记成失败 */
export function matchOutcomes(batch: readonly SellRequestItem[], response: Pick<SellResponse, 'results'> | null, error = ''): SentItem[] {
	return batch.map(request => {
		const outcome = response?.results.find(result => result.assetid === request.assetid) ?? null;
		return {request, outcome, error: outcome ? '' : error || '没有返回这件的结果'};
	});
}

export function sentStatus(sent: SentItem): SellStatus {
	return sent.outcome?.status ?? 'failed';
}

export function sentMessage(sent: SentItem): string {
	return sent.outcome?.message || sent.error;
}

/** 整次上架的汇总(件数按 amount 算) */
export function sentTotals(sent: readonly SentItem[]): {listed: number; pendingConfirmation: number; failed: number} {
	const count = (status: SellStatus) => sent.filter(item => sentStatus(item) === status).reduce((sum, item) => sum + item.request.amount, 0);
	return {listed: count('listed'), pendingConfirmation: count('pending_confirmation'), failed: count('failed')};
}

/** 上架结果汇总:「已上架 3 件,待手机确认 1 件,失败 1 件」 */
export function sellSummary(result: {listed: number; pendingConfirmation: number; failed: number; confirmed?: number}): {text: string; level: 'success' | 'warning' | 'error'} {
	const parts = [`已上架 ${result.listed} 件${result.confirmed ? `(自动确认 ${result.confirmed} 件)` : ''}`];
	if (result.pendingConfirmation) parts.push(`待手机确认 ${result.pendingConfirmation} 件`);
	if (result.failed) parts.push(`失败 ${result.failed} 件`);
	const level = result.failed && !result.listed && !result.pendingConfirmation ? 'error' : result.failed || result.pendingConfirmation ? 'warning' : 'success';
	return {text: parts.join(','), level};
}

/** 一组的结果:件数按 amount 算 */
export interface GroupResult {
	key: string;
	label: string;
	pieces: number;
	listed: number;
	pending: number;
	failed: number;
	details: SentItem[];
}

export function groupResults(rows: readonly PendingRow[], sent: readonly SentItem[]): GroupResult[] {
	return rows.map(row => {
		const details = sent.filter(item => item.request.groupKey === row.key);
		const totals = sentTotals(details);
		return {
			key: row.key, label: sellItemLabel(row.group), pieces: details.reduce((sum, item) => sum + item.request.amount, 0),
			listed: totals.listed, pending: totals.pendingConfirmation, failed: totals.failed, details
		};
	}).filter(result => result.details.length);
}

/** 「AK-47 | 红线 ×5:已上架 4,待确认 0,失败 1」 */
export function groupResultText(result: GroupResult): string {
	return `${result.label} ×${result.pieces}:已上架 ${result.listed},待确认 ${result.pending},失败 ${result.failed}`;
}

/** 提交后:每组只留失败的件数(全部成功的组拿掉;没提交的组原样留着),方便改价重试 */
export function remainingAfterSell(rows: readonly PendingRow[], sent: readonly SentItem[]): PendingRow[] {
	return rows.flatMap(row => {
		const mine = sent.filter(item => item.request.groupKey === row.key);
		if (!mine.length) {
			return [row];
		}
		const failed = sentTotals(mine).failed;
		return failed > 0 ? [{...row, quantity: failed}] : [];
	});
}

// ===== 我的在售 =====

export const LISTING_STATUS_LABELS: Record<ListingStatus, {label: string; tone: 'success' | 'warning' | 'default'}> = {
	active: {label: '在售', tone: 'success'},
	to_confirm: {label: '待确认', tone: 'warning'},
	on_hold: {label: '暂挂', tone: 'default'}
};

export interface ListingRow extends MyListing {
	/** 账号|listingId,表格行 key */
	rowKey: string;
	account: string;
	currency: WalletCurrency | null;
}

export function flattenListings(accounts: readonly ListingsAccount[]): ListingRow[] {
	return accounts.flatMap(entry => (entry.ok ? (entry.listings ?? []) : []).map(listing => ({
		...listing, rowKey: `${entry.account}|${listing.listingId}`, account: entry.account, currency: entry.currency ?? null
	})));
}

/** account / status 为 null 不限 */
export function filterListings(rows: readonly ListingRow[], filter: {account: string | null; status: ListingStatus | null}): ListingRow[] {
	return rows.filter(row => (filter.account == null || row.account === filter.account) && (filter.status == null || row.status === filter.status));
}

export function listingCounts(rows: readonly ListingRow[]): Record<ListingStatus, number> & {total: number} {
	const count = (status: ListingStatus) => rows.filter(row => row.status === status).length;
	return {active: count('active'), to_confirm: count('to_confirm'), on_hold: count('on_hold'), total: rows.length};
}

/** 在售合计:按币种分开(不同币种的账号不能加在一起) */
export function listingTotals(rows: readonly ListingRow[]): Array<{currency: WalletCurrency | null; buyer: number; receive: number}> {
	const groups = new Map<string, {currency: WalletCurrency | null; buyer: number; receive: number}>();
	for (const row of rows) {
		const key = row.currency ? `${row.currency.id}` : '?';
		const group = groups.get(key) ?? {currency: row.currency, buyer: 0, receive: 0};
		group.buyer += row.buyerPriceCents;
		group.receive += row.receiveCents;
		groups.set(key, group);
	}
	return [...groups.values()];
}

// ===== 成交记录 =====

export const HISTORY_TYPE_LABELS: Record<HistoryType, {label: string; tone: 'success' | 'info' | 'warning' | 'default'}> = {
	sold: {label: '卖出', tone: 'success'},
	bought: {label: '买入', tone: 'info'},
	listed: {label: '上架', tone: 'default'},
	cancelled: {label: '下架', tone: 'warning'},
	unknown: {label: '其它', tone: 'default'}
};

/** 显示的价格:买入看买家付,卖出看到手,上架 / 下架看挂的买家价 */
export function historyPrice(event: Pick<HistoryEvent, 'type' | 'buyerPriceCents' | 'receiveCents'>): number | null {
	if (event.type === 'sold') {
		return event.receiveCents ?? event.buyerPriceCents;
	}
	return event.buyerPriceCents;
}

export function filterHistory(events: readonly HistoryEvent[], type: HistoryType | null): HistoryEvent[] {
	return type == null ? [...events] : events.filter(event => event.type === type);
}

/** 分页信息:第几页 / 共几页、能不能翻 */
export function pageInfo(start: number, count: number, totalCount: number): {page: number; pages: number; hasPrev: boolean; hasNext: boolean} {
	const pages = Math.max(1, Math.ceil(totalCount / count));
	return {page: Math.floor(start / count) + 1, pages, hasPrev: start > 0, hasNext: start + count < totalCount};
}
