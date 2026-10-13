'use strict';

// 账户指纹模块:为每个账号生成「稳定但各异」的 machineID / machineName / User-Agent。
// 设计目标 = 模拟真实机器:每个账号一套固定指纹(长期不变),账号之间互不相同。
//
//   - machineID :覆盖 steam-user 的 machineIdFormat(3 个随机盐 → SHA1)。既去掉库默认
//                 'SteamUser Hash BB3 {account_name}' 的固定特征,又保证每账号唯一且稳定。
//   - machineName:仿 Windows 默认计算机名(DESKTOP-XXXXXXX / LAPTOP-XXXXXXX,共 15 字符)。
//   - userAgent :从 data/ua_cache.json 随机选一条(仅用于对 Steam 网页/社区的 HTTP 请求,
//                 登录本身走 CM 二进制协议不发 UA,GC 不走 HTTP,均不涉及)。
//
// 全部一次性生成后写入 data/fingerprint_cache.json,之后按账号名复用。

const fs = require('fs');
const {writeJsonAtomic} = require('../lib/atomic-file');
const path = require('path');
const crypto = require('crypto');

function readJsonSafe(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (_) {
		return fallback;
	}
}

function createFingerprintStore(options = {}) {
	const dataDir = options.dataDir;
	const log = typeof options.logger === 'function' ? options.logger : () => {};
	const cacheFile = path.join(dataDir, 'fingerprint_cache.json');
	const uaFile = path.join(dataDir, 'ua_cache.json');

	const cache = readJsonSafe(cacheFile, {}) || {};
	let uaList = null;   // 懒加载,首次用到时读盘

	function loadUaList() {
		if (uaList) {
			return uaList;
		}
		const raw = readJsonSafe(uaFile, null);
		uaList = Array.isArray(raw) ? raw.filter(item => typeof item === 'string' && item.trim()) : [];
		if (!uaList.length) {
			log('warn', 'data/ua_cache.json 为空或不存在,User-Agent 随机化已跳过');
		}
		return uaList;
	}

	function persist() {
		try {
			writeJsonAtomic(cacheFile, cache);
		} catch (err) {
			log('warn', '写入 fingerprint_cache.json 失败: ' + err.message);
		}
	}

	function randomToken(bytes = 16) {
		return crypto.randomBytes(bytes).toString('hex');
	}

	// 仿 Windows 默认计算机名:DESKTOP-XXXXXXX(大写字母数字,共 15 字符),少量 LAPTOP-。
	function randomMachineName() {
		const prefix = crypto.randomInt(0, 100) < 80 ? 'DESKTOP' : 'LAPTOP';
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
		let suffix = '';
		for (let i = 0; i < 7; i++) {
			suffix += alphabet[crypto.randomInt(0, alphabet.length)];
		}
		return `${prefix}-${suffix}`;
	}

	function pickUserAgent() {
		const list = loadUaList();
		return list.length ? list[crypto.randomInt(0, list.length)] : '';
	}

	// 返回 {machineName, machineIdFormat:[s1,s2,s3], userAgent}。无账号名(如匿名)时给一次性随机、不缓存。
	function getAccountFingerprint(accountName) {
		const key = String(accountName || '').trim().toLowerCase();
		if (!key) {
			return {
				machineName: randomMachineName(),
				machineIdFormat: [randomToken(), randomToken(), randomToken()],
				userAgent: pickUserAgent()
			};
		}

		let entry = cache[key];
		let changed = false;
		if (!entry || typeof entry !== 'object') {
			entry = {};
			changed = true;
		}
		if (!Array.isArray(entry.machineIdFormat) || entry.machineIdFormat.length !== 3) {
			entry.machineIdFormat = [randomToken(), randomToken(), randomToken()];
			changed = true;
		}
		if (typeof entry.machineName !== 'string' || !entry.machineName) {
			entry.machineName = randomMachineName();
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
			persist();
		}
		return {
			machineName: entry.machineName,
			machineIdFormat: entry.machineIdFormat.slice(),
			userAgent: entry.userAgent || ''
		};
	}

	return {getAccountFingerprint};
}

module.exports = {createFingerprintStore};
