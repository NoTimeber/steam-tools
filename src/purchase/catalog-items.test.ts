import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodePriceSheet} from '../steam/price-sheet.ts';
import type {PriceMap} from '../steam/price-sheet.ts';
import {classifyCatalogItem, compareCatalogItems, createCatalogItemBuilder, keepTf2KeyOnly, TF2_KEY_DEF_INDEX, TF2_KEY_FALLBACK_PRICES} from './catalog-items.ts';
import type {CatalogItemBuilder, DescribeGcItem, ItemSchema} from './catalog-items.ts';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'price-sheets');
const SCHEMA_DIR = join(ROOT, 'app', 'schema');

// 快照由重构前 server.js 里的同名函数生成(见 test/fixtures/price-sheets/README.md)
type Row = [number, string, string, string];
interface CatalogSnapshot {
	catalogs: Record<'cs2' | 'tf2', Array<[...Row, string]>>;
	tf2Unfiltered: Row[];
	schemaSweep: Record<'cs2' | 'tf2', {count: number; chunkSize: number; chunks: string[]}>;
}
interface PriceSnapshot {
	entryDefIndex: Record<string, number>;
}

const snapshot = JSON.parse(readFileSync(join(FIXTURES, 'catalog.expected.json'), 'utf8')) as CatalogSnapshot;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const sortKeys = (prices: PriceMap) => Object.fromEntries(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)));
const row = (item: {def_index: number; name: string; type: string; category: string}): Row => [item.def_index, item.name, item.type, item.category];

let builder: CatalogItemBuilder;
let schemas: Record<'cs2' | 'tf2', ItemSchema>;

before(() => {
	const {loadItemsGameSchema, describeGcItem} = require(join(ROOT, 'app', 'items-game-schema.js')) as {
		loadItemsGameSchema(file: string, options: Record<string, string>): ItemSchema;
		describeGcItem: DescribeGcItem;
	};
	const tf2Loc = existsSync(join(SCHEMA_DIR, 'tf2_schinese.txt')) ? 'tf2_schinese.txt' : 'tf2_english.txt';
	schemas = {
		cs2: loadItemsGameSchema(join(SCHEMA_DIR, 'items_game.txt'), {
			localizationFile: join(SCHEMA_DIR, 'csgo_schinese.txt'),
			englishLocalizationFile: join(SCHEMA_DIR, 'csgo_english.txt')
		}),
		tf2: loadItemsGameSchema(join(SCHEMA_DIR, 'tf2_items_game.txt'), {
			localizationFile: join(SCHEMA_DIR, tf2Loc),
			englishLocalizationFile: join(SCHEMA_DIR, 'tf2_english.txt')
		})
	};
	builder = createCatalogItemBuilder({schemas, describeGcItem, logger: {log() {}}});
});

for (const game of ['cs2', 'tf2'] as const) {
	test(`${game} 目录:名称、分类、顺序、价格与重构前一致`, async () => {
		const sheet = await decodePriceSheet(readFileSync(join(FIXTURES, `${game}-usd.bkv`)));
		const list = builder.buildCatalog(sheet, game);
		assert.deepEqual(list.map(item => [...row(item), digest(sortKeys(item.prices))]), snapshot.catalogs[game]);
	});

	test(`${game} 商店条目名 → defIndex 与重构前一致`, async () => {
		const prices = JSON.parse(readFileSync(join(FIXTURES, `${game}-usd.expected.json`), 'utf8')) as PriceSnapshot;
		const sheet = await decodePriceSheet(readFileSync(join(FIXTURES, `${game}-usd.bkv`)));
		const entries = ((sheet.parsed.store ?? sheet.parsed) as {entries: Record<string, Record<string, unknown>>}).entries;
		const resolved = Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, builder.resolveDefIndex(name, entry, game)]));
		assert.deepEqual(resolved, prices.entryDefIndex);
	});

	test(`${game} schema 里每个物品定义的名称和分类与重构前一致`, () => {
		const expected = snapshot.schemaSweep[game];
		const defIndexes = Object.keys(schemas[game].items ?? {}).map(Number).filter(n => n > 0).sort((a, b) => a - b);
		assert.equal(defIndexes.length, expected.count);
		const mismatchedChunks: number[] = [];
		for (let i = 0; i < defIndexes.length; i += expected.chunkSize) {
			const rows = defIndexes.slice(i, i + expected.chunkSize).map(defIndex => row(builder.buildItem(defIndex, {USD: 1}, null, '', game)));
			if (digest(rows) !== expected.chunks[i / expected.chunkSize]) {
				mismatchedChunks.push(i / expected.chunkSize);
			}
		}
		assert.deepEqual(mismatchedChunks, [], '出错的分块(重新生成旧结果对比,见 make-catalog-snapshot.cjs)');
	});
}

