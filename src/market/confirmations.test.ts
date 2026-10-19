import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBuyOrderConfirmer} from './confirmations.ts';
import type {ConfirmerOptions, Totp} from './confirmations.ts';

const STEAM_ID = '76561198000000001';
const COOKIES = [`steamLoginSecure=${STEAM_ID}%7C%7Ctoken`, 'sessionid=sid'];
const QUERY_TIME = 'https://api.steampowered.com/ITwoFactorService/QueryTime/v1/';
/** 本机 1000 秒,Steam 1005 秒:时间差 5 秒 */
const NOW_MS = 1_000_000;
const MAFILE_DEVICE = 'android:11111111-2222-3333-4444-555555555555';

interface FakeSteam {
	/** 每次 getlist 依次返回的列表,数字是 HTTP 错误码(用完后一直返回最后一个) */
	lists: Array<Array<{id: string; creator: string}> | number>;
	/** 依次给 ajaxop 的状态码(用完就 200) */
	ajaxStatuses: number[];
	/** ajaxop 回 success=false 时的 message */
	ajaxFail?: string;
	/** getlist 回 needauth */
	needauth?: boolean;
	/** 这些设备 ID 读列表时 Steam 回 success=false + Oh nooooooes!(detail 写原因) */
	refusedDevices: Map<string, string>;
	timeFails?: boolean;
	requests: Array<{url: URL; headers: Record<string, string>}>;
	accepted: string[];
	listCalls: number;
	timeCalls: number;
	queue: string[];
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});

function fakeSteam(lists: FakeSteam['lists']): FakeSteam & {options: ConfirmerOptions} {
	const steam: FakeSteam = {lists, ajaxStatuses: [], refusedDevices: new Map(), requests: [], accepted: [], listCalls: 0, timeCalls: 0, queue: []};
	const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.href === QUERY_TIME) {
			steam.timeCalls++;
			return steam.timeFails ? new Response('', {status: 503}) : json({response: {server_time: '1005', skew_tolerance_seconds: '60'}});
		}
		steam.requests.push({url, headers: Object.fromEntries(new Headers(init?.headers).entries())});
		if (url.pathname === '/mobileconf/getlist') {
			if (steam.needauth) {
				return json({success: false, needauth: true});
			}
			const refused = steam.refusedDevices.get(url.searchParams.get('p') ?? '');
			if (refused) {
				return json({success: false, message: 'Oh nooooooes!', detail: refused});
			}
			const entry = steam.lists[Math.min(steam.listCalls++, steam.lists.length - 1)] ?? [];
			if (typeof entry === 'number') {
				return json({success: false, message: 'Rate limit exceeded'}, entry);
			}
			return json({success: true, conf: entry.map(conf => ({id: conf.id, creator_id: conf.creator, nonce: 'n-' + conf.id, type: 12, headline: 'h'}))});
		}
		if (url.pathname === '/mobileconf/ajaxop') {
			const status = steam.ajaxStatuses.shift() ?? 200;
			if (status !== 200) {
				return json({success: false, message: 'Rate limit exceeded'}, status);
			}
			if (steam.ajaxFail) {
				return json({success: false, message: steam.ajaxFail});
			}
			steam.accepted.push(url.searchParams.get('cid') ?? '');
			return json({success: true});
		}
		return new Response('not found', {status: 404});
	}) as typeof fetch;
	const totp: Totp = {
		getConfirmationKey: (secret, time, tag) => `${secret}@${time}/${tag}`,
		getDeviceID: steamID => 'android:derived-' + steamID
	};
	return Object.assign(steam, {
		options: {
			fetch: fakeFetch,
			totp,
			now: () => NOW_MS,
			sleep: async () => {},
			queue: {
				wait: async () => void steam.queue.push('wait'),
				hold: () => void steam.queue.push('hold')
			}
		}
	});
}

const query = (steam: FakeSteam, index: number) => Object.fromEntries(steam.requests[index]?.url.searchParams ?? []);

