'use strict';

const fs = require('fs');
const path = require('path');
const {parse} = require('kvparser');

const RARITY_LABELS = {
	default: '默认',
	common: '消费级',
	uncommon: '工业级',
	rare: '军规级',
	mythical: '受限',
	legendary: '保密',
	ancient: '隐秘',
	immortal: '违禁',
	unusual: '非凡'
};

const QUALITY_LABELS = {
	normal: '普通',
	genuine: '纯正',
	vintage: '复古',
	unusual: '非凡',
	unique: '独特',
	community: '社区',
	developer: '开发者',
	selfmade: '自制',
	customized: '已命名',
	strange: 'StatTrak',
	completed: '已完成',
	haunted: '闹鬼',
	tournament: '纪念品'
};

const WEAPON_NAME_MAP = {
	weapon_ak47: 'AK-47',
	weapon_aug: 'AUG',
	weapon_awp: 'AWP',
	weapon_bizon: 'PP-Bizon',
	weapon_cz75a: 'CZ75-Auto',
	weapon_deagle: 'Desert Eagle',
	weapon_elite: 'Dual Berettas',
	weapon_famas: 'FAMAS',
	weapon_fiveseven: 'Five-SeveN',
	weapon_g3sg1: 'G3SG1',
	weapon_galilar: 'Galil AR',
	weapon_glock: 'Glock-18',
	weapon_hkp2000: 'P2000',
	weapon_m249: 'M249',
	weapon_m4a1: 'M4A4',
	weapon_m4a1_silencer: 'M4A1-S',
	weapon_mac10: 'MAC-10',
	weapon_mag7: 'MAG-7',
	weapon_mp5sd: 'MP5-SD',
	weapon_mp7: 'MP7',
	weapon_mp9: 'MP9',
	weapon_nova: 'Nova',
	weapon_p90: 'P90',
	weapon_p250: 'P250',
	weapon_revolver: 'R8 Revolver',
	weapon_sawedoff: 'Sawed-Off',
	weapon_scar20: 'SCAR-20',
	weapon_sg556: 'SG 553',
	weapon_ssg08: 'SSG 08',
	weapon_tec9: 'Tec-9',
	weapon_ump45: 'UMP-45',
	weapon_usp_silencer: 'USP-S',
	weapon_xm1014: 'XM1014',
	weapon_hegrenade: 'HE Grenade',
	weapon_flashbang: 'Flashbang',
	weapon_smokegrenade: 'Smoke Grenade',
	weapon_molotov: 'Molotov',
	weapon_incgrenade: 'Incendiary Grenade',
	weapon_decoy: 'Decoy Grenade',
	weapon_tagrenade: 'Tactical Awareness Grenade',
	weapon_knife: 'Knife',
	weapon_knife_t: 'Knife',
	weapon_bayonet: 'Bayonet',
	weapon_knife_m9_bayonet: 'M9 Bayonet',
	weapon_karambit: 'Karambit',
	weapon_knife_survival_bowie: 'Bowie Knife',
	weapon_knife_butterfly: 'Butterfly Knife',
	weapon_knife_falchion: 'Falchion Knife',
	weapon_knife_push: 'Shadow Daggers',
	weapon_knife_ursus: 'Ursus Knife',
	weapon_knife_gypsy_jackknife: 'Navaja Knife',
	weapon_knife_stiletto: 'Stiletto Knife',
	weapon_knife_widowmaker: 'Talon Knife',
	weapon_knife_canis: 'Classic Knife',
	weapon_knife_cord: 'Paracord Knife',
	weapon_knife_skeleton: 'Skeleton Knife',
	weapon_knife_outdoor: 'Nomad Knife',
	weapon_knife_css: 'Classic Knife',
	weapon_knife_kukri: 'Kukri Knife',
	weapon_taser: 'Zeus x27'
};

