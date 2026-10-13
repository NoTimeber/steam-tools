'use strict';

// 未登录(会话失效)时统一跳转登录页
function redirectToLogin() {
	if (!/\/login(?:\.html)?$/.test(window.location.pathname)) {
		window.location.href = '/login';
	}
}

const socket = io();
socket.on('connect_error', (err) => {
	if (err && /unauthorized/i.test(err.message || '')) {
		redirectToLogin();
	}
});
const $ = (id) => document.getElementById(id);

// ============================================================
// 主题化提示系统：toast 轻提示 + confirm/alert 弹窗
// 替代原生 window.alert / window.confirm，与深色主题统一。
// 均为函数声明（会被提升），调用点不受定义位置限制。
// ============================================================
function ensureToastHost() {
	let host = document.getElementById('toast-host');
	if (!host) {
		host = document.createElement('div');
		host.id = 'toast-host';
		host.className = 'toast-host';
		document.body.appendChild(host);
	}
	return host;
}

// 轻提示。type: 'info' | 'success' | 'warn' | 'error'
function toast(message, type = 'info', opts = {}) {
	const host = ensureToastHost();
	const el = document.createElement('div');
	el.className = 'toast toast-' + type;

	const iconEl = document.createElement('span');
	iconEl.className = 'toast-icon';
	iconEl.textContent = ({success: '✓', error: '✕', warn: '!', info: 'i'})[type] || 'i';

	const msgEl = document.createElement('span');
	msgEl.className = 'toast-msg';
	msgEl.textContent = String(message == null ? '' : message);

	const closeEl = document.createElement('button');
	closeEl.type = 'button';
	closeEl.className = 'toast-close';
	closeEl.setAttribute('aria-label', '关闭');
	closeEl.textContent = '×';

	el.append(iconEl, msgEl, closeEl);
	host.appendChild(el);
	requestAnimationFrame(() => el.classList.add('show'));

	const duration = opts.duration != null ? opts.duration : (type === 'error' ? 6000 : 3600);
	let timer = null;
	let closing = false;
	const dismiss = () => {
		if (closing) return;
		closing = true;
		if (timer) { clearTimeout(timer); timer = null; }
		el.classList.remove('show');
		el.classList.add('hide');
		setTimeout(() => el.remove(), 220);
	};
	const arm = (ms) => { if (ms > 0) timer = setTimeout(dismiss, ms); };
	closeEl.addEventListener('click', dismiss);
	el.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
	el.addEventListener('mouseleave', () => { if (!closing) arm(1600); });
	arm(duration);
	return el;
}

// 主题化弹窗（confirm/alert 通用）。返回 Promise<boolean>：确定=true，取消/关闭=false。
function openDialog(opts = {}) {
	const {
		title = '提示',
		message = '',
		detail = '',
		confirmText = '确定',
		cancelText = '取消',
		danger = false,
		showCancel = true,
		copyDetail = false
	} = opts;
	return new Promise((resolve) => {
		const safe = (s) => String(s == null ? '' : s);
		const backdrop = document.createElement('div');
		backdrop.className = 'app-dialog-backdrop';

		const dialog = document.createElement('section');
		dialog.className = 'app-dialog';
		dialog.setAttribute('role', showCancel ? 'alertdialog' : 'dialog');
		dialog.setAttribute('aria-modal', 'true');

		const header = document.createElement('header');
		const titleEl = document.createElement('h2');
		titleEl.className = 'app-dialog-title';
		titleEl.textContent = safe(title);
		header.appendChild(titleEl);

		const body = document.createElement('div');
		body.className = 'app-dialog-body';
		const msgEl = document.createElement('p');
		msgEl.className = 'app-dialog-message';
		msgEl.textContent = safe(message);
		body.appendChild(msgEl);

		if (detail) {
			const pre = document.createElement('pre');
			pre.className = 'app-dialog-detail';
			pre.textContent = safe(detail);
			body.appendChild(pre);
			if (copyDetail) {
				const copyBtn = document.createElement('button');
				copyBtn.type = 'button';
				copyBtn.className = 'app-dialog-copy';
				copyBtn.textContent = '复制';
				copyBtn.addEventListener('click', async () => {
					try {
						await navigator.clipboard.writeText(safe(detail));
						copyBtn.textContent = '已复制';
						setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
					} catch (_) {
						const range = document.createRange();
						range.selectNodeContents(pre);
						const sel = window.getSelection();
						sel.removeAllRanges();
						sel.addRange(range);
					}
				});
				body.appendChild(copyBtn);
			}
		}

		const actions = document.createElement('footer');
		actions.className = 'app-dialog-actions';
		let cancelBtn = null;
		if (showCancel) {
			cancelBtn = document.createElement('button');
			cancelBtn.type = 'button';
			cancelBtn.textContent = cancelText;
			actions.appendChild(cancelBtn);
		}
		const okBtn = document.createElement('button');
		okBtn.type = 'button';
		okBtn.className = danger ? 'danger-btn' : 'primary';
		okBtn.textContent = confirmText;
		actions.appendChild(okBtn);

		dialog.append(header, body, actions);
		backdrop.appendChild(dialog);

		let done = false;
		const close = (result) => {
			if (done) return;
			done = true;
			document.removeEventListener('keydown', onKey, true);
			backdrop.classList.remove('show');
			setTimeout(() => backdrop.remove(), 200);
			resolve(result);
		};
		const onKey = (e) => {
			if (e.key === 'Escape') { e.preventDefault(); close(false); }
			else if (e.key === 'Enter') { e.preventDefault(); close(true); }
		};
		if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
		okBtn.addEventListener('click', () => close(true));
		backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(false); });
		document.addEventListener('keydown', onKey, true);

		document.body.appendChild(backdrop);
		requestAnimationFrame(() => {
			backdrop.classList.add('show');
			okBtn.focus();
		});
	});
}

// confirm 替代：返回 Promise<boolean>
function confirmDialog(message, opts = {}) {
	return openDialog(Object.assign({title: '请确认', message, confirmText: '确定', cancelText: '取消'}, opts));
}
// alert 替代（需用户阅读/复制内容时使用）：点“知道了”后 resolve
function alertDialog(message, opts = {}) {
	return openDialog(Object.assign({title: '提示', message, showCancel: false, confirmText: '知道了'}, opts));
}

const STORAGE_KEY = 'steam-login-replica.accounts';
const LOG_STORAGE_KEY = 'steam-login-replica.logLines';
// 单个商品的购买数量安全上限。实际可买数量由账号余额决定，这里仅作兜底，须与后端 PURCHASE_MAX_ITEM_QUANTITY 保持一致。
const PURCHASE_MAX_ITEM_QUANTITY = 9999;

// 账户分类：未在线 / 在线 / GC 已连接。顺序即列表中分组从上到下的展示顺序。
// 必须在 init()（调用 renderAccounts）之前声明，否则会触发 const 暂时性死区错误。
const ACCOUNT_GROUPS = [
	{key: 'gc', title: 'GC 已连接', tone: 'ok'},
	{key: 'online', title: '在线', tone: 'ok'},
	{key: 'offline', title: '未在线', tone: ''}
];

const state = {
	accounts: loadAccounts(),
	accountOrder: [],
	selected: new Set(),
	attemptToAccount: new Map(),
	attemptLogCount: new Map(),
	activeGuardAttempt: null,
	activeModule: 'accounts',
	terminalOpener: {selectedKey: '', terminals: [], loading: false, error: '', typeFilter: 'all', stateFilter: 'all'},
	logLines: loadLogLines(),
	metaSyncVersion: 0,
	dismissedAttemptIds: new Set(),
	dismissedAccountNames: new Set(),
	accountGroups: {
		collapsed: new Set()
	},
	gcPopover: {
		accountId: '',
		left: 0,
		top: 0
	},
	totp: {
		accountId: '',
		accountName: '',
		code: '',
		expiresIn: 0,
		loading: false,
		error: '',
		timer: null
	},
	inventory: {
		selectedAccountId: '',
		selectedItemAssetId: '',
		loadedAccountId: '',
		items: [],
		categoryFilter: 'all',
		terminal: null,
		raw: null,
		fetchedAt: '',
		source: '',
		error: '',
		loading: false,
		version: 0
	},
	purchase: {
		game: 'cs2',
		gameLabel: 'CS2',
		accounts: [],
		items: [],
		tasks: [],
		cartByGame: {
			cs2: {},
			tf2: {}
		},
		selectedAccounts: new Set(),
		collapsedCategories: new Set(),
		priceModal: {
			itemDefIndex: null,
			currentCurrencyISO: 'USD'
		},
		rates: {},
		ratesSource: '',
		ratesFetchedAt: '',
		itemSearch: '',
		itemsFetchedAt: '',
		accountError: '',
		itemError: '',
		loadingAccounts: false,
		loadingItems: false,
		submitting: false,
		accountVersion: 0,
		itemVersion: 0
	},
	buygame: {
		accounts: [],
		selectedAccounts: new Set(),
		games: [],            // [{packageId, name, priceCents, currencyISO, appid, resolving, error}]
		tasks: [],
		loadingAccounts: false,
		accountError: '',
		submitting: false,
		pricedFor: ''         // 当前游戏价格按哪个账号(attemptId)的区域解析,用于换号后自动重算
	},
	marketBuyorder: {
		accounts: [],
		selectedAccounts: new Set(),
		loadingAccounts: false,
		accountError: '',
		context: null,        // 行情参考 {itemName, highestBuyOrderCents, lowestSellOrderCents, medianPrice, volume, currency, currencyISO}
		contextLoading: false,
		contextError: '',
		orders: [],           // 本工具挂出的求购单(后端账本,全量)
		// 面板当前显示哪几条:null=不显示(刚进模块,还没挂单也没刷新)。
		// 账本是全量持久化的,但面板只显示「本次挂出的这一批」或「本次刷新对过账的账号」,
		// 免得一进来就把历史全铺出来、一点刷新就报一堆账号未在线。
		visibleOrderIds: null,
		placing: false
	},
	uu: {
		accounts: [],
		selectedAccount: '',
		pollIntervalMs: 0,
		loading: false,
		pendingRefresh: null, // 刷新撞车时排队的那次刷新(见 refreshUuState)
		loaded: false,
		error: '',
		login: null,
		tokens: [],
		tokenLoaded: false
	},
	wallet: {
		jobId: '',
		running: false,
		results: [],
		jobIndexMap: []
	}
};

const mafileInput = $('mafile');
const logs = $('logs');
const logsToBottomBtn = $('logs-to-bottom');

init();

function init() {
	bindSocket();
	bindNavigation();
	bindActions();
	renderLogs();
	renderAccounts();
	renderInventory();
	renderPurchase();
	renderUu();
	renderMarketBuyorder();
	renderTerminalOpener();
	renderWallet();
	bindUpdateChecker();
	bootstrapAccounts();
}

// 先与服务端名单对齐,再拉取元数据/运行态,避免运行态合并进随后被替换的旧列表。
async function bootstrapAccounts() {
	await syncAccountsFromServer();
	accountsSyncReady = true;   // 此后 saveAccounts() 才会把改动推回服务端
	refreshAccountMeta();
	refreshRuntimeAttempts();
}

function bindSocket() {
	socket.on('connect', () => {
		$('server-state').textContent = '已连接';
		$('server-state').className = 'status';
	});

	socket.on('disconnect', () => {
		$('server-state').textContent = '已断开';
		$('server-state').className = 'status muted';
	});

	socket.on('attempt:update', attempt => {
		mergeAttempt(attempt);
		schedulePurchaseAccountsRefresh();   // 账户状态变化时，若在内购页则自动刷新可选账户
		if (state.activeModule === 'buygame' && !state.buygame.loadingAccounts) {
			refreshBuyGameAccounts({silent: true});
		}
		if (state.activeModule === 'market-buyorder' && !state.marketBuyorder.loadingAccounts) {
			refreshMarketAccounts({silent: true});
		}
		if (state.activeModule === 'terminal-opener') {
			renderTerminalOpener();   // GC 连接状态变化时刷新账户列表
		}
	});

	socket.on('purchase:task-created', task => {
		mergePurchaseTask(task, 'created');
	});

	socket.on('purchase:task-updated', task => {
		mergePurchaseTask(task, 'updated');
	});

	socket.on('purchase:task-completed', task => {
		mergePurchaseTask(task, 'completed');
	});

	socket.on('buygame:task-created', task => mergeBuyGameTask(task));
	socket.on('buygame:task-updated', task => mergeBuyGameTask(task));
	socket.on('buygame:task-completed', task => mergeBuyGameTask(task, true));

	socket.on('uu:update', account => {
		mergeUuAccount(account);
	});

	socket.on('uu:log', payload => {
		if (!payload) return;
		addLine(payload.level || 'info', '[UU·' + (payload.accountName || '') + '] ' + (payload.message || ''));
	});

	socket.on('wallet:redeem', payload => {
		handleWalletRedeemUpdate(payload);
	});
}

async function refreshRuntimeAttempts() {
	try {
		const data = await getJson('/api/attempts');
		for (const attempt of data.attempts || []) {
			mergeAttempt(attempt, '', {silent: true});
		}
	} catch {}
}

// ===== 远程更新提示 =====
let dismissedUpdateVersion = '';

function bindUpdateChecker() {
	const restartBtn = $('update-restart-btn');
	const dismissBtn = $('update-dismiss-btn');
	if (restartBtn) restartBtn.addEventListener('click', applyUpdateRestart);
	if (dismissBtn) dismissBtn.addEventListener('click', () => {
		const banner = $('update-banner');
		dismissedUpdateVersion = (banner && banner.dataset.version) || '';
		hideUpdateBanner();
	});
	// 启动时读一次状态(launcher 已在冷启动检查过)；之后不再频繁轮询，
	// 由「运行设置 → 检查更新」按钮手动触发真实的联网检查。
	checkUpdateStatus();
}

// 手动检查更新：POST /api/update/check，由后端经 IPC 委托 launcher 执行真实的联网拉取，
// 完成后返回 launcher 写入的状态。
async function manualCheckUpdate() {
	const btn = $('check-update-btn');
	if (btn) {
		btn.disabled = true;
		btn.textContent = '检查中…';
	}
	try {
		const data = await postJson('/api/update/check', {});
		const status = data.status || {};
		setAppVersion(status.current);
		if (status.pending && status.available) {
			dismissedUpdateVersion = '';   // 手动检查后即便之前忽略过也重新提示
			showUpdateBanner(status);
			toast('发现新版本 v' + status.available + '，可在顶部横幅点“立即重启生效”', 'success');
		} else if (data.checked === false) {
			toast(data.message || '正在后台检查，稍后将自动提示', 'info');
			scheduleDelayedUpdatePolls();   // 大包仍在后台下载，稍后补查几次
		} else {
			hideUpdateBanner();
			toast('已是最新版本' + (status.current ? '（v' + status.current + '）' : ''), 'success');
		}
	} catch (err) {
		toast('检查更新失败：' + err.message, 'error');
	} finally {
		if (btn) {
			btn.disabled = false;
			btn.textContent = '检查更新';
		}
	}
}

// 手动检查若因大包下载超时返回，后台 launcher 仍在暂存；每 10s 补查一次状态，持续约 1 分钟。
function scheduleDelayedUpdatePolls() {
	let count = 0;
	const timer = setInterval(() => {
		count++;
		checkUpdateStatus();
		if (count >= 6) {
			clearInterval(timer);
		}
	}, 10000);
}

// 左上角版本标识:复用更新状态里的 current(launcher 写入 update-status.json)。
function setAppVersion(version) {
	const el = $('app-version');
	if (!el) {
		return;
	}
	const v = version == null ? '' : String(version).trim();
	el.textContent = v ? ('v' + v) : '';
}

async function checkUpdateStatus() {
	try {
		const data = await getJson('/api/update/status');
		const status = data.status || {};
		setAppVersion(status.current);
		if (status.pending && status.available && status.available !== dismissedUpdateVersion) {
			showUpdateBanner(status);
		} else if (!status.pending) {
			hideUpdateBanner();
		}
	} catch {}
}

function showUpdateBanner(status) {
	const banner = $('update-banner');
	if (!banner) return;
	const text = $('update-banner-text');
	if (text) {
		const cur = status.current ? ('当前 v' + status.current + ' → ') : '';
		text.textContent = cur + '新版 v' + status.available + ' 已下载，重启后生效。';
	}
	// 更新内容直接显示在横幅里（可换行/滚动），没有说明时隐藏该区域。
	const notesEl = $('update-banner-notes');
	if (notesEl) {
		const notes = status.notes ? String(status.notes).trim() : '';
		notesEl.textContent = notes ? ('更新内容：' + notes) : '';
		notesEl.hidden = !notes;
	}
	banner.dataset.version = status.available;
	banner.hidden = false;
}

function hideUpdateBanner() {
	const banner = $('update-banner');
	if (banner) banner.hidden = true;
}

async function applyUpdateRestart() {
	const restartBtn = $('update-restart-btn');
	const dismissBtn = $('update-dismiss-btn');
	const text = $('update-banner-text');
	if (restartBtn) restartBtn.disabled = true;
	if (dismissBtn) dismissBtn.disabled = true;
	if (text) text.textContent = '正在重启以应用更新，请稍候…';
	try {
		await postJson('/api/update/restart', {});
	} catch {
		// 后端可能已退出导致响应中断,属正常,继续探活
	}
	setTimeout(() => waitServerBackAndReload(0), 1500);
}

async function waitServerBackAndReload(attempt) {
	if (attempt > 60) {   // 最多等 ~60s
		const text = $('update-banner-text');
		if (text) text.textContent = '重启耗时较久,请稍后手动刷新页面。';
		return;
	}
	try {
		const res = await fetch('/api/health', {cache: 'no-store'});
		if (res.ok) { window.location.reload(); return; }
	} catch {}
	setTimeout(() => waitServerBackAndReload(attempt + 1), 1000);
}

function bindNavigation() {
	document.querySelectorAll('.module').forEach(button => {
		button.addEventListener('click', () => {
			activateModule(button.dataset.module);
		});
	});
}

function bindActions() {
	// UU Token 弹窗
	const uuGetTokenBtn = $('uu-get-token-btn');
	if (uuGetTokenBtn) uuGetTokenBtn.addEventListener('click', () => openUuTokenModal(''));
	const uuPollSaveBtn = $('uu-poll-save-btn');
	if (uuPollSaveBtn) uuPollSaveBtn.addEventListener('click', saveUuPollInterval);
	const uuModalClose = $('uu-modal-close');
	if (uuModalClose) uuModalClose.addEventListener('click', closeUuTokenModal);
	const uuModalOverlay = $('uu-modal-overlay');
	if (uuModalOverlay) uuModalOverlay.addEventListener('click', closeUuTokenModal);
	const uuModalBody = $('uu-modal-body');
	if (uuModalBody) {
		uuModalBody.addEventListener('click', ev => {
			const btn = ev.target.closest('[data-uu-action]') || ev.target.closest('#uu-modal-bind-btn');
			if (!btn) return;
			if (btn.id === 'uu-modal-bind-btn') {
				const tokenEl = document.getElementById('uu-modal-token');
				const token = tokenEl ? tokenEl.value.trim() : '';
				if (token) bindUuTokenInModal(state.uu.selectedAccount, token);
			} else if (btn.dataset.uuAction === 'login-start') {
				handleUuTokenLoginStart(btn);
			} else if (btn.dataset.uuAction === 'login-verify') {
				handleUuTokenLoginVerify(btn);
			}
		});
	}

	$('import-accounts-btn').addEventListener('click', openImportModal);
	$('import-mafile-btn').addEventListener('click', () => mafileInput.click());
	mafileInput.addEventListener('change', importMafiles);
	const logoutAppBtn = $('logout-app-btn');
	if (logoutAppBtn) {
		logoutAppBtn.addEventListener('click', async () => {
			try {
				await fetch('/api/auth/logout', {method: 'POST'});
			} catch (err) {
				// ignore
			}
			window.location.href = '/login';
		});
	}

	const checkUpdateBtn = $('check-update-btn');
	if (checkUpdateBtn) {
		checkUpdateBtn.addEventListener('click', manualCheckUpdate);
	}

	const changePasswordBtn = $('change-password-btn');
	if (changePasswordBtn) {
		changePasswordBtn.addEventListener('click', openChangePasswordModal);
		$('change-password-close').addEventListener('click', closeChangePasswordModal);
		$('change-password-cancel').addEventListener('click', closeChangePasswordModal);
		$('change-password-confirm').addEventListener('click', submitChangePassword);
		$('change-password-modal').addEventListener('click', event => {
			if (event.target.id === 'change-password-modal') {
				closeChangePasswordModal();
			}
		});
	}
	$('login-selected-btn').addEventListener('click', loginSelectedAccounts);
	$('logout-selected-btn').addEventListener('click', logoutSelectedAccounts);
	$('delete-selected-btn').addEventListener('click', deleteSelectedAccounts);
	$('check-all').addEventListener('change', toggleAll);
	$('range-select-btn').addEventListener('click', selectAccountsByRange);
	['range-start', 'range-end'].forEach(id => {
		$(id).addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				selectAccountsByRange();
			}
		});
	});
	$('import-modal-confirm').addEventListener('click', importAccountsFromModal);
	$('import-modal-cancel').addEventListener('click', closeImportModal);
	$('import-modal-close').addEventListener('click', closeImportModal);
	$('import-account-modal').addEventListener('click', event => {
		if (event.target.id === 'import-account-modal') {
			closeImportModal();
		}
	});
	$('guard-submit').addEventListener('click', submitGuard);
	$('guard-code').addEventListener('keydown', event => {
		if (event.key === 'Enter') {
			submitGuard();
		}
	});
	$('inventory-refresh-btn').addEventListener('click', () => {
		refreshInventory({forceRefresh: true});
	});
	$('inventory-category-select').addEventListener('change', event => {
		state.inventory.categoryFilter = event.target.value || 'all';
		renderInventory();
	});
	document.querySelectorAll('[data-purchase-game]').forEach(button => {
		button.addEventListener('click', () => switchPurchaseGame(button.dataset.purchaseGame));
	});
	$('purchase-refresh-accounts').addEventListener('click', () => {
		refreshPurchaseOnlineAccounts();
	});
	$('purchase-refresh-items').addEventListener('click', () => {
		refreshPurchaseItems();
	});
	$('purchase-refresh-rates').addEventListener('click', () => {
		refreshPurchaseRates();
	});
	$('purchase-max-qty-btn').addEventListener('click', maxOutPurchaseCart);
	$('purchase-clear-cart').addEventListener('click', clearPurchaseCart);
	$('purchase-submit-btn').addEventListener('click', submitPurchaseTask);
	$('purchase-item-search').addEventListener('input', event => {
		state.purchase.itemSearch = String(event.target.value || '').trim().toLowerCase();
		renderPurchase();
	});
	bindPurchaseAccountMultiSelect();
	bindBuyGame();
	bindMarketBuyorder();
	$('purchase-item-rows').addEventListener('toggle', handlePurchaseCategoryToggle, true);
	$('purchase-item-rows').addEventListener('click', handlePurchaseItemListClick);
	$('purchase-cart-body').addEventListener('click', handlePurchaseCartClick);
	$('purchase-cart-body').addEventListener('change', handlePurchaseCartInput);
	$('purchase-price-close').addEventListener('click', closePurchasePriceModal);
	$('purchase-price-modal').addEventListener('click', event => {
		if (event.target.id === 'purchase-price-modal') {
			closePurchasePriceModal();
		}
	});
	$('totp-close').addEventListener('click', closeTotpModal);
	$('totp-refresh').addEventListener('click', refreshTotpCode);
	$('totp-modal').addEventListener('click', event => {
		if (event.target.id === 'totp-modal') {
			closeTotpModal();
		}
	});
	var uuList = $('uu-account-list'); if (uuList) uuList.addEventListener('click', handleUuAccountListClick);
	// UU 模块使用行内布局和弹窗，不再需要 detail body 事件

	// 充值码兑换模块
	$('wallet-import-mafile-btn').addEventListener('click', () => $('wallet-mafile').click());
	$('wallet-mafile').addEventListener('change', importWalletMafiles);
	$('wallet-redeem-btn').addEventListener('click', startWalletRedeem);
	$('wallet-retry-btn').addEventListener('click', retryWalletFailed);
	$('wallet-clear-btn').addEventListener('click', clearWallet);
	$('wallet-accounts').addEventListener('input', updateWalletCounts);
	$('wallet-codes').addEventListener('input', updateWalletCounts);
	$('clear-log').addEventListener('click', () => {
		state.logLines = [];
		logs.textContent = '';
		if (logsToBottomBtn) logsToBottomBtn.hidden = true;
		saveLogLines();
	});
	// 实时日志：滚动时根据是否在底部切换“最新日志”按钮；点击按钮跳回底部继续跟随
	logs.addEventListener('scroll', updateLogsToBottomBtn);
	if (logsToBottomBtn) logsToBottomBtn.addEventListener('click', scrollLogsToBottom);
	document.addEventListener('click', handleDocumentClickForGcPopover, true);
	window.addEventListener('resize', closeGcActionPopover);
	window.addEventListener('scroll', closeGcActionPopover, true);
}

function activateModule(module) {
	state.activeModule = module;
	document.querySelectorAll('.module').forEach(item => item.classList.toggle('active', item.dataset.module === module));
	document.querySelectorAll('.module-view').forEach(view => view.classList.toggle('active', view.id === 'module-' + module));
	if (module === 'inventory') {
		renderInventory();
		ensureInventoryLoaded();
		return;
	}
	if (module === 'purchase') {
		renderPurchase();
		ensurePurchaseLoaded();
		return;
	}
	if (module === 'buygame') {
		renderBuyGame();
		ensureBuyGameLoaded();
		return;
	}
	if (module === 'market-buyorder') {
		renderMarketBuyorder();
		ensureMarketLoaded();
		return;
	}
	if (module === 'uu') {
		renderUu();
		ensureUuLoaded();
		return;
	}
	if (module === 'terminal-opener') {
		renderTerminalOpener();
		ensureTerminalOpenerLoaded();
		return;
	}
	if (module === 'wallet') {
		renderWallet();
	}
}

function openImportModal() {
	$('import-account-modal').hidden = false;
	$('import-accounts-text').focus();
}

function closeImportModal() {
	$('import-account-modal').hidden = true;
}

function importAccountsFromModal() {
	try {
		const text = $('import-accounts-text').value;
		const rows = parseAccountText(text);
		let added = 0;
		let updated = 0;
		for (const row of rows) {
			const result = upsertAccount(row);
			if (result === 'added') {
				added++;
			} else if (result === 'updated') {
				updated++;
			}
		}
		saveAccounts();
		renderAccounts();
		refreshAccountMeta();
		$('import-accounts-text').value = '';
		closeImportModal();
		addLine('success', `导入账户完成: 新增 ${added}, 更新 ${updated}`);
	} catch (err) {
		addLine('error', '导入账户失败: ' + err.message);
	}
}

async function importMafiles(event) {
	const files = Array.from(event.target.files || []);
	event.target.value = '';
	if (!files.length) {
		return;
	}

	let added = 0;
	let updated = 0;
	const toPersist = [];
	for (const file of files) {
		try {
			const data = JSON.parse(await file.text());
			const accountName = data.account_name || data.accountName || file.name.replace(/\.(maFile|json)$/i, '');
			const sharedSecret = data.shared_secret || data.sharedSecret || '';
			if (!accountName) {
				addLine('warn', `${file.name}: 缺少 account_name`);
				continue;
			}
			if (!sharedSecret) {
				addLine('warn', `${accountName}: maFile 中没有 shared_secret`);
			}

			// 完整 maFile（含 identity_secret）交服务端持久化,供发货手机确认使用。
			if (!data.account_name && !data.accountName) {
				data.account_name = accountName;
			}
			toPersist.push(data);

			const result = upsertAccount({
				accountName,
				password: data.password || '',
				sharedSecret,
				hasMaFile: true,
				source: 'maFile'
			});
			if (result === 'added') {
				added++;
			} else if (result === 'updated') {
				updated++;
			}
		} catch (err) {
			addLine('error', `${file.name}: 读取 maFile 失败: ${err.message}`);
		}
	}

	saveAccounts();
	renderAccounts();

	if (toPersist.length) {
		try {
			const resp = await postJson('/api/mafile/import', {mafiles: toPersist});
			const withId = (resp.results || []).filter(r => r.ok && r.hasIdentitySecret).length;
			addLine('info', `maFile 已存到服务器: ${resp.saved} 个 (含 identity_secret: ${withId})`);
		} catch (err) {
			addLine('warn', `maFile 服务端保存失败(发货确认可能受影响): ${err.message}`);
		}
	}

	refreshAccountMeta();
	addLine('success', `导入 maFile 完成: 新增 ${added}, 更新 ${updated}`);
}

async function loginSelectedAccounts() {
	const accounts = state.accounts.filter(account => state.selected.has(account.id));
	if (!accounts.length) {
		addLine('warn', '请先选择账户');
		return;
	}

	for (const account of accounts) {
		await loginAccount(account);
	}
}

async function logoutSelectedAccounts() {
	const accounts = state.accounts.filter(account => state.selected.has(account.id));
	if (!accounts.length) {
		addLine('warn', '请先选择账户');
		return;
	}

	for (const account of accounts) {
		await logoutAccount(account);
	}
}

