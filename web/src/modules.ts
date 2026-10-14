// 侧边栏的模块。还没迁到新版的模块显示占位页,引导回旧版界面(/)。

import type {Component} from 'vue';

export interface ModuleEntry {
	key: string;
	label: string;
	/** 已迁到新版的模块给出页面组件 */
	view?: () => Promise<Component | {default: Component}>;
}

export const MODULES: readonly ModuleEntry[] = [
	{key: 'accounts', label: '账户管理', view: () => import('./views/AccountsView.vue')},
	{key: 'inventory', label: '库存管理', view: () => import('./views/InventoryView.vue')},
	{key: 'purchase', label: '内购任务', view: () => import('./views/PurchaseView.vue')},
	{key: 'buygame', label: '买游戏', view: () => import('./views/BuyGameView.vue')},
	{key: 'market', label: '市场求购', view: () => import('./views/MarketView.vue')},
	{key: 'uu', label: 'UU发货', view: () => import('./views/UuView.vue')},
	{key: 'terminal', label: '终端机开箱'},
	{key: 'wallet', label: '充值码兑换'},
	{key: 'settings', label: '运行设置', view: () => import('./views/SettingsView.vue')}
];
