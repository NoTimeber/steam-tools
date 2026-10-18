<script setup lang="ts">
// 磨损色条:五段按 Steam 外观区间的宽度画,竖线标出磨损值的位置
import {WEAR_RANGES} from '../../lib/inventory.ts';

defineProps<{wear: number; large?: boolean}>();

const SEGMENT_COLORS = ['var(--wear-fn)', 'var(--wear-mw)', 'var(--wear-ft)', 'var(--wear-ww)', 'var(--wear-bs)'];
const segments = WEAR_RANGES.map((range, index) => ({width: `${(range.max - range.min) * 100}%`, color: SEGMENT_COLORS[index]}));
</script>

<template>
	<div class="wear-bar" :class="{large}">
		<div class="segments">
			<i v-for="(segment, index) in segments" :key="index" :style="{width: segment.width, background: segment.color}" />
		</div>
		<span class="marker" :style="{left: `${Math.min(Math.max(wear, 0), 1) * 100}%`}" />
	</div>
</template>

<style scoped>
.wear-bar {
	position: relative;
	height: 4px;
}

.wear-bar.large {
	height: 8px;
}

.segments {
	display: flex;
	gap: 1px;
	height: 100%;
	overflow: hidden;
	border-radius: 999px;
}

.segments > i {
	height: 100%;
}

.marker {
	position: absolute;
	top: -2px;
	bottom: -2px;
	width: 2px;
	transform: translateX(-50%);
	border-radius: 999px;
	background: var(--text);
	box-shadow: 0 0 0 1px var(--surface);
}
</style>
