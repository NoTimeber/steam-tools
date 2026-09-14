'use strict';

/**
 * 从 GitHub Releases 拉取加密发布包,产出 docker 构建上下文(docker/dist)。
 *
 * 做的事(与 launcher.js 的更新流程同源,只是产物换成构建上下文):
 *   1. 取清单 manifest.json(GITHUB_REPO 拼 GitHub latest 链接,或 UPDATE_MANIFEST_URL)
 *   2. 用 public-key.pem 做 Ed25519 验签 —— 签名不过直接拒绝
 *   3. 下载 app.zip(密文),按清单里的 sha256 校验
 *   4. 用 update-key.bin 做 AES-256-GCM 解密(iv/authTag 来自已签名清单)
 *   5. 解压成构建上下文:zip 根部的 package.json/package-lock.json 放上下文根,
 *      其余(server.js、lib/、public/、schema/ ...)放 app/ —— 与 Dockerfile 的 COPY 布局对齐
 *   6. 顺带把仓库里的 Dockerfile、一个最小 .dockerignore、以及 VERSION 写进上下文
 *
 * 用法:
 *   node docker/fetch-release.js                     # 拉最新发布(需要 public-key.pem + update-key.bin)
 *   node docker/fetch-release.js --local release     # 用本地 release/ 目录(manifest.json + app.zip),不上网
 *   node docker/fetch-release.js --source            # 直接用仓库里的 app/ 组装(离线/开发用,不需要密钥)
 *   node docker/fetch-release.js --out docker/dist   # 指定输出目录(默认 docker/dist)
 *
 * 加密发布包里的 app.zip 是"密文",明文 zip 含源码 —— update-key.bin 能解开它,
 * 所以这个文件只放在你自己的服务器/机器上,绝不要提交、绝不要进镜像(见 .dockerignore)。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(__dirname, 'dist');
const PUBKEY_FILE = path.join(REPO_ROOT, 'public-key.pem');
const AESKEY_FILE = path.join(REPO_ROOT, 'update-key.bin');
const ROOT_ENTRIES = new Set(['package.json', 'package-lock.json']);

function log(...a) { console.log('[fetch-release]', ...a); }
function fail(msg) { console.error('[fetch-release] ' + msg); process.exit(1); }
function rmrf(p) { try { fs.rmSync(p, {recursive: true, force: true}); } catch (_) {} }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function parseArgs(argv) {
	const out = {local: '', source: false, out: DEFAULT_OUT};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--local') out.local = argv[++i] || '';
		else if (a === '--source') out.source = true;
		else if (a === '--out') out.out = path.resolve(argv[++i] || DEFAULT_OUT);
		else if (a === '-h' || a === '--help') {
			const src = fs.readFileSync(__filename, 'utf8');
			const start = src.indexOf('/**');
			const end = src.indexOf('*/', start);
			console.log(src.slice(start + 3, end).split('\n').map(l => l.replace(/^\s*\* ?/, '')).join('\n').trim());
			process.exit(0);
		} else fail('未知参数: ' + a);
	}
	out.out = path.resolve(out.out);
	return out;
}

// ---------------- zip 读取(纯 Node,零依赖) ----------------
// 不走 unzip/python,免得服务器上还得装东西。完整性由 AES-GCM 的 authTag 与
// 密文 sha256 保证,所以这里不重复算 CRC32,只按中央目录的 compSize 解压。

function findEocd(buf) {
	const min = Math.max(0, buf.length - 65557);   // EOCD 最长 22 + 65535 注释
	for (let i = buf.length - 22; i >= min; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) return i;
	}
	return -1;
}

function safeRelative(name) {
	const norm = path.posix.normalize(String(name).replace(/\\/g, '/')).replace(/^\/+/, '');
	if (!norm || norm === '.' || norm === '..' || norm.startsWith('../')) {
		throw new Error('zip 内路径越界,疑似 zip-slip: ' + name);
	}
	return norm;
}

