<script setup lang="ts">
// 顶部的更新提示,按先后:更新完了要刷新页面 → 更新中(三步进度;重启时读不到进度显示「重启中」)→ 上次更新失败(原因和输出,可重试)
// → 有新版本(装了更新器有「立即更新」,没装给出服务器上要执行的命令和装更新器的命令)。
import {computed} from 'vue';
import {NAlert, NButton, NSpace, NSpin, NStep, NSteps} from 'naive-ui';
import {useApplyUpdate} from '../components/useApplyUpdate.ts';
import {dismissFinish, dismissUpdate, INSTALL_UPDATER_COMMAND, isUpdating, needsReload, selfUpdate, update, UPDATE_COMMAND} from '../stores/update.ts';

const {confirmUpdate, requesting} = useApplyUpdate();

const STEPS = [{key: 'git', title: '拉取新代码'}, {key: 'pull', title: '拉取新镜像'}, {key: 'up', title: '重启服务'}] as const;

type Mode = 'reload' | 'updating' | 'done' | 'failed' | 'available' | '';

const mode = computed<Mode>(() => {
	if (needsReload()) {
		return 'reload';
	}
	if (isUpdating()) {
		return 'updating';
	}
	if (selfUpdate.justFinished) {
		return 'done';
	}
	if (selfUpdate.state === 'failed' && selfUpdate.finishedAt && selfUpdate.finishedAt !== selfUpdate.dismissedFinish) {
		return 'failed';
	}
	return update.hasUpdate && update.latest !== update.dismissed ? 'available' : '';
});

/** 进度条现在在第几步(从 1 起;还没接手时是 0) */
const stepIndex = computed(() => {
	const index = STEPS.findIndex(step => step.key === selfUpdate.step);
	return index < 0 ? (selfUpdate.state === 'running' ? 1 : 0) : index + 1;
});

const updatingText = computed(() => {
	if (selfUpdate.unreachable) {
		return '服务正在重启,稍等,好了自动接着显示…';
	}
	if (selfUpdate.state === 'pending') {
		return selfUpdate.stale
			? '服务器上的更新器一直没接手:在服务器上看看 systemctl status steam-tools-updater.path(没装就执行一次装更新器的命令)。'
			: '已请求,等服务器上的更新器接手…';
	}
	if (selfUpdate.stale) {
		return `「${selfUpdate.message || '更新中'}」很久没动静了:在服务器上看看 journalctl -u steam-tools-updater.service。`;
	}
	return selfUpdate.message || '更新中…';
});

const failedStep = computed(() => STEPS.find(step => step.key === selfUpdate.step)?.title ?? '');

function reload(): void {
	window.location.reload();
}
</script>

<template>
	<NAlert v-if="mode === 'reload'" type="success" :title="`已更新到 v${update.current}`" class="update-banner" :bordered="false">
		<div>服务已经是新版本了,这个页面还是旧的,刷新一下就好。</div>
		<NSpace class="actions">
			<NButton size="small" type="primary" @click="reload">刷新页面</NButton>
		</NSpace>
	</NAlert>

	<NAlert v-else-if="mode === 'updating'" :type="selfUpdate.stale ? 'warning' : 'info'" class="update-banner" :bordered="false">
		<template #header>
			<span class="title"><NSpin v-if="!selfUpdate.stale" :size="14" />正在更新{{ update.latest && update.hasUpdate ? ` 到 v${update.latest}` : '' }}</span>
		</template>
		<NSteps size="small" :current="stepIndex" :status="selfUpdate.stale ? 'error' : 'process'" class="steps">
			<NStep v-for="step in STEPS" :key="step.key" :title="step.title" />
		</NSteps>
		<div class="progress-text">{{ updatingText }}</div>
	</NAlert>

	<NAlert v-else-if="mode === 'done'" type="success" title="更新完成" class="update-banner" :bordered="false" closable @close="dismissFinish">
		<div>服务已重启,现在是 v{{ update.current }}。</div>
		<div v-if="selfUpdate.to && selfUpdate.to !== update.current" class="muted hint">
			服务器上的代码已到 v{{ selfUpdate.to }};在 .env 里固定了 STEAM_TOOLS_TAG 时镜像不会跟着变。
		</div>
	</NAlert>

	<NAlert v-else-if="mode === 'failed'" type="error" :title="`更新失败${failedStep ? `(${failedStep})` : ''}`" class="update-banner" :bordered="false">
		<div>{{ selfUpdate.message }}</div>
		<details v-if="selfUpdate.log" class="log">
			<summary>服务器上的输出</summary>
			<pre class="mono">{{ selfUpdate.log }}</pre>
		</details>
		<NSpace class="actions">
			<NButton size="small" type="primary" :loading="requesting" :disabled="!selfUpdate.installed" @click="confirmUpdate">重试</NButton>
			<NButton size="small" @click="dismissFinish">关闭</NButton>
		</NSpace>
	</NAlert>

	<NAlert v-else-if="mode === 'available'" type="info" :title="`发现新版本 v${update.latest}`" class="update-banner" :bordered="false">
		<template v-if="selfUpdate.installed">
			<div>当前 v{{ update.current }}。点「立即更新」在服务器上自动更新并重启服务。</div>
		</template>
		<template v-else>
			<div>当前 v{{ update.current }}。在服务器的部署目录执行下面的命令更新:</div>
			<code class="command mono">{{ UPDATE_COMMAND }}</code>
			<div class="muted hint">想以后在面板上一键更新:更新后在部署目录执行一次 <code class="mono">{{ INSTALL_UPDATER_COMMAND }}</code>(见 DEPLOY.md)。</div>
		</template>
		<div v-if="update.notes" class="notes">{{ update.notes }}</div>
		<NSpace class="actions">
			<NButton v-if="selfUpdate.installed" size="small" type="primary" :loading="requesting" @click="confirmUpdate">立即更新</NButton>
			<NButton v-if="update.url" tag="a" :href="update.url" target="_blank" rel="noopener noreferrer" size="small" :type="selfUpdate.installed ? 'default' : 'primary'">查看更新说明</NButton>
			<NButton size="small" @click="dismissUpdate">忽略这个版本</NButton>
		</NSpace>
	</NAlert>
</template>

<style scoped>
.update-banner {
	margin: 12px 20px 0;
}

.title {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}

.steps {
	max-width: 560px;
	margin: 6px 0 8px;
}

.progress-text {
	font-size: 13px;
}

.command {
	display: inline-block;
	margin-top: 6px;
	padding: 2px 8px;
	border-radius: 4px;
	background: rgba(128, 128, 128, 0.15);
	user-select: all;
}

.hint {
	margin-top: 6px;
	font-size: 12px;
}

.hint code {
	user-select: all;
}

.notes {
	margin-top: 8px;
	max-height: 120px;
	overflow: auto;
	white-space: pre-wrap;
}

.log {
	margin-top: 6px;
	font-size: 12px;
}

.log summary {
	cursor: pointer;
}

.log pre {
	max-height: 200px;
	margin: 6px 0 0;
	padding: 8px;
	overflow: auto;
	border-radius: 6px;
	background: rgba(128, 128, 128, 0.12);
	white-space: pre-wrap;
	word-break: break-all;
}

.actions {
	margin-top: 8px;
}
</style>
