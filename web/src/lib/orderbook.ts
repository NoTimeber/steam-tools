// 市场盘口(分档的在售 / 求购)的纯逻辑:一个价格排在第几档、前面有多少、显示哪几行、深度条的比例。
// 档位来自后端 src/market/client.ts 的 OrderLevel:在售从低到高、求购从高到低,quantity 是本档数量,cumulative 是累计。

export interface OrderLevel {
	priceCents: number;
	quantity: number;
	cumulative: number;
}

export type BookSide = 'sell' | 'buy';

/** 默认显示几档 */
export const BOOK_DEFAULT_LEVELS = 5;

/** 价格 a 是不是比 b「更靠前」:在售越便宜越靠前,求购越高越靠前 */
function better(side: BookSide, a: number, b: number): boolean {
	return side === 'sell' ? a < b : a > b;
}

export interface BookPosition {
	/** 排在第几档(1 起);同价并进那一档 */
	level: number;
	/** 并进了已有的同价档 */
	joins: boolean;
	/** 前面更好的件数(在售:更便宜的;求购:出价更高的) */
	ahead: number;
	/** 同价已有的件数(同价按时间排,排在它们后面) */
	samePrice: number;
	/** 价格在已知档位之外(盘口只给了前 30 档左右),ahead 只是下限 */
	beyond: boolean;
}

/** 某个价格在一边盘口里的位置;价格无效返回 null */
export function bookPosition(levels: readonly OrderLevel[], side: BookSide, priceCents: number | null | undefined): BookPosition | null {
	if (priceCents == null || !Number.isFinite(priceCents) || priceCents <= 0) {
		return null;
	}
	let ahead = 0;
	let index = 0;
	for (const level of levels) {
		if (better(side, level.priceCents, priceCents)) {
			ahead += level.quantity;
			index++;
			continue;
		}
		const joins = level.priceCents === priceCents;
		return {level: index + 1, joins, ahead, samePrice: joins ? level.quantity : 0, beyond: false};
	}
	return {level: index + 1, joins: false, ahead, samePrice: 0, beyond: levels.length > 0};
}

/** 位置说明。format 把分格式化成带币种的价 */
export function positionText(side: BookSide, priceCents: number, position: BookPosition, format: (cents: number) => string): string {
	const price = format(priceCents);
	const atLeast = position.beyond ? '至少' : '';
	const same = position.samePrice ? `,同价已有 ${position.samePrice} ${side === 'sell' ? '件' : '个'}排在前面` : '';
	if (side === 'sell') {
		if (!position.ahead && !position.beyond) {
			return `按 ${price} 上架:是最低价(排第 1 档)${same}`;
		}
		return `按 ${price} 上架:前面${atLeast}有 ${position.ahead} 件更便宜(排第 ${position.level} 档${position.beyond ? '之后' : ''})${same}`;
	}
	if (!position.ahead && !position.beyond) {
		return `按 ${price} 求购:是最高的求购(排第 1 档)${same}`;
	}
	return `按 ${price} 求购:前面${atLeast}有 ${position.ahead} 个更高的求购(排第 ${position.level} 档${position.beyond ? '之后' : ''})${same}`;
}

/** 表格里的一行:一档,或者「我的价」插在两档之间的标记行 */
export type BookRow =
	| {kind: 'level'; level: OrderLevel; index: number; mine: boolean}
	| {kind: 'mine'; priceCents: number};

/**
 * 要显示的行:前 limit 档(expanded 时全部);给了我的价时,同价那一档标出来,不同价就在该在的位置插一行标记
 * (位置在显示范围之外就不插,只看文字说明)
 */
export function bookRows(levels: readonly OrderLevel[], side: BookSide, myPriceCents: number | null | undefined, expanded: boolean, limit = BOOK_DEFAULT_LEVELS): BookRow[] {
	const shown = expanded ? levels : levels.slice(0, limit);
	const position = bookPosition(levels, side, myPriceCents);
	const rows: BookRow[] = [];
	shown.forEach((level, index) => {
		if (position && !position.joins && position.level === index + 1) {
			rows.push({kind: 'mine', priceCents: myPriceCents!});
		}
		rows.push({kind: 'level', level, index, mine: !!position?.joins && position.level === index + 1});
	});
	// 排在显示的最后一档之后:全部显示了(或总共就这几档)才在末尾插
	if (position && !position.joins && position.level === shown.length + 1 && shown.length === levels.length) {
		rows.push({kind: 'mine', priceCents: myPriceCents!});
	}
	return rows;
}

/** 深度条的分母:显示的档里最大的数量(至少 1) */
export function maxQuantity(levels: readonly OrderLevel[]): number {
	return Math.max(1, ...levels.map(level => level.quantity));
}

/** 深度条宽度百分比(0~100,有数量的至少 2%,免得看不见) */
export function barPercent(quantity: number, max: number): number {
	if (!(quantity > 0) || !(max > 0)) {
		return 0;
	}
	return Math.max(2, Math.min(100, Math.round(quantity / max * 100)));
}
