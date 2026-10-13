import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodePriceSheet, extractStorePrices, normalizePriceMap, normalizePriceValue} from './price-sheet.ts';
import type {PriceMap} from './price-sheet.ts';

const require = createRequire(import.meta.url);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'price-sheets');

// 快照由重构前 server.js 里的同名函数生成(见 test/fixtures/price-sheets/README.md)
interface Snapshot {
	fixture: string;
	game: string;
	source: string;
	itemCount: number;
	order: number[];
	entryDefIndex: Record<string, number>;
	itemDigests: Record<string, string>;
	spot: Array<{defIndex: number; entryName: string; prices: PriceMap}>;
}

const sortKeys = (prices: PriceMap) => Object.fromEntries(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)));
const digest = (prices: PriceMap) => createHash('sha256').update(JSON.stringify(sortKeys(prices))).digest('hex').slice(0, 16);

for (const game of ['cs2', 'tf2']) {
	test(`${game} 价目表:与重构前的解析结果逐项一致`, async () => {
		const snapshot = JSON.parse(readFileSync(join(FIXTURES, `${game}-usd.expected.json`), 'utf8')) as Snapshot;
		const sheet = await decodePriceSheet(readFileSync(join(FIXTURES, snapshot.fixture)));
		assert.equal(sheet.source, snapshot.source);

		// 条目名 → defIndex 依赖物品 schema,这里直接用旧代码解析出的对应关系
		const items = extractStorePrices(sheet.parsed, name => snapshot.entryDefIndex[name] ?? 0);
		assert.equal(items.length, snapshot.itemCount);
		assert.deepEqual(items.map(item => item.defIndex), snapshot.order, '商品顺序一致');
		const mismatched = items.filter(item => digest(item.prices) !== snapshot.itemDigests[item.defIndex]).map(item => item.defIndex);
		assert.deepEqual(mismatched, [], '每个商品的各币种价格一致');
		for (const spot of snapshot.spot) {
			const item = items.find(candidate => candidate.defIndex === spot.defIndex);
			assert.equal(item?.entryName, spot.entryName);
			assert.deepEqual(sortKeys(item?.prices ?? {}), spot.prices);
		}
	});
}

test('价格值归一:number / string / bigint / protobuf Long / 非法值', () => {
	assert.equal(normalizePriceValue(199.4), 199);
	assert.equal(normalizePriceValue('250'), 250);
	assert.equal(normalizePriceValue(12345678901n), 12345678901);
	assert.equal(normalizePriceValue({low: 199, high: 0, unsigned: true}), 199);
	assert.equal(normalizePriceValue({low: 1, high: 1}), 4294967297);
	assert.equal(normalizePriceValue({toString: () => '77'}), 77);
	for (const bad of [null, undefined, '', 'abc', NaN, Infinity, {}, []]) {
		assert.equal(normalizePriceValue(bad), 0, String(bad));
	}
	assert.deepEqual(normalizePriceMap({usd: 199, eur: 0, '': 5, GBP: '-1', JPY: '300'}), {USD: 199, JPY: 300});
});

test('标准 .lzma 压缩的价目表也能解', async () => {
	const lzma = require('lzma-native') as {createStream(type: string, options: object): NodeJS.ReadWriteStream};
	const raw = readFileSync(join(FIXTURES, 'cs2-usd.bkv'));
	const compressed = await new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		const encoder = lzma.createStream('aloneEncoder', {preset: 6});
		encoder.on('data', (chunk: Buffer) => chunks.push(chunk));
		encoder.on('end', () => resolve(Buffer.concat(chunks)));
		encoder.on('error', reject);
		encoder.end(raw);
	});
	assert.ok(compressed.length < raw.length / 5);
	const sheet = await decodePriceSheet(compressed);
	assert.equal(sheet.source, 'lzma-binarykv');
	assert.ok(sheet.sourceBuffer.equals(raw));
	assert.deepEqual(sheet.parsed, (await decodePriceSheet(raw)).parsed);
});

test('空的或解不出来的价目表报 502', async () => {
	await assert.rejects(decodePriceSheet(Buffer.alloc(0)), (err: Error & {statusCode?: number}) => err.statusCode === 502 && /为空/.test(err.message));
	await assert.rejects(decodePriceSheet(Buffer.from('LZMA' + 'x'.repeat(40))), (err: Error & {statusCode?: number}) => err.statusCode === 502 && /解析失败/.test(err.message));
});

test('只在其它节点里出现的 defIndex 也会收进来;同一 defIndex 只取一次', () => {
	const parsed = {
		store: {
			entries: {
				'Item A': {prices: {USD: 100}},
				'Item A again': {prices: {USD: 999}},
				'Unknown': {prices: {USD: 5}},
				'Tiered': {base_price: 249}
			},
			inventoryvalvegcpricesheet: {249: {USD: 249, EUR: 219}},
			extra: {nested: {def_index: 77, USD: 300, NOT_A_CURRENCY: 1}}
		}
	};
	const ids: Record<string, number> = {'Item A': 1, 'Item A again': 1, 'Tiered': 5021};
	const items = extractStorePrices(parsed, name => ids[name] ?? 0);
	assert.deepEqual(items.map(item => [item.defIndex, item.entryName, item.prices]), [
		[1, 'Item A', {USD: 100}],
		[5021, 'Tiered', {USD: 249, EUR: 219}],
		[77, '', {USD: 300}]
	]);
});
