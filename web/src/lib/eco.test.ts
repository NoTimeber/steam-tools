/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	budgetText, dirtyFields, draftPayload, draftsDirty, formatTime, gameLabel, itemLabel, itemStatus, money, newDraft, purchaseStatus, removedNames, sweepBlocker,
	sweepConfirmText, toDrafts, describeTradeUrl, priceText, receiverEcoNote, receiverMatches, receiverOptionLabel, receiverText, receiverUsable, sortReceiverAccounts
} from './eco.ts';
import {
	bindPayloadError, bindResultStatus, bindSummary, filterBindCandidates, pruneSelection, selectableNames, toggleAllVisible, visibleCheckState
} from './eco.ts';
import {currentLinkStatus, linkStatus, updateLinkBlocker} from './eco.ts';
import type {EcoBindCandidate, EcoReceiverAccount, EcoReceivers, EcoSettings, EcoWatchItem} from './eco.ts';

const ITEMS: EcoWatchItem[] = [
	{name: 'Kilowatt Case', maxPrice: 0.66, maxQty: 100, maxSpend: 0, gameId: 730},
	{name: 'Recoil Case', maxPrice: 1.48, maxQty: 100, maxSpend: 60, gameId: 730}
];

function uids() {
	let n = 0;
	return () => `u${++n}`;
}

test('草稿:从服务端列表生成,同名行沿用 uid', () => {
	const drafts = toDrafts(ITEMS, uids());
	assert.deepEqual(drafts.map(row => [row.uid, row.origName, row.maxPrice, row.gameId]), [['u1', 'Kilowatt Case', 0.66, 730], ['u2', 'Recoil Case', 1.48, 730]]);
	const again = toDrafts([ITEMS[1]!], () => 'fresh', drafts);
	assert.equal(again[0]!.uid, 'u2');
	assert.equal(draftsDirty(drafts, ITEMS), false);
});

test('草稿:改了哪些格子、删了哪些、加了新行都算有改动', () => {
	const drafts = toDrafts(ITEMS, uids());
	drafts[0]!.maxPrice = 0.7;
	assert.deepEqual([...dirtyFields(drafts[0]!, ITEMS)], ['maxPrice']);
	assert.equal(draftsDirty(drafts, ITEMS), true);
	drafts[0]!.maxPrice = 0.66;
	drafts[0]!.maxSpend = null;   // 清空花费上限 = 0,不算改动
	assert.equal(draftsDirty(drafts, ITEMS), false);
	drafts[0]!.gameId = 570;
	assert.deepEqual([...dirtyFields(drafts[0]!, ITEMS)], ['gameId']);
	drafts[0]!.gameId = 730;

	const removed = drafts.filter(row => row.origName !== 'Recoil Case');
	assert.deepEqual(removedNames(removed, ITEMS), ['Recoil Case']);
	assert.equal(draftsDirty(removed, ITEMS), true);

	const added = [...drafts, newDraft(uids(), {name: ' Revolution Case ', maxPrice: 1.02, maxQty: 10})];
	assert.equal(added[2]!.name, 'Revolution Case');
	assert.equal(added[2]!.gameId, 730, '默认 CS2');
	assert.equal(dirtyFields(added[2]!, ITEMS).size, 5);
	assert.equal(draftsDirty(added, ITEMS), true);
	assert.equal(newDraft(uids(), {name: 'Arcana', gameId: 570}).gameId, 570);
});

