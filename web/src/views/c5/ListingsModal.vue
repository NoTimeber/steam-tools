<script setup lang="ts">
// 查某个饰品目标价以内的在售(C5 内测接口):核对价格和官网一致,也顺带验证 IP 白名单。
import {reactive, watch} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NModal, NSpace} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {money} from '../../lib/c5.ts';
import type {C5Listing} from '../../lib/c5.ts';
import {fetchListings} from '../../stores/c5.ts';

const props = defineProps<{name: string}>();
const emit = defineEmits<{close: []}>();

const view = reactive({loading: false, error: '', maxPrice: 0, listings: [] as C5Listing[]});

async function load(): Promise<void> {
	const name = props.name;
	view.loading = true;
	view.error = '';
	view.listings = [];
	try {
		const data = await fetchListings(name);
		if (name === props.name) {
			view.maxPrice = data.maxPrice;
			view.listings = data.listings;
		}
	} catch (err) {
		view.error = errorText(err);
	} finally {
		view.loading = false;
	}
}

watch(() => props.name, name => {
	if (name) {
		load();
	}
});

const columns: DataTableColumns<C5Listing> = [
	{title: '价格', key: 'price', width: 90, render: listing => money(listing.price)},
	{title: '在售 id', key: 'productId', render: listing => listing.productId}
];
</script>

<template>
	<NModal :show="!!name" @update:show="(value: boolean) => !value && emit('close')">
		<NCard :title="`${name}:目标价 ${money(view.maxPrice)} 以内的在售`" style="width: 520px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
			<NAlert v-if="view.error" type="error" :bordered="false" class="error">
				{{ view.error }}
				<div class="muted">在售查询是内测接口:报白名单 / 权限错误时,去 C5 官网 API 管理把服务器公网 IP 加进白名单,或者把策略换成「快速购买」。</div>
			</NAlert>
			<NDataTable v-else size="small" :columns="columns" :data="view.listings" :loading="view.loading" :max-height="380" :row-key="(row: C5Listing) => row.productId">
				<template #empty>
					<span class="muted">目标价以内没有在售</span>
				</template>
			</NDataTable>
			<template #footer>
				<NSpace justify="space-between" align="center">
					<span class="muted">共 {{ view.listings.length }} 件(单次最多取 50 件)</span>
					<NSpace>
						<NButton :loading="view.loading" @click="load">刷新</NButton>
						<NButton @click="emit('close')">关闭</NButton>
					</NSpace>
				</NSpace>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.error {
	margin-bottom: 8px;
}
</style>
