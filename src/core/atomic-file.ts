// 原子写盘和安全读 JSON(从 app/lib/atomic-file.js 移来)。
//
// 写:先写同目录临时文件并 fsync,再 rename 覆盖目标。进程写到一半崩溃/被杀时,目标文件要么是旧内容要么是新内容,
// 不会出现半截 JSON。Windows 上目标被别的进程占用时 rename 可能 EPERM/EBUSY,短暂重试几次。
// 读:文件不存在返回 null;内容损坏时先把坏文件备份成 <name>.corrupt-<时间戳> 再返回 null
// (以前损坏会被静默当成「空」,下一次写入就把空数据固化,原内容彻底丢失)。

import {closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** 同一份坏文件只备份一次(调用方可能频繁读取) */
const backedUpCorruptFiles = new Set<string>();

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(err: unknown): string {
	return err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function writeFileAtomic(file: string, data: string | Uint8Array, encoding?: BufferEncoding): void {
	const dir = dirname(file);
	mkdirSync(dir, {recursive: true});
	const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
	const fd = openSync(tmp, 'w', 0o600);
	try {
		writeFileSync(fd, data, encoding);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(tmp, file);
			return;
		} catch (err) {
			if (attempt >= 4 || !RENAME_RETRY_CODES.has(errorCode(err))) {
				try {
					unlinkSync(tmp);
				} catch {
					// 临时文件删不掉也不影响结果
				}
				throw err;
			}
			sleepSync(50 * (attempt + 1));
		}
	}
}

/** space 传 0 写成紧凑 JSON */
export function writeJsonAtomic(file: string, value: unknown, space = 2): void {
	writeFileAtomic(file, JSON.stringify(value, null, space), 'utf8');
}

export function readJsonFileSafe(file: string, logger: Pick<Console, 'error'> = console): any {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch (err) {
		if (errorCode(err) !== 'ENOENT') {
			logger.error(`[atomic-file] 读取 ${file} 失败: ${errorText(err)}`);
		}
		return null;
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		const fingerprint = `${file}:${text.length}:${text.slice(0, 64)}`;
		if (backedUpCorruptFiles.has(fingerprint)) {
			return null;
		}
		backedUpCorruptFiles.add(fingerprint);
		const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		try {
			copyFileSync(file, backup);
			logger.error(`[atomic-file] ${file} 不是合法 JSON(${errorText(err)}),已备份到 ${backup}`);
		} catch (copyErr) {
			logger.error(`[atomic-file] ${file} 不是合法 JSON,且备份失败: ${errorText(copyErr)}`);
		}
		return null;
	}
}
