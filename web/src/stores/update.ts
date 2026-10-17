// 新版本提示和一键更新:后端查 GitHub 上的最新 Release,有新版就在顶部提示。
// 服务器上装了更新器(deploy/install-updater.sh)时可以在面板上点「立即更新」:后端放一个请求,宿主机拉代码、拉镜像、重建容器,
// 这里每 2 秒读一次进度(重启那一会儿读不到,当作「重启中」)。没装时提示在服务器上执行 UPDATE_COMMAND。

import {reactive} from 'vue';
import {api} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import type {SelfUpdateStatus, UpdateStatus} from '../api/types.ts';

export const UPDATE_COMMAND = 'git pull && docker compose pull && docker compose up -d';
export const INSTALL_UPDATER_COMMAND = 'sudo ./deploy/install-updater.sh';
/** 页面开着时隔多久再问一次后端(后端自己 6 小时才真去查 GitHub) */
const POLL_MS = 60 * 60 * 1000;
/** 更新中读进度的间隔 */
const PROGRESS_POLL_MS = 2000;
const DISMISSED_KEY = 'steam-tools.update.dismissed';
const DISMISSED_FINISH_KEY = 'steam-tools.update.dismissedFinish';
/** 打开页面时发现这么久以内刚更新完,也提示一句(更新重启后面板要重新登录,登录后看得到结果) */
const RECENT_FINISH_MS = 10 * 60 * 1000;

function readStored(key: string): string {
	try {
		return localStorage.getItem(key) || '';
	} catch {
		return '';
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 存储不可用时只是刷新后会再提示
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
	dismissed: readStored(DISMISSED_KEY),
	/** 这个页面打开时服务端的版本;一键更新后服务端版本变了,提示刷新页面 */
	pageVersion: ''
});

/** 一键更新的进度 */
export const selfUpdate = reactive({
	loaded: false,
	installed: false,
	state: 'idle' as SelfUpdateStatus['state'],
	step: '' as SelfUpdateStatus['step'],
	message: '',
	log: '',
	requestedAt: 0,
	startedAt: 0,
	finishedAt: 0,
	from: '',
	to: '',
	stale: false,
	/** 更新中读不到进度(服务正在重启) */
	unreachable: false,
	/** 刚更新完(这个页面看着它完成的,或者打开页面时刚完成不久):提示一句,点关闭消失 */
	justFinished: false,
	/** 点过「关闭」的那次结果(更新完成或失败,按结束时间认) */
	dismissedFinish: Number(readStored(DISMISSED_FINISH_KEY)) || 0
});

function setDismissed(version: string): void {
	update.dismissed = version;
	writeStored(DISMISSED_KEY, version);
}

export function dismissUpdate(): void {
	setDismissed(update.latest);
}

function apply(status: UpdateStatus): void {
	update.current = status.current || '';
	update.pageVersion ||= update.current;
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

/** 更新中(请求放了或者宿主机在跑) */
export function isUpdating(): boolean {
	return selfUpdate.state === 'pending' || selfUpdate.state === 'running';
}

/** 一键更新后服务端已经是新版本了,页面还是旧的:要刷新 */
export function needsReload(): boolean {
	return !!update.pageVersion && !!update.current && update.current !== update.pageVersion;
}

let progressTimer: ReturnType<typeof setTimeout> | undefined;

function applyProgress(status: SelfUpdateStatus): void {
	const wasUpdating = isUpdating();
	const firstLoad = !selfUpdate.loaded;
	Object.assign(selfUpdate, {
		loaded: true,
		unreachable: false,
		installed: !!status.installed,
		state: status.state,
		step: status.step,
		message: status.message || '',
		log: status.log || '',
		requestedAt: status.requestedAt || 0,
		startedAt: status.startedAt || 0,
		finishedAt: status.finishedAt || 0,
		from: status.from || '',
		to: status.to || '',
		stale: !!status.stale
	});
	// 刚更新完:读一下服务端现在的版本(变了就提示刷新页面)
	if (wasUpdating && !isUpdating()) {
		selfUpdate.justFinished = selfUpdate.state === 'done';
		void loadUpdateStatus();
	} else if (firstLoad && selfUpdate.state === 'done' && Date.now() - selfUpdate.finishedAt < RECENT_FINISH_MS && selfUpdate.finishedAt !== selfUpdate.dismissedFinish) {
		selfUpdate.justFinished = true;
	}
}

/** 更新中每 2 秒读一次进度;读不到(重启中)也接着读 */
function scheduleProgress(): void {
	clearTimeout(progressTimer);
	if (isUpdating()) {
		progressTimer = setTimeout(() => void loadSelfUpdate(), PROGRESS_POLL_MS);
	}
}

export async function loadSelfUpdate(): Promise<void> {
	try {
		applyProgress((await api.get<{update: SelfUpdateStatus}>('/api/update/progress')).update);
	} catch {
		if (isUpdating()) {
			selfUpdate.unreachable = true;
		}
	}
	scheduleProgress();
}

/** 请求一键更新(没装更新器、已经在更新时后端回 409,错误抛给页面) */
export async function applyUpdate(): Promise<void> {
	applyProgress((await api.post<{update: SelfUpdateStatus}>('/api/update/apply')).update);
	scheduleProgress();
}

/** 关掉「更新完成 / 更新失败」的提示(这次结果不再提示) */
export function dismissFinish(): void {
	selfUpdate.justFinished = false;
	selfUpdate.dismissedFinish = selfUpdate.finishedAt;
	writeStored(DISMISSED_FINISH_KEY, String(selfUpdate.finishedAt));
}

/** 打开页面时读一次,之后每小时再读一次(页面常开几天不关);断线重连后(可能是更新重启了)再读一次进度 */
export function startUpdateStatus(): void {
	loadUpdateStatus();
	loadSelfUpdate();
	window.setInterval(() => {
		loadUpdateStatus();
		loadSelfUpdate();
	}, POLL_MS);
	socket.on('connect', () => {
		if (selfUpdate.loaded) {
			loadSelfUpdate();
			loadUpdateStatus();
		}
	});
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
		return {kind: 'available', message: `发现新版本 v${update.latest},${selfUpdate.installed ? '可以点「立即更新」' : '更新方法见顶部提示'}`};
	}
	return {kind: 'latest', message: `已是最新版本(v${update.current})`};
}
