<script setup lang="ts">
// 物品详情:大图、名字、标签、磨损(连着 GC 才有)、各项信息;堆叠打开时下面列出这一堆的每一件,点哪件看哪件
import {computed, ref, watch} from 'vue';
import {NButton, NCard, NModal, NTooltip, useMessage} from 'naive-ui';
import AppIcon from '../../components/AppIcon.vue';
import {copyText} from '../../components/clipboard.ts';
import {
	formatInventorySource, formatWear, hasWear, inventoryUrlOf, marketUrlOf, rarityColorOf, tradeBadge, wearNameOf
} from '../../lib/inventory.ts';
import type {InventoryItem} from '../../lib/inventory.ts';
import WearBar from './WearBar.vue';

const props = defineProps<{items: InventoryItem[]; now: number; steamID: string}>();
const emit = defineEmits<{close: []}>();
const message = useMessage();

const index = ref(0);
watch(() => props.items, () => (index.value = 0));

const item = computed<InventoryItem | null>(() => props.items[index.value] ?? props.items[0] ?? null);
const color = computed(() => (item.value ? rarityColorOf(item.value) : ''));
const badge = computed(() => (item.value ? tradeBadge(item.value, props.now) : null));
const badgeKind = computed(() => (badge.value?.state === 'tradable' ? 'ok' : badge.value?.state === 'cooling' ? 'warn' : 'muted'));
const marketUrl = computed(() => (item.value ? marketUrlOf(item.value) : ''));
const inventoryUrl = computed(() => (item.value ? inventoryUrlOf(props.steamID, item.value.assetid) : ''));

const broken = ref(false);
watch(() => item.value?.iconUrl, () => (broken.value = false));

const rows = computed(() => {
	const current = item.value;
	if (!current) return [];
	const marketable = current.marketable === false ? '不可上架' : current.marketable ? '可上架' : '-';
	return [
		{label: '类型', value: current.type || '-'},
		{label: '收藏品 / 分类', value: current.category || '-'},
		{label: '外观', value: current.exterior || '-'},
		{label: '可交易', value: badge.value?.tip || badge.value?.label || '-'},
		{label: '市场', value: marketable},
		{label: '来源', value: formatInventorySource(current.source)}
	].filter(row => row.value && row.value !== '-');
});

async function copy(text: string, label: string): Promise<void> {
	await copyText(text);
	message.success(`已复制${label}`);
}
</script>

<template>
	<NModal :show="items.length > 0" @update:show="(show: boolean) => !show && emit('close')">
		<NCard v-if="item" title="物品详情" class="detail-card" :bordered="false" closable role="dialog" aria-modal="true" @close="emit('close')">
			<div class="head" :style="color ? {'--rarity': color} : undefined">
				<div class="well">
					<img v-if="item.iconUrl && !broken" :src="item.iconUrl" :alt="item.name" @error="broken = true">
					<AppIcon v-else name="package" :size="32" class="placeholder" />
				</div>
				<div class="head-text">
					<h3 class="name">{{ item.name }}</h3>
					<div v-if="item.marketHashName && item.marketHashName !== item.name" class="hash muted">
						<span>{{ item.marketHashName }}</span>
						<NTooltip>
							<template #trigger>
								<button type="button" class="icon-btn" @click="copy(item.marketHashName, '英文名')"><AppIcon name="copy" :size="14" /></button>
							</template>
							复制英文名
						</NTooltip>
					</div>
					<div class="chips">
						<span v-if="item.rarity" class="inv-chip rarity"><i />{{ item.rarity }}</span>
						<span v-if="item.exterior" class="inv-chip muted">{{ item.exterior }}</span>
						<NTooltip v-if="badge" :disabled="!badge.tip">
							<template #trigger><span class="inv-chip" :class="badgeKind">{{ badge.label }}</span></template>
							{{ badge.tip }}
						</NTooltip>
						<span v-if="item.marketable === false" class="inv-chip muted">不可上架</span>
					</div>
				</div>
			</div>

			<section v-if="hasWear(item)" class="wear panel-soft">
				<div class="wear-head">
					<span class="muted">磨损</span>
					<span><span class="mono">{{ formatWear(item.paintWear!) }}</span> {{ wearNameOf(item.paintWear!) }}</span>
				</div>
				<WearBar :wear="item.paintWear!" large />
				<div v-if="item.paintSeed !== null && item.paintSeed !== undefined" class="muted seed">图案模板 <span class="mono">{{ item.paintSeed }}</span></div>
			</section>

			<dl class="info">
				<template v-for="row in rows" :key="row.label">
					<dt>{{ row.label }}</dt>
					<dd>{{ row.value }}</dd>
				</template>
				<dt>Asset ID</dt>
				<dd class="asset">
					<span class="mono">{{ item.assetid }}</span>
					<NTooltip>
						<template #trigger>
							<button type="button" class="icon-btn" @click="copy(item.assetid, ' Asset ID')"><AppIcon name="copy" :size="14" /></button>
						</template>
						复制 Asset ID
					</NTooltip>
				</dd>
			</dl>

			<section v-if="items.length > 1" class="stack">
				<div class="muted stack-title">这一堆共 {{ items.length }} 件</div>
				<div class="stack-list">
					<button
						v-for="(entry, entryIndex) in items"
						:key="entry.assetid"
						type="button"
						class="stack-row"
						:class="{active: entryIndex === index}"
						@click="index = entryIndex"
					>
						<span class="mono">{{ entry.assetid }}</span>
						<span v-if="hasWear(entry)" class="mono muted">{{ formatWear(entry.paintWear!) }}</span>
						<span class="inv-chip" :class="tradeBadge(entry, now).state === 'tradable' ? 'ok' : tradeBadge(entry, now).state === 'cooling' ? 'warn' : 'muted'">
							{{ tradeBadge(entry, now).label }}
						</span>
					</button>
				</div>
			</section>

			<template #footer>
				<div class="actions">
					<NButton v-if="inventoryUrl" tag="a" :href="inventoryUrl" target="_blank" rel="noopener noreferrer">
						<template #icon><AppIcon name="external" :size="16" /></template>Steam 库存
					</NButton>
					<NButton v-if="marketUrl" tag="a" :href="marketUrl" target="_blank" rel="noopener noreferrer">
						<template #icon><AppIcon name="external" :size="16" /></template>Steam 市场
					</NButton>
				</div>
			</template>
		</NCard>
	</NModal>
