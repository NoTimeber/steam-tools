// CS2「终端机开箱」的纯逻辑(不依赖 Vue):筛选、剩余次数、报价文字、确认框文字。规则照搬旧版前端。

/** 报价里的皮肤(src/terminal/skins.ts 补全过名字、外观、价格) */
export interface TerminalOffer {
	name?: string;
	image?: string;
	exterior?: string;
	rarity?: string;
	wear?: number | null;
	paintseed?: number | null;
	priceText?: string;
}

/** /api/terminal/state 的一个终端机 */
export interface TerminalItem {
	id: string;
	defIndex: number;
	sealed: boolean;
	name?: string;
	image?: string;
	picksUsed?: number | null;
	picksMax?: number | null;
	picksLeft?: number | null;
	/** 老字段:旧版后端用它表示已开次数 */
	pointsRemaining?: number | null;
	/** 毫秒时间戳 */
	expiresAt?: number | null;
	offer?: TerminalOffer | null;
	history?: TerminalOffer[];
}

export const TERMINAL_TYPES: ReadonlyArray<{value: string; label: string}> = [
	{value: '5176', label: '创世终端机'},
	{value: '5181', label: '毁灭之手终端机'}
];

export type StateFilter = 'all' | 'sealed' | 'open';

export function filterTerminals(list: readonly TerminalItem[], type: string, state: StateFilter): TerminalItem[] {
	return list.filter(item => {
		if (type !== 'all' && String(item.defIndex) !== type) return false;
		if (state === 'sealed' && !item.sealed) return false;
		if (state === 'open' && item.sealed) return false;
		return true;
	});
}

/** 挑选次数:后端给 picksUsed/picksMax/picksLeft;老字段兜底,上限缺省 5 */
export function picks(item: TerminalItem): {used: number | null; max: number; left: number | null} {
	const max = item.picksMax != null ? Number(item.picksMax) : 5;
	const used = item.picksUsed != null ? Number(item.picksUsed) : item.pointsRemaining != null ? Number(item.pointsRemaining) : null;
	const left = item.picksLeft != null ? Number(item.picksLeft) : used != null ? Math.max(0, max - used) : null;
	return {used, max, left};
}

/** 报价的两行小字:外观 · 磨损;稀有度 · 图案 */
export function offerLines(offer: TerminalOffer): [string, string] {
	const wear = offer.wear != null ? `磨损 ${Number(offer.wear).toFixed(4)}` : '';
	return [
		[offer.exterior || '', wear].filter(Boolean).join(' · '),
		[offer.rarity || '', offer.paintseed != null ? `图案 ${offer.paintseed}` : ''].filter(Boolean).join(' · ')
	];
}

export function formatExpire(ms: number | null | undefined): string {
	if (!ms) return '-';
	const date = new Date(Number(ms));
	return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', {hour12: false});
}

export function unsealConfirmText(id: string): string {
	return `确定解封这个终端机吗?\n\nGC id: ${id}\n\n⚠️ 不可逆:会启动 72 小时倒计时。解封后可「拒绝报价 · 换下一个」,买需在 Steam 客户端完成。`;
}

export function advanceConfirmText(id: string, left: number | null): string {
	const last = left != null && left <= 0 ? '\n\n⚠️ 该终端机挑选次数已达上限,这是拒绝最后一个报价(可能不会再有新报价)。' : '';
	return `确定「拒绝当前报价、换下一个」吗?\n\nGC id: ${id}\n· 不可逆:当前报价会被丢弃换成新的;\n· 消耗 1 次挑选;\n· 不花钱(买才花钱)。${last}`;
}
