'use strict';

// Steam 社区市场「求购单」模块(用登录账号的 WebSession cookie 在 steamcommunity.com 挂求购、撤求购)。
//
// 与现有「UU 上架出售」的区别:那条路是把库存通过悠悠有品(youpin898)API 转挂到市场;本模块直接重放
// 浏览器对 Steam 社区市场的调用 —— 即网页上「求购」对话框点确定时发的请求,买家出价等卖家成交。
//
// 用到的 Steam 端点(2026-06,与网页 market JS 一致):
//   1. 商品页(取 item_nameid / 物品名)  GET  steamcommunity.com/market/listings/<appid>/<market_hash_name>
//   2. 求购/在售盘口(行情参考)          GET  steamcommunity.com/market/itemordershistogram?...&item_nameid=..
//   3. 概览价(成交均价/在售最低/销量)    GET  steamcommunity.com/market/priceoverview/?...&market_hash_name=..
//   4. 挂求购单                          POST steamcommunity.com/market/createbuyorder/
//   5. 撤求购单                          POST steamcommunity.com/market/cancelbuyorder/
//
// 要点:
//   - createbuyorder 是表单 POST(application/x-www-form-urlencoded),字段:
//       sessionid / currency(钱包数字货币枚举) / appid / market_hash_name / price_total / quantity
//     price_total 是「总价的最小货币单位(分)」= 每件分价 × 数量。currency 必须等于账号钱包币种。
//   - 必须带 Referer = 该商品的上架页(market/listings/...),否则 Steam 会拒。
//   - sessionid 既在 Cookie 里、又要作为表单字段一起带(CSRF)。
//   - 求购单不需要手机/邮箱二次确认,可全自动。
//   - item_nameid 只能从商品页 HTML 里的 Market_LoadOrderSpread( <id> ) 抓,没有独立 API;
//     行情(盘口)是「锦上添花」,抓不到不影响挂单(用户自己填的价照样能挂)。

// 求购单可能需要 Steam 手机令牌确认(2024+ 新风控,部分账号/地区强制):createbuyorder 返回
// success=22(Pending)或带 needs_mobile_confirmation,此时订单仅"待确认",需用 identity_secret 在
// mobileconf 里 allow 后才真正生效。复用 steamcommunity 的 acceptConfirmationForObject(同发货确认)。
// 坑:success=22 时 Steam 往往**不返回 buy_orderid**,无法按对象 id 匹配确认项 → 改用「挂单前后快照差分」:
// 挂单前记下已有确认项 id,挂单后新出现的那条就是本单,其 creator 字段即真正的 buy_orderid。
// 必须走工厂建 community:库默认的 Chrome/118 UA 会被 Steam 以 429 挡掉,mobileconf 全线失败。
// 详见 src/steam/community.ts。
const {createSteamCommunity} = require('../../src/steam/community.ts');
const SteamTotp = require('steam-totp');

const COMMUNITY = 'https://steamcommunity.com';

// 设备时间与 Steam 的偏移(确认 key 用),进程级缓存 1 小时,避免每个账号都打一次 QueryTime。
let _cachedTimeOffset = null;
let _cachedTimeOffsetAt = 0;
function getTimeOffsetAsync() {
	const nowMs = Date.now();
	if (_cachedTimeOffset !== null && (nowMs - _cachedTimeOffsetAt) < 3600000) {
		return Promise.resolve(_cachedTimeOffset);
	}
	return new Promise(resolve => {
		try {
			SteamTotp.getTimeOffset((err, offset) => {
				if (!err) {
					_cachedTimeOffset = offset || 0;
					_cachedTimeOffsetAt = Date.now();
				}
				resolve(_cachedTimeOffset || 0);
			});
		} catch (_) {
			resolve(_cachedTimeOffset || 0);
		}
	});
}

