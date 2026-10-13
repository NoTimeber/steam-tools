// 右侧「实时运行日志」:各模块的操作结果都写到这里。存浏览器本地(最多 600 行),刷新页面不丢。

import {ref} from 'vue';

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogLine {
	time: string;
	level: LogLevel;
	message: string;
}

const STORAGE_KEY = 'steam-tools.next.logs';
const MAX_LINES = 600;

function load(): LogLine[] {
	try {
		const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
		return Array.isArray(data) ? data.slice(-MAX_LINES).filter(line => line && typeof line.message === 'string') : [];
	} catch {
		return [];
	}
}

function save(lines: LogLine[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
	} catch {
		// 存储不可用(隐私模式/超额)时只是刷新后丢日志
	}
}

export const logLines = ref<LogLine[]>(load());

export function addLog(level: LogLevel | string, message: string): void {
	const normalized: LogLevel = level === 'success' || level === 'warn' || level === 'error' ? level : 'info';
	const lines = [...logLines.value, {time: new Date().toLocaleTimeString('zh-CN', {hour12: false}), level: normalized, message}];
	logLines.value = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
	save(logLines.value);
}

export function clearLogs(): void {
	logLines.value = [];
	save([]);
}