async function deleteSelectedAccounts() {
	const accounts = state.accounts.filter(account => state.selected.has(account.id));
	if (!accounts.length) {
		addLine('warn', '请先选择账户');
		return;
	}

	for (const account of accounts) {
		if (account.attemptId) {
			state.dismissedAttemptIds.add(account.attemptId);
			state.attemptToAccount.delete(account.attemptId);
		}
		if (account.accountName) {
			state.dismissedAccountNames.add(String(account.accountName).toLowerCase());
		}
	}

	// 删除前留存账号名/任务 id，供后端一并清理保活会话。
	const cleanupList = accounts.map(account => ({
		accountName: account.accountName || '',
		attemptId: account.attemptId || ''
	}));

	state.accounts = state.accounts.filter(account => !state.selected.has(account.id));
	state.selected.clear();
	if (accounts.some(account => account.id === state.inventory.selectedAccountId)) {
		resetInventoryState();
	}
	removePurchaseAccounts(accounts.map(account => account.accountName));
	saveAccounts();
	renderAccounts();
	renderInventory();
	renderPurchase();
	addLine('success', `已删除 ${accounts.length} 个账户`);

	// 一并清理后端会话：登出在线客户端、移除内存任务表、删除已保存的 session 文件，
	// 避免下次刷新时这些会话又被 /api/attempts 拉回来。
	try {
		const result = await postJson('/api/accounts/cleanup', {accounts: cleanupList});
		if (result && (result.removedAttempts || result.removedFiles)) {
			addLine('info', `已清理后端会话：任务 ${result.removedAttempts || 0} 个、session 文件 ${result.removedFiles || 0} 个`);
		}
	} catch (err) {
		addLine('warn', `后端会话清理失败：${err.message}`);
	}
}

async function loginAccount(account, options = {}) {
	if (!account) {
		return;
	}
	// 已有在线/登录中的会话时不再重复发起登录：后端每次 /api/login 都会新建 attempt 与
	// SteamUser 客户端，mergeAttempt 随后覆盖 account.attemptId，旧会话被挤掉且无人回收。
	// 需要重新登录请先「登出选中」。
	// options.force：UU发货行的「登录账户」按钮用。那里的在线状态取自后端发货就绪判断，
	// 本地 status 可能因粘性而仍停留在「登录成功」（客户端已掉线但状态没回退），
	// 这时必须允许重连，否则用户会被这个守卫卡死。
	const currentStatus = normalizeLoginStatus(account.status);
	if (!options.force && account.attemptId && (currentStatus === '登录成功' || currentStatus === '登录中')) {
		addLine('warn', `${account.accountName}: 已处于「${currentStatus}」状态，跳过重复登录（如需重连请先登出）`);
		return;
	}

	if (!account.password) {
		account.status = '登录失败';
		saveAccounts();
		renderAccounts();
		addLine('error', `${account.accountName}: 缺少密码，无法登录`);
		return;
	}

	account.status = '登录中';
	account.gcConnected = false;
	account.cs2GcConnected = false;
	account.tf2GcConnected = false;
	account.activeGame = 'cs2';
	account.lastError = '';
	saveAccounts();
	renderAccounts();

	try {
		const data = await postJson('/api/login', {
			accountName: account.accountName,
			password: account.password,
			twoFactorCode: account.twoFactorCode || '',
			sharedSecret: account.sharedSecret || '',
			remember: account.remember !== false
		});
		mergeAttempt(data.attempt, account.id);
	} catch (err) {
		account.status = '登录失败';
		account.lastError = err.message;
		saveAccounts();
		renderAccounts();
		addLine('error', `${account.accountName}: ${err.message}`);
	}
}

async function logoutAccount(account) {
	if (!account) {
		return;
	}

	if (!account.attemptId) {
		applyLoggedOutState(account);
		removePurchaseAccounts([account.accountName]);
		saveAccounts();
		renderAccounts();
		renderInventory();
		renderPurchase();
		addLine('success', `${account.accountName}: 已下线`);
		return;
	}

	try {
		const data = await postJson('/api/logout/' + account.attemptId, {});
		mergeAttempt(data.attempt, account.id);
		applyLoggedOutState(account);
		saveAccounts();
		renderAccounts();
		renderInventory();
		renderPurchase();
		addLine('success', `${account.accountName}: 已下线`);
	} catch (err) {
		addLine('error', `${account.accountName}: ${err.message}`);
	}
}

async function connectGcForAccount(accountId, game = 'cs2') {
	const account = state.accounts.find(item => item.id === accountId);
	if (!account) {
		return;
	}
	const normalizedGame = normalizePurchaseGame(game);
	const gameLabel = normalizedGame === 'tf2' ? 'TF2' : 'CS2';
	if (!account.attemptId) {
		addLine('warn', `${account.accountName}: 请先登录后再连接 ${gameLabel} GC`);
		return;
	}

	try {
		const data = await postJson(`/api/gc/connect/${account.attemptId}?game=${encodeURIComponent(normalizedGame)}`, {game: normalizedGame});
		mergeAttempt(data.attempt, account.id, {silent: true});
		addLine('success', `${account.accountName}: 已请求连接 ${gameLabel} GC`);
	} catch (err) {
		addLine('error', `${account.accountName}: ${err.message}`);
	}
}

async function disconnectGcForAccount(accountId, game = 'cs2') {
	const account = state.accounts.find(item => item.id === accountId);
	if (!account) {
		return;
	}
	const normalizedGame = normalizePurchaseGame(game);
	const gameLabel = normalizedGame === 'tf2' ? 'TF2' : 'CS2';
	if (!account.attemptId) {
		addLine('warn', `${account.accountName}: 当前没有可断开的 ${gameLabel} GC 任务`);
		return;
	}

	try {
		const data = await postJson(`/api/gc/disconnect/${account.attemptId}?game=${encodeURIComponent(normalizedGame)}`, {game: normalizedGame});
		mergeAttempt(data.attempt, account.id, {silent: true});
		if (normalizedGame === 'cs2' && state.inventory.selectedAccountId === account.id) {
			resetInventoryState();
		}
		addLine('success', `${account.accountName}: 已请求断开 ${gameLabel} GC`);
	} catch (err) {
		addLine('error', `${account.accountName}: ${err.message}`);
	}
}

async function submitGuard() {
	if (!state.activeGuardAttempt) {
		addLine('warn', '当前没有等待 Steam Guard 的任务');
		return;
	}

	const code = $('guard-code').value.trim();
	if (!code) {
		addLine('warn', '请输入 Steam Guard 验证码');
		return;
	}

	try {
		const data = await postJson('/api/guard/' + state.activeGuardAttempt, {code});
		$('guard-code').value = '';
		mergeAttempt(data.attempt);
	} catch (err) {
		addLine('error', err.message);
	}
}

function mergeAttempt(attempt, knownAccountId, options = {}) {
	if (!attempt || !attempt.id) {
		return;
	}
	if (state.dismissedAttemptIds.has(attempt.id)) {
		return;
	}
	if (attempt.accountName && state.dismissedAccountNames.has(String(attempt.accountName).toLowerCase())) {
		return;
	}

	let account = knownAccountId ? state.accounts.find(item => item.id === knownAccountId) : null;
	if (!account) {
		account = state.accounts.find(item => item.attemptId === attempt.id)
			|| state.accounts.find(item => item.accountName && item.accountName === attempt.accountName);
	}
	// 只显示导入的账号：不再为后端孤立会话自动补建账户。
	// 后端 attempt 仅用于刷新已导入账号的状态（按 attemptId / accountName 匹配）；
	// 匹配不到的（如未导入却仍在后端保活的会话）直接忽略，不在列表中显示。
	if (account) {
		const previousStatus = normalizeLoginStatus(account.status);
		const previousGcState = {
			cs2: !!account.cs2GcConnected,
			tf2: !!account.tf2GcConnected
		};
		state.attemptToAccount.set(attempt.id, account.id);
		account.attemptId = attempt.id;
		account.status = collapseAttemptStatus(attempt.status, previousStatus);
		if (attempt.hasMaFile !== undefined) {
			account.hasMaFile = !!attempt.hasMaFile;
		}
		account.steamID = attempt.steamID || account.steamID || '';
		account.country = attempt.country || account.country || '';
		if (attempt.balance !== undefined) {
			account.balance = attempt.balance;
		}
		if (attempt.currency !== undefined) {
			account.currency = attempt.currency;
		}
		if (attempt.hasWallet !== undefined) {
			account.hasWallet = !!attempt.hasWallet;
		}
		account.hasRefreshToken = !!attempt.hasRefreshToken;
		if (attempt.cs2GcConnected !== undefined) {
			account.cs2GcConnected = !!attempt.cs2GcConnected;
		}
		if (attempt.tf2GcConnected !== undefined) {
			account.tf2GcConnected = !!attempt.tf2GcConnected;
		}
		if (attempt.gcConnected !== undefined) {
			account.gcConnected = !!attempt.gcConnected;
		}
		account.gcConnected = !!account.cs2GcConnected;
		if (attempt.activeGame !== undefined) {
			account.activeGame = normalizePurchaseGame(attempt.activeGame);
		}
		if (attempt.inventoryCount !== undefined) {
			account.inventoryCount = Number(attempt.inventoryCount || 0);
		}
		if (attempt.inventorySource !== undefined) {
			account.inventorySource = attempt.inventorySource || '';
		}
		account.guard = attempt.guard || null;
		if (!options.silent) {
			appendLoginResultLine(account, previousStatus, attempt);
			appendGcResultLines(account, previousGcState);
		}
	}

	if (attempt.guard) {
		state.activeGuardAttempt = attempt.id;
		$('guard-box').hidden = false;
		$('guard-title').textContent = attempt.guard.type === 'email' ? '需要邮箱 Steam Guard' : '需要移动令牌 Steam Guard';
		$('guard-desc').textContent = attempt.guard.lastCodeWrong ? '上一个验证码错误，请重新输入。' : (attempt.guard.domain ? '邮箱域名: ' + attempt.guard.domain : '请输入 Steam 手机令牌验证码。');
		$('guard-code').focus();
	} else if (state.activeGuardAttempt === attempt.id) {
		state.activeGuardAttempt = null;
		$('guard-box').hidden = true;
	}

	saveAccounts();
	renderAccounts();
	renderInventory();
	syncPurchaseAccountFromAttempt(attempt);
	renderPurchase();
}

function appendLoginResultLine(account, previousStatus, attempt) {
	const nextStatus = normalizeLoginStatus(account.status);
	if (previousStatus === nextStatus) {
		return;
	}
	if (nextStatus === '登录成功') {
		addLine('success', `${account.accountName}: 登录成功`);
		return;
	}
	if (nextStatus === '登录失败') {
		const reason = extractFailureReason(attempt) || account.lastError || '';
		addLine('error', `${account.accountName}: 登录失败${reason ? ' - ' + reason : ''}`);
	}
}

function appendGcResultLines(account, previousGcState) {
	appendSingleGcResultLine(account, 'cs2', !!(previousGcState && previousGcState.cs2), !!account.cs2GcConnected);
	appendSingleGcResultLine(account, 'tf2', !!(previousGcState && previousGcState.tf2), !!account.tf2GcConnected);
}

function appendSingleGcResultLine(account, game, previousConnected, nextConnected) {
	if (previousConnected === nextConnected) {
		return;
	}
	const gameLabel = game === 'tf2' ? 'TF2' : 'CS2';
	if (nextConnected) {
		addLine('success', `${account.accountName}: ${gameLabel} GC 连接成功`);
		return;
	}
	addLine('warn', `${account.accountName}: ${gameLabel} GC 已断开`);
}

function extractFailureReason(attempt) {
	const logs = Array.isArray(attempt.logs) ? attempt.logs : [];
	for (let index = logs.length - 1; index >= 0; index--) {
		const entry = logs[index];
		if (entry && entry.level === 'error' && entry.message) {
			return entry.message;
		}
	}
	return '';
}

// 依据登录状态与 GC 连接状态推导账户所属分类（派生值，不单独存储）：
// CS2/TF2 GC 已连接 -> gc；登录成功 -> online；其余（未登录/登录中/登录失败）-> offline。
// mergeAttempt 在收到 attempt:update 后更新 status / *GcConnected 字段并重渲，
// 因此登录成功会自动归入“在线”，GC 连接成功会自动归入“GC 已连接”。
function accountGroupKey(account) {
	if (account.cs2GcConnected || account.tf2GcConnected) {
		return 'gc';
	}
	if (normalizeLoginStatus(account.status) === '登录成功') {
		return 'online';
	}
	return 'offline';
}

function groupAccounts() {
	const grouped = {offline: [], online: [], gc: []};
	for (const account of state.accounts) {
		grouped[accountGroupKey(account)].push(account);
	}
	return grouped;
}

// 序号至少补足两位(对齐“00-00”的输入习惯)
function padSeq(n) {
	return String(n).padStart(2, '0');
}

// 按序号区间勾选账户。两侧任填其一即按单个处理;start>end 自动交换;越界自动夹取。
// 序号对应 state.accountOrder(账户列表当前显示顺序),勾选为追加(不清除已选)。
function selectAccountsByRange() {
	const order = Array.isArray(state.accountOrder) ? state.accountOrder : [];
	const total = order.length;
	if (!total) {
		toast('暂无账户', 'warn');
		return;
	}
	let start = parseInt($('range-start').value, 10);
	let end = parseInt($('range-end').value, 10);
	if (Number.isNaN(start) && Number.isNaN(end)) {
		toast('请输入要勾选的序号', 'warn');
		return;
	}
	if (Number.isNaN(start)) {
		start = end;
	}
	if (Number.isNaN(end)) {
		end = start;
	}
	if (start > end) {
		const tmp = start;
		start = end;
		end = tmp;
	}
	start = Math.max(1, start);
	end = Math.min(total, end);
	if (start > total) {
		toast(`序号超出范围（共 ${total} 个账户）`, 'warn');
		return;
	}
	for (let i = start; i <= end; i++) {
		const account = order[i - 1];
		if (account) {
			state.selected.add(account.id);
		}
	}
	renderAccounts();
	toast(`已勾选序号 ${padSeq(start)}–${padSeq(end)}，共 ${end - start + 1} 个账户`, 'success');
}

function renderAccounts() {
	const tbody = $('account-rows');
	tbody.textContent = '';

	const grouped = groupAccounts();
	const orderedAccounts = [];   // 按显示顺序的扁平列表,用于“按序号勾选”
	let seq = 0;

	for (const group of ACCOUNT_GROUPS) {
		const members = grouped[group.key];
		if (!members.length) {
			continue;
		}

		const collapsed = state.accountGroups.collapsed.has(group.key);
		const allSelected = members.every(account => state.selected.has(account.id));

		const headerRow = document.createElement('tr');
		headerRow.className = 'account-group-header' + (collapsed ? ' collapsed' : '');
		headerRow.dataset.group = group.key;
		headerRow.innerHTML = `
			<td colspan="9">
				<div class="account-group-bar">
					<span class="account-group-caret" aria-hidden="true">▾</span>
					<span class="account-group-title">${escapeHtml(group.title)}</span>
					<span class="pill ${group.tone} account-group-count">${members.length}</span>
					<button type="button" class="mini-btn account-group-select" data-group-select="${escapeAttr(group.key)}">${allSelected ? '取消本组' : '全选本组'}</button>
				</div>
			</td>
		`;
		tbody.appendChild(headerRow);

		if (collapsed) {
			// 收起的分组也占用序号,保证各账户序号稳定(展开/收起不改变序号)
			for (const account of members) {
				seq++;
				orderedAccounts.push(account);
			}
			continue;
		}

		for (const account of members) {
			seq++;
			orderedAccounts.push(account);
			const row = document.createElement('tr');
			row.innerHTML = `
				<td class="check-cell"><input type="checkbox" data-select="${escapeAttr(account.id)}" ${state.selected.has(account.id) ? 'checked' : ''}></td>
				<td class="seq-cell">${padSeq(seq)}</td>
				<td title="${escapeAttr(account.accountName)}">${escapeHtml(account.accountName)}</td>
				<td>${renderMaFileCell(account)}</td>
				<td>${statusPill(account)}</td>
				<td>${escapeHtml(account.country || '-')}</td>
				<td title="${escapeAttr(formatBalance(account))}">${escapeHtml(formatBalance(account))}</td>
				<td title="${escapeAttr(account.steamID || '')}">${escapeHtml(account.steamID || '-')}</td>
				<td class="account-actions-cell">${renderGcActionButtons(account)}</td>
			`;
			tbody.appendChild(row);
		}
	}

	state.accountOrder = orderedAccounts;

	tbody.querySelectorAll('tr.account-group-header').forEach(headerRow => {
		headerRow.addEventListener('click', event => {
			if (event.target.closest('[data-group-select]')) {
				return;
			}
			toggleAccountGroup(headerRow.dataset.group);
		});
	});

	tbody.querySelectorAll('button[data-group-select]').forEach(button => {
		button.addEventListener('click', event => {
			event.stopPropagation();
			toggleAccountGroupSelection(button.dataset.groupSelect);
		});
	});

	tbody.querySelectorAll('input[data-select]').forEach(input => {
		input.addEventListener('change', () => {
			if (input.checked) {
				state.selected.add(input.dataset.select);
			} else {
				state.selected.delete(input.dataset.select);
			}
			renderCounts();
		});
	});

	tbody.querySelectorAll('button[data-gc-connect]').forEach(button => {
		button.addEventListener('click', () => {
			connectGcForAccount(button.dataset.gcConnect, button.dataset.gcGame || 'cs2');
		});
	});

	tbody.querySelectorAll('button[data-gc-disconnect]').forEach(button => {
		button.addEventListener('click', () => {
			disconnectGcForAccount(button.dataset.gcDisconnect, button.dataset.gcGame || 'cs2');
		});
	});

	tbody.querySelectorAll('button[data-gc-open-menu]').forEach(button => {
		button.addEventListener('click', event => {
			toggleGcActionPopover(button.dataset.gcOpenMenu, event.currentTarget);
		});
	});

	tbody.querySelectorAll('button[data-show-code]').forEach(button => {
		button.addEventListener('click', () => {
			openTotpModal(button.dataset.showCode);
		});
	});

	$('empty-state').hidden = state.accounts.length > 0;
	renderCounts();
}

function renderCounts() {
	const onlineCount = state.accounts.filter(account => normalizeLoginStatus(account.status) === '登录成功').length;
	const offlineCount = Math.max(0, state.accounts.length - onlineCount);
	$('account-count').textContent = `${state.accounts.length} 个账户`;
	$('online-count').textContent = `在线数：${onlineCount}`;
	$('offline-count').textContent = `离线数：${offlineCount}`;
	$('selected-count').textContent = `${state.selected.size} 已选`;
	$('login-selected-btn').disabled = state.selected.size === 0;
	$('logout-selected-btn').disabled = state.selected.size === 0;
	$('delete-selected-btn').disabled = state.selected.size === 0;
	const allChecked = state.accounts.length > 0 && state.accounts.every(account => state.selected.has(account.id));
	$('check-all').checked = allChecked;
	updateAccountGroupSelectLabels();
}

// 在不整体重渲的情况下，把各分组头部的“全选本组/取消本组”按钮文案与当前勾选状态同步，
// 供逐行勾选（仅调用 renderCounts）时保持准确。
function updateAccountGroupSelectLabels() {
	const grouped = groupAccounts();
	document.querySelectorAll('#account-rows button[data-group-select]').forEach(button => {
		const members = grouped[button.dataset.groupSelect] || [];
		const allSelected = members.length > 0 && members.every(account => state.selected.has(account.id));
		button.textContent = allSelected ? '取消本组' : '全选本组';
	});
}

function toggleAccountGroup(groupKey) {
	const key = String(groupKey || '');
	if (!key) {
		return;
	}
	if (state.accountGroups.collapsed.has(key)) {
		state.accountGroups.collapsed.delete(key);
	} else {
		state.accountGroups.collapsed.add(key);
	}
	renderAccounts();
}

// 切换某一分类内全部账户的勾选：若已全选则取消，否则全选。
function toggleAccountGroupSelection(groupKey) {
	const key = String(groupKey || '');
	if (!key) {
		return;
	}
	const members = state.accounts.filter(account => accountGroupKey(account) === key);
	if (!members.length) {
		return;
	}
	const allSelected = members.every(account => state.selected.has(account.id));
	for (const account of members) {
		if (allSelected) {
			state.selected.delete(account.id);
		} else {
			state.selected.add(account.id);
		}
	}
	renderAccounts();
}

function renderInventory() {
	const selectedAccount = ensureInventorySelection();
	const gcAccounts = getGcAccounts();

	$('inventory-account-count').textContent = `GC在线账户：${gcAccounts.length}`;
	$('inventory-item-count').textContent = `物品数：${selectedAccount && state.inventory.loadedAccountId === selectedAccount.id ? state.inventory.items.length : 0}`;
	$('inventory-source').textContent = `来源：${formatInventorySource(state.inventory.source)}`;
	$('inventory-refresh-btn').disabled = !selectedAccount || state.inventory.loading;

	renderInventoryAccounts(gcAccounts, selectedAccount);
	renderInventorySummary(selectedAccount);
	renderInventoryFilter(selectedAccount);
	renderInventoryTable(selectedAccount);
}

// 库存分类:优先按稳定的 item.kind 枚举归类(不受本地化/稀有度影响),kind 缺失时回退到 item.type。
// 「消费级/普通级/工业级」等是「稀有度」不是类型,一律不作为分类;基础武器、乐器盒、探员等杂项
// 也不单独归类,只在「全部」里出现(inventoryCategoryOf 返回 '' 表示不归类)。
const INVENTORY_KIND_LABELS = {
	weapon_skin: '武器皮肤',
	weapon_case: '武器箱',
	graffiti: '涂鸦',
	sticker: '印花',
	tool: '工具'
};
const INVENTORY_CATEGORIES = ['武器皮肤', '武器箱', '印花胶囊', '印花', '涂鸦', '工具'];  // 下拉展示顺序
// Steam 社区库存(source=community)物品没有 kind、且 type 是「普通级 武器箱」这种「稀有度+类型」拼接,
// 无法直接用。改用 description.tags 里 Type 标签的 internal_name(CSGO_Type_*)这个稳定标识归类。
const INVENTORY_COMMUNITY_TYPE_MAP = {
	CSGO_Type_WeaponCase: '武器箱',
	CSGO_Type_Spray: '涂鸦',
	CSGO_Type_Sticker: '印花',
	CSGO_Type_Tool: '工具'
};
const INVENTORY_COMMUNITY_WEAPON_TYPES = new Set([
	'CSGO_Type_Pistol', 'CSGO_Type_SMG', 'CSGO_Type_Rifle', 'CSGO_Type_Shotgun',
	'CSGO_Type_Machinegun', 'CSGO_Type_SniperRifle', 'CSGO_Type_Knife',
	'CSGO_Type_Hands', 'CSGO_Type_Gloves'
]);
function inventoryCommunityTypeInternal(item) {
	const tags = item && item.raw && item.raw.description && Array.isArray(item.raw.description.tags)
		? item.raw.description.tags
		: null;
	if (!tags) {
		return '';
	}
	const typeTag = tags.find(t => t && (t.category === 'Type' || t.category_name === 'Type'));
	return typeTag ? String(typeTag.internal_name || '') : '';
}
function inventoryCategoryOf(item) {
	if (!item) {
		return '';
	}
	// GC 源:直接用稳定的 kind 枚举。
	const byKind = INVENTORY_KIND_LABELS[item.kind];
	if (byKind) {
		return byKind;
	}
	// 社区源:用 Type 标签 internal_name 归类(不受「普通级 武器箱」这种拼接 type 影响)。
	const internal = inventoryCommunityTypeInternal(item);
	if (internal) {
		if (INVENTORY_COMMUNITY_TYPE_MAP[internal]) {
			return INVENTORY_COMMUNITY_TYPE_MAP[internal];
		}
		if (INVENTORY_COMMUNITY_WEAPON_TYPES.has(internal)) {
			// 武器类:名字带「|」= 有涂装 = 武器皮肤;否则是无涂装基础武器,不归类。
			return /\|/.test(String(item.name || '')) ? '武器皮肤' : '';
		}
		return '';  // 探员/音乐盒/收藏品/布章 等其它类型不归类。
	}
	// 回退:GC 干净 type 标签命中白名单。
	const t = String(item.type || '').trim();
	return INVENTORY_CATEGORIES.includes(t) ? t : '';
}

// 顶部分类筛选下拉:只列出库存里实际存在的白名单分类(带数量),选中后只显示该类物品。
function renderInventoryFilter(selectedAccount) {
	const select = $('inventory-category-select');
	if (!select) {
		return;
	}
	const loaded = selectedAccount && state.inventory.loadedAccountId === selectedAccount.id;
	const items = loaded ? state.inventory.items : [];
	if (!items.length) {
		select.disabled = true;
		select.innerHTML = '<option value="all">全部</option>';
		select.value = 'all';
		return;
	}
	const counts = new Map();
	for (const it of items) {
		const c = inventoryCategoryOf(it);
		if (c) {
			counts.set(c, (counts.get(c) || 0) + 1);
		}
	}
	// 切换账户后当前分类可能不存在了,回退到「全部」。
	if (state.inventory.categoryFilter !== 'all' && !counts.has(state.inventory.categoryFilter)) {
		state.inventory.categoryFilter = 'all';
	}
	const activeCat = state.inventory.categoryFilter || 'all';
	const opts = [`<option value="all">全部 (${items.length})</option>`];
	for (const c of INVENTORY_CATEGORIES) {
		if (counts.has(c)) {
			opts.push(`<option value="${escapeAttr(c)}">${escapeHtml(c)} (${counts.get(c)})</option>`);
		}
	}
	select.disabled = false;
	select.innerHTML = opts.join('');
	select.value = activeCat;
}

function renderInventoryAccounts(accounts, selectedAccount) {
	const sel = $('inventory-account-select');
	if (!sel) return;
	const selId = selectedAccount ? selectedAccount.id : '';
	sel.textContent = '';
	if (!accounts.length) {
		const opt = document.createElement('option');
		opt.value = '';
		opt.textContent = '暂无已连接 CS2 GC 的账户';
		sel.appendChild(opt);
		sel.disabled = true;
		return;
	}
	sel.disabled = false;
	for (const account of accounts) {
		const opt = document.createElement('option');
		opt.value = account.id;
		opt.textContent = `${account.accountName || account.id}（${account.country || '-'} · ${formatBalance(account) || '-'} · 物品 ${account.inventoryCount || 0}）`;
		if (account.id === selId) opt.selected = true;
		sel.appendChild(opt);
	}
	sel.value = selId;
	sel.onchange = () => selectInventoryAccount(sel.value);
}

function renderInventorySummary(selectedAccount) {
	const summary = $('inventory-summary');
	if (!selectedAccount) {
		summary.innerHTML = '<span>请选择已连接 GC 的账户</span>';
		return;
	}

	const fetchedAt = state.inventory.loadedAccountId === selectedAccount.id ? formatInventoryTime(state.inventory.fetchedAt) : '-';
	summary.innerHTML = [
		`<span>账号：${escapeHtml(selectedAccount.accountName)}</span>`,
		`<span>国家：${escapeHtml(selectedAccount.country || '-')}</span>`,
		`<span>余额：${escapeHtml(formatBalance(selectedAccount))}</span>`,
		`<span>CS2 GC：已连接</span>`,
		`<span>来源：${escapeHtml(formatInventorySource(state.inventory.source))}</span>`,
		`<span>更新时间：${escapeHtml(fetchedAt)}</span>`
	].join('');
}

function renderInventoryTable(selectedAccount) {
	const tbody = $('inventory-rows');
	tbody.textContent = '';

	let message = '';
	if (!selectedAccount) {
		message = '请选择已连接 GC 的账户';
	} else if (state.inventory.loading) {
		message = '正在加载库存...';
	} else if (state.inventory.error) {
		message = state.inventory.error;
	} else if (state.inventory.loadedAccountId !== selectedAccount.id) {
		message = '在上方选择账户或点刷新库存开始加载';
	} else if (!state.inventory.items.length) {
		message = '当前账户暂无库存';
	}

	if (message) {
		$('inventory-empty-state').textContent = message;
		$('inventory-empty-state').hidden = false;
		return;
	}

	const activeCat = state.inventory.categoryFilter || 'all';
	const rows = activeCat === 'all'
		? state.inventory.items
		: state.inventory.items.filter(it => inventoryCategoryOf(it) === activeCat);
	if (!rows.length) {
		$('inventory-empty-state').textContent = `「${activeCat}」分类下暂无饰品`;
		$('inventory-empty-state').hidden = false;
		return;
	}

	$('inventory-empty-state').hidden = true;
	for (const item of rows) {
		const row = document.createElement('tr');
		row.className = state.inventory.selectedItemAssetId === item.assetid ? 'active' : '';
		row.innerHTML = `
			<td>${renderInventoryItemCell(item)}</td>
			<td title="${escapeAttr(item.type || '-')}">${escapeHtml(item.type || '-')}</td>
			<td>${escapeHtml(item.rarity || '-')}</td>
			<td>${escapeHtml(item.exterior || '-')}</td>
			<td>${inventoryTradePill(item)}</td>
			<td title="${escapeAttr(formatTradableAt(item.tradableAfter))}">${escapeHtml(formatTradableAt(item.tradableAfter))}</td>
		`;
		row.addEventListener('click', () => {
			state.inventory.selectedItemAssetId = item.assetid || '';
			renderInventory();
		});
		tbody.appendChild(row);
	}
}

function renderInventoryItemCell(item) {
	const name = escapeHtml(item.name || '-');
	const subtitleText = getInventoryItemSubtitle(item);
	const subtitle = escapeHtml(subtitleText);
	const thumb = item.iconUrl
		? `<img class="inventory-thumb" src="${escapeAttr(item.iconUrl)}" alt="">`
		: '<div class="inventory-thumb-placeholder"></div>';
	return `
		<div class="inventory-item-cell">
			${thumb}
			<div class="inventory-name">
				<strong title="${escapeAttr(item.name || '-')}">${name}</strong>
				<span title="${escapeAttr(subtitleText || '')}">${subtitle}</span>
			</div>
		</div>
	`;
}

function inventoryTradePill(item) {
	return `<span class="pill ${item.tradable ? 'ok' : 'bad'}">${item.tradable ? '可交易' : '不可交易'}</span>`;
}

function terminalAccountKey(account) {
	return account ? (account.attemptId || account.id || '') : '';
}

