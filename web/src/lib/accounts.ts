// 账户列表的纯逻辑(不依赖 Vue,单元测试直接用 node 跑):登录状态归并、导入文本解析、余额显示、按序号勾选、按分组筛选、
// 搜索和粘贴账号列表匹配、账户表的筛选 / 排序 / 余额合计 / 导出。登录状态和导入的规则照搬旧版前端。

import {csvDocument, textCell} from './csv.ts';

export type LoginStatus = '未登录' | '登录中' | '登录成功' | '登录失败';

/** 登录状态标签的颜色(Naive 的 NTag type) */
export const STATUS_TAG: Readonly<Record<LoginStatus, 'success' | 'warning' | 'error' | 'default'>> = {
	登录成功: 'success',
	登录中: 'warning',
	登录失败: 'error',
	未登录: 'default'
};

/**
 * 会话状态 → 列表上的登录状态。已登录成功的账号掉线重连(connecting / failed / disconnected 等)时
 * 仍显示「登录成功」,避免 steam-user 自动重连时状态来回跳。
 */
export function collapseAttemptStatus(status: string, previous: LoginStatus): LoginStatus {
	switch (status) {
		case 'logged_on':
		case 'web_session':
			return '登录成功';
		case 'logged_out':
			return '未登录';
		case 'failed':
		case 'disconnected':
			return previous === '登录成功' ? '登录成功' : '登录失败';
		case 'created':
		case 'connecting':
		case 'guard_required':
		case 'web_session_pending':
			return previous === '登录成功' ? '登录成功' : '登录中';
		default:
			return '未登录';
	}
}

// ===== 用户建的分组 =====

/** 分组筛选:ALL_ACCOUNTS 全部,NO_GROUP 未分组,其它是分组 id */
export const ALL_ACCOUNTS = '';
export const NO_GROUP = '-';

export function matchesGroupFilter(row: {groupId: string}, filter: string): boolean {
	if (filter === ALL_ACCOUNTS) {
		return true;
	}
	return filter === NO_GROUP ? !row.groupId : row.groupId === filter;
}

/** 分组 id 列表里把 id 往前(-1)或往后(+1)挪一位;到头了原样返回 */
export function moveGroupId(ids: readonly string[], id: string, delta: -1 | 1): string[] {
	const order = [...ids];
	const from = order.indexOf(id);
	const to = from + delta;
	if (from < 0 || to < 0 || to >= order.length) {
		return order;
	}
	[order[from], order[to]] = [order[to]!, order[from]!];
	return order;
}

/** 搜索:账号名或 SteamID 包含关键词(不分大小写);空关键词都算 */
export function matchesSearch(row: {accountName: string; steamID: string}, query: string): boolean {
	const q = query.trim().toLowerCase();
	return !q || row.accountName.toLowerCase().includes(q) || row.steamID.includes(q);
}

/** 粘贴的账号列表:空格、逗号、分号、换行分隔(中英文标点都认),不分大小写去重 */
export function parseNameList(text: string): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const token of text.split(/[\s,，;；、]+/u)) {
		if (token && !seen.has(token.toLowerCase())) {
			seen.add(token.toLowerCase());
			names.push(token);
		}
	}
	return names;
}

/** 粘贴的列表按账号名(不分大小写)或 SteamID 对上名单里的账号;对不上的原样列出 */
export function matchNameList<T extends {accountName: string; steamID: string}>(text: string, rows: readonly T[]): {matched: T[]; missing: string[]} {
	const byName = new Map(rows.map(row => [row.accountName.toLowerCase(), row]));
	const bySteamId = new Map(rows.filter(row => row.steamID).map(row => [row.steamID, row]));
	const matched = new Set<T>();
	const missing: string[] = [];
	for (const name of parseNameList(text)) {
		const row = byName.get(name.toLowerCase()) ?? bySteamId.get(name);
		if (row) {
			matched.add(row);
		} else {
			missing.push(name);
		}
	}
	return {matched: [...matched], missing};
}

// ===== 账户表:筛选、排序、汇总、导出 =====

/** 会话(登录状态)在表格里的叫法 */
export const SESSION_LABEL: Readonly<Record<LoginStatus, string>> = {
	登录成功: '在线',
	登录中: '登录中',
	登录失败: '登录失败',
	未登录: '离线'
};

