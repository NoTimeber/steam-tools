// 运行状态和新版本提示(见 ../core/version-check.ts)的 HTTP 路由。

import type {VersionCheck} from '../core/version-check.ts';
import type {Router} from './http.ts';

export interface SystemRouteDeps {
	/** 当前会话数 */
	sessionCount(): number;
	versionCheck: VersionCheck;
	uptime?: () => number;
}

export function systemRoutes(router: Router, deps: SystemRouteDeps): void {
	const uptime = deps.uptime ?? (() => process.uptime());

	router.get('/api/health', (req, res) => {
		res.json({success: true, uptime: uptime(), attempts: deps.sessionCount()});
	});

	// 当前版本和已知的最新版本(过期了后台会再查)。
	router.get('/api/update/status', (req, res) => {
		res.json({success: true, status: deps.versionCheck.status()});
	});

	// 手动检查:现查 GitHub 最新 Release;查失败的原因在 status.error 里。
	router.post('/api/update/check', async (req, res) => {
		res.json({success: true, status: await deps.versionCheck.check()});
	});
}