function getGcAccounts() {
	return state.accounts.filter(account => account.cs2GcConnected && account.attemptId);
}

// ===================== 终端机开箱 独立模块 =====================
function terminalOpenerFmtTime(ms) {
	if (!ms) return '-';
	try { return new Date(Number(ms)).toLocaleString('zh-CN', {hour12: false}); } catch (_) { return '-'; }
}

function renderTerminalOpener() {
	const accounts = getGcAccounts();
	const selectedKey = terminalOpenerSelectedKey(accounts);
	const acctCount = $('terminal-opener-account-count');
	const termCount = $('terminal-opener-terminal-count');
	if (acctCount) acctCount.textContent = `已连 GC 账户：${accounts.length}`;
	if (termCount) termCount.textContent = `终端机：${state.terminalOpener.terminals.length}`;
	const refreshBtn = $('terminal-opener-refresh-btn');
	if (refreshBtn) refreshBtn.onclick = () => ensureTerminalOpenerLoaded(true);
	const typeSel = $('terminal-opener-type-filter');
	if (typeSel) {
		typeSel.value = state.terminalOpener.typeFilter || 'all';
		typeSel.onchange = () => { state.terminalOpener.typeFilter = typeSel.value; renderTerminalOpenerGrid(terminalOpenerSelectedKey()); };
	}
	const stateSel = $('terminal-opener-state-filter');
	if (stateSel) {
		stateSel.value = state.terminalOpener.stateFilter || 'all';
		stateSel.onchange = () => { state.terminalOpener.stateFilter = stateSel.value; renderTerminalOpenerGrid(terminalOpenerSelectedKey()); };
	}
	renderTerminalOpenerAccounts(accounts, selectedKey);
	renderTerminalOpenerGrid(selectedKey);
}

// 选中的账户 key(attemptId);失效则清空
function terminalOpenerSelectedKey(accounts) {
	const list = accounts || getGcAccounts();
	const cur = state.terminalOpener.selectedKey;
	if (cur && list.some(a => terminalAccountKey(a) === cur)) return cur;
	state.terminalOpener.selectedKey = '';
	state.terminalOpener.terminals = [];
	return '';
}

function selectTerminalOpener(key) {
	if (state.terminalOpener.selectedKey === key) { ensureTerminalOpenerLoaded(true); return; }
	state.terminalOpener.selectedKey = key;
	state.terminalOpener.terminals = [];
	renderTerminalOpener();
	ensureTerminalOpenerLoaded(true);
}

function renderTerminalOpenerAccounts(accounts, selectedKey) {
	const sel = $('terminal-opener-account-select');
	if (!sel) return;
	sel.textContent = '';
	if (!accounts.length) {
		const opt = document.createElement('option');
		opt.value = '';
		opt.textContent = '暂无已连接 CS2 GC 的账户';
		sel.appendChild(opt);
		sel.disabled = true;
		return;
	}
	sel.disabled = false;
	const ph = document.createElement('option');
	ph.value = '';
	ph.textContent = '— 请选择账户 —';
	sel.appendChild(ph);
	for (const account of accounts) {
		const key = terminalAccountKey(account);
		const opt = document.createElement('option');
		opt.value = key;
		opt.textContent = `${account.accountName || key}（${account.country || '-'} · ${formatBalance(account) || '-'}）`;
		if (key === selectedKey) opt.selected = true;
		sel.appendChild(opt);
	}
	sel.value = selectedKey || '';
	sel.onchange = () => { if (sel.value) selectTerminalOpener(sel.value); };
}

function terminalOpenerOfferHtml(offer) {
	if (!offer) return `<div class="toc-offer toc-empty">暂无报价 · 点「拒绝报价 · 换下一个」生成</div>`;
	const img = offer.image
		? `<img class="toc-img" src="${escapeHtml(offer.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
		: `<div class="toc-img toc-img-empty">无图</div>`;
	const wear = offer.wear != null ? `磨损 ${Number(offer.wear).toFixed(4)}` : '';
	const sub1 = [escapeHtml(offer.exterior || ''), wear].filter(Boolean).join(' · ');
	const sub2 = [escapeHtml(offer.rarity || ''), offer.paintseed != null ? `图案 ${offer.paintseed}` : ''].filter(Boolean).join(' · ');
	return `<div class="toc-offer">
		${img}
		<div class="toc-offer-info">
			<div class="toc-name" title="${escapeHtml(offer.name || '')}">${escapeHtml(offer.name || '')}</div>
			${sub1 ? `<div class="toc-sub">${sub1}</div>` : ''}
			${sub2 ? `<div class="toc-sub muted">${sub2}</div>` : ''}
			<div class="toc-price">${escapeHtml(offer.priceText || '—')}</div>
		</div>
	</div>`;
}

// 之前每次「换下一个」开出的报价历史(后端持久缓存),折叠展示,方便回看开过哪些。
function terminalOpenerHistoryHtml(history) {
	const list = Array.isArray(history) ? history : [];
	if (!list.length) return '';
	const rows = list.map((o, i) => {
		const img = o.image
			? `<img class="toc-hist-img" src="${escapeHtml(o.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
			: `<div class="toc-hist-img toc-hist-img-empty"></div>`;
		const wear = o.wear != null ? `磨损 ${Number(o.wear).toFixed(4)}` : '';
		const sub = [escapeHtml(o.exterior || ''), wear].filter(Boolean).join(' · ');
		return `<div class="toc-hist-row">
			<span class="toc-hist-idx">${i + 1}</span>
			${img}
			<span class="toc-hist-name" title="${escapeHtml(o.name || '')}">${escapeHtml(o.name || '')}${sub ? ` <span class="muted">· ${sub}</span>` : ''}</span>
			<span class="toc-hist-price">${escapeHtml(o.priceText || '—')}</span>
		</div>`;
	}).join('');
	return `<details class="toc-hist"><summary>历史报价（${list.length}）</summary><div class="toc-hist-list">${rows}</div></details>`;
}

