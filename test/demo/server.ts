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
// C5 扫货:app-key 随便填(bad 开头的会被拒);假平台有 500 元余额和四个箱子的在售,每次查行情可能在原价附近补货;
// 绑了两个 Steam 账号:alpha(登录后自动取交易链接)和一个交易助手(选它时要贴交易链接)。
// 代理管理:演示里有个假代理 127.0.0.1:<PORT+1>(DEMO_PROXY_PORT 可改;用户名、密码随便填,用户名以 -rotate 结尾的每次连接换出口 IP),
// 检测能过(出口 IP 是假的);经它的 Steam 网页请求会失败(假代理不转发 HTTPS)。
// 库存:每个登录的账号看到同一份假社区库存(随包皮肤库里挑的皮肤 + 武器箱 + 终端机,有冷却中、锁定、重复的)。
// 删掉那个目录就回到初始状态。端口 PORT、口令 APP_PASSWORD 可改。前端要先在 web/ 下构建(npm run build),开发时用 web/ 下的 npm run dev。

import {spawn} from 'node:child_process';
import http from 'node:http';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
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

// 假 C5 开放平台的初始场景(每次启动重写;运行中的余额、在售、订单只在内存里)
const c5ScenarioFile = join(root, 'fake-c5.json');
writeFileSync(c5ScenarioFile, JSON.stringify({
	balance: 500,
	restock: true,
	// C5 上绑定的账号:alpha 在账户管理里(登录后自动取交易链接);交易助手不在,选它时要贴一次交易链接
	steamAccounts: [
		{steamId: '76561190100005555', nickname: '演示收货号', username: 'alpha', autoType: 0, accountStatus: 1},
		{steamId: '76561198012345678', nickname: '演示交易助手', username: 'c5_helper', autoType: 2, accountStatus: 1}
	],
	items: {
		'Kilowatt Case': {listings: [0.62, 0.64, 0.66, 0.7, 0.72], purchaseMax: 0.58},
		'Dreams & Nightmares Case': {listings: [6.1, 6.2, 6.35], purchaseMax: 5.9},
		'Revolution Case': {listings: [1.05, 1.08], purchaseMax: 0.98},
		'Recoil Case': {listings: [1.45, 1.5], purchaseMax: 1.35}
	}
}, null, 2));

