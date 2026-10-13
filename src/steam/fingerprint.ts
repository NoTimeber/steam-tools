// 账号指纹(从 app/services/fingerprint.js 移来):每个账号一套「稳定但各异」的 machineID / machineName / User-Agent,
// 像一台固定的真实机器——长期不变,账号之间互不相同。
//
//   - machineID:覆盖 steam-user 的 machineIdFormat(3 个随机盐 → SHA1),去掉库默认
//     'SteamUser Hash BB3 {account_name}' 的固定特征,每账号唯一且稳定;
//   - machineName:仿 Windows 默认计算机名(DESKTOP-XXXXXXX / LAPTOP-XXXXXXX,共 15 字符);
//   - userAgent:从 data/ua_cache.json 随机选一条,只用于对 Steam 网页/社区的 HTTP 请求
//     (登录走 CM 二进制协议不发 UA,GC 不走 HTTP)。
// 第一次生成后写进 data/fingerprint_cache.json,之后按账号名(不区分大小写)复用。

import {randomBytes, randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from '../core/atomic-file.ts';

export interface Fingerprint {
	machineName: string;
	machineIdFormat: string[];
	userAgent: string;
}

interface CacheEntry {
	machineName?: unknown;
	machineIdFormat?: unknown;
	userAgent?: unknown;
}

function readJson(file: string, fallback: unknown): unknown {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

const MACHINE_NAME_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export interface FingerprintOptions {
	dataDir: string;
	log?: (level: 'warn', message: string) => void;
	random?: {bytes(size: number): Buffer; int(min: number, max: number): number};
	writeJson?: (file: string, value: unknown) => void;
}

export function createFingerprintStore(options: FingerprintOptions) {
	const log = options.log ?? (() => {});
	const random = options.random ?? {bytes: randomBytes, int: randomInt};
	const write = options.writeJson ?? ((file: string, value: unknown) => writeJsonAtomic(file, value));
	const cacheFile = join(options.dataDir, 'fingerprint_cache.json');
	const uaFile = join(options.dataDir, 'ua_cache.json');
	const cache = (readJson(cacheFile, {}) || {}) as Record<string, CacheEntry>;
	let uaList: string[] | null = null;   // 第一次用到才读

	function userAgents(): string[] {
		if (!uaList) {
			const raw = readJson(uaFile, null);
			uaList = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
			if (!uaList.length) {
				log('warn', 'data/ua_cache.json 为空或不存在,User-Agent 随机化已跳过');
			}
		}
		return uaList;
	}

	const token = () => random.bytes(16).toString('hex');

	function machineName(): string {
		const prefix = random.int(0, 100) < 80 ? 'DESKTOP' : 'LAPTOP';
		let suffix = '';
		for (let i = 0; i < 7; i++) {
			suffix += MACHINE_NAME_ALPHABET[random.int(0, MACHINE_NAME_ALPHABET.length)];
		}
		return `${prefix}-${suffix}`;
	}

	function pickUserAgent(): string {
		const list = userAgents();
		return list.length ? list[random.int(0, list.length)] as string : '';
	}

	/** 没有账号名(匿名)时给一次性的随机指纹,不缓存 */
	function getAccountFingerprint(accountName: unknown): Fingerprint {
		const key = String(accountName || '').trim().toLowerCase();
		if (!key) {
			return {machineName: machineName(), machineIdFormat: [token(), token(), token()], userAgent: pickUserAgent()};
		}
		let entry = cache[key];
		let changed = false;
		if (!entry || typeof entry !== 'object') {
			entry = {};
			changed = true;
		}
		if (!Array.isArray(entry.machineIdFormat) || entry.machineIdFormat.length !== 3) {
			entry.machineIdFormat = [token(), token(), token()];
			changed = true;
		}
		if (typeof entry.machineName !== 'string' || !entry.machineName) {
			entry.machineName = machineName();
			changed = true;
		}
		if (typeof entry.userAgent !== 'string' || !entry.userAgent) {
			const ua = pickUserAgent();
			if (ua) {
				entry.userAgent = ua;
				changed = true;
			}
		}
		if (changed) {
			cache[key] = entry;
			try {
				write(cacheFile, cache);
			} catch (err) {
				log('warn', '写入 fingerprint_cache.json 失败: ' + (err instanceof Error ? err.message : String(err)));
			}
		}
		return {
			machineName: entry.machineName as string,
			machineIdFormat: (entry.machineIdFormat as string[]).slice(),
			userAgent: (entry.userAgent as string) || ''
		};
	}

	return {getAccountFingerprint};
}
