// 运行状态和远程更新(旧版启动器,见 ../core/launcher.ts)的 HTTP 路由。

import type {LauncherBridge} from '../core/launcher.ts';
import type {Router} from './http.ts';

export interface SystemRouteDeps {
	/** 当前会话数 */
	sessionCount(): number;
	launcher: LauncherBridge;
	uptime?: () => number;
}

export function systemRoutes(router: Router, deps: SystemRouteDeps): void {
	const uptime = deps.uptime ?? (() => process.uptime());

	router.get('/api/health', (req, res) => {
		res.json({success: true, uptime: uptime(), attempts: deps.sessionCount()});
	});

	// 前端查询是否有已暂存待生效的新版本。
	router.get('/api/update/status', (req, res) => {
		res.json({success: true, status: deps.launcher.status()});
	});

	// 手动触发一次检查:经 IPC 转给启动器,等它做完回读状态;没经启动器运行时直接返回本地已知状态。
	router.post('/api/update/check', async (req, res) => {
		try {
			const result = await deps.launcher.check();
			if ('busy' in result) {
				return res.status(409).json({success: false, error: '已有检查在进行中,请稍候'});
			}
			res.json({success: true, ...result});
		} catch (err) {
			res.status(500).json({success: false, error: err && (err as Error).message || '无法联系启动器'});
		}
	});

	// 一键重启以应用暂存的新版本(启动器收到特殊退出码后切换 app.next → app 再拉起新版)。
	router.post('/api/update/restart', (req, res) => {
		res.json({success: true, message: '正在重启以应用更新...'});
		deps.launcher.restart();
	});
}
