// 充值码批量兑换(从 app/server.js 移来):左侧账户(账号----密码)和右侧充值码按行 1:1 配对,N 个 worker 并发兑换,
// 每条经 wallet:redeem 推送进度。payload.index 是本次提交的 pairs 下标,前端用它映射回结果行(所以能「只重试失败项」)。

import {randomBytes} from 'node:crypto';
import {createWalletRedeemer} from './redeem.ts';
import type {RedeemOptions, RedeemResult} from './redeem.ts';

export {createWalletRedeemer, describeRedeemError} from './redeem.ts';

const MAX_PAIRS = 500;
const MAX_CONCURRENCY = 10;
const DEFAULT_CONCURRENCY = 3;
const REDEEM_TIMEOUT_MS = 60000;

export function walletError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

export interface RedeemPair {
	account: string;
	password: string;
	code: string;
}

export interface WalletEvent {
	jobId: string;
	status: 'processing' | 'success' | 'error' | 'done';
	index?: number;
	account?: string;
	message?: string;
	balance?: string;
	logLevel?: string;
	logMessage?: string;
}

export interface WalletServiceOptions {
	/** 本地 maFile / 旧 cookies 文件里的 shared_secret 和 refreshToken(没填密码时用 refreshToken 登录) */
	profileFor(accountName: string): {sharedSecret?: string; refreshToken?: string};
	/** 这个账号的 Steam 代理,'' 直连 */
	proxyFor?(accountName: string): string;
	emit(payload: WalletEvent): void;
	redeem?: (opts: RedeemOptions) => Promise<RedeemResult>;
	randomId?: () => string;
	logger?: Pick<Console, 'error'>;
}

export function createWalletService(options: WalletServiceOptions) {
	const redeem = options.redeem ?? createWalletRedeemer().redeemForAccount;
	const randomId = options.randomId ?? (() => Date.now().toString(36) + '-' + randomBytes(3).toString('hex'));
	const logger = options.logger ?? console;

	/** 兑换一条;任何异常都转成 error 推送,绝不抛出(不能拖垮 worker) */
	async function redeemPair(jobId: string, pair: RedeemPair, index: number): Promise<void> {
		const base = {jobId, index, account: pair.account};
		options.emit({...base, status: 'processing', message: '正在登录并兑换…'});
		const profile = options.profileFor(pair.account);
		try {
			const result = await redeem({
				accountName: pair.account,
				password: pair.password,
				refreshToken: pair.password ? '' : (profile.refreshToken || ''),
				sharedSecret: profile.sharedSecret || '',
				proxy: options.proxyFor?.(pair.account) ?? '',
				code: pair.code,
				timeoutMs: REDEEM_TIMEOUT_MS,
				logger: (level, message) => options.emit({...base, status: 'processing', logLevel: level, logMessage: message})
			});
			options.emit({...base, status: 'success', message: result.message, balance: result.formattedNewWalletBalance || ''});
		} catch (err) {
			options.emit({...base, status: 'error', message: err instanceof Error && err.message ? err.message : '兑换失败'});
		}
	}

	async function run(jobId: string, pairs: RedeemPair[], concurrency: number): Promise<void> {
		let cursor = 0;
		const worker = async () => {
			while (cursor < pairs.length) {
				const index = cursor++;
				await redeemPair(jobId, pairs[index] as RedeemPair, index);
			}
		};
		await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, pairs.length))}, worker));
		options.emit({jobId, status: 'done', message: '全部处理完成'});
	}

	/** 校验配对、起任务,马上返回;进度全走推送 */
	function start(body: {pairs?: unknown; concurrency?: unknown}): {jobId: string; total: number; concurrency: number} {
		const pairs: RedeemPair[] = [];
		for (const item of Array.isArray(body.pairs) ? body.pairs : []) {
			const account = String(item && item.account || '').trim();
			const code = String(item && item.code || '').trim();
			if (account && code) {
				pairs.push({account, password: item && item.password != null ? String(item.password) : '', code});
			}
		}
		if (!pairs.length) {
			throw walletError(400, '没有可兑换的账户/充值码配对');
		}
		if (pairs.length > MAX_PAIRS) {
			throw walletError(400, `单次最多兑换 ${MAX_PAIRS} 条`);
		}
		let concurrency = Math.floor(Number(body.concurrency));
		if (!Number.isFinite(concurrency) || concurrency < 1) {
			concurrency = DEFAULT_CONCURRENCY;
		}
		concurrency = Math.min(concurrency, MAX_CONCURRENCY, pairs.length);

		const jobId = randomId();
		// 等调用方先把响应发出去再开始推送(和旧版顺序一致;前端在拿到 jobId 之前也会接收早到的事件)
		queueMicrotask(() => {
			run(jobId, pairs, concurrency).catch(err => {
				logger.error('[wallet] redeem job error', err);
				options.emit({jobId, status: 'done', message: '任务异常终止'});
			});
		});
		return {jobId, total: pairs.length, concurrency};
	}

	return {start};
}

export type WalletService = ReturnType<typeof createWalletService>;
