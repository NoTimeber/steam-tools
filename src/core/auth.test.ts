import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuth} from './auth.ts';
import type {AuthRequest} from './auth.ts';

/** 最小的假响应:记下 Set-Cookie 和返回体 */
function fakeRes() {
	const res = {
		cookie: '',
		code: 200,
		body: null as unknown,
		setHeader(name: string, value: string) {
			if (name === 'Set-Cookie') {
				res.cookie = value;
			}
			return res;
		},
		status(code: number) {
			res.code = code;
			return res;
		},
		json(body: unknown) {
			res.body = body;
			return res;
		},
		redirect() {
			return res;
		}
	};
	return res;
}

const withCookie = (cookie: string): AuthRequest => ({ip: '127.0.0.1', headers: {cookie: cookie.split(';')[0]}});

test('登录会话存盘:重启(新建 auth)后同一个 cookie 仍然有效;文件里只有 token 的哈希;登出、改口令后失效', () => {
	const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
	try {
		const options = {envPassword: 'pw-12345678', sessionFile: join(dir, 'auth-sessions.json'), authFile: join(dir, 'auth.json')};
		const first = createAuth(options);
		const res = fakeRes();
		first.login({ip: '127.0.0.1', body: {password: 'pw-12345678'}}, res);
		assert.equal(res.code, 200);
		const token = /sid=([0-9a-f]+)/.exec(res.cookie)![1]!;
		assert.ok(!readFileSync(options.sessionFile, 'utf8').includes(token), '文件里不存 token 原文');

		const restarted = createAuth(options);
		assert.equal(restarted.isAuthed(withCookie(res.cookie)), true, '重启后不用重新登录');
		assert.equal(restarted.isAuthed(withCookie('sid=deadbeef')), false);

		restarted.logout(withCookie(res.cookie), fakeRes());
		assert.equal(createAuth(options).isAuthed(withCookie(res.cookie)), false, '登出后重启也不恢复');

		// 改口令:其它会话全部失效,只留新签发的
		const again = createAuth(options);
		const a = fakeRes();
		again.login({ip: '127.0.0.1', body: {password: 'pw-12345678'}}, a);
		const b = fakeRes();
		again.login({ip: '127.0.0.1', body: {password: 'pw-12345678'}}, b);
		const changed = fakeRes();
		again.changePassword({...withCookie(a.cookie), body: {currentPassword: 'pw-12345678', newPassword: 'new-password-1'}}, changed);
		assert.equal(changed.code, 200);
		const after = createAuth(options);
		assert.equal(after.isAuthed(withCookie(b.cookie)), false);
		assert.equal(after.isAuthed(withCookie(changed.cookie)), true);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test('过期的会话重启后不恢复;不给 sessionFile 时只在内存', () => {
	const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
	try {
		let clock = 1_000_000;
		const options = {envPassword: 'pw-12345678', sessionFile: join(dir, 's.json'), ttlMs: 60_000, now: () => clock};
		const res = fakeRes();
		createAuth(options).login({ip: '127.0.0.1', body: {password: 'pw-12345678'}}, res);
		clock += 61_000;
		assert.equal(createAuth(options).isAuthed(withCookie(res.cookie)), false);

		const memory = fakeRes();
		createAuth({envPassword: 'pw-12345678'}).login({ip: '127.0.0.1', body: {password: 'pw-12345678'}}, memory);
		assert.equal(createAuth({envPassword: 'pw-12345678'}).isAuthed(withCookie(memory.cookie)), false);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});