const TOKEN_NAME_MAP = {
	ak47: 'AK-47',
	awp: 'AWP',
	cz75a: 'CZ75-Auto',
	deagle: 'Desert Eagle',
	elite: 'Dual Berettas',
	fiveseven: 'Five-SeveN',
	g3sg1: 'G3SG1',
	galilar: 'Galil AR',
	glock: 'Glock-18',
	hkp2000: 'P2000',
	m249: 'M249',
	m4a1: 'M4A4',
	m4a1_silencer: 'M4A1-S',
	mac10: 'MAC-10',
	mag7: 'MAG-7',
	mp5sd: 'MP5-SD',
	p90: 'P90',
	p250: 'P250',
	scar20: 'SCAR-20',
	sg556: 'SG 553',
	ssg08: 'SSG 08',
	tec9: 'Tec-9',
	ump45: 'UMP-45',
	usp_silencer: 'USP-S',
	xm1014: 'XM1014',
	xray: 'X-Ray',
	rip: 'RIP',
	csgo: 'CSGO',
	cs2: 'CS2'
};

const PAINT_PREFIXES = [
	'aa_',
	'ae_',
	'am_',
	'an_',
	'aq_',
	'cu_',
	'gs_',
	'hy_',
	'hye_',
	'op_',
	'pa_',
	'pe_',
	're_',
	'se_',
	'so_',
	'sp_',
	'spr_',
	'sv_',
	'tr_',
	'wi_'
];

function loadItemsGameSchema(filePath, options = {}) {
	const empty = createEmptySchema(filePath);
	if (!filePath || !fs.existsSync(filePath)) {
		return empty;
	}

	try {
		const text = fs.readFileSync(filePath, 'utf8');
		return buildSchema(text, filePath, options);
	} catch (err) {
		return createEmptySchema(filePath, err && err.message ? err.message : String(err));
	}
}

function describeGcItem(schema, item) {
	const safeSchema = schema && schema.loaded ? schema : createEmptySchema('');
	const defIndex = toFiniteNumber(item && item.def_index);
	const definition = resolveItemDefinition(safeSchema, defIndex);
	const paintIndex = toFiniteNumber(item && item.paint_index);
	const paintKit = paintIndex == null ? null : safeSchema.paintKits[String(paintIndex)] || null;
	const isGraffiti = isGraffitiDefinition(definition);
	const sprayKitId = isGraffiti ? extractSprayKitId(item) : null;
	const sprayKit = sprayKitId == null ? null : safeSchema.stickerKits[String(sprayKitId)] || null;
	const directStickerKit = !definition && defIndex != null ? (safeSchema.stickerKits[String(defIndex)] || null) : null;
	const stickers = isGraffiti ? [] : resolveAppliedStickers(safeSchema, item && item.stickers);
	const kind = resolveKind(definition, paintKit, sprayKit, directStickerKit);
	const kindLabel = kindToLabel(kind, definition);
	const definitionDisplayName = getDefinitionDisplayName(safeSchema, definition);
	const containerMarketName = getContainerMarketName(safeSchema, kind, defIndex, definition);
	const paintDisplayName = getPaintKitDisplayName(safeSchema, paintKit, definition);
	const sprayDisplayName = getStickerKitDisplayName(safeSchema, sprayKit);
	const directStickerDisplayName = getStickerKitDisplayName(safeSchema, directStickerKit);
	const baseDisplayName = buildBaseDisplayName({
		defIndex,
		definition,
		containerMarketName,
		definitionDisplayName,
		paintKit,
		paintDisplayName,
		sprayKit,
		sprayDisplayName,
		directStickerKit,
		directStickerDisplayName
	});
	const customName = cleanString(item && item.custom_name);
	const name = customName || baseDisplayName || `DefIndex ${defIndex == null ? '-' : defIndex}`;
	const category = resolveCategory(safeSchema, definition, kind);
	const quality = resolveQualityLabel(safeSchema, item, definition);
	const rarity = resolveRarityLabel(safeSchema, item, definition, sprayKit);
	const exterior = formatExterior(item && item.paint_wear);
	const tradableAfter = toIsoDate(item && item.tradable_after);
	const marketHashName = buildSubtitle({
		customName,
		baseDisplayName,
		category,
		kind,
		definition,
		item,
		quality,
		sprayKit,
		directStickerKit,
		stickers
	});

	return {
		name,
		marketHashName,
		type: kindLabel,
		category,
		rarity,
		exterior,
		iconUrl: '',
		quality,
		kind,
		definitionIndex: defIndex,
		definitionInternalName: definition && definition.name ? definition.name : '',
		definitionDisplayName,
		paintKit: paintKit ? {
			index: paintIndex,
			internalName: cleanString(paintKit.name),
			displayName: paintDisplayName,
			descriptionTag: cleanString(paintKit.description_tag),
			descriptionString: cleanString(paintKit.description_string),
			wearMin: toFiniteNumber(paintKit.wear_remap_min),
			wearMax: toFiniteNumber(paintKit.wear_remap_max)
		} : null,
		sprayKit: sprayKit ? {
			id: sprayKitId,
			internalName: cleanString(sprayKit.name),
			displayName: sprayDisplayName,
			rarity: rarityLabelFromKey(cleanString(sprayKit.item_rarity))
		} : null,
		stickers,
		tradableAfter
	};
}

