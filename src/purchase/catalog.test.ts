import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Attempt} from '../steam/session-manager.ts';
import {createPurchaseCatalog} from './catalog.ts';
import type {CatalogItem, CatalogItemBuilder} from './catalog-items.ts';
import {TF2_KEY_FALLBACK_PRICES} from './catalog-items.ts';
import type {RateState} from './rates.ts';
import type {StoreData} from './store-gc.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'price-sheets');

const item = (defIndex: number, name: string, category = '工具'): CatalogItem => ({def_index: defIndex, name, type: category, category, prices: {USD: 100, EUR: 90}});

class FakeClient extends EventEmitter {
	steamID = {getSteamID64: () => '1'};
	played: number[][] = [];
	onPlay: (() => void) | null = null;
	gamesPlayed(apps: number[]) {
		this.played.push(apps);
		if (this.onPlay) {
			setImmediate(this.onPlay);
		}
	}
	webLogOn() {}
}

function makeAttempt(name: string, overrides: Partial<Attempt> = {}): Attempt & {client: FakeClient} {
	return {
		id: `id-${name}`, accountName: name, status: 'web_session', createdAt: 1, client: new FakeClient(), csgo: new EventEmitter(),
		cs2GcConnected: true, activeGame: 'cs2', currency: 1, currencyISO: 'USD', country: 'US', loginGeoCountry: '', logs: [], ...overrides
	} as unknown as Attempt & {client: FakeClient};
}

function setup(t: TestContext, options: {files?: Record<string, unknown>; list?: CatalogItem[]} = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
	t.after(() => rmSync(dir, {recursive: true, force: true}));
	const files = new Map<string, unknown>(Object.entries(options.files ?? {}).map(([name, value]) => [join(dir, name), value]));
	const attempts = new Map<string, Attempt>();
	const queried: string[] = [];
	let rateFetches = 0;
	let list = options.list ?? [item(2, '乙'), item(1, '甲', '钥匙')];
	const rates: RateState = {source: 'test', fetchedAt: '2026-10-13T00:00:00.000Z', fetchedAtMs: Date.now(), base: 'USD', rates: {USD: 1, EUR: 0.9}};
	const items = {
		buildItem: (defIndex: number, prices: Record<string, number>, _entry: unknown, entryName: string) => ({def_index: defIndex, name: entryName, type: '钥匙', category: '钥匙', prices})
	} as unknown as CatalogItemBuilder;
	const catalog = createPurchaseCatalog({
		attempts: () => attempts.values(),
		items,
		gc: {
			async queryUserData(attempt): Promise<StoreData> {
				queried.push(attempt.accountName);
				return {
					source: 'gc', fetchedAt: new Date().toISOString(), account: attempt.accountName, attemptId: attempt.id, game: 'cs2', country: 'US',
					currency: 1, currencyISO: 'USD', balance: 10, priceSheetVersion: 3, list, rawPriceSheet: Buffer.from([0, 1]), parsedPriceSheet: {parsed: {}, source: 'x', sourceBuffer: Buffer.alloc(0)}
				};
			}
		},
		cacheDir: dir,
		priceSheetDir: dir,
		readJson: file => files.get(file) ?? null,
		writeJson: (file, value) => void files.set(file, JSON.parse(JSON.stringify(value))),
		fetchRates: async () => {
			rateFetches++;
			return {...rates, fetchedAtMs: Date.now()};
		},
		gcTimeoutMs: 1000,
		logger: {warn() {}}
	});
	return {
		catalog, attempts, queried, dir, files,
		cache: (game: string) => files.get(join(dir, `${game}.json`)) as Record<string, any> | undefined,
		rateFetches: () => rateFetches,
		setList: (next: CatalogItem[]) => void (list = next)
	};
}

test('CS2 没有缓存:返回空目录并提示刷新', async (t: TestContext) => {
	const {catalog} = setup(t);
	const state = await catalog.ensureLoaded('cs2');
	assert.equal(state.list.length, 0);
	assert.equal(state.needsRefresh, true);
	const response = catalog.response('cs2');
	assert.equal(response.count, 0);
	assert.equal(response.needsRefresh, true);
	assert.equal(response.gameLabel, 'CS2');
});

test('磁盘缓存:启动时预加载,字段归一', async (t: TestContext) => {
	const {catalog, queried} = setup(t, {files: {'cs2.json': {list: [item(1, '名称标签')], currencyISO: 'usd', country: 'us', newIds: ['1', 'x'], rates: {USD: 1}}}});
	catalog.preload();
	const state = await catalog.ensureLoaded('cs2');
	assert.equal(state.list.length, 1);
	assert.equal(state.currencyISO, 'USD');
	assert.equal(state.country, 'US');
	assert.deepEqual(state.newIds, [1]);
	assert.equal(state.source, 'cache');
	assert.equal(catalog.response('cs2').chineseCount, 1);
	assert.deepEqual(queried, []);
});

test('刷新 CS2:没有在线账号报 409', async (t: TestContext) => {
	const {catalog} = setup(t);
	await assert.rejects(catalog.refresh('cs2'), (err: Error & {statusCode?: number}) => err.statusCode === 409 && /没有在线且已连接 GC 的账号/.test(err.message));
});

