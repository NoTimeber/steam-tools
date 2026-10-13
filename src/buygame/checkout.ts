// Steam 商店「协议购买整款游戏」(从 app/services/steamStorePurchase.js 移来):用钱包余额买给登录账号自己。
//
// 和内购不同:内购走 GC 二进制协议买游戏内道具;这里用 WebSession cookie 重放浏览器的结算流程,
// 买的是整款游戏(以 packageid/subid 为单位)。
//
// 流程(2026-06 实测可用,与当前 checkout.js 一致):
//   1. webapi_token        GET  store.steampowered.com/pointssummary/ajaxgetasyncconfig
//   2. 取价格              GET  store.steampowered.com/api/packagedetails?packageids=..&cc=国家
//   3. 新建 GID 购物车     POST api.steampowered.com/IShoppingCartService/CreateNewShoppingCart  → gidshoppingcart
//   4. 加包(要 costwhenadded) POST api.steampowered.com/IShoppingCartService/AddPackages
//   4.5 余额预检           GET  api.steampowered.com/ICheckoutService/ValidateCart
//   5. 初始化交易          POST checkout.steampowered.com/checkout/inittransaction  → transid
//   6. 取最终价(校验)     GET  checkout.steampowered.com/checkout/getfinalprice
//   7. 完成交易(真扣款)   POST checkout.steampowered.com/checkout/finalizetransaction
//   8. 轮询交易状态        GET  checkout.steampowered.com/checkout/transactionstatus
//
// 要点:
//   - 结算端点全在 checkout.steampowered.com 子域;store. 上的同名端点已废(永远 success:2)。
//   - 必须用「新建 GID 购物车」(IShoppingCartService),账号购物车(IAccountCartService)没有 GID,喂不进 inittransaction。
//   - AddPackages 必须带 costwhenadded(amount + currencycode),否则不会真正加入。
//   - 钱包给自己买不需要手机/邮箱二次确认,可以全自动。
//   - dryRun(默认 true):跑到第 6 步(getfinalprice)就停,不扣款,用来安全验证。

const STORE = 'https://store.steampowered.com';
const CHECKOUT = 'https://checkout.steampowered.com';
const WEBAPI = 'https://api.steampowered.com';
const STATUS_POLLS = 8;
const STATUS_POLL_GAP_MS = 1500;

export type CheckoutLog = (level: 'info', message: string) => void;

/** Steam EPurchaseResultDetail 常见码(transactionstatus.purchaseresultdetail) */
const PURCHASE_RESULT_DETAIL: Readonly<Record<number, string>> = {
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

export function describePurchaseResultDetail(detail: unknown): string {
	const text = PURCHASE_RESULT_DETAIL[Number(detail)];
	return text ? `${text}(purchaseresultdetail=${detail})` : `购买失败 purchaseresultdetail=${detail}(参见 Steam EPurchaseResultDetail 码表)`;
}

interface CartAmount {
	formatted_amount?: unknown;
	amount_in_cents?: unknown;
}

/** 优先用 Steam 的本地化金额(如 "$U16,00"),否则按分换算 */
function formatCartAmount(amount: CartAmount | null | undefined): string {
	if (!amount) {
		return '?';
	}
	if (amount.formatted_amount) {
		return String(amount.formatted_amount);
	}
	return (Number(amount.amount_in_cents || 0) / 100).toFixed(2);
}

function extractSessionId(cookies: readonly string[]): string {
	for (const raw of cookies) {
		const match = /^sessionid=([^;]+)/.exec(String(raw).trim());
		if (match?.[1]) {
			return decodeURIComponent(match[1]);
		}
	}
	return '';
}

function truncate(value: unknown, max = 400): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	if (!text) {
		return '';
	}
	return text.length > max ? text.slice(0, max) + '…' : text;
}

async function readJson(response: Response): Promise<{text: string; json: any}> {
	const text = await response.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	return {text, json};
}

export interface PurchaseParams {
	cookies?: readonly string[];
	/** cookies 里没有 sessionid 时用这个(登录拿到的 webSessionID) */
	sessionid?: string;
	userAgent?: string;
	packageIds: unknown;
	/** 商店国家,决定区域价 */
	country?: string;
	/** 钱包数字货币枚举,AddPackages 的 costwhenadded 要用 */
	currency?: number | null;
	/** 默认 true:不扣款 */
	dryRun?: boolean;
}