module.exports = {
	describeGcItem,
	loadItemsGameSchema
};

function createEmptySchema(filePath, error = '') {
	return {
		filePath: filePath || '',
		loaded: false,
		error,
		items: Object.create(null),
		prefabs: Object.create(null),
		paintKits: Object.create(null),
		stickerKits: Object.create(null),
		containerMarketNames: Object.create(null),
		localizedTokens: Object.create(null),
		englishTokens: Object.create(null),
		englishValueToToken: Object.create(null),
		rarityByValue: Object.create(null),
		qualityByValue: Object.create(null),
		resolvedItems: Object.create(null)
	};
}

function buildSchema(text, filePath, options = {}) {
	const localizedTokens = loadLocalizationTokens(options.localizationFile);
	const englishTokens = loadLocalizationTokens(options.englishLocalizationFile);
	const schema = {
		filePath,
		loaded: true,
		error: '',
		prefabs: mergeNamedSections(text, 'prefabs'),
		items: mergeNamedSections(text, 'items'),
		paintKits: mergeNamedSections(text, 'paint_kits'),
		stickerKits: mergeNamedSections(text, 'sticker_kits'),
		containerMarketNames: loadContainerMarketNames(filePath),
		localizedTokens,
		englishTokens,
		englishValueToToken: buildEnglishValueIndex(englishTokens),
		rarityByValue: buildValueIndex(mergeNamedSections(text, 'rarities')),
		qualityByValue: buildValueIndex(mergeNamedSections(text, 'qualities')),
		resolvedItems: Object.create(null)
	};

	return schema;
}

function mergeNamedSections(text, sectionName) {
	const output = Object.create(null);
	for (const block of extractTopLevelSectionBlocks(text, sectionName)) {
		const parsed = parse(block);
		const section = parsed && parsed[sectionName] && typeof parsed[sectionName] === 'object'
			? parsed[sectionName]
			: null;
		if (section) {
			Object.assign(output, section);
		}
	}
	return output;
}

function extractTopLevelSectionBlocks(text, sectionName) {
	const marker = `\n\t"${sectionName}"\n\t{`;
	const blocks = [];
	let startFrom = 0;

	while (true) {
		const markerIndex = text.indexOf(marker, startFrom);
		if (markerIndex < 0) {
			break;
		}

		const keyStart = markerIndex + 1;
		const braceStart = text.indexOf('{', keyStart);
		if (braceStart < 0) {
			break;
		}

		let depth = 0;
		let inString = false;
		let escaped = false;
		let endIndex = -1;

		for (let index = braceStart; index < text.length; index++) {
			const char = text[index];

			if (inString) {
				if (escaped) {
					escaped = false;
				} else if (char === '\\') {
					escaped = true;
				} else if (char === '"') {
					inString = false;
				}
				continue;
			}

			if (char === '"') {
				inString = true;
				continue;
			}

			if (char === '{') {
				depth++;
				continue;
			}

			if (char === '}') {
				depth--;
				if (depth === 0) {
					endIndex = index + 1;
					break;
				}
			}
		}

		if (endIndex < 0) {
			break;
		}

		blocks.push(text.slice(keyStart, endIndex));
		startFrom = endIndex;
	}

	return blocks;
}

