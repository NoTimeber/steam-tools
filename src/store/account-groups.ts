import {randomUUID} from 'node:crypto';
import type {Db} from '../core/db.ts';
import {nowIso, str, transaction} from '../core/db.ts';
import {accountKey} from './accounts.ts';

// 账户分组:用户自己建的分组,和账号在哪个分组。名字校验、账号在不在名单里由账号模块管,这里只管存取。
export interface AccountGroup {
	id: string;
	name: string;
}

export interface AccountGroupStore {
	/** 按显示顺序 */
	list(): AccountGroup[];
	/** 账号名小写 → 分组 id(可能有已删账号留下的,用的时候按名单过滤) */
	members(): Map<string, string>;
	/** 加到最后 */
	create(name: string): AccountGroup;
	rename(id: string, name: string): boolean;
	/** 组里的账号变成未分组 */
	remove(id: string): boolean;
	/** 按给的 id 顺序排,没列到的保持原来的先后排在后面,不认识的 id 忽略 */
	reorder(ids: readonly string[]): void;
	/** groupId 为 '' 时移出分组(删账号时也这样清掉) */
	assign(accountNames: readonly string[], groupId: string): void;
}

export function createAccountGroupStore(db: Db): AccountGroupStore {
	const selectAll = db.prepare('SELECT id, name FROM account_groups ORDER BY position, name');
	const selectMembers = db.prepare('SELECT account_key, group_id FROM account_group_members');
	const maxPosition = db.prepare('SELECT COALESCE(MAX(position), -1) AS position FROM account_groups');
	const insertGroup = db.prepare('INSERT INTO account_groups (id, name, position, updated_at) VALUES (?, ?, ?, ?)');
	const renameGroup = db.prepare('UPDATE account_groups SET name = ?, updated_at = ? WHERE id = ?');
	const moveGroup = db.prepare('UPDATE account_groups SET position = ?, updated_at = ? WHERE id = ?');
	const deleteGroup = db.prepare('DELETE FROM account_groups WHERE id = ?');
	const upsertMember = db.prepare(`
		INSERT INTO account_group_members (account_key, group_id, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(account_key) DO UPDATE SET group_id = excluded.group_id, updated_at = excluded.updated_at
	`);
	const deleteMember = db.prepare('DELETE FROM account_group_members WHERE account_key = ?');

	function list(): AccountGroup[] {
		return selectAll.all().map(row => ({id: str(row, 'id'), name: str(row, 'name')}));
	}

	return {
		list,
		members() {
			return new Map(selectMembers.all().map(row => [str(row, 'account_key'), str(row, 'group_id')]));
		},
		create(name) {
			const group = {id: randomUUID(), name};
			insertGroup.run(group.id, name, Number(maxPosition.get()?.position) + 1, nowIso());
			return group;
		},
		rename(id, name) {
			return Number(renameGroup.run(name, nowIso(), id).changes) > 0;
		},
		remove(id) {
			// 成员表有 ON DELETE CASCADE
			return Number(deleteGroup.run(id).changes) > 0;
		},
		reorder(ids) {
			const current = list().map(group => group.id);
			const known = new Set(current);
			const first = [...new Set(ids)].filter(id => known.has(id));
			const picked = new Set(first);
			const order = [...first, ...current.filter(id => !picked.has(id))];
			const updatedAt = nowIso();
			transaction(db, () => {
				order.forEach((id, index) => moveGroup.run(index, updatedAt, id));
			});
		},
		assign(accountNames, groupId) {
			const keys = [...new Set(accountNames.map(accountKey).filter(Boolean))];
			const updatedAt = nowIso();
			transaction(db, () => {
				for (const key of keys) {
					if (groupId) {
						upsertMember.run(key, groupId, updatedAt);
					} else {
						deleteMember.run(key);
					}
				}
			});
		}
	};
}
