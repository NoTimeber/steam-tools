import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {buildNameMap, createNameDb, loadNameDb} from './names.ts';

const NAMES = {
	'Kilowatt Case': '千瓦武器箱',
	'Kilowatt Case Key': '千瓦武器箱钥匙',
	'AK-47 | Redline (Field-Tested)': 'AK-47 | 红线 (久经沙场)',
	'StatTrak™ AK-47 | Redline (Field-Tested)': 'AK-47（StatTrak™） | 红线 (久经沙场)',
	'AK-47 | Redline (Minimal Wear)': 'AK-47 | 红线 (略有磨损)',
	'Desert Eagle | Sunset Storm 壱 (Factory New)': '沙漠之鹰 | 日落风暴 壱 (崭新出厂)'
};

test('ByMykel 数据 → 英文名对中文名:没有英文名的跳过,同名先到先得', () => {
	assert.deepEqual(buildNameMap([
		[{market_hash_name: 'Kilowatt Case', name: '千瓦武器箱'}, {market_hash_name: null, name: '射手'}, {name: '名称标签'}],
		[{market_hash_name: 'Kilowatt Case', name: '别的名字'}, {market_hash_name: ' Recoil Case ', name: ' 反冲武器箱 '}],
		null
	]), {'Kilowatt Case': '千瓦武器箱', 'Recoil Case': '反冲武器箱'});
});

test('搜索:中文、英文、几个词都要有;完全一致和开头一致的排前面,再按名字长短', () => {
	const db = createNameDb(NAMES);
	const search = (query: string) => db.search(query).map(match => match.name);
	assert.deepEqual(search('千瓦'), ['Kilowatt Case', 'Kilowatt Case Key']);
	assert.deepEqual(search('千瓦武器箱钥匙'), ['Kilowatt Case Key']);
	assert.deepEqual(search('kilowatt case'), ['Kilowatt Case', 'Kilowatt Case Key']);
	assert.deepEqual(search('kilowatt case key'), ['Kilowatt Case Key']);
	assert.deepEqual(search('红线 久经'), ['AK-47 | Redline (Field-Tested)', 'StatTrak™ AK-47 | Redline (Field-Tested)']);
	assert.deepEqual(search('ak 红线 stattrak'), ['StatTrak™ AK-47 | Redline (Field-Tested)']);
	assert.deepEqual(search('(stattrak™)'), ['StatTrak™ AK-47 | Redline (Field-Tested)'], '全角半角括号不分');
	assert.deepEqual(search('  '), []);
	assert.equal(db.search('a', 2).length, 2);
});

test('查中文名 / 反查英文名;有的英文名本身带汉字', () => {
	const db = createNameDb(NAMES);
	assert.equal(db.zh('Kilowatt Case'), '千瓦武器箱');
	assert.equal(db.zh('Gallery Case'), null);
	assert.equal(db.zh('constructor'), null);
	assert.equal(db.nameOf('千瓦武器箱'), 'Kilowatt Case');
	assert.equal(db.nameOf('Kilowatt Case'), null);
	assert.equal(db.zh('Desert Eagle | Sunset Storm 壱 (Factory New)'), '沙漠之鹰 | 日落风暴 壱 (崭新出厂)');
});

test('读 gzip 词库:用到时才读;文件没有或坏了当空词库', () => {
	const dir = mkdtempSync(join(tmpdir(), 'names-'));
	try {
		const file = join(dir, 'names.json.gz');
		writeFileSync(file, gzipSync(JSON.stringify({generatedAt: '2026-10-14T00:00:00.000Z', names: NAMES})));
		const warnings: unknown[] = [];
		const logger = {warn: (...args: unknown[]) => warnings.push(args)};
		const db = loadNameDb(file, logger);
		assert.equal(db.size(), Object.keys(NAMES).length);
		assert.equal(db.zh('Kilowatt Case'), '千瓦武器箱');

		assert.equal(loadNameDb(join(dir, 'missing.gz'), logger).size(), 0);
		writeFileSync(join(dir, 'bad.gz'), 'not gzip');
		assert.equal(loadNameDb(join(dir, 'bad.gz'), logger).zh('Kilowatt Case'), null);
		assert.equal(warnings.length, 2);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test('随包词库能读,常见饰品都有中文名', () => {
	const db = loadNameDb(join(import.meta.dirname, '..', '..', 'app', 'data', 'cs2-names-zh.json.gz'), {warn: () => assert.fail('随包词库读不了')});
	assert.ok(db.size() > 40000);
	assert.equal(db.zh('Kilowatt Case'), '千瓦武器箱');
	assert.equal(db.zh('StatTrak™ AK-47 | Redline (Field-Tested)'), 'AK-47（StatTrak™） | 红线 (久经沙场)');
	assert.equal(db.search('千瓦武器箱')[0]?.name, 'Kilowatt Case');
});