function buildValueIndex(entries) {
	const output = Object.create(null);
	for (const [key, value] of Object.entries(entries || {})) {
		if (!value || typeof value !== 'object' || value.value == null) {
			continue;
		}
		output[String(value.value)] = {
			key,
			value
		};
	}
	return output;
}

function resolveItemDefinition(schema, defIndex) {
	if (defIndex == null) {
		return null;
	}

	const key = String(defIndex);
	if (schema.resolvedItems[key]) {
		return schema.resolvedItems[key];
	}

	const item = schema.items[key];
	if (!item || typeof item !== 'object') {
		return null;
	}

	const merged = deepMerge(resolvePrefabs(schema.prefabs, item.prefab), item);
	schema.resolvedItems[key] = merged;
	return merged;
}

function resolvePrefabs(prefabs, prefabValue, seen = new Set()) {
	const names = cleanString(prefabValue).split(/\s+/).filter(Boolean);
	let merged = Object.create(null);

	for (const name of names) {
		if (!name || seen.has(name) || !prefabs[name]) {
			continue;
		}

		seen.add(name);
		const prefab = prefabs[name];
		merged = deepMerge(merged, resolvePrefabs(prefabs, prefab.prefab, seen));
		merged = deepMerge(merged, prefab);
	}

	return merged;
}

function deepMerge(base, extra) {
	const left = isPlainObject(base) ? base : Object.create(null);
	const right = isPlainObject(extra) ? extra : Object.create(null);
	const output = {...left};

	for (const [key, value] of Object.entries(right)) {
		if (isPlainObject(value) && isPlainObject(output[key])) {
			output[key] = deepMerge(output[key], value);
		} else if (isPlainObject(value)) {
			output[key] = deepMerge(Object.create(null), value);
		} else {
			output[key] = value;
		}
	}

	return output;
}

function isPlainObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveKind(definition, paintKit, sprayKit, directStickerKit) {
	if (paintKit && isWeaponDefinition(definition)) {
		return 'weapon_skin';
	}
	if (sprayKit) {
		return 'graffiti';
	}
	if (directStickerKit) {
		return isSprayKit(directStickerKit) ? 'graffiti' : 'sticker';
	}
	if (isCaseDefinition(definition)) {
		return 'weapon_case';
	}
	if (isWeaponDefinition(definition)) {
		return 'base_weapon';
	}
	if (isToolDefinition(definition)) {
		return 'tool';
	}
	return 'item';
}

function kindToLabel(kind, definition) {
	if (kind === 'weapon_skin') {
		return '武器皮肤';
	}
	if (kind === 'weapon_case') {
		return isStickerCapsule(definition) ? '印花胶囊' : '武器箱';
	}
	if (kind === 'graffiti') {
		return '涂鸦';
	}
	if (kind === 'sticker') {
		return '印花';
	}
	if (kind === 'base_weapon') {
		return '基础武器';
	}
	if (kind === 'tool') {
		return '工具';
	}
	return '物品';
}

function resolveCategory(schema, definition, kind) {
	if (!definition) {
		return '';
	}

	const weaponType = cleanString(definition.visuals && definition.visuals.weapon_type);
	if (weaponType) {
		return weaponType;
	}

	if (kind === 'weapon_case') {
		const itemSetText = localizeToken(schema, definition.tags && definition.tags.ItemSet && definition.tags.ItemSet.tag_text);
		if (itemSetText) {
			return itemSetText;
		}
		const itemSet = cleanString(definition.tags && definition.tags.ItemSet && definition.tags.ItemSet.tag_value);
		if (itemSet) {
			return humanizeText(itemSet.replace(/^set_/, ''));
		}
		const supplySeries = cleanString(definition.attributes && definition.attributes['set supply crate series'] && definition.attributes['set supply crate series'].value);
		if (supplySeries) {
			return `系列 ${supplySeries}`;
		}
	}

	if (kind === 'tool' && definition.tool && definition.tool.type) {
		return humanizeText(definition.tool.type);
	}

	return '';
}

