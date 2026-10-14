// 新版本提示:后端查 GitHub 上的最新 Release,有新版就在顶部提示。只提示不自动更新——
// 镜像由 GitHub Actions 发版时构建,更新要在服务器上执行 UPDATE_COMMAND(拉新镜像、重建容器)。

import {reactive} from 'vue';
import {api} from '../api/http.ts';
import type {UpdateStatus} from '../api/types.ts';

export const UPDATE_COMMAND = 'git pull && docker compose pull && docker compose up -d';
/** 页面开着时隔多久再问一次后端(后端自己 6 小时才真去查 GitHub) */
const POLL_MS = 60 * 60 * 1000;
const DISMISSED_KEY = 'steam-tools.update.dismissed';

function readDismissed(): string {
	try {
		return localStorage.getItem(DISMISSED_KEY) || '';
	} catch {
		return '';
	}
}

export const update = reactive({
	current: '',
	/** 服务端关了检查(UPDATE_CHECK=0) */
	disabled: false,
	latest: '',
	hasUpdate: false,
	notes: '',
	url: '',
	error: '',
	/** 点过「忽略这个版本」的版本号 */
	dismissed: readDismissed()
});

function setDismissed(version: string): void {
	update.dismissed = version;
	try {
		localStorage.setItem(DISMISSED_KEY, version);
	} catch {
		// 存储不可用时只是刷新后会再提示
	}
}

export function dismissUpdate(): void {
	setDismissed(update.latest);
}

function apply(status: UpdateStatus): void {
	update.current = status.current || '';
	update.disabled = !!status.disabled;
	update.latest = status.latest || '';
	update.hasUpdate = !!status.hasUpdate;
	update.notes = (status.notes || '').trim();
	update.url = status.url && status.url.startsWith('https://') ? status.url : '';
	update.error = status.error || '';
}

export async function loadUpdateStatus(): Promise<void> {
	try {
		const data = await api.get<{status: UpdateStatus}>('/api/update/status');
		apply(data.status);
	} catch {
		// 拿不到就不提示
	}
}

/** 打开页面时读一次,之后每小时再读一次(页面常开几天不关) */
export function startUpdateStatus(): void {
	loadUpdateStatus();
	window.setInterval(loadUpdateStatus, POLL_MS);
}

export interface CheckOutcome {
	kind: 'available' | 'latest' | 'failed';
	message: string;
}

/** 手动检查:后端现查 GitHub;有新版时即使之前忽略过也重新提示 */
export async function checkForUpdate(): Promise<CheckOutcome> {
	const data = await api.post<{status: UpdateStatus}>('/api/update/check');
	apply(data.status);
	if (update.disabled) {
		return {kind: 'failed', message: '服务端关了版本检查(UPDATE_CHECK=0)'};
	}
	if (update.error) {
		return {kind: 'failed', message: '检查更新失败:' + update.error};
	}
	if (update.hasUpdate) {
		setDismissed('');
		return {kind: 'available', message: `发现新版本 v${update.latest},更新方法见顶部提示`};
	}
	return {kind: 'latest', message: `已是最新版本(v${update.current})`};
}
