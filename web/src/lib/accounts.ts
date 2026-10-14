// 账户列表的纯逻辑(不依赖 Vue,单元测试直接用 node 跑):登录状态归并、导入文本解析、余额显示、按序号勾选。
// 规则照搬旧版前端。

export type LoginStatus = '未登录' | '登录中' | '登录成功' | '登录失败';
export type AccountGroup = 'gc' | 'online' | 'offline';

/** 分组从上到下的显示顺序 */
export const ACCOUNT_GROUPS: ReadonlyArray<{key: AccountGroup; title: string}> = [
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

export function accountGroup(row: {status: LoginStatus; cs2GcConnected: boolean; tf2GcConnected: boolean}): AccountGroup {
	if (row.cs2GcConnected || row.tf2GcConnected) {
		return 'gc';
	}
	return row.status === '登录成功' ? 'online' : 'offline';
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
