// 离线演示服务:用端到端测试的假 Steam(../e2e/support/offline-preload.cjs)跑真实的服务端,开发前端时用,不碰任何真实账号。
//
//   node test/demo/server.ts            # http://127.0.0.1:53110 ,口令 demo-password
//
// 演示数据放在系统临时目录 steam-tools-demo/ 下(DEMO_ROOT 可改),第一次启动时写入几个演示账号:
//   alpha    密码正确,带 maFile(可看令牌验证码)
//   bravo    密码正确
//   charlie  要移动令牌验证码,填 24680
//   delta    密码错误,登录失败
// UU 发货:「获取 Token」用短信登录,手机号随便填 11 位、验证码随便填,拿到的演示 token 在 UU 侧绑定的是 alpha 的 SteamID。
// 删掉那个目录就回到初始状态。端口 PORT、口令 APP_PASSWORD 可改。前端要先在 web/ 下构建(npm run build),开发时用 web/ 下的 npm run dev。

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const root = process.env.DEMO_ROOT || join(tmpdir(), 'steam-tools-demo');
const dataDir = join(root, 'data');
const configDir = join(dataDir, 'config');

if (!existsSync(join(dataDir, 'steam-tools.db'))) {
	// 旧版明文名单 / maFile:服务端第一次启动时导入加密库(和真实升级路径一样)
	mkdirSync(join(configDir, 'mafile'), {recursive: true});
	writeFileSync(join(configDir, 'accounts.json'), JSON.stringify([
		{accountName: 'alpha', password: 'pw-good', hasMaFile: true},
		{accountName: 'bravo', password: 'pw-good'},
		{accountName: 'charlie', password: 'pw-guard'},
		{accountName: 'delta', password: 'pw-wrong'}
	], null, 2));
	writeFileSync(join(configDir, 'mafile', 'alpha.maFile'), JSON.stringify({
		account_name: 'alpha',
		shared_secret: 'ZGVtby1zaGFyZWQtc2VjcmV0LTEyMw==',
		identity_secret: 'ZGVtby1pZGVudGl0eS1zZWNyZXQtMTI=',
		Session: {SteamID: 76561190100005555}
	}, null, 2));
}

// 假悠悠接口的场景(每次启动重写):短信登录发一个演示 token,它绑定 alpha 的 SteamID(假 steam-user 按账号名长度算 SteamID)
const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const uuToken = [jwtPart({alg: 'none'}), jwtPart({Id: '10086', Name: '演示UU', exp: 4102444800}), 'demo'].join('.');
const uuScenarioFile = join(root, 'fake-uu.json');
mkdirSync(root, {recursive: true});
writeFileSync(uuScenarioFile, JSON.stringify({smsToken: uuToken, tokens: {[uuToken]: {steamId: '76561190100005555'}}, orders: {}}, null, 2));

const port = process.env.PORT || '53110';
const password = process.env.APP_PASSWORD || 'demo-password';
const child = spawn(process.execPath, ['--require', join(REPO_ROOT, 'test', 'e2e', 'support', 'offline-preload.cjs'), join(REPO_ROOT, 'src', 'main.ts')], {
	cwd: REPO_ROOT,
	stdio: 'inherit',
	env: {
		...process.env,
		APP_ROOT: root,
		DATA_DIR: dataDir,
		HOST: process.env.HOST || '127.0.0.1',
		PORT: port,
		APP_PASSWORD: password,
		FAKE_STORE_COUNTRY: process.env.FAKE_STORE_COUNTRY || 'US',
		FAKE_STEAM_LOG: join(root, 'fake-steam.log'),
		FAKE_UU_FILE: uuScenarioFile
	}
});
console.log(`[demo] 离线演示服务 http://127.0.0.1:${port} 口令 ${password} 数据 ${root}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => child.kill(signal));
}
child.on('exit', code => process.exit(code ?? 0));
