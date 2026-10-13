import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBuyOrderLedger} from './ledger.ts';
import type {BuyOrderRecord} from './ledger.ts';
import {createNameIdResolver} from './nameids.ts';
import type {LiveBuyOrder} from './client.ts';

function memoryFiles(initial: Record<string, unknown> = {}) {
	const files = new Map<string, unknown>(Object.entries(initial));
	return {
		files,
		readJson: (file: string) => files.has(file) ? structuredClone(files.get(file)) : null,
		writeJson: (file: string, value: unknown) => void files.set(file, structuredClone(value))
	};
}

const record = (id: string, account: string, buyOrderId: string, extra: Partial<BuyOrderRecord> = {}): BuyOrderRecord => ({
	id, createdAt: '2026-10-01T00:00:00.000Z', account, attemptId: account[0] + '1', steamID: '', appid: 730, marketHashName: 'AK',
	itemName: 'AK', currency: 1, currencyISO: 'USD', pricePerItemCents: 100, quantity: 2, priceTotalCents: 200, buyOrderId,
	status: 'active', ...extra
});
const live = (entries: Record<string, Array<Partial<LiveBuyOrder> & {buyOrderId: string}>>) => new Map(Object.entries(entries).map(([account, orders]) =>
	[account, new Map(orders.map(order => [order.buyOrderId, {priceCents: 100, quantity: 2, quantityRemaining: null, appid: 730, marketHashName: 'AK', ...order}]))]));

test('账本:新记录在前;每次改动立刻写回,不会被别的请求覆盖', () => {
	const fs = memoryFiles();
	const ledger = createBuyOrderLedger({file: 'L', ...fs});
	ledger.add(record('r1', 'alpha', 'B1'));
	// 别处(比如另一个请求)这时往文件里加了一条:下一次改动要在它的基础上改
	fs.files.set('L', [record('x', 'bravo', 'BX'), ...fs.readJson('L') as BuyOrderRecord[]]);
	ledger.add(record('r2', 'alpha', 'B2'));
	assert.deepEqual(ledger.list().map(r => r.id), ['r2', 'x', 'r1']);
	ledger.removeBuyOrder('B1');
	assert.deepEqual(ledger.list().map(r => r.id), ['r2', 'x']);
	assert.equal(ledger.find('x')?.buyOrderId, 'BX');
	assert.equal(ledger.find('r1'), null);
});

test('账本:文件损坏或不是数组时当作空', () => {
	assert.deepEqual(createBuyOrderLedger({file: 'L', ...memoryFiles({L: {broken: true}})}).list(), []);
	assert.deepEqual(createBuyOrderLedger({file: 'L', ...memoryFiles()}).list(), []);
});

test('对账:Steam 上没了的删掉,还在的更新剩余数量并转 active;没拉到的账号不动', () => {
	const fs = memoryFiles({L: [
		record('gone', 'alpha', 'B1'),
		record('kept', 'alpha', 'B2', {status: 'pending_confirm'}),
		record('same', 'alpha', 'B3', {quantityRemaining: 1}),
		record('noid', 'alpha', ''),
		record('offline', 'bravo', 'B9')
	]});
	const ledger = createBuyOrderLedger({file: 'L', ...fs});
	const result = ledger.reconcile(live({alpha: [{buyOrderId: 'B2', quantityRemaining: 2}, {buyOrderId: 'B3', quantityRemaining: 1}]}), Date.parse('2026-10-02'));
	assert.deepEqual(result.orders.map(r => [r.id, r.status, r.quantityRemaining]), [
		['kept', 'active', 2], ['same', 'active', 1], ['offline', 'active', undefined]
	]);
	assert.deepEqual([result.removed, result.updated], [2, 1]);
	assert.deepEqual(ledger.list(), result.orders);
});

test('对账:开始拉取之后才记下的单(Steam 返回里可能还没有)不删;没有时间的老记录照常对账', () => {
	const since = Date.parse('2026-10-02T00:00:00Z');
	const fs = memoryFiles({L: [
		record('fresh', 'alpha', 'B1', {createdAt: '2026-10-02T00:00:01.000Z'}),
		record('legacy', 'alpha', 'B2', {createdAt: undefined as unknown as string})
	]});
	const result = createBuyOrderLedger({file: 'L', ...fs}).reconcile(live({alpha: []}), since);
	assert.deepEqual(result.orders.map(r => r.id), ['fresh']);
	assert.equal(result.removed, 1);
});

test('nameid:手填 → 本地缓存 → 社区库;拿到的记进缓存', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'nameid-'));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	writeFileSync(join(dir, 'CS2.json'), JSON.stringify({'AK-47 | Redline (Field-Tested)': 176096390}));
	const fs = memoryFiles({C: {'730|Cached': '555'}});
	const blocked: string[] = [];
	const resolver = createNameIdResolver({
		cacheFile: 'C', dbDir: dir, ...fs, writeText: () => {},
		fetch: (async (url: string) => {
			blocked.push(String(url));
			throw new TypeError('offline');
		}) as typeof fetch
	});
	assert.equal(await resolver.resolve(730, 'Cached', 'id-12'), '12');
	assert.equal(await resolver.resolve(730, 'Cached'), '555');
	assert.equal(await resolver.resolve(730, 'AK-47 | Redline (Field-Tested)'), '176096390');
	assert.equal(await resolver.resolve(730, 'Unknown'), '');
	assert.equal(await resolver.resolve(570, 'Dota item'), '', '不是 CS2/TF2 不查库');
	assert.deepEqual(blocked, []);

	resolver.remember(730, 'New', 'x99');
	resolver.remember(730, 'Empty', '');
	assert.deepEqual(fs.files.get('C'), {'730|Cached': '555', '730|New': '99'});
});

test('nameid:本地库缺失时下载一次并落盘,并发查询共用这一次', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'nameid-'));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	const downloads: string[] = [];
	const written: string[] = [];
	const resolver = createNameIdResolver({
		cacheFile: 'C', dbDir: dir, ...memoryFiles(), writeText: file => void written.push(file),
		fetch: (async (url: string) => {
			downloads.push(String(url));
			return new Response(JSON.stringify({Key: 1234}));
		}) as typeof fetch
	});
	assert.deepEqual(await Promise.all([resolver.fromDb(440, 'Key'), resolver.fromDb(440, 'Key'), resolver.fromDb(440, 'Other')]), ['1234', '1234', '']);
	assert.deepEqual(downloads, ['https://raw.githubusercontent.com/somespecialone/steam-item-name-ids/main/data/TF2/item_names.json']);
	assert.deepEqual(written, [join(dir, 'TF2.json')]);
});
