// HTTP 代理的通用工具:代理地址校验和脱敏、走代理的 fetch、走代理的 request(steamcommunity / steamstore 用的 HTTP 库)。
//
// Node 自带的 fetch 不能按请求指定代理,这里用 node:http(s) 的 Agent(Node 24.5 起支持 proxyEnv:
// HTTPS 目标走 CONNECT 隧道,HTTP 目标发绝对地址;代理地址里的账号密码自动带成 Proxy-Authorization),
// 外面包一层和 fetch 一样的接口,调用方不用改。只实现了这里用到的部分:字符串 / URLSearchParams / 二进制请求体、
// redirect follow/manual、AbortSignal、gzip/deflate/br 解压。每个请求的收发字节数(估算:请求行 + 头 + 体、
// 状态行 + 头 + 解压前的体,不含 TLS 和 CONNECT 握手)可以报给 onTraffic,代理用量统计用。
// 只支持 HTTP 代理(http:// 或 https://),SOCKS 不支持。

import {createRequire} from 'node:module';
import http from 'node:http';
import https from 'node:https';
import {Readable, Transform} from 'node:stream';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);

const MAX_REDIRECTS = 20;

/** 代理地址里的编号占位符:固定 IP 模式下换成每个账号分到的编号(如 webshare 的 用户名-{n}) */
export const PROXY_INDEX_PLACEHOLDER = '{n}';
/** 解析 URL 时暂时代替 {n} 的记号({ } 会被 URL 编码掉;小写字母在用户名、主机名里都原样保留) */
const INDEX_MARK = 'zzproxyindexzz';

const withMark = (text: string) => text.split(PROXY_INDEX_PLACEHOLDER).join(INDEX_MARK);
const withPlaceholder = (text: string) => text.split(INDEX_MARK).join(PROXY_INDEX_PLACEHOLDER);

export function isProxyTemplate(proxyUrl: string): boolean {
	return proxyUrl.includes(PROXY_INDEX_PLACEHOLDER);
}

/** 把模板里的 {n} 换成编号 */
export function fillProxyTemplate(template: string, index: number): string {
	return template.split(PROXY_INDEX_PLACEHOLDER).join(String(index));
}

/**
 * 代理地址规范化:「http://用户:密码@主机:端口」,没写协议的按 http://;空串表示不用代理。
 * 可以带 {n} 编号占位符(原样保留)。不是 HTTP 代理、没有主机、带了路径的都报错(错误信息给人看)
 */
export function normalizeProxyUrl(raw: unknown): string {
	const text = withMark(String(raw ?? '').trim());
	if (!text) {
		return '';
	}
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error('代理地址格式不对,应该像 http://用户名:密码@主机:端口');
	}
	if (/^socks/i.test(url.protocol)) {
		throw new Error('暂不支持 SOCKS 代理,请填 HTTP 代理地址(http://...)');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`不支持 ${url.protocol.replace(':', '')} 代理,请填 HTTP 代理地址(http://...)`);
	}
	if (!url.hostname) {
		throw new Error('代理地址缺少主机');
	}
	if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
		throw new Error('代理地址只要协议、账号密码、主机和端口,不要带路径');
	}
	const auth = url.username ? `${url.username}${url.password ? ':' + url.password : ''}@` : '';
	// 端口总是写出来(URL 会把默认的 80 / 443 省掉,显示时看不出用的哪个端口)
	return withPlaceholder(`${url.protocol}//${auth}${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`);
}

export type ProxyProtocol = 'http' | 'https';

/** 代理地址拆开的各项;账号密码是解码后的原文 */
export interface ProxyParts {
	protocol: ProxyProtocol;
	host: string;
	port: number;
	username: string;
	password: string;
}

/** 拆开代理地址(先按 normalizeProxyUrl 校验,不对的抛错);{n} 原样保留 */
export function parseProxyUrl(raw: unknown): ProxyParts {
	const normalized = normalizeProxyUrl(raw);
	if (!normalized) {
		throw new Error('代理地址为空');
	}
	const url = new URL(withMark(normalized));
	return {
		protocol: url.protocol === 'https:' ? 'https' : 'http',
		host: withPlaceholder(url.hostname),
		port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
		username: withPlaceholder(decodeURIComponent(url.username)),
		password: withPlaceholder(decodeURIComponent(url.password))
	};
}

