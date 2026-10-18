// item_nameid 查找(从 app/server.js 移来)。盘口接口 itemordershistogram 要 nameid,而 Steam 改版后商品页基本抓不到它,
// 所以按这个顺序找:用户手填 → 本地缓存(data/market-nameids.json)→ 社区 nameid 库。
//
// 社区库({market_hash_name: nameid},CS2/TF2 各一个文件)随程序打包在 app/services/nameid-db/,
// 正常只读本地;文件缺失时才从 github.com/somespecialone/steam-item-name-ids 拉一次并落盘。
// 已存在的物品 nameid 不会变,只有新物品才需要更新这个库。

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {MarketLog} from './client.ts';

const DB_GAME_BY_APPID: Readonly<Record<number, string>> = {730: 'CS2', 440: 'TF2'};
const DB_DOWNLOAD_URL = 'https://raw.githubusercontent.com/somespecialone/steam-item-name-ids/main/data/{game}/item_names.json';

export interface NameIdOptions {
	/** 本地缓存 {"appid|market_hash_name": nameid} */
	cacheFile: string;
	/** 社区库目录({CS2,TF2}.json) */
	dbDir: string;
	readJson(file: string): unknown;
	writeJson(file: string, value: unknown): void;
	writeText(file: string, text: string): void;
	fetch?: typeof fetch;
	log?: MarketLog;
}

type NameIdMap = Record<string, unknown>;

function isMap(value: unknown): value is NameIdMap {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function digits(value: unknown): string {
	return String(value ?? '').replace(/\D/g, '');
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function nameIdKey(appid: number, marketHashName: string): string {
	return `${Number(appid)}|${String(marketHashName || '')}`;
}

export function createNameIdResolver(options: NameIdOptions) {
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const log: MarketLog = options.log ?? (() => {});
	const dbCache = new Map<string, Promise<NameIdMap>>();

	function loadCache(): NameIdMap {
		const data = options.readJson(options.cacheFile);
		return isMap(data) ? data : {};
	}

	function cached(appid: number, marketHashName: string): string {
		const value = loadCache()[nameIdKey(appid, marketHashName)];
		return value ? String(value) : '';
	}

	/** 拿到 nameid(手填或抓到)就记下来,下次自动用 */
	function remember(appid: number, marketHashName: string, nameId: unknown): void {
		const id = digits(nameId);
		if (!id) {
			return;
		}
		const map = loadCache();
		const key = nameIdKey(appid, marketHashName);
		if (map[key] === id) {
			return;
		}
		map[key] = id;
		try {
			options.writeJson(options.cacheFile, map);
		} catch (err) {
			log('warn', `[market-buyorder] nameid 缓存保存失败: ${errorText(err)}`);
		}
	}

	function readLocalDb(game: string): NameIdMap | null {
		try {
			const map: unknown = JSON.parse(readFileSync(join(options.dbDir, game + '.json'), 'utf8'));
			return isMap(map) ? map : null;
		} catch {
			return null;
		}
	}

	async function downloadDb(game: string): Promise<NameIdMap> {
		const res = await http(DB_DOWNLOAD_URL.replace('{game}', game), {headers: {'User-Agent': 'steam-tools'}, signal: AbortSignal.timeout(15000)});
		if (!res.ok) {
			throw new Error('HTTP ' + res.status);
		}
		const text = await res.text();
		const map: unknown = JSON.parse(text);
		if (!isMap(map)) {
			throw new Error('数据格式异常');
		}
		try {
			options.writeText(join(options.dbDir, game + '.json'), text);
		} catch (err) {
			log('warn', `[market-buyorder] nameid 库落盘失败(${game}): ${errorText(err)}`);
		}
		return map;
	}

	async function loadDb(game: string): Promise<NameIdMap> {
		let map = readLocalDb(game);
		if (!map) {
			try {
				map = await downloadDb(game);
				log('info', `[market-buyorder] 本地 nameid 库缺失,已从社区仓库补全(${game})`);
			} catch (err) {
				log('warn', `[market-buyorder] nameid 库加载失败(${game}): ${errorText(err)}`);
				map = {};
			}
		}
		log('info', `[market-buyorder] nameid 库就绪(${game}): ${Object.keys(map).length} 条`);
		return map;
	}

	/** 某个游戏的社区库;不是 CS2/TF2 为 null。每个游戏只加载一次(并发的查询共用同一次加载) */
	function db(appid: number): Promise<NameIdMap> | null {
		const game = DB_GAME_BY_APPID[Number(appid)];
		if (!game) {
			return null;
		}
		let pending = dbCache.get(game);
		if (!pending) {
			pending = loadDb(game);
			dbCache.set(game, pending);
		}
		return pending;
	}

	/** 查社区库;不是 CS2/TF2 或库里没有返回空串 */
	async function fromDb(appid: number, marketHashName: string): Promise<string> {
		const pending = db(appid);
		return pending ? digits((await pending)[marketHashName]) : '';
	}

	/** 社区库里这个游戏的全部物品英文名(搜商品用);不是 CS2/TF2 为空 */
	async function names(appid: number): Promise<string[]> {
		const pending = db(appid);
		return pending ? Object.keys(await pending) : [];
	}

	/** 手填 → 本地缓存 → 社区库 */
	async function resolve(appid: number, marketHashName: string, manual?: unknown): Promise<string> {
		return digits(manual) || cached(appid, marketHashName) || await fromDb(appid, marketHashName);
	}

	return {cached, remember, fromDb, names, resolve};
}

export type NameIdResolver = ReturnType<typeof createNameIdResolver>;
