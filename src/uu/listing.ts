// CS2 自动上架的一轮(从 app/server.js 移来,日志文案不变)。纯 UU 操作,不需要 Steam 在线;token 通用,固定走 CS2。
//   1) 上架:拉库存 → 可交易且未在售(AssetStatus=0)、命中白名单、不在黑名单 → 按磨损段定价 → 上架(只卖不租);
//      UU 没给磨损时用外部检视服务兜底,还没有就跳过;
//   2) 改价(reprice 默认开):在售的皮肤按当前市场重新定价,价格变了才改。
// dryRun 只算价不上架/改价。

import type {UuInventoryItem, UuSellListItem} from './client.ts';
import type {MarketQuery} from './pricing.ts';
import {errorText} from './delivery.ts';
import type {AccountState} from './state.ts';

/** 上架用到的 UU 客户端能力 */
export interface ListingClient extends MarketQuery {
	getInventory(opts?: {refresh?: boolean}): Promise<UuInventoryItem[]>;
	sellItems(items: Array<{AssetId: string | number | undefined; Price: number}>): Promise<{success: number; fail: number}>;
	getSellList(): Promise<UuSellListItem[]>;
	changeSalePrice(items: Array<{CommodityId: string | number; Price: number}>): Promise<{success: number; fail: number}>;
}

export interface PriceEngine {
	getAbradeRelatedPrice(uu: MarketQuery, templateId: string | number, goodName: string, abrade: unknown): Promise<number>;
}

export interface ListingContext {
	/** 建 CS2 的 UU 客户端(非 debug 日志写进账号日志) */
	client(state: AccountState): ListingClient;
	/** 建定价引擎(查价限频由调用方决定) */
	priceEngine(state: AccountState): PriceEngine;
	log(state: AccountState, level: string, message: string): void;
	emit(state: AccountState): void;
	/** 用外部检视服务把检视链接解析成磨损;没配置或失败为 null */
	resolveAbrade(actionLink: string | undefined): Promise<number | null>;
	/** 是否配置了外部检视服务(只影响日志文案) */
	inspectConfigured: boolean;
}

function matchesFilters(name: string, whitelist: string[], blacklist: string[]): 'ok' | 'not-whitelisted' | 'blacklisted' {
	if (whitelist.length && !whitelist.some(word => word && name.includes(word))) {
		return 'not-whitelisted';
	}
	if (blacklist.length && blacklist.some(word => word && name.includes(word))) {
		return 'blacklisted';
	}
	return 'ok';
}

