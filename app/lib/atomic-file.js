'use strict';

// 原子写盘:先写同目录临时文件并 fsync,再 rename 覆盖目标。
// 进程在写入中途崩溃/被 kill 时,目标文件要么是旧内容要么是新内容,不会出现半截 JSON。
// (Windows 上目标被其它进程占用时 rename 可能 EPERM/EBUSY,短暂重试几次。)

const fs = require('fs');
const path = require('path');

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const backedUpCorruptFiles = new Set();

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeFileAtomic(file, data, encoding) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, {recursive: true});
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	const fd = fs.openSync(tmp, 'w', 0o600);
	try {
		fs.writeFileSync(fd, data, encoding);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tmp, file);
			return;
		} catch (err) {
			if (attempt >= 4 || !RENAME_RETRY_CODES.has(err.code)) {
				try { fs.unlinkSync(tmp); } catch (_) {}
				throw err;
			}
			sleepSync(50 * (attempt + 1));
		}
	}
}

function writeJsonAtomic(file, value, space = 2) {
	writeFileAtomic(file, JSON.stringify(value, null, space), 'utf8');
}

// 读 JSON:文件不存在返回 null;内容损坏时先把坏文件备份成 <name>.corrupt-<时间戳>,再返回 null。
// 以前损坏会被静默当成"空",下一次写入就把空数据固化,原内容彻底丢失。
function readJsonFileSafe(file, logger = console) {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (err.code !== 'ENOENT') {
			logger.error(`[atomic-file] 读取 ${file} 失败: ${err.message}`);
		}
		return null;
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		// 同一份坏文件只备份一次(调用方可能频繁读取)
		const fingerprint = `${file}:${text.length}:${text.slice(0, 64)}`;
		if (backedUpCorruptFiles.has(fingerprint)) {
			return null;
		}
		backedUpCorruptFiles.add(fingerprint);
		const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		try {
			fs.copyFileSync(file, backup);
			logger.error(`[atomic-file] ${file} 不是合法 JSON(${err.message}),已备份到 ${backup}`);
		} catch (copyErr) {
			logger.error(`[atomic-file] ${file} 不是合法 JSON,且备份失败: ${copyErr.message}`);
		}
		return null;
	}
}

module.exports = {writeFileAtomic, writeJsonAtomic, readJsonFileSafe};