export interface AccountFilters {
	/** ALL_ACCOUNTS / NO_GROUP / 分组 id */
	group: string;
	/** '' 不限 */
	session: '' | LoginStatus;
	gc: '' | 'connected' | 'none';
	/** mafile 有 maFile;secret 只有名单里的 shared_secret;none 都没有 */
	guard: '' | 'mafile' | 'secret' | 'none';
	minBalance: number | null;
	maxBalance: number | null;
}

export function emptyFilters(): AccountFilters {
	return {group: ALL_ACCOUNTS, session: '', gc: '', guard: '', minBalance: null, maxBalance: null};
}

/** 生效的筛选条件个数(筛选按钮上的角标) */
export function activeFilterCount(filters: AccountFilters): number {
	return [filters.group !== ALL_ACCOUNTS, filters.session, filters.gc, filters.guard, filters.minBalance != null, filters.maxBalance != null].filter(Boolean).length;
}

export interface FilterableAccount {
	groupId: string;
	status: LoginStatus;
	cs2GcConnected: boolean;
	tf2GcConnected: boolean;
	hasMaFile: boolean;
	hasSharedSecret: boolean;
	hasWallet: boolean;
	balance: number | null;
}

/** 余额上下限:设了就只留有钱包、余额在范围里的 */
export function matchesFilters(row: FilterableAccount, filters: AccountFilters): boolean {
	if (!matchesGroupFilter(row, filters.group) || (filters.session && row.status !== filters.session)) {
		return false;
	}
	const gc = row.cs2GcConnected || row.tf2GcConnected;
	if ((filters.gc === 'connected' && !gc) || (filters.gc === 'none' && gc)) {
		return false;
	}
	const guard = row.hasMaFile ? 'mafile' : row.hasSharedSecret ? 'secret' : 'none';
	if (filters.guard && guard !== filters.guard) {
		return false;
	}
	if (filters.minBalance != null || filters.maxBalance != null) {
		const balance = row.hasWallet && row.balance != null ? Number(row.balance) : NaN;
		if (!Number.isFinite(balance) || (filters.minBalance != null && balance < filters.minBalance) || (filters.maxBalance != null && balance > filters.maxBalance)) {
			return false;
		}
	}
	return true;
}

export type SortKey = 'accountName' | 'status' | 'balance';
export type SortOrder = 'ascend' | 'descend';

/** 会话排序:GC 已连接 → 在线 → 登录中 → 登录失败 → 离线 */
function statusRank(row: FilterableAccount): number {
	if (row.cs2GcConnected || row.tf2GcConnected) {
		return 0;
	}
	return {登录成功: 1, 登录中: 2, 登录失败: 3, 未登录: 4}[row.status];
}

/** 排序(不改原数组);相同的保持原来的先后;没有余额的总排在最后 */
export function sortAccounts<T extends FilterableAccount & {accountName: string}>(rows: readonly T[], key: SortKey | '', order: SortOrder): T[] {
	if (!key) {
		return [...rows];
	}
	const flip = order === 'descend' ? -1 : 1;
	const balanceOf = (row: T) => (row.hasWallet && row.balance != null && Number.isFinite(Number(row.balance)) ? Number(row.balance) : null);
	return rows
		.map((row, index) => ({row, index}))
		.sort((a, b) => {
			let result = 0;
			if (key === 'balance') {
				const x = balanceOf(a.row);
				const y = balanceOf(b.row);
				if (x == null || y == null) {
					result = x == null && y == null ? 0 : x == null ? 1 : -1;
					return result || a.index - b.index;
				}
				result = (x - y) * flip;
			} else if (key === 'status') {
				result = (statusRank(a.row) - statusRank(b.row)) * flip;
			} else {
				result = a.row.accountName.localeCompare(b.row.accountName, 'zh-CN', {numeric: true, sensitivity: 'base'}) * flip;
			}
			return result || a.index - b.index;
		})
		.map(item => item.row);
}

