'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// 代码目录(app/,随远程更新整包替换)与安装根目录(install root,存放 data/.env/node_modules,不随更新动)。
// launcher 启动时会注入 APP_ROOT=安装根。直接 `node app/server.js` 时回退到上级目录。
const CODE_DIR = __dirname;
const APP_ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.join(__dirname, '..');

// 从安装根加载 .env(Node>=20.6 内置)。不存在则忽略,继续用系统环境变量。
try {
	process.loadEnvFile(path.join(APP_ROOT, '.env'));
} catch (err) {
	// 没有 .env 文件时静默跳过
}

const express = require('express');
const {Server} = require('socket.io');
const GlobalOffensive = require('globaloffensive');
const TeamFortress2 = require('tf2');

// 修复 protobufjs 共享根(roots["default"])冲突:tf2 与 globaloffensive 都往共享根写
// CMsgClientWelcome,但 tf2 的版本没有嵌套的 Location 类型。tf2 在 globaloffensive 之后
// require,会用「无 Location」的版本覆盖共享根,导致连接 CS2 GC 收到欢迎消息(CMsgClientWelcome)
// 解码时 $root.CMsgClientWelcome.Location 为 undefined 而整个进程崩溃(launcher 反复重启)。
// 这里在 tf2 加载「之后」把 globaloffensive 带 Location 的版本重新装回共享根;tf2 自身的欢迎
// 消息无 location 字段、其解码不引用该嵌套类型,故不受影响。
try {
	const pbRoot = require('protobufjs/minimal').roots['default'];
	const goWelcome = require('globaloffensive/protobufs/generated/_load').CMsgClientWelcome;
	if (pbRoot && goWelcome && goWelcome.Location
		&& (!pbRoot.CMsgClientWelcome || !pbRoot.CMsgClientWelcome.Location)) {
		pbRoot.CMsgClientWelcome = goWelcome;
	}
} catch (err) {
	console.error('[protobuf-fix] 修复 CMsgClientWelcome 共享根冲突失败:', err && err.message ? err.message : err);
}

const SteamTotp = require('steam-totp');
const SteamUser = require('steam-user');
const {describeGcItem, loadItemsGameSchema} = require('./items-game-schema');
const {UuAccount, SUBSTATUS_WAIT_CONFIRM, generateHeaders, generateRandomString, decodeJwt} = require('./lib/uuyoupin');
const {UuPriceEngine} = require('./lib/uu-pricing');
const {acceptVerifiedTradeOffer} = require('./lib/trade-offer');
const {redeemForAccount} = require('./lib/wallet-code');
const {createAuth} = require('./lib/auth');
const {createFingerprintStore} = require('./services/fingerprint');
const {createSteamStorePurchaser} = require('./services/steamStorePurchase');
const {createSteamMarketBuyOrder} = require('./services/steamMarketBuyOrder');
const {createCs2Terminal} = require('./lib/cs2-terminal');
const {writeFileAtomic, writeJsonAtomic, readJsonFileSafe} = require('./lib/atomic-file');
// 凭据数据层(TypeScript,由 Node 24 直接运行):SQLite + 字段加密,见 src/store/。
const {openStore, normalizeStoredAccount, uuTokenId} = require('../src/store/index.ts');
// Steam 登录会话管理(TypeScript):每账号一个会话、登录/重连看门狗、重启自动恢复,见 src/steam/。
const {createSessionManager} = require('../src/steam/session-manager.ts');
// GC 相关(TypeScript):币种表、游戏配置、GC 请求收发、钱包扣款授权、在线会话查询,见 src/steam/。
const {CURRENCY_ISO_TO_COUNTRY, currencyIdToIso, normalizeCountryCode} = require('../src/steam/currencies.ts');
const {
	GAME_CONFIGS: PURCHASE_GAME_CONFIGS,
	normalizeGame: normalizePurchaseGame,
	gameConfig: getPurchaseGameConfig
} = require('../src/steam/games.ts');
const {
	updateDefaultGcState: updateAttemptDefaultGcState,
	ensureGameSession: ensureAttemptGameSession,
	disconnectGameSession: disconnectAttemptGameSession
} = require('../src/steam/gc-client.ts');
const {installMicroTxnHooks} = require('../src/steam/microtxn.ts');
const {findOnlineAttempt} = require('../src/steam/attempts.ts');
// CS2/TF2 游戏内购(TypeScript):商品目录、GC 下单、内购任务,见 src/purchase/。
const {createPurchaseService, normalizeCartData, publicTask: publicPurchaseTask} = require('../src/purchase/index.ts');

const PORT = Number(process.env.PORT || 53110);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = APP_ROOT;
// 运行数据目录。Docker 部署时挂卷到这里(DATA_DIR=/data),本地默认仍是安装根下的 data/。
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const STEAM_USER_DIR = path.join(DATA_DIR, 'steam-user');

// 账户指纹(machineID / machineName / User-Agent),按账号名稳定复用,见 services/fingerprint.js。
const fingerprintStore = createFingerprintStore({
	dataDir: DATA_DIR,
	logger: (level, message) => console.log(`[fingerprint:${level}] ${message}`)
});

// Steam 商店「协议购买整款游戏」(钱包给自己买),见 services/steamStorePurchase.js。
const steamStorePurchaser = createSteamStorePurchaser({
	logger: (level, message) => console.log(`[steam-purchase:${level}] ${message}`)
});

// Steam 社区市场「求购单」(挂求购/撤求购/行情参考),见 services/steamMarketBuyOrder.js。
const steamMarketBuyOrder = createSteamMarketBuyOrder({
	logger: (level, message) => console.log(`[market-buyorder:${level}] ${message}`)
});

// CS2「创世终端机」开启(P0/P1/P2:抓包 + 拉报价 + 解封,不含花钱兑换),见 lib/cs2-terminal.js。
const cs2Terminal = createCs2Terminal({
	logger: {
		info: (m) => console.log(`[terminal:info] ${m}`),
		warn: (m) => console.log(`[terminal:warn] ${m}`)
	}
});

// 登录重试:连接卡住(超时未拿到 WebSession)时自动重试,避免永久卡在"登录中"。
const LOGIN_TIMEOUT_MS = Math.max(10000, Number(process.env.LOGIN_TIMEOUT_MS || 45000));
const LOGIN_RETRY_MAX = Math.max(0, Number(process.env.LOGIN_RETRY_MAX || 2));
// 掉线重连看门狗(steam-user autoRelogin 的兜底):扫描间隔 / 先给 autoRelogin 的宽限期 / 最多重连次数。
const RECONNECT_WATCHDOG_INTERVAL_MS = Math.max(15000, Number(process.env.RECONNECT_WATCHDOG_INTERVAL_MS || 30000));
const RECONNECT_GRACE_MS = Math.max(30000, Number(process.env.RECONNECT_GRACE_MS || 90000));
const RECONNECT_MAX_ATTEMPTS = Math.max(1, Number(process.env.RECONNECT_MAX_ATTEMPTS || 6));
// 服务重启后自动恢复登录:SESSION_RESTORE=0 关闭;账号之间间隔(防 Steam 限频)。
const SESSION_RESTORE_ENABLED = String(process.env.SESSION_RESTORE || '1') !== '0';
const SESSION_RESTORE_INTERVAL_MS = Math.max(1000, Number(process.env.SESSION_RESTORE_INTERVAL_MS || 3000));

// launcher 在检测到新版本时写这个文件;前端据此提示"重启生效"。
const UPDATE_STATUS_FILE = path.join(DATA_DIR, 'update-status.json');
// 市场求购单本地账本(只记由本工具挂出的求购,供「我的求购单」列表/撤销用)。
const MARKET_BUYORDERS_FILE = path.join(DATA_DIR, 'market-buyorders.json');
// item_nameid 缓存({appid|market_hash_name: nameid})。Steam 改版后商品页抓不到 nameid,
// 一旦由用户手填/任何途径拿到一次就缓存复用,供「行情参考」抓盘口(最高求购/最低在售)。
const MARKET_NAMEIDS_FILE = path.join(DATA_DIR, 'market-nameids.json');
// 子进程以此退出码退出时,launcher 会"应用暂存更新并重启"(见 launcher.js)。
const RESTART_EXIT_CODE = 75;
// 静态参考资料(CS2/TF2 物品 schema + 本地化文案)。放在 app/schema/ 内,
// 随 app.zip 一起打包发布(见 tools/build-release.js),这样 schema 更新能跟着
// 自动更新一起下发,不必再单独往客户端 data/ 里塞文件。可用 SCHEMA_DIR 覆盖。
const SCHEMA_DIR = process.env.SCHEMA_DIR ? path.resolve(process.env.SCHEMA_DIR) : path.join(__dirname, 'schema');
const SHARED_CONFIG_DIR = process.env.CONFIG_DIR ? path.resolve(process.env.CONFIG_DIR) : path.join(DATA_DIR, 'config');
const CONFIG_MAFILE_DIR = path.join(SHARED_CONFIG_DIR, 'mafile');
const CONFIG_COOKIES_DIR = path.join(SHARED_CONFIG_DIR, 'cookies');
const ACCOUNT_CACHE_FILE = path.join(SHARED_CONFIG_DIR, 'account_cache.json');
// 账户名单(账号名/密码/sharedSecret 等)服务端持久化,实现多浏览器/多设备同步。
// 之前名单只存在浏览器 localStorage,换浏览器访问就看不到。
const ACCOUNT_LIST_FILE = path.join(SHARED_CONFIG_DIR, 'accounts.json');
const ITEMS_GAME_FILE = process.env.CS2_ITEMS_GAME_FILE ? path.resolve(process.env.CS2_ITEMS_GAME_FILE) : path.join(SCHEMA_DIR, 'items_game.txt');
const CSGO_SCHINESE_FILE = path.join(SCHEMA_DIR, 'csgo_schinese.txt');
const CSGO_ENGLISH_FILE = path.join(SCHEMA_DIR, 'csgo_english.txt');
const TF2_ITEMS_GAME_FILE = process.env.TF2_ITEMS_GAME_FILE ? path.resolve(process.env.TF2_ITEMS_GAME_FILE) : path.join(SCHEMA_DIR, 'tf2_items_game.txt');
const TF2_SCHINESE_FILE = path.join(SCHEMA_DIR, 'tf2_schinese.txt');
const TF2_ENGLISH_FILE = path.join(SCHEMA_DIR, 'tf2_english.txt');
const INVENTORY_CACHE_TTL_MS = 15 * 1000;
// 社区库存拉取失败后的冷却:冷却期内允许直接用 GC 兜底缓存,避免每次开库存都反复重试社区接口。
const COMMUNITY_INV_RETRY_COOLDOWN_MS = 30 * 1000;
const CS2_APP_ID = 730;
const TF2_APP_ID = 440;
const INVENTORY_APP_ID = CS2_APP_ID;
const INVENTORY_CONTEXT_ID = 2;
const INVENTORY_PAGE_SIZE = 2000;
const LOCAL_CM_FALLBACKS = [
	{
		endpoint: 'cm0.steampowered.com:443',
		type: 'websockets',
		realm: 'steamglobal',
		load: 0,
		wtd_load: 0
	}
];

fs.mkdirSync(STEAM_USER_DIR, {recursive: true});
fs.mkdirSync(CONFIG_COOKIES_DIR, {recursive: true});

const ITEMS_GAME_SCHEMA = loadItemsGameSchema(ITEMS_GAME_FILE, {
	localizationFile: CSGO_SCHINESE_FILE,
	englishLocalizationFile: CSGO_ENGLISH_FILE
});
if (ITEMS_GAME_SCHEMA.error) {
	console.warn('[items_game] failed to load schema:', ITEMS_GAME_SCHEMA.error);
}
const TF2_ITEMS_GAME_SCHEMA = loadItemsGameSchema(TF2_ITEMS_GAME_FILE, {
	localizationFile: fs.existsSync(TF2_SCHINESE_FILE) ? TF2_SCHINESE_FILE : TF2_ENGLISH_FILE,
	englishLocalizationFile: TF2_ENGLISH_FILE
});
if (TF2_ITEMS_GAME_SCHEMA.error) {
	console.warn('[tf2 items_game] failed to load schema:', TF2_ITEMS_GAME_SCHEMA.error);
}

// ===== 部署相关:反代信任 / cookie Secure / 同源校验 =====
// TRUST_PROXY:未设置=loopback(只信任本机反代)。Docker 里反代经 bridge 网络进来,设 loopback,uniquelocal。
// 也可填 true / 跳数 / 网段,语义同 Express 的 'trust proxy'。
function parseTrustProxy(value) {
	const v = String(value == null ? '' : value).trim();
	if (!v) return 'loopback';
	if (v === 'true') return true;
	if (v === 'false') return false;
	if (/^\d+$/.test(v)) return Number(v);
	return v;
}

// COOKIE_SECURE:1=总是加 Secure;0=从不加;auto(默认)=经 HTTPS(含反代转发)访问时才加。
function parseCookieSecure(value) {
	const v = String(value == null ? '' : value).trim().toLowerCase();
	if (v === '1' || v === 'true') return true;
	if (v === '0' || v === 'false') return false;
	return 'auto';
}

// 额外允许的来源(逗号分隔的完整 origin,如 https://tools.example.com)。默认只允许与请求 Host 同域。
const ALLOWED_ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || '')
	.split(',').map(item => item.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean));

function headerHostname(value) {
	const first = String(value || '').split(',')[0].trim();
	if (!first) return '';
	try {
		return new URL('http://' + first).hostname.toLowerCase();
	} catch (_) {
		return '';
	}
}

// 写操作和 WebSocket 握手的 CSRF 兜底:浏览器带了 Origin 时,其主机名必须等于本次请求的 Host
// (或反代转发的 X-Forwarded-Host)。没有 Origin(curl 等非浏览器)放行;跨站页面伪造不了这些请求头。
function isAllowedOrigin(headers) {
	const origin = String((headers && headers.origin) || '').trim();
	if (!origin) return true;
	if (ALLOWED_ORIGINS.has(origin.replace(/\/+$/, '').toLowerCase())) return true;
	let originHost;
	try {
		originHost = new URL(origin).hostname.toLowerCase();
	} catch (_) {
		return false; // 含 Origin: null(沙箱 iframe / file://)
	}
	const hosts = [headerHostname(headers.host), headerHostname(headers['x-forwarded-host'])].filter(Boolean);
	return hosts.includes(originHost);
}

// 调试端点(会返回 Steam cookies / 可触发真实下单),默认关闭,ENABLE_DEBUG_ENDPOINTS=1 才开。
const DEBUG_ENDPOINTS_ENABLED = String(process.env.ENABLE_DEBUG_ENDPOINTS || '') === '1';
function debugOnly(req, res, next) {
	if (DEBUG_ENDPOINTS_ENABLED) return next();
	res.status(404).json({success: false, error: 'not found'});
}

const app = express();
// 反代后面要信任 X-Forwarded-*,才能拿到真实客户端 IP(登录限速)和是否 HTTPS(Secure cookie)。
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
const server = http.createServer((req, res) => {
		if (String(req.url || '').startsWith('/socket.io/')) { return; }
		app(req, res);
	});
const io = new Server(server, {
	allowRequest: (req, callback) => callback(null, isAllowedOrigin(req.headers))
});
const AUTH_FILE = path.join(SHARED_CONFIG_DIR, 'auth.json');
const auth = createAuth({
	envPassword: process.env.APP_PASSWORD || '',
	authFile: AUTH_FILE,
	ttlMs: Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000),
	cookieSecure: parseCookieSecure(process.env.COOKIE_SECURE),
	setupToken: process.env.SETUP_TOKEN || ''
});
io.use(auth.socketAuth);

// 「买游戏」(协议购买整款 Steam 游戏)任务,见 services/steamStorePurchase.js。
const buyGameTasks = [];
const buyGameTaskIndex = new Map();
const BUYGAME_TASK_LIMIT = 50;
const BUYGAME_DEFAULT_CONCURRENCY = 3;   // 买游戏默认并发线程数
const BUYGAME_MAX_CONCURRENCY = 10;      // 并发上限,防止过多并发被 Steam 限频
const PURCHASE_PRICE_SHEET_DIR = path.join(DATA_DIR, 'price-sheets');
const PURCHASE_CATALOG_CACHE_DIR = path.join(DATA_DIR, 'purchase-catalogs');

fs.mkdirSync(PURCHASE_PRICE_SHEET_DIR, {recursive: true});
fs.mkdirSync(PURCHASE_CATALOG_CACHE_DIR, {recursive: true});

// ===== UU(悠悠有品)发货模块状态 =====
const UU_DIR = path.join(DATA_DIR, 'uu');
const UU_CONFIG_FILE = path.join(UU_DIR, 'delivery-config.json');
const UU_TOKENS_FILE = path.join(UU_DIR, 'tokens.json');
const UU_POLL_MIN_MS = 30 * 1000;          // 轮询最短间隔：30 秒
const UU_POLL_MAX_MS = 120 * 60 * 1000;    // 轮询最长间隔：120 分钟
const UU_POLL_DEFAULT_MS = 5 * 60 * 1000;  // 默认轮询间隔：5 分钟
const UU_ORDER_COOLDOWN_MS = 5 * 60 * 1000; // 订单走完发货流程后冷却 5 分钟再重新检测，规避 UU 服务端状态延迟导致的误判失败
// 防止访问频繁（对齐 Steamauto 的限速）：
//   UU_DELIVER_GAP_MS        —— 同一轮内逐笔处理订单之间的间隔（Steamauto 每接受一笔等 5s）
//   UU_CONFIRM_ACCEPT_GAP_MS —— 单笔内 UU confirmOffer 与 Steam 接受报价之间的间隔，给 UU 服务端留处理时间
const UU_DELIVER_GAP_MS = 5 * 1000;
const UU_CONFIRM_ACCEPT_GAP_MS = 1.5 * 1000;
// CS2 自动上架：上架轮询间隔 + 每次市场查价限频（对齐 Steamauto operate_sleep，UU 查价限流较严）
const UU_LIST_INTERVAL_MS = 30 * 60 * 1000; // 自动上架轮询：30 分钟
const UU_LIST_QUERY_GAP = {min: 4000, max: 9000}; // 缓存未命中时每次市场查价之间的等待区间(ms)
// 外部 CS2 检视(磨损)解析服务（自建，见 inspect-service/）。UU 未返回磨损时用它兜底；未配置则跳过该物品。
const INSPECT_SERVICE_URL = (process.env.INSPECT_SERVICE_URL || '').replace(/\/+$/, '');
const INSPECT_SERVICE_KEY = process.env.INSPECT_KEY || '';

// 用外部解析服务把检视链接解析成磨损(float)；失败返回 null。
async function resolveAbradeViaInspect(actionLink) {
	if (!INSPECT_SERVICE_URL || !actionLink) return null;
	try {
		const u = new URL(INSPECT_SERVICE_URL + '/inspect');
		u.searchParams.set('url', actionLink);
		const headers = {};
		if (INSPECT_SERVICE_KEY) headers['x-inspect-key'] = INSPECT_SERVICE_KEY; // 走 header，避免密钥进访问日志
		const resp = await fetch(u, {headers, signal: AbortSignal.timeout(15000)});
		const json = await resp.json();
		if (json && json.success && json.iteminfo && json.iteminfo.floatvalue != null) {
			const f = parseFloat(json.iteminfo.floatvalue);
			return Number.isFinite(f) ? f : null;
		}
	} catch (err) {
		// 解析服务不可用不致命，按"无磨损"处理
	}
	return null;
}
let UU_POLL_INTERVAL_MS = Math.min(UU_POLL_MAX_MS, Math.max(UU_POLL_MIN_MS, Number(process.env.UU_POLL_INTERVAL_MS) || UU_POLL_DEFAULT_MS));

function clampUuPollMs(ms) {
	const n = Number(ms);
	if (!Number.isFinite(n) || n <= 0) {
		return UU_POLL_DEFAULT_MS;
	}
	return Math.min(UU_POLL_MAX_MS, Math.max(UU_POLL_MIN_MS, Math.round(n)));
}
const UU_WAIT_CONFIRM_SUBSTATUS = SUBSTATUS_WAIT_CONFIRM; // 1103 = 待您确认报价
// 支持并行发货的游戏（每个游戏独立开关/轮询/统计；token 通用，host 按游戏自动选）
const DELIVER_GAME_IDS = [String(CS2_APP_ID), String(TF2_APP_ID)];
const UU_LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;
const uuDelivery = new Map(); // accountName -> 发货状态
const uuLoginSessions = new Map(); // loginSessionId -> 短信登录会话
fs.mkdirSync(UU_DIR, {recursive: true});

// 加密数据库:账户名单、maFile、Steam session、UU token/发货配置都存在这里(敏感字段 AES-256-GCM)。
// 首次启动时把旧版明文 JSON 导入,原文件挪到 data/_migrated_plaintext/ 下等你确认后删除。
// 主密钥:MASTER_KEY 环境变量 > MASTER_KEY_FILE > <安装根>/secrets/master.key(开发环境缺失时自动生成)。
let store;
try {
	store = openStore({
		dataDir: DATA_DIR,
		defaultKeyFile: path.join(APP_ROOT, 'secrets', 'master.key'),
		env: process.env,
		legacy: {
			accountsFile: ACCOUNT_LIST_FILE,
			mafileDir: CONFIG_MAFILE_DIR,
			sessionDir: SESSION_DIR,
			uuTokensFile: UU_TOKENS_FILE,
			uuConfigFile: UU_CONFIG_FILE,
			uuLastTokenFile: path.join(UU_DIR, 'last-token.txt')
		}
	});
} catch (err) {
	console.error('[store] 打开数据库失败:', err && err.message ? err.message : err);
	process.exit(1);
}

