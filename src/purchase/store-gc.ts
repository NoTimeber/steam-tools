// GC 商店协议(从 app/server.js 移来):查价目表(StoreGetUserData)和真实下单。
// 下单三步:StorePurchaseInit → Steam 钱包扣款授权(MicroTxn,见 ../steam/microtxn.ts) → StorePurchaseFinalize。
// CS2 和 TF2 用同一套 Valve GC 商城后端,消息号不同(Finalize:CS2 2504,TF2 2512),载荷规则略有差别,见 buildPurchaseInit。

import {existsSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import type {EventEmitter} from 'node:events';
import {sendGcRequest} from '../steam/gc-client.ts';
import type {ProtoType} from '../steam/gc-client.ts';
import {gameConfig, normalizeGame} from '../steam/games.ts';
import type {GameId} from '../steam/games.ts';
import {CURRENCY_ISO_TO_COUNTRY, currencyIdToIso, normalizeCountryCode} from '../steam/currencies.ts';
import {decodePriceSheet} from '../steam/price-sheet.ts';
import type {DecodedPriceSheet} from '../steam/price-sheet.ts';
import {authorizeMicroTxn, waitForMicroTxnRequest} from '../steam/microtxn.ts';
import type {MicroTxnClient} from '../steam/microtxn.ts';
import {safeName} from '../steam/session-manager.ts';
import type {Attempt} from '../steam/session-manager.ts';
import {findCatalogItem, itemPrice, TF2_KEY_DEF_INDEX, UYU_TF2_KEY_COST} from './catalog-items.ts';
import type {CatalogItem, CatalogItemBuilder} from './catalog-items.ts';

const require = createRequire(import.meta.url);

export const PURCHASE_GC_TIMEOUT_MS = 15000;
const PURCHASE_LANGUAGE_CODE = 6;
const GC_RESULT_OK = 1;
const USD_CURRENCY = 1;
// 乌拉圭:钱包币种 id 是 41(UYU),商店价目表里的 UYU 却索引成 40
export const UY_WALLET_CURRENCY = 41;
export const UY_STORE_CURRENCY = 40;

interface GcCall {
	request: number;
	requestProto: ProtoType;
	response: number;
	responseProto: ProtoType;
}

interface StoreMessages {
	getUserData: GcCall;
	purchaseInit: GcCall;
	purchaseFinalize: GcCall;
}

type MessageIds = Record<string, number>;
type Protos = Record<string, ProtoType>;

let storeMessages: Record<GameId, StoreMessages> | null = null;

// 用到时才加载 GC 的 protobuf 定义:app/server.js 已按顺序加载过(并修好了共享根的冲突),这里拿到的是同一份缓存。
// 注意:两个库的生成代码共用 protobufjs 的默认根,后加载的 tf2 会覆盖同名消息类型。CS2 这边因此实际用的是
// TF2 版的 CMsgStoreGetUserData(没有 currency 字段,请求里的钱包币种编码时被丢掉)和 TF2 版的回包
// (字段名是 currency/country 而不是 *_deprecated,下面两种都读)。下单用的 Init/Finalize 两边字段一致,不受影响。
function messagesFor(game: GameId): StoreMessages {
	if (!storeMessages) {
		const table = (ids: MessageIds, protos: Protos): StoreMessages => {
			const call = (name: string, request: string, response: string): GcCall => ({
				request: ids[name] as number,
				requestProto: protos[request] as ProtoType,
				response: ids[`${name}Response`] as number,
				responseProto: protos[response] as ProtoType
			});
			return {
				getUserData: call('StoreGetUserData', 'CMsgStoreGetUserData', 'CMsgStoreGetUserDataResponse'),
				purchaseInit: call('StorePurchaseInit', 'CMsgGCStorePurchaseInit', 'CMsgGCStorePurchaseInitResponse'),
				purchaseFinalize: call('StorePurchaseFinalize', 'CMsgGCStorePurchaseFinalize', 'CMsgGCStorePurchaseFinalizeResponse')
			};
		};
		storeMessages = {
			cs2: table(require('globaloffensive/language') as MessageIds, require('globaloffensive/protobufs/generated/base_gcmessages') as Protos),
			tf2: table(require('tf2/language') as MessageIds, require('tf2/protobufs/generated/_load') as Protos)
		};
	}
	return storeMessages[game];
}

/** 64 位 id(txn_id / item_id)可能是字符串、数字、bigint 或 Long */
export function longToString(value: unknown): string {
	if (value == null) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'bigint') {
		return String(value);
	}
	if (typeof value === 'object' && typeof (value as {toString?: unknown}).toString === 'function') {
		return (value as {toString(): string}).toString();
	}
	return String(value);
}

