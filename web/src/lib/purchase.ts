// 游戏内购的纯逻辑(不依赖 Vue):购物车按余额封顶、价格与币种、汇率折算、任务状态和日志文案。
// 规则照搬旧版前端。金额一律用「分」(整数)。

/** 单件商品购买数量的兜底上限;实际能买多少由余额决定。和后端一致 */
export const MAX_ITEM_QUANTITY = 9999;

/** /api/purchase/online-accounts 的账号(在线、挂了该游戏 GC 模块) */
export interface PurchaseAccount {
	account: string;
	attemptId: string;
	country: string;
	hasWallet: boolean;
	currency: number | null;
	currencyISO: string;
	balance: number | null;
	gcConnected: boolean;
}

/** 商品目录里的一项(src/purchase/catalog-items.ts 的 CatalogItem);prices 是 币种 → 分 */
export interface CatalogItem {
	def_index: number;
	name: string;
	type: string;
	category: string;
	prices: Record<string, number | null>;
}

export interface CartEntry {
	itemDefId: number;
	name: string;
	quantity: number;
	/** 账号币种下的单价(分) */
	costInLocalCurrency: number;
	currencyISO: string;
}

export type FindItem = (defIndex: number) => CatalogItem | null | undefined;

const iso = (value: unknown, fallback = 'USD') => String(value || fallback).trim().toUpperCase() || fallback;

/** 已选账号里最多的币种(没选账号时 USD) */
export function dominantCurrency(accounts: readonly PurchaseAccount[]): string {
	const counts = new Map<string, number>();
	for (const account of accounts) {
		const code = iso(account.currencyISO);
		counts.set(code, (counts.get(code) ?? 0) + 1);
	}
	let winner = 'USD';
	let best = -1;
	for (const [code, count] of counts) {
		if (count > best) {
			winner = code;
			best = count;
		}
	}
	return winner;
}

/** 某币种的单价;没有这个币种的价格就用美元价(旧版就这样) */
export function itemPrice(item: CatalogItem | null | undefined, currencyISO: string): number {
	const prices = item && item.prices && typeof item.prices === 'object' ? item.prices : null;
	if (!prices) {
		return 0;
	}
	const code = iso(currencyISO);
	if (prices[code] != null) {
		return Number(prices[code] || 0);
	}
	return prices.USD != null ? Number(prices.USD || 0) : 0;
}

/** 钱包余额(分);没钱包或余额未知返回 null(不按余额封顶) */
export function balanceCents(account: PurchaseAccount | null | undefined): number | null {
	if (!account || !account.hasWallet || account.balance == null) {
		return null;
	}
	const balance = Number(account.balance);
	return Number.isFinite(balance) ? Math.max(0, Math.round(balance * 100)) : null;
}

/**
 * 按当前目录和余额整理一个账号的购物车:补名称、按账号币种取单价、数量夹到 1..上限,
 * 再按顺序用余额封顶(前面的商品先占余额,买不起的商品整项去掉)
 */
export function normalizeCart(entries: readonly CartEntry[], account: PurchaseAccount | null | undefined, findItem: FindItem): CartEntry[] {
	if (!account) {
		return [];
	}
	const result: CartEntry[] = [];
	let remaining = balanceCents(account);
	for (const entry of entries) {
		if (!entry || Number(entry.quantity || 0) <= 0) {
			continue;
		}
		const item = findItem(Number(entry.itemDefId));
		const currencyISO = iso(account.currencyISO || entry.currencyISO);
		const synced: CartEntry = {
			itemDefId: Number(entry.itemDefId),
			name: item ? item.name : (entry.name || `DefIndex ${entry.itemDefId}`),
			currencyISO,
			quantity: Math.max(1, Math.min(MAX_ITEM_QUANTITY, Number(entry.quantity || 1))),
			costInLocalCurrency: item ? itemPrice(item, currencyISO) : Number(entry.costInLocalCurrency || 0)
		};
		const unit = Math.max(0, synced.costInLocalCurrency);
		if (remaining != null && unit > 0) {
			const affordable = Math.max(0, Math.min(MAX_ITEM_QUANTITY, Math.floor(remaining / unit)));
			if (affordable <= 0) {
				continue;
			}
			synced.quantity = Math.min(synced.quantity, affordable);
			remaining -= synced.quantity * unit;
		}
		result.push(synced);
	}
	return result;
}

/** 某件商品最多还能买几件(扣掉购物车里其它商品占的余额) */
export function maxQuantityFor(entries: readonly CartEntry[], account: PurchaseAccount | null | undefined, itemDefId: number): number {
	if (!account) {
		return 0;
	}
	const target = entries.find(entry => Number(entry.itemDefId) === Number(itemDefId));
	const unit = Math.max(0, Number(target?.costInLocalCurrency || 0));
	const balance = balanceCents(account);
	if (unit <= 0 || balance == null) {
		return MAX_ITEM_QUANTITY;
	}
	const others = entries
		.filter(entry => Number(entry.itemDefId) !== Number(itemDefId))
		.reduce((sum, entry) => sum + Math.max(0, Number(entry.costInLocalCurrency || 0)) * Math.max(0, Number(entry.quantity || 0)), 0);
	return Math.max(0, Math.min(MAX_ITEM_QUANTITY, Math.floor(Math.max(0, balance - others) / unit)));
}

