import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describeGcItem, loadItemsGameSchema} from './schema.ts';
import type {ItemSchema} from './schema.ts';

// 一个小型 items_game.txt:prefab 链、武器、武器箱、涂鸦、印花、稀有度/品质表
const ITEMS_GAME = `"items_game"
{
	"rarities"
	{
		"legendary"
		{
			"value"		"5"
		}
	}
	"qualities"
	{
		"strange"
		{
			"value"		"9"
		}
	}
	"prefabs"
	{
		"weapon_base"
		{
			"item_class"		"weapon_ak47"
			"visuals"
			{
				"weapon_type"		"Rifle"
			}
		}
		"rifle"
		{
			"prefab"		"weapon_base"
			"item_quality"		"unique"
		}
	}
	"items"
	{
		"7"
		{
			"name"		"weapon_ak47"
			"prefab"		"rifle"
		}
		"4001"
		{
			"name"		"crate_community_1"
			"item_name"		"#CSGO_crate_community_1"
			"attributes"
			{
				"set supply crate series"
				{
					"value"		"12"
				}
			}
		}
		"1348"
		{
			"name"		"spray"
		}
	}
	"paint_kits"
	{
		"44"
		{
			"name"		"cu_ak47_cobra"
			"description_tag"		"#PaintKit_cu_ak47_cobra_Tag"
		}
		"282"
		{
			"name"		"cu_ak47_mastery"
			"description_tag"		"#PaintKit_cu_ak47_mastery_Tag"
		}
	}
	"sticker_kits"
	{
		"5"
		{
			"name"		"std_dust"
			"item_name"		"#StickerKit_std_dust"
			"item_rarity"		"rare"
		}
		"9000"
		{
			"name"		"spray_gg"
			"item_rarity"		"common"
		}
	}
}
`;

const LOCALIZATION = `"lang"
{
	"Language"		"schinese"
	"Tokens"
	{
		"PaintKit_cu_ak47_cobra_Tag"		"火蛇"  // 注释不算
		"CSGO_crate_community_1"		"猎杀者武器箱"
		"StickerKit_std_dust"		"沙尘"
	}
}
`;

let schema: ItemSchema;
let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'schema-'));
	writeFileSync(join(dir, 'items_game.txt'), ITEMS_GAME);
	// UTF-16LE + BOM,和 Valve 的本地化文件一样
	writeFileSync(join(dir, 'schinese.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LOCALIZATION, 'utf16le')]));
	schema = loadItemsGameSchema(join(dir, 'items_game.txt'), {localizationFile: join(dir, 'schinese.txt')});
	process.on('exit', () => rmSync(dir, {recursive: true, force: true}));
});

test('加载:只抽需要的顶层段,prefab 链合并;本地化读 UTF-16 的 Tokens 块', () => {
	assert.equal(schema.loaded, true);
	assert.deepEqual(Object.keys(schema.items).sort(), ['1348', '4001', '7']);
	assert.equal(schema.localizedTokens.PaintKit_cu_ak47_cobra_Tag, '火蛇');
	assert.equal(schema.rarityByValue['5']?.key, 'legendary');
	const missing = loadItemsGameSchema(join(dir, 'nope.txt'));
	assert.deepEqual([missing.loaded, missing.error], [false, '']);
});

test('武器皮肤:武器名 | 皮肤中文名;没有本地化时从内部名拼;外观档、模板、贴纸、StatTrak', () => {
	const skin = describeGcItem(schema, {
		def_index: 7, paint_index: 44, paint_wear: 0.2, paint_seed: '661', quality: 9, rarity: 5,
		stickers: [{slot: 0, sticker_id: 5, wear: 0.1}, {sticker_id: null}]
	});
	assert.deepEqual([skin.name, skin.type, skin.category, skin.exterior, skin.quality, skin.rarity, skin.kind], ['AK-47 | 火蛇', '武器皮肤', 'Rifle', '久经沙场 0.20000', 'StatTrak', '保密', 'weapon_skin']);
	assert.equal(skin.marketHashName, 'Rifle / 模板 661 / 贴纸 1');
	assert.deepEqual(skin.stickers.map(s => [s.stickerId, s.displayName, s.rarity]), [[5, '沙尘', '军规级']]);
	assert.equal(describeGcItem(schema, {def_index: 7, paint_index: 282}).name, 'AK-47 | Mastery', '去掉系列前缀和武器名');
	assert.deepEqual([describeGcItem(schema, {def_index: 7}).kind, describeGcItem(schema, {def_index: 7}).quality], ['base_weapon', '独特'], 'prefab 里的品质');
});

test('武器箱、涂鸦、印花、改名、交易冷却;找不到定义时兜底', () => {
	const crate = describeGcItem(schema, {def_index: {toString: () => '4001'}});
	assert.deepEqual([crate.name, crate.type, crate.category, crate.marketHashName], ['猎杀者武器箱', '武器箱', '系列 12', '系列 12']);
	const graffiti = describeGcItem(schema, {def_index: 1348, stickers: [{sticker_id: 9000}]});
	assert.deepEqual([graffiti.name, graffiti.kind, graffiti.rarity, graffiti.marketHashName], ['封印涂鸦 | GG', 'graffiti', '消费级', '喷漆代号 spray_gg']);
	const sticker = describeGcItem(schema, {def_index: 5});
	assert.deepEqual([sticker.name, sticker.kind], ['印花 | 沙尘', 'sticker']);
	const renamed = describeGcItem(schema, {def_index: 7, paint_index: 44, custom_name: ' 我的枪 ', tradable_after: new Date('2030-01-01T00:00:00Z')});
	assert.deepEqual([renamed.name, renamed.marketHashName.split(' / ')[0], renamed.tradableAfter], ['我的枪', 'AK-47 | 火蛇', '2030-01-01T00:00:00.000Z']);
	assert.deepEqual([describeGcItem(schema, {def_index: 999}).name, describeGcItem(schema, {}).name, describeGcItem(null, {def_index: 7}).name], ['DefIndex 999', 'DefIndex -', 'DefIndex 7']);
	assert.equal(describeGcItem(schema, {def_index: 7, tradable_after: 'garbage'}).tradableAfter, '');
});
