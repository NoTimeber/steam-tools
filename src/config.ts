// 运行配置:环境变量(含安装根下的 .env,见 ./core/env.ts)→ 目录、端口、超时等。环境变量基本都在这里读,
// 例外:APP_ROOT(./core/env.ts)、主密钥 MASTER_KEY / MASTER_KEY_FILE(store 自己读)、STEAM_WEB_USER_AGENT(./steam/community.ts)。

import {join, resolve} from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
	/** 安装根:存放 data/、.env、secrets/,不随代码更新动 */
	appRoot: string;
	/** 随代码发布的目录(app/):物品 schema、随包皮肤库、社区 nameid 库 */
	appDir: string;
	/** 前端(Vue,web/ 的构建产物),挂在 / */
	webDir: string;
	host: string;
	port: number;

	/** 运行数据目录。Docker 部署时挂卷到这里(DATA_DIR=/data),本地默认是安装根下的 data/ */
	dataDir: string;
	steamUserDir: string;
	priceSheetDir: string;
	catalogCacheDir: string;
	/** 加密库主密钥文件的缺省位置(MASTER_KEY / MASTER_KEY_FILE 都没给时用) */
	defaultKeyFile: string;
	/** launcher 在检测到新版本时写这个文件;前端据此提示"重启生效" */
	updateStatusFile: string;
	/** 共享配置目录(CONFIG_DIR):口令、旧版 cookies、account_cache.json */
	configDir: string;
	cookiesDir: string;
	accountCacheFile: string;
	authFile: string;
	/** 旧版明文文件,首次启动导入加密库用 */
	legacy: {
		accountsFile: string;
		mafileDir: string;
		sessionDir: string;
		uuDir: string;
		uuTokensFile: string;
		uuConfigFile: string;
		uuLastTokenFile: string;
	};

	/**
	 * 静态参考资料(CS2/TF2 物品 schema + 本地化文案)。放在 app/schema/ 内随代码发布,
	 * schema 更新能跟着代码一起下发。可用 SCHEMA_DIR 覆盖
	 */
	schema: {
		cs2ItemsGame: string;
		cs2Schinese: string;
		cs2English: string;
		tf2ItemsGame: string;
		tf2Schinese: string;
		tf2English: string;
	};

	http: {
		trustProxy: string | undefined;
		allowedOrigins: string | undefined;
		cookieSecure: string | undefined;
		/** 调试端点(会返回 Steam cookies / 可触发真实下单),ENABLE_DEBUG_ENDPOINTS=1 才开 */
		debugEndpoints: boolean;
	};
	auth: {
		/** APP_PASSWORD:没在网页里设过口令时用它(只作引导/兼容) */
		envPassword: string;
		sessionTtlMs: number;
		setupToken: string;
	};
	sessions: {
		/** 登录重试:连接卡住(超时未拿到 WebSession)时自动重试,避免永久卡在"登录中" */
		loginTimeoutMs: number;
		loginRetryMax: number;
		/** 掉线重连看门狗(steam-user autoRelogin 的兜底):扫描间隔 / 先给 autoRelogin 的宽限期 / 最多重连次数 */
		reconnectIntervalMs: number;
		reconnectGraceMs: number;
		reconnectMaxAttempts: number;
		/** 服务重启后自动恢复登录:SESSION_RESTORE=0 关闭;账号之间间隔(防 Steam 限频) */
		restoreEnabled: boolean;
		restoreIntervalMs: number;
	};
	uu: {
		/** 轮询间隔;数据库里改过的优先 */
		pollIntervalMs: number | undefined;
		/** 上架时 UU 没给磨损,用外部检视服务兜底(见 inspect-service/) */
		inspectUrl: string;
		inspectKey: string;
	};
}

/** 数字型环境变量:没给或不是数字用缺省值,再夹到下限 */
function atLeast(value: string | undefined, fallback: number, min: number): number {
	const parsed = Number(value || fallback);
	return Math.max(min, Number.isFinite(parsed) ? parsed : fallback);
}

