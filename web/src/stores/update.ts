// 远程更新(旧版启动器):启动时读一次状态,有暂存的新版本就在顶部提示;「运行设置」里可手动检查。
// Docker 部署不经启动器,这里一直是「没有更新」。

import {reactive} from 'vue';
import {api} from '../api/http.ts';
import type {UpdateStatus} from '../api/types.ts';

export const update = reactive({
	current: '',
	/** 待生效的新版本;空 = 没有 */
	available: '',
	notes: '',
	dismissed: '',
	restarting: false,
	restartMessage: ''
});

function apply(status: UpdateStatus): void {
	update.current = status.current ? String(status.current) : '';
	update.available = status.pending && status.available ? String(status.available) : '';
	update.notes = status.notes ? String(status.notes).trim() : '';
}

export async function loadUpdateStatus(): Promise<void> {
	try {
		const data = await api.get<{status?: UpdateStatus}>('/api/update/status');
		apply(data.status || {});
	} catch {
		// 拿不到就不提示
	}
}

export interface CheckOutcome {
	kind: 'available' | 'background' | 'latest';
	message: string;
}

/** 手动检查:后端经 IPC 让启动器联网检查;大包还在后台下载时之后每 10 秒补查一次,共 1 分钟 */
export async function checkForUpdate(): Promise<CheckOutcome> {
	const data = await api.post<{checked?: boolean; message?: string; status?: UpdateStatus}>('/api/update/check');
	apply(data.status || {});
	if (update.available) {
		update.dismissed = '';
		return {kind: 'available', message: `发现新版本 v${update.available},可在顶部横幅点「立即重启生效」`};
	}
	if (data.checked === false) {
		let count = 0;
		const timer = window.setInterval(() => {
			loadUpdateStatus();
			if (++count >= 6) {
				window.clearInterval(timer);
			}
		}, 10000);
		return {kind: 'background', message: data.message || '正在后台检查,稍后将自动提示'};
	}
	return {kind: 'latest', message: '已是最新版本' + (update.current ? `(v${update.current})` : '')};
}

/** 重启应用更新:服务端会退出,等它回来再刷新页面(最多等 1 分钟) */
export async function restartForUpdate(): Promise<void> {
	update.restarting = true;
	update.restartMessage = '正在重启以应用更新,请稍候…';
	try {
		await api.post('/api/update/restart');
	} catch {
		// 服务端可能已经退出,响应中断属正常
	}
	await new Promise(resolve => window.setTimeout(resolve, 1500));
	for (let attempt = 0; attempt <= 60; attempt++) {
		try {
			const res = await fetch('/api/health', {cache: 'no-store'});
			if (res.ok) {
				window.location.reload();
				return;
			}
		} catch {
			// 还没起来
		}
		await new Promise(resolve => window.setTimeout(resolve, 1000));
	}
	update.restartMessage = '重启耗时较久,请稍后手动刷新页面。';
}
