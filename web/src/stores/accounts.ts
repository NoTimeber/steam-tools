// 账户列表:服务端名单(GET /api/accounts/list,不含密码,带分组)+ 账号资料(maFile、会话缓存)+ 实时会话(/api/attempts 和 attempt:update 推送)。
// 名单以服务端为准,浏览器里不存账号和密码。其它模块(库存、内购……)也从这里拿账号状态。

import {computed, reactive} from 'vue';
import {api, errorText} from '../api/http.ts';
import {socket} from '../api/socket.ts';
import type {AccountGroup, AccountGroupState, AccountProfile, GameId, PublicAttempt, PublicHistory, StoredAccount} from '../api/types.ts';
import {ALL_ACCOUNTS, NO_GROUP, collapseAttemptStatus, emptyFilters, lastErrorMessage, matchesFilters, matchesSearch, parseAccountText, sortAccounts} from '../lib/accounts.ts';
import type {AccountFilters, LoginStatus, SortKey, SortOrder} from '../lib/accounts.ts';
import {addLog} from './logs.ts';

export interface AccountRow {
	/** 账号名小写,作为行的 key */
	key: string;
	accountName: string;
	hasPassword: boolean;
	hasSharedSecret: boolean;
	hasMaFile: boolean;
	steamID: string;
	country: string;
	balance: number | null;
	currency: number | null;
	hasWallet: boolean;
	/** 所在分组的 id,未分组为 '' */
	groupId: string;
	status: LoginStatus;
	attemptId: string;
	cs2GcConnected: boolean;
	tf2GcConnected: boolean;
	activeGame: GameId;
	inventoryCount: number;
	lastError: string;
}

export const gameLabel = (game: GameId) => (game === 'tf2' ? 'TF2' : 'CS2');

const state = reactive({
	rows: [] as AccountRow[],
	loaded: false,
	loading: false,
	error: '',
	selected: new Set<string>(),
	/** 用户建的分组(按显示顺序) */
	groups: [] as AccountGroup[],
	/** 账户表的筛选、搜索、排序(sortKey 为 '' 时按名单顺序) */
	filters: emptyFilters() as AccountFilters,
	search: '',
	sortKey: '' as SortKey | '',
	sortOrder: 'ascend' as SortOrder,
	/** 正在等 Steam Guard 验证码的会话 */
	guard: null as null | {attemptId: string; accountName: string; type: string; domain: string; lastCodeWrong: boolean}
});

export const accounts = state;

function rowFromStored(stored: StoredAccount, previous?: AccountRow): AccountRow {
	return {
		key: stored.accountName.toLowerCase(),
		accountName: stored.accountName,
		hasPassword: stored.hasPassword,
		hasSharedSecret: stored.hasSharedSecret,
		hasMaFile: previous?.hasMaFile || stored.hasMaFile,
		steamID: previous?.steamID || stored.steamID || '',
		country: previous?.country || stored.country || '',
		balance: previous ? previous.balance : stored.balance,
		currency: previous ? previous.currency : stored.currency,
		hasWallet: previous ? previous.hasWallet : stored.hasWallet,
		groupId: stored.groupId || '',
		status: previous?.status ?? '未登录',
		attemptId: previous?.attemptId ?? '',
		cs2GcConnected: previous?.cs2GcConnected ?? false,
		tf2GcConnected: previous?.tf2GcConnected ?? false,
		activeGame: previous?.activeGame ?? 'cs2',
		inventoryCount: previous?.inventoryCount ?? 0,
		lastError: previous?.lastError ?? ''
	};
}

function findRow(name: string): AccountRow | undefined {
	const key = name.trim().toLowerCase();
	return state.rows.find(row => row.key === key);
}

/** 勾选只留表格里看得到的(删掉的、筛掉的、移到别的分组的都去掉),免得批量操作动到看不见的账号 */
function pruneSelection(): void {
	const keys = new Set(visibleRows.value.map(row => row.key));
	for (const key of [...state.selected]) {
		if (!keys.has(key)) {
			state.selected.delete(key);
		}
	}
}

/** 用服务端名单替换列表;已有行的运行态(登录状态、GC)保留 */
function applyList(list: StoredAccount[]): void {
	const previous = new Map(state.rows.map(row => [row.key, row]));
	state.rows = list.map(stored => rowFromStored(stored, previous.get(stored.accountName.toLowerCase())));
	pruneSelection();
}

