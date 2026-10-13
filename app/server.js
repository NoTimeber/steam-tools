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
const {redeemForAccount} = require('./lib/wallet-code');
const {createAuth} = require('./lib/auth');
const {createFingerprintStore} = require('./services/fingerprint');
const {createCs2Terminal} = require('./lib/cs2-terminal');
const {writeFileAtomic, writeJsonAtomic, readJsonFileSafe} = require('./lib/atomic-file');
// 凭据数据层(TypeScript,由 Node 24 直接运行):SQLite + 字段加密,见 src/store/。
const {openStore, normalizeStoredAccount} = require('../src/store/index.ts');
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
const {findOnlineAttempt, findAttemptByKey: findAttemptInMap, listCookieFlowAccounts} = require('../src/steam/attempts.ts');
// CS2/TF2 游戏内购(TypeScript):商品目录、GC 下单、内购任务,见 src/purchase/。
const {createPurchaseService, normalizeCartData, publicTask: publicPurchaseTask} = require('../src/purchase/index.ts');
// UU(悠悠有品)发货/自动上架/token 管理(TypeScript),见 src/uu/。
const {createUuService} = require('../src/uu/index.ts');
// Steam 社区市场求购单(TypeScript):行情参考、挂求购/手机确认、撤单、对账,见 src/market/。
const {createMarketService} = require('../src/market/index.ts');
// 买游戏(TypeScript):Steam 商店结算协议、多账号购买任务,见 src/buygame/。
const {createBuyGameService} = require('../src/buygame/index.ts');

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

const PURCHASE_PRICE_SHEET_DIR = path.join(DATA_DIR, 'price-sheets');
const PURCHASE_CATALOG_CACHE_DIR = path.join(DATA_DIR, 'purchase-catalogs');

fs.mkdirSync(PURCHASE_PRICE_SHEET_DIR, {recursive: true});
fs.mkdirSync(PURCHASE_CATALOG_CACHE_DIR, {recursive: true});

// UU 旧版明文文件(首次启动导入加密库用,见下面的 openStore)
const UU_DIR = path.join(DATA_DIR, 'uu');
const UU_CONFIG_FILE = path.join(UU_DIR, 'delivery-config.json');
const UU_TOKENS_FILE = path.join(UU_DIR, 'tokens.json');
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

// UU 发货:token 和发货配置在加密库(store.uu);轮询间隔 UU_POLL_INTERVAL_MS(数据库里改过的优先);
// 上架时 UU 没给磨损,用外部检视服务(INSPECT_SERVICE_URL / INSPECT_KEY,见 inspect-service/)兜底
const uu = createUuService({
	store: store.uu,
	attempts: () => attempts.values(),
	emit: (event, payload) => io.emit(event, payload),
	hasMaFile: accountName => !!readLocalAccountProfile(accountName).hasMaFile,
	pollIntervalMs: Number(process.env.UU_POLL_INTERVAL_MS) || undefined,
	inspect: {url: process.env.INSPECT_SERVICE_URL || '', key: process.env.INSPECT_KEY || ''}
});

// 市场求购:账本 data/market-buyorders.json 只记本工具挂出的求购;item_nameid 先查缓存 data/market-nameids.json,
// 再查随程序打包的社区库 app/services/nameid-db/
const market = createMarketService({
	findAttempt: findAttemptByKey,
	cookiesFor: resolveInventoryCookies,
	ledgerFile: path.join(DATA_DIR, 'market-buyorders.json'),
	nameIdCacheFile: path.join(DATA_DIR, 'market-nameids.json'),
	nameIdDbDir: path.join(CODE_DIR, 'services', 'nameid-db'),
	readJson: readJsonFile,
	writeJson: writeJsonAtomic,
	writeText: (file, text) => writeFileAtomic(file, text, 'utf8')
});

