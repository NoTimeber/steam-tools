import {test} from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Attempt} from '../steam/session-manager.ts';
import {createOfferHistory} from './history.ts';
import {createTerminalService} from './index.ts';
import {CMsgOpenCrate, CSOVolatileItemOffer, decodeEconItem, GcProtos, peekEconItemId, readExpiration, readPicksUsed, structInts, walkProto} from './protocol.ts';
import {buildSkinMap, createSkinDb, enrichTerminalOffer} from './skins.ts';
import type {EnrichedOffer} from './skins.ts';
import {createCs2Terminal} from './terminal.ts';

const TERM = '52603299338';
const u32 = (n: number) => {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n);
	return b;
};
const f32 = (n: number) => {
	const b = Buffer.alloc(4);
	b.writeFloatLE(n);
	return b;
};

/** 终端机里的报价皮肤(CSOEconItem):外观、casket_id(272/273)、价格(316) */
function casketSkin(id: string, casket: string, price: number): Buffer {
	const big = BigInt(casket);
	return Buffer.from(GcProtos.CSOEconItem!.encode({
		id, account_id: 1, inventory: 0, def_index: 32, quantity: 1, level: 1, quality: 4, flags: 0, origin: 0, rarity: 5,
		attribute: [
			{def_index: 6, value_bytes: f32(123)}, {def_index: 7, value_bytes: f32(88.7)}, {def_index: 8, value_bytes: f32(0.25)},
			{def_index: 272, value_bytes: u32(Number(big & 0xffffffffn))}, {def_index: 273, value_bytes: u32(Number(big >> 32n))},
			{def_index: 316, value_bytes: u32(price)}
		]
	}).finish());
}

test('协议:CSOEconItem 的外观、casket_id、价格都从 value_bytes 小端读;只读 id 不整体解码', () => {
	const data = casketSkin('900', TERM, 43);
	assert.equal(peekEconItemId(data), '900');
	const item = decodeEconItem(data);
	assert.deepEqual([item?.id, item?.def_index, item?.paint, item?.casketId, item?.priceCents], ['900', 32, {paintindex: 123, seed: 88, wear: f32(0.25).readFloatLE(0)}, TERM, 43]);
	assert.match(item?.attrStr ?? '', /316=43/);
	assert.equal(decodeEconItem(Buffer.from([0x08, 0x80])), null, '截断的包');
	assert.equal(peekEconItemId(Buffer.from([0x10, 1])), null, '第一个字段不是 id 就不认');
});

test('协议:无 schema 的 protobuf 顶层字段、结构体回包拆小端整数', () => {
	assert.deepEqual(walkProto(Buffer.from([0x08, 0x05, 0x12, 0x02, 0xaa, 0xbb, 0x1d, 0, 0, 0, 0])), [{field: 1, v: '5'}, {field: 2, v: 'bytes[2]'}, {field: 3, v: 'f32'}]);
	assert.deepEqual(structInts(Buffer.from([5, 0, 0, 0, 1, 0])), {u8: [5, 0, 0, 0, 1, 0], u16: [5, 0, 1], u32: [5]});
});

test('协议:终端机属性——attr169 已开次数、attr183 到期时间(秒 → 毫秒)', () => {
	const term = {attribute: [{def_index: 169, value_bytes: u32(2)}, {def_index: 183, value_bytes: u32(1790000000)}]};
	assert.equal(readPicksUsed(term), 2);
	assert.equal(readExpiration(term), 1790000000000);
	assert.equal(readPicksUsed({attribute: [{def_index: 169, value: 3}]}), 3);
	assert.equal(readPicksUsed({}), null);
	assert.equal(readExpiration(null), null);
});

// ===== 抓包与动作 =====

function fakeAttempt(inventory: unknown[] = []) {
	const sent: Array<{msgType: number; header: unknown; payload: Buffer}> = [];
	const client = Object.assign(new EventEmitter(), {
		steamID: {getSteamID64: () => '76561190100005555'},
		sendToGC: (appid: number, msgType: number, header: unknown, payload: Uint8Array) => void sent.push({msgType, header, payload: Buffer.from(payload)})
	});
	const csgo = Object.assign(new EventEmitter(), {inventory, haveGCSession: true});
	const attempt = {accountName: 'alpha', cs2GcConnected: true, client, csgo} as unknown as Attempt;
	return {attempt, client, csgo, sent};
}

function terminal() {
	let clock = Date.parse('2026-10-13T00:00:00Z');
	const logs: string[] = [];
	const sleeps: number[] = [];
	const t = createCs2Terminal({
		log: (level, message) => void logs.push(`${level}:${message}`),
		now: () => clock,
		sleep: async ms => {
			sleeps.push(ms);
			clock += ms;
		},
		setTimer: () => {}
	});
	return {t, logs, sleeps};
}