// Steam 登录会话。attempts 是会话表(id -> attempt),内购/库存/UU 等代码直接读它。
const sessions = createSessionManager({
	createClient(fingerprint) {
		const clientOptions = {
			dataDirectory: STEAM_USER_DIR,
			// 长连接因空闲/CM 轮换/网络抖动断开后,让 steam-user 用已存的 refreshToken 自动重连重登
			// (会重新触发 loggedOn→webSession,状态与 cookie 自动恢复)。会话管理里的重连看门狗再做兜底。
			autoRelogin: true,
			renewRefreshTokens: true,
			webCompatibilityMode: true,
			protocol: SteamUser.EConnectionProtocol.WebSocket
		};
		// 覆盖 machineID 格式(去掉库默认特征、每账号稳定随机);UA 注入 steam-user 的 web 请求。
		if (Array.isArray(fingerprint.machineIdFormat) && fingerprint.machineIdFormat.length === 3) {
			clientOptions.machineIdFormat = fingerprint.machineIdFormat;
		}
		if (fingerprint.userAgent) {
			clientOptions.additionalHeaders = {'User-Agent': fingerprint.userAgent};
		}
		return new SteamUser(clientOptions);
	},
	getFingerprint: accountName => fingerprintStore.getAccountFingerprint(accountName),
	generateAuthCode: sharedSecret => SteamTotp.generateAuthCode(sharedSecret),
	// 被顶号/会话被替换/封禁/密码错:不自动重连(避免与你在别处的登录抢号/无效硬冲)
	fatalEResults: new Set(['LoggedInElsewhere', 'LogonSessionReplaced', 'AccountDisabled', 'Banned', 'InvalidPassword']
		.map(name => (SteamUser.EResult || {})[name])
		.filter(value => typeof value === 'number')),
	cmFallbackServers: LOCAL_CM_FALLBACKS,
	sessions: store.sessions,
	intents: store.loginIntents,
	onChange: attempt => io.emit('attempt:update', sessions.publicAttempt(attempt)),
	onClientCreated: attachGameCoordinators,
	onWebSession: attempt => refreshAttemptStoreCountry(attempt),   // 后台查真实账户国家(USD 等无法从货币推断)
	currencyIdToIso,
	resolveWalletCountry: attempt => resolveAccountCountry({
		country: attempt.country,
		currency: attempt.currency,
		currencyISO: attempt.currencyISO
	}),
	timing: {
		loginTimeoutMs: LOGIN_TIMEOUT_MS,
		loginRetryMax: LOGIN_RETRY_MAX,
		reconnectIntervalMs: RECONNECT_WATCHDOG_INTERVAL_MS,
		reconnectGraceMs: RECONNECT_GRACE_MS,
		reconnectMaxAttempts: RECONNECT_MAX_ATTEMPTS,
		restoreIntervalMs: SESSION_RESTORE_INTERVAL_MS
	}
});
const attempts = sessions.attempts;

// GC 内购下单时要响应 Steam 的钱包扣款授权请求(steam-user 本身不处理这条消息)
installMicroTxnHooks(SteamUser);

// 游戏内购:商品目录(内存 + data/purchase-catalogs 缓存)和下单任务
const purchase = createPurchaseService({
	attempts,
	events: sessions,
	emitTask: (event, task) => io.emit(event, task),
	schemas: {cs2: ITEMS_GAME_SCHEMA, tf2: TF2_ITEMS_GAME_SCHEMA},
	describeGcItem,
	cacheDir: PURCHASE_CATALOG_CACHE_DIR,
	priceSheetDir: PURCHASE_PRICE_SHEET_DIR,
	readJson: readJsonFile,
	writeJson: writeJsonAtomic
});

app.disable('x-powered-by');
app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Referrer-Policy', 'same-origin');
	next();
});
// 非幂等请求一律做同源校验(含 /api/auth/*,防登录 CSRF)
app.use((req, res, next) => {
	if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
	if (isAllowedOrigin(req.headers)) return next();
	res.status(403).json({success: false, error: '来源校验失败,跨站请求已拒绝'});
});
app.use(express.json({limit: '1mb'}));

// 容器/反代健康检查:无需登录,不暴露任何运行状态
app.get('/healthz', (req, res) => {
	res.json({ok: true});
});

// ===== 鉴权(公开端点,先于网关注册) =====
app.get('/login', (req, res) => {
	// 用 root 传目录:否则 send 会检查整条绝对路径,安装目录里有点开头的目录(如 ~/.local)时直接 404
	res.sendFile('login.html', {root: path.join(CODE_DIR, 'public')});
});
app.post('/api/auth/login', (req, res) => auth.login(req, res));
app.post('/api/auth/logout', (req, res) => auth.logout(req, res));
app.get('/api/auth/status', (req, res) => auth.status(req, res));
app.post('/api/auth/setup', (req, res) => auth.setup(req, res));
app.post('/api/auth/password', (req, res) => auth.changePassword(req, res));

// 网关:其余所有请求(含静态资源、API、socket.io)未登录一律拦截
app.use(auth.middleware);

app.use(express.static(path.join(CODE_DIR, 'public'), {
	etag: false,
	lastModified: false,
	maxAge: 0,
	setHeaders(res, filePath) {
		if (/\.(?:html|js|css)$/iu.test(String(filePath || ''))) {
			res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
			res.setHeader('Pragma', 'no-cache');
			res.setHeader('Expires', '0');
			res.setHeader('Surrogate-Control', 'no-store');
		}
	}
}));

app.get('/api/health', (req, res) => {
	res.json({
		success: true,
		uptime: process.uptime(),
		attempts: attempts.size
	});
});

app.get('/api/attempts', (req, res) => {
	const items = sessions.list().map(publicAttempt);
	res.json({success: true, attempts: items});
});

function readUpdateStatus() {
	try {
		return JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8'));
	} catch (_) {
		// 无文件 = 未检测到更新,按"无待更新"处理
		return {pending: false};
	}
}

// 远程更新:前端查询是否有已暂存待生效的新版本。
app.get('/api/update/status', (req, res) => {
	res.json({success: true, status: readUpdateStatus()});
});

// 远程更新:手动触发一次检查。真实的联网拉取/验签/下载/暂存由 launcher 负责,
// 这里经 IPC 把请求转给 launcher,等它完成后回读 update-status.json 返回。
// 未经 launcher 启动(如 start-app-only)时无 IPC,退回返回本地已知状态。
let pendingUpdateCheck = null;
process.on('message', (msg) => {
	if (msg && msg.type === 'check-update-done' && pendingUpdateCheck) {
		const resolve = pendingUpdateCheck;
		pendingUpdateCheck = null;
		resolve(msg.status || readUpdateStatus());
	}
});

app.post('/api/update/check', (req, res) => {
	if (typeof process.send !== 'function') {
		return res.json({
			success: true, checked: false, status: readUpdateStatus(),
			message: '当前未通过启动器运行,无法联网检查更新'
		});
	}
	if (pendingUpdateCheck) {
		return res.status(409).json({success: false, error: '已有检查在进行中,请稍候'});
	}
	const timer = setTimeout(() => {
		if (pendingUpdateCheck) {
			pendingUpdateCheck = null;
			res.json({
				success: true, checked: false, status: readUpdateStatus(),
				message: '正在后台检查/下载,稍后将自动提示'
			});
		}
	}, 25000);
	pendingUpdateCheck = (status) => {
		clearTimeout(timer);
		res.json({success: true, checked: true, status: status || readUpdateStatus()});
	};
	try {
		process.send({type: 'check-update'});
	} catch (err) {
		clearTimeout(timer);
		pendingUpdateCheck = null;
		res.status(500).json({success: false, error: err.message || '无法联系启动器'});
	}
});

// 远程更新:一键重启以应用暂存的新版本。
// 用特殊退出码退出,launcher 收到后会切换 app.next→app 再拉起新版。
app.post('/api/update/restart', (req, res) => {
	res.json({success: true, message: '正在重启以应用更新...'});
	// 稍延迟,确保响应已发出再退出
	setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
});

// 账户名单:多浏览器/多设备共享(存 data/config/accounts.json)。
// initialized 表示服务端是否已写过名单文件——前端据此决定首次升级时是否把本地名单迁移上来,
// 避免"已删除账号"被某个仍有旧 localStorage 的浏览器重新推回。
app.get('/api/accounts/list', (req, res) => {
	try {
		res.json({success: true, initialized: store.accounts.isInitialized(), accounts: readAccountList().map(publicStoredAccount)});
	} catch (err) {
		res.status(500).json({success: false, error: err && err.message ? err.message : '读取账户名单失败'});
	}
});

// 全量替换账户名单(前端 saveAccounts 推送的就是完整 state.accounts)。
app.post('/api/accounts/list', (req, res) => {
	const body = req.body || {};
	const list = Array.isArray(body.accounts) ? body.accounts : [];
	try {
		const saved = writeAccountList(mergeClientAccountSecrets(list));
		res.json({success: true, accounts: saved.map(publicStoredAccount)});
	} catch (err) {
		res.status(500).json({success: false, error: err && err.message ? err.message : '保存账户名单失败'});
	}
});

app.post('/api/accounts/meta', async (req, res) => {
	const names = Array.isArray(req.body && req.body.accountNames) ? req.body.accountNames : [];
	const accounts = {};
	for (const rawName of names) {
		const accountName = String(rawName || '').trim();
		if (!accountName) {
			continue;
		}
		accounts[accountName] = publicAccountProfile(readLocalAccountProfile(accountName));
	}

	// 缓存/货币推断不出国家的(如 USD 钱包),用持久化 cookie 查商店账户页补全真实国家
	try {
		await resolveMissingAccountCountries(accounts);
	} catch {}

	res.json({success: true, accounts});
});

// 服务端持久化 maFile：完整 maFile（含 identity_secret）加密存入数据库，
// 发货/求购确认时从这里取 identity_secret 做手机确认。
app.post('/api/mafile/import', (req, res) => {
	const body = req.body || {};
	const list = Array.isArray(body.mafiles) ? body.mafiles : (body.mafile ? [body.mafile] : []);
	if (!list.length) {
		return res.status(400).json({success: false, error: '没有可导入的 maFile'});
	}
	const results = [];
	let saved = 0;
	for (const entry of list) {
		const ma = entry && typeof entry === 'object' ? entry : null;
		const accountName = ma ? String(ma.account_name || ma.accountName || '').trim() : '';
		if (!ma || !accountName) {
			results.push({accountName: accountName || '', ok: false, error: '缺少 account_name'});
			continue;
		}
		if (!/^[A-Za-z0-9_.-]+$/u.test(accountName)) {
			results.push({accountName, ok: false, error: '账号名包含非法字符,无法保存'});
			continue;
		}
		const sharedSecret = String(ma.shared_secret || ma.sharedSecret || '').trim();
		const identitySecret = String(ma.identity_secret || ma.identitySecret || '').trim();
		try {
			store.mafiles.put(accountName, ma);
			saved++;
			results.push({
				accountName,
				ok: true,
				hasSharedSecret: !!sharedSecret,
				hasIdentitySecret: !!identitySecret,
				profile: publicAccountProfile(readLocalAccountProfile(accountName))
			});
		} catch (err) {
			results.push({accountName, ok: false, error: err && err.message ? err.message : '写入失败'});
		}
	}
	res.json({success: true, saved, results});
});

app.post('/api/auth-code', (req, res) => {
	const body = req.body || {};
	const accountName = String(body.accountName || '').trim();
	const localProfile = readLocalAccountProfile(accountName);
	const storedAccount = findStoredAccount(accountName);
	const sharedSecret = String(body.sharedSecret || localProfile.sharedSecret || (storedAccount && storedAccount.sharedSecret) || '').trim();

	if (!sharedSecret) {
		return res.status(409).json({success: false, error: '当前账号没有可用的 shared_secret'});
	}

	try {
		const code = SteamTotp.generateAuthCode(sharedSecret);
		const now = SteamTotp.time();
		const expiresIn = 30 - (now % 30) || 30;
		res.json({
			success: true,
			accountName,
			code,
			expiresIn,
			expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
		});
	} catch (err) {
		res.status(500).json({success: false, error: err && err.message ? err.message : '生成验证码失败'});
	}
});

app.post('/api/login', (req, res) => {
	const body = req.body || {};
	const accountName = String(body.accountName || '').trim();
	// 浏览器不再持有密码/shared_secret:没传就用服务端名单里存的。
	const storedAccount = findStoredAccount(accountName);
	const password = String(body.password || (storedAccount && storedAccount.password) || '');
	const localProfile = readLocalAccountProfile(accountName);
	const sharedSecret = String(body.sharedSecret || localProfile.sharedSecret || (storedAccount && storedAccount.sharedSecret) || '').trim();
	const identitySecret = String(body.identitySecret || localProfile.identitySecret || '').trim();
	let twoFactorCode = String(body.twoFactorCode || '').trim();
	// 没传 remember 时按名单里的设置(默认记住):记住才会保存 refreshToken,重启后才能免密恢复
	const remember = body.remember !== undefined ? !!body.remember : !(storedAccount && storedAccount.remember === false);

	if (!accountName || !password) {
		return res.status(400).json({success: false, error: '账号和密码不能为空'});
	}

	// 同一账号已在登录中或在线:直接返回现有会话,不再新建客户端互相顶号。force=true 时强制重登。
	const existing = body.force ? null : sessions.activeAttemptFor(accountName);
	if (existing) {
		return res.json({success: true, attempt: publicAttempt(existing), reused: true});
	}

	// 新建会话时会先拆掉该账号的旧会话(已登出/掉线/失败的)
	const attempt = sessions.createAttempt({
		accountName,
		remember,
		sharedSecret,
		identitySecret,
		hasMaFile: localProfile.hasMaFile,
		country: localProfile.country,
		hasWallet: localProfile.hasWallet,
		currency: localProfile.currency,
		currencyISO: localProfile.currencyISO,
		balance: localProfile.balance
	});

	if (!body.sharedSecret && localProfile.sharedSecret) {
		addLog(attempt, 'info', '已从本地 maFile 载入 shared_secret');
	}

	if (!body.identitySecret && localProfile.identitySecret) {
		addLog(attempt, 'info', '已从本地 maFile 载入 identity_secret（用于发货确认）');
	}

	if (!twoFactorCode && sharedSecret) {
		try {
			twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);
			addLog(attempt, 'info', '已使用 shared_secret 生成移动令牌验证码');
		} catch (err) {
			addLog(attempt, 'warn', 'shared_secret 无法生成验证码: ' + err.message);
		}
	}

	sessions.startLogon(attempt, {
		accountName,
		password,
		twoFactorCode: twoFactorCode || undefined
	});

	res.json({success: true, attempt: publicAttempt(attempt)});
});

app.post('/api/login-refresh', (req, res) => {
	const body = req.body || {};
	const refreshToken = String(body.refreshToken || '').trim();
	const accountName = String(body.accountName || '').trim();

	if (!refreshToken) {
		return res.status(400).json({success: false, error: 'refreshToken 不能为空'});
	}

	const localProfile = readLocalAccountProfile(accountName);
	const attempt = sessions.createAttempt({
		accountName,
		remember: !!body.remember,
		sharedSecret: localProfile.sharedSecret,
		identitySecret: localProfile.identitySecret,
		hasMaFile: localProfile.hasMaFile,
		country: localProfile.country,
		hasWallet: localProfile.hasWallet,
		currency: localProfile.currency,
		currencyISO: localProfile.currencyISO,
		balance: localProfile.balance
	});

	sessions.startLogon(attempt, {refreshToken});
	res.json({success: true, attempt: publicAttempt(attempt)});
});

app.post('/api/guard/:id', (req, res) => {
	const attempt = getAttempt(req.params.id, res);
	if (!attempt) {
		return;
	}

	const code = String((req.body && req.body.code) || '').trim();
	if (!code) {
		return res.status(400).json({success: false, error: '验证码不能为空'});
	}

	if (!attempt.guardCallback) {
		return res.status(409).json({success: false, error: '当前任务不需要 Steam Guard 验证码'});
	}

	sessions.submitGuardCode(attempt, code);

	res.json({success: true, attempt: publicAttempt(attempt)});
});

app.post('/api/web-session/:id', (req, res) => {
	const attempt = getAttempt(req.params.id, res);
	if (!attempt) {
		return;
	}

	if (!attempt.client || !attempt.client.steamID) {
		return res.status(409).json({success: false, error: 'Steam 尚未登录'});
	}

	try {
		attempt.status = 'web_session_pending';
		addLog(attempt, 'info', '正在获取 WebSession cookies');
		attempt.client.webLogOn();
		emitAttempt(attempt);
		res.json({success: true, attempt: publicAttempt(attempt)});
	} catch (err) {
		addLog(attempt, 'error', '获取 WebSession 失败: ' + err.message);
		emitAttempt(attempt);
		res.status(500).json({success: false, error: err.message});
	}
});

app.post('/api/logout/:id', (req, res) => {
	const attempt = getAttempt(req.params.id, res);
	if (!attempt) {
		return;
	}

	// 手动登出:取消待执行的登录重试,并清掉"重启后自动恢复"的意图
	sessions.logout(attempt);
	res.json({success: true, attempt: publicAttempt(attempt)});
});

// 前端删除账户时调用：把这些账号对应的后端保活会话一并清理。
// 1) 登出在线客户端并移出内存任务表（这样 /api/attempts 不会再返回它们）；
// 2) 删除数据库里已保存的 session（避免残留凭据）。
app.post('/api/accounts/cleanup', (req, res) => {
	const body = req.body || {};
	const list = Array.isArray(body.accounts) ? body.accounts : [];

	const names = [];
	const ids = [];
	for (const item of list) {
		const accountName = item && item.accountName ? String(item.accountName).trim() : '';
		const attemptId = item && item.attemptId ? String(item.attemptId).trim() : '';
		if (accountName) {
			names.push(accountName);
		}
		if (attemptId) {
			ids.push(attemptId);
		}
	}

	// 登出并移出会话表、清掉登录意图;session 按 accountName / steamID / id 任一作 key 保存过,一并删掉。
	const {removedAttempts, sessionKeys} = sessions.removeAccounts(names, ids);
	let removedFiles = 0;
	try {
		removedFiles = store.sessions.remove(sessionKeys);
	} catch (err) {
		console.warn('[cleanup] 删除 session 失败', err && err.message);
	}

	// 同步从持久化名单中移除,确保即使前端防抖推送未及时发出,服务端名单也保持一致。
	let removedFromList = false;
	try {
		removedFromList = removeAccountsFromList(names);
	} catch (err) {
		console.warn('[cleanup] 更新账户名单失败', err && err.message);
	}

	res.json({success: true, removedAttempts, removedFiles, removedFromList});
});

app.post('/api/gc/connect/:id', (req, res) => {
	const attempt = getAttempt(req.params.id, res);
	if (!attempt) {
		return;
	}
	const game = getPurchaseGame(req);
	const config = getPurchaseGameConfig(game);

	if (!attempt.client || !attempt.client.steamID || attempt.status === 'logged_out') {
		return res.status(409).json({success: false, error: '当前账号尚未登录 Steam'});
	}

	try {
		ensureAttemptGameSession(attempt, config.id);
		try {
			attempt.client.webLogOn();
		} catch {}
		addLog(attempt, 'info', `已请求连接 ${config.label} GC`);
		emitAttempt(attempt);
		res.json({success: true, attempt: publicAttempt(attempt)});
	} catch (err) {
		res.status(500).json({success: false, error: err.message || '连接 GC 失败'});
	}
});

app.post('/api/gc/disconnect/:id', (req, res) => {
	const attempt = getAttempt(req.params.id, res);
	if (!attempt) {
		return;
	}
	const game = getPurchaseGame(req);
	const config = getPurchaseGameConfig(game);

	if (!attempt.client || attempt.status === 'logged_out') {
		return res.status(409).json({success: false, error: '当前账号尚未登录 Steam'});
	}

	try {
		disconnectAttemptGameSession(attempt, config.id);
		addLog(attempt, 'info', `已请求断开 ${config.label} GC`);
		emitAttempt(attempt);
		res.json({success: true, attempt: publicAttempt(attempt)});
	} catch (err) {
		res.status(500).json({success: false, error: err.message || '断开 GC 失败'});
	}
});

app.get('/api/cookies/:id', debugOnly, (req, res) => {
	const attempt = getAttempt(req.params.id, res);
	if (!attempt) {
		return;
	}

	if (!attempt.cookies || !attempt.cookies.length) {
		return res.status(404).json({success: false, error: '当前任务没有 cookies'});
	}

	res.json({
		success: true,
		cookies: attempt.cookies,
		cookieHeader: attempt.cookies.join('; ')
	});
});

app.get('/api/inventory/:id', async (req, res) => {
	const attempt = getAttempt(req.params.id, res);
	if (!attempt) {
		return;
	}

	try {
		const inventory = await getAttemptInventory(attempt, {
			forceRefresh: req.query.refresh === '1'
		});
		res.json({
			success: true,
			attempt: publicAttempt(attempt),
			inventory
		});
	} catch (err) {
		res.status(err.statusCode || 500).json({
			success: false,
			error: err.message || '库存读取失败'
		});
	}
});

// ===== CS2「创世终端机」开启(P1 拉报价 / P2 解封 / 抓包状态)=====
// ⚠️ 解封不可逆(启动 72h 倒计时);本组端点【不含】花钱兑换报价(P3)。
app.post('/api/terminal/unseal', (req, res) => {
	const body = req.body || {};
	const attempt = findAttemptByKey(String(body.accountId || body.account || '').trim());
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录(用 id 或账号名指定)'});
	}
	const assetid = String(body.assetid || body.itemId || '').trim();
	const variant = String(body.variant || '').trim();
	try {
		const result = cs2Terminal.unseal(attempt, assetid, {variant, volatileLimit: body.volatileLimit, pointsRemaining: body.pointsRemaining, gcItemId: body.gcItemId});
		addLog(attempt, 'warn', `[终端机] 已发送解封请求 item=${assetid} 方式=${result.msg}(不可逆,72h 倒计时开始)`);
		res.json({success: true, result});
	} catch (err) {
		res.status(400).json({success: false, error: err && err.message ? err.message : '解封失败'});
	}
});

// 协议探针:依次发多种候选解封消息,对齐回包 + SO 变动,命中即停。用于定位真正的解封消息。
app.post('/api/terminal/probe', async (req, res) => {
	const body = req.body || {};
	const attempt = findAttemptByKey(String(body.accountId || body.account || '').trim());
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录'});
	}
	try {
		addLog(attempt, 'warn', '[终端机] 协议探针启动(会依次试发多种开箱消息,命中即停;命中=不可逆消耗该终端机)');
		const result = await cs2Terminal.probe(attempt, {itemId: body.itemId || body.assetid, gcItemId: body.gcItemId});
		addLog(attempt, 'warn', `[终端机] 协议探针结束:${result.hit ? '★命中 ' + result.hit.label : '无变动(需抓官方客户端实包)'}`);
		res.json({success: true, result});
	} catch (err) {
		res.status(400).json({success: false, error: err && err.message ? err.message : '探针失败'});
	}
});

// ★ 推进到下一个报价:不可逆、消耗 1 次挑选(2534 UseToolWithIntArg)。仅在前端强确认后调用。
app.post('/api/terminal/advance-offer', async (req, res) => {
	const body = req.body || {};
	const attempt = findAttemptByKey(String(body.accountId || body.account || '').trim());
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录'});
	}
	const terminalId = String(body.gcItemId || body.itemId || body.assetid || '').trim();
	try {
		addLog(attempt, 'warn', `[终端机] 推进到下一个报价(不可逆·消耗1次)终端机 ${terminalId}`);
		const result = await cs2Terminal.advanceOffer(attempt, terminalId, {pointsRemaining: body.pointsRemaining});
		try { await ensureCs2SkinImages(); } catch (_) {}
		if (result && Array.isArray(result.skins)) result.skins = result.skins.map(enrichTerminalOffer);
		// 揭示出的新报价追加进该终端机的历史(持久缓存,页面刷新/重启后仍可查看之前开过的结果)。
		const revealed = result && Array.isArray(result.skins) ? result.skins[0] : null;
		if (revealed) result.history = appendTerminalOffer(terminalId, revealed.defindex, revealed);
		addLog(attempt, 'warn', `[终端机] 已推进:当前 ${result.count || 0} 个报价(新 ${result.fresh ? result.fresh.length : 0})`);
		res.json({success: true, result});
	} catch (err) {
		res.status(400).json({success: false, error: err && err.message ? err.message : '推进报价失败'});
	}
});

