// 账号的 Steam 消费记录(商店「账户明细 → 购买记录」,store.steampowered.com/account/history/)。
// Steam 没有给这个的 API,只能用账号自己的网页会话 cookie 读网页:
//   1. GET  /account/history/?l=schinese              整页 HTML:表格行 + 脚本里的 g_historyCursor(下一页游标)
//   2. POST /account/AjaxLoadMoreHistory/?l=schinese  表单 cursor[wallet_txnid] / cursor[timestamp_newest] / cursor[balance] /
//      cursor[currency] + sessionid,返回 {html: 更多行, cursor: 再下一页};没有 cursor 就读完了
// 表格每行的列按 class 区分:wht_date 日期、wht_items 商品、wht_type 类型(里面的 .wth_payment 是付款方式)、
// wht_total 总额、wht_wallet_change 钱包变动、wht_wallet_balance 钱包余额;有退款的行带 wht_refunded 之类的 class。
// 固定读中文页面(类型名「购买 / 礼物购买 / 游戏内购买 / 市场交易 / 退款」),英文也认。金额只有带货币符号的文本,
// 解析出数值和币种供汇总,原文一并保留。
// 网页内部接口没有文档:写法照 ASFEnhance 等开源实现,还没用真实账号核对过;Steam 改版时要跟着改。

import type {Attempt} from '../steam/session-manager.ts';
import {currencyIdToIso} from '../steam/currencies.ts';
import {createStoreSession, StoreRequestError} from './store-session.ts';

const STORE = 'https://store.steampowered.com';
const HISTORY_URL = `${STORE}/account/history/?l=schinese`;
const MORE_URL = `${STORE}/account/AjaxLoadMoreHistory/?l=schinese`;

// ===== 解析 =====

/** 商店购买 / 礼物购买 / 游戏内购买 / 市场买入 / 市场卖出 / 钱包充值 / 退款 / 货币转换 / 其它 */
export type HistoryKind = 'purchase' | 'gift' | 'ingame' | 'market_buy' | 'market_sell' | 'wallet' | 'refund' | 'conversion' | 'other';

export interface Money {
	/** 页面上的原文,如「-¥ 12.50」 */
	text: string;
	/** 带正负号的数值;解析不了为 null */
	amount: number | null;
	/** ISO 币种;认不出为 '' */
	currency: string;
}

export interface HistoryRow {
	/** YYYY-MM-DD;解析不了为 '' */
	date: string;
	dateText: string;
	/** 商品列每行一项(游戏名、道具名、「Steam 社区市场」等) */
	items: string[];
	/** 类型列去掉付款方式后的文字,如「购买」「3 笔市场交易」 */
	typeText: string;
	kind: HistoryKind;
	/** 市场交易合并成一行时的笔数;不是市场交易为 0 */
	marketCount: number;
	/** 付款方式;拆分付款时一种一行 */
	payment: string[];
	/** 整单或其中的商品退过款 */
	refunded: boolean;
	total: Money | null;
	walletChange: Money | null;
	walletBalance: Money | null;
	/** 交易号(行上「查看详情」链接里的 transid);没有为 '' */
	transid: string;
}

export interface HistoryCursor {
	wallet_txnid: string;
	timestamp_newest: number;
	balance: string;
	currency: number;
}

export interface ParseOptions {
	/** 账号钱包币种:「¥」靠它分人民币还是日元,认不出符号的金额也算它 */
	currencyHint?: string;
	/** 日期没写年份时用 */
	currentYear?: number;
}

const ENTITIES: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === '#') {
			const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
		}
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

function classOf(attrs: string): string {
	const match = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
	return match ? match[1] ?? match[2] ?? '' : '';
}

interface CellLine {
	text: string;
	/** 在 .wth_payment(付款方式)块里 */
	payment: boolean;
}