// 买游戏:任务只在内存里(最多 50 个),进度经 socket.io 推送
const buyGame = createBuyGameService({
	findAttempt: findAttemptByKey,
	cookiesFor: resolveInventoryCookies,
	emit: (event, task) => io.emit(event, task)
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
	try {
		res.json({success: true, result: await buyGame.testPurchase(req.body || {})});
	} catch (err) {
		sendBuyGameError(res, err, '购买失败');
	}
});

// ===== 买游戏(协议购买整款 Steam 游戏,src/buygame/)=====
function sendBuyGameError(res, err, fallback) {
	res.status(err && err.statusCode || 500).json({success: false, error: err && err.message || fallback});
}

// 可购买账户:已登录且有 WebSession cookie 的账号(买游戏只需 cookie,不需要 GC)。
app.get('/api/buygame/online-accounts', (req, res) => {
	res.json({success: true, accounts: listCookieFlowAccounts(attempts.values(), resolveInventoryCookies)});
});

// 解析一个 subid(packageid):返回游戏名/价格,供前端确认购买内容。query: { packageId|subid, accountId? }
app.get('/api/buygame/resolve', async (req, res) => {
	try {
		res.json({success: true, package: await buyGame.resolvePackage(req.query)});
	} catch (err) {
		sendBuyGameError(res, err, '解析失败');
	}
});

app.get('/api/buygame/tasks', (req, res) => {
	res.json({success: true, tasks: buyGame.listTasks()});
});

// 创建并执行买游戏任务。body: { items:[{accountId, packageIds:[subid...]}], dryRun, concurrency }
app.post('/api/buygame/tasks', (req, res) => {
	try {
		res.json({success: true, task: buyGame.createTask(req.body || {})});
	} catch (err) {
		sendBuyGameError(res, err, '创建任务失败');
	}
});

// ===== Steam 社区市场:求购单(src/market/)=====
function sendMarketError(res, err, fallback) {
	res.status(err && err.statusCode || 500).json({success: false, error: err && err.message || fallback});
}

// 可挂求购的在线账户(同「买游戏」:已登录 + 有 WebSession cookie)。
app.get('/api/market/online-accounts', (req, res) => {
	res.json({success: true, accounts: listCookieFlowAccounts(attempts.values(), resolveInventoryCookies)});
});

// 行情参考。query: { accountId|account, url | (appid, marketHashName), itemNameId? }
app.get('/api/market/context', async (req, res) => {
	try {
		res.json({success: true, context: await market.context(req.query)});
	} catch (err) {
		sendMarketError(res, err, '行情获取失败');
	}
});

// 挂求购单(可多账号,钱包币种须一致)。
// body: { accountIds:[id|name...], url|(appid,marketHashName), pricePerItem(钱包币种主单位), quantity, itemName?, concurrency?, perAccountMax? }
app.post('/api/market/buyorder', async (req, res) => {
	try {
		res.json({success: true, ...await market.place(req.body || {})});
	} catch (err) {
		sendMarketError(res, err, '挂求购失败');
	}
});

// 我的求购单(仅本工具挂出的,存于 data/market-buyorders.json)。
app.get('/api/market/buyorders', (req, res) => {
	res.json({success: true, orders: market.orders()});
});

// 撤求购单。body: { id }(账本记录 id)或 { accountId, buyOrderId }
app.post('/api/market/buyorder/cancel', async (req, res) => {
	try {
		await market.cancel(req.body || {});
		res.json({success: true});
	} catch (err) {
		sendMarketError(res, err, '撤销失败');
	}
});

// 刷新「我的求购单」:逐账号从 Steam 实拉,和账本对账。body: { accounts:[账号名|attemptId...], concurrency? }
app.post('/api/market/buyorders/sync', async (req, res) => {
	try {
		const result = await market.sync(req.body || {});
		res.json({
			success: true,
			orders: result.orders,
			syncedAccounts: result.syncedAccounts,
			summary: {removed: result.removed, updated: result.updated, accounts: result.accounts}
		});
	} catch (err) {
		sendMarketError(res, err, '刷新失败');
	}
});

// ===== UU(悠悠有品)发货 =====
function sendUuError(res, err, fallback) {
	res.status(err && err.statusCode || 500).json({success: false, error: err && err.message || fallback});
}

