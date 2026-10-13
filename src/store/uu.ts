import {createHash} from 'node:crypto';
import type {Db, Row} from '../core/db.ts';
import {nowIso, str, transaction} from '../core/db.ts';
import type {Vault} from '../core/vault.ts';
import type {SettingsStore} from './settings.ts';

const TOKEN_PURPOSE = 'uu.token_entry';
const DELIVERY_TOKEN_PURPOSE = 'uu.delivery_token';
const DELIVERY_SETTINGS_KEY = 'uu.delivery.settings';

// 与旧版 data/uu/tokens.json 每一项一致:{token, userId, nickname, linkedSteamId, jwtExp, acquiredAt}
export interface UuTokenEntry {
	token: string;
	userId?: string | number | null;
	nickname?: string;
	linkedSteamId?: string;
	jwtExp?: number | null;
	acquiredAt?: string;
	[extra: string]: unknown;
}

// 旧版 delivery-config.json 的整体形状:{__settings__: {...}, <账号名>: {token, gameId, ...}}
export type UuDeliveryConfig = Record<string, Record<string, unknown>>;

/** token 的稳定标识:UU userId;没有时用 token 哈希。前端只拿这个 id,不再拿 token 原文。 */
export function uuTokenId(entry: Pick<UuTokenEntry, 'token' | 'userId'>): string {
	const userId = entry.userId == null ? '' : String(entry.userId).trim();
	if (userId) {
		return userId;
	}
	return 'h' + createHash('sha256').update(String(entry.token || '')).digest('hex').slice(0, 16);
}

export interface UuStore {
	listTokens(): UuTokenEntry[];
	replaceTokens(entries: readonly UuTokenEntry[]): void;
	findToken(id: string): UuTokenEntry | null;
	/** 没存过任何发货配置时返回 null(与旧版"文件不存在"一致)。 */
	loadDeliveryConfig(): UuDeliveryConfig | null;
	saveDeliveryConfig(config: UuDeliveryConfig): void;
}

export function createUuStore(db: Db, vault: Vault, settings: SettingsStore): UuStore {
	const selectTokens = db.prepare('SELECT data FROM uu_tokens ORDER BY position');
	const selectToken = db.prepare('SELECT data FROM uu_tokens WHERE id = ?');
	const deleteTokens = db.prepare('DELETE FROM uu_tokens');
	const insertToken = db.prepare(
		'INSERT INTO uu_tokens (id, position, linked_steam_id, data, updated_at) VALUES (?, ?, ?, ?, ?)'
	);
	const selectDelivery = db.prepare('SELECT account_name, token, config FROM uu_delivery ORDER BY position');
	const deleteDelivery = db.prepare('DELETE FROM uu_delivery');
	const insertDelivery = db.prepare(
		'INSERT INTO uu_delivery (account_name, position, token, config, updated_at) VALUES (?, ?, ?, ?, ?)'
	);

	const openEntry = (row: Row) => vault.decryptJson<UuTokenEntry>(str(row, 'data'), TOKEN_PURPOSE);

	return {
		listTokens() {
			return selectTokens.all().map(openEntry);
		},
		replaceTokens(entries) {
			// 同一个 id 出现多次时保留最后一条(与旧版"按 userId 去重、后写覆盖"一致)
			const byId = new Map<string, UuTokenEntry>();
			for (const entry of entries) {
				if (entry && typeof entry === 'object' && entry.token) {
					const id = uuTokenId(entry);
					byId.delete(id);
					byId.set(id, entry);
				}
			}
			const updatedAt = nowIso();
			transaction(db, () => {
				deleteTokens.run();
				let position = 0;
				for (const [id, entry] of byId) {
					insertToken.run(id, position++, String(entry.linkedSteamId ?? ''), vault.encryptJson(entry, TOKEN_PURPOSE), updatedAt);
				}
			});
		},
		findToken(id) {
			const row = selectToken.get(String(id || ''));
			return row ? openEntry(row) : null;
		},
		loadDeliveryConfig() {
			const rows = selectDelivery.all();
			const globalSettings = settings.get<Record<string, unknown>>(DELIVERY_SETTINGS_KEY);
			if (!rows.length && !globalSettings) {
				return null;
			}
			const config: UuDeliveryConfig = {};
			if (globalSettings) {
				config.__settings__ = globalSettings;
			}
			for (const row of rows) {
				const rest = JSON.parse(str(row, 'config')) as Record<string, unknown>;
				config[str(row, 'account_name')] = {
					...rest,
					token: vault.decrypt(str(row, 'token'), DELIVERY_TOKEN_PURPOSE)
				};
			}
			return config;
		},
		saveDeliveryConfig(config) {
			const updatedAt = nowIso();
			transaction(db, () => {
				deleteDelivery.run();
				let position = 0;
				for (const [name, value] of Object.entries(config || {})) {
					if (name.startsWith('__') || !value || typeof value !== 'object') {
						continue;
					}
					const {token, ...rest} = value;
					const tokenText = String(token ?? '').trim();
					if (!tokenText) {
						continue;
					}
					insertDelivery.run(name, position++, vault.encrypt(tokenText, DELIVERY_TOKEN_PURPOSE), JSON.stringify(rest), updatedAt);
				}
				if (config && config.__settings__ && typeof config.__settings__ === 'object') {
					settings.set(DELIVERY_SETTINGS_KEY, config.__settings__);
				}
			});
		}
	};
}
