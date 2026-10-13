'use strict';

// Steam 商店「协议购买整款游戏」模块(钱包余额、买给登录账号自己)。
//
// 与现有「内购」模块的区别:内购走 GC 二进制协议买游戏内道具;本模块走 Steam 网页结算
// 协议,用登录后拿到的 WebSession cookie 重放浏览器结算流程,买的是整款游戏(以 packageid/subid 为单位)。
//
// 流程(2026-06 实测可用,与当前 checkout.js 一致):
//   1. webapi_token        GET  store.steampowered.com/pointssummary/ajaxgetasyncconfig
//   2. 取价格              GET  store.steampowered.com/api/packagedetails?packageids=..&cc=国家
//   3. 新建 GID 购物车     POST api.steampowered.com/IShoppingCartService/CreateNewShoppingCart  → gidshoppingcart
//   4. 加包(需 costwhenadded) POST api.steampowered.com/IShoppingCartService/AddPackages
//   5. 初始化交易          POST checkout.steampowered.com/checkout/inittransaction  → transid
//   6. 取最终价(校验)     GET  checkout.steampowered.com/checkout/getfinalprice
//   7. 完成交易(真扣款)   POST checkout.steampowered.com/checkout/finalizetransaction
//   8. 轮询交易状态        GET  checkout.steampowered.com/checkout/transactionstatus
//
// 要点:
//   - 结算端点全在 checkout.steampowered.com 子域(不是 store.),这是关键;store. 上的同名端点已废(永远 success:2)。
//   - 必须用「新建 GID 购物车」(IShoppingCartService),不能用账号购物车(IAccountCartService)——后者无 GID,
//     喂不进 inittransaction。
//   - AddPackages 必须带 costwhenadded(amount+currencycode),否则不会真正加入。
//   - 钱包给自己买无需手机/邮箱二次确认 → 可全自动。
//   - dryRun(默认 true):跑到第 6 步(getfinalprice)即停、不扣款,用于安全验证。

const STORE = 'https://store.steampowered.com';
const CHECKOUT = 'https://checkout.steampowered.com';
const WEBAPI = 'https://api.steampowered.com';

// Steam EPurchaseResultDetail 常见码 → 中文(transactionstatus.purchaseresultdetail)。
const PURCHASE_RESULT_DETAIL = {
	1: 'AVS 地址校验失败',
	2: '余额不足',
	3: '需联系 Steam 客服',
	4: '交易超时',
	5: '无效的商品包',
	6: '无效的支付方式',
	7: '数据无效',
	8: '有其它交易正在进行',
	9: '已拥有该商品',
	10: '价格已变动,请重试',
	11: '风控/欺诈校验未通过',
	12: '用户取消',
	13: '受限国家/地区',
	16: '请改用其它支付方式',
	18: '收货地址无效',
	19: '该地区不支持',
	20: '账号被封禁',
	21: '账号未验证',
	22: '账号无效',
	23: '账单国家与商店区域不符',
	24: '缺少必需的前置游戏',
	31: '钱包货币与商店不符'
};

function describePurchaseResultDetail(detail) {
	const text = PURCHASE_RESULT_DETAIL[Number(detail)];
	return text ? `${text}(purchaseresultdetail=${detail})` : `购买失败 purchaseresultdetail=${detail}(参见 Steam EPurchaseResultDetail 码表)`;
}

// 格式化 CartAmount:优先用 Steam 本地化串(如 "$U16,00"),否则按分换算。
function formatCartAmount(amount) {
	if (!amount) {
		return '?';
	}
	if (amount.formatted_amount) {
		return String(amount.formatted_amount);
	}
	return (Number(amount.amount_in_cents || 0) / 100).toFixed(2);
}

function noopLogger() {}

function extractSessionId(cookies) {
	for (const raw of cookies) {
		const match = /^sessionid=([^;]+)/.exec(String(raw).trim());
		if (match) {
			return decodeURIComponent(match[1]);
		}
	}
	return '';
}

function truncate(value, max = 400) {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	if (!text) {
		return '';
	}
	return text.length > max ? text.slice(0, max) + '…' : text;
}

async function parseJson(response) {
	const text = await response.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch (_) {
		json = null;
	}
	return {text, json};
}

