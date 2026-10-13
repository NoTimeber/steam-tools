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
const {createAuth} = require('./lib/auth');
const {createFingerprintStore} = require('./services/fingerprint');
const {writeFileAtomic, writeJsonAtomic, readJsonFileSafe} = require('./lib/atomic-file');
// 凭据数据层(TypeScript,由 Node 24 直接运行):SQLite + 字段加密,见 src/store/。
const {openStore, normalizeStoredAccount} = require('../src/store/index.ts');
// Steam 登录会话管理(TypeScript):每账号一个会话、登录/重连看门狗、重启自动恢复,见 src/steam/。
const {createSessionManager} = require('../src/steam/session-manager.ts');
// GC 相关(TypeScript):币种表、游戏配置、GC 请求收发、钱包扣款授权、在线会话查询,见 src/steam/。
const {currencyIdToIso} = require('../src/steam/currencies.ts');
const {
	GAME_CONFIGS: PURCHASE_GAME_CONFIGS,
	normalizeGame: normalizePurchaseGame,
	gameConfig: getPurchaseGameConfig
} = require('../src/steam/games.ts');
const {
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
// 充值码批量兑换(TypeScript):临时登录 → 兑换 → 登出,见 src/wallet/。
const {createWalletService} = require('../src/wallet/index.ts');
// 账号与登录(TypeScript):名单同步、账号资料、maFile、登录/登出/Guard、删除账号、自动恢复凭据,见 src/accounts/。
const {createProfiles, createAccountService, resolveAccountCountry} = require('../src/accounts/index.ts');
// 库存(TypeScript):社区库存为准、GC 库存兜底;CS2/TF2 GC 模块的挂载,见 src/inventory/、src/steam/gc-modules.ts。
const {createInventoryService} = require('../src/inventory/index.ts');
const {createGcModuleAttacher} = require('../src/steam/gc-modules.ts');
// CS2 终端机(TypeScript):GC 抓包、解封、读/推进报价、皮肤中文名库、报价历史,见 src/terminal/。
const {createTerminalService} = require('../src/terminal/index.ts');
const {LOCAL_CM_FALLBACKS} = require('../src/steam/cm-fallback.ts');

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

// 账号资料:maFile、会话 cookies(加密库)+ 旧版 cookies 文件 / account_cache.json(只读)
const profiles = createProfiles({
	mafiles: store.mafiles,
	sessions: store.sessions,
	cookiesDir: CONFIG_COOKIES_DIR,
	accountCacheFile: ACCOUNT_CACHE_FILE,
	readJson: readJsonFile
});

// 库存:CS2 物品名靠本地 schema(app/items-game-schema.js)描述 GC 物品;库存数量变了推送会话
const inventory = createInventoryService({
	describeGcItem: item => describeGcItem(ITEMS_GAME_SCHEMA, item),
	cookiesFor: profiles.cookiesFor,
	emit: attempt => sessions.emit(attempt)
});
// CS2 终端机:报价皮肤中文名用 ByMykel 皮肤库(data/cs2-skin-db.json 缓存,app/data/ 随包副本),揭示过的报价记在 data/terminal-offers.json
const terminal = createTerminalService({
	findAttempt: findAttemptByKey,
	addLog,
	inventory,
	describeGcItem: item => describeGcItem(ITEMS_GAME_SCHEMA, item),
	historyFile: path.join(DATA_DIR, 'terminal-offers.json'),
	skinCacheFile: path.join(DATA_DIR, 'cs2-skin-db.json'),
	skinBundledFile: path.join(CODE_DIR, 'data', 'cs2-skin-db.json'),
	readJson: readJsonFile,
	writeJson: writeJsonAtomic,
	writeCompactJson: (file, value) => writeJsonAtomic(file, value, 0)
});
// 新建 Steam 客户端时挂 CS2/TF2 GC 模块;终端机在 CS2 模块上挂抓包监听
const gcModules = createGcModuleAttacher({
	GlobalOffensive,
	TeamFortress2,
	events: {addLog: (attempt, level, message) => sessions.addLog(attempt, level, message), emit: attempt => sessions.emit(attempt)},
	inventory,
	onCs2Module: attempt => terminal.attach(attempt)
});

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
	onClientCreated: (attempt, client) => gcModules.attach(attempt, client),
	onWebSession: attempt => accountService.refreshCountry(attempt),   // 后台查真实账户国家(USD 等无法从货币推断)
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

// 账号与登录路由的逻辑;拿到 WebSession 后查真实账户国家也在这里
const accountService = createAccountService({store, sessions, profiles});

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
	hasMaFile: accountName => profiles.local(accountName).hasMaFile,
	pollIntervalMs: Number(process.env.UU_POLL_INTERVAL_MS) || undefined,
	inspect: {url: process.env.INSPECT_SERVICE_URL || '', key: process.env.INSPECT_KEY || ''}
});

