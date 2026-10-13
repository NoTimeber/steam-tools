import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {UuInventoryItem, UuMarketSale, UuSellListItem} from './client.ts';
import {runListingPass} from './listing.ts';
import type {ListingClient, ListingContext} from './listing.ts';
import {createAccountState} from './state.ts';
import type {AccountState, ListConfig} from './state.ts';

const item = (id: number, name: string, overrides: Partial<UuInventoryItem> = {}): UuInventoryItem => ({
	SteamAssetId: `asset-${id}`, Tradable: true, AssetStatus: 0, TemplateInfo: {Id: id, CommodityName: name}, AssetInfo: {Abrade: '0.16'}, ActionLink: `steam://inspect/${id}`, ...overrides
});

class FakeUu implements ListingClient {
	inventory: UuInventoryItem[] = [];
	sellList: UuSellListItem[] = [];
	sold: Array<{AssetId: unknown; Price: number}> = [];
	changed: Array<{CommodityId: unknown; Price: number}> = [];
	inventoryError: Error | null = null;
	async getInventory() {
		if (this.inventoryError) {
			throw this.inventoryError;
		}
		return this.inventory;
	}
	async sellItems(items: Array<{AssetId: string | number | undefined; Price: number}>) {
		this.sold.push(...items);
		return {success: items.length, fail: 0};
	}
	async getSellList() {
		return this.sellList;
	}
	async changeSalePrice(items: Array<{CommodityId: string | number; Price: number}>) {
		this.changed.push(...items);
		return {success: items.length, fail: 0};
	}
	async getMarketSaleListWithAbrade(): Promise<UuMarketSale[]> {
		return [];
	}
}

function harness(config: ListConfig | null, prices: Record<string, number | Error>, inspect: {configured: boolean; values?: Record<string, number>} = {configured: false}) {
	const uu = new FakeUu();
	const state: AccountState = Object.assign(createAccountState('alpha'), {token: 'T', listConfig: config});
	const logs: string[] = [];
	const ctx: ListingContext = {
		client: () => uu,
		priceEngine: () => ({
			async getAbradeRelatedPrice(_uu, templateId, name, abrade) {
				const price = prices[name] ?? prices[String(templateId)] ?? 0;
				if (price instanceof Error) {
					throw price;
				}
				logs.push(`price? ${name} ${Number(abrade).toFixed(4)}`);
				return price;
			}
		}),
		log: (_state, level, message) => void logs.push(`${level} ${message}`),
		emit() {},
		resolveAbrade: async link => (link && inspect.values ? inspect.values[link] ?? null : null),
		inspectConfigured: inspect.configured
	};
	return {uu, state, logs, ctx};
}

test('上架:只挑可交易、未在售、有模板的;白名单/黑名单过滤;按磨损定价', async () => {
	const h = harness({whitelist: ['AK', 'M4'], blacklist: ['纪念品'], reprice: false}, {'AK-47 | 红线': 35.5, 'M4A4 | 龙王': 80});
	h.uu.inventory = [
		item(1, 'AK-47 | 红线'),
		item(2, 'M4A4 | 龙王', {AssetInfo: {Abrade: 0.07}}),
		item(3, 'AK-47 | 纪念品'),
		item(4, 'AWP | 二西莫夫'),
		item(5, 'AK-47 | 在售中', {AssetStatus: 1}),
		item(6, 'AK-47 | 冷却中', {Tradable: false}),
		item(7, 'AK-47 | 无磨损信息', {AssetInfo: null}),
		item(8, '', {TemplateInfo: {Id: 8}})
	];
	await runListingPass(h.ctx, h.state, 'manual');
	assert.deepEqual(h.uu.sold, [{AssetId: 'asset-1', Price: 35.5}, {AssetId: 'asset-2', Price: 80}]);
	assert.deepEqual(h.state.listStats, {scans: 1, listed: 2, failed: 0, skipped: 0, noAbrade: 0, repriced: 0});
	assert.equal(h.state.listStatus, 'idle');
	assert.ok(h.logs.includes('info 跳过(黑名单): AK-47 | 纪念品'));
	assert.ok(h.logs.includes('info 将上架: AK-47 | 红线（磨损 0.1600） ¥35.5'));
	assert.ok(h.logs.includes('success 上架完成: 成功 2 件, 失败 0 件'));
	assert.equal(h.logs[0], 'info CS2 上架: 手动触发扫描');
});

