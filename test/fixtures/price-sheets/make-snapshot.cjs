'use strict';
// 用【重构前】server.js 里原样的价目表解析函数,在样本上算出结果,存成回归快照。
// 参数:代码目录 旧版server.js路径 样本文件 游戏(cs2|tf2) 输出json
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const vm = require('vm');

const [code, legacyServer, fixture, game, outFile] = process.argv.slice(2);
const req = name => require(path.join(code, 'node_modules', name));
const {describeGcItem, loadItemsGameSchema} = require(path.join(code, 'app', 'items-game-schema.js'));
const src = fs.readFileSync(legacyServer, 'utf8');

function grab(name, kind = 'function') {
	const marker = kind === 'async' ? `async function ${name}(` : kind === 'const' ? `const ${name} = ` : `function ${name}(`;
	const start = src.indexOf('\n' + marker) + 1;
	if (start <= 0) throw new Error('not found: ' + name);
	let i = src.indexOf(kind === 'const' ? '{' : '{', start);
	if (kind !== 'const') {
		// 跳过参数列表里的默认值对象等:从函数体开头的 ") {" 开始数
		i = src.indexOf(') {', start) + 2;
	}
	let depth = 0;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (!depth) break; }
	}
	let end = i + 1;
	if (kind === 'const') end = src.indexOf(';', i) + 1;
	return src.slice(start, end);
}

const schemaDir = path.join(code, 'app', 'schema');
const ITEMS_GAME_SCHEMA = loadItemsGameSchema(path.join(schemaDir, 'items_game.txt'), {
	localizationFile: path.join(schemaDir, 'csgo_schinese.txt'),
	englishLocalizationFile: path.join(schemaDir, 'csgo_english.txt')
});
const tf2Loc = fs.existsSync(path.join(schemaDir, 'tf2_schinese.txt')) ? path.join(schemaDir, 'tf2_schinese.txt') : path.join(schemaDir, 'tf2_english.txt');
const TF2_ITEMS_GAME_SCHEMA = loadItemsGameSchema(path.join(schemaDir, 'tf2_items_game.txt'), {
	localizationFile: tf2Loc,
	englishLocalizationFile: path.join(schemaDir, 'tf2_english.txt')
});

const legacy = [
	grab('CURRENCY_ISO_TO_COUNTRY', 'const'),
	grab('normalizePurchaseGame'),
	grab('getPurchaseSchema'),
	grab('getPurchaseSchemaNameIndex'),
	grab('parseCs2PriceSheet', 'async'),
	grab('buildPurchaseCatalogItemsFromParsedSheet'),
	grab('resolveDefIndexFromStoreEntry'),
	grab('resolvePricesForStoreEntry'),
	grab('collectPriceSheetItemPrices'),
	grab('extractPriceMapFromNode'),
	grab('normalizePriceMap'),
	grab('normalizePriceValue')
].join('\n\n');

// 只把"建商品对象/排序/TF2 只留钥匙"这三步换成记录原始结果,价格与 defIndex 的计算全是旧代码
const sandbox = {
	Buffer, BigInt, Object, Number, String, Array, Map, Set, Math, Error, console,
	lzma: req('lzma-native'),
	BinaryKvParser: req('binarykvparser'),
	describeGcItem,
	ITEMS_GAME_SCHEMA,
	TF2_ITEMS_GAME_SCHEMA,
	PURCHASE_SCHEMA_NAME_INDEXES: {cs2: null, tf2: null},
	buildPurchaseCatalogItemFromDefinition: (defIndex, prices, entry, entryName) => ({defIndex, prices, entryName}),
	comparePurchaseCatalogItems: () => 0,
	filterPurchaseCatalogItemsForGame: items => items
};
vm.createContext(sandbox);
vm.runInContext(legacy + '\nthis.__legacy = {parseCs2PriceSheet, buildPurchaseCatalogItemsFromParsedSheet, resolveDefIndexFromStoreEntry, CURRENCY_ISO_TO_COUNTRY};', sandbox);
const L = sandbox.__legacy;

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const sortKeys = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

(async () => {
	const raw = fs.readFileSync(fixture);
	const sheet = await L.parseCs2PriceSheet({price_sheet: raw});
	const items = L.buildPurchaseCatalogItemsFromParsedSheet(sheet, 'USD', game);
	const root = sheet.parsed.store || sheet.parsed;
	const entryDefIndex = {};
	for (const [name, entry] of Object.entries(root.entries || {})) {
		entryDefIndex[name] = L.resolveDefIndexFromStoreEntry(name, entry, game);
	}
	const itemDigests = {};
	for (const item of items) {
		itemDigests[item.defIndex] = digest(sortKeys(item.prices));
	}
	const spot = items.slice(0, 3).concat(items.slice(-2)).map(item => ({defIndex: item.defIndex, entryName: item.entryName, prices: sortKeys(item.prices)}));
	const snapshot = {
		note: '由重构前 server.js 的价目表解析函数生成(make-snapshot),新实现必须逐项一致',
		fixture: path.basename(fixture),
		game,
		source: sheet.source,
		itemCount: items.length,
		order: items.map(item => item.defIndex),
		entryDefIndex,
		itemDigests,
		spot
	};
	fs.writeFileSync(outFile, JSON.stringify(snapshot, null, '\t') + '\n');
	console.log(game, 'source', sheet.source, 'items', items.length, 'entries', Object.keys(entryDefIndex).length,
		'unresolved', Object.values(entryDefIndex).filter(v => !v).length);
})().catch(err => {
	console.error(err);
	process.exit(1);
});
