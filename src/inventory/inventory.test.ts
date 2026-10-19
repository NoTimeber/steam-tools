import {test} from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import type {Attempt} from '../steam/session-manager.ts';
import {createGcModuleAttacher} from '../steam/gc-modules.ts';
import {serializeForJson} from '../core/serialize.ts';
import {extractCommunityTradableAfter, normalizeCommunityInventoryPage} from './community.ts';
import {buildGcInventorySnapshot, isGcDisplayInventoryItem} from './gc.ts';
import {createInventoryService} from './index.ts';
import type {DescribeGcItem} from './gc.ts';

const describe: DescribeGcItem = item => ({
	name: 'Item ' + item.def_index, marketHashName: 'MH ' + item.def_index, type: item.def_index === 7 ? 'Rifle' : '', category: 'weapon',
	rarity: 'r', exterior: 'e', iconUrl: 'i', tradableAfter: item.tradable_after ?? null, stickers: [1, 2]
});

test('序列化:Long 转十进制、Buffer 转 hex、Date 转 ISO,丢函数,循环引用打标记', () => {
	const circular: Record<string, unknown> = {a: 1};
	circular.self = circular;
	assert.deepEqual(serializeForJson({
		id: {low: 5, high: 0, unsigned: true, toString: () => '5'}, buf: Buffer.from([1, 255]), at: new Date('2026-01-01T00:00:00Z'),
		big: 10n, fn: () => 1, list: [circular], nil: null
	}), {id: '5', buf: {type: 'Buffer', hex: '01ff'}, at: '2026-01-01T00:00:00.000Z', big: '10', list: [{a: 1, self: '[Circular]'}], nil: null});
});

test('GC 库存过滤:储物柜里的、flags 24 的、origin 24 + 属性 277 的不显示', () => {
	assert.equal(isGcDisplayInventoryItem({id: '1'}), true);
	assert.equal(isGcDisplayInventoryItem({id: '1', casket_id: '9'}), false);
	assert.equal(isGcDisplayInventoryItem({id: '1', flags: 28}), false);
	assert.equal(isGcDisplayInventoryItem({id: '1', flags: 8}), true);
	assert.equal(isGcDisplayInventoryItem({id: '1', origin: 24, attribute: [{def_index: 277}]}), false);
	assert.equal(isGcDisplayInventoryItem({id: '1', origin: 24, attribute: [{def_index: 6}]}), true);
	assert.equal(isGcDisplayInventoryItem(null), false);
});

test('GC 快照:按背包位置排序,交易冷却按 schema 给的时间算;raw 里保留全部原始物品', () => {
	const now = Date.parse('2026-10-13T00:00:00Z');
	const snapshot = buildGcInventorySnapshot({inventory: [
		{id: '2', def_index: 7, position: 2, tradable_after: '2026-10-20T00:00:00Z', paint_wear: 0.2},
		{id: '1', def_index: 9, position: 1},
		{id: '3', def_index: 9, position: 1, casket_id: '5'}
	]}, describe, now);
	assert.deepEqual(snapshot.items.map(i => [i.assetid, i.type, i.tradable, i.paintWear, i.stickerCount]), [['1', 'DefIndex 9', true, null, 2], ['2', 'Rifle', false, 0.2, 2]]);
	assert.deepEqual([snapshot.source, snapshot.itemCount, snapshot.fetchedAt, (snapshot.raw as {items: unknown[]}).items.length], ['gc', 2, '2026-10-13T00:00:00.000Z', 3]);
});

test('社区库存:按 classid_instanceid 配描述;标签取本地化名;GC 里有同一件时用 GC 的交易冷却', () => {
	const now = Date.parse('2026-10-13T00:00:00Z');
	const items = normalizeCommunityInventoryPage({
		assets: [{assetid: '1', classid: 'a', instanceid: '0'}, {assetid: '2', classid: 'b', instanceid: '0', amount: '3'}, {id: '3', classid: 'zz', instanceid: '0'}],
		descriptions: [
			{classid: 'a', instanceid: '0', name: '红线', market_hash_name: 'Redline', tradable: 1, icon_url: 'x', tags: [{category: 'Type', localized_tag_name: '步枪'}, {category_name: 'Rarity', name: '保密', color: 'D32CE6'}]},
			{classid: 'b', instanceid: '0', market_name: '钥匙', tradable: 0, marketable: 0, type: 'Key'}
		]
	}, new Map([['1', {tradable_after: new Date('2026-10-20T00:00:00Z'), paint_wear: 0.25, paint_seed: 661}]]), now);
	assert.deepEqual(items.map(i => [i.rarityColor, i.paintWear, i.paintSeed]), [['#d32ce6', 0.25, 661], ['', null, null], ['', null, null]], '稀有度颜色取标签的;磨损只有 GC 里有');
	assert.deepEqual(items.map(i => [i.assetid, i.name, i.type, i.rarity, i.tradable, i.marketable, i.tradableAfter, i.amount]), [
		['1', '红线', '步枪', '保密', false, true, '2026-10-20T00:00:00.000Z', 1],
		['2', '钥匙', 'Key', '', false, false, '', 3],
		['3', 'Asset ', '-', '', true, true, '', 1]
	]);
	assert.equal(items[0]?.iconUrl, 'https://community.cloudflare.steamstatic.com/economy/image/x/96fx96f');
});