/** 单元格按块级标签(div / br)拆成行,去标签、解实体、压空白 */
function cellLines(html: string): CellLine[] {
	const lines: CellLine[] = [];
	const stack: boolean[] = [];   // 每层打开的 div 是否在付款方式块里
	let buffer = '';
	let bufferPayment = false;
	const inPayment = () => stack.length > 0 && stack[stack.length - 1] === true;
	const flush = () => {
		const text = decodeEntities(buffer).replace(/\s+/g, ' ').trim();
		if (text) {
			lines.push({text, payment: bufferPayment});
		}
		buffer = '';
	};
	for (const match of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g)) {
		const [, closing, rawTag, attrs = '', text] = match;
		if (text !== undefined) {
			if (!buffer.trim()) {
				bufferPayment = inPayment();
			}
			buffer += text;
			continue;
		}
		const tag = String(rawTag).toLowerCase();
		if (tag === 'br') {
			flush();
		} else if (tag === 'div' || tag === 'p' || tag === 'li') {
			flush();
			if (closing) {
				stack.pop();
			} else if (!attrs.trim().endsWith('/')) {
				stack.push(inPayment() || /\bwth_payment\b/.test(classOf(attrs)));
			}
		}
	}
	flush();
	return lines;
}

// 符号 → 币种。长的在前(ARS$ 里有 S$,CDN$ 里有 $……)
const CURRENCY_MARKS: ReadonlyArray<readonly [RegExp, string]> = [
	[/CDN\$/, 'CAD'], [/NZ\$/, 'NZD'], [/HK\$/, 'HKD'], [/NT\$/, 'TWD'], [/Mex\$/i, 'MXN'], [/COL\$/, 'COP'], [/CLP\$/, 'CLP'], [/ARS\$/, 'ARS'],
	[/A\$/, 'AUD'], [/S\$/, 'SGD'], [/R\$/, 'BRL'], [/\$U/, 'UYU'], [/S\/\./, 'PEN'],
	[/€/, 'EUR'], [/£/, 'GBP'], [/[pр]уб/i, 'RUB'], [/₴/, 'UAH'], [/₸/, 'KZT'], [/₺|\bTL\b/, 'TRY'], [/zł/i, 'PLN'], [/CHF/, 'CHF'],
	[/\bRp\b/, 'IDR'], [/\bRM\b/, 'MYR'], [/₱/, 'PHP'], [/฿/, 'THB'], [/₫/, 'VND'], [/₩/, 'KRW'], [/₹/, 'INR'], [/\bSR\b/, 'SAR'],
	[/\bAED\b/, 'AED'], [/\bQR\b/, 'QAR'], [/\bKD\b/, 'KWD'], [/₪/, 'ILS'], [/₡/, 'CRC'], [/\bkr\b/i, 'NOK'], [/(?:^|[\s+\-−])R\s?\d/, 'ZAR'],
	[/\bUSD\b|\$/, 'USD']
];

function detectCurrency(text: string, hint: string): string {
	if (/JP¥|円/.test(text)) {
		return 'JPY';
	}
	if (/[¥￥]/.test(text)) {
		if (hint === 'JPY' || hint === 'CNY') {
			return hint;
		}
		return /\d[.,]\d{2}(?!\d)/.test(text) ? 'CNY' : 'JPY';
	}
	for (const [pattern, currency] of CURRENCY_MARKS) {
		if (pattern.test(text)) {
			return currency;
		}
	}
	return hint;
}

