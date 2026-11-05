import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Attempt} from '../steam/session-manager.ts';
import type {Confirmation, ListConfirmationsParams, RespondConfirmationsParams} from '../steam/confirmations.ts';
import {createAccountConfirmations} from './confirmations.ts';
import type {AccountConfirmationsOptions} from './confirmations.ts';

const conf = (id: string, extra: Partial<Confirmation> = {}): Confirmation => ({
	id, creator: 'c-' + id, nonce: 'n-' + id, type: 2, headline: 'H' + id, typeName: 'Trade Offer', summary: ['s'], icon: '', createdAt: 1700000000,
	acceptText: 'Accept', cancelText: 'Cancel', warn: '', ...extra
});

function setup(overrides: Partial<AccountConfirmationsOptions> = {}) {
	const attempt = {id: 'att-1', accountName: 'Alpha', status: 'web_session', steamID: '7656-live', userAgent: 'UA-live', cookies: ['steamLoginSecure=live']} as unknown as Attempt;
	const calls: Array<['list', ListConfirmationsParams] | ['respond', RespondConfirmationsParams]> = [];
	const logs: string[] = [];
	const lists: Confirmation[][] = [[conf('1'), conf('2', {type: 3, headline: 'AK-47'}), conf('3', {nonce: ''})]];
	let respondError: Error | null = null;
	/** 不为空时提交要等它(模拟 Steam 慢) */
	let gate: Promise<void> | null = null;
	const options: AccountConfirmationsOptions = {
		accountNameOf: raw => (['alpha', 'bravo', 'nomafile'].includes(raw.toLowerCase()) ? (raw.toLowerCase() === 'alpha' ? 'Alpha' : raw.toLowerCase()) : null),
		findAttempt: name => (name === 'Alpha' ? attempt : undefined),
		cookiesFor: target => (target.cookies?.length ? target.cookies : target.accountName === 'bravo' ? ['steamLoginSecure=saved'] : []),
		profileOf: name => (name === 'nomafile' ? {identitySecret: '', deviceId: ''} : {identitySecret: 'IS-' + name, deviceId: 'android:' + name, steamID: '7656-' + name}),
		confirmer: {
			async listConfirmations(params) {
				calls.push(['list', params]);
				return lists.shift() ?? [];
			},
			async respondToConfirmations(params) {
				calls.push(['respond', params]);
				await gate;
				if (respondError) {
					throw respondError;
				}
			}
		},
		addLog: (_attempt, level, message) => void logs.push(`${level} ${message}`),
		now: () => 5000,
		...overrides
	};
	return {
		service: createAccountConfirmations(options), attempt, calls, logs,
		failRespond: (err: Error) => void (respondError = err),
		/** 之后的提交卡住,调返回的函数放行 */
		holdRespond: () => {
			let open = () => {};
			gate = new Promise<void>(resolve => (open = resolve));
			return () => open();
		}
	};
}

const statusOf = async (run: () => Promise<unknown>) => {
	try {
		await run();
	} catch (err) {
		return (err as {statusCode?: number}).statusCode;
	}
	return 200;
};

test('读列表:在线账号用会话的 cookie / SteamID / UA,maFile 的 identity_secret 和 device_id;下发不带 nonce,没 nonce 的不要', async () => {
	const {service, calls} = setup();
	const result = await service.list(' ALPHA ');
	assert.equal(result.accountName, 'Alpha');
	assert.equal(result.fetchedAt, 5000);
	assert.deepEqual(result.confirmations.map(item => item.id), ['1', '2']);
	assert.deepEqual(result.confirmations[0], {
		id: '1', creator: 'c-1', type: 2, typeName: 'Trade Offer', headline: 'H1', summary: ['s'], icon: '', createdAt: 1700000000_000,
		acceptText: 'Accept', cancelText: 'Cancel', warn: ''
	});
	assert.ok(!JSON.stringify(result).includes('n-1'), '不下发 nonce');
	const [kind, params] = calls[0]!;
	assert.equal(kind, 'list');
	assert.deepEqual({...params, log: undefined}, {
		cookies: ['steamLoginSecure=live'], identitySecret: 'IS-Alpha', steamID: '7656-live', deviceId: 'android:Alpha', userAgent: 'UA-live', log: undefined
	});
});