export interface TraceStep {
	step: string;
	summary: string;
	raw?: string;
}

export interface PriceInfo {
	finalCents: number | null;
	currencyCode: number;
	base: unknown;
	discount: unknown;
	tax: unknown;
}

export interface PurchaseResult {
	success: true;
	dryRun: boolean;
	cartGid: unknown;
	transId: string;
	price: PriceInfo;
	purchaseResultDetail?: 0;
	trace: {steps: TraceStep[]; dryRun: boolean; country: string; packageIds: number[]};
}

export interface PackageInfo {
	packageId: number;
	name: string;
	appid: number;
	priceCents: number;
	currencyISO: string;
	discountPercent: number;
	available: boolean;
}

export interface CheckoutOptions {
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	log?: CheckoutLog;
}

export function createStoreCheckout(options: CheckoutOptions = {}) {
	const http = options.fetch ?? ((input, init) => fetch(input, init));
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const log: CheckoutLog = options.log ?? (() => {});

	async function purchasePackages(params: PurchaseParams): Promise<PurchaseResult> {
		const cookies = (params.cookies ?? []).filter(Boolean);
		const userAgent = params.userAgent || 'Mozilla/5.0';
		const packageIds = (Array.isArray(params.packageIds) ? params.packageIds : [params.packageIds])
			.map(id => Number(id))
			.filter(id => Number.isInteger(id) && id > 0);
		const country = String(params.country || 'US').trim().toUpperCase() || 'US';
		const currencyCode = Number(params.currency || 0);
		const dryRun = params.dryRun !== false;

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

		const baseHeaders: Record<string, string> = {Cookie: cookieList.join('; '), 'User-Agent': userAgent, Origin: CHECKOUT, Referer: CHECKOUT + '/'};
		const formHeaders = {...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'};

		const trace: PurchaseResult['trace'] = {steps: [], dryRun, country, packageIds};
		function note(step: string, summary: string, raw?: string): void {
			trace.steps.push({step, summary, raw: raw ? truncate(raw) : undefined});
			log('info', `[steam-purchase] ${step}: ${summary}`);
		}

		async function servicePost(service: string, method: string, input: unknown, token: string) {
			const url = `${WEBAPI}/${service}/${method}/v1/?access_token=${encodeURIComponent(token)}`;
			return readJson(await http(url, {method: 'POST', headers: formHeaders, body: 'input_json=' + encodeURIComponent(JSON.stringify(input))}));
		}

		async function serviceGet(service: string, method: string, input: unknown, token: string) {
			const url = `${WEBAPI}/${service}/${method}/v1/?access_token=${encodeURIComponent(token)}&input_json=${encodeURIComponent(JSON.stringify(input))}`;
			return readJson(await http(url, {headers: baseHeaders}));
		}

		// 1. webapi_token
		const tokenBody = await readJson(await http(STORE + '/pointssummary/ajaxgetasyncconfig', {headers: {...baseHeaders, Accept: 'application/json, text/plain, */*'}}));
		const webapiToken = tokenBody.json?.data?.webapi_token;
		note('webapi_token', webapiToken ? '已取得' : '未取得', tokenBody.text);
		if (!webapiToken) {
			throw new Error('获取 webapi_token 失败(cookie 可能已失效),请重新登录该账号');
		}

		// 2. 价格(AddPackages 的 costwhenadded 要用);取不到用 0,Steam 会在 getfinalprice 重算真实价
		const prices: Record<number, number> = {};
		try {
			const details = await readJson(await http(`${STORE}/api/packagedetails?packageids=${packageIds.join(',')}&cc=${country}`, {headers: baseHeaders}));
			for (const id of packageIds) {
				const entry = details.json && details.json[id];
				const price = entry && entry.success && entry.data && entry.data.price;
				prices[id] = price ? Number(price.final) : 0;
			}
		} catch {
			// 见上
		}
		note('packagedetails', packageIds.map(id => `${id}=${prices[id] || 0}`).join(' '));

		// 3. 新建 GID 购物车
		const createBody = await servicePost('IShoppingCartService', 'CreateNewShoppingCart', {}, webapiToken);
		const cartGid = createBody.json?.response?.gidshoppingcart;
		note('create_cart', cartGid ? 'gid=' + cartGid : '未取得 gid', createBody.text);
		if (!cartGid) {
			throw new Error('新建购物车失败,响应=' + truncate(createBody.text, 200));
		}
		const cartReferer = CHECKOUT + '/checkout/?cart=' + cartGid;

		// 4. 加包
		const cartItems = packageIds.map(id => ({
			packageid: id,
			quantity: 1,
			is_gift: false,
			costwhenadded: {amount: prices[id] || 0, currencycode: currencyCode}
		}));
		const addBody = await servicePost('IShoppingCartService', 'AddPackages', {gidshoppingcart: cartGid, cart_items: cartItems, store_country_code: country}, webapiToken);
		const lineItems = addBody.json?.response?.contents?.lineitems;
		note('add_packages', Array.isArray(lineItems) ? lineItems.length + ' 件已加入' : '购物车为空', addBody.text);
		if (!Array.isArray(lineItems) || !lineItems.length) {
			throw new Error('加入购物车失败(包不存在/区域不可购/价格缺失?),响应=' + truncate(addBody.text, 250));
		}

		// 4.5 余额预检:ValidateCart 拿钱包余额,不够就别发起交易了。预检失败不阻断,最终由交易状态兜底
		let wallet: {subtotalCents: number; walletCents: number; exceedingCents: number; subtotalText: string; walletText: string} | null = null;
		try {
			const validate = await serviceGet('ICheckoutService', 'ValidateCart', {gidshoppingcart: cartGid, context: {language: 0, country_code: country}, for_init_purchase: true}, webapiToken);
			const totals = validate.json?.response?.estimated_totals;
			if (totals) {
				wallet = {
					subtotalCents: Number(totals.subtotal?.amount_in_cents || 0),
					walletCents: Number(totals.wallet_balance?.amount_in_cents || 0),
					exceedingCents: Number(totals.exceeding_wallet_balance?.amount_in_cents || 0),
					subtotalText: formatCartAmount(totals.subtotal),
					walletText: formatCartAmount(totals.wallet_balance)
				};
			}
		} catch {
			// 见上
		}
		if (wallet) {
			note('funds_check', `需 ${wallet.subtotalText} / 钱包 ${wallet.walletText}`);
			const insufficient = wallet.exceedingCents > 0
				|| (wallet.walletCents > 0 && wallet.subtotalCents > 0 && wallet.walletCents < wallet.subtotalCents);
			if (insufficient) {
				throw new Error(`余额不足:本单需 ${wallet.subtotalText},钱包余额 ${wallet.walletText}`);
			}
		}

		// 5. inittransaction(checkout. 子域)
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
		const initBody = await readJson(await http(CHECKOUT + '/checkout/inittransaction/', {
			method: 'POST', headers: {...formHeaders, Referer: cartReferer}, body: initForm.toString()
		}));
		const initOk = initBody.json && Number(initBody.json.success) === 1;
		const transId = initBody.json && initBody.json.transid;
		note('inittransaction', `success=${initBody.json && initBody.json.success} transid=${transId || '-'}`, initBody.text);
		if (!initOk || !transId) {
			throw new Error('inittransaction 失败,响应=' + truncate(initBody.text, 250));
		}

		// 6. getfinalprice(校验价格/余额)
		const priceUrl = new URL(CHECKOUT + '/checkout/getfinalprice/');
		priceUrl.searchParams.set('count', '1');
		priceUrl.searchParams.set('transid', transId);
		priceUrl.searchParams.set('purchasetype', 'self');
		priceUrl.searchParams.set('microtxnid', '-1');
		priceUrl.searchParams.set('cart', String(cartGid));
		priceUrl.searchParams.set('gidReplayOfTransID', '-1');
		const priceBody = await readJson(await http(priceUrl, {headers: {...baseHeaders, Referer: cartReferer}}));
		const final = priceBody.json;
		const priceOk = final && Number(final.success) === 1;
		const finalCents = final
			? Number(final.base || 0) - Number(final.discount || 0) + Number(final.tax || 0) + Number(final.shipping || 0) + Number(final.importfee || 0)
			: null;
		note('getfinalprice', `success=${final && final.success} final=${finalCents}`, priceBody.text);
		if (!priceOk) {
			throw new Error('getfinalprice 失败(余额不足/区域不符?),响应=' + truncate(priceBody.text, 250));
		}
		const price: PriceInfo = {
			finalCents,
			currencyCode: Number(final.currencycode || currencyCode),
			base: final.base,
			discount: final.discount,
			tax: final.tax
		};

		if (dryRun) {
			note('dry_run_stop', '试运行:已验证到最终价,未扣款');
			return {success: true, dryRun: true, cartGid, transId, price, trace};
		}

		// 7. finalizetransaction(真扣款)
		const browserInfo = JSON.stringify({language: 'zh-CN', javaEnabled: 'false', colorDepth: 24, screenHeight: 1080, screenWidth: 1920});
		const finalizeBody = await readJson(await http(CHECKOUT + '/checkout/finalizetransaction/', {
			method: 'POST', headers: {...formHeaders, Referer: cartReferer}, body: new URLSearchParams({transid: transId, CardCVV2: '', browserInfo}).toString()
		}));
		note('finalizetransaction', `success=${finalizeBody.json && finalizeBody.json.success}`, finalizeBody.text);

		// 8. transactionstatus:success=1 且 purchaseresultdetail=0 是成功;detail 非 0 是失败原因码
		let status: any = null;
		for (let i = 0; i < STATUS_POLLS; i++) {
			const statusUrl = new URL(CHECKOUT + '/checkout/transactionstatus/');
			statusUrl.searchParams.set('count', String(i + 1));
			statusUrl.searchParams.set('transid', transId);
			const statusBody = await readJson(await http(statusUrl, {headers: {...baseHeaders, Referer: cartReferer}}));
			status = statusBody.json;
			const success = status && Number(status.success);
			const detail = status && Number(status.purchaseresultdetail);
			note('transactionstatus#' + (i + 1), `success=${success} detail=${detail}`, statusBody.text);
			if (success === 1 && detail === 0) {
				return {success: true, dryRun: false, cartGid, transId, price, purchaseResultDetail: 0, trace};
			}
			if (detail && detail !== 0) {
				throw new Error(describePurchaseResultDetail(detail));
			}
			await sleep(STATUS_POLL_GAP_MS);
		}
		throw new Error('交易状态轮询超时,最后响应=' + truncate(JSON.stringify(status), 200));
	}

	/** packageid → 游戏名/价格;用账号的 cookie/UA/国家请求,拿区域价 */
	async function resolvePackage(packageId: number, country: string, session: {cookies?: readonly string[]; userAgent?: string} = {}): Promise<PackageInfo> {
		const cc = String(country || 'US').trim().toUpperCase() || 'US';
		const headers: Record<string, string> = {Accept: 'application/json, text/plain, */*', 'User-Agent': session.userAgent || 'Mozilla/5.0'};
		if (session.cookies?.length) {
			headers.Cookie = session.cookies.join('; ');
		}
		const res = await http(`${STORE}/api/packagedetails?packageids=${packageId}&cc=${cc}&l=schinese`, {headers});
		if (!res.ok) {
			throw new Error(`packagedetails HTTP ${res.status}`);
		}
		const payload: any = await res.json();
		const entry = payload && payload[packageId];
		if (!entry || !entry.success || !entry.data) {
			throw new Error('未找到该 subid(可能不存在或当前区域不可见)');
		}
		const data = entry.data;
		const price = data.price || null;
		const apps: any[] = Array.isArray(data.apps) ? data.apps : [];
		return {
			packageId,
			name: String(data.name || (apps[0] && apps[0].name) || `Package ${packageId}`),
			appid: apps.length ? Number(apps[0].id) : 0,
			priceCents: price ? Number(price.final) : 0,
			currencyISO: price ? String(price.currency || '').toUpperCase() : '',
			discountPercent: price ? Number(price.discount_percent || 0) : 0,
			available: !!price || data.is_free_license === true
		};
	}

	return {purchasePackages, resolvePackage};
}

export type StoreCheckout = ReturnType<typeof createStoreCheckout>;
