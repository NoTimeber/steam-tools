// 侧边栏的模块和对应页面(路由按这个表生成)。

import type {Component} from 'vue';
import type {IconName} from './components/AppIcon.vue';

export interface ModuleEntry {
	key: string;
	label: string;
	/** 侧边栏里归在哪一栏 */
	group: string;
	icon: IconName;
	view: () => Promise<Component | {default: Component}>;
}

export const MODULES: readonly ModuleEntry[] = [
	{key: 'accounts', label: '账户管理', group: '账户', icon: 'users', view: () => import('./views/AccountsView.vue')},
	{key: 'proxies', label: '代理管理', group: '账户', icon: 'globe', view: () => import('./views/ProxiesView.vue')},
	{key: 'inventory', label: '库存管理', group: '账户', icon: 'package', view: () => import('./views/InventoryView.vue')},
	{key: 'purchase', label: '内购任务', group: '交易', icon: 'cart', view: () => import('./views/PurchaseView.vue')},
	{key: 'buygame', label: '买游戏', group: '交易', icon: 'gamepad', view: () => import('./views/BuyGameView.vue')},
	{key: 'market', label: '市场求购', group: '交易', icon: 'trending', view: () => import('./views/MarketView.vue')},
	{key: 'uu', label: 'UU发货', group: '交易', icon: 'truck', view: () => import('./views/UuView.vue')},
	{key: 'c5', label: 'C5扫货', group: '交易', icon: 'zap', view: () => import('./views/C5View.vue')},
	{key: 'terminal', label: '终端机开箱', group: '工具', icon: 'gift', view: () => import('./views/TerminalView.vue')},
	{key: 'wallet', label: '充值码兑换', group: '工具', icon: 'card', view: () => import('./views/WalletView.vue')},
	{key: 'settings', label: '运行设置', group: '系统', icon: 'sliders', view: () => import('./views/SettingsView.vue')}
];
