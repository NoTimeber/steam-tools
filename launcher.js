'use strict';

/**
 * launcher.js —— 稳定启动层(install root)。
 *
 * 职责(本身几乎不更新,只用 Node 内置模块,不依赖 node_modules):
 *   1. 应用上一轮运行时已暂存好的更新(app.next → app)。
 *   2. 冷启动时拉取清单、验签、下载、校验、暂存并应用最新代码。
 *   3. 以子进程方式拉起 app/server.js(注入 APP_ROOT)。
 *   4. 运行时定时检查:有新版仅"暂存"(app.next),不打断当前会话;
 *      写 data/update-status.json 供前端提示"重启生效"。
 *   5. 子进程启动即崩 → 自动回滚到 app.prev,避免一次坏推送把客户端打挂。
 *
 * 任何网络/验签/下载失败都"降级",直接用本地现有版本启动,绝不卡死。
 *
 * 目录约定(均在 install root 下):
 *   app/        当前运行的代码(随更新整包替换)
 *   app.next/   已下载校验、等待下次启动生效的新版本
 *   app.prev/   上一版本备份,供回滚
 *   data/       运行数据(不随更新动)
 *   .env        用户配置(不随更新动)
 *   node_modules/  依赖(仅当 depsHash 变化才 npm install)
 *   version.json   本地版本状态 {code, depsHash}
 *   public-key.pem 更新签名公钥(用于验签)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {spawn, execFileSync, execSync} = require('child_process');

const INSTALL_ROOT = __dirname;
const APP_DIR = path.join(INSTALL_ROOT, 'app');
const APP_NEXT = path.join(INSTALL_ROOT, 'app.next');
const APP_PREV = path.join(INSTALL_ROOT, 'app.prev');
const CACHE_DIR = path.join(INSTALL_ROOT, '.cache');
const VERSION_FILE = path.join(INSTALL_ROOT, 'version.json');
const PUBKEY_FILE = path.join(INSTALL_ROOT, 'public-key.pem');
const READY_MARKER = '.ready';
const APP_ENTRY = path.join(APP_DIR, 'server.js');
const UPDATE_STATUS_FILE = path.join(INSTALL_ROOT, 'data', 'update-status.json');

// 先尝试加载 .env,好让 UPDATE_MANIFEST_URL / 检查间隔等可被用户覆盖。
try {
	process.loadEnvFile(path.join(INSTALL_ROOT, '.env'));
} catch (_) {
	// 无 .env 时忽略
}

// 更新托管在 GitHub Releases:配置 GITHUB_REPO=owner/repo 即可。
// 清单走 latest 稳定链接,zip 走 manifest 里版本固定的 tag 链接(由 build-release 写入)。
const GITHUB_REPO = (process.env.GITHUB_REPO || '').trim();
const MANIFEST_URL = process.env.UPDATE_MANIFEST_URL
	|| (GITHUB_REPO ? `https://github.com/${GITHUB_REPO}/releases/latest/download/manifest.json` : '');
// 国内加速:可选镜像前缀(如 https://ghproxy.com/),清单与 zip 下载都会经它;sha256/签名仍校验,经镜像安全。
const DL_PREFIX = (process.env.UPDATE_DOWNLOAD_PREFIX || '').trim();
const AUTO_UPDATE = String(process.env.AUTO_UPDATE || '1') !== '0';

/** 若配置了镜像前缀,把下载 URL 经镜像改写。 */
function mirror(url) { return DL_PREFIX ? DL_PREFIX + url : url; }
// 默认每天检查一次(可用 UPDATE_CHECK_INTERVAL_MS 覆盖);冷启动时额外检查一次。
const CHECK_INTERVAL_MS = Math.max(60_000, Number(process.env.UPDATE_CHECK_INTERVAL_MS || 24 * 60 * 60 * 1000));
const NET_TIMEOUT_MS = Number(process.env.UPDATE_NET_TIMEOUT_MS || 15_000);
const CRASH_WINDOW_MS = 8_000;   // 子进程启动 8s 内退出视为"启动即崩"
const MAX_RESTARTS = 5;          // 正常运行后崩溃的有限重启次数
const RESTART_CODE = 75;         // 与 server.js 的 RESTART_EXIT_CODE 一致:子进程请求"应用更新并重启"

function log(...a) { console.log('[launcher]', ...a); }
function warn(...a) { console.warn('[launcher]', ...a); }