function buildBaseDisplayName(context) {
	if (context.paintKit && context.definitionDisplayName) {
		return `${context.definitionDisplayName} | ${context.paintDisplayName || `Paint ${context.paintKit.index}`}`;
	}
	if (context.sprayKit) {
		return `封印涂鸦 | ${context.sprayDisplayName || `喷漆 ${context.sprayKit.id}`}`;
	}
	if (context.directStickerKit) {
		const label = isSprayKit(context.directStickerKit) ? '封印涂鸦' : '印花';
		return `${label} | ${context.directStickerDisplayName || `Kit ${context.defIndex}`}`;
	}
	if (context.containerMarketName) {
		return context.containerMarketName;
	}
	if (context.definitionDisplayName) {
		return context.definitionDisplayName;
	}
	return '';
}

function getContainerMarketName(schema, kind, defIndex, definition) {
	if (kind !== 'weapon_case' || defIndex == null) {
		return '';
	}

	const localizedDefinitionName = localizeToken(schema, definition && definition.item_name);
	if (localizedDefinitionName) {
		return localizedDefinitionName;
	}

	const englishName = cleanString(schema && schema.containerMarketNames && schema.containerMarketNames[String(defIndex)]);
	return localizeEnglishValue(schema, englishName) || englishName;
}

function getDefinitionDisplayName(schema, definition) {
	if (!definition || typeof definition !== 'object') {
		return '';
	}

	const weaponName = resolveWeaponName(definition.item_class) || resolveWeaponName(definition.name);
	if (weaponName) {
		return weaponName;
	}

	if (isGraffitiDefinition(definition)) {
		return '封印涂鸦';
	}

	if (cleanString(definition.name) === 'spray') {
		return '封印涂鸦';
	}

	const localizedItemName = localizeToken(schema, definition.item_name);
	if (localizedItemName) {
		return localizedItemName;
	}

	return humanizeText(cleanString(definition.name) || cleanString(definition.item_class) || cleanString(definition.item_name));
}

