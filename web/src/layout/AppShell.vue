<script setup lang="ts">
// 页面骨架:左侧导航、中间模块页面、右侧实时运行日志;顶部有更新提示。
import {computed} from 'vue';
import {useRoute, useRouter} from 'vue-router';
import {NMenu, NTag} from 'naive-ui';
import type {MenuOption} from 'naive-ui';
import {socketConnected} from '../api/socket.ts';
import {MODULES} from '../modules.ts';
import {update} from '../stores/update.ts';
import LogPane from './LogPane.vue';
import UpdateBanner from './UpdateBanner.vue';

const route = useRoute();
const router = useRouter();

const menuOptions = computed<MenuOption[]>(() => MODULES.map(module => ({
	key: module.key,
	label: module.label
})));

const activeKey = computed(() => String(route.name || 'accounts'));
</script>

<template>
	<div class="shell">
		<aside class="shell-sidebar">
			<div class="brand">
				<div class="brand-title">
					<strong>Steam 工具台</strong>
					<span v-if="update.current" class="muted brand-version">v{{ update.current }}</span>
				</div>
				<NTag size="small" :type="socketConnected ? 'success' : 'default'" :bordered="false">
					{{ socketConnected ? '已连接' : '未连接' }}
				</NTag>
			</div>
			<NMenu :options="menuOptions" :value="activeKey" @update:value="(key: string) => router.push('/' + key)" />
			<a class="legacy-link muted" href="/">切换到旧版界面</a>
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
	grid-template-columns: 200px minmax(0, 1fr) 340px;
	height: 100%;
}

.shell-sidebar {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 16px 8px;
	background: var(--sidebar);
	border-right: 1px solid var(--line-soft);
}

.brand {
	display: flex;
	flex-direction: column;
	gap: 6px;
	align-items: flex-start;
	padding: 0 12px 8px;
}

.brand-title {
	display: flex;
	gap: 6px;
	align-items: baseline;
}

.brand-version {
	font-size: 12px;
}

.legacy-link {
	margin-top: auto;
	padding: 0 12px;
	font-size: 12px;
	text-decoration: none;
}

.legacy-link:hover {
	color: var(--accent);
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
	border-left: 1px solid var(--line-soft);
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