app.post('/api/terminal/request-offers', (req, res) => {
	const body = req.body || {};
	const attempt = findAttemptByKey(String(body.accountId || body.account || '').trim());
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录'});
	}
	try {
		const result = cs2Terminal.requestOffers(attempt, {defidx: body.defidx, itemId: body.itemId || body.assetid, volatileLimit: body.volatileLimit});
		addLog(attempt, 'info', '[终端机] 已请求报价(volatile shop)');
		res.json({success: true, result});
	} catch (err) {
		res.status(400).json({success: false, error: err && err.message ? err.message : '请求报价失败'});
	}
});

// GC 通路自检:查自己 profile,验证本会话 GC 请求能否收到回包(判断「开箱被拦」还是「整条不通」)。
app.post('/api/terminal/selftest', (req, res) => {
	const body = req.body || {};
	const attempt = findAttemptByKey(String(body.accountId || body.account || '').trim());
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录'});
	}
	try {
		const result = cs2Terminal.selfTest(attempt);
		addLog(attempt, 'info', '[终端机] GC 通路自检已发起(看后台日志 8s 内是否有回包)');
		res.json({success: true, result});
	} catch (err) {
		res.status(400).json({success: false, error: err && err.message ? err.message : '自检失败'});
	}
});

// 解析已捕获报价里的 faux_itemid → 真实皮肤(GC 检视)。
app.post('/api/terminal/resolve-offers', async (req, res) => {
	const body = req.body || {};
	const attempt = findAttemptByKey(String(body.accountId || body.account || '').trim());
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录'});
	}
	try {
		const result = await cs2Terminal.resolveOffers(attempt);
		addLog(attempt, 'info', `[终端机] 报价解析:${result.count || 0}/${result.total || 0} 成功`);
		res.json({success: true, result});
	} catch (err) {
		res.status(400).json({success: false, error: err && err.message ? err.message : '解析报价失败'});
	}
});

// ---- CS2 皮肤中文名+图片:def_index + paint_index → {name(中文), image, rarity}。数据源 ByMykel CSGO-API(zh-CN),拉一次缓存到磁盘 ----
// 注:本地 items_game.txt 对较新 paint 只有英文开发名(如 "P2000 Deep RED"),所以皮肤名用 ByMykel zh-CN;外观档仍用本地 describeGcItem。
const CS2_SKIN_DB_CACHE = path.join(DATA_DIR, 'cs2-skin-db.json');
const CS2_SKIN_DB_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/zh-CN/skins.json';
let cs2SkinDbMap = null;
let cs2SkinDbLoading = null;
function buildCs2SkinDbMap(list) {
	const map = {};
	for (const s of (Array.isArray(list) ? list : [])) {
		const def = Number(s && s.weapon && s.weapon.weapon_id);
		const paint = s && s.paint_index != null ? Number(s.paint_index) : NaN;
		if (def && Number.isFinite(paint)) {
			map[`${def}_${paint}`] = {name: s.name || '', image: s.image || '', rarity: (s.rarity && s.rarity.name) || ''};
		}
	}
	return map;
}
// 随发布包一起的内置副本(app/data/,layer②会更新;raw.githubusercontent 在国内常被墙,靠这个离线也能用)。
const CS2_SKIN_DB_BUNDLED = path.join(CODE_DIR, 'data', 'cs2-skin-db.json');
function loadCs2SkinDbFile(file) {
	try {
		if (fs.existsSync(file)) {
			const j = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (j && j.map && Object.keys(j.map).length) return j.map;
		}
	} catch (_) {}
	return null;
}
async function fetchCs2SkinDb() {
	try {
		const res = await fetch(CS2_SKIN_DB_URL, {headers: {'User-Agent': 'steam-tools'}, signal: AbortSignal.timeout(30000)});
		if (res.ok) {
			const map = buildCs2SkinDbMap(await res.json());
			if (Object.keys(map).length) {
				try { writeJsonAtomic(CS2_SKIN_DB_CACHE, {fetchedAt: new Date().toISOString(), map}, 0); } catch (_) {}
				return map;
			}
		}
	} catch (e) { console.warn('[terminal] 拉 CS2 皮肤库(ByMykel zh-CN)失败:', e && e.message); }
	return null;
}
let cs2SkinDbRefreshed = false;
function refreshCs2SkinDbInBackground() {
	if (cs2SkinDbRefreshed) return;
	cs2SkinDbRefreshed = true;
	fetchCs2SkinDb().then(map => { if (map) cs2SkinDbMap = map; }).catch(() => {});
}
async function ensureCs2SkinImages() {
	if (cs2SkinDbMap) return cs2SkinDbMap;
	if (cs2SkinDbLoading) return cs2SkinDbLoading;
	cs2SkinDbLoading = (async () => {
		// 优先:运行时缓存(上次联网刷新的最新) → 内置随包副本(离线/被墙也能用);两者任一命中就用,并后台尝试联网刷新。
		const m = loadCs2SkinDbFile(CS2_SKIN_DB_CACHE) || loadCs2SkinDbFile(CS2_SKIN_DB_BUNDLED);
		if (m) { cs2SkinDbMap = m; refreshCs2SkinDbInBackground(); return cs2SkinDbMap; }
		// 都没有(极少见)→ 直接联网拉
		return (cs2SkinDbMap = (await fetchCs2SkinDb()) || {});
	})();
	try { return await cs2SkinDbLoading; } finally { cs2SkinDbLoading = null; }
}
function resolveCs2Skin(defIndex, paintIndex) {
	if (!cs2SkinDbMap) return null;
	return cs2SkinDbMap[`${Number(defIndex)}_${Number(paintIndex)}`] || null;
}
// 给一个终端机报价(raw {defindex,paintindex,paintwear,paintseed,rarity,priceCents})补:中文名/图片/外观档/品质。
function enrichTerminalOffer(offer) {
	if (!offer) return offer;
	const def = Number(offer.defindex || 0);
	const paint = Number(offer.paintindex || 0);
	const wear = offer.paintwear != null ? Number(offer.paintwear) : null;
	// 本地 schema:主要取外观档(中文)+ 兜底名/品质
	let localName = '', exterior = '', localRarity = '';
	try {
		const d = describeGcItem(ITEMS_GAME_SCHEMA, {def_index: def, paint_index: paint, paint_wear: wear != null ? wear : undefined, paint_seed: offer.paintseed});
		if (d) {
			localName = d.name || '';
			localRarity = d.rarity || '';
			exterior = String(d.exterior || '').replace(/\s*[\d.]+\s*$/, '').trim(); // 去尾部 float,只留档位名
		}
	} catch (_) {}
	// ByMykel zh-CN:皮肤中文名 + 图片 + 品质(优先)
	const db = resolveCs2Skin(def, paint);
	return {
		...offer,
		name: (db && db.name) || localName || `def${def} · paint${paint}`,
		exterior,
		rarity: (db && db.rarity) || localRarity || '',
		wear,
		priceText: offer.priceCents != null ? '$' + (offer.priceCents / 100).toFixed(2) : '',
		image: (db && db.image) || ''
	};
}

// 终端机自身的中文名兜底(本地 schema 只有英文 "Crate Community 36";社区库存拿不到时用这个)。
const TERMINAL_DEF_NAMES = {
	5176: {sealed: '封装的创世终端机', open: '创世终端机'},
	5181: {sealed: '封装的毁灭之手终端机', open: '毁灭之手终端机'}
};
function defaultTerminalName(t) {
	const n = TERMINAL_DEF_NAMES[Number(t && t.defIndex)];
	if (n) return t && t.sealed ? n.sealed : n.open;
	return t && t.sealed ? '封装的终端机' : '终端机';
}

// ── 终端机报价历史:每次「换下一个」揭示出的报价都追加缓存到 data/terminal-offers.json(按终端机 GC id)。
//    刷新页面/重启后仍能查看该终端机之前开出过哪些报价。GC id 是持久 assetid,解封后跨会话稳定。
const TERMINAL_OFFERS_FILE = path.join(DATA_DIR, 'terminal-offers.json');
const TERMINAL_OFFERS_MAX = 30;   // 每个终端机最多存这么多条(挑选上限 5,留足余量)
function loadTerminalOfferHistoryMap() {
	const data = readJsonFile(TERMINAL_OFFERS_FILE);
	return (data && typeof data === 'object') ? data : {};
}
function getTerminalOfferHistory(terminalId) {
	const rec = loadTerminalOfferHistoryMap()[String(terminalId)];
	return rec && Array.isArray(rec.offers) ? rec.offers : [];
}
// 追加一条揭示出的报价(已富化:带中文名/图/价)。与上一条同 itemid 则跳过(避免重复揭示同一条时重复记)。
function appendTerminalOffer(terminalId, defIndex, offer) {
	const key = String(terminalId || '').trim();
	if (!key || !offer) return getTerminalOfferHistory(key);
	const map = loadTerminalOfferHistoryMap();
	const rec = map[key] && typeof map[key] === 'object' ? map[key] : {defIndex: Number(defIndex) || 0, offers: []};
	if (!Array.isArray(rec.offers)) rec.offers = [];
	const last = rec.offers[rec.offers.length - 1];
	const sameAsLast = last && offer.itemid != null && String(last.itemid) === String(offer.itemid);
	if (!sameAsLast) {
		rec.offers.push({...offer, revealedAt: new Date().toISOString()});
		if (rec.offers.length > TERMINAL_OFFERS_MAX) rec.offers = rec.offers.slice(-TERMINAL_OFFERS_MAX);
	}
	rec.defIndex = Number(defIndex) || rec.defIndex || 0;
	rec.updatedAt = new Date().toISOString();
	map[key] = rec;
	try { writeJsonAtomic(TERMINAL_OFFERS_FILE, map); } catch (_) {}
	return rec.offers;
}

app.get('/api/terminal/state', async (req, res) => {
	const attempt = findAttemptByKey(String(req.query.accountId || req.query.account || '').trim());
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录'});
	}
	try { await ensureCs2SkinImages(); } catch (_) {}
	const state = cs2Terminal.getState(attempt);
	// 用库存快照(社区源:带真实中文名+图标)给终端机补 name/image:按 assetid 精确匹配(状态图标对得上),
	// 匹配不到再按 def 兜底(同 def 名字/图一样),都拿不到就用本地中文名兜底、无图。
	const metaByAsset = new Map(), metaByDef = new Map();
	try {
		const snap = await getAttemptInventory(attempt, {});
		// 只信社区源(带 schinese 中文名 + 图标);GC 源是英文名且无图,不如本地兜底,跳过。
		if (snap && snap.source === 'community') {
			for (const it of snap.items || []) {
				const meta = {name: it.name || '', image: it.iconUrl || ''};
				if (it.assetid) metaByAsset.set(String(it.assetid), meta);
				const def = it.raw && it.raw.gcItem ? Number(it.raw.gcItem.def_index) : null;
				if (def && meta.image && !metaByDef.has(def)) metaByDef.set(def, meta);
			}
		}
	} catch (_) {}
	if (Array.isArray(state.terminals)) {
		const historyMap = loadTerminalOfferHistoryMap();   // 一次读盘,给所有终端机查历史
		state.terminals = state.terminals.map(t => {
			if (!t) return t;
			const meta = metaByAsset.get(String(t.id)) || metaByDef.get(Number(t.defIndex)) || null;
			const hrec = historyMap[String(t.id)];
			return {
				...t,
				name: (meta && meta.name) || defaultTerminalName(t),
				image: (meta && meta.image) || '',
				offer: t.offer ? enrichTerminalOffer(t.offer) : t.offer,
				history: hrec && Array.isArray(hrec.offers) ? hrec.offers : []   // 之前每次「换下一个」开出的报价(持久缓存)
			};
		});
	}
	res.json({success: true, state});
});

// ===== 游戏内购(CS2/TF2 GC 商店)=====
// 前端用 /api/purchase/*(?game=cs2|tf2);/api/cs2/*、/api/tf2/*、/api/task/*-purchase 是旧别名,保留兼容。
function sendPurchaseError(res, err, fallback) {
	res.status(err && err.statusCode || 500).json({success: false, error: err && err.message || fallback});
}

function purchaseCatalogRoute(game, load, failure) {
	return async (req, res) => {
		const target = game || getPurchaseGame(req);
		try {
			await load(target);
			res.json(purchase.catalog.response(target));
		} catch (err) {
			sendPurchaseError(res, err, failure);
		}
	};
}

function purchaseTaskRoute(game) {
	return (req, res) => {
		let cartData;
		try {
			cartData = normalizeCartData(req.body && req.body.cartData);
		} catch (err) {
			return res.status(400).json({success: false, error: err && err.message ? err.message : '购物车数据无效'});
		}
		const task = purchase.tasks.create(game || getPurchaseGame(req), cartData);
		purchase.tasks.start(task);
		res.json({success: true, task: publicPurchaseTask(task)});
	};
}

for (const [prefix, game] of [['purchase', null], ['cs2', 'cs2'], ['tf2', 'tf2']]) {
	app.get(`/api/${prefix}/online-accounts`, (req, res) => {
		const target = game || getPurchaseGame(req);
		res.json({success: true, game: target, gameLabel: getPurchaseGameConfig(target).label, accounts: purchase.listOnlineAccounts(target)});
	});
	app.get(`/api/${prefix}/items`, purchaseCatalogRoute(game, target => purchase.catalog.ensureLoaded(target), '商品目录读取失败'));
	app.post(`/api/${prefix}/refresh-items`, purchaseCatalogRoute(game, target => purchase.catalog.refresh(target, {forceRefresh: true}), '商品目录刷新失败'));
	// 刷新汇率:新接口是 POST,旧别名是 GET
	app[prefix === 'purchase' ? 'post' : 'get'](`/api/${prefix}/refresh-rates`, async (req, res) => {
		const target = game || getPurchaseGame(req);
		try {
			await purchase.catalog.refreshRates({forceRefresh: true});
			res.json(purchase.catalog.response(target));
		} catch (err) {
			sendPurchaseError(res, err, '汇率刷新失败');
		}
	});
}

app.get('/api/purchase/tasks', (req, res) => {
	res.json({success: true, tasks: purchase.tasks.list()});
});
app.post('/api/purchase/tasks', purchaseTaskRoute(null));
app.post('/api/task/cs2-purchase', purchaseTaskRoute('cs2'));
app.post('/api/task/tf2-purchase', purchaseTaskRoute('tf2'));

// 协议购买整款 Steam 游戏(钱包给自己买)。默认 dryRun:只验证到最终价、不扣款。
// body: { id: <账号attempt id>, packageIds: [subid...], dryRun?: true|false }
app.post('/api/steam-purchase/test', debugOnly, async (req, res) => {
	const body = req.body || {};
	const key = String(body.id || body.accountId || body.accountName || '').trim();
	let attempt = attempts.get(key);
	if (!attempt && key) {
		const lower = key.toLowerCase();
		for (const item of attempts.values()) {
			if (String(item.accountName || '').toLowerCase() === lower) {
				attempt = item;
				break;
			}
		}
	}
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录(用 id 或账号名指定)'});
	}

	const cookies = resolveInventoryCookies(attempt);
	if (!cookies.length) {
		return res.status(409).json({success: false, error: '当前账号没有可用的 WebSession cookies,请重新登录'});
	}

	const packageIds = Array.isArray(body.packageIds)
		? body.packageIds
		: (body.packageId != null ? [body.packageId] : []);
	const dryRun = body.dryRun !== false; // 默认 true:不扣款

	try {
		const result = await steamStorePurchaser.purchasePackages({
			cookies,
			sessionid: attempt.webSessionID,
			userAgent: attempt.userAgent,
			country: attempt.country || attempt.loginGeoCountry || 'CN',
			currency: attempt.currency,
			packageIds,
			dryRun
		});
		res.json({success: true, result});
	} catch (err) {
		res.status(500).json({success: false, error: err && err.message ? err.message : '购买失败'});
	}
});

// ===== 买游戏(协议购买整款 Steam 游戏)=====

// 可购买账户:已登录且有 WebSession cookie 的账号(买游戏只需 cookie,不需要 GC)。
app.get('/api/buygame/online-accounts', (req, res) => {
	res.json({success: true, accounts: listBuyGameOnlineAccounts()});
});

// 解析一个 subid(packageid):返回游戏名/价格,供前端确认购买内容。
app.get('/api/buygame/resolve', async (req, res) => {
	const packageId = Number(req.query.packageId || req.query.subid);
	if (!Number.isInteger(packageId) || packageId <= 0) {
		return res.status(400).json({success: false, error: 'packageId 无效'});
	}
	const attempt = findAttemptByKey(String(req.query.accountId || req.query.account || '').trim());
	const country = (attempt && (attempt.country || attempt.loginGeoCountry)) || 'US';
	try {
		const info = await resolveSteamPackageInfo(packageId, country, attempt);
		res.json({success: true, package: info});
	} catch (err) {
		res.status(502).json({success: false, error: err && err.message ? err.message : '解析失败'});
	}
});

app.get('/api/buygame/tasks', (req, res) => {
	res.json({success: true, tasks: buyGameTasks.map(publicBuyGameTask)});
});

// 创建并执行买游戏任务。body: { items:[{accountId, packageIds:[subid...]}], dryRun }
app.post('/api/buygame/tasks', (req, res) => {
	const body = req.body || {};
	const rawItems = Array.isArray(body.items) ? body.items : [];
	const items = [];
	for (const raw of rawItems) {
		const attempt = findAttemptByKey(String((raw && (raw.accountId || raw.account)) || '').trim());
		if (!attempt) {
			continue;
		}
		const packageIds = (Array.isArray(raw.packageIds) ? raw.packageIds : [])
			.map(id => Number(id))
			.filter(id => Number.isInteger(id) && id > 0);
		if (!packageIds.length) {
			continue;
		}
		items.push({attempt, packageIds: Array.from(new Set(packageIds))});
	}
	if (!items.length) {
		return res.status(400).json({success: false, error: '没有有效的购买项(账号未在线或 subid 无效)'});
	}
	const dryRun = body.dryRun === true; // 买游戏默认真扣款;前端可勾选试运行
	const task = createBuyGameTask(items, dryRun, body.concurrency); // 并发线程数,默认 3
	startBuyGameTask(task);
	res.json({success: true, task: publicBuyGameTask(task)});
});

// ===== Steam 社区市场:求购单(createbuyorder / cancelbuyorder)=====

function loadMarketBuyOrders() {
	const data = readJsonFile(MARKET_BUYORDERS_FILE);
	return Array.isArray(data) ? data : [];
}

function saveMarketBuyOrders(list) {
	try {
		writeJsonAtomic(MARKET_BUYORDERS_FILE, list);
	} catch (err) {
		console.log('[market-buyorder] 账本保存失败: ' + (err && err.message ? err.message : err));
	}
}

// ---- item_nameid 缓存(行情盘口用)----
function marketNameIdKey(appid, marketHashName) {
	return `${Number(appid)}|${String(marketHashName || '')}`;
}
function loadMarketNameIds() {
	const data = readJsonFile(MARKET_NAMEIDS_FILE);
	return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}
function getCachedMarketNameId(appid, marketHashName) {
	const v = loadMarketNameIds()[marketNameIdKey(appid, marketHashName)];
	return v ? String(v) : '';
}
function saveMarketNameId(appid, marketHashName, nameId) {
	const id = String(nameId || '').replace(/\D/g, '');
	if (!id) {
		return;
	}
	const map = loadMarketNameIds();
	const key = marketNameIdKey(appid, marketHashName);
	if (map[key] === id) {
		return;
	}
	map[key] = id;
	try {
		writeJsonAtomic(MARKET_NAMEIDS_FILE, map);
	} catch (err) {
		console.log('[market-buyorder] nameid 缓存保存失败: ' + (err && err.message ? err.message : err));
	}
}

// 社区 nameid 数据库({market_hash_name: nameid},按游戏分文件,覆盖 CS2/TF2)。
// 数据已随程序打包在本地 app/services/nameid-db/{CS2,TF2}.json —— 正常运行只读本地,不联网。
// (来源:github.com/somespecialone/steam-item-name-ids;nameid 对已存在物品永不变,新物品才需更新。)
const NAMEID_DB_GAME_BY_APPID = {730: 'CS2', 440: 'TF2'};
const NAMEID_DB_DIR = path.join(CODE_DIR, 'services', 'nameid-db');
const nameIdDbCache = new Map(); // game -> {map}

function loadLocalNameIdDb(game) {
	try {
		const map = JSON.parse(fs.readFileSync(path.join(NAMEID_DB_DIR, game + '.json'), 'utf8'));
		return (map && typeof map === 'object' && !Array.isArray(map)) ? map : null;
	} catch (_) {
		return null;
	}
}

// 自愈:本地 nameid 库文件缺失(如部分部署)时,从社区仓库拉一次并落盘;此后纯本地读取。
async function downloadNameIdDb(game) {
	const url = `https://raw.githubusercontent.com/somespecialone/steam-item-name-ids/main/data/${game}/item_names.json`;
	const res = await fetch(url, {headers: {'User-Agent': 'steam-tools'}, signal: AbortSignal.timeout(15000)});
	if (!res.ok) {
		throw new Error('HTTP ' + res.status);
	}
	const text = await res.text();
	const map = JSON.parse(text);
	if (!map || typeof map !== 'object' || Array.isArray(map)) {
		throw new Error('数据格式异常');
	}
	try {
		fs.mkdirSync(NAMEID_DB_DIR, {recursive: true});
		writeFileAtomic(path.join(NAMEID_DB_DIR, game + '.json'), text, 'utf8');
	} catch (err) {
		console.log('[market-buyorder] nameid 库落盘失败(' + game + '): ' + (err && err.message ? err.message : err));
	}
	return map;
}

async function resolveNameIdFromDb(appid, marketHashName) {
	const game = NAMEID_DB_GAME_BY_APPID[Number(appid)];
	if (!game) {
		return '';
	}
	let entry = nameIdDbCache.get(game);
	if (!entry) {
		let map = loadLocalNameIdDb(game);   // 先读本地打包好的库
		if (!map) {
			try {
				map = await downloadNameIdDb(game);   // 本地缺失才补全一次
				console.log(`[market-buyorder] 本地 nameid 库缺失,已从社区仓库补全(${game})`);
			} catch (err) {
				console.log('[market-buyorder] nameid 库加载失败(' + game + '): ' + (err && err.message ? err.message : err));
				map = {};
			}
		}
		entry = {map};
		nameIdDbCache.set(game, entry);
		console.log(`[market-buyorder] nameid 库就绪(${game}): ${Object.keys(entry.map).length} 条`);
	}
	const v = entry.map[marketHashName];
	return v ? String(v).replace(/\D/g, '') : '';
}

