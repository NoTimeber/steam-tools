import {test} from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import {createWalletRedeemer, createWalletService, describeRedeemError} from './index.ts';
import type {RedeemOptions, RedeemResult} from './redeem.ts';
import type {WalletEvent, WalletServiceOptions} from './index.ts';

type Login = 'ok' | 'error' | 'guardMobile' | 'guardEmail' | 'guardWrong' | 'hang' | 'cmFail';

/** 假 steam-user + steamstore:登录按 login 走,兑换按 redeem 回 */
function fakeSteam(login: Login, redeem: unknown) {
	const calls: unknown[] = [];
	class FakeUser extends EventEmitter {
		static EConnectionProtocol = {WebSocket: 'ws'};
		constructor(options: unknown) {
			super();
			calls.push(['new', options]);
		}
		async _apiRequest(...args: unknown[]) {
			if (login === 'cmFail' && args[1] === 'ISteamDirectory') {
				throw new Error('directory down');
			}
			return {};
		}
		logOn(details: unknown) {
			calls.push(['logOn', details]);
			setImmediate(async () => {
				if (login === 'cmFail') {
					calls.push(['cm', await this._apiRequest('GET', 'ISteamDirectory', 'GetCMListForConnect')]);
				}
				if (login === 'ok' || login === 'cmFail') {
					this.emit('loggedOn');
				} else if (login === 'error') {
					this.emit('error', new Error('InvalidPassword'));
				} else if (login === 'guardMobile') {
					this.emit('steamGuard', null, (code: string) => {
						calls.push(['guard', code]);
						this.emit('loggedOn');
					}, false);
				} else if (login === 'guardEmail') {
					this.emit('steamGuard', 'qq.com', () => {}, false);
				} else if (login === 'guardWrong') {
					this.emit('steamGuard', null, () => {}, true);
				}
			});
		}
		webLogOn() {
			setImmediate(() => this.emit('webSession', 'sid', ['steamLoginSecure=x']));
		}
		logOff() {
			calls.push(['logOff']);
		}
	}
	class FakeStore {
		setCookies(cookies: unknown) {
			calls.push(['cookies', cookies]);
		}
		async redeemWalletCode(code: string) {
			calls.push(['redeem', code]);
			if (redeem instanceof Error) {
				throw redeem;
			}
			return redeem as {eresult: number; detail: number};
		}
	}
	const redeemer = createWalletRedeemer({SteamUser: FakeUser as never, SteamStore: FakeStore as never, totp: {generateAuthCode: secret => 'CODE-' + secret}});
	return {redeemer, calls};
}

const OK = {eresult: 1, detail: 0, formattedNewWalletBalance: '$15.00', amount: 500};

test('兑换成功:密码登录(有 shared_secret 带上令牌)→ 拿 cookie → 兑换 → 登出', async () => {
	const {redeemer, calls} = fakeSteam('ok', OK);
	const logs: string[] = [];
	const result = await redeemer.redeemForAccount({accountName: ' alpha ', password: 'pw', sharedSecret: 'SS', code: ' GOOD ', logger: (level, message) => void logs.push(`${level}:${message}`)});
	assert.deepEqual(result, {ok: true, eresult: 1, detail: 0, formattedNewWalletBalance: '$15.00', amount: 500, message: '兑换成功,余额 $15.00'});
	assert.deepEqual(calls.slice(1), [
		['logOn', {accountName: 'alpha', password: 'pw', twoFactorCode: 'CODE-SS'}], ['cookies', ['steamLoginSecure=x']], ['redeem', 'GOOD'], ['logOff']
	]);
	assert.deepEqual(calls[0], ['new', {dataDirectory: null, autoRelogin: false, renewRefreshTokens: true, webCompatibilityMode: true, protocol: 'ws'}]);
	assert.deepEqual(logs, ['info:正在连接 Steam…', 'info:Steam 登录成功,正在获取 WebSession', 'info:正在兑换充值码…', 'success:兑换成功,当前余额 $15.00']);
});

