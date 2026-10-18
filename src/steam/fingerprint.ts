// 账号指纹(从 app/services/fingerprint.js 移来):每个账号一套「稳定但各异」的 machineID / machineName / User-Agent,
// 像一台固定的真实机器——长期不变,账号之间互不相同。
//
//   - machineID:覆盖 steam-user 的 machineIdFormat(3 个随机盐 → SHA1),去掉库默认
//     'SteamUser Hash BB3 {account_name}' 的固定特征,每账号唯一且稳定;
//   - machineName:仿 Windows 默认计算机名(DESKTOP-XXXXXXX / LAPTOP-XXXXXXX,共 15 字符);
//   - userAgent:从新版 Chrome 的 UA 池(./user-agent.ts,最新几个大版本 × Windows / Mac)随机挑一条,只用于对 Steam
//     网页/社区的 HTTP 请求(登录走 CM 二进制协议不发 UA,GC 不走 HTTP)。老 Chrome UA 会被 Steam 429,
//     所以缓存里不在当前池里的(以前 data/ua_cache.json 那批最高 Chrome/99 的、空的)下次用到时重新挑。
// 第一次生成后写进 data/fingerprint_cache.json,之后按账号名(不区分大小写)复用。

import {randomBytes, randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from '../core/atomic-file.ts';
import {isCurrentWebUserAgent, webUserAgentPool} from './user-agent.ts';

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
	/** UA 池;默认 webUserAgentPool() */
	userAgents?: readonly string[];
	random?: {bytes(size: number): Buffer; int(min: number, max: number): number};
	writeJson?: (file: string, value: unknown) => void;
}

export function createFingerprintStore(options: FingerprintOptions) {
	const log = options.log ?? (() => {});
	const random = options.random ?? {bytes: randomBytes, int: randomInt};
	const write = options.writeJson ?? ((file: string, value: unknown) => writeJsonAtomic(file, value));
	const cacheFile = join(options.dataDir, 'fingerprint_cache.json');
	const cache = (readJson(cacheFile, {}) || {}) as Record<string, CacheEntry>;
	const userAgents = options.userAgents?.length ? options.userAgents : webUserAgentPool();

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
		return userAgents[random.int(0, userAgents.length)] as string;
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
		if (!isCurrentWebUserAgent(entry.userAgent, userAgents)) {
			entry.userAgent = pickUserAgent();
			changed = true;
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
			userAgent: entry.userAgent as string
		};
	}

	/** 只看缓存里这个账号的指纹,没有不生成(账户详情页用);UA 不在当前池里的(下次登录会换掉)给空串 */
	function peekAccountFingerprint(accountName: unknown): {machineName: string; userAgent: string} | null {
		const entry = cache[String(accountName || '').trim().toLowerCase()];
		if (!entry || typeof entry !== 'object') {
			return null;
		}
		return {
			machineName: typeof entry.machineName === 'string' ? entry.machineName : '',
			userAgent: isCurrentWebUserAgent(entry.userAgent, userAgents) ? entry.userAgent : ''
		};
	}

	return {getAccountFingerprint, peekAccountFingerprint};
}