const welcome = (objects: Array<{type_id: number; object_data: Buffer[]}>) => Buffer.from(GcProtos.CMsgClientWelcome!.encode({version: 1, outofdate_subscribed_caches: [{objects}]}).finish());
const offer = (defidx: number, faux: string[]) => Buffer.from(CSOVolatileItemOffer.encode({defidx, faux_itemid: faux, generation_time: faux.map(() => 1700000000)}).finish());

test('抓包:欢迎消息里的报价对象(type 20)和终端机里的报价皮肤(faux 命中)都记下;非 CS2 的包不管', () => {
	const {t, logs} = terminal();
	const {attempt, client} = fakeAttempt([{id: TERM, def_index: 5176, origin: 8, attribute: [{def_index: 169, value_bytes: u32(1)}]}]);
	t.attach(attempt);
	t.attach(attempt);
	assert.equal(client.listenerCount('receivedFromGC'), 1, '幂等');
	const faux = '9223372036854775901';
	client.emit('receivedFromGC', 730, 4004, welcome([{type_id: 1, object_data: [casketSkin(faux, TERM, 43)]}, {type_id: 20, object_data: [offer(5176, [faux])]}]));
	client.emit('receivedFromGC', 440, 4004, welcome([{type_id: 20, object_data: [offer(5181, ['1'])]}]));
	const state = t.getState(attempt);
	assert.deepEqual(state.offers.map(o => [o.defidx, o.fauxItemIds]), [[5176, [faux]]]);
	assert.deepEqual(state.injectedSkins.map(s => [s.id, s.faux, s.priceCents, s.casketId]), [[faux, true, 43, TERM]]);
	assert.deepEqual(state.soTypeIds, [{type_id: 1, count: 1}, {type_id: 20, count: 1}]);
	const [term] = state.terminals;
	assert.deepEqual([term?.sealed, term?.picksUsed, term?.picksLeft, term?.offer?.priceCents, term?.offer?.paintindex], [false, 1, 4, 43, 123]);
	assert.ok(logs.some(l => l.includes('★ 捕获报价 defidx=5176')));
});

test('抓包:SO Create 增量里 casket 指向终端机的皮肤算报价;ItemCustomizationNotification 记下;1008 结构体回包打日志', () => {
	const {t, logs} = terminal();
	const {attempt, client} = fakeAttempt();
	t.attach(attempt);
	client.emit('receivedFromGC', 730, 21, Buffer.from(GcProtos.CMsgSOSingleObject!.encode({type_id: 1, object_data: casketSkin('901', TERM, 77)}).finish()));
	client.emit('receivedFromGC', 730, 1090, Buffer.from(GcProtos.CMsgGCItemCustomizationNotification!.encode({item_id: [TERM], request: 1007}).finish()));
	client.emit('receivedFromGC', 730, 1008, Buffer.from([5, 0, 0, 0, 0, 0]));
	const state = t.getState(attempt);
	assert.deepEqual(state.injectedSkins.map(s => [s.id, s.faux, s.priceCents]), [['901', false, 77]]);
	assert.deepEqual(state.notifications.map(n => [n.request, n.itemIds]), [[1007, [TERM]]]);
	assert.ok(logs.some(l => l.includes('★解封响应(结构体 6B) 疑似result=5(NoMatch)')));
	t.clear(attempt);
	assert.deepEqual([t.getState(attempt).injectedSkins.length, t.getState(attempt).notifications.length], [0, 0]);
});

test('解封:用 GC 当前 id(社区 assetid 常是 original_id);默认不带 for_rental、上限 0;找不到终端机报错', () => {
	const {t} = terminal();
	const {attempt, sent} = fakeAttempt([{id: TERM, original_id: '111', def_index: 5176, origin: 24}]);
	const result = t.unseal(attempt, '111');
	assert.deepEqual([result.itemId, result.msgNum, result.msg], [TERM, 2534, 'OpenCrate/pb(2534,limit=0)']);
	assert.deepEqual(CMsgOpenCrate.decode(sent[0]!.payload), CMsgOpenCrate.decode(CMsgOpenCrate.encode({subject_item_id: TERM, volatile_limit: 0}).finish()));
	assert.throws(() => t.unseal(attempt, 'abc'), /无效的物品 id/);
	const two = fakeAttempt([{id: '1', def_index: 5176}, {id: '2', def_index: 5181}]);
	assert.throws(() => t.unseal(two.attempt, '3'), /GC 库存里没有 id\/original_id=3 的终端机/, '多个终端机又对不上时绝不乱开');
	(attempt as {cs2GcConnected: boolean}).cs2GcConnected = false;
	assert.throws(() => t.unseal(attempt, TERM), /未连接 CS2 GC/);
});