test('steamstore 不抛错但 eresult≠1(限流、币种不符等)算失败,不再报成功', async () => {
	const limited = fakeSteam('ok', {eresult: 2, detail: 53});
	await assert.rejects(limited.redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X'}), /已被限流/);
	assert.deepEqual(limited.calls.at(-1), ['logOff']);
	const unknown = fakeSteam('ok', {eresult: 2, detail: 0});
	await assert.rejects(unknown.redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X'}), /^Error: 兑换失败\(eresult=2\)$/);
	const thrown = fakeSteam('ok', Object.assign(new Error('Wallet code is not valid'), {purchaseresultdetail: 14}));
	await assert.rejects(thrown.redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X'}), /充值码无效/);
});

test('登录:refreshToken 优先;Guard 有 shared_secret 自动过,邮箱令牌/没 maFile/令牌错直接失败', async () => {
	const token = fakeSteam('ok', OK);
	await token.redeemer.redeemForAccount({accountName: 'a', password: 'p', refreshToken: ' RT ', code: 'X'});
	assert.deepEqual(token.calls[1], ['logOn', {refreshToken: 'RT'}]);

	const mobile = fakeSteam('guardMobile', OK);
	await mobile.redeemer.redeemForAccount({accountName: 'a', password: 'p', sharedSecret: 'SS', code: 'X'});
	assert.ok(mobile.calls.some(c => JSON.stringify(c) === '["guard","CODE-SS"]'));

	await assert.rejects(fakeSteam('guardMobile', OK).redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X'}), /缺少 shared_secret/);
	await assert.rejects(fakeSteam('guardEmail', OK).redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X'}), /邮箱 Steam Guard/);
	await assert.rejects(fakeSteam('guardWrong', OK).redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X'}), /移动令牌验证码错误/);
	const failed = fakeSteam('error', OK);
	await assert.rejects(failed.redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X'}), /InvalidPassword/);
	assert.deepEqual(failed.calls.at(-1), ['logOff'], '失败也登出');
	await assert.rejects(fakeSteam('hang', OK).redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X', timeoutMs: 20}), /登录超时/);
	await assert.rejects(fakeSteam('ok', OK).redeemer.redeemForAccount({accountName: 'a', password: '', code: 'X'}), /缺少账号或密码/);
	await assert.rejects(fakeSteam('ok', OK).redeemer.redeemForAccount({accountName: 'a', password: 'p', code: ' '}), /充值码为空/);
});

test('Steam 目录服务不可达时改用本地 CM', async () => {
	const {redeemer, calls} = fakeSteam('cmFail', OK);
	const logs: string[] = [];
	await redeemer.redeemForAccount({accountName: 'a', password: 'p', code: 'X', logger: (level, message) => void logs.push(message)});
	const cm = calls.find(c => Array.isArray(c) && c[0] === 'cm') as [string, {response: {serverlist: Array<{endpoint: string}>}}];
	assert.equal(cm[1].response.serverlist[0]?.endpoint, 'cm0.steampowered.com:443');
	assert.ok(logs.includes('Steam 目录服务不可达,改用本地 WebSocket CM'));
});

test('错误码翻译', () => {
	assert.equal(describeRedeemError({purchaseresultdetail: 15}), '充值码已被使用(DuplicateActivationCode)');
	assert.equal(describeRedeemError({purchaseresultdetail: 99}), '兑换失败(detail=99)');
	assert.equal(describeRedeemError({message: 'HTTP 429'}), 'HTTP 429');
	assert.equal(describeRedeemError(null), '未知错误');
});

function service(redeem: (opts: RedeemOptions) => Promise<RedeemResult>, queueLogin?: WalletServiceOptions['queueLogin']) {
	const events: WalletEvent[] = [];
	const wallet = createWalletService({
		profileFor: name => name === 'bravo' ? {sharedSecret: 'SS-b', refreshToken: 'RT-b'} : {},
		emit: payload => void events.push(payload),
		redeem,
		queueLogin,
		randomId: () => 'job-1',
		logger: {error() {}}
	});
	const done = async () => {
		for (let i = 0; i < 200 && !events.some(e => e.status === 'done'); i++) {
			await new Promise(resolve => setImmediate(resolve));
		}
	};
	return {wallet, events, done};
}

test('批量任务:并发 worker 逐条兑换;没填密码用 refreshToken;单条失败不影响别的', async () => {
	const seen: RedeemOptions[] = [];
	let running = 0;
	let peak = 0;
	const {wallet, events, done} = service(async opts => {
		seen.push(opts);
		peak = Math.max(peak, ++running);
		opts.logger?.('info', 'log ' + opts.code);
		await new Promise(resolve => setImmediate(resolve));
		running--;
		if (opts.code === 'BAD') {
			throw new Error('充值码无效(BadActivationCode)');
		}
		return {ok: true, eresult: 1, detail: 0, formattedNewWalletBalance: '', amount: 1, message: '兑换成功'};
	});
	const started = wallet.start({pairs: [{account: 'alpha', password: 'pw', code: 'A'}, {account: ' bravo ', code: 'B'}, {account: 'alpha', password: 'pw', code: 'BAD'}, null, {account: '', code: 'x'}], concurrency: '2'});
	assert.deepEqual(started, {jobId: 'job-1', total: 3, concurrency: 2});
	assert.equal(events.length, 0, '先返回响应,下一个微任务才开始推送');
	await done();
	assert.equal(peak, 2);
	assert.deepEqual(seen.map(o => [o.accountName, o.password, o.refreshToken, o.sharedSecret, o.timeoutMs]), [
		['alpha', 'pw', '', '', 60000], ['bravo', '', 'RT-b', 'SS-b', 60000], ['alpha', 'pw', '', '', 60000]
	]);
	const finals = events.filter(e => e.status === 'success' || e.status === 'error').map(e => [e.index, e.status, e.message]);
	assert.deepEqual(finals.sort(), [[0, 'success', '兑换成功'], [1, 'success', '兑换成功'], [2, 'error', '充值码无效(BadActivationCode)']]);
	assert.ok(events.some(e => e.index === 1 && e.logMessage === 'log B' && e.status === 'processing'));
	assert.deepEqual(events.at(-1), {jobId: 'job-1', status: 'done', message: '全部处理完成'});
});

test('参数校验:没有有效配对、超过 500 条报 400;并发缺省 3,上限 10 且不超过条数', () => {
	const {wallet} = service(async () => ({ok: true, eresult: 1, detail: 0, formattedNewWalletBalance: '', amount: 0, message: ''}));
	assert.throws(() => wallet.start({pairs: 'x'}), (err: Error & {statusCode?: number}) => err.statusCode === 400 && err.message === '没有可兑换的账户/充值码配对');
	assert.throws(() => wallet.start({pairs: Array.from({length: 501}, () => ({account: 'a', code: 'c'}))}), /单次最多兑换 500 条/);
	const many = Array.from({length: 20}, (_, i) => ({account: 'a', code: 'c' + i}));
	assert.equal(wallet.start({pairs: many}).concurrency, 3);
	assert.equal(wallet.start({pairs: many, concurrency: 99}).concurrency, 10);
	assert.equal(wallet.start({pairs: many.slice(0, 2), concurrency: 5}).concurrency, 2);
});

test('代理的登录速率限制:要排队的先推一条排队中,轮到再登录兑换', async () => {
	let release!: (granted: boolean) => void;
	const ready = new Promise<boolean>(resolve => (release = resolve));
	const redeemed: string[] = [];
	const {wallet, events, done} = service(async opts => {
		redeemed.push(opts.accountName);
		return {ok: true, eresult: 1, detail: 0, formattedNewWalletBalance: '$5.00', amount: 500, message: '兑换成功'};
	}, accountName => (accountName === 'bravo' ? {waitMs: 30500, ready} : null));
	wallet.start({pairs: [{account: 'alpha', password: 'pw', code: 'A'}, {account: 'bravo', password: 'pw', code: 'B'}], concurrency: 2});
	for (let i = 0; i < 20; i++) {
		await new Promise(resolve => setImmediate(resolve));
	}
	assert.deepEqual(redeemed, ['alpha'], 'bravo 在排队');
	assert.ok(events.some(e => e.account === 'bravo' && /排队中\(约 31 秒\)/.test(e.message ?? '')));
	release(true);
	await done();
	assert.deepEqual(redeemed, ['alpha', 'bravo']);
});
