<script setup lang="ts">
// 还没迁到新版的模块:引导回旧版界面。两个界面同时开着没问题,数据都在服务端。
import {computed} from 'vue';
import {useRoute} from 'vue-router';
import {NButton, NResult} from 'naive-ui';

const route = useRoute();
const label = computed(() => String(route.meta.label || '这个模块'));
</script>

<template>
	<div class="module-page">
		<NResult status="info" :title="`${label}还在旧版界面`" description="新版界面正在逐个模块迁移,这个模块暂时请在旧版界面里使用。两个界面可以同时打开,数据都在服务端。">
			<template #footer>
				<NButton tag="a" href="/" target="_blank" type="primary">在新标签页打开旧版界面</NButton>
			</template>
		</NResult>
	</div>
</template>