function renderTerminalOpenerGrid(selectedKey) {
	const grid = $('terminal-opener-terminals');
	const empty = $('terminal-opener-empty');
	if (!grid) return;
	grid.textContent = '';
	if (!selectedKey) {
		if (empty) { empty.hidden = false; empty.textContent = '请在上方选择账户'; }
		return;
	}
	const allTerminals = Array.isArray(state.terminalOpener.terminals) ? state.terminalOpener.terminals : [];
	const typeFilter = state.terminalOpener.typeFilter || 'all';
	const stateFilter = state.terminalOpener.stateFilter || 'all';
	const terminals = allTerminals.filter(t => {
		if (typeFilter !== 'all' && String(t.defIndex) !== String(typeFilter)) return false;
		if (stateFilter === 'sealed' && !t.sealed) return false;
		if (stateFilter === 'open' && t.sealed) return false;
		return true;
	});
	const fcount = $('terminal-opener-filter-count');
	if (fcount) fcount.textContent = allTerminals.length ? `显示 ${terminals.length} / 共 ${allTerminals.length}` : '';
	if (!allTerminals.length) {
		if (empty) { empty.hidden = false; empty.textContent = state.terminalOpener.loading ? '加载中…' : (state.terminalOpener.error ? ('加载失败：' + state.terminalOpener.error) : '该账户库存里没有终端机（创世/毁灭之手，或未连接 CS2 GC）'); }
		return;
	}
	if (!terminals.length) {
		if (empty) { empty.hidden = false; empty.textContent = '当前筛选条件下没有终端机（可把上方筛选改回“全部”）'; }
		return;
	}
	if (empty) empty.hidden = true;
	const sealedN = allTerminals.filter(t => t.sealed).length;
	terminals.forEach((t) => {
		const id = String(t.id);
		// attr169 是「已开次数」(递增),剩余 = 上限 - 已开。后端已给 picksUsed/picksMax/picksLeft;老字段兜底。
		const picksMax = t.picksMax != null ? t.picksMax : 5;
		const picksUsed = t.picksUsed != null ? t.picksUsed : (t.pointsRemaining != null ? t.pointsRemaining : null);
		const picksLeft = t.picksLeft != null ? t.picksLeft : (picksUsed != null ? Math.max(0, picksMax - picksUsed) : null);
		// 终端机名/图标来自库存(后端用社区库存补的真实中文名+图标),拿不到用本地兜底名。GC id 收进悬浮提示。
		const title = t.name || (t.sealed ? '封装的终端机' : '终端机');
		const termImg = t.image
			? `<img class="toc-term-img" src="${escapeHtml(t.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
			: `<div class="toc-term-img toc-term-img-empty">无图</div>`;
		const card = document.createElement('div');
		card.className = 'terminal-opener-card ' + (t.sealed ? 'sealed' : 'unsealed');
		card.innerHTML = `
			<div class="toc-head">
				${termImg}
				<span class="toc-title" title="GC id ${escapeHtml(id)}">${escapeHtml(title)}</span>
				<span class="toc-status ${t.sealed ? 'is-sealed' : 'is-open'}">${t.sealed ? '未解封' : '已解封'}</span>
			</div>
			<div class="toc-meta">
				${!t.sealed ? `<span>剩余 ${picksLeft != null ? picksLeft : '-'} / ${picksMax} 次${picksUsed != null ? `（已开 ${picksUsed}）` : ''}</span>` : ''}
				${t.expiresAt ? `<span>到期 ${escapeHtml(terminalOpenerFmtTime(t.expiresAt))}</span>` : ''}
			</div>
			${t.sealed
				? `<button type="button" class="danger-btn toc-btn" data-act="unseal" data-id="${escapeHtml(id)}">解封（不可逆·72h）</button>`
				: `${terminalOpenerOfferHtml(t.offer)}
					<div class="toc-actions">
						<button type="button" class="danger-btn toc-btn" data-act="advance" data-id="${escapeHtml(id)}">拒绝报价 · 换下一个（消耗）</button>
					</div>
					${terminalOpenerHistoryHtml(t.history)}`
			}`;
		grid.appendChild(card);
	});
	grid.onclick = (e) => {
		const btn = e.target.closest('button[data-act]');
		if (!btn) return;
		const act = btn.dataset.act, id = btn.dataset.id;
		if (act === 'unseal') terminalOpenerUnseal(selectedKey, id);
		else if (act === 'advance') terminalOpenerAdvance(selectedKey, id);
	};
	const empty2 = $('terminal-opener-empty');
	if (empty2) empty2.hidden = true;
	const termCount = $('terminal-opener-terminal-count');
	if (termCount) termCount.textContent = `终端机：${allTerminals.length}（未解封 ${sealedN}）`;
}

async function ensureTerminalOpenerLoaded(force) {
	if (state.activeModule !== 'terminal-opener') return;
	const key = terminalOpenerSelectedKey();
	if (!key) { renderTerminalOpener(); return; }
	if (state.terminalOpener.loading && !force) return;
	state.terminalOpener.loading = true;
	state.terminalOpener.error = '';
	renderTerminalOpenerGrid(key);
	try {
		const data = await getJson('/api/terminal/state?accountId=' + encodeURIComponent(key));
		const st = (data && data.state) || {};
		state.terminalOpener.terminals = Array.isArray(st.terminals) ? st.terminals : [];
	} catch (err) {
		state.terminalOpener.error = (err && err.message) || '加载失败';
	} finally {
		state.terminalOpener.loading = false;
	}
	renderTerminalOpener();
}

async function terminalOpenerUnseal(key, id) {
	if (!key || !id) return;
	const ok = await confirmDialog(
		`确定解封这个终端机吗?\n\nGC id: ${id}\n\n⚠️ 不可逆：会启动 72 小时倒计时。解封后可「拒绝报价 · 换下一个」，买需在 Steam 客户端完成。`,
		{title: '解封终端机（不可逆）', confirmText: '确认解封', cancelText: '取消', danger: true}
	);
	if (!ok) return;
	try {
		toast('正在解封…约 5s', 'info');
		await postJson('/api/terminal/unseal', {accountId: key, gcItemId: id, variant: 'opencrate', volatileLimit: '0'});
		await new Promise(r => setTimeout(r, 3500));
		await ensureTerminalOpenerLoaded(true);
		toast('已解封', 'success');
	} catch (err) {
		toast('解封失败：' + (err && err.message ? err.message : err), 'error');
	}
}

async function terminalOpenerAdvance(key, id) {
	if (!key || !id) return;
	const t = state.terminalOpener.terminals.find(x => String(x.id) === String(id));
	const left = t && t.picksLeft != null ? t.picksLeft : null;
	const lastNote = (left != null && left <= 0)
		? '\n\n⚠️ 该终端机挑选次数已达上限，这是拒绝最后一个报价（可能不会再有新报价）。'
		: '';
	const ok = await confirmDialog(
		`确定「拒绝当前报价、换下一个」吗?\n\nGC id: ${id}\n· 不可逆：当前报价会被丢弃换成新的；\n· 消耗 1 次挑选；\n· 不花钱（买才花钱）。${lastNote}`,
		{title: '拒绝报价 · 换下一个（不可逆·消耗1次）', confirmText: '确认', cancelText: '取消', danger: true}
	);
	if (!ok) return;
	try {
		toast('正在换下一个报价…约 6s', 'info');
		const data = await postJson('/api/terminal/advance-offer', {accountId: key, gcItemId: id});
		const r = (data && data.result) || {};
		applyTerminalOpenerOffer(id, r.skins && r.skins[0], r.history);
		toast(r.count ? `已换：${(r.skins[0] && r.skins[0].name) || '新报价'}` : '已推进（未读到新报价，可再试一次）', r.count ? 'success' : 'warn');
		setTimeout(() => ensureTerminalOpenerLoaded(true), 800);
	} catch (err) {
		toast('换报价失败：' + (err && err.message ? err.message : err), 'error');
	}
}

// 把某终端机的当前报价 + 历史就地更新到卡片(不整刷)
function applyTerminalOpenerOffer(id, offer, history) {
	const t = state.terminalOpener.terminals.find(x => String(x.id) === String(id));
	if (t) {
		t.offer = offer || t.offer;
		if (Array.isArray(history)) t.history = history;
	}
	renderTerminalOpenerGrid(state.terminalOpener.selectedKey);
}

function ensureInventorySelection() {
	const accounts = getGcAccounts();
	if (!accounts.length) {
		resetInventoryState();
		return null;
	}

	const selectedAccount = accounts.find(account => account.id === state.inventory.selectedAccountId);
	if (selectedAccount) {
		return selectedAccount;
	}

	state.inventory.selectedAccountId = accounts[0].id;
	clearLoadedInventory();
	return accounts[0];
}

function getSelectedInventoryItem() {
	const items = Array.isArray(state.inventory.items) ? state.inventory.items : [];
	if (!items.length) {
		return null;
	}
	const selectedItem = items.find(item => item.assetid === state.inventory.selectedItemAssetId);
	if (selectedItem) {
		return selectedItem;
	}
	state.inventory.selectedItemAssetId = items[0].assetid || '';
	return items[0];
}

function selectInventoryAccount(accountId) {
	if (state.inventory.selectedAccountId === accountId) {
		ensureInventoryLoaded();
		return;
	}

	state.inventory.selectedAccountId = accountId;
	clearLoadedInventory();
	renderInventory();
	ensureInventoryLoaded();
}

function ensureInventoryLoaded() {
	if (state.activeModule !== 'inventory' || state.inventory.loading) {
		return;
	}

	const selectedAccount = ensureInventorySelection();
	if (!selectedAccount) {
		renderInventory();
		return;
	}

	if (state.inventory.loadedAccountId === selectedAccount.id && !state.inventory.error) {
		return;
	}

	refreshInventory({silent: true});
}

async function refreshInventory(options = {}) {
	const selectedAccount = ensureInventorySelection();
	if (!selectedAccount) {
		renderInventory();
		return;
	}
	if (!selectedAccount.attemptId) {
		state.inventory.error = '当前账户没有运行中的登录任务';
		renderInventory();
		return;
	}

	const version = ++state.inventory.version;
	state.inventory.loading = true;
	state.inventory.error = '';
	renderInventory();

	try {
		const suffix = options.forceRefresh ? '?refresh=1' : '';
		const data = await getJson('/api/inventory/' + encodeURIComponent(selectedAccount.attemptId) + suffix);
		if (version !== state.inventory.version) {
			return;
		}
		if (data.attempt) {
			mergeAttempt(data.attempt, selectedAccount.id, {silent: true});
		}
		state.inventory.loadedAccountId = selectedAccount.id;
		state.inventory.items = Array.isArray(data.inventory && data.inventory.items) ? data.inventory.items : [];
		state.inventory.raw = data.inventory ? data.inventory.raw || null : null;
		state.inventory.fetchedAt = data.inventory && data.inventory.fetchedAt ? data.inventory.fetchedAt : '';
		state.inventory.source = data.inventory && data.inventory.source ? data.inventory.source : '';
		state.inventory.selectedItemAssetId = state.inventory.items[0] ? (state.inventory.items[0].assetid || '') : '';
		state.inventory.error = '';
		if (!options.silent) {
			addLine('success', `${selectedAccount.accountName}: 库存已刷新`);
		}
	} catch (err) {
		if (version !== state.inventory.version) {
			return;
		}
		state.inventory.loadedAccountId = '';
		state.inventory.items = [];
		state.inventory.raw = null;
		state.inventory.selectedItemAssetId = '';
		state.inventory.fetchedAt = '';
		state.inventory.source = '';
		state.inventory.error = err.message;
		if (!options.silent) {
			addLine('error', `${selectedAccount.accountName}: ${err.message}`);
		}
	} finally {
		if (version === state.inventory.version) {
			state.inventory.loading = false;
			renderInventory();
		}
	}
}

function resetInventoryState() {
	state.inventory.selectedAccountId = '';
	clearLoadedInventory();
}

function clearLoadedInventory() {
	state.inventory.loadedAccountId = '';
	state.inventory.items = [];
	state.inventory.raw = null;
	state.inventory.selectedItemAssetId = '';
	state.inventory.fetchedAt = '';
	state.inventory.source = '';
	state.inventory.error = '';
	state.inventory.loading = false;
	state.inventory.version++;
}

function formatInventorySource(source) {
	if (source === 'community') {
		return '社区库存';
	}
	if (source === 'gc') {
		return 'GC缓存';
	}
	return '-';
}

function formatInventoryTime(value) {
	if (!value) {
		return '-';
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? '-'
		: date.toLocaleTimeString('zh-CN', {hour12: false});
}

function formatTradableAt(value) {
	if (!value) {
		return '-';
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return '-';
	}

	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	const hour = String(date.getUTCHours()).padStart(2, '0');
	const minute = String(date.getUTCMinutes()).padStart(2, '0');
	const second = String(date.getUTCSeconds()).padStart(2, '0');
	return `${year}-${month}-${day} ${hour}:${minute}:${second} GMT`;
}

function getInventoryItemSubtitle(item) {
	const marketHashName = String(item && item.marketHashName || '').trim();
	const category = String(item && item.category || '').trim();
	const name = String(item && item.name || '').trim();
	const type = String(item && item.type || '').trim();
	const candidates = item && item.source === 'community'
		? [category]
		: [marketHashName, category];

	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}
		if (candidate === name) {
			continue;
		}
		if (candidate === type) {
			continue;
		}
		if (/^系列\s+\d+$/u.test(candidate)) {
			continue;
		}
		return candidate;
	}

	return '';
}

function renderPurchase() {
	const cartGroups = getPurchaseCartGroups();
	const selectedAccounts = getPurchaseSelectedAccounts();
	const visibleItems = getPurchaseVisibleItems();
	const gameLabel = getPurchaseGameLabel();

	$('purchase-game-label').textContent = `当前游戏：${gameLabel}`;
	document.querySelectorAll('[data-purchase-game]').forEach(button => {
		button.classList.toggle('active', button.dataset.purchaseGame === state.purchase.game);
	});
	$('purchase-account-count').textContent = `在线账户：${state.purchase.accounts.length}`;
	$('purchase-selected-count').textContent = `已选账户：${selectedAccounts.length}`;
	$('purchase-item-count').textContent = `商品数：${state.purchase.items.length}`;
	$('purchase-task-count').textContent = `任务数：${state.purchase.tasks.length}`;
	$('purchase-refresh-accounts').disabled = state.purchase.loadingAccounts;
	$('purchase-refresh-items').disabled = state.purchase.loadingItems;
	$('purchase-refresh-rates').disabled = state.purchase.loadingItems;
	$('purchase-max-qty-btn').disabled = cartGroups.length === 0;
	$('purchase-clear-cart').disabled = cartGroups.length === 0;
	$('purchase-submit-btn').disabled = state.purchase.submitting || cartGroups.length === 0;

	renderPurchaseAccountMultiSelect(selectedAccounts);
	renderPurchaseItems(selectedAccounts, visibleItems);
	renderPurchaseCart(cartGroups);
	renderPurchasePriceModal();
}

// 多选下拉：勾选若干在线账户作为购买账户，选项只展示「账号名 + 余额」。
function renderPurchaseAccountMultiSelect(selectedAccounts) {
	const toggle = $('purchase-account-select-toggle');
	const label = $('purchase-account-select-label');
	const menu = $('purchase-account-select-menu');
	const optionsBox = $('purchase-account-select-options');
	if (!toggle || !label || !optionsBox) {
		return;
	}
	const gameLabel = getPurchaseGameLabel();
	const accounts = state.purchase.accounts;
	const hasAccounts = accounts.length > 0;

	// 只要有账户就允许展开；后台刷新(loadingAccounts)期间不禁用、不强关菜单、不清空选项，
	// 否则下拉会因频繁刷新而“点不动 / 一闪而过 / 账户消失”。
	toggle.disabled = !hasAccounts;
	if (!hasAccounts && menu) {
		menu.hidden = true;
		toggle.setAttribute('aria-expanded', 'false');
	}

	// 选项：有账户就始终渲染勾选框；只有在「没有账户」时才显示加载/错误/空提示。
	optionsBox.textContent = '';
	if (hasAccounts) {
		for (const account of accounts) {
			const checked = state.purchase.selectedAccounts.has(account.account);
			const row = document.createElement('label');
			row.className = 'purchase-account-option';
			row.innerHTML = `
				<input type="checkbox" value="${escapeAttr(account.account)}" ${checked ? 'checked' : ''}>
				<span class="purchase-account-option-name" title="${escapeAttr(account.account)}">${escapeHtml(account.account)}</span>
				<span class="purchase-account-option-balance">余额：${escapeHtml(formatBalance(account))}</span>
			`;
			optionsBox.appendChild(row);
		}
	} else if (state.purchase.loadingAccounts) {
		optionsBox.innerHTML = `<div class="purchase-account-select-empty">正在加载 ${escapeHtml(gameLabel)} 在线账户...</div>`;
	} else if (state.purchase.accountError) {
		optionsBox.innerHTML = `<div class="purchase-account-select-empty">${escapeHtml(state.purchase.accountError)}</div>`;
	} else {
		optionsBox.innerHTML = `<div class="purchase-account-select-empty">暂无可用 ${escapeHtml(gameLabel)} 在线账户</div>`;
	}

	// 折叠按钮文案：展示已选数量。
	const count = selectedAccounts.length;
	if (!hasAccounts && state.purchase.loadingAccounts) {
		label.textContent = `正在加载 ${gameLabel} 在线账户...`;
	} else if (!hasAccounts) {
		label.textContent = `暂无可用 ${gameLabel} 在线账户`;
	} else if (count === 0) {
		label.textContent = '请选择在线账户';
	} else if (count === 1) {
		label.textContent = `已选 1 个：${selectedAccounts[0].account}`;
	} else {
		label.textContent = `已选 ${count} 个账户`;
	}
}

// 绑定多选下拉的交互：展开/收起、勾选、全选/清空、点击外部收起。仅在初始化时调用一次。
function bindPurchaseAccountMultiSelect() {
	const wrapper = $('purchase-account-multiselect');
	const toggle = $('purchase-account-select-toggle');
	const menu = $('purchase-account-select-menu');
	const optionsBox = $('purchase-account-select-options');
	if (!wrapper || !toggle || !menu || !optionsBox) {
		return;
	}
	toggle.addEventListener('click', () => {
		if (toggle.disabled) {
			return;
		}
		const willOpen = menu.hidden;
		menu.hidden = !willOpen;
		toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
	});
	optionsBox.addEventListener('change', event => {
		const input = event.target;
		if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') {
			return;
		}
		const name = String(input.value || '').trim();
		if (!name) {
			return;
		}
		if (input.checked) {
			state.purchase.selectedAccounts.add(name);
		} else {
			state.purchase.selectedAccounts.delete(name);
		}
		renderPurchase();
	});
	menu.addEventListener('click', event => {
		// 阻止冒泡到 document 的“点击外部收起”：勾选会触发 renderPurchase 重建选项，
		// 被点击的元素随即从 DOM 脱离，若让 click 冒到 document，wrapper.contains 会判为外部而误关菜单。
		event.stopPropagation();
		if (event.target.closest('[data-purchase-account-all]')) {
			state.purchase.selectedAccounts = new Set(state.purchase.accounts.map(account => account.account));
			renderPurchase();
		} else if (event.target.closest('[data-purchase-account-none]')) {
			state.purchase.selectedAccounts = new Set();
			renderPurchase();
		}
	});
	document.addEventListener('click', event => {
		if (!menu.hidden && !wrapper.contains(event.target)) {
			menu.hidden = true;
			toggle.setAttribute('aria-expanded', 'false');
		}
	});
}

// ===== 买游戏(协议购买整款 Steam 游戏)=====

function ensureBuyGameLoaded() {
	if (state.activeModule !== 'buygame') {
		return;
	}
	if (!state.buygame.loadingAccounts) {
		refreshBuyGameAccounts({silent: true});
	}
	loadBuyGameTasks();
}

async function refreshBuyGameAccounts(options = {}) {
	const silent = !!options.silent;
	state.buygame.loadingAccounts = true;
	state.buygame.accountError = '';
	if (!silent) {
		renderBuyGame();
	}
	try {
		const data = await getJson('/api/buygame/online-accounts');
		state.buygame.accounts = Array.isArray(data.accounts) ? data.accounts : [];
		// 移除已离线的已选账号
		const live = new Set(state.buygame.accounts.map(a => a.account));
		state.buygame.selectedAccounts = new Set([...state.buygame.selectedAccounts].filter(a => live.has(a)));
	} catch (err) {
		state.buygame.accountError = err.message || '加载账户失败';
		if (!silent) {
			addLine('error', '买游戏在线账户刷新失败: ' + err.message);
		}
	} finally {
		state.buygame.loadingAccounts = false;
		renderBuyGame();
	}
}

async function loadBuyGameTasks() {
	try {
		const data = await getJson('/api/buygame/tasks');
		state.buygame.tasks = Array.isArray(data.tasks) ? data.tasks : [];
		renderBuyGame();
	} catch (_) { /* 忽略 */ }
}

function mergeBuyGameTask(task, completed) {
	if (!task || !task.id) {
		return;
	}
	const list = state.buygame.tasks;
	const idx = list.findIndex(t => t.id === task.id);
	if (idx >= 0) {
		list[idx] = task;
	} else {
		list.unshift(task);
	}
	if (state.activeModule === 'buygame') {
		renderBuyGame();
	}
	if (completed) {
		const fail = Number(task.failCount || 0);
		if (task.dryRun) {
			const ok = (task.accounts || []).filter(a => a.status === 'verified').length;
			toast(`试运行完成：${ok} 个账号验证通过${fail ? '，' + fail + ' 个失败' : ''}`, fail ? 'warn' : 'success');
		} else {
			toast(`购买完成：成功 ${Number(task.successCount || 0)}，失败 ${fail}`, fail ? 'warn' : 'success');
		}
	}
}

function firstSelectedBuyGameAttemptId() {
	const first = [...state.buygame.selectedAccounts][0];
	if (!first) {
		return '';
	}
	const acc = state.buygame.accounts.find(a => a.account === first);
	return acc ? acc.attemptId : '';
}

function renderBuyGame() {
	const accountCount = $('buygame-account-count');
	if (!accountCount) {
		return; // 模块未渲染
	}
	const selected = [...state.buygame.selectedAccounts];
	const validGames = state.buygame.games.filter(g => !g.error && !g.resolving);
	accountCount.textContent = `在线账户：${state.buygame.accounts.length}`;
	$('buygame-selected-count').textContent = `已选账户：${selected.length}`;
	$('buygame-game-count').textContent = `游戏：${state.buygame.games.length}`;
	$('buygame-task-count').textContent = `任务数：${state.buygame.tasks.length}`;
	$('buygame-refresh-accounts').disabled = state.buygame.loadingAccounts;
	$('buygame-buy-btn').disabled = state.buygame.submitting || selected.length === 0 || validGames.length === 0;

	renderBuyGameAccountSelect(selected);
	renderBuyGameList();
	renderBuyGameResults();
}

// 换账号后,游戏价格按新区域重算(首个已选账号变化时触发)。
function repriceBuyGameGamesIfNeeded() {
	const id = firstSelectedBuyGameAttemptId();
	if (id === state.buygame.pricedFor) {
		return;
	}
	state.buygame.pricedFor = id;
	const games = state.buygame.games;
	if (!games.length) {
		return;
	}
	games.forEach(game => { game.resolving = true; game.error = ''; });
	renderBuyGame();
	games.forEach(resolveBuyGameGame);
}

function selectAllBuyGameAccounts() {
	state.buygame.selectedAccounts = new Set(state.buygame.accounts.map(a => a.account));
	renderBuyGame();
	repriceBuyGameGamesIfNeeded();
}

function clearBuyGameAccounts() {
	state.buygame.selectedAccounts = new Set();
	renderBuyGame();
	repriceBuyGameGamesIfNeeded();
}

function renderBuyGameAccountSelect(selected) {
	const toggle = $('buygame-account-select-toggle');
	const label = $('buygame-account-select-label');
	const menu = $('buygame-account-select-menu');
	const optionsBox = $('buygame-account-select-options');
	if (!toggle || !label || !optionsBox) {
		return;
	}
	const accounts = state.buygame.accounts;
	const hasAccounts = accounts.length > 0;
	toggle.disabled = !hasAccounts;
	if (!hasAccounts && menu) {
		menu.hidden = true;
		toggle.setAttribute('aria-expanded', 'false');
	}

	optionsBox.textContent = '';
	if (hasAccounts) {
		for (const account of accounts) {
			const checked = state.buygame.selectedAccounts.has(account.account);
			const row = document.createElement('label');
			row.className = 'purchase-account-option';
			row.innerHTML = `
				<input type="checkbox" value="${escapeAttr(account.account)}" ${checked ? 'checked' : ''}>
				<span class="purchase-account-option-name" title="${escapeAttr(account.account)}">${escapeHtml(account.account)}</span>
				<span class="purchase-account-option-balance">余额：${escapeHtml(formatBalance(account))}</span>
			`;
			optionsBox.appendChild(row);
		}
	} else if (state.buygame.loadingAccounts) {
		optionsBox.innerHTML = '<div class="purchase-account-select-empty">正在加载在线账户...</div>';
	} else if (state.buygame.accountError) {
		optionsBox.innerHTML = `<div class="purchase-account-select-empty">${escapeHtml(state.buygame.accountError)}</div>`;
	} else {
		optionsBox.innerHTML = '<div class="purchase-account-select-empty">暂无在线账户，先在账户页登录</div>';
	}

	const count = selected.length;
	if (!hasAccounts && state.buygame.loadingAccounts) {
		label.textContent = '正在加载在线账户...';
	} else if (!hasAccounts) {
		label.textContent = '暂无在线账户';
	} else if (count === 0) {
		label.textContent = '请选择在线账户';
	} else if (count === 1) {
		label.textContent = `已选 1 个：${selected[0]}`;
	} else {
		label.textContent = `已选 ${count} 个账户`;
	}
}

// 当前游戏价格按第一个已选账号的区域/货币解析。
function buyGamePricingCurrency() {
	const first = [...state.buygame.selectedAccounts][0];
	if (first) {
		const acc = state.buygame.accounts.find(a => a.account === first);
		if (acc && acc.currency != null) {
			return Number(acc.currency);
		}
	}
	return null;
}

// 金额格式化:有数字货币枚举时用与“余额”一致的货币符号(如 $U16.00),否则退回 ISO。
function formatBuyGameMoney(cents, currency, currencyISO) {
	const major = (Number(cents) / 100).toFixed(2);
	if (currency != null) {
		return `${currencySymbol(currency)}${major}`;
	}
	return `${major} ${currencyISO || ''}`.trim();
}

function formatBuyGamePrice(game) {
	if (game.resolving) {
		return '解析中…';
	}
	if (game.error) {
		return game.error;
	}
	if (!game.priceCents) {
		return '免费 / 无价格';
	}
	const off = game.discountPercent ? ` (-${game.discountPercent}%)` : '';
	// 用已选账号的钱包货币展示(与该账号区域价一致),没选账号时退回 ISO。
	return `${formatBuyGameMoney(game.priceCents, buyGamePricingCurrency(), game.currencyISO)}${off}`;
}

function renderBuyGameList() {
	const list = $('buygame-list');
	const empty = $('buygame-list-empty');
	if (!list) {
		return;
	}
	const games = state.buygame.games;
	empty.hidden = games.length > 0;
	list.textContent = '';
	for (const game of games) {
		const row = document.createElement('div');
		row.className = 'buygame-list-row' + (game.error ? ' has-error' : '');
		row.innerHTML = `
			<div class="buygame-list-main">
				<span class="buygame-list-name">${escapeHtml(game.name || ('subid ' + game.packageId))}</span>
				<span class="buygame-list-sub">subid ${game.packageId}${game.appid ? ' · app ' + game.appid : ''}</span>
			</div>
			<span class="buygame-list-price${game.error ? ' is-error' : ''}">${formatBuyGamePrice(game)}</span>
			<button type="button" class="buygame-list-remove" data-buygame-remove="${game.packageId}" title="移除">✕</button>
		`;
		list.appendChild(row);
	}
}

// 购买结果(对齐充值码兑换的结果表):展示最近一个任务的逐账号结果。
function renderBuyGameResults() {
	const tbody = $('buygame-result-rows');
	const empty = $('buygame-result-empty');
	const progress = $('buygame-progress');
	if (!tbody) {
		return;
	}
	const task = state.buygame.tasks[0] || null;
	tbody.innerHTML = '';

	if (!task) {
		empty.hidden = false;
		if (progress) {
			progress.textContent = '未开始';
		}
		return;
	}

	const accounts = task.accounts || [];
	empty.hidden = accounts.length > 0;
	const taskZh = {queued: '排队', running: '进行中', completed: '已完成', failed: '失败'}[task.status] || task.status;
	if (progress) {
		const threadInfo = task.concurrency ? ` · ${task.concurrency} 线程` : '';
		progress.textContent = `${task.dryRun ? '试运行' : '真实购买'} · ${taskZh}${threadInfo} · ${task.processedAccounts}/${task.totalAccounts} · 成功 ${task.successCount} 失败 ${task.failCount}`;
	}

	const accZh = {queued: '排队', running: '购买中', verified: '验证通过', success: '成功', failed: '失败'};
	const chipMap = {success: 'success', verified: 'success', failed: 'error', running: 'pending', queued: 'pending'};
	accounts.forEach((acc, index) => {
		const tr = document.createElement('tr');

		const idxCell = document.createElement('td');
		idxCell.className = 'wallet-idx-cell';
		idxCell.textContent = String(index + 1);
		tr.appendChild(idxCell);

		const accountCell = document.createElement('td');
		accountCell.className = 'wallet-account-cell';
		accountCell.textContent = acc.account || '-';
		tr.appendChild(accountCell);

		const statusCell = document.createElement('td');
		const chip = document.createElement('span');
		chip.className = 'wallet-status is-' + (chipMap[acc.status] || 'pending');
		chip.textContent = accZh[acc.status] || acc.status;
		statusCell.appendChild(chip);
		tr.appendChild(statusCell);

		const costCell = document.createElement('td');
		costCell.className = 'buygame-cost-cell';
		// 花费转换成与该账号余额一致的货币(spentCents 来自 getfinalprice,本就是账号钱包货币)。
		costCell.textContent = acc.spentCents != null ? formatBuyGameMoney(acc.spentCents, acc.currency, acc.currencyISO) : '-';
		tr.appendChild(costCell);

		const detailCell = document.createElement('td');
		if (acc.status === 'failed') {
			detailCell.textContent = acc.error || '失败';
		} else if (acc.transId) {
			detailCell.textContent = (task.dryRun ? '已验证 · 交易号 ' : '交易号 ') + acc.transId;
		} else {
			detailCell.textContent = '';
		}
		tr.appendChild(detailCell);

		tbody.appendChild(tr);
	});
}

async function addBuyGameSubids(text) {
	const ids = String(text || '')
		.split(/[\s,，]+/)
		.map(x => Number(x.trim()))
		.filter(id => Number.isInteger(id) && id > 0);
	if (!ids.length) {
		toast('请输入有效的 subid', 'warn');
		return;
	}
	state.buygame.pricedFor = firstSelectedBuyGameAttemptId();   // 记录本次解析所用区域,避免随后重复重算
	const existing = new Set(state.buygame.games.map(g => g.packageId));
	const fresh = [];
	for (const id of ids) {
		if (existing.has(id)) {
			continue;
		}
		const game = {packageId: id, name: '', priceCents: 0, currencyISO: '', appid: 0, discountPercent: 0, resolving: true, error: ''};
		state.buygame.games.push(game);
		fresh.push(game);
	}
	renderBuyGame();
	await Promise.all(fresh.map(resolveBuyGameGame));
}

async function resolveBuyGameGame(game) {
	const accId = firstSelectedBuyGameAttemptId();
	const url = `/api/buygame/resolve?packageId=${game.packageId}` + (accId ? `&accountId=${encodeURIComponent(accId)}` : '');
	try {
		const data = await getJson(url);
		const pkg = data.package || {};
		game.name = pkg.name || ('subid ' + game.packageId);
		game.priceCents = Number(pkg.priceCents || 0);
		game.currencyISO = pkg.currencyISO || '';
		game.appid = Number(pkg.appid || 0);
		game.discountPercent = Number(pkg.discountPercent || 0);
		game.error = '';
	} catch (err) {
		game.error = err.message || '解析失败';
	} finally {
		game.resolving = false;
		renderBuyGame();
	}
}

// 读取并发线程数输入(1-10,默认 3)
function buyGameConcurrency() {
	const input = $('buygame-concurrency');
	const n = Math.round(Number(input && input.value));
	if (!Number.isFinite(n) || n < 1) {
		return 3;
	}
	return Math.min(10, n);
}

async function submitBuyGame() {
	const selected = [...state.buygame.selectedAccounts];
	const games = state.buygame.games.filter(g => !g.error && !g.resolving);
	if (!selected.length) {
		toast('请先选择购买账户', 'warn');
		return;
	}
	if (!games.length) {
		toast('请先添加要购买的游戏', 'warn');
		return;
	}
	const packageIds = games.map(g => g.packageId);

	const perAccountCents = games.reduce((sum, g) => sum + Number(g.priceCents || 0), 0);
	const perAccount = formatBuyGameMoney(perAccountCents, buyGamePricingCurrency(), games[0] && games[0].currencyISO);
	const ok = await confirmDialog(
		`将用 ${selected.length} 个账号、每个账号购买 ${games.length} 款游戏。\n每账号约 ${perAccount}（最终以各自区域价为准），用钱包余额真实扣款且不可逆。确认购买？`,
		{title: '确认真实购买', confirmText: '确认购买', cancelText: '取消', danger: true}
	);
	if (!ok) {
		return;
	}

	const items = selected.map(name => {
		const acc = state.buygame.accounts.find(a => a.account === name);
		return acc ? {accountId: acc.attemptId, packageIds} : null;
	}).filter(Boolean);

	const concurrency = buyGameConcurrency();

	state.buygame.submitting = true;
	renderBuyGame();
	try {
		await postJson('/api/buygame/tasks', {items, dryRun: false, concurrency});
		toast(`已提交购买任务（${concurrency} 线程）`, 'success');
	} catch (err) {
		toast('提交失败：' + err.message, 'error');
	} finally {
		state.buygame.submitting = false;
		renderBuyGame();
	}
}

// 绑定买游戏模块交互(初始化时调用一次)。
function bindBuyGame() {
	const refreshBtn = $('buygame-refresh-accounts');
	if (refreshBtn) {
		refreshBtn.addEventListener('click', () => refreshBuyGameAccounts());
	}
	const selectAllBtn = $('buygame-select-all');
	if (selectAllBtn) {
		selectAllBtn.addEventListener('click', selectAllBuyGameAccounts);
	}
	const selectNoneBtn = $('buygame-select-none');
	if (selectNoneBtn) {
		selectNoneBtn.addEventListener('click', clearBuyGameAccounts);
	}

	// 账户多选下拉
	const wrapper = $('buygame-account-multiselect');
	const toggle = $('buygame-account-select-toggle');
	const menu = $('buygame-account-select-menu');
	const optionsBox = $('buygame-account-select-options');
	if (wrapper && toggle && menu && optionsBox) {
		toggle.addEventListener('click', () => {
			if (toggle.disabled) {
				return;
			}
			const willOpen = menu.hidden;
			menu.hidden = !willOpen;
			toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
		});
		optionsBox.addEventListener('change', event => {
			const input = event.target;
			if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') {
				return;
			}
			const name = String(input.value || '').trim();
			if (!name) {
				return;
			}
			if (input.checked) {
				state.buygame.selectedAccounts.add(name);
			} else {
				state.buygame.selectedAccounts.delete(name);
			}
			renderBuyGame();
			repriceBuyGameGamesIfNeeded();
		});
		menu.addEventListener('click', event => {
			event.stopPropagation();
			if (event.target.closest('[data-buygame-account-all]')) {
				selectAllBuyGameAccounts();
			} else if (event.target.closest('[data-buygame-account-none]')) {
				clearBuyGameAccounts();
			}
		});
		document.addEventListener('click', event => {
			if (!menu.hidden && !wrapper.contains(event.target)) {
				menu.hidden = true;
				toggle.setAttribute('aria-expanded', 'false');
			}
		});
	}

	// 添加 subid
	const input = $('buygame-subid-input');
	const addBtn = $('buygame-add-btn');
	const doAdd = () => {
		if (!input) {
			return;
		}
		const text = input.value;
		input.value = '';
		addBuyGameSubids(text);
	};
	if (addBtn) {
		addBtn.addEventListener('click', doAdd);
	}
	if (input) {
		input.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				doAdd();
			}
		});
	}

	// 游戏列表移除
	const list = $('buygame-list');
	if (list) {
		list.addEventListener('click', event => {
			const btn = event.target.closest('[data-buygame-remove]');
			if (!btn) {
				return;
			}
			const id = Number(btn.dataset.buygameRemove);
			state.buygame.games = state.buygame.games.filter(g => g.packageId !== id);
			renderBuyGame();
		});
	}

	// 购买
	const buyBtn = $('buygame-buy-btn');
	if (buyBtn) {
		buyBtn.addEventListener('click', submitBuyGame);
	}
}

// ===== 市场求购(Steam 社区市场 createbuyorder)=====

function ensureMarketLoaded() {
	if (state.activeModule !== 'market-buyorder') {
		return;
	}
	if (!state.marketBuyorder.loadingAccounts) {
		refreshMarketAccounts({silent: true});
	}
	loadMarketOrders();
}

async function refreshMarketAccounts(options = {}) {
	const silent = !!options.silent;
	const m = state.marketBuyorder;
	m.loadingAccounts = true;
	m.accountError = '';
	if (!silent) {
		renderMarketBuyorder();
	}
	try {
		const data = await getJson('/api/market/online-accounts');
		m.accounts = Array.isArray(data.accounts) ? data.accounts : [];
		// 移除已离线的已选账号
		const live = new Set(m.accounts.map(a => a.account));
		m.selectedAccounts = new Set([...m.selectedAccounts].filter(a => live.has(a)));
	} catch (err) {
		m.accountError = err.message || '加载账户失败';
		if (!silent) {
			addLine('error', '市场求购在线账户刷新失败: ' + err.message);
		}
	} finally {
		m.loadingAccounts = false;
		renderMarketBuyorder();
	}
}

// 面板实际显示的求购单:账本全量 ∩ 本次可见集合。visibleOrderIds 为 null 时什么都不显示。
function visibleMarketOrders() {
	const m = state.marketBuyorder;
	if (!m.visibleOrderIds) {
		return [];
	}
	return (m.orders || []).filter(o => o && m.visibleOrderIds.has(o.id));
}

async function loadMarketOrders() {
	try {
		const data = await getJson('/api/market/buyorders');
		state.marketBuyorder.orders = Array.isArray(data.orders) ? data.orders : [];
		renderMarketBuyorder();
	} catch (_) { /* 忽略 */ }
}

// 挂单/刷新的并发线程数(默认 2,限 1~8)。
function marketConcurrency() {
	const el = $('market-concurrency-input');
	const n = el ? Math.round(Number(el.value)) : 2;
	return Math.max(1, Math.min(8, Number.isFinite(n) && n > 0 ? n : 2));
}

// 刷新求购单:对选中的在线账号从 Steam 实拉真实求购单对账(成交/撤销/过期的移除,剩余数量更新),
// 并把面板收窄到这些账号——这也是查看/撤销之前挂出的单的入口。
async function syncMarketOrders() {
	const m = state.marketBuyorder;
	const btn = $('market-refresh-orders');
	// 只对账用户在左侧选中的在线账号;没选就沿用当前面板里已显示的那些账号。
	// 不再遍历整个账本——那会把早已登出的历史账号也捞进来,刷一次报一堆「未在线」。
	const selected = [...m.selectedAccounts];
	const targets = selected.length
		? selected
		: [...new Set(visibleMarketOrders().map(o => o.account).filter(Boolean))];
	if (!targets.length) {
		toast('请先在左侧选择要查看求购单的在线账户', 'warn');
		return;
	}
	setUuButtonBusy(btn, true, '刷新中…');
	try {
		const data = await postJson('/api/market/buyorders/sync', {
			concurrency: marketConcurrency(),
			accounts: targets
		});
		if (Array.isArray(data.orders)) {
			m.orders = data.orders;
		}
		// 面板收窄到「这次实拉成功的账号」的求购单——历史记录仍在账本里,只是不显示。
		const synced = new Set(Array.isArray(data.syncedAccounts) ? data.syncedAccounts : []);
		m.visibleOrderIds = new Set(
			(m.orders || []).filter(o => o && synced.has(o.account)).map(o => o.id)
		);
		renderMarketBuyorder();
		const s = data.summary || {};
		const parts = [];
		if (s.removed) parts.push(`移除 ${s.removed}`);
		if (s.updated) parts.push(`更新 ${s.updated}`);
		toast(parts.length ? ('已刷新：' + parts.join('，')) : '已是最新', 'success');
		const offline = (s.accounts || []).filter(a => !a.ok);
		if (offline.length) {
			toast(`${offline.length} 个账号未刷新(${offline.map(a => a.account + '：' + a.error).join('；')})`, 'warn');
		}
	} catch (err) {
		toast('刷新失败：' + (err.message || '未知错误'), 'error');
	} finally {
		setUuButtonBusy(btn, false);
	}
}

// 已选账号的共同币种;混选不同币种时 mixed=true(求购价无法用单一币种表达)。
function marketSelectedCurrency() {
	const m = state.marketBuyorder;
	const accs = [...m.selectedAccounts]
		.map(name => m.accounts.find(a => a.account === name))
		.filter(Boolean);
	if (!accs.length) {
		return {currency: null, currencyISO: '', mixed: false, count: 0};
	}
	const ids = new Set(accs.map(a => Number(a.currency)));
	if (ids.size > 1) {
		return {currency: null, currencyISO: '', mixed: true, count: accs.length};
	}
	return {currency: Number(accs[0].currency), currencyISO: accs[0].currencyISO || '', mixed: false, count: accs.length};
}

// 勾选「各账号按余额挂满」时:每个所选账号各自 qty = floor(该账号余额 / 每件价),互不影响。
// 用分为单位做整除避免浮点误差。返回 {ok, items:[{account,balance,qty,known}], total, unknown, currency}:
//   ok=false 表示无法计算(未选账号 / 币种混合 / 单价无效);
//   unknown=true 表示有账号缺余额信息(该账号按 0 件处理,提示刷新账户)。
function marketPerAccountMax() {
	const m = state.marketBuyorder;
	const priceEl = $('market-price-input');
	const price = priceEl ? Number(priceEl.value) : 0;
	const cur = marketSelectedCurrency();
	if (cur.mixed || cur.currency == null || !Number.isFinite(price) || price <= 0) {
		return {ok: false, items: [], total: 0, unknown: false, currency: cur.currency};
	}
	const accs = [...m.selectedAccounts]
		.map(name => m.accounts.find(a => a.account === name))
		.filter(Boolean);
	if (!accs.length) {
		return {ok: false, items: [], total: 0, unknown: false, currency: cur.currency};
	}
	const priceCents = Math.round(price * 100);
	let unknown = false;
	const items = accs.map(a => {
		const known = a.hasWallet && Number.isFinite(Number(a.balance));
		if (!known) {
			unknown = true;
			return {account: a.account, balance: null, qty: 0, known: false};
		}
		const qty = priceCents > 0 ? Math.floor(Math.round(Number(a.balance) * 100) / priceCents) : 0;
		return {account: a.account, balance: Number(a.balance), qty: Math.max(0, qty), known: true};
	});
	const total = items.reduce((s, x) => s + x.qty, 0);
	return {ok: true, items, total, unknown, currency: cur.currency};
}

// 「各账号按余额挂满」是否勾选。
function marketMaxPerAccountOn() {
	const el = $('market-max-per-account');
	return !!(el && el.checked);
}

// 全选:按已锁定币种(或列表首个账号的币种)选满,保持「同一币种」不变量。
function selectAllMarketAccounts() {
	const m = state.marketBuyorder;
	if (!m.accounts.length) {
		return;
	}
	const cur = marketSelectedCurrency();
	const target = (!cur.mixed && cur.currency != null) ? cur.currency : Number(m.accounts[0].currency);
	m.selectedAccounts = new Set(m.accounts.filter(a => Number(a.currency) === target).map(a => a.account));
	renderMarketBuyorder();
}

function clearMarketAccounts() {
	state.marketBuyorder.selectedAccounts = new Set();
	renderMarketBuyorder();
}

function renderMarketBuyorder() {
	const accountCount = $('market-account-count');
	if (!accountCount) {
		return; // 模块未渲染
	}
	const m = state.marketBuyorder;
	const selected = [...m.selectedAccounts];
	accountCount.textContent = `在线账户：${m.accounts.length}`;
	$('market-selected-count').textContent = `已选账户：${selected.length}`;
	// 计数跟着面板走:显示的是本次挂单/本次刷新的条数,不是账本全量。
	$('market-order-count').textContent = `我的求购：${visibleMarketOrders().length}`;

	const cur = marketSelectedCurrency();
	const hint = $('market-currency-hint');
	if (hint) {
		if (cur.mixed) {
			hint.textContent = '币种：混合(需统一)';
		} else if (cur.currency != null) {
			hint.textContent = `币种：${cur.currencyISO || cur.currency}`;
		} else {
			hint.textContent = '币种：-';
		}
	}

	const prefix = $('market-currency-prefix');
	if (prefix) {
		prefix.textContent = cur.currency != null ? (currencySymbol(cur.currency) || cur.currencyISO || '?') : '-';
	}

	const refreshBtn = $('market-refresh-accounts');
	if (refreshBtn) {
		refreshBtn.disabled = m.loadingAccounts;
	}

	const priceEl = $('market-price-input');
	const qtyEl = $('market-qty-input');
	const urlEl = $('market-url-input');
	const price = priceEl ? Number(priceEl.value) : 0;
	const qty = qtyEl ? Math.round(Number(qtyEl.value)) : 0;
	const url = urlEl ? String(urlEl.value || '').trim() : '';
	const validPrice = Number.isFinite(price) && price > 0;
	const validQty = Number.isInteger(qty) && qty > 0;

	const sym = cur.currency != null ? (currencySymbol(cur.currency) || cur.currencyISO || '') : '';
	// 「各账号按余额挂满」:勾选后忽略数量框,每个账号各自按余额取最大;数量框禁用。
	const perMaxOn = marketMaxPerAccountOn();
	const perMax = perMaxOn ? marketPerAccountMax() : null;
	if (qtyEl) {
		qtyEl.disabled = perMaxOn;
		// 挂满模式:数量框只读展示「最大求购数量」(各账号合计);详细每账号数量在下方逐行列出。
		if (perMaxOn && perMax && perMax.ok) {
			qtyEl.value = String(perMax.total);
		}
	}
	// 挂满模式下「求购数量」有效性 = 至少有一个账号能挂 1 件；固定模式下 = 数量框为正整数。
	const qtyOk = perMaxOn ? (!!perMax && perMax.ok && perMax.total > 0) : validQty;

	const totalLabel = $('market-total-label');
	const totalEl = $('market-total');
	if (totalLabel) {
		totalLabel.textContent = perMaxOn ? '各账号合计求购' : '单账号总出价';
	}
	if (totalEl) {
		if (perMaxOn) {
			totalEl.textContent = (perMax && perMax.ok && perMax.total > 0) ? `约 ${perMax.total} 件` : '-';
		} else if (cur.currency != null && validPrice && validQty) {
			totalEl.textContent = `${sym}${(price * qty).toFixed(2)}`;
		} else {
			totalEl.textContent = '-';
		}
	}

	// 挂满预览:合计件数 + 各账号「单独每行」明细(账号 / 余额 / 该账号最大求购数量)。
	const maxHint = $('market-max-qty-hint');
	if (maxHint) {
		if (perMaxOn && perMax && perMax.ok && perMax.items.length) {
			let head = `各账号按余额挂满,合计约 ${perMax.total} 件`;
			if (perMax.unknown) {
				head += '（部分账号余额未知，按 0 件跳过，请先刷新账户）';
			}
			const rowsHtml = perMax.items.map(x => {
				const balText = x.known ? `${sym}${x.balance.toFixed(2)}` : '余额未知';
				const qtyText = x.known ? `${x.qty} 件` : '跳过';
				return `<div class="market-maxrow">`
					+ `<span class="market-maxrow-acc" title="${escapeAttr(x.account)}">${escapeHtml(x.account)}</span>`
					+ `<span class="market-maxrow-bal">${escapeHtml(balText)}</span>`
					+ `<span class="market-maxrow-qty">${escapeHtml(qtyText)}</span>`
					+ `</div>`;
			}).join('');
			maxHint.hidden = false;
			maxHint.innerHTML = `<div class="market-maxrow-head">${escapeHtml(head)}</div>${rowsHtml}`;
		} else if (perMaxOn && validPrice && selected.length) {
			maxHint.hidden = false;
			maxHint.textContent = '所选账号余额均不足以按当前单价求购 1 件（或余额未知，请刷新账户）';
		} else {
			maxHint.hidden = true;
			maxHint.textContent = '';
		}
	}

	const placeBtn = $('market-place-btn');
	if (placeBtn) {
		placeBtn.disabled = m.placing || !selected.length || cur.mixed || cur.currency == null || !validPrice || !qtyOk || !url;
	}

	renderMarketAccountSelect(selected);
	renderMarketContext();
	renderMarketOrders();
}

function renderMarketAccountSelect(selected) {
	const toggle = $('market-account-select-toggle');
	const label = $('market-account-select-label');
	const menu = $('market-account-select-menu');
	const optionsBox = $('market-account-select-options');
	if (!toggle || !label || !optionsBox) {
		return;
	}
	const m = state.marketBuyorder;
	const accounts = m.accounts;
	const hasAccounts = accounts.length > 0;
	toggle.disabled = !hasAccounts;
	if (!hasAccounts && menu) {
		menu.hidden = true;
		toggle.setAttribute('aria-expanded', 'false');
	}

	// 已锁定币种后,异币种账号置灰,从源头杜绝「币种混合」。
	const cur = marketSelectedCurrency();
	const lockCurrency = (!cur.mixed && cur.currency != null) ? cur.currency : null;

	optionsBox.textContent = '';
	if (hasAccounts) {
		for (const account of accounts) {
			const checked = m.selectedAccounts.has(account.account);
			const disabled = lockCurrency != null && !checked && Number(account.currency) !== lockCurrency;
			const row = document.createElement('label');
			row.className = 'purchase-account-option' + (disabled ? ' market-option-disabled' : '');
			row.innerHTML = `
				<input type="checkbox" value="${escapeAttr(account.account)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
				<span class="purchase-account-option-name" title="${escapeAttr(account.account)}">${escapeHtml(account.account)}</span>
				<span class="purchase-account-option-balance">${escapeHtml(account.currencyISO || '')} · ${escapeHtml(formatBalance(account))}</span>
			`;
			optionsBox.appendChild(row);
		}
	} else if (m.loadingAccounts) {
		optionsBox.innerHTML = '<div class="purchase-account-select-empty">正在加载在线账户...</div>';
	} else if (m.accountError) {
		optionsBox.innerHTML = `<div class="purchase-account-select-empty">${escapeHtml(m.accountError)}</div>`;
	} else {
		optionsBox.innerHTML = '<div class="purchase-account-select-empty">暂无在线账户，先在账户页登录</div>';
	}

	const count = selected.length;
	if (!hasAccounts && m.loadingAccounts) {
		label.textContent = '正在加载在线账户...';
	} else if (!hasAccounts) {
		label.textContent = '暂无在线账户';
	} else if (count === 0) {
		label.textContent = '请选择在线账户';
	} else if (count === 1) {
		label.textContent = `已选 1 个：${selected[0]}`;
	} else {
		label.textContent = `已选 ${count} 个账户`;
	}
}

function renderMarketContext() {
	const box = $('market-context');
	if (!box) {
		return;
	}
	const m = state.marketBuyorder;
	if (m.contextLoading) {
		box.hidden = false;
		box.innerHTML = '<span class="muted">正在获取行情…</span>';
		return;
	}
	const ctx = m.context;
	if (!ctx) {
		box.hidden = true;
		box.innerHTML = '';
		return;
	}
	const sym = currencySymbol(ctx.currency) || ctx.currencyISO || '';
	const fmtCents = c => (c == null ? '—' : `${sym}${(Number(c) / 100).toFixed(2)}`);
	// 最低在售:优先用盘口(itemordershistogram)的精确值;盘口缺失(无 nameid)时回退到
	// priceoverview 的 lowest_price 文本(不需要 nameid,Steam 改版后仍可用)。
	const lowestSellText = ctx.lowestSellOrderCents != null
		? fmtCents(ctx.lowestSellOrderCents)
		: (ctx.lowestPrice || '—');
	const chips = [
		`<span class="market-chip market-chip-buy">最高求购 <strong>${escapeHtml(fmtCents(ctx.highestBuyOrderCents))}</strong></span>`,
		`<span class="market-chip market-chip-sell">最低在售 <strong>${escapeHtml(lowestSellText)}</strong></span>`
	];
	if (ctx.medianPrice) {
		chips.push(`<span class="market-chip">成交均价 <strong>${escapeHtml(ctx.medianPrice)}</strong></span>`);
	}
	if (ctx.volume) {
		chips.push(`<span class="market-chip">24h 销量 <strong>${escapeHtml(ctx.volume)}</strong></span>`);
	}
	let suggest = '';
	if (ctx.highestBuyOrderCents != null) {
		const v = ((Number(ctx.highestBuyOrderCents) + 1) / 100).toFixed(2);
		suggest = `<button type="button" class="market-suggest-btn" data-market-suggest="${escapeAttr(v)}">↑ 比最高求购高一档 ${sym}${v}</button>`;
	}
	// 没拿到最高求购 = 缺 item_nameid。CS2/TF2 由本地内置数据库自动解析,命不中多为冷门物品/其它游戏。
	let note = '';
	if (ctx.highestBuyOrderCents == null) {
		note = `<div class="market-context-note muted">未取到「最高求购」。CS2/TF2 会自动从本地数据库解析；若仍为空，多为冷门物品或其它游戏（最低在售/均价/销量不受影响）。</div>`;
	}
	box.hidden = false;
	box.innerHTML = `
		<div class="market-context-name">${escapeHtml(ctx.itemName || ctx.marketHashName)}</div>
		<div class="market-chips">${chips.join('')}</div>
		${suggest}
		${note}
	`;
}

function renderMarketOrders() {
	const tbody = $('market-order-rows');
	const empty = $('market-order-empty');
	if (!tbody) {
		return;
	}
	const orders = visibleMarketOrders();
	tbody.innerHTML = '';
	if (!orders.length) {
		if (empty) {
			empty.textContent = state.marketBuyorder.visibleOrderIds
				? '本次没有可显示的求购单'
				: '挂完求购单后显示本次结果；查看/撤销之前挂出的单，请在左侧选中对应在线账户后点「刷新」';
			empty.hidden = false;
		}
		return;
	}
	if (empty) {
		empty.hidden = true;
	}
	for (const o of orders) {
		const unit = `${currencySymbol(o.currency) || o.currencyISO || ''}${(Number(o.pricePerItemCents) / 100).toFixed(2)}`;
		// 未确认的求购单(自动手机确认失败/未导入 maFile):标出来,提醒去 Steam 手机 App 确认后才生效。
		const pendingTag = o.status === 'pending_confirm'
			? ' <span class="market-pending-tag" title="该求购单尚未经 Steam 手机令牌确认,需在 Steam 手机 App 确认后才会生效">待手机确认</span>'
			: '';
		// 数量:刷新过且有部分成交时显示「剩余/总」,否则只显示总数。
		const qty = Number(o.quantity);
		const rem = o.quantityRemaining;
		const qtyText = (rem != null && Number(rem) !== qty) ? `${Number(rem)}/${qty}` : `${qty}`;
		const tr = document.createElement('tr');
		tr.innerHTML = `
			<td title="${escapeAttr(o.account)}">${escapeHtml(o.account)}</td>
			<td title="${escapeAttr(o.itemName || o.marketHashName)}">${escapeHtml(o.itemName || o.marketHashName)}${pendingTag}</td>
			<td>${escapeHtml(unit)}</td>
			<td class="wallet-idx-cell" title="剩余/总数量">${escapeHtml(qtyText)}</td>
			<td><button type="button" class="danger-btn market-cancel-btn" data-market-cancel="${escapeAttr(o.id)}">撤销</button></td>
		`;
		tbody.appendChild(tr);
	}
}

async function fetchMarketContextForUI() {
	const m = state.marketBuyorder;
	const url = ($('market-url-input').value || '').trim();
	if (!url) {
		toast('请先粘贴商品链接', 'warn');
		return;
	}
	const firstSel = [...m.selectedAccounts][0];
	if (!firstSel) {
		toast('请先选择一个账户(按其钱包币种获取行情)', 'warn');
		return;
	}
	const acc = m.accounts.find(a => a.account === firstSel);
	if (!acc) {
		toast('账户不可用,请刷新账户', 'warn');
		return;
	}
	const btn = $('market-fetch-btn');
	setUuButtonBusy(btn, true, '查询中…');
	m.contextLoading = true;
	m.contextError = '';
	renderMarketContext();
	try {
		const qs = '/api/market/context?accountId=' + encodeURIComponent(acc.attemptId) + '&url=' + encodeURIComponent(url);
		const data = await getJson(qs);
		m.context = data.context || null;
	} catch (err) {
		m.context = null;
		m.contextError = err.message || '行情获取失败';
		toast('行情获取失败：' + m.contextError, 'error');
	} finally {
		m.contextLoading = false;
		setUuButtonBusy(btn, false);
		renderMarketBuyorder();
	}
}

async function placeMarketBuyOrder() {
	const m = state.marketBuyorder;
	const selected = [...m.selectedAccounts];
	if (!selected.length) {
		toast('请先选择求购账户', 'warn');
		return;
	}
	const cur = marketSelectedCurrency();
	if (cur.mixed) {
		toast('所选账号钱包币种不一致,请只选同一币种的账号', 'warn');
		return;
	}
	if (cur.currency == null) {
		toast('所选账号钱包币种未知', 'warn');
		return;
	}
	const url = ($('market-url-input').value || '').trim();
	if (!url) {
		toast('请粘贴商品链接', 'warn');
		return;
	}
	const pricePerItem = Number($('market-price-input').value);
	if (!Number.isFinite(pricePerItem) || pricePerItem <= 0) {
		toast('请输入有效的每件求购价', 'warn');
		return;
	}

	const perAccountMax = marketMaxPerAccountOn();
	let quantity = 0;
	let perMax = null;
	if (perAccountMax) {
		perMax = marketPerAccountMax();
		if (!perMax.ok || perMax.total <= 0) {
			toast('所选账号余额均不足以按当前单价求购 1 件(或余额未知,请刷新账户)', 'warn');
			return;
		}
	} else {
		quantity = Math.round(Number($('market-qty-input').value));
		if (!Number.isInteger(quantity) || quantity <= 0) {
			toast('请输入有效的求购数量', 'warn');
			return;
		}
	}

	const sym = currencySymbol(cur.currency) || cur.currencyISO || '';
	const itemName = (m.context && m.context.itemName) ? m.context.itemName : '';
	// 挂满模式:各账号数量不同,确认框列出各账号将挂的件数(超过 8 个只列前几个)。
	const confirmMsg = perAccountMax
		? `将用 ${selected.length} 个账号「按各自余额挂满」求购${itemName ? '：' + itemName : ''}（并发 ${marketConcurrency()} 线程）。\n每件 ${sym}${pricePerItem.toFixed(2)}，每个账号各自 floor(余额 ÷ 单价) 件，合计约 ${perMax.total} 件：\n${perMax.items.slice(0, 8).map(x => `· ${x.account}：${x.known ? x.qty + ' 件' : '余额未知（跳过）'}`).join('\n')}${perMax.items.length > 8 ? `\n· …等 ${perMax.items.length} 个账号` : ''}\n求购单只在卖家成交时才从钱包扣款。确认挂单？`
		: `将用 ${selected.length} 个账号挂求购单（并发 ${marketConcurrency()} 线程）${itemName ? '：' + itemName : ''}。\n每件 ${sym}${pricePerItem.toFixed(2)} × ${quantity} 件 = 单账号总出价 ${sym}${(pricePerItem * quantity).toFixed(2)}。\n求购单只在卖家成交时才从钱包扣款。确认挂单？`;
	const ok = await confirmDialog(
		confirmMsg,
		{title: '确认挂求购单', confirmText: '确认挂单', cancelText: '取消', danger: true}
	);
	if (!ok) {
		return;
	}

	const accountIds = selected.map(name => {
		const acc = m.accounts.find(a => a.account === name);
		return acc ? acc.attemptId : name;
	});

	m.placing = true;
	renderMarketBuyorder();
	try {
		const payload = {accountIds, url, pricePerItem, itemName, concurrency: marketConcurrency()};
		if (perAccountMax) {
			payload.perAccountMax = true;
		} else {
			payload.quantity = quantity;
		}
		const data = await postJson('/api/market/buyorder', payload);
		const failed = (data.results || []).filter(r => !r.ok);
		if (data.placed > 0 && !failed.length) {
			toast(`已挂 ${data.placed} 张求购单`, 'success');
		} else if (data.placed > 0) {
			toast(`成功 ${data.placed} 张，失败 ${failed.length} 张`, 'warn');
		} else {
			toast('挂单失败：' + ((failed[0] && failed[0].error) || '未知错误'), 'error');
		}
		if (failed.length) {
			alertDialog(failed.map(r => `${r.account}：${r.error}`).join('\n'), {title: '部分账号挂单失败'});
		}
		// 面板只显示本次挂出的这一批(含待手机确认的),历史记录留在账本里但不铺出来。
		m.visibleOrderIds = new Set((data.results || []).map(r => r && r.recordId).filter(Boolean));
		await loadMarketOrders();
	} catch (err) {
		toast('挂单失败：' + err.message, 'error');
	} finally {
		m.placing = false;
		renderMarketBuyorder();
	}
}

async function cancelMarketOrder(id) {
	const o = state.marketBuyorder.orders.find(x => x.id === id);
	const label = o ? (o.itemName || o.marketHashName) : '';
	const ok = await confirmDialog(
		`撤销该求购单${label ? '：' + label : ''}？`,
		{title: '撤销求购单', confirmText: '撤销', cancelText: '取消', danger: true}
	);
	if (!ok) {
		return;
	}
	try {
		await postJson('/api/market/buyorder/cancel', {id});
		toast('已撤销', 'success');
		await loadMarketOrders();
	} catch (err) {
		toast('撤销失败：' + err.message, 'error');
	}
}

// 绑定市场求购模块交互(初始化时调用一次)。
function bindMarketBuyorder() {
	const refreshBtn = $('market-refresh-accounts');
	if (refreshBtn) {
		refreshBtn.addEventListener('click', () => refreshMarketAccounts());
	}

	// 账户多选下拉(限同一币种)
	const wrapper = $('market-account-multiselect');
	const toggle = $('market-account-select-toggle');
	const menu = $('market-account-select-menu');
	const optionsBox = $('market-account-select-options');
	if (wrapper && toggle && menu && optionsBox) {
		toggle.addEventListener('click', () => {
			if (toggle.disabled) {
				return;
			}
			const willOpen = menu.hidden;
			menu.hidden = !willOpen;
			toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
		});
		optionsBox.addEventListener('change', event => {
			const input = event.target;
			if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') {
				return;
			}
			const name = String(input.value || '').trim();
			if (!name) {
				return;
			}
			if (input.checked) {
				state.marketBuyorder.selectedAccounts.add(name);
			} else {
				state.marketBuyorder.selectedAccounts.delete(name);
			}
			renderMarketBuyorder();
		});
		menu.addEventListener('click', event => {
			event.stopPropagation();
			if (event.target.closest('[data-market-account-all]')) {
				selectAllMarketAccounts();
			} else if (event.target.closest('[data-market-account-none]')) {
				clearMarketAccounts();
			}
		});
		document.addEventListener('click', event => {
			if (!menu.hidden && !wrapper.contains(event.target)) {
				menu.hidden = true;
				toggle.setAttribute('aria-expanded', 'false');
			}
		});
	}

	const fetchBtn = $('market-fetch-btn');
	if (fetchBtn) {
		fetchBtn.addEventListener('click', fetchMarketContextForUI);
	}
	const urlInput = $('market-url-input');
	if (urlInput) {
		urlInput.addEventListener('input', () => {
			state.marketBuyorder.context = null;
			renderMarketBuyorder();
		});
		urlInput.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				fetchMarketContextForUI();
			}
		});
	}
	const priceInput = $('market-price-input');
	if (priceInput) {
		priceInput.addEventListener('input', renderMarketBuyorder);
	}
	const qtyInput = $('market-qty-input');
	if (qtyInput) {
		qtyInput.addEventListener('input', renderMarketBuyorder);
	}
	// 「各账号按余额挂满」勾选:切换后重渲染(禁用数量框、显示各账号预览)。
	const perAccountMaxToggle = $('market-max-per-account');
	if (perAccountMaxToggle) {
		perAccountMaxToggle.addEventListener('change', renderMarketBuyorder);
	}
	const placeBtn = $('market-place-btn');
	if (placeBtn) {
		placeBtn.addEventListener('click', placeMarketBuyOrder);
	}
	const refreshOrdersBtn = $('market-refresh-orders');
	if (refreshOrdersBtn) {
		refreshOrdersBtn.addEventListener('click', syncMarketOrders);
	}

	// 行情区:点“建议价”填入价格框
	const ctxBox = $('market-context');
	if (ctxBox) {
		ctxBox.addEventListener('click', event => {
			const sug = event.target.closest('[data-market-suggest]');
			if (sug && priceInput) {
				priceInput.value = sug.dataset.marketSuggest;
				renderMarketBuyorder();
			}
		});
	}

	// 我的求购单:撤销
	const orderRows = $('market-order-rows');
	if (orderRows) {
		orderRows.addEventListener('click', event => {
			const btn = event.target.closest('[data-market-cancel]');
			if (btn) {
				cancelMarketOrder(btn.dataset.marketCancel);
			}
		});
	}
}

function renderPurchaseItems(selectedAccounts, visibleItems) {
	const list = $('purchase-item-rows');
	list.textContent = '';

	const currentCurrencyISO = getPurchaseCurrentCurrencyISO(selectedAccounts);
	const fetchedAt = state.purchase.itemsFetchedAt ? formatPurchaseTime(state.purchase.itemsFetchedAt) : '-';
	const rateSummary = summarizePurchaseRates(currentCurrencyISO);
	const gameLabel = getPurchaseGameLabel();
	$('purchase-item-summary').innerHTML = [
		`<span>游戏：${escapeHtml(gameLabel)}</span>`,
		`<span>已选账号：${selectedAccounts.length}</span>`,
		`<span>当前币种：${escapeHtml(currentCurrencyISO)}</span>`,
		`<span>价格源：GC 商品目录</span>`,
		`<span title="${escapeAttr(rateSummary.title)}">${escapeHtml(rateSummary.text)}</span>`,
		`<span>更新时间：${escapeHtml(fetchedAt)}</span>`
	].join('');

	let message = '';
	if (state.purchase.loadingItems) {
		message = `正在加载 ${gameLabel} 商品目录...`;
	} else if (state.purchase.itemError) {
		message = state.purchase.itemError;
	} else if (!state.purchase.items.length) {
		message = `当前没有可用的 ${gameLabel} 商品`;
	} else if (!visibleItems.length) {
		message = '没有匹配当前搜索条件的商品';
	}

	if (message) {
		$('purchase-item-empty').textContent = message;
		$('purchase-item-empty').hidden = false;
		return;
	}

	$('purchase-item-empty').hidden = true;
	for (const group of groupPurchaseItems(visibleItems)) {
		const details = document.createElement('details');
		details.className = 'purchase-category';
		details.dataset.category = group.category;
		details.open = !state.purchase.collapsedCategories.has(group.category);
		details.innerHTML = `
			<summary class="purchase-category-summary">
				<div class="purchase-category-title">
					<strong>${escapeHtml(group.category)}</strong>
					<span>${group.items.length} 项</span>
				</div>
				<span class="purchase-category-meta">${escapeHtml(group.items[0] && group.items[0].type || group.category)}</span>
			</summary>
			<div class="purchase-category-body"></div>
		`;
		const body = details.querySelector('.purchase-category-body');
		for (const item of group.items) {
			const localPrice = formatPurchasePriceCents(getPurchaseItemPrice(item, currentCurrencyISO), currentCurrencyISO);
			const priceCount = getPurchaseItemPriceCount(item);
			const row = document.createElement('div');
			row.className = 'purchase-item-row';
			row.innerHTML = `
				<div class="purchase-item-summary-row">
					<div class="purchase-item-main">
						<div class="purchase-item-name">
							<strong title="${escapeAttr(item.name || '-')}">${escapeHtml(item.name || '-')}</strong>
							<span title="${escapeAttr(item.type || item.category || '')}">${escapeHtml(item.type || item.category || '-')}</span>
						</div>
						<div class="purchase-item-meta-line">
							<span class="purchase-item-price-main">${escapeHtml(localPrice)}</span>
							<span class="purchase-item-price-note">${escapeHtml(currentCurrencyISO)}</span>
						</div>
					</div>
					<div class="purchase-item-actions">
						<button type="button" class="mini-btn" data-purchase-show-price="${escapeAttr(String(item.def_index))}" data-price-count="${priceCount}">
							查看价格(${priceCount})
						</button>
						<button type="button" data-purchase-add="${escapeAttr(String(item.def_index))}" ${selectedAccounts.length ? '' : 'disabled'}>加入购物车</button>
					</div>
				</div>
			`;
			body.appendChild(row);
		}
		list.appendChild(details);
	}
}

// 紧凑展示：每个「选中账户」一行，显示 账户名 / 余额 / 消耗余额 / 购买数量。
// 单件数量在左侧商品表用「加入购物车」「最大购买数量」调整，这里不再逐件编辑。
function renderPurchaseCart(cartGroups) {
	const summary = $('purchase-cart-summary');
	const body = $('purchase-cart-body');
	const emptyState = $('purchase-cart-empty');
	body.textContent = '';
	const gameLabel = getPurchaseGameLabel();
	const selectedAccounts = getPurchaseSelectedAccounts();

	if (!selectedAccounts.length) {
		summary.innerHTML = `<span>游戏：${escapeHtml(gameLabel)}</span>`;
		emptyState.hidden = false;
		emptyState.textContent = '从左侧商品表加入购物车';
		return;
	}

	const totalUnits = cartGroups.reduce((sum, group) => sum + group.totalUnits, 0);
	summary.innerHTML = [
		`<span>游戏：${escapeHtml(gameLabel)}</span>`,
		`<span>已选账号：${selectedAccounts.length}</span>`,
		`<span>含商品账号：${cartGroups.length}</span>`,
		`<span>商品件数：${totalUnits}</span>`
	].join('');
	emptyState.hidden = true;

	const table = document.createElement('div');
	table.className = 'purchase-cart-summary-table';
	const head = document.createElement('div');
	head.className = 'purchase-cart-summary-row purchase-cart-summary-head';
	head.innerHTML = `<span>账户名</span><span>余额</span><span>消耗余额</span><span>购买数量</span><span></span>`;
	table.appendChild(head);

	for (const account of selectedAccounts) {
		const entries = syncPurchaseCartForAccount(account.account);
		const units = entries.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
		const costCents = entries.reduce(
			(sum, entry) => sum + Number(entry.costInLocalCurrency || 0) * Number(entry.quantity || 0),
			0
		);
		const row = document.createElement('div');
		row.className = 'purchase-cart-summary-row';
		row.innerHTML = `
			<span class="purchase-cart-summary-name" title="${escapeAttr(account.account)}">${escapeHtml(account.account)}</span>
			<span>${escapeHtml(formatBalance(account))}</span>
			<span class="purchase-cart-summary-cost">${escapeHtml(formatPurchasePriceCents(costCents, account.currencyISO))}</span>
			<span class="purchase-cart-summary-qty">${units}</span>
			<button type="button" class="mini-btn" data-purchase-clear-account="${escapeAttr(account.account)}" ${units ? '' : 'disabled'}>清空</button>
		`;
		table.appendChild(row);
	}
	body.appendChild(table);
}

function ensurePurchaseLoaded() {
	if (state.activeModule !== 'purchase') {
		return;
	}
	// 每次进入内购都刷新在线账户（不再只在列表为空时拉取），确保刚登录的账户立即出现。
	if (!state.purchase.loadingAccounts) {
		refreshPurchaseOnlineAccounts({silent: true});
	}
	if (!state.purchase.items.length && !state.purchase.loadingItems) {
		loadPurchaseItems({silent: true});
	}
	refreshPurchaseCartState();
}

// 账户登录/状态变化（attempt:update）时，若正处于内购页则防抖刷新可选在线账户，
// 这样刚登录成功的账户无需手动刷新即可出现在多选下拉里。下拉展开中则跳过，避免打断选择。
let purchaseAccountsRefreshTimer = null;
function schedulePurchaseAccountsRefresh() {
	if (state.activeModule !== 'purchase') {
		return;
	}
	if (purchaseAccountsRefreshTimer) {
		clearTimeout(purchaseAccountsRefreshTimer);
	}
	purchaseAccountsRefreshTimer = setTimeout(() => {
		purchaseAccountsRefreshTimer = null;
		const menu = $('purchase-account-select-menu');
		const menuOpen = menu && !menu.hidden;
		if (state.activeModule === 'purchase' && !state.purchase.loadingAccounts && !menuOpen) {
			refreshPurchaseOnlineAccounts({silent: true});
		}
	}, 800);
}

async function refreshPurchaseOnlineAccounts(options = {}) {
	const version = ++state.purchase.accountVersion;
	state.purchase.loadingAccounts = true;
	state.purchase.accountError = '';
	renderPurchase();

	try {
		const data = await getJson(`/api/purchase/online-accounts?game=${encodeURIComponent(state.purchase.game)}`);
		if (version !== state.purchase.accountVersion) {
			return;
		}
		state.purchase.gameLabel = String(data.gameLabel || getPurchaseGameLabel()).trim() || getPurchaseGameLabel();
		state.purchase.accounts = Array.isArray(data.accounts) ? data.accounts.map(normalizePurchaseAccount) : [];
		reconcilePurchaseAccounts();
		if (!options.silent) {
			addLine('success', `${state.purchase.gameLabel} 内购在线账户已刷新: ${state.purchase.accounts.length} 个`);
		}
	} catch (err) {
		if (version !== state.purchase.accountVersion) {
			return;
		}
		state.purchase.accountError = err.message;
		if (!options.silent) {
			addLine('error', `${getPurchaseGameLabel()} 内购在线账户刷新失败: ${err.message}`);
		}
	} finally {
		if (version === state.purchase.accountVersion) {
			state.purchase.loadingAccounts = false;
			renderPurchase();
		}
	}
}

async function loadPurchaseItems(options = {}) {
	await refreshPurchaseCatalog('/api/purchase/items', `${getPurchaseGameLabel()} 内购商品目录已加载`, options);
}

async function refreshPurchaseItems(options = {}) {
	await refreshPurchaseCatalog('/api/purchase/refresh-items', `${getPurchaseGameLabel()} 内购商品目录已刷新`, options);
}

async function refreshPurchaseRates(options = {}) {
	await refreshPurchaseCatalog('/api/purchase/refresh-rates', `${getPurchaseGameLabel()} 内购汇率已刷新`, options);
}

async function refreshPurchaseCatalog(url, successMessage, options = {}) {
	const version = ++state.purchase.itemVersion;
	state.purchase.loadingItems = true;
	state.purchase.itemError = '';
	renderPurchase();

	try {
		const targetUrl = `${url}?game=${encodeURIComponent(state.purchase.game)}`;
		const data = url === '/api/purchase/items'
			? await getJson(targetUrl)
			: await postJson(targetUrl, {game: state.purchase.game});
		if (version !== state.purchase.itemVersion) {
			return;
		}
		state.purchase.gameLabel = String(data.gameLabel || getPurchaseGameLabel()).trim() || getPurchaseGameLabel();
		state.purchase.items = Array.isArray(data.list) ? data.list : [];
		state.purchase.rates = data.rates && typeof data.rates === 'object' ? data.rates : {};
		state.purchase.ratesSource = String(data.ratesSource || '').trim();
		state.purchase.ratesFetchedAt = String(data.ratesFetchedAt || '').trim();
		state.purchase.itemsFetchedAt = data.fetchedAt || '';
		state.purchase.itemError = data.needsRefresh ? '当前没有本地商品缓存，请点击“刷新商品”后再使用' : '';
		syncAllPurchaseCartEntries();
		if (!options.silent) {
			addLine('success', successMessage);
		}
	} catch (err) {
		if (version !== state.purchase.itemVersion) {
			return;
		}
		state.purchase.itemError = err.message;
		if (!options.silent) {
			addLine('error', successMessage.replace('已刷新', '刷新失败') + ': ' + err.message);
		}
	} finally {
		if (version === state.purchase.itemVersion) {
			state.purchase.loadingItems = false;
			renderPurchase();
		}
	}
}

// 购物车「最大购买数量」：把当前账户购物车里每件商品的数量按余额拉满。
// 直接把库存数量设为安全上限，再交给 syncPurchaseCartForAccount 依余额逐项封顶（与手填一致）。
function maxOutPurchaseCart() {
	const accounts = getPurchaseSelectedAccounts();
	if (!accounts.length) {
		addLine('warn', '请先在购物车上方选择账户');
		return;
	}
	const cart = getPurchaseCartStore();
	let touched = 0;
	for (const account of accounts) {
		const entries = cart[account.account];
		if (!Array.isArray(entries) || !entries.length) {
			continue;
		}
		for (const entry of entries) {
			entry.quantity = PURCHASE_MAX_ITEM_QUANTITY;
		}
		syncPurchaseCartForAccount(account.account);
		touched += 1;
	}
	if (!touched) {
		addLine('warn', '当前账户购物车为空，请先加入商品');
		return;
	}
	renderPurchase();
	addLine('success', '已按余额为购物车设置最大购买数量');
}

function handlePurchaseItemListClick(event) {
	const priceButton = event.target.closest('button[data-purchase-show-price]');
	if (priceButton) {
		event.preventDefault();
		event.stopPropagation();
		const defIndex = Number(priceButton.dataset.purchaseShowPrice);
		const item = getPurchaseItemByDefIndex(defIndex);
		if (item) {
			openPurchasePriceModal(item, getPurchaseCurrentCurrencyISO());
		}
		return;
	}

	const button = event.target.closest('button[data-purchase-add]');
	if (!button) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	const defIndex = Number(button.dataset.purchaseAdd);
	const item = getPurchaseItemByDefIndex(defIndex);
	const selectedAccounts = getPurchaseSelectedAccounts();
	if (!item || !selectedAccounts.length) {
		return;
	}

	let addedCount = 0;
	for (const account of selectedAccounts) {
		const currentEntries = syncPurchaseCartForAccount(account.account);
		const currentEntry = currentEntries.find(record => Number(record.itemDefId) === defIndex);
		const requestedQuantity = Number(currentEntry && currentEntry.quantity || 0) + 1;
		const result = setPurchaseCartItemQuantity(account.account, defIndex, requestedQuantity);
		if (result.appliedQuantity >= requestedQuantity) {
			addedCount += 1;
			continue;
		}
		const maxText = result.maxQuantity > 0 ? `，最大可买 ${result.maxQuantity}` : '';
		addLine('warn', `${account.account}: ${item.name || `DefIndex ${defIndex}`} 已达到最大购买量${maxText}`);
	}

	renderPurchase();
	if (addedCount > 0) {
		addLine('success', `${item.name || `DefIndex ${defIndex}`}: 已加入 ${addedCount} 个账号的购物车`);
	}
}

function handlePurchaseCategoryToggle(event) {
	const details = event.target;
	if (!(details instanceof HTMLDetailsElement) || !details.classList.contains('purchase-category')) {
		return;
	}
	const category = String(details.dataset.category || '').trim();
	if (!category) {
		return;
	}
	if (details.open) {
		state.purchase.collapsedCategories.delete(category);
	} else {
		state.purchase.collapsedCategories.add(category);
	}
}

function handlePurchaseCartClick(event) {
	const clearButton = event.target.closest('button[data-purchase-clear-account]');
	if (clearButton) {
		delete getPurchaseCartStore()[clearButton.dataset.purchaseClearAccount];
		renderPurchase();
		return;
	}

	const removeButton = event.target.closest('button[data-purchase-remove]');
	if (!removeButton) {
		return;
	}
	const accountName = removeButton.dataset.purchaseRemove;
	const defIndex = Number(removeButton.dataset.defIndex);
	const currentEntry = syncPurchaseCartForAccount(accountName).find(entry => Number(entry.itemDefId) === defIndex);
	const nextQuantity = Number(currentEntry && currentEntry.quantity || 0) - 1;
	setPurchaseCartItemQuantity(accountName, defIndex, nextQuantity);
	renderPurchase();
}

function handlePurchaseCartInput(event) {
	const target = event.target;
	if (!(target instanceof HTMLInputElement) || !target.dataset.purchaseQuantity) {
		return;
	}
	const accountName = target.dataset.purchaseQuantity;
	const defIndex = Number(target.dataset.defIndex);
	const requestedQuantity = Math.max(0, Number(target.value || 0));
	const result = setPurchaseCartItemQuantity(accountName, defIndex, requestedQuantity);
	if (requestedQuantity > 0 && result.appliedQuantity !== requestedQuantity) {
		const item = getPurchaseItemByDefIndex(defIndex);
		const maxText = result.maxQuantity > 0 ? `最大可买 ${result.maxQuantity}` : '当前余额不足';
		addLine('warn', `${accountName}: ${item && item.name ? item.name : `DefIndex ${defIndex}`} 数量已调整为 ${result.appliedQuantity || 0}（${maxText}）`);
	}
	renderPurchase();
}

async function submitPurchaseTask() {
	const cartData = buildPurchaseCartPayload();
	const accountCount = Object.keys(cartData).length;
	if (!accountCount) {
		addLine('warn', `当前没有可提交的 ${getPurchaseGameLabel()} 内购购物车`);
		return;
	}

	state.purchase.submitting = true;
	renderPurchase();
	try {
		const data = await postJson('/api/purchase/tasks', {game: state.purchase.game, cartData});
		clearPurchaseCart({silent: true});
		if (data.task) {
			mergePurchaseTask(data.task, 'created');
		}
		addLine('success', `已提交 ${getPurchaseGameLabel()} 内购任务: ${accountCount} 个账号`);
	} catch (err) {
		addLine('error', `${getPurchaseGameLabel()} 内购任务提交失败: ${err.message}`);
	} finally {
		state.purchase.submitting = false;
		renderPurchase();
	}
}

function clearPurchaseCart(options = {}) {
	const accounts = getPurchaseSelectedAccounts();
	if (accounts.length) {
		// 只清空当前选中账户的购物车，避免误删未选中账户留下的购物车。
		const cart = getPurchaseCartStore();
		for (const account of accounts) {
			delete cart[account.account];
		}
	} else {
		state.purchase.cartByGame[state.purchase.game] = {};
	}
	if (!options.silent) {
		addLine('success', `${getPurchaseGameLabel()} 内购购物车已清空`);
	}
	renderPurchase();
}

function mergePurchaseTask(task, source = '') {
	if (!task || !task.id) {
		return;
	}
	if (task.game && normalizePurchaseGame(task.game) !== state.purchase.game) {
		return;
	}
	const index = state.purchase.tasks.findIndex(item => item.id === task.id);
	const previous = index >= 0 ? state.purchase.tasks[index] : null;
	if (index >= 0) {
		state.purchase.tasks[index] = task;
	} else {
		state.purchase.tasks.unshift(task);
	}
	state.purchase.tasks.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
	appendPurchaseTaskLogLine(task, previous, source);
	renderPurchase();
}

function normalizePurchaseAccount(input) {
	if (!input || typeof input !== 'object') {
		return {
			account: '',
			attemptId: '',
			status: '',
			country: '',
			hasWallet: false,
			currency: null,
			currencyISO: 'USD',
			balance: null,
			gcConnected: false,
			cs2GcConnected: false,
			tf2GcConnected: false,
			activeGame: 'cs2',
			inventoryCount: 0
		};
	}
	return {
		account: String(input.account || input.accountName || '').trim(),
		attemptId: String(input.attemptId || input.id || '').trim(),
		status: String(input.status || '').trim(),
		game: String(input.game || 'cs2').trim().toLowerCase() === 'tf2' ? 'tf2' : 'cs2',
		country: String(input.country || input.loginGeoCountry || '').trim(),
		hasWallet: !!input.hasWallet,
		currency: input.currency == null ? null : Number(input.currency),
		currencyISO: String(input.currencyISO || 'USD').trim().toUpperCase() || 'USD',
		balance: input.balance == null ? null : Number(input.balance),
		gcConnected: !!input.gcConnected,
		cs2GcConnected: !!input.cs2GcConnected,
		tf2GcConnected: !!input.tf2GcConnected,
		activeGame: normalizePurchaseGame(input.activeGame || input.game || 'cs2'),
		inventoryCount: Number(input.inventoryCount || 0)
	};
}

function isPurchaseStatusOnline(status) {
	return ['online', 'logged_on', 'web_session', 'web_session_pending', '登录成功'].includes(String(status || '').trim());
}

function syncPurchaseAccountFromAttempt(attempt) {
	const accountName = String(attempt && attempt.accountName || '').trim();
	if (!accountName) {
		return;
	}
	if (!isPurchaseStatusOnline(attempt.status)) {
		removePurchaseAccounts([accountName]);
		return;
	}
	const attemptGame = state.purchase.game;
	const gcConnected = attemptGame === 'tf2'
		? !!attempt.tf2GcConnected
		: !!attempt.cs2GcConnected;

	const normalized = normalizePurchaseAccount({
		account: accountName,
		attemptId: attempt.id,
		status: attempt.status,
		game: attemptGame,
		country: attempt.country || attempt.loginGeoCountry || '',
		hasWallet: !!attempt.hasWallet,
		currency: attempt.currency,
		currencyISO: attempt.currencyISO || '',
		balance: attempt.balance,
		gcConnected,
		cs2GcConnected: !!attempt.cs2GcConnected,
		tf2GcConnected: !!attempt.tf2GcConnected,
		activeGame: attempt.activeGame || attemptGame,
		inventoryCount: attempt.inventoryCount
	});
	if (!normalized.account) {
		return;
	}

	const index = state.purchase.accounts.findIndex(item => item.account === normalized.account);
	if (index >= 0) {
		state.purchase.accounts[index] = {
			...state.purchase.accounts[index],
			...normalized
		};
	} else {
		state.purchase.accounts.push(normalized);
		state.purchase.accounts.sort((left, right) => left.account.localeCompare(right.account, 'zh-CN'));
	}
	syncPurchaseCartForAccount(normalized.account);
}

function removePurchaseAccounts(accountNames) {
	const targets = new Set(
		(accountNames || [])
			.map(name => String(name || '').trim())
			.filter(Boolean)
	);
	if (!targets.size) {
		return;
	}
	state.purchase.accounts = state.purchase.accounts.filter(account => !targets.has(account.account));
	for (const accountName of targets) {
		state.purchase.selectedAccounts.delete(accountName);
		delete state.purchase.cartByGame.cs2[accountName];
		delete state.purchase.cartByGame.tf2[accountName];
	}
}

function reconcilePurchaseAccounts() {
	const online = new Set(state.purchase.accounts.map(account => account.account));
	state.purchase.selectedAccounts = new Set(
		Array.from(state.purchase.selectedAccounts).filter(accountName => online.has(accountName))
	);
	const cart = getPurchaseCartStore();
	for (const accountName of Object.keys(cart)) {
		if (!online.has(accountName)) {
			delete cart[accountName];
		}
	}
	syncAllPurchaseCartEntries();
}

function getPurchaseSelectedAccounts() {
	return state.purchase.accounts.filter(account => state.purchase.selectedAccounts.has(account.account));
}

function getPurchaseGameLabel() {
	return state.purchase.game === 'tf2' ? 'TF2' : 'CS2';
}

function normalizePurchaseGame(value) {
	return String(value || '').trim().toLowerCase() === 'tf2' ? 'tf2' : 'cs2';
}

function getPurchaseCartStore(game = state.purchase.game) {
	const normalized = normalizePurchaseGame(game);
	if (!state.purchase.cartByGame[normalized]) {
		state.purchase.cartByGame[normalized] = {};
	}
	return state.purchase.cartByGame[normalized];
}

function switchPurchaseGame(game) {
	const normalized = normalizePurchaseGame(game);
	if (normalized === state.purchase.game) {
		return;
	}
	state.purchase.game = normalized;
	state.purchase.gameLabel = getPurchaseGameLabel();
	state.purchase.accounts = [];
	state.purchase.items = [];
	state.purchase.tasks = [];
	state.purchase.accountError = '';
	state.purchase.itemError = '';
	state.purchase.selectedAccounts = new Set();
	state.purchase.itemSearch = '';
	refreshPurchaseCartState();
	renderPurchase();
	refreshPurchaseOnlineAccounts({silent: true});
	loadPurchaseItems({silent: true});
}

function getPurchaseCurrentCurrencyISO(selectedAccounts = null) {
	const accounts = Array.isArray(selectedAccounts) ? selectedAccounts : getPurchaseSelectedAccounts();
	if (!accounts.length) {
		return 'USD';
	}
	const counts = new Map();
	for (const account of accounts) {
		const iso = String(account.currencyISO || 'USD').trim().toUpperCase() || 'USD';
		counts.set(iso, Number(counts.get(iso) || 0) + 1);
	}
	let winner = 'USD';
	let winnerCount = -1;
	for (const [iso, count] of counts.entries()) {
		if (count > winnerCount) {
			winner = iso;
			winnerCount = count;
		}
	}
	return winner;
}

function getPurchaseAccountByName(accountName) {
	return state.purchase.accounts.find(account => account.account === accountName) || null;
}

function getPurchaseAccountBalanceCents(account) {
	if (!account || !account.hasWallet || account.balance == null) {
		return null;
	}
	const balance = Number(account.balance);
	if (!Number.isFinite(balance)) {
		return null;
	}
	return Math.max(0, Math.round(balance * 100));
}

function getPurchaseGameAccounts() {
	return state.purchase.accounts.filter(account => normalizePurchaseGame(account.game || state.purchase.game) === state.purchase.game);
}

function getPurchaseVisibleItems() {
	const query = String(state.purchase.itemSearch || '').trim().toLowerCase();
	if (!query) {
		return state.purchase.items.slice();
	}
	return state.purchase.items.filter(item => {
		const haystack = [
			item.name,
			item.type,
			item.category,
			String(item.def_index || '')
		].join(' ').toLowerCase();
		return haystack.includes(query);
	});
}

function groupPurchaseItems(items) {
	const groups = [];
	let current = null;
	for (const item of items) {
		const category = String(item && (item.category || item.type) || '未分类').trim() || '未分类';
		if (!current || current.category !== category) {
			current = {category, items: []};
			groups.push(current);
		}
		current.items.push(item);
	}
	return groups;
}

function getPurchaseItemPriceCount(item) {
	if (!item || !item.prices || typeof item.prices !== 'object') {
		return 0;
	}
	return Object.keys(item.prices).length;
}

function getPurchasePriceEntries(item, currentCurrencyISO) {
	if (!item || !item.prices || typeof item.prices !== 'object') {
		return [];
	}
	const current = String(currentCurrencyISO || 'USD').trim().toUpperCase();
	return Object.keys(item.prices)
		.map(rawIso => String(rawIso || '').trim().toUpperCase())
		.filter(Boolean)
		.filter(iso => item.prices[iso] != null)
		.map(iso => {
			const cents = Number(item.prices[iso] || 0);
			const convertedUsdCents = convertPurchasePriceCents(cents, iso, 'USD');
			const convertedCnyCents = convertPurchasePriceCents(cents, iso, 'CNY');
			return {
				iso,
				value: formatPurchasePriceCents(cents, iso),
				highlight: iso === current,
				convertedUsdCents,
				convertedUsdText: Number.isFinite(convertedUsdCents)
					? formatPurchasePriceCents(convertedUsdCents, 'USD')
					: '无法折算',
				convertedCnyCents,
				convertedCnyText: Number.isFinite(convertedCnyCents)
					? formatPurchasePriceCents(convertedCnyCents, 'CNY')
					: '无法折算'
			};
		})
		.sort((left, right) => {
			const leftValue = Number.isFinite(left.convertedCnyCents) ? left.convertedCnyCents : Number.POSITIVE_INFINITY;
			const rightValue = Number.isFinite(right.convertedCnyCents) ? right.convertedCnyCents : Number.POSITIVE_INFINITY;
			if (leftValue !== rightValue) {
				return leftValue - rightValue;
			}
			return left.iso.localeCompare(right.iso, 'en');
		});
}

function summarizePurchaseRates(currentCurrencyISO) {
	const rateCount = state.purchase.rates && typeof state.purchase.rates === 'object'
		? Object.keys(state.purchase.rates).length
		: 0;
	if (!rateCount) {
		return {
			text: '汇率：未提供',
			title: '当前响应里没有可用 rates 对象'
		};
	}
	const current = String(currentCurrencyISO || 'USD').trim().toUpperCase();
	const currentRate = state.purchase.rates[current];
	const sourceText = state.purchase.ratesSource ? `来源 ${state.purchase.ratesSource}` : '独立汇率表';
	if (currentRate == null) {
		return {
			text: `汇率参考：${rateCount} 个币种`,
			title: `${sourceText}，以 USD 为基准`
		};
	}
	return {
		text: `汇率参考：${current}= ${Number(currentRate).toFixed(4)}`,
		title: `${sourceText}，以 USD 为基准，当前共 ${rateCount} 个币种`
	};
}

function convertPurchasePriceCents(cents, fromCurrencyISO, toCurrencyISO) {
	const fromISO = String(fromCurrencyISO || '').trim().toUpperCase();
	const toISO = String(toCurrencyISO || '').trim().toUpperCase();
	const amount = Number(cents);
	if (!fromISO || !toISO || !Number.isFinite(amount)) {
		return Number.NaN;
	}
	if (fromISO === toISO) {
		return amount;
	}
	const rates = state.purchase.rates;
	if (!rates || typeof rates !== 'object') {
		return Number.NaN;
	}
	const fromRate = Number(rates[fromISO]);
	const toRate = Number(rates[toISO]);
	if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
		return Number.NaN;
	}
	return amount / fromRate * toRate;
}

function openPurchasePriceModal(item, currentCurrencyISO) {
	if (!item || item.def_index == null) {
		return;
	}
	state.purchase.priceModal.itemDefIndex = Number(item.def_index);
	state.purchase.priceModal.currentCurrencyISO = String(currentCurrencyISO || 'USD').trim().toUpperCase() || 'USD';
	$('purchase-price-modal').hidden = false;
	renderPurchasePriceModal();
}

function closePurchasePriceModal() {
	$('purchase-price-modal').hidden = true;
	state.purchase.priceModal.itemDefIndex = null;
	state.purchase.priceModal.currentCurrencyISO = 'USD';
}

function renderPurchasePriceModal() {
	const modal = $('purchase-price-modal');
	const itemDefIndex = Number(state.purchase.priceModal.itemDefIndex);
	if (!itemDefIndex) {
		modal.hidden = true;
		return;
	}
	const item = getPurchaseItemByDefIndex(itemDefIndex);
	if (!item) {
		closePurchasePriceModal();
		return;
	}
	const currentCurrencyISO = state.purchase.priceModal.currentCurrencyISO || 'USD';
	const entries = getPurchasePriceEntries(item, currentCurrencyISO);
	const list = $('purchase-price-list');
	$('purchase-price-title').textContent = `${item.name || '商品'} 价格列表`;
	list.textContent = '';
	if (!entries.length) {
		const empty = document.createElement('div');
		empty.className = 'purchase-price-empty';
		empty.textContent = '没有价格数据';
		list.appendChild(empty);
		return;
	}
	for (const entry of entries) {
		const row = document.createElement('div');
		row.className = 'purchase-price-row' + (entry.highlight ? ' highlight' : '');
		row.innerHTML = `
			<div class="purchase-price-row-main">
				<strong>${escapeHtml(entry.iso)}</strong>
				${entry.highlight ? '<span class="pill ok">当前账号币种</span>' : ''}
			</div>
			<div class="purchase-price-row-value">${escapeHtml(entry.value)}</div>
			<div class="purchase-price-row-usd">${escapeHtml(entry.convertedUsdText)}</div>
			<div class="purchase-price-row-cny">${escapeHtml(entry.convertedCnyText)}</div>
		`;
		list.appendChild(row);
	}
}

function getPurchaseItemByDefIndex(defIndex) {
	return state.purchase.items.find(item => Number(item.def_index) === Number(defIndex)) || null;
}

function getPurchaseItemPrice(item, currencyISO) {
	if (!item || !item.prices || typeof item.prices !== 'object') {
		return 0;
	}
	const iso = String(currencyISO || 'USD').trim().toUpperCase();
	if (item.prices[iso] != null) {
		return Number(item.prices[iso] || 0);
	}
	if (item.prices.USD != null) {
		return Number(item.prices.USD || 0);
	}
	return 0;
}

function syncPurchaseCartEntry(entry, account) {
	const item = getPurchaseItemByDefIndex(entry.itemDefId);
	entry.name = item ? item.name : (entry.name || `DefIndex ${entry.itemDefId}`);
	entry.currencyISO = String(account && account.currencyISO || entry.currencyISO || 'USD').trim().toUpperCase();
	entry.quantity = Math.max(1, Math.min(PURCHASE_MAX_ITEM_QUANTITY, Number(entry.quantity || 1)));
	if (item) {
		entry.costInLocalCurrency = getPurchaseItemPrice(item, entry.currencyISO);
	}
	return entry;
}

function syncPurchaseCartForAccount(accountName) {
	const account = getPurchaseAccountByName(accountName);
	const cart = getPurchaseCartStore();
	const entries = Array.isArray(cart[accountName]) ? cart[accountName] : [];
	if (!account) {
		delete cart[accountName];
		return [];
	}
	const normalized = [];
	let remainingBalanceCents = getPurchaseAccountBalanceCents(account);
	for (const entry of entries) {
		if (!entry || Number(entry.quantity || 0) <= 0) {
			continue;
		}
		const synced = syncPurchaseCartEntry({...entry}, account);
		const unitPriceCents = Math.max(0, Number(synced.costInLocalCurrency || 0));
		if (remainingBalanceCents != null && unitPriceCents > 0) {
			const maxAffordable = Math.max(0, Math.min(PURCHASE_MAX_ITEM_QUANTITY, Math.floor(remainingBalanceCents / unitPriceCents)));
			if (maxAffordable <= 0) {
				continue;
			}
			synced.quantity = Math.min(Number(synced.quantity || 0), maxAffordable);
			remainingBalanceCents -= synced.quantity * unitPriceCents;
		}
		normalized.push(synced);
	}
	if (normalized.length) {
		cart[accountName] = normalized;
	} else {
		delete cart[accountName];
	}
	return normalized;
}

function syncAllPurchaseCartEntries() {
	for (const accountName of Object.keys(getPurchaseCartStore())) {
		syncPurchaseCartForAccount(accountName);
	}
}

function getPurchaseCartEntryMaxQuantity(accountName, entry) {
	const account = getPurchaseAccountByName(accountName);
	if (!account) {
		return 0;
	}
	const unitPriceCents = Math.max(0, Number(entry && entry.costInLocalCurrency || 0));
	if (unitPriceCents <= 0) {
		return PURCHASE_MAX_ITEM_QUANTITY;
	}
	const balanceCents = getPurchaseAccountBalanceCents(account);
	if (balanceCents == null) {
		return PURCHASE_MAX_ITEM_QUANTITY;
	}
	const targetItemDefId = Number(entry && entry.itemDefId || 0);
	let otherTotalCents = 0;
	for (const candidate of syncPurchaseCartForAccount(accountName)) {
		if (Number(candidate.itemDefId) === targetItemDefId) {
			continue;
		}
		otherTotalCents += Math.max(0, Number(candidate.costInLocalCurrency || 0)) * Math.max(0, Number(candidate.quantity || 0));
	}
	const availableCents = Math.max(0, balanceCents - otherTotalCents);
	return Math.max(0, Math.min(PURCHASE_MAX_ITEM_QUANTITY, Math.floor(availableCents / unitPriceCents)));
}

function setPurchaseCartItemQuantity(accountName, itemDefId, quantity) {
	const account = getPurchaseAccountByName(accountName);
	const cart = getPurchaseCartStore();
	const entries = Array.isArray(cart[accountName]) ? cart[accountName].map(entry => ({...entry})) : [];
	const normalizedItemDefId = Number(itemDefId);
	let entry = entries.find(record => Number(record.itemDefId) === normalizedItemDefId);

	if (!entry && Number(quantity) > 0) {
		entry = {
			itemDefId: normalizedItemDefId,
			name: '',
			quantity: 0,
			costInLocalCurrency: 0,
			currencyISO: account && account.currencyISO ? account.currencyISO : 'USD'
		};
		entries.push(entry);
	}
	if (entry) {
		entry.quantity = Math.max(0, Math.round(Number(quantity || 0)));
	}

	const filtered = entries.filter(record => Number(record.quantity || 0) > 0);
	if (filtered.length) {
		cart[accountName] = filtered;
	} else {
		delete cart[accountName];
	}

	const normalizedEntries = syncPurchaseCartForAccount(accountName);
	const appliedEntry = normalizedEntries.find(record => Number(record.itemDefId) === normalizedItemDefId) || null;
	return {
		appliedQuantity: appliedEntry ? Number(appliedEntry.quantity || 0) : 0,
		maxQuantity: appliedEntry ? getPurchaseCartEntryMaxQuantity(accountName, appliedEntry) : 0,
		entry: appliedEntry
	};
}

function getPurchaseCartGroups() {
	// 多选模型：购物车展示/提交所有勾选中的账户。
	return state.purchase.accounts
		.filter(account => normalizePurchaseGame(account.game || state.purchase.game) === state.purchase.game)
		.filter(account => state.purchase.selectedAccounts.has(account.account))
		.map(account => ({
			account,
			entries: syncPurchaseCartForAccount(account.account)
		}))
		.filter(group => group.entries.length)
		.map(group => ({
			...group,
			totalUnits: group.entries.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0),
			totalCostCents: group.entries.reduce((sum, entry) => sum + Number(entry.costInLocalCurrency || 0) * Number(entry.quantity || 0), 0)
		}));
}

function buildPurchaseCartPayload() {
	const payload = {};
	for (const group of getPurchaseCartGroups()) {
		payload[group.account.account] = group.entries.map(entry => ({
			itemDefId: Number(entry.itemDefId),
			costInLocalCurrency: Number(entry.costInLocalCurrency || 0),
			quantity: Number(entry.quantity || 0)
		}));
	}
	return payload;
}

function refreshPurchaseCartState() {
	state.purchase.cartByGame.cs2 = state.purchase.cartByGame.cs2 || {};
	state.purchase.cartByGame.tf2 = state.purchase.cartByGame.tf2 || {};
}

function purchaseTaskStatusLabel(status) {
	if (status === 'queued') {
		return '排队中';
	}
	if (status === 'running') {
		return '执行中';
	}
	if (status === 'completed') {
		return '已完成';
	}
	if (status === 'partial') {
		return '部分成功';
	}
	if (status === 'failed') {
		return '失败';
	}
	return status || '-';
}

function purchaseTaskStatusTone(status) {
	if (status === 'completed') {
		return 'ok';
	}
	if (status === 'partial' || status === 'running') {
		return 'warn';
	}
	if (status === 'failed') {
		return 'bad';
	}
	return '';
}

function appendPurchaseTaskLogLine(task, previous, source) {
	const status = String(task && task.status || '').trim();
	const previousStatus = String(previous && previous.status || '').trim();
	const gameLabel = String(task && task.gameLabel || getPurchaseGameLabel()).trim() || getPurchaseGameLabel();
	const accountCount = Number(task && task.totalAccounts || 0);
	const totalUnits = Number(task && task.totalUnits || 0);
	if (source === 'created' && !previous) {
		addLine('success', `${gameLabel} 内购任务已创建: ${accountCount} 个账号，${totalUnits} 件商品`);
		return;
	}
	if (!previous || previousStatus === status) {
		return;
	}
	if (status === 'running') {
		addLine('warn', `${gameLabel} 内购任务执行中: ${accountCount} 个账号，${totalUnits} 件商品`);
		return;
	}
	if (status === 'completed' || status === 'partial' || status === 'failed') {
		// 把失败账号的具体错误也带进主日志(否则只显示"成功0失败1",看不到原因)。
		const failedAccts = (Array.isArray(task.accounts) ? task.accounts : []).filter(a => a && a.status === 'failed' && a.error);
		const errSuffix = failedAccts.length ? ' — ' + failedAccts.map(a => `${a.account}: ${a.error}`).join('; ') : '';
		addLine(
			status === 'failed' ? 'error' : (status === 'partial' ? 'warn' : 'success'),
			`${gameLabel} 内购任务${purchaseTaskStatusLabel(status)}: 成功 ${Number(task.successCount || 0)}，失败 ${Number(task.failCount || 0)}${errSuffix}`
		);
	}
}

function formatPurchasePriceCents(cents, currencyISO) {
	const value = Number(cents);
	if (!Number.isFinite(value)) {
		return '-';
	}
	const symbol = purchaseCurrencySymbol(currencyISO);
	return /^[A-Z]{3}$/u.test(symbol)
		? `${symbol} ${(value / 100).toFixed(2)}`
		: `${symbol}${(value / 100).toFixed(2)}`;
}

function purchaseCurrencySymbol(currencyISO) {
	const symbols = {
		USD: '$',
		GBP: '£',
		EUR: '€',
		CHF: 'CHF ',
		RUB: '₽',
		PLN: 'zł',
		BRL: 'R$',
		JPY: '¥',
		NOK: 'kr ',
		IDR: 'Rp ',
		MYR: 'RM ',
		PHP: '₱',
		SGD: 'S$',
		THB: '฿',
		VND: '₫',
		KRW: '₩',
		TRY: '₺',
		UAH: '₴',
		MXN: 'Mex$',
		CAD: 'C$',
		AUD: 'A$',
		NZD: 'NZ$',
		CNY: '¥',
		INR: '₹',
		COP: 'COL$',
		ZAR: 'R ',
		HKD: 'HK$',
		TWD: 'NT$',
		SAR: 'SR ',
		AED: 'AED ',
		KZT: '₸',
		QAR: 'QR '
	};
	return symbols[String(currencyISO || '').trim().toUpperCase()] || String(currencyISO || 'USD').trim().toUpperCase();
}

function formatPurchaseTime(value) {
	if (!value) {
		return '-';
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return '-';
	}
	return `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', {hour12: false})}`;
}

function formatJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch (err) {
		return String(err && err.message ? err.message : value);
	}
}

function toggleAll(event) {
	if (event.target.checked) {
		for (const account of state.accounts) {
			state.selected.add(account.id);
		}
	} else {
		state.selected.clear();
	}
	renderAccounts();
}

function parseAccountText(text) {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error('请输入账号----密码，一行一个');
	}

	const rows = [];
	const invalidRows = [];
	trimmed.split(/\r?\n/).forEach((line, index) => {
		const value = line.trim();
		if (!value || value.startsWith('#')) {
			return;
		}
		const account = parseAccountLine(value);
		if (!account.accountName || !account.password) {
			invalidRows.push(index + 1);
			return;
		}
		rows.push(account);
	});

	if (invalidRows.length) {
		throw new Error(`第 ${invalidRows.join(', ')} 行格式错误，请使用 账号----密码`);
	}
	if (!rows.length) {
		throw new Error('请输入账号----密码，一行一个');
	}
	return rows;
}