test('交易冷却文字:括号里的时刻不能丢(V8 会把括号当注释)', () => {
	assert.equal(extractCommunityTradableAfter({owner_descriptions: [{value: '<b>Tradable After Feb 03, 2099 (7:00:00) GMT</b>'}]}), '2099-02-03T07:00:00.000Z');
	assert.equal(extractCommunityTradableAfter({descriptions: ['', 'Marketable After Mar 10, 2099 (16:00:00) GMT']}), '2099-03-10T16:00:00.000Z');
	assert.equal(extractCommunityTradableAfter({cache_expiration: '2099-01-01T08:00:00Z', owner_descriptions: ['Tradable After Feb 03, 2099 (7:00:00) GMT']}), '2099-01-01T08:00:00.000Z');
	assert.equal(extractCommunityTradableAfter({owner_descriptions: ['不是日期']}), '');
	assert.equal(extractCommunityTradableAfter({owner_descriptions: [{value: 'Tradable/Marketable After Oct 25, 2026 (7:00:00) GMT'}]}), '2026-10-25T07:00:00.000Z');
});

test('交易冷却文字:中文日期(l=schinese 拉的),按 GMT;没有时刻的不认', () => {
	for (const text of [
		'Tradable/Marketable After 2026年10月25日 (7:00:00) GMT',
		'在 2026年10月25日 (7:00:00) GMT 之后可交易/出售',
		'<span>可交易时间：2026 年 10 月 25 日 （7:00:00） GMT</span>'
	]) {
		assert.equal(extractCommunityTradableAfter({owner_descriptions: [{value: text}]}), '2026-10-25T07:00:00.000Z', text);
	}
	assert.equal(extractCommunityTradableAfter({owner_descriptions: ['2099年2月3日 (16:30) GMT']}), '2099-02-03T16:30:00.000Z');
	assert.equal(extractCommunityTradableAfter({descriptions: ['2024年哥本哈根锦标赛纪念品'], owner_descriptions: ['2026年10月25日']}), '');
	const [key] = normalizeCommunityInventoryPage({
		assets: [{assetid: '1', classid: 'k', instanceid: '0'}],
		descriptions: [{classid: 'k', instanceid: '0', name: '武器箱钥匙', tradable: 0, owner_descriptions: [{value: ' '}, {value: '2099年2月3日 (7:00:00) GMT'}]}]
	}, null, Date.UTC(2099, 1, 3, 6));
	assert.deepEqual([key?.tradable, key?.tradableAfter], [false, '2099-02-03T07:00:00.000Z'], '解锁当天 6 点还在冷却');
	assert.equal(extractCommunityTradableAfter(null), '');
});

// ===== 服务:缓存、并发去重、失败冷却 + GC 兜底 =====

function page(assetIds: string[], more = false) {
	return {success: 1, more_items: more ? 1 : 0, last_assetid: assetIds.at(-1), assets: assetIds.map(assetid => ({assetid, classid: 'a', instanceid: '0'})), descriptions: [{classid: 'a', instanceid: '0', name: 'X'}]};
}

function harness(replies: Array<unknown | 'fail'>) {
	let clock = 1_000_000;
	const requests: string[] = [];
	const emits: unknown[] = [];
	let release: (() => void) | null = null;
	let gate: Promise<void> | null = null;
	const service = createInventoryService({
		describeGcItem: describe,
		cookiesFor: attempt => attempt.accountName === 'nocookie' ? [] : ['steamLoginSecure=x'],
		emit: attempt => void emits.push([attempt.inventoryCount, attempt.inventorySource]),
		now: () => clock,
		fetch: (async (url: URL) => {
			requests.push(String(url.searchParams.get('start_assetid') || 'first'));
			if (gate) {
				await gate;
			}
			const reply = replies.shift();
			if (reply === 'fail' || reply === undefined) {
				return new Response('Forbidden', {status: 403});
			}
			return new Response(JSON.stringify(reply));
		}) as unknown as typeof fetch
	});
	const attempt = {accountName: 'alpha', steamID: '7656', gcConnected: true, csgo: {inventory: [{id: '9', def_index: 7}]}} as unknown as Attempt;
	return {
		service, attempt, requests, emits,
		tick: (ms: number) => void (clock += ms),
		hold() {
			gate = new Promise(resolve => {
				release = resolve;
			});
		},
		release: () => release?.()
	};
}