test('提交前检查:名字、目标价、数量、游戏、重复', () => {
	const drafts = toDrafts(ITEMS, uids());
	assert.deepEqual(draftPayload(drafts), {items: ITEMS, error: ''});
	const make = (patch: object) => draftPayload([{...drafts[0]!, ...patch}]).error;
	assert.match(make({name: ' '}), /第 1 行:饰品名不能为空/);
	assert.match(make({maxPrice: 0}), /目标价要大于 0/);
	assert.match(make({maxPrice: null}), /目标价要大于 0/);
	assert.match(make({maxQty: 1.5}), /数量上限至少 1/);
	assert.match(make({maxSpend: -1}), /不能是负数/);
	assert.match(make({gameId: 1}), /游戏只能是 CS2 \/ Dota2 \/ TF2 \/ Rust/);
	assert.match(draftPayload([drafts[0]!, {...drafts[1]!, name: 'Kilowatt Case'}]).error, /Kilowatt Case 重复了/);
	assert.equal(draftPayload([{...drafts[0]!, maxSpend: null}]).items[0]!.maxSpend, 0);
	assert.equal(draftPayload([{...drafts[0]!, gameId: 252490}]).items[0]!.gameId, 252490);
});

test('文案', () => {
	assert.deepEqual(itemStatus('hit'), {label: '到价', tone: 'success'});
	assert.deepEqual(itemStatus('new'), {label: '未保存', tone: 'warning'});
	assert.deepEqual(purchaseStatus('unknown'), {label: '结果未知', tone: 'warning'});
	assert.equal(money(null), '-');
	assert.equal(money(1.005), '1.00');
	assert.equal(budgetText({total: 0, spent: 1.2, qty: 2}), '1.20 / 未设');
	assert.equal(budgetText({total: 500, spent: 0, qty: 0}), '0.00 / 500.00');
	assert.equal(gameLabel(730), 'CS2');
	assert.equal(gameLabel(252490), 'Rust');
	assert.equal(gameLabel(1), '1');
	const now = new Date(2026, 9, 14, 12, 0, 0).getTime();
	assert.equal(formatTime(new Date(2026, 9, 14, 9, 5, 7).getTime(), now), '09:05:07');
	assert.equal(formatTime(new Date(2026, 9, 13, 23, 0, 0).getTime(), now), '10-13 23:00:00');
	assert.equal(formatTime(null), '-');
});

test('中文名:草稿带上中文名只用来显示,不提交、不算改动;报错用中文名', () => {
	const drafts = toDrafts(ITEMS.map((item, index) => ({...item, zh: index === 0 ? '千瓦武器箱' : null})), uids());
	assert.deepEqual(drafts.map(row => [row.name, row.zh, itemLabel(row)]), [
		['Kilowatt Case', '千瓦武器箱', '千瓦武器箱'], ['Recoil Case', null, 'Recoil Case']
	]);
	assert.equal(draftsDirty(drafts, ITEMS), false);
	assert.deepEqual(draftPayload(drafts), {items: ITEMS, error: ''});

	const added = [...drafts, newDraft(uids(), {name: 'Gallery Case', zh: '画廊武器箱', maxPrice: 0, maxQty: 1})];
	assert.equal(added[2]!.zh, '画廊武器箱');
	assert.equal(draftPayload(added).error, '画廊武器箱:目标价要大于 0');
});