/** 分组改了:正在筛的分组被删掉时回到全部 */
function applyGroups(groups: AccountGroup[]): void {
	state.groups = groups;
	const group = state.filters.group;
	if (group !== ALL_ACCOUNTS && group !== NO_GROUP && !groups.some(item => item.id === group)) {
		state.filters.group = ALL_ACCOUNTS;
	}
}

// ===== 读取 =====

export async function loadAccounts(): Promise<void> {
	state.loading = true;
	try {
		const data = await api.get<{accounts: StoredAccount[]; groups?: AccountGroup[]}>('/api/accounts/list');
		applyGroups(data.groups || []);
		applyList(data.accounts || []);
		state.error = '';
		state.loaded = true;
	} catch (err) {
		state.error = errorText(err);
		addLog('error', `读取账户名单失败: ${state.error}`);
		return;
	} finally {
		state.loading = false;
	}
	await Promise.all([refreshAttempts(), refreshMeta()]);
}

export async function refreshAttempts(): Promise<void> {
	try {
		const data = await api.get<{attempts: PublicAttempt[]}>('/api/attempts');
		for (const attempt of data.attempts || []) {
			mergeAttempt(attempt, {silent: true});
		}
	} catch {
		// 会话状态拿不到时先显示名单,推送到了再更新
	}
}

let metaVersion = 0;

/** 账号资料:maFile 里的 SteamID、缓存的国家和钱包 */
export async function refreshMeta(): Promise<void> {
	const accountNames = state.rows.map(row => row.accountName);
	if (!accountNames.length) {
		return;
	}
	const version = ++metaVersion;
	try {
		const data = await api.post<{accounts: Record<string, AccountProfile>}>('/api/accounts/meta', {accountNames});
		if (version !== metaVersion) {
			return;
		}
		for (const row of state.rows) {
			const meta = data.accounts?.[row.accountName];
			if (!meta) {
				continue;
			}
			if (!row.steamID && meta.steamId) {
				row.steamID = String(meta.steamId);
			}
			row.hasMaFile = !!meta.hasMaFile;
			if (meta.country) {
				row.country = meta.country;
			}
			if ((!row.hasWallet || row.balance == null) && meta.hasWallet) {
				row.hasWallet = true;
				row.balance = meta.balance;
				row.currency = meta.currency;
			}
		}
	} catch {
		// 资料补不全不影响使用
	}
}

// ===== 会话推送 =====

/** 后端会话 → 列表行。只更新名单里有的账号(后端保活着、但已从名单删掉的会话不显示) */
export function mergeAttempt(attempt: PublicAttempt, options: {silent?: boolean} = {}): void {
	if (!attempt || !attempt.id) {
		return;
	}
	const row = state.rows.find(item => item.attemptId === attempt.id) || findRow(attempt.accountName || '');
	if (row) {
		const previousStatus = row.status;
		const previousGc = {cs2: row.cs2GcConnected, tf2: row.tf2GcConnected};
		row.attemptId = attempt.id;
		row.status = collapseAttemptStatus(attempt.status, previousStatus);
		if (attempt.hasMaFile !== undefined) row.hasMaFile = !!attempt.hasMaFile;
		row.steamID = attempt.steamID || row.steamID;
		row.country = attempt.country || row.country;
		if (attempt.balance !== undefined) row.balance = attempt.balance;
		if (attempt.currency !== undefined) row.currency = attempt.currency;
		if (attempt.hasWallet !== undefined) row.hasWallet = !!attempt.hasWallet;
		if (attempt.cs2GcConnected !== undefined) row.cs2GcConnected = !!attempt.cs2GcConnected;
		if (attempt.tf2GcConnected !== undefined) row.tf2GcConnected = !!attempt.tf2GcConnected;
		if (attempt.activeGame) row.activeGame = attempt.activeGame === 'tf2' ? 'tf2' : 'cs2';
		if (attempt.inventoryCount !== undefined) row.inventoryCount = Number(attempt.inventoryCount || 0);
		if (!options.silent) {
			logTransitions(row, previousStatus, previousGc, attempt);
		}
	}

	if (attempt.guard) {
		state.guard = {
			attemptId: attempt.id,
			accountName: attempt.accountName,
			type: attempt.guard.type,
			domain: attempt.guard.domain || '',
			lastCodeWrong: !!attempt.guard.lastCodeWrong
		};
	} else if (state.guard?.attemptId === attempt.id) {
		state.guard = null;
	}
}