</template>

<style scoped>
.detail-card {
	width: 560px;
	max-width: calc(100vw - 32px);
}

.head {
	--rarity: var(--line);
	display: flex;
	gap: 16px;
	align-items: flex-start;
}

.well {
	display: flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 132px;
	height: 100px;
	padding: 8px;
	border-radius: 10px;
	background: linear-gradient(to top, color-mix(in srgb, var(--rarity) 30%, transparent), transparent 75%), var(--surface-2);
}

.well img {
	max-width: 100%;
	max-height: 84px;
	object-fit: contain;
}

.placeholder {
	color: var(--muted);
}

.head-text {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
}

.name {
	margin: 0;
	font-size: 16px;
	font-weight: 600;
	line-height: 1.35;
	word-break: break-word;
}

.hash {
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 12.5px;
	word-break: break-word;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: 2px;
}

.icon-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: none;
	width: 22px;
	height: 22px;
	padding: 0;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
}

.icon-btn:hover {
	background: var(--hover);
	color: var(--text);
}

.panel-soft {
	margin-top: 16px;
	padding: 12px;
	border: 1px solid var(--line);
	border-radius: 10px;
}

.wear-head {
	display: flex;
	justify-content: space-between;
	gap: 8px;
	margin-bottom: 8px;
	font-size: 13px;
}

.seed {
	margin-top: 8px;
	font-size: 12.5px;
}

.info {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 8px 16px;
	margin: 16px 0 0;
	font-size: 13px;
}

.info dt {
	color: var(--muted);
}

.info dd {
	margin: 0;
	min-width: 0;
	word-break: break-word;
}

.asset {
	display: flex;
	align-items: center;
	gap: 4px;
}

.stack {
	margin-top: 16px;
}

.stack-title {
	margin-bottom: 6px;
	font-size: 13px;
}

.stack-list {
	display: flex;
	flex-direction: column;
	max-height: 200px;
	overflow-y: auto;
	border: 1px solid var(--line);
	border-radius: 10px;
}

.stack-row {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 6px 12px;
	border: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 13px;
	text-align: left;
	cursor: pointer;
}

.stack-row + .stack-row {
	border-top: 1px solid var(--line-soft);
}

.stack-row:hover {
	background: var(--hover);
}

.stack-row.active {
	background: var(--accent-soft);
}

.stack-row .inv-chip {
	margin-left: auto;
}

.actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: 8px;
}

@media (max-width: 520px) {
	.head {
		flex-direction: column;
	}

	.well {
		width: 100%;
	}
}
</style>