// 解析前端传来的商品定位:优先 url,其次 appid + marketHashName。
function resolveMarketTarget(body) {
	if (body && body.url) {
		return steamMarketBuyOrder.parseListingUrl(body.url);
	}
	const appid = Number(body && body.appid);
	const marketHashName = String((body && body.marketHashName) || '').trim();
	if (Number.isInteger(appid) && appid > 0 && marketHashName) {
		return {appid, marketHashName};
	}
	throw new Error('请提供商品链接(url)或 appid + marketHashName');
}

// 可挂求购的在线账户(同「买游戏」:已登录 + 有 WebSession cookie)。
app.get('/api/market/online-accounts', (req, res) => {
	res.json({success: true, accounts: listBuyGameOnlineAccounts()});
});

// 行情参考:用某账号的 cookie/币种/地区抓盘口(最高求购/最低在售)与概览价(成交均价/销量)。
// query: { accountId|account, url } 或 { accountId, appid, marketHashName }
app.get('/api/market/context', async (req, res) => {
	const attempt = findAttemptByKey(String(req.query.accountId || req.query.account || '').trim());
	if (!attempt) {
		return res.status(404).json({success: false, error: '账号不存在或未登录(用 id 或账号名指定)'});
	}
	let target;
	try {
		target = resolveMarketTarget({url: req.query.url, appid: req.query.appid, marketHashName: req.query.marketHashName});
	} catch (err) {
		return res.status(400).json({success: false, error: err.message});
	}
	// item_nameid:优先用请求里手填的,其次本地缓存。Steam 改版后商品页已抓不到 nameid,
	// 靠这两条恢复盘口(最高求购/最低在售);成交均价/最低在售-priceoverview 不需要 nameid,照常返回。
	const manualNameId = String(req.query.itemNameId || req.query.nameId || '').replace(/\D/g, '');
	let knownNameId = manualNameId || getCachedMarketNameId(target.appid, target.marketHashName);
	if (!knownNameId) {
		// 本地没有就查社区 nameid 数据库(CS2/TF2),命中即自动用,无需用户手填。
		knownNameId = await resolveNameIdFromDb(target.appid, target.marketHashName);
	}
	const cookies = resolveInventoryCookies(attempt);
	try {
		const context = await steamMarketBuyOrder.fetchMarketContext({
			appid: target.appid,
			marketHashName: target.marketHashName,
			itemNameId: knownNameId,
			cookies,
			userAgent: attempt.userAgent,
			currency: attempt.currency,
			country: attempt.country || attempt.loginGeoCountry || 'US'
		});
		context.currencyISO = String(attempt.currencyISO || currencyIdToIso(attempt.currency) || '').toUpperCase();
		// 拿到 nameid(手填或回退抓到)就缓存,下次自动用、无需再填。
		if (context.itemNameId) {
			saveMarketNameId(target.appid, target.marketHashName, context.itemNameId);
		}
		res.json({success: true, context});
	} catch (err) {
		res.status(502).json({success: false, error: err && err.message ? err.message : '行情获取失败'});
	}
});

// 以并发上限 limit 跑 items,worker(item,i) 返回结果;结果与 items 同序。
// Node 单线程,这里的"多线程"是并发 I/O(同时进行多账号的 Steam 请求/等待),unshift 等同步操作天然安全。
async function runWithConcurrency(items, limit, worker) {
	const results = new Array(items.length);
	const lim = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
	let cursor = 0;
	async function runner() {
		while (true) {
			const i = cursor++;
			if (i >= items.length) {
				return;
			}
			results[i] = await worker(items[i], i);
		}
	}
	await Promise.all(Array.from({length: lim}, () => runner()));
	return results;
}

// 挂求购单(可多账号批量,但要求所选账号钱包币种一致 —— 因为求购价是按单一币种填的)。
// body: { accountIds:[id|name...], url|(appid,marketHashName), pricePerItem(钱包币种主单位小数), quantity, itemName?, concurrency?, perAccountMax? }
//   perAccountMax=true 时忽略 quantity,每个账号数量各自 = floor(该账号钱包余额 / pricePerItem)。
app.post('/api/market/buyorder', async (req, res) => {
	const body = req.body || {};
	let target;
	try {
		target = resolveMarketTarget(body);
	} catch (err) {
		return res.status(400).json({success: false, error: err.message});
	}

	const rawIds = Array.isArray(body.accountIds) ? body.accountIds
		: (Array.isArray(body.accounts) ? body.accounts : []);
	const attemptList = [];
	const seen = new Set();
	for (const raw of rawIds) {
		const attempt = findAttemptByKey(String(raw || '').trim());
		if (attempt && !seen.has(attempt.id)) {
			seen.add(attempt.id);
			attemptList.push(attempt);
		}
	}
	if (!attemptList.length) {
		return res.status(400).json({success: false, error: '没有有效的在线账号(用 id 或账号名指定)'});
	}

	// 挂满模式:每个账号数量按各自钱包余额单独算(见 processAttempt);此时不需要统一的 quantity。
	const perAccountMax = !!body.perAccountMax;
	const pricePerItem = Number(body.pricePerItem);
	if (!Number.isFinite(pricePerItem) || pricePerItem <= 0) {
		return res.status(400).json({success: false, error: '每件求购价无效'});
	}
	const pricePerItemCents = Math.round(pricePerItem * 100);
	if (pricePerItemCents <= 0) {
		return res.status(400).json({success: false, error: '每件求购价过低'});
	}
	let quantity = 0;
	let priceTotalCents = 0;
	if (!perAccountMax) {
		quantity = Math.round(Number(body.quantity));
		if (!Number.isInteger(quantity) || quantity <= 0) {
			return res.status(400).json({success: false, error: '求购数量必须为正整数'});
		}
		priceTotalCents = pricePerItemCents * quantity;
	}

	// 校验所选账号币种已知且一致(前端也会拦,这里兜底)。
	const currencyIds = attemptList.map(a => Number(a.currency));
	if (currencyIds.some(c => !Number.isInteger(c) || c <= 0)) {
		return res.status(409).json({success: false, error: '有账号钱包币种未知,无法挂求购(请确认账号有钱包)'});
	}
	if (new Set(currencyIds).size > 1) {
		return res.status(409).json({success: false, error: '所选账号钱包币种不一致,请只选择同一币种的账号下单'});
	}

	// 多线程(并发)上限:默认 2,限 1~8,避免对 Steam 过度并发触发风控。
	const concurrency = Math.max(1, Math.min(8, Math.round(Number(body.concurrency)) || 2));

	const ledger = loadMarketBuyOrders();

	async function processAttempt(attempt) {
		const cookies = resolveInventoryCookies(attempt);
		if (!cookies.length) {
			return {account: attempt.accountName, attemptId: attempt.id, ok: false, error: '没有可用的 WebSession cookies,请重新登录'};
		}
		// 挂满模式:该账号数量 = floor(该账号钱包余额 / 单价),各账号互不影响。
		let acctQty = quantity;
		let acctPriceTotalCents = priceTotalCents;
		if (perAccountMax) {
			const bal = Number(attempt.balance);
			if (!attempt.hasWallet || !Number.isFinite(bal)) {
				return {account: attempt.accountName, attemptId: attempt.id, ok: false, error: '钱包余额未知,无法按余额挂满(请刷新账户/确认账号有钱包)'};
			}
			acctQty = Math.floor(Math.round(bal * 100) / pricePerItemCents);
			if (acctQty <= 0) {
				return {account: attempt.accountName, attemptId: attempt.id, ok: false, error: `钱包余额 ${bal.toFixed(2)} 不足以按当前单价求购 1 件`};
			}
			acctPriceTotalCents = pricePerItemCents * acctQty;
		}
		try {
			// 挂单「前」快照已有确认项:返回的 confirmation_id 实测对不上 conf.id(多半是 creator_id),
			// 故用快照差分作主力定位——挂单后新冒出的那条就是本单,字段映射无关。仅对有 maFile 的账号做。
			let priorConfIds = null;
			if (attempt.identitySecret) {
				try {
					priorConfIds = await steamMarketBuyOrder.listConfirmationIds({cookies, identitySecret: attempt.identitySecret});
				} catch (e) {
					priorConfIds = null;
				}
			}

			const createParams = {
				cookies,
				sessionid: attempt.webSessionID,
				userAgent: attempt.userAgent,
				appid: target.appid,
				marketHashName: target.marketHashName,
				currency: attempt.currency,
				priceTotalCents: acctPriceTotalCents,
				quantity: acctQty
			};
			// 第 1 步:首次提交(不带 confirmation)。
			const r = await steamMarketBuyOrder.createBuyOrder(createParams);

			// 求购单需要手机令牌确认时(success=22 / need_confirmation):
			//   第 2 步 allow 该确认项;第 3 步带 confirmation=<id> 重发 createbuyorder,Steam 才真正落单并返回 buy_orderid。
			//   ⚠️ 只 allow 不重发 → 订单被丢弃(网页端查不到)。对照 aiosteampy place_buy_order。
			let effectiveBuyOrderId = r.buyOrderId;
			let confirmed = !r.needsConfirmation;
			let confirmError = '';
			if (r.needsConfirmation) {
				if (!attempt.identitySecret) {
					confirmError = '已提交求购但需手机确认,该账号未导入 maFile(identity_secret)。请导入 maFile 后重试,或在 Steam 手机 App 手动确认';
				} else if (!r.confirmationId && !r.buyOrderId && priorConfIds === null) {
					confirmError = '已提交求购但需手机确认,且无法定位确认项(无 confirmation_id/buy_orderid 且确认列表读取失败),请在 Steam 手机 App 手动确认';
				} else {
					try {
						// 第 2 步:手机令牌 allow 确认项。
						await steamMarketBuyOrder.confirmBuyOrder({
							cookies,
							identitySecret: attempt.identitySecret,
							confirmationId: r.confirmationId,
							buyOrderId: r.buyOrderId,
							priorConfIds
						});
						// 第 3 步:带 confirmation 重发,拿真正的 buy_orderid;确认可能稍有延迟才生效,故重试。
						for (let k = 0; k < 4 && !confirmed; k++) {
							const r2 = await steamMarketBuyOrder.createBuyOrder(Object.assign({}, createParams, {confirmation: r.confirmationId}));
							if (r2.buyOrderId) {
								effectiveBuyOrderId = r2.buyOrderId;
								confirmed = true;
								break;
							}
							if (!r2.needsConfirmation) {
								break; // 既无 buy_orderid 又不再要求确认 → 异常状态,停止
							}
							await new Promise(res => setTimeout(res, 1500));
						}
						if (!confirmed) {
							confirmError = '已手机确认,但带 confirmation 重发仍未拿到 buy_orderid(确认可能尚未生效),请稍后在网页端「我的求购单」核对';
						}
					} catch (e) {
						confirmError = '已提交求购但自动确认/最终下单失败:' + (e && e.message ? e.message : '未知错误') + '(可在 Steam 手机 App 手动确认)';
					}
				}
			}

			// recordId 回传给前端，用来把「我的求购单」面板限定为本次挂出的这一批。
			let recordId = '';
			if (effectiveBuyOrderId) {
				const record = {
					id: crypto.randomUUID(),
					createdAt: new Date().toISOString(),
					account: attempt.accountName,
					attemptId: attempt.id,
					steamID: attempt.steamID || '',
					appid: target.appid,
					marketHashName: target.marketHashName,
					itemName: String(body.itemName || '').trim() || target.marketHashName,
					currency: Number(attempt.currency),
					currencyISO: String(attempt.currencyISO || currencyIdToIso(attempt.currency) || '').toUpperCase(),
					pricePerItemCents,
					quantity: acctQty,
					priceTotalCents: acctPriceTotalCents,
					buyOrderId: effectiveBuyOrderId,
					status: confirmed ? 'active' : 'pending_confirm'
				};
				ledger.unshift(record);
				recordId = record.id;
			}

			if (confirmed) {
				return {account: attempt.accountName, attemptId: attempt.id, ok: true, buyOrderId: effectiveBuyOrderId, recordId};
			}
			return {account: attempt.accountName, attemptId: attempt.id, ok: false, buyOrderId: effectiveBuyOrderId, recordId, needsConfirmation: true, error: confirmError || '求购单待手机确认'};
		} catch (err) {
			return {account: attempt.accountName, attemptId: attempt.id, ok: false, error: err && err.message ? err.message : '挂求购失败'};
		}
	}

	const results = await runWithConcurrency(attemptList, concurrency, processAttempt);
	saveMarketBuyOrders(ledger);

	const placed = results.filter(r => r.ok).length;
	res.json({success: true, placed, failed: results.length - placed, results});
});

// 我的求购单(仅本工具挂出的,存于 data/market-buyorders.json)。
app.get('/api/market/buyorders', (req, res) => {
	res.json({success: true, orders: loadMarketBuyOrders()});
});

// 撤求购单。body: { id }(本地账本记录 id)或 { accountId, buyOrderId } 直接撤。
app.post('/api/market/buyorder/cancel', async (req, res) => {
	const body = req.body || {};
	const ledger = loadMarketBuyOrders();
	let record = null;
	let attempt = null;
	let buyOrderId = '';

	if (body.id) {
		record = ledger.find(o => o.id === body.id) || null;
		if (!record) {
			return res.status(404).json({success: false, error: '账本中找不到该求购记录'});
		}
		buyOrderId = record.buyOrderId;
		attempt = findAttemptByKey(record.account) || findAttemptByKey(record.attemptId);
	} else {
		buyOrderId = String(body.buyOrderId || '').trim();
		attempt = findAttemptByKey(String(body.accountId || body.account || '').trim());
	}

	if (!buyOrderId) {
		return res.status(400).json({success: false, error: '该记录没有 buy_orderid,无法撤单'});
	}
	if (!attempt) {
		return res.status(409).json({success: false, error: '对应账号未在线,无法撤单(请登录该账号后重试)'});
	}
	const cookies = resolveInventoryCookies(attempt);
	if (!cookies.length) {
		return res.status(409).json({success: false, error: '账号没有可用的 WebSession cookies,请重新登录'});
	}

	try {
		await steamMarketBuyOrder.cancelBuyOrder({cookies, sessionid: attempt.webSessionID, userAgent: attempt.userAgent, buyOrderId});
	} catch (err) {
		return res.status(502).json({success: false, error: err && err.message ? err.message : '撤销失败'});
	}

	// 撤成功:从账本移除匹配 buyOrderId 的记录。
	saveMarketBuyOrders(ledger.filter(o => o.buyOrderId !== buyOrderId));
	res.json({success: true});
});

// 刷新「我的求购单」:逐账号从 Steam 实拉真实求购单(market/mylistings),与本地账本对账:
// 已成交/已撤/已过期(Steam 上不存在了)的本地记录移除;仍在的更新剩余数量。离线账号的记录保持不动。
//
// body.accounts:要对账的账号名/attemptId 列表,一般是用户在左侧选中的在线账号。
// 不传才退回「账本里出现过的所有账号」——那条老路会把历史账本里早已登出的账号全捞一遍,
// 刷一次就报一堆「未在线」,所以前端总是显式传。
app.post('/api/market/buyorders/sync', async (req, res) => {
	const body = req.body || {};
	const concurrency = Math.max(1, Math.min(8, Math.round(Number(body.concurrency)) || 2));
	const ledger = loadMarketBuyOrders();
	const requested = Array.isArray(body.accounts)
		? body.accounts.map(v => String(v || '').trim()).filter(Boolean)
		: [];
	let names;
	if (requested.length) {
		// 传进来的可能是 attemptId,统一解析成账号名,好和账本里的 rec.account 对上
		const resolved = requested.map(key => {
			const attempt = findAttemptByKey(key);
			return attempt && attempt.accountName ? attempt.accountName : key;
		});
		names = [...new Set(resolved)];
	} else {
		names = [...new Set(ledger.map(o => o.account).filter(Boolean))];
	}
	const accounts = [];
	const liveByName = {}; // account name -> Map(buyOrderId -> liveOrder)

	// 多线程(并发)逐账号实拉,加速刷新。
	const syncResults = await runWithConcurrency(names, concurrency, async (name) => {
		const attempt = findAttemptByKey(name);
		if (!attempt) {
			return {name, ok: false, error: '未在线'};
		}
		const cookies = resolveInventoryCookies(attempt);
		if (!cookies.length) {
			return {name, ok: false, error: '无可用 cookie(请重新登录)'};
		}
		try {
			const orders = await steamMarketBuyOrder.fetchMyBuyOrders({
				cookies,
				sessionid: attempt.webSessionID,
				userAgent: attempt.userAgent
			});
			return {name, ok: true, count: orders.length, map: new Map(orders.map(o => [String(o.buyOrderId), o]))};
		} catch (e) {
			return {name, ok: false, error: e && e.message ? e.message : '读取失败'};
		}
	});
	for (const r of syncResults) {
		if (r.ok) {
			liveByName[r.name] = r.map;
			accounts.push({account: r.name, ok: true, count: r.count});
		} else {
			accounts.push({account: r.name, ok: false, error: r.error});
		}
	}

	let removed = 0;
	let updated = 0;
	const next = [];
	for (const rec of ledger) {
		const live = liveByName[rec.account];
		if (!live) {
			next.push(rec); // 该账号没同步成功(离线/失败)→ 保持原样
			continue;
		}
		const lo = rec.buyOrderId ? live.get(String(rec.buyOrderId)) : null;
		if (!lo) {
			removed++; // Steam 上已不存在(成交/撤销/过期)→ 移除
			continue;
		}
		const newRemaining = lo.quantityRemaining != null ? lo.quantityRemaining : rec.quantityRemaining;
		if (rec.status !== 'active' || rec.quantityRemaining !== newRemaining) {
			updated++;
		}
		next.push(Object.assign({}, rec, {status: 'active', quantityRemaining: newRemaining}));
	}

	saveMarketBuyOrders(next);
	// syncedAccounts:实拉成功的账号。前端据此把面板限定为「刚对过账的这些账号的求购单」,
	// 其余历史记录仍留在账本里(撤单/下次对账要用),只是不显示。
	const syncedAccounts = accounts.filter(a => a.ok).map(a => a.account);
	res.json({success: true, orders: next, syncedAccounts, summary: {removed, updated, accounts}});
});

// ===== UU(悠悠有品)发货 =====
app.get('/api/uu/state', (req, res) => {
	res.json({
		success: true,
		pollIntervalMs: UU_POLL_INTERVAL_MS,
		accounts: listUuAccounts()
	});
});

app.post('/api/uu/bind', async (req, res) => {
	try {
		const body = req.body || {};
		// 浏览器拿不到 token 原文:自动绑定时传 tokenId,由服务端查出 token;手动粘贴时仍直接传 token。
		let token = String(body.token || '').trim();
		if (!token && body.tokenId) {
			const entry = store.uu.findToken(String(body.tokenId));
			if (!entry) {
				return res.status(404).json({success: false, error: '找不到该 token,请刷新后重试'});
			}
			token = entry.token;
		}
		const account = await bindUuToken(body.accountName, token, body.gameId);
		res.json({success: true, account});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || 'token 绑定失败'});
	}
});


app.post('/api/uu/auto', (req, res) => {
	try {
		const body = req.body || {};
		const account = setUuAuto(body.accountName, body.gameId, !!body.enabled);
		res.json({success: true, account});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '操作失败'});
	}
});


app.post('/api/uu/scan', async (req, res) => {
	try {
		const body = req.body || {};
		const account = await runUuDeliveryPass(body.accountName, body.gameId, {source: 'manual'});
		res.json({success: true, account});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '扫描发货失败'});
	}
});

app.get('/api/uu/orders/:account', async (req, res) => {
	try {
		const orders = await getUuWaitDeliverOrders(req.params.account);
		res.json({success: true, orders});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '读取待发货列表失败'});
	}
});

// CS2 自动上架：开关 + 手动触发一次上架扫描
app.post('/api/uu/list/auto', (req, res) => {
	try {
		const body = req.body || {};
		const account = setUuListAuto(body.accountName, !!body.enabled);
		res.json({success: true, account});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '操作失败'});
	}
});

app.post('/api/uu/list/scan', async (req, res) => {
	try {
		const body = req.body || {};
		const account = await runUuListingPass(body.accountName, {source: 'manual'});
		res.json({success: true, account});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '上架扫描失败'});
	}
});

app.post('/api/uu/poll-interval', (req, res) => {
	try {
		const minutes = Number((req.body || {}).minutes);
		if (!Number.isFinite(minutes) || minutes <= 0) {
			throw uuError(400, '请输入有效的轮询分钟数');
		}
		const pollIntervalMs = setUuPollInterval(minutes * 60 * 1000);
		res.json({success: true, pollIntervalMs});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '设置轮询间隔失败'});
	}
});

// 悠悠短信登录获取 token（两步：start 发码 → verify 登录）
app.post('/api/uu/login/start', async (req, res) => {
	try {
		const data = await startUuSmsLogin((req.body || {}).phone);
		res.json({success: true, ...data});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '发送验证码失败'});
	}
});

app.post('/api/uu/login/verify', async (req, res) => {
	try {
		const body = req.body || {};
		const data = await verifyUuSmsLogin({
			loginSessionId: body.loginSessionId,
			code: body.code,
			accountName: body.accountName,
			gameId: body.gameId
		});
		const {token, ...rest} = data || {};
		res.json({success: true, ...rest, tokenId: token ? uuTokenId({token, userId: rest.userId}) : ''});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '登录失败'});
	}
});

app.post('/api/uu/login/cancel', (req, res) => {
	const id = String((req.body || {}).loginSessionId || '');
	if (id) {
		uuLoginSessions.delete(id);
	}
	res.json({success: true});
});

// ===== 独立 token 管理（不依赖账号选择）=====
// 获取 token 后先存到这里(加密库 uu_tokens 表)，等下再绑到具体 Steam 账号

function loadUuTokens() {
	return store.uu.listTokens();
}

function saveUuTokens(tokens) {
	try {
		store.uu.replaceTokens(Array.isArray(tokens) ? tokens : []);
	} catch (err) {
		console.warn('[uu] 保存 token 列表失败:', err.message);
	}
}

// 下发给浏览器的 token 条目:不含 token 原文,只给稳定 id 和掩码;绑定/删除都按 id 进行。
function publicUuTokenEntry(entry) {
	const {token, ...rest} = entry || {};
	return {...rest, id: uuTokenId(entry || {}), tokenMask: maskUuToken(token)};
}

