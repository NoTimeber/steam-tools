// 侧边栏的模块和对应页面(路由按这个表生成)。

import type {Component} from 'vue';

export interface ModuleEntry {
	key: string;
	label: string;
	view: () => Promise<Component | {default: Component}>;
}

export const MODULES: readonly ModuleEntry[] = [
	{key: 'accounts', label: '账户管理', view: () => import('./views/AccountsView.vue')},
	{key: 'inventory', label: '库存管理', view: () => import('./views/InventoryView.vue')},
	{key: 'purchase', label: '内购任务', view: () => import('./views/PurchaseView.vue')},
	{key: 'buygame', label: '买游戏', view: () => import('./views/BuyGameView.vue')},
	{key: 'market', label: '市场求购', view: () => import('./views/MarketView.vue')},
	{key: 'uu', label: 'UU发货', view: () => import('./views/UuView.vue')},
	{key: 'terminal', label: '终端机开箱', view: () => import('./views/TerminalView.vue')},
	{key: 'wallet', label: '充值码兑换', view: () => import('./views/WalletView.vue')},
	{key: 'settings', label: '运行设置', view: () => import('./views/SettingsView.vue')}
];
