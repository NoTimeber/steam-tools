// 库存的 HTTP 路由。

import type {Attempt, SessionManager} from '../steam/session-manager.ts';
import {sendError} from '../web/http.ts';
import type {Router} from '../web/http.ts';
import type {InventoryService} from './index.ts';

export interface InventoryRouteDeps {
	inventory: Pick<InventoryService, 'get'>;
	/** 按 attemptId 找会话 */
	getAttempt(id: string): Attempt | undefined;
	publicAttempt: SessionManager['publicAttempt'];
}

export function inventoryRoutes(router: Router, {inventory, getAttempt, publicAttempt}: InventoryRouteDeps): void {
	// ?refresh=1 跳过缓存
	router.get('/api/inventory/:id', async (req, res) => {
		const attempt = getAttempt(req.params.id!);
		if (!attempt) {
			return res.status(404).json({success: false, error: '任务不存在'});
		}
		try {
			const snapshot = await inventory.get(attempt, {forceRefresh: req.query.refresh === '1'});
			res.json({success: true, attempt: publicAttempt(attempt), inventory: snapshot});
		} catch (err) {
			sendError(res, err, '库存读取失败');
		}
	});
}