function parseAccountLine(line) {
	const separator = line.indexOf('----');
	if (separator < 0) {
		return {accountName: '', password: '', hasMaFile: false, source: 'import'};
	}
	const parts = [line.slice(0, separator).trim(), line.slice(separator + 4).trim()];
	return {
		accountName: parts[0] || '',
		password: parts[1] || '',
		hasMaFile: false,
		source: 'import'
	};
}

function normalizeAccountRecord(record) {
	if (!record || typeof record !== 'object') {
		return {accountName: ''};
	}
	return {
		accountName: record.accountName || record.account_name || record.username || record.user || record.name || '',
		password: record.password || record.pass || '',
		sharedSecret: record.sharedSecret || record.shared_secret || '',
		twoFactorCode: record.twoFactorCode || record.two_factor_code || '',
		hasMaFile: !!record.hasMaFile,
		remember: record.remember !== false,
		source: record.source || 'import'
	};
}

function upsertAccount(input) {
	const accountName = String(input.accountName || '').trim();
	if (!accountName) {
		return 'skipped';
	}
	state.dismissedAccountNames.delete(accountName.toLowerCase());

	const account = findAccount(accountName);
	if (account) {
		if (input.password) {
			account.password = input.password;
		}
		if (input.sharedSecret) {
			account.sharedSecret = input.sharedSecret;
		}
		if (input.twoFactorCode) {
			account.twoFactorCode = input.twoFactorCode;
		}
		if (input.hasMaFile !== undefined) {
			account.hasMaFile = !!input.hasMaFile;
		}
		account.remember = input.remember !== false;
		account.source = input.source || account.source;
		return 'updated';
	}

	addAccount(input);
	return 'added';
}

