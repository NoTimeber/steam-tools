<script setup lang="ts">
// 查某个饰品目标价以内的在售(ECO 在售列表):核对价格和官网一致,也顺带验证密钥、接口权限和 IP 白名单。
import {reactive, watch} from 'vue';
import {NAlert, NButton, NCard, NDataTable, NModal, NSpace} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import {errorText} from '../../api/http.ts';
import {money} from '../../lib/eco.ts';
import type {EcoListing} from '../../lib/eco.ts';
import {fetchListings} from '../../stores/eco.ts';

/** name 是英文名(查在售用),label 是显示用的(有中文用中文) */
const props = defineProps<{name: string; label?: string}>();
const emit = defineEmits<{close: []}>();

const view = reactive({loading: false, error: '', maxPrice: 0, listings: [] as EcoListing[]});

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

const columns: DataTableColumns<EcoListing> = [
	{title: '价格', key: 'price', width: 90, render: listing => money(listing.price)},
	{title: '商品编号', key: 'goodsNum', render: listing => listing.goodsNum}
];
</script>

<template>
	<NModal :show="!!name" @update:show="(value: boolean) => !value && emit('close')">
		<NCard :title="`${label || name}:目标价 ${money(view.maxPrice)} 以内的在售`" style="width: 520px; max-width: calc(100vw - 32px)" :bordered="false" role="dialog" aria-modal="true">
			<NAlert v-if="view.error" type="error" :bordered="false" class="error">
				{{ view.error }}
				<div class="muted">报 4004 不在IP白名单时,去 ECO 开放平台把服务器的公网出口 IP 加进白名单;报签名 / 权限错误时,检查 PartnerId 和公钥是否填对。</div>
			</NAlert>
			<NDataTable v-else size="small" :columns="columns" :data="view.listings" :loading="view.loading" :max-height="380" :row-key="(row: EcoListing) => row.goodsNum">
				<template #empty>
					<span class="muted">目标价以内没有在售</span>
				</template>
			</NDataTable>
			<template #footer>
				<NSpace justify="space-between" align="center">
					<span class="muted">共 {{ view.listings.length }} 件(单次最多取 100 件)</span>
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
