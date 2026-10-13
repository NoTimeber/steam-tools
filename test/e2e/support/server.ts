// 端到端测试工具:用临时目录 + 随机端口启动真实的 app/server.js(预加载 offline-preload.cjs:
// 假 steam-user、最小 GC 模拟、外网拦截),
// 外加一个带 cookie / Origin / X-Forwarded-For 的 HTTP 客户端。

import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {openStore} from '../../../src/store/index.ts';
import type {Store} from '../../../src/store/index.ts';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER_ENTRY = join(REPO_ROOT, 'app', 'server.js');
const FAKE_STEAM = join(REPO_ROOT, 'test', 'e2e', 'support', 'offline-preload.cjs');

// 外部环境里可能影响被测服务的变量,启动前一律去掉
const STRIPPED_ENV = [
	'APP_PASSWORD', 'SETUP_TOKEN', 'COOKIE_SECURE', 'NODE_ENV', 'MASTER_KEY', 'MASTER_KEY_FILE', 'TRUST_PROXY',
	'ALLOWED_ORIGINS', 'ENABLE_DEBUG_ENDPOINTS', 'SESSION_RESTORE', 'SESSION_RESTORE_INTERVAL_MS', 'CONFIG_DIR', 'SCHEMA_DIR'
];

export function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `steam-tools-${prefix}-`));
}

export function removeDir(dir: string): void {
	rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.unref();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
		});
	});
}

export interface FakeSteamEvent {
	run: string;
	event: 'logOn' | 'logOff' | 'gamesPlayed' | 'sendToGC' | 'blockedFetch' | 'purchaseInit' | 'microTxnAuthorize' | 'purchaseFinalize'
		| 'uuRequest' | 'offerAccept' | 'offerConfirm' | 'marketRequest' | 'marketConfirmList' | 'marketConfirm' | 'timeOffset' | 'storeRequest' | 'walletRedeem';
	/** walletRedeem:兑换的码 */
	code?: string;
	client?: string;
	details?: Record<string, unknown>;
	apps?: number[];
	appid?: number;
	msgType?: number;
	url?: string;
	/** purchaseInit:解码后的下单请求 */
	body?: {country?: string; language?: number; currency?: number; line_items?: Array<Record<string, number>>; [key: string]: unknown};
	txnId?: string;
	transId?: string;
	approve?: number;
	/** purchaseFinalize:是否已授权、扣款成功 */
	ok?: boolean;
	/** uuRequest:网关、路径、gameid 头、请求体 */
	host?: string;
	path?: string;
	gameid?: string;
	/** offerAccept / offerConfirm */
	offerId?: string;
	identitySecret?: string;
	/** storeRequest:Steam WebAPI 的 input_json */
	input?: Record<string, any>;
	/** marketRequest / storeRequest:请求方法、查询参数、表单、Referer;owner 是 cookie 里的 steamLoginSecure(区分账号) */
	method?: string;
	query?: Record<string, string>;
	form?: Record<string, string>;
	referer?: string;
	owner?: string;
	/** marketConfirmList / marketConfirm:确认 key 的 tag、确认项 id、是否同意 */
	tag?: string;
	confId?: string;
	accept?: boolean;
}

export interface StartOptions {
	/** 复用同一套目录(模拟重启);不传则新建临时目录 */
	appRoot?: string;
	dataDir?: string;
	env?: Record<string, string>;
	/** 写进假 Steam 日志的轮次标记 */
	run?: string | number;
}

export class TestServer {
	readonly baseUrl: string;
	readonly port: number;
	readonly appRoot: string;
	readonly dataDir: string;
	readonly steamLogFile: string;
	readonly run: string;
	private readonly child: ChildProcess;
	private readonly chunks: string[] = [];

	constructor(child: ChildProcess, port: number, appRoot: string, dataDir: string, steamLogFile: string, run: string) {
		this.child = child;
		this.port = port;
		this.baseUrl = `http://127.0.0.1:${port}`;
		this.appRoot = appRoot;
		this.dataDir = dataDir;
		this.steamLogFile = steamLogFile;
		this.run = run;
		child.stdout?.on('data', chunk => this.chunks.push(String(chunk)));
		child.stderr?.on('data', chunk => this.chunks.push(String(chunk)));
	}