/** 钱包余额按币种合计,账号多的币种在前 */
export function walletTotals(rows: ReadonlyArray<{hasWallet: boolean; balance: number | null; currency: number | null}>): Array<{currency: number | null; total: number; count: number}> {
	const byCurrency = new Map<number | null, {currency: number | null; total: number; count: number}>();
	for (const row of rows) {
		const balance = Number(row.balance);
		if (!row.hasWallet || row.balance == null || !Number.isFinite(balance)) {
			continue;
		}
		const entry = byCurrency.get(row.currency) ?? {currency: row.currency, total: 0, count: 0};
		entry.total += balance;
		entry.count++;
		byCurrency.set(row.currency, entry);
	}
	return [...byCurrency.values()]
		.map(entry => ({...entry, total: Math.round(entry.total * 100) / 100}))
		.sort((a, b) => b.count - a.count || b.total - a.total);
}

/** 导出账户列表:序号、账号、分组、会话、SteamID、国家、余额、币种(不含密码和令牌) */
export function accountsCsv(
	rows: ReadonlyArray<FilterableAccount & {accountName: string; steamID: string; country: string; currency: number | null}>,
	groupName: (groupId: string) => string
): string {
	const lines = ['序号,账号,分组,会话,SteamID,国家,余额,币种'];
	rows.forEach((row, index) => {
		const balance = row.hasWallet && row.balance != null && Number.isFinite(Number(row.balance)) ? Number(row.balance).toFixed(2) : '';
		lines.push([
			String(index + 1),
			textCell(row.accountName),
			textCell(row.groupId ? groupName(row.groupId) : ''),
			SESSION_LABEL[row.status],
			textCell(row.steamID),
			textCell(row.country),
			balance,
			textCell(balance ? currencySymbol(row.currency).trim() : '')
		].join(','));
	});
	return csvDocument(lines);
}

export interface ImportedAccount {
	accountName: string;
	password: string;
}

/** 「账号----密码」一行一个;# 开头和空行跳过。格式不对的行一起报出来 */
export function parseAccountText(text: string): ImportedAccount[] {
	const rows: ImportedAccount[] = [];
	const invalid: number[] = [];
	text.split(/\r?\n/).forEach((line, index) => {
		const value = line.trim();
		if (!value || value.startsWith('#')) {
			return;
		}
		const separator = value.indexOf('----');
		const accountName = separator < 0 ? '' : value.slice(0, separator).trim();
		const password = separator < 0 ? '' : value.slice(separator + 4).trim();
		if (!accountName || !password) {
			invalid.push(index + 1);
			return;
		}
		rows.push({accountName, password});
	});
	if (invalid.length) {
		throw new Error(`第 ${invalid.join(', ')} 行格式错误,请使用 账号----密码`);
	}
	if (!rows.length) {
		throw new Error('请输入账号----密码,一行一个');
	}
	return rows;
}

/** Steam 钱包币种 id → 符号 */
const CURRENCY_SYMBOLS: Readonly<Record<number, string>> = {
	1: '$', 2: '£', 3: '€', 5: '₽', 7: 'R$', 8: '¥', 9: 'kr ', 10: 'Rp ', 11: 'RM ', 12: '₱', 13: 'S$', 14: '฿', 15: '₫',
	16: '₩', 17: '₺', 18: '₴', 19: 'Mex$', 20: 'C$', 21: 'A$', 22: 'NZ$', 24: '₹', 27: 'COL$', 28: 'R ', 29: 'HK$', 30: 'NT$',
	31: 'SR ', 32: 'AED ', 37: '₸', 39: 'QR ', 40: '₡', 41: '$U '
};

export function currencySymbol(currency: number | null | undefined): string {
	return CURRENCY_SYMBOLS[Number(currency)] ?? '';
}

export function formatBalance(row: {hasWallet: boolean; balance: number | null; currency: number | null}): string {
	const balance = Number(row.balance);
	if (!row.hasWallet || row.balance == null || !Number.isFinite(balance)) {
		return '-';
	}
	return `${currencySymbol(row.currency)}${balance.toFixed(2)}`;
}

