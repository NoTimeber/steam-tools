// 消费记录的纯逻辑(不依赖 Vue,单元测试直接用 node 跑):类型名、按类型汇总、金额显示、筛选、导出 CSV。

import type {HistoryKind, HistoryMoney, HistoryRow} from '../api/types.ts';

/** 类型的显示顺序和名字 */
export const HISTORY_KINDS: ReadonlyArray<{key: HistoryKind; label: string}> = [
	{key: 'purchase', label: '商店购买'},
	{key: 'gift', label: '礼物购买'},
	{key: 'ingame', label: '游戏内购买'},
	{key: 'market_buy', label: '市场买入'},
	{key: 'market_sell', label: '市场卖出'},
	{key: 'wallet', label: '钱包充值'},
	{key: 'refund', label: '退款'},
	{key: 'conversion', label: '货币转换'},
	{key: 'other', label: '其它'}
];

const KIND_LABEL = new Map(HISTORY_KINDS.map(kind => [kind.key, kind.label]));

export function kindLabel(kind: HistoryKind): string {
	return KIND_LABEL.get(kind) ?? kind;
}

const CURRENCY_SIGNS: Readonly<Record<string, string>> = {
	CNY: '¥', JPY: 'JP¥', USD: '$', EUR: '€', GBP: '£', RUB: '₽', KRW: '₩', HKD: 'HK$', TWD: 'NT$', UAH: '₴', KZT: '₸', TRY: '₺', INR: '₹'
};

/** 汇总后的金额:币种符号 + 两位小数;不认识的币种写代码 */
export function formatAmount(amount: number, currency: string): string {
	const sign = amount < 0 ? '-' : '';
	const mark = CURRENCY_SIGNS[currency] ?? (currency ? currency + ' ' : '');
	return `${sign}${mark}${Math.abs(amount).toFixed(2)}`;
}

/** 一行记录算多少钱:优先总额,没有用钱包变动(都取绝对值) */
function rowAmount(row: HistoryRow): HistoryMoney | null {
	for (const money of [row.total, row.walletChange]) {
		if (money && money.amount != null) {
			return money;
		}
	}
	return null;
}

export interface KindSummary {
	kind: HistoryKind;
	label: string;
	/** 记录行数 */
	count: number;
	/** 交易笔数(市场交易一行可能合并了好几笔) */
	trades: number;
	/** 按币种分开的合计,金额大的在前 */
	totals: Array<{currency: string; amount: number}>;
}

/** 按类型汇总(只列有记录的类型);金额按币种分开,不换算 */
export function summarizeHistory(rows: readonly HistoryRow[]): KindSummary[] {
	const byKind = new Map<HistoryKind, {count: number; trades: number; totals: Map<string, number>}>();
	for (const row of rows) {
		const entry = byKind.get(row.kind) ?? {count: 0, trades: 0, totals: new Map<string, number>()};
		byKind.set(row.kind, entry);
		entry.count++;
		entry.trades += row.marketCount > 0 ? row.marketCount : 1;
		const money = rowAmount(row);
		if (money) {
			entry.totals.set(money.currency, (entry.totals.get(money.currency) ?? 0) + Math.abs(money.amount!));
		}
	}
	return HISTORY_KINDS.filter(kind => byKind.has(kind.key)).map(kind => {
		const entry = byKind.get(kind.key)!;
		return {
			kind: kind.key,
			label: kind.label,
			count: entry.count,
			trades: entry.trades,
			totals: [...entry.totals.entries()]
				.map(([currency, amount]) => ({currency, amount: Math.round(amount * 100) / 100}))
				.sort((left, right) => right.amount - left.amount)
		};
	});
}

/** 按类型和关键字(商品、类型、付款方式、日期里任一包含,不分大小写)筛选 */
export function filterHistory(rows: readonly HistoryRow[], kind: HistoryKind | '', keyword: string): HistoryRow[] {
	const needle = keyword.trim().toLowerCase();
	return rows.filter(row => {
		if (kind && row.kind !== kind) {
			return false;
		}
		if (!needle) {
			return true;
		}
		return [...row.items, row.typeText, ...row.payment, row.date, row.dateText].some(text => text.toLowerCase().includes(needle));
	});
}

/** 日期范围(YYYY-MM-DD,含两端);null 表示不限 */
export type DateRange = readonly [string, string] | null;

/** 按日期范围筛选;设了范围时,日期解析不出来的记录排除 */
export function inDateRange(rows: readonly HistoryRow[], range: DateRange): HistoryRow[] {
	if (!range) {
		return [...rows];
	}
	const [from, to] = range[0] <= range[1] ? range : [range[1], range[0]];
	return rows.filter(row => !!row.date && row.date >= from && row.date <= to);
}

const CSV_HEADER = ['日期', '类型', 'Steam 类型', '商品', '付款方式', '总额', '钱包变动', '钱包余额', '币种', '市场交易笔数', '含退款', '交易号'];

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 文字列:= + - @ 开头的前面加 ',免得 Excel 当公式执行 */
function textCell(text: string): string {
	return csvCell(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
}

/** 金额列:解析出数值的写数值(带正负号,表格里能直接求和),解析不了的写原文 */
function moneyCell(money: HistoryMoney | null): string {
	if (!money) {
		return '';
	}
	return money.amount != null ? String(money.amount) : textCell(money.text);
}

/** 导出 CSV:带 BOM(Excel 直接打开中文不乱码),CRLF 换行;多个商品、付款方式用「 / 」连起来 */
export function historyCsv(rows: readonly HistoryRow[]): string {
	const lines = [CSV_HEADER.join(',')];
	for (const row of rows) {
		const currency = [row.total, row.walletChange, row.walletBalance].find(money => money?.currency)?.currency ?? '';
		lines.push([
			textCell(row.date || row.dateText),
			textCell(kindLabel(row.kind)),
			textCell(row.typeText),
			textCell(row.items.join(' / ')),
			textCell(row.payment.join(' / ')),
			moneyCell(row.total),
			moneyCell(row.walletChange),
			moneyCell(row.walletBalance),
			currency,
			row.marketCount ? String(row.marketCount) : '',
			row.refunded ? '是' : '',
			row.transid
		].join(','));
	}
	return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n';
}

/** 导出文件名:账号-消费记录-起止日期(不限时间为「全部」) */
export function csvFileName(accountName: string, range: DateRange): string {
	const name = accountName.replace(/[\\/:*?"<>|\s]+/g, '_') || '账号';
	const span = range ? (range[0] <= range[1] ? `${range[0]}至${range[1]}` : `${range[1]}至${range[0]}`) : '全部';
	return `${name}-消费记录-${span}.csv`;
}