test('读报价只发只读的加载消息,绝不发 2534;推进才发 2534 并带已开次数', async () => {
	const {t, sleeps} = terminal();
	const {attempt, sent} = fakeAttempt([{id: TERM, def_index: 5176, origin: 8, attribute: [{def_index: 169, value_bytes: u32(2)}]}]);
	const read = await t.readOffers(attempt, TERM);
	assert.deepEqual([read.count, read.consumed], [0, false]);
	assert.deepEqual(sent.map(s => s.msgType), [1094, 2536]);
	assert.deepEqual(sleeps, [2200, 2200]);

	sent.length = 0;
	const advanced = await t.advanceOffer(attempt, TERM);
	assert.deepEqual([advanced.pointsRemaining, advanced.consumed], [2, true]);
	assert.deepEqual(sent.map(s => s.msgType), [2534, 1094]);
	const body = CMsgOpenCrate.decode(sent[0]!.payload);
	assert.deepEqual([String(body.tool_item_id), String(body.subject_item_id), body.points_remaining], [TERM, TERM, 2]);

	const sealed = fakeAttempt([{id: TERM, def_index: 5176, origin: 24}]);
	await assert.rejects(t.advanceOffer(sealed.attempt, TERM), /请先解封/);
	await assert.rejects(t.readOffers(attempt, ''), /未提供终端机 GC id/);
});

test('拉报价:超长的 itemId(多个 id 拼在一起)忽略,只发订阅不发加载', () => {
	const {t, logs} = terminal();
	const {attempt, sent} = fakeAttempt();
	assert.deepEqual(t.requestOffers(attempt, {itemId: '123456789012345678901234', defidx: 5176}), {sent: true, defidx: 5176, itemId: null});
	assert.deepEqual(sent.map(s => s.msgType), [9195, 9228]);
	assert.ok(logs.some(l => l.startsWith('warn:[terminal] ⚠ itemId 非法(24 位')));
	sent.length = 0;
	t.requestOffers(attempt, {itemId: TERM});
	assert.deepEqual(sent.map(s => s.msgType), [9195, 9228, 2536]);
});

test('协议探针:有变动就停;状态:有倒计时或已开次数的也算已解封', async () => {
	const {t} = terminal();
	const {attempt, client, sent} = fakeAttempt([{id: TERM, def_index: 5176, origin: 24}, {id: '2', def_index: 5181, origin: 0, attribute: [{def_index: 183, value_bytes: u32(1790000000)}]}]);
	t.attach(attempt);
	// 第二个候选发出后 GC 回一个 SO Destroy
	const original = client.sendToGC;
	client.sendToGC = (appid, msgType, header, payload) => {
		original(appid, msgType, header, payload);
		if (sent.length === 2) {
			client.emit('receivedFromGC', 730, 23, Buffer.from(GcProtos.CMsgSOSingleObject!.encode({type_id: 1}).finish()));
		}
	};
	const result = await t.probe(attempt, {gcItemId: TERM});
	assert.equal(result.hit?.label, 'opencrate/2534 norental+lim0');
	assert.equal(result.results.length, 2);
	const terminals = t.getState(attempt).terminals;
	assert.deepEqual(terminals.map(x => [x.id, x.sealed]), [[TERM, true], ['2', false]]);
});

// ===== 皮肤库、报价补全、历史 =====

test('皮肤库:运行时缓存 → 随包副本 → 联网;拿到本地副本后后台刷新一次', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'skins-'));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	const bundled = join(dir, 'bundled.json');
	writeFileSync(bundled, JSON.stringify({map: {'7_44': {name: '随包火蛇', image: 'b', rarity: ''}}}));
	const writes: unknown[] = [];
	let fetches = 0;
	const db = createSkinDb({
		cacheFile: join(dir, 'cache.json'), bundledFile: bundled, writeJson: (file, value) => void writes.push(value),
		fetch: (async () => {
			fetches++;
			return new Response(JSON.stringify([{weapon: {weapon_id: 7}, paint_index: 44, name: '火蛇', image: 'i', rarity: {name: '隐秘'}}]));
		}) as typeof fetch,
		logger: {warn() {}}
	});
	await db.ensure();
	assert.equal(db.resolve(7, 44)?.name, '随包火蛇');
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(fetches, 1);
	assert.equal(db.resolve('7', '44')?.name, '火蛇', '后台刷新后换成最新的');
	assert.equal((writes[0] as {map: Record<string, unknown>}).map['7_44'] !== undefined, true);
	await db.ensure();
	assert.equal(fetches, 1, '只刷新一次');
});