/** 「1.234,56」「1,234.56」「1 234,56」「16,00」「4,--」都认;只有一种分隔符时,后面正好 3 位算千分位(KWD 除外) */
function parseNumber(text: string, currency: string): number | null {
	const match = /\d[\d\s.,' ]*/.exec(text);
	if (!match) {
		return null;
	}
	let digits = match[0].replace(/[\s' ]/g, '').replace(/[.,]+$/, '');
	const lastDot = digits.lastIndexOf('.');
	const lastComma = digits.lastIndexOf(',');
	if (lastDot >= 0 && lastComma >= 0) {
		const decimal = lastDot > lastComma ? '.' : ',';
		digits = digits.split(decimal === '.' ? ',' : '.').join('').replace(',', '.');
	} else if (lastDot >= 0 || lastComma >= 0) {
		const parts = digits.split(lastDot >= 0 ? '.' : ',');
		const tail = parts[parts.length - 1] ?? '';
		const decimal = parts.length === 2 && (tail.length !== 3 || currency === 'KWD');
		digits = decimal ? parts.join('.') : parts.join('');
	}
	const value = Number(digits);
	return Number.isFinite(value) ? value : null;
}

/** 金额文本 → Money;空的(含「--」)为 null */
export function parseMoney(text: string, currencyHint = ''): Money | null {
	const clean = text.replace(/\s+/g, ' ').trim();
	if (!clean || /^[-–—]+$/.test(clean)) {
		return null;
	}
	const currency = detectCurrency(clean, currencyHint.toUpperCase());
	const value = parseNumber(clean, currency);
	const negative = /^[^\d]*[-−]/.test(clean);
	return {text: clean, amount: value == null ? null : (negative ? -value : value), currency};
}

const MONTHS: Readonly<Record<string, number>> = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};

function ymd(year: number, month: number, day: number): string {
	if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31 && year > 2000)) {
		return '';
	}
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 「2026 年 10 月 15 日」「15 Oct, 2026」「Oct 15, 2026」「2026-10-15」→ 2026-10-15;没年份的用 currentYear */
export function parseHistoryDate(text: string, currentYear = new Date().getFullYear()): string {
	let match = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
	if (match) {
		return ymd(match[1] ? Number(match[1]) : currentYear, Number(match[2]), Number(match[3]));
	}
	match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
	if (match) {
		return ymd(Number(match[1]), Number(match[2]), Number(match[3]));
	}
	match = /(\d{1,2})\.?\s+([A-Za-z]{3})[a-z]*\.?,?(?:\s+(\d{4}))?/.exec(text);
	if (match && MONTHS[match[2]!.toLowerCase()]) {
		return ymd(match[3] ? Number(match[3]) : currentYear, MONTHS[match[2]!.toLowerCase()]!, Number(match[1]));
	}
	match = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?(?:\s+(\d{4}))?/.exec(text);
	if (match && MONTHS[match[1]!.toLowerCase()]) {
		return ymd(match[3] ? Number(match[3]) : currentYear, MONTHS[match[1]!.toLowerCase()]!, Number(match[2]));
	}
	return '';
}

/** 按类型列的文字分类;市场交易按钱包变动的正负分买入/卖出,「购买」钱包资金算充值 */
export function classifyHistoryRow(typeText: string, items: readonly string[], walletChange: Money | null): HistoryKind {
	if (/退款|Refund/i.test(typeText)) return 'refund';
	if (/转换|轉換|Conver/i.test(typeText)) return 'conversion';
	if (/游戏内|遊戲內|In-Game/i.test(typeText)) return 'ingame';
	if (/市场|市集|Market/i.test(typeText)) return (walletChange?.amount ?? 0) > 0 ? 'market_sell' : 'market_buy';
	if (/礼物|禮物|Gift/i.test(typeText)) return 'gift';
	const walletItem = items.some(item => /钱包|錢包|Wallet/i.test(item));
	if (/购买|購買|Purchase/i.test(typeText)) return walletItem ? 'wallet' : 'purchase';
	if (/钱包|錢包|Wallet|充值|Add Funds/i.test(typeText)) return 'wallet';
	return 'other';
}

function parseRow(attrs: string, body: string, options: ParseOptions): HistoryRow | null {
	const cells = new Map<string, CellLine[]>();
	for (const cell of body.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
		const key = classOf(cell[1] ?? '').split(/\s+/).find(name => name.startsWith('wht_'));
		if (key && !cells.has(key)) {
			cells.set(key, cellLines(cell[2] ?? ''));
		}
	}
	if (!cells.has('wht_type') && !cells.has('wht_items')) {
		return null;
	}
	const hint = String(options.currencyHint || '').toUpperCase();
	const lines = (key: string) => cells.get(key) ?? [];
	const text = (key: string) => lines(key).map(line => line.text).join(' ');
	const typeLines = lines('wht_type');
	const typeText = typeLines.filter(line => !line.payment).map(line => line.text).join(' ');
	const itemLines = lines('wht_items');
	const dateText = text('wht_date');
	if (!typeText && !itemLines.length && !dateText) {
		return null;
	}
	const walletChange = parseMoney(text('wht_wallet_change'), hint);
	const kind = classifyHistoryRow(typeText, itemLines.filter(line => !line.payment).map(line => line.text), walletChange);
	const market = kind === 'market_buy' || kind === 'market_sell';
	return {
		date: parseHistoryDate(dateText, options.currentYear),
		dateText,
		items: itemLines.map(line => line.text),
		typeText,
		kind,
		marketCount: market ? Number(/^\s*(\d+)/.exec(typeText)?.[1] ?? 1) : 0,
		payment: typeLines.filter(line => line.payment).map(line => line.text),
		refunded: kind === 'refund' || /\b(?:wht|wth)_(?:item_)?refunded\b/.test(attrs + body),
		total: parseMoney(text('wht_total'), hint),
		walletChange,
		walletBalance: parseMoney(text('wht_wallet_balance'), hint),
		transid: /transid=(\d+)/.exec(decodeEntities(attrs + body))?.[1] ?? ''
	};
}

/** 整页 HTML 或「加载更多」返回的 html 里的记录行(表头、「加载更多」行跳过) */
export function parseHistoryRows(html: string, options: ParseOptions = {}): HistoryRow[] {
	const rows: HistoryRow[] = [];
	for (const match of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
		const row = parseRow(match[1] ?? '', match[2] ?? '', options);
		if (row) {
			rows.push(row);
		}
	}
	return rows;
}

export function normalizeCursor(value: unknown): HistoryCursor | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const cursor = value as Record<string, unknown>;
	if (cursor.wallet_txnid == null && cursor.timestamp_newest == null) {
		return null;
	}
	return {
		wallet_txnid: String(cursor.wallet_txnid ?? ''),
		timestamp_newest: Number(cursor.timestamp_newest || 0),
		balance: String(cursor.balance ?? ''),
		currency: Number(cursor.currency || 0)
	};
}