function readJson(file, fallback) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
	catch (_) { return fallback; }
}
function writeJson(file, obj) {
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function rmrf(p) {
	try { fs.rmSync(p, {recursive: true, force: true}); } catch (_) {}
}
function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}
function cmpVersion(a, b) {
	// 简易 semver/数字比较:逐段比较,缺位补 0。返回 a>b:1, a<b:-1, 相等:0
	const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
	const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const x = pa[i] || 0, y = pb[i] || 0;
		if (x > y) return 1;
		if (x < y) return -1;
	}
	return 0;
}

function localVersion() {
	return readJson(VERSION_FILE, {code: '0.0.0', depsHash: ''});
}

/** 用内嵌公钥验证清单签名,返回解析后的清单对象;失败抛错。 */
function fetchAndVerifyManifest() {
	if (!MANIFEST_URL) throw new Error('未配置更新地址(GITHUB_REPO 或 UPDATE_MANIFEST_URL)');
	let publicKey;
	try {
		publicKey = crypto.createPublicKey(fs.readFileSync(PUBKEY_FILE));
	} catch (e) {
		throw new Error('缺少/无法读取 public-key.pem,跳过更新: ' + e.message);
	}
	return withTimeout(NET_TIMEOUT_MS, async (signal) => {
		const res = await fetch(mirror(MANIFEST_URL), {signal, cache: 'no-store'});
		if (!res.ok) throw new Error('清单 HTTP ' + res.status);
		const outer = await res.json();          // {payload: base64, sig: base64}
		if (!outer || !outer.payload || !outer.sig) throw new Error('清单格式不对');
		const payload = Buffer.from(outer.payload, 'base64');
		const sig = Buffer.from(outer.sig, 'base64');
		const ok = crypto.verify(null, payload, publicKey, sig);   // Ed25519: 算法传 null
		if (!ok) throw new Error('清单签名校验失败 —— 拒绝更新');
		return JSON.parse(payload.toString('utf8'));
	});
}

async function withTimeout(ms, fn) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ms);
	try { return await fn(ctrl.signal); }
	finally { clearTimeout(t); }
}

/** 下载并校验 sha256,返回 Buffer。 */
async function downloadVerified(url, expectSha) {
	return withTimeout(NET_TIMEOUT_MS * 4, async (signal) => {
		const res = await fetch(mirror(url), {signal, cache: 'no-store'});
		if (!res.ok) throw new Error('下载 HTTP ' + res.status);
		const buf = Buffer.from(await res.arrayBuffer());
		const got = sha256(buf);
		if (expectSha && got !== expectSha) {
			throw new Error(`sha256 不匹配: 期望 ${expectSha} 实得 ${got}`);
		}
		return buf;
	});
}

/** 用随包下发的对称密钥 AES-256-GCM 解密(iv/authTag 来自已签名清单)。 */
function decryptBlob(buf, code) {
	const keyFile = path.join(INSTALL_ROOT, 'update-key.bin');
	const key = fs.readFileSync(keyFile);
	const d = crypto.createDecipheriv('aes-256-gcm', key,
		Buffer.from(code.iv, 'base64'));
	d.setAuthTag(Buffer.from(code.authTag, 'base64'));
	return Buffer.concat([d.update(buf), d.final()]);   // authTag 不符会在 final() 抛错
}