test('快照:读 getlist(maFile 设备 ID、Steam 时间签 key、tag=conf);没有 identity_secret 时不查', async () => {
	const steam = fakeSteam([[{id: '1', creator: 'a'}, {id: '2', creator: 'b'}]]);
	const confirmer = createBuyOrderConfirmer(steam.options);
	const ids = await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS', deviceId: MAFILE_DEVICE, userAgent: 'UA-1'});
	assert.deepEqual(ids, new Set(['1', '2']));
	assert.deepEqual(query(steam, 0), {p: MAFILE_DEVICE, a: STEAM_ID, k: 'IS@1005/conf', t: '1005', m: 'react', tag: 'conf'});
	assert.equal(steam.requests[0]?.url.origin + steam.requests[0]!.url.pathname, 'https://steamcommunity.com/mobileconf/getlist');
	assert.equal(steam.requests[0]?.headers.cookie, COOKIES.join('; '));
	assert.equal(steam.requests[0]?.headers['user-agent'], 'UA-1');
	assert.deepEqual(steam.queue, ['wait'], '先排队再发');

	assert.deepEqual(await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: ' '}), new Set());
	assert.equal(steam.requests.length, 1);
});

test('快照差分:挂单后新冒出来的那条就是本单,ajaxop allow 它并带回 creator;没有 maFile 设备 ID 时按 SteamID 算', async () => {
	const steam = fakeSteam([[{id: 'old', creator: 'trade-1'}, {id: 'new', creator: '9001'}]]);
	const confirmer = createBuyOrderConfirmer(steam.options);
	const result = await confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: 'mismatch', priorConfIds: new Set(['old'])});
	assert.deepEqual(result, {confirmed: true, buyOrderId: '9001'});
	assert.deepEqual(steam.accepted, ['new']);
	assert.deepEqual(query(steam, 1), {
		p: 'android:derived-' + STEAM_ID, a: STEAM_ID, k: 'IS@1005/allow', t: '1005', m: 'react', tag: 'allow', op: 'allow', cid: 'new', ck: 'n-new'
	});
	assert.equal(steam.requests[1]?.url.pathname, '/mobileconf/ajaxop');
});

test('没有快照时用 confirmation_id 比 id 或 creator;多条分不清就报错,绝不乱确认', async () => {
	const steam = fakeSteam([[{id: '1', creator: 'trade-1'}, {id: '2', creator: '555'}]]);
	await createBuyOrderConfirmer(steam.options).confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '555'});
	assert.deepEqual(steam.accepted, ['2']);

	const ambiguous = fakeSteam([[{id: '1', creator: 'trade-1'}, {id: '2', creator: 'trade-2'}]]);
	await assert.rejects(createBuyOrderConfirmer(ambiguous.options).confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '777'}), /检测到 2 个待确认项/);
	assert.deepEqual(ambiguous.accepted, []);
});

test('确认项晚到:按间隔重试;一直没有就报错', async () => {
	const steam = fakeSteam([[], [], [{id: 'n', creator: '1'}]]);
	const waits: number[] = [];
	const confirmer = createBuyOrderConfirmer({...steam.options, sleep: async ms => void waits.push(ms)});
	await confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', buyOrderId: '1', priorConfIds: new Set()});
	assert.deepEqual(waits, [5000, 5000]);
	assert.deepEqual(steam.accepted, ['n']);

	const never = fakeSteam([[{id: 'old', creator: 'x'}]]);
	await assert.rejects(createBuyOrderConfirmer(never.options).confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', priorConfIds: new Set(['old']), attempts: 3}), /重试 3 次仍没找到/);
	assert.equal(never.listCalls, 3);
	assert.deepEqual(never.accepted, []);
});

test('前置条件:没 cookie、没 identity_secret、什么线索都没有、读不出 SteamID 时直接报错', async () => {
	const steam = fakeSteam([[]]);
	const confirmer = createBuyOrderConfirmer(steam.options);
	await assert.rejects(confirmer.confirmBuyOrder({cookies: [], identitySecret: 'IS', confirmationId: '1'}), /缺少 WebSession cookies/);
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: '', confirmationId: '1'}), /未导入 maFile/);
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', priorConfIds: null}), /无法定位/);
	await assert.rejects(confirmer.confirmBuyOrder({cookies: ['sessionid=sid'], identitySecret: 'IS', confirmationId: '1'}), /读不出 SteamID/);
	assert.equal(steam.requests.length, 0);

	await confirmer.listConfirmationIds({cookies: ['sessionid=sid'], identitySecret: 'IS', steamID: STEAM_ID});
	assert.equal(query(steam, 0).a, STEAM_ID, '给了 SteamID 就不用从 cookie 读');
});

