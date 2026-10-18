<script setup lang="ts">
// 线条图标(24×24,描边跟随文字颜色)。不引图标库,用到哪个在 ICONS 里加一个。
import {computed} from 'vue';

const ICONS = {
	layers: '<path d="M12 3 2 8l10 5 10-5z"/><path d="m2 16 10 5 10-5M2 12l10 5 10-5"/>',
	users: '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M21 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
	package: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
	cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.2a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 7H6"/>',
	gamepad: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 10.5v4M5 12.5h4"/><circle cx="15.5" cy="11.5" r="1"/><circle cx="18" cy="14" r="1"/>',
	trending: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
	truck: '<path d="M14 17V6H3v11h2"/><path d="M14 9h4l3 3.5V17h-2"/><path d="M9 17h6"/><circle cx="7" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/>',
	zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
	gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
	card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
	sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
	filter: '<path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/>',
	columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
	phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
	copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
	folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
	trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
	globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
	login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/>',
	logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
	receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
	download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
	key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 17 11"/>',
	wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 11h-5a2 2 0 0 0 0 4h5z"/>',
	shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
	signal: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>',
	chevronRight: '<path d="m9 6 6 6-6 6"/>',
	chevronDown: '<path d="m6 9 6 6 6-6"/>',
	arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
	arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
	x: '<path d="M18 6 6 18M6 6l12 12"/>',
	userPlus: '<path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
	clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
	terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3M12 15h6"/>',
	radio: '<circle cx="12" cy="12" r="1.5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M8.5 15.5a5 5 0 0 1 0-7M18.4 5.6a9 9 0 0 1 0 12.8M5.6 18.4a9 9 0 0 1 0-12.8"/>',
	chart: '<path d="M3 3v18h18"/><path d="M8 16v-4M12.5 16V8M17 16v-7"/>',
	tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
	power: '<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
	check: '<path d="m5 12 5 5L20 7"/>',
	alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
	grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
	list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
	refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 21v-5h-5"/>',
	external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
	info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'
} as const;

export type IconName = keyof typeof ICONS;

const props = withDefaults(defineProps<{name: IconName; size?: number | string; strokeWidth?: number}>(), {size: 18, strokeWidth: 1.75});

const px = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));
</script>

<template>
	<svg
		class="app-icon"
		viewBox="0 0 24 24"
		:width="px"
		:height="px"
		fill="none"
		stroke="currentColor"
		:stroke-width="strokeWidth"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		v-html="ICONS[name]"
	/>
</template>

<style scoped>
.app-icon {
	flex: none;
	vertical-align: middle;
}
</style>
