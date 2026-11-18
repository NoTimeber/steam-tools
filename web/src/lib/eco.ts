// ECO 扫货的纯逻辑(不依赖 Vue):后端状态的类型、状态文案、监控列表草稿(改价、添加、删除、改动检测、提交前检查)。
// 饰品按 Steam 英文名(name / HashName)存和提交(ECO 接口只认它),页面上显示后端词库或 ECO 行情里的中文名(zh)。

/** stopped 停止;sweeping 自动扫货(真实下单,没有模拟) */
export type EcoRunState = 'stopped' | 'sweeping';
export type EcoItemStatus = 'done' | 'cooldown' | 'noquote' | 'hit' | 'watch';
export type EcoPurchaseStatus = 'unknown' | 'ok' | 'failed' | 'cancelled';
export type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';

/** 后端 src/eco/config.ts 的 EcoSettings */
export interface EcoSettings {
	strategy: 'listing' | 'quick';
	tradeUrl: string;
	maxTotalSpend: number;
	maxBuyPerCycle: number;
	minBalanceReserve: number;
	errorCooldownSec: number;
	pollIntervalSec: number;
	timeoutSec: number;
}

/** 后端 src/store/eco.ts 的 EcoWatchItem */
export interface EcoWatchItem {
	name: string;
	maxPrice: number;
	maxQty: number;
	maxSpend: number;
	/** 730 CS2 / 570 Dota2 / 440 TF2 / 252490 Rust */
	gameId: number;
}

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

/** 后端 src/eco/index.ts 的 EcoPurchaseView */
export interface EcoPurchase {
	/** 商户单号(我方生成) */
	merchantNo: string;
	ts: number;
	name: string;
	zh: string | null;
	/** ECO 商品编号;快速购买下单前不知道,为空 */
	goodsNum: string;
	price: number;
	status: EcoPurchaseStatus;
	/** ECO 订单编号 */
	orderNo: string | null;
	actualPay: number | null;
	orderState: number | null;
	orderStateName: string | null;
	checkedAt: number;
	error: string | null;
	cost: number;
}

/** 后端 src/eco/index.ts 的 EcoState */
export interface EcoState {
	/** PartnerId 和私钥都填了、私钥能用 */
	configured: boolean;
	partnerId: string;
	/** 私钥对应的公钥(base64,不带头尾),要填到 ECO 开放平台;没有私钥为 '' */
	publicKey: string;
	/** 存的私钥用不了的原因 */
	keyError: string | null;
	settings: EcoSettings;
	settingsError: string | null;
	run: EcoRunState;
	cycle: {n: number; at: number | null; error: string | null; errors: number; done: boolean};
	budget: {total: number; spent: number; qty: number};
	balance: {value: number; at: number} | null;
	/** 收货账号;没填交易链接为 null */
	receiver: EcoReceiver | null;
	items: EcoItemView[];
	purchases: EcoPurchase[];
	unknown: number;
}

