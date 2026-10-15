import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listAccountRefs} from './attempts.ts';
import type {Attempt} from './session-manager.ts';

const attempt = (fields: Partial<Attempt>) => ({status: 'logged_on', cookies: ['steamLoginSecure=x'], ...fields}) as Attempt;

test('账号列表:按名单顺序列全部账号,补上 SteamID、昵称、在不在线、有没有存下的会话', () => {
	const refs = listAccountRefs(['alpha', 'Bravo', 'charlie', 'delta', ''], [
		attempt({accountName: 'alpha', steamID: '76561198000000001', personaName: '阿尔法'}),
		attempt({accountName: 'bravo', steamID: '76561198000000002', status: 'logged_out', cookies: []}),
		attempt({accountName: 'delta', steamID: '', cookies: []})
	], {
		// charlie 有 maFile;bravo 上次登录存下了会话
		steamIdOf: name => ({charlie: '76561198000000003', Bravo: 'not-an-id'} as Record<string, string>)[name] ?? '',
		cookiesFor: entry => (entry.cookies?.length ? entry.cookies : String(entry.accountName).toLowerCase() === 'bravo' ? ['steamLoginSecure=old'] : [])
	});
	assert.deepEqual(refs, [
		{account: 'alpha', steamId: '76561198000000001', personaName: '阿尔法', online: true, hasSession: true},
		{account: 'Bravo', steamId: '76561198000000002', personaName: '', online: false, hasSession: true},
		{account: 'charlie', steamId: '76561198000000003', personaName: '', online: false, hasSession: false},
		{account: 'delta', steamId: '', personaName: '', online: false, hasSession: false}
	]);
});
