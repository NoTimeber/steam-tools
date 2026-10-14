// CS2「终端机开箱」:选一个已连 CS2 GC 的账号,列出库存里的终端机(创世 / 毁灭之手),解封、拒绝报价换下一个。
// 这两个操作都不可逆,界面上先确认。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import type {StateFilter, TerminalItem, TerminalOffer} from '../lib/terminal.ts';
import {accounts} from './accounts.ts';
import type {AccountRow} from './accounts.ts';

export const terminal = reactive({
	selectedKey: '',
	terminals: [] as TerminalItem[],
	loading: false,
	error: '',
	typeFilter: 'all',
	stateFilter: 'all' as StateFilter,
	/** 正在操作的终端机 id */
	busyId: ''
});

export const gcAccounts = computed<AccountRow[]>(() => accounts.rows.filter(row => row.cs2GcConnected && !!row.attemptId));

export const selectedAccount = computed(() => gcAccounts.value.find(row => row.key === terminal.selectedKey) ?? null);

let version = 0;

/** 选中的账号断开 GC 了:清空 */
export function ensureSelection(): void {
	if (terminal.selectedKey && !selectedAccount.value) {
		terminal.selectedKey = '';
		terminal.terminals = [];
		terminal.error = '';
		version++;
	}
}

export async function load(): Promise<void> {
	const account = selectedAccount.value;
	if (!account) {
		return;
	}
	const current = ++version;
	terminal.loading = true;
	terminal.error = '';
	try {
		const data = await api.get<{state?: {terminals?: TerminalItem[]}}>(`/api/terminal/state?accountId=${encodeURIComponent(account.attemptId)}`);
		if (current === version) {
			terminal.terminals = data.state?.terminals || [];
		}
	} catch (err) {
		if (current === version) {
			terminal.error = errorText(err) || '加载失败';
		}
	} finally {
		if (current === version) {
			terminal.loading = false;
		}
	}
}

export function selectAccount(key: string): void {
	if (terminal.selectedKey !== key) {
		terminal.selectedKey = key;
		terminal.terminals = [];
	}
	load();
}

/** 解封(不可逆,启动 72h 倒计时);GC 那边要几秒才生效,等一下再刷新 */
export async function unseal(id: string): Promise<void> {
	const account = selectedAccount.value;
	if (!account) {
		return;
	}
	terminal.busyId = id;
	try {
		await api.post('/api/terminal/unseal', {accountId: account.attemptId, gcItemId: id, variant: 'opencrate', volatileLimit: '0'});
		await new Promise(resolve => window.setTimeout(resolve, 3500));
		await load();
	} finally {
		terminal.busyId = '';
	}
}

/** 拒绝当前报价、换下一个(不可逆,消耗 1 次挑选);返回新报价(没读到为 null) */
export async function advance(id: string): Promise<TerminalOffer | null> {
	const account = selectedAccount.value;
	if (!account) {
		return null;
	}
	terminal.busyId = id;
	try {
		const data = await api.post<{result?: {count?: number; skins?: TerminalOffer[]; history?: TerminalOffer[]}}>('/api/terminal/advance-offer', {
			accountId: account.attemptId,
			gcItemId: id
		});
		const result = data.result || {};
		const offer = result.count && result.skins ? result.skins[0] ?? null : null;
		const item = terminal.terminals.find(t => String(t.id) === String(id));
		if (item) {
			item.offer = offer || item.offer;
			if (Array.isArray(result.history)) {
				item.history = result.history;
			}
		}
		window.setTimeout(load, 800);
		return offer;
	} finally {
		terminal.busyId = '';
	}
}