	output(): string {
		return this.chunks.join('');
	}

	/** 本次启动以来假 Steam 收到的调用 */
	steamEvents(): FakeSteamEvent[] {
		if (!existsSync(this.steamLogFile)) {
			return [];
		}
		return readFileSync(this.steamLogFile, 'utf8').trim().split('\n').filter(Boolean)
			.map(line => JSON.parse(line) as FakeSteamEvent)
			.filter(event => event.run === this.run);
	}

	/** 启动日志里打印的初始化令牌 */
	setupToken(): string {
		return (this.output().match(/初始化令牌: ([0-9a-f]+)/) ?? [])[1] ?? '';
	}

	get exited(): boolean {
		return this.child.exitCode !== null || this.child.signalCode !== null;
	}

	/** 直接杀进程(模拟断电/崩溃),之后可以用同一套目录重新 start */
	async kill(): Promise<void> {
		if (this.exited) {
			return;
		}
		const exited = new Promise(resolve => this.child.once('exit', resolve));
		this.child.kill();
		await exited;
		await sleep(200);   // Windows 上让出数据库文件句柄
	}

	/** 用同一把主密钥从外部打开数据库(只读核对用,用完 close) */
	openStore(): Store {
		return openStore({
			dataDir: this.dataDir,
			defaultKeyFile: join(this.appRoot, 'secrets', 'master.key'),
			env: {},
			logger: {log() {}, warn() {}, error() {}}
		});
	}
}

async function waitReady(server: TestServer): Promise<void> {
	for (let i = 0; i < 120; i++) {
		if (server.exited) {
			throw new Error('被测服务启动即退出:\n' + server.output());
		}
		try {
			const res = await fetch(server.baseUrl + '/healthz');
			if (res.ok) {
				return;
			}
		} catch {
			// 还没监听
		}
		await sleep(100);
	}
	throw new Error('被测服务 12 秒内没有就绪:\n' + server.output());
}

/** 启动被测服务;只想检查"启动失败"时传 expectExit */
export async function startServer(options: StartOptions = {}): Promise<TestServer> {
	const appRoot = options.appRoot ?? tempDir('root');
	const dataDir = options.dataDir ?? join(appRoot, 'data');
	const port = await freePort();
	const run = String(options.run ?? '1');
	const steamLogFile = join(appRoot, 'fake-steam.log');
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !STRIPPED_ENV.includes(key)) {
			env[key] = value;
		}
	}
	Object.assign(env, {
		APP_ROOT: appRoot,
		DATA_DIR: dataDir,
		PORT: String(port),
		HOST: '127.0.0.1',
		FAKE_STEAM_LOG: steamLogFile,
		FAKE_STEAM_RUN: run
	}, options.env);
	const child = spawn(process.execPath, ['--require', FAKE_STEAM, SERVER_ENTRY], {cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
	const server = new TestServer(child, port, appRoot, dataDir, steamLogFile, run);
	await waitReady(server);
	return server;
}

/** 启动后预期立即退出(如主密钥不对),返回退出码和输出 */
export async function startExpectingExit(options: StartOptions): Promise<{code: number | null; output: string}> {
	const appRoot = options.appRoot ?? tempDir('root');
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !STRIPPED_ENV.includes(key)) {
			env[key] = value;
		}
	}
	Object.assign(env, {APP_ROOT: appRoot, DATA_DIR: options.dataDir ?? join(appRoot, 'data'), PORT: String(await freePort()), HOST: '127.0.0.1'}, options.env);
	const child = spawn(process.execPath, ['--require', FAKE_STEAM, SERVER_ENTRY], {cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
	const chunks: string[] = [];
	child.stdout.on('data', chunk => chunks.push(String(chunk)));
	child.stderr.on('data', chunk => chunks.push(String(chunk)));
	const code = await Promise.race([
		new Promise<number | null>(resolve => child.once('exit', code => resolve(code))),
		sleep(15000).then(() => {
			child.kill();
			return -999;
		})
	]);
	return {code, output: chunks.join('')};
}

// ===== HTTP 客户端 =====

export interface Response {
	status: number;
	headers: Headers;
	text: string;
	json: any;
}

export interface RequestOptions {
	body?: unknown;
	headers?: Record<string, string>;
	/** 经反代转发的客户端 IP(服务默认信任本机反代);不传则每次换一个,避免撞上登录限速 */
	ip?: string;
	/** 默认:非 GET 请求带同源 Origin */
	origin?: string | null;
}

let ipCounter = 10;

export class Client {
	cookie = '';
	readonly baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	async request(method: string, url: string, options: RequestOptions = {}): Promise<Response> {
		const headers: Record<string, string> = {
			'x-forwarded-for': options.ip ?? `198.51.100.${(ipCounter++ % 250) + 1}`,
			...options.headers
		};
		if (options.body !== undefined) {
			headers['content-type'] = 'application/json';
		}
		const origin = options.origin === undefined ? (method === 'GET' ? null : this.baseUrl) : options.origin;
		if (origin) {
			headers.origin = origin;
		}
		if (this.cookie && !headers.cookie) {
			headers.cookie = this.cookie;
		}
		const res = await fetch(this.baseUrl + url, {
			method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			redirect: 'manual'
		});
		const text = await res.text();
		let json: unknown = null;
		try {
			json = JSON.parse(text);
		} catch {
			// 非 JSON
		}
		return {status: res.status, headers: res.headers, text, json};
	}

	get(url: string, options?: RequestOptions) {
		return this.request('GET', url, options);
	}

	post(url: string, body?: unknown, options: RequestOptions = {}) {
		return this.request('POST', url, {...options, body});
	}

	delete(url: string, body?: unknown, options: RequestOptions = {}) {
		return this.request('DELETE', url, {...options, body});
	}

	/** 从 Set-Cookie 里取会话 cookie 并记住 */
	adoptCookie(res: Response): string {
		const match = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]*/);
		this.cookie = match ? match[0] : '';
		return this.cookie;
	}

	/** 用环境变量口令(APP_PASSWORD)登录 */
	async login(password: string): Promise<void> {
		const res = await this.post('/api/auth/login', {password});
		if (res.status !== 200) {
			throw new Error(`登录失败 ${res.status}: ${res.text}`);
		}
		this.adoptCookie(res);
	}
}