test('库存:分页拉社区库存;15 秒内用缓存,强制刷新才重拉', async () => {
	const h = harness([page(['1', '2'], true), page(['3']), page(['4'])]);
	const first = await h.service.get(h.attempt);
	assert.deepEqual([first.source, first.itemCount, h.requests], ['community', 3, ['first', '2']]);
	assert.deepEqual(h.emits, [[3, 'community']]);
	h.tick(10_000);
	assert.equal((await h.service.get(h.attempt)).itemCount, 3);
	assert.equal(h.requests.length, 2);
	assert.equal((await h.service.get(h.attempt, {forceRefresh: true})).itemCount, 1);
	h.tick(16_000);
	assert.equal((await h.service.get(h.attempt)).source, 'gc', '缓存过期后重拉;这次失败,GC 里有东西就兜底');
	assert.equal(h.requests.length, 4);
});

test('库存:同一账号并发打开只发一次请求', async () => {
	const h = harness([page(['1'])]);
	h.hold();
	const both = Promise.all([h.service.get(h.attempt), h.service.get(h.attempt)]);
	await new Promise(resolve => setImmediate(resolve));
	h.release();
	const [a, b] = await both;
	assert.equal(a, b);
	assert.deepEqual(h.requests, ['first']);
});

test('库存:社区失败用 GC 兜底并冷却 30 秒;冷却期内 GC 快照可直接返回,过了再试社区', async () => {
	const h = harness(['fail', page(['1'])]);
	(h.attempt as {inventoryCache?: unknown}).inventoryCache = null;
	const fallback = await h.service.get(h.attempt);
	assert.deepEqual([fallback.source, fallback.itemCount], ['gc', 1]);
	assert.deepEqual(h.emits, [[1, 'gc']]);
	h.tick(5_000);
	assert.equal((await h.service.get(h.attempt)).source, 'gc');
	assert.equal(h.requests.length, 1, '冷却期内不重试社区');
	h.tick(30_000);
	assert.equal((await h.service.get(h.attempt)).source, 'community');
});

test('库存:GC 来源的新鲜缓存不短路(还是去拉社区);没连 GC 也照样拉社区;GC 也是空的就把社区错误抛出去', async () => {
	const h = harness([page(['1'])]);
	h.service.refreshFromGc(h.attempt);
	assert.deepEqual([h.attempt.inventoryCount, h.attempt.inventorySource], [1, 'gc']);
	assert.equal((await h.service.get(h.attempt)).source, 'community');
	h.service.refreshFromGc(h.attempt);
	assert.deepEqual([h.attempt.inventoryCount, h.attempt.inventorySource], [1, 'community'], 'GC 物品变了只更新数量,社区缓存留着');

	const off = harness([page(['1', '2'])]);
	Object.assign(off.attempt, {gcConnected: false, csgo: null});
	const noGc = await off.service.get(off.attempt);
	assert.deepEqual([noGc.source, noGc.itemCount, off.requests], ['community', 2, ['first']]);
	const offFail = harness(['fail']);
	Object.assign(offFail.attempt, {gcConnected: false, csgo: null});
	await assert.rejects(offFail.service.get(offFail.attempt), (err: Error & {statusCode?: number}) => err.statusCode === 409 && err.message === 'Forbidden', '没连 GC 就没有兜底');

	const empty = harness(['fail']);
	(empty.attempt.csgo as {inventory: unknown[]}).inventory = [];
	await assert.rejects(empty.service.get(empty.attempt), (err: Error & {statusCode?: number}) => err.statusCode === 409 && err.message === 'Forbidden');

	const noCookie = harness([]);
	(noCookie.attempt as {accountName: string}).accountName = 'nocookie';
	(noCookie.attempt.csgo as {inventory: unknown[]}).inventory = [];
	await assert.rejects(noCookie.service.get(noCookie.attempt), /没有可用的 WebSession cookies/);
	assert.deepEqual(noCookie.requests, []);
});

/** 库存页先连 GC:attempt 上挂假客户端(记 gamesPlayed)和假 CS2 模块 */
function withGcClient(h: ReturnType<typeof harness>) {
	const played: number[][] = [];
	const csgo = Object.assign(new EventEmitter(), {inventory: [{id: '9', def_index: 7}]});
	Object.assign(h.attempt, {
		cs2GcConnected: false, gcConnected: false, activeGame: 'cs2', csgo,
		client: {gamesPlayed: (apps: number[]) => void played.push(apps), webLogOn: () => {}}
	});
	return {
		played, csgo,
		connect() {
			Object.assign(h.attempt, {cs2GcConnected: true, gcConnected: true});
			csgo.emit('connectedToGC');
		}
	};
}

