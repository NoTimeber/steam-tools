'use strict';

/**
 * 打包并签名一个发布版本。
 *
 *   node tools/build-release.js <version> ["更新说明"]
 *   例: node tools/build-release.js 1.0.1 "修复 UU 发货签名"
 *
 * 产物(release/ 目录):
 *   app-<version>.zip   ← app/ 内容 + package.json/package-lock.json
 *   manifest.json       ← 含 sha256/depsHash 的已签名清单
 *
 * 发布 = 把这两个文件上传到你的服务器:
 *   manifest.json → UPDATE_MANIFEST_URL 指向的地址
 *   app-<version>.zip → manifest.code.url 指向的地址
 *
 * 基址通过环境变量配置(默认 https://nonoxd.top/steam-tools/):
 *   UPDATE_BASE_URL=https://nonoxd.top/steam-tools/ node tools/build-release.js 1.0.1
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');

const ROOT = path.join(__dirname, '..');

// 读取根目录 .env，让 GITHUB_REPO / UPDATE_BASE_URL 等无需每次命令行传入。
// 命令行/外部已设置的环境变量优先于 .env。
try {
	const dotenv = path.join(ROOT, '.env');
	if (fs.existsSync(dotenv)) {
		for (const line of fs.readFileSync(dotenv, 'utf8').split(/\r?\n/)) {
			const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
			if (!m || line.trim().startsWith('#')) continue;
			const key = m[1];
			let val = m[2].trim().replace(/^["']|["']$/g, '');
			if (process.env[key] === undefined) process.env[key] = val;
		}
	}
} catch (_) {}

const APP_DIR = path.join(ROOT, 'app');
// 签名私钥放在项目目录之外,避免误提交/误打包。可用 UPDATE_KEY_DIR 覆盖。
const KEY_DIR = process.env.UPDATE_KEY_DIR ? path.resolve(process.env.UPDATE_KEY_DIR) : path.join(os.homedir(), '.steam-tools-keys');
const PRIV = path.join(KEY_DIR, 'update-private.pem');
const RELEASE_DIR = path.join(ROOT, 'release');
const BUILD_TMP = path.join(ROOT, '.build-tmp');

const version = process.argv[2];
const notes = process.argv[3] || '';
const REPO = (process.env.GITHUB_REPO || '').trim();   // owner/repo
const MIN_LAUNCHER = process.env.MIN_LAUNCHER || '1.0.0';

if (!version || !/^\d+(\.\d+)*$/.test(version)) {
	console.error('用法: node tools/build-release.js <version> ["说明"]   (version 形如 1.0.1)');
	process.exit(1);
}
if (!fs.existsSync(PRIV)) {
	console.error(`找不到私钥 ${PRIV},请先运行 node tools/keygen.js(或用 UPDATE_KEY_DIR 指定目录)`);
	process.exit(1);
}

// zip 的下载地址:优先 UPDATE_BASE_URL(自定义/本地测试),否则用 GitHub Release 版本固定链接。
let codeUrl;
if (process.env.UPDATE_BASE_URL) {
	codeUrl = process.env.UPDATE_BASE_URL.replace(/\/?$/, '/') + 'app.zip';
} else if (REPO) {
	codeUrl = `https://github.com/${REPO}/releases/download/v${version}/app.zip`;
} else {
	console.error('请设置 GITHUB_REPO=owner/repo(或 UPDATE_BASE_URL)后再打包。');
	console.error('例: GITHUB_REPO=youname/steam-tools-dist node tools/build-release.js ' + version);
	process.exit(1);
}

function sha256File(f) {
	return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}
function rmrf(p) { try { fs.rmSync(p, {recursive: true, force: true}); } catch (_) {} }

// 1) 准备打包内容:app/ + 根的 package 文件
rmrf(BUILD_TMP);
fs.mkdirSync(BUILD_TMP, {recursive: true});
// app/data 里只有 cs2-skin-db.json 是随代码分发的;一次性脚本会往这里写 session/refreshToken/UU token,
// 发布包能被任意客户端解密,所以其余文件一律不打包。.ready 是 launcher 的安装态标记,也不打包。
const APP_DATA_DIR = path.join(APP_DIR, 'data');
const BUNDLED_DATA_FILES = new Set([path.join(APP_DATA_DIR, 'cs2-skin-db.json')]);
fs.cpSync(APP_DIR, BUILD_TMP, {
	recursive: true,
	filter(src) {
		if (path.basename(src) === '.ready') return false;
		if (src === APP_DATA_DIR) return true;
		if (src.startsWith(APP_DATA_DIR + path.sep)) return BUNDLED_DATA_FILES.has(src);
		return true;
	}
});
for (const f of ['package.json', 'package-lock.json']) {
	const src = path.join(ROOT, f);
	if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BUILD_TMP, f));
}

// 2) 压缩成明文 zip(用 PowerShell Compress-Archive,零依赖)
fs.mkdirSync(RELEASE_DIR, {recursive: true});
const zipPath = path.join(RELEASE_DIR, 'app.zip');   // 发布附件(此处将写入"密文"),配合 releases/.../download/app.zip
const plainZip = path.join(RELEASE_DIR, 'app.plain.zip');
rmrf(zipPath); rmrf(plainZip);
execFileSync('powershell', [
	'-NoProfile', '-NonInteractive', '-Command',
	`Compress-Archive -Path '${BUILD_TMP.replace(/'/g, "''")}\\*' -DestinationPath '${plainZip.replace(/'/g, "''")}' -Force`
], {stdio: 'inherit'});
rmrf(BUILD_TMP);

// 3) AES-256-GCM 加密明文 zip → app.zip(发布的就是密文)。iv/authTag 放进已签名清单。
const AESKEY = path.join(ROOT, 'update-key.bin');
if (!fs.existsSync(AESKEY)) {
	console.error('找不到 update-key.bin(加密密钥),请先运行 node tools/keygen.js'); process.exit(1);
}
const key = fs.readFileSync(AESKEY);
if (key.length !== 32) { console.error('update-key.bin 必须是 32 字节'); process.exit(1); }
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(fs.readFileSync(plainZip)), cipher.final()]);
const authTag = cipher.getAuthTag();
fs.writeFileSync(zipPath, enc);
rmrf(plainZip);

// 4) 计算哈希(对密文)
const zipSha = sha256File(zipPath);
const lockFile = path.join(ROOT, 'package-lock.json');
const depsHash = fs.existsSync(lockFile) ? sha256File(lockFile) : '';
const size = fs.statSync(zipPath).size;

// 5) 构造清单 payload 并签名
const payloadObj = {
	code: {
		version,
		url: codeUrl,
		sha256: zipSha,
		depsHash,
		size,
		notes,
		encrypted: true,
		iv: iv.toString('base64'),
		authTag: authTag.toString('base64')
	},
	minLauncher: MIN_LAUNCHER,
	publishedAt: new Date().toISOString()
};
const payloadBytes = Buffer.from(JSON.stringify(payloadObj), 'utf8');
const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIV));
const sig = crypto.sign(null, payloadBytes, privateKey);   // Ed25519
const manifest = {
	payload: payloadBytes.toString('base64'),
	sig: sig.toString('base64')
};
const manifestPath = path.join(RELEASE_DIR, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log('发布已生成:');
console.log('  zip     :', zipPath, `(${(size / 1024).toFixed(1)} KB)`);
console.log('  sha256  :', zipSha);
console.log('  depsHash:', depsHash || '(无 lock)');
console.log('  manifest:', manifestPath);
console.log('  zip URL :', codeUrl);

if (REPO && !process.env.UPDATE_BASE_URL) {
	console.log(`\n发布到 GitHub Releases(tag 必须叫 v${version},附件名保持 app.zip / manifest.json):`);
	console.log('  方式一 网页:新建 Release → tag v' + version + ' → 拖入上面两个文件。');
	console.log('  方式二 gh CLI 一键:');
	console.log(`     gh release create v${version} "${zipPath}" "${manifestPath}" \\`);
	console.log(`        -R ${REPO} -t "v${version}" -n ${JSON.stringify(notes || ('v' + version))}`);
	console.log(`\n  客户端清单地址(填到 .env 的 GITHUB_REPO=${REPO} 即自动用此地址):`);
	console.log(`     https://github.com/${REPO}/releases/latest/download/manifest.json`);
} else {
	console.log('\n上传 manifest.json 与 app.zip 到 UPDATE_BASE_URL 指向的目录即可。');
}