function addAccount(input) {
	const account = {
		id: cryptoId(),
		accountName: String(input.accountName || '').trim(),
		password: input.password || '',
		sharedSecret: input.sharedSecret || '',
		twoFactorCode: input.twoFactorCode || '',
		remember: input.remember !== false,
		status: '未登录',
		hasMaFile: !!input.hasMaFile,
		steamID: '',
		country: '',
		balance: null,
		currency: null,
		hasWallet: false,
		hasRefreshToken: false,
		gcConnected: false,
		cs2GcConnected: false,
		tf2GcConnected: false,
		activeGame: 'cs2',
		inventoryCount: 0,
		inventorySource: '',
		attemptId: '',
		source: input.source || 'manual',
		lastError: ''
	};
	state.accounts.push(account);
	return account;
}

function findAccount(accountName) {
	return state.accounts.find(account => account.accountName.toLowerCase() === String(accountName || '').toLowerCase());
}

function statusPill(account) {
	const status = normalizeLoginStatus(account.status);
	let tone = '';
	if (status === '登录成功') {
		tone = 'ok';
	} else if (status === '登录中') {
		tone = 'warn';
	} else if (status === '登录失败') {
		tone = 'bad';
	}
	return `<span class="pill ${tone}">${escapeHtml(status)}</span>`;
}

function maFilePill(account) {
	return `<span class="pill ${account.hasMaFile ? 'ok' : ''}">${account.hasMaFile ? '有' : '无'}</span>`;
}

function renderMaFileCell(account) {
	const canShowCode = !!(account.hasMaFile || account.sharedSecret);
	return `
		<div class="mafile-cell">
			${maFilePill(account)}
			<button type="button" class="mini-btn" data-show-code="${escapeAttr(account.id)}" ${canShowCode ? '' : 'disabled'}>验证码</button>
		</div>
	`;
}

function getAccountGcConnected(account, game = 'cs2') {
	return normalizePurchaseGame(game) === 'tf2' ? !!account.tf2GcConnected : !!account.cs2GcConnected;
}

function getConnectedGcGame(account) {
	if (!account) {
		return '';
	}
	if (account.tf2GcConnected) {
		return 'tf2';
	}
	if (account.cs2GcConnected) {
		return 'cs2';
	}
	return '';
}

function renderGcActionButtons(account) {
	const canUseGc = !!account.attemptId && normalizeLoginStatus(account.status) === '登录成功';
	const connectedGame = canUseGc ? getConnectedGcGame(account) : '';
	const connectedLabel = connectedGame === 'tf2' ? 'TF2' : 'CS2';
	if (connectedGame) {
		return `
			<div class="row-actions">
				<button type="button" data-gc-disconnect="${escapeAttr(account.id)}" data-gc-game="${escapeAttr(connectedGame)}">断开${escapeHtml(connectedLabel)}</button>
			</div>
		`;
	}
	if (!canUseGc) {
		return `
			<div class="row-actions">
				<button type="button" disabled>连接GC</button>
			</div>
		`;
	}
	return `
		<div class="row-actions">
			<button type="button" data-gc-open-menu="${escapeAttr(account.id)}">连接GC</button>
		</div>
	`;
}

function toggleGcActionPopover(accountId, anchor) {
	const normalizedAccountId = String(accountId || '').trim();
	if (!normalizedAccountId || !(anchor instanceof HTMLElement)) {
		return;
	}
	if (state.gcPopover.accountId === normalizedAccountId) {
		closeGcActionPopover();
		return;
	}
	const rect = anchor.getBoundingClientRect();
	state.gcPopover.accountId = normalizedAccountId;
	state.gcPopover.left = Math.round(rect.left + window.scrollX);
	state.gcPopover.top = Math.round(rect.bottom + window.scrollY + 6);
	renderGcActionPopover();
}