/** 各项拼成代理地址(账号密码 URL 编码,{n} 原样保留);没有主机为 '' */
export function buildProxyUrl(parts: ProxyParts): string {
	if (!parts.host) {
		return '';
	}
	const encode = (text: string) => withPlaceholder(encodeURIComponent(withMark(text)));
	const auth = parts.username ? `${encode(parts.username)}${parts.password ? ':' + encode(parts.password) : ''}@` : '';
	return `${parts.protocol}://${auth}${parts.host}:${parts.port}`;
}

/** 给人看的代理地址:密码换成 ****({n} 原样保留);解析不了返回空串 */
export function maskProxyUrl(proxyUrl: string): string {
	if (!proxyUrl) {
		return '';
	}
	try {
		const url = new URL(withMark(proxyUrl));
		const auth = url.username ? `${decodeURIComponent(url.username)}${url.password ? ':****' : ''}@` : '';
		return withPlaceholder(`${url.protocol}//${auth}${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`);
	} catch {
		return '';
	}
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function requestBody(body: FetchInit['body'], headers: Headers): Buffer | undefined {
	if (body == null) {
		return undefined;
	}
	if (typeof body === 'string') {
		if (!headers.has('content-type')) {
			headers.set('content-type', 'text/plain;charset=UTF-8');
		}
		return Buffer.from(body);
	}
	if (body instanceof URLSearchParams) {
		if (!headers.has('content-type')) {
			headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
		}
		return Buffer.from(body.toString());
	}
	if (body instanceof ArrayBuffer) {
		return Buffer.from(body);
	}
	if (ArrayBuffer.isView(body)) {
		return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	}
	throw new TypeError('走代理的请求不支持这种请求体');
}

function decoded(res: http.IncomingMessage, raw: Readable): Readable {
	switch (String(res.headers['content-encoding'] || '').trim().toLowerCase()) {
		case 'gzip':
		case 'x-gzip':
			return raw.pipe(zlib.createGunzip());
		case 'deflate':
			return raw.pipe(zlib.createInflate());
		case 'br':
			return raw.pipe(zlib.createBrotliDecompress());
		default:
			return raw;
	}
}

/** 原样转发,顺便数字节 */
function byteCounter(): Transform & {bytes: number} {
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			counter.bytes += chunk.length;
			callback(null, chunk);
		}
	}) as Transform & {bytes: number};
	counter.bytes = 0;
	return counter;
}

/** 请求行 + 头的字节数(估算) */
function requestHeadBytes(url: URL, method: string, headers: Record<string, string>): number {
	let size = Buffer.byteLength(`${method} ${url.pathname}${url.search} HTTP/1.1\r\nhost: ${url.host}\r\n\r\n`);
	for (const [key, value] of Object.entries(headers)) {
		size += Buffer.byteLength(`${key}: ${value}\r\n`);
	}
	return size;
}

/** 状态行 + 头的字节数(估算) */
function responseHeadBytes(res: http.IncomingMessage): number {
	let size = Buffer.byteLength(`HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\n\r\n`);
	for (let index = 0; index < res.rawHeaders.length; index += 2) {
		size += Buffer.byteLength(`${res.rawHeaders[index]}: ${res.rawHeaders[index + 1]}\r\n`);
	}
	return size;
}

