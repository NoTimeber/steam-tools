// 终端机报价历史(从 app/server.js 移来):每次「换下一个」揭示的报价追加到 data/terminal-offers.json(按终端机 GC id),
// 刷新页面、重启后还能看到之前开出过哪些报价。GC id 是持久的 assetid,解封后跨会话稳定。

const MAX_PER_TERMINAL = 30;   // 挑选上限是 5,留足余量

export interface HistoryRecord {
	defIndex: number;
	offers: Array<Record<string, unknown>>;
	updatedAt?: string;
}

export interface OfferHistoryOptions {
	file: string;
	readJson(file: string): unknown;
	writeJson(file: string, value: unknown): void;
	now?: () => number;
}

export function createOfferHistory(options: OfferHistoryOptions) {
	const now = options.now ?? Date.now;

	function all(): Record<string, HistoryRecord> {
		const data = options.readJson(options.file);
		return data && typeof data === 'object' ? data as Record<string, HistoryRecord> : {};
	}

	function get(terminalId: unknown): Array<Record<string, unknown>> {
		const record = all()[String(terminalId)];
		return record && Array.isArray(record.offers) ? record.offers : [];
	}

	/** 追加一条揭示出的报价(已补好中文名、图片、价格);和上一条同 itemid 就不重复记。返回该终端机的全部历史 */
	function append(terminalId: unknown, defIndex: unknown, offer: Record<string, unknown> | null | undefined): Array<Record<string, unknown>> {
		const key = String(terminalId || '').trim();
		if (!key || !offer) {
			return get(key);
		}
		const map = all();
		const record: HistoryRecord = map[key] && typeof map[key] === 'object' ? map[key] : {defIndex: Number(defIndex) || 0, offers: []};
		if (!Array.isArray(record.offers)) {
			record.offers = [];
		}
		const last = record.offers[record.offers.length - 1];
		const sameAsLast = last && offer.itemid != null && String(last.itemid) === String(offer.itemid);
		const stamp = new Date(now()).toISOString();
		if (!sameAsLast) {
			record.offers.push({...offer, revealedAt: stamp});
			if (record.offers.length > MAX_PER_TERMINAL) {
				record.offers = record.offers.slice(-MAX_PER_TERMINAL);
			}
		}
		record.defIndex = Number(defIndex) || record.defIndex || 0;
		record.updatedAt = stamp;
		map[key] = record;
		try {
			options.writeJson(options.file, map);
		} catch {
			// 写不了就只在这次返回里有
		}
		return record.offers;
	}

	return {all, get, append};
}

export type OfferHistory = ReturnType<typeof createOfferHistory>;