function logTransitions(row: AccountRow, previousStatus: LoginStatus, previousGc: {cs2: boolean; tf2: boolean}, attempt: PublicAttempt): void {
	if (row.status !== previousStatus) {
		if (row.status === '登录成功') {
			addLog('success', `${row.accountName}: 登录成功`);
		} else if (row.status === '登录失败') {
			const reason = lastErrorMessage(attempt.logs) || row.lastError;
			addLog('error', `${row.accountName}: 登录失败${reason ? ' - ' + reason : ''}`);
		}
	}
	for (const game of ['cs2', 'tf2'] as const) {
		const now = game === 'cs2' ? row.cs2GcConnected : row.tf2GcConnected;
		if (now !== previousGc[game]) {
			addLog(now ? 'success' : 'warn', `${row.accountName}: ${gameLabel(game)} GC ${now ? '连接成功' : '已断开'}`);
		}
	}
}

let started = false;

/** 进页面时调一次:读名单、订阅会话推送 */
export function startAccounts(): void {
	if (started) {
		return;
	}
	started = true;
	socket.on('attempt:update', (attempt: PublicAttempt) => mergeAttempt(attempt));
	// 断线重连后补一次全量状态(断开期间的推送收不到)
	socket.on('connect', () => {
		if (state.loaded) {
			refreshAttempts();
		}
	});
	loadAccounts();
}

// ===== 派生 =====

/** 表格里显示的账号:筛选、搜索后排好序;序号和「按序号勾选」都按这个顺序 */
export const visibleRows = computed(() => sortAccounts(
	state.rows.filter(row => matchesFilters(row, state.filters) && matchesSearch(row, state.search)),
	state.sortKey,
	state.sortOrder
));

export const onlineCount = computed(() => state.rows.filter(row => row.status === '登录成功').length);

export const selectedRows = computed(() => state.rows.filter(row => state.selected.has(row.key)));

// ===== 分组 =====

/** 改筛选条件(只改给了的);筛掉的账号取消勾选 */
export function setFilters(patch: Partial<AccountFilters>): void {
	Object.assign(state.filters, patch);
	pruneSelection();
}

export function resetFilters(): void {
	state.filters = emptyFilters();
	pruneSelection();
}

export function setSearch(search: string): void {
	state.search = search;
	pruneSelection();
}

export function setSort(key: SortKey | '', order: SortOrder = 'ascend'): void {
	state.sortKey = key;
	state.sortOrder = order;
}

export function groupName(groupId: string): string {
	return state.groups.find(group => group.id === groupId)?.name ?? '';
}

function applyGroupState(result: AccountGroupState): void {
	applyGroups(result.groups);
	applyList(result.accounts);
}

/** 新建分组(排在最后);给了账号就顺便移进去。出错抛给界面 */
export async function createGroup(name: string, rows: readonly AccountRow[] = []): Promise<AccountGroup> {
	const result = await api.post<AccountGroupState & {group: AccountGroup}>('/api/accounts/groups', {name, accountNames: rows.map(row => row.accountName)});
	applyGroupState(result);
	addLog('success', rows.length ? `已新建分组「${result.group.name}」,移入 ${rows.length} 个账户` : `已新建分组「${result.group.name}」`);
	return result.group;
}

export async function renameGroup(id: string, name: string): Promise<void> {
	applyGroupState(await api.post<AccountGroupState>(`/api/accounts/groups/${encodeURIComponent(id)}`, {name}));
}

/** 删分组:组里的账号变成未分组 */
export async function deleteGroup(id: string): Promise<void> {
	const name = groupName(id);
	applyGroupState(await api.delete<AccountGroupState>(`/api/accounts/groups/${encodeURIComponent(id)}`));
	addLog('success', `已删除分组「${name}」`);
}

export async function reorderGroups(ids: string[]): Promise<void> {
	applyGroupState(await api.post<AccountGroupState>('/api/accounts/group-order', {ids}));
}

/** 把账号移到分组,groupId 为 '' 移出分组;返回成没成功(失败记日志) */
export async function moveToGroup(rows: readonly AccountRow[], groupId: string): Promise<boolean> {
	if (!rows.length) {
		return true;
	}
	try {
		applyGroupState(await api.post<AccountGroupState>('/api/accounts/group-members', {accountNames: rows.map(row => row.accountName), groupId}));
		addLog('success', groupId ? `已把 ${rows.length} 个账户移到分组「${groupName(groupId)}」` : `已把 ${rows.length} 个账户移出分组`);
		return true;
	} catch (err) {
		addLog('error', `移动分组失败: ${errorText(err)}`);
		return false;
	}
}