test('刷新 CS2:用已连 GC 的账号拉目录,排序、标出新商品、写缓存(不含原始价目表)', async (t: TestContext) => {
	const {catalog, attempts, queried, cache, setList} = setup(t);
	attempts.set('a', makeAttempt('alpha'));
	attempts.set('b', makeAttempt('offline', {status: 'logged_out'}));
	const first = await catalog.refresh('cs2', {forceRefresh: true});
	assert.deepEqual(queried, ['alpha']);
	assert.deepEqual(first.list.map(entry => [entry.name, entry.category]), [['乙', '工具'], ['甲', '钥匙']], '工具排在钥匙前');
	assert.deepEqual(first.newIds.sort(), [1, 2]);
	assert.equal(first.priceSheetVersion, 3);
	assert.deepEqual(first.rates, {USD: 1, EUR: 0.9});
	assert.equal(first.changed, true);

	const saved = cache('cs2');
	assert.equal(saved?.list.length, 2);
	assert.equal(saved?.storeData.rawPriceSheet, undefined, '缓存不存原始价目表');
	assert.equal(saved?.storeData.parsedPriceSheet, undefined);
	assert.equal(saved?.storeData.priceSheetVersion, 3);
	assert.ok(first.storeData?.rawPriceSheet, '内存里还在');

	setList([item(1, '甲', '钥匙'), item(3, '丙')]);
	const second = await catalog.refresh('cs2');
	assert.deepEqual(second.newIds, [3]);
});

test('刷新 CS2:没有已连 GC 的账号时,让在线账号进游戏等 GC 连上', async (t: TestContext) => {
	const {catalog, attempts, queried} = setup(t);
	const alpha = makeAttempt('alpha', {cs2GcConnected: false, activeGame: ''});
	alpha.client.onPlay = () => {
		alpha.cs2GcConnected = true;
		(alpha.csgo as EventEmitter).emit('connectedToGC');
	};
	attempts.set('a', alpha);
	await catalog.refresh('cs2');
	assert.deepEqual(alpha.client.played, [[730]]);
	assert.deepEqual(queried, ['alpha']);
});

test('TF2:静态钥匙目录,兜底价打底,价目表留样里的真实价覆盖', async (t: TestContext) => {
	const empty = setup(t);
	const fallback = await empty.catalog.ensureLoaded('tf2');
	assert.equal(fallback.source, 'static');
	assert.equal(fallback.currencyISO, 'UYU');
	assert.deepEqual(fallback.list[0]?.prices, TF2_KEY_FALLBACK_PRICES);
	assert.equal(empty.cache('tf2')?.list.length, 1, '静态目录也写缓存');
	assert.equal((await empty.catalog.refresh('tf2')).source, 'static', '刷新 TF2 也是静态目录');

	const withSheet = setup(t);
	copyFileSync(join(FIXTURES, 'tf2-usd.bkv'), join(withSheet.dir, 'tf2-price-sheet-alpha-US-USD-1-raw-binarykv.bkv'));
	const real = await withSheet.catalog.ensureLoaded('tf2');
	const prices = real.list[0]?.prices ?? {};
	assert.equal(prices.USD, 249);
	assert.ok(Object.keys(prices).length >= Object.keys(TF2_KEY_FALLBACK_PRICES).length);
	assert.ok(Object.entries(prices).some(([iso, value]) => TF2_KEY_FALLBACK_PRICES[iso] !== value), '至少有一个币种用了留样里的价格');
});

test('汇率:6 小时内只拉一次;强制刷新后写进各游戏目录', async (t: TestContext) => {
	const {catalog, rateFetches, cache} = setup(t, {files: {'cs2.json': {list: [item(1, 'x')]}}});
	catalog.preload();
	await catalog.ensureRatesLoaded();
	await catalog.ensureRatesLoaded();
	assert.equal(rateFetches(), 1);
	await catalog.refreshRates({forceRefresh: true});
	assert.equal(rateFetches(), 2);
	assert.deepEqual(catalog.state('cs2')?.rates, {USD: 1, EUR: 0.9});
	assert.equal(cache('cs2')?.ratesSource, 'test');
});

test('下单前用账号查到的价目表更新内存目录(不写盘)', async (t: TestContext) => {
	const {catalog, cache} = setup(t);
	await catalog.ensureLoaded('cs2');
	const alpha = makeAttempt('alpha');
	catalog.adoptStoreData('cs2', alpha, {
		source: 'gc', fetchedAt: 'now', account: 'alpha', attemptId: alpha.id, game: 'cs2', country: 'US', currency: 1, currencyISO: 'USD',
		balance: 1, priceSheetVersion: 9, list: [item(2, '乙', '钥匙'), item(1, '甲')]
	});
	assert.equal(catalog.state('cs2')?.needsRefresh, false);
	assert.equal(catalog.findItem(2, 'cs2')?.name, '乙');
	assert.equal(catalog.findItem(99, 'cs2'), null);
	assert.deepEqual(catalog.response('cs2').list.map(entry => entry.def_index), [1, 2]);
	assert.equal(cache('cs2'), undefined);
});
