// Steam 工具台服务端入口:读配置、打开加密库、组装各业务模块、挂 HTTP 路由和 socket.io、监听端口、优雅关机。
// 业务逻辑都在各模块里(src/<模块>/index.ts),路由在 src/<模块>/routes.ts;这里只做组装。
//
// 运行:node src/main.ts(Node 24 直接跑 TypeScript,不需要构建)。旧版 launcher 仍启动 app/server.js,它只转到这里。

// 这两个 import 必须在最前面:先加载 .env,再加载 GC 库并修好 protobuf 共享根(见各自文件头)
import {APP_DIR, APP_ROOT, WEB_DIST_DIR} from './core/env.ts';
import {GlobalOffensive, TeamFortress2} from './steam/gc-libs.ts';

import {existsSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import type {Server as SocketServer} from 'socket.io';
import {loadConfig} from './config.ts';
import {readJsonFileSafe, writeFileAtomic, writeJsonAtomic} from './core/atomic-file.ts';
import {createAuth} from './core/auth.ts';
import {createOriginCheck, parseCookieSecure, parseTrustProxy} from './core/http.ts';
import {createLauncherBridge} from './core/launcher.ts';
import {openStore} from './store/index.ts';
import type {Store} from './store/index.ts';
import {describeGcItem, loadItemsGameSchema} from './items/schema.ts';
import type {ItemSchema} from './items/schema.ts';
import {createFingerprintStore} from './steam/fingerprint.ts';
import {createSessionManager} from './steam/session-manager.ts';
import type {SteamClient} from './steam/session-manager.ts';
import {currencyIdToIso} from './steam/currencies.ts';
import {installMicroTxnHooks} from './steam/microtxn.ts';
import type {SteamUserClass} from './steam/microtxn.ts';
import {findAttemptByKey, listCookieFlowAccounts} from './steam/attempts.ts';
import {createGcModuleAttacher} from './steam/gc-modules.ts';
import {LOCAL_CM_FALLBACKS} from './steam/cm-fallback.ts';
import {createAccountService, createProfiles, resolveAccountCountry} from './accounts/index.ts';
import {accountRoutes} from './accounts/routes.ts';
import {createInventoryService} from './inventory/index.ts';
import {inventoryRoutes} from './inventory/routes.ts';
import {createTerminalService} from './terminal/index.ts';
import {terminalRoutes} from './terminal/routes.ts';
import {createPurchaseService} from './purchase/index.ts';
import {purchaseRoutes} from './purchase/routes.ts';
import {createUuService} from './uu/index.ts';
import {uuRoutes} from './uu/routes.ts';
import {createMarketService} from './market/index.ts';
import {marketRoutes} from './market/routes.ts';
import {createBuyGameService} from './buygame/index.ts';
import {buyGameRoutes} from './buygame/routes.ts';
import {createWalletService} from './wallet/index.ts';
import {walletRoutes} from './wallet/routes.ts';
import {createWebApp} from './web/app.ts';
import {debugOnly} from './web/http.ts';
import {systemRoutes} from './web/system-routes.ts';

const require = createRequire(import.meta.url);

interface SteamUserModule extends SteamUserClass {
	new (options: Record<string, unknown>): SteamClient;
	EConnectionProtocol: {WebSocket: number};
	EResult?: Record<string, number>;
}

const SteamUser = require('steam-user') as SteamUserModule;
const SteamTotp = require('steam-totp') as {generateAuthCode(sharedSecret: string): string};
const {Server} = require('socket.io') as typeof import('socket.io');

const config = loadConfig(process.env, {appRoot: APP_ROOT, appDir: APP_DIR, webDir: WEB_DIST_DIR});

mkdirSync(config.steamUserDir, {recursive: true});
mkdirSync(config.cookiesDir, {recursive: true});
mkdirSync(config.priceSheetDir, {recursive: true});
mkdirSync(config.catalogCacheDir, {recursive: true});
mkdirSync(config.legacy.uuDir, {recursive: true});

// 不存在返回 null;损坏时先备份坏文件再返回 null(见 src/core/atomic-file.ts)
const readJson = (file: string) => readJsonFileSafe(file);

// ===== 物品 schema(CS2 / TF2)=====
const cs2Schema = loadItemsGameSchema(config.schema.cs2ItemsGame, {
	localizationFile: config.schema.cs2Schinese,
	englishLocalizationFile: config.schema.cs2English
});
if (cs2Schema.error) {
	console.warn('[items_game] failed to load schema:', cs2Schema.error);
}
const tf2Schema = loadItemsGameSchema(config.schema.tf2ItemsGame, {
	localizationFile: existsSync(config.schema.tf2Schinese) ? config.schema.tf2Schinese : config.schema.tf2English,
	englishLocalizationFile: config.schema.tf2English
});
if (tf2Schema.error) {
	console.warn('[tf2 items_game] failed to load schema:', tf2Schema.error);
}

// ===== HTTP / socket.io / 口令鉴权 =====
// 写操作和 WebSocket 握手的 CSRF 兜底:浏览器带的 Origin 必须和请求的 Host 同域,或在 ALLOWED_ORIGINS 里
const isAllowedOrigin = createOriginCheck(config.http.allowedOrigins);
const auth = createAuth({
	envPassword: config.auth.envPassword,
	authFile: config.authFile,
	ttlMs: config.auth.sessionTtlMs,
	cookieSecure: parseCookieSecure(config.http.cookieSecure),
	setupToken: config.auth.setupToken
});

// ===== 加密数据库 =====
// 账户名单、maFile、Steam session、UU token/发货配置都存在这里(敏感字段 AES-256-GCM)。
// 首次启动时把旧版明文 JSON 导入,原文件挪到 data/_migrated_plaintext/ 下等你确认后删除。
// 主密钥:MASTER_KEY 环境变量 > MASTER_KEY_FILE > <安装根>/secrets/master.key(开发环境缺失时自动生成)。
let store: Store;
try {
	store = openStore({
		dataDir: config.dataDir,
		defaultKeyFile: config.defaultKeyFile,
		env: process.env,
		legacy: config.legacy
	});
} catch (err) {
	console.error('[store] 打开数据库失败:', err && (err as Error).message ? (err as Error).message : err);
	process.exit(1);
}

const httpServer = createServer((req, res) => {
	// socket.io 自己处理 /socket.io/ 的请求(握手鉴权见下面的 io.use)
	if (String(req.url || '').startsWith('/socket.io/')) {
		return;
	}
	app(req, res);
});
const io: SocketServer = new Server(httpServer, {
	allowRequest: (req, callback) => callback(null, isAllowedOrigin(req.headers))
});
io.use(auth.socketAuth);
io.on('connection', socket => {
	socket.emit('hello', {ts: Date.now()});
});

// ===== 账号资料、Steam 会话 =====
// 账户指纹(machineID / machineName / User-Agent),按账号名稳定复用
const fingerprints = createFingerprintStore({
	dataDir: config.dataDir,
	log: (level, message) => console.log(`[fingerprint:${level}] ${message}`)
});

// 账号资料:maFile、会话 cookies(加密库)+ 旧版 cookies 文件 / account_cache.json(只读)
const profiles = createProfiles({
	mafiles: store.mafiles,
	sessions: store.sessions,
	cookiesDir: config.cookiesDir,
	accountCacheFile: config.accountCacheFile,
	readJson
});

// 库存:CS2 物品名靠本地 schema 描述 GC 物品;库存数量变了推送会话
const inventory = createInventoryService({
	describeGcItem: item => describeGcItem(cs2Schema, item),
	cookiesFor: profiles.cookiesFor,
	emit: attempt => sessions.emit(attempt)
});

// CS2 终端机:报价皮肤中文名用 ByMykel 皮肤库(data/cs2-skin-db.json 缓存,app/data/ 随包副本),揭示过的报价记在 data/terminal-offers.json
const terminal = createTerminalService({
	findAttempt: key => findAttemptByKey(sessions.attempts, key),
	addLog: (attempt, level, message) => sessions.addLog(attempt, level, message),
	inventory,
	describeGcItem: item => describeGcItem(cs2Schema, item),
	historyFile: join(config.dataDir, 'terminal-offers.json'),
	skinCacheFile: join(config.dataDir, 'cs2-skin-db.json'),
	skinBundledFile: join(config.appDir, 'data', 'cs2-skin-db.json'),
	readJson,
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

// Steam 登录会话。sessions.attempts 是会话表(id -> attempt),内购/库存/UU 等直接读它。
const sessions = createSessionManager({
	createClient(fingerprint) {
		const clientOptions: Record<string, unknown> = {
			dataDirectory: config.steamUserDir,
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
	getFingerprint: accountName => fingerprints.getAccountFingerprint(accountName),
	generateAuthCode: sharedSecret => SteamTotp.generateAuthCode(sharedSecret),
	// 被顶号/会话被替换/封禁/密码错:不自动重连(避免与你在别处的登录抢号/无效硬冲)
	fatalEResults: new Set(['LoggedInElsewhere', 'LogonSessionReplaced', 'AccountDisabled', 'Banned', 'InvalidPassword']
		.map(name => (SteamUser.EResult || {})[name])
		.filter((value): value is number => typeof value === 'number')),
	cmFallbackServers: [...LOCAL_CM_FALLBACKS],
	sessions: store.sessions,
	intents: store.loginIntents,
	onChange: attempt => io.emit('attempt:update', sessions.publicAttempt(attempt)),
	onClientCreated: (attempt, client) => gcModules.attach(attempt, client),
	onWebSession: attempt => accounts.refreshCountry(attempt),   // 后台查真实账户国家(USD 等无法从货币推断)
	currencyIdToIso,
	resolveWalletCountry: attempt => resolveAccountCountry({
		country: attempt.country,
		currency: attempt.currency,
		currencyISO: attempt.currencyISO
	}),
	timing: {
		loginTimeoutMs: config.sessions.loginTimeoutMs,
		loginRetryMax: config.sessions.loginRetryMax,
		reconnectIntervalMs: config.sessions.reconnectIntervalMs,
		reconnectGraceMs: config.sessions.reconnectGraceMs,
		reconnectMaxAttempts: config.sessions.reconnectMaxAttempts,
		restoreIntervalMs: config.sessions.restoreIntervalMs
	}
});
const attempts = sessions.attempts;
const findAttempt = (key: unknown) => findAttemptByKey(attempts, key);
const cookieFlowAccounts = () => listCookieFlowAccounts(attempts.values(), profiles.cookiesFor);

// 账号与登录路由的逻辑;拿到 WebSession 后查真实账户国家也在这里
const accounts = createAccountService({store, sessions, profiles});

// ===== 业务模块 =====
// GC 内购下单时要响应 Steam 的钱包扣款授权请求(steam-user 本身不处理这条消息)
installMicroTxnHooks(SteamUser);

// 游戏内购:商品目录(内存 + data/purchase-catalogs 缓存)和下单任务
const purchase = createPurchaseService({
	attempts,
	events: sessions,
	emitTask: (event, task) => io.emit(event, task),
	schemas: {cs2: cs2Schema, tf2: tf2Schema},
	// 内购只声明了它用到的 schema 字段;传回来的就是上面这两个完整 schema
	describeGcItem: (schema, item) => describeGcItem(schema as ItemSchema, item),
	cacheDir: config.catalogCacheDir,
	priceSheetDir: config.priceSheetDir,
	readJson,
	writeJson: writeJsonAtomic
});

// UU 发货:token 和发货配置在加密库(store.uu);上架时 UU 没给磨损,用外部检视服务兜底
const uu = createUuService({
	store: store.uu,
	attempts: () => attempts.values(),
	emit: (event, payload) => io.emit(event, payload),
	hasMaFile: accountName => profiles.local(accountName).hasMaFile,
	pollIntervalMs: config.uu.pollIntervalMs,
	inspect: {url: config.uu.inspectUrl, key: config.uu.inspectKey}
});

// 市场求购:账本 data/market-buyorders.json 只记本工具挂出的求购;item_nameid 先查缓存 data/market-nameids.json,
// 再查随程序打包的社区库 app/services/nameid-db/
const market = createMarketService({
	findAttempt,
	cookiesFor: profiles.cookiesFor,
	ledgerFile: join(config.dataDir, 'market-buyorders.json'),
	nameIdCacheFile: join(config.dataDir, 'market-nameids.json'),
	nameIdDbDir: join(config.appDir, 'services', 'nameid-db'),
	readJson,
	writeJson: writeJsonAtomic,
	writeText: (file, text) => writeFileAtomic(file, text, 'utf8')
});

// 买游戏:任务只在内存里(最多 50 个),进度经 socket.io 推送
const buyGame = createBuyGameService({
	findAttempt,
	cookiesFor: profiles.cookiesFor,
	emit: (event, task) => io.emit(event, task)
});

// 充值码兑换:没填密码的账号用本地 maFile / 旧 cookies 文件里的 refreshToken 登录,有 shared_secret 自动过令牌
const wallet = createWalletService({
	profileFor: accountName => profiles.local(accountName),
	emit: payload => io.emit('wallet:redeem', payload)
});

// 远程更新(旧版启动器);Docker 部署不经启动器
const launcher = createLauncherBridge({statusFile: config.updateStatusFile});

// ===== 路由 =====
const debug = debugOnly(config.http.debugEndpoints);
const app = createWebApp({
	auth,
	isAllowedOrigin,
	trustProxy: parseTrustProxy(config.http.trustProxy),
	webDir: config.webDir,
	routes: [
		router => systemRoutes(router, {sessionCount: () => attempts.size, launcher}),
		router => accountRoutes(router, {accounts, debug}),
		router => inventoryRoutes(router, {inventory, getAttempt: id => attempts.get(id), publicAttempt: sessions.publicAttempt}),
		router => terminalRoutes(router, {terminal}),
		router => purchaseRoutes(router, {purchase}),
		router => buyGameRoutes(router, {buyGame, listAccounts: cookieFlowAccounts, debug}),
		router => marketRoutes(router, {market, listAccounts: cookieFlowAccounts}),
		router => uuRoutes(router, {uu}),
		router => walletRoutes(router, {wallet})
	]
});

// ===== 启动 =====
httpServer.listen(config.port, config.host, () => {
	const shownHost = config.host === '0.0.0.0' ? '<本机所有网卡>' : config.host;
	console.log(`Steam 工具台 listening on http://${shownHost}:${config.port}`);
	if (!auth.configured) {
		console.warn(`[auth] 尚未设置口令, 请用浏览器打开 /login 设置初始口令(设置前已锁定)`);
		console.warn(`[auth] 初始化令牌: ${auth.setupToken}  (本次启动有效;可用 SETUP_TOKEN 环境变量固定)`);
	}
});

// 未处理的 Promise 拒绝只记日志不退出:进程一退,所有在线 Steam 会话都会掉。
process.on('unhandledRejection', reason => {
	console.error('[unhandledRejection]', reason && (reason as Error).stack ? (reason as Error).stack : reason);
});

// docker stop / Ctrl+C:先登出所有 Steam 会话再退出;10 秒兜底强退。
let shuttingDown = false;
function shutdown(signal: string): void {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	console.log(`[shutdown] 收到 ${signal},登出 ${attempts.size} 个会话并关闭服务`);
	sessions.shutdown();   // 不改登录意图:下次启动照常自动恢复
	uu.stop();
	io.close();
	httpServer.close(() => process.exit(0));
	httpServer.closeAllConnections();
	setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

sessions.start();
if (config.sessions.restoreEnabled) {
	// 按登录意图恢复上次在线的账号:优先用保存的 refreshToken,失效再用名单里的密码 + maFile 令牌
	sessions.restoreAll(accountName => accounts.restoreCredentials(accountName));
}
purchase.catalog.preload();
uu.start();
