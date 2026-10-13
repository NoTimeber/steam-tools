import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVault, loadMasterKey, VaultError} from './vault.ts';

const silent = {warn() {}};

test('加密后能解回原文,每次密文不同', () => {
	const vault = createVault(randomBytes(32));
	const a = vault.encrypt('hunter2', 'account.password');
	const b = vault.encrypt('hunter2', 'account.password');
	assert.notEqual(a, b);
	assert.ok(!a.includes('hunter2'));
	assert.match(a, new RegExp(`^v1\\.${vault.keyId}\\.`));
	assert.equal(vault.decrypt(a, 'account.password'), 'hunter2');
	assert.deepEqual(vault.decryptJson(vault.encryptJson({x: [1, '中文']}, 'p'), 'p'), {x: [1, '中文']});
});

test('用途(AAD)不符、密文被改、换了密钥都解不开', () => {
	const vault = createVault(randomBytes(32));
	const sealed = vault.encrypt('secret', 'account.password');
	assert.throws(() => vault.decrypt(sealed, 'account.shared_secret'), VaultError);

	const parts = sealed.split('.');
	const raw = Buffer.from(parts[2] ?? '', 'base64url');
	raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
	assert.throws(() => vault.decrypt(`${parts[0]}.${parts[1]}.${raw.toString('base64url')}`, 'account.password'), VaultError);

	const other = createVault(randomBytes(32));
	assert.throws(() => other.decrypt(sealed, 'account.password'), /另一把主密钥/);
	assert.throws(() => vault.decrypt('plain-text', 'account.password'), /不是有效的密文/);
});

test('主密钥长度必须是 32 字节', () => {
	assert.throws(() => createVault(randomBytes(16)), VaultError);
});

test('loadMasterKey:环境变量优先,支持 base64 和 hex', () => {
	const key = randomBytes(32);
	const dir = mkdtempSync(join(tmpdir(), 'vault-'));
	const fromB64 = loadMasterKey({env: {MASTER_KEY: key.toString('base64')}, defaultKeyFile: join(dir, 'k'), logger: silent});
	assert.equal(fromB64.source, 'env');
	assert.ok(fromB64.key.equals(key));
	const fromHex = loadMasterKey({env: {MASTER_KEY: key.toString('hex')}, defaultKeyFile: join(dir, 'k'), logger: silent});
	assert.ok(fromHex.key.equals(key));
	assert.throws(() => loadMasterKey({env: {MASTER_KEY: 'too-short'}, defaultKeyFile: join(dir, 'k'), logger: silent}), VaultError);
});

test('loadMasterKey:读 MASTER_KEY_FILE 指向的文件', () => {
	const key = randomBytes(32);
	const dir = mkdtempSync(join(tmpdir(), 'vault-'));
	const file = join(dir, 'master.key');
	writeFileSync(file, key.toString('base64') + '\n');
	const loaded = loadMasterKey({env: {MASTER_KEY_FILE: file}, defaultKeyFile: join(dir, 'unused'), logger: silent});
	assert.ok(loaded.key.equals(key));
	assert.equal(loaded.source, file);
	assert.equal(loaded.generated, false);
});

test('loadMasterKey:开发环境缺文件时自动生成,再次加载得到同一把', () => {
	const dir = mkdtempSync(join(tmpdir(), 'vault-'));
	const file = join(dir, 'secrets', 'master.key');
	const first = loadMasterKey({env: {}, defaultKeyFile: file, logger: silent});
	assert.equal(first.generated, true);
	assert.ok(existsSync(file));
	assert.equal(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64').length, 32);
	const second = loadMasterKey({env: {}, defaultKeyFile: file, logger: silent});
	assert.equal(second.generated, false);
	assert.ok(second.key.equals(first.key));
});

test('loadMasterKey:生产环境缺文件直接报错,不自动生成', () => {
	const dir = mkdtempSync(join(tmpdir(), 'vault-'));
	const file = join(dir, 'master.key');
	assert.throws(() => loadMasterKey({env: {NODE_ENV: 'production'}, defaultKeyFile: file, logger: silent}), /生产环境不会自动生成/);
	assert.ok(!existsSync(file));
});