/** 一轮上架 + 改价;上一轮还没结束就跳过 */
export async function runListingPass(ctx: ListingContext, state: AccountState, source: string): Promise<void> {
	if (state.listRunning) {
		return;
	}
	state.listRunning = true;
	state.listStatus = 'listing';
	state.lastListAt = new Date().toISOString();
	state.listStats.scans += 1;
	ctx.emit(state);

	try {
		const cfg = state.listConfig || {};
		const whitelist = Array.isArray(cfg.whitelist) ? cfg.whitelist.filter(Boolean) : [];
		const blacklist = Array.isArray(cfg.blacklist) ? cfg.blacklist.filter(Boolean) : [];
		const maxPrice = Number(cfg.maxPrice) > 0 ? Number(cfg.maxPrice) : 0;
		const dryRun = !!cfg.dryRun;
		const uu = ctx.client(state);
		const engine = ctx.priceEngine(state);

		// ===== 1. 上架未在售的库存 =====
		ctx.log(state, 'info', source === 'auto' ? 'CS2 自动上架: 开始扫描库存' : 'CS2 上架: 手动触发扫描');
		const inventory = await uu.getInventory({refresh: true});
		const candidates: UuInventoryItem[] = [];
		for (const item of inventory) {
			if (!item.AssetInfo || item.Tradable !== true || item.AssetStatus !== 0) {
				continue;
			}
			const template = item.TemplateInfo || {};
			const shortName = template.CommodityName || '';
			if (!template.Id || !shortName) {
				continue;
			}
			const filter = matchesFilters(shortName, whitelist, blacklist);
			if (filter === 'not-whitelisted') {
				continue;
			}
			if (filter === 'blacklisted') {
				ctx.log(state, 'info', `跳过(黑名单): ${shortName}`);
				continue;
			}
			candidates.push(item);
		}

		const toSell: Array<{AssetId: string | number | undefined; Price: number}> = [];
		if (candidates.length) {
			ctx.log(state, 'info', `发现 ${candidates.length} 件可上架物品，开始按磨损定价...`);
			for (const item of candidates) {
				const template = item.TemplateInfo as {Id: string | number; CommodityName: string};
				const shortName = template.CommodityName;
				let abrade = parseFloat(String(item.AssetInfo && item.AssetInfo.Abrade));
				if (!Number.isFinite(abrade)) {
					const resolved = await ctx.resolveAbrade(item.ActionLink);
					if (resolved != null) {
						abrade = resolved;
						ctx.log(state, 'info', `外部解析磨损: ${shortName} → ${abrade.toFixed(4)}`);
					} else {
						state.listStats.noAbrade += 1;
						ctx.log(state, 'warn', `跳过(无磨损${ctx.inspectConfigured ? '，外部解析失败' : '，未配置外部解析服务'}): ${shortName}`);
						continue;
					}
				}
				let price = 0;
				try {
					price = await engine.getAbradeRelatedPrice(uu, template.Id, shortName, abrade);
				} catch (err) {
					state.listStats.skipped += 1;
					ctx.log(state, 'error', `定价失败 ${shortName}: ${errorText(err)}`);
					continue;
				}
				if (!(price > 0)) {
					state.listStats.skipped += 1;
					ctx.log(state, 'info', `跳过(无参考价): ${shortName}`);
					continue;
				}
				if (maxPrice && price > maxPrice) {
					state.listStats.skipped += 1;
					ctx.log(state, 'info', `跳过(超过最高价 ¥${maxPrice}): ${shortName} ¥${price}`);
					continue;
				}
				ctx.log(state, 'info', `将上架: ${shortName}（磨损 ${abrade.toFixed(4)}） ¥${price}`);
				toSell.push({AssetId: item.SteamAssetId, Price: price});
			}
		} else {
			ctx.log(state, 'info', '无新可上架物品（库存无可交易/未在售的皮肤）');
		}

		if (toSell.length) {
			if (dryRun) {
				ctx.log(state, 'warn', `[dryRun] 仅试算，未真正上架 ${toSell.length} 件`);
			} else {
				const result = await uu.sellItems(toSell);
				state.listStats.listed += result.success;
				state.listStats.failed += result.fail;
				ctx.log(state, result.success > 0 ? 'success' : 'warn', `上架完成: 成功 ${result.success} 件, 失败 ${result.fail} 件`);
			}
		}

		// ===== 2. 在售物品跟价 =====
		if (cfg.reprice !== false) {
			const sellList = await uu.getSellList();
			const toChange: Array<{CommodityId: string | number; Price: number}> = [];
			for (const item of sellList) {
				const shortName = item.name || '';
				if (!shortName.includes('|')) {
					continue;   // 不是皮肤(存储组件等)
				}
				if (matchesFilters(shortName, whitelist, blacklist) !== 'ok') {
					continue;
				}
				const abrade = parseFloat(String(item.abrade));
				if (!Number.isFinite(abrade) || !item.id) {
					continue;
				}
				const currentPrice = parseFloat(String(item.sellAmount));
				let newPrice = 0;
				try {
					newPrice = await engine.getAbradeRelatedPrice(uu, item.templateId as string | number, shortName, abrade);
				} catch (err) {
					ctx.log(state, 'error', `改价定价失败 ${shortName}: ${errorText(err)}`);
					continue;
				}
				if (!(newPrice > 0) || (maxPrice && newPrice > maxPrice)) {
					continue;
				}
				if (Number.isFinite(currentPrice) && Math.abs(newPrice - currentPrice) < 0.01) {
					continue;
				}
				ctx.log(state, 'info', `将改价: ${shortName} ¥${Number.isFinite(currentPrice) ? currentPrice : '?'} → ¥${newPrice}`);
				toChange.push({CommodityId: item.id, Price: newPrice});
			}
			if (toChange.length) {
				if (dryRun) {
					ctx.log(state, 'warn', `[dryRun] 仅试算，未真正改价 ${toChange.length} 件`);
				} else {
					const result = await uu.changeSalePrice(toChange);
					state.listStats.repriced += result.success;
					ctx.log(state, result.success > 0 ? 'success' : 'warn', `改价完成: 成功 ${result.success} 件, 失败 ${result.fail} 件`);
				}
			} else {
				ctx.log(state, 'info', '无需改价（在售价格均为最新）');
			}
		}

		state.listStatus = 'idle';
		state.listLastError = '';
	} catch (err) {
		state.listStatus = 'error';
		state.listLastError = errorText(err);
		ctx.log(state, 'error', 'CS2 自动上架失败: ' + state.listLastError);
	} finally {
		state.listRunning = false;
		ctx.emit(state);
	}
}
