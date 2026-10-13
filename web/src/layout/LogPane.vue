<script setup lang="ts">
// 实时运行日志:停在底部时新日志自动跟随;往上翻看时保持位置,并提示「最新日志」。
import {nextTick, ref, watch} from 'vue';
import {NButton} from 'naive-ui';
import {clearLogs, logLines} from '../stores/logs.ts';

const box = ref<HTMLElement | null>(null);
const showJump = ref(false);

const nearBottom = () => {
	const el = box.value;
	return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
};

function toBottom(): void {
	if (box.value) {
		box.value.scrollTop = box.value.scrollHeight;
	}
	showJump.value = false;
}

watch(() => logLines.value.length, async () => {
	const stick = nearBottom();
	await nextTick();
	if (stick) {
		toBottom();
	} else {
		showJump.value = true;
	}
});

watch(box, el => {
	if (el) {
		toBottom();
	}
});
</script>

<template>
	<aside class="log-pane">
		<header>
			<h2>实时运行日志</h2>
			<NButton size="tiny" quaternary @click="clearLogs">清空</NButton>
		</header>
		<div ref="box" class="log-lines mono" @scroll="showJump = !nearBottom()">
			<div v-for="(line, index) in logLines" :key="index" :class="['log-line', 'log-' + line.level]">
				<span class="log-time">[{{ line.time }}]</span> {{ line.message }}
			</div>
		</div>
		<NButton v-if="showJump" class="log-jump" size="small" type="primary" secondary @click="toBottom">↓ 最新日志</NButton>
	</aside>
</template>

<style scoped>
.log-pane {
	position: relative;
	display: flex;
	flex-direction: column;
	min-height: 0;
	background: var(--sidebar);
}

header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 14px 14px 8px;
}

h2 {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
}

.log-lines {
	flex: 1;
	min-height: 0;
	overflow: auto;
	padding: 0 14px 14px;
	font-size: 12px;
	line-height: 1.6;
	white-space: pre-wrap;
	word-break: break-all;
}

.log-time {
	color: var(--muted);
}

.log-success {
	color: var(--ok);
}

.log-warn {
	color: var(--warn);
}

.log-error {
	color: var(--danger);
}

.log-jump {
	position: absolute;
	right: 16px;
	bottom: 16px;
}
</style>
