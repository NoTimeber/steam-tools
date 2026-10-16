// 消费记录的纯逻辑(不依赖 Vue,单元测试直接用 node 跑):类型名、按类型计数、筛选、导出 CSV。

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

/** 各类型的记录条数(按类型顺序,只列有记录的),给类型下拉用 */
export function countKinds(rows: readonly HistoryRow[]): Array<{kind: HistoryKind; label: string; count: number}> {
	const counts = new Map<HistoryKind, number>();
	for (const row of rows) {
		counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
	}
	return HISTORY_KINDS.filter(kind => counts.has(kind.key)).map(kind => ({kind: kind.key, label: kind.label, count: counts.get(kind.key)!}));
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
