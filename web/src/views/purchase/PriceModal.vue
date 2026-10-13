<script setup lang="ts">
// 某件商品在各币种的价格,折算成美元和人民币对比(按人民币从低到高)。
import {computed, h} from 'vue';
import {NCard, NDataTable, NModal, NTag} from 'naive-ui';
import type {DataTableColumns} from 'naive-ui';
import {priceEntries} from '../../lib/purchase.ts';
import type {CatalogItem, PriceEntry, Rates} from '../../lib/purchase.ts';

const props = defineProps<{item: CatalogItem | null; currency: string; rates: Rates}>();
const emit = defineEmits<{close: []}>();

const entries = computed(() => (props.item ? priceEntries(props.item, props.currency, props.rates) : []));

const columns: DataTableColumns<PriceEntry> = [
	{
		title: '币种',
		key: 'iso',
		render: entry => h('span', {class: 'iso'}, [
			h('strong', entry.iso),
			entry.current ? h(NTag, {size: 'small', type: 'success', bordered: false}, () => '当前账号币种') : null
		])
	},
	{title: '原价', key: 'value'},
	{title: '折算美元', key: 'usd'},
	{title: '折算人民币', key: 'cny'}
];
</script>

<template>
	<NModal :show="!!item" @update:show="(show: boolean) => !show && emit('close')">
		<NCard :title="`${item?.name || '商品'} 价格列表`" style="width: 640px" :bordered="false" closable role="dialog" aria-modal="true" @close="emit('close')">
			<NDataTable
				size="small"
				:columns="columns"
				:data="entries"
				:row-key="(entry: PriceEntry) => entry.iso"
				:row-class-name="(entry: PriceEntry) => (entry.current ? 'current-row' : '')"
				:max-height="480"
			>
				<template #empty>没有价格数据</template>
			</NDataTable>
		</NCard>
	</NModal>
</template>

<style scoped>
:deep(.iso) {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}

:deep(.current-row td) {
	background: rgba(94, 201, 138, 0.08);
}
</style>