async function readAll(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** 一个请求的收发字节数(估算) */
export interface ProxyTraffic {
	url: string;
	sent: number;
	received: number;
}

export interface ProxyFetchOptions {
	keepAlive?: boolean;
	/** 每个请求收完响应时报一次(跳转的每一跳各算一次);请求失败的不报 */
	onTraffic?: (traffic: ProxyTraffic) => void;
}

/**
 * 走指定 HTTP 代理的 fetch。每次调用建一套自己的 Agent:keepAlive 时同一个 fetch 的请求复用连接,
 * 轮换代理(每个新连接换一个出口 IP)下也就是同一个出口 IP;想让谁和谁分开 IP,就给谁各建一个
 */
export function createProxyFetch(proxyUrl: string, options: ProxyFetchOptions = {}): typeof fetch {
	// @types/node 还没有 proxyEnv 这个选项
	const agentOptions = (env: Record<string, string>) => ({keepAlive: options.keepAlive ?? true, proxyEnv: env}) as http.AgentOptions;
	const agents = {
		'http:': new http.Agent(agentOptions({HTTP_PROXY: proxyUrl})),
		'https:': new https.Agent(agentOptions({HTTPS_PROXY: proxyUrl}))
	};

	function once(url: URL, method: string, headers: Headers, body: Buffer | undefined, signal: AbortSignal | undefined): Promise<Response> {
		return new Promise((resolve, reject) => {
			const agent = agents[url.protocol as 'http:' | 'https:'];
			if (!agent) {
				reject(new TypeError(`不支持的地址: ${url.href}`));
				return;
			}
			const outgoing: Record<string, string> = {};
			headers.forEach((value, key) => {
				outgoing[key] = value;
			});
			if (!headers.has('accept-encoding')) {
				outgoing['accept-encoding'] = 'gzip, deflate, br';
			}
			if (body) {
				outgoing['content-length'] = String(body.length);
			}
			const sent = requestHeadBytes(url, method, outgoing) + (body?.length ?? 0);
			const request = (url.protocol === 'https:' ? https : http).request(url, {method, headers: outgoing, agent, signal}, res => {
				const counter = byteCounter();
				readAll(decoded(res, res.pipe(counter))).then(buffer => {
					options.onTraffic?.({url: url.href, sent, received: responseHeadBytes(res) + counter.bytes});
					const responseHeaders = new Headers();
					for (const [key, value] of Object.entries(res.headers)) {
						// 已经解压过,长度和编码头不再对得上
						if (value == null || key === 'content-encoding' || key === 'content-length') {
							continue;
						}
						for (const item of Array.isArray(value) ? value : [value]) {
							responseHeaders.append(key, item);
						}
					}
					const status = res.statusCode ?? 0;
					resolve(new Response(NULL_BODY_STATUS.has(status) ? null : buffer, {status, statusText: res.statusMessage, headers: responseHeaders}));
				}, reject);
			});
			request.on('error', err => reject(signal?.aborted ? err : new TypeError(`通过代理请求失败: ${err.message}`, {cause: err})));
			request.end(body);
		});
	}

	return async function proxyFetch(input: FetchInput, init: FetchInit = {}): Promise<Response> {
		let url = new URL(input instanceof Request ? input.url : String(input));
		let method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
		const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
		let body = requestBody(init.body, headers);
		const signal = init.signal ?? undefined;
		for (let hop = 0; ; hop++) {
			const response = await once(url, method, headers, body, signal);
			const location = response.headers.get('location');
			if (init.redirect === 'manual' || !location || response.status < 300 || response.status >= 400 || response.status === 304) {
				return response;
			}
			if (init.redirect === 'error') {
				throw new TypeError(`请求被重定向到 ${location}`);
			}
			if (hop >= MAX_REDIRECTS) {
				throw new TypeError('重定向次数过多');
			}
			// 和浏览器一样:303,或 301/302 的 POST,改成不带请求体的 GET
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
				method = 'GET';
				body = undefined;
				headers.delete('content-type');
			}
			url = new URL(location, url);
		}
	};
}

/**
 * steamcommunity / steamstore 的 HTTP 库(request)走代理的实例,传给它们的 request 选项。
 * 每个实例自己一个连接池(request 默认全进程共用),不同账号的连接不会混用、出口 IP 不会被串到一起
 */
export function createProxyRequest(proxyUrl: string): unknown {
	// request 是 steamcommunity 的依赖,从它那里解析,不依赖 node_modules 的提升方式
	const request = createRequire(require.resolve('steamcommunity'))('request') as {defaults(options: Record<string, unknown>): unknown};
	return request.defaults({forever: true, proxy: proxyUrl, pool: {}});
}
