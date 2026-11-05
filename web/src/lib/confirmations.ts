// 令牌确认(账户管理):待确认项的类型名、标签颜色、哪些涉及账号安全,以及按类型计数。
// 类型号是 Steam 的 EMobileConfirmationType;认不出的用 Steam 给的英文类型名。

import type {PendingConfirmation} from '../api/types.ts';

export type ConfirmationTag = 'default' | 'info' | 'success' | 'warning' | 'error';

const TYPES: Record<number, {label: string; tag: ConfirmationTag}> = {
	1: {label: '测试', tag: 'default'},
	2: {label: '交易报价', tag: 'info'},
	3: {label: '市场上架', tag: 'success'},
	4: {label: '功能变更', tag: 'warning'},
	5: {label: '更换手机号', tag: 'error'},
	6: {label: '账户恢复', tag: 'error'},
	9: {label: '创建 API Key', tag: 'error'},
	11: {label: '加入家庭组', tag: 'warning'},
	12: {label: '市场求购', tag: 'success'}
};

/** 换手机号、账户恢复、创建 API Key:动账号安全的,不跟着「全选」一起勾,要单独看清楚再点 */
const SENSITIVE = new Set([5, 6, 9]);

export function confirmationType(conf: Pick<PendingConfirmation, 'type' | 'typeName'>): {label: string; tag: ConfirmationTag} {
	return TYPES[conf.type] ?? {label: conf.typeName || `类型 ${conf.type}`, tag: 'default'};
}

export function isSensitive(conf: Pick<PendingConfirmation, 'type'>): boolean {
	return SENSITIVE.has(conf.type);
}

/** 交易报价在 Steam 网页上的地址(creator 是报价 id);别的类型没有 */
export function tradeOfferUrl(conf: Pick<PendingConfirmation, 'type' | 'creator'>): string {
	return conf.type === 2 && /^\d+$/.test(conf.creator) ? `https://steamcommunity.com/tradeoffer/${conf.creator}/` : '';
}

/** 「全选」勾哪些:涉及账号安全的除外 */
export function selectableIds(list: readonly PendingConfirmation[]): string[] {
	return list.filter(conf => !isSensitive(conf)).map(conf => conf.id);
}

/** 按类型计数,按第一次出现的顺序:「交易报价 3 · 市场上架 1」 */
export function typeCounts(list: readonly PendingConfirmation[]): Array<{label: string; count: number}> {
	const counts = new Map<string, number>();
	for (const conf of list) {
		const {label} = confirmationType(conf);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts].map(([label, count]) => ({label, count}));
}
