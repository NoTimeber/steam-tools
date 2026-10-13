// 前端路由:hash 模式(/next/#/accounts),服务端不用为前端路由做回退。

import {createRouter, createWebHashHistory} from 'vue-router';
import type {RouteRecordRaw} from 'vue-router';
import {MODULES} from './modules.ts';

const routes: RouteRecordRaw[] = [
	{path: '/', redirect: '/accounts'},
	...MODULES.map(module => ({
		path: `/${module.key}`,
		name: module.key,
		meta: {label: module.label},
		component: module.view ?? (() => import('./views/LegacyView.vue'))
	})),
	{path: '/:pathMatch(.*)*', redirect: '/accounts'}
];

export const router = createRouter({
	history: createWebHashHistory(),
	routes
});