function closeGcActionPopover() {
	state.gcPopover.accountId = '';
	const popover = $('gc-action-popover');
	if (popover) {
		popover.hidden = true;
		popover.innerHTML = '';
	}
}

function renderGcActionPopover() {
	const popover = $('gc-action-popover');
	if (!popover) {
		return;
	}
	const account = state.accounts.find(item => item.id === state.gcPopover.accountId);
	if (!account) {
		closeGcActionPopover();
		return;
	}
	popover.hidden = false;
	popover.style.left = `${state.gcPopover.left}px`;
	popover.style.top = `${state.gcPopover.top}px`;
	popover.innerHTML = `
		<div class="gc-action-popover-card">
			<button type="button" data-gc-connect="${escapeAttr(account.id)}" data-gc-game="cs2">连接CS2</button>
			<button type="button" data-gc-connect="${escapeAttr(account.id)}" data-gc-game="tf2">连接TF2</button>
		</div>
	`;
	popover.querySelectorAll('button[data-gc-connect]').forEach(button => {
		button.addEventListener('click', () => {
			closeGcActionPopover();
			connectGcForAccount(button.dataset.gcConnect, button.dataset.gcGame || 'cs2');
		});
	});
}

function handleDocumentClickForGcPopover(event) {
	const popover = $('gc-action-popover');
	if (!popover || popover.hidden) {
		return;
	}
	const target = event.target;
	if (popover.contains(target)) {
		return;
	}
	if (target instanceof Element && target.closest('button[data-gc-open-menu]')) {
		return;
	}
	closeGcActionPopover();
}

function collapseAttemptStatus(status, previousStatus) {
	const previous = normalizeLoginStatus(previousStatus);
	if (status === 'logged_on' || status === 'web_session') {
		return '登录成功';
	}
	if (status === 'logged_out') {
		return '未登录';
	}
	if (status === 'failed') {
		return previous === '登录成功' ? '登录成功' : '登录失败';
	}
	if (status === 'disconnected') {
		return previous === '登录成功' ? '登录成功' : '登录失败';
	}
	if (status === 'created' || status === 'connecting' || status === 'guard_required' || status === 'web_session_pending') {
		return previous === '登录成功' ? '登录成功' : '登录中';
	}
	return normalizeLoginStatus(status);
}

function openTotpModal(accountId) {
	const account = state.accounts.find(item => item.id === accountId);
	if (!account) {
		addLine('warn', '账号不存在');
		return;
	}

	state.totp.accountId = account.id;
	state.totp.accountName = account.accountName || '';
	state.totp.code = '';
	state.totp.expiresIn = 0;
	state.totp.error = '';
	$('totp-modal').hidden = false;
	renderTotpModal();
	startTotpTimer();
	refreshTotpCode();
}

function closeTotpModal() {
	$('totp-modal').hidden = true;
	stopTotpTimer();
	state.totp.accountId = '';
	state.totp.accountName = '';
	state.totp.code = '';
	state.totp.expiresIn = 0;
	state.totp.loading = false;
	state.totp.error = '';
}

function startTotpTimer() {
	stopTotpTimer();
	state.totp.timer = window.setInterval(() => {
		if ($('totp-modal').hidden) {
			stopTotpTimer();
			return;
		}
		if (state.totp.loading) {
			return;
		}
		if (state.totp.expiresIn > 1) {
			state.totp.expiresIn -= 1;
			renderTotpModal();
			return;
		}
		refreshTotpCode();
	}, 1000);
}

function stopTotpTimer() {
	if (state.totp.timer) {
		window.clearInterval(state.totp.timer);
		state.totp.timer = null;
	}
}

async function refreshTotpCode() {
	const account = state.accounts.find(item => item.id === state.totp.accountId);
	if (!account) {
		closeTotpModal();
		return;
	}

	state.totp.loading = true;
	state.totp.error = '';
	renderTotpModal();
	try {
		const data = await postJson('/api/auth-code', {
			accountName: account.accountName,
			sharedSecret: account.sharedSecret || ''
		});
		state.totp.accountName = data.accountName || account.accountName || '';
		state.totp.code = data.code || '';
		state.totp.expiresIn = Number(data.expiresIn || 0);
	} catch (err) {
		state.totp.code = '';
		state.totp.expiresIn = 0;
		state.totp.error = err.message || '读取验证码失败';
	} finally {
		state.totp.loading = false;
		renderTotpModal();
	}
}

function renderTotpModal() {
	$('totp-title').textContent = state.totp.accountName ? `${state.totp.accountName} 登录验证码` : '查看验证码';
	$('totp-code').textContent = state.totp.loading
		? '读取中...'
		: (state.totp.code || '-----');
	$('totp-meta').textContent = state.totp.error
		? state.totp.error
		: `剩余 ${Math.max(0, Number(state.totp.expiresIn || 0))} 秒`;
	$('totp-refresh').disabled = state.totp.loading || !state.totp.accountId;
}

function normalizeLoginStatus(status) {
	if (status === '登录成功' || status === '已登录' || status === 'WebSession' || status === '成功') {
		return '登录成功';
	}
	if (status === '登录失败' || status === '失败' || status === '已断开' || status === '缺少密码') {
		return '登录失败';
	}
	if (status === '登录中' || status === '需要验证' || status === '获取 Web' || status === '已创建' || status === '已导入令牌') {
		return '登录中';
	}
	return '未登录';
}

function formatBalance(account) {
	if (!account.hasWallet) {
		return '-';
	}
	const balance = Number(account.balance);
	if (!Number.isFinite(balance)) {
		return '-';
	}
	return `${currencySymbol(account.currency)}${balance.toFixed(2)}`;
}

function currencySymbol(currency) {
	const symbols = {
		1: '$',
		2: '£',
		3: '€',
		5: '₽',
		7: 'R$',
		8: '¥',
		9: 'kr ',
		10: 'Rp ',
		11: 'RM ',
		12: '₱',
		13: 'S$',
		14: '฿',
		15: '₫',
		16: '₩',
		17: '₺',
		18: '₴',
		19: 'Mex$',
		20: 'C$',
		21: 'A$',
		22: 'NZ$',
		24: '₹',
		27: 'COL$',
		28: 'R ',
		29: 'HK$',
		30: 'NT$',
		31: 'SR ',
		32: 'AED ',
		37: '₸',
		39: 'QR ',
		40: '₡',
		41: '$U '
	};
	return symbols[Number(currency)] || '';
}

function applyLoggedOutState(account) {
	account.status = '未登录';
	account.attemptId = '';
	account.guard = null;
	account.hasRefreshToken = false;
	account.gcConnected = false;
	account.cs2GcConnected = false;
	account.tf2GcConnected = false;
	account.activeGame = 'cs2';
	account.inventoryCount = 0;
	account.inventorySource = '';
	account.lastError = '';
}

async function refreshAccountMeta() {
	const accountNames = Array.from(new Set(
		state.accounts
			.map(account => String(account.accountName || '').trim())
			.filter(Boolean)
	));

	if (!accountNames.length) {
		return;
	}

	const version = ++state.metaSyncVersion;
	try {
		const data = await postJson('/api/accounts/meta', {accountNames});
		if (version !== state.metaSyncVersion) {
			return;
		}
		if (mergeAccountMeta(data.accounts || {})) {
			saveAccounts();
			renderAccounts();
			renderInventory();
			renderPurchase();
		}
	} catch {}
}

function mergeAccountMeta(metaByName) {
	let changed = false;
	for (const account of state.accounts) {
		const meta = metaByName[account.accountName];
		if (!meta) {
			continue;
		}
		// 从 meta 回填 steamID（来自 maFile，无需登录即可匹配）
		if (!account.steamID && meta.steamId) {
			account.steamID = String(meta.steamId);
			changed = true;
		}
		if (!!meta.hasMaFile !== !!account.hasMaFile) {
			account.hasMaFile = !!meta.hasMaFile;
			changed = true;
		}
		if (!account.country && meta.country) {
			account.country = meta.country;
			changed = true;
		} else if (meta.country && meta.country !== account.country) {
			account.country = meta.country;
			changed = true;
		}
		if ((!account.hasWallet || account.balance == null) && meta.hasWallet) {
			account.hasWallet = true;
			account.balance = meta.balance;
			account.currency = meta.currency;
			changed = true;
		}
	}
	return changed;
}

// 是否停在底部附近（容差 40px）。用于决定新日志是否自动跟随到底。
function isLogsNearBottom() {
	return logs.scrollHeight - logs.scrollTop - logs.clientHeight < 40;
}

// 跳到最新（底部）并隐藏“最新日志”按钮
function scrollLogsToBottom() {
	logs.scrollTop = logs.scrollHeight;
	if (logsToBottomBtn) logsToBottomBtn.hidden = true;
}

// 根据当前滚动位置显示/隐藏“↓ 最新日志”按钮
function updateLogsToBottomBtn() {
	if (logsToBottomBtn) logsToBottomBtn.hidden = isLogsNearBottom();
}

function addLine(level, message) {
	const now = new Date().toLocaleTimeString('zh-CN', {hour12: false});
	state.logLines.push(`[${now}] ${message}`);
	if (state.logLines.length > 600) {
		state.logLines.shift();
	}
	// 写入前先判断用户是否停在底部附近：是则自动跟随到底（实时滚动），
	// 否则保留用户当前滚动位置，方便向上翻看历史日志，并提示有新日志可“回到最新”。
	const stickToBottom = isLogsNearBottom();
	logs.textContent = state.logLines.join('\n') + '\n';
	if (stickToBottom) {
		logs.scrollTop = logs.scrollHeight;
		if (logsToBottomBtn) logsToBottomBtn.hidden = true;
	} else if (logsToBottomBtn) {
		logsToBottomBtn.hidden = false;
	}
	saveLogLines();
}

// 渲染已恢复/现有的日志到日志面板并滚动到底部（页面加载时调用）
function renderLogs() {
	logs.textContent = state.logLines.length ? state.logLines.join('\n') + '\n' : '';
	logs.scrollTop = logs.scrollHeight;
	if (logsToBottomBtn) logsToBottomBtn.hidden = true;
}

// ===================== UU发货 =====================

// ===== UU Token 独立管理面板 =====

async function refreshUuTokens() {
	try {
		const data = await getJson('/api/uu/tokens');
		state.uu.tokens = Array.isArray(data.tokens) ? data.tokens : [];
		state.uu.tokenLoaded = true;
	} catch (err) {
		state.uu.tokenLoaded = true;
	}
	// 自动绑定：token 的 SteamID 匹配到「账户管理」里的账号且未绑定时，自动调用绑定接口
	const bound = await autoBindMatchedTokens();
	if (bound) {
		// 绑定成功会改变发货行，拉一次最新状态收尾
		await refreshUuState({force: true});
	} else if (state.activeModule === 'uu') {
		// token 现在直接参与建行（未匹配的 token 也要显示），拉完必须重绘
		renderUu();
	}
}

async function autoBindMatchedTokens() {
	const tokens = state.uu.tokens || [];
	const accounts = state.uu.accounts || [];
	const attempts = state.accounts || [];
	let boundCount = 0;
	for (const t of tokens) {
		if (!t.linkedSteamId || !t.token) continue;
		// 按 SteamID 在「账户管理」里找账号——不限在线状态，只要该账号登录过一次、
		// 本地存过 steamID 就能匹配上；账号是否在线只影响能否发货，不影响能否绑定。
		const matchedAccount = attempts.find(a => a.steamID === t.linkedSteamId);
		if (!matchedAccount) continue;
		// 检查是否已绑定
		const alreadyBound = accounts.some(a => a.accountName === matchedAccount.accountName && a.bound);
		if (alreadyBound) continue;
		// 自动绑定
		try {
			console.log('[uu] 自动绑定: token SteamID ' + t.linkedSteamId + ' -> 账号 ' + matchedAccount.accountName);
			// 不传 gameId：token 通用，绑一次即可，CS2/TF2 发货开关各自独立。
			await postJson('/api/uu/bind', {accountName: matchedAccount.accountName, token: t.token});
			addLine('info', 'UU Token：已自动绑定到 ' + matchedAccount.accountName);
			boundCount++;
		} catch (err) {
			// 静默失败，不打扰用户
		}
	}
	return boundCount;
}

	// 发货行 = 已绑定 token 的账号 + 尚未匹配到本地账号的 token。
	// token 是用户自己获取的，UU 侧绑定的 SteamID 决定它属于「账户管理」里的哪个账号；
	// 账号在线与否只影响行内提示和「登录账户」按钮，不影响是否显示。
	function getUuRows() {
		var accounts = getSortedUuAccounts();
		var rows = [];
		var claimedUserIds = {};
		for (var i = 0; i < accounts.length; i++) {
			var account = accounts[i];
			if (account && account.userId) { claimedUserIds[String(account.userId)] = true; }
			var local = findAccount(account && account.accountName) || null;
			rows.push({
				kind: 'account',
				account: account,
				local: local,
				// online 取后端发货就绪判断（PURCHASE_ONLINE_STATUSES），它才是能否发货的真实门槛；
				// 本地「登录成功」是粘性的，掉线后不会回退，拿它做提示会骗人。
				online: !!(account && account.online)
			});
		}
		var tokens = Array.isArray(state.uu.tokens) ? state.uu.tokens : [];
		for (var j = 0; j < tokens.length; j++) {
			var token = tokens[j];
			if (!token || !token.token) { continue; }
			if (token.userId && claimedUserIds[String(token.userId)]) { continue; }
			rows.push({kind: 'token', token: token, local: findUuLocalAccountBySteamId(token.linkedSteamId)});
		}
		return rows;
	}

	// 按 UU 绑定的 SteamID 在「账户管理」里找账号——包含离线账号，
	// 只要它此前登录过一次、本地存过 steamID 就能匹配上。
	function findUuLocalAccountBySteamId(steamId) {
		var id = String(steamId || '').trim();
		if (!id) { return null; }
		var accounts = state.accounts || [];
		for (var i = 0; i < accounts.length; i++) {
			if (accounts[i] && String(accounts[i].steamID || '').trim() === id) { return accounts[i]; }
		}
		return null;
	}

	function getSortedUuAccounts() {
		var accounts = Array.isArray(state.uu.accounts) ? state.uu.accounts.slice() : [];
		accounts.sort(function(a, b) {
			var ab = a && a.bound ? 0 : 1;
			var bb = b && b.bound ? 0 : 1;
			if (ab !== bb) return ab - bb;
			return String(a && a.accountName || '').localeCompare(String(b && b.accountName || ''));
		});
		return accounts;
	}

	function formatUuInterval(ms) {
		var n = Number(ms || 0);
		if (n <= 0) return '-';
		if (n % 60000 === 0) return (n / 60000) + ' 分钟';
		if (n >= 60000) return (Math.round(n / 6000) / 10) + ' 分钟';
		return Math.round(n / 1000) + ' 秒';
	}

	function renderUuCounts(accounts) {
		var list = Array.isArray(accounts) ? accounts : [];
		var bound = 0;
		var online = 0;
		var delivered = 0;
		for (var i = 0; i < list.length; i++) {
			if (list[i] && list[i].bound) bound++;
			if (list[i] && list[i].online) online++;
			var dlv = list[i] && list[i].delivery;
			if (dlv) {
				for (var gk in dlv) {
					if (dlv[gk] && dlv[gk].stats) delivered += dlv[gk].stats.delivered || 0;
				}
			}
		}
		var pollMs = Number(state.uu.pollIntervalMs || 0);
		var ac = document.getElementById('uu-account-count'); if (ac) ac.textContent = '账号：' + list.length;
		var bc = document.getElementById('uu-bound-count'); if (bc) bc.textContent = '已绑定：' + bound;
		var oc = document.getElementById('uu-online-count'); if (oc) oc.textContent = '在线：' + online + ' / ' + list.length;
		var dc = document.getElementById('uu-delivered-count'); if (dc) dc.textContent = '累计发货：' + delivered;
		var ph = document.getElementById('uu-poll-hint'); if (ph) ph.textContent = '轮询：' + formatUuInterval(pollMs);
		var pi = document.getElementById('uu-poll-input');
		if (pi && document.activeElement !== pi && pollMs > 0) {
			pi.value = String(Math.round(pollMs / 60000 * 10) / 10);
		}
	}

	async function saveUuPollInterval() {
		var input = document.getElementById('uu-poll-input');
		if (!input) return;
		var minutes = Number(input.value);
		if (!isFinite(minutes) || minutes <= 0) {
			toast('请输入有效的轮询分钟数（最少 0.5 分钟）', 'warn');
			return;
		}
		try {
			var data = await postJson('/api/uu/poll-interval', {minutes: minutes});
			state.uu.pollIntervalMs = Number(data.pollIntervalMs || 0);
			addLine('info', 'UU发货：轮询间隔已设为 ' + formatUuInterval(state.uu.pollIntervalMs));
			renderUu();
		} catch (err) {
			toast('设置失败：' + (err.message || err), 'error');
		}
	}

	// 已绑定 token 的账号：提示对应 Steam 账号是否在线（离线时右侧给出「登录账户」按钮）。
	function renderUuOnlineHint(row) {
		if (!row.local) {
			return '<span class="uu-online-missing" title="UU 绑定的 Steam 账号不在「账户管理」列表里">账户管理无此账号</span>';
		}
		if (row.online) {
			// 在线但缺 cookies / identity_secret 时同样发不了货，一并提示，省得用户以为在线就万事大吉。
			if (row.account && !row.account.hasCookies) {
				return '<span class="uu-online-warn" title="缺少 WebSession cookies，无法发货">在线·缺 cookies</span>';
			}
			if (row.account && !row.account.hasIdentitySecret) {
				return '<span class="uu-online-warn" title="缺少 identity_secret（需导入 maFile），无法确认发货">在线·缺 maFile</span>';
			}
			return '<span class="uu-online-ok">在线</span>';
		}
		return '<span class="uu-online-off" title="Steam 账号未在线，无法发货">离线</span>';
	}

	// 已获取但还没匹配到「账户管理」账号的 token：单独成行，否则用户获取完 token 看不到任何反馈。
	function renderUuUnmatchedTokenRow(row) {
		var token = row.token || {};
		var steamId = String(token.linkedSteamId || '').trim();
		var hint;
		if (!steamId) {
			hint = '该 Token 在 UU 侧未绑定 Steam 账号，无法用于发货';
		} else if (row.local) {
			// SteamID 对上了本地账号，说明自动绑定这一步失败了（token 过期/校验不通过）
			hint = '已匹配到账号 ' + escapeHtml(row.local.accountName || '') + '，但绑定未成功，请检查 Token 是否已过期';
		} else {
			hint = '该 Token 绑定的 SteamID ' + escapeHtml(steamId) + ' 未匹配到「账户管理」中的账号，请先在账户管理添加并登录一次该账号';
		}
		return '<div class="uu-row uu-row-unmatched">'
			+ '<div class="uu-row-name">' + escapeHtml(token.nickname || token.userId || '(无昵称)') + '</div>'
			+ '<div class="uu-row-uu"><span class="nick">UU Token</span></div>'
			+ '<div class="uu-row-online"><span class="uu-online-missing">' + (row.local ? '绑定失败' : '未匹配') + '</span></div>'
			+ '<div class="uu-row-status"></div>'
			+ '<div class="uu-row-toggle"></div>'
			+ '<div class="uu-row-stats">' + hint + '</div>'
			+ '<div class="uu-row-actions">'
				+ '<button type="button" class="uu-token-del-btn uu-row-token-del-btn" data-uu-token="' + escapeAttr(token.token || '') + '">删除 Token</button>'
			+ '</div>'
			+ '</div>';
	}

	function renderUu() {
		var accounts = getSortedUuAccounts();
		var rows = getUuRows();
		renderUuCounts(accounts);
		var table = document.getElementById('uu-account-table');
		var empty = document.getElementById('uu-account-empty');
		if (!table) return;
		if (!rows.length) { table.innerHTML = ''; empty.hidden = false; return; }
		empty.hidden = true;
		table.innerHTML = rows.map(function(row) {
			if (row.kind === 'token') { return renderUuUnmatchedTokenRow(row); }
			var account = row.account;
			var d730 = (account.delivery && account.delivery['730']) || {};
			var d440 = (account.delivery && account.delivery['440']) || {};
			var s730 = d730.stats || {};
			var s440 = d440.stats || {};
			var listStats = account.listStats || {};
			var dStat = function(st) { return st === 'scanning' ? '\u53d1\u8d27\u4e2d' : st === 'error' ? '\u9519\u8bef' : '\u7a7a\u95f2'; };
			var dCls = function(st) { return st === 'scanning' ? 'scanning' : st === 'error' ? 'error' : 'idle'; };
			var lastScan = d730.lastScanAt || d440.lastScanAt || '';
			return '<div class="uu-row">'
				+ '<div class="uu-row-name">' + escapeHtml(account.accountName) + '</div>'
				+ '<div class="uu-row-uu">' + (account.bound
					? '<span class="nick">' + escapeHtml(account.nickname || '(\u65e0\u6635\u79f0)') + '</span>'
					: '<span class="unbound">\u672a\u7ed1\u5b9a</span>') + '</div>'
				+ '<div class="uu-row-online">' + renderUuOnlineHint(row) + '</div>'
				+ '<div class="uu-row-status">' + (account.bound
					? '<span class="' + dCls(d730.status) + '">CS2 ' + dStat(d730.status) + '</span> <span class="' + dCls(d440.status) + '">TF2 ' + dStat(d440.status) + '</span>'
					: '') + '</div>'
				+ '<div class="uu-row-toggle">' + (account.bound
					? '<label class="uu-switch"><input type="checkbox" data-uu-action="auto" data-uu-game="730" data-uu-account="' + escapeAttr(account.accountName) + '" ' + (d730.auto ? 'checked' : '') + '><span>CS2\u53d1\u8d27</span></label>'
						+ '<label class="uu-switch"><input type="checkbox" data-uu-action="auto" data-uu-game="440" data-uu-account="' + escapeAttr(account.accountName) + '" ' + (d440.auto ? 'checked' : '') + '><span>TF2\u53d1\u8d27</span></label>'
						+ '<label class="uu-switch"><input type="checkbox" data-uu-action="list-auto" data-uu-account="' + escapeAttr(account.accountName) + '" ' + (account.listAuto ? 'checked' : '') + '><span>\u81ea\u52a8\u4e0a\u67b6(CS2)</span></label>'
					: '<button type="button" class="primary uu-row-bind-btn" data-uu-account="' + escapeAttr(account.accountName) + '">\u7ed1\u5b9a Token</button>') + '</div>'
				+ '<div class="uu-row-stats">' + (account.bound
					? '<span class="ok">CS2\u53d1\u8d27 ' + (s730.delivered || 0) + '</span> <span class="ok">TF2\u53d1\u8d27 ' + (s440.delivered || 0) + '</span> <span class="bad">\u5931\u8d25 ' + ((s730.failed || 0) + (s440.failed || 0)) + '</span>'
						+ ' <span class="uu-list-stat">\u4e0a\u67b6 ' + (listStats.listed || 0) + (listStats.repriced ? ' / \u6539\u4ef7 ' + listStats.repriced : '') + (listStats.failed ? ' / \u5931\u8d25 ' + listStats.failed : '') + (listStats.noAbrade ? ' / \u65e0\u78e8\u635f ' + listStats.noAbrade : '') + '</span>'
						+ (account.listStatus === 'listing' ? ' <span class="scanning">\u4e0a\u67b6\u4e2d</span>' : account.listStatus === 'error' ? ' <span class="error">\u4e0a\u67b6\u9519\u8bef</span>' : '')
					: '<span>\u70b9\u51fb\u53f3\u4fa7\u6309\u94ae\u83b7\u53d6\u5e76\u7ed1\u5b9a UU Token</span>')
				+ (lastScan ? ' <span>' + escapeHtml(new Date(lastScan).toLocaleTimeString('zh-CN', {hour12: false})) + '</span>' : '')
				+ '</div>'
				+ '<div class="uu-row-actions">'
					+ (!row.online && row.local
						? '<button type="button" class="primary uu-row-login-btn" data-uu-account="' + escapeAttr(account.accountName) + '">\u767b\u5f55\u8d26\u6237</button>'
						: '')
					+ (account.bound
						? '<button type="button" class="uu-row-list-scan-btn" data-uu-account="' + escapeAttr(account.accountName) + '">\u7acb\u5373\u4e0a\u67b6</button>'
							+ '<button type="button" class="uu-token-del-btn uu-row-del-btn" data-uu-account="' + escapeAttr(account.accountName) + '">\u5220\u9664 Token</button>'
						: '')
				+ '</div>'
				+ '</div>';
		}).join('');

		// bind events
		table.querySelectorAll('input[data-uu-action="auto"]').forEach(function(input) {
			input.addEventListener('change', function() { toggleUuAuto(input.dataset.uuAccount, input.dataset.uuGame, input.checked); });
		});
		table.querySelectorAll('input[data-uu-action="list-auto"]').forEach(function(input) {
			input.addEventListener('change', function() { toggleUuListAuto(input.dataset.uuAccount, input.checked); });
		});
		table.querySelectorAll('.uu-row-bind-btn').forEach(function(btn) {
			btn.addEventListener('click', function() { openUuTokenModal(btn.dataset.uuAccount); });
		});
		table.querySelectorAll('.uu-row-list-scan-btn').forEach(function(btn) {
			btn.addEventListener('click', function() { scanUuList(btn.dataset.uuAccount, btn); });
		});
		table.querySelectorAll('.uu-row-del-btn').forEach(function(btn) {
			btn.addEventListener('click', function() { deleteUuAccountToken(btn.dataset.uuAccount); });
		});
		table.querySelectorAll('.uu-row-login-btn').forEach(function(btn) {
			btn.addEventListener('click', function() { loginUuAccount(btn.dataset.uuAccount, btn); });
		});
		table.querySelectorAll('.uu-row-token-del-btn').forEach(function(btn) {
			btn.addEventListener('click', function() { deleteUuTokenByValue(btn.dataset.uuToken); });
		});
	}

	// 发货行里的「登录账户」：直接调账户管理的登录逻辑，省得用户切模块去勾选登录。
	async function loginUuAccount(accountName, button) {
		var local = findAccount(accountName);
		if (!local) {
			toast('「账户管理」里没有账号 ' + accountName + '，请先添加该账号', 'warn');
			return;
		}
		setUuButtonBusy(button, true, '登录中…');
		try {
			// force：这一行的离线判断来自后端发货就绪状态，本地 status 可能还粘在「登录成功」，
			// 不 force 会被重复登录守卫挡下来，用户就永远登不上。
			await loginAccount(local, {force: true});
			await refreshUuState({force: true});
		} finally {
			setUuButtonBusy(button, false);
		}
	}

	// 删除未匹配到账号的 token（这类 token 没有 accountName，只能按 token 值删）
	async function deleteUuTokenByValue(token) {
		var tok = String(token || '').trim();
		if (!tok) { return; }
		var confirmed = await confirmDialog('确定删除这个尚未匹配到账号的 UU Token？', {
			title: '删除 Token',
			confirmText: '删除',
			danger: true
		});
		if (!confirmed) { return; }
		try {
			await postJson('/api/uu/token', {token: tok}, 'DELETE');
			addLine('info', 'UU Token：已删除未匹配的 Token');
			await refreshUuTokens();
			await refreshUuState({force: true});
		} catch (err) {
			toast('删除失败：' + err.message, 'error');
		}
	}

function openUuTokenModal(accountName) {
	const modal = $('uu-token-modal');
	const body = $('uu-modal-body');
	if (!modal || !body) return;
	state.uu.selectedAccount = String(accountName || '').trim();
	body.innerHTML = renderUuModalContent();
	modal.classList.add('show');
}

function closeUuTokenModal() {
	const modal = $('uu-token-modal');
	if (modal) modal.classList.remove('show');
	state.uu.login = null;
	state.uu.selectedAccount = '';
}

function refreshUuModalContent() {
	var body = document.getElementById('uu-modal-body');
	if (body) body.innerHTML = renderUuModalContent();
}

function renderUuModalContent() {
	const login = state.uu.login;
	// 这里不选游戏：UU token 是「按 UU 账号」发的（JWT 里只有 Id/Name，没有游戏字段），
	// 一个 token 对 CS2/TF2 都通用。发哪个游戏由账号行里的「CS2发货 / TF2发货」开关分别控制。
	// 短信登录内嵌表单
	let html = '<div class="uu-login-box"><div class="uu-login-title">短信登录获取 Token</div>' + renderUuLoginInner(login) + '</div>';
	// 手动粘贴
	html += '<div class="uu-login-box"><div class="uu-login-title">手动粘贴 Token</div>'
		+ '<label class="uu-field"><textarea id="uu-modal-token" rows="3" placeholder="eyJ..." spellcheck="false"></textarea></label>'
		+ '<div class="uu-actions"><button type="button" class="primary" id="uu-modal-bind-btn">校验并绑定</button></div>'
		+ '</div>';
	return html;
}

async function handleUuTokenLoginStart(button) {
	const body = document.getElementById('uu-modal-body');
	const phoneEl = body.querySelector('[data-uu-field="phone"]');
	const phone = phoneEl ? phoneEl.value.trim() : '';
	if (!/^\d{6,15}$/.test(phone)) {
		toast('请输入正确的手机号', 'warn');
		return;
	}
	setUuButtonBusy(button, true, '发送中…');
	try {
		const data = await postJson('/api/uu/login/start', {phone});
		state.uu.login = {
			phone,
			loginSessionId: data.loginSessionId,
			mode: data.mode,
			smsUpContent: data.smsUpContent || '',
			smsUpNumber: data.smsUpNumber || '',
			message: data.message || '',
			error: ''
		};
		addLine('info', 'UU Token：已发送验证码至 ' + phone);
		refreshUuModalContent();
	} catch (err) {
		state.uu.login = {phone, error: err.message || '发送失败'};
		addLine('error', 'UU Token：发送验证码失败 ' + err.message);
		refreshUuModalContent();
	} finally {
		setUuButtonBusy(button, false);
	}
}

