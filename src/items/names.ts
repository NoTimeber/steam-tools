// CS2 饰品中英文名对照。C5 开放平台的查价、查在售、下单都只认 Steam 英文名(marketHashName),返回里也没有中文名;
// C5 扫货页输中文搜饰品、监控列表 / 流水 / 日志显示中文名都靠这份词库。
//
// 数据来自 ByMykel CSGO-API 的 zh-CN 数据(和 Steam 国区市场的中文名一致,如「AK-47（StatTrak™） | 红线 (久经沙场)」)。
// 原始数据近 90MB,不在运行时拉:scripts/build-cs2-names.ts 下载后只留「英文名 → 中文名」,gzip 存成随包的
// app/data/cs2-names-zh.json.gz。词库生成之后才出的新箱子查不到中文,仍可直接填英文名。

import {existsSync, readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

/** ByMykel zh-CN 里带 market_hash_name 的数据文件(基础武器、宠物、工具没有) */
export const NAME_SOURCES: readonly string[] = [
	'crates', 'keys', 'stickers', 'sticker_slabs', 'skins_not_grouped', 'agents', 'patches', 'graffiti', 'music_kits',
	'collectibles', 'keychains', 'highlights'
];

export function nameSourceUrl(file: string): string {
	return `https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/zh-CN/${file}.json`;
}

export interface NameMatch {
	/** Steam 英文名(marketHashName) */
	name: string;
	zh: string;
}

/** ByMykel 的数据列表 → {英文名: 中文名};同一英文名先到先得 */
export function buildNameMap(lists: readonly unknown[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const list of lists) {
		for (const entry of Array.isArray(list) ? list : []) {
			const name = typeof entry?.market_hash_name === 'string' ? entry.market_hash_name.trim() : '';
			const zh = typeof entry?.name === 'string' ? entry.name.trim() : '';
			if (name && zh && !(name in map)) {
				map[name] = zh;
			}
		}
	}
	return map;
}

export interface NameDb {
	/** 英文名 → 中文名;词库里没有返回 null */
	zh(name: string): string | null;
	/** 中文名 → 英文名(完全一致才算);不是词库里的中文名返回 null */
	nameOf(zh: string): string | null;
	/** 中文或英文搜,空格分开的几个词都要出现;完全一致的、开头一致的、名字短的排前面 */
	search(query: string, limit?: number): NameMatch[];
	size(): number;
}

// 中文名里 StatTrak / 纪念品 / ★ 用全角括号,磨损用半角括号,搜的时候不分
const fold = (text: string) => text.toLowerCase().replace(/（/g, '(').replace(/）/g, ')');

export function createNameDb(names: Readonly<Record<string, string>>): NameDb {
	const entries = Object.entries(names).map(([name, zh]) => ({name, zh, en: fold(name), cn: fold(zh)}));
	const byZh = new Map<string, string>();
	for (const {name, zh} of entries) {
		if (!byZh.has(zh)) {
			byZh.set(zh, name);
		}
	}

	return {
		zh: name => (Object.hasOwn(names, name) ? names[name] ?? null : null),
		nameOf: zh => byZh.get(zh.trim()) ?? null,
		search(query, limit = 20) {
			const q = fold(query.trim());
			const words = q.split(/\s+/).filter(Boolean);
			if (!words.length) {
				return [];
			}
			const rank = (entry: typeof entries[number]) => (entry.cn === q || entry.en === q ? 0 : entry.cn.startsWith(q) || entry.en.startsWith(q) ? 1 : 2);
			return entries
				.filter(entry => words.every(word => entry.cn.includes(word) || entry.en.includes(word)))
				.map(entry => ({entry, rank: rank(entry)}))
				.sort((a, b) => a.rank - b.rank || a.entry.zh.length - b.entry.zh.length || (a.entry.name < b.entry.name ? -1 : 1))
				.slice(0, limit)
				.map(({entry}) => ({name: entry.name, zh: entry.zh}));
		},
		size: () => entries.length
	};
}

/** 读 gzip 的词库文件({generatedAt, names});第一次用到时才读。文件没有或坏了当空词库 */
export function loadNameDb(file: string, logger: Pick<Console, 'warn'> = console): NameDb {
	let db: NameDb | null = null;
	const get = (): NameDb => {
		if (!db) {
			let names: Record<string, string> = {};
			try {
				if (existsSync(file)) {
					const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
					if (data && typeof data.names === 'object' && data.names) {
						names = data.names;
					}
				} else {
					logger.warn(`[items] 没有饰品中文名词库 ${file},只能填英文名`);
				}
			} catch (err) {
				logger.warn(`[items] 读饰品中文名词库失败,只能填英文名: ${err instanceof Error ? err.message : err}`);
			}
			db = createNameDb(names);
		}
		return db;
	};
	return {
		zh: name => get().zh(name),
		nameOf: zh => get().nameOf(zh),
		search: (query, limit) => get().search(query, limit),
		size: () => get().size()
	};
}
