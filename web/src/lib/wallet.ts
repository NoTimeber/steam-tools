// 充值码兑换的纯逻辑(不依赖 Vue):账户和充值码按行严格 1:1 配对、结果行按推送更新、导入 maFile 合并账户行。
// 规则照搬旧版前端。

export interface RedeemPair {
	account: string;
	password: string;
	code: string;
	line: number;
}

export interface ParsedLines {
	pairs: RedeemPair[];
	/** 错位的行:只有一侧有内容、账户名为空 */
	issues: Array<{line: number; reason: string}>;
	accountTotal: number;
	codeTotal: number;
}

function lines(text: string): string[] {
	const out = String(text || '').split(/\r?\n/);
	// 去掉结尾的空行(常见的结尾换行),中间的空行保留,维持行号对齐
	while (out.length && !out[out.length - 1]!.trim()) {
		out.pop();
	}
	return out;
}

/**
 * 严格按行号把左侧「账号----密码」和右侧充值码对上。不单独过滤空行(那样两列会错位):
 * 两侧同为空行跳过;只有一侧有内容记为错位;都有内容才是一条配对。密码可以不填(用本地 maFile/会话登录)
 */
export function parseRedeemLines(accountsText: string, codesText: string): ParsedLines {
	const accountLines = lines(accountsText);
	const codeLines = lines(codesText);
	const result: ParsedLines = {pairs: [], issues: [], accountTotal: 0, codeTotal: 0};
	for (let i = 0; i < Math.max(accountLines.length, codeLines.length); i++) {
		const accountRaw = (accountLines[i] || '').trim();
		const code = (codeLines[i] || '').trim();
		if (accountRaw) result.accountTotal++;
		if (code) result.codeTotal++;
		if (!accountRaw && !code) {
			continue;
		}
		if (!code) {
			result.issues.push({line: i + 1, reason: '左侧有账户,右侧缺少对应充值码'});
			continue;
		}
		if (!accountRaw) {
			result.issues.push({line: i + 1, reason: '右侧有充值码,左侧缺少对应账户'});
			continue;
		}
		const separator = accountRaw.indexOf('----');
		const account = separator === -1 ? accountRaw : accountRaw.slice(0, separator).trim();
		const password = separator === -1 ? '' : accountRaw.slice(separator + 4);
		if (!account) {
			result.issues.push({line: i + 1, reason: '账户名为空'});
			continue;
		}
		result.pairs.push({account, password, code, line: i + 1});
	}
	return result;
}

/** 结果表里的充值码只露头尾 */
export function maskCode(code: string): string {
	const value = String(code || '');
	return value.length <= 8 ? value : `${value.slice(0, 5)}…${value.slice(-4)}`;
}

export type RowStatus = 'pending' | 'processing' | 'success' | 'error';

export interface ResultRow {
	account: string;
	password: string;
	code: string;
	status: RowStatus;
	message: string;
	balance: string;
}

export function statusTag(status: RowStatus): {label: string; tone: 'default' | 'warning' | 'success' | 'error'} {
	switch (status) {
		case 'success': return {label: '成功', tone: 'success'};
		case 'error': return {label: '失败', tone: 'error'};
		case 'processing': return {label: '处理中', tone: 'warning'};
		default: return {label: '待处理', tone: 'default'};
	}
}

/** 服务端推送(wallet:redeem) */
export interface RedeemEvent {
	jobId?: string;
	status?: 'processing' | 'success' | 'error' | 'done';
	index?: number;
	account?: string;
	message?: string;
	balance?: string;
	logLevel?: string;
	logMessage?: string;
}

export interface ApplyOutcome {
	done: boolean;
	logs: Array<{level: string; message: string}>;
}

/**
 * 把一条推送更新到结果行。推送里的 index 是「这次提交的 pairs」的下标,经 indexMap 映射回结果行(重试只提交失败的那些)。
 * 过程日志(logMessage)同步到运行日志;debug 噪声不写
 */
export function applyRedeemEvent(rows: ResultRow[], indexMap: readonly number[], event: RedeemEvent): ApplyOutcome {
	if (event.status === 'done') {
		return {done: true, logs: [{level: 'success', message: '充值码兑换任务结束'}]};
	}
	const row = typeof event.index === 'number' ? rows[indexMap[event.index] ?? -1] : undefined;
	if (!row) {
		return {done: false, logs: []};
	}
	const logs: ApplyOutcome['logs'] = [];
	const who = event.account || row.account;
	if (event.logMessage) {
		if (event.logLevel !== 'debug') {
			logs.push({level: event.logLevel || 'info', message: `[兑换·${who}] ${event.logMessage}`});
		}
		if (event.status === 'processing' && row.status !== 'success' && row.status !== 'error') {
			row.status = 'processing';
			row.message = event.logMessage;
		}
	} else if (event.status) {
		row.status = event.status;
		if (event.message) row.message = event.message;
		if (event.balance) row.balance = event.balance;
		if (event.status === 'success' || event.status === 'error') {
			logs.push({level: event.status, message: `[兑换·${who}] ${event.message || statusTag(event.status).label}`});
		}
	}
	return {done: false, logs};
}

/** 导入 maFile 的账号补进账户框:已有的账号(不区分大小写)不重复加;空行去掉 */
export function mergeAccountLines(text: string, newLines: readonly string[]): string {
	const existing = String(text || '').split(/\r?\n/).filter(line => line.trim());
	const nameOf = (line: string) => {
		const trimmed = line.trim();
		const separator = trimmed.indexOf('----');
		return (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim().toLowerCase();
	};
	const seen = new Set(existing.map(nameOf));
	for (const line of newLines) {
		const name = nameOf(line);
		if (name && !seen.has(name)) {
			seen.add(name);
			existing.push(line);
		}
	}
	return existing.join('\n');
}