/** 乌拉圭账号的商店币种:钱包 41 / 商店 40 / ISO=UYU / 未知(0)都归成 40;其它原样 */
export function normalizeStoreCurrency(currency: unknown, country: unknown, currencyISO: unknown): number {
	const numeric = Number(currency || 0);
	const normalizedCountry = normalizeCountryCode(country);
	const iso = String(currencyISO || '').trim().toUpperCase();
	if (normalizedCountry === 'UY' && (numeric === UY_WALLET_CURRENCY || numeric === UY_STORE_CURRENCY || iso === 'UYU' || numeric === 0)) {
		return UY_STORE_CURRENCY;
	}
	return numeric;
}

export interface StoreData {
	source: string;
	fetchedAt: string;
	account: string;
	attemptId: string;
	game: GameId;
	country: string;
	currency: number;
	currencyISO: string;
	balance: number | null;
	priceSheetVersion: number;
	priceSheetLength?: number;
	/** 只在内存里:原始和解析后的价目表(写目录缓存时去掉) */
	rawPriceSheet?: Buffer;
	parsedPriceSheet?: DecodedPriceSheet;
	list: CatalogItem[];
}

/** 下单需要的账号购物车(PurchaseTaskAccount 的子集) */
export interface PurchaseOrder {
	currencyISO: string;
	country: string;
	items: Array<{itemDefId: number; quantity: number; unitPriceCents: number}>;
}

export interface PurchaseInitPlan {
	body: {country: string; language: number; line_items: Array<Record<string, number>>; currency?: number};
	/** 日志里的载荷说明 */
	describe: string;
	/** 失败时附在错误信息里的载荷摘要 */
	failureDetail: string;
}

function tf2PurchaseCountry(storeData: StoreData, order: PurchaseOrder, currency: number): string {
	const country = normalizeCountryCode(storeData.country || order.country || '');
	if (country) {
		return country;
	}
	return currency === UY_STORE_CURRENCY || String(order.currencyISO || '').trim().toUpperCase() === 'UYU' ? 'UY' : '';
}

/**
 * PurchaseInit 载荷。CS2 和 TF2 共用的规则(都是实测出来的,违反会得到 result=8 InvalidParam):
 *   1) USD 是价目表的基准币种(价位本身就是美分),子表里没有 USD 行:USD 账号省略 currency;
 *   2) 乌拉圭钱包币种 41 要换成商店的 40(normalizeStoreCurrency);
 *   3) purchase_type=0 会被拒:CS2 不发;TF2 只卖钥匙,钥匙也不发。
 * TF2 乌拉圭钥匙按价目表里的 UYU 价计价(没有就用 9600)。
 */