app.post('/api/uu/token/acquire', async (req, res) => {
	try {
		const body = req.body || {};
		const token = String(body.token || '').trim();
		const gameId = uuDefaultGameId(body.gameId); // 仅用于选查询网关，token 通用
		if (!token) {
			return res.status(400).json({success: false, error: 'token 不能为空'});
		}

		// 解析 JWT 拿身份
		const jwt = decodeJwt(token);
		const userId = jwt && jwt.Id ? String(jwt.Id) : '';
		const nickname = jwt && jwt.Name ? String(jwt.Name) : '';
		const jwtExp = jwt && jwt.exp ? Number(jwt.exp) : null;

		// 调旧 API 查绑定的 Steam 账号
		let linkedSteamId = '';
		try {
			const uu = new UuAccount(token, {gameId});
			const pull = await uu.getSteamCookiePull();
			linkedSteamId = pull.steamId || '';
		} catch (err) {
			// cookie/pull 失败不阻断，可能 token 没绑 Steam
		}

		const entry = {
			token,
			userId,
			nickname,
			linkedSteamId,
			jwtExp,
			acquiredAt: new Date().toISOString()
		};

		// 持久化：按 userId 去重，不按游戏（与 verifyUuSmsLogin 保持一致）
		const tokens = loadUuTokens();
		const idx = tokens.findIndex(t => t.userId === entry.userId);
		if (idx >= 0) {
			tokens[idx] = entry;
		} else {
			tokens.push(entry);
		}
		saveUuTokens(tokens);

		res.json({success: true, token: publicUuTokenEntry(entry)});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '保存 token 失败'});
	}
});

app.get('/api/uu/tokens', (req, res) => {
	try {
		res.json({success: true, tokens: loadUuTokens().map(publicUuTokenEntry)});
	} catch (err) {
		res.status(500).json({success: false, error: err.message || '读取 token 列表失败'});
	}
});

app.delete('/api/uu/token', (req, res) => {
	try {
		const body = req.body || {};
		// 按账号删除（行内“删除 Token”按钮）：解绑该账号并从 token 列表移除
		const accountName = String(body.accountName || '').trim();
		if (accountName) {
			const account = deleteUuAccountToken(accountName);
			return res.json({success: true, account});
		}
		// 未匹配到账号的 token：按 id 删除(浏览器只有 id)
		const tokenId = String(body.tokenId || '').trim();
		if (tokenId) {
			saveUuTokens(loadUuTokens().filter(t => uuTokenId(t) !== tokenId));
			return res.json({success: true});
		}
		// 兼容：按 token 字符串删除
		const token = String(body.token || '').trim();
		if (!token) {
			return res.status(400).json({success: false, error: 'tokenId、token 或 accountName 不能为空'});
		}
		let tokens = loadUuTokens();
		tokens = tokens.filter(t => t.token !== token);
		saveUuTokens(tokens);
		res.json({success: true});
	} catch (err) {
		res.status(err.statusCode || 500).json({success: false, error: err.message || '删除 token 失败'});
	}
});

// ===== 充值码兑换 =====
// 左侧账户(账号----密码,按行)与右侧充值码(按行)1:1 配对兑换。
// 多线程并发:按 concurrency 起 N 个 worker 从同一队列取任务,逐条通过
// wallet:redeem 事件回推结果(payload.index 为本次提交 pairs 数组内的下标,
// 前端用它映射回结果行,从而支持「只重试失败项」)。
const WALLET_REDEEM_MAX_PAIRS = 500;
const WALLET_REDEEM_MAX_CONCURRENCY = 10;
const WALLET_REDEEM_DEFAULT_CONCURRENCY = 3;

app.post('/api/wallet/redeem', (req, res) => {
	const body = req.body || {};
	const rawPairs = Array.isArray(body.pairs) ? body.pairs : [];
	const pairs = [];
	for (const item of rawPairs) {
		const account = String(item && item.account || '').trim();
		const password = item && item.password != null ? String(item.password) : '';
		const code = String(item && item.code || '').trim();
		if (!account || !code) {
			continue;
		}
		pairs.push({account, password, code});
	}

	if (!pairs.length) {
		return res.status(400).json({success: false, error: '没有可兑换的账户/充值码配对'});
	}
	if (pairs.length > WALLET_REDEEM_MAX_PAIRS) {
		return res.status(400).json({success: false, error: `单次最多兑换 ${WALLET_REDEEM_MAX_PAIRS} 条`});
	}

	let concurrency = Math.floor(Number(body.concurrency));
	if (!Number.isFinite(concurrency) || concurrency < 1) {
		concurrency = WALLET_REDEEM_DEFAULT_CONCURRENCY;
	}
	concurrency = Math.min(concurrency, WALLET_REDEEM_MAX_CONCURRENCY, pairs.length);

	const jobId = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
	const job = {id: jobId, pairs, concurrency, createdAt: Date.now()};
	res.json({success: true, jobId, total: pairs.length, concurrency});
	runWalletRedeemJob(job).catch(err => {
		console.error('[wallet] redeem job error', err);
		io.emit('wallet:redeem', {jobId, status: 'done', message: '任务异常终止'});
	});
});

function emitWalletRedeem(payload) {
	io.emit('wallet:redeem', payload);
}

// 兑换单条配对(自带兜底:任何异常都转成 error 结果,绝不抛出,以免拖垮 worker)。
async function redeemWalletPair(job, index) {
	const pair = job.pairs[index];
	emitWalletRedeem({jobId: job.id, index, account: pair.account, status: 'processing', message: '正在登录并兑换…'});

	// 本地 maFile 提供 shared_secret(自动 2FA);无密码时回退到本地 refreshToken。
	const profile = readLocalAccountProfile(pair.account);
	const sharedSecret = profile.sharedSecret || '';
	const refreshToken = pair.password ? '' : (profile.refreshToken || '');

	try {
		const result = await redeemForAccount({
			accountName: pair.account,
			password: pair.password,
			refreshToken,
			sharedSecret,
			code: pair.code,
			timeoutMs: 60000,
			logger: (level, message) => {
				emitWalletRedeem({jobId: job.id, index, account: pair.account, status: 'processing', logLevel: level, logMessage: message});
			}
		});
		emitWalletRedeem({
			jobId: job.id,
			index,
			account: pair.account,
			status: 'success',
			message: result.message,
			balance: result.formattedNewWalletBalance || ''
		});
	} catch (err) {
		emitWalletRedeem({
			jobId: job.id,
			index,
			account: pair.account,
			status: 'error',
			message: err && err.message ? err.message : '兑换失败'
		});
	}
}

async function runWalletRedeemJob(job) {
	let cursor = 0;
	async function worker() {
		while (true) {
			const index = cursor++;
			if (index >= job.pairs.length) {
				return;
			}
			await redeemWalletPair(job, index);
		}
	}

	const workerCount = Math.max(1, Math.min(job.concurrency, job.pairs.length));
	const workers = [];
	for (let i = 0; i < workerCount; i++) {
		workers.push(worker());
	}
	await Promise.all(workers);
	emitWalletRedeem({jobId: job.id, status: 'done', message: '全部处理完成'});
}

io.on('connection', socket => {
	socket.emit('hello', {ts: Date.now()});
});

server.listen(PORT, HOST, () => {
	const shownHost = HOST === '0.0.0.0' ? '<本机所有网卡>' : HOST;
	console.log(`Steam 工具台 listening on http://${shownHost}:${PORT}`);
	if (!auth.configured) {
		console.warn(`[auth] 尚未设置口令, 请用浏览器打开 /login 设置初始口令(设置前已锁定)`);
		console.warn(`[auth] 初始化令牌: ${auth.setupToken}  (本次启动有效;可用 SETUP_TOKEN 环境变量固定)`);
	}
});