test('上架:没磨损先用外部检视服务兜底;无参考价、超过最高价、定价出错都跳过', async () => {
	const h = harness({maxPrice: 50, reprice: false}, {'A | 1': 20, 'A | 2': 0, 'A | 3': 60, 'A | 4': new Error('操作太频繁')}, {configured: true, values: {'steam://inspect/1': 0.25}});
	h.uu.inventory = [
		item(1, 'A | 1', {AssetInfo: {Abrade: null}}),
		item(2, 'A | 2'),
		item(3, 'A | 3'),
		item(4, 'A | 4'),
		item(5, 'A | 5', {AssetInfo: {Abrade: ''}})
	];
	await runListingPass(h.ctx, h.state, 'auto');
	assert.deepEqual(h.uu.sold, [{AssetId: 'asset-1', Price: 20}]);
	assert.deepEqual(h.state.listStats, {scans: 1, listed: 1, failed: 0, skipped: 3, noAbrade: 1, repriced: 0});
	assert.ok(h.logs.includes('info 外部解析磨损: A | 1 → 0.2500'));
	assert.ok(h.logs.includes('info 跳过(无参考价): A | 2'));
	assert.ok(h.logs.includes('info 跳过(超过最高价 ¥50): A | 3 ¥60'));
	assert.ok(h.logs.includes('error 定价失败 A | 4: 操作太频繁'));
	assert.ok(h.logs.includes('warn 跳过(无磨损，外部解析失败): A | 5'));
	assert.equal(h.logs[0], 'info CS2 自动上架: 开始扫描库存');

	const noService = harness({reprice: false}, {});
	noService.uu.inventory = [item(1, 'B | 1', {AssetInfo: {}})];
	await runListingPass(noService.ctx, noService.state, 'auto');
	assert.ok(noService.logs.includes('warn 跳过(无磨损，未配置外部解析服务): B | 1'));
});

test('改价:只动皮肤、有磨损、价格变了的;dryRun 只算不改', async () => {
	const h = harness({maxPrice: 100}, {'AK-47 | 红线': 36, 'M4 | 龙王': 50, 'AWP | 树蝰': 120, 'Glock | 水灵': 0});
	h.uu.sellList = [
		{id: 'c1', templateId: 1, name: 'AK-47 | 红线', sellAmount: '35.5', abrade: '0.16'},
		{id: 'c2', templateId: 2, name: 'M4 | 龙王', sellAmount: 50.004, abrade: '0.07'},
		{id: 'c3', templateId: 3, name: 'AWP | 树蝰', sellAmount: '90', abrade: '0.2'},
		{id: 'c4', templateId: 4, name: '库存存储组件', sellAmount: '5', abrade: ''},
		{id: 'c5', templateId: 5, name: 'Glock | 水灵', sellAmount: '3', abrade: '0.3'},
		{id: 'c6', templateId: 6, name: 'USP | 没磨损', sellAmount: '3'},
		{templateId: 7, name: 'P90 | 没 id', sellAmount: '3', abrade: '0.3'}
	];
	await runListingPass(h.ctx, h.state, 'manual');
	assert.deepEqual(h.uu.changed, [{CommodityId: 'c1', Price: 36}], '价格没变(差 < 0.01)、超过最高价、没参考价的都不改');
	assert.equal(h.state.listStats.repriced, 1);
	assert.ok(h.logs.includes('info 将改价: AK-47 | 红线 ¥35.5 → ¥36'));
	assert.ok(h.logs.includes('info 无新可上架物品（库存无可交易/未在售的皮肤）'));

	const dry = harness({dryRun: true}, {'AK-47 | 红线': 36});
	dry.uu.inventory = [item(1, 'AK-47 | 红线')];
	dry.uu.sellList = [{id: 'c1', templateId: 1, name: 'AK-47 | 红线', sellAmount: '30', abrade: '0.16'}];
	await runListingPass(dry.ctx, dry.state, 'manual');
	assert.deepEqual([dry.uu.sold, dry.uu.changed], [[], []]);
	assert.ok(dry.logs.includes('warn [dryRun] 仅试算，未真正上架 1 件'));
	assert.ok(dry.logs.includes('warn [dryRun] 仅试算，未真正改价 1 件'));
});

test('上架出错记为错误状态;上一轮没结束就跳过', async () => {
	const h = harness(null, {});
	h.uu.inventoryError = Object.assign(new Error('需先在悠悠有品 App 内手动上架一次并确认「交易撤回须知」'), {uuSceneConfirm: true});
	await runListingPass(h.ctx, h.state, 'auto');
	assert.equal(h.state.listStatus, 'error');
	assert.match(h.state.listLastError, /交易撤回须知/);
	assert.equal(h.state.listRunning, false);

	h.state.listRunning = true;
	await runListingPass(h.ctx, h.state, 'auto');
	assert.equal(h.state.listStats.scans, 1);
});