/** 用 PowerShell Expand-Archive 解压 zip 到目标目录(零依赖)。 */
function extractZip(zipPath, destDir) {
	rmrf(destDir);
	fs.mkdirSync(destDir, {recursive: true});
	execFileSync('powershell', [
		'-NoProfile', '-NonInteractive', '-Command',
		`Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
	], {stdio: 'ignore'});
}

/**
 * 下载并把 code 版本暂存到 app.next/,写入 .ready 标记。
 * 不做切换(切换只在启动时、子进程未运行时进行)。
 */
async function stageCode(code) {
	fs.mkdirSync(CACHE_DIR, {recursive: true});
	log(`下载新版本 ${code.version} ...`);
	const buf = await downloadVerified(code.url, code.sha256);   // 先按密文校验 sha256
	const zipBuf = code.encrypted ? decryptBlob(buf, code) : buf;  // 再解密成明文 zip
	const zipPath = path.join(CACHE_DIR, `app-${code.version}.zip`);
	fs.writeFileSync(zipPath, zipBuf);
	log('解压到 app.next ...');
	extractZip(zipPath, APP_NEXT);
	rmrf(zipPath);
	// 解压后 app.next 内应直接是 server.js 等(zip 以 app/ 内容为根)
	if (!fs.existsSync(path.join(APP_NEXT, 'server.js'))) {
		throw new Error('暂存包损坏:app.next/server.js 不存在');
	}
	writeJson(path.join(APP_NEXT, READY_MARKER), {
		version: code.version,
		depsHash: code.depsHash || '',
		sha256: code.sha256
	});
	log(`新版本 ${code.version} 已暂存,重启后生效`);
}

/** 若 app.next 已就绪,执行原子切换 app→app.prev、app.next→app,并按需 npm install。 */
function applyStagedIfReady() {
	const marker = path.join(APP_NEXT, READY_MARKER);
	if (!fs.existsSync(marker)) return false;
	const ready = readJson(marker, null);
	if (!ready || !fs.existsSync(path.join(APP_NEXT, 'server.js'))) {
		rmrf(APP_NEXT);
		return false;
	}
	log(`应用已暂存版本 ${ready.version} ...`);
	rmrf(APP_PREV);
	if (fs.existsSync(APP_DIR)) fs.renameSync(APP_DIR, APP_PREV);
	fs.renameSync(APP_NEXT, APP_DIR);

	const prev = localVersion();
	writeJson(VERSION_FILE, {code: ready.version, depsHash: prev.depsHash});
	writeUpdateStatus({pending: false, current: ready.version, checkedAt: nowIso()});

	// 依赖变化:把新版 package 文件提升到 install root 并安装(node_modules 始终在 root)
	if (ready.depsHash && ready.depsHash !== prev.depsHash) {
		try {
			for (const f of ['package.json', 'package-lock.json']) {
				const src = path.join(APP_DIR, f);
				if (fs.existsSync(src)) fs.copyFileSync(src, path.join(INSTALL_ROOT, f));
			}
			log('依赖有变化,执行 npm install ...');
			// 用 execSync 走 shell:Windows 新版 Node 禁止用 execFile 直接拉起 .cmd(EINVAL)
			execSync('npm install --no-audit --no-fund', {cwd: INSTALL_ROOT, stdio: 'inherit'});
			writeJson(VERSION_FILE, {code: ready.version, depsHash: ready.depsHash});
		} catch (e) {
			warn('npm install 失败(保留旧依赖,可能触发回滚):', e.message);
		}
	}
	return true;
}

/** 回滚到 app.prev(用于启动即崩)。成功返回 true。 */
function rollback() {
	if (!fs.existsSync(APP_PREV)) return false;
	warn('检测到启动即崩,回滚到上一版本 ...');
	const broken = path.join(INSTALL_ROOT, 'app.broken');
	rmrf(broken);
	if (fs.existsSync(APP_DIR)) fs.renameSync(APP_DIR, broken);
	fs.renameSync(APP_PREV, APP_DIR);
	rmrf(broken);
	return true;
}

function writeUpdateStatus(obj) {
	try { writeJson(UPDATE_STATUS_FILE, obj); } catch (_) {}
}

// 防止"定时检查"与"前端手动检查"并发拉取/暂存导致 app.next 竞争。
let updateChecking = false;

/**
 * 检查更新(并发安全外壳)。
 *   applyNow=true(冷启动):有新版则暂存并立刻切换(此时子进程未运行)。
 *   applyNow=false(运行时/手动):仅暂存,写 update-status 提示前端"重启生效"。
 */
async function checkUpdate(applyNow) {
	if (updateChecking) return;
	updateChecking = true;
	try {
		await doCheckUpdate(applyNow);
	} finally {
		updateChecking = false;
	}
}

async function doCheckUpdate(applyNow) {
	if (!AUTO_UPDATE) return;
	let manifest;
	try {
		manifest = await fetchAndVerifyManifest();
	} catch (e) {
		warn('检查更新跳过:', e.message);
		return;
	}
	const code = manifest && manifest.code;
	if (!code || !code.version) return;
	const local = localVersion();
	if (cmpVersion(code.version, local.code) <= 0) {
		writeUpdateStatus({pending: false, current: local.code, checkedAt: nowIso()});
		return;   // 已是最新
	}
	try {
		await stageCode(code);
		if (applyNow) {
			applyStagedIfReady();
		} else {
			writeUpdateStatus({
				pending: true, current: local.code, available: code.version,
				notes: code.notes || '', checkedAt: nowIso()
			});
		}
	} catch (e) {
		warn('暂存更新失败:', e.message);
	}
}

function nowIso() {
	// 启动时刻通过子进程时间即可;此处仅用于提示,容错处理
	try { return new Date().toISOString(); } catch (_) { return ''; }
}

// ---------------- 子进程监管 ----------------
let child = null;
let restarts = 0;
let intervalTimer = null;

function startChild() {
	const startedAt = Date.now();
	log('启动 app/server.js ...');
	child = spawn(process.execPath, [APP_ENTRY], {
		cwd: INSTALL_ROOT,
		env: {...process.env, APP_ROOT: INSTALL_ROOT},
		// 第 4 个 fd 给 IPC：让子进程(server)能请求"立即检查更新"。前三路仍直通控制台。
		stdio: ['inherit', 'inherit', 'inherit', 'ipc']
	});

	// 前端「检查更新」→ server 经 IPC 转发到此；执行真实检查后把最新状态回传给 server。
	child.on('message', (msg) => {
		if (!msg || msg.type !== 'check-update') return;
		log('收到手动检查更新请求 ...');
		checkUpdate(false)
			.catch((e) => warn('手动检查更新异常:', e.message))
			.finally(() => {
				const status = readJson(UPDATE_STATUS_FILE, {pending: false});
				try { if (child) child.send({type: 'check-update-done', status}); } catch (_) {}
			});
	});

	child.on('exit', (code, signal) => {
		const uptime = Date.now() - startedAt;
		child = null;
		if (signal === 'SIGINT' || signal === 'SIGTERM') {
			log('子进程被信号终止,退出 launcher'); cleanupExit(0); return;
		}
		if (code === 0) {
			log('子进程正常退出'); cleanupExit(0); return;
		}
		// 子进程请求"应用更新并重启"(前端点了"立即重启生效")。先于崩溃判断处理。
		if (code === RESTART_CODE) {
			log('收到重启请求,应用暂存更新(如有)并重启 ...');
			try { applyStagedIfReady(); } catch (e) { warn('应用暂存更新失败:', e.message); }
			restarts = 0;
			startChild();
			return;
		}
		// 非零退出
		if (uptime < CRASH_WINDOW_MS) {
			// 启动即崩:尝试回滚一次
			if (rollback()) {
				const prev = localVersion();
				// version.json 记的是坏版本号,这里无法精确还原,标记为未知,等下次检查纠正
				writeJson(VERSION_FILE, {code: '0.0.0', depsHash: prev.depsHash});
				warn('已回滚,重启 ...');
				startChild();
				return;
			}
			warn(`子进程启动即崩(退出码 ${code})且无可回滚版本,放弃。`);
			cleanupExit(code || 1);
			return;
		}
		// 运行一段时间后崩溃:有限次重启
		if (restarts < MAX_RESTARTS) {
			restarts++;
			warn(`子进程退出(码 ${code}),第 ${restarts}/${MAX_RESTARTS} 次重启 ...`);
			startChild();
		} else {
			warn('重启次数耗尽,退出 launcher。');
			cleanupExit(code || 1);
		}
	});
}

function cleanupExit(code) {
	if (intervalTimer) clearInterval(intervalTimer);
	process.exit(code);
}

// 让 Ctrl+C / 关闭窗口能把子进程一起带走
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => {
		if (child) { try { child.kill(); } catch (_) {} }
		else cleanupExit(0);
	});
}

async function main() {
	log(`install root: ${INSTALL_ROOT}`);
	log(`manifest: ${MANIFEST_URL || '(未配置)'}  自动更新: ${AUTO_UPDATE ? '开' : '关'}` +
		(DL_PREFIX ? `  镜像: ${DL_PREFIX}` : ''));

	// 1) 应用上一轮运行时已暂存的更新
	try { applyStagedIfReady(); } catch (e) { warn('应用暂存更新失败:', e.message); }

	// 2) 冷启动检查并立即生效
	await checkUpdate(true);

	// app/ 必须存在才能启动
	if (!fs.existsSync(APP_ENTRY)) {
		warn('致命:找不到 app/server.js,无法启动。'); process.exit(1);
	}

	// 3) 拉起子进程
	startChild();

	// 4) 运行时定时检查(仅暂存)
	intervalTimer = setInterval(() => {
		checkUpdate(false).catch((e) => warn('定时检查异常:', e.message));
	}, CHECK_INTERVAL_MS);
}

main().catch((e) => { warn('launcher 致命错误:', e); process.exit(1); });