/** 页面脚本里的 g_historyCursor;没有(或是 null)说明只有这一页 */
export function parseHistoryCursor(html: string): HistoryCursor | null {
	const match = /g_historyCursor\s*=\s*(\{[^;]*?\})\s*;/.exec(html);
	if (!match) {
		return null;
	}
	try {
		return normalizeCursor(JSON.parse(match[1]!));
	} catch {
		return null;
	}
}

// ===== 读取 =====

export type HistoryStatus = 'loading' | 'done' | 'error';

interface HistoryJob {
	accountName: string;
	status: HistoryStatus;
	rows: HistoryRow[];
	pages: number;
	/** 读到页数上限就停了,更早的没读 */
	truncated: boolean;
	error: string;
	startedAt: number;
	finishedAt: number;
}

export interface PublicHistory {
	accountName: string;
	status: HistoryStatus;
	pages: number;
	count: number;
	truncated: boolean;
	error: string;
	startedAt: string;
	/** 读取中为 '' */
	finishedAt: string;
	/** 读取中不带(轮询进度时省流量);读完或出错(已读到的部分)才给 */
	rows?: HistoryRow[];
}

type HistoryAttempt = Partial<Pick<Attempt, 'accountName' | 'cookies' | 'steamID' | 'id' | 'userAgent' | 'webSessionID' | 'currency' | 'currencyISO'>>;

export interface PurchaseHistoryOptions {
	/** 按账号名找内存里的会话(cookie、UA、sessionid、钱包币种);没有为 null */
	findAttempt(accountName: string): HistoryAttempt | null;
	/** 会话的网页 cookie:内存里的,或上次登录存下的 */
	cookiesFor(attempt: HistoryAttempt): readonly string[];
	/** 会话里没有钱包币种时用(缓存的账号资料) */
	currencyOf?(accountName: string): string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** 两页之间隔多久,免得被 Steam 限流 */
	pageGapMs?: number;
	maxPages?: number;
	/** 超时、429、5xx 时每页最多重试几次 */
	retries?: number;
	retryDelayMs?: number;
}

function errorText(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : String(err);
}