test('报价补全:皮肤库给中文名/图片/品质,本地 schema 给外观档(去掉尾部磨损值);都没有用 def/paint 兜底', () => {
	const skins = {resolve: (def: unknown, paint: unknown) => (Number(def) === 7 && Number(paint) === 44 ? {name: '火蛇', image: 'img', rarity: '隐秘'} : null)};
	const describe = (item: Record<string, unknown>) => ({name: 'Local', rarity: '保密', exterior: '久经沙场 0.250'});
	assert.deepEqual(enrichTerminalOffer({defindex: 7, paintindex: 44, paintwear: 0.25, priceCents: 43}, describe, skins), {
		defindex: 7, paintindex: 44, paintwear: 0.25, priceCents: 43, name: '火蛇', exterior: '久经沙场', rarity: '隐秘', wear: 0.25, priceText: '$0.43', image: 'img'
	});
	const fallback = enrichTerminalOffer({defindex: 9, paintindex: 3}, () => {
		throw new Error('schema 坏了');
	}, skins) as EnrichedOffer;
	assert.deepEqual([fallback?.name, fallback?.priceText, fallback?.wear], ['def9 · paint3', '', null]);
	assert.equal(enrichTerminalOffer(null, describe, skins), null);
	assert.deepEqual(buildSkinMap([{weapon: {weapon_id: 7}, paint_index: '44', name: 'x'}, {weapon: {}}, null]), {'7_44': {name: 'x', image: '', rarity: ''}});
});

test('报价历史:追加、和上一条同 itemid 不重复记、最多 30 条', () => {
	const files = new Map<string, unknown>();
	const history = createOfferHistory({file: 'H', readJson: f => files.get(f) ?? null, writeJson: (f, v) => void files.set(f, structuredClone(v)), now: () => 0});
	history.append(TERM, 5176, {itemid: '1'});
	history.append(TERM, 5176, {itemid: '1'});
	assert.deepEqual(history.get(TERM).map(o => o.itemid), ['1']);
	for (let i = 2; i <= 35; i++) {
		history.append(TERM, 5176, {itemid: String(i)});
	}
	const offers = history.get(TERM);
	assert.deepEqual([offers.length, offers[0]?.itemid, offers.at(-1)?.revealedAt], [30, '6', '1970-01-01T00:00:00.000Z']);
	assert.deepEqual(history.append('', 1, {itemid: 'x'}), []);
});

test('服务:找不到账号 404,动作出错 400;推进后补全报价并记历史;状态页配社区名字', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'term-svc-'));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	const {attempt} = fakeAttempt([{id: TERM, def_index: 5176, origin: 24}]);
	const files = new Map<string, unknown>();
	const logs: string[] = [];
	const service = createTerminalService({
		findAttempt: key => (key === 'a1' ? attempt : null),
		addLog: (a, level, message) => void logs.push(message),
		inventory: {get: async () => ({source: 'community', items: [{assetid: TERM, name: '封装的创世终端机', iconUrl: 'icon'}]})},
		describeGcItem: () => ({name: 'Local', exterior: ''}),
		historyFile: 'H', skinCacheFile: join(dir, 'c.json'), skinBundledFile: join(dir, 'b.json'),
		readJson: f => files.get(f) ?? null, writeJson: (f, v) => void files.set(f, v), writeCompactJson: () => {},
		fetch: (async () => new Response('[]')) as typeof fetch,
		terminal: {
			...createCs2Terminal({sleep: async () => {}}),
			advanceOffer: async () => ({ok: true, terminalId: TERM, pointsRemaining: 1, count: 1, skins: [{itemid: '9', defindex: 7, paintindex: 44, paintwear: 0.1, paintseed: 1, rarity: 4, priceCents: 43, attrStr: ''}], fresh: [], consumed: true})
		} as never,
		logger: {log() {}, warn() {}}
	});
	await assert.rejects(service.unseal({accountId: 'ghost'}), (err: Error & {statusCode?: number}) => err.statusCode === 404 && err.message === '账号不存在或未登录(用 id 或账号名指定)');
	await assert.rejects(service.unseal({accountId: 'a1', assetid: 'x'}), (err: Error & {statusCode?: number}) => err.statusCode === 400 && err.message === '无效的物品 id');
	const advanced = await service.advanceOffer({accountId: 'a1', gcItemId: TERM});
	assert.deepEqual([advanced.skins[0].name, advanced.skins[0].priceText, advanced.history.length], ['Local', '$0.43', 1]);
	assert.ok(logs.includes(`[终端机] 推进到下一个报价(不可逆·消耗1次)终端机 ${TERM}`));
	const state = await service.state({account: 'a1'});
	assert.deepEqual(state.terminals.map((x: {name: string; image: string; sealed: boolean; history: unknown[]}) => [x.name, x.image, x.sealed, x.history.length]), [['封装的创世终端机', 'icon', true, 1]]);
	await assert.rejects(service.state({}), (err: Error & {statusCode?: number}) => err.statusCode === 404);
});
