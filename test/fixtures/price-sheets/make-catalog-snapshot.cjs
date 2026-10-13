'use strict';
// 用【重构前】server.js 里原样的商品名称/分类函数,生成内购目录的回归快照。
// 参数:代码目录 旧版server.js路径 输出json
// 快照内容:
//   - 两份真实价目表样本生成的最终目录(名称/类型/分类/价格摘要,顺序即目录顺序);
//   - TF2 样本在「只留钥匙」过滤之前的全部商品分类;
//   - 两款游戏 schema 里每个物品定义的名称/类型/分类(分块摘要)。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const vm = require('vm');

const [codeArg, legacyServer, outFile] = process.argv.slice(2);
const code = path.resolve(codeArg);
const {describeGcItem, loadItemsGameSchema} = require(path.join(code, 'app', 'items-game-schema.js'));
const {decodePriceSheet, extractStorePrices, normalizePriceMap} = require(path.join(code, 'src', 'steam', 'price-sheet.ts'));
const {normalizeGame, gameConfig} = require(path.join(code, 'src', 'steam', 'games.ts'));
const src = fs.readFileSync(legacyServer, 'utf8');

function grabBlock(marker) {
	const start = src.indexOf('\n' + marker) + 1;
	if (start <= 0) throw new Error('not found: ' + marker);
	return start;
}

function grabFunction(name) {
	const start = grabBlock(`function ${name}(`);
	let i = src.indexOf(') {', start) + 2;
	let depth = 0;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (!depth) break; }
	}
	return src.slice(start, i + 1);
}

// 顶层常量:从 "const NAME =" 到语句结束的分号(括号配平之后)
function grabConst(name) {
	const start = grabBlock(`const ${name} = `);
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (ch === '(' || ch === '{' || ch === '[') depth++;
		else if (ch === ')' || ch === '}' || ch === ']') depth--;
		else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
	}
	throw new Error('unterminated const: ' + name);
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
	grabConst('UYU_TF2_KEY_COST'),
	grabConst('TF2_KEY_PRICE_TIER'),
	grabConst('TF2_MANN_CO_SUPPLY_CRATE_KEY_DEFID'),
	grabConst('TF2_MANN_CO_KEY_FALLBACK_PRICES'),
	grabConst('PURCHASE_CATEGORY_ORDER'),
	grabConst('PURCHASE_CATEGORY_INDEX'),
	...[
		'buildPurchaseCatalogItemsFromParsedSheet', 'filterPurchaseCatalogItemsForGame', 'comparePurchaseCatalogItems',
		'getPurchaseSchema', 'getPurchaseSchemaNameIndex', 'resolveDefIndexFromStoreEntry',
		'buildPurchaseCatalogItemFromDefinition', 'classifyPurchaseCatalogItem', 'classifyTf2PurchaseCatalogItem',
		'mapTf2StoreCategory', 'isTf2KeyItem', 'isTf2TicketItem', 'isTf2BundleItem', 'isTf2WeaponItem', 'isTf2HatItem',
		'isTf2AccessoryItem', 'normalizePurchaseCatalogName', 'isPurchaseMusicKitItem', 'isPurchaseCapsuleItem',
		'isPurchaseTicketItem', 'isPurchaseWeaponItem', 'isPurchaseHatItem', 'isPurchaseBundleItem', 'isPurchaseAccessoryItem'
	].map(grabFunction)
].join('\n\n');

const sandbox = {
	Buffer, Object, Number, String, Array, Map, Set, Math, Error,
	console: {log() {}, warn() {}, error() {}},
	describeGcItem,
	extractStorePrices,
	normalizePriceMap,
	normalizePurchaseGame: normalizeGame,
	getPurchaseGameConfig: gameConfig,
	ITEMS_GAME_SCHEMA,
	TF2_ITEMS_GAME_SCHEMA,
	PURCHASE_SCHEMA_NAME_INDEXES: {cs2: null, tf2: null}
};
vm.createContext(sandbox);
vm.runInContext(legacy + '\nthis.__legacy = {buildPurchaseCatalogItemsFromParsedSheet, buildPurchaseCatalogItemFromDefinition, comparePurchaseCatalogItems, getPurchaseSchema};', sandbox);
const L = sandbox.__legacy;

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const sortKeys = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
const row = item => [item.def_index, item.name, item.type, item.category];
const SWEEP_CHUNK = 250;

function schemaSweep(game) {
	const schema = L.getPurchaseSchema(game);
	const defIndexes = Object.keys(schema.items || {}).map(Number).filter(n => n > 0).sort((a, b) => a - b);
	const rows = defIndexes.map(defIndex => row(L.buildPurchaseCatalogItemFromDefinition(defIndex, {USD: 1}, null, '', game)));
	const chunks = [];
	for (let i = 0; i < rows.length; i += SWEEP_CHUNK) {
		chunks.push(digest(rows.slice(i, i + SWEEP_CHUNK)));
	}
	return {count: rows.length, chunkSize: SWEEP_CHUNK, chunks};
}

(async () => {
	const snapshot = {
		note: '由重构前 server.js 的商品名称/分类函数生成(make-catalog-snapshot),新实现必须逐项一致',
		catalogs: {},
		tf2Unfiltered: [],
		schemaSweep: {}
	};
	for (const game of ['cs2', 'tf2']) {
		const sheet = await decodePriceSheet(fs.readFileSync(path.join(__dirname, `${game}-usd.bkv`)));
		const list = L.buildPurchaseCatalogItemsFromParsedSheet(sheet, 'USD', game);
		snapshot.catalogs[game] = list.map(item => [...row(item), digest(sortKeys(item.prices))]);
		if (game === 'tf2') {
			const root = sheet.parsed;
			const all = extractStorePrices(root, (name, entry) => sandbox.resolveDefIndexFromStoreEntry(name, entry, 'tf2'))
				.map(item => L.buildPurchaseCatalogItemFromDefinition(item.defIndex, item.prices, item.entry, item.entryName, 'tf2'));
			all.sort(L.comparePurchaseCatalogItems);
			snapshot.tf2Unfiltered = all.map(row);
		}
		snapshot.schemaSweep[game] = schemaSweep(game);
	}
	// 每个商品一行,方便看 diff
	const lines = JSON.stringify(snapshot, null, '\t')
		.replace(/\[\n\t+([^\[\]{}]*?)\n\t+\]/g, (_, body) => '[' + body.replace(/\n\t+/g, ' ') + ']');
	fs.writeFileSync(outFile, lines + '\n');
	console.log('cs2 catalog', snapshot.catalogs.cs2.length, 'tf2 catalog', snapshot.catalogs.tf2.length,
		'tf2 unfiltered', snapshot.tf2Unfiltered.length,
		'sweep', snapshot.schemaSweep.cs2.count, snapshot.schemaSweep.tf2.count);
})().catch(err => {
	console.error(err);
	process.exit(1);
});