test('开始自动扫货:要交易链接和总预算;确认文字写明真实下单', () => {
	const settings: EcoSettings = {
		strategy: 'quick', tradeUrl: '', maxTotalSpend: 0, maxBuyPerCycle: 10, minBalanceReserve: 5, errorCooldownSec: 10, pollIntervalSec: 5, timeoutSec: 10
	};
	assert.equal(sweepBlocker(settings), '没填收货账号的交易链接');
	assert.equal(sweepBlocker({...settings, tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=a'}), '没设总预算(要大于 0)');
	assert.equal(sweepBlocker({...settings, tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=a', maxTotalSpend: 20}), null);
	const text = sweepConfirmText({...settings, maxTotalSpend: 20}, 3, {steamId: '76561198152000001', account: 'alpha', personaName: '阿尔法', eco: null, ecoChecked: true});
	assert.match(text, /真实下单/);
	assert.match(text, /ECO 账户余额/);
	assert.match(text, /总预算 20\.00,每轮最多 10 单,余额保留 5\.00/);
	assert.match(text, /快速购买.*监控 3 个饰品/);
	assert.ok(text.includes('收货账号:alpha(阿尔法) · SteamID 76561198152000001,ECO 上没绑定这个账号。'), text);
});

test('搜索结果的价格文字:有价给价和在售数,查过价没在售说无在售,没查价不写', () => {
	const option = {name: 'Kilowatt Case', zh: '千瓦武器箱', lowest: 0.66, sellCount: 4};
	assert.equal(priceText(option, true), '¥0.66 · 在售 4');
	assert.equal(priceText({...option, lowest: null, sellCount: null}, true), 'ECO 无在售');
	assert.equal(priceText({...option, lowest: null, sellCount: null}, false), '');
});

const ALPHA = '76561198152000001';
const LINK = `https://steamcommunity.com/tradeoffer/new/?partner=${76561198152000001n - 76561197960265728n}&token=abc`;
const BOUND = {steamId: ALPHA, nickname: 'ECO 号', tradeUrl: LINK, tradeUrlOk: true, status: '正常', isDefault: true, remark: ''};

test('交易链接是谁的:按账号 id(SteamID 低 32 位)对 ECO 绑定的账号;收货账号文字优先用 ECO 昵称', () => {
	const receivers: EcoReceivers = {accounts: [{...BOUND, account: 'alpha', linkCheck: {valid: true, error: null, at: 1}, canUpdate: true}], checked: true, boundError: null};
	const mine = describeTradeUrl(LINK, receivers);
	assert.deepEqual(mine, {steamId: ALPHA, account: 'alpha', personaName: null, eco: BOUND, ecoChecked: true});
	assert.equal(receiverText(mine), `ECO 号 · SteamID ${ALPHA}`);
	assert.deepEqual(receiverEcoNote(mine), {text: 'ECO 已绑定(ECO 号)', ok: true});
	assert.deepEqual(receiverEcoNote(mine, LINK), {text: 'ECO 已绑定(ECO 号)', ok: true});
	assert.deepEqual(receiverEcoNote(mine, LINK.replace('abc', 'old')), {text: '和 ECO 上登记的交易链接不一致', ok: false});
	assert.equal(receiverText({steamId: ALPHA, account: 'alpha', personaName: '阿尔法', eco: null, ecoChecked: true}), `alpha(阿尔法) · SteamID ${ALPHA}`);

	const stranger = describeTradeUrl('https://steamcommunity.com/tradeoffer/new/?partner=7&token=x', receivers);
	assert.equal(receiverText(stranger), 'SteamID 76561197960265735');
	assert.deepEqual(receiverEcoNote(stranger), {text: 'ECO 上没绑定这个账号', ok: false});
	assert.equal(receiverEcoNote(describeTradeUrl(LINK, null)), null, '没查过 ECO 不下结论');
	assert.deepEqual(receiverEcoNote({...mine!, eco: {...BOUND, status: '暂挂'}}), {text: 'ECO 上状态:暂挂', ok: false});
	assert.deepEqual(receiverEcoNote({...mine!, eco: {...BOUND, tradeUrlOk: false}}), {text: 'ECO 已绑定(ECO 号)', ok: true}, 'ECO 列表的失效标记不可靠,不当警告');
	assert.equal(describeTradeUrl('https://example.com/?partner=1', receivers), null);
	assert.equal(receiverText(null), '未设置');
});

test('收货账号下拉:ECO 昵称(备注),默认、状态不正常、没有链接的才标出来;只有没链接的不能选;能选的在前;按昵称、备注、SteamID、账户管理账号名搜', () => {
	const account: EcoReceiverAccount = {...BOUND, isDefault: false, account: 'alpha', linkCheck: null, canUpdate: false};
	assert.equal(receiverOptionLabel(account), 'ECO 号');
	assert.equal(receiverOptionLabel({...account, remark: '小号'}), 'ECO 号(小号)');
	assert.equal(receiverOptionLabel({...account, nickname: ''}), ALPHA);
	assert.equal(receiverOptionLabel({...account, isDefault: true, status: '异常', tradeUrl: ''}), 'ECO 号 · 默认 · 异常 · 没有交易链接');
	assert.equal(receiverOptionLabel({...account, tradeUrlOk: false}), 'ECO 号', 'ECO 列表的失效标记不写进名字');

	assert.ok(receiverUsable(account));
	assert.ok(!receiverUsable({...account, tradeUrl: ''}));
	assert.ok(receiverUsable({...account, tradeUrlOk: false}), 'ECO 列表标失效也能选');

	assert.ok(receiverMatches(account, 'eco'));
	assert.ok(receiverMatches({...account, remark: 'Main'}, 'main'));
	assert.ok(receiverMatches(account, '2000001'));
	assert.ok(receiverMatches(account, 'ALPHA'), '账户管理里的账号名也能搜');
	assert.ok(!receiverMatches(account, 'bravo'));
	assert.ok(receiverMatches(account, '  '));

	const list = [
		{...account, steamId: '1', status: '暂挂'}, {...account, steamId: '2'}, {...account, steamId: '3', tradeUrl: ''},
		{...account, steamId: '4', isDefault: true}, {...account, steamId: '5'}
	];
	assert.deepEqual(sortReceiverAccounts(list).map(entry => entry.steamId), ['4', '2', '5', '1', '3']);
});

function candidate(account: string, patch: Partial<EcoBindCandidate> = {}): EcoBindCandidate {
	return {account, steamId: '', group: '', hasMaFile: true, hasPassword: true, ready: true, reason: null, bound: null, ...patch};
}

const CANDIDATES: EcoBindCandidate[] = [
	candidate('a1', {group: '仓库', steamId: ALPHA}),
	candidate('a2', {group: '仓库', bound: BOUND}),
	candidate('a3', {group: '仓库', ready: false, hasPassword: false, reason: '没存密码'}),
	candidate('b1')
];

test('绑定窗口筛选:按工具分组(null 不限,空串是未分组)、只看未绑定', () => {
	assert.deepEqual(filterBindCandidates(CANDIDATES, {group: null, unboundOnly: false}).map(entry => entry.account), ['a1', 'a2', 'a3', 'b1']);
	assert.deepEqual(filterBindCandidates(CANDIDATES, {group: '仓库', unboundOnly: false}).map(entry => entry.account), ['a1', 'a2', 'a3']);
	assert.deepEqual(filterBindCandidates(CANDIDATES, {group: '', unboundOnly: false}).map(entry => entry.account), ['b1']);
	assert.deepEqual(filterBindCandidates(CANDIDATES, {group: '仓库', unboundOnly: true}).map(entry => entry.account), ['a1', 'a3']);
});

test('绑定窗口勾选:全选只勾看得见的能导入行,别的已勾的不动;刷新后去掉不能导入的', () => {
	assert.deepEqual(selectableNames(CANDIDATES), ['a1', 'a2', 'b1']);
	const visible = filterBindCandidates(CANDIDATES, {group: '仓库', unboundOnly: false});
	assert.deepEqual(toggleAllVisible(['b1'], visible, true), ['b1', 'a1', 'a2']);
	assert.deepEqual(toggleAllVisible(['b1', 'a1', 'a2'], visible, false), ['b1']);
	assert.deepEqual(visibleCheckState(['a1'], visible), {checked: false, indeterminate: true});
	assert.deepEqual(visibleCheckState(['a1', 'a2'], visible), {checked: true, indeterminate: false});
	assert.deepEqual(visibleCheckState([], [CANDIDATES[2]!]), {checked: false, indeterminate: false});
	assert.deepEqual(pruneSelection(['a1', 'a3', 'gone'], CANDIDATES), ['a1']);
});

test('绑定提交前检查和结果文案', () => {
	assert.equal(bindPayloadError(0, 'none', ''), '先勾选要绑定的账号');
	assert.match(bindPayloadError(51, 'none', ''), /最多绑定 50 个/);
	assert.equal(bindPayloadError(2, 'fixed', '  '), '选了「统一填写」就要填 ECO 分组名');
	assert.equal(bindPayloadError(2, 'fixed', 'x'.repeat(51)), 'ECO 分组名最长 50 个字');
	assert.equal(bindPayloadError(2, 'fixed', '仓库'), '');
	assert.equal(bindPayloadError(2, 'tool', ''), '');
	assert.deepEqual(bindResultStatus('unknown'), {label: '结果未知', tone: 'warning'});
	assert.equal(bindSummary([
		{account: 'a', status: 'ok', message: ''}, {account: 'b', status: 'failed', message: ''}, {account: 'c', status: 'ok', message: ''}
	]), '成功 2 个,失败 1 个');
});

test('交易链接状态:验证结果优先;没验证过时 ECO 列表的失效标记只做淡色提示;当前收货账号只认同一条链接', () => {
	const now = new Date(2026, 9, 14, 12, 0, 0).getTime();
	const at = new Date(2026, 9, 14, 11, 0, 0).getTime();
	const account: EcoReceiverAccount = {...BOUND, account: 'alpha', linkCheck: null, canUpdate: true};
	assert.deepEqual(linkStatus({...account, tradeUrlOk: false, linkCheck: {valid: true, error: null, at}}, now),
		{text: '链接有效', tone: 'success', muted: false, title: '11:00:00 验证'}, '验证说有效就是有效,不管列表标记');
	assert.equal(linkStatus({...account, linkCheck: {valid: false, error: null, at}}, now).text, '链接无效');
	const failed = linkStatus({...account, linkCheck: {valid: null, error: '6001 太频繁', at}}, now);
	assert.equal(failed.text, '验证失败');
	assert.equal(failed.tone, 'warning');
	assert.match(failed.title, /6001 太频繁/);
	assert.deepEqual([linkStatus({...account, tradeUrlOk: false}).text, linkStatus({...account, tradeUrlOk: false}).muted], ['ECO 列表标记失效(未验证)', true]);
	assert.equal(linkStatus(account).text, '未验证');
	assert.equal(linkStatus({...account, tradeUrl: ''}).text, '没有交易链接');

	const checked = {...account, linkCheck: {valid: true, error: null, at}};
	assert.equal(currentLinkStatus(checked, ` ${LINK} `, now)?.text, '链接有效');
	assert.equal(currentLinkStatus(checked, LINK.replace('abc', 'old'), now), null, '设置里的链接不是 ECO 登记的那条,验证结果对不上');
	assert.equal(currentLinkStatus(null, LINK, now), null);

	assert.equal(updateLinkBlocker(account), null);
	assert.match(updateLinkBlocker({...account, canUpdate: false})!, /alpha 在工具里没有有效的登录会话.*重新登录/);
	assert.match(updateLinkBlocker({...account, account: null, canUpdate: false})!, /不在账户管理里/);
	assert.match(updateLinkBlocker(null)!, /不是 ECO 上绑定的账号/);

	const settings: EcoSettings = {
		strategy: 'listing', tradeUrl: LINK, maxTotalSpend: 20, maxBuyPerCycle: 10, minBalanceReserve: 0, errorCooldownSec: 10, pollIntervalSec: 5, timeoutSec: 10
	};
	const receiver = {steamId: ALPHA, account: 'alpha', personaName: null, eco: {...BOUND, tradeUrlOk: false}, ecoChecked: true};
	const text = sweepConfirmText(settings, 1, receiver, currentLinkStatus(checked, LINK, now));
	assert.ok(text.includes('收货账号:ECO 号 · SteamID 76561198152000001,ECO 已绑定(ECO 号),交易链接有效。'), text);
	assert.ok(!text.includes('失效'), 'ECO 列表的失效标记不进确认文字');
	assert.ok(sweepConfirmText(settings, 1, receiver, linkStatus({...account, tradeUrlOk: false})).includes('交易链接:ECO 列表标记失效(未验证)'));
});