function createSteamStorePurchaser(deps = {}) {
	const log = typeof deps.logger === 'function' ? deps.logger : noopLogger;

	async function purchasePackages(params = {}) {
		const cookies = Array.isArray(params.cookies) ? params.cookies.filter(Boolean) : [];
		const userAgent = params.userAgent || 'Mozilla/5.0';
		const packageIds = (Array.isArray(params.packageIds) ? params.packageIds : [params.packageIds])
			.map(id => Number(id))
			.filter(id => Number.isInteger(id) && id > 0);
		const country = String(params.country || 'US').trim().toUpperCase() || 'US';
		const currencyCode = Number(params.currency || 0);   // 数字货币枚举,用于 costwhenadded
		const dryRun = params.dryRun !== false;               // 默认 true:不真正扣款

		if (!cookies.length) {
			throw new Error('缺少 WebSession cookies,无法购买');
		}
		if (!packageIds.length) {
			throw new Error('未提供有效的 packageid(subid)');
		}

		const cookieList = cookies.slice();
		let sessionid = extractSessionId(cookieList);
		if (!sessionid && params.sessionid) {
			sessionid = String(params.sessionid).trim();
			cookieList.push('sessionid=' + sessionid);
		}
		if (!sessionid) {
			throw new Error('cookies 中找不到 sessionid,且未单独提供');
		}
		const cookieHeader = cookieList.join('; ');

		const baseHeaders = {Cookie: cookieHeader, 'User-Agent': userAgent, Origin: CHECKOUT, Referer: CHECKOUT + '/'};
		const formHeaders = {...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'};

		const trace = {steps: [], dryRun, country, packageIds};
		function note(step, summary, raw) {
			trace.steps.push({step, summary, raw: raw ? truncate(raw) : undefined});
			log('info', `[steam-purchase] ${step}: ${summary}`);
		}

		async function svcPost(svc, method, jsonObj, token) {
			const url = `${WEBAPI}/${svc}/${method}/v1/?access_token=${encodeURIComponent(token)}`;
			const res = await fetch(url, {method: 'POST', headers: formHeaders, body: 'input_json=' + encodeURIComponent(JSON.stringify(jsonObj))});
			return parseJson(res);
		}

		async function svcGet(svc, method, jsonObj, token) {
			const url = `${WEBAPI}/${svc}/${method}/v1/?access_token=${encodeURIComponent(token)}&input_json=${encodeURIComponent(JSON.stringify(jsonObj))}`;
			return parseJson(await fetch(url, {headers: baseHeaders}));
		}

		// ── 1. webapi_token ──────────────────────────────────────────────
		const tokenBody = await parseJson(await fetch(STORE + '/pointssummary/ajaxgetasyncconfig', {headers: {...baseHeaders, Accept: 'application/json, text/plain, */*'}}));
		const webapiToken = tokenBody.json && tokenBody.json.data && tokenBody.json.data.webapi_token;
		note('webapi_token', webapiToken ? '已取得' : '未取得', tokenBody.text);
		if (!webapiToken) {
			throw new Error('获取 webapi_token 失败(cookie 可能已失效),请重新登录该账号');
		}

		// ── 2. 价格(packagedetails,AddPackages 的 costwhenadded 需要) ────
		const priceMap = {};
		try {
			const pdBody = await parseJson(await fetch(`${STORE}/api/packagedetails?packageids=${packageIds.join(',')}&cc=${country}`, {headers: baseHeaders}));
			for (const id of packageIds) {
				const entry = pdBody.json && pdBody.json[id];
				const price = entry && entry.success && entry.data && entry.data.price;
				priceMap[id] = price ? Number(price.final) : 0;
			}
		} catch (_) { /* 价格取不到时用 0,Steam 仍会在 getfinalprice 重算真实价 */ }
		note('packagedetails', packageIds.map(id => `${id}=${priceMap[id] || 0}`).join(' '));

		// ── 3. 新建 GID 购物车 ───────────────────────────────────────────
		const createBody = await svcPost('IShoppingCartService', 'CreateNewShoppingCart', {}, webapiToken);
		const cartGid = createBody.json && createBody.json.response && createBody.json.response.gidshoppingcart;
		note('create_cart', cartGid ? ('gid=' + cartGid) : '未取得 gid', createBody.text);
		if (!cartGid) {
			throw new Error('新建购物车失败,响应=' + truncate(createBody.text, 200));
		}

		// ── 4. 加包 ──────────────────────────────────────────────────────
		const cartItems = packageIds.map(id => ({
			packageid: id,
			quantity: 1,
			is_gift: false,
			costwhenadded: {amount: priceMap[id] || 0, currencycode: currencyCode}
		}));
		const addBody = await svcPost('IShoppingCartService', 'AddPackages', {gidshoppingcart: cartGid, cart_items: cartItems, store_country_code: country}, webapiToken);
		const lineItems = addBody.json && addBody.json.response && addBody.json.response.contents && addBody.json.response.contents.lineitems;
		note('add_packages', Array.isArray(lineItems) ? (lineItems.length + ' 件已加入') : '购物车为空', addBody.text);
		if (!Array.isArray(lineItems) || !lineItems.length) {
			throw new Error('加入购物车失败(包不存在/区域不可购/价格缺失?),响应=' + truncate(addBody.text, 250));
		}

		// ── 4.5 余额预检(ValidateCart 拿钱包余额,余额不足就别发起交易了)──────
		let walletInfo = null;
		try {
			const vc = await svcGet('ICheckoutService', 'ValidateCart', {gidshoppingcart: cartGid, context: {language: 0, country_code: country}, for_init_purchase: true}, webapiToken);
			const totals = vc.json && vc.json.response && vc.json.response.estimated_totals;
			if (totals) {
				walletInfo = {
					subtotalCents: Number((totals.subtotal && totals.subtotal.amount_in_cents) || 0),
					walletCents: Number((totals.wallet_balance && totals.wallet_balance.amount_in_cents) || 0),
					exceedingCents: Number((totals.exceeding_wallet_balance && totals.exceeding_wallet_balance.amount_in_cents) || 0),
					subtotalText: formatCartAmount(totals.subtotal),
					walletText: formatCartAmount(totals.wallet_balance)
				};
			}
		} catch (_) { /* 预检失败不阻断,继续走正常流程,最终由交易状态兜底 */ }

		if (walletInfo) {
			note('funds_check', `需 ${walletInfo.subtotalText} / 钱包 ${walletInfo.walletText}`);
			const insufficient = walletInfo.exceedingCents > 0
				|| (walletInfo.walletCents > 0 && walletInfo.subtotalCents > 0 && walletInfo.walletCents < walletInfo.subtotalCents);
			if (insufficient) {
				throw new Error(`余额不足:本单需 ${walletInfo.subtotalText},钱包余额 ${walletInfo.walletText}`);
			}
		}

		// ── 5. inittransaction(checkout. 子域) ─────────────────────────
		const initForm = new URLSearchParams({
			gidShoppingCart: String(cartGid), gidReplayOfTransID: '-1', bUseAccountCart: '0',
			PaymentMethod: 'steamaccount', abortPendingTransactions: '0', bHasCardInfo: '0',
			CardNumber: '', CardExpirationYear: '', CardExpirationMonth: '',
			FirstName: '', LastName: '', Address: '', AddressTwo: '', Country: country, City: '', State: '', PostalCode: '', Phone: '',
			ShippingFirstName: '', ShippingLastName: '', ShippingAddress: '', ShippingAddressTwo: '', ShippingCountry: country, ShippingCity: '', ShippingState: '', ShippingPostalCode: '', ShippingPhone: '',
			bIsGift: '0', GifteeAccountID: '', GifteeEmail: '', GifteeName: '', GiftMessage: '', Sentiment: '', Signature: '', ScheduledSendOnDate: '0',
			BankAccount: '', BankCode: '', BankIBAN: '', BankBIC: '', TPBankID: '', bSaveBillingAddress: '1',
			gidPaymentID: '', bUseRemainingSteamAccount: '1', bPreAuthOnly: '0', sessionid
		});
		const initBody = await parseJson(await fetch(CHECKOUT + '/checkout/inittransaction/', {
			method: 'POST', headers: {...formHeaders, Referer: CHECKOUT + '/checkout/?cart=' + cartGid}, body: initForm.toString()
		}));
		const initOk = initBody.json && Number(initBody.json.success) === 1;
		const transId = initBody.json && initBody.json.transid;
		note('inittransaction', `success=${initBody.json && initBody.json.success} transid=${transId || '-'}`, initBody.text);
		if (!initOk || !transId) {
			throw new Error('inittransaction 失败,响应=' + truncate(initBody.text, 250));
		}

		// ── 6. getfinalprice(校验价格/余额) ─────────────────────────────
		const priceUrl = new URL(CHECKOUT + '/checkout/getfinalprice/');
		priceUrl.searchParams.set('count', '1');
		priceUrl.searchParams.set('transid', transId);
		priceUrl.searchParams.set('purchasetype', 'self');
		priceUrl.searchParams.set('microtxnid', '-1');
		priceUrl.searchParams.set('cart', String(cartGid));
		priceUrl.searchParams.set('gidReplayOfTransID', '-1');
		const priceBody = await parseJson(await fetch(priceUrl, {headers: {...baseHeaders, Referer: CHECKOUT + '/checkout/?cart=' + cartGid}}));
		const priceOk = priceBody.json && Number(priceBody.json.success) === 1;
		const finalCents = priceBody.json
			? (Number(priceBody.json.base || 0) - Number(priceBody.json.discount || 0) + Number(priceBody.json.tax || 0) + Number(priceBody.json.shipping || 0) + Number(priceBody.json.importfee || 0))
			: null;
		note('getfinalprice', `success=${priceBody.json && priceBody.json.success} final=${finalCents}`, priceBody.text);
		if (!priceOk) {
			throw new Error('getfinalprice 失败(余额不足/区域不符?),响应=' + truncate(priceBody.text, 250));
		}

		const priceInfo = {
			finalCents,
			currencyCode: priceBody.json ? Number(priceBody.json.currencycode || currencyCode) : currencyCode,
			base: priceBody.json && priceBody.json.base,
			discount: priceBody.json && priceBody.json.discount,
			tax: priceBody.json && priceBody.json.tax
		};

		if (dryRun) {
			note('dry_run_stop', '试运行:已验证到最终价,未扣款');
			return {success: true, dryRun: true, cartGid, transId, price: priceInfo, trace};
		}

		// ── 7. finalizetransaction(真扣款) ───────────────────────────────
		const browserInfo = JSON.stringify({language: 'zh-CN', javaEnabled: 'false', colorDepth: 24, screenHeight: 1080, screenWidth: 1920});
		const finalizeForm = new URLSearchParams({transid: transId, CardCVV2: '', browserInfo});
		const finalizeBody = await parseJson(await fetch(CHECKOUT + '/checkout/finalizetransaction/', {
			method: 'POST', headers: {...formHeaders, Referer: CHECKOUT + '/checkout/?cart=' + cartGid}, body: finalizeForm.toString()
		}));
		note('finalizetransaction', `success=${finalizeBody.json && finalizeBody.json.success}`, finalizeBody.text);

		// ── 8. transactionstatus(轮询确认) ──────────────────────────────
		let statusJson = null;
		for (let i = 0; i < 8; i++) {
			const statusUrl = new URL(CHECKOUT + '/checkout/transactionstatus/');
			statusUrl.searchParams.set('count', String(i + 1));
			statusUrl.searchParams.set('transid', transId);
			const statusBody = await parseJson(await fetch(statusUrl, {headers: {...baseHeaders, Referer: CHECKOUT + '/checkout/?cart=' + cartGid}}));
			statusJson = statusBody.json;
			const success = statusJson && Number(statusJson.success);
			const detail = statusJson && Number(statusJson.purchaseresultdetail);
			note('transactionstatus#' + (i + 1), `success=${success} detail=${detail}`, statusBody.text);
			// success===1 + purchaseresultdetail===0 = 成功;detail!==0 = 失败原因码(EPurchaseResultDetail)。
			if (success === 1 && detail === 0) {
				return {success: true, dryRun: false, cartGid, transId, price: priceInfo, purchaseResultDetail: 0, trace};
			}
			if (detail && detail !== 0) {
				throw new Error(describePurchaseResultDetail(detail));
			}
			await new Promise(resolve => setTimeout(resolve, 1500));
		}
		throw new Error('交易状态轮询超时,最后响应=' + truncate(JSON.stringify(statusJson), 200));
	}

	return {purchasePackages};
}

module.exports = {createSteamStorePurchaser};
