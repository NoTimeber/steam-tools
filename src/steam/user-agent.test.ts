import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	POOL_MAJOR_VERSIONS, STEAM_WEB_USER_AGENT, chromeMajor, chromeUserAgent, isCurrentWebUserAgent, webUserAgentFor, webUserAgentPool
} from './user-agent.ts';

const WIN = 'Windows NT 10.0; Win64; x64';
const MAC = 'Macintosh; Intel Mac OS X 10_15_7';

test('UA 池:最新的几个 Chrome 大版本 × Windows / Mac,都是精简后的真实格式', () => {
	const latest = chromeUserAgent(MAC, 150);
	const pool = webUserAgentPool(latest);
	assert.equal(pool.length, POOL_MAJOR_VERSIONS * 2);
	assert.equal(pool[0], chromeUserAgent(WIN, 150));
	assert.ok(pool.includes(latest));
	assert.deepEqual([...new Set(pool.map(ua => chromeMajor(ua)))], Array.from({length: POOL_MAJOR_VERSIONS}, (_, i) => 150 - i));
	assert.equal(chromeUserAgent(WIN, 148), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');

	// 环境变量填了不是标准格式的 Chrome UA:池里照样有它;不是 Chrome 就只有它一条
	const custom = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
	assert.equal(webUserAgentPool(custom)[0], custom);
	assert.deepEqual(webUserAgentPool('MyAgent/1.0'), ['MyAgent/1.0']);
	assert.equal(chromeMajor('MyAgent/1.0'), null);
});

test('账号 UA:在当前池里才用,老 Chrome、空的、不是字符串的都换成默认 UA', () => {
	const pool = webUserAgentPool();
	assert.ok(pool.includes(STEAM_WEB_USER_AGENT));
	const last = pool[pool.length - 1]!;
	assert.equal(webUserAgentFor(last), last);
	const old = chromeUserAgent(WIN, 99);
	assert.equal(isCurrentWebUserAgent(old), false);
	assert.equal(webUserAgentFor(old), STEAM_WEB_USER_AGENT);
	assert.equal(webUserAgentFor(''), STEAM_WEB_USER_AGENT);
	assert.equal(webUserAgentFor(undefined), STEAM_WEB_USER_AGENT);
	assert.equal(webUserAgentFor(7), STEAM_WEB_USER_AGENT);
});