export interface ConfigDirs {
	appRoot: string;
	appDir: string;
	webDir: string;
}

export function loadConfig(env: Env, dirs: ConfigDirs): Config {
	const {appRoot, appDir, webDir} = dirs;
	const dataDir = env.DATA_DIR ? resolve(env.DATA_DIR) : join(appRoot, 'data');
	const configDir = env.CONFIG_DIR ? resolve(env.CONFIG_DIR) : join(dataDir, 'config');
	const schemaDir = env.SCHEMA_DIR ? resolve(env.SCHEMA_DIR) : join(appDir, 'schema');
	const uuDir = join(dataDir, 'uu');

	return {
		appRoot,
		appDir,
		webDir,
		host: env.HOST || '0.0.0.0',
		port: Number(env.PORT || 53110),

		dataDir,
		steamUserDir: join(dataDir, 'steam-user'),
		priceSheetDir: join(dataDir, 'price-sheets'),
		catalogCacheDir: join(dataDir, 'purchase-catalogs'),
		defaultKeyFile: join(appRoot, 'secrets', 'master.key'),
		updateStatusFile: join(dataDir, 'update-status.json'),
		configDir,
		cookiesDir: join(configDir, 'cookies'),
		accountCacheFile: join(configDir, 'account_cache.json'),
		authFile: join(configDir, 'auth.json'),
		legacy: {
			accountsFile: join(configDir, 'accounts.json'),
			mafileDir: join(configDir, 'mafile'),
			sessionDir: join(dataDir, 'sessions'),
			uuDir,
			uuTokensFile: join(uuDir, 'tokens.json'),
			uuConfigFile: join(uuDir, 'delivery-config.json'),
			uuLastTokenFile: join(uuDir, 'last-token.txt')
		},

		schema: {
			cs2ItemsGame: env.CS2_ITEMS_GAME_FILE ? resolve(env.CS2_ITEMS_GAME_FILE) : join(schemaDir, 'items_game.txt'),
			cs2Schinese: join(schemaDir, 'csgo_schinese.txt'),
			cs2English: join(schemaDir, 'csgo_english.txt'),
			tf2ItemsGame: env.TF2_ITEMS_GAME_FILE ? resolve(env.TF2_ITEMS_GAME_FILE) : join(schemaDir, 'tf2_items_game.txt'),
			tf2Schinese: join(schemaDir, 'tf2_schinese.txt'),
			tf2English: join(schemaDir, 'tf2_english.txt')
		},

		http: {
			trustProxy: env.TRUST_PROXY,
			allowedOrigins: env.ALLOWED_ORIGINS,
			cookieSecure: env.COOKIE_SECURE,
			debugEndpoints: String(env.ENABLE_DEBUG_ENDPOINTS || '') === '1'
		},
		auth: {
			envPassword: env.APP_PASSWORD || '',
			sessionTtlMs: Number(env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000),
			setupToken: env.SETUP_TOKEN || ''
		},
		sessions: {
			loginTimeoutMs: atLeast(env.LOGIN_TIMEOUT_MS, 45000, 10000),
			loginRetryMax: atLeast(env.LOGIN_RETRY_MAX, 2, 0),
			reconnectIntervalMs: atLeast(env.RECONNECT_WATCHDOG_INTERVAL_MS, 30000, 15000),
			reconnectGraceMs: atLeast(env.RECONNECT_GRACE_MS, 90000, 30000),
			reconnectMaxAttempts: atLeast(env.RECONNECT_MAX_ATTEMPTS, 6, 1),
			restoreEnabled: String(env.SESSION_RESTORE || '1') !== '0',
			restoreIntervalMs: atLeast(env.SESSION_RESTORE_INTERVAL_MS, 3000, 1000)
		},
		uu: {
			pollIntervalMs: Number(env.UU_POLL_INTERVAL_MS) || undefined,
			inspectUrl: env.INSPECT_SERVICE_URL || '',
			inspectKey: env.INSPECT_KEY || ''
		}
	};
}