async function handleUuTokenLoginVerify(button) {
	const login = state.uu.login;
	if (!login || !login.loginSessionId) {
		return;
	}
	const body = document.getElementById('uu-modal-body');
	let code = '';
	if (login.mode === 'sms') {
		const codeEl = body.querySelector('[data-uu-field="code"]');
		code = codeEl ? codeEl.value.trim() : '';
		if (!code) {
			toast('请输入短信验证码', 'warn');
			return;
		}
	}
	setUuButtonBusy(button, true, '登录中…');
	try {
		// 不传 gameId：token 是按 UU 账号发的，CS2/TF2 通用；发哪个游戏由账号行的开关决定。
		const data = await postJson('/api/uu/login/verify', {
			loginSessionId: login.loginSessionId,
			code,
			accountName: ''
		});
		state.uu.login = null;
		addLine('info', 'UU Token：获取成功 ' + (data.nickname || data.userId || ''));
		if (data.linkedSteamId) {
			addLine('info', 'UU Token：已查到绑定 SteamID ' + data.linkedSteamId);
		}
		if (data.bindError) {
			addLine('warn', 'UU Token：已获取，但自动绑定失败 ' + data.bindError);
			toast('已获取 Token，但自动绑定失败：' + data.bindError, 'warn');
		}
		// 先关弹窗再刷新:弹窗是全屏遮罩,盖在发货账户表上,不关的话刷新了用户也看不见。
		closeUuTokenModal();
		await refreshUuTokens();
		await refreshUuState({force: true});
	} catch (err) {
		login.error = err.message || '登录失败';
		addLine('error', 'UU Token：登录失败 ' + err.message);
		refreshUuModalContent();
	} finally {
		setUuButtonBusy(button, false);
	}
}

async function bindUuTokenInModal(accountName, token) {
	if (!token) { toast('请粘贴 Token', 'warn'); return; }
	// 没有预选账号时走「获取」路径：先存下 token 并查出它在 UU 侧绑定的 SteamID，
	// 再由 refreshUuTokens → autoBindMatchedTokens 按 SteamID 匹配「账户管理」里的账号。
	// 手动粘贴和短信登录到这一步是等价的，都不要求先挑一个在线账号。
	if (!accountName) {
		try {
			const data = await postJson('/api/uu/token/acquire', {token});
			const entry = (data && data.token) || {};
			addLine('info', 'UU Token：已保存 ' + (entry.nickname || entry.userId || ''));
			if (entry.linkedSteamId) {
				addLine('info', 'UU Token：已查到绑定 SteamID ' + entry.linkedSteamId);
			} else {
				addLine('warn', 'UU Token：该 Token 在 UU 侧未绑定 Steam 账号，无法用于发货');
			}
			closeUuTokenModal();
			await refreshUuTokens();
			await refreshUuState({force: true});
		} catch (err) {
			toast('保存 Token 失败：' + (err.message || err), 'error');
		}
		return;
	}
	try {
		// 同上：不传 gameId，token 通用。
		const data = await postJson('/api/uu/bind', {accountName, token});
		mergeUuAccount(data.account);
		addLine('info', 'UU Token：已绑定到 ' + accountName);
		closeUuTokenModal();
		await refreshUuState({force: true});
	} catch (err) {
		toast('绑定失败：' + (err.message || err), 'error');
	}
}

// 删除某个账号已绑定/获取的 token（行内删除按钮调用）
async function deleteUuAccountToken(accountName) {
	const name = String(accountName || '').trim();
	if (!name) return;
	const confirmed = await confirmDialog('确定删除账号「' + name + '」已获取的 Token？删除后将取消该账号自动发货。', {
		title: '删除 Token',
		confirmText: '删除',
		danger: true
	});
	if (!confirmed) {
		return;
	}
	try {
		const data = await postJson('/api/uu/token', {accountName: name}, 'DELETE');
		addLine('info', 'UU Token：已删除 ' + name);
		if (data && data.account) {
			mergeUuAccount(data.account);
		}
		await refreshUuTokens();
		await refreshUuState();
	} catch (err) {
		toast('删除失败：' + err.message, 'error');
	}
}

function ensureUuLoaded() {
	if (!state.uu.loaded && !state.uu.loading) {
		refreshUuState();
	}
}

async function refreshUuState(options = {}) {
	if (state.uu.loading) {
		// 之前这里直接 return,把这次刷新「吞掉」了 —— 拿到 token 后的刷新如果撞上
		// 正在进行的刷新(比如切模块触发的 ensureUuLoaded),发货账户表就不会更新,
		// 看起来就是「更新有延迟」。改成排队重试一次,拿最新数据收尾。
		if (state.uu.pendingRefresh) {
			return state.uu.pendingRefresh;
		}
		state.uu.pendingRefresh = (async () => {
			while (state.uu.loading) {
				await new Promise(resolve => setTimeout(resolve, 120));
			}
			state.uu.pendingRefresh = null;
			return refreshUuState(options);
		})();
		return state.uu.pendingRefresh;
	}
	state.uu.loading = true;
	state.uu.error = '';
	if (options.force) {
		renderUu();
	}
	try {
		const data = await getJson('/api/uu/state');
		state.uu.accounts = Array.isArray(data.accounts) ? data.accounts : [];
		state.uu.pollIntervalMs = Number(data.pollIntervalMs || 0);
		state.uu.loaded = true;
		if (state.uu.selectedAccount && !state.uu.accounts.some(account => account.accountName === state.uu.selectedAccount)) {
			state.uu.selectedAccount = '';
		}
		if (!state.uu.selectedAccount && state.uu.accounts.length) {
			state.uu.selectedAccount = state.uu.accounts[0].accountName;
		}
	} catch (err) {
		state.uu.error = err.message || '加载失败';
	} finally {
		state.uu.loading = false;
		renderUu();
	}
	if (!state.uu.tokenLoaded) {
		refreshUuTokens();
	}
}

function mergeUuAccount(account) {
	if (!account || !account.accountName) {
		return;
	}
	const index = state.uu.accounts.findIndex(item => item.accountName === account.accountName);
	if (index >= 0) {
		state.uu.accounts[index] = account;
	} else {
		state.uu.accounts.push(account);
	}
	if (state.activeModule !== 'uu') {
		return;
	}
	renderUu();
}

function renderUuLoginInner(login) {
	if (login && login.loginSessionId && login.mode === 'sms') {
		return `<div class="muted">${escapeHtml(login.message || ('验证码已发送至 ' + login.phone))}</div>`
			+ '<label class="uu-field"><span>短信验证码</span><input data-uu-field="code" maxlength="8" inputmode="numeric" placeholder="验证码" autocomplete="one-time-code"></label>'
			+ (login.error ? `<div class="uu-error">${escapeHtml(login.error)}</div>` : '')
			+ '<div class="uu-actions">'
			+ '<button type="button" onclick="closeUuTokenModal()">取消</button>'
			+ '<button type="button" class="primary" data-uu-action="login-verify">登录并绑定</button>'
			+ '</div>';
	}
	if (login && login.loginSessionId && login.mode === 'sms-up') {
		return '<div class="uu-notice">'
			+ '该手机号需要<strong>上行短信</strong>验证：请用本机编辑短信，'
			+ `内容 <strong>${escapeHtml(login.smsUpContent)}</strong>，发送到 <strong>${escapeHtml(login.smsUpNumber)}</strong>，发送成功后点下方按钮。`
			+ '</div>'
			+ (login.error ? `<div class="uu-error">${escapeHtml(login.error)}</div>` : '')
			+ '<div class="uu-actions">'
			+ '<button type="button" onclick="closeUuTokenModal()">取消</button>'
			+ '<button type="button" class="primary" data-uu-action="login-verify">我已发送，登录并绑定</button>'
			+ '</div>';
	}
	return '<label class="uu-field"><span>手机号(+86)</span>'
		+ `<input data-uu-field="phone" inputmode="numeric" maxlength="15" placeholder="11位手机号"${login && login.phone ? ` value="${escapeAttr(login.phone)}"` : ''}></label>`
		+ (login && login.error ? `<div class="uu-error">${escapeHtml(login.error)}</div>` : '')
		+ '<div class="uu-actions"><button type="button" class="primary" data-uu-action="login-start">发送验证码</button></div>';
}

function setUuButtonBusy(button, busy, text) {
	if (!button) {
		return;
	}
	button.disabled = busy;
	if (busy) {
		button.dataset.label = button.textContent;
		button.textContent = text || '处理中…';
	} else if (button.dataset.label) {
		button.textContent = button.dataset.label;
		delete button.dataset.label;
	}
}

async function toggleUuAuto(account, gameId, enabled) {
	try {
		const data = await postJson('/api/uu/auto', {accountName: account, gameId, enabled});
		mergeUuAccount(data.account);
	} catch (err) {
		toast('操作失败：' + err.message, 'error');
		renderUu();
	}
}

async function toggleUuListAuto(account, enabled) {
	try {
		const data = await postJson('/api/uu/list/auto', {accountName: account, enabled});
		mergeUuAccount(data.account);
		addLine('info', 'CS2上架：' + account + (enabled ? ' 已开启自动上架' : ' 已关闭自动上架'));
	} catch (err) {
		toast('操作失败：' + err.message, 'error');
		renderUu();
	}
}

async function scanUuList(account, button) {
	setUuButtonBusy(button, true, '上架中…');
	try {
		const data = await postJson('/api/uu/list/scan', {accountName: account});
		mergeUuAccount(data.account);
		addLine('info', 'CS2上架：' + account + ' 上架扫描完成');
	} catch (err) {
		addLine('error', 'CS2上架：上架失败 ' + err.message);
	} finally {
		setUuButtonBusy(button, false);
	}
}

function openChangePasswordModal() {
	$('cp-current').value = '';
	$('cp-new').value = '';
	$('cp-confirm').value = '';
	const errBox = $('cp-error');
	errBox.hidden = true;
	errBox.textContent = '';
	$('change-password-modal').hidden = false;
	$('cp-current').focus();
}

function closeChangePasswordModal() {
	$('change-password-modal').hidden = true;
}

async function submitChangePassword() {
	const current = $('cp-current').value;
	const next = $('cp-new').value;
	const confirm = $('cp-confirm').value;
	const errBox = $('cp-error');
	const showError = msg => {
		errBox.textContent = msg;
		errBox.hidden = false;
	};
	if (!next) {
		showError('请输入新口令');
		return;
	}
	if (next !== confirm) {
		showError('两次输入的新口令不一致');
		return;
	}
	const btn = $('change-password-confirm');
	btn.disabled = true;
	try {
		await postJson('/api/auth/password', {currentPassword: current, newPassword: next});
		closeChangePasswordModal();
		addLine('success', '访问口令已修改,其它设备需重新登录');
	} catch (err) {
		showError(err.message || '修改失败');
	} finally {
		btn.disabled = false;
	}
}

// ===== 充值码兑换模块 =====

// 去掉数组结尾的纯空行(常见的结尾换行),保留中间行以维持行号对齐。
function stripTrailingEmpty(lines) {
	const out = lines.slice();
	while (out.length && !out[out.length - 1].trim()) {
		out.pop();
	}
	return out;
}

// 严格按「行下标」把左侧账户(账号----密码)与右侧充值码一一对应。
// 不做独立过滤空行(那样会让两列错位),而是逐行检查:
//   - 两侧同为空行 → 跳过(不影响后续对齐)
//   - 只有一侧有内容 → 记为对齐错误(issues),不参与兑换
//   - 两侧都有内容 → 一条有效配对
function parseWalletLines() {
	const accountLines = stripTrailingEmpty(String($('wallet-accounts').value || '').split(/\r?\n/));
	const codeLines = stripTrailingEmpty(String($('wallet-codes').value || '').split(/\r?\n/));
	const lineCount = Math.max(accountLines.length, codeLines.length);

	const pairs = [];
	const issues = [];
	let accountTotal = 0;
	let codeTotal = 0;

	for (let i = 0; i < lineCount; i++) {
		const accountRaw = (accountLines[i] || '').trim();
		const codeRaw = (codeLines[i] || '').trim();
		if (accountRaw) accountTotal++;
		if (codeRaw) codeTotal++;

		if (!accountRaw && !codeRaw) {
			continue;
		}
		if (accountRaw && !codeRaw) {
			issues.push({line: i + 1, reason: '左侧有账户，右侧缺少对应充值码'});
			continue;
		}
		if (!accountRaw && codeRaw) {
			issues.push({line: i + 1, reason: '右侧有充值码，左侧缺少对应账户'});
			continue;
		}

		const idx = accountRaw.indexOf('----');
		const account = idx === -1 ? accountRaw : accountRaw.slice(0, idx).trim();
		const password = idx === -1 ? '' : accountRaw.slice(idx + 4);
		if (!account) {
			issues.push({line: i + 1, reason: '账户名为空'});
			continue;
		}
		pairs.push({account, password, code: codeRaw, line: i + 1});
	}

	return {pairs, issues, accountTotal, codeTotal};
}

function updateWalletCounts() {
	const parsed = parseWalletLines();
	$('wallet-account-count').textContent = '账户：' + parsed.accountTotal;
	$('wallet-code-count').textContent = '充值码：' + parsed.codeTotal;
	$('wallet-pair-count').textContent = '配对：' + parsed.pairs.length
		+ (parsed.issues.length ? '（错位 ' + parsed.issues.length + '）' : '');
	return parsed;
}

function getWalletConcurrency() {
	let n = parseInt($('wallet-thread-input').value, 10);
	if (!Number.isFinite(n) || n < 1) {
		n = 3;
	}
	if (n > 10) {
		n = 10;
	}
	$('wallet-thread-input').value = String(n);
	return n;
}

function countWalletFinished() {
	return state.wallet.results.filter(r => r.status === 'success' || r.status === 'error').length;
}

function setWalletControlsRunning(running) {
	$('wallet-redeem-btn').disabled = running;
	$('wallet-clear-btn').disabled = running;
	$('wallet-thread-input').disabled = running;
	updateWalletRetryButton();
}

function updateWalletRetryButton() {
	const hasFailed = state.wallet.results.some(r => r.status === 'error');
	$('wallet-retry-btn').disabled = state.wallet.running || !hasFailed;
}

function renderWallet() {
	updateWalletCounts();
	renderWalletResults();
}

function maskWalletCode(code) {
	const value = String(code || '');
	if (value.length <= 8) {
		return value;
	}
	return value.slice(0, 5) + '…' + value.slice(-4);
}

function walletStatusLabel(status) {
	switch (status) {
		case 'success': return '成功';
		case 'error': return '失败';
		case 'processing': return '处理中';
		default: return '待处理';
	}
}

function renderWalletResults() {
	const tbody = $('wallet-result-rows');
	const empty = $('wallet-result-empty');
	const results = state.wallet.results;
	tbody.innerHTML = '';

	let success = 0;
	let fail = 0;
	for (const item of results) {
		if (item.status === 'success') success++;
		else if (item.status === 'error') fail++;
	}
	$('wallet-success-count').textContent = '成功：' + success;
	$('wallet-fail-count').textContent = '失败：' + fail;

	if (!results.length) {
		empty.hidden = false;
		updateWalletRetryButton();
		return;
	}
	empty.hidden = true;

	results.forEach((item, index) => {
		const tr = document.createElement('tr');

		const idxCell = document.createElement('td');
		idxCell.className = 'wallet-idx-cell';
		idxCell.textContent = String(index + 1);
		tr.appendChild(idxCell);

		const accountCell = document.createElement('td');
		accountCell.className = 'wallet-account-cell';
		accountCell.textContent = item.account || '-';
		tr.appendChild(accountCell);

		const codeCell = document.createElement('td');
		codeCell.className = 'wallet-code-cell';
		codeCell.textContent = maskWalletCode(item.code);
		tr.appendChild(codeCell);

		const statusCell = document.createElement('td');
		const status = document.createElement('span');
		status.className = 'wallet-status is-' + (item.status || 'pending');
		status.textContent = walletStatusLabel(item.status);
		statusCell.appendChild(status);
		tr.appendChild(statusCell);

		const detailCell = document.createElement('td');
		detailCell.textContent = item.message || '';
		tr.appendChild(detailCell);

		tbody.appendChild(tr);
	});

	updateWalletRetryButton();
}

async function startWalletRedeem() {
	if (state.wallet.running) {
		addLine('warn', '充值码兑换正在进行中，请等待当前任务完成');
		return;
	}

	const {pairs, issues, accountTotal, codeTotal} = parseWalletLines();
	if (!accountTotal) {
		addLine('warn', '请先在左侧填写账户');
		return;
	}
	if (!codeTotal) {
		addLine('warn', '请先在右侧填写充值码');
		return;
	}

	// 严格 1:1:存在任何错位都不开始,逐条提示行号,避免把充值码兑到错的账号上。
	if (issues.length) {
		addLine('error', `账户与充值码未一一对应，发现 ${issues.length} 处错位，请修正后再兑换：`);
		issues.slice(0, 10).forEach(it => addLine('error', `  第 ${it.line} 行：${it.reason}`));
		if (issues.length > 10) {
			addLine('error', `  …其余 ${issues.length - 10} 处省略`);
		}
		return;
	}
	if (!pairs.length) {
		addLine('warn', '没有可兑换的有效配对');
		return;
	}

	const missingPassword = pairs.filter(p => !p.password).map(p => p.account);
	if (missingPassword.length) {
		addLine('info', `以下账户未填写密码，将尝试用本地 maFile/会话登录：${missingPassword.join('、')}`);
	}

	// 初始化结果行(保存 account/password/code,供后续「重试失败」沿用原配对)。
	state.wallet.results = pairs.map(p => ({
		account: p.account,
		password: p.password,
		code: p.code,
		status: 'pending',
		message: '排队中…',
		balance: ''
	}));

	// 首次运行:提交下标 == 结果行下标(恒等映射)。
	await submitWalletJob(pairs, pairs.map((p, i) => i), '开始兑换');
}

// 重试所有失败项:沿用原账户、原密码、原充值码;映射回原结果行。
async function retryWalletFailed() {
	if (state.wallet.running) {
		addLine('warn', '任务进行中，请等待完成后再重试');
		return;
	}

	const failedIndexes = [];
	state.wallet.results.forEach((row, i) => {
		if (row.status === 'error') {
			failedIndexes.push(i);
		}
	});
	if (!failedIndexes.length) {
		addLine('info', '没有失败的兑换项');
		return;
	}

	const pairs = failedIndexes.map(i => ({
		account: state.wallet.results[i].account,
		password: state.wallet.results[i].password,
		code: state.wallet.results[i].code
	}));
	failedIndexes.forEach(i => {
		state.wallet.results[i].status = 'pending';
		state.wallet.results[i].message = '排队重试…';
	});

	await submitWalletJob(pairs, failedIndexes, `重试失败项（${pairs.length} 条）`);
}

// 提交一个兑换任务。indexMap[jobIndex] = 结果行下标,用于把服务端回推的下标映射回界面行。
async function submitWalletJob(pairs, indexMap, actionLabel) {
	const concurrency = getWalletConcurrency();
	state.wallet.running = true;
	state.wallet.jobId = '';
	state.wallet.jobIndexMap = indexMap;
	setWalletControlsRunning(true);
	$('wallet-progress').textContent = `0 / ${pairs.length}`;
	renderWalletResults();
	addLine('info', `${actionLabel}：${pairs.length} 条，线程 ${concurrency}`);

	try {
		const data = await postJson('/api/wallet/redeem', {pairs, concurrency});
		state.wallet.jobId = data.jobId || '';
	} catch (err) {
		state.wallet.running = false;
		setWalletControlsRunning(false);
		$('wallet-progress').textContent = '提交失败';
		addLine('error', '提交兑换任务失败：' + err.message);
	}
}

function handleWalletRedeemUpdate(payload) {
	if (!payload) {
		return;
	}
	// 已知 jobId 时过滤掉非本任务的事件(任务启动初期 jobId 为空,早到事件照常接收)。
	if (state.wallet.jobId && payload.jobId && payload.jobId !== state.wallet.jobId) {
		return;
	}

	if (payload.status === 'done') {
		state.wallet.running = false;
		setWalletControlsRunning(false);
		$('wallet-progress').textContent = `完成 ${countWalletFinished()} / ${state.wallet.results.length}`;
		addLine('success', '充值码兑换任务结束');
		renderWalletResults();
		return;
	}

	// 服务端回推的是「本次提交 pairs 数组」的下标,经 jobIndexMap 映射回界面结果行。
	const jobIndex = payload.index;
	if (typeof jobIndex !== 'number') {
		return;
	}
	const resultIndex = state.wallet.jobIndexMap[jobIndex];
	if (typeof resultIndex !== 'number' || !state.wallet.results[resultIndex]) {
		return;
	}
	const row = state.wallet.results[resultIndex];

	if (payload.logMessage) {
		// 把每个账号的过程日志同步到右侧实时日志面板(debug 噪声不入面板)
		if (payload.logLevel !== 'debug') {
			addLine(payload.logLevel || 'info', `[兑换·${payload.account || row.account}] ${payload.logMessage}`);
		}
		if (payload.status === 'processing' && row.status !== 'success' && row.status !== 'error') {
			row.status = 'processing';
			row.message = payload.logMessage;
		}
	} else if (payload.status) {
		row.status = payload.status;
		if (payload.message) {
			row.message = payload.message;
		}
		if (payload.balance) {
			row.balance = payload.balance;
		}
		if (payload.status === 'success' || payload.status === 'error') {
			const level = payload.status === 'success' ? 'success' : 'error';
			addLine(level, `[兑换·${payload.account || row.account}] ${payload.message || walletStatusLabel(payload.status)}`);
		}
	}

	$('wallet-progress').textContent = `${countWalletFinished()} / ${state.wallet.results.length}`;
	renderWalletResults();
}

function clearWallet() {
	if (state.wallet.running) {
		addLine('warn', '任务进行中，无法清空');
		return;
	}
	$('wallet-accounts').value = '';
	$('wallet-codes').value = '';
	state.wallet.results = [];
	state.wallet.jobIndexMap = [];
	state.wallet.jobId = '';
	$('wallet-progress').textContent = '未开始';
	renderWallet();
}

async function importWalletMafiles(event) {
	const files = Array.from(event.target.files || []);
	event.target.value = '';
	if (!files.length) {
		return;
	}

	const toPersist = [];
	const accountLines = [];
	for (const file of files) {
		try {
			const data = JSON.parse(await file.text());
			const accountName = String(data.account_name || data.accountName || file.name.replace(/\.(maFile|json)$/i, '')).trim();
			if (!accountName) {
				addLine('warn', `${file.name}: 缺少 account_name`);
				continue;
			}
			if (!data.account_name && !data.accountName) {
				data.account_name = accountName;
			}
			if (!data.shared_secret && !data.sharedSecret) {
				addLine('warn', `${accountName}: maFile 中没有 shared_secret，登录时可能需要手动验证码`);
			}
			toPersist.push(data);
			const password = data.password ? String(data.password) : '';
			accountLines.push(accountName + '----' + password);
		} catch (err) {
			addLine('error', `${file.name}: 读取 maFile 失败: ${err.message}`);
		}
	}

	// 完整 maFile(含 shared_secret/identity_secret)交服务端持久化,供登录自动 2FA。
	if (toPersist.length) {
		try {
			const resp = await postJson('/api/mafile/import', {mafiles: toPersist});
			addLine('info', `maFile 已存到服务器: ${resp.saved} 个`);
		} catch (err) {
			addLine('warn', `maFile 服务端保存失败(自动登录可能受影响): ${err.message}`);
		}
	}

	// 把导入的账号补进左侧账户框(按账号去重,保留已填写的密码行)
	mergeWalletAccountLines(accountLines);
	updateWalletCounts();
	addLine('success', `导入 maFile 完成: ${toPersist.length} 个`);
}

// 合并新账号行到左侧文本框:已存在的账号(行首 account 部分)不重复添加。
function mergeWalletAccountLines(newLines) {
	const textarea = $('wallet-accounts');
	const existing = String(textarea.value || '').split(/\r?\n/);
	const seen = new Set();
	for (const line of existing) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const idx = trimmed.indexOf('----');
		seen.add((idx === -1 ? trimmed : trimmed.slice(0, idx)).trim().toLowerCase());
	}

	const merged = existing.filter(line => line.trim().length > 0);
	for (const line of newLines) {
		const idx = line.indexOf('----');
		const account = (idx === -1 ? line : line.slice(0, idx)).trim().toLowerCase();
		if (account && !seen.has(account)) {
			seen.add(account);
			merged.push(line);
		}
	}
	textarea.value = merged.join('\n');
}

async function postJson(url, payload, method = 'POST') {
	const response = await fetch(url, {
		method,
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(payload)
	});
	if (response.status === 401) {
		redirectToLogin();
		throw new Error('未登录');
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok || data.success === false) {
		throw new Error(data.error || ('HTTP ' + response.status));
	}
	return data;
}

async function getJson(url) {
	const response = await fetch(url);
	if (response.status === 401) {
		redirectToLogin();
		throw new Error('未登录');
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok || data.success === false) {
		throw new Error(data.error || ('HTTP ' + response.status));
	}
	return data;
}

function loadAccounts() {
	try {
		const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
		return Array.isArray(data) ? data.map(normalizeStoredAccount).filter(account => account.accountName) : [];
	} catch {
		return [];
	}
}

function normalizeStoredAccount(account) {
	account = account || {};
	const normalized = normalizeAccountRecord(account);
	return {
		id: account.id || cryptoId(),
		accountName: normalized.accountName,
		password: normalized.password,
		sharedSecret: normalized.sharedSecret,
		twoFactorCode: normalized.twoFactorCode,
		remember: normalized.remember,
		status: '未登录',
		hasMaFile: !!account.hasMaFile || !!normalized.hasMaFile,
		steamID: account.steamID || '',
		country: account.country || '',
		balance: account.balance == null ? null : Number(account.balance),
		currency: account.currency == null ? null : Number(account.currency),
		hasWallet: !!account.hasWallet,
		hasRefreshToken: false,
		gcConnected: false,
		cs2GcConnected: !!account.cs2GcConnected,
		tf2GcConnected: !!account.tf2GcConnected,
		activeGame: normalizePurchaseGame(account.activeGame || 'cs2'),
		inventoryCount: 0,
		inventorySource: '',
		attemptId: '',
		source: account.source || normalized.source,
		lastError: ''
	};
}

function saveAccounts() {
	saveAccountsLocal();
	schedulePushAccounts();
}

// 本地缓存:刷新后可立即出图,服务端不可达时也不丢操作。
function saveAccountsLocal() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state.accounts));
	} catch {}
}

// 只把"耐久"字段推到服务端,运行态(status/gcConnected...)不上传。
function serializeAccountForServer(account) {
	account = account || {};
	return {
		id: account.id || '',
		accountName: account.accountName || '',
		password: account.password || '',
		sharedSecret: account.sharedSecret || '',
		twoFactorCode: account.twoFactorCode || '',
		remember: account.remember !== false,
		hasMaFile: !!account.hasMaFile,
		steamID: account.steamID || '',
		country: account.country || '',
		balance: account.balance == null ? null : Number(account.balance),
		currency: account.currency == null ? null : Number(account.currency),
		hasWallet: !!account.hasWallet,
		activeGame: account.activeGame || 'cs2',
		source: account.source || ''
	};
}

async function pushAccountsToServer() {
	try {
		await postJson('/api/accounts/list', {accounts: state.accounts.map(serializeAccountForServer)});
	} catch {
		// 同步失败不阻塞本地操作;本地 localStorage 仍是缓存,下次操作会再次尝试推送。
	}
}

// 初始同步完成前不推送,避免用同步前的旧本地名单覆盖服务端。
let accountsSyncReady = false;

// 防抖推送:批量导入/登录时会频繁调用 saveAccounts(),合并成一次网络写入。
let pushAccountsTimer = null;
function schedulePushAccounts() {
	if (!accountsSyncReady) {
		return;
	}
	if (pushAccountsTimer) {
		clearTimeout(pushAccountsTimer);
	}
	pushAccountsTimer = setTimeout(() => {
		pushAccountsTimer = null;
		pushAccountsToServer();
	}, 500);
}

// 启动时以服务端名单为准,实现多浏览器同步。
async function syncAccountsFromServer() {
	let data;
	try {
		data = await getJson('/api/accounts/list');
	} catch {
		return;   // 离线/错误:沿用本地 localStorage 缓存
	}
	const serverAccounts = Array.isArray(data.accounts)
		? data.accounts.map(normalizeStoredAccount).filter(account => account.accountName)
		: [];

	// 服务端从未写过名单(首次升级)且本地有数据 -> 把本地名单迁移上去,保留本地账户。
	if (!data.initialized && serverAccounts.length === 0 && state.accounts.length > 0) {
		await pushAccountsToServer();
		return;
	}

	// 否则一律以服务端为准(含服务端为空 = 已被其他浏览器清空的情况)。
	state.accounts = serverAccounts;
	saveAccountsLocal();
	renderAccounts();
}

// 运行日志持久化：刷新网页后恢复，避免日志全部丢失
function loadLogLines() {
	try {
		const data = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
		return Array.isArray(data) ? data.slice(-600).map(String) : [];
	} catch {
		return [];
	}
}

function saveLogLines() {
	try {
		localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(state.logLines));
	} catch {
		// 存储不可用（隐私模式/超额）时忽略，不影响日志显示
	}
}

function cryptoId() {
	if (window.crypto && window.crypto.randomUUID) {
		return window.crypto.randomUUID();
	}
	return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function escapeHtml(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(value) {
	return escapeHtml(value);
}
