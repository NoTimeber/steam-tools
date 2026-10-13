import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from './index.ts';
import type {LegacyPaths} from './legacy-import.ts';

function quietLogger() {
	const lines: string[] = [];
	return {lines, log: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m)};
}

// 按旧版目录结构铺一份明文数据
function legacyDataDir() {
	const dir = mkdtempSync(join(tmpdir(), 'legacy-'));
	const paths: LegacyPaths = {
		accountsFile: join(dir, 'config', 'accounts.json'),
		mafileDir: join(dir, 'config', 'mafile'),
		sessionDir: join(dir, 'sessions'),
		uuTokensFile: join(dir, 'uu', 'tokens.json'),
		uuConfigFile: join(dir, 'uu', 'delivery-config.json'),
		uuLastTokenFile: join(dir, 'uu', 'last-token.txt')
	};
	mkdirSync(paths.mafileDir, {recursive: true});
	mkdirSync(paths.sessionDir, {recursive: true});
	mkdirSync(join(dir, 'uu'), {recursive: true});
	writeFileSync(paths.accountsFile, JSON.stringify([
		{id: 'c1', accountName: 'Alice', password: 'LEGACY-PW-A', sharedSecret: 'LEGACY-SS-A', remember: true, steamID: '765611', balance: 1.5, currency: 1},
		{id: 'c2', accountName: 'bob', password: 'LEGACY-PW-B'}
	], null, 2));
	writeFileSync(join(paths.mafileDir, 'Alice.maFile'), JSON.stringify({account_name: 'Alice', shared_secret: 'LEGACY-MA-SS', identity_secret: 'LEGACY-MA-IS'}));
	writeFileSync(join(paths.mafileDir, 'notes.txt'), 'not a mafile');
	writeFileSync(join(paths.sessionDir, 'Alice.json'), JSON.stringify({accountName: 'Alice', refreshToken: 'LEGACY-RT', cookies: ['steamLoginSecure=LEGACY-COOKIE']}));
	writeFileSync(join(paths.sessionDir, 'broken.json'), '{"oops":');
	writeFileSync(paths.uuTokensFile, JSON.stringify([{token: 'LEGACY-UU-TOKEN', userId: '42', nickname: 'n', linkedSteamId: '765611'}]));
	writeFileSync(paths.uuConfigFile, JSON.stringify({__settings__: {pollIntervalMs: 90000}, Alice: {token: 'LEGACY-UU-TOKEN', gameId: '730', delivery: {'730': {auto: true}}}}));
	writeFileSync(paths.uuLastTokenFile, 'LEGACY-UU-TOKEN');
	return {dir, paths};
}

function open(dir: string, paths: LegacyPaths, key: Buffer, logger = quietLogger()) {
	return openStore({dataDir: dir, defaultKeyFile: join(dir, 'unused.key'), env: {MASTER_KEY: key.toString('base64')}, logger, legacy: paths});
}

function listRecursive(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, {recursive: true, withFileTypes: true})
		.filter(entry => entry.isFile())
		.map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1).replaceAll('\\', '/'))
		.sort();
}

test('旧版明文数据导入加密库,原文件归档,坏文件原地保留', () => {
	const {dir, paths} = legacyDataDir();
	const logger = quietLogger();
	const store = open(dir, paths, randomBytes(32), logger);
	const report = store.legacyImport;
	assert.ok(report);
	assert.deepEqual(report.imported, {accounts: 2, mafiles: 1, sessions: 1, uuTokens: 1, uuDelivery: 1});
	assert.deepEqual(report.failed, [join(paths.sessionDir, 'broken.json')]);
	assert.deepEqual(report.skipped, [], 'last-token.txt 只归档,不算"跳过"');

	assert.equal(store.accounts.get('alice')?.password, 'LEGACY-PW-A');
	assert.equal(store.accounts.get('alice')?.sharedSecret, 'LEGACY-SS-A');
	assert.equal(store.accounts.isInitialized(), true);
	assert.equal(store.mafiles.get('Alice')?.identity_secret, 'LEGACY-MA-IS');
	assert.equal(store.sessions.get('Alice')?.refreshToken, 'LEGACY-RT');
	assert.equal(store.uu.findToken('42')?.token, 'LEGACY-UU-TOKEN');
	assert.deepEqual(store.uu.loadDeliveryConfig(), {
		__settings__: {pollIntervalMs: 90000},
		Alice: {token: 'LEGACY-UU-TOKEN', gameId: '730', delivery: {'730': {auto: true}}}
	});

	// 数据目录里只剩坏文件和非 maFile 文件;明文都挪进了归档目录
	assert.ok(report.archiveDir);
	const remaining = listRecursive(dir).filter(f => !f.startsWith('_migrated_plaintext/') && !f.startsWith('steam-tools.db'));
	assert.deepEqual(remaining, ['config/mafile/notes.txt', 'sessions/broken.json']);
	const archived = listRecursive(report.archiveDir);
	assert.deepEqual(archived, [
		'config/accounts.json',
		'config/mafile/Alice.maFile',
		'sessions/Alice.json',
		'uu/delivery-config.json',
		'uu/last-token.txt',
		'uu/tokens.json'
	]);
	assert.equal(JSON.parse(readFileSync(join(report.archiveDir, 'config/accounts.json'), 'utf8'))[0].password, 'LEGACY-PW-A', '归档是原样移动');
	assert.ok(logger.lines.some(line => line.includes('确认数据正常后请删除该目录')));

	// 数据库文件里没有任何明文凭据
	const raw = readFileSync(join(dir, 'steam-tools.db')).toString('latin1') +
		(existsSync(join(dir, 'steam-tools.db-wal')) ? readFileSync(join(dir, 'steam-tools.db-wal')).toString('latin1') : '');
	for (const secret of ['LEGACY-PW', 'LEGACY-SS', 'LEGACY-MA', 'LEGACY-RT', 'LEGACY-COOKIE', 'LEGACY-UU-TOKEN']) {
		assert.ok(!raw.includes(secret), `${secret} 不能明文落盘`);
	}
	store.close();
});

test('再次启动不重复导入;库里已有数据时旧文件只归档不覆盖', () => {
	const {dir, paths} = legacyDataDir();
	const key = randomBytes(32);
	const first = open(dir, paths, key);
	first.accounts.replaceAll([{accountName: 'Alice', password: 'NEWER-PW'}]);
	first.close();

	const second = open(dir, paths, key);
	assert.equal(second.legacyImport?.archiveDir, null, '没有新文件时什么都不做');
	second.close();

	// 有人又把旧备份拷了回来
	const again = legacyDataDir();
	for (const [from, to] of [[again.paths.accountsFile, paths.accountsFile], [again.paths.uuTokensFile, paths.uuTokensFile]] as const) {
		mkdirSync(join(to, '..'), {recursive: true});
		writeFileSync(to, readFileSync(from));
	}
	const third = open(dir, paths, key);
	assert.deepEqual(third.legacyImport?.imported, {accounts: 0, mafiles: 0, sessions: 0, uuTokens: 0, uuDelivery: 0});
	assert.equal(third.legacyImport?.skipped.length, 2);
	assert.equal(third.accounts.get('alice')?.password, 'NEWER-PW', '库里较新的数据不能被旧文件覆盖');
	assert.ok(!existsSync(paths.accountsFile), '跳过的明文文件也要挪走');
	third.close();
});