// 拉取该账号当前所有待确认项(CConfirmation[]),用 identity_secret 自签 list key。
function getConfirmationsAsync(community, identitySecret, offset) {
	return new Promise((resolve, reject) => {
		const time = SteamTotp.time(offset || 0);
		const key = SteamTotp.getConfirmationKey(identitySecret, time, 'list');
		community.getConfirmations(time, {tag: 'list', key}, (err, confs) => err ? reject(err) : resolve(confs || []));
	});
}

// allow(accept)一条具体确认项(已从列表里拿到的 CConfirmation,含 nonce)。
function respondConfirmationAsync(conf, identitySecret, offset) {
	return new Promise((resolve, reject) => {
		const time = SteamTotp.time(offset || 0);
		const key = SteamTotp.getConfirmationKey(identitySecret, time, 'accept');
		conf.respond(time, {tag: 'accept', key}, true, err => err ? reject(err) : resolve());
	});
}

// createbuyorder 返回的 success 非 1 时的常见含义(EResult 子集 + Steam 自定义码)。
const BUY_ORDER_ERROR = {
	2: '操作失败(Steam 通用错误,稍后重试)',
	8: '参数无效(物品名或价格不正确)',
	15: '没有访问权限(cookie 可能已失效,请重新登录该账号)',
	16: '操作超时,请重试',
	20: 'Steam 市场服务暂时不可用,请稍后重试',
	21: '该账号登录态已失效,请重新登录后再挂求购',
	// EResult 22 = Pending:求购单已建但需 Steam 手机令牌确认。createBuyOrder 已单独处理(自动确认),
	// 此处文案仅作其它路径(如撤单)兜底。
	22: '操作待 Steam 手机令牌确认(Pending),请在 Steam 手机 App 确认',
	24: '钱包余额/参数不足以挂此求购',
	25: '已达求购单数量上限(请先撤掉部分旧求购)',
	26: '物品不存在或不可在市场交易',
	29: '重复的求购请求(可能上一单仍在处理),请稍后再试',
	78: '该求购已存在或与现有求购冲突'
};

