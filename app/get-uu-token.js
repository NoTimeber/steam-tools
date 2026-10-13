'use strict';

// 悠悠有品 token 获取脚本（短信登录，无需抓包）。
// 复刻 Steamauto utils/uu_helper.py 的 get_token_automatically 流程。
//
// 用法：
//   node get-uu-token.js
// 按提示输入手机号、验证码即可。成功后打印 token，并保存到 data/uu/last-token.txt。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {UuAccount, generateHeaders, generateRandomString} = require('../src/uu/client.ts');

function ask(question) {
	const rl = readline.createInterface({input: process.stdin, output: process.stdout});
	return new Promise(resolve => rl.question(question, answer => {
		rl.close();
		resolve(String(answer || '').trim());
	}));
}

async function main() {
	const deviceInfo = generateRandomString(10);
	const headers = generateHeaders(deviceInfo, deviceInfo, '', '730');
	const sessionId = deviceInfo;

	const phone = await ask('请输入手机号(+86，仅数字)：');
	if (!/^\d{11}$/.test(phone)) {
		console.warn('[警告] 手机号格式看起来不对（应为 11 位数字），仍继续尝试...');
	}

	console.log('正在获取 UK 校验参数...');
	const uk = await UuAccount.getUuUk();
	if (!uk) {
		console.warn('[警告] 获取 UK 失败，仍尝试发送验证码（可能失败）');
	} else {
		console.log('UK 获取成功。');
		// 与上游一致：把真实 uk 注入共享 headers，供后续上行短信配置/登录复用
		headers.uk = uk;
	}

	console.log('正在请求发送短信验证码...');
	const result = await UuAccount.sendLoginSmsCode(phone, sessionId, {headers, uk});
	let response;

	if (String((result && result.Msg) || '').includes('成功')) {
		console.log('发送结果：' + result.Msg);
		const code = await ask('请输入收到的短信验证码：');
		response = await UuAccount.smsSignIn(phone, code, sessionId, {headers});
	} else {
		console.log('该手机号需要「上行短信」验证，正在获取发送信息...');
		const cfg = await UuAccount.getSmsUpSignInConfig(headers);
		if (cfg && cfg.Code === 0) {
			console.log('');
			console.log('请用本机编辑短信，内容【' + cfg.Data.SmsUpContent + '】，发送到号码【' + cfg.Data.SmsUpNumber + '】');
			console.log('发送完成后按回车继续...');
			await ask('');
			await new Promise(r => setTimeout(r, 3000));
			response = await UuAccount.smsSignIn(phone, '', sessionId, {headers});
		} else {
			throw new Error('获取上行短信配置失败：' + JSON.stringify(cfg));
		}
	}

	console.log('登录结果：' + ((response && response.Msg) || JSON.stringify(response)));
	const token = response && response.Data && response.Data.Token;
	if (!token) {
		throw new Error('未获取到 token，完整响应：' + JSON.stringify(response));
	}

	const outDir = path.join(__dirname, 'data', 'uu');
	fs.mkdirSync(outDir, {recursive: true});
	const outFile = path.join(outDir, 'last-token.txt');
	fs.writeFileSync(outFile, token, 'utf8');

	console.log('');
	console.log('===== 你的悠悠 token（已保存到 ' + outFile + '）=====');
	console.log(token);
	console.log('================================================');
	console.log('');
	console.log('接下来可用它验证发货客户端：');
	console.log('  node test-uu-deliver.js "' + token + '" 440');
}

main().catch(err => {
	console.error('[失败] ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