export interface EcoCheckResult {
	balance: {money: number | null; locked: number | null; waitSettlement: number | null};
	steamAccounts: EcoBoundAccount[];
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

/** 后端 src/eco/index.ts 的 EcoReceiver:交易链接对应的账号 */
export interface EcoReceiver {
	steamId: string;
	/** 账户管理里对应的账号名 */
	account: string | null;
	personaName: string | null;
	eco: EcoBoundAccount | null;
	/** false = 还没查过 ECO 上绑定了哪些账号 */
	ecoChecked: boolean;
}

/** 用 ECO 的验证交易链接接口查的结果(后端 src/eco/index.ts 的 EcoLinkCheck) */
export interface EcoLinkCheck {
	/** 平台说有效 / 无效;查失败为 null */
	valid: boolean | null;
	error: string | null;
	at: number;
}

/** 收货账号下拉的一项:ECO 上绑定的 Steam 账号,选它就用 ECO 上登记的交易链接 */
export interface EcoReceiverAccount extends EcoBoundAccount {
	/** 账户管理里对应的账号名;不在账户管理里为 null */
	account: string | null;
	/** 上次验证这个链接的结果;没验过为 null */
	linkCheck: EcoLinkCheck | null;
	/** 工具里有这个账号的有效 refreshToken,能让 ECO 重新取交易链接 */
	canUpdate: boolean;
}

export interface EcoReceivers {
	accounts: EcoReceiverAccount[];
	/** 查到了 ECO 上绑定的账号 */
	checked: boolean;
	/** 没配好密钥、查 ECO 失败的原因 */
	boundError: string | null;
}

export interface EcoListing {
	/** ECO 商品编号 */
	goodsNum: string;
	price: number;
}

/** 添加饰品的搜索结果;zh 为 null 是词库里没有、按输入的英文名原样用 */
export interface EcoNameOption {
	name: string;
	zh: string | null;
	/** ECO 在售最低价、在售数;没查价(没配好密钥、查价失败)或没在售为 null */
	lowest: number | null;
	sellCount: number | null;
}

export interface EcoNameSearch {
	options: EcoNameOption[];
	priced: boolean;
	priceError: string | null;
}

/** ECO 支持的游戏(后端 src/eco/config.ts 的 GAME_IDS) */
export const GAME_OPTIONS: ReadonlyArray<{value: number; label: string}> = [
	{value: 730, label: 'CS2'},
	{value: 570, label: 'Dota2'},
	{value: 440, label: 'TF2'},
	{value: 252490, label: 'Rust'}
];

export const DEFAULT_GAME_ID = 730;

export function gameLabel(gameId: number): string {
	return GAME_OPTIONS.find(option => option.value === gameId)?.label ?? String(gameId);
}

/** 显示用的饰品名:有中文用中文 */
export function itemLabel(item: {name: string; zh?: string | null}): string {
	return item.zh || item.name;
}

/** 搜索结果里的价格:「¥0.66 · 在售 4」;查过价但没在售时「ECO 无在售」;没查价为空 */
export function priceText(option: EcoNameOption, priced: boolean): string {
	if (option.lowest != null) {
		return `¥${money(option.lowest)} · 在售 ${option.sellCount ?? '-'}`;
	}
	return priced ? 'ECO 无在售' : '';
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

/** 交易链接是不是这个 SteamID 的(按账号 id = SteamID 低 32 位比) */
export function isTradeUrlOf(tradeUrl: string, steamId: string): boolean {
	const partner = partnerOf(tradeUrl);
	return partner != null && /^\d{17}$/.test(steamId) && String(BigInt(steamId) & 0xFFFFFFFFn) === partner;
}

function boundOf(account: EcoReceiverAccount): EcoBoundAccount {
	const {account: _local, linkCheck: _check, canUpdate: _update, ...bound} = account;
	return bound;
}

/** 设置里填的交易链接是谁的(页面上手改链接时即时显示;保存后以后端 state.receiver 为准) */
export function describeTradeUrl(tradeUrl: string, receivers: EcoReceivers | null): EcoReceiver | null {
	const partner = partnerOf(tradeUrl);
	if (partner == null) {
		return null;
	}
	const bound = receivers?.accounts.find(account => isTradeUrlOf(tradeUrl, account.steamId)) ?? null;
	return {
		steamId: bound?.steamId ?? String(76561197960265728n + BigInt(partner)),
		account: bound?.account ?? null,
		personaName: null,
		eco: bound && boundOf(bound),
		ecoChecked: !!receivers?.checked
	};
}

/**
 * 能不能选作收货账号:ECO 上有交易链接就行。
 * ECO 列表里的 tradeUrlOk(TradeLinkIsEnable)不可靠(实测两个有效链接都标成 false),不拿它拦
 */
export function receiverUsable(account: EcoBoundAccount): boolean {
	return !!account.tradeUrl;
}

/** 交易链接状态的小标签;muted 表示只是参考(没验证过) */
export interface LinkStatus {
	text: string;
	tone: Tone;
	muted: boolean;
	/** 鼠标悬停的说明(验证失败的原因、验证时间) */
	title: string;
}

/**
 * 交易链接状态:验证过用验证结果(有效 / 无效 / 验证失败);没验证过时 ECO 列表标了失效只给个淡色提示,
 * 其它显示「未验证」。没有链接为「没有交易链接」
 */
export function linkStatus(account: Pick<EcoReceiverAccount, 'tradeUrl' | 'tradeUrlOk' | 'linkCheck'>, now: number = Date.now()): LinkStatus {
	if (!account.tradeUrl) {
		return {text: '没有交易链接', tone: 'error', muted: false, title: 'ECO 上没有这个账号的交易链接'};
	}
	const check = account.linkCheck;
	if (check) {
		const when = `${formatTime(check.at, now)} 验证`;
		if (check.valid === true) {
			return {text: '链接有效', tone: 'success', muted: false, title: when};
		}
		if (check.valid === false) {
			return {text: '链接无效', tone: 'error', muted: false, title: `${when};点「更新交易链接」让 ECO 重新取,或去 ECO 官网更新`};
		}
		return {text: '验证失败', tone: 'warning', muted: false, title: `${when}失败:${check.error ?? '未知错误'}`};
	}
	if (!account.tradeUrlOk) {
		return {text: 'ECO 列表标记失效(未验证)', tone: 'default', muted: true, title: 'ECO 列表里的这个标记不可靠,点「验证」用 ECO 的验证接口查'};
	}
	return {text: '未验证', tone: 'default', muted: true, title: '点「验证」用 ECO 的验证接口查'};
}

/**
 * 当前收货账号的链接状态:只有设置里的交易链接就是 ECO 上登记的那条时,验证结果才对得上;
 * 对不上(或账号不在下拉里)返回 null,由 receiverEcoNote 提示「不一致」
 */
export function currentLinkStatus(account: EcoReceiverAccount | null | undefined, tradeUrl: string, now: number = Date.now()): LinkStatus | null {
	if (!account || !tradeUrl.trim() || account.tradeUrl !== tradeUrl.trim()) {
		return null;
	}
	return linkStatus(account, now);
}

/** 「更新交易链接」不能用的原因;能用返回 null */
export function updateLinkBlocker(account: EcoReceiverAccount | null | undefined): string | null {
	if (!account) {
		return '当前收货账号不是 ECO 上绑定的账号';
	}
	if (account.canUpdate) {
		return null;
	}
	return account.account
		? `${account.account} 在工具里没有有效的登录会话;去账户管理用账密重新登录一次再更新`
		: '这个账号不在账户管理里,工具没有它的登录凭据;去 ECO 官网更新,或先把账号加进账户管理并登录';
}

/** 收货账号下拉的一项:「ECO 昵称(备注)」,默认账号、状态不正常、没有链接的才标出来(链接验证状态另外画标签) */
export function receiverOptionLabel(account: EcoReceiverAccount): string {
	const name = account.nickname || account.steamId;
	const remark = account.remark && account.remark !== name ? `(${account.remark})` : '';
	const notes = [
		account.isDefault ? '默认' : '',
		account.status !== '正常' ? account.status : '',
		!account.tradeUrl ? '没有交易链接' : ''
	].filter(Boolean);
	return `${name}${remark}${notes.map(note => ` · ${note}`).join('')}`;
}

/** 下拉里搜索:昵称、备注、SteamID、账户管理里的账号名都能搜 */
export function receiverMatches(account: EcoReceiverAccount, pattern: string): boolean {
	const text = pattern.trim().toLowerCase();
	return !text || [account.nickname, account.remark, account.steamId, account.account ?? ''].some(value => value.toLowerCase().includes(text));
}

/** 收货账号下拉的顺序:能选的在前,其次状态正常的,再其次 ECO 默认账号;同一档按 ECO 返回的顺序 */
export function sortReceiverAccounts(accounts: readonly EcoReceiverAccount[]): EcoReceiverAccount[] {
	const rank = (account: EcoReceiverAccount) => Number(!receiverUsable(account)) * 4 + Number(account.status !== '正常') * 2 + Number(!account.isDefault);
	return accounts.map((account, index) => ({account, index}))
		.sort((a, b) => rank(a.account) - rank(b.account) || a.index - b.index)
		.map(entry => entry.account);
}

/** 收货账号一行字:「ECO 昵称 · SteamID 7656…」;不是 ECO 绑定的用账户管理里的账号名,都不是只给 SteamID */
export function receiverText(receiver: EcoReceiver | null): string {
	if (!receiver) {
		return '未设置';
	}
	const name = receiver.eco?.nickname || (receiver.account ? `${receiver.account}${receiver.personaName ? `(${receiver.personaName})` : ''}` : '');
	return `${name ? name + ' · ' : ''}SteamID ${receiver.steamId}`;
}

/**
 * 收货账号在 ECO 上的情况:没查过返回 null。
 * 给了 tradeUrl(设置里填的)时,和 ECO 上登记的链接不一样也标出来(token 换过的话下单会失败)
 */
export function receiverEcoNote(receiver: EcoReceiver | null, tradeUrl = ''): {text: string; ok: boolean} | null {
	if (!receiver || !receiver.ecoChecked) {
		return null;
	}
	const eco = receiver.eco;
	if (!eco) {
		return {text: 'ECO 上没绑定这个账号', ok: false};
	}
	if (eco.status !== '正常') {
		return {text: `ECO 上状态:${eco.status}`, ok: false};
	}
	// 不看 tradeUrlOk:ECO 列表里的这个标记不可靠,链接好坏以验证结果为准(linkStatus)
	if (tradeUrl && eco.tradeUrl && tradeUrl.trim() !== eco.tradeUrl) {
		return {text: '和 ECO 上登记的交易链接不一致', ok: false};
	}
	return {text: `ECO 已绑定(${eco.nickname || eco.steamId})`, ok: true};
}

// ===== 导入令牌绑定 Steam 账号 =====

/** 后端 src/eco/index.ts 的 EcoBindCandidate:账户管理里的一个账号能不能导入、ECO 上绑了没有 */
export interface EcoBindCandidate {
	account: string;
	/** 登录后记下的 SteamID64;没登录过为 '' */
	steamId: string;
	/** 工具里的账户分组名;未分组为 '' */
	group: string;
	hasMaFile: boolean;
	hasPassword: boolean;
	ready: boolean;
	/** 不能导入的原因 */
	reason: string | null;
	bound: EcoBoundAccount | null;
}

export interface EcoBindList {
	accounts: EcoBindCandidate[];
	groups: string[];
	boundError: string | null;
}

/** none 不设 ECO 分组;fixed 统一填 groupName;tool 用工具里的账户分组名 */
export type EcoBindGroupMode = 'none' | 'fixed' | 'tool';

export interface EcoBindResult {
	account: string;
	status: 'ok' | 'failed' | 'unknown';
	message: string;
}

export const BIND_GROUP_MAX = 50;
export const BIND_BATCH_MAX = 50;

/** 绑定窗口的筛选:group 为 null 不限,'' 是未分组;unboundOnly 只看 ECO 上还没绑的 */
export interface BindFilter {
	group: string | null;
	unboundOnly: boolean;
}

export function filterBindCandidates(accounts: readonly EcoBindCandidate[], filter: BindFilter): EcoBindCandidate[] {
	return accounts.filter(entry => (filter.group == null || entry.group === filter.group) && (!filter.unboundOnly || !entry.bound));
}

/** 能勾的:能导入的(已绑定的也能勾,重新导入) */
export function selectableNames(accounts: readonly EcoBindCandidate[]): string[] {
	return accounts.filter(entry => entry.ready).map(entry => entry.account);
}

/** 全选 / 取消全选只作用于当前看得见、能勾的行,别的已勾的不动 */
export function toggleAllVisible(selected: readonly string[], visible: readonly EcoBindCandidate[], checked: boolean): string[] {
	const names = selectableNames(visible);
	if (checked) {
		return [...selected, ...names.filter(name => !selected.includes(name))];
	}
	return selected.filter(name => !names.includes(name));
}

/** 表头全选框的状态:看得见的能勾行全勾了 / 勾了一部分 */
export function visibleCheckState(selected: readonly string[], visible: readonly EcoBindCandidate[]): {checked: boolean; indeterminate: boolean} {
	const names = selectableNames(visible);
	const count = names.filter(name => selected.includes(name)).length;
	return {checked: names.length > 0 && count === names.length, indeterminate: count > 0 && count < names.length};
}

/** 列表刷新后,勾选里去掉已经不存在或不能导入的账号 */
export function pruneSelection(selected: readonly string[], accounts: readonly EcoBindCandidate[]): string[] {
	const ready = new Set(selectableNames(accounts));
	return selected.filter(name => ready.has(name));
}

/** 提交前检查:勾了账号、不超过一批上限、统一填写时分组名必填且不超过 50 字。没问题返回 '' */
export function bindPayloadError(count: number, mode: EcoBindGroupMode, groupName: string): string {
	if (count <= 0) {
		return '先勾选要绑定的账号';
	}
	if (count > BIND_BATCH_MAX) {
		return `一次最多绑定 ${BIND_BATCH_MAX} 个账号,现在勾了 ${count} 个`;
	}
	const name = groupName.trim();
	if (mode === 'fixed' && !name) {
		return '选了「统一填写」就要填 ECO 分组名';
	}
	if (mode === 'fixed' && name.length > BIND_GROUP_MAX) {
		return `ECO 分组名最长 ${BIND_GROUP_MAX} 个字`;
	}
	return '';
}

export function bindResultStatus(status: EcoBindResult['status']): {label: string; tone: Tone} {
	switch (status) {
		case 'ok': return {label: '成功', tone: 'success'};
		case 'failed': return {label: '失败', tone: 'error'};
		default: return {label: '结果未知', tone: 'warning'};
	}
}

/** 结果汇总:「成功 3 个,失败 1 个,结果未知 1 个」 */
export function bindSummary(results: readonly EcoBindResult[]): string {
	const count = (status: EcoBindResult['status']) => results.filter(result => result.status === status).length;
	return [`成功 ${count('ok')} 个`, count('failed') ? `失败 ${count('failed')} 个` : '', count('unknown') ? `结果未知 ${count('unknown')} 个` : '']
		.filter(Boolean).join(',');
}

// ===== 文案 =====

export const RUN_LABELS: Record<EcoRunState, string> = {stopped: '停止', sweeping: '自动扫货'};

export const STRATEGY_LABELS: Record<EcoSettings['strategy'], string> = {
	listing: '按在售列表(查在售后按商品编号从低价逐件买)',
	quick: '快速购买(平台挑不高于目标价的一件,一次一件)'
};

export function itemStatus(status: EcoItemStatus | 'new'): {label: string; tone: Tone} {
	switch (status) {
		case 'done': return {label: '已买满', tone: 'default'};
		case 'cooldown': return {label: '冷却中', tone: 'warning'};
		case 'noquote': return {label: '无行情', tone: 'default'};
		case 'hit': return {label: '到价', tone: 'success'};
		case 'watch': return {label: '监控中', tone: 'info'};
		default: return {label: '未保存', tone: 'warning'};
	}
}

export function purchaseStatus(status: EcoPurchaseStatus): {label: string; tone: Tone} {
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

export function budgetText(budget: EcoState['budget']): string {
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
	gameId: number;
}

export type DraftField = 'name' | 'maxPrice' | 'maxQty' | 'maxSpend' | 'gameId';
const FIELDS: readonly DraftField[] = ['name', 'maxPrice', 'maxQty', 'maxSpend', 'gameId'];

/** 服务端列表 → 草稿;previous 里同名的行沿用原来的 uid(表格不重建行,输入框不丢焦点) */
export function toDrafts(items: ReadonlyArray<EcoWatchItem & {zh?: string | null}>, newUid: () => string, previous: readonly DraftRow[] = []): DraftRow[] {
	return items.map(item => ({
		uid: previous.find(row => row.origName === item.name)?.uid ?? newUid(),
		origName: item.name,
		name: item.name,
		zh: item.zh ?? null,
		maxPrice: item.maxPrice,
		maxQty: item.maxQty,
		maxSpend: item.maxSpend,
		gameId: item.gameId
	}));
}

function sameValue(field: DraftField, draft: DraftRow, item: EcoWatchItem): boolean {
	if (field === 'maxSpend') {
		return (draft.maxSpend ?? 0) === item.maxSpend;
	}
	return draft[field] === item[field];
}

/** 这一行和服务端不一样的格子;新加的行全部算改过 */
export function dirtyFields(draft: DraftRow, items: readonly EcoWatchItem[]): Set<DraftField> {
	const item = draft.origName == null ? undefined : items.find(entry => entry.name === draft.origName);
	return new Set(item ? FIELDS.filter(field => !sameValue(field, draft, item)) : FIELDS);
}

/** 草稿里删掉了的服务端饰品 */
export function removedNames(drafts: readonly DraftRow[], items: readonly EcoWatchItem[]): string[] {
	return items.map(item => item.name).filter(name => !drafts.some(row => row.origName === name));
}

export function draftsDirty(drafts: readonly DraftRow[], items: readonly EcoWatchItem[]): boolean {
	return drafts.length !== items.length
		|| drafts.some((row, index) => row.origName !== items[index]?.name || dirtyFields(row, items).size > 0);
}

export function newDraft(newUid: () => string, init: Partial<Pick<DraftRow, 'name' | 'zh' | 'maxPrice' | 'maxQty' | 'maxSpend' | 'gameId'>> = {}): DraftRow {
	return {
		uid: newUid(),
		origName: null,
		name: String(init.name ?? '').trim(),
		zh: init.zh ?? null,
		maxPrice: init.maxPrice ?? null,
		maxQty: init.maxQty ?? null,
		maxSpend: init.maxSpend ?? 0,
		gameId: init.gameId ?? DEFAULT_GAME_ID
	};
}

/** 提交前在浏览器先查一遍(服务端还会再校验),错了返回原因 */
export function draftPayload(drafts: readonly DraftRow[]): {items: EcoWatchItem[]; error: string} {
	const items: EcoWatchItem[] = [];
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
		if (!GAME_OPTIONS.some(option => option.value === row.gameId)) {
			return {items: [], error: `${shown}:游戏只能是 ${GAME_OPTIONS.map(option => option.label).join(' / ')}`};
		}
		if (items.some(item => item.name === name)) {
			return {items: [], error: `${shown} 重复了`};
		}
		items.push({name, maxPrice: Number(row.maxPrice), maxQty: Number(row.maxQty), maxSpend: Number(row.maxSpend ?? 0), gameId: row.gameId});
	}
	return {items, error: ''};
}

/** 能不能开始自动扫货(和后端 src/eco/config.ts 的 sweepBlocker 一样):能返回 null,不能返回原因 */
export function sweepBlocker(settings: EcoSettings): string | null {
	if (!settings.tradeUrl) {
		return '没填收货账号的交易链接';
	}
	if (!(settings.maxTotalSpend > 0)) {
		return '没设总预算(要大于 0)';
	}
	return null;
}

/** 开始自动扫货前的确认文字 */
export function sweepConfirmText(settings: EcoSettings, itemCount: number, receiver: EcoReceiver | null, link: LinkStatus | null = null): string {
	const note = receiverEcoNote(receiver, settings.tradeUrl);
	return [
		'自动扫货:监控列表里的饰品跌到目标价以内会真实下单,花 ECO 账户余额(没有模拟)。',
		`收货账号:${receiverText(receiver)}${note ? `,${note.text}` : ''}${link ? `,交易链接${link.text.startsWith('链接') ? link.text.slice(2) : ':' + link.text}` : ''}。`,
		`总预算 ${money(settings.maxTotalSpend)},每轮最多 ${settings.maxBuyPerCycle} 单,余额保留 ${money(settings.minBalanceReserve)}。`,
		`策略:${STRATEGY_LABELS[settings.strategy]};监控 ${itemCount} 个饰品。`,
		'确定开始?'
	].join('\n');
}