export function buildPurchaseInit(game: unknown, order: PurchaseOrder, storeData: StoreData, attempt: Pick<Attempt, 'currency' | 'country' | 'loginGeoCountry'>): PurchaseInitPlan {
	if (normalizeGame(game) === 'tf2') {
		const currency = normalizeStoreCurrency(storeData.currency, storeData.country, order.currencyISO);
		const country = tf2PurchaseCountry(storeData, order, currency);
		const lineItems = order.items.map(item => {
			const quantity = Math.max(1, Number(item.quantity || 0));
			let unitPrice = Math.max(0, Number(item.unitPriceCents || 0));
			if (country === 'UY' && currency === UY_STORE_CURRENCY && Number(item.itemDefId) === TF2_KEY_DEF_INDEX) {
				const localPrice = itemPrice(findCatalogItem(storeData.list, item.itemDefId), 'UYU');
				unitPrice = localPrice > 0 ? localPrice : UYU_TF2_KEY_COST;
			}
			const line: Record<string, number> = {
				item_def_id: Number(item.itemDefId),
				quantity: Number(item.quantity || 0),
				cost_in_local_currency: unitPrice * quantity
			};
			if (Number(item.itemDefId) !== TF2_KEY_DEF_INDEX) {
				line.purchase_type = 0;
			}
			return line;
		});
		const isBaseCurrency = String(order.currencyISO || '').trim().toUpperCase() === 'USD' || currency === USD_CURRENCY;
		const body: PurchaseInitPlan['body'] = {country, language: PURCHASE_LANGUAGE_CODE, line_items: lineItems};
		if (!isBaseCurrency) {
			body.currency = currency;
		}
		return {
			body,
			describe: `country=${country || '(空)'} currency=${isBaseCurrency ? '省略(USD基准币种)' : currency} storeCurrency=${storeData.currency} currencyISO=${order.currencyISO} 行项=${JSON.stringify(lineItems)}`,
			failureDetail: `(载荷 country=${country || '空'} currency=${isBaseCurrency ? '省略' : currency} cost=${lineItems.map(line => line.cost_in_local_currency).join('/')} ptype=${lineItems.map(line => line.purchase_type == null ? '省略' : line.purchase_type).join('/')})`
		};
	}

	const walletCurrency = Number(storeData.currency || attempt.currency || 0);
	const currencyISO = String(order.currencyISO || storeData.currencyISO || currencyIdToIso(walletCurrency) || '').trim().toUpperCase();
	const country = String(storeData.country || attempt.country || attempt.loginGeoCountry || '').trim().toUpperCase();
	const currency = normalizeStoreCurrency(walletCurrency, country, currencyISO);
	const isBaseCurrency = currencyISO === 'USD' || currency === USD_CURRENCY;
	const lineItems = order.items.map(item => ({
		item_def_id: Number(item.itemDefId),
		quantity: Number(item.quantity || 0),
		cost_in_local_currency: Number(item.unitPriceCents || 0) * Number(item.quantity || 0)
	}));
	const body: PurchaseInitPlan['body'] = {country, language: PURCHASE_LANGUAGE_CODE, line_items: lineItems};
	if (!isBaseCurrency) {
		body.currency = currency;
	}
	return {
		body,
		describe: `country=${country || '(空)'} currency=${isBaseCurrency ? '省略(USD基准币种)' : currency}${currency !== walletCurrency ? `(钱包${walletCurrency}→商店${currency})` : ''} currencyISO=${currencyISO} 行项=${JSON.stringify(lineItems)}`,
		failureDetail: `(载荷 country=${country || '空'} currency=${isBaseCurrency ? '省略' : currency} cost=${lineItems.map(line => line.cost_in_local_currency).join('/')})`
	};
}

export interface PurchaseResult {
	txnId: string;
	itemIds: string[];
	initResult: number;
	finalizeResult: number;
	balanceAfter: number | null;
}

/** 写账号日志 + 推送账号状态(会话管理里的同名方法) */
export interface AttemptEvents {
	addLog(attempt: Attempt, level: string, message: string): void;
	emit(attempt: Attempt): void;
}

export interface StoreGcOptions {
	items: CatalogItemBuilder;
	events: AttemptEvents;
	/** 价目表留样目录(每种账号/币种/版本存一份 .bkv) */
	priceSheetDir: string;
	timeoutMs?: number;
	logger?: Pick<Console, 'warn'>;
}

interface WalletClient extends EventEmitter {
	wallet?: {currency?: number} | null;
}