/** 把 zip 内容解出来,entry 名映射后交给 onFile(relPath, buffer)。 */
function readZip(buf, onFile) {
	const eocd = findEocd(buf);
	if (eocd < 0) throw new Error('不是有效的 zip:找不到 EOCD 尾部');
	const total = buf.readUInt16LE(eocd + 10);
	const cdSize = buf.readUInt32LE(eocd + 12);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
		throw new Error('这个 zip 用了 Zip64 扩展,当前解析器不支持(发布包不该这么大)');
	}
	if (cdOffset + cdSize > buf.length) throw new Error('zip 中央目录越界,包已损坏');

	let p = cdOffset;
	let count = 0;
	for (let i = 0; i < total; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录项签名不对 @' + p);
		const flags = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
		p += 46 + nameLen + extraLen + commentLen;

		if (name.endsWith('/')) continue;                     // 目录项,写文件时按需建目录
		if (flags & 0x1) throw new Error('zip 内有加密项(发布包的 AES 加密是外层,不该出现在这里): ' + name);
		if (method !== 0 && method !== 8) throw new Error('不支持的压缩方式 ' + method + ': ' + name);

		if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地文件头签名不对: ' + name);
		// 用本地头自己的 name/extra 长度算数据起点:Compress-Archive 与多数打包器的 extra 长度都可能不同。
		const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
		const raw = buf.subarray(dataStart, dataStart + compSize);
		if (raw.length !== compSize) throw new Error('zip 数据被截断: ' + name);
		const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);

		onFile(name, data);
		count++;
	}
	return count;
}

// ---------------- 各步骤 ----------------

/** 取清单并验签,返回 payload 对象。 */
async function loadManifest(opts) {
	if (opts.local) {
		const file = path.join(path.resolve(opts.local), 'manifest.json');
		if (!fs.existsSync(file)) fail('本地清单不存在: ' + file);
		log('读本地清单', file);
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	}
	const repo = String(process.env.GITHUB_REPO || '').trim();
	const url = String(process.env.UPDATE_MANIFEST_URL || '').trim()
		|| (repo ? `https://github.com/${repo}/releases/latest/download/manifest.json` : '');
	if (!url) fail('没配置清单地址:在 .env 里设 GITHUB_REPO=owner/repo(或 UPDATE_MANIFEST_URL)');
	const prefix = String(process.env.UPDATE_DOWNLOAD_PREFIX || '').trim();
	log('拉取清单', url);
	const res = await fetch(prefix + url, {cache: 'no-store'});
	if (!res.ok) fail('清单 HTTP ' + res.status + ' —— 检查仓库名与网络');
	return res.json();
}

function verifyManifest(outer, opts) {
	if (opts.source) return null;
	if (!outer || !outer.payload || !outer.sig) fail('清单格式不对(缺 payload/sig)');
	const pub = crypto.createPublicKey(fs.readFileSync(PUBKEY_FILE));
	const payload = Buffer.from(outer.payload, 'base64');
	const ok = crypto.verify(null, payload, pub, Buffer.from(outer.sig, 'base64'));   // Ed25519 传 null
	if (!ok) fail('清单签名校验失败 —— 拒绝使用这个包');
	log('清单签名校验通过');
	const parsed = JSON.parse(payload.toString('utf8'));
	if (!parsed || !parsed.code || !parsed.code.version) fail('清单里没有 code.version');
	return parsed;
}

/** 拿到密文 app.zip 的 Buffer。 */
async function loadZipBuffer(code, opts) {
	if (opts.local) {
		const file = path.join(path.resolve(opts.local), 'app.zip');
		if (!fs.existsSync(file)) fail('本地发布包不存在: ' + file);
		log('读本地发布包', file);
		return fs.readFileSync(file);
	}
	log('下载发布包', code.url);
	const prefix = String(process.env.UPDATE_DOWNLOAD_PREFIX || '').trim();
	const res = await fetch(prefix + code.url, {cache: 'no-store'});
	if (!res.ok) fail('发布包 HTTP ' + res.status + ' —— Release 附件是不是叫 app.zip?');
	return Buffer.from(await res.arrayBuffer());
}

function decrypt(buf, code) {
	if (!code.encrypted) return buf;
	if (!fs.existsSync(AESKEY_FILE)) {
		fail('发布包是加密的,但找不到 ' + path.basename(AESKEY_FILE) + '(从桌面安装目录拷一份过来,别提交)');
	}
	const key = fs.readFileSync(AESKEY_FILE);
	if (key.length !== 32) fail('update-key.bin 必须是 32 字节,实为 ' + key.length);
	const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(code.iv, 'base64'));
	d.setAuthTag(Buffer.from(code.authTag, 'base64'));
	const plain = Buffer.concat([d.update(buf), d.final()]);   // authTag 不符会在这里抛错
	log('解密完成(AES-256-GCM)');
	return plain;
}

