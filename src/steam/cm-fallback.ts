// Steam 目录服务(ISteamDirectory/GetCMListForConnect)不可达时,改用本地 WebSocket CM 列表。
// 会话管理和充值码兑换的临时登录都要用。

/** 国内服务器上 Steam 目录服务经常连不上,直连 cm0 */
export const LOCAL_CM_FALLBACKS: readonly unknown[] = Object.freeze([{
	endpoint: 'cm0.steampowered.com:443',
	type: 'websockets',
	realm: 'steamglobal',
	load: 0,
	wtd_load: 0
}]);

interface ApiRequestClient {
	_apiRequest?: (...args: unknown[]) => Promise<unknown>;
}

/** 给 steam-user 打补丁:取 CM 列表失败时返回 servers;每次用上备用列表都调一次 onFallback */
export function patchCmFallback(client: ApiRequestClient, servers: readonly unknown[], onFallback: () => void): void {
	if (typeof client._apiRequest !== 'function') {
		return;
	}
	const original = client._apiRequest.bind(client);
	client._apiRequest = async function patchedApiRequest(...args: unknown[]) {
		try {
			return await original(...args);
		} catch (err) {
			const [, iface, method] = args;
			if (iface === 'ISteamDirectory' && method === 'GetCMListForConnect') {
				onFallback();
				return {response: {serverlist: servers}};
			}
			throw err;
		}
	};
}