export interface SetQuantityResult {
	entries: CartEntry[];
	/** 实际生效的数量(可能被余额压低) */
	appliedQuantity: number;
	maxQuantity: number;
}

/** 设置某件商品的数量(0 = 移除),再按余额整理 */
export function setCartQuantity(entries: readonly CartEntry[], account: PurchaseAccount | null | undefined, itemDefId: number, quantity: number, findItem: FindItem): SetQuantityResult {
	const next = entries.map(entry => ({...entry}));
	let entry = next.find(record => Number(record.itemDefId) === Number(itemDefId));
	if (!entry && quantity > 0) {
		entry = {itemDefId: Number(itemDefId), name: '', quantity: 0, costInLocalCurrency: 0, currencyISO: iso(account?.currencyISO)};
		next.push(entry);
	}
	if (entry) {
		entry.quantity = Math.max(0, Math.round(Number(quantity || 0)));
	}
	const normalized = normalizeCart(next.filter(record => record.quantity > 0), account, findItem);
	const applied = normalized.find(record => Number(record.itemDefId) === Number(itemDefId));
	return {
		entries: normalized,
		appliedQuantity: applied ? applied.quantity : 0,
		maxQuantity: applied ? maxQuantityFor(normalized, account, itemDefId) : 0
	};
}

export function cartTotals(entries: readonly CartEntry[]): {units: number; costCents: number} {
	return entries.reduce((total, entry) => ({
		units: total.units + Number(entry.quantity || 0),
		costCents: total.costCents + Number(entry.costInLocalCurrency || 0) * Number(entry.quantity || 0)
	}), {units: 0, costCents: 0});
}

// ===== 商品目录 =====

/** 搜名称、类型、分类、def_index */
export function filterItems(items: readonly CatalogItem[], query: string): CatalogItem[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return items.slice();
	}
	return items.filter(item => [item.name, item.type, item.category, String(item.def_index ?? '')].join(' ').toLowerCase().includes(needle));
}

/** 按分类分组;目录本身已按分类排好序,连续的同类归一组 */
export function groupItems(items: readonly CatalogItem[]): Array<{category: string; items: CatalogItem[]}> {
	const groups: Array<{category: string; items: CatalogItem[]}> = [];
	for (const item of items) {
		const category = String(item.category || item.type || '未分类').trim() || '未分类';
		const last = groups[groups.length - 1];
		if (last && last.category === category) {
			last.items.push(item);
		} else {
			groups.push({category, items: [item]});
		}
	}
	return groups;
}

// ===== 币种与汇率 =====

/** 汇率表以美元为基准(1 USD = rates[X] X) */
export type Rates = Record<string, number>;

export function convertCents(cents: number, from: string, to: string, rates: Rates | null | undefined): number {
	const fromISO = iso(from, '');
	const toISO = iso(to, '');
	const amount = Number(cents);
	if (!fromISO || !toISO || !Number.isFinite(amount)) {
		return Number.NaN;
	}
	if (fromISO === toISO) {
		return amount;
	}
	const fromRate = Number(rates?.[fromISO]);
	const toRate = Number(rates?.[toISO]);
	if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
		return Number.NaN;
	}
	return amount / fromRate * toRate;
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
	USD: '$', GBP: '£', EUR: '€', CHF: 'CHF ', RUB: '₽', PLN: 'zł', BRL: 'R$', JPY: '¥', NOK: 'kr ', IDR: 'Rp ', MYR: 'RM ',
	PHP: '₱', SGD: 'S$', THB: '฿', VND: '₫', KRW: '₩', TRY: '₺', UAH: '₴', MXN: 'Mex$', CAD: 'C$', AUD: 'A$', NZD: 'NZ$',
	CNY: '¥', INR: '₹', COP: 'COL$', ZAR: 'R ', HKD: 'HK$', TWD: 'NT$', SAR: 'SR ', AED: 'AED ', KZT: '₸', QAR: 'QR '
};

/** 分 → 带符号的金额;不认识的币种用代码,如「UYU 12.00」 */
export function formatCents(cents: number, currencyISO: string): string {
	const value = Number(cents);
	if (!Number.isFinite(value)) {
		return '-';
	}
	const code = iso(currencyISO);
	const symbol = CURRENCY_SYMBOLS[code];
	return symbol ? `${symbol}${(value / 100).toFixed(2)}` : `${code} ${(value / 100).toFixed(2)}`;
}

export interface PriceEntry {
	iso: string;
	value: string;
	current: boolean;
	usd: string;
	cny: string;
}

