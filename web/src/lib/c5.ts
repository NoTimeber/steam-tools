// C5 扫货的纯逻辑(不依赖 Vue):后端状态的类型、状态文案、监控列表草稿(改价、添加、删除、改动检测、提交前检查)。
// 饰品按 Steam 英文名(name)存和提交(C5 接口只认它),页面上显示后端词库查到的中文名(zh)。

/** stopped 停止;sweeping 自动扫货(真实下单,没有模拟) */
export type C5RunState = 'stopped' | 'sweeping';
export type C5ItemStatus = 'done' | 'cooldown' | 'noquote' | 'hit' | 'watch';
export type C5PurchaseStatus = 'unknown' | 'ok' | 'failed' | 'cancelled';
export type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';

/** 后端 src/c5/config.ts 的 C5Settings */
export interface C5Settings {
	strategy: 'listing' | 'quick';
	tradeUrl: string;
	maxTotalSpend: number;
	maxBuyPerCycle: number;
	minBalanceReserve: number;
	errorCooldownSec: number;
	pollIntervalSec: number;
	timeoutSec: number;
}

export interface C5WatchItem {
	name: string;
	maxPrice: number;
	maxQty: number;
	maxSpend: number;
	appId: number;
	delivery: number;
	assetType: number;
}

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

export interface C5Purchase {
	outTradeNo: string;
	ts: number;
	name: string;
	zh: string | null;
	productId: string;
	price: number;
	status: C5PurchaseStatus;
	orderId: string | null;
	actualPay: number | null;
	orderStatus: number | null;
	orderStatusName: string | null;
	checkedAt: number;
	error: string | null;
	cost: number;
}

export interface C5LogLine {
	time: number;
	level: 'debug' | 'info' | 'success' | 'warn' | 'error';
	message: string;
}

/** 后端 src/c5/index.ts 的 C5State */
export interface C5State {
	configured: boolean;
	appKeyMasked: string;
	settings: C5Settings;
	settingsError: string | null;
	run: C5RunState;
	cycle: {n: number; at: number | null; error: string | null; errors: number; done: boolean};
	budget: {total: number; spent: number; qty: number};
	balance: {value: number; at: number} | null;
	/** 收货账号;没填交易链接为 null */
	receiver: C5Receiver | null;
	items: C5ItemView[];
	purchases: C5Purchase[];
	unknown: number;
	logs: C5LogLine[];
}

export interface C5CheckResult {
	balance: {money: number | null; settle: number | null; deposit: number | null};
	steamAccounts: C5BoundAccount[];
}

/** C5 账户上绑定的 Steam 账号 */
export interface C5BoundAccount {
	steamId: string;
	nickname: string;
	status: string;
}

/** 后端 src/c5/index.ts 的 C5Receiver:交易链接对应的账号 */
export interface C5Receiver {
	steamId: string;
	account: string | null;
	personaName: string | null;
	c5: C5BoundAccount | null;
	/** false = 还没查过 C5 上绑定了哪些账号 */
	c5Checked: boolean;
}

/** 收货账号下拉:本工具里登录着的账号;c5Bound 为 null 是没查 C5(没填 app-key 或查失败) */
export interface C5ReceiverAccount {
	account: string;
	steamId: string;
	personaName: string;
	c5Bound: boolean | null;
}

export interface C5Receivers {
	accounts: C5ReceiverAccount[];
	/** 查到了 C5 上绑定的账号 */
	checked: boolean;
	bound: C5BoundAccount[];
	boundError: string | null;
}

export interface C5Listing {
	productId: string;
	price: number;
	amount: number;
}

/** 添加饰品的搜索结果(后端 src/c5/index.ts 的 C5NameOption);zh 为 null 是词库里没有、按输入的英文名原样用 */
export interface C5NameOption {
	name: string;
	zh: string | null;
	/** C5 在售最低价、在售数;没查价(没填 app-key、查价失败)或没在售为 null */
	lowest: number | null;
	sellCount: number | null;
}

export interface C5NameSearch {
	options: C5NameOption[];
	priced: boolean;
	priceError: string | null;
}

/** 显示用的饰品名:有中文用中文 */
export function itemLabel(item: {name: string; zh?: string | null}): string {
	return item.zh || item.name;
}

/** 搜索结果里的价格:「¥0.66 · 在售 4」;查过价但没在售时「C5 无在售」;没查价为空 */
export function priceText(option: C5NameOption, priced: boolean): string {
	if (option.lowest != null) {
		return `¥${money(option.lowest)} · 在售 ${option.sellCount ?? '-'}`;
	}
	return priced ? 'C5 无在售' : '';
}

// ===== 收货账号 =====

/** 交易链接里的 partner(账号 id = SteamID64 的低 32 位);不是交易链接返回 null */
export function partnerOf(tradeUrl: string): string | null {
	try {
		const url = new URL(tradeUrl);
		const partner = url.searchParams.get('partner') ?? '';
		return url.hostname === 'steamcommunity.com' && /^\d{1,10}$/.test(partner) ? String(BigInt(partner)) : null;
	} catch {
		return null;
	}
}