test('Steam 时间差缓存 1 小时;查不到按本机时间签,不缓存', async () => {
	let clock = NOW_MS;
	const steam = fakeSteam([[{id: 'a', creator: '1'}]]);
	const confirmer = createBuyOrderConfirmer({...steam.options, now: () => clock});
	await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'});
	clock += 59 * 60 * 1000;
	await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'});
	assert.equal(steam.timeCalls, 1);
	assert.equal(query(steam, 1).t, String(1000 + 59 * 60 + 5), '签名时间 = 本机时间 + 缓存的时间差');
	clock += 2 * 60 * 1000;
	await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'});
	assert.equal(steam.timeCalls, 2);

	const offline = fakeSteam([[]]);
	offline.timeFails = true;
	const logs: string[] = [];
	const local = createBuyOrderConfirmer({...offline.options, log: (level, message) => void logs.push(`${level} ${message}`)});
	await local.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'});
	await local.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS'});
	assert.equal(query(offline, 0).t, '1000');
	assert.equal(offline.timeCalls, 2, '失败不缓存');
	assert.match(logs[0] ?? '', /^warn .*查 Steam 时间失败,按本机时间签确认 key:HTTP 503/);
});

test('Steam 说失败时把原话带进报错:needauth 提示重新登录,ajaxop success=false 带 message', async () => {
	const expired = fakeSteam([[]]);
	expired.needauth = true;
	await assert.rejects(createBuyOrderConfirmer(expired.options).confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '1'}), /网页登录已失效/);

	const refused = fakeSteam([[{id: 'a', creator: '1'}]]);
	refused.ajaxFail = 'Invalid authenticator';
	await assert.rejects(createBuyOrderConfirmer(refused.options).confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: 'a'}),
		/Steam 拒绝了手机确认请求\(mobileconf\/ajaxop\):Invalid authenticator/);
});

test('超时:mobileconf 不回就按 timeoutMs 报错', async () => {
	const steam = fakeSteam([[]]);
	const hanging = (async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input) === QUERY_TIME) {
			return json({response: {server_time: '1005'}});
		}
		return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason)));
	}) as typeof fetch;
	const confirmer = createBuyOrderConfirmer({...steam.options, fetch: hanging});
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '1', timeoutMs: 20}), /超时: mobileconf\/getlist/);
});

test('限流:读列表、提交确认回 429 时出口冷却、等一会再试,日志里带 Steam 原话', async () => {
	const steam = fakeSteam([429, [{id: 'new', creator: '9001'}]]);
	steam.ajaxStatuses.push(429);
	const waits: number[] = [];
	const logs: string[] = [];
	const confirmer = createBuyOrderConfirmer({
		...steam.options, sleep: async ms => void waits.push(ms), log: (level, message) => void logs.push(`${level} ${message}`)
	});
	const result = await confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', priorConfIds: new Set()});
	assert.deepEqual(result, {confirmed: true, buyOrderId: '9001'});
	assert.deepEqual(waits, [10000, 10000], '读列表、提交确认各等了一次');
	assert.deepEqual(steam.accepted, ['new']);
	assert.deepEqual(steam.queue, ['wait', 'hold', 'wait', 'wait', 'hold', 'wait']);
	const limited = logs.filter(line => line.startsWith('warn'));
	assert.match(limited[0] ?? '', /读取确认列表被 Steam 拒绝\(HTTP 429,Steam 回:Rate limit exceeded\),10 秒后重试\(1\/2\)/);
	assert.match(limited[1] ?? '', /提交确认被 Steam 拒绝/);
	assert.ok(logs.some(line => /手机确认:设备 ID 先用按 SteamID 算的,Steam 时间差 5 秒/.test(line)));
});