function walletUpdate(attempt: Attempt, timeoutMs: number): Promise<{hasWallet: boolean; currency: number; balance: number | null}> {
	return new Promise((resolve, reject) => {
		const client = attempt.client as WalletClient | null;
		if (!client) {
			reject(new Error('wallet watcher unavailable'));
			return;
		}
		const onWallet = (hasWallet: unknown, currency: unknown, balance: unknown) => {
			clearTimeout(timer);
			resolve({hasWallet: !!hasWallet, currency: Number(currency || 0), balance: balance == null ? null : Number(balance)});
		};
		const timer = setTimeout(() => {
			client.removeListener('wallet', onWallet);
			reject(new Error('wallet update timed out'));
		}, Math.max(1000, Number(timeoutMs || 0)));
		client.once('wallet', onWallet);
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error && err.message ? err.message : '未知错误';
}

export function createStoreGc(options: StoreGcOptions) {
	const {items, events, priceSheetDir} = options;
	const timeoutMs = options.timeoutMs ?? PURCHASE_GC_TIMEOUT_MS;
	const logger = options.logger ?? console;

	function call<T = Record<string, unknown>>(attempt: Attempt, game: GameId, which: keyof StoreMessages, body: unknown): Promise<T> {
		const message = messagesFor(game)[which];
		return sendGcRequest(attempt, game, message.request, message.requestProto, body, message.response, message.responseProto as ProtoType<T>, {timeoutMs});
	}

	function dumpPriceSheet(fileParts: Array<string | number>, buffer: Buffer): void {
		if (!buffer.length) {
			return;
		}
		const filePath = join(priceSheetDir, fileParts.join('-') + '.bkv');
		if (existsSync(filePath)) {
			return;
		}
		try {
			writeFileSync(filePath, buffer);
		} catch (err) {
			logger.warn('[purchase] failed to dump price sheet:', errorMessage(err));
		}
	}

	/** 用这个账号向 GC 查商店数据:价目表(解析成商品目录)、账号国家和币种 */
	async function queryUserData(attempt: Attempt, gameInput: unknown): Promise<StoreData> {
		const game = normalizeGame(gameInput);
		const client = attempt.client as WalletClient | null;
		const requestedCurrency = Number(attempt.currency || client?.wallet?.currency || 0);
		const requestBody: Record<string, number> = {price_sheet_version: 0};
		if (requestedCurrency > 0) {
			requestBody.currency = requestedCurrency;
		}
		const response = await call(attempt, game, 'getUserData', requestBody);
		const rawPriceSheet = response.price_sheet ? Buffer.from(response.price_sheet as Uint8Array) : Buffer.alloc(0);
		const parsedPriceSheet = await decodePriceSheet(rawPriceSheet);
		const responseCurrency = Number(response.currency || response.currency_deprecated || 0);

		// 两款游戏取币种/国家的优先级不同(CS2 以请求时的钱包币种为准,TF2 以回包为准),保持原样
		let currency: number;
		let currencyISO: string;
		let country: string;
		if (game === 'tf2') {
			currency = Number(responseCurrency || requestedCurrency || 0);
			currencyISO = String(attempt.currencyISO || currencyIdToIso(attempt.currency) || currencyIdToIso(currency) || '').trim().toUpperCase();
			country = normalizeCountryCode(attempt.country || attempt.loginGeoCountry || response.country || response.country_deprecated || CURRENCY_ISO_TO_COUNTRY[currencyISO]);
		} else {
			currency = requestedCurrency || responseCurrency;
			currencyISO = String(attempt.currencyISO || currencyIdToIso(requestedCurrency || responseCurrency) || '').trim().toUpperCase();
			country = normalizeCountryCode(attempt.country || attempt.loginGeoCountry || response.country || response.country_deprecated || CURRENCY_ISO_TO_COUNTRY[currencyIdToIso(requestedCurrency)]);
			// 钱包币种和回包币种不一致(如乌拉圭钱包 41/商店 40)时,下单要用商店的
			events.addLog(attempt, 'info', `[CS2内购] StoreGetUserData 钱包currency=${requestedCurrency} 回包currency=${Number(response.currency || 0)}(deprecated=${Number(response.currency_deprecated || 0)}) ISO=${currencyISO} country=${country}`);
		}

		const data: StoreData = {
			source: 'gc',
			fetchedAt: new Date().toISOString(),
			account: attempt.accountName,
			attemptId: attempt.id,
			game,
			country,
			currency,
			currencyISO,
			balance: attempt.balance == null ? null : Number(attempt.balance),
			priceSheetVersion: Number(response.price_sheet_version || 0),
			priceSheetLength: rawPriceSheet.length,
			rawPriceSheet,
			parsedPriceSheet,
			list: items.buildCatalog(parsedPriceSheet, game)
		};

		const account = safeName(data.account || 'unknown');
		const source = safeName(parsedPriceSheet.source || 'raw');
		const currencyTag = data.currencyISO || data.currency || '0';
		dumpPriceSheet(game === 'tf2'
			? ['tf2-price-sheet', account, data.country || currencyTag, currencyTag, data.priceSheetVersion || 0, source]
			: ['cs2-price-sheet', account, currencyTag, data.priceSheetVersion || 0, source], parsedPriceSheet.sourceBuffer);
		return data;
	}

	/** 真实下单(会扣钱包余额):Init → 钱包扣款授权 → Finalize;成功后等一次钱包更新刷新余额 */
	async function purchase(attempt: Attempt, gameInput: unknown, order: PurchaseOrder, storeData: StoreData): Promise<PurchaseResult> {
		const game = normalizeGame(gameInput);
		const config = gameConfig(game);
		const tag = `[${config.label}内购]`;
		const plan = buildPurchaseInit(game, order, storeData, attempt);
		events.addLog(attempt, 'info', `${tag} PurchaseInit 载荷 ${plan.describe}`);

		const init = await call(attempt, game, 'purchaseInit', plan.body);
		const initResult = Number(init.result || 0);
		events.addLog(attempt, 'info', `${tag} PurchaseInit 回包 result=${initResult} txn=${longToString(init.txn_id) || '-'}`);
		if (initResult !== GC_RESULT_OK) {
			throw new Error(`PurchaseInit 返回失败 result=${initResult}${plan.failureDetail}`);
		}
		const txnId = longToString(init.txn_id);
		if (!txnId || txnId === '0') {
			throw new Error('PurchaseInit 未返回有效 txn_id');
		}

		const client = attempt.client as unknown as MicroTxnClient;
		let transId: string;
		try {
			const request = await waitForMicroTxnRequest(client, txnId, config.appId, timeoutMs);
			transId = request.transId;
			events.addLog(attempt, 'info', `${tag} 收到 Steam MicroTxn 授权请求: orderid=${request.orderId || '-'} transid=${request.transId || '-'} appid=${request.appId || 0}`);
			events.emit(attempt);
		} catch (err) {
			throw new Error(`等待 Steam MicroTxn 授权请求失败: ${errorMessage(err)}`);
		}
		try {
			const auth = await authorizeMicroTxn(client, transId, timeoutMs);
			events.addLog(attempt, 'info', `${tag} Steam MicroTxn 授权完成: transid=${transId || '-'} result=${auth.result}`);
			events.emit(attempt);
		} catch (err) {
			throw new Error(`Steam MicroTxn 授权失败: ${errorMessage(err)}`);
		}

		const finalize = await call(attempt, game, 'purchaseFinalize', {txn_id: txnId});
		const finalizeResult = Number(finalize.result || 0);
		const itemIds = Array.isArray(finalize.item_ids) ? finalize.item_ids.map(longToString) : [];
		events.addLog(attempt, 'info', `${tag} PurchaseFinalize 回包 result=${finalizeResult} item_ids=${itemIds.length ? itemIds.join(',') : '-'}`);
		if (finalizeResult !== GC_RESULT_OK) {
			throw new Error(`PurchaseFinalize 返回失败 result=${finalizeResult}`);
		}

		const wallet = await walletUpdate(attempt, 5000).catch(() => null);
		if (wallet && wallet.balance != null) {
			attempt.balance = Number(wallet.balance);
			attempt.currency = Number(wallet.currency || attempt.currency || 0);
			attempt.currencyISO = currencyIdToIso(attempt.currency) || attempt.currencyISO;
		}
		return {
			txnId,
			itemIds,
			initResult,
			finalizeResult,
			balanceAfter: wallet && wallet.balance != null ? Number(wallet.balance) : null
		};
	}

	return {queryUserData, purchase};
}

export type StoreGc = ReturnType<typeof createStoreGc>;
