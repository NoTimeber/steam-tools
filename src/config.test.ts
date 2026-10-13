import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {loadConfig} from './config.ts';

const dirs = {appRoot: resolve('/srv/tools'), appDir: resolve('/srv/tools/app')};

test('缺省:数据在安装根 data/,schema 在 app/schema/,端口 53110,自动恢复开', () => {
	const config = loadConfig({}, dirs);
	assert.equal(config.dataDir, join(dirs.appRoot, 'data'));
	assert.equal(config.configDir, join(dirs.appRoot, 'data', 'config'));
	assert.equal(config.legacy.accountsFile, join(dirs.appRoot, 'data', 'config', 'accounts.json'));
	assert.equal(config.legacy.uuTokensFile, join(dirs.appRoot, 'data', 'uu', 'tokens.json'));
	assert.equal(config.defaultKeyFile, join(dirs.appRoot, 'secrets', 'master.key'));
	assert.equal(config.publicDir, join(dirs.appDir, 'public'));
	assert.equal(config.schema.cs2ItemsGame, join(dirs.appDir, 'schema', 'items_game.txt'));
	assert.equal(config.schema.tf2Schinese, join(dirs.appDir, 'schema', 'tf2_schinese.txt'));
	assert.deepEqual([config.host, config.port], ['0.0.0.0', 53110]);
	assert.deepEqual(config.http, {trustProxy: undefined, allowedOrigins: undefined, cookieSecure: undefined, debugEndpoints: false});
	assert.deepEqual(config.auth, {envPassword: '', sessionTtlMs: 7 * 24 * 60 * 60 * 1000, setupToken: ''});
	assert.deepEqual(config.sessions, {
		loginTimeoutMs: 45000, loginRetryMax: 2, reconnectIntervalMs: 30000, reconnectGraceMs: 90000,
		reconnectMaxAttempts: 6, restoreEnabled: true, restoreIntervalMs: 3000
	});
	assert.deepEqual(config.uu, {pollIntervalMs: undefined, inspectUrl: '', inspectKey: ''});
});

test('环境变量覆盖目录;CONFIG_DIR 独立于 DATA_DIR', () => {
	const config = loadConfig({
		DATA_DIR: '/data', CONFIG_DIR: '/cfg', SCHEMA_DIR: '/schema', CS2_ITEMS_GAME_FILE: '/x/items.txt',
		PORT: '8080', HOST: '127.0.0.1', ENABLE_DEBUG_ENDPOINTS: '1', SESSION_RESTORE: '0', UU_POLL_INTERVAL_MS: '120000',
		APP_PASSWORD: 'pw', SETUP_TOKEN: 'tok', TRUST_PROXY: 'loopback', COOKIE_SECURE: 'auto', ALLOWED_ORIGINS: 'https://a.example'
	}, dirs);
	assert.equal(config.dataDir, resolve('/data'));
	assert.equal(config.steamUserDir, join(resolve('/data'), 'steam-user'));
	assert.equal(config.legacy.sessionDir, join(resolve('/data'), 'sessions'));
	assert.equal(config.cookiesDir, join(resolve('/cfg'), 'cookies'));
	assert.equal(config.authFile, join(resolve('/cfg'), 'auth.json'));
	assert.equal(config.schema.cs2ItemsGame, resolve('/x/items.txt'));
	assert.equal(config.schema.cs2English, join(resolve('/schema'), 'csgo_english.txt'));
	assert.equal(config.schema.tf2ItemsGame, join(resolve('/schema'), 'tf2_items_game.txt'));
	assert.deepEqual([config.host, config.port], ['127.0.0.1', 8080]);
	assert.deepEqual(config.http, {trustProxy: 'loopback', allowedOrigins: 'https://a.example', cookieSecure: 'auto', debugEndpoints: true});
	assert.deepEqual([config.auth.envPassword, config.auth.setupToken], ['pw', 'tok']);
	assert.equal(config.sessions.restoreEnabled, false);
	assert.equal(config.uu.pollIntervalMs, 120000);
});

test('超时类数值有下限;不是数字时用缺省值', () => {
	const low = loadConfig({
		LOGIN_TIMEOUT_MS: '1', LOGIN_RETRY_MAX: '-3', RECONNECT_WATCHDOG_INTERVAL_MS: '10', RECONNECT_GRACE_MS: '10',
		RECONNECT_MAX_ATTEMPTS: '0', SESSION_RESTORE_INTERVAL_MS: '5'
	}, dirs).sessions;
	assert.deepEqual(low, {
		loginTimeoutMs: 10000, loginRetryMax: 0, reconnectIntervalMs: 15000, reconnectGraceMs: 30000,
		reconnectMaxAttempts: 1, restoreEnabled: true, restoreIntervalMs: 1000
	});
	const junk = loadConfig({LOGIN_TIMEOUT_MS: 'abc', RECONNECT_MAX_ATTEMPTS: 'x', UU_POLL_INTERVAL_MS: 'soon'}, dirs);
	assert.equal(junk.sessions.loginTimeoutMs, 45000);
	assert.equal(junk.sessions.reconnectMaxAttempts, 6);
	assert.equal(junk.uu.pollIntervalMs, undefined);
});
