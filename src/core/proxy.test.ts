import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import zlib from 'node:zlib';
import {createProxyFetch, fillProxyTemplate, isProxyTemplate, maskProxyUrl, normalizeProxyUrl} from './proxy.ts';

test('代理地址:补协议和端口,SOCKS、别的协议、带路径的报错;脱敏只藏密码', () => {
	assert.equal(normalizeProxyUrl(''), '');
	assert.equal(normalizeProxyUrl('  '), '');
	assert.equal(normalizeProxyUrl('http://user-rotate:pw@p.example.io:80/'), 'http://user-rotate:pw@p.example.io:80');
	assert.equal(normalizeProxyUrl('user:pw@1.2.3.4:8080'), 'http://user:pw@1.2.3.4:8080');
	assert.equal(normalizeProxyUrl('proxy.example.io'), 'http://proxy.example.io:80');
	assert.equal(normalizeProxyUrl('https://proxy.example.io'), 'https://proxy.example.io:443');
	assert.equal(normalizeProxyUrl('http://u:p%40ss@h:1'), 'http://u:p%40ss@h:1', '密码里的特殊字符保持编码');
	assert.throws(() => normalizeProxyUrl('socks5://u:p@h:1080'), /SOCKS/);
	assert.throws(() => normalizeProxyUrl('ftp://h:21'), /不支持 ftp/);
	assert.throws(() => normalizeProxyUrl('http://h:80/path'), /不要带路径/);
	assert.throws(() => normalizeProxyUrl('http://'), /格式不对/);

	assert.equal(maskProxyUrl('http://user-rotate:pw@p.example.io:80'), 'http://user-rotate:****@p.example.io:80');
	assert.equal(maskProxyUrl('http://proxy.example.io:8080'), 'http://proxy.example.io:8080');
	assert.equal(maskProxyUrl(''), '');
});

interface Seen {
	method: string;
	url: string;
	auth: string;
	body: string;
	contentType: string;
}

/** 本地假代理:普通请求(HTTP 目标)由它直接当源站回;CONNECT(HTTPS 目标)只记下来就断开 */
async function fakeProxy(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
	const seen: Seen[] = [];
	const connects: Array<{target: string; auth: string}> = [];
	const server = http.createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) {
			body += chunk;
		}
		seen.push({method: String(req.method), url: String(req.url), auth: String(req.headers['proxy-authorization'] ?? ''), body, contentType: String(req.headers['content-type'] ?? '')});
		handle(req, res);
	});
	server.on('connect', (req, socket) => {
		connects.push({target: String(req.url), auth: String(req.headers['proxy-authorization'] ?? '')});
		socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	return {seen, connects, port, close: () => new Promise<void>(resolve => server.close(() => resolve()))};
}

test('走代理的 fetch:带代理认证、发绝对地址;解压、多个 Set-Cookie、手动/自动重定向、表单请求体', async () => {
	const proxy = await fakeProxy((req, res) => {
		const path = new URL(String(req.url)).pathname;
		if (path === '/gzip') {
			res.writeHead(200, {'content-encoding': 'gzip', 'content-type': 'application/json', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/']});
			res.end(zlib.gzipSync(JSON.stringify({ok: true})));
		} else if (path === '/moved') {
			res.writeHead(302, {location: '/gzip'});
			res.end();
		} else if (path === '/see-other') {
			res.writeHead(303, {location: 'http://example.test/echo'});
			res.end();
		} else {
			res.writeHead(200);
			res.end('echo');
		}
	});
	try {
		const proxyFetch = createProxyFetch(normalizeProxyUrl(`http://user-rotate:p%40ss@127.0.0.1:${proxy.port}`));

		const res = await proxyFetch('http://example.test/gzip', {headers: {Cookie: 'x=1'}});
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), {ok: true});
		assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
		assert.equal(proxy.seen[0]!.url, 'http://example.test/gzip', 'HTTP 目标给代理发绝对地址');
		assert.equal(proxy.seen[0]!.auth, 'Basic ' + Buffer.from('user-rotate:p@ss').toString('base64'), '密码按解码后的带');

		const manual = await proxyFetch('http://example.test/moved', {redirect: 'manual'});
		assert.deepEqual([manual.status, manual.headers.get('location')], [302, '/gzip']);
		assert.deepEqual([manual.url, manual.redirected], ['http://example.test/moved', false]);
		const followed = await proxyFetch('http://example.test/moved');
		assert.deepEqual(await followed.json(), {ok: true});
		assert.deepEqual([followed.url, followed.redirected], ['http://example.test/gzip', true], '和自带的 fetch 一样带上最终地址');
		assert.deepEqual([res.url, res.redirected], ['http://example.test/gzip', false]);

		const posted = await proxyFetch('http://example.test/see-other', {method: 'POST', body: new URLSearchParams({a: '1', b: '中'})});
		assert.equal(await posted.text(), 'echo');
		const [post, after] = proxy.seen.slice(-2);
		assert.deepEqual([post!.method, post!.body, post!.contentType], ['POST', 'a=1&b=%E4%B8%AD', 'application/x-www-form-urlencoded;charset=UTF-8']);
		assert.deepEqual([after!.method, after!.body], ['GET', ''], '303 之后改成不带请求体的 GET');

		// HTTPS 目标走 CONNECT 隧道,同样带认证;代理拒绝时报「通过代理请求失败」
		await assert.rejects(proxyFetch('https://store.example.test/account/'), /通过代理请求失败/);
		assert.deepEqual(proxy.connects, [{target: 'store.example.test:443', auth: 'Basic ' + Buffer.from('user-rotate:p@ss').toString('base64')}]);

		const controller = new AbortController();
		controller.abort();
		await assert.rejects(proxyFetch('http://example.test/gzip', {signal: controller.signal}), (err: Error) => err.name === 'AbortError');
	} finally {
		await proxy.close();
	}
});

test('代理地址模板:{n} 原样保留,打码时也保留;按编号填', () => {
	const template = normalizeProxyUrl('user-{n}:pw@p.example.io:80');
	assert.equal(template, 'http://user-{n}:pw@p.example.io:80');
	assert.ok(isProxyTemplate(template));
	assert.ok(!isProxyTemplate('http://user-rotate:pw@p.example.io:80'));
	assert.equal(maskProxyUrl(template), 'http://user-{n}:****@p.example.io:80');
	assert.equal(fillProxyTemplate(template, 42), 'http://user-42:pw@p.example.io:80');
});