test('读列表:不在线的用存下的 cookie;没账号名 400、不在名单 404、没 maFile / 没 cookie 409、Steam 出错 502', async () => {
	const {service, calls} = setup();
	await service.list('bravo');
	assert.deepEqual(calls[0]?.[1].cookies, ['steamLoginSecure=saved']);
	assert.equal(calls[0]?.[1].steamID, '7656-bravo', '不在线时 SteamID 用 maFile 的');

	assert.equal(await statusOf(() => service.list(' ')), 400);
	assert.equal(await statusOf(() => service.list('zulu')), 404);
	assert.equal(await statusOf(() => service.list('nomafile')), 409);
	const noCookies = setup({cookiesFor: () => []});
	assert.equal(await statusOf(() => noCookies.service.list('bravo')), 409);

	assert.equal(calls.length, 1, '前置条件不满足时不请求 Steam');

	const failing = setup({
		confirmer: {
			listConfirmations: async () => {
				throw new Error('Steam 网页登录已失效');
			},
			respondToConfirmations: async () => {}
		}
	});
	await assert.rejects(failing.service.list('alpha'), (err: Error & {statusCode?: number}) => err.statusCode === 502 && /网页登录已失效/.test(err.message));
});

test('确认 / 拒绝:只认最近读到的列表里的 id,带上 nonce;成功后从列表去掉、写账号日志', async () => {
	const {service, calls, logs} = setup();
	assert.equal(await statusOf(() => service.respond({accountName: 'alpha', ids: ['1'], accept: true})), 409, '还没读过列表');

	await service.list('alpha');
	const result = await service.respond({accountName: 'alpha', ids: ['2', '1', '2'], accept: true});
	assert.deepEqual(result.done, ['2', '1']);
	assert.equal(result.accept, true);
	assert.deepEqual(result.confirmations, []);
	const [, params] = calls.at(-1)! as ['respond', RespondConfirmationsParams];
	assert.deepEqual(params.confirmations.map(item => [item.id, item.nonce]), [['2', 'n-2'], ['1', 'n-1']]);
	assert.equal(params.accept, true);
	assert.deepEqual(logs, ['info 令牌确认:已确认 2 项:市场上架「AK-47」;交易报价「H1」']);

	assert.equal(await statusOf(() => service.respond({accountName: 'alpha', ids: ['1'], accept: false})), 409, '处理过的不能再提交');
	assert.equal(await statusOf(() => service.respond({accountName: 'alpha', ids: [], accept: false})), 400);
	assert.equal(await statusOf(() => service.respond({accountName: 'alpha', ids: ['1']})), 400, '要说清确认还是拒绝');
	assert.equal(await statusOf(() => service.respond({accountName: 'alpha', ids: ['1'], accept: 'yes'})), 400);
});

test('确认 / 拒绝:Steam 拒绝时 502、写错误日志、列表不动(可以再试)', async () => {
	const {service, calls, logs, failRespond} = setup();
	await service.list('alpha');
	failRespond(new Error('Steam 拒绝了手机确认请求(mobileconf/ajaxop):Invalid authenticator'));
	await assert.rejects(service.respond({accountName: 'alpha', ids: ['1'], accept: false}),
		(err: Error & {statusCode?: number}) => err.statusCode === 502 && /Invalid authenticator/.test(err.message));
	assert.deepEqual(logs, ['error 令牌确认:拒绝 1 项失败:Steam 拒绝了手机确认请求(mobileconf/ajaxop):Invalid authenticator']);
	assert.equal(calls.filter(([kind]) => kind === 'respond').length, 1);
});

test('同一个账号的操作排队:连点两下,第二次等第一次完了才看列表,不会把同一条提交两次', async () => {
	const {service, calls, holdRespond} = setup();
	await service.list('alpha');
	const release = holdRespond();
	const first = service.respond({accountName: 'alpha', ids: ['1'], accept: true});
	const second = service.respond({accountName: 'alpha', ids: ['1'], accept: true});
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(calls.filter(([kind]) => kind === 'respond').length, 1);
	release();
	await first;
	await assert.rejects(second, (err: Error & {statusCode?: number}) => err.statusCode === 409);
	assert.equal(calls.filter(([kind]) => kind === 'respond').length, 1);
});