// ===== 导入 =====

interface UpsertResult {
	added: number;
	updated: number;
	accounts: StoredAccount[];
}

/** 「账号----密码」文本导入;格式错误直接抛给界面显示 */
export async function importAccountText(text: string): Promise<void> {
	const rows = parseAccountText(text);
	const result = await api.post<UpsertResult>('/api/accounts/upsert', {accounts: rows.map(row => ({...row, source: 'import'}))});
	applyList(result.accounts);
	addLog('success', `导入账户完成: 新增 ${result.added}, 更新 ${result.updated}`);
	refreshMeta();
}

/** maFile 导入:整份(含 identity_secret)存服务端,账号并进名单 */
export async function importMaFiles(files: File[]): Promise<void> {
	const mafiles: Array<Record<string, unknown>> = [];
	const entries: Array<Record<string, unknown>> = [];
	for (const file of files) {
		try {
			const data = JSON.parse(await file.text()) as Record<string, unknown>;
			const accountName = String(data.account_name || data.accountName || file.name.replace(/\.(maFile|json)$/i, '')).trim();
			if (!accountName) {
				addLog('warn', `${file.name}: 缺少 account_name`);
				continue;
			}
			const sharedSecret = String(data.shared_secret || data.sharedSecret || '');
			if (!sharedSecret) {
				addLog('warn', `${accountName}: maFile 中没有 shared_secret`);
			}
			if (!data.account_name && !data.accountName) {
				data.account_name = accountName;
			}
			mafiles.push(data);
			entries.push({accountName, password: String(data.password || ''), sharedSecret, hasMaFile: true, source: 'maFile'});
		} catch (err) {
			addLog('error', `${file.name}: 读取 maFile 失败: ${errorText(err)}`);
		}
	}
	if (!mafiles.length) {
		return;
	}
	try {
		const saved = await api.post<{saved: number; results?: Array<{ok: boolean; hasIdentitySecret?: boolean}>}>('/api/mafile/import', {mafiles});
		const withIdentity = (saved.results || []).filter(result => result.ok && result.hasIdentitySecret).length;
		addLog('info', `maFile 已存到服务器: ${saved.saved} 个 (含 identity_secret: ${withIdentity})`);
	} catch (err) {
		addLog('warn', `maFile 服务端保存失败(发货确认可能受影响): ${errorText(err)}`);
	}
	try {
		const result = await api.post<UpsertResult>('/api/accounts/upsert', {accounts: entries});
		applyList(result.accounts);
		addLog('success', `导入 maFile 完成: 新增 ${result.added}, 更新 ${result.updated}`);
	} catch (err) {
		addLog('error', `导入 maFile 失败: ${errorText(err)}`);
	}
	refreshMeta();
}

// ===== 登录 / 登出 / 删除 =====

function markLoggedOut(row: AccountRow): void {
	row.status = '未登录';
	row.attemptId = '';
	row.cs2GcConnected = false;
	row.tf2GcConnected = false;
	row.activeGame = 'cs2';
	row.inventoryCount = 0;
	row.lastError = '';
}

/**
 * 登录。已在线/登录中的不重复发起(后端也会复用现有会话);force 强制重登(UU 发货页「登录账户」用)。
 * 密码在服务端名单里,浏览器不传
 */
export async function loginAccount(row: AccountRow, options: {force?: boolean} = {}): Promise<void> {
	if (!options.force && row.attemptId && (row.status === '登录成功' || row.status === '登录中')) {
		addLog('warn', `${row.accountName}: 已处于「${row.status}」状态,跳过重复登录(如需重连请先登出)`);
		return;
	}
	if (!row.hasPassword) {
		row.status = '登录失败';
		addLog('error', `${row.accountName}: 缺少密码,无法登录`);
		return;
	}
	row.status = '登录中';
	row.cs2GcConnected = false;
	row.tf2GcConnected = false;
	row.lastError = '';
	try {
		// remember 不传:服务端按名单里的设置(默认记住,重启后能免密恢复)
		const data = await api.post<{attempt: PublicAttempt}>('/api/login', {accountName: row.accountName, force: !!options.force});
		mergeAttempt(data.attempt);
	} catch (err) {
		row.status = '登录失败';
		row.lastError = errorText(err);
		addLog('error', `${row.accountName}: ${row.lastError}`);
	}
}

