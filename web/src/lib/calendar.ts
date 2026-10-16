// 日期范围选择器的纯逻辑(不依赖 Vue):一个月的日历格子、翻月、起止排序。
// 日期都用本地日期的 YYYY-MM-DD 字符串,字符串比较就是日期先后。

export interface CalendarDay {
	/** YYYY-MM-DD */
	date: string;
	day: number;
	/** 本月的日子;前后补齐的上月、下月日子为 false */
	inMonth: boolean;
}

/** 年和月(month 0-11,同 Date) */
export interface YearMonth {
	year: number;
	month: number;
}

const pad = (value: number): string => String(value).padStart(2, '0');

export function isoDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** YYYY-MM-DD 所在的年月;解析不了用 fallback */
export function monthOf(date: string | null | undefined, fallback: YearMonth): YearMonth {
	const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date ?? '');
	return match ? {year: Number(match[1]), month: Number(match[2]) - 1} : fallback;
}

/** 往前(负)或往后翻几个月 */
export function shiftMonth({year, month}: YearMonth, delta: number): YearMonth {
	const date = new Date(year, month + delta, 1);
	return {year: date.getFullYear(), month: date.getMonth()};
}

/** 一个月的日历:周一开头,固定 6 行 42 格(换月时高度不变) */
export function monthDays({year, month}: YearMonth): CalendarDay[] {
	const offset = (new Date(year, month, 1).getDay() + 6) % 7;
	return Array.from({length: 42}, (_, index) => {
		const date = new Date(year, month, 1 - offset + index);
		return {date: isoDate(date), day: date.getDate(), inMonth: date.getMonth() === month};
	});
}

/** 两次点的日期排成 [早, 晚](先点晚的也行) */
export function orderedRange(first: string, second: string): [string, string] {
	return first <= second ? [first, second] : [second, first];
}