// 假社区库存(每次启动重写):从随包皮肤库挑一些有图的皮肤(各稀有度、各外观),加武器箱(一部分冷却中,看堆叠)和一个锁定的终端机
function demoInventory() {
	const RARITIES: Record<string, [string, string]> = {
		'消费级': ['消费级', 'b0c3d9'], '工业级': ['工业级', '5e98d9'], '军规级': ['军规级', '4b69ff'], '受限级': ['受限', '8847ff'],
		'保密级': ['保密', 'd32ce6'], '隐秘级': ['隐秘', 'eb4b4b'], '非凡': ['非凡', 'eb4b4b']
	};
	const EXTERIORS = ['崭新出厂', '略有磨损', '久经沙场', '破损不堪', '战痕累累'];
	const skins = Object.values(JSON.parse(readFileSync(join(REPO_ROOT, 'app', 'data', 'cs2-skin-db.json'), 'utf8')).map as Record<string, {name: string; image: string; rarity: string}>);
	// 中文库存里冷却时间的写法(日期是中文的,前后缀没核对过真实原文)
	const unlockText = (days: number) => {
		const date = new Date(Date.now() + days * 86400000);
		return `Tradable/Marketable After ${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 (7:00:00) GMT`;
	};
	const descriptions: unknown[] = [];
	const assets: unknown[] = [];
	const add = (classid: string, copies: number) => {
		for (let n = 0; n < copies; n++) assets.push({assetid: String(5_000_000_000 + assets.length * 7919), classid, instanceid: '0', amount: '1'});
	};
	let index = 0;
	for (const [dbRarity, [rarity, color]] of Object.entries(RARITIES)) {
		for (const skin of skins.filter(entry => entry.rarity === dbRarity && entry.image).slice(0, dbRarity === '非凡' ? 2 : 4)) {
			const exterior = EXTERIORS[index % EXTERIORS.length]!;
			const cooling = index % 4 === 1;
			const name = `${skin.name} (${exterior})`;
			descriptions.push({
				classid: `skin${index}`, instanceid: '0', name, market_hash_name: name, tradable: cooling ? 0 : 1, marketable: 1,
				icon_url: skin.image.split('/economy/image/')[1] || '',
				...(cooling ? {owner_descriptions: [{value: ' '}, {value: unlockText(1 + (index % 7))}]} : {}),
				tags: [
					{category: 'Type', internal_name: 'CSGO_Type_Rifle', localized_tag_name: '武器'},
					{category: 'Rarity', localized_tag_name: rarity, color},
					{category: 'Exterior', localized_tag_name: exterior}
				]
			});
			add(`skin${index}`, index % 6 === 0 ? 3 : 1);
			index++;
		}
	}
	const caseTags = [{category: 'Type', internal_name: 'CSGO_Type_WeaponCase', localized_tag_name: '武器箱'}, {category: 'Rarity', localized_tag_name: '普通级', color: 'b0c3d9'}];
	const kase = {name: '梦魇武器箱', market_hash_name: 'Dreams & Nightmares Case', marketable: 1, icon_url: '', tags: caseTags};
	descriptions.push({classid: 'case', instanceid: '0', tradable: 1, ...kase});
	descriptions.push({classid: 'case', instanceid: '1', tradable: 0, owner_descriptions: [{value: unlockText(5)}], ...kase});
	descriptions.push({
		classid: 'terminal', instanceid: '0', name: '封装的毁灭之手终端机', market_hash_name: 'Sealed Dead Hand Terminal', tradable: 0, marketable: 0, icon_url: '',
		tags: [{category: 'Type', internal_name: 'CSGO_Type_Tool', localized_tag_name: '工具'}, {category: 'Rarity', localized_tag_name: '普通级', color: 'b0c3d9'}]
	});
	add('case', 9);
	for (let n = 0; n < 3; n++) assets.push({assetid: String(6_000_000_000 + n), classid: 'case', instanceid: '1', amount: '1'});
	add('terminal', 2);
	return {assets, descriptions};
}
const inventoryFile = join(root, 'fake-inventory.json');
writeFileSync(inventoryFile, JSON.stringify(demoInventory()));

const port = process.env.PORT || '53110';
const password = process.env.APP_PASSWORD || 'demo-password';

// 假代理:检测时查出口 IP 是普通 HTTP 请求(下面的 PROXY_TEST_URL),由它直接回;HTTPS(CONNECT)一律拒绝
const proxyPort = Number(process.env.DEMO_PROXY_PORT) || Number(port) + 1;
let rotation = 0;
const fakeProxy = http.createServer((req, res) => {
	const auth = Buffer.from(String(req.headers['proxy-authorization'] ?? '').replace(/^Basic /, ''), 'base64').toString();
	const user = auth.split(':')[0] ?? '';
	// 每个「用户名-编号」一个固定 IP;-rotate 每次换一个
	const index = /-rotate$/.test(user) ? ++rotation : Number(/-(\d+)$/.exec(user)?.[1] ?? 0);
	res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({ip: `198.51.100.${(index % 250) + 1}`, country: 'US'}));
});
fakeProxy.on('connect', (_req, socket) => {
	socket.on('error', () => {});
	socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});
fakeProxy.listen(proxyPort, '127.0.0.1');

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
		FAKE_UU_FILE: uuScenarioFile,
		FAKE_C5_FILE: c5ScenarioFile,
		FAKE_INVENTORY_FILE: inventoryFile,
		PROXY_TEST_URL: 'http://ip.demo.test/',
		UPDATE_CHECK: '0'
	}
});
console.log(`[demo] 离线演示服务 http://127.0.0.1:${port} 口令 ${password} 数据 ${root};假代理 127.0.0.1:${proxyPort}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		fakeProxy.close();
		child.kill(signal);
	});
}
child.on('exit', code => process.exit(code ?? 0));