export function createPurchaseHistory(options: PurchaseHistoryOptions) {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const pageGapMs = options.pageGapMs ?? 1200;
	const maxPages = options.maxPages ?? 300;
	const retries = options.retries ?? 2;
	const retryDelayMs = options.retryDelayMs ?? 5000;
	/** 账号名小写 → 最近一次读取(只在内存里,重启就没了) */
	const jobs = new Map<string, HistoryJob>();

	function publicHistory(job: HistoryJob): PublicHistory {
		return {
			accountName: job.accountName,
			status: job.status,
			pages: job.pages,
			count: job.rows.length,
			truncated: job.truncated,
			error: job.error,
			startedAt: new Date(job.startedAt).toISOString(),
			finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : '',
			...(job.status === 'loading' ? {} : {rows: job.rows})
		};
	}

	async function withRetry<T>(run: () => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await run();
			} catch (err) {
				if (!(err instanceof StoreRequestError && err.retryable) || attempt >= retries) {
					throw err;
				}
				await sleep(retryDelayMs * (attempt + 1));
			}
		}
	}

	async function readAll(job: HistoryJob, attempt: HistoryAttempt | null, cookies: readonly string[]): Promise<void> {
		const session = createStoreSession({cookies, userAgent: attempt?.userAgent, fetch: options.fetch});
		const parseOptions: ParseOptions = {
			currencyHint: attempt?.currencyISO || currencyIdToIso(attempt?.currency) || options.currencyOf?.(job.accountName) || '',
			currentYear: new Date(now()).getFullYear()
		};
		const html = await withRetry(() => session.getHtml(HISTORY_URL, '消费记录页'));
		const loggedIn = /wallet_history_table|account_pulldown|g_historyCursor/.test(html) || (!!attempt?.steamID && html.includes(String(attempt.steamID)));
		if (!loggedIn) {
			throw new Error('消费记录页未登录(cookie 可能已失效,重新登录一次再读)');
		}
		job.rows.push(...parseHistoryRows(html, parseOptions));
		job.pages = 1;

		let cursor = parseHistoryCursor(html);
		// 「加载更多」要 sessionid(防 CSRF,和 cookie 里的一致)
		const sessionid = session.cookie('sessionid') || /g_sessionID\s*=\s*"([^"]+)"/.exec(html)?.[1] || attempt?.webSessionID || '';
		const seen = new Set<string>();
		while (cursor) {
			if (job.pages >= maxPages) {
				job.truncated = true;
				return;
			}
			const key = JSON.stringify(cursor);
			if (seen.has(key)) {
				return;   // 游标没往前走,别死循环
			}
			seen.add(key);
			await sleep(pageGapMs);
			const label = `第 ${job.pages + 1} 页消费记录`;
			const form = {
				'cursor[wallet_txnid]': cursor.wallet_txnid,
				'cursor[timestamp_newest]': String(cursor.timestamp_newest),
				'cursor[balance]': cursor.balance,
				'cursor[currency]': String(cursor.currency),
				sessionid
			};
			const data = await withRetry(() => session.postForm(MORE_URL, form, HISTORY_URL, label));
			const page = data && typeof data === 'object' ? data as {html?: unknown; cursor?: unknown} : {};
			if (typeof page.html !== 'string') {
				throw new Error(`${label}读取失败: ${JSON.stringify(data).slice(0, 200)}`);
			}
			const rows = parseHistoryRows(page.html, parseOptions);
			job.pages++;
			job.rows.push(...rows);
			cursor = normalizeCursor(page.cursor);
			if (!rows.length) {
				return;
			}
		}
	}

	async function run(job: HistoryJob, attempt: HistoryAttempt | null, cookies: readonly string[]): Promise<void> {
		try {
			await readAll(job, attempt, cookies);
			job.status = 'done';
		} catch (err) {
			job.status = 'error';
			job.error = errorText(err);
		} finally {
			job.finishedAt = now();
		}
	}

	/**
	 * 开始读取一个账号的全部消费记录(后台一页页翻,前端轮询 get 看进度)。
	 * 正在读的直接返回进度;读过的不重读,除非 force。账号没有网页 cookie 时抛错
	 */
	function load(accountName: string, force = false): PublicHistory {
		const key = accountName.toLowerCase();
		const existing = jobs.get(key);
		if (existing && (existing.status === 'loading' || !force)) {
			return publicHistory(existing);
		}
		const attempt = options.findAttempt(accountName);
		const cookies = options.cookiesFor(attempt ?? {accountName});
		if (!cookies.length) {
			throw new Error('这个账号没有网页会话,先登录一次再读');
		}
		const job: HistoryJob = {accountName, status: 'loading', rows: [], pages: 0, truncated: false, error: '', startedAt: now(), finishedAt: 0};
		jobs.set(key, job);
		void run(job, attempt, cookies);
		return publicHistory(job);
	}

	/** 最近一次读取的结果或进度;没读过为 null */
	function get(accountName: string): PublicHistory | null {
		const job = jobs.get(accountName.toLowerCase());
		return job ? publicHistory(job) : null;
	}

	return {load, get};
}

export type PurchaseHistory = ReturnType<typeof createPurchaseHistory>;
