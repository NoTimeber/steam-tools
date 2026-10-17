// 「实时运行日志」:各模块的操作结果都写到这里。存浏览器本地(最多 600 行),刷新页面不丢。
// 日志面板平时收在右下角的圆按钮里,收起时新来的日志记未读数(有错误单独记,按钮变红)。

import {reactive, ref} from 'vue';

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogLine {
	time: string;
	level: LogLevel;
	message: string;
}

const STORAGE_KEY = 'steam-tools.next.logs';
const PANEL_KEY = 'steam-tools.logPanel.open';
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

function loadOpen(): boolean {
	try {
		return localStorage.getItem(PANEL_KEY) === '1';
	} catch {
		return false;
	}
}

export const logLines = ref<LogLine[]>(load());

/** 面板开没开(这个浏览器记住,默认收起);收起期间来的日志条数和其中的错误数 */
export const logPanel = reactive({open: loadOpen(), unread: 0, unreadErrors: 0});

function setPanelOpen(open: boolean): void {
	logPanel.open = open;
	if (open) {
		logPanel.unread = 0;
		logPanel.unreadErrors = 0;
	}
	try {
		localStorage.setItem(PANEL_KEY, open ? '1' : '0');
	} catch {
		// 记不住就每次默认收起
	}
}

export function toggleLogPanel(): void {
	setPanelOpen(!logPanel.open);
}

export function closeLogPanel(): void {
	setPanelOpen(false);
}

export function addLog(level: LogLevel | string, message: string): void {
	const normalized: LogLevel = level === 'success' || level === 'warn' || level === 'error' ? level : 'info';
	const lines = [...logLines.value, {time: new Date().toLocaleTimeString('zh-CN', {hour12: false}), level: normalized, message}];
	logLines.value = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
	save(logLines.value);
	if (!logPanel.open) {
		logPanel.unread++;
		if (normalized === 'error') {
			logPanel.unreadErrors++;
		}
	}
}

export function clearLogs(): void {
	logLines.value = [];
	save([]);
}