test('库存页先连 GC:没连就先进 CS2、等 GC 连上,再跳过缓存重拉;同时打开只连一次;已连上不再进游戏', async () => {
	const h = harness([page(['1']), page(['1', '2']), page(['3'])]);
	const gc = withGcClient(h);
	await h.service.get(h.attempt);
	assert.deepEqual([h.requests, gc.played], [['first'], []], '终端机这类调用方不替账号连 GC');

	const both = Promise.all([h.service.get(h.attempt, {connectGc: true}), h.service.get(h.attempt, {connectGc: true})]);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(gc.played, [[730]], '两次打开只进一次游戏');
	assert.deepEqual(h.requests, ['first'], 'GC 没连上前不拉社区');
	gc.connect();
	const [a, b] = await both;
	assert.equal(a, b);
	assert.deepEqual([a.itemCount, h.requests], [2, ['first', 'first']], '刚连上 GC,15 秒内的缓存也不算数');

	assert.equal((await h.service.get(h.attempt, {connectGc: true})).itemCount, 2, '已连上:照常用缓存');
	assert.deepEqual([gc.played.length, h.requests.length], [1, 2]);
});

test('库存页先连 GC:GC 报错或账号没登录就报错,不拉社区库存', async () => {
	const h = harness([page(['1'])]);
	const gc = withGcClient(h);
	const pending = h.service.get(h.attempt, {connectGc: true});
	await new Promise(resolve => setImmediate(resolve));
	gc.csgo.emit('error', new Error('boom'));
	await assert.rejects(pending, (err: Error & {statusCode?: number}) => err.statusCode === 409 && err.message.startsWith('CS2 GC 没连上(boom)'));
	assert.deepEqual(h.requests, []);

	const offline = harness([page(['1'])]);
	Object.assign(offline.attempt, {cs2GcConnected: false, client: null});
	await assert.rejects(offline.service.get(offline.attempt, {connectGc: true}), /当前账号尚未登录 Steam/);
	assert.deepEqual(offline.requests, []);
});

// ===== GC 模块挂载 =====

class FakeModule extends EventEmitter {
	inventory: unknown[] = [];
	client: unknown;
	constructor(client: unknown) {
		super();
		this.client = client;
	}
}

test('GC 模块:连上/断开更新连接标记;CS2 库存变化刷新快照;终端机挂抓包;初始化失败只记日志', () => {
	const calls: string[] = [];
	const refreshed: string[] = [];
	const gc = createGcModuleAttacher({
		GlobalOffensive: FakeModule,
		TeamFortress2: FakeModule,
		events: {addLog: (a, level, message) => void calls.push(`${level}:${message}`), emit: () => void calls.push('emit')},
		inventory: {refreshFromGc: () => void refreshed.push('refresh')},
		onCs2Module: () => void calls.push('terminal')
	});
	const attempt = {accountName: 'alpha'} as Attempt;
	gc.attach(attempt, {});
	assert.deepEqual(calls, ['terminal']);
	const csgo = attempt.csgo as FakeModule;
	const tf2 = attempt.tf2 as FakeModule;

	csgo.emit('connectedToGC');
	assert.deepEqual([attempt.cs2GcConnected, attempt.tf2GcConnected, attempt.gcConnected, attempt.activeGame], [true, false, true, 'cs2']);
	csgo.emit('itemAcquired');
	csgo.emit('itemRemoved');
	assert.deepEqual(refreshed, ['refresh', 'refresh', 'refresh']);
	tf2.emit('connectedToGC');
	assert.deepEqual([attempt.cs2GcConnected, attempt.tf2GcConnected, attempt.gcConnected, attempt.activeGame], [false, true, false, 'tf2']);
	csgo.emit('error', new Error('GC 超时'));
	assert.ok(calls.includes('warn:GC 连接失败: GC 超时'));

	const broken = createGcModuleAttacher({
		GlobalOffensive: class {
			constructor() {
				throw new Error('steam-user 版本不对');
			}
		} as never,
		TeamFortress2: FakeModule,
		events: {addLog: (a, level, message) => void calls.push(`${level}:${message}`), emit() {}},
		inventory: {refreshFromGc() {}}
	});
	const other = {accountName: 'bravo'} as Attempt;
	broken.attach(other, {});
	assert.ok(calls.includes('warn:CS2 GC 初始化失败: steam-user 版本不对'));
	assert.ok(other.tf2, 'TF2 照常挂上');
});