export async function logoutAccount(row: AccountRow): Promise<void> {
	if (row.attemptId) {
		try {
			const data = await api.post<{attempt: PublicAttempt}>(`/api/logout/${encodeURIComponent(row.attemptId)}`);
			mergeAttempt(data.attempt, {silent: true});
		} catch (err) {
			addLog('error', `${row.accountName}: ${errorText(err)}`);
			return;
		}
	}
	markLoggedOut(row);
	addLog('success', `${row.accountName}: 已下线`);
}

/** 依次登录/登出选中的账号(一个接一个,不并发,和旧版一样) */
export async function forSelected(action: (row: AccountRow) => Promise<void>): Promise<void> {
	const rows = selectedRows.value;
	if (!rows.length) {
		addLog('warn', '请先选择账户');
		return;
	}
	for (const row of rows) {
		await action(row);
	}
}

/** 删除选中:后端登出、移出会话表、删保存的 session,并从名单移除 */
export async function deleteSelected(): Promise<void> {
	const rows = selectedRows.value;
	if (!rows.length) {
		return;
	}
	try {
		const result = await api.post<{removedAttempts?: number; removedFiles?: number}>('/api/accounts/cleanup', {
			accounts: rows.map(row => ({accountName: row.accountName, attemptId: row.attemptId}))
		});
		addLog('success', `已删除 ${rows.length} 个账户`);
		if (result.removedAttempts || result.removedFiles) {
			addLog('info', `已清理后端会话:任务 ${result.removedAttempts || 0} 个、session ${result.removedFiles || 0} 个`);
		}
	} catch (err) {
		addLog('error', `删除账户失败: ${errorText(err)}`);
	}
	await loadAccounts();
}

// ===== GC / Steam Guard / 令牌 =====

export async function connectGc(row: AccountRow, game: GameId): Promise<void> {
	if (!row.attemptId) {
		addLog('warn', `${row.accountName}: 请先登录后再连接 ${gameLabel(game)} GC`);
		return;
	}
	try {
		const data = await api.post<{attempt: PublicAttempt}>(`/api/gc/connect/${encodeURIComponent(row.attemptId)}?game=${game}`, {game});
		mergeAttempt(data.attempt, {silent: true});
		addLog('success', `${row.accountName}: 已请求连接 ${gameLabel(game)} GC`);
	} catch (err) {
		addLog('error', `${row.accountName}: ${errorText(err)}`);
	}
}

export async function disconnectGc(row: AccountRow, game: GameId): Promise<void> {
	if (!row.attemptId) {
		addLog('warn', `${row.accountName}: 当前没有可断开的 ${gameLabel(game)} GC 任务`);
		return;
	}
	try {
		const data = await api.post<{attempt: PublicAttempt}>(`/api/gc/disconnect/${encodeURIComponent(row.attemptId)}?game=${game}`, {game});
		mergeAttempt(data.attempt, {silent: true});
		addLog('success', `${row.accountName}: 已请求断开 ${gameLabel(game)} GC`);
	} catch (err) {
		addLog('error', `${row.accountName}: ${errorText(err)}`);
	}
}

export async function submitGuardCode(code: string): Promise<void> {
	const guard = state.guard;
	if (!guard) {
		addLog('warn', '当前没有等待 Steam Guard 的任务');
		return;
	}
	const data = await api.post<{attempt: PublicAttempt}>(`/api/guard/${encodeURIComponent(guard.attemptId)}`, {code});
	mergeAttempt(data.attempt);
}

/** 消费记录:上次读取的结果或进度,没读过为 null */
export async function fetchHistory(accountName: string): Promise<PublicHistory | null> {
	const data = await api.get<{history: PublicHistory | null}>(`/api/accounts/history?accountName=${encodeURIComponent(accountName)}`);
	return data.history;
}

/** 开始读消费记录(服务端后台翻页,用 fetchHistory 轮询);读过的直接返回上次的,force 重读 */
export async function startHistory(accountName: string, force = false): Promise<PublicHistory> {
	const data = await api.post<{history: PublicHistory}>('/api/accounts/history', {accountName, force});
	return data.history;
}

/** 当前 GC 连着哪个游戏(两个都连着时算 TF2,和旧版一致) */
export function connectedGame(row: AccountRow): GameId | '' {
	if (row.tf2GcConnected) return 'tf2';
	if (row.cs2GcConnected) return 'cs2';
	return '';
}

export function canUseGc(row: AccountRow): boolean {
	return !!row.attemptId && row.status === '登录成功';
}
