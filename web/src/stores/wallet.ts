// 充值码兑换:左边「账号----密码」、右边充值码按行 1:1 配对,服务端逐条临时登录 → 兑换 → 登出,进度经 wallet:redeem 推送。
// 输入框里的密码只在浏览器内存里,不存。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import {clampConcurrency} from '../lib/buygame.ts';
import {applyRedeemEvent, mergeAccountLines, parseRedeemLines} from '../lib/wallet.ts';
import type {RedeemEvent, ResultRow} from '../lib/wallet.ts';
import {addLog} from './logs.ts';

export const wallet = reactive({
	accountsText: '',
	codesText: '',
	concurrency: 3,
	results: [] as ResultRow[],
	jobId: '',
	/** 本次提交的第 i 条对应 results 的第 indexMap[i] 行 */
	indexMap: [] as number[],
	running: false,
	progress: '未开始'
});

export const parsed = computed(() => parseRedeemLines(wallet.accountsText, wallet.codesText));

export const counts = computed(() => ({
	success: wallet.results.filter(row => row.status === 'success').length,
	failed: wallet.results.filter(row => row.status === 'error').length,
	finished: wallet.results.filter(row => row.status === 'success' || row.status === 'error').length
}));

async function submit(pairs: Array<{account: string; password: string; code: string}>, indexMap: number[], label: string): Promise<void> {
	const concurrency = clampConcurrency(wallet.concurrency);
	wallet.concurrency = concurrency;
	wallet.running = true;
	wallet.jobId = '';
	wallet.indexMap = indexMap;
	wallet.progress = `0 / ${pairs.length}`;
	addLog('info', `${label}:${pairs.length} 条,线程 ${concurrency}`);
	try {
		const data = await api.post<{jobId?: string}>('/api/wallet/redeem', {pairs, concurrency});
		wallet.jobId = data.jobId || '';
	} catch (err) {
		wallet.running = false;
		wallet.progress = '提交失败';
		addLog('error', '提交兑换任务失败:' + errorText(err));
	}
}

/** 开始兑换;有错位直接不开始(免得把码兑到错的账号上),逐条写日志 */
export async function startRedeem(): Promise<void> {
	if (wallet.running) {
		addLog('warn', '充值码兑换正在进行中,请等待当前任务完成');
		return;
	}
	const {pairs, issues, accountTotal, codeTotal} = parsed.value;
	if (!accountTotal) {
		addLog('warn', '请先在左侧填写账户');
		return;
	}
	if (!codeTotal) {
		addLog('warn', '请先在右侧填写充值码');
		return;
	}
	if (issues.length) {
		addLog('error', `账户与充值码未一一对应,发现 ${issues.length} 处错位,请修正后再兑换:`);
		for (const issue of issues.slice(0, 10)) {
			addLog('error', `  第 ${issue.line} 行:${issue.reason}`);
		}
		if (issues.length > 10) {
			addLog('error', `  …其余 ${issues.length - 10} 处省略`);
		}
		return;
	}
	if (!pairs.length) {
		addLog('warn', '没有可兑换的有效配对');
		return;
	}
	const noPassword = pairs.filter(pair => !pair.password).map(pair => pair.account);
	if (noPassword.length) {
		addLog('info', `以下账户未填写密码,将尝试用本地 maFile/会话登录:${noPassword.join('、')}`);
	}
	wallet.results = pairs.map(pair => ({account: pair.account, password: pair.password, code: pair.code, status: 'pending', message: '排队中…', balance: ''}));
	await submit(pairs.map(({account, password, code}) => ({account, password, code})), pairs.map((_, index) => index), '开始兑换');
}

/** 重试所有失败项:沿用原账号、原密码、原充值码,结果写回原来那一行 */
export async function retryFailed(): Promise<void> {
	if (wallet.running) {
		addLog('warn', '任务进行中,请等待完成后再重试');
		return;
	}
	const indexes = wallet.results.map((row, index) => (row.status === 'error' ? index : -1)).filter(index => index >= 0);
	if (!indexes.length) {
		addLog('info', '没有失败的兑换项');
		return;
	}
	for (const index of indexes) {
		wallet.results[index]!.status = 'pending';
		wallet.results[index]!.message = '排队重试…';
	}
	await submit(indexes.map(index => {
		const row = wallet.results[index]!;
		return {account: row.account, password: row.password, code: row.code};
	}), indexes, `重试失败项(${indexes.length} 条)`);
}

export function clearAll(): void {
	if (wallet.running) {
		addLog('warn', '任务进行中,无法清空');
		return;
	}
	Object.assign(wallet, {accountsText: '', codesText: '', results: [], indexMap: [], jobId: '', progress: '未开始'});
}

/** 导入 maFile:整份存服务端(登录时自动过令牌),账号补进左侧账户框 */
export async function importMaFiles(files: File[]): Promise<void> {
	const mafiles: Array<Record<string, unknown>> = [];
	const lines: string[] = [];
	for (const file of files) {
		try {
			const data = JSON.parse(await file.text()) as Record<string, unknown>;
			const accountName = String(data.account_name || data.accountName || file.name.replace(/\.(maFile|json)$/i, '')).trim();
			if (!accountName) {
				addLog('warn', `${file.name}: 缺少 account_name`);
				continue;
			}
			if (!data.account_name && !data.accountName) {
				data.account_name = accountName;
			}
			if (!data.shared_secret && !data.sharedSecret) {
				addLog('warn', `${accountName}: maFile 中没有 shared_secret,登录时可能需要手动验证码`);
			}
			mafiles.push(data);
			lines.push(`${accountName}----${data.password ? String(data.password) : ''}`);
		} catch (err) {
			addLog('error', `${file.name}: 读取 maFile 失败: ${errorText(err)}`);
		}
	}
	if (mafiles.length) {
		try {
			const saved = await api.post<{saved?: number}>('/api/mafile/import', {mafiles});
			addLog('info', `maFile 已存到服务器: ${saved.saved ?? mafiles.length} 个`);
		} catch (err) {
			addLog('warn', `maFile 服务端保存失败(自动登录可能受影响): ${errorText(err)}`);
		}
	}
	wallet.accountsText = mergeAccountLines(wallet.accountsText, lines);
	addLog('success', `导入 maFile 完成: ${mafiles.length} 个`);
}

let started = false;

export function startWallet(): void {
	if (started) {
		return;
	}
	started = true;
	socket.on('wallet:redeem', (event: RedeemEvent) => {
		if (!event) {
			return;
		}
		// 知道 jobId 后只认本任务的(提交刚返回前就到的早期事件照收)
		if (wallet.jobId && event.jobId && event.jobId !== wallet.jobId) {
			return;
		}
		const outcome = applyRedeemEvent(wallet.results, wallet.indexMap, event);
		for (const line of outcome.logs) {
			addLog(line.level, line.message);
		}
		if (outcome.done) {
			wallet.running = false;
			wallet.progress = `完成 ${counts.value.finished} / ${wallet.results.length}`;
		} else {
			wallet.progress = `${counts.value.finished} / ${wallet.results.length}`;
		}
	});
}