/** 序号至少两位(对齐「00-00」的输入习惯) */
export function padSeq(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * 按序号区间勾选:两侧只填一个就是单个;起止颠倒自动交换;越界夹到 1..total。
 * 返回要勾选的序号区间(含两端),或者说明为什么不行
 */
export function resolveSeqRange(startText: string, endText: string, total: number): {start: number; end: number} | {error: string} {
	if (!total) {
		return {error: '暂无账户'};
	}
	let start = parseInt(startText, 10);
	let end = parseInt(endText, 10);
	if (Number.isNaN(start) && Number.isNaN(end)) {
		return {error: '请输入要勾选的序号'};
	}
	if (Number.isNaN(start)) {
		start = end;
	}
	if (Number.isNaN(end)) {
		end = start;
	}
	if (start > end) {
		[start, end] = [end, start];
	}
	start = Math.max(1, start);
	end = Math.min(total, end);
	if (start > total) {
		return {error: `序号超出范围(共 ${total} 个账户)`};
	}
	return {start, end};
}

/** 会话日志里最近一条错误(登录失败的原因) */
export function lastErrorMessage(logs: ReadonlyArray<{level: string; message: string}> | undefined): string {
	for (let index = (logs?.length ?? 0) - 1; index >= 0; index--) {
		const entry = logs![index]!;
		if (entry.level === 'error' && entry.message) {
			return entry.message;
		}
	}
	return '';
}

// ===== 账户详情 =====

const TIME_STEPS: ReadonlyArray<[number, string]> = [[60, '分钟'], [3600, '小时'], [86400, '天'], [2592000, '个月'], [31536000, '年']];

/** 相对时间:过去的「3 小时前」,将来的「6 个月后」;一分钟以内「刚刚」/「马上」;没有时间「—」 */
export function fromNow(time: number | null | undefined, now: number = Date.now()): string {
	if (!time) {
		return '—';
	}
	const diff = Math.round((time - now) / 1000);
	const seconds = Math.abs(diff);
	if (seconds < 60) {
		return diff <= 0 ? '刚刚' : '马上';
	}
	let label = '';
	for (const [size, unit] of TIME_STEPS) {
		if (seconds >= size) {
			label = `${Math.floor(seconds / size)} ${unit}`;
		}
	}
	return label + (diff < 0 ? '前' : '后');
}

const pad2 = (value: number) => String(value).padStart(2, '0');

function dayKey(time: number): string {
	const date = new Date(time);
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 完整时间:2026-10-18 09:30:05 */
export function formatDateTime(time: number | null | undefined): string {
	if (!time) {
		return '—';
	}
	const date = new Date(time);
	return `${dayKey(time)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export interface LogDay<T> {
	key: string;
	label: string;
	entries: T[];
}

/** 日志按天分组,新的在前:今天 / 昨天 / 10月16日(不是今年的带年份);没有时间的放最后「时间未知」 */
export function groupLogsByDay<T extends {at?: number}>(logs: readonly T[], now: number = Date.now()): Array<LogDay<T>> {
	const today = dayKey(now);
	const yesterday = dayKey(now - 86_400_000);
	const thisYear = new Date(now).getFullYear();
	const groups = new Map<string, LogDay<T>>();
	for (const entry of [...logs].reverse()) {
		const key = entry.at ? dayKey(entry.at) : '';
		let group = groups.get(key);
		if (!group) {
			let label = '时间未知';
			if (entry.at) {
				const date = new Date(entry.at);
				const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
				label = key === today ? '今天' : key === yesterday ? '昨天' : date.getFullYear() === thisYear ? monthDay : `${date.getFullYear()}年${monthDay}`;
			}
			group = {key, label, entries: []};
			groups.set(key, group);
		}
		group.entries.push(entry);
	}
	const list = [...groups.values()];
	return [...list.filter(group => group.key), ...list.filter(group => !group.key)];
}

/** 日志级别的叫法和标签颜色 */
export function logLevel(level: string): {label: string; type: 'success' | 'info' | 'warning' | 'error' | 'default'} {
	switch (level) {
		case 'success':
			return {label: '成功', type: 'success'};
		case 'warn':
			return {label: '警告', type: 'warning'};
		case 'error':
			return {label: '错误', type: 'error'};
		case 'info':
			return {label: '信息', type: 'default'};
		default:
			return {label: level, type: 'default'};
	}
}
