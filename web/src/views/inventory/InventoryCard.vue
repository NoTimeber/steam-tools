<script setup lang="ts">
// 库存物品卡:图片(稀有度底色)、磨损色条(连着 GC 才有)、名字、稀有度和交易标签。堆叠时右上角是件数,交易标签是「x/N 可交易」
import {computed, ref, watch} from 'vue';
import {NTooltip} from 'naive-ui';
import AppIcon from '../../components/AppIcon.vue';
import {formatTradableAt, formatWear, hasWear, rarityColorOf, tradeBadge, tradeStateOf, wearNameOf} from '../../lib/inventory.ts';
import type {InventoryItem} from '../../lib/inventory.ts';
import WearBar from './WearBar.vue';

const props = defineProps<{item: InventoryItem; now: number; items?: InventoryItem[]}>();
const emit = defineEmits<{open: []}>();

const broken = ref(false);
watch(() => props.item.iconUrl, () => (broken.value = false));

const color = computed(() => rarityColorOf(props.item));
const count = computed(() => props.items?.length ?? 1);

const badge = computed(() => {
	if (count.value <= 1) {
		const single = tradeBadge(props.item, props.now);
		return {...single, kind: single.state === 'tradable' ? 'ok' : single.state === 'cooling' ? 'warn' : 'muted'};
	}
	const states = props.items!.map(entry => tradeStateOf(entry, props.now));
	const tradable = states.filter(state => state === 'tradable').length;
	const cooling = props.items!.filter((_, index) => states[index] === 'cooling');
	const locked = states.filter(state => state === 'locked').length;
	const first = cooling.map(entry => entry.tradableAfter).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
	const tip = [
		cooling.length ? `冷却中 ${cooling.length} 件,最早 ${formatTradableAt(first ?? '')} 解锁` : '',
		locked ? `已锁定 ${locked} 件` : ''
	].filter(Boolean).join(';');
	return {label: `${tradable}/${count.value} 可交易`, tip, kind: tradable === count.value ? 'ok' : tradable ? 'warn' : 'muted'};
});
</script>

<template>
	<button type="button" class="item-card" :style="color ? {'--rarity': color} : undefined" @click="emit('open')">
		<span v-if="count > 1" class="count">×{{ count }}</span>
		<div class="well">
			<img v-if="item.iconUrl && !broken" :src="item.iconUrl" :alt="item.name" loading="lazy" @error="broken = true">
			<AppIcon v-else name="package" :size="28" class="placeholder" />
		</div>
		<NTooltip v-if="hasWear(item) && count <= 1" placement="top">
			<template #trigger>
				<div class="wear"><WearBar :wear="item.paintWear!" /></div>
			</template>
			{{ wearNameOf(item.paintWear!) }} · <span class="mono">{{ formatWear(item.paintWear!) }}</span>
		</NTooltip>
		<div class="body">
			<h3 class="name" :title="item.name">{{ item.name }}</h3>
			<div class="chips">
				<span v-if="item.rarity" class="inv-chip rarity"><i />{{ item.rarity }}</span>
				<NTooltip :disabled="!badge.tip" placement="top">
					<template #trigger>
						<span class="inv-chip" :class="badge.kind">{{ badge.label }}</span>
					</template>
					{{ badge.tip }}
				</NTooltip>
			</div>
		</div>
	</button>
</template>

<style scoped>
.item-card {
	--rarity: var(--line);
	position: relative;
	display: flex;
	flex-direction: column;
	min-width: 0;
	padding: 0;
	overflow: hidden;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: var(--surface);
	box-shadow: var(--shadow);
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
	transition: border-color 0.15s, box-shadow 0.15s;
}

.item-card:hover {
	border-color: color-mix(in srgb, var(--text) 22%, var(--line));
}

.item-card:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 1px;
}

.count {
	position: absolute;
	top: 8px;
	right: 8px;
	z-index: 1;
	padding: 0 6px;
	border-radius: 6px;
	background: color-mix(in srgb, var(--text) 82%, transparent);
	color: var(--surface);
	font-size: 12px;
	font-weight: 600;
	line-height: 20px;
}

.well {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 96px;
	padding: 10px;
	background: linear-gradient(to top, color-mix(in srgb, var(--rarity) 28%, transparent), transparent 70%), var(--surface-2);
}

.well img {
	max-width: 100%;
	max-height: 76px;
	object-fit: contain;
}

.placeholder {
	color: var(--muted);
}

.wear {
	padding: 6px 12px 0;
}

.body {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 8px 12px 12px;
}

.name {
	display: -webkit-box;
	min-height: 2.8em;
	margin: 0;
	overflow: hidden;
	font-size: 12.5px;
	font-weight: 500;
	line-height: 1.4;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	word-break: break-word;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
</style>

<style>
/* 库存的标签(卡片和详情弹窗共用) */
.inv-chip {
	display: inline-block;
	max-width: 100%;
	overflow: hidden;
	padding: 0 8px;
	text-overflow: ellipsis;
	vertical-align: middle;
	border-radius: 6px;
	font-size: 12px;
	font-weight: 500;
	line-height: 20px;
	white-space: nowrap;
}

.inv-chip.rarity {
	background: color-mix(in srgb, var(--rarity) 16%, transparent);
	color: var(--text);
}

.inv-chip.rarity > i {
	display: inline-block;
	margin-right: 5px;
	vertical-align: 1px;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--rarity);
}

.inv-chip.ok {
	background: color-mix(in srgb, var(--ok) 14%, transparent);
	color: var(--ok);
}

.inv-chip.warn {
	background: color-mix(in srgb, var(--warn) 14%, transparent);
	color: var(--warn);
}

.inv-chip.muted {
	background: var(--surface-2);
	color: var(--muted);
}
</style>
