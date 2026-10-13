// 部署相关的 HTTP 设置(从 app/server.js 移来):反代信任、cookie 的 Secure、同源校验。

/**
 * TRUST_PROXY:不设 = loopback(只信任本机反代)。Docker 里反代经 bridge 网络进来,设 loopback,uniquelocal。
 * 也可以填 true / 跳数 / 网段,语义同 Express 的 'trust proxy'。
 */
export function parseTrustProxy(value: unknown): string | number | boolean {
	const text = String(value == null ? '' : value).trim();
	if (!text) {
		return 'loopback';
	}
	if (text === 'true') {
		return true;
	}
	if (text === 'false') {
		return false;
	}
	return /^\d+$/.test(text) ? Number(text) : text;
}

/** COOKIE_SECURE:1 总加 Secure;0 从不加;auto(默认)经 HTTPS(含反代转发)访问时才加 */
export function parseCookieSecure(value: unknown): boolean | 'auto' {
	const text = String(value == null ? '' : value).trim().toLowerCase();
	if (text === '1' || text === 'true') {
		return true;
	}
	if (text === '0' || text === 'false') {
		return false;
	}
	return 'auto';
}

function headerHostname(value: unknown): string {
	const first = String(value || '').split(',')[0]?.trim() ?? '';
	if (!first) {
		return '';
	}
	try {
		return new URL('http://' + first).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * 写操作和 WebSocket 握手的 CSRF 兜底:浏览器带了 Origin 时,它的主机名必须等于这次请求的 Host
 * (或反代转发的 X-Forwarded-Host),或者在 ALLOWED_ORIGINS(逗号分隔的完整 origin)里。
 * 没有 Origin(curl 等非浏览器)放行;跨站页面伪造不了这些请求头。Origin: null(沙箱 iframe / file://)拒绝。
 */
export function createOriginCheck(allowedOrigins: unknown): (headers: Record<string, unknown> | null | undefined) => boolean {
	const allowed = new Set(String(allowedOrigins || '').split(',').map(item => item.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean));
	return headers => {
		const origin = String((headers && headers.origin) || '').trim();
		if (!origin) {
			return true;
		}
		if (allowed.has(origin.replace(/\/+$/, '').toLowerCase())) {
			return true;
		}
		let originHost: string;
		try {
			originHost = new URL(origin).hostname.toLowerCase();
		} catch {
			return false;
		}
		const hosts = [headerHostname(headers?.host), headerHostname(headers?.['x-forwarded-host'])].filter(Boolean);
		return hosts.includes(originHost);
	};
}