app.get('/api/uu/state', (req, res) => {
	res.json({success: true, ...uu.state()});
});

// 绑定:手动粘贴传 token;自动绑定传 tokenId(浏览器拿不到 token 原文)
app.post('/api/uu/bind', async (req, res) => {
	try {
		res.json({success: true, account: await uu.bind(req.body || {})});
	} catch (err) {
		sendUuError(res, err, 'token 绑定失败');
	}
});

app.post('/api/uu/auto', (req, res) => {
	try {
		const body = req.body || {};
		res.json({success: true, account: uu.setAuto(body.accountName, body.gameId, !!body.enabled)});
	} catch (err) {
		sendUuError(res, err, '操作失败');
	}
});

app.post('/api/uu/scan', async (req, res) => {
	try {
		const body = req.body || {};
		res.json({success: true, account: await uu.scan(body.accountName, body.gameId)});
	} catch (err) {
		sendUuError(res, err, '扫描发货失败');
	}
});

app.get('/api/uu/orders/:account', async (req, res) => {
	try {
		res.json({success: true, orders: await uu.waitDeliverOrders(req.params.account)});
	} catch (err) {
		sendUuError(res, err, '读取待发货列表失败');
	}
});

// CS2 自动上架:开关 + 手动触发一次
app.post('/api/uu/list/auto', (req, res) => {
	try {
		const body = req.body || {};
		res.json({success: true, account: uu.setListAuto(body.accountName, !!body.enabled)});
	} catch (err) {
		sendUuError(res, err, '操作失败');
	}
});

app.post('/api/uu/list/scan', async (req, res) => {
	try {
		res.json({success: true, account: await uu.listScan((req.body || {}).accountName)});
	} catch (err) {
		sendUuError(res, err, '上架扫描失败');
	}
});

app.post('/api/uu/poll-interval', (req, res) => {
	try {
		res.json({success: true, pollIntervalMs: uu.setPollIntervalMinutes((req.body || {}).minutes)});
	} catch (err) {
		sendUuError(res, err, '设置轮询间隔失败');
	}
});

// 悠悠短信登录拿 token(两步:start 发码 → verify 登录);返回给浏览器的只有 tokenId,没有 token 原文
app.post('/api/uu/login/start', async (req, res) => {
	try {
		res.json({success: true, ...await uu.loginStart((req.body || {}).phone)});
	} catch (err) {
		sendUuError(res, err, '发送验证码失败');
	}
});

app.post('/api/uu/login/verify', async (req, res) => {
	try {
		res.json({success: true, ...await uu.loginVerify(req.body || {})});
	} catch (err) {
		sendUuError(res, err, '登录失败');
	}
});

app.post('/api/uu/login/cancel', (req, res) => {
	uu.loginCancel((req.body || {}).loginSessionId);
	res.json({success: true});
});

// ===== 独立 token 管理(先存进加密库,再绑到具体 Steam 账号)=====
app.post('/api/uu/token/acquire', async (req, res) => {
	try {
		res.json({success: true, token: await uu.acquireToken(req.body || {})});
	} catch (err) {
		sendUuError(res, err, '保存 token 失败');
	}
});

app.get('/api/uu/tokens', (req, res) => {
	try {
		res.json({success: true, tokens: uu.listTokens()});
	} catch (err) {
		sendUuError(res, err, '读取 token 列表失败');
	}
});

// 按账号(解绑并移除)、按 tokenId(未匹配到账号的)、或按 token 原文(兼容)删除
app.delete('/api/uu/token', (req, res) => {
	try {
		const account = uu.deleteToken(req.body || {});
		res.json(account ? {success: true, account} : {success: true});
	} catch (err) {
		sendUuError(res, err, '删除 token 失败');
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
	uu.stop();
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
uu.start();

// 按 attemptId 或账号名(不区分大小写)找会话,不看在线状态。
function findAttemptByKey(key) {
	return findAttemptInMap(attempts, key);
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
