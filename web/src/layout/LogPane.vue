<script setup lang="ts">
// 实时运行日志:右下角一个圆按钮,点开是浮在页面上的日志面板,再点或按 × 收起。
// 收起时按钮上显示未读条数,其中有错误时是红的。面板里停在底部时新日志自动跟随;往上翻看时保持位置,并提示「最新日志」。
import {computed, nextTick, ref, watch} from 'vue';
import {NBadge, NButton, NTooltip} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import {clearLogs, closeLogPanel, logLines, logPanel, toggleLogPanel} from '../stores/logs.ts';

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
	if (!box.value) {
		return;
	}
	const stick = nearBottom();
	await nextTick();
	if (stick) {
		toBottom();
	} else {
		showJump.value = true;
	}
});

// 每次打开都翻到最新
watch(box, el => {
	if (el) {
		toBottom();
	}
});

const launcherTip = computed(() => {
	if (logPanel.open) {
		return '收起运行日志';
	}
	if (!logPanel.unread) {
		return '实时运行日志';
	}
	return `实时运行日志:${logPanel.unread} 条新的${logPanel.unreadErrors ? `,其中 ${logPanel.unreadErrors} 条错误` : ''}`;
});
</script>

<template>
	<Transition name="log-panel">
		<section v-if="logPanel.open" class="log-panel" role="dialog" aria-label="实时运行日志" @keydown.esc="closeLogPanel">
			<header>
				<h2><AppIcon name="terminal" :size="16" />实时运行日志</h2>
				<div class="head-actions">
					<NButton size="tiny" quaternary :disabled="!logLines.length" @click="clearLogs">清空</NButton>
					<NTooltip placement="top">
						<template #trigger>
							<NButton size="tiny" quaternary aria-label="收起" @click="closeLogPanel"><template #icon><AppIcon name="x" :size="16" /></template></NButton>
						</template>
						收起
					</NTooltip>
				</div>
			</header>
			<div ref="box" class="log-lines mono" @scroll="showJump = !nearBottom()">
				<div v-for="(line, index) in logLines" :key="index" :class="['log-line', 'log-' + line.level]">
					<span class="log-time">[{{ line.time }}]</span> {{ line.message }}
				</div>
				<div v-if="!logLines.length" class="log-empty muted">还没有日志</div>
			</div>
			<NButton v-if="showJump" class="log-jump" size="small" type="primary" secondary @click="toBottom">↓ 最新日志</NButton>
		</section>
	</Transition>

	<div class="log-dock">
		<NTooltip placement="left">
			<template #trigger>
				<NBadge :value="logPanel.unread" :max="99" :show="!logPanel.open && logPanel.unread > 0" :type="logPanel.unreadErrors ? 'error' : 'warning'">
					<button
						type="button"
						class="log-launcher"
						:class="{open: logPanel.open, alert: !logPanel.open && logPanel.unreadErrors > 0}"
						:aria-label="launcherTip"
						:aria-expanded="logPanel.open"
						@click="toggleLogPanel"
					>
						<AppIcon :name="logPanel.open ? 'x' : 'terminal'" :size="20" :stroke-width="2" />
					</button>
				</NBadge>
			</template>
			{{ launcherTip }}
		</NTooltip>
	</div>
</template>

<style scoped>
.log-dock {
	position: fixed;
	right: 20px;
	bottom: 20px;
	z-index: 1000;
}

.log-launcher {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 44px;
	height: 44px;
	border: 1px solid var(--line);
	border-radius: 50%;
	background: var(--surface);
	color: var(--text);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
	cursor: pointer;
	transition: background 0.15s, color 0.15s, transform 0.15s;
}

.log-launcher:hover {
	color: var(--accent-text);
	transform: translateY(-1px);
}

.log-launcher.open {
	background: var(--accent);
	border-color: var(--accent);
	color: var(--on-accent);
}

.log-launcher.alert {
	border-color: var(--danger);
	color: var(--danger);
}

.log-panel {
	position: fixed;
	right: 20px;
	bottom: 76px;
	z-index: 1000;
	display: flex;
	flex-direction: column;
	width: min(440px, calc(100vw - 40px));
	height: min(520px, calc(100vh - 120px));
	border: 1px solid var(--line);
	border-radius: 12px;
	background: var(--surface);
	box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
	overflow: hidden;
}

header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 10px 10px 10px 14px;
	border-bottom: 1px solid var(--line);
}

h2 {
	display: flex;
	align-items: center;
	gap: 6px;
	margin: 0;
	font-size: 14px;
	font-weight: 600;
}

.head-actions {
	display: flex;
	align-items: center;
	gap: 2px;
}

.log-lines {
	flex: 1;
	min-height: 0;
	overflow: auto;
	padding: 10px 14px 14px;
	font-size: 12px;
	line-height: 1.6;
	white-space: pre-wrap;
	word-break: break-all;
}

.log-empty {
	padding: 24px 0;
	text-align: center;
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

.log-panel-enter-active,
.log-panel-leave-active {
	transition: opacity 0.15s, transform 0.15s;
}

.log-panel-enter-from,
.log-panel-leave-to {
	opacity: 0;
	transform: translateY(8px);
}
</style>
