<script setup lang="ts">
// 内购任务(CS2/TF2 GC 商店):左边商品目录,右边购物车和任务。
import {onMounted, onUnmounted} from 'vue';
import {NButton, NCard, NRadioButton, NRadioGroup, NSpace} from 'naive-ui';
import type {GameId} from '../api/types.ts';
import {enterPurchase, gameLabel, leavePurchase, loadCatalog, purchase, refreshAccounts, selectedAccounts, switchGame} from '../stores/purchase.ts';
import CartPanel from './purchase/CartPanel.vue';
import CatalogPanel from './purchase/CatalogPanel.vue';
import TaskList from './purchase/TaskList.vue';

onMounted(enterPurchase);
onUnmounted(leavePurchase);
</script>

<template>
	<div class="module-page">
		<header class="module-header">
			<div>
				<h1>内购任务</h1>
				<div class="module-counts">
					<span>当前游戏:{{ gameLabel }}</span>
					<span>在线账户:{{ purchase.accounts.length }}</span>
					<span>已选账户:{{ selectedAccounts.length }}</span>
					<span>商品数:{{ purchase.items.length }}</span>
					<span>任务数:{{ purchase.tasks.length }}</span>
				</div>
			</div>
			<NSpace align="center">
				<NRadioGroup :value="purchase.game" size="small" @update:value="(game: GameId) => switchGame(game)">
					<NRadioButton value="cs2">CS2</NRadioButton>
					<NRadioButton value="tf2">TF2</NRadioButton>
				</NRadioGroup>
				<NButton :loading="purchase.loadingAccounts" @click="refreshAccounts()">刷新账户</NButton>
				<NButton :disabled="purchase.loadingItems" @click="loadCatalog('items')">刷新商品</NButton>
				<NButton :disabled="purchase.loadingItems" @click="loadCatalog('rates')">刷新汇率</NButton>
			</NSpace>
		</header>

		<div class="purchase-layout">
			<CatalogPanel class="catalog" />
			<div class="side">
				<NCard size="small" :bordered="false">
					<CartPanel />
				</NCard>
				<NCard size="small" :bordered="false" title="最近任务">
					<TaskList :tasks="purchase.tasks" />
				</NCard>
			</div>
		</div>
	</div>
</template>

<style scoped>
.purchase-layout {
	display: grid;
	grid-template-columns: minmax(0, 1.25fr) minmax(360px, 1fr);
	gap: 16px;
	flex: 1;
	min-height: 0;
}

.catalog {
	min-height: 0;
}

.side {
	display: flex;
	flex-direction: column;
	gap: 12px;
	min-height: 0;
	overflow: auto;
}

@media (max-width: 1280px) {
	.purchase-layout {
		grid-template-columns: minmax(0, 1fr);
	}

	.catalog {
		min-height: 480px;
	}
}
</style>
