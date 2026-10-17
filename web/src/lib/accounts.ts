// 账户列表的纯逻辑(不依赖 Vue,单元测试直接用 node 跑):登录状态归并、导入文本解析、余额显示、按序号勾选、按分组筛选、
// 搜索和粘贴账号列表匹配。
// 规则照搬旧版前端。

export type LoginStatus = '未登录' | '登录中' | '登录成功' | '登录失败';
/** 表格里按状态分的几段(和用户自己建的「分组」不是一回事) */
export type StatusGroup = 'gc' | 'online' | 'offline';

/** 登录状态标签的颜色(Naive 的 NTag type) */
export const STATUS_TAG: Readonly<Record<LoginStatus, 'success' | 'warning' | 'error' | 'default'>> = {
	登录成功: 'success',
	登录中: 'warning',
	登录失败: 'error',
	未登录: 'default'
};

/** 状态段从上到下的显示顺序 */
export const STATUS_GROUPS: ReadonlyArray<{key: StatusGroup; title: string}> = [
	{key: 'gc', title: 'GC 已连接'},
	{key: 'online', title: '在线'},
	{key: 'offline', title: '未在线'}
];

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

export function statusGroup(row: {status: LoginStatus; cs2GcConnected: boolean; tf2GcConnected: boolean}): StatusGroup {
	if (row.cs2GcConnected || row.tf2GcConnected) {
		return 'gc';
	}
	return row.status === '登录成功' ? 'online' : 'offline';
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

export interface GroupFilterOption {
	value: string;
	label: string;
	count: number;
}

/** 筛选项:全部、各分组(按分组顺序)、未分组(有分组时才列) */
export function groupFilterOptions(groups: ReadonlyArray<{id: string; name: string}>, rows: ReadonlyArray<{groupId: string}>): GroupFilterOption[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		counts.set(row.groupId, (counts.get(row.groupId) ?? 0) + 1);
	}
	const options: GroupFilterOption[] = [{value: ALL_ACCOUNTS, label: '全部', count: rows.length}];
	if (groups.length) {
		options.push(...groups.map(group => ({value: group.id, label: group.name, count: counts.get(group.id) ?? 0})));
		options.push({value: NO_GROUP, label: '未分组', count: counts.get('') ?? 0});
	}
	return options;
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
