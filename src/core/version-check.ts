// 新版本提示:当前版本取 package.json,最新版本查 GitHub 仓库的最新 Release。只提示不自动更新——
// 部署是 Docker 从源码构建,更新要在服务器上执行 git pull && docker compose up -d --build。

/** 上次查成功后多久再查;查失败的话隔一会儿就重试 */
const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 10000;

export interface VersionStatus {
	current: string;
	/** 检查关了(UPDATE_CHECK=0) */
	disabled: boolean;
	/** 最新 Release 的版本号(去掉 tag 的 v);还没查到时没有 */
	latest?: string;
	hasUpdate: boolean;
	/** Release 的说明和页面地址 */
	notes?: string;
	url?: string;
	checkedAt?: string;
	/** 最近一次检查失败的原因 */
	error?: string;
}

export interface VersionCheckOptions {
	current: string;
	/** GitHub 仓库 owner/repo;空 = 不检查 */
	repo: string;
	fetch?: typeof fetch;
	now?: () => number;
}

/** 逐段比较数字版本号,缺位补 0:a 比 b 新返回正数 */
export function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(part => parseInt(part, 10) || 0);
	const pb = b.split('.').map(part => parseInt(part, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (diff) {
			return diff;
		}
	}
	return 0;
}

export function createVersionCheck(options: VersionCheckOptions) {
	const fetchImpl = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	let latest: {version: string; notes: string; url: string} | null = null;
	let checkedAt = 0;
	let error = '';
	let running: Promise<void> | null = null;

	function snapshot(): VersionStatus {
		const status: VersionStatus = {current: options.current, disabled: !options.repo, hasUpdate: false};
		if (latest) {
			Object.assign(status, {latest: latest.version, notes: latest.notes, url: latest.url});
			status.hasUpdate = compareVersions(latest.version, options.current) > 0;
		}
		if (checkedAt) {
			status.checkedAt = new Date(checkedAt).toISOString();
		}
		if (error) {
			status.error = error;
		}
		return status;
	}

	async function fetchLatest(): Promise<void> {
		try {
			const res = await fetchImpl(`https://api.github.com/repos/${options.repo}/releases/latest`, {
				headers: {accept: 'application/vnd.github+json', 'user-agent': 'steam-tools'},
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
			if (!res.ok) {
				throw new Error(res.status === 404 ? `${options.repo} 还没有发布 Release` : `GitHub 返回 HTTP ${res.status}`);
			}
			const release = await res.json() as {tag_name?: unknown; body?: unknown; html_url?: unknown};
			const version = String(release.tag_name || '').replace(/^v/i, '');
			if (!version) {
				throw new Error('GitHub 返回的 Release 没有版本号');
			}
			latest = {version, notes: String(release.body || '').trim(), url: String(release.html_url || '')};
			error = '';
		} catch (err) {
			error = (err as Error).name === 'TimeoutError' ? '连接 GitHub 超时' : (err as Error).message || String(err);
		} finally {
			checkedAt = now();
		}
	}

	/** 正在查就跟着等,不重复发请求;失败不抛错,原因记在 status().error */
	function refresh(): Promise<void> {
		running ??= fetchLatest().finally(() => {
			running = null;
		});
		return running;
	}

	/** 已知状态,立即返回;过期了顺手在后台再查一次 */
	function status(): VersionStatus {
		if (options.repo && !running && (!checkedAt || now() - checkedAt >= (error ? RETRY_MS : FRESH_MS))) {
			void refresh();
		}
		return snapshot();
	}

	/** 手动检查:不看缓存,查完再返回 */
	async function check(): Promise<VersionStatus> {
		if (options.repo) {
			await refresh();
		}
		return snapshot();
	}

	return {status, check};
}

export type VersionCheck = ReturnType<typeof createVersionCheck>;
