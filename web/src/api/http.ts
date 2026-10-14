// 调后端接口:统一处理未登录(跳登录页)和 {success: false, error} 形式的错误。

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

/** 会话失效时回登录页(登录页在服务端,不在前端路由里);登录后回到首页 */
export function redirectToLogin(): void {
	window.location.href = '/login';
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
	const init: RequestInit = {method, headers: {}, cache: 'no-store'};
	if (body !== undefined) {
		init.headers = {'content-type': 'application/json'};
		init.body = JSON.stringify(body);
	}
	const res = await fetch(url, init);
	if (res.status === 401) {
		redirectToLogin();
		throw new ApiError('未登录', 401, null);
	}
	const data = await res.json().catch(() => ({})) as {success?: boolean; error?: string};
	if (!res.ok || data.success === false) {
		throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data);
	}
	return data as T;
}

export const api = {
	get: <T>(url: string) => request<T>('GET', url),
	post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
	delete: <T>(url: string, body: unknown = {}) => request<T>('DELETE', url, body)
};

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
