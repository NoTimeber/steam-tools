<script setup lang="ts">
import {computed} from 'vue';
import {NAlert, NButton, NSpace} from 'naive-ui';
import {dismissUpdate, update, UPDATE_COMMAND} from '../stores/update.ts';

const visible = computed(() => update.hasUpdate && update.latest !== update.dismissed);
</script>

<template>
	<NAlert v-if="visible" type="info" :title="`发现新版本 v${update.latest}`" class="update-banner" :bordered="false">
		<div>当前 v{{ update.current }}。在服务器的部署目录执行下面的命令更新:</div>
		<code class="command mono">{{ UPDATE_COMMAND }}</code>
		<div v-if="update.notes" class="notes">{{ update.notes }}</div>
		<NSpace class="actions">
			<NButton v-if="update.url" tag="a" :href="update.url" target="_blank" rel="noopener noreferrer" size="small" type="primary">查看更新说明</NButton>
			<NButton size="small" @click="dismissUpdate">忽略这个版本</NButton>
		</NSpace>
	</NAlert>
</template>

<style scoped>
.update-banner {
	margin: 12px 20px 0;
}

.command {
	display: inline-block;
	margin-top: 6px;
	padding: 2px 8px;
	border-radius: 4px;
	background: rgba(128, 128, 128, 0.15);
	user-select: all;
}

.notes {
	margin-top: 8px;
	max-height: 120px;
	overflow: auto;
	white-space: pre-wrap;
}

.actions {
	margin-top: 8px;
}
</style>
