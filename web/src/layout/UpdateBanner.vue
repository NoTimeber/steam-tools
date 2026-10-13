<script setup lang="ts">
import {computed} from 'vue';
import {NAlert, NButton, NSpace} from 'naive-ui';
import {restartForUpdate, update} from '../stores/update.ts';

const visible = computed(() => update.restarting || (!!update.available && update.available !== update.dismissed));
</script>

<template>
	<NAlert v-if="visible" type="info" title="发现新版本" class="update-banner" :bordered="false">
		<div v-if="update.restarting">{{ update.restartMessage }}</div>
		<template v-else>
			<div>{{ update.current ? `当前 v${update.current} → ` : '' }}新版 v{{ update.available }} 已下载,重启后生效。</div>
			<div v-if="update.notes" class="notes">更新内容:{{ update.notes }}</div>
			<NSpace class="actions">
				<NButton size="small" type="primary" @click="restartForUpdate">立即重启生效</NButton>
				<NButton size="small" @click="update.dismissed = update.available">稍后</NButton>
			</NSpace>
		</template>
	</NAlert>
</template>

<style scoped>
.update-banner {
	margin: 12px 20px 0;
}

.notes {
	margin-top: 4px;
	max-height: 120px;
	overflow: auto;
	white-space: pre-wrap;
}

.actions {
	margin-top: 8px;
}
</style>