function describeBuyOrderError(code, message, rawText) {
	if (message) {
		return `${message}(success=${code})`;
	}
	const text = BUY_ORDER_ERROR[Number(code)];
	if (text) {
		return text;
	}
	// 未知码:把 Steam 原始返回片段带出来,便于排查。
	const extra = rawText ? `:${truncate(String(rawText), 160)}` : '';
	return `挂求购单失败(success=${code})${extra}`;
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

// 解析市场商品链接 → {appid, marketHashName}。
// 接受:完整 URL(https://steamcommunity.com/market/listings/730/G18BD283004)
//      或仅路径(/market/listings/730/AK-47...)。market_hash_name 会做一次 URL 解码。
function parseListingUrl(input) {
	const raw = String(input || '').trim();
	if (!raw) {
		throw new Error('请填写市场商品链接');
	}
	const match = /\/market\/listings\/(\d+)\/([^/?#]+)/i.exec(raw);
	if (!match) {
		throw new Error('链接格式不对,应形如 https://steamcommunity.com/market/listings/730/物品名');
	}
	const appid = Number(match[1]);
	let marketHashName = match[2];
	try {
		marketHashName = decodeURIComponent(marketHashName);
	} catch (_) {
		// 已是解码态(含特殊字符)时 decodeURIComponent 可能抛错,保留原值。
	}
	if (!Number.isInteger(appid) || appid <= 0 || !marketHashName) {
		throw new Error('链接中缺少有效的 appid 或物品名');
	}
	return {appid, marketHashName};
}

function listingUrl(appid, marketHashName) {
	return `${COMMUNITY}/market/listings/${appid}/${encodeURIComponent(marketHashName)}`;
}

function createSteamMarketBuyOrder(deps = {}) {
	const log = typeof deps.logger === 'function' ? deps.logger : noopLogger;

	function buildCookieHeader(cookies, sessionidFallback) {
		const list = (Array.isArray(cookies) ? cookies : []).filter(Boolean).slice();
		let sessionid = extractSessionId(list);
		if (!sessionid && sessionidFallback) {
			sessionid = String(sessionidFallback).trim();
			if (sessionid) {
				list.push('sessionid=' + sessionid);
			}
		}
		return {cookieHeader: list.join('; '), sessionid};
	}

	// 行情参考(尽力而为):商品页抓 item_nameid + 物品名 → 盘口 + 概览价。
	// 任一步失败都不抛,返回已拿到的部分,挂单不依赖它。
	async function fetchMarketContext(params = {}) {
		const {appid, marketHashName} = params;
		const cookies = Array.isArray(params.cookies) ? params.cookies.filter(Boolean) : [];
		const userAgent = params.userAgent || 'Mozilla/5.0';
		const currency = Number(params.currency || 0);
		const country = String(params.country || 'US').trim().toUpperCase() || 'US';
		const language = params.language || 'english';
		// 调用方(路由)可传入已知 item_nameid(来自本地缓存或用户手填)。
		// 背景:Steam 2025/2026 把市场商品页改成了 React SSR 应用,页面 HTML 里不再内嵌
		// `Market_LoadOrderSpread( item_nameid )`,老正则已基本抓不到 item_nameid;
		// 而盘口接口 itemordershistogram 仍正常,只要有 item_nameid 就能拿到最高求购/最低在售。
		const providedNameId = String(params.itemNameId || '').replace(/\D/g, '');

		const cookieHeader = cookies.join('; ');
		const pageUrl = listingUrl(appid, marketHashName);
		const baseHeaders = {'User-Agent': userAgent};
		if (cookieHeader) {
			baseHeaders.Cookie = cookieHeader;
		}

		const result = {
			appid,
			marketHashName,
			currency,
			itemNameId: providedNameId,
			itemName: '',
			highestBuyOrderCents: null,
			lowestSellOrderCents: null,
			lowestPrice: '',
			medianPrice: '',
			volume: ''
		};

		// 1) 商品页:展示名 +(尽力)item_nameid。
		//    item_nameid 优先用外部传入的;没有才回退到老正则(新版 React 页面多半抓不到,
		//    但部分旧版/特定 appid 仍可能命中,留作回退无害)。
		try {
			const pageRes = await fetch(pageUrl, {headers: {...baseHeaders, Accept: 'text/html'}});
			const html = await pageRes.text();
			if (!result.itemNameId) {
				const idMatch = /Market_LoadOrderSpread\(\s*(\d+)\s*\)/.exec(html);
				if (idMatch) {
					result.itemNameId = idMatch[1];
				}
			}
			const nameMatch = /id="largeiteminfo_item_name"[^>]*>([^<]+)</.exec(html)
				|| /<title>[^<]*?(?:Listings for|的)\s*(.+?)<\/title>/.exec(html);
			if (nameMatch) {
				result.itemName = nameMatch[1].trim();
			}
		} catch (err) {
			log('warn', `[market-buyorder] 商品页抓取失败: ${err && err.message ? err.message : err}`);
		}

		// 2) 盘口:最高求购价 / 最低在售价(需 item_nameid)
		if (result.itemNameId) {
			try {
				const histUrl = new URL(COMMUNITY + '/market/itemordershistogram');
				histUrl.searchParams.set('country', country);
				histUrl.searchParams.set('language', language);
				histUrl.searchParams.set('currency', String(currency));
				histUrl.searchParams.set('item_nameid', result.itemNameId);
				histUrl.searchParams.set('two_factor', '0');
				const histRes = await fetch(histUrl, {headers: {...baseHeaders, Accept: 'application/json', Referer: pageUrl}});
				const hist = await parseJson(histRes);
				if (hist.json && Number(hist.json.success) === 1) {
					const hb = Number(hist.json.highest_buy_order);
					const ls = Number(hist.json.lowest_sell_order);
					result.highestBuyOrderCents = Number.isFinite(hb) ? hb : null;
					result.lowestSellOrderCents = Number.isFinite(ls) ? ls : null;
				}
			} catch (err) {
				log('warn', `[market-buyorder] 盘口抓取失败: ${err && err.message ? err.message : err}`);
			}
		}

		// 3) 概览价:成交均价 / 在售最低 / 近 24h 销量
		try {
			const ovUrl = new URL(COMMUNITY + '/market/priceoverview/');
			ovUrl.searchParams.set('country', country);
			ovUrl.searchParams.set('currency', String(currency));
			ovUrl.searchParams.set('appid', String(appid));
			ovUrl.searchParams.set('market_hash_name', marketHashName);
			const ovRes = await fetch(ovUrl, {headers: {...baseHeaders, Accept: 'application/json', Referer: pageUrl}});
			const ov = await parseJson(ovRes);
			if (ov.json && ov.json.success) {
				result.lowestPrice = String(ov.json.lowest_price || '');
				result.medianPrice = String(ov.json.median_price || '');
				result.volume = String(ov.json.volume || '');
			}
		} catch (err) {
			log('warn', `[market-buyorder] 概览价抓取失败: ${err && err.message ? err.message : err}`);
		}

		return result;
	}

	// 挂一张求购单。
	// params: { cookies, sessionid, userAgent, appid, marketHashName, currency, priceTotalCents, quantity, confirmation? }
	// ⚠️ 关键流程(对照 aiosteampy place_buy_order):
	//   1) 首次提交(不带 confirmation)→ Steam 返回 {need_confirmation, confirmation:{confirmation_id}}(success=22),订单尚未真正建立;
	//   2) 用手机令牌 allow 该确认项;
	//   3) **带 confirmation=<confirmation_id> 再次提交** → Steam 才返回 buy_orderid,订单这时才真正落地。
	//   只 allow 确认、不重发第 3 步,订单会被丢弃(网页端「我的求购单」查不到)。
	// 返回: { success:true, buyOrderId, confirmationId, needsConfirmation }
	async function createBuyOrder(params = {}) {
		const cookies = Array.isArray(params.cookies) ? params.cookies.filter(Boolean) : [];
		const userAgent = params.userAgent || 'Mozilla/5.0';
		const appid = Number(params.appid);
		const marketHashName = String(params.marketHashName || '');
		const currency = Number(params.currency || 0);
		const priceTotalCents = Math.round(Number(params.priceTotalCents));
		const quantity = Math.round(Number(params.quantity));

		if (!cookies.length && !params.sessionid) {
			throw new Error('缺少 WebSession cookies,无法挂求购');
		}
		if (!Number.isInteger(appid) || appid <= 0) {
			throw new Error('appid 无效');
		}
		if (!marketHashName) {
			throw new Error('物品名(market_hash_name)为空');
		}
		if (!Number.isInteger(currency) || currency <= 0) {
			throw new Error('账号钱包币种未知,无法挂求购(请确认该账号有钱包)');
		}
		if (!Number.isInteger(quantity) || quantity <= 0) {
			throw new Error('求购数量必须为正整数');
		}
		if (!Number.isInteger(priceTotalCents) || priceTotalCents <= 0) {
			throw new Error('求购价格无效');
		}

		const {cookieHeader, sessionid} = buildCookieHeader(cookies, params.sessionid);
		if (!sessionid) {
			throw new Error('cookies 中找不到 sessionid,且未单独提供');
		}

		const referer = listingUrl(appid, marketHashName);
		const form = new URLSearchParams({
			sessionid,
			currency: String(currency),
			appid: String(appid),
			market_hash_name: marketHashName,
			price_total: String(priceTotalCents),
			quantity: String(quantity),
			billing_state: '',
			save_my_address: '0'
		});
		// 第 3 步重发时带上 confirmation=<confirmation_id>,Steam 据此把"待确认"的求购单最终落地。
		const confirmationField = String(params.confirmation || '').replace(/\D/g, '');
		if (confirmationField) {
			form.set('confirmation', confirmationField);
		}

		const res = await fetch(COMMUNITY + '/market/createbuyorder/', {
			method: 'POST',
			headers: {
				Cookie: cookieHeader,
				'User-Agent': userAgent,
				Origin: COMMUNITY,
				Referer: referer,
				'X-Requested-With': 'XMLHttpRequest',
				Accept: '*/*',
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
			},
			body: form.toString()
		});
		const {text, json} = await parseJson(res);
		log('info', `[market-buyorder] createbuyorder ${marketHashName} 总价=${priceTotalCents} x${quantity} → ${truncate(text, 200)}`);

		if (!json) {
			// 多半是 cookie 失效后被重定向到登录页(返回 HTML)。
			throw new Error('Steam 未返回有效响应,cookie 可能已失效,请重新登录该账号');
		}
		const code = Number(json.success);
		// success: 1 = 已挂单(可能仍带 need_confirmation);22 = Pending,订单已建但需手机确认才生效。
		// 这两种都算"挂上了",其余按错误处理。
		if (code !== 1 && code !== 22) {
			throw new Error(describeBuyOrderError(json.success, json.message, text));
		}
		const buyOrderId = json.buy_orderid ? String(json.buy_orderid) : '';
		// 实测 success=22 的响应形如:{"need_confirmation":true,"confirmation":{"confirmation_id":"..."},"success":22}
		// confirmation_id 直接等于 mobileconf 列表里的 conf.id,据此精确定位待确认项(最可靠)。
		const confirmationId = (json.confirmation && json.confirmation.confirmation_id)
			? String(json.confirmation.confirmation_id) : '';
		const needsConfirmation = code === 22 || !!json.need_confirmation
			|| !!json.needs_mobile_confirmation || !!json.mobile_confirmation_required || !!confirmationId;
		return {success: true, buyOrderId, confirmationId, needsConfirmation};
	}

	// 挂单「前」快照:返回该账号当前所有待确认项的 id 集合(Set<string>)。
	// 用于 success=22 不返回 buy_orderid 时,挂单后差分出本单的确认项。无 maFile/读取失败时返回空集。
	async function listConfirmationIds(params = {}) {
		const cookies = Array.isArray(params.cookies) ? params.cookies.filter(Boolean) : [];
		const identitySecret = String(params.identitySecret || '').trim();
		if (!cookies.length || !identitySecret) {
			return new Set();
		}
		const community = createSteamCommunity();
		community.setCookies(cookies);
		const offset = await getTimeOffsetAsync();
		const confs = await getConfirmationsAsync(community, identitySecret, offset);
		return new Set(confs.map(c => String(c.id)));
	}

	// 手机令牌确认一张「待确认」的求购单。失败抛错(含未导入 maFile / 定位不到确认项 等)。
	// 实测:createbuyorder 返回的 confirmation_id 对不上 mobileconf 列表的 conf.id(多半是 creator_id),
	// 故采用「快照差分为主 + id/creator 匹配为辅」的稳健定位(字段语义无关),都失败时打印整张列表帮诊断。
	// 确认项可能在挂单后稍有延迟才出现,故带几次重试。返回 {confirmed:true, buyOrderId}(尽量回填真实 buy_orderid)。
	async function confirmBuyOrder(params = {}) {
		const cookies = Array.isArray(params.cookies) ? params.cookies.filter(Boolean) : [];
		const identitySecret = String(params.identitySecret || '').trim();
		const confirmationId = String(params.confirmationId || '').trim();
		const buyOrderId = String(params.buyOrderId || '').trim();
		const priorConfIds = params.priorConfIds instanceof Set ? params.priorConfIds
			: (Array.isArray(params.priorConfIds) ? new Set(params.priorConfIds.map(String)) : null);
		const timeoutMs = Number(params.timeoutMs) || 30000;
		const attempts = Number(params.attempts) || 6;
		const gapMs = Number(params.gapMs) || 2000;

		if (!cookies.length) {
			throw new Error('缺少 WebSession cookies,无法确认求购单');
		}
		if (!identitySecret) {
			throw new Error('该账号未导入 maFile(identity_secret),无法自动手机确认');
		}
		if (!confirmationId && !buyOrderId && !priorConfIds) {
			throw new Error('未取到 confirmation_id / buy_orderid 且无确认快照,无法定位待确认的求购单(请在 Steam 手机 App 手动确认)');
		}

		const community = createSteamCommunity();
		community.setCookies(cookies); // 同步;从 steamLoginSecure 解析 steamID,getConfirmations 需要
		const withTimeout = (p, label) => Promise.race([
			p,
			new Promise((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), timeoutMs))
		]);
		const offset = await getTimeOffsetAsync();

		let lastErr = null;
		for (let i = 0; i < attempts; i++) {
			try {
				const confs = await withTimeout(getConfirmationsAsync(community, identitySecret, offset), 'getConfirmations');
				// 候选集:有挂单前快照就只看「新冒出」的(字段语义无关,最稳);否则看全部待确认项。
				const candidates = priorConfIds ? confs.filter(c => !priorConfIds.has(String(c.id))) : confs;

				// 在候选里精确锁定本单:confirmation_id 既可能 = conf.id 也可能 = conf.creator,两边都比;
				// 再退到已知 buy_orderid 比 creator;还不行而候选恰好只有 1 条,那就是它。
				let conf = null;
				if (confirmationId) {
					conf = candidates.find(c => String(c.id) === confirmationId || String(c.creator) === confirmationId);
				}
				if (!conf && buyOrderId) {
					conf = candidates.find(c => String(c.creator) === buyOrderId);
				}
				if (!conf && candidates.length === 1) {
					conf = candidates[0];
				}

				if (!conf) {
					if (candidates.length > 1) {
						// 多条候选又无法用 id/creator 区分 → 保守报错,交用户手动确认,绝不盲收别的确认项。
						log('warn', `[market-buyorder] ${candidates.length} 个候选确认项无法匹配本单(confId=${confirmationId || '-'} buyOrderId=${buyOrderId || '-'}): ` + candidates.map(c => `{id:${c.id},creator:${c.creator},type:${c.type}}`).join(','));
						throw new Error(`检测到 ${candidates.length} 个待确认项,无法确定属于本求购单,请在 Steam 手机 App 手动确认`);
					}
					// 0 条候选:确认项还没生成 → 等一下重试。
					if (i < attempts - 1) {
						log('info', `[market-buyorder] 待确认项暂未出现,${gapMs}ms 后重试(${i + 1}/${attempts})`);
						await new Promise(r => setTimeout(r, gapMs));
						continue;
					}
					// 重试用尽仍空:dump 整张列表帮诊断(可能是新版购买确认走了别的体系)。
					log('warn', `[market-buyorder] 重试结束仍未找到确认项。confId=${confirmationId || '-'} buyOrderId=${buyOrderId || '-'} 列表共 ${confs.length} 条: ` + confs.map(c => `{id:${c.id},creator:${c.creator},type:${c.type}}`).join(','));
					throw new Error('Could not find confirmation');
				}

				await withTimeout(respondConfirmationAsync(conf, identitySecret, offset), 'respondConfirmation');
				const recovered = String(conf.creator || '') || buyOrderId;
				log('info', `[market-buyorder] 求购单手机确认完成(confId=${conf.id}, creator/buyOrderId=${recovered || '?'})`);
				return {confirmed: true, buyOrderId: recovered};
			} catch (err) {
				lastErr = err;
				const msg = (err && err.message) || '';
				// 确认项还没生成 → 等一下重试;其它错误直接抛。
				if (/Could not find confirmation/i.test(msg) && i < attempts - 1) {
					log('info', `[market-buyorder] 确认项暂未出现,${gapMs}ms 后重试(${i + 1}/${attempts})`);
					await new Promise(r => setTimeout(r, gapMs));
					continue;
				}
				throw err;
			}
		}
		throw lastErr || new Error('确认失败');
	}

	// 撤一张求购单。params: { cookies, sessionid, userAgent, buyOrderId }
	async function cancelBuyOrder(params = {}) {
		const cookies = Array.isArray(params.cookies) ? params.cookies.filter(Boolean) : [];
		const userAgent = params.userAgent || 'Mozilla/5.0';
		const buyOrderId = String(params.buyOrderId || '').trim();
		if (!buyOrderId) {
			throw new Error('缺少 buy_orderid');
		}
		const {cookieHeader, sessionid} = buildCookieHeader(cookies, params.sessionid);
		if (!sessionid) {
			throw new Error('cookies 中找不到 sessionid,且未单独提供');
		}

		const form = new URLSearchParams({sessionid, buy_orderid: buyOrderId});
		const res = await fetch(COMMUNITY + '/market/cancelbuyorder/', {
			method: 'POST',
			headers: {
				Cookie: cookieHeader,
				'User-Agent': userAgent,
				Origin: COMMUNITY,
				Referer: COMMUNITY + '/market/',
				'X-Requested-With': 'XMLHttpRequest',
				Accept: '*/*',
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
			},
			body: form.toString()
		});
		const {text, json} = await parseJson(res);
		log('info', `[market-buyorder] cancelbuyorder ${buyOrderId} → ${truncate(text, 160)}`);
		// 撤单成功返回 {success:1};订单已不存在时 Steam 也可能返回非 1,这里宽松处理:
		// 只有明确 success===1 视为成功,其余抛错由上层决定是否当作"已撤"。
		if (json && Number(json.success) === 1) {
			return {success: true};
		}
		throw new Error(describeBuyOrderError(json && json.success, json && json.message) || '撤销失败');
	}

	// 拉取该账号在 Steam 上的真实求购单(用于刷新/对账)。
	// GET market/mylistings?norender=1 返回 {success, buy_orders:[{buy_orderid, price, quantity, quantity_remaining, description:{appid, market_hash_name|name}}]}。
	// price 是每件最小货币单位(分),与挂单时一致。返回标准化数组。
	async function fetchMyBuyOrders(params = {}) {
		const cookies = Array.isArray(params.cookies) ? params.cookies.filter(Boolean) : [];
		const userAgent = params.userAgent || 'Mozilla/5.0';
		if (!cookies.length && !params.sessionid) {
			throw new Error('缺少 WebSession cookies,无法读取求购单');
		}
		const {cookieHeader} = buildCookieHeader(cookies, params.sessionid);
		const res = await fetch(COMMUNITY + '/market/mylistings/?norender=1&start=0&count=100', {
			method: 'GET',
			headers: {
				Cookie: cookieHeader,
				'User-Agent': userAgent,
				Referer: COMMUNITY + '/market/',
				'X-Requested-With': 'XMLHttpRequest',
				Accept: '*/*'
			}
		});
		const {text, json} = await parseJson(res);
		if (!json) {
			throw new Error('Steam 未返回有效响应,cookie 可能已失效,请重新登录该账号');
		}
		if (!json.success) {
			throw new Error(describeBuyOrderError(json.success, json.message, text));
		}
		const raw = Array.isArray(json.buy_orders) ? json.buy_orders : [];
		return raw.map(o => {
			const d = o.description || {};
			return {
				buyOrderId: String(o.buy_orderid || ''),
				priceCents: Number(o.price) || 0,
				quantity: Number(o.quantity) || 0,
				quantityRemaining: o.quantity_remaining != null ? Number(o.quantity_remaining) : null,
				appid: Number(d.appid) || 0,
				marketHashName: String(d.market_hash_name || d.name || '')
			};
		}).filter(o => o.buyOrderId);
	}

	return {parseListingUrl, fetchMarketContext, createBuyOrder, listConfirmationIds, confirmBuyOrder, cancelBuyOrder, fetchMyBuyOrders};
}

module.exports = {createSteamMarketBuyOrder, parseListingUrl};
