<script setup lang="ts">
// 页面骨架:左侧分栏导航(带图标)、中间模块页面、右侧实时运行日志;顶部有更新提示。
import {computed, h} from 'vue';
import {useRoute, useRouter} from 'vue-router';
import {NMenu, NTag} from 'naive-ui';
import type {MenuOption} from 'naive-ui';
import {socketConnected} from '../api/socket.ts';
import AppIcon from '../components/AppIcon.vue';
import {MODULES} from '../modules.ts';
import {update} from '../stores/update.ts';
import LogPane from './LogPane.vue';
import UpdateBanner from './UpdateBanner.vue';

const route = useRoute();
const router = useRouter();

/** 按 group 分栏,栏的顺序按模块表里第一次出现的顺序 */
const menuOptions = computed<MenuOption[]>(() => {
	const groups = new Map<string, MenuOption[]>();
	for (const module of MODULES) {
		const items = groups.get(module.group) ?? [];
		items.push({key: module.key, label: module.label, icon: () => h(AppIcon, {name: module.icon})});
		groups.set(module.group, items);
	}
	return [...groups].map(([label, children]) => ({type: 'group', key: 'group-' + label, label, children}));
});

const activeKey = computed(() => String(route.name || 'accounts'));
</script>

<template>
	<div class="shell">
		<aside class="shell-sidebar">
			<div class="brand">
				<span class="brand-logo"><AppIcon name="layers" :size="18" :stroke-width="2" /></span>
				<strong class="brand-name">Steam 工具台</strong>
			</div>
			<NMenu class="nav" :options="menuOptions" :value="activeKey" :indent="12" @update:value="(key: string) => router.push('/' + key)" />
			<div class="sidebar-foot">
				<NTag size="small" :type="socketConnected ? 'success' : 'default'" :bordered="false">
					{{ socketConnected ? '已连接' : '未连接' }}
				</NTag>
				<span v-if="update.current" class="muted brand-version">v{{ update.current }}</span>
			</div>
		</aside>
		<main class="shell-content">
			<UpdateBanner />
			<div class="shell-view">
				<RouterView />
			</div>
		</main>
		<LogPane class="shell-logs" />
	</div>
</template>

<style scoped>
.shell {
	display: grid;
	grid-template-columns: 216px minmax(0, 1fr) 340px;
	height: 100%;
}

.shell-sidebar {
	display: flex;
	flex-direction: column;
	min-height: 0;
	background: var(--sidebar);
	border-right: 1px solid var(--line);
}

.brand {
	display: flex;
	gap: 10px;
	align-items: center;
	height: 60px;
	padding: 0 20px;
	border-bottom: 1px solid var(--line);
}

.brand-logo {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border-radius: 8px;
	background: var(--accent);
	color: var(--on-accent);
}

.brand-name {
	font-size: 15px;
	font-weight: 700;
}

.nav {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 8px 8px 12px;
}

.nav :deep(.n-menu-item-group-title) {
	padding-left: 12px !important;
	font-size: 12px;
	font-weight: 600;
}

.sidebar-foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 12px 20px;
	border-top: 1px solid var(--line);
}

.brand-version {
	font-size: 12px;
}

.shell-content {
	display: flex;
	flex-direction: column;
	min-width: 0;
	min-height: 0;
}

.shell-view {
	flex: 1;
	min-height: 0;
	overflow: auto;
}

.shell-logs {
	border-left: 1px solid var(--line);
}

@media (max-width: 1100px) {
	.shell {
		grid-template-columns: 180px minmax(0, 1fr);
	}

	.shell-logs {
		display: none;
	}
}
</style>