// 市场求购:账本 data/market-buyorders.json 只记本工具挂出的求购;item_nameid 先查缓存 data/market-nameids.json,
// 再查随程序打包的社区库 app/services/nameid-db/
const market = createMarketService({
	findAttempt: findAttemptByKey,
	cookiesFor: profiles.cookiesFor,
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
	cookiesFor: profiles.cookiesFor,
	emit: (event, task) => io.emit(event, task)
});

// 充值码兑换:没填密码的账号用本地 maFile / 旧 cookies 文件里的 refreshToken 登录,有 shared_secret 自动过令牌
const wallet = createWalletService({
	profileFor: accountName => profiles.local(accountName),
	emit: payload => io.emit('wallet:redeem', payload)
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
	res.json({success: true, attempts: accountService.listAttempts()});
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

// ===== 账号与登录(src/accounts/)=====
function sendAccountError(res, err, fallback) {
	res.status(err && err.statusCode || 500).json({success: false, error: err && err.message || fallback});
}

// 包一层:成功时把返回对象并进 {success: true},失败按 statusCode 返回
function accountRoute(handler, fallback) {
	return async (req, res) => {
		try {
			res.json({success: true, ...await handler(req)});
		} catch (err) {
			sendAccountError(res, err, fallback);
		}
	};
}

// 账户名单:多浏览器/多设备共享(加密库)。
// initialized 表示服务端是否写过名单——前端据此决定首次升级时是否把本地名单迁移上来,
// 避免"已删除账号"被某个仍有旧 localStorage 的浏览器重新推回。
app.get('/api/accounts/list', accountRoute(() => accountService.listAccounts(), '读取账户名单失败'));
// 全量替换账户名单(前端 saveAccounts 推送的就是完整 state.accounts)。
app.post('/api/accounts/list', accountRoute(req => accountService.saveAccounts(req.body || {}), '保存账户名单失败'));
app.post('/api/accounts/meta', accountRoute(req => accountService.meta(req.body || {}), '读取账号资料失败'));
// 服务端持久化 maFile:完整 maFile(含 identity_secret)加密存入数据库,发货/求购确认时取 identity_secret。
app.post('/api/mafile/import', accountRoute(req => accountService.importMaFiles(req.body || {}), '导入 maFile 失败'));
app.post('/api/auth-code', accountRoute(req => accountService.authCode(req.body || {}), '生成验证码失败'));
app.post('/api/login', accountRoute(req => accountService.login(req.body || {}), '登录失败'));
app.post('/api/login-refresh', accountRoute(req => accountService.loginWithRefreshToken(req.body || {}), '登录失败'));
app.post('/api/guard/:id', accountRoute(req => accountService.submitGuard(req.params.id, req.body || {}), '提交验证码失败'));
app.post('/api/web-session/:id', accountRoute(req => accountService.requestWebSession(req.params.id), '获取 WebSession 失败'));
app.post('/api/logout/:id', accountRoute(req => accountService.logout(req.params.id), '登出失败'));
// 前端删除账户时调用:登出、移出会话表,删掉保存的 session,并从名单移除。
app.post('/api/accounts/cleanup', accountRoute(req => accountService.cleanup(req.body || {}), '清理失败'));
app.post('/api/gc/connect/:id', accountRoute(req => accountService.connectGc(req.params.id, getPurchaseGame(req)), '连接 GC 失败'));
app.post('/api/gc/disconnect/:id', accountRoute(req => accountService.disconnectGc(req.params.id, getPurchaseGame(req)), '断开 GC 失败'));
app.get('/api/cookies/:id', debugOnly, accountRoute(req => accountService.cookies(req.params.id), '读取 cookies 失败'));

app.get('/api/inventory/:id', async (req, res) => {
	const attempt = getAttempt(req.params.id, res);
	if (!attempt) {
		return;
	}

	try {
		const snapshot = await inventory.get(attempt, {forceRefresh: req.query.refresh === '1'});
		res.json({
			success: true,
			attempt: publicAttempt(attempt),
			inventory: snapshot
		});
	} catch (err) {
		res.status(err.statusCode || 500).json({
			success: false,
			error: err.message || '库存读取失败'
		});
	}
});

// ===== CS2「创世终端机」(src/terminal/)=====
// ⚠️ 解封、推进报价不可逆(解封启动 72h 倒计时);这组端点不含花钱兑换报价。
function terminalRoute(key, run, fallback) {
	return async (req, res) => {
		try {
			res.json({success: true, [key]: await run(req)});
		} catch (err) {
			res.status(err && err.statusCode || 500).json({success: false, error: err && err.message || fallback});
		}
	};
}

app.post('/api/terminal/unseal', terminalRoute('result', req => terminal.unseal(req.body || {}), '解封失败'));
// 协议探针:依次发多种候选解封消息,对齐回包 + SO 变动,命中即停。
app.post('/api/terminal/probe', terminalRoute('result', req => terminal.probe(req.body || {}), '探针失败'));
// 推进到下一个报价:不可逆、消耗 1 次挑选。仅在前端强确认后调用。
app.post('/api/terminal/advance-offer', terminalRoute('result', req => terminal.advanceOffer(req.body || {}), '推进报价失败'));
app.post('/api/terminal/request-offers', terminalRoute('result', req => terminal.requestOffers(req.body || {}), '请求报价失败'));
// GC 通路自检:查自己 profile,验证本会话 GC 请求能否收到回包。
app.post('/api/terminal/selftest', terminalRoute('result', req => terminal.selfTest(req.body || {}), '自检失败'));
// 解析已捕获报价里的 faux_itemid → 真实皮肤(GC 检视)。
app.post('/api/terminal/resolve-offers', terminalRoute('result', req => terminal.resolveOffers(req.body || {}), '解析报价失败'));
app.get('/api/terminal/state', terminalRoute('state', req => terminal.state(req.query), '读取终端机状态失败'));

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
	res.json({success: true, accounts: listCookieFlowAccounts(attempts.values(), profiles.cookiesFor)});
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
	res.json({success: true, accounts: listCookieFlowAccounts(attempts.values(), profiles.cookiesFor)});
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

// ===== 充值码兑换(src/wallet/)=====
// body: { pairs:[{account, password, code}...], concurrency };进度经 wallet:redeem 推送
app.post('/api/wallet/redeem', (req, res) => {
	try {
		res.json({success: true, ...wallet.start(req.body || {})});
	} catch (err) {
		res.status(err && err.statusCode || 500).json({success: false, error: err && err.message || '提交兑换任务失败'});
	}
});

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
	sessions.restoreAll(accountName => accountService.restoreCredentials(accountName));
}

function getPurchaseGame(req) {
	return normalizePurchaseGame(
		req && req.query && req.query.game
		|| req && req.body && req.body.game
	);
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

function publicAttempt(attempt) {
	return sessions.publicAttempt(attempt);
}

// 不存在返回 null;损坏时先备份坏文件再返回 null(见 lib/atomic-file.js)。
function readJsonFile(file) {
	return readJsonFileSafe(file);
}

purchase.catalog.preload();
uu.start();

// 按 attemptId 或账号名(不区分大小写)找会话,不看在线状态。
function findAttemptByKey(key) {
	return findAttemptInMap(attempts, key);
}
