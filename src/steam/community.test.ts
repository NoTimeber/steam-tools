import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createRequestGate, MOBILECONF_COOLDOWN_MS, throttleMobileconf} from './community.ts';
import type {RequestGate, SteamCommunity} from './community.ts';

const require = createRequire(import.meta.url);

test('排队器:同一个 key 两次放行至少隔 gap;不同 key 互不影响;hold 推后下一次', async () => {
	let clock = 0;
	const sleeps: number[] = [];
	const gate = createRequestGate(5000, {now: () => clock, sleep: async ms => {
		sleeps.push(ms);
		clock += ms;
	}});
	await gate.wait('a');
	clock += 1000;
	await gate.wait('a');
	await gate.wait('b');
	assert.deepEqual(sleeps, [4000], 'a 等满 5 秒,b 第一次不用等');
	gate.hold('b', 1);
	await gate.wait('b');
	assert.deepEqual(sleeps, [4000, 5000], '比剩下的 gap 短的 hold 不会让它提前');
	gate.hold('a', 10000);
	await gate.wait('a');
	assert.deepEqual(sleeps, [4000, 5000, 10000]);
	assert.equal(clock, 20000);
});

test('排队器:同时在等的请求一个一个放行', async () => {
	const gate = createRequestGate(60);
	const started: number[] = [];
	await Promise.all([0, 1, 2].map(async () => {
		await gate.wait('x');
		started.push(Date.now());
	}));
	assert.equal(started.length, 3);
	for (let index = 1; index < started.length; index++) {
		assert.ok(started[index]! - started[index - 1]! >= 45, `第 ${index + 1} 个隔了 ${started[index]! - started[index - 1]!}ms`);
	}
});

/** 真的 steamcommunity,HTTP 换成假的:按地址回状态码 */
function communityWith(statusFor: (url: string) => number): {community: SteamCommunity; sent: string[]} {
	const SteamCommunityClass = require('steamcommunity') as new (options: Record<string, unknown>) => SteamCommunity;
	const sent: string[] = [];
	const request = {
		defaults: () => (options: {url: string}, callback: (err: Error | null, response: unknown, body: unknown) => void) => {
			sent.push(options.url);
			setImmediate(() => callback(null, {statusCode: statusFor(options.url), headers: {}}, {success: true}));
		}
	};
	return {community: new SteamCommunityClass({request}), sent};
}

function get(community: SteamCommunity, url: string): Promise<Error | null> {
	return new Promise(resolve => (community.httpRequestGet as (options: unknown, callback: (err: Error | null) => void) => void)({uri: url, json: true}, err => resolve(err)));
}

test('mobileconf 请求先排队再发,别的请求不排队;回 429 时这个出口冷却', async () => {
	const events: string[] = [];
	let release: () => void = () => {};
	const gate: RequestGate = {
		wait: key => {
			events.push('wait ' + key);
			return new Promise<void>(resolve => {
				release = () => resolve();
			});
		},
		hold: (key, ms) => void events.push(`hold ${key} ${ms}`)
	};
	const {community, sent} = communityWith(url => url.includes('ajaxop') ? 429 : 200);
	throttleMobileconf(community, 'proxy-a', gate);

	assert.equal(await get(community, 'https://steamcommunity.com/market/mylistings'), null);
	assert.deepEqual(events, [], '市场请求不排队');

	const listing = get(community, 'https://steamcommunity.com/mobileconf/getlist');
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(events, ['wait proxy-a']);
	assert.equal(sent.length, 1, '没轮到之前不发');
	release();
	assert.equal(await listing, null);
	assert.equal(sent.at(-1), 'https://steamcommunity.com/mobileconf/getlist');

	const accepting = get(community, 'https://steamcommunity.com/mobileconf/ajaxop');
	await new Promise(resolve => setImmediate(resolve));
	release();
	const err = await accepting as Error & {code?: number};
	assert.equal(err?.code, 429);
	assert.deepEqual(events, ['wait proxy-a', 'wait proxy-a', `hold proxy-a ${MOBILECONF_COOLDOWN_MS}`]);
});