test('限流:一直 429 就按顺序等完再报限流;别的错误不重试', async () => {
	const limited = fakeSteam([429]);
	const waits: number[] = [];
	const confirmer = createBuyOrderConfirmer({...limited.options, sleep: async ms => void waits.push(ms)});
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '1'}),
		/Steam 手机确认接口限流\(HTTP 429,Steam 回:Rate limit exceeded\),重试 2 次仍不行/);
	assert.deepEqual(waits, [10000, 20000]);
	assert.equal(limited.listCalls, 3);

	const broken = fakeSteam([500]);
	const strict = createBuyOrderConfirmer({...broken.options, sleep: async () => assert.fail('不该等')});
	await assert.rejects(strict.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', confirmationId: '1'}), /mobileconf\/getlist 返回 HTTP 500:Rate limit exceeded/);
	assert.equal(broken.listCalls, 1);
});

const LOADING = 'There was a problem loading the confirmation page. Please try your request again later.';
const BAD_CODES = 'It looks like your Steam Guard Mobile Authenticator is providing incorrect Steam Guard codes.';

test('设备 ID 被拒(Oh nooooooes!):换按 SteamID 算的再试,能用的这次运行里记住', async () => {
	const steam = fakeSteam([[{id: 'n', creator: '9001'}]]);
	steam.refusedDevices.set(MAFILE_DEVICE, LOADING);
	const logs: string[] = [];
	const confirmer = createBuyOrderConfirmer({...steam.options, log: (level, message) => void logs.push(`${level} ${message}`)});
	const result = await confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', deviceId: MAFILE_DEVICE, confirmationId: '9001'});
	assert.deepEqual(result, {confirmed: true, buyOrderId: '9001'});
	assert.deepEqual(steam.requests.map(r => [r.url.pathname, r.url.searchParams.get('p')]), [
		['/mobileconf/getlist', MAFILE_DEVICE], ['/mobileconf/getlist', 'android:derived-' + STEAM_ID], ['/mobileconf/ajaxop', 'android:derived-' + STEAM_ID]
	]);
	assert.ok(logs.some(line => line.startsWith('warn') && line.includes('Steam 原文:') && line.includes(LOADING)), '日志里有 Steam 原文');
	assert.ok(logs.some(line => /设备 ID 换成按 SteamID 算的再试一次/.test(line)));

	await confirmer.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS', deviceId: MAFILE_DEVICE});
	assert.equal(steam.requests.at(-1)?.url.searchParams.get('p'), 'android:derived-' + STEAM_ID, '下次直接用能用的那个');
	assert.equal(steam.requests.length, 4);
});

test('两个设备 ID 都被拒:报错带上 detail(原因),不再重试', async () => {
	const steam = fakeSteam([[]]);
	steam.refusedDevices.set(MAFILE_DEVICE, BAD_CODES).set('android:derived-' + STEAM_ID, BAD_CODES);
	const confirmer = createBuyOrderConfirmer({...steam.options, sleep: async () => assert.fail('不该等')});
	await assert.rejects(confirmer.confirmBuyOrder({cookies: COOKIES, identitySecret: 'IS', deviceId: MAFILE_DEVICE, confirmationId: '1'}),
		(err: Error) => err.message === `Steam 拒绝了手机确认请求(mobileconf/getlist):Oh nooooooes! ${BAD_CODES}`);
	assert.equal(steam.requests.length, 2);
});

test('maFile 的 device_id 不像设备 ID(SDA 坏掉时写成 ERROR):直接用按 SteamID 算的', async () => {
	const steam = fakeSteam([[]]);
	const logs: string[] = [];
	await createBuyOrderConfirmer({...steam.options, log: (level, message) => void logs.push(`${level} ${message}`)})
		.listConfirmationIds({cookies: COOKIES, identitySecret: 'IS', deviceId: 'ERROR'});
	assert.equal(query(steam, 0).p, 'android:derived-' + STEAM_ID);
	assert.match(logs[0] ?? '', /^warn .*maFile 的 device_id 不像设备 ID\(ERROR\)/);
});
