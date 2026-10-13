'use strict';

// 悠悠有品 CS2 上架联调脚本（只读，不会真正上架/改价）。
// 用法：
//   node test-uu-listing.js [UU_TOKEN]
//   不传 token 时，自动从 data/uu/tokens.json 取（token 与游戏无关，按 UU 账号通用，
//   gameId 仅是接口参数/绑定标签，故优先 730，无则用任意一个）。
// 也可用环境变量 UU_TOKEN。
//
// 流程：解析身份 → 拉 CS2 库存 → 打印前若干件(名称/模板id/磨损/购入价/可交易)
//      → 对首件可交易且有磨损的物品，按磨损段算出建议上架价并打印。
// 磨损来源：UU 库存返回的 AssetInfo.Abrade（缺失则提示需外部解析服务，本脚本不上架）。

const fs = require('fs');
const path = require('path');
const {UuAccount, decodeJwt} = require('./lib/uuyoupin');
const {UuPriceEngine} = require('./lib/uu-pricing');

function loadCs2Token() {
	const fromArg = (process.argv[2] || process.env.UU_TOKEN || '').trim();
	if (fromArg) return fromArg;
	try {
		const file = path.join(__dirname, 'data', 'uu', 'tokens.json');
		const tokens = JSON.parse(fs.readFileSync(file, 'utf8'));
		// token 与游戏无关（同一 UU 账号通用），优先 730 标签，无则取第一个。
		const picked = tokens.find(t => String(t.gameId) === '730') || tokens[0];
		if (picked) {
			console.log('[test] 使用 data/uu/tokens.json 中的 token:', picked.nickname || picked.userId, `(标签 gameId=${picked.gameId})`);
			return picked.token;
		}
	} catch (err) {
		/* ignore */
	}
	return '';
}

function num(x) {
	const n = parseFloat(x);
	return Number.isFinite(n) ? n : null;
}

async function main() {
	const token = loadCs2Token();
	if (!token) {
		console.error('用法: node test-uu-listing.js <UU_TOKEN_CS2>  (或在 data/uu/tokens.json 配 gameId=730 的 token)');
		process.exit(1);
	}

	const jwt = decodeJwt(token);
	if (jwt) console.log(`[test] token 身份: Id=${jwt.Id} Name=${jwt.Name} 过期=${jwt.exp ? new Date(jwt.exp * 1000).toISOString() : '未知'}`);

	const uu = new UuAccount(token, {gameId: '730', debug: true});
	const engine = new UuPriceEngine({logger: (lvl, msg) => console.log(`[price:${lvl}] ${msg}`)});

	console.log('[test] 拉取 CS2 悠悠库存...');
	const inventory = await uu.getInventory({refresh: true});
	const items = inventory.filter(it => it.AssetInfo);
	console.log(`[test] 库存总数 ${inventory.length}，含 AssetInfo 的可处理项 ${items.length}`);

	const preview = items.slice(0, 10);
	for (const it of preview) {
		const tmpl = it.TemplateInfo || {};
		const abrade = it.AssetInfo ? it.AssetInfo.Abrade : null;
		console.log(
			`  - ${tmpl.CommodityName} | tmpl=${tmpl.Id} | 磨损=${abrade != null ? abrade : '无'}` +
			` | 购入=${it.AssetBuyPrice || '-'} | 可交易=${it.Tradable} | 状态=${it.AssetStatus}`
		);
	}

	// 对首件“可交易 + 有磨损”的物品试算建议上架价（只算，不上架）。
	const candidate = items.find(it => it.Tradable && it.AssetStatus === 0 && num(it.AssetInfo && it.AssetInfo.Abrade) != null);
	if (!candidate) {
		console.log('[test] 没有“可交易且 UU 返回了磨损”的物品可试算。');
		console.log('[test] 提示：磨损缺失的物品需走外部 GC 解析服务（见部署方案），本脚本不处理。');
		return;
	}
	const tmpl = candidate.TemplateInfo || {};
	const abrade = num(candidate.AssetInfo.Abrade);
	console.log(`\n[test] 试算定价：${tmpl.CommodityName} (磨损 ${abrade})`);
	const price = await engine.getAbradeRelatedPrice(uu, tmpl.Id, tmpl.CommodityName, abrade);
	if (price > 0) console.log(`[test] => 建议上架价：¥${price}（仅试算，未上架）`);
	else console.log('[test] => 未算出价格（市场无对应磨损段在售 / 已放弃）。');

	console.log('\n[test] 完成（全程只读，未上架/未改价）。');
}

main().catch(err => {
	console.error('[test] 失败: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
