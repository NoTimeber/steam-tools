// 一次性把旧版明文 JSON 数据导入加密数据库。
// 规则:
//   - 某类数据在库里还没有时才导入;库里已有则跳过(防止把旧备份拷回来覆盖新数据)。
//   - 读不了/不是合法 JSON 的文件原地不动,只记日志。
//   - 读成功的文件(不论导入还是跳过)全部挪到 <dataDir>/_migrated_plaintext/<时间>/ 下,
//     数据目录里不再散落明文凭据;不删除任何东西,由用户确认后自行删除该目录。

import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync} from 'node:fs';
import {basename, dirname, join, relative} from 'node:path';
import {transaction} from '../core/db.ts';
import type {Db} from '../core/db.ts';
import type {AccountStore} from './accounts.ts';
import type {MaFile, MaFileStore} from './mafiles.ts';
import type {SteamSession, SteamSessionStore} from './steam-sessions.ts';
import type {UuDeliveryConfig, UuStore, UuTokenEntry} from './uu.ts';

export interface LegacyPaths {
	accountsFile: string;
	mafileDir: string;
	sessionDir: string;
	uuTokensFile: string;
	uuConfigFile: string;
	uuLastTokenFile: string;
}

export interface ImportReport {
	archiveDir: string | null;
	imported: {accounts: number; mafiles: number; sessions: number; uuTokens: number; uuDelivery: number};
	/** 已归档但没导入的文件(库里已有同类数据) */
	skipped: string[];
	/** 读取失败、原地保留的文件 */
	failed: string[];
}

interface Logger {
	log(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

type Kind = 'accounts' | 'mafile' | 'session' | 'uuTokens' | 'uuConfig' | 'uuLastToken';

interface Candidate {
	file: string;
	kind: Kind;
}

interface Stores {
	db: Db;
	accounts: AccountStore;
	mafiles: MaFileStore;
	sessions: SteamSessionStore;
	uu: UuStore;
}

function listFiles(dir: string, suffix: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, {withFileTypes: true})
		.filter(entry => entry.isFile() && entry.name.endsWith(suffix) && !entry.name.startsWith('.'))
		.map(entry => join(dir, entry.name))
		.sort();
}

function moveFile(from: string, to: string): void {
	mkdirSync(dirname(to), {recursive: true});
	try {
		renameSync(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
			throw err;
		}
		copyFileSync(from, to);
		unlinkSync(from);
	}
}

export function importLegacyFiles(stores: Stores, paths: LegacyPaths, dataDir: string, logger: Logger, now = new Date()): ImportReport {
	const report: ImportReport = {
		archiveDir: null,
		imported: {accounts: 0, mafiles: 0, sessions: 0, uuTokens: 0, uuDelivery: 0},
		skipped: [],
		failed: []
	};

	const single = (file: string, kind: Kind): Candidate[] => (existsSync(file) ? [{file, kind}] : []);
	const candidates: Candidate[] = [
		...single(paths.accountsFile, 'accounts'),
		...listFiles(paths.mafileDir, '.maFile').map(file => ({file, kind: 'mafile' as const})),
		...listFiles(paths.sessionDir, '.json').map(file => ({file, kind: 'session' as const})),
		...single(paths.uuTokensFile, 'uuTokens'),
		...single(paths.uuConfigFile, 'uuConfig'),
		...single(paths.uuLastTokenFile, 'uuLastToken')
	];
	if (!candidates.length) {
		return report;
	}

	const parsed: Array<Candidate & {value: unknown}> = [];
	for (const candidate of candidates) {
		if (candidate.kind === 'uuLastToken') {
			parsed.push({...candidate, value: null}); // 只是 tokens.json 的冗余副本,不导入,直接归档
			continue;
		}
		try {
			parsed.push({...candidate, value: JSON.parse(readFileSync(candidate.file, 'utf8'))});
		} catch (err) {
			report.failed.push(candidate.file);
			logger.error(`[legacy-import] 读取 ${candidate.file} 失败,保留原文件: ${(err as Error).message}`);
		}
	}

	const archived: string[] = [];
	transaction(stores.db, () => {
		for (const {file, kind, value} of parsed) {
			if (kind === 'accounts') {
				if (!Array.isArray(value) || stores.accounts.isInitialized()) {
					report.skipped.push(file);
				} else {
					report.imported.accounts = stores.accounts.replaceAll(value).length;
				}
			} else if (kind === 'mafile') {
				const maFile = value && typeof value === 'object' ? (value as MaFile) : null;
				const name = String(maFile?.account_name ?? maFile?.accountName ?? basename(file, '.maFile')).trim();
				if (!maFile || !name || stores.mafiles.has(name)) {
					report.skipped.push(file);
				} else {
					stores.mafiles.put(name, maFile);
					report.imported.mafiles++;
				}
			} else if (kind === 'session') {
				const key = basename(file, '.json');
				if (!value || typeof value !== 'object' || stores.sessions.has(key)) {
					report.skipped.push(file);
				} else {
					stores.sessions.put(key, value as SteamSession);
					report.imported.sessions++;
				}
			} else if (kind === 'uuTokens') {
				if (!Array.isArray(value) || stores.uu.listTokens().length) {
					report.skipped.push(file);
				} else {
					stores.uu.replaceTokens(value as UuTokenEntry[]);
					report.imported.uuTokens = stores.uu.listTokens().length;
				}
			} else if (kind === 'uuConfig') {
				if (!value || typeof value !== 'object' || stores.uu.loadDeliveryConfig() !== null) {
					report.skipped.push(file);
				} else {
					stores.uu.saveDeliveryConfig(value as UuDeliveryConfig);
					report.imported.uuDelivery = Object.keys(value).filter(key => !key.startsWith('__')).length;
				}
			}
			// uuLastToken:tokens.json 的冗余副本,不导入,只归档
			archived.push(file);
		}
	});

	if (archived.length) {
		const stamp = now.toISOString().replace(/[:.]/g, '-');
		const archiveDir = join(dataDir, '_migrated_plaintext', stamp);
		for (const file of archived) {
			const rel = relative(dataDir, file);
			const target = rel.startsWith('..') ? join(archiveDir, 'external', basename(file)) : join(archiveDir, rel);
			moveFile(file, target);
		}
		report.archiveDir = archiveDir;
		const {accounts, mafiles, sessions, uuTokens, uuDelivery} = report.imported;
		logger.log(`[legacy-import] 旧数据已导入加密数据库:账户 ${accounts}、maFile ${mafiles}、session ${sessions}、UU token ${uuTokens}、UU 发货配置 ${uuDelivery}`);
		if (report.skipped.length) {
			logger.warn(`[legacy-import] ${report.skipped.length} 个文件因库里已有同类数据而未导入(已一并归档): ${report.skipped.map(f => relative(dataDir, f)).join(', ')}`);
		}
		logger.warn(`[legacy-import] 原明文文件已移到 ${archiveDir},确认数据正常后请删除该目录(里面是明文密码和令牌)。`);
	}
	return report;
}
