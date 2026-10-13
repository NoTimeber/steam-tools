'use strict';

// 发货 P2 验证脚本：把 UU 订单 ↔ Steam 报价接受 串起来。
// 默认 dry-run（只校验、不接受），加 --accept 才真正接受+手机确认。
//
// 用法：
//   node accept-uu-offer.js <UU_TOKEN> <steamAccountName> [orderNo] [--accept]
//   例(只校验): node accept-uu-offer.js "<token>" erdzl63830
//   例(真接受): node accept-uu-offer.js "<token>" erdzl63830 2026060311453759566000440 --accept
//
// 前置：先 node login-steam.js <steamAccountName> 拿到 cookies。

const fs = require('fs');
const path = require('path');
const {UuAccount} = require('./lib/uuyoupin');
const {acceptVerifiedTradeOffer} = require('./lib/trade-offer');

const ROOT = __dirname;
const SESSION_DIR = path.join(ROOT, 'data', 'sessions');
const MAFILE_DIR = path.resolve(ROOT, '..', 'config', 'mafile');

function log(level, msg) { console.log(`[P2:${level}] ${msg}`); }

function readIdentitySecret(name) {
	const raw = fs.readFileSync(path.join(MAFILE_DIR, name + '.maFile'), 'utf8');
	return JSON.parse(raw).identity_secret || '';
}

function readSessionCookies(name) {
	const file = path.join(SESSION_DIR, name + '.json');
	if (!fs.existsSync(file)) throw new Error(`未找到会话 ${file}，请先运行 node login-steam.js ${name}`);
	const s = JSON.parse(fs.readFileSync(file, 'utf8'));
	return {cookies: s.cookies || [], steamId: s.steamId || ''};
}

async function main() {
	const args = process.argv.slice(2).filter(a => a !== '--accept');
	const doAccept = process.argv.includes('--accept');
	const token = (args[0] || '').trim();
	const steamAccount = (args[1] || '').trim();
	let orderNo = (args[2] || '').trim();

	if (!token || !steamAccount) {
		console.error('用法: node accept-uu-offer.js <UU_TOKEN> <steamAccountName> [orderNo] [--accept]');
		process.exit(1);
	}

	const {cookies, steamId} = readSessionCookies(steamAccount);
	const identitySecret = readIdentitySecret(steamAccount);
	log('info', `Steam 账号 ${steamAccount}  SteamID ${steamId}  cookies ${cookies.length}  identitySecret ${identitySecret ? '有' : '无'}`);

	const uu = new UuAccount(token, {gameId: 440, debug: true});

	if (!orderNo) {
		const orders = await uu.getWaitDeliverList({gameId: 440});
		const pending = orders.find(o => o.orderSubStatus === 1103) || orders[0];
		if (!pending) { log('info', '当前无待发货订单'); return; }
		orderNo = pending.orderNo;
		log('info', `自动选中订单 ${orderNo} | ${pending.itemName}`);
	}

	const detail = await uu.getOrderDetail(orderNo);
	const tradeOfferId = detail.tradeOfferId;
	const partnerSteamId = detail.buyer && detail.buyer.steamId; // UU 报的对方 steamId（字符串）
	const assetId = detail.commodity && (detail.commodity.assetId || detail.commodity.assertId);
	log('info', `订单 ${orderNo}  tradeOfferId ${tradeOfferId}  对方steamId ${partnerSteamId}  assetId ${assetId || '(无)'}`);

	if (!tradeOfferId) { log('info', '该订单无 tradeOfferId，无法接受'); return; }

	const result = await acceptVerifiedTradeOffer({
		cookies,
		identitySecret,
		tradeOfferId,
		expectedPartnerSteamId: partnerSteamId,
		expectGiveAppId: 440,
		// 如果 UU 给了具体 assetId，可加 expectGiveAssetIds:[assetId] 做更强校验
		dryRun: !doAccept,
		logger: log
	});

	console.log('\n===== 结果 =====');
	console.log(JSON.stringify(result, null, 2));
	if (result.ok && !doAccept) {
		console.log('\n[dry-run] 校验通过！确认无误后加 --accept 真正接受+确认报价。');
	} else if (result.ok && doAccept) {
		console.log('\n✅ 已接受并确认 Steam 报价。回 UU 看订单是否走向“出售成功”。');
	} else {
		console.log('\n⛔ 已拒绝(fail-closed)，原因: ' + result.reason);
	}
}

main().catch(err => { console.error('[P2] 异常: ' + (err && err.stack ? err.stack : err)); process.exit(1); });