/** 价格表:各币种原价、折美元、折人民币,按人民币从低到高(折不了的排最后) */
export function priceEntries(item: CatalogItem, currentISO: string, rates: Rates | null | undefined): PriceEntry[] {
	const current = iso(currentISO);
	const prices = item.prices && typeof item.prices === 'object' ? item.prices : {};
	return Object.keys(prices)
		.map(code => code.trim().toUpperCase())
		.filter(code => code && prices[code] != null)
		.map(code => {
			const cents = Number(prices[code] || 0);
			const usd = convertCents(cents, code, 'USD', rates);
			const cny = convertCents(cents, code, 'CNY', rates);
			return {code, cents, usd, cny};
		})
		.sort((a, b) => {
			const left = Number.isFinite(a.cny) ? a.cny : Number.POSITIVE_INFINITY;
			const right = Number.isFinite(b.cny) ? b.cny : Number.POSITIVE_INFINITY;
			return left !== right ? left - right : a.code.localeCompare(b.code, 'en');
		})
		.map(entry => ({
			iso: entry.code,
			value: formatCents(entry.cents, entry.code),
			current: entry.code === current,
			usd: Number.isFinite(entry.usd) ? formatCents(entry.usd, 'USD') : '无法折算',
			cny: Number.isFinite(entry.cny) ? formatCents(entry.cny, 'CNY') : '无法折算'
		}));
}

export function ratesSummary(rates: Rates | null | undefined, currentISO: string, source: string): {text: string; title: string} {
	const count = rates && typeof rates === 'object' ? Object.keys(rates).length : 0;
	if (!count) {
		return {text: '汇率:未提供', title: '当前响应里没有可用 rates 对象'};
	}
	const current = iso(currentISO);
	const sourceText = source ? `来源 ${source}` : '独立汇率表';
	const rate = rates![current];
	if (rate == null) {
		return {text: `汇率参考:${count} 个币种`, title: `${sourceText},以 USD 为基准`};
	}
	return {text: `汇率参考:${current}= ${Number(rate).toFixed(4)}`, title: `${sourceText},以 USD 为基准,当前共 ${count} 个币种`};
}

// ===== 任务 =====

export type TaskStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';

export interface PurchaseTask {
	id: string;
	game: 'cs2' | 'tf2';
	gameLabel: string;
	status: TaskStatus | string;
	createdAt: string;
	finishedAt?: string;
	totalAccounts: number;
	totalUnits: number;
	successCount: number;
	failCount: number;
	accounts: Array<{
		account: string;
		status: string;
		error: string;
		currencyISO: string;
		balanceBefore: number | null;
		balanceAfter: number | null;
		totalCostCents: number;
		totalUnits: number;
		items: Array<{itemDefId: number; name: string; quantity: number; unitPriceCents: number}>;
	}>;
}

const TASK_STATUS: Readonly<Record<string, {label: string; tone: 'default' | 'success' | 'warning' | 'error'}>> = {
	queued: {label: '排队中', tone: 'default'},
	running: {label: '执行中', tone: 'warning'},
	completed: {label: '已完成', tone: 'success'},
	partial: {label: '部分成功', tone: 'warning'},
	failed: {label: '失败', tone: 'error'}
};

export function taskStatus(status: string): {label: string; tone: 'default' | 'success' | 'warning' | 'error'} {
	return TASK_STATUS[status] ?? {label: status || '-', tone: 'default'};
}

/** 任务推送对应的运行日志;不需要写日志时返回 null */
export function taskLogLine(task: PurchaseTask, previous: PurchaseTask | null, created: boolean): {level: 'success' | 'warn' | 'error'; message: string} | null {
	const label = task.gameLabel || (task.game === 'tf2' ? 'TF2' : 'CS2');
	const scope = `${Number(task.totalAccounts || 0)} 个账号,${Number(task.totalUnits || 0)} 件商品`;
	if (created && !previous) {
		return {level: 'success', message: `${label} 内购任务已创建: ${scope}`};
	}
	if (!previous || previous.status === task.status) {
		return null;
	}
	if (task.status === 'running') {
		return {level: 'warn', message: `${label} 内购任务执行中: ${scope}`};
	}
	if (task.status === 'completed' || task.status === 'partial' || task.status === 'failed') {
		// 失败账号的原因一起带上(不然只看到「成功 0,失败 1」)
		const failed = (task.accounts || []).filter(account => account.status === 'failed' && account.error);
		const reasons = failed.length ? ' — ' + failed.map(account => `${account.account}: ${account.error}`).join('; ') : '';
		return {
			level: task.status === 'failed' ? 'error' : task.status === 'partial' ? 'warn' : 'success',
			message: `${label} 内购任务${taskStatus(task.status).label}: 成功 ${Number(task.successCount || 0)},失败 ${Number(task.failCount || 0)}${reasons}`
		};
	}
	return null;
}
