// 给新建的 Steam 客户端挂 CS2 / TF2 的 GC 模块(globaloffensive / tf2),跟踪 GC 连接状态和 CS2 库存变化
// (从 app/server.js 移来)。会话本身由 ./session-manager.ts 管理,它在客户端建好、logOn 之前调这里。
// 挂得要早(GC 欢迎消息到达前),终端机才能抓到连接时内嵌的初始 SO 缓存(含报价)。

import type {Attempt} from './session-manager.ts';
import {updateDefaultGcState} from './gc-client.ts';

interface GcModule {
	on(event: string, listener: (...args: any[]) => void): unknown;
}

type GcModuleClass = new (client: unknown) => GcModule;

export interface GcModuleOptions {
	GlobalOffensive: GcModuleClass;
	TeamFortress2: GcModuleClass;
	events: {addLog(attempt: Attempt, level: string, message: string): void; emit(attempt: Attempt): void};
	/** CS2 库存:连上 / 物品变化时刷新数量和 GC 快照 */
	inventory: {refreshFromGc(attempt: Attempt): void};
	/** CS2 模块挂上、GC 连上时调(终端机挂抓包监听,要幂等) */
	onCs2Module?(attempt: Attempt): void;
}

function errorText(err: unknown): string {
	return err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
}

export function createGcModuleAttacher(options: GcModuleOptions) {
	const {events, inventory} = options;

	function hookCs2(attempt: Attempt): void {
		try {
			options.onCs2Module?.(attempt);
		} catch {
			// 抓包挂不上不影响 GC 本身
		}
	}

	function attachCs2(attempt: Attempt, csgo: GcModule): void {
		csgo.on('connectedToGC', () => {
			attempt.cs2GcConnected = true;
			attempt.tf2GcConnected = false;
			attempt.activeGame = 'cs2';
			updateDefaultGcState(attempt);
			attempt.inventorySource = 'gc';
			inventory.refreshFromGc(attempt);
			hookCs2(attempt);
			events.emit(attempt);
		});
		csgo.on('disconnectedFromGC', () => {
			attempt.cs2GcConnected = false;
			updateDefaultGcState(attempt);
			events.emit(attempt);
		});
		for (const event of ['itemAcquired', 'itemChanged', 'itemRemoved']) {
			csgo.on(event, () => {
				inventory.refreshFromGc(attempt);
				events.emit(attempt);
			});
		}
		csgo.on('error', (err: unknown) => {
			attempt.cs2GcConnected = false;
			updateDefaultGcState(attempt);
			events.addLog(attempt, 'warn', 'GC 连接失败: ' + errorText(err));
			events.emit(attempt);
		});
	}

	function attachTf2(attempt: Attempt, tf2: GcModule): void {
		tf2.on('connectedToGC', () => {
			attempt.cs2GcConnected = false;
			attempt.tf2GcConnected = true;
			attempt.activeGame = 'tf2';
			updateDefaultGcState(attempt);
			events.emit(attempt);
		});
		tf2.on('disconnectedFromGC', () => {
			attempt.tf2GcConnected = false;
			updateDefaultGcState(attempt);
			events.emit(attempt);
		});
	}

	/** session-manager 的 onClientCreated */
	function attach(attempt: Attempt, client: unknown): void {
		try {
			const csgo = new options.GlobalOffensive(client);
			attempt.csgo = csgo;
			attachCs2(attempt, csgo);
			options.onCs2Module?.(attempt);
		} catch (err) {
			events.addLog(attempt, 'warn', 'CS2 GC 初始化失败: ' + errorText(err));
		}
		try {
			const tf2 = new options.TeamFortress2(client);
			attempt.tf2 = tf2;
			attachTf2(attempt, tf2);
		} catch (err) {
			events.addLog(attempt, 'warn', 'TF2 GC 初始化失败: ' + errorText(err));
		}
	}

	return {attach};
}
