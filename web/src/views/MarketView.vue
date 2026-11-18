<script setup lang="ts">
// 市场:四个标签页 —— 求购(挂求购单、我的求购单)、出售(库存上架)、我的在售(下架)、成交记录。
// 在线账号四页共用(/api/market/online-accounts);当前标签记在地址的 ?tab= 里,刷新页面、分享链接都能回到同一页。
import {computed, onMounted, onUnmounted} from 'vue';
import {useRoute, useRouter} from 'vue-router';
import {NButton, NTab, NTabs} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import {enterMarket, leaveMarket, market, refreshAccounts} from '../stores/market.ts';
import BuyTab from './market/BuyTab.vue';
import HistoryTab from './market/HistoryTab.vue';
import ListingsTab from './market/ListingsTab.vue';
import SellTab from './market/SellTab.vue';

type MarketTab = 'buy' | 'sell' | 'listings' | 'history';
const TABS: readonly MarketTab[] = ['buy', 'sell', 'listings', 'history'];

const route = useRoute();
const router = useRouter();

onMounted(enterMarket);
onUnmounted(leaveMarket);

const tab = computed<MarketTab>(() => {
	const value = String(route.query.tab ?? '');
	return (TABS as readonly string[]).includes(value) ? value as MarketTab : 'buy';
});

function openTab(value: MarketTab): void {
	const query = {...route.query};
	if (value === 'buy') {
		delete query.tab;
	} else {
		query.tab = value;
	}
	void router.replace({query});
}
</script>

<template>
	<div class="module-page market-page">
		<header class="module-header">
			<div>
				<h1>市场</h1>
				<div class="module-counts">
					<span>在线账户:{{ market.accounts.length }}</span>
					<span v-if="market.accountError" class="warn-text">{{ market.accountError }}</span>
				</div>
			</div>
			<NButton :loading="market.loadingAccounts" @click="refreshAccounts()">刷新账户</NButton>
		</header>

		<NTabs type="line" :value="tab" class="page-tabs" @update:value="openTab">
			<NTab name="buy"><span class="tab-label"><AppIcon name="trending" :size="16" />求购</span></NTab>
			<NTab name="sell"><span class="tab-label"><AppIcon name="tag" :size="16" />出售</span></NTab>
			<NTab name="listings"><span class="tab-label"><AppIcon name="list" :size="16" />我的在售</span></NTab>
			<NTab name="history"><span class="tab-label"><AppIcon name="clock" :size="16" />成交记录</span></NTab>
		</NTabs>

		<BuyTab v-if="tab === 'buy'" />
		<SellTab v-else-if="tab === 'sell'" />
		<ListingsTab v-else-if="tab === 'listings'" />
		<HistoryTab v-else />
	</div>
</template>

<style scoped>
/* 内容比一屏长,交给外层滚动 */
.market-page {
	height: auto;
	min-height: 100%;
}

.page-tabs {
	flex: none;
}

.tab-label {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.warn-text {
	color: var(--warn);
}
</style>