function getPaintKitDisplayName(schema, paintKit, definition) {
	if (!paintKit) {
		return '';
	}

	const localizedTagName = localizeToken(schema, paintKit.description_tag);
	if (localizedTagName) {
		return localizedTagName;
	}

	const localizedStringName = localizeToken(schema, paintKit.description_string);
	if (localizedStringName) {
		return localizedStringName;
	}

	let code = cleanString(paintKit.description_tag)
		.replace(/^#PaintKit_/i, '')
		.replace(/_Tag$/i, '');

	if (!code) {
		code = cleanString(paintKit.description_string).replace(/^#PaintKit_/i, '');
	}
	if (!code) {
		code = cleanString(paintKit.name);
	}

	for (const prefix of PAINT_PREFIXES) {
		if (code.startsWith(prefix)) {
			code = code.slice(prefix.length);
			break;
		}
	}

	for (const token of collectDefinitionTokens(definition)) {
		if (code.startsWith(token + '_')) {
			code = code.slice(token.length + 1);
		}
		if (code.endsWith('_' + token)) {
			code = code.slice(0, -(token.length + 1));
		}
	}

	return humanizeText(code || cleanString(paintKit.name));
}

function getStickerKitDisplayName(schema, stickerKit) {
	if (!stickerKit) {
		return '';
	}

	const localizedItemName = localizeToken(schema, stickerKit.item_name);
	if (localizedItemName) {
		return localizedItemName;
	}

	let code = cleanString(stickerKit.item_name)
		.replace(/^#StickerKit_/i, '')
		.replace(/^#SprayKit_/i, '')
		.replace(/^#PatchKit_/i, '');

	if (!code) {
		code = cleanString(stickerKit.name);
	}

	code = code.replace(/^spray_/i, '');
	code = code.replace(/^std_/i, '');

	return humanizeText(code || cleanString(stickerKit.name));
}

function resolveAppliedStickers(schema, stickers) {
	if (!Array.isArray(stickers)) {
		return [];
	}

	return stickers
		.filter(entry => entry && toFiniteNumber(entry.sticker_id) != null)
		.map(entry => {
			const stickerId = toFiniteNumber(entry.sticker_id);
			const kit = stickerId == null ? null : schema.stickerKits[String(stickerId)] || null;
			return {
				slot: toFiniteNumber(entry.slot),
				stickerId,
				internalName: cleanString(kit && kit.name),
				displayName: getStickerKitDisplayName(schema, kit) || `印花 ${stickerId == null ? '-' : stickerId}`,
				rarity: rarityLabelFromKey(cleanString(kit && kit.item_rarity)),
				wear: toFiniteNumber(entry.wear),
				scale: toFiniteNumber(entry.scale),
				rotation: toFiniteNumber(entry.rotation),
				offsetX: toFiniteNumber(entry.offset_x),
				offsetY: toFiniteNumber(entry.offset_y)
			};
		});
}

function resolveWeaponName(value) {
	const key = cleanString(value);
	if (!key) {
		return '';
	}
	if (WEAPON_NAME_MAP[key]) {
		return WEAPON_NAME_MAP[key];
	}
	if (key.startsWith('weapon_')) {
		return humanizeText(key.slice(7));
	}
	return '';
}

function resolveRarityLabel(schema, item, definition, stickerKit) {
	const numericRarity = toFiniteNumber(item && item.rarity);
	if (numericRarity != null) {
		const entry = schema.rarityByValue[String(numericRarity)];
		if (entry) {
			return rarityLabelFromKey(entry.key);
		}
	}

	const keys = [
		cleanString(definition && definition.item_rarity),
		cleanString(stickerKit && stickerKit.item_rarity)
	].filter(Boolean);

	for (const key of keys) {
		const label = rarityLabelFromKey(key);
		if (label) {
			return label;
		}
	}

	return '';
}

function resolveQualityLabel(schema, item, definition) {
	const numericQuality = toFiniteNumber(item && item.quality);
	if (numericQuality != null) {
		const entry = schema.qualityByValue[String(numericQuality)];
		if (entry) {
			return qualityLabelFromKey(entry.key);
		}
	}

	return qualityLabelFromKey(cleanString(definition && definition.item_quality));
}

function buildSubtitle(context) {
	const parts = [];

	if (context.customName && context.baseDisplayName && context.customName !== context.baseDisplayName) {
		parts.push(context.baseDisplayName);
	}
	if (context.category) {
		parts.push(context.category);
	}

	if (context.kind === 'weapon_skin') {
		const seed = toFiniteNumber(context.item && context.item.paint_seed);
		if (seed != null) {
			parts.push(`模板 ${seed}`);
		}
		if (context.stickers.length) {
			parts.push(`贴纸 ${context.stickers.length}`);
		}
	}

	if (context.kind === 'graffiti' && context.sprayKit && context.sprayKit.name) {
		parts.push(`喷漆代号 ${context.sprayKit.name}`);
	}

	if (context.kind === 'sticker' && context.directStickerKit && context.directStickerKit.name) {
		parts.push(`印花代号 ${context.directStickerKit.name}`);
	}

	if (context.kind === 'weapon_case') {
		const supplySeries = cleanString(context.definition && context.definition.attributes && context.definition.attributes['set supply crate series'] && context.definition.attributes['set supply crate series'].value);
		if (supplySeries && !parts.includes(`系列 ${supplySeries}`)) {
			parts.push(`系列 ${supplySeries}`);
		}
	}

	if (!parts.length && context.quality) {
		parts.push(`品质 ${context.quality}`);
	}

	return parts.join(' / ');
}

function loadContainerMarketNames(itemsGamePath) {
	const output = Object.create(null);
	const schemaFile = path.resolve(path.dirname(itemsGamePath || ''), 'node_modules', '@protobufjs', 'locale', 'schema.json');
	if (!schemaFile || !fs.existsSync(schemaFile)) {
		return output;
	}

	try {
		const payload = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
		const containers = payload && typeof payload === 'object' ? payload.containers : null;
		if (!containers || typeof containers !== 'object') {
			return output;
		}

		for (const [key, value] of Object.entries(containers)) {
			if (!/^\d+$/.test(key) || !value || typeof value !== 'object') {
				continue;
			}
			const marketHashName = cleanString(value.market_hash_name);
			if (marketHashName) {
				output[key] = marketHashName;
			}
		}
	} catch {
		return output;
	}

	return output;
}

function loadLocalizationTokens(filePath) {
	const output = Object.create(null);
	if (!filePath || !fs.existsSync(filePath)) {
		return output;
	}

	try {
		const text = decodeTextFile(filePath);
		const lines = text.split(/\r?\n/);
		let pendingTokensBlock = false;
		let inTokensBlock = false;
		let depth = 0;

		for (const line of lines) {
			const withoutComments = stripLineComments(line);
			if (!inTokensBlock) {
				if (!pendingTokensBlock && /"Tokens"/.test(withoutComments)) {
					pendingTokensBlock = true;
				}
				if (pendingTokensBlock) {
					const braceDelta = countBraceDelta(withoutComments);
					if (braceDelta > 0 || withoutComments.trim() === '{') {
						inTokensBlock = true;
						depth = Math.max(1, braceDelta || 1);
						pendingTokensBlock = false;
					}
				}
				continue;
			}

			if (depth === 1) {
				const strings = extractQuotedStrings(withoutComments);
				if (strings.length >= 2) {
					output[strings[0]] = strings[1];
				}
			}

			depth += countBraceDelta(withoutComments);
			if (depth <= 0) {
				break;
			}
		}
	} catch {
		return output;
	}

	return output;
}

function buildEnglishValueIndex(tokens) {
	const output = Object.create(null);
	for (const [key, value] of Object.entries(tokens || {})) {
		const normalized = normalizeLookupValue(value);
		if (!normalized || output[normalized]) {
			continue;
		}
		output[normalized] = key;
	}
	return output;
}

function localizeToken(schema, token) {
	const key = cleanString(token).replace(/^#/, '');
	if (!key) {
		return '';
	}
	return cleanString(schema && schema.localizedTokens && schema.localizedTokens[key]);
}

function localizeEnglishValue(schema, value) {
	const normalized = normalizeLookupValue(value);
	if (!normalized) {
		return '';
	}

	const token = schema && schema.englishValueToToken ? schema.englishValueToToken[normalized] : '';
	return token ? localizeToken(schema, token) : '';
}

function normalizeLookupValue(value) {
	return cleanString(value).replace(/\s+/g, ' ').toLowerCase();
}

function decodeTextFile(filePath) {
	const buffer = fs.readFileSync(filePath);
	if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
		return buffer.toString('utf16le').replace(/^\uFEFF/, '');
	}
	if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
		return buffer.toString('utf8').replace(/^\uFEFF/, '');
	}
	return buffer.toString('utf8');
}

function stripLineComments(line) {
	let inString = false;
	let escaped = false;

	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		const next = line[index + 1];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === '/' && next === '/') {
			return line.slice(0, index);
		}
	}

	return line;
}

function countBraceDelta(line) {
	let delta = 0;
	let inString = false;
	let escaped = false;

	for (const char of line) {
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === '{') {
			delta++;
		} else if (char === '}') {
			delta--;
		}
	}

	return delta;
}

function extractQuotedStrings(line) {
	const strings = [];
	let current = '';
	let inString = false;
	let escaped = false;

	for (const char of line) {
		if (!inString) {
			if (char === '"') {
				inString = true;
				current = '';
			}
			continue;
		}

		if (escaped) {
			current += char === 'n' ? '\n' : char;
			escaped = false;
			continue;
		}

		if (char === '\\') {
			escaped = true;
			continue;
		}

		if (char === '"') {
			strings.push(current);
			inString = false;
			current = '';
			continue;
		}

		current += char;
	}

	return strings;
}

function isWeaponDefinition(definition) {
	return !!definition && (
		cleanString(definition.item_class).startsWith('weapon_')
		|| cleanString(definition.name).startsWith('weapon_')
	);
}

function isCaseDefinition(definition) {
	if (!definition) {
		return false;
	}
	const prefab = cleanString(definition.prefab);
	return (
		prefab.includes('weapon_case')
		|| cleanString(definition.inv_container_and_tools).includes('case')
		|| cleanString(definition.name).startsWith('crate_')
	);
}

function isStickerCapsule(definition) {
	if (!definition) {
		return false;
	}
	return cleanString(definition.inv_container_and_tools).includes('sticker_capsule');
}

function isGraffitiDefinition(definition) {
	return !!definition && (
		cleanString(definition.name) === 'spray'
		|| cleanString(definition.tool && definition.tool.type) === 'spray'
	);
}

function isToolDefinition(definition) {
	return !!definition && (
		cleanString(definition.item_class) === 'tool'
		|| cleanString(definition.craft_class) === 'tool'
	);
}

function isSprayKit(stickerKit) {
	return !!stickerKit && /^spray_/i.test(cleanString(stickerKit.name));
}

function extractSprayKitId(item) {
	if (!item || !Array.isArray(item.stickers)) {
		return null;
	}
	const first = item.stickers.find(entry => entry && toFiniteNumber(entry.sticker_id) != null);
	return first ? toFiniteNumber(first.sticker_id) : null;
}

function collectDefinitionTokens(definition) {
	const output = new Set();
	for (const raw of [definition && definition.name, definition && definition.item_class]) {
		const value = cleanString(raw).replace(/^weapon_/, '');
		if (!value) {
			continue;
		}
		output.add(value);
		output.add(value.replace(/_/g, ''));
	}
	return Array.from(output).filter(Boolean).sort((left, right) => right.length - left.length);
}

function formatExterior(value) {
	const wear = toFiniteNumber(value);
	if (wear == null) {
		return '';
	}
	return `${exteriorLabel(wear)} ${wear.toFixed(5)}`;
}

function exteriorLabel(value) {
	if (value < 0.07) {
		return '崭新出厂';
	}
	if (value < 0.15) {
		return '略有磨损';
	}
	if (value < 0.38) {
		return '久经沙场';
	}
	if (value < 0.45) {
		return '破损不堪';
	}
	return '战痕累累';
}

function rarityLabelFromKey(key) {
	return key && RARITY_LABELS[key] ? RARITY_LABELS[key] : humanizeText(key);
}

function qualityLabelFromKey(key) {
	return key && QUALITY_LABELS[key] ? QUALITY_LABELS[key] : humanizeText(key);
}

function humanizeText(value) {
	const source = cleanString(value)
		.replace(/^#/, '')
		.replace(/^SFUI_WPNHUD_/i, '')
		.replace(/^CSGO_/i, '')
		.replace(/^PaintKit_/i, '')
		.replace(/^StickerKit_/i, '')
		.replace(/^SprayKit_/i, '')
		.replace(/^PatchKit_/i, '');

	if (!source) {
		return '';
	}

	const normalized = source.replace(/[-]+/g, '_').replace(/__+/g, '_');
	const direct = TOKEN_NAME_MAP[normalized];
	if (direct) {
		return direct;
	}

	return normalized
		.split('_')
		.filter(Boolean)
		.map(part => {
			const lowered = part.toLowerCase();
			if (TOKEN_NAME_MAP[lowered]) {
				return TOKEN_NAME_MAP[lowered];
			}
			if (/^\d+$/.test(part)) {
				return part;
			}
			if (part.length <= 3) {
				return part.toUpperCase();
			}
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(' ');
}

function toFiniteNumber(value) {
	if (value == null || value === '') {
		return null;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	if (typeof value === 'object' && typeof value.toString === 'function') {
		const parsed = Number(value.toString());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function toIsoDate(value) {
	if (!value) {
		return '';
	}
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function cleanString(value) {
	return String(value == null ? '' : value).trim();
}