function writeDist(zipBuf, outDir) {
	let files = 0;
	let bytes = 0;
	readZip(zipBuf, (name, data) => {
		const rel = safeRelative(name);
		// zip 根部 = app/ 的内容 + 两个 package 文件,后者要落到上下文根
		const target = path.posix.join(ROOT_ENTRIES.has(rel) ? '.' : 'app', rel);
		const dest = path.join(outDir, target);
		if (path.relative(outDir, dest).startsWith('..')) throw new Error('解压目标越界: ' + name);
		fs.mkdirSync(path.dirname(dest), {recursive: true});
		fs.writeFileSync(dest, data, {mode: 0o644});
		files++;
		bytes += data.length;
	});
	return {files, bytes};
}

function writeScaffold(outDir, version) {
	// 构建上下文里必须有 Dockerfile;直接复用仓库里的那份,避免两份定义漂移。
	const dockerfile = path.join(REPO_ROOT, 'Dockerfile');
	if (!fs.existsSync(dockerfile)) fail('找不到 ' + dockerfile);
	fs.copyFileSync(dockerfile, path.join(outDir, 'Dockerfile'));
	fs.writeFileSync(path.join(outDir, 'VERSION'), String(version) + '\n');
	fs.writeFileSync(path.join(outDir, '.dockerignore'), [
		'node_modules/',
		'.git/',
		'**/.DS_Store',
		'',
	].join('\n'));
}

/** --source:不碰网络与密钥,直接把仓库里的 app/ 组装成同样布局的上下文。 */
function buildFromSource(outDir) {
	const appSrc = path.join(REPO_ROOT, 'app');
	if (!fs.existsSync(path.join(appSrc, 'server.js'))) fail('仓库里的 app/server.js 不存在');
	fs.cpSync(appSrc, path.join(outDir, 'app'), {recursive: true});
	for (const f of ['package.json', 'package-lock.json']) {
		const src = path.join(REPO_ROOT, f);
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
	// package.json 里的 0.1.0 是原型版本号,不是发版号;加 -dev 后缀以便和正式版区分。
	return {version: (pkg.version || '0.0.0') + '-dev', files: -1, bytes: -1};
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	try { process.loadEnvFile(path.join(REPO_ROOT, '.env')); } catch (_) {}

	rmrf(opts.out);
	fs.mkdirSync(opts.out, {recursive: true});

	let version;
	if (opts.source) {
		log('--source:用仓库里的 app/ 组装构建上下文');
		const r = buildFromSource(opts.out);
		version = r.version;
	} else {
		const outer = await loadManifest(opts);
		const manifest = verifyManifest(outer, opts);
		const code = manifest.code;
		version = String(code.version);

		const cipher = await loadZipBuffer(code, opts);
		if (code.sha256) {
			const got = sha256(cipher);
			if (got !== code.sha256) fail(`发布包 sha256 不匹配(期望 ${code.sha256} 实得 ${got})—— 下载可能被截断/篡改`);
			log('sha256 校验通过');
		}
		const plain = decrypt(cipher, code);
		const r = writeDist(plain, opts.out);
		log(`解压完成:${r.files} 个文件,${(r.bytes / 1024 / 1024).toFixed(1)} MB(明文)`);
	}

	if (!fs.existsSync(path.join(opts.out, 'app', 'server.js'))) {
		fail('产出的上下文里没有 app/server.js,包结构不符合预期');
	}
	writeScaffold(opts.out, version);

	const rel = path.relative(REPO_ROOT, opts.out) || '.';
	log(`构建上下文就绪:${rel}  (版本 ${version})`);
	console.log('');
	console.log('  下一步:');
	console.log(`    APP_VERSION=${version} docker compose up -d --build app`);
	console.log('  或直接:');
	console.log('    bash docker/update.sh');
}

main().catch(err => fail(err && err.stack ? err.stack : String(err)));