test('TF2 价目表里全部商品的分类(只留钥匙之前)与重构前一致', async () => {
	const sheet = await decodePriceSheet(readFileSync(join(FIXTURES, 'tf2-usd.bkv')));
	const {extractStorePrices} = await import('../steam/price-sheet.ts');
	const all = extractStorePrices(sheet.parsed, (name, entry) => builder.resolveDefIndex(name, entry, 'tf2'))
		.map(item => builder.buildItem(item.defIndex, item.prices, item.entry, item.entryName, 'tf2'));
	all.sort(compareCatalogItems);
	assert.deepEqual(all.map(row), snapshot.tf2Unfiltered);
});

test('分类规则:几个典型商品', () => {
	const cs2 = (name: string, definition = {}, defIndex = 1) => classifyCatalogItem({game: 'cs2', defIndex, name, definition}).category;
	assert.equal(cs2('吊称标签', {}, 1200), '工具');
	assert.equal(classifyCatalogItem({game: 'cs2', defIndex: 1200, name: '吊称标签'}).name, '名称标签', '固定中文名');
	assert.equal(cs2('Operation Pass', {name: 'operation ticket'}), '票券');
	assert.equal(cs2('“凤凰大行动”武器箱钥匙'), '钥匙');
	assert.equal(cs2('音乐盒:某某', {}), '音乐盒');
	assert.equal(cs2('2024 印花胶囊'), '胶囊');
	assert.equal(cs2('X 射线 包裹'), '胶囊');
	assert.equal(cs2('印花 | 某某'), '印花');
	assert.equal(cs2('随便什么'), '其他');
	assert.equal(cs2('', {item_name: '#CSGO_Something'}), '其他');
	assert.equal(classifyCatalogItem({game: 'cs2', defIndex: 9, name: '', definition: {item_name: '#Token'}}).name, 'DefIndex 9');

	const tf2 = (name: string, category = '', defIndex = 1) => classifyCatalogItem({game: 'tf2', defIndex, name, category}).category;
	assert.equal(tf2('Mann Co. Supply Crate Key', '', TF2_KEY_DEF_INDEX), '钥匙');
	assert.equal(tf2('Tour of Duty Ticket'), '票券');
	assert.equal(tf2('Something', 'Tools'), '工具');
	assert.equal(tf2('Team Captain'), '帽子', 'cap');
	assert.equal(tf2('Rocket Launcher'), '武器');
	assert.equal(tf2('Some Dance', 'Taunts'), '饰品');
	assert.equal(tf2('Whatever', 'Taunts'), '帽子', '按子串匹配:whatever 里有 hat(旧规则如此)');
	assert.equal(tf2('Nothing'), '其他');
});

test('排序:先按分类顺序,同类按名称', () => {
	const items = [
		{name: 'b', category: '其他'},
		{name: 'z', category: '工具'},
		{name: 'a', category: '未知分类'},
		{name: 'a', category: '工具'},
		{name: 'k', category: '钥匙'}
	];
	assert.deepEqual(items.sort((l, r) => compareCatalogItems({...l, type: ''}, {...r, type: ''})).map(i => i.name + i.category),
		['a工具', 'z工具', 'k钥匙', 'b其他', 'a未知分类']);
});

test('TF2 只留钥匙,缺的币种用兜底价补上,实时价不动', () => {
	const logs: string[] = [];
	const items = keepTf2KeyOnly([
		{def_index: 1, name: 'x', type: '工具', category: '工具', prices: {USD: 1}},
		{def_index: TF2_KEY_DEF_INDEX, name: 'Key', type: '钥匙', category: '钥匙', prices: {EUR: 230}}
	], message => logs.push(message));
	assert.equal(items.length, 1);
	assert.equal(items[0]?.prices.EUR, 230);
	assert.equal(items[0]?.prices.USD, TF2_KEY_FALLBACK_PRICES.USD);
	assert.equal(Object.keys(items[0]?.prices ?? {}).length, Object.keys(TF2_KEY_FALLBACK_PRICES).length);
	assert.equal(logs.length, 1);
	assert.doesNotMatch(logs[0] ?? '', /EUR/);
});