function isTradeUrlOf(tradeUrl: string, steamId: string): boolean {
	const partner = partnerOf(tradeUrl);
	return partner != null && /^\d{17}$/.test(steamId) && String(BigInt(steamId) & 0xFFFFFFFFn) === partner;
}

/** 设置里填的交易链接是谁的(页面上手改链接时即时显示;保存后以后端 state.receiver 为准) */
export function describeTradeUrl(tradeUrl: string, receivers: C5Receivers | null): C5Receiver | null {
	const partner = partnerOf(tradeUrl);
	if (partner == null) {
		return null;
	}
	const local = receivers?.accounts.find(account => isTradeUrlOf(tradeUrl, account.steamId)) ?? null;
	const c5 = receivers?.bound.find(account => isTradeUrlOf(tradeUrl, account.steamId)) ?? null;
	return {
		steamId: local?.steamId ?? c5?.steamId ?? String(76561197960265728n + BigInt(partner)),
		account: local?.account ?? null,
		personaName: local?.personaName || null,
		c5,
		c5Checked: !!receivers?.checked
	};
}

/** 收货账号一行字:「alpha(昵称) · SteamID 7656…」;不是本工具的账号只给 SteamID */
export function receiverText(receiver: C5Receiver | null): string {
	if (!receiver) {
		return '未设置';
	}
	const name = receiver.account ? `${receiver.account}${receiver.personaName ? `(${receiver.personaName})` : ''} · ` : '';
	return `${name}SteamID ${receiver.steamId}`;
}

/** 收货账号在 C5 上的情况:没查过返回 null */
export function receiverC5Note(receiver: C5Receiver | null): {text: string; ok: boolean} | null {
	if (!receiver || !receiver.c5Checked) {
		return null;
	}
	if (!receiver.c5) {
		return {text: 'C5 上没绑定这个账号', ok: false};
	}
	return receiver.c5.status === '正常'
		? {text: `C5 已绑定(${receiver.c5.nickname || receiver.c5.steamId})`, ok: true}
		: {text: `C5 上状态:${receiver.c5.status}`, ok: false};
}

// ===== 文案 =====

export const RUN_LABELS: Record<C5RunState, string> = {stopped: '停止', sweeping: '自动扫货'};

export const DELIVERY_OPTIONS = [
	{value: 0, label: '不限'},
	{value: 1, label: '人工发货'},
	{value: 2, label: '自动发货'}
];

export const ASSET_TYPE_OPTIONS = [
	{value: 1, label: '普通在售'},
	{value: 2, label: '冷却期在售'}
];

export function itemStatus(status: C5ItemStatus | 'new'): {label: string; tone: Tone} {
	switch (status) {
		case 'done': return {label: '已买满', tone: 'default'};
		case 'cooldown': return {label: '冷却中', tone: 'warning'};
		case 'noquote': return {label: '无行情', tone: 'default'};
		case 'hit': return {label: '到价', tone: 'success'};
		case 'watch': return {label: '监控中', tone: 'info'};
		default: return {label: '未保存', tone: 'warning'};
	}
}

export function purchaseStatus(status: C5PurchaseStatus): {label: string; tone: Tone} {
	switch (status) {
		case 'ok': return {label: '已成交', tone: 'success'};
		case 'unknown': return {label: '结果未知', tone: 'warning'};
		case 'failed': return {label: '未成交', tone: 'error'};
		default: return {label: '已取消', tone: 'default'};
	}
}

export function money(value: number | null | undefined): string {
	return value == null || !Number.isFinite(value) ? '-' : value.toFixed(2);
}

