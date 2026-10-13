// 支持 GC 操作的两款游戏(从 app/server.js 的 PURCHASE_GAME_CONFIGS 移来)。

export type GameId = 'cs2' | 'tf2';

export interface GameConfig {
	id: GameId;
	label: string;
	taskType: string;
	appId: number;
	/** attempt 上挂 GC 模块实例的字段 */
	moduleKey: 'csgo' | 'tf2';
	/** attempt 上表示该游戏 GC 已连接的字段 */
	gcStateKey: 'cs2GcConnected' | 'tf2GcConnected';
	defaultPublicGcKey: string;
}

export const CS2_APP_ID = 730;
export const TF2_APP_ID = 440;

export const GAME_CONFIGS: Readonly<Record<GameId, GameConfig>> = Object.freeze({
	cs2: {
		id: 'cs2',
		label: 'CS2',
		taskType: 'cs2-purchase',
		appId: CS2_APP_ID,
		moduleKey: 'csgo',
		gcStateKey: 'cs2GcConnected',
		defaultPublicGcKey: 'gcConnected'
	},
	tf2: {
		id: 'tf2',
		label: 'TF2',
		taskType: 'tf2-purchase',
		appId: TF2_APP_ID,
		moduleKey: 'tf2',
		gcStateKey: 'tf2GcConnected',
		defaultPublicGcKey: 'tf2GcConnected'
	}
});

/** 'tf2' / '440' / 'Team Fortress 2' 等都认作 tf2,其余一律 cs2 */
export function normalizeGame(value: unknown): GameId {
	const raw = String(value || '').trim().toLowerCase();
	if (raw === 'tf2' || raw === '440' || raw === 'teamfortress2' || raw === 'team fortress 2') {
		return 'tf2';
	}
	return 'cs2';
}

export function gameConfig(game: unknown): GameConfig {
	return GAME_CONFIGS[normalizeGame(game)];
}
