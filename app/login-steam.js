'use strict';

// 用 maFile 登录某个 Steam 账号，拿到 webSession cookies 并保存到 data/sessions/<account>.json。
// 2FA 验证码用 maFile 的 shared_secret 自动生成，只需手动输密码。
//
// 用法：
//   node login-steam.js <accountName>
//   例：node login-steam.js erdzl63830

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

const ROOT = __dirname;
const STEAM_USER_DIR = path.join(ROOT, 'data', 'steam-user');
const SESSION_DIR = path.join(ROOT, 'data', 'sessions');
const MAFILE_DIR = path.resolve(ROOT, '..', 'config', 'mafile');

function ask(question, {hide = false} = {}) {
	const rl = readline.createInterface({input: process.stdin, output: process.stdout});
	if (hide) {
		// 掩码输入：提示符正常显示，输入字符用 * 代替
		rl._writeToOutput = function(s) {
			if (s.includes(question) || s === '\r\n' || s === '\n' || s === '\r') rl.output.write(s);
			else rl.output.write('*');
		};
	}
	return new Promise(resolve => rl.question(question, ans => { rl.close(); console.log(''); resolve(String(ans || '').trim()); }));
}

// 以字符串方式读取 maFile（SteamID 是 17 位数，绝不能过 JSON 数字）
function readMaFile(name) {
	const file = path.join(MAFILE_DIR, name + '.maFile');
	const raw = fs.readFileSync(file, 'utf8');
	const obj = JSON.parse(raw);
	const sidMatch = raw.match(/"SteamID"\s*:\s*"?(\d+)"?/);
	return {
		sharedSecret: obj.shared_secret || '',
		identitySecret: obj.identity_secret || '',
		steamId: sidMatch ? sidMatch[1] : '' // 字符串，安全
	};
}

async function main() {
	const accountName = (process.argv[2] || '').trim();
	if (!accountName) {
		console.error('用法: node login-steam.js <accountName>');
		process.exit(1);
	}

	const ma = readMaFile(accountName);
	if (!ma.sharedSecret) {
		console.error('maFile 缺少 shared_secret，无法自动 2FA');
		process.exit(1);
	}
	console.log(`[登录] 账号 ${accountName}  SteamID(字符串) ${ma.steamId}`);

	const password = (process.env.STEAM_PASSWORD || '').trim() || await ask('请输入 Steam 密码：', {hide: true});
	if (!password) { console.error('密码为空'); process.exit(1); }

	fs.mkdirSync(STEAM_USER_DIR, {recursive: true});
	fs.mkdirSync(SESSION_DIR, {recursive: true});

	const client = new SteamUser({
		dataDirectory: STEAM_USER_DIR,
		autoRelogin: false,
		renewRefreshTokens: true,
		webCompatibilityMode: true,
		protocol: SteamUser.EConnectionProtocol.WebSocket
	});

	client.on('loggedOn', () => console.log('[登录] 已登录 Steam，等待 webSession...'));
	client.on('error', err => { console.error('[登录] 失败: ' + err.message); process.exit(1); });
	client.on('steamGuard', (domain, callback) => {
		// maFile 已自动生成验证码；若仍触发说明令牌异常，手动兜底
		ask(`需要 Steam Guard 验证码${domain ? '(邮箱 ' + domain + ')' : ''}：`).then(code => callback(code));
	});

	client.on('webSession', (sessionID, cookies) => {
		const steamId = client.steamID ? client.steamID.getSteamID64() : ma.steamId;
		const file = path.join(SESSION_DIR, accountName + '.json');
		fs.writeFileSync(file, JSON.stringify({
			accountName,
			steamId,                 // 字符串
			cookies,                 // ['sessionid=...','steamLoginSecure=...']
			cookieHeader: cookies.join('; '),
			savedAt: new Date().toISOString()
		}, null, 2), 'utf8');
		console.log(`[登录] webSession 获取成功，cookies(${cookies.length}) 已保存到 ${file}`);
		console.log(`[登录] SteamID(运行时) = ${steamId}`);
		client.logOff();
		setTimeout(() => process.exit(0), 500);
	});

	client.logOn({
		accountName,
		password,
		twoFactorCode: SteamTotp.generateAuthCode(ma.sharedSecret)
	});
}

main().catch(err => { console.error('[登录] 异常: ' + (err && err.stack ? err.stack : err)); process.exit(1); });
