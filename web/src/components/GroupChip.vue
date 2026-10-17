<script setup lang="ts">
// 代理组标签:色点 + 名字(颜色是 styles.css 里的 --g-颜色 变量)。
defineProps<{name: string; color?: string}>();
</script>

<template>
	<span class="group-chip"><i :style="{background: color ? `var(--g-${color})` : 'var(--muted)'}" /><span>{{ name }}</span></span>
</template>
