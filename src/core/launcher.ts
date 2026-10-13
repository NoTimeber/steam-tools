// 和旧版启动器(launcher.js)配合的远程更新(从 app/server.js 移来)。Docker 部署不经启动器,更新靠重新构建镜像。
//
// 真正的联网拉取、验签、下载、暂存都由启动器做:这里经 IPC 把「检查更新」转给它,等它做完再回读 update-status.json;
// 「重启应用更新」用特殊退出码退出,启动器收到后把 app.next 换成 app 再拉起新版。

import {readFileSync} from 'node:fs';

/** 子进程用这个退出码退出,启动器会应用暂存的更新并重启(见 launcher.js) */
export const RESTART_EXIT_CODE = 75;
const CHECK_TIMEOUT_MS = 25000;
const RESTART_DELAY_MS = 300;

export interface UpdateStatus {
	pending?: boolean;
	[key: string]: unknown;
}

interface LauncherProcess {
	send?: (message: unknown) => unknown;
	on(event: 'message', listener: (message: any) => void): unknown;
	exit(code: number): void;
}

export interface LauncherOptions {
	/** data/update-status.json(启动器检测到新版本时写) */
	statusFile: string;
	process?: LauncherProcess;
	setTimer?: (callback: () => void, ms: number) => {cancel(): void};
}

export type CheckResult =
	| {checked: boolean; status: UpdateStatus; message?: string}
	| {busy: true};

export function createLauncherBridge(options: LauncherOptions) {
	const proc = options.process ?? process as unknown as LauncherProcess;
	const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => {
		const timer = setTimeout(callback, ms);
		return {cancel: () => clearTimeout(timer)};
	});
	let pending: ((status: UpdateStatus | undefined) => void) | null = null;

	/** 没有状态文件 = 没检测到更新 */
	function status(): UpdateStatus {
		try {
			return JSON.parse(readFileSync(options.statusFile, 'utf8'));
		} catch {
			return {pending: false};
		}
	}

	proc.on('message', message => {
		if (message && message.type === 'check-update-done' && pending) {
			const resolve = pending;
			pending = null;
			resolve(message.status || status());
		}
	});

	/**
	 * 让启动器检查一次更新。没经启动器运行(无 IPC)时直接返回本地已知状态;
	 * 已有检查在进行中返回 {busy};25 秒还没结果就先返回「后台进行中」,之后启动器写状态文件时前端会自动提示
	 */
	function check(): Promise<CheckResult> {
		if (typeof proc.send !== 'function') {
			return Promise.resolve({checked: false, status: status(), message: '当前未通过启动器运行,无法联网检查更新'});
		}
		if (pending) {
			return Promise.resolve({busy: true});
		}
		return new Promise((resolve, reject) => {
			const timer = setTimer(() => {
				if (pending) {
					pending = null;
					resolve({checked: false, status: status(), message: '正在后台检查/下载,稍后将自动提示'});
				}
			}, CHECK_TIMEOUT_MS);
			pending = result => {
				timer.cancel();
				resolve({checked: true, status: result || status()});
			};
			try {
				proc.send?.({type: 'check-update'});
			} catch (err) {
				timer.cancel();
				pending = null;
				reject(err);
			}
		});
	}

	/** 稍等一下(让响应先发出去)再用重启码退出 */
	function restart(): void {
		setTimer(() => proc.exit(RESTART_EXIT_CODE), RESTART_DELAY_MS);
	}

	return {status, check, restart};
}

export type LauncherBridge = ReturnType<typeof createLauncherBridge>;
