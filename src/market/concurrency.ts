// 多账号并发:求购(./index.ts)和出售(./sell.ts)共用。

/** 并发上限 1~8,默认 2(太高容易触发 Steam 风控) */
export function clampConcurrency(value: unknown): number {
	return Math.max(1, Math.min(8, Math.round(Number(value)) || 2));
}

/** 最多 limit 个同时跑,结果与 items 同序 */
export async function runWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	const lanes = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
	let cursor = 0;
	async function lane(): Promise<void> {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await worker(items[index] as T, index);
		}
	}
	await Promise.all(Array.from({length: lanes}, lane));
	return results;
}