/** 今天的只显示时分秒,别的日子带上月日 */
export function formatTime(ms: number | null | undefined, now: number = Date.now()): string {
	if (!ms) {
		return '-';
	}
	const date = new Date(ms);
	const time = date.toLocaleTimeString('zh-CN', {hour12: false});
	if (date.toDateString() === new Date(now).toDateString()) {
		return time;
	}
	return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`;
}

export function budgetText(budget: C5State['budget']): string {
	return `${money(budget.spent)} / ${budget.total > 0 ? money(budget.total) : '未设'}`;
}

// ===== 监控列表草稿 =====

/** 表格里正在编辑的一行。origName 为空的是新加的(还没保存);zh 只用来显示,不提交 */
export interface DraftRow {
	uid: string;
	origName: string | null;
	name: string;
	zh: string | null;
	maxPrice: number | null;
	maxQty: number | null;
	maxSpend: number | null;
	appId: number;
	delivery: number;
	assetType: number;
}

export type DraftField = 'name' | 'maxPrice' | 'maxQty' | 'maxSpend' | 'delivery' | 'assetType';
const FIELDS: readonly DraftField[] = ['name', 'maxPrice', 'maxQty', 'maxSpend', 'delivery', 'assetType'];

/** 服务端列表 → 草稿;previous 里同名的行沿用原来的 uid(表格不重建行,输入框不丢焦点) */
export function toDrafts(items: ReadonlyArray<C5WatchItem & {zh?: string | null}>, newUid: () => string, previous: readonly DraftRow[] = []): DraftRow[] {
	return items.map(item => ({
		uid: previous.find(row => row.origName === item.name)?.uid ?? newUid(),
		origName: item.name,
		name: item.name,
		zh: item.zh ?? null,
		maxPrice: item.maxPrice,
		maxQty: item.maxQty,
		maxSpend: item.maxSpend,
		appId: item.appId,
		delivery: item.delivery,
		assetType: item.assetType
	}));
}

function sameValue(field: DraftField, draft: DraftRow, item: C5WatchItem): boolean {
	if (field === 'maxSpend') {
		return (draft.maxSpend ?? 0) === item.maxSpend;
	}
	return draft[field] === item[field];
}

/** 这一行和服务端不一样的格子;新加的行全部算改过 */
export function dirtyFields(draft: DraftRow, items: readonly C5WatchItem[]): Set<DraftField> {
	const item = draft.origName == null ? undefined : items.find(entry => entry.name === draft.origName);
	return new Set(item ? FIELDS.filter(field => !sameValue(field, draft, item)) : FIELDS);
}

/** 草稿里删掉了的服务端饰品 */
export function removedNames(drafts: readonly DraftRow[], items: readonly C5WatchItem[]): string[] {
	return items.map(item => item.name).filter(name => !drafts.some(row => row.origName === name));
}

export function draftsDirty(drafts: readonly DraftRow[], items: readonly C5WatchItem[]): boolean {
	return drafts.length !== items.length
		|| drafts.some((row, index) => row.origName !== items[index]?.name || dirtyFields(row, items).size > 0);
}

export function newDraft(newUid: () => string, init: Partial<Pick<DraftRow, 'name' | 'zh' | 'maxPrice' | 'maxQty' | 'maxSpend'>> = {}): DraftRow {
	return {
		uid: newUid(),
		origName: null,
		name: String(init.name ?? '').trim(),
		zh: init.zh ?? null,
		maxPrice: init.maxPrice ?? null,
		maxQty: init.maxQty ?? null,
		maxSpend: init.maxSpend ?? 0,
		appId: 730,
		delivery: 0,
		assetType: 1
	};
}

/** 提交前在浏览器先查一遍(服务端还会再校验),错了返回原因 */
export function draftPayload(drafts: readonly DraftRow[]): {items: C5WatchItem[]; error: string} {
	const items: C5WatchItem[] = [];
	for (const [index, row] of drafts.entries()) {
		const where = `第 ${index + 1} 行`;
		const name = row.name.trim();
		if (!name) {
			return {items: [], error: `${where}:饰品名不能为空`};
		}
		const shown = row.zh || name;
		if (!(Number(row.maxPrice) > 0)) {
			return {items: [], error: `${shown}:目标价要大于 0`};
		}
		if (!Number.isInteger(row.maxQty) || Number(row.maxQty) < 1) {
			return {items: [], error: `${shown}:数量上限至少 1`};
		}
		if (Number(row.maxSpend ?? 0) < 0) {
			return {items: [], error: `${shown}:花费上限不能是负数`};
		}
		if (items.some(item => item.name === name)) {
			return {items: [], error: `${shown} 重复了`};
		}
		items.push({
			name, maxPrice: Number(row.maxPrice), maxQty: Number(row.maxQty), maxSpend: Number(row.maxSpend ?? 0),
			appId: row.appId, delivery: row.delivery, assetType: row.assetType
		});
	}
	return {items, error: ''};
}

/** 能不能开始自动扫货(和后端 src/c5/config.ts 的 sweepBlocker 一样):能返回 null,不能返回原因 */
export function sweepBlocker(settings: C5Settings): string | null {
	if (!settings.tradeUrl) {
		return '没填收货账号的交易链接';
	}
	if (!(settings.maxTotalSpend > 0)) {
		return '没设总预算(要大于 0)';
	}
	return null;
}

/** 开始自动扫货前的确认文字 */
export function sweepConfirmText(settings: C5Settings, itemCount: number, receiver: C5Receiver | null): string {
	const note = receiverC5Note(receiver);
	return [
		'自动扫货:监控列表里的饰品跌到目标价以内会真实下单,花 C5 账户余额(没有模拟)。',
		`收货账号:${receiverText(receiver)}${note ? `,${note.text}` : ''}。`,
		`总预算 ${money(settings.maxTotalSpend)},每轮最多 ${settings.maxBuyPerCycle} 单,余额保留 ${money(settings.minBalanceReserve)}。`,
		`策略:${settings.strategy === 'quick' ? '快速购买(平台挑最低价,一次一件)' : '按在售列表批量买'};监控 ${itemCount} 个饰品。`,
		'确定开始?'
	].join('\n');
}