// 未处理的 Promise 拒绝只记日志不退出:进程一退,所有在线 Steam 会话都会掉。
process.on('unhandledRejection', reason => {
	console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

// docker stop / Ctrl+C:先登出所有 Steam 会话再退出;10 秒兜底强退。
let shuttingDown = false;
function shutdown(signal) {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	console.log(`[shutdown] 收到 ${signal},登出 ${attempts.size} 个会话并关闭服务`);
	sessions.shutdown();   // 不改登录意图:下次启动照常自动恢复
	io.close();
	server.close(() => process.exit(0));
	if (typeof server.closeAllConnections === 'function') {
		server.closeAllConnections();
	}
	setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

sessions.start();
if (SESSION_RESTORE_ENABLED) {
	// 按登录意图恢复上次在线的账号:优先用保存的 refreshToken,失效再用名单里的密码 + maFile 令牌
	sessions.restoreAll(accountName => {
		const stored = findStoredAccount(accountName);
		if (!stored) {
			return null;   // 账号已从名单删除
		}
		const profile = readLocalAccountProfile(stored.accountName);
		const saved = store.sessions.get(safeName(stored.accountName));
		return {
			profile: {
				accountName: stored.accountName,
				remember: stored.remember !== false,
				sharedSecret: profile.sharedSecret || stored.sharedSecret || '',
				identitySecret: profile.identitySecret || '',
				hasMaFile: profile.hasMaFile,
				country: profile.country || stored.country || '',
				hasWallet: profile.hasWallet || stored.hasWallet,
				currency: profile.currency != null ? profile.currency : stored.currency,
				currencyISO: profile.currencyISO || '',
				balance: profile.balance != null ? profile.balance : stored.balance
			},
			refreshToken: saved && saved.refreshToken ? String(saved.refreshToken) : '',
			password: stored.password || ''
		};
	});
}

// 给新建的 Steam 客户端挂 CS2/TF2 GC 模块(会话本身由 src/steam/session-manager.ts 管理)。
// 尽早挂 GC 抓包(在 GC 欢迎消息到达前),这样连接时内嵌的初始 SO 缓存(含报价)也能被捕获。
function attachGameCoordinators(attempt, client) {
	try {
		const csgo = new GlobalOffensive(client);
		attempt.csgo = csgo;
		attachCs2GcEvents(attempt, csgo);
		cs2Terminal.attach(attempt);
	} catch (err) {
		addLog(attempt, 'warn', 'CS2 GC 初始化失败: ' + err.message);
	}
	try {
		const tf2 = new TeamFortress2(client);
		attempt.tf2 = tf2;
		attachTf2GcEvents(attempt, tf2);
	} catch (err) {
		addLog(attempt, 'warn', 'TF2 GC 初始化失败: ' + err.message);
	}
}

function attachCs2GcEvents(attempt, csgo) {
	csgo.on('connectedToGC', () => {
		attempt.cs2GcConnected = true;
		attempt.tf2GcConnected = false;
		attempt.activeGame = 'cs2';
		updateAttemptDefaultGcState(attempt);
		attempt.inventoryCount = countGcInventoryItems(csgo);
		attempt.inventorySource = 'gc';
		if (!attempt.inventoryCache || attempt.inventoryCache.source === 'gc') {
			attempt.inventoryCache = buildGcInventorySnapshot(attempt);
		}
		// 创世终端机:附加 GC 抓包监听(捕获报价/解封结果),幂等。
		try { cs2Terminal.attach(attempt); } catch (_) {}
		emitAttempt(attempt);
	});

	csgo.on('disconnectedFromGC', () => {
		attempt.cs2GcConnected = false;
		updateAttemptDefaultGcState(attempt);
		emitAttempt(attempt);
	});

	csgo.on('itemAcquired', () => {
		handleGcInventoryChanged(attempt, csgo);
	});

	csgo.on('itemChanged', () => {
		handleGcInventoryChanged(attempt, csgo);
	});

	csgo.on('itemRemoved', () => {
		handleGcInventoryChanged(attempt, csgo);
	});

	csgo.on('error', err => {
		attempt.cs2GcConnected = false;
		updateAttemptDefaultGcState(attempt);
		addLog(attempt, 'warn', 'GC 连接失败: ' + err.message);
		emitAttempt(attempt);
	});
}

function attachTf2GcEvents(attempt, tf2) {
	tf2.on('connectedToGC', () => {
		attempt.cs2GcConnected = false;
		attempt.tf2GcConnected = true;
		attempt.activeGame = 'tf2';
		updateAttemptDefaultGcState(attempt);
		emitAttempt(attempt);
	});

	tf2.on('disconnectedFromGC', () => {
		attempt.tf2GcConnected = false;
		updateAttemptDefaultGcState(attempt);
		emitAttempt(attempt);
	});
}

function handleGcInventoryChanged(attempt, csgo) {
	attempt.inventoryCount = countGcInventoryItems(csgo);
	if (!attempt.inventoryCache || attempt.inventoryCache.source === 'gc') {
		attempt.inventoryCache = buildGcInventorySnapshot(attempt);
	}
	emitAttempt(attempt);
}

function getPurchaseGame(req) {
	return normalizePurchaseGame(
		req && req.query && req.query.game
		|| req && req.body && req.body.game
	);
}

function saveSession(attempt) {
	sessions.saveSession(attempt);
}

function getAttempt(id, res) {
	const attempt = attempts.get(id);
	if (!attempt) {
		res.status(404).json({success: false, error: '任务不存在'});
		return null;
	}

	return attempt;
}

function addLog(attempt, level, message) {
	sessions.addLog(attempt, level, message);
}

function emitAttempt(attempt) {
	sessions.emit(attempt);
}

function publicAttempt(attempt) {
	return sessions.publicAttempt(attempt);
}

function safeName(value) {
	return String(value || 'session')
		.replace(/[^a-z0-9_.-]+/gi, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 80) || 'session';
}

function publicAccountProfile(profile) {
	return {
		accountName: profile.accountName,
		steamId: profile.steamID || profile.steamId || '',
		hasMaFile: !!profile.hasMaFile,
		hasIdentitySecret: !!profile.identitySecret,
		country: profile.country || '',
		hasWallet: !!profile.hasWallet,
		currency: profile.currency == null ? null : Number(profile.currency),
		currencyISO: profile.currencyISO || '',
		balance: profile.balance == null ? null : Number(profile.balance)
	};
}

// ===== 账户名单持久化(多浏览器同步) =====
// 只保存"耐久"字段;运行态(status/gcConnected/inventoryCount...)由前端登录后自行刷新,不落盘。
function sanitizeStoredAccount(account) {
	return normalizeStoredAccount(account);
}

function readAccountList() {
	return store.accounts.list();
}

// 整表替换;规范化与按账号名去重(保留首次出现的位置,值取最后一次)在 src/store/accounts.ts。
function writeAccountList(list) {
	return store.accounts.replaceAll(Array.isArray(list) ? list : []);
}

// 从名单中移除指定账号(删除账户时调用),返回是否有改动。
function removeAccountsFromList(accountNames) {
	return store.accounts.removeByNames(accountNames || []);
}

// 下发给浏览器的名单不含密码/shared_secret/一次性验证码,只给"有没有"的标记。
function publicStoredAccount(account) {
	const {password, sharedSecret, twoFactorCode, ...rest} = account;
	return {...rest, hasPassword: !!password, hasSharedSecret: !!sharedSecret};
}

// 浏览器推回来的名单里这几个字段通常为空(服务端从不下发),空值 = 沿用服务端已存的值,非空才覆盖。
function mergeClientAccountSecrets(list) {
	const stored = new Map(readAccountList().map(acc => [acc.accountName.toLowerCase(), acc]));
	return (Array.isArray(list) ? list : []).map(item => {
		const acc = sanitizeStoredAccount(item);
		if (!acc) {
			return null;
		}
		const prev = stored.get(acc.accountName.toLowerCase());
		if (prev) {
			if (!acc.password) acc.password = prev.password;
			if (!acc.sharedSecret) acc.sharedSecret = prev.sharedSecret;
			if (!acc.twoFactorCode) acc.twoFactorCode = prev.twoFactorCode;
		}
		return acc;
	}).filter(Boolean);
}

function findStoredAccount(accountName) {
	const key = String(accountName || '').trim().toLowerCase();
	if (!key) {
		return null;
	}
	return readAccountList().find(acc => acc.accountName.toLowerCase() === key) || null;
}

function readLocalAccountProfile(accountName) {
	const name = String(accountName || '').trim();
	const profile = {
		accountName: name,
		hasMaFile: false,
		sharedSecret: '',
		identitySecret: '',
		refreshToken: '',
		country: '',
		hasWallet: false,
		currency: null,
		currencyISO: '',
		balance: null
	};

	if (!name) {
		return profile;
	}

	const maFile = store.mafiles.get(name);
	if (maFile && typeof maFile === 'object') {
		profile.hasMaFile = true;
		profile.sharedSecret = String(maFile.shared_secret || maFile.sharedSecret || '').trim();
		profile.identitySecret = String(maFile.identity_secret || maFile.identitySecret || '').trim();
		profile.steamID = String(maFile.SteamID || maFile.steamID || '').trim();
		const session = maFile.Session && typeof maFile.Session === 'object' ? maFile.Session : null;
		if (session && session.RefreshToken) {
			profile.refreshToken = String(session.RefreshToken).trim();
		}
	}

	const cookies = readJsonFile(path.join(CONFIG_COOKIES_DIR, name + '.json'));
	if (cookies && typeof cookies === 'object' && !profile.refreshToken && cookies.refreshToken) {
		profile.refreshToken = String(cookies.refreshToken).trim();
	}

	const cache = readJsonFile(ACCOUNT_CACHE_FILE);
	const cached = findCachedAccount(cache, name);
	if (cached && typeof cached === 'object') {
		profile.currency = cached.currency == null ? null : Number(cached.currency);
		profile.currencyISO = String(cached.currencyISO || currencyIdToIso(profile.currency) || '').trim().toUpperCase();
		profile.balance = cached.balance == null ? null : Number(cached.balance);
		profile.hasWallet = profile.balance != null && Number.isFinite(profile.balance);
		profile.country = resolveAccountCountry({
			country: cached.country,
			currency: profile.currency,
			currencyISO: profile.currencyISO
		});
	}

	return profile;
}


function resolveAccountCountry(details) {
	const currencyISO = String((details && details.currencyISO) || currencyIdToIso(details && details.currency) || '').trim().toUpperCase();
	if (currencyISO && CURRENCY_ISO_TO_COUNTRY[currencyISO]) {
		return CURRENCY_ISO_TO_COUNTRY[currencyISO];
	}

	if (!currencyISO && details) {
		return normalizeCountryCode(details.country);
	}

	return '';
}

// 账户"国家/地区"内存缓存(accountName 小写 -> CC),避免重复请求商店页
const accountStoreCountryCache = new Map();
// 上次请求时间(accountName 小写 -> ms),给失败的账户加冷却,避免每次轮询都打 Steam
const accountStoreCountryFetchedAt = new Map();
const ACCOUNT_COUNTRY_COOLDOWN_MS = 5 * 60 * 1000;

// 用账户自己的 cookie 请求 Steam 商店账户页,解析出"账户国家/地区"。
// 这是账户在 Steam 上设置的商店国家(网页"国家/地区"显示的值),权威且不随登录 IP 变化;
// 数据源是商店页 #application_config 的 data-config JSON 里的 COUNTRY 字段。
//
// 注意:刚登录的账户只有 steamLoginSecure/sessionid 等,首次访问 /account/ 时 Steam 会 302
// 回自身并下发 browserid/Steam_Language/steamCountry,必须带上这些新 cookie 再请一次才会返回
// 200。Node fetch 跨重定向不带 Set-Cookie,所以这里手动跟随重定向并累积 cookie。
async function fetchAccountStoreCountry(attempt) {
	const cookies = resolveInventoryCookies(attempt);
	if (!cookies.length) {
		return '';
	}
	const jar = new Map();
	const putCookie = raw => {
		const kv = String(raw).split(';')[0];
		const idx = kv.indexOf('=');
		if (idx > 0) {
			jar.set(kv.slice(0, idx).trim(), kv.slice(idx + 1).trim());
		}
	};
	cookies.forEach(putCookie);
	const baseHeaders = {
		Accept: 'text/html,application/xhtml+xml',
		'Accept-Language': 'en-US,en;q=0.9',
		'User-Agent': (attempt && attempt.userAgent) || 'Mozilla/5.0'
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 9000);
	let url = 'https://store.steampowered.com/account/';
	try {
		for (let hop = 0; hop < 5; hop++) {
			const cookieHeader = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
			const res = await fetch(url, {headers: {...baseHeaders, Cookie: cookieHeader}, redirect: 'manual', signal: controller.signal});
			const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
			setCookies.forEach(putCookie);
			if (res.status >= 300 && res.status < 400) {
				const loc = res.headers.get('location');
				if (!loc) {
					throw new Error('账户页重定向缺少 location');
				}
				url = new URL(loc, url).href;
				if (/\/login\b/i.test(url)) {
					throw new Error('账户页跳转到登录页(cookie 已失效,需重新登录)');
				}
				continue;
			}
			if (!res.ok) {
				throw new Error('账户页 HTTP ' + res.status + '(cookie 可能已失效)');
			}
			const html = await res.text();
			// 必须确认是"已登录"的账户页,否则 application_config.COUNTRY 可能是按 IP 的访客值
			const loggedIn = /account_pulldown/.test(html)
				|| (attempt && attempt.steamID && html.includes(String(attempt.steamID)));
			if (!loggedIn) {
				throw new Error('账户页未登录(cookie 可能已失效)');
			}
			const m = html.match(/&quot;COUNTRY&quot;:&quot;([A-Za-z]{2})&quot;/)
				|| html.match(/"COUNTRY"\s*:\s*"([A-Za-z]{2})"/)
				|| html.match(/"countrycode"\s*:\s*"([A-Za-z]{2})"/);
			return m ? normalizeCountryCode(m[1]) : '';
		}
		throw new Error('账户页重定向次数过多(cookie 可能已失效)');
	} finally {
		clearTimeout(timer);
	}
}

// 在线账户登录拿到 WebSession 后,后台刷新其真实账户国家,更新 attempt 并下发(不阻塞登录)。
function refreshAttemptStoreCountry(attempt) {
	if (!attempt) {
		return;
	}
	const key = String(attempt.accountName || '').toLowerCase();
	fetchAccountStoreCountry(attempt).then(country => {
		if (key) {
			accountStoreCountryFetchedAt.set(key, Date.now());
		}
		if (!country) {
			return;
		}
		if (key) {
			accountStoreCountryCache.set(key, country);
		}
		if (country !== attempt.country) {
			attempt.country = country;
			addLog(attempt, 'info', '账户国家/地区: ' + country);
			saveSession(attempt);
			emitAttempt(attempt);
		}
	}).catch(err => {
		if (key) {
			accountStoreCountryFetchedAt.set(key, Date.now());
		}
		addLog(attempt, 'warn', '获取账户国家失败: ' + (err && err.message ? err.message : err));
	});
}

// 给账户列表(/api/accounts/meta)补全缺失的"国家/地区":用持久化的 cookie 查商店账户页。
// 整体有时间预算 + 并发上限 + 失败冷却,保证接口不会被网络请求长时间拖住。
async function resolveMissingAccountCountries(accounts) {
	const pending = Object.keys(accounts).filter(name => !accounts[name].country);
	if (!pending.length) {
		return;
	}
	const deadline = Date.now() + 6000;
	const queue = pending.slice();
	const worker = async () => {
		while (queue.length && Date.now() < deadline) {
			const name = queue.shift();
			const key = name.toLowerCase();
			const cached = accountStoreCountryCache.get(key);
			if (cached) {
				accounts[name].country = cached;
				continue;
			}
			const last = accountStoreCountryFetchedAt.get(key) || 0;
			if (Date.now() - last < ACCOUNT_COUNTRY_COOLDOWN_MS) {
				continue;
			}
			accountStoreCountryFetchedAt.set(key, Date.now());
			try {
				const country = await fetchAccountStoreCountry({accountName: name});
				if (country) {
					accountStoreCountryCache.set(key, country);
					accounts[name].country = country;
				}
			} catch {}
		}
	};
	const concurrency = Math.min(5, pending.length);
	await Promise.all(Array.from({length: concurrency}, worker));
}

function findCachedAccount(cache, accountName) {
	if (!cache || typeof cache !== 'object') {
		return null;
	}
	if (cache[accountName]) {
		return cache[accountName];
	}
	const lowered = accountName.toLowerCase();
	for (const key of Object.keys(cache)) {
		if (key.toLowerCase() === lowered) {
			return cache[key];
		}
	}
	return null;
}

// 不存在返回 null;损坏时先备份坏文件再返回 null(见 lib/atomic-file.js)。
function readJsonFile(file) {
	return readJsonFileSafe(file);
}

function countGcInventoryItems(csgo) {
	return getGcInventoryItems(csgo).length;
}

function hasGcAttribute(item, defIndex) {
	return Array.isArray(item && item.attribute)
		&& item.attribute.some(attribute => Number(attribute && attribute.def_index) === Number(defIndex));
}

function isGcDisplayInventoryItem(item) {
	if (!item || item.casket_id) {
		return false;
	}

	const flags = Number(item.flags || 0);
	if ((flags & 24) === 24) {
		return false;
	}

	if (Number(item.origin || 0) === 24 && hasGcAttribute(item, 277)) {
		return false;
	}

	return true;
}

function getGcInventoryItems(csgo) {
	if (!csgo || !Array.isArray(csgo.inventory)) {
		return [];
	}
	return csgo.inventory.filter(isGcDisplayInventoryItem);
}

function buildGcInventoryItemMap(csgo) {
	const map = new Map();
	for (const item of getGcInventoryItems(csgo)) {
		const assetid = String(item && item.id || '');
		if (!assetid) {
			continue;
		}
		map.set(assetid, item);
	}
	return map;
}

function buildGcInventorySnapshot(attempt) {
	const items = getGcInventoryItems(attempt.csgo)
		.map(item => normalizeGcInventoryItem(item))
		.sort((left, right) => {
			const leftPos = Number(left.position || 0);
			const rightPos = Number(right.position || 0);
			if (leftPos !== rightPos) {
				return leftPos - rightPos;
			}
			return String(left.assetid).localeCompare(String(right.assetid));
		});

	return {
		source: 'gc',
		fetchedAt: new Date().toISOString(),
		fetchedAtMs: Date.now(),
		itemCount: items.length,
		items,
		raw: {
			source: 'gc',
			items: Array.isArray(attempt.csgo && attempt.csgo.inventory)
				? attempt.csgo.inventory.map(item => serializeForJson(item))
				: []
		}
	};
}

function normalizeGcInventoryItem(item) {
	const details = describeGcItem(ITEMS_GAME_SCHEMA, item);
	const tradableAfter = details.tradableAfter ? new Date(details.tradableAfter) : null;
	return {
		assetid: String(item.id || ''),
		name: details.name,
		marketHashName: details.marketHashName,
		type: details.type || (item.def_index ? `DefIndex ${item.def_index}` : '-'),
		category: details.category,
		rarity: details.rarity,
		exterior: details.exterior,
		iconUrl: details.iconUrl,
		tradable: !tradableAfter || tradableAfter <= new Date(),
		marketable: null,
		amount: 1,
		position: Number(item.position || 0),
		paintIndex: Number.isFinite(item.paint_index) ? item.paint_index : null,
		paintSeed: Number.isFinite(item.paint_seed) ? item.paint_seed : null,
		paintWear: Number.isFinite(item.paint_wear) ? item.paint_wear : null,
		stickerCount: Array.isArray(details.stickers) ? details.stickers.length : 0,
		kind: details.kind,
		quality: details.quality,
		definitionIndex: details.definitionIndex,
		definitionInternalName: details.definitionInternalName,
		definitionDisplayName: details.definitionDisplayName,
		paintKit: details.paintKit,
		sprayKit: details.sprayKit,
		stickers: details.stickers,
		tradableAfter: details.tradableAfter,
		source: 'gc',
		raw: serializeForJson(item)
	};
}

async function getAttemptInventory(attempt, options) {
	const forceRefresh = !!(options && options.forceRefresh);
	if (!attempt.gcConnected) {
		const err = new Error('当前账号尚未连接 GC');
		err.statusCode = 409;
		throw err;
	}

	// 只把「社区源」的新鲜缓存当作可直接返回:连接 GC 时会预建一份 GC 源快照(用本地 schema,较新饰品名字/映射不准),
	// 若直接短路返回它,第一次开库存就会看到错误映射(要手动刷新才拉到正确的社区中文名)。所以 GC 源缓存不短路,
	// 继续去拉社区库存拿正确数据;仅当社区刚拉【失败】且在冷却期内时,才临时用 GC 兜底,避免每次开库存都反复重试。
	const cache = attempt.inventoryCache;
	const communityCooldownActive = attempt.communityInvTriedAt
		&& (Date.now() - attempt.communityInvTriedAt) < COMMUNITY_INV_RETRY_COOLDOWN_MS;
	if (!forceRefresh && isFreshInventoryCache(cache) && (cache.source === 'community' || communityCooldownActive)) {
		return publicInventorySnapshot(cache);
	}

	// 并发去重:同账号同一时刻只发一次社区库存请求,其余调用方(如库存页 + 终端机开箱页同时打开)
	// 等这同一个 Promise,避免「一个在拉、另一个看到过期 GC 快照(或冷却标志)就短路返回错误映射」。
	if (attempt.inventoryInflight) {
		return attempt.inventoryInflight;
	}

	const runFetch = (async () => {
		try {
			const snapshot = await fetchCommunityInventorySnapshot(attempt);
			attempt.inventoryCache = snapshot;
			attempt.inventoryCount = snapshot.itemCount;
			attempt.inventorySource = snapshot.source;
			attempt.communityInvTriedAt = 0;   // 成功:清掉失败冷却
			emitAttempt(attempt);
			return publicInventorySnapshot(snapshot);
		} catch (communityError) {
			// 失败才记时间戳,开启冷却:冷却期内先返回 GC 兜底,不反复重试社区接口。
			attempt.communityInvTriedAt = Date.now();
			const gcSnapshot = buildGcInventorySnapshot(attempt);
			if (gcSnapshot.itemCount > 0) {
				attempt.inventoryCache = gcSnapshot;
				attempt.inventoryCount = gcSnapshot.itemCount;
				attempt.inventorySource = gcSnapshot.source;
				emitAttempt(attempt);
				return publicInventorySnapshot(gcSnapshot);
			}
			throw communityError;
		}
	})();

	attempt.inventoryInflight = runFetch;
	try {
		return await runFetch;
	} finally {
		if (attempt.inventoryInflight === runFetch) attempt.inventoryInflight = null;
	}
}

function isFreshInventoryCache(cache) {
	return !!(cache && cache.fetchedAtMs && (Date.now() - cache.fetchedAtMs) < INVENTORY_CACHE_TTL_MS);
}

function publicInventorySnapshot(snapshot) {
	return {
		source: snapshot.source,
		fetchedAt: snapshot.fetchedAt,
		itemCount: Number(snapshot.itemCount || 0),
		items: Array.isArray(snapshot.items) ? snapshot.items : [],
		raw: snapshot.raw || null
	};
}

purchase.catalog.preload();
initUuDelivery();

// 「买游戏」「市场求购」都是纯 cookie 的 HTTP 重放(steamStorePurchase / steamMarketBuyOrder),
// 不需要活的 steam-user 连接,只要账号有有效 WebSession cookie 且未被手动登出即可用。
// 这里特意不用 isAttemptOnline(src/steam/attempts.ts)—— 那个要求 status 仍是 logged_on/web_session,
// 会把「登录后 steam 客户端断线(status=disconnected)」的账号误判为离线,导致挂求购/买游戏页选不到。
// 与账户管理页「在线/登录成功」口径对齐:前端 collapseAttemptStatus 会把登录后断线/失败的账号
// 仍折叠成「登录成功」并归入「在线」组(有 cookie 即说明曾成功拿到 WebSession),这里据此放行。
function isAttemptUsableForCookieFlow(attempt) {
	return !!(attempt
		&& attempt.accountName
		&& String(attempt.status || '') !== 'logged_out');
}

// ===== 买游戏:辅助函数 =====

// 按内部 id 或账号名(不区分大小写)查找 attempt。
function findAttemptByKey(key) {
	if (!key) {
		return null;
	}
	if (attempts.has(key)) {
		return attempts.get(key);
	}
	const lower = key.toLowerCase();
	for (const attempt of attempts.values()) {
		if (String(attempt.accountName || '').toLowerCase() === lower) {
			return attempt;
		}
	}
	return null;
}

// 可买游戏的在线账户:已登录 + 有 WebSession cookie。
function listBuyGameOnlineAccounts() {
	return Array.from(attempts.values())
		.filter(isAttemptUsableForCookieFlow)
		.filter(attempt => resolveInventoryCookies(attempt).length > 0)
		.sort((left, right) => String(left.accountName || '').localeCompare(String(right.accountName || ''), 'zh-CN'))
		.map(attempt => ({
			account: attempt.accountName,
			attemptId: attempt.id,
			personaName: attempt.personaName || '',
			country: attempt.country || attempt.loginGeoCountry || '',
			hasWallet: !!attempt.hasWallet,
			currency: attempt.currency == null ? null : Number(attempt.currency),
			currencyISO: String(attempt.currencyISO || currencyIdToIso(attempt.currency) || 'USD').trim().toUpperCase(),
			balance: attempt.balance == null ? null : Number(attempt.balance)
		}));
}

// 解析 packageid → 游戏名/价格(用账号的 cookie/UA/国家请求,拿区域价)。
async function resolveSteamPackageInfo(packageId, country, attempt) {
	const cc = String(country || 'US').trim().toUpperCase() || 'US';
	const headers = {Accept: 'application/json, text/plain, */*', 'User-Agent': (attempt && attempt.userAgent) || 'Mozilla/5.0'};
	const cookies = attempt ? resolveInventoryCookies(attempt) : [];
	if (cookies.length) {
		headers.Cookie = cookies.join('; ');
	}
	const url = `https://store.steampowered.com/api/packagedetails?packageids=${packageId}&cc=${cc}&l=schinese`;
	const res = await fetch(url, {headers});
	if (!res.ok) {
		throw new Error(`packagedetails HTTP ${res.status}`);
	}
	const payload = await res.json();
	const entry = payload && payload[packageId];
	if (!entry || !entry.success || !entry.data) {
		throw new Error('未找到该 subid(可能不存在或当前区域不可见)');
	}
	const data = entry.data;
	const price = data.price || null;
	const apps = Array.isArray(data.apps) ? data.apps : [];
	return {
		packageId,
		name: String(data.name || (apps[0] && apps[0].name) || `Package ${packageId}`),
		appid: apps.length ? Number(apps[0].id) : 0,
		priceCents: price ? Number(price.final) : 0,
		currencyISO: price ? String(price.currency || '').toUpperCase() : '',
		discountPercent: price ? Number(price.discount_percent || 0) : 0,
		available: !!price || (data.is_free_license === true)
	};
}

// ===== 买游戏:任务模型与执行 =====

function emitBuyGameTask(task, eventName = 'buygame:task-updated') {
	io.emit(eventName, publicBuyGameTask(task));
}

function publicBuyGameTask(task) {
	return {
		id: task.id,
		status: task.status,
		dryRun: !!task.dryRun,
		concurrency: Number(task.concurrency || BUYGAME_DEFAULT_CONCURRENCY),
		createdAt: task.createdAt,
		startedAt: task.startedAt,
		finishedAt: task.finishedAt,
		totalAccounts: Number(task.totalAccounts || 0),
		processedAccounts: Number(task.processedAccounts || 0),
		successCount: Number(task.successCount || 0),
		failCount: Number(task.failCount || 0),
		accounts: Array.isArray(task.accounts) ? task.accounts.map(acc => ({
			account: acc.account,
			attemptId: acc.attemptId,
			status: acc.status,
			country: acc.country,
			currency: acc.currency == null ? null : Number(acc.currency),
			currencyISO: acc.currencyISO,
			packageIds: acc.packageIds.slice(),
			balanceBefore: acc.balanceBefore,
			spentCents: acc.spentCents == null ? null : Number(acc.spentCents),
			transId: acc.transId || '',
			error: acc.error || '',
			updatedAt: acc.updatedAt || ''
		})) : []
	};
}

function createBuyGameTask(items, dryRun, concurrency) {
	const createdAt = new Date().toISOString();
	const accounts = items.map(item => ({
		attemptId: item.attempt.id,
		account: item.attempt.accountName,
		status: 'queued',
		country: item.attempt.country || item.attempt.loginGeoCountry || '',
		currency: item.attempt.currency == null ? null : Number(item.attempt.currency),
		currencyISO: String(item.attempt.currencyISO || currencyIdToIso(item.attempt.currency) || 'USD').toUpperCase(),
		packageIds: item.packageIds.slice(),
		balanceBefore: item.attempt.balance == null ? null : Number(item.attempt.balance),
		spentCents: null,
		transId: '',
		error: '',
		updatedAt: createdAt
	}));
	const task = {
		id: Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
		status: 'queued',
		dryRun: !!dryRun,
		concurrency: Math.max(1, Math.min(BUYGAME_MAX_CONCURRENCY, Math.round(Number(concurrency)) || BUYGAME_DEFAULT_CONCURRENCY)),
		createdAt,
		startedAt: '',
		finishedAt: '',
		totalAccounts: accounts.length,
		processedAccounts: 0,
		successCount: 0,
		failCount: 0,
		accounts,
		_items: items
	};
	buyGameTasks.unshift(task);
	buyGameTaskIndex.set(task.id, task);
	if (buyGameTasks.length > BUYGAME_TASK_LIMIT) {
		const removed = buyGameTasks.pop();
		if (removed) {
			buyGameTaskIndex.delete(removed.id);
		}
	}
	emitBuyGameTask(task, 'buygame:task-created');
	return task;
}

function startBuyGameTask(task) {
	setTimeout(() => {
		runBuyGameTask(task).catch(err => {
			task.status = 'failed';
			task.finishedAt = new Date().toISOString();
			emitBuyGameTask(task, 'buygame:task-completed');
			console.error('[buygame] task failed:', err && err.message);
		});
	}, 0);
}

async function runBuyGameTask(task) {
	if (!task || task.status !== 'queued') {
		return;
	}
	task.status = 'running';
	task.startedAt = new Date().toISOString();
	emitBuyGameTask(task);

	// 单个账号的购买流程(各账号互不依赖,可并发执行)
	const processAccount = async (i) => {
		const acc = task.accounts[i];
		const attempt = task._items[i].attempt;
		acc.status = 'running';
		acc.updatedAt = new Date().toISOString();
		emitBuyGameTask(task);

		try {
			const cookies = resolveInventoryCookies(attempt);
			if (!cookies.length) {
				throw new Error('账号缺少 WebSession cookies,请重新登录');
			}
			const result = await steamStorePurchaser.purchasePackages({
				cookies,
				sessionid: attempt.webSessionID,
				userAgent: attempt.userAgent,
				country: attempt.country || attempt.loginGeoCountry || 'US',
				currency: attempt.currency,
				packageIds: acc.packageIds,
				dryRun: task.dryRun
			});
			acc.transId = result.transId || '';
			acc.spentCents = result.price ? Number(result.price.finalCents) : null;
			acc.status = task.dryRun ? 'verified' : 'success';
			if (!task.dryRun) {
				task.successCount++;
			}
		} catch (err) {
			acc.status = 'failed';
			acc.error = err && err.message ? err.message : '购买失败';
			task.failCount++;
		}
		acc.updatedAt = new Date().toISOString();
		task.processedAccounts++;
		emitBuyGameTask(task);
	};

	// 多线程(并发)执行:开 N 个 worker 从共享游标取账号,N = task.concurrency。
	// JS 单线程事件循环,cursor++ 与计数自增都在 await 之间同步完成,无竞态。
	const concurrency = Math.max(1, Math.min(BUYGAME_MAX_CONCURRENCY, Number(task.concurrency) || BUYGAME_DEFAULT_CONCURRENCY));
	let cursor = 0;
	const worker = async () => {
		while (cursor < task.accounts.length) {
			const i = cursor++;
			await processAccount(i);
		}
	};
	await Promise.all(Array.from({length: Math.min(concurrency, task.accounts.length)}, worker));

	task.status = 'completed';
	task.finishedAt = new Date().toISOString();
	emitBuyGameTask(task, 'buygame:task-completed');
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCommunityInventorySnapshot(attempt) {
	if (!attempt.steamID) {
		const err = new Error('当前账号缺少 SteamID，无法读取库存');
		err.statusCode = 409;
		throw err;
	}

	const cookies = resolveInventoryCookies(attempt);
	if (!cookies.length) {
		const err = new Error('当前账号没有可用的 WebSession cookies');
		err.statusCode = 409;
		throw err;
	}

	const cookieHeader = cookies.join('; ');
	const items = [];
	const rawPages = [];
	const gcItemsByAssetId = buildGcInventoryItemMap(attempt.csgo);
	let startAssetId = '';
	let pages = 0;

	do {
		const payload = await fetchCommunityInventoryPage(attempt.steamID, cookieHeader, startAssetId, attempt.userAgent);
		rawPages.push(payload);
		items.push(...normalizeCommunityInventoryPage(payload, gcItemsByAssetId));
		startAssetId = payload.more_items ? String(payload.last_assetid || '') : '';
		pages++;
	} while (startAssetId && pages < 20);

	return {
		source: 'community',
		fetchedAt: new Date().toISOString(),
		fetchedAtMs: Date.now(),
		itemCount: items.length,
		items,
		raw: {
			source: 'community',
			pages: rawPages
		}
	};
}

async function fetchCommunityInventoryPage(steamID, cookieHeader, startAssetId, userAgent) {
	const url = new URL(`https://steamcommunity.com/inventory/${steamID}/${INVENTORY_APP_ID}/${INVENTORY_CONTEXT_ID}`);
	url.searchParams.set('l', 'schinese');
	url.searchParams.set('count', String(INVENTORY_PAGE_SIZE));
	if (startAssetId) {
		url.searchParams.set('start_assetid', startAssetId);
	}

	const response = await fetch(url, {
		headers: {
			Accept: 'application/json, text/plain, */*',
			Cookie: cookieHeader,
			Referer: `https://steamcommunity.com/profiles/${steamID}/inventory/`,
			'User-Agent': userAgent || 'Mozilla/5.0'
		}
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		const err = new Error(body && body.length < 160 ? body : `库存请求失败: HTTP ${response.status}`);
		err.statusCode = response.status === 401 || response.status === 403 ? 409 : 502;
		throw err;
	}

	const payload = await response.json();
	if (!payload || (payload.success !== 1 && payload.success !== true)) {
		const err = new Error(payload && payload.error ? payload.error : '库存响应无效');
		err.statusCode = 502;
		throw err;
	}

	return payload;
}

function normalizeCommunityInventoryPage(payload, gcItemsByAssetId = null) {
	const descriptions = new Map();
	for (const description of payload.descriptions || []) {
		descriptions.set(`${description.classid}_${description.instanceid}`, description);
	}

	return (payload.assets || []).map(asset => {
		const assetid = String(asset.assetid || asset.id || '');
		const description = descriptions.get(`${asset.classid}_${asset.instanceid}`) || {};
		const tags = Array.isArray(description.tags) ? description.tags : [];
		const gcItem = gcItemsByAssetId instanceof Map ? gcItemsByAssetId.get(assetid) : null;
		const gcTradableAfter = toIsoString(gcItem && gcItem.tradable_after);
		const tradableAfter = gcTradableAfter || extractCommunityTradableAfter(description);
		const isTradable = tradableAfter
			? new Date(tradableAfter).getTime() <= Date.now()
			: description.tradable !== 0;
		return {
			assetid,
			name: String(description.name || description.market_name || description.market_hash_name || `Asset ${asset.assetid || ''}`),
			marketHashName: String(description.market_hash_name || ''),
			type: String(pickTag(tags, 'Type') || description.type || '-'),
			category: String(pickTag(tags, 'Category') || ''),
			rarity: String(pickTag(tags, 'Rarity') || ''),
			exterior: String(pickTag(tags, 'Exterior') || ''),
			iconUrl: description.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${description.icon_url}/96fx96f` : '',
			tradable: isTradable,
			marketable: description.marketable !== 0,
			tradableAfter,
			amount: Number(asset.amount || 1),
			position: 0,
			source: 'community',
			raw: {
				asset,
				description,
				gcItem: gcItem ? serializeForJson(gcItem) : null
			}
		};
	});
}

function extractCommunityTradableAfter(description) {
	if (!description || typeof description !== 'object') {
		return '';
	}

	for (const candidate of [description.cache_expiration, description.item_expiration]) {
		const iso = toIsoString(candidate);
		if (iso) {
			return iso;
		}
	}

	const fields = [
		description.owner_descriptions,
		description.descriptions,
		description.fraudwarnings
	];

	for (const field of fields) {
		if (!Array.isArray(field)) {
			continue;
		}

		for (const entry of field) {
			const text = stripHtml(entry && entry.value ? entry.value : entry);
			if (!text) {
				continue;
			}

			const direct = toIsoString(text);
			if (direct) {
				return direct;
			}

			const normalized = text
				.replace(/Tradable\s*After\s*/i, '')
				.replace(/Marketable\s*After\s*/i, '')
				.replace(/[()]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();
			const parsed = toIsoString(normalized);
			if (parsed) {
				return parsed;
			}
		}
	}

	return '';
}

function stripHtml(value) {
	return String(value == null ? '' : value)
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function toIsoString(value) {
	if (!value) {
		return '';
	}

	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function pickTag(tags, category) {
	const tag = tags.find(item => item && (item.category === category || item.category_name === category));
	return tag ? (tag.localized_tag_name || tag.name || tag.internal_name || '') : '';
}

function resolveInventoryCookies(attempt) {
	if (Array.isArray(attempt.cookies) && attempt.cookies.length) {
		return attempt.cookies;
	}

	const session = store.sessions.get(safeName(attempt.accountName || attempt.steamID || attempt.id));
	if (session && Array.isArray(session.cookies) && session.cookies.length) {
		return session.cookies;
	}

	const cookiesFile = path.join(CONFIG_COOKIES_DIR, safeName(attempt.accountName) + '.json');
	const cookieData = readJsonFile(cookiesFile);
	const rawCookieData = readJsonFile(path.join(CONFIG_COOKIES_DIR, String(attempt.accountName || '').trim() + '.json'));
	const source = cookieData || rawCookieData;
	if (source) {
		if (Array.isArray(source.cookies) && source.cookies.length) {
			return source.cookies;
		}
		if (typeof source.cookieHeader === 'string' && source.cookieHeader.trim()) {
			return source.cookieHeader.split(/;\s*/).filter(Boolean);
		}
	}

	return [];
}

function serializeForJson(value, seen = new WeakSet()) {
	if (value == null) {
		return value;
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Buffer.isBuffer(value)) {
		return {
			type: 'Buffer',
			hex: value.toString('hex')
		};
	}
	if (Array.isArray(value)) {
		return value.map(item => serializeForJson(item, seen));
	}
	if (typeof value === 'object') {
		if (seen.has(value)) {
			return '[Circular]';
		}
		if (isLongLike(value)) {
			try {
				return value.toString();
			} catch {}
		}
		seen.add(value);
		const output = {};
		for (const [key, item] of Object.entries(value)) {
			if (typeof item === 'function') {
				continue;
			}
			output[key] = serializeForJson(item, seen);
		}
		seen.delete(value);
		return output;
	}
	return String(value);
}

function isLongLike(value) {
	return !!(
		value
		&& typeof value === 'object'
		&& typeof value.low === 'number'
		&& typeof value.high === 'number'
		&& Object.prototype.hasOwnProperty.call(value, 'unsigned')
	);
}

// ===================== UU(悠悠有品)发货模块 =====================

function uuError(statusCode, message) {
	const err = new Error(message);
	err.statusCode = statusCode;
	return err;
}

function normalizeUuGameId(value) {
	const text = String(value == null ? '' : value).trim().toLowerCase();
	if (text === '730' || text === 'cs2' || text === 'csgo') {
		return String(CS2_APP_ID);
	}
	return String(TF2_APP_ID); // 默认 TF2=440
}

// 「没指定游戏」时用的默认游戏 = CS2。
// normalizeUuGameId 的缺省是 TF2，那是给「明确选了游戏的发货开关」用的；
// 而 token 获取/绑定本来就与游戏无关，缺省必须跟登录路径一致(登录、cookie-pull 都写死 730)，
// 否则不传 gameId 会被悄悄判成 TF2，拿 TF2 网关去校验一个通用 token。
function uuDefaultGameId(gameId) {
	const text = String(gameId == null ? '' : gameId).trim();
	return text ? normalizeUuGameId(text) : String(CS2_APP_ID);
}

function uuGameLabel(gameId) {
	return String(gameId) === String(CS2_APP_ID) ? 'CS2' : 'TF2';
}

function maskUuToken(token) {
	const text = String(token || '');
	if (!text) {
		return '';
	}
	if (text.length <= 12) {
		return '****';
	}
	return text.slice(0, 4) + '…' + text.slice(-6);
}

// 取/建某账号某游戏的发货子状态（每游戏独立）
function gameDelivery(state, gameId) {
	const gid = String(gameId);
	if (!state.byGame) state.byGame = {};
	if (!state.byGame[gid]) {
		state.byGame[gid] = {
			auto: false,
			pollTimer: null,
			running: false,
			status: 'idle', // idle | scanning | error
			lastScanAt: '',
			lastError: '',
			stats: {scans: 0, delivered: 0, failed: 0, skipped: 0},
			delivered: new Set(),     // 本会话已成功发货的 orderNo
			orderCooldown: new Map()  // orderNo -> 冷却截止(ms)
		};
	}
	return state.byGame[gid];
}

function ensureUuState(accountName) {
	const name = String(accountName || '').trim();
	let state = uuDelivery.get(name);
	if (state) {
		return state;
	}
	state = {
		accountName: name,
		token: '',
		gameId: String(TF2_APP_ID), // 最近一次绑定的游戏（仅展示提示用）
		nickname: '',
		userId: null,
		jwtExp: null,
		boundAt: '',
		recentOrders: [],
		logs: [],
		byGame: {}, // 每游戏发货子状态（lazily 创建）见 gameDelivery()
		// ===== CS2 自动上架（与发货并行的独立子系统） =====
		listAuto: false,           // 是否开启自动上架
		listTimer: null,           // 上架轮询定时器
		listRunning: false,        // 本轮上架进行中（防重入）
		listStatus: 'idle',        // idle | listing | error
		lastListAt: '',
		listLastError: '',
		listStats: {scans: 0, listed: 0, failed: 0, skipped: 0, noAbrade: 0, repriced: 0},
		listConfig: null           // {maxPrice, whitelist:[], blacklist:[], dryRun, reprice}
	};
	uuDelivery.set(name, state);
	return state;
}

function addUuLog(state, level, message) {
	const entry = {
		level,
		time: new Date().toLocaleTimeString('zh-CN', {hour12: false}),
		message
	};
	state.logs.push(entry);
	if (state.logs.length > 200) {
		state.logs.shift();
	}
	const line = `[uu:${state.accountName}] ${message}`;
	if (level === 'error') {
		console.error(line);
	} else if (level === 'warn') {
		console.warn(line);
	}
	// 推送到前端右侧实时日志（含订单 id 与发货结果）
	io.emit('uu:log', {accountName: state.accountName, level, message, time: entry.time});
}

function loadUuConfig() {
	const raw = store.uu.loadDeliveryConfig();
	if (!raw || typeof raw !== 'object') {
		return;
	}
	if (raw.__settings__ && raw.__settings__.pollIntervalMs != null) {
		UU_POLL_INTERVAL_MS = clampUuPollMs(raw.__settings__.pollIntervalMs);
	}
	for (const [accountName, cfg] of Object.entries(raw)) {
		const name = String(accountName || '').trim();
		if (!name || name.startsWith('__') || !cfg || typeof cfg !== 'object') {
			continue;
		}
		const token = String(cfg.token || '').trim();
		if (!token) {
			continue;
		}
		const state = ensureUuState(name);
		state.token = token;
		state.gameId = normalizeUuGameId(cfg.gameId);
		state.nickname = String(cfg.nickname || '');
		state.userId = cfg.userId == null ? null : String(cfg.userId);
		state.jwtExp = cfg.jwtExp == null ? null : Number(cfg.jwtExp);
		state.boundAt = String(cfg.boundAt || '');
		state.listAuto = !!cfg.listAuto;
		state.listConfig = cfg.listConfig && typeof cfg.listConfig === 'object' ? cfg.listConfig : null;
		// 每游戏发货开关
		if (cfg.delivery && typeof cfg.delivery === 'object') {
			for (const gid of DELIVER_GAME_IDS) {
				gameDelivery(state, gid).auto = !!(cfg.delivery[gid] && cfg.delivery[gid].auto);
			}
		} else {
			// 迁移旧配置：单游戏 {auto, gameId} → 对应游戏开关
			gameDelivery(state, normalizeUuGameId(cfg.gameId)).auto = cfg.auto !== false;
		}
	}
}

function saveUuConfig() {
	const out = {};
	out.__settings__ = {pollIntervalMs: UU_POLL_INTERVAL_MS};
	for (const [name, state] of uuDelivery) {
		if (!state.token) {
			continue;
		}
		const delivery = {};
		for (const gid of DELIVER_GAME_IDS) {
			if (state.byGame && state.byGame[gid]) delivery[gid] = {auto: !!state.byGame[gid].auto};
		}
		out[name] = {
			token: state.token,
			gameId: state.gameId,
			nickname: state.nickname || '',
			userId: state.userId == null ? null : String(state.userId),
			jwtExp: state.jwtExp == null ? null : Number(state.jwtExp),
			boundAt: state.boundAt || '',
			delivery,
			listAuto: !!state.listAuto,
			listConfig: state.listConfig || null
		};
	}
	try {
		store.uu.saveDeliveryConfig(out);
	} catch (err) {
		console.warn('[uu] 保存发货配置失败:', err.message);
	}
}


// 按 SteamID 查找已登录的 attempt（用于 UU token 自动匹配绑定）
function findAttemptBySteamId(steamId) {
	const sid = String(steamId || '').trim();
	if (!sid) return null;
	for (const attempt of attempts.values()) {
		if (attempt.steamID === sid && attempt.accountName) return attempt;
	}
	return null;
}
function initUuDelivery() {
	try {
		loadUuConfig();
	} catch (err) {
		console.warn('[uu] 载入发货配置失败:', err.message);
	}
	for (const state of uuDelivery.values()) {
		if (state.token) {
			for (const gid of DELIVER_GAME_IDS) {
				if (gameDelivery(state, gid).auto) startUuPolling(state, gid);
			}
			if (state.listAuto) startUuListPolling(state);
		}
	}
}

// 发货需要：steam 账号在线 + WebSession cookies + identity_secret(手机确认)
function uuAttemptReadiness(accountName) {
	const attempt = findOnlineAttempt(attempts.values(), accountName);
	if (!attempt) {
		return {attempt: null, online: false, hasCookies: false, hasIdentitySecret: false, steamID: ''};
	}
	return {
		attempt,
		online: true,
		hasCookies: Array.isArray(attempt.cookies) && attempt.cookies.length > 0,
		hasIdentitySecret: !!attempt.identitySecret,
		steamID: attempt.steamID || ''
	};
}

function publicUuAccount(accountName) {
	const name = String(accountName || '').trim();
	const state = uuDelivery.get(name) || null;
	const ready = uuAttemptReadiness(name);
	const profile = state ? null : readLocalAccountProfile(name);
	// 每游戏发货状态
	const delivery = {};
	for (const gid of DELIVER_GAME_IDS) {
		const g = state && state.byGame && state.byGame[gid] ? state.byGame[gid] : null;
		delivery[gid] = {
			gameId: gid,
			gameLabel: uuGameLabel(gid),
			auto: !!(g && g.auto),
			status: g ? g.status : 'idle',
			lastScanAt: g ? g.lastScanAt : '',
			lastError: g ? g.lastError : '',
			stats: g ? {...g.stats} : {scans: 0, delivered: 0, failed: 0, skipped: 0}
		};
	}
	return {
		accountName: name,
		bound: !!(state && state.token),
		gameId: state ? state.gameId : String(TF2_APP_ID),
		nickname: state ? state.nickname : '',
		// UU 用户 id：前端用它把已获取的 token 与本行对应起来，
		// 从而判断哪些 token 还没匹配到「账户管理」里的账号。
		userId: state && state.userId ? String(state.userId) : '',
		tokenMask: state ? maskUuToken(state.token) : '',
		tokenExpiresAt: state && state.jwtExp ? new Date(state.jwtExp * 1000).toISOString() : '',
		tokenExpired: !!(state && state.jwtExp && state.jwtExp * 1000 < Date.now()),
		delivery, // 每游戏: {gameId, gameLabel, auto, status, lastScanAt, lastError, stats}
		recentOrders: state ? state.recentOrders.slice(0, 20) : [],
		logs: state ? state.logs.slice(-60) : [],
		online: ready.online,
		hasCookies: ready.hasCookies,
		hasIdentitySecret: ready.hasIdentitySecret,
		hasMaFile: state ? ready.hasIdentitySecret : !!(profile && profile.hasMaFile),
		steamID: ready.steamID,
		// CS2 自动上架
		listAuto: state ? !!state.listAuto : false,
		listStatus: state ? state.listStatus : 'idle',
		lastListAt: state ? state.lastListAt : '',
		listLastError: state ? state.listLastError : '',
		listStats: state ? {...state.listStats} : {scans: 0, listed: 0, failed: 0, skipped: 0, noAbrade: 0, repriced: 0}
	};
}

// 发货列表由「已获取的 UU token」驱动，不再把当前在线的 Steam 账号也塞进来。
// token 由用户自行获取，再按 UU 绑定的 SteamID 与「账户管理」里的账号比对绑定；
// 账号是否在线只是行内的提示（离线时前端给出「登录账户」按钮），不决定是否入列。
function listUuAccounts() {
	const names = new Set();
	for (const [name, state] of uuDelivery) {
		if (state.token) {
			names.add(name);
		}
	}
	return Array.from(names)
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right, 'zh-CN'))
		.map(publicUuAccount);
}

function emitUuAccount(accountName) {
	io.emit('uu:update', publicUuAccount(accountName));
}

async function bindUuToken(accountName, token, gameId) {
	const name = String(accountName || '').trim();
	const tok = String(token || '').trim();
	if (!name) {
		throw uuError(400, '账号不能为空');
	}
	if (!tok) {
		throw uuError(400, 'token 不能为空');
	}
	// gid 只用来选校验网关(token 通用)；不传就走 CS2，别落到 TF2 上去校验。
	const gid = uuDefaultGameId(gameId);
	const state = ensureUuState(name);

	let account;
	try {
		// UuAccount.create 会解 JWT 并打一次 waitDeliverList 验证 token 有效
		account = await UuAccount.create(tok, {
			gameId: gid,
			logger: (level, message) => {
				if (level !== 'debug') {
					addUuLog(state, level, message);
				}
			}
		});
	} catch (err) {
		throw uuError(400, 'token 校验失败: ' + (err && err.message ? err.message : err));
	}

	state.token = tok;
	state.gameId = gid;
	state.nickname = account.getUserNickname() || '';
	state.userId = account.userId || null;
	state.jwtExp = account.jwtExp || null;
	state.boundAt = new Date().toISOString();
	addUuLog(
		state,
		'info',
		`已绑定 token：${state.nickname || '(无昵称)'} | 到期 ${state.jwtExp ? new Date(state.jwtExp * 1000).toLocaleString('zh-CN') : '未知'}（在 CS2/TF2 开关里分别开启自动发货）`
	);
	saveUuConfig();
	emitUuAccount(name);
	return publicUuAccount(name);
}


// 删除某账号已获取/绑定的 token：停轮询 + 清空绑定状态 + 从 token 列表移除
function deleteUuAccountToken(accountName) {
	const name = String(accountName || '').trim();
	if (!name) {
		throw uuError(400, '账号不能为空');
	}
	const state = uuDelivery.get(name);
	if (!state || !state.token) {
		throw uuError(409, '该账号尚未绑定 token');
	}
	const removedToken = state.token;
	const removedUserId = state.userId == null ? '' : String(state.userId); // 必须在下面清空 state 之前取
	for (const gid of DELIVER_GAME_IDS) {
		stopUuPolling(state, gid);
		if (state.byGame && state.byGame[gid]) state.byGame[gid].auto = false;
	}
	stopUuListPolling(state);
	state.token = '';
	state.listAuto = false;
	state.nickname = '';
	state.userId = null;
	state.jwtExp = null;
	state.boundAt = '';
	addUuLog(state, 'info', '已删除该账号的 UU token，自动发货已停止');
	saveUuConfig();
	// 同步从已获取 token 列表中移除该 token。
	// 按 userId 删(顺带兼容按 token 字符串)：历史上同一 UU 账号可能因为按游戏分开存
	// 而留下多条记录，只按 token 字符串过滤会漏删，残留那条会被前端自动绑定逻辑再绑回来。
	try {
		const tokens = loadUuTokens().filter(t =>
			t.token !== removedToken && !(removedUserId && String(t.userId) === removedUserId));
		saveUuTokens(tokens);
	} catch (err) {
		console.warn('[uu] 清理 token 列表失败:', err.message);
	}
	emitUuAccount(name);
	return publicUuAccount(name);
}


function setUuAuto(accountName, gameId, enabled) {
	const name = String(accountName || '').trim();
	const state = uuDelivery.get(name);
	if (!state || !state.token) {
		throw uuError(409, '该账号尚未绑定 token');
	}
	const gid = normalizeUuGameId(gameId);
	const g = gameDelivery(state, gid);
	g.auto = !!enabled;
	if (g.auto) {
		startUuPolling(state, gid);
		addUuLog(state, 'info', `已开启 ${uuGameLabel(gid)} 自动发货轮询`);
	} else {
		stopUuPolling(state, gid);
		addUuLog(state, 'info', `已关闭 ${uuGameLabel(gid)} 自动发货轮询`);
	}
	saveUuConfig();
	emitUuAccount(name);
	return publicUuAccount(name);
}


function startUuPolling(state, gameId) {
	const gid = String(gameId);
	const g = gameDelivery(state, gid);
	if (!state || !state.token || !g.auto || g.pollTimer) {
		return;
	}
	g.pollTimer = setInterval(() => {
		runUuDeliveryPass(state.accountName, gid, {source: 'auto'}).catch(() => {});
	}, UU_POLL_INTERVAL_MS);
	runUuDeliveryPass(state.accountName, gid, {source: 'auto'}).catch(() => {});
}

function stopUuPolling(state, gameId) {
	const gid = String(gameId);
	const g = state && state.byGame ? state.byGame[gid] : null;
	if (g && g.pollTimer) {
		clearInterval(g.pollTimer);
		g.pollTimer = null;
	}
}

// 设置全局轮询间隔（毫秒），并重启所有正在轮询的(账号×游戏)使其立即生效
function setUuPollInterval(ms) {
	UU_POLL_INTERVAL_MS = clampUuPollMs(ms);
	for (const state of uuDelivery.values()) {
		for (const gid of DELIVER_GAME_IDS) {
			const g = state.byGame && state.byGame[gid];
			if (g && g.pollTimer) {
				stopUuPolling(state, gid);
				startUuPolling(state, gid);
			}
		}
	}
	saveUuConfig();
	return UU_POLL_INTERVAL_MS;
}

function pushUuRecord(state, record) {
	state.recentOrders.unshift(record);
	if (state.recentOrders.length > 30) {
		state.recentOrders.length = 30;
	}
}

// ===== CS2 自动上架 worker（与发货并行，独立生命周期） =====

function startUuListPolling(state) {
	if (!state || !state.token || !state.listAuto || state.listTimer) {
		return;
	}
	state.listTimer = setInterval(() => {
		runUuListingPass(state.accountName, {source: 'auto'}).catch(() => {});
	}, UU_LIST_INTERVAL_MS);
	runUuListingPass(state.accountName, {source: 'auto'}).catch(() => {});
}

function stopUuListPolling(state) {
	if (state && state.listTimer) {
		clearInterval(state.listTimer);
		state.listTimer = null;
	}
}

function setUuListAuto(accountName, enabled) {
	const name = String(accountName || '').trim();
	const state = uuDelivery.get(name);
	if (!state || !state.token) {
		throw uuError(409, '该账号尚未绑定 token');
	}
	state.listAuto = !!enabled;
	if (state.listAuto) {
		startUuListPolling(state);
		addUuLog(state, 'info', '已开启 CS2 自动上架');
	} else {
		stopUuListPolling(state);
		addUuLog(state, 'info', '已关闭 CS2 自动上架');
	}
	saveUuConfig();
	emitUuAccount(name);
	return publicUuAccount(name);
}

// 一次自动上架：拉 CS2 库存 → 过滤可上架皮肤 → 按磨损段定价 → 上架（仅出售）。
// 磨损来源：UU 库存 AssetInfo.Abrade；缺失则跳过（待外部 GC 解析服务，P4）。上架仅处理 AssetStatus=0（未在售），天然避免重复上架。
async function runUuListingPass(accountName, options = {}) {
	const name = String(accountName || '').trim();
	const state = uuDelivery.get(name);
	if (!state || !state.token) {
		throw uuError(409, '该账号尚未绑定 token');
	}
	if (state.listRunning) {
		return publicUuAccount(name); // 上一轮未结束，跳过
	}
	const source = options.source || 'manual';

	state.listRunning = true;
	state.listStatus = 'listing';
	state.lastListAt = new Date().toISOString();
	state.listStats.scans += 1;
	emitUuAccount(name);

	try {
		const cfg = state.listConfig || {};
		const whitelist = Array.isArray(cfg.whitelist) ? cfg.whitelist.filter(Boolean) : [];
		const blacklist = Array.isArray(cfg.blacklist) ? cfg.blacklist.filter(Boolean) : [];
		const maxPrice = Number(cfg.maxPrice) > 0 ? Number(cfg.maxPrice) : 0;
		const dryRun = !!cfg.dryRun;

		// 上架是纯 UU 操作，不依赖 Steam 在线/cookies（那是发货才需要的）。token 通用，强制 CS2。
		const uuLogger = (level, message) => {
			if (level !== 'debug') {
				addUuLog(state, level, message);
			}
		};
		const uu = new UuAccount(state.token, {gameId: String(CS2_APP_ID), logger: uuLogger});
		const engine = new UuPriceEngine({params: {requestGap: UU_LIST_QUERY_GAP}, logger: uuLogger});

		// ===== Phase 1: 上架未在售的库存物品 =====
		addUuLog(state, 'info', source === 'auto' ? 'CS2 自动上架: 开始扫描库存' : 'CS2 上架: 手动触发扫描');
		const inventory = await uu.getInventory({refresh: true});

		// 过滤：可交易 + 未在售(AssetStatus=0) + 有模板 + 命中白名单(空=全部) + 未命中黑名单
		const candidates = [];
		for (const it of inventory) {
			if (!it.AssetInfo) continue;
			if (it.Tradable !== true || it.AssetStatus !== 0) continue;
			const tm = it.TemplateInfo || {};
			const shortName = tm.CommodityName || '';
			if (!tm.Id || !shortName) continue;
			if (whitelist.length && !whitelist.some(s => s && shortName.includes(s))) continue;
			if (blacklist.length && blacklist.some(s => s && shortName.includes(s))) {
				addUuLog(state, 'info', `跳过(黑名单): ${shortName}`);
				continue;
			}
			candidates.push(it);
		}

		const toSell = [];
		if (candidates.length) {
			addUuLog(state, 'info', `发现 ${candidates.length} 件可上架物品，开始按磨损定价...`);
			for (const it of candidates) {
				const tm = it.TemplateInfo;
				const shortName = tm.CommodityName;
				let abrade = parseFloat(it.AssetInfo && it.AssetInfo.Abrade);
				if (!Number.isFinite(abrade)) {
					// UU 未返回磨损 → 用外部 GC 解析服务兜底（见 inspect-service/）
					const resolved = await resolveAbradeViaInspect(it.ActionLink);
					if (resolved != null) {
						abrade = resolved;
						addUuLog(state, 'info', `外部解析磨损: ${shortName} → ${abrade.toFixed(4)}`);
					} else {
						state.listStats.noAbrade += 1;
						addUuLog(state, 'warn', `跳过(无磨损${INSPECT_SERVICE_URL ? '，外部解析失败' : '，未配置外部解析服务'}): ${shortName}`);
						continue;
					}
				}
				let price = 0;
				try {
					price = await engine.getAbradeRelatedPrice(uu, tm.Id, shortName, abrade);
				} catch (err) {
					state.listStats.skipped += 1;
					addUuLog(state, 'error', `定价失败 ${shortName}: ${err && err.message ? err.message : err}`);
					continue;
				}
				if (!(price > 0)) {
					state.listStats.skipped += 1;
					addUuLog(state, 'info', `跳过(无参考价): ${shortName}`);
					continue;
				}
				if (maxPrice && price > maxPrice) {
					state.listStats.skipped += 1;
					addUuLog(state, 'info', `跳过(超过最高价 ¥${maxPrice}): ${shortName} ¥${price}`);
					continue;
				}
				addUuLog(state, 'info', `将上架: ${shortName}（磨损 ${abrade.toFixed(4)}） ¥${price}`);
				toSell.push({AssetId: it.SteamAssetId, Price: price});
			}
		} else {
			addUuLog(state, 'info', '无新可上架物品（库存无可交易/未在售的皮肤）');
		}

		if (toSell.length) {
			if (dryRun) {
				addUuLog(state, 'warn', `[dryRun] 仅试算，未真正上架 ${toSell.length} 件`);
			} else {
				const result = await uu.sellItems(toSell);
				state.listStats.listed += result.success;
				state.listStats.failed += result.fail;
				addUuLog(state, result.success > 0 ? 'success' : 'warn', `上架完成: 成功 ${result.success} 件, 失败 ${result.fail} 件`);
			}
		}

		// ===== Phase 2: 自动改价（对已在售物品按当前市场重新定价跟价） =====
		if (cfg.reprice !== false) {
			const sellList = await uu.getSellList();
			const toChange = [];
			for (const it of sellList) {
				const shortName = it.name || '';
				if (!shortName.includes('|')) continue; // 跳过非皮肤(存储组件等)
				if (whitelist.length && !whitelist.some(s => s && shortName.includes(s))) continue;
				if (blacklist.length && blacklist.some(s => s && shortName.includes(s))) continue;
				const abrade = parseFloat(it.abrade);
				if (!Number.isFinite(abrade)) continue; // 无磨损不参与改价
				const commodityId = it.id;
				if (!commodityId) continue;
				const curPrice = parseFloat(it.sellAmount);
				let newPrice = 0;
				try {
					newPrice = await engine.getAbradeRelatedPrice(uu, it.templateId, shortName, abrade);
				} catch (err) {
					addUuLog(state, 'error', `改价定价失败 ${shortName}: ${err && err.message ? err.message : err}`);
					continue;
				}
				if (!(newPrice > 0)) continue;
				if (maxPrice && newPrice > maxPrice) continue;
				if (Number.isFinite(curPrice) && Math.abs(newPrice - curPrice) < 0.01) continue; // 价格未变化则不改
				addUuLog(state, 'info', `将改价: ${shortName} ¥${Number.isFinite(curPrice) ? curPrice : '?'} → ¥${newPrice}`);
				toChange.push({CommodityId: commodityId, Price: newPrice});
			}
			if (toChange.length) {
				if (dryRun) {
					addUuLog(state, 'warn', `[dryRun] 仅试算，未真正改价 ${toChange.length} 件`);
				} else {
					const cr = await uu.changeSalePrice(toChange);
					state.listStats.repriced += cr.success;
					addUuLog(state, cr.success > 0 ? 'success' : 'warn', `改价完成: 成功 ${cr.success} 件, 失败 ${cr.fail} 件`);
				}
			} else {
				addUuLog(state, 'info', '无需改价（在售价格均为最新）');
			}
		}

		state.listStatus = 'idle';
		state.listLastError = '';
	} catch (err) {
		state.listStatus = 'error';
		state.listLastError = err && err.message ? err.message : String(err);
		addUuLog(state, 'error', 'CS2 自动上架失败: ' + state.listLastError);
	} finally {
		state.listRunning = false;
		emitUuAccount(name);
	}
	return publicUuAccount(name);
}

async function runUuDeliveryPass(accountName, gameId, options = {}) {
	const name = String(accountName || '').trim();
	const state = uuDelivery.get(name);
	if (!state || !state.token) {
		throw uuError(409, '该账号尚未绑定 token');
	}
	const gid = normalizeUuGameId(gameId);
	const label = uuGameLabel(gid);
	const g = gameDelivery(state, gid);
	if (g.running) {
		return publicUuAccount(name); // 该游戏上一轮尚未结束，跳过
	}
	const source = options.source || 'manual';

	g.running = true;
	g.status = 'scanning';
	g.lastScanAt = new Date().toISOString();
	g.stats.scans += 1;
	emitUuAccount(name);

	try {
		const ready = uuAttemptReadiness(name);
		// 就绪检查（缺哪样都没法发货）。原因变化时才播报一次，避免自动轮询每 30s 刷屏。
		let notReady = '';
		if (!ready.online) {
			notReady = 'Steam 账号未在线，无法发货——请先在「账户管理」登录该账号';
		} else if (!ready.hasCookies) {
			notReady = 'Steam 账号缺少 WebSession cookies，请在账户页重新登录/获取';
		} else if (!ready.hasIdentitySecret) {
			notReady = '缺少 identity_secret（maFile，手机令牌确认用），无法接受报价——请为该账号导入 maFile';
		}
		if (notReady) {
			if (source !== 'auto' || g.lastSkipReason !== notReady) {
				addUuLog(state, 'warn', `[${label}] ${notReady}`);
			}
			g.lastSkipReason = notReady;
			g.status = ready.online ? 'error' : 'idle';
			g.lastError = ready.online ? notReady : '';
			return publicUuAccount(name);
		}
		g.lastSkipReason = ''; // 已就绪，清除上次的未就绪原因

		const attempt = ready.attempt;
		// 按游戏建 UuAccount：host 自动选（CS2→api.youpin898.com，TF2→g3-api）
		const uu = new UuAccount(state.token, {
			gameId: gid,
			logger: (level, message) => {
				if (level !== 'debug') {
					addUuLog(state, level, `[${label}] ${message}`);
				}
			}
		});

			const beforeStats = {...g.stats};
			const orders = await uu.getWaitDeliverList({gameId: gid});
			// 先处理"待发送报价"订单（卖家需主动发报价）：发出报价后会转为"待确认报价"，下一轮再接受。
			const needSend = orders.filter(isWaitSendOfferOrder);
			if (needSend.length) {
				addUuLog(state, 'info', `[${label}] 轮询: 发现 ${needSend.length} 笔待发送报价订单，尝试发送报价`);
				for (let i = 0; i < needSend.length; i++) {
					await sendUuOrderOffer(state, uu, needSend[i], label);
					emitUuAccount(name);
					if (i < needSend.length - 1) {
						await sleep(UU_DELIVER_GAP_MS); // 逐笔间隔，避免频繁访问 UU 接口
					}
				}
			}
			const allPending = orders.filter(order => Number(order.orderSubStatus) === Number(UU_WAIT_CONFIRM_SUBSTATUS));
			// 清理过期冷却记录，并跳过仍处于冷却期内的订单
			const nowTs = Date.now();
			for (const [ono, until] of g.orderCooldown) {
				if (until <= nowTs) {
					g.orderCooldown.delete(ono);
				}
			}
			const pending = allPending.filter(order => {
				const until = g.orderCooldown.get(order.orderNo);
				return !(until && nowTs < until);
			});
			const cooling = allPending.length - pending.length;
			if (!pending.length) {
				if (source === 'auto') {
					addUuLog(state, 'info', cooling > 0
						? `[${label}] 轮询: 待确认报价订单均处于发货冷却期（${cooling} 笔），稍后再试`
						: `[${label}] 轮询: 无待确认报价订单`);
				} else {
					addUuLog(state, 'info', `[${label}] 待发货列表无可处理的"待确认报价"订单（共 ${orders.length} 单${cooling > 0 ? `，${cooling} 笔冷却中` : ''}）`);
				}
				g.status = 'idle';
				g.lastError = '';
				return publicUuAccount(name);
			}

			addUuLog(state, 'info', `[${label}] 轮询: 发现 ${pending.length} 笔待确认报价，开始发货${cooling > 0 ? `（另有 ${cooling} 笔冷却中）` : ''}`);
			for (let i = 0; i < pending.length; i++) {
				await deliverUuOrder(state, g, uu, pending[i], attempt, gid, label);
				emitUuAccount(name);
				if (i < pending.length - 1) {
					await sleep(UU_DELIVER_GAP_MS);
				}
			}
			const delivered = (g.stats.delivered || 0) - (beforeStats.delivered || 0);
			const failed = (g.stats.failed || 0) - (beforeStats.failed || 0);
			if (delivered > 0 || failed > 0) {
				addUuLog(state, delivered > 0 ? 'success' : 'warn', `[${label}] 本轮结果: 发货 ${delivered} 笔成功, ${failed} 笔失败`);
			}
			g.status = 'idle';
			g.lastError = '';
	} catch (err) {
		g.status = 'error';
		g.lastError = err && err.message ? err.message : String(err);
		addUuLog(state, 'error', `[${label}] 发货轮询失败: ` + g.lastError);
	} finally {
		g.running = false;
		emitUuAccount(name);
	}
	return publicUuAccount(name);
}

// 判断订单是否处于“待发送报价”（卖家需先主动发出 Steam 报价才能进入待确认报价 1103）。
// 用子状态名匹配（含“发送报价”且非“确认”），避免依赖未知的子状态码，对齐 Steamauto 的消息匹配做法。
function isWaitSendOfferOrder(order) {
	const name = String(order && order.subStatusName || '');
	return name.includes('发送报价') && !name.includes('确认');
}

// 处理“待发送报价”订单：调用 UU send-offer 发出报价，并轮询 get-offer-status 直到发送成功(status=3)。
// 成功后该订单将转为“待确认报价”(1103)，由下一轮发货流程完成确认+接受。对齐 Steamauto send_offer 流程。
async function sendUuOrderOffer(state, uu, order, label = '') {
	const orderNo = order.orderNo;
	const itemName = order.itemName || order.hashName || '';
	const tag = label ? `[${label}] ` : '';
	try {
		addUuLog(state, 'info', `${tag}订单 ${orderNo}「${itemName}」处于「${order.subStatusName || '待发送报价'}」，尝试发送报价...`);
		const result = await uu.sendOffer(orderNo);
		if (result !== true) {
			addUuLog(state, 'warn', `订单 ${orderNo} 发送报价失败: ${result}`);
			return false;
		}
		addUuLog(state, 'info', `订单 ${orderNo} 报价发送中，等待发送完成...`);
		for (let i = 0; i < 5; i++) {
			await sleep(1500);
			const status = await uu.getOfferStatus(orderNo);
			const code = status && typeof status === 'object' ? Number(status.status) : null;
			if (code === 3) {
				addUuLog(state, 'success', `✅ 订单 ${orderNo} 报价已发送成功，将在下一轮自动确认接受`);
				return true;
			}
			if (i === 4) {
				addUuLog(state, 'warn', `订单 ${orderNo} 报价发送等待超时（最后状态: ${typeof status === 'object' ? JSON.stringify(status) : status}）`);
			}
		}
		return false;
	} catch (err) {
		addUuLog(state, 'error', `订单 ${orderNo} 发送报价异常: ${err && err.message ? err.message : err}`);
		return false;
	}
}

async function deliverUuOrder(state, g, uu, order, attempt, gameId, label = '') {
	const orderNo = order.orderNo;
	const itemName = order.itemName || order.hashName || '';
	const tag = label ? `[${label}] ` : '';

	if (g.delivered.has(orderNo)) {
		return; // 本会话已成功发货，避免重复接受
	}

	const record = {
		orderNo,
		itemName,
		tradeOfferId: null,
		ok: false,
		reason: '',
		at: new Date().toISOString()
	};

	try {
		addUuLog(state, 'info', `${tag}订单 ${orderNo}「${itemName}」开始处理`);
		const detail = await uu.getOrderDetail(orderNo);
		const tradeOfferId = detail && detail.tradeOfferId;
		const partnerSteamId = detail && detail.buyer && detail.buyer.steamId; // UU 报的对方 steamId(字符串)
		const assetId = detail && detail.commodity && (detail.commodity.assetId || detail.commodity.assertId);
		record.tradeOfferId = tradeOfferId || null;

		if (!tradeOfferId) {
			record.reason = '暂无 tradeOfferId（报价未发出/已取消）';
			addUuLog(state, 'warn', `${tag}订单 ${orderNo} ${record.reason}，跳过`);
			g.stats.skipped += 1;
			pushUuRecord(state, record);
			return;
		}

		// 进入实际发货流程：登记冷却，避免本订单在 UU 服务端状态延迟期间被重复接受报价（错误 11）
		g.orderCooldown.set(orderNo, Date.now() + UU_ORDER_COOLDOWN_MS);

		const verifyOptions = {
			cookies: attempt.cookies,
			identitySecret: attempt.identitySecret,
			tradeOfferId,
			expectedPartnerSteamId: partnerSteamId,
			expectGiveAppId: Number(gameId),
			expectGiveAssetIds: assetId ? [String(assetId)] : undefined,
			logger: (level, message) => {
				if (level !== 'debug') {
					addUuLog(state, level, message);
				}
			}
		};

		// 阶段1（UU 侧）：confirmOffer 确认报价
		const confirm = await uu.confirmOffer(orderNo, tradeOfferId);
		if (confirm === true) {
			addUuLog(state, 'info', `${tag}订单 ${orderNo} 阶段1 confirmOffer 成功`);
		} else {
			addUuLog(state, 'warn', `${tag}订单 ${orderNo} 阶段1 confirmOffer 返回: ${confirm}（继续尝试接受报价）`);
		}

		// 阶段1 与阶段2 之间留间隔：给 UU 服务端处理时间，并降低接口访问频率
		await sleep(UU_CONFIRM_ACCEPT_GAP_MS);

		// 阶段2（Steam 侧）：fail-closed 校验后接受报价 + identity_secret 手机确认
		const result = await acceptVerifiedTradeOffer({...verifyOptions, dryRun: false});
		record.ok = !!result.ok && !!result.accepted;
		record.reason = result.reason;
		if (record.ok) {
			g.stats.delivered += 1;
			g.delivered.add(orderNo);
			addUuLog(state, 'success', `${tag}✅ 订单 ${orderNo}「${itemName}」发货成功（已接受+手机确认）`);
		} else {
			g.stats.failed += 1;
			addUuLog(state, 'error', `${tag}⛔ 订单 ${orderNo} 接受报价失败(fail-closed): ${result.reason}`);
		}
		pushUuRecord(state, record);
	} catch (err) {
		record.reason = err && err.message ? err.message : String(err);
		g.stats.failed += 1;
		addUuLog(state, 'error', `${tag}订单 ${orderNo} 处理异常: ${record.reason}`);
		pushUuRecord(state, record);
	}
}

async function getUuWaitDeliverOrders(accountName) {
	const name = String(accountName || '').trim();
	const state = uuDelivery.get(name);
	if (!state || !state.token) {
		throw uuError(409, '该账号尚未绑定 token');
	}
	const logger = (level, message) => {
		if (level !== 'debug') {
			addUuLog(state, level, message);
		}
	};
	// 两个游戏分别查（host 不同），合并返回
	const out = [];
	for (const gid of DELIVER_GAME_IDS) {
		try {
			const uu = new UuAccount(state.token, {gameId: gid, logger});
			const orders = await uu.getDeliverableOrders({gameId: gid});
			for (const order of orders) {
				out.push({
					gameId: gid,
					gameLabel: uuGameLabel(gid),
					orderNo: order.orderNo,
					itemName: order.itemName,
					hashName: order.hashName,
					subStatus: order.orderSubStatus,
					subStatusName: order.subStatusName,
					tradeOfferId: order.tradeOfferId,
					offerSendResult: order.offerSendResult,
					sellAmount: order.sellAmount
				});
			}
		} catch (err) {
			addUuLog(state, 'warn', `[${uuGameLabel(gid)}] 读取待发货失败: ${err && err.message ? err.message : err}`);
		}
	}
	return out;
}

// ===== 悠悠短信登录获取 token =====

function pruneUuLoginSessions() {
	const now = Date.now();
	for (const [id, session] of uuLoginSessions) {
		if (now - session.createdAt > UU_LOGIN_SESSION_TTL_MS) {
			uuLoginSessions.delete(id);
		}
	}
}

// 第一步：生成设备会话 + 取 UK + 发送短信验证码（或检测到需要上行短信）
async function startUuSmsLogin(phone) {
	const tel = String(phone || '').trim();
	if (!/^\d{6,15}$/.test(tel)) {
		throw uuError(400, '手机号格式不正确');
	}
	pruneUuLoginSessions();

	// 设备身份在 start/verify 之间必须保持一致（与 get-uu-token.js 对齐）
	const deviceInfo = generateRandomString(10);
	const headers = generateHeaders(deviceInfo, deviceInfo, '', '730');
	const sessionId = deviceInfo;

	let uk = '';
	try {
		uk = await UuAccount.getUuUk();
	} catch (err) {
		uk = '';
	}
	// 与上游一致：把真实 uk 注入共享 headers，使后续 getSmsUpSignInConfig / smsSignIn
	// （含 verify 阶段复用的 session.headers）都带上同一个有效 uk，而非随机值。
	if (uk) {
		headers.uk = uk;
	}

	const result = await UuAccount.sendLoginSmsCode(tel, sessionId, {headers, uk});
	const msg = String((result && result.Msg) || '');
	const loginSessionId = crypto.randomBytes(12).toString('hex');

	if (msg.includes('成功')) {
		uuLoginSessions.set(loginSessionId, {phone: tel, headers, sessionId, mode: 'sms', createdAt: Date.now()});
		return {loginSessionId, mode: 'sms', phone: tel, message: msg || '验证码已发送'};
	}

	// 下行短信失败 → 尝试“上行短信”验证流程
	const cfg = await UuAccount.getSmsUpSignInConfig(headers);
	if (cfg && cfg.Code === 0 && cfg.Data) {
		uuLoginSessions.set(loginSessionId, {phone: tel, headers, sessionId, mode: 'sms-up', createdAt: Date.now()});
		return {
			loginSessionId,
			mode: 'sms-up',
			phone: tel,
			smsUpContent: cfg.Data.SmsUpContent || '',
			smsUpNumber: cfg.Data.SmsUpNumber || '',
			message: msg || '该手机号需要上行短信验证'
		};
	}

	throw uuError(502, '发送验证码失败: ' + (msg || JSON.stringify(result)) + '；上行短信配置也获取失败');
}

// 第二步：用验证码（下行）或空码（上行）登录拿 token，并可选自动绑定到账号
async function verifyUuSmsLogin({loginSessionId, code, accountName, gameId} = {}) {
	pruneUuLoginSessions();
	const session = uuLoginSessions.get(String(loginSessionId || ''));
	if (!session) {
		throw uuError(400, '登录会话不存在或已过期，请重新发送验证码');
	}
	if (session.mode === 'sms' && !String(code || '').trim()) {
		throw uuError(400, '请输入短信验证码');
	}

	const verifyCode = session.mode === 'sms' ? String(code).trim() : '';
	let response;
	try {
		response = await UuAccount.smsSignIn(session.phone, verifyCode, session.sessionId, {headers: session.headers});
	} catch (err) {
		throw uuError(502, 'UU 登录请求失败: ' + (err && err.message ? err.message : err));
	}

	const token = response && response.Data && response.Data.Token;
	if (!token) {
		throw uuError(400, 'UU 登录失败: ' + ((response && response.Msg) || JSON.stringify(response)));
	}
	uuLoginSessions.delete(String(loginSessionId));
	// 这里的游戏只决定「校验/查绑定时打哪个网关」，不决定 token 的归属(token 通用)。
	// 前端已不再传 gameId；缺省走 CS2，与登录/cookie-pull 一致(那两处本来就写死 730)。
	// 注意不能直接用 normalizeUuGameId(undefined)——它会落到 TF2。
	const gameIdNorm = uuDefaultGameId(gameId);


	// 持久化 token 到加密库 + 查 UU 绑定的 Steam 账号
	let linkedSteamId = '';
	const jwt = decodeJwt(token);
	const userId = jwt && jwt.Id ? String(jwt.Id) : '';
	const nickname = jwt && jwt.Name ? String(jwt.Name) : '';
	const jwtExp = jwt && jwt.exp ? Number(jwt.exp) : null;

	try {
		const uu = new UuAccount(token, {gameId: gameIdNorm});
		const pull = await uu.getSteamCookiePull();
		linkedSteamId = pull.steamId || '';
	} catch (err) {
		// cookie/pull 失败不阻断
	}

	// 写入 token 列表 —— 按 userId 去重，**不按游戏**。
	// UU token 是按 UU 账号发放的(JWT 里只有 Id/Name，没有游戏字段)，CS2/TF2 通用；
	// 以前这里的 key 是 (userId, gameId)，同一个 UU 账号在弹窗里选 CS2 登一次、选 TF2 再登一次
	// 就会存成两条、两个不同的 JWT，然后被自动绑定逻辑各绑一次。
	try {
		const tokens = loadUuTokens();
		const idx = tokens.findIndex(t => t.userId === userId);
		const entry = {token, userId, nickname, linkedSteamId, jwtExp, acquiredAt: new Date().toISOString()};
		if (idx >= 0) {
			tokens[idx] = entry;
		} else {
			tokens.push(entry);
		}
		saveUuTokens(tokens);
	} catch (err) {
		// 持久化失败不阻断
	}

	const out = {token: String(token), userId, nickname, linkedSteamId, jwtExp, bound: false, account: null, bindError: ''};
	const name = String(accountName || '').trim();
	if (name) {
		try {
			out.account = await bindUuToken(name, token, gameId);
			out.bound = true;
		} catch (err) {
			out.bindError = err && err.message ? err.message : String(err);
		}
	} else if (linkedSteamId) {
		// 自动匹配本地已登录账号
		const matchedAttempt = findAttemptBySteamId(linkedSteamId);
		if (matchedAttempt && matchedAttempt.accountName) {
			try {
				out.account = await bindUuToken(matchedAttempt.accountName, token, gameId);
				out.bound = true;
				out.autoBoundAccount = matchedAttempt.accountName;
				console.log('[uu] 自动绑定: token SteamID ' + linkedSteamId + ' -> 账号 ' + matchedAttempt.accountName);
			} catch (err) {
				out.bindError = err && err.message ? err.message : String(err);
			}
		}
	}
	return out;
}
