// 账号与登录:refreshToken 登录、Steam Guard 验证码、手动刷新 WebSession、登录后查真实账户国家、账户列表补全国家、令牌确认。
// 假 steam-user:密码 pw-guard 要移动令牌验证码(24680 才对);假商店账户页按 FAKE_STORE_COUNTRY 回国家;
// 假 mobileconf 的「令牌确认」确认项在 FAKE_CONFIRMATIONS_FILE。

import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {Client, removeDir, sleep, startServer, tempDir} from './support/server.ts';
import type {FakeSteamEvent, TestServer} from './support/server.ts';

const IDENTITY_SECRET = 'E2E-HOTEL-IDENTITY';
const steamTotp = createRequire(import.meta.url)('steam-totp') as {getConfirmationKey(secret: string, time: number, tag: string): string};

interface PublicAttempt {
	id: string;
	accountName: string;
	status: string;
	country: string;
	guard: {type: string; lastCodeWrong: boolean} | null;
	logs: Array<{level: string; message: string}>;
}

describe('账号与登录', () => {
	const password = randomBytes(9).toString('base64url');
	let appRoot: string;
	let server: TestServer;
	let client: Client;

	const events = (name: FakeSteamEvent['event']) => server.steamEvents().filter(event => event.event === name);
	const attempt = async (id: string) => ((await client.get('/api/attempts')).json.attempts as PublicAttempt[]).find(a => a.id === id);
	async function until(id: string, ok: (a: PublicAttempt) => boolean, timeoutMs = 5000): Promise<PublicAttempt> {
		const deadline = Date.now() + timeoutMs;
		let current = await attempt(id);
		while (!(current && ok(current)) && Date.now() < deadline) {
			await sleep(50);
			current = await attempt(id);
		}
		assert.ok(current && ok(current), JSON.stringify(current));
		return current as PublicAttempt;
	}

	before(async () => {
		appRoot = tempDir('accounts');
		mkdirSync(join(appRoot, 'data', 'config'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'accounts.json'), JSON.stringify([
			{accountName: 'golf', password: 'pw-guard'},
			{accountName: 'hotel', password: 'pw-good'}
		]));
		// hotel 有 maFile(只有 identity_secret,登录照旧按密码),能用令牌确认
		mkdirSync(join(appRoot, 'data', 'config', 'mafile'), {recursive: true});
		writeFileSync(join(appRoot, 'data', 'config', 'mafile', 'hotel.maFile'), JSON.stringify({account_name: 'hotel', identity_secret: IDENTITY_SECRET}));
		const confirmationsFile = join(appRoot, 'fake-confirmations.json');
		writeFileSync(confirmationsFile, JSON.stringify([
			{id: 'c1', creator_id: '5551', type: 2, type_name: 'Trade Offer', headline: 'Bob', summary: ['You will give up 1 item'], creation_time: 1700000000},
			{id: 'c2', creator_id: '7001', type: 3, type_name: 'Market Listing', headline: 'AK-47 | Redline', summary: ['Selling for $10.00']},
			{id: 'c3', creator_id: '5552', type: 2, type_name: 'Trade Offer', headline: 'Eve'}
		]));
		server = await startServer({appRoot, env: {APP_PASSWORD: password, FAKE_STORE_COUNTRY: 'UY', FAKE_CONFIRMATIONS_FILE: confirmationsFile}});
		client = new Client(server.baseUrl);
		await client.login(password);
	});

	after(async () => {
		await server?.kill();
		removeDir(appRoot);
	});

	test('refreshToken 登录:不需要密码;登录后查商店账户页拿到真实国家', async () => {
		const res = await client.post('/api/login-refresh', {accountName: 'alpha', refreshToken: 'RT-GOOD-alpha', remember: true});
		assert.equal(res.status, 200, res.text);
		const ready = await until(res.json.attempt.id, a => a.status === 'web_session' && a.country === 'UY');
		assert.ok(ready.logs.some(l => l.message === '账户国家/地区: UY'));
		const logOn = events('logOn').at(-1)?.details;
		assert.equal(logOn?.refreshToken, 'RT-GOOD-alpha');
		assert.equal(logOn?.password, undefined);
		// 账户页先 302 下发 browserid,带上再请求一次才 200
		assert.equal(events('storeRequest').filter(e => e.path === 'store.steampowered.com/account/').length, 2);

		assert.equal((await client.post('/api/login-refresh', {accountName: 'alpha'})).status, 400);
	});

	test('Steam Guard:要验证码时停在 guard_required;错码再要一次,对码登录成功', async () => {
		const res = await client.post('/api/login', {accountName: 'golf'});
		assert.equal(res.status, 200, res.text);
		const id = res.json.attempt.id as string;
		const waiting = await until(id, a => a.status === 'guard_required');
		assert.deepEqual([waiting.guard?.type, waiting.guard?.lastCodeWrong], ['mobile', false]);

		assert.equal((await client.post(`/api/guard/${id}`, {code: ' '})).status, 400);
		assert.equal((await client.post(`/api/guard/${id}`, {code: '11111'})).status, 200);
		const wrong = await until(id, a => a.status === 'guard_required' && !!a.guard?.lastCodeWrong);
		assert.equal(wrong.guard?.type, 'mobile');
		assert.equal((await client.post(`/api/guard/${id}`, {code: '24680'})).status, 200);
		await until(id, a => a.status === 'web_session');
		assert.deepEqual(events('guardCode').map(e => (e as unknown as {code: string}).code), ['11111', '24680']);

		// 已经不需要验证码了
		assert.equal((await client.post(`/api/guard/${id}`, {code: '24680'})).status, 409);
		assert.equal((await client.post('/api/guard/no-such-id', {code: '1'})).status, 404);
	});

	test('手动刷新 WebSession:进 web_session_pending,拿到新 cookie 后回 web_session', async () => {
		const res = await client.post('/api/login', {accountName: 'hotel'});
		const id = res.json.attempt.id as string;
		await until(id, a => a.status === 'web_session');
		const before = events('webLogOn').length;
		const refresh = await client.post(`/api/web-session/${id}`);
		assert.equal(refresh.status, 200, refresh.text);
		assert.equal(refresh.json.attempt.status, 'web_session_pending');
		await until(id, a => a.status === 'web_session');
		assert.equal(events('webLogOn').length, before + 1);

		assert.equal((await client.post('/api/web-session/no-such-id')).status, 404);
	});

	test('消费记录:后台一页页读完(先 302 补 cookie,翻页带 sessionid 和游标);读过的不重读,force 重读', async () => {
		const read = async (body: Record<string, unknown>) => {
			const res = await client.post('/api/accounts/history', body);
			assert.equal(res.status, 200, res.text);
			const deadline = Date.now() + 15000;
			let history = res.json.history;
			while (history.status === 'loading' && Date.now() < deadline) {
				await sleep(100);
				history = (await client.get('/api/accounts/history?accountName=hotel')).json.history;
			}
			return history;
		};
		const done = await read({accountName: 'HOTEL'});
		assert.deepEqual([done.status, done.accountName, done.pages, done.count, done.error], ['done', 'hotel', 3, 37, '']);
		const kinds = new Set(done.rows.map((row: {kind: string}) => row.kind));
		assert.deepEqual([...kinds].sort(), ['gift', 'ingame', 'market_buy', 'market_sell', 'purchase', 'refund', 'wallet']);
		assert.deepEqual(done.rows[0].total, {text: '$0.42', amount: 0.42, currency: 'USD'});

		const requests = events('storeRequest').filter(e => e.path === 'store.steampowered.com/account/AjaxLoadMoreHistory/');
		assert.deepEqual(requests.map(e => e.form?.['cursor[wallet_txnid]']), ['2', '3']);
		assert.ok(requests.every(e => e.form?.sessionid === 'store-' + e.owner), '用商店补发的 sessionid');

		assert.equal((await read({accountName: 'hotel'})).count, 37);
		assert.equal(events('storeRequest').filter(e => e.path === 'store.steampowered.com/account/history/').length, 2, '读过的不重读');
		await read({accountName: 'hotel', force: true});
		assert.equal(events('storeRequest').filter(e => e.path === 'store.steampowered.com/account/history/').length, 4);

		assert.equal((await client.post('/api/accounts/history', {accountName: 'nobody'})).status, 404);
		assert.equal((await client.get('/api/accounts/history?accountName=golf')).json.history, null);
	});

	test('令牌确认:读待确认项(不下发 nonce);一次确认两条走 multiajaxop、拒绝一条走 ajaxop;处理过的不能再提交', async () => {
		const list = await client.post('/api/accounts/confirmations/list', {accountName: 'HOTEL'});
		assert.equal(list.status, 200, list.text);
		assert.equal(list.json.accountName, 'hotel');
		type Item = {id: string; type: number; headline: string; summary: string[]; createdAt: number};
		assert.deepEqual((list.json.confirmations as Item[]).map(c => [c.id, c.type, c.headline]), [['c1', 2, 'Bob'], ['c2', 3, 'AK-47 | Redline'], ['c3', 2, 'Eve']]);
		assert.equal((list.json.confirmations as Item[])[0]?.createdAt, 1700000000_000);
		assert.ok(!list.text.includes('nonce'), '不下发 nonce');
		const listed = events('marketConfirmList').at(-1);
		assert.equal(listed?.tag, 'conf');
		assert.equal(listed?.params?.k, steamTotp.getConfirmationKey(IDENTITY_SECRET, Number(listed?.params?.t), 'conf'));

		// mobileconf 请求按出口排队,两次至少隔 5 秒
		const accepted = await client.post('/api/accounts/confirmations/respond', {accountName: 'hotel', ids: ['c1', 'c2'], accept: true});
		assert.equal(accepted.status, 200, accepted.text);
		assert.deepEqual(accepted.json.done, ['c1', 'c2']);
		assert.deepEqual((accepted.json.confirmations as Item[]).map(c => c.id), ['c3']);
		const multi = events('mobileconfRespond').at(-1);
		assert.deepEqual([multi?.path, multi?.method, multi?.confIds, multi?.op, multi?.tag], ['/mobileconf/multiajaxop', 'POST', ['c1', 'c2'], 'allow', 'allow']);
		assert.equal(multi?.params?.k, steamTotp.getConfirmationKey(IDENTITY_SECRET, Number(multi?.params?.t), 'allow'));

		const declined = await client.post('/api/accounts/confirmations/respond', {accountName: 'hotel', ids: ['c3'], accept: false});
		assert.equal(declined.status, 200, declined.text);
		const single = events('mobileconfRespond').at(-1);
		assert.deepEqual([single?.path, single?.method, single?.confIds, single?.op], ['/mobileconf/ajaxop', 'GET', ['c3'], 'cancel']);

		assert.equal((await client.post('/api/accounts/confirmations/respond', {accountName: 'hotel', ids: ['c1'], accept: true})).status, 409, '处理过的不能再提交');
		assert.equal(events('mobileconfRespond').length, 2);
		const again = await client.post('/api/accounts/confirmations/list', {accountName: 'hotel'});
		assert.deepEqual(again.json.confirmations, []);

		const attempts = (await client.get('/api/attempts')).json.attempts as PublicAttempt[];
		const logs = attempts.find(a => a.accountName === 'hotel')?.logs.map(l => l.message) ?? [];
		assert.ok(logs.includes('令牌确认:已确认 2 项:交易报价「Bob」;市场上架「AK-47 | Redline」'), JSON.stringify(logs));
		assert.ok(logs.includes('令牌确认:已拒绝 1 项:交易报价「Eve」'));

		assert.equal((await client.post('/api/accounts/confirmations/list', {accountName: 'golf'})).status, 409, '没有 maFile');
		assert.equal((await client.post('/api/accounts/confirmations/list', {accountName: 'nobody'})).status, 404);
	});

	test('账户列表补全国家:钱包币种推断不出来的,用保存的 cookie 查商店账户页', async () => {
		const res = await client.post('/api/accounts/meta', {accountNames: ['hotel', 'nobody']});
		assert.equal(res.status, 200, res.text);
		assert.equal(res.json.accounts.hotel.country, 'UY');
		assert.equal(res.json.accounts.nobody.country, '', '没有 cookie 的账号查不了');
		assert.deepEqual(Object.keys(res.json.accounts.hotel).sort(), ['accountName', 'balance', 'country', 'currency', 'currencyISO', 'hasIdentitySecret', 'hasMaFile', 'hasWallet', 'steamId']);
	});
});
