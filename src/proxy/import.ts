// 导入代理列表:每行一个,支持 host:port、host:port:user:pass、host:port@user:pass、user:pass@host:port,
// 每行可以带 http:// / https:// 前缀(没带的用默认协议)。webshare 下载的列表就是 host:port:user:pass。
// 空行、# 开头的行跳过;SOCKS5 暂不支持(Node 自带的代理只认 HTTP)。这里只拆,主机端口的校验在 ./index.ts。

import type {ProxyProtocol} from '../core/proxy.ts';

export interface ParsedProxyLine {
	/** 第几行(从 1 起) */
	line: number;
	protocol: ProxyProtocol;
	host: string;
	port: string;
	username: string;
	password: string;
}

/** 拆不开的行:只回行号(行里可能有密码,不原样回传) */
export interface ProxyLineError {
	line: number;
	error: string;
}

/** 「主机:端口」:端口是数字,主机不带冒号(IPv6 不支持这种写法) */
const HOST_PORT = /^([^:@\s]+):(\d{1,5})$/;
/** 看起来像主机名:有点、是 IP,或者 localhost */
const HOSTISH = /\.|^localhost$/i;

function credentials(text: string): {username: string; password: string} {
	const at = text.indexOf(':');
	return at < 0 ? {username: text, password: ''} : {username: text.slice(0, at), password: text.slice(at + 1)};
}

/** 一行拆成各项;不认识的格式返回错误原因 */
function parseLine(raw: string, fallback: ProxyProtocol): Omit<ParsedProxyLine, 'line'> | string {
	let text = raw.trim();
	let protocol = fallback;
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
	if (scheme) {
		const name = scheme[1]!.toLowerCase();
		if (name.startsWith('socks')) {
			return '暂不支持 SOCKS5 代理';
		}
		if (name !== 'http' && name !== 'https') {
			return `不支持 ${name} 协议`;
		}
		protocol = name;
		text = text.slice(scheme[0].length).replace(/\/+$/, '');
	}
	const at = text.lastIndexOf('@');
	if (at >= 0) {
		const left = text.slice(0, at);
		const right = text.slice(at + 1);
		const rightHost = HOST_PORT.exec(right);
		// 标准写法 user:pass@host:port 优先;右边不像主机端口、左边像的才是 host:port@user:pass
		if (rightHost && (HOSTISH.test(rightHost[1]!) || !HOST_PORT.test(left))) {
			return {protocol, host: rightHost[1]!, port: rightHost[2]!, ...credentials(left)};
		}
		const leftHost = HOST_PORT.exec(left);
		if (leftHost) {
			return {protocol, host: leftHost[1]!, port: leftHost[2]!, ...credentials(right)};
		}
		return '认不出主机和端口';
	}
	const parts = text.split(':');
	if (parts.length === 2 && HOST_PORT.test(text)) {
		return {protocol, host: parts[0]!, port: parts[1]!, username: '', password: ''};
	}
	if (parts.length >= 4 && /^\d{1,5}$/.test(parts[1]!)) {
		// host:port:user:pass,密码里有冒号的照原样拼回去
		return {protocol, host: parts[0]!, port: parts[1]!, username: parts[2]!, password: parts.slice(3).join(':')};
	}
	return '格式不对,应该像 host:port 或 host:port:user:pass';
}

export function parseProxyList(text: string, fallback: ProxyProtocol): {proxies: ParsedProxyLine[]; errors: ProxyLineError[]} {
	const proxies: ParsedProxyLine[] = [];
	const errors: ProxyLineError[] = [];
	String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			return;
		}
		const parsed = parseLine(line, fallback);
		if (typeof parsed === 'string') {
			errors.push({line: index + 1, error: parsed});
		} else {
			proxies.push({line: index + 1, ...parsed});
		}
	});
	return {proxies, errors};
}