// ===== socket.io 推送 =====

/** 极简 socket.io 客户端(Engine.IO v4 over WebSocket):收集服务端推送的事件 */
export class SocketListener {
	readonly events: Array<{name: string; payload: any}> = [];
	private readonly ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.ws = ws;
	}

	/** 用登录后的 cookie 连上,等到命名空间连接成功 */
	static connect(client: Client, timeoutMs = 5000): Promise<SocketListener> {
		const url = client.baseUrl.replace('http', 'ws') + '/socket.io/?EIO=4&transport=websocket';
		// Node 的 WebSocket(undici)支持自定义握手头
		const ws = new WebSocket(url, {headers: {cookie: client.cookie, origin: client.baseUrl}} as unknown as string[]);
		const listener = new SocketListener(ws);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('socket.io 连接超时')), timeoutMs);
			ws.onmessage = event => {
				const message = String(event.data);
				if (message.startsWith('0{')) {
					ws.send('40');
				} else if (message === '2') {
					ws.send('3');   // 心跳
				} else if (message.startsWith('40')) {
					clearTimeout(timer);
					resolve(listener);
				} else if (message.startsWith('44')) {
					clearTimeout(timer);
					reject(new Error('socket.io 拒绝连接: ' + message));
				} else if (message.startsWith('42')) {
					const [name, payload] = JSON.parse(message.slice(2)) as [string, unknown];
					listener.events.push({name, payload});
				}
			};
			ws.onerror = () => reject(new Error('socket.io 连接失败'));
		});
	}

	named(name: string): any[] {
		return this.events.filter(event => event.name === name).map(event => event.payload);
	}

	/** 等到某个事件满足条件 */
	async waitFor(name: string, ok: (payload: any) => boolean, timeoutMs = 10000): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.named(name).find(ok);
			if (found) {
				return found;
			}
			await sleep(50);
		}
		throw new Error(`等 ${name} 超时;已收到: ${JSON.stringify(this.named(name)).slice(0, 2000)}`);
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			// 已关闭
		}
	}
}

export {sleep};
