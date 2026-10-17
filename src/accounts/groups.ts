// 账户分组:新建、改名、删除、排序,把账号移进/移出分组。下发的名单每个账号带上 groupId(未分组为 '')。
// 每个改动都返回最新的分组和名单,前端直接替换。

import type {AccountGroup, AccountGroupStore} from '../store/account-groups.ts';
import {accountKey} from '../store/accounts.ts';
import type {AccountStore, StoredAccount} from '../store/accounts.ts';
import {publicStoredAccount} from './profiles.ts';
import type {PublicStoredAccount} from './profiles.ts';

export type {AccountGroup} from '../store/account-groups.ts';

export type PublicAccount = PublicStoredAccount & {groupId: string};

export interface GroupState {
	groups: AccountGroup[];
	accounts: PublicAccount[];
}

export const GROUP_NAME_MAX = 20;

function groupError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

export function createAccountGroups(store: {accounts: Pick<AccountStore, 'list'>; groups: AccountGroupStore}) {
	/** 名单下发给浏览器:去掉密钥,带上分组 */
	function publicAccounts(list: StoredAccount[] = store.accounts.list()): PublicAccount[] {
		const members = store.groups.members();
		return list.map(account => ({...publicStoredAccount(account), groupId: members.get(accountKey(account.accountName)) ?? ''}));
	}

	function state(): GroupState {
		return {groups: store.groups.list(), accounts: publicAccounts()};
	}

	function findGroup(id: unknown): AccountGroup {
		const group = store.groups.list().find(item => item.id === String(id ?? ''));
		if (!group) {
			throw groupError(404, '分组不存在');
		}
		return group;
	}

	/** 去掉首尾和多余空白;不能空、不能太长、不能和别的分组重名(不分大小写) */
	function groupName(raw: unknown, selfId = ''): string {
		const name = String(raw ?? '').trim().replace(/\s+/gu, ' ');
		if (!name) {
			throw groupError(400, '分组名不能为空');
		}
		if ([...name].length > GROUP_NAME_MAX) {
			throw groupError(400, `分组名最多 ${GROUP_NAME_MAX} 个字`);
		}
		const lowered = name.toLowerCase();
		if (store.groups.list().some(group => group.id !== selfId && group.name.toLowerCase() === lowered)) {
			throw groupError(409, `已经有叫「${name}」的分组`);
		}
		return name;
	}

	/** 请求里的账号名,只留名单里有的 */
	function listedNames(raw: unknown): string[] {
		const listed = new Map(store.accounts.list().map(account => [accountKey(account.accountName), account.accountName]));
		const names = new Set<string>();
		for (const item of Array.isArray(raw) ? raw : []) {
			const name = listed.get(accountKey(String(item ?? '')));
			if (name) {
				names.add(name);
			}
		}
		return [...names];
	}

	return {
		publicAccounts,

		/** 新建分组(排在最后);带 accountNames 时顺便把这些账号移进去 */
		createGroup(body: {name?: unknown; accountNames?: unknown}): GroupState & {group: AccountGroup} {
			const group = store.groups.create(groupName(body.name));
			const names = listedNames(body.accountNames);
			if (names.length) {
				store.groups.assign(names, group.id);
			}
			return {group, ...state()};
		},

		renameGroup(id: unknown, body: {name?: unknown}): GroupState {
			const group = findGroup(id);
			store.groups.rename(group.id, groupName(body.name, group.id));
			return state();
		},

		/** 组里的账号变成未分组,账号本身不动 */
		deleteGroup(id: unknown): GroupState {
			store.groups.remove(findGroup(id).id);
			return state();
		},

		/** ids 是新的显示顺序 */
		reorderGroups(body: {ids?: unknown}): GroupState {
			store.groups.reorder(Array.isArray(body.ids) ? body.ids.map(String) : []);
			return state();
		},

		/** 把账号移到分组;groupId 为空移出分组 */
		moveToGroup(body: {accountNames?: unknown; groupId?: unknown}): GroupState {
			const groupId = body.groupId ? findGroup(body.groupId).id : '';
			const names = listedNames(body.accountNames);
			if (!names.length) {
				throw groupError(400, '没有要移动的账号');
			}
			store.groups.assign(names, groupId);
			return state();
		}
	};
}

export type AccountGroups = ReturnType<typeof createAccountGroups>;
